import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_RECORDS_PER_FILE, appendBoundedRecord } from "../src/adapters/chatgpt-web/diagnostics-log";

const dirs: string[] = [];
function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "diag-log-"));
  dirs.push(dir);
  return join(dir, "turn-failures.jsonl");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("the file is capped at MAX_RECORDS_PER_FILE and keeps the newest across restarts", () => {
  const target = tempFile();
  const total = MAX_RECORDS_PER_FILE + 20;
  // Two loops stand in for two process lifetimes; the in-memory counter that used to bound this reset
  // between them, but the file must not grow past the cap regardless.
  for (let i = 0; i < total; i += 1) appendBoundedRecord(target, JSON.stringify({ seq: i }));

  const lines = readFileSync(target, "utf8").split("\n").filter(Boolean);
  expect(lines.length).toBe(MAX_RECORDS_PER_FILE);
  // The oldest were dropped, not the newest: a recent failure is the one worth keeping.
  expect(JSON.parse(lines[0]!).seq).toBe(total - MAX_RECORDS_PER_FILE);
  expect(JSON.parse(lines.at(-1)!).seq).toBe(total - 1);
}, 30_000);

test("a fresh process seeing an already-full file does not push it over", () => {
  const target = tempFile();
  for (let i = 0; i < MAX_RECORDS_PER_FILE; i += 1) appendBoundedRecord(target, JSON.stringify({ seq: i }));
  appendBoundedRecord(target, JSON.stringify({ seq: 9999 }));
  const lines = readFileSync(target, "utf8").split("\n").filter(Boolean);
  expect(lines.length).toBe(MAX_RECORDS_PER_FILE);
  expect(JSON.parse(lines.at(-1)!).seq).toBe(9999);
}, 30_000);
