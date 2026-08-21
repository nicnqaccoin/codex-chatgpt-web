import { describe, expect, test } from "bun:test";
import {
  CHATGPT_MENU_ANIMATION_SETTLE_MS,
  CHATGPT_UI_SETTLE_MS,
  CHATGPT_PROMPT_INSERT_CHUNK_CHARS,
  normalizeComposerWhitespace,
  promptInsertChunkEnd,
} from "../src/adapters/chatgpt-web/browser-worker";

describe("Milestone M3: R1 Browser Turn Overhead Latency Reduction", () => {
  // The connector row is virtualized and replaced during the menu's fill animation, so its geometry
  // needs more headroom than an ordinary composer settle: a bounding box read mid-animation is
  // stale but non-null, and the trusted mouse click then hits a sibling row.
  test("connector menu animation keeps more settle headroom than the composer", () => {
    expect(CHATGPT_MENU_ANIMATION_SETTLE_MS).toBeGreaterThanOrEqual(500);
    expect(CHATGPT_MENU_ANIMATION_SETTLE_MS).toBeGreaterThan(CHATGPT_UI_SETTLE_MS);
  });

  test("promptInsertChunkEnd partitions large prompts accurately without dropping chars", () => {
    const text = "x".repeat(50_000);
    let offset = 0;
    const parts: string[] = [];
    while (offset < text.length) {
      const end = promptInsertChunkEnd(text, offset);
      expect(end).toBeGreaterThan(offset);
      expect(end - offset).toBeLessThanOrEqual(CHATGPT_PROMPT_INSERT_CHUNK_CHARS);
      parts.push(text.slice(offset, end));
      offset = end;
    }
    expect(parts.join("")).toBe(text);
    expect(parts.length).toBe(4); // 16k + 16k + 16k + 2k
  });

  test("whitespace normalizer preserves formatting and length invariants", () => {
    const raw = "const foo = 1;\n\nconst bar = 2;";
    expect(normalizeComposerWhitespace(raw)).toBe(raw);
    expect(normalizeComposerWhitespace("hello\r\nworld")).toBe("hello\n\nworld");
  });
});
