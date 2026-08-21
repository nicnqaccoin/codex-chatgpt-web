import { appendFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

const MAX_RECORDS_PER_FILE = 500;
const written = new Map<string, number>();

function diagnosticsPath(fileName: string): string {
  return join(homedir(), ".codex-chatgpt-web", "diagnostics", fileName);
}

/**
 * Append one JSONL record for something that would otherwise be invisible after the turn ends.
 * Diagnostics must never break a turn and must never fire from the test suite, whose fixtures
 * exercise these paths on purpose.
 */
export function appendDiagnosticRecord(fileName: string, record: Record<string, unknown>): void {
  if (process.env.NODE_ENV === "test" || process.env.BUN_TEST) return;
  const count = written.get(fileName) ?? 0;
  if (count >= MAX_RECORDS_PER_FILE) return;
  written.set(fileName, count + 1);
  try {
    const target = diagnosticsPath(fileName);
    mkdirSync(dirname(target), { recursive: true });
    appendFileSync(target, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, "utf8");
  } catch {
    // A diagnostics failure is never worth failing a turn over.
  }
}
