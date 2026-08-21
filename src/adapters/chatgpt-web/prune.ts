import type { CodexAssistantContentPart, CodexContentPart, CodexMessage } from "../../types";

export interface SemanticPruneOptions {
  verbatimTailMessages?: number; // default: 6
  maxCommandOutputChars?: number; // default: 1500
}

export const CHATGPT_DEFAULT_VERBATIM_TOOL_RESULT_MESSAGES = 6;
export const CHATGPT_DEFAULT_MAX_COMMAND_OUTPUT_CHARS = 1500;

const TOOL_RESULT_HEAD_CHARS = 4_000;
const TOOL_RESULT_TAIL_CHARS = 2_000;

/**
 * A single tool result this large cannot be replayed whole under any composer ceiling - the Plus
 * medium/high ceiling is 110,000 characters - so leaving one verbatim inside the recent window does
 * not preserve it, it only makes fit recovery discard the entire conversation around it while still
 * failing to fit. A real session held a 138,893 character result and collapsed to a single message.
 * Only applied once the prompt has already exceeded its budget.
 */
export const CHATGPT_MAX_SINGLE_TOOL_RESULT_CHARS = 40_000;

/**
 * Instruction blocks the task cannot work without: the desktop contract that carries the
 * Images/Visuals rules the Visualize plugin depends on, the environment and AGENTS.md contract, the
 * skill catalog, and per-plugin capability notes. Fit recovery drops ordinary conversation instead
 * of these, whatever their position in the history.
 */
const INSTRUCTION_BLOCK_MARKERS: readonly string[] = [
  "<app-context>",
  "<recommended_plugins>",
  "<environment_context>",
  "<skills_instructions>",
  "<model_switch>",
  "<permissions instructions>",
  "<collaboration_mode>",
  "<apps_instructions>",
  "<plugins_instructions>",
  "# AGENTS.md",
  "Capabilities from the",
];

export function isInstructionMessage(message: CodexMessage): boolean {
  if (message.role === "assistant" || message.role === "toolResult") return false;
  const text = textFromContent(message.content).trimStart();
  return INSTRUCTION_BLOCK_MARKERS.some(marker => text.startsWith(marker));
}

export function getLatestUserIndex(messages: readonly CodexMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user" && !isInstructionMessage(message)) return index;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.role === "user") return index;
  }
  return -1;
}

export function textFromContent(content: string | CodexContentPart[]): string {
  if (typeof content === "string") return content;
  const texts: string[] = [];
  for (const part of content) {
    if (part.type === "text") texts.push(part.text);
  }
  return texts.join("\n");
}

export function updateContentText(
  content: string | CodexContentPart[],
  newText: string,
): string | CodexContentPart[] {
  if (typeof content === "string") return newText;
  let replaced = false;
  const parts: CodexContentPart[] = [];
  for (const part of content) {
    if (part.type === "text") {
      if (!replaced) {
        parts.push({ type: "text", text: newText });
        replaced = true;
      }
    } else {
      parts.push(part);
    }
  }
  if (!replaced) {
    parts.unshift({ type: "text", text: newText });
  }
  return parts;
}

function baseToolName(name: string): string {
  return name.replace(/^.*__/, "").replace(/^codex_/, "").toLowerCase();
}

function isReadFileTool(baseName: string): boolean {
  return [
    "view_file",
    "read_file",
    "read_text_file",
    "cat",
    "open_file",
    "get_file_contents",
    "readfile",
    "viewfile",
    "fetch_file",
  ].includes(baseName);
}

function isModifyFileTool(baseName: string): boolean {
  return [
    "apply_patch",
    "patch",
    "write_to_file",
    "replace_file_content",
    "edit_file",
    "modify_file",
    "write_file",
    "create_file",
    "create_or_update_file",
    "writefile",
  ].includes(baseName);
}

function isListDirTool(baseName: string): boolean {
  return [
    "list_dir",
    "dir_list",
    "list_directory",
    "ls",
    "dir",
    "find_by_name",
    "find_files",
    "file_search",
    "glob_search",
    "tree",
    "list_files",
    "listdir",
  ].includes(baseName);
}

