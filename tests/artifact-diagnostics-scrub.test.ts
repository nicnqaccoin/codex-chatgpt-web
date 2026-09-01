import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubLegacyArtifactDiagnostics } from "../src/adapters/chatgpt-web/artifact-diagnostics";

const dirs: string[] = [];
function tempFile(lines: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), "artifact-scrub-"));
  dirs.push(dir);
  const path = join(dir, "artifact-detection.jsonl");
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : ""), "utf8");
  return path;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("a legacy file with plaintext previews is scrubbed, keeping the rest of each record", () => {
  const path = tempFile([
    { at: "t1", messageCount: 3, latestUserPreview: "draw newton's law, phone 0987654321", visualizationPathsAnywhere: 1 },
    { at: "t2", messageCount: 5, latestUserPreview: "another secret prompt", visualizationPathsAnywhere: 2 },
  ]);

  const scrubbed = scrubLegacyArtifactDiagnostics(path);
  expect(scrubbed).toBe(2);

  const text = readFileSync(path, "utf8");
  expect(text).not.toContain("newton");
  expect(text).not.toContain("0987654321");
  expect(text).not.toContain("latestUserPreview");
  // The non-sensitive shape survives; the preview's length is retained as latestUserChars.
  const first = JSON.parse(text.split("\n").filter(Boolean)[0]!);
  expect(first.messageCount).toBe(3);
  expect(first.visualizationPathsAnywhere).toBe(1);
  expect(first.latestUserChars).toBe("draw newton's law, phone 0987654321".length);
});

test("running twice is a no-op the second time", () => {
  const path = tempFile([{ at: "t1", latestUserPreview: "secret" }]);
  expect(scrubLegacyArtifactDiagnostics(path)).toBe(1);
  expect(scrubLegacyArtifactDiagnostics(path)).toBe(0);
});

test("a file already using digests is left untouched", () => {
  const path = tempFile([{ at: "t1", latestUserChars: 12, latestUserDigest: "abc123def456" }]);
  const before = readFileSync(path, "utf8");
  expect(scrubLegacyArtifactDiagnostics(path)).toBe(0);
  expect(readFileSync(path, "utf8")).toBe(before);
});

test("a missing file is a no-op, not an error", () => {
  expect(scrubLegacyArtifactDiagnostics(join(tmpdir(), "does-not-exist-artifact.jsonl"))).toBe(0);
});
