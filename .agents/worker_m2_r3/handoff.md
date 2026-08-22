# Worker Handoff: Milestone M2 (R3 Streaming Responsiveness & CoT Stall Mitigation)

## 1. Observation
- **Modified files**:
  1. `src/adapters/chatgpt-web/markdown.ts`:
     - Implemented monotonic active leaf-block streaming in `ChatGptMarkdownBuffer`.
     - Reduced default `stabilityMs` from `750ms` to `250ms`.
     - Added uncommitted block streaming tracking with `activeIndex` and `activeEmitted` state.
     - Preserved strict append-only markdown guarantees and GFM parsing.
  2. `src/adapters/chatgpt-web/browser-worker.ts`:
     - Replaced static 30s stall timer with a true DOM inactivity timer (`lastActivityAt`).
     - `lastActivityAt` updates and resets `loggedCompletionWait` whenever visible text changes, trace blocks change, or running/spinner state is active.
     - Stall warnings only trigger when 30s of genuine DOM inactivity elapse.
  3. `src/adapters/chatgpt-web/turn-execution.ts`:
     - Added `ChatGptHeartbeatFeed` and integrated it into `ChatGptTurnRuntimeBase`.
  4. `src/adapters/chatgpt-web/index.ts`:
     - Replaced decoupled `setInterval` with subscription to `session.runtime.heartbeats`, tying adapter heartbeats directly to verified browser DOM polling.
  5. `tests/markdown-buffer.test.ts` & `tests/stream-stall.test.ts`:
     - Added 9 new unit tests verifying leaf streaming, grouping, stability windows, inactivity timers, and heartbeat propagation.

## 2. Logic Chain
1. Active leaf-block streaming allows incremental tokens within an uncommitted `<p>` or list item to be emitted immediately as they appear, eliminating single-block and active-paragraph buffering latency.
2. Tracking `activeEmitted` ensures each chunk slice is strictly monotonic: `block.startsWith(activeEmitted)` guarantees append-only deltas with no retractions.
3. Updating `lastActivityAt` on text growth, trace updates, and spinner state ensures deep reasoning models (CoT taking >30s) are never falsely flagged as stalled.
4. Routing heartbeats through `ChatGptHeartbeatFeed` from the live browser worker loop guarantees that a frozen or crashed browser worker will cease heartbeats and trip upstream stall detection cleanly.

## 3. Caveats
- Fast typing in the browser can produce partial HTML elements; Turndown parses them safely via standard DOM parsing, but the monotonic prefix check ensures only valid incremental text is emitted.
- All visualization private-use sentinels `\uE200...\uE201` are untouched and preserved.

## 4. Conclusion
Milestone M2 (R3) implementation is complete, typechecks cleanly (`tsc --noEmit` exits 0), and all new and existing tests pass.

## 5. Verification Method
- Typecheck: `./node_modules/.bin/tsc --noEmit`
- Tests: `npx -y bun@1.3.14 test tests`
