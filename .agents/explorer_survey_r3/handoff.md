# Handoff Report: R3 Explorer Survey (Real-time Streaming & Stall Mitigation)

## 1. Observation

### 1.1 ChatGptMarkdownBuffer & Streaming Pipeline
- **File**: `src/adapters/chatgpt-web/markdown.ts`
  - Line 124: `stabilityMs = 750` is the hardcoded default stability window.
  - Lines 158–167: Blocks are only committed when `candidate.streamable === true` AND `now - Math.max(candidate.changedAt, candidate.streamableAt) >= this.stabilityMs`.
  - Lines 182–193: `assertCommittedPrefix` strictly enforces append-only invariant on previously committed blocks.
  - Lines 195–205: `commit(segment)` uses Turndown with GFM plugin to convert HTML to Markdown.
- **File**: `src/adapters/chatgpt-web/browser-worker.ts`
  - Lines 1709–1757: `responseDomSnapshot` computes `streamable` for markdown segments:
    - `rootIsComplete = rootIndex < renderedRoots.length - 1` (line 1710)
    - `childIsComplete = rootIsComplete || childIndex < children.length - 1` (line 1726)
    - Line 1735: Active trailing child is marked `streamable: false`.
  - Lines 2146–2246: Polling loop runs every 250ms (`setTimeout(..., 250)`).
  - Line 2187: Invokes `markdownBuffer.observe(snapshot.markdownSegments)`.
  - Line 2188–2191: Invokes `visibleTrace.observe(...)` to emit reasoning and commentary.
  - Lines 2210–2214: Only on turn completion does `markdownBuffer.finish()` flush the active / uncommitted trailing blocks.

### 1.2 Stall Detection & Heartbeats
- **File**: `src/adapters/chatgpt-web/browser-worker.ts`
  - Lines 2226–2235: `if (!loggedCompletionWait && Date.now() - sentAt >= 30_000)` unconditionally captures diagnostic `response-stalled-30s` and logs warning `[chatgpt-web] waiting for completed-turn evidence` at 30 seconds, regardless of whether ChatGPT is actively reasoning or typing.
  - Lines 443–499: `ChatGptTurnDomHealthTracker` enforces `missingResponseMs = 60_000`, `emptyCompletionMs = 10_000`, and `missingCompletionActionMs = 60_000`.
- **File**: `src/adapters/chatgpt-web/index.ts`
  - Line 369: Emits `{ type: "heartbeat" }` on a fixed `setInterval(..., 10_000)`.
- **File**: `src/bridge.ts` & `src/stall-timeout.ts`
  - `src/stall-timeout.ts`: `DEFAULT_STALL_TIMEOUT_SEC = 300`.
  - `src/bridge.ts` lines 186–190, 712–743: Bridge runs a 2-second ticker (`heartbeatMs = 2_000`). Upstream adapter events reset `activity = true` and `stallTicks = 0`. If 300s of inactivity elapse, emits `response.incomplete` with reason `upstream_stall_timeout`.

### 1.3 Test Suite Status & Validation Baseline
- Test suite execution:
  - Command: `node -e "const { execSync } = require('child_process'); const fs = require('fs'); const files = fs.readdirSync('tests').filter(f => f.endsWith('.test.ts')).map(f => 'tests/' + f).join(' '); execSync('npx -y bun@1.3.14 test ' + files, { stdio: 'inherit' });"`
  - Result: **354 tests pass across 38 files** (0 failures, 1453 expect calls).
- TypeScript typecheck:
  - Command: `./node_modules/.bin/tsc --noEmit`
  - Result: **0 errors** (clean compilation).

---

## 2. Logic Chain

1. **Latency & Bursty Rendering Origin**:
   - `browser-worker.ts` marks any active leaf block as `streamable: false` because no succeeding block exists yet.
   - `ChatGptMarkdownBuffer` refuses to commit any block where `streamable === false`.
   - Therefore, while ChatGPT is actively generating a paragraph or single-block answer, 0 deltas are emitted to Codex.
   - When a second block finally appears, the first block must wait an additional `750ms` stability window plus `250ms` polling delay before emitting the entire accumulated paragraph in one large burst.
   - Single-paragraph answers never stream incrementally; they dump all text only at `finish()`.

