import { expect, test } from "bun:test";
import {
  CHATGPT_PROMPT_INSERT_CHUNK_CHARS,
  normalizeComposerWhitespace,
  promptAttachmentFailure,
  promptInsertChunkEnd,
} from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";

function chunks(text: string): string[] {
  const parts: string[] = [];
  for (let offset = 0; offset < text.length;) {
    const end = promptInsertChunkEnd(text, offset);
    expect(end).toBeGreaterThan(offset);
    parts.push(text.slice(offset, end));
    offset = end;
  }
  return parts;
}

test("chunking never loses or reorders a character", () => {
  const text = "a".repeat(15_994) + "      " + "b".repeat(20_000);
  expect(chunks(text).join("")).toBe(text);
});

test("a chunk never ends on whitespace the composer would rewrite", () => {
  const text = "a".repeat(15_994) + "      " + "b".repeat(20_000);
  const [first] = chunks(text);
  expect(first!.length).toBe(15_994);
  expect(/\s$/.test(first!)).toBe(false);
});

test("a chunk ends where a whitespace run starts instead of splitting it", () => {
  const text = "d".repeat(15_000) + " ".repeat(2_000) + "e".repeat(5_000);
  const parts = chunks(text);
  // The boundary lookback reaches back over the whole run, so the chunk stops short of the hard
  // limit rather than ending inside the spaces. A chunk that ends on whitespace leaves that
  // character last in the composer, where the surface rewrites it - a trailing space becomes
  // U+00A0 - and the exact readback then fails on a prompt that arrived intact.
  expect(parts[0]!.length).toBe(15_000);
  expect(parts[0]!.length).toBeLessThan(CHATGPT_PROMPT_INSERT_CHUNK_CHARS);
  expect(/\s$/.test(parts[0]!)).toBe(false);
  expect(parts.join("")).toBe(text);
});

test("a surrogate pair is never split at a boundary", () => {
  const text = "f".repeat(15_999) + "\u{1F600}" + "g".repeat(20_000);
  const parts = chunks(text);
  expect(parts.join("")).toBe(text);
  expect(/[\uD800-\uDBFF]$/.test(parts[0]!)).toBe(false);
});

test("composer whitespace rewrites are treated as equivalent and preserve length", () => {
  expect(normalizeComposerWhitespace("abc def")).toBe(normalizeComposerWhitespace("abc def"));
  expect(normalizeComposerWhitespace("a\r\nb")).toBe(normalizeComposerWhitespace("a\n\nb"));
  expect(normalizeComposerWhitespace("abc")).not.toBe(normalizeComposerWhitespace("abd"));
  expect(normalizeComposerWhitespace("abcdef")).toHaveLength(6);
});

test("a clean-prefix truncation is a non-retryable context error, not a transport fault", () => {
  const failure = promptAttachmentFailure("x".repeat(127_999), "x".repeat(111_999), "chunk");
  expect(failure).toBeInstanceOf(ChatGptWebAdapterError);
  expect((failure as ChatGptWebAdapterError).status).toBe(400);
  expect((failure as ChatGptWebAdapterError).code).toBe("context_length_exceeded");
  expect((failure as ChatGptWebAdapterError).retryable).toBe(false);
});

test("a mid-text divergence stays retryable and names the exact codepoints", () => {
  const failure = promptAttachmentFailure("abc def", "abc def", "chunk");
  expect(failure).not.toBeInstanceOf(ChatGptWebAdapterError);
  expect(failure.message).toContain("divergenceAt=3");
  expect(failure.message).toContain("U+0020");
  expect(failure.message).toContain("U+00A0");
});

test("an empty composer stays a retryable transport fault", () => {
  const failure = promptAttachmentFailure("prompt", "", "complete");
  expect(failure).not.toBeInstanceOf(ChatGptWebAdapterError);
  expect(failure.message).toContain("did not preserve the complete prompt");
});
