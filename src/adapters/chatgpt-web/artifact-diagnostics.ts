import { appendFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import type { CodexMessage } from "../../types";

const VISUALIZATION_MARKER = /[\\/]\.codex[\\/]visualizations[\\/]/i;
const MAX_RECORDS = 200;
let recorded = 0;

function diagnosticsPath(): string {
  return join(homedir(), ".codex-chatgpt-web", "diagnostics", "artifact-detection.jsonl");
}

function messageText(message: CodexMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map(part => part.type === "text" ? part.text : "").join("\n");
}

/**
 * A turn that publishes a visualization but returns no content reference leaves the Result panel
 * empty with nothing to inspect afterwards: the request that produced it is gone. Record just enough
 * shape to tell which rule missed - and only for that near miss, so a healthy install writes nothing.
 */
export function recordArtifactDetectionMiss(
  messages: readonly CodexMessage[],
  latestUserIndex: number,
): void {
  // Test fixtures deliberately exercise the miss paths; their records would drown the real ones.
  if (process.env.NODE_ENV === "test" || process.env.BUN_TEST) return;
  if (recorded >= MAX_RECORDS) return;
  const scanned = messages.slice(latestUserIndex + 1);
  const pathsAnywhere = messages.filter(message => VISUALIZATION_MARKER.test(messageText(message))).length;
  if (pathsAnywhere === 0) return;
  recorded += 1;
  const record = {
    at: new Date().toISOString(),
    messageCount: messages.length,
    latestUserIndex,
    latestUserPreview: messageText(messages[latestUserIndex] ?? ({} as CodexMessage)).slice(0, 80),
    scannedAfterUser: scanned.length,
    toolResultsAfterUser: scanned.filter(message => message.role === "toolResult").length,
    visualizationPathsAnywhere: pathsAnywhere,
    visualizationPathsAfterUser: scanned.filter(message => VISUALIZATION_MARKER.test(messageText(message))).length,
    tailRoles: messages.slice(-8).map(message => message.role),
  };
  try {
    const target = diagnosticsPath();
    mkdirSync(dirname(target), { recursive: true });
    appendFileSync(target, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Diagnostics must never break a turn.
  }
}
