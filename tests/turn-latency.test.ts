import { describe, expect, test } from "bun:test";
import {
  CHATGPT_MENU_ANIMATION_SETTLE_MS,
  CHATGPT_UI_SETTLE_MS,
  CHATGPT_PROMPT_INSERT_CHUNK_CHARS,
  normalizeComposerWhitespace,
  promptInsertChunkEnd,
} from "../src/adapters/chatgpt-web/browser-worker";

describe("Milestone M3: R1 Browser Turn Overhead Latency Reduction", () => {
  test("CHATGPT_UI_SETTLE_MS is bounded to <= 50ms for minimal turn latency", () => {
    expect(CHATGPT_UI_SETTLE_MS).toBeLessThanOrEqual(50);
    expect(CHATGPT_UI_SETTLE_MS).toBeGreaterThanOrEqual(10);
  });

  // The composer settle was cut 5x for latency; the connector menu's fill animation must not be
  // cut with it, or the trusted mouse click reads a stale row geometry and hits a sibling row.
  test("connector menu animation keeps its original settle headroom", () => {
    expect(CHATGPT_MENU_ANIMATION_SETTLE_MS).toBeGreaterThanOrEqual(500);
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