function isExecCommandTool(baseName: string): boolean {
  return [
    "exec_command",
    "shell_command",
    "exec",
    "run_command",
    "bash",
    "sh",
    "powershell",
    "cmd",
    "execute_command",
    "terminal_exec",
    "process_exec",
  ].includes(baseName);
}

function normalizePath(rawPath: string): string {
  return rawPath
    .trim()
    .replace(/^file:\/\/\/?/i, "")
    .replaceAll("\\", "/")
    .replace(/\/+/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function cleanDisplayPath(rawPath: string): string {
  return rawPath
    .trim()
    .replace(/^file:\/\/\/?/i, "")
    .replaceAll("\\", "/")
    .replace(/\/+/g, "/");
}

function extractFilePathFromArgs(args: Record<string, unknown>): string | undefined {
  const possible = [
    args.path,
    args.file_path,
    args.filePath,
    args.target_file,
    args.targetFile,
    args.TargetFile,
    args.filename,
    args.fileName,
    args.AbsolutePath,
    args.file,
    args.uri,
  ];
  for (const p of possible) {
    if (typeof p === "string" && p.trim().length > 0) return p.trim();
  }
  return undefined;
}

function extractDirPathFromArgs(args: Record<string, unknown>): string | undefined {
  const possible = [
    args.directory_path,
    args.directoryPath,
    args.dir_path,
    args.dirPath,
    args.DirectoryPath,
    args.SearchDirectory,
    args.path,
    args.dir,
    args.directory,
    args.folder,
  ];
  for (const p of possible) {
    if (typeof p === "string" && p.trim().length > 0) return p.trim();
  }
  return undefined;
}

function extractPatternFromArgs(args: Record<string, unknown>): string | undefined {
  const possible = [
    args.pattern,
    args.Pattern,
    args.glob,
    args.query,
    args.Query,
  ];
  for (const p of possible) {
    if (typeof p === "string" && p.trim().length > 0) return p.trim();
  }
  return undefined;
}

function extractCommandFromArgs(args: Record<string, unknown>): string | undefined {
  const possible = [
    args.command,
    args.cmd,
    args.command_line,
    args.commandLine,
    args.CommandLine,
    args.script,
    args.exec,
  ];
  for (const p of possible) {
    if (typeof p === "string" && p.trim().length > 0) return p.trim();
  }
  return undefined;
}

function extractFilePathFromText(text: string): string | undefined {
  const match = /(?:File Path|File|Viewing file):\s*[`"']?(file:\/\/\/[^\r\n`"']+|[A-Za-z]:[\\\/][^\r\n`"']+|\/[^\r\n`"']+)/i.exec(text);
  if (match && match[1]) return match[1].trim();
  return undefined;
}

function extractDirPathFromText(text: string): string | undefined {
  const match = /(?:Directory Path|Directory|Searching in):\s*[`"']?([A-Za-z]:[\\\/][^\r\n`"']+|\/[^\r\n`"']+|[^\r\n`"']+)/i.exec(text);
  if (match && match[1]) return match[1].trim();
  return undefined;
}

function extractCommandFromText(text: string): string | undefined {
  const match = /(?:^|\n)(?:[$>]|Command:)\s*(.+?)(?:\r?\n|$)/i.exec(text);
  if (match && match[1]) return match[1].trim();
  return undefined;
}

function extractPathsFromPatchContent(text: string): string[] {
  const paths: string[] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    const amMatch = /^[AMD]\s+(.+)$/.exec(trimmed);
    if (amMatch && amMatch[1]) {
      paths.push(amMatch[1].trim());
      continue;
    }
    const appliedMatch = /(?:Applied patch to|Updated)\s+["']?([^"'\r\n]+?)["']?$/i.exec(trimmed);
    if (appliedMatch && appliedMatch[1]) {
      paths.push(appliedMatch[1].trim());
      continue;
    }
    const diffMatch = /^(?:\+\+\+|\-\-\-|\*{3})\s+[ab]?\/?([^\s\t\r\n]+)/.exec(trimmed);
    if (diffMatch && diffMatch[1] && diffMatch[1] !== "dev/null") {
      paths.push(diffMatch[1].trim());
    }
  }
  return paths;
}

