import { describe, expect, test } from "bun:test";
import { ChatGptMarkdownBuffer, type ChatGptMarkdownSegment } from "../src/adapters/chatgpt-web/markdown";

describe("ChatGptMarkdownBuffer Responsiveness & Stability", () => {
  test("emits completed block after stability window elapses and flushes trailing block at finish", () => {
    const buffer = new ChatGptMarkdownBuffer(m => m, 250);

    const t0 = 1000;
    // Block 0 is completed (streamable: true), Block 1 is trailing active (streamable: false)
    const first = [
      { key: "0", html: "<p>First paragraph</p>", text: "First paragraph", streamable: true },
      { key: "1", html: "<p>Second paragraph</p>", text: "Second paragraph", streamable: false },
    ];

    // At t0: within stability window (0ms elapsed), no delta emitted yet
    expect(buffer.observe(first, t0)).toBe("");

    // At t0 + 100ms: still within 250ms stability window
    expect(buffer.observe(first, t0 + 100)).toBe("");

    // At t0 + 250ms: stability window elapsed for Block 0, Block 0 commits and emits
    expect(buffer.observe(first, t0 + 250)).toBe("First paragraph");

    // At finish: trailing Block 1 is committed and emitted with separator
    const final = buffer.finish();
    expect(final.delta).toBe("\n\nSecond paragraph");
    expect(final.markdown).toBe("First paragraph\n\nSecond paragraph");
  });

  // ChatGPT renders inline math as plain text and lets KaTeX rewrite it a few hundred milliseconds
  // later. A default window short enough to commit the pre-hydration block streams "F" and "x" as
  // separate lines, and an append-only Responses delta cannot be retracted once it is sent.
  test("default stability window outlasts ChatGPT's late KaTeX hydration", () => {
    const buffer = new ChatGptMarkdownBuffer();
    const t0 = 1000;
    const tail: ChatGptMarkdownSegment = { key: "1", html: "<p>tail</p>", text: "tail", streamable: false };
    const preHydration: ChatGptMarkdownSegment[] = [
      { key: "0", html: "<p>F<sub>x</sub></p>", text: "F\nx", streamable: true },
      tail,
    ];

    expect(buffer.observe(preHydration, t0)).toBe("");
    expect(buffer.observe(preHydration, t0 + 500)).toBe("");

    const hydrated: ChatGptMarkdownSegment[] = [
      { key: "0", html: '<p><span class="katex">F_x</span></p>', text: "F_x", streamable: true },
      tail,
    ];
    expect(buffer.observe(hydrated, t0 + 600)).toBe("");
    // Markdown-escaped, and crucially the hydrated text rather than the split "F\nx".
    expect(buffer.observe(hydrated, t0 + 1400)).toBe("F\\_x");
  });

  // ChatGPT rewrites finished blocks while it hydrates controls and citations. A rewrite that never
  // reaches the Markdown cannot change what a commit emits, so it must not restart the wait.
  test("a cosmetic HTML rewrite does not restart the stability window", () => {
    const buffer = new ChatGptMarkdownBuffer(m => m, 750);
    const t0 = 1000;
    const tail: ChatGptMarkdownSegment = { key: "1", html: "<p>tail</p>", text: "tail", streamable: false };
    const first: ChatGptMarkdownSegment[] = [
      { key: "0", html: "<p>Settled paragraph</p>", text: "Settled paragraph", streamable: true },
      tail,
    ];
    expect(buffer.observe(first, t0)).toBe("");

    const reskinned: ChatGptMarkdownSegment[] = [
      { key: "0", html: '<p class="mt-2 hydrated">Settled paragraph</p>', text: "Settled paragraph", streamable: true },
      tail,
    ];
    expect(buffer.observe(reskinned, t0 + 700)).toBe("");
    // Still committed on the original block's own deadline rather than 750ms after the reskin.
    expect(buffer.observe(reskinned, t0 + 750)).toBe("Settled paragraph");
  });

  test("handles list items within a group using single newline separators", () => {
    const buffer = new ChatGptMarkdownBuffer(m => m, 100);

    const t0 = 1000;
    const items = [
      { key: "0:0:ul:0", html: "<ul><li>Item 1</li></ul>", text: "Item 1", group: "0:0:ul", streamable: true },
      { key: "0:0:ul:1", html: "<ul><li>Item 2</li></ul>", text: "Item 2", group: "0:0:ul", streamable: true },
    ];

    expect(buffer.observe(items, t0)).toBe("");
    expect(buffer.observe(items, t0 + 100)).toBe("- Item 1\n- Item 2");

    const final = buffer.finish();
    expect(final.delta).toBe("");
    expect(final.markdown).toBe("- Item 1\n- Item 2");
  });

  test("respects stability window for committed blocks", () => {
    const buffer = new ChatGptMarkdownBuffer(m => m, 200);

    const t0 = 1000;
    buffer.observe([
      { key: "0", html: "<p>Block A</p>", text: "Block A", streamable: true },
    ], t0);

    const deltaMid = buffer.observe([
      { key: "0", html: "<p>Block A</p>", text: "Block A", streamable: true },
    ], t0 + 100);
    expect(deltaMid).toBe("");

    const deltaFinal = buffer.observe([
      { key: "0", html: "<p>Block A</p>", text: "Block A", streamable: true },
    ], t0 + 200);
    expect(deltaFinal).toBe("Block A");

    const finish = buffer.finish();
    expect(finish.markdown).toBe("Block A");
  });

  test("applies custom transform correctly to streamed chunks", () => {
    const stripFooter = (md: string) => md.replace(/\\?\[FOOTER\\?\]/g, "").trim();
    const buffer = new ChatGptMarkdownBuffer(stripFooter, 100);

    const t0 = 1000;
    buffer.observe([
      { key: "0", html: "<p>Body text [FOOTER]</p>", text: "Body text [FOOTER]", streamable: true },
    ], t0);

    const delta = buffer.observe([
      { key: "0", html: "<p>Body text [FOOTER]</p>", text: "Body text [FOOTER]", streamable: true },
    ], t0 + 100);
    expect(delta).toBe("Body text");

    const final = buffer.finish();
    expect(final.markdown).toBe("Body text");
  });

  test("fails closed if previously committed text block is removed or mutated", () => {
    const buffer = new ChatGptMarkdownBuffer(m => m, 50);

    buffer.observe([{ key: "0", html: "<p>Alpha</p>", text: "Alpha", streamable: true }], 100);
    buffer.observe([{ key: "0", html: "<p>Alpha</p>", text: "Alpha", streamable: true }], 150);

    expect(() => {
      buffer.observe([]);
    }).toThrow("ChatGPT removed a completed text block that was already streamed to Codex");

    expect(() => {
      buffer.observe([{ key: "0", html: "<p>Beta</p>", text: "Beta", streamable: true }]);
    }).toThrow("ChatGPT changed a completed text block that was already streamed to Codex");
  });
});
