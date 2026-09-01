import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { VERSION } from "../../version";
import { runtimeBuildId } from "../../runtime-manifest";

export const MAX_RECORDS_PER_FILE = 500;

function diagnosticsPath(fileName: string): string {
  return join(homedir(), ".codex-chatgpt-web", "diagnostics", fileName);
}

/**
 * MAX_RECORDS_PER_FILE was only ever a per-process guard: an in-memory counter reset on every launcher
 * restart while the file kept growing, which is how context-trim.jsonl reached six figures. Bound the
 * file itself to its newest MAX_RECORDS_PER_FILE lines, and keep the newest rather than refusing to
 * write past the cap - a recent failure is worth more than an ancient one. These fire about once per
 * turn, minutes apart, so re-reading a 500-line file each time costs nothing that matters.
 */
export function appendBoundedRecord(target: string, line: string): void {
  let kept: string[] = [];
  try {
    kept = readFileSync(target, "utf8").split("\n").filter(entry => entry.length > 0);
  } catch {
    // First write, or an unreadable file about to be replaced.
  }
  kept.push(line);
  if (kept.length > MAX_RECORDS_PER_FILE) kept = kept.slice(kept.length - MAX_RECORDS_PER_FILE);
  if (kept.length === 1) {
    appendFileSync(target, `${line}\n`, "utf8");
  } else {
    writeFileSync(target, `${kept.join("\n")}\n`, "utf8");
  }
}

/**
 * Append one JSONL record for something that would otherwise be invisible after the turn ends.
 * Diagnostics must never break a turn and must never fire from the test suite, whose fixtures
 * exercise these paths on purpose.
 */
export function appendDiagnosticRecord(fileName: string, record: Record<string, unknown>): void {
  if (process.env.NODE_ENV === "test" || process.env.BUN_TEST) return;
  try {
    const target = diagnosticsPath(fileName);
    mkdirSync(dirname(target), { recursive: true });
    // Stamp the build into every failure/trim record. The browser checkpoints already carry it, but
    // turn-failures.jsonl and context-trim.jsonl did not, so a failure could not be attributed to a
    // bundle - which is exactly why a same-semver hotfix could not be told apart when a turn broke.
    appendBoundedRecord(target, JSON.stringify({
      at: new Date().toISOString(),
      runtimeVersion: VERSION,
      buildId: runtimeBuildId(),
      ...record,
    }));
  } catch {
    // A diagnostics failure is never worth failing a turn over.
  }
}
