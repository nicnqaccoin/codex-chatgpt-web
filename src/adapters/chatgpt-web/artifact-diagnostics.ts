import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { createHash } from "crypto";
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
 * The record needs to tell one near-miss apart from another and spot a repeat, not reproduce what the
 * user typed. A length and a short digest do both without writing their prompt to a plaintext file
 * that outlives the turn.
 */
export function messageFingerprint(text: string): { chars: number; digest: string } {
  return { chars: text.length, digest: createHash("sha256").update(text).digest("hex").slice(0, 12) };
}

/**
 * MAX_RECORDS only ever bounded one process: the counter reset on every launcher restart while the
 * file kept growing. Trim the file itself to the newest MAX_RECORDS lines so it stays bounded across
 * restarts regardless of the in-memory guard.
 */
export const ARTIFACT_DIAGNOSTIC_MAX_RECORDS = MAX_RECORDS;

export function appendBounded(target: string, line: string): void {
  let kept: string[] = [];
  try {
    kept = readFileSync(target, "utf8").split("\n").filter(entry => entry.length > 0);
  } catch {
    // First write, or an unreadable file we are about to replace.
  }
  kept.push(line);
  if (kept.length > MAX_RECORDS) kept = kept.slice(kept.length - MAX_RECORDS);
  if (kept.length === 1) {
    appendFileSync(target, `${line}\n`, "utf8");
  } else {
    writeFileSync(target, `${kept.join("\n")}\n`, "utf8");
  }
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
  const latestUser = messageFingerprint(messageText(messages[latestUserIndex] ?? ({} as CodexMessage)));
  const record = {
    at: new Date().toISOString(),
    messageCount: messages.length,
    latestUserIndex,
    // Shape only, never the user's text: enough to correlate and dedup, nothing to read back.
    latestUserChars: latestUser.chars,
    latestUserDigest: latestUser.digest,
    scannedAfterUser: scanned.length,
    toolResultsAfterUser: scanned.filter(message => message.role === "toolResult").length,
    visualizationPathsAnywhere: pathsAnywhere,
    visualizationPathsAfterUser: scanned.filter(message => VISUALIZATION_MARKER.test(messageText(message))).length,
    tailRoles: messages.slice(-8).map(message => message.role),
  };
  try {
    const target = diagnosticsPath();
    mkdirSync(dirname(target), { recursive: true });
    appendBounded(target, JSON.stringify(record));
  } catch {
    // Diagnostics must never break a turn.
  }
}