function countDirectoryItems(text: string): number {
  const countMatch = /(?:total(?:\s+entries)?|found|\bcount\b|items?)\s*[:=]?\s*(\d+)/i.exec(text)
    || /\((\d+)\s+items?\)/i.exec(text);
  if (countMatch && countMatch[1]) {
    const parsed = parseInt(countMatch[1], 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const itemLines = lines.filter(l => !l.startsWith("#") && !l.startsWith("Directory:") && !l.startsWith("Path:"));
  return Math.max(1, itemLines.length);
}

function extractExitCode(text: string, isError: boolean): number {
  const match = /(?:exit code:?|exited with code:?)\s*(\d+)/i.exec(text);
  if (match && match[1]) {
    return parseInt(match[1], 10);
  }
  return isError ? 1 : 0;
}

export function elideToolResultText(text: string): string {
  if (text.length <= TOOL_RESULT_HEAD_CHARS + TOOL_RESULT_TAIL_CHARS + 400) return text;
  const elided = text.length - TOOL_RESULT_HEAD_CHARS - TOOL_RESULT_TAIL_CHARS;
  return `${text.slice(0, TOOL_RESULT_HEAD_CHARS)}\n`
    + `[... ${elided.toLocaleString("en-US")} characters elided from this older tool result ...]\n`
    + text.slice(text.length - TOOL_RESULT_TAIL_CHARS);
}

function compactCommandOutput(text: string, isError: boolean, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const exitCode = extractExitCode(text, isError);
  if (exitCode === 0 && !isError) {
    const headChars = 400;
    const tailChars = 200;
    if (text.length <= headChars + tailChars + 200) return text;
    const elided = text.length - headChars - tailChars;
    return `${text.slice(0, headChars)}\n[... ${elided.toLocaleString("en-US")} characters elided from completed command output ...]\n${text.slice(text.length - tailChars)}`;
  } else {
    const headChars = 500;
    const tailChars = 500;
    if (text.length <= headChars + tailChars + 200) return text;
    const elided = text.length - headChars - tailChars;
    return `${text.slice(0, headChars)}\n[... ${elided.toLocaleString("en-US")} characters elided from failed command output ...]\n${text.slice(text.length - tailChars)}`;
  }
}

/**
 * Sentinel-delimited payloads carry structured state that only survives intact, so a result holding
 * one is never rewritten.
 */
function hasVisualizationDirectives(text: string): boolean {
  return /[\uE200\uE201\uE202]/.test(text);
}

const VISUALIZATION_PATH_PATTERN = /[\\/]\.codex[\\/]visualizations[\\/][^\s"'`,;]+/gi;
const PATH_BOUNDARY = /[\s"'`,;]/;

/**
 * Anchoring the scan on the literal segment keeps it linear. Leading the pattern with a
 * `[^\s"'`,;]*` prefix instead made it backtrack from every offset, which took over twenty seconds
 * on a 140,000 character result with no whitespace in it - and unbroken output that long is exactly
 * what a build log or a minified bundle produces. The prefix is recovered by walking backwards.
 */
function visualizationPaths(text: string): string[] {
  if (!/\.codex/i.test(text)) return [];
  const paths: string[] = [];
  VISUALIZATION_PATH_PATTERN.lastIndex = 0;
  for (
    let match = VISUALIZATION_PATH_PATTERN.exec(text);
    match;
    match = VISUALIZATION_PATH_PATTERN.exec(text)
  ) {
    let start = match.index;
    while (start > 0 && !PATH_BOUNDARY.test(text[start - 1]!)) start -= 1;
    paths.push(text.slice(start, match.index + match[0].length));
  }
  return [...new Set(paths)];
}

/**
 * The Visualize panel finds the artifact by scanning tool results for its
 * `.codex/visualizations/*.html` path. Protecting every result that merely mentions that path cost
 * a measured 25-40% of the achievable saving on visualization sessions, where most of the history
 * mentions it. Shortening those results is fine; making the path disappear is not, so any path the
 * rewrite dropped is restated at the end of the pruned text.
 */
function withPreservedVisualizationPaths(original: string, pruned: string): string {
  const missing = visualizationPaths(original).filter(path => !pruned.includes(path));
  if (missing.length === 0) return pruned;
  return `${pruned}\n[visualization artifacts referenced above: ${missing.join(", ")}]`;
}

/** Re-state any visualization path a rewrite dropped, for every result the caller changed. */
function restoreVisualizationPaths(
  before: readonly CodexMessage[],
  after: CodexMessage[],
): CodexMessage[] {
  for (let index = 0; index < after.length; index += 1) {
    const pruned = after[index]!;
    const original = before[index]!;
    if (pruned === original || pruned.role !== "toolResult" || original.role !== "toolResult") continue;
    const prunedText = textFromContent(pruned.content);
    const repaired = withPreservedVisualizationPaths(textFromContent(original.content), prunedText);
    if (repaired !== prunedText) {
      after[index] = { ...pruned, content: updateContentText(pruned.content, repaired) };
    }
  }
  return after;
}

function computeTurnNumbers(messages: readonly CodexMessage[]): number[] {
  const turnNumbers = new Array<number>(messages.length);
  let currentTurn = 1;
  let seenNonInstructionUser = false;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role === "user" && !isInstructionMessage(msg)) {
      if (seenNonInstructionUser) {
        currentTurn += 1;
      }
      seenNonInstructionUser = true;
    }
    turnNumbers[i] = currentTurn;
  }
  return turnNumbers;
}

interface ToolCallEntry {
  id: string;
  name: string;
  args: Record<string, unknown>;
  messageIndex: number;
  turnNumber: number;
}

export function pruneSemanticToolResults(
  messages: readonly CodexMessage[],
  options?: SemanticPruneOptions,
): CodexMessage[] {
  if (messages.length === 0) return [];

  const verbatimTail = options?.verbatimTailMessages ?? CHATGPT_DEFAULT_VERBATIM_TOOL_RESULT_MESSAGES;
  const maxCommandChars = options?.maxCommandOutputChars ?? CHATGPT_DEFAULT_MAX_COMMAND_OUTPUT_CHARS;
  const verbatimThreshold = messages.length - verbatimTail;

  /**
   * Recency is the only protection. Anchoring it to the latest user message instead protected the
   * entire history of an agent session - measured at 66 of 66 tool results on a real 140-message
   * run - because the user asks once and the agent then works alone for hundreds of steps, so every
   * index sat after that one ask. The long autonomous trajectory is exactly what has to be pruned.
   */
  const isProtected = (index: number): boolean => index >= verbatimThreshold;

  const turnNumbers = computeTurnNumbers(messages);

  // Build index of tool calls from assistant messages
  const toolCalls = new Map<string, ToolCallEntry>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "toolCall") {
          toolCalls.set(part.id, {
            id: part.id,
            name: part.name,
            args: part.arguments || {},
            messageIndex: i,
            turnNumber: turnNumbers[i]!,
          });
        }
      }
    }
  }

  // Pre-scan file modifications from all assistant tool calls (e.g. apply_patch, write_to_file)
  const seenFileMods = new Map<string, { turn: number; messageIndex: number; displayPath: string }>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "toolCall" && isModifyFileTool(baseToolName(part.name))) {
          const path = extractFilePathFromArgs(part.arguments || {});
          if (path) {
            const norm = normalizePath(path);
            if (!seenFileMods.has(norm)) {
              seenFileMods.set(norm, {
                turn: turnNumbers[i]!,
                messageIndex: i,
                displayPath: cleanDisplayPath(path),
              });
            }
          }
        }
      }
    }
  }

  // Registries for supersession (scanning backwards)
  const seenFileReads = new Map<string, { turn: number; messageIndex: number; displayPath: string }>();
  const seenDirListings = new Map<string, { turn: number; messageIndex: number; displayDir: string }>();
  const seenCommands = new Map<string, { turn: number; messageIndex: number; command: string }>();

  // Copy of messages to return
  const result: CodexMessage[] = [...messages];

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== "toolResult") continue;

    const text = textFromContent(msg.content);
    if (hasVisualizationDirectives(text)) {
      continue;
    }

    const toolCall = toolCalls.get(msg.toolCallId);
    const rawToolName = msg.toolName || toolCall?.name || "";
    const baseName = baseToolName(rawToolName);
    const args = toolCall?.args || {};

    // 1. File Modification Result Check (e.g. apply_patch result)
    if (isModifyFileTool(baseName) || rawToolName.includes("apply_patch") || rawToolName.includes("write_to_file")) {
      const explicitPath = extractFilePathFromArgs(args);
      const patchPaths = explicitPath ? [explicitPath] : extractPathsFromPatchContent(text);
      for (const p of patchPaths) {
        const norm = normalizePath(p);
        if (!seenFileMods.has(norm)) {
          seenFileMods.set(norm, {
            turn: turnNumbers[i]!,
            messageIndex: i,
            displayPath: cleanDisplayPath(p),
          });
        }
      }
      // If apply_patch is outside protected window and huge, elide it
      if (!isProtected(i) && text.length > 6400) {
        const elided = elideToolResultText(text);
        if (elided !== text) {
          result[i] = { ...msg, content: updateContentText(msg.content, elided) };
        }
      }
      continue;
    }

    // 2. File Read Tool Results (e.g. view_file, read_file, cat)
    if (isReadFileTool(baseName) || extractFilePathFromArgs(args) !== undefined) {
      const filePath = extractFilePathFromArgs(args) || extractFilePathFromText(text);
      if (filePath) {
        const norm = normalizePath(filePath);
        if (isProtected(i)) {
          if (!seenFileReads.has(norm)) {
            seenFileReads.set(norm, {
              turn: turnNumbers[i]!,
              messageIndex: i,
              displayPath: cleanDisplayPath(filePath),
            });
          }
        } else {
          const mod = seenFileMods.get(norm);
          const isModNewer = mod !== undefined && mod.messageIndex > i;
          const newerRead = seenFileReads.get(norm);
          const isReadNewer = newerRead !== undefined && newerRead.messageIndex > i;
          if (isModNewer || isReadNewer) {
            const supersededByTurn = Math.max(isModNewer ? mod.turn : 0, isReadNewer ? newerRead.turn : 0);
            const lineCount = text.split(/\r?\n/).length;
            const charCount = text.length;
            const receipt = `[Earlier file content of '${cleanDisplayPath(filePath)}' (${lineCount} lines, ${charCount} chars) superseded by subsequent read/modification at turn ${supersededByTurn}]`;
            result[i] = { ...msg, content: updateContentText(msg.content, receipt) };
          } else {
            // Newest read of this file (at or after any prior modification)
            seenFileReads.set(norm, {
              turn: turnNumbers[i]!,
              messageIndex: i,
              displayPath: cleanDisplayPath(filePath),
            });
            if (text.length > 6400) {
              const elided = elideToolResultText(text);
              if (elided !== text) {
                result[i] = { ...msg, content: updateContentText(msg.content, elided) };
              }
            }
          }
        }
        continue;
      }
    }

    // 3. Directory Listing Tool Results (e.g. list_dir, find_by_name, ls, dir)
    if (isListDirTool(baseName) || extractDirPathFromArgs(args) !== undefined) {
      const dirPath = extractDirPathFromArgs(args) || extractDirPathFromText(text) || ".";
      const pattern = extractPatternFromArgs(args);
      const targetKey = normalizePath(dirPath) + (pattern ? `::${pattern.toLowerCase()}` : "");

      if (isProtected(i)) {
        if (!seenDirListings.has(targetKey)) {
          seenDirListings.set(targetKey, {
            turn: turnNumbers[i]!,
            messageIndex: i,
            displayDir: cleanDisplayPath(dirPath),
          });
        }
      } else {
        const newerListing = seenDirListings.get(targetKey);
        if (newerListing) {
          const itemCount = countDirectoryItems(text);
          const receipt = `[Earlier directory listing of '${cleanDisplayPath(dirPath)}' (${itemCount} items) superseded by turn ${newerListing.turn}]`;
          result[i] = { ...msg, content: updateContentText(msg.content, receipt) };
        } else {
          seenDirListings.set(targetKey, {
            turn: turnNumbers[i]!,
            messageIndex: i,
            displayDir: cleanDisplayPath(dirPath),
          });
          if (text.length > 6400) {
            const elided = elideToolResultText(text);
            if (elided !== text) {
              result[i] = { ...msg, content: updateContentText(msg.content, elided) };
            }
          }
        }
      }
      continue;
    }

    // 4. Command Execution Tool Results (e.g. exec_command, shell_command, exec)
    if (isExecCommandTool(baseName) || extractCommandFromArgs(args) !== undefined) {
      const cmd = extractCommandFromArgs(args) || extractCommandFromText(text);
      if (cmd && cmd.trim().length > 0) {
        const normCmd = cmd.trim();
        if (isProtected(i)) {
          if (!seenCommands.has(normCmd)) {
            seenCommands.set(normCmd, {
              turn: turnNumbers[i]!,
              messageIndex: i,
              command: normCmd,
            });
          }
        } else {
          const newerCmd = seenCommands.get(normCmd);
          if (newerCmd) {
            const exitCode = extractExitCode(text, msg.isError);
            const displayCmd = normCmd.length > 80 ? normCmd.slice(0, 77) + "..." : normCmd;
            const receipt = `[Command \`${displayCmd}\` output superseded by subsequent execution; Exit code: ${exitCode}]`;
            result[i] = { ...msg, content: updateContentText(msg.content, receipt) };
          } else {
            seenCommands.set(normCmd, {
              turn: turnNumbers[i]!,
              messageIndex: i,
              command: normCmd,
            });
            if (text.length > maxCommandChars) {
              const compacted = compactCommandOutput(text, msg.isError, maxCommandChars);
              if (compacted !== text) {
                result[i] = { ...msg, content: updateContentText(msg.content, compacted) };
              }
            }
          }
        }
        continue;
      } else if (!isProtected(i) && text.length > maxCommandChars) {
        const compacted = compactCommandOutput(text, msg.isError, maxCommandChars);
        if (compacted !== text) {
          result[i] = { ...msg, content: updateContentText(msg.content, compacted) };
        }
        continue;
      }
    }

    // 5. Fallback for other older tool results
    if (!isProtected(i) && text.length > 6400) {
      const elided = elideToolResultText(text);
      if (elided !== text) {
        result[i] = { ...msg, content: updateContentText(msg.content, elided) };
      }
    }
  }

  return restoreVisualizationPaths(messages, result);
}

