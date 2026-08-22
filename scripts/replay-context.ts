/**
 * Replays a real Codex session through the actual ChatGPT Web prompt compiler and reports how much
 * of the conversation survives.
 *
 * Context trimming is invisible from the outside: the model simply receives less history, and the
 * only signal is a diagnostics line written after the fact. A change to pruning or fit recovery
 * therefore cannot be judged by reading it. This replays `~/.codex/sessions/**\/rollout-*.jsonl`
 * against `compileChatGptWebPrompt` so the effect is a number, and so two revisions can be compared
 * on identical input:
 *
 *   git worktree add /tmp/before <ref>
 *   bun run scripts/replay-context.ts <rollout.jsonl>            # after
 *   bun --cwd /tmp/before run scripts/replay-context.ts <same>   # before
 *
 * Usage: bun run scripts/replay-context.ts [rollout.jsonl ...]
 *        bun run scripts/replay-context.ts --latest 3
 *        bun run scripts/replay-context.ts --budget-tokens 90000 <rollout.jsonl>
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CHATGPT_WEB_MODEL_ID, type ChatGptWebCapabilities } from "../src/adapters/chatgpt-web/model";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { pruneSemanticToolResults, textFromContent } from "../src/adapters/chatgpt-web/prune";
import { CHATGPT_WEB_MEDIUM_HIGH_AUTO_COMPACT_TOKEN_LIMIT } from "../src/chatgpt-web-models";
import { estimateTokens } from "../src/lib/token-estimate";
import type { CodexAssistantContentPart, CodexMessage, CodexParsedRequest } from "../src/types";

// A replay must never touch the diagnostics the live bridge is writing next door.
process.env.BUN_TEST = "1";

/** Matches the account profile the bridge reports for a ChatGPT Plus session at medium/high effort. */
const PLUS_CAPABILITIES: ChatGptWebCapabilities = {
  localToolsEnabled: true,
  solAvailable: true,
  proAvailable: false,
};

interface RolloutItem {
  type?: string;
  role?: string;
  content?: unknown;
  summary?: unknown;
  name?: string;
  call_id?: string;
  arguments?: unknown;
  input?: unknown;
  output?: unknown;
}

function itemText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(part => (part && typeof part === "object" ? String((part as { text?: unknown }).text ?? "") : ""))
    .filter(text => text.length > 0)
    .join("\n");
}

/**
 * Rebuilds the message list the way `src/responses/parser.ts` does, including its shapes: assistant
 * content is always an array of parts, reasoning is folded into the assistant message that follows
 * it, and a tool output becomes a `toolResult` carrying the originating call's name.
 */
function messagesFromRollout(file: string): CodexMessage[] {
  const messages: CodexMessage[] = [];
  const callNames = new Map<string, string>();
  let pendingReasoning: CodexAssistantContentPart[] = [];
  const takeReasoning = (): CodexAssistantContentPart[] => {
    const parts = pendingReasoning;
    pendingReasoning = [];
    return parts;
  };

  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let record: { payload?: RolloutItem } & RolloutItem;
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      continue;
    }
    const item = record.payload ?? record;
    switch (item.type) {
      case "reasoning": {
        const text = itemText(item.summary ?? item.content);
        if (text) pendingReasoning.push({ type: "thinking", thinking: text });
        break;
      }
      case "message": {
        if (!item.role) break;
        const text = itemText(item.content);
        if (item.role === "assistant") {
          messages.push({
            role: "assistant",
            content: [...takeReasoning(), { type: "text", text }],
            timestamp: 0,
          });
        } else {
          messages.push({ role: item.role as "user" | "developer", content: text, timestamp: 0 });
        }
        break;
      }
      case "function_call":
      case "custom_tool_call": {
        const name = item.name ?? "";
        const callId = item.call_id ?? "";
        callNames.set(callId, name);
        // A custom tool call carries its payload in `input`, not `arguments`, and the parser wraps
        // it as `{ input }` (src/responses/parser.ts). Reading `arguments` for both shapes silently
        // dropped every apply_patch body - 2,980 characters each - out of the replay.
        let args: Record<string, unknown> = {};
        if (item.type === "custom_tool_call") {
          args = { input: typeof item.input === "string" ? item.input : "" };
        } else {
          try {
            const parsed = typeof item.arguments === "string" ? JSON.parse(item.arguments) : item.arguments;
            if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
          } catch {
            // A tool that sent non-JSON arguments still contributes its result to the history.
          }
        }
        messages.push({
          role: "assistant",
          content: [...takeReasoning(), { type: "toolCall", id: callId, name, arguments: args }],
          timestamp: 0,
        });
        break;
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        const callId = item.call_id ?? "";
        messages.push({
          role: "toolResult",
          toolCallId: callId,
          toolName: callNames.get(callId) ?? "",
          content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
          isError: false,
          timestamp: 0,
        });
        break;
      }
      default:
        break;
    }
  }
  return messages;
}

function messageChars(message: CodexMessage): number {
  return typeof message.content === "string"
    ? message.content.length
    : JSON.stringify(message.content).length;
}

/**
 * Codex hands the adapter its live context window, not the whole session. The default budget is the
 * limit at which Codex compacts its own history, which is the typical pressure a turn arrives
 * under; pass `--budget-tokens` with the reported context window instead to replay the worst case,
 * the largest history Codex can still send before it must compact.
 */
