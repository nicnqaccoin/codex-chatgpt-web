import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ARTIFACT_DIAGNOSTIC_MAX_RECORDS,
  appendBounded,
  messageFingerprint,
} from "../src/adapters/chatgpt-web/artifact-diagnostics";

const dirs: string[] = [];
function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "artifact-diag-"));
  dirs.push(dir);
  return join(dir, "artifact-detection.jsonl");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("the fingerprint carries a length and digest but never the text", () => {
  const secret = "draw newton's third law with a blue apple and my phone number 0987654321";
  const fp = messageFingerprint(secret);
  expect(fp.chars).toBe(secret.length);
  expect(fp.digest).toMatch(/^[0-9a-f]{12}$/);
  expect(JSON.stringify(fp)).not.toContain("newton");
  expect(JSON.stringify(fp)).not.toContain("0987654321");
  // Same input reproduces the digest, so repeats still correlate.
  expect(messageFingerprint(secret).digest).toBe(fp.digest);
});

// Each write re-reads and rewrites the whole file; that is cheap for a near-miss that fires rarely
// in production but slow in a tight 205-iteration loop on Windows fs, so the timeout is widened.
test("the on-disk log stays bounded across writes, keeping the newest", () => {
  const target = tempFile();
  const total = ARTIFACT_DIAGNOSTIC_MAX_RECORDS + 5;
  for (let i = 0; i < total; i += 1) appendBounded(target, JSON.stringify({ seq: i }));

  const lines = readFileSync(target, "utf8").split("\n").filter(Boolean);
  expect(lines.length).toBe(ARTIFACT_DIAGNOSTIC_MAX_RECORDS);
  // The oldest five were trimmed; the last line is the most recent write.
  expect(JSON.parse(lines[0]!).seq).toBe(5);
  expect(JSON.parse(lines.at(-1)!).seq).toBe(total - 1);
}, 30_000);

test("bounding survives a fresh process seeing an already-full file", () => {
  const target = tempFile();
  for (let i = 0; i < ARTIFACT_DIAGNOSTIC_MAX_RECORDS; i += 1) appendBounded(target, JSON.stringify({ seq: i }));
  // A "restart" resets any in-memory counter but the file is already at the cap; one more write must
  // not push it over.
  appendBounded(target, JSON.stringify({ seq: 999 }));
  const lines = readFileSync(target, "utf8").split("\n").filter(Boolean);
  expect(lines.length).toBe(ARTIFACT_DIAGNOSTIC_MAX_RECORDS);
  expect(JSON.parse(lines.at(-1)!).seq).toBe(999);
});
