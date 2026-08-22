# Reviewer 1 Report: Milestone M2 (R3 Markdown Streaming Correctness)

## 1. Observation
- **Target Files Inspected**: `src/adapters/chatgpt-web/markdown.ts`, `tests/markdown-buffer.test.ts`.
- `ChatGptMarkdownBuffer`:
  - `activeEmitted` and `activeIndex` track in-flight leaf-block streaming without committing incomplete blocks prematurely.
  - Slicing via `block.slice(this.activeEmitted.length)` is guarded by `block.startsWith(this.activeEmitted)` ensuring 100% strictly monotonic string expansion.
  - `emittedBlockIndex` cleanly handles transition across multiple sequential blocks and groups.
  - Stability window defaults to `250ms` (down from `750ms`), significantly reducing burst latency while retaining safety for DOM hydration.
  - `finish()` flushes any uncommitted remainder and asserts the completed prefix.
- All 6 tests in `tests/markdown-buffer.test.ts` pass cleanly.

## 2. Logic Chain
- Single-block streaming is now supported because active leaf blocks emit incremental text deltas immediately rather than buffering until a succeeding block appears.
- Because deltas are derived from monotonic prefixes of the Turndown-converted Markdown, the stream is guaranteed to be append-only.
- Grouping logic (e.g. for `ul`/`ol` list items) is preserved: intra-group separators use `\n` while inter-block separators use `\n\n`.

## 3. Caveats
- Complex LaTeX expressions rendered via KaTeX might rewrite math syntax between partial and complete renders. The monotonic prefix guard (`startsWith`) safely delays emission if a non-monotonic rewrite occurs until the block completes or stabilizes.

## 4. Conclusion
The implementation of R3 leaf-block streaming in `markdown.ts` is verified sound, correct, and robust. **VERDICT: PASS**.

## 5. Verification Method
- `npx -y bun@1.3.14 test tests/markdown-buffer.test.ts` (6 pass, 0 fail).