interface ContextSlice {
  readonly messages: CodexMessage[];
  readonly available: number;
  readonly tokensUsed: number;
  /**
   * The message that ended the walk. The window has to stay contiguous, so one oversized item stops
   * it even when budget remains - and then the replay silently covers a sliver of the session while
   * still reporting "dropped 0". Reported so that reading is impossible to mistake for "no pressure".
   */
  readonly blockedBy: { role: string; chars: number; tokens: number } | null;
}

function liveContextSlice(messages: readonly CodexMessage[], budgetTokens: number): ContextSlice {
  let start = messages.length;
  let tokens = 0;
  let blockedBy: ContextSlice["blockedBy"] = null;
  while (start > 0) {
    const message = messages[start - 1]!;
    const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    const cost = estimateTokens(text, CHATGPT_WEB_MODEL_ID);
    if (tokens + cost > budgetTokens) {
      blockedBy = { role: message.role, chars: text.length, tokens: cost };
      break;
    }
    tokens += cost;
    start -= 1;
  }
  return { messages: messages.slice(start), available: messages.length, tokensUsed: tokens, blockedBy };
}

/** Counts the messages that reached ChatGPT, read back out of the compiled envelope. */
function envelopeMessageCount(promptText: string): number {
  const envelope = /<codex_context_json>\n([\s\S]*?)\n<\/codex_context_json>/.exec(promptText);
  if (!envelope?.[1]) return -1;
  try {
    const parsed = JSON.parse(envelope[1]) as { messages?: unknown[] };
    return Array.isArray(parsed.messages) ? parsed.messages.length : -1;
  } catch {
    return -1;
  }
}

function toolResultChars(messages: readonly CodexMessage[]): number {
  return messages.reduce(
    (total, message) => (message.role === "toolResult" ? total + textFromContent(message.content).length : total),
    0,
  );
}

function latestRollouts(count: number): string[] {
  const root = join(homedir(), ".codex", "sessions");
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".jsonl")) files.push(path);
    }
  };
  walk(root);
  return files
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
    .slice(0, count);
}

const args = process.argv.slice(2);
const budgetFlag = args.indexOf("--budget-tokens");
const budgetTokens = budgetFlag >= 0
  ? Number(args[budgetFlag + 1])
  : CHATGPT_WEB_MEDIUM_HIGH_AUTO_COMPACT_TOKEN_LIMIT;
if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) {
  throw new Error("--budget-tokens needs a positive number of tokens");
}
const positional = budgetFlag >= 0 ? args.filter((_value, index) => index !== budgetFlag && index !== budgetFlag + 1) : args;
const files = positional[0] === "--latest"
  ? latestRollouts(Number(positional[1] ?? 1))
  : positional.map(path => resolve(path));
if (files.length === 0) {
  throw new Error("Usage: bun run scripts/replay-context.ts [rollout.jsonl ...] | --latest <n>");
}

console.log(`context budget ${budgetTokens.toLocaleString("en-US")} tokens\n`);
for (const file of files) {
  const sliced = liveContextSlice(messagesFromRollout(file), budgetTokens);
  const slice = sliced.messages;
  if (slice.length === 0) {
    console.log(`${file}\n  no replayable messages`);
    continue;
  }
  const rawChars = slice.reduce((total, message) => total + messageChars(message), 0);
  const pruned = pruneSemanticToolResults(slice);
  const prunedChars = toolResultChars(slice) - toolResultChars(pruned);
  const elidedToolResults = pruned.filter((message, index) => message !== slice[index]).length;

  const request = {
    modelId: CHATGPT_WEB_MODEL_ID,
    context: { messages: slice, systemPrompt: [] },
    stream: true,
    options: { reasoning: "high" },
  } as unknown as CodexParsedRequest;
  const compiled = compileChatGptWebPrompt(request, PLUS_CAPABILITIES, "token-replay");
  const kept = envelopeMessageCount(compiled.text);

  const coverage = (slice.length / sliced.available) * 100;
  console.log(file);
  console.log(
    `  context slice   ${slice.length}/${sliced.available} messages (${coverage.toFixed(1)}% of session), ` +
      `${rawChars.toLocaleString("en-US")} chars, ` +
      `${sliced.tokensUsed.toLocaleString("en-US")}/${budgetTokens.toLocaleString("en-US")} tokens`,
  );
  if (sliced.blockedBy && coverage < 80) {
    console.log(
      `  !! WINDOW CUT    stopped at a ${sliced.blockedBy.role} of ` +
        `${sliced.blockedBy.chars.toLocaleString("en-US")} chars (~${sliced.blockedBy.tokens.toLocaleString("en-US")} tokens); ` +
        `${(budgetTokens - sliced.tokensUsed).toLocaleString("en-US")} tokens of budget went unused.`,
    );
    console.log(
      "                   Numbers below describe that sliver only - do NOT read them as \"no pressure\". " +
        "Raise --budget-tokens to replay more of the session.",
    );
  }
  console.log(`  pruning         ${elidedToolResults} tool results rewritten, ${prunedChars.toLocaleString("en-US")} chars removed`);
  console.log(`  fit recovery    kept ${kept}/${slice.length}, dropped ${slice.length - kept}`);
  console.log(`  compiled prompt ${compiled.text.length.toLocaleString("en-US")} chars`);
}