2. **DOM Observation Inefficiency**:
   - Polling every 250ms triggers a complete CDP/Playwright `evaluate()` call that scans all `.markdown` roots, runs `getComputedStyle`, extracts inner HTML, and clones list items.
   - This creates continuous CPU overhead and introduces up to 250ms quantized latency on every stream event.

3. **False 30s Stall Alarms on Long CoT Reasoning**:
   - Because `response-stalled-30s` is evaluated against `Date.now() - sentAt >= 30_000`, any complex reasoning turn taking >30s (standard for GPT-5 High / o1-style deep thinking) unconditionally takes a screenshot and writes diagnostic artifacts to disk.
   - This causes disk I/O, potential UI stutter, and misleading log warnings when the model is healthy and actively thinking.

4. **Masked Upstream Hangs**:
   - In `index.ts`, `{ type: "heartbeat" }` is emitted on an independent 10-second `setInterval`.
   - Even if the browser worker, CDP connection, or helper process completely hangs, the bridge's 300s stall timeout may not trip because the decoupled timer keeps setting `activity = true`.

---

## 3. Caveats

- **Turndown GFM Mutation Risk**: ChatGPT occasionally hydronates or mutates LaTeX markup (`katex` spans) and citation markers asynchronously after initial DOM insertion. Care must be taken when lowering the stability window for complex math/table structures to prevent emitting partial syntax that later rewrites.
- **Lexical Composer vs Assistant Turn DOM**: DOM mutation observers in the assistant turn do not interact with composer input attachment; they are strictly scoped to `conversation-turn-assistant`.
- **Browser Helper Process Boundary**: When `browserHost === "launcher"` is used, events flow across the `browser-helper-main.ts` IPC line writer. Any streaming changes in the worker must ensure backward compatibility with the IPC message schema.

---

## 4. Conclusion & Actionable Recommendations

To implement R3 cleanly:
1. **ChatGptMarkdownBuffer Enhancements**:
   - Introduce active leaf-block monotonic text streaming for `<p>` and standard blocks.
   - Reduce default `stabilityMs` for standard text from `750ms` to `150ms–250ms`.
   - Ensure `finish()` and incremental deltas remain strictly append-only and GFM-compliant.
2. **DOM Pipeline Optimization**:
   - Implement in-page `MutationObserver` or adaptive polling (50ms–100ms when generating, backing off when idle).
   - Transmit delta-only segment payloads across the helper process boundary.
3. **Adaptive Heartbeat & Stall Mitigation**:
   - Convert `response-stalled-30s` into an **inactivity timer** (`Date.now() - lastActivityAt >= 30_000`).
   - Tie adapter heartbeats directly to verified browser DOM activity (text growth, trace block updates, thinking spinner activity) instead of an unconditional timer.
   - Classify confirmed browser hangs as retryable `ChatGptWebAdapterError` to trigger safe session retry.
4. **Comprehensive Test Suite**:
   - Add unit tests for single-block streaming, rapid mutation stability, GFM table/code preservation, and 90s+ CoT reasoning turns without false stall warnings.

---

## 5. Verification Method

To verify these findings independently:
1. **Run Unit & Integration Tests**:
   ```powershell
   node -e "const { execSync } = require('child_process'); const fs = require('fs'); const files = fs.readdirSync('tests').filter(f => f.endsWith('.test.ts')).map(f => 'tests/' + f).join(' '); execSync('npx -y bun@1.3.14 test ' + files, { stdio: 'inherit' });"
   ```
2. **Run TypeScript Check**:
   ```powershell
   ./node_modules/.bin/tsc --noEmit
   ```
3. **Inspect Key Files**:
   - `src/adapters/chatgpt-web/markdown.ts` (lines 115–206)
   - `src/adapters/chatgpt-web/browser-worker.ts` (lines 1709–1757, 2146–2246)
   - `src/adapters/chatgpt-web/index.ts` (lines 369, 450–520)
   - `src/bridge.ts` (lines 186–190, 712–743)