/**
 * Progressive deep tool result compaction: for non-recent tool results outside the active turn
 * and verbatim tail, reduces any remaining bulky outputs to compact 1-line semantic receipts.
 */
export function compactToolResultsToReceipts(
  messages: readonly CodexMessage[],
  verbatimTail = CHATGPT_DEFAULT_VERBATIM_TOOL_RESULT_MESSAGES,
): CodexMessage[] {
  const verbatimThreshold = messages.length - verbatimTail;

  const compacted = messages.map((message, index) => {
    if (message.role !== "toolResult") return message;

    const text = textFromContent(message.content);
    if (hasVisualizationDirectives(text)) {
      return message;
    }

    if (index >= verbatimThreshold) {
      // The recent window stays verbatim, with one exception: an oversized result is not preserved
      // by keeping it, only by keeping the head and tail that still fit.
      if (text.length <= CHATGPT_MAX_SINGLE_TOOL_RESULT_CHARS) return message;
      const elided = elideToolResultText(text);
      return elided === text
        ? message
        : { ...message, content: updateContentText(message.content, elided) };
    }

    if (text.length <= 150) return message;

    const charCount = text.length;
    const toolName = message.toolName || "tool";
    const receipt = `[Tool '${toolName}' completed with ${charCount.toLocaleString("en-US")} chars of output]`;
    return {
      ...message,
      content: updateContentText(message.content, receipt),
    };
  });
  return restoreVisualizationPaths(messages, compacted);
}
