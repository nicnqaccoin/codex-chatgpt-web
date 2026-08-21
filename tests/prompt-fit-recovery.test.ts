import { afterEach, expect, test } from "bun:test";
import {
  CHATGPT_VERBATIM_TOOL_RESULT_MESSAGES,
  compileChatGptWebPrompt,
  isInstructionMessage,
  nextDroppableIndex,
  noteCompactionPromptSize,
  resetCompactionStallTracking,
  withElidedOlderToolResults,
  withoutDesktopOnlyReplayBlocks,
} from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import type { ChatGptWebCapabilities } from "../src/adapters/chatgpt-web/model";
import type { CodexMessage, CodexParsedRequest } from "../src/types";

const plus: ChatGptWebCapabilities = {
  localToolsEnabled: true,
  solAvailable: true,
  proAvailable: false,
};

afterEach(() => {
  resetCompactionStallTracking();
});

function userMessage(content: string, timestamp: number): CodexMessage {
  return { role: "user", content, timestamp };
}

function toolResult(content: string, timestamp: number): CodexMessage {
  return {
    role: "toolResult",
    toolCallId: `call_${timestamp}`,
    toolName: "apply_patch",
    isError: false,
    content,
    timestamp,
  };
}

/** Mirrors the desktop contract Codex replays on every turn, including the Visualize rules. */
const APP_CONTEXT = "<app-context>\n# Codex desktop context\n### Images/Visuals/Files\nRules.\n</app-context>";
const ENVIRONMENT = "# AGENTS.md instructions\nGlobal rules.\n<environment_context><cwd>/w</cwd></environment_context>";

function request(messages: CodexMessage[], compaction = false): CodexParsedRequest {
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    context: { messages, systemPrompt: [] },
    stream: true,
    options: { reasoning: "high" },
    ...(compaction ? { _compactionRequest: true } : {}),
  } as unknown as CodexParsedRequest;
}

test("instruction blocks are recognised wherever they sit in the history", () => {
  expect(isInstructionMessage(userMessage(APP_CONTEXT, 1))).toBe(true);
  expect(isInstructionMessage(userMessage(ENVIRONMENT, 2))).toBe(true);
  expect(isInstructionMessage({
    role: "developer",
    content: "Capabilities from the `Visualize` plugin: ...",
    timestamp: 3,
  })).toBe(true);
  expect(isInstructionMessage(userMessage("draw newton's third law", 4))).toBe(false);
  expect(isInstructionMessage(toolResult("A file.html", 5))).toBe(false);
});

test("fit recovery drops conversation and never the instruction contract", () => {
  const messages = [
    userMessage(APP_CONTEXT, 1),
    userMessage(ENVIRONMENT, 2),
    userMessage("draw newton's third law", 3),
    toolResult("old output", 4),
    userMessage("make it prettier", 5),
  ];

  // Oldest droppable is the task request, not the two instruction blocks ahead of it.
  expect(nextDroppableIndex(messages)).toBe(2);

  // The newest message is the live request and is never a candidate either.
  expect(nextDroppableIndex([userMessage(APP_CONTEXT, 1), userMessage("only turn", 2)])).toBe(-1);
});

test("an oversized turn keeps the Visualize contract and sheds old conversation instead", () => {
  const filler = "conversation ".repeat(20_000);
  const compiled = compileChatGptWebPrompt(
    request([
      userMessage(APP_CONTEXT, 1),
      userMessage(ENVIRONMENT, 2),
      userMessage(filler, 3),
      userMessage(filler, 4),
      userMessage("make it prettier", 5),
    ]),
    plus,
    "turn-token",
  );

  expect(compiled.text).toContain("### Images/Visuals/Files");
  expect(compiled.text).toContain("# AGENTS.md instructions");
  expect(compiled.text).toContain("make it prettier");
  // 110,000 is the measured Plus medium/high composer ceiling.
  expect(compiled.text.length).toBeLessThanOrEqual(110_000);
});

test("desktop-only replay blocks are dropped without touching the surrounding contract", () => {
  const text = [
    APP_CONTEXT,
    "<oai-mem-citation>\n<citation_entries>\nMEMORY.md:1-2\n</citation_entries>\n</oai-mem-citation>",
    "## What's in Memory\n### C:/projects/other\n- unrelated digest\n",
    "<skills_instructions>\n## Skills\n</skills_instructions>",
    "<recommended_plugins>\nplugins you have not installed\n</recommended_plugins>",
    "keep this tail",
  ].join("\n") + "x".repeat(2_000);

  const slimmed = withoutDesktopOnlyReplayBlocks(text);

  expect(slimmed).toContain("### Images/Visuals/Files");
  expect(slimmed).toContain("<skills_instructions>");
  expect(slimmed).toContain("keep this tail");
  expect(slimmed).not.toContain("<oai-mem-citation>");
  expect(slimmed).not.toContain("What's in Memory");
  expect(slimmed).not.toContain("<recommended_plugins>");
  expect(withoutDesktopOnlyReplayBlocks("short text")).toBe("short text");
});

test("older tool results are elided with a marker while recent ones stay verbatim", () => {
  const huge = "x".repeat(29_327);
  const messages = [
    toolResult(huge, 1),
    ...Array.from(
      { length: CHATGPT_VERBATIM_TOOL_RESULT_MESSAGES },
      (_value, index) => userMessage(`turn ${index}`, index + 2),
    ),
    toolResult(huge, 99),
  ];

  const elided = withElidedOlderToolResults(messages);
  const first = elided[0]!.content as string;
  const last = elided.at(-1)!.content as string;

  expect(first.length).toBeLessThan(7_000);
  expect(first).toContain("characters elided from this older tool result");
  expect(last).toBe(huge);
});

test("three compactions that stop shrinking fail closed instead of looping", () => {
  // Sizes captured during the 2026-08-21 livelock.
  expect(() => noteCompactionPromptSize(95_137)).not.toThrow();
  expect(() => noteCompactionPromptSize(94_058)).not.toThrow();
  expect(() => noteCompactionPromptSize(94_261)).toThrow("no longer reducing this session");
});

test("compactions that keep shrinking are never blocked", () => {
  for (const bytes of [95_000, 60_000, 30_000, 20_000]) {
    expect(() => noteCompactionPromptSize(bytes)).not.toThrow();
  }
});

test("stall detection only considers compactions inside the window", () => {
  const start = 1_000_000;
  expect(() => noteCompactionPromptSize(94_000, start)).not.toThrow();
  expect(() => noteCompactionPromptSize(94_100, start + 1_000)).not.toThrow();
  expect(() => noteCompactionPromptSize(94_050, start + 700_000)).not.toThrow();
});
