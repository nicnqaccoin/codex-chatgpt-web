# R3 Investigation & Architectural Survey: Real-Time Streaming Responsiveness & Stall Mitigation

## 1. Executive Summary

This survey analyzes the streaming architecture, Markdown buffering, DOM observation pipeline, and response stall detection in `codex-chatgpt-web`. The goal of R3 is to:
1. **Reduce streaming latency and eliminate bursty terminal rendering** caused by coarse block-level buffering and conservative stability windows in `ChatGptMarkdownBuffer`.
2. **Optimize the DOM mutation observation pipeline** between the browser worker and the Codex client bridge for lower CPU/CDP overhead and faster delta propagation.
3. **Design an adaptive heartbeat and activity detection mechanism** for long Chain-of-Thought (CoT) reasoning turns (e.g., GPT-5 High / Pro reasoning) that eliminates false `response-stalled-30s` diagnostic storms while guaranteeing prompt recovery on genuine upstream browser hangs.
4. **Define explicit test coverage and benchmark scenarios** to validate streaming smoothness, Markdown correctness (GFM tables, fenced code, KaTeX math, nested lists), and stall recovery.

---

## 2. In-Depth Analysis of `ChatGptMarkdownBuffer`

### 2.1 File Location & Responsibilities
- **Source**: `src/adapters/chatgpt-web/markdown.ts`
- **Key Classes / Functions**:
  - `ChatGptMarkdownBuffer` (lines 115–206)
  - `chatGptHtmlToMarkdown()` (lines 84–86) + custom Turndown rules (lines 4–82)
  - `ChatGptMarkdownSegment` and `ChatGptMarkdownCandidate` interfaces (lines 88–104)

### 2.2 Current Emitting Mechanism
```typescript
export class ChatGptMarkdownBuffer {
  private readonly candidates = new Map<number, ChatGptMarkdownCandidate>();
  private readonly committed: CommittedChatGptMarkdownSegment[] = [];
  private latest: ChatGptMarkdownSegment[] = [];
  private markdown = "";
  private lastGroup: string | undefined;

  constructor(
    private readonly transform: (markdown: string) => string = markdown => markdown,
    private readonly stabilityMs = 750,
  ) {}
```
In `observe(segments, now)`:
1. Validates that previously committed segments have not changed (`assertCommittedPrefix`).
2. Iterates over incoming uncommitted segments and tracks `changedAt` and `streamableAt`.
3. Evaluates commitment eligibility:
   ```typescript
   if (!candidate?.streamable || candidate.streamableAt === undefined) break;
   if (now - Math.max(candidate.changedAt, candidate.streamableAt) < this.stabilityMs) break;
   delta += this.commit(candidate);
   ```
4. In `commit(segment)`:
   - Converts HTML to Markdown via `chatGptHtmlToMarkdown(segment.html)` (Turndown + GFM).
   - Inserts block separators (`\n\n` or `\n` if within the same list group).
   - Appends block to `this.markdown` and returns the newly committed slice as `delta`.
5. In `finish()`:
   - Commits all uncommitted segments immediately regardless of `streamable` flag or stability timer.

### 2.3 Root Causes of Latency & Bursty Terminal Rendering
1. **Block-Level Streamable Gate (No Intra-Block Streaming)**:
   - In `browser-worker.ts` (`responseDomSnapshot`), a segment's `streamable` flag is calculated as:
     `rootIsComplete = rootIndex < renderedRoots.length - 1`
     `childIsComplete = rootIsComplete || childIndex < children.length - 1`
   - **Consequence**: The currently active leaf block (the paragraph, code block, or list item ChatGPT is actively typing) has `streamable: false`. It CANNOT be streamed while being generated.
2. **Single-Block Responses Never Stream**:
   - If ChatGPT answers with a single paragraph, short answer, or single code block, no subsequent block ever appears during generation. As a result, `streamable` remains `false` throughout the turn. The entire answer only emits when `finish()` is invoked after generation ends completely.
3. **Compound Delay (Polling + Stability Window)**:
   - Even when child $N+1$ appears, child $N$ is subjected to `stabilityMs = 750ms` plus the 250ms polling loop interval. This introduces $>1000\text{ms}$ delay between block completion and client delivery.
4. **Bursty Delta Dumps**:
   - Instead of a smooth token stream (10–50 chars per frame), the client receives an entire 200–500 word paragraph in a single huge chunk, creating a jerky, discontinuous terminal display.
5. **Turndown Execution on Every Committed Block**:
   - Every block runs full Turndown HTML parsing and rule matching upon commit.

### 2.4 Recommended Architecture for Low-Latency Streaming
1. **Fine-Grained Active-Block Incremental Streaming**:
   - For standard paragraph (`<p>`) elements, detect monotonic text growth within the active element.
   - When text grows, commit stable prefix chunks (e.g. at sentence boundaries or whitespace boundaries that have stabilized for a smaller threshold, e.g. 100–150ms).
2. **Adaptive Stability Window**:
   - Reduce default `stabilityMs` for standard prose from `750ms` to `150ms–250ms`.
   - Keep conservative stability windows only for volatile or complex nodes that ChatGPT frequently rewrites during hydration (e.g. KaTeX math formulas, citations, tables).
3. **Turndown Optimization**:
   - Fast-path plain text and simple paragraphs without running full DOM AST parsers where direct text extraction with standard escaping suffices.

---

## 3. DOM Mutation Observer & Bridge Pipeline

### 3.1 Current Architecture & Flow
```
[ ChatGPT Web Page (Chrome / Electron) ]
         │
         │  Playwright page.evaluate() via responseDomSnapshot()
         │  (Triggered every 250ms in polling loop)
         ▼
[ ChatGptBrowserWorker (browser-worker.ts) ]
   ├── ChatGptVisibleTraceTracker (trace blocks: status / commentary)
   ├── ChatGptMarkdownBuffer (final answer markdown segments)
   └── ChatGptTurnDomHealthTracker (DOM presence & completion checks)
         │
         │  IPC Line Writer (browser-helper-main.ts <-> launcher-helper-client.ts)
         │  protocol: { type: "event", event: "text" | "reasoning" | "commentary", text: "..." }
         ▼
[ ChatGptTurnSessions Runtime (src/adapters/chatgpt-web/index.ts) ]
   ├── ChatGptTextFeed (drainable async text stream)
   └── ChatGptTraceFeed (drainable async trace stream)
         │
         │  Async Iterator Yield
         ▼
[ SSE Responses Bridge (src/bridge.ts) ]
   ├── response.output_item.added / delta / done
   └── response.heartbeat (keep-alive SSE frames)
         │
         ▼
[ Codex Client / Terminal UI ]
```

### 3.2 Key Findings & Bottlenecks
1. **250ms Polling Loop**:
   - `browser-worker.ts` lines 2146–2246 run a loop with `await new Promise(r => setTimeout(r, 250))`.
   - Each tick calls `responseDomSnapshot()` which executes heavy `querySelectorAll`, `getComputedStyle`, and `cloneNode` operations inside the browser page context.
2. **Payload Serialization Overhead**:
   - Every 250ms snapshot serializes full HTML strings and inner text of all markdown roots across the CDP boundary, even when only a few characters changed in the latest block.
3. **Segregation of Commentary vs Final Answer**:
   - Top-level `.markdown` inside `[data-streaming-response-status]` is routed to intermediate commentary (`onCommentary`), while top-level `.markdown` outside status containers is routed to `ChatGptMarkdownBuffer` (`onTextDelta`).
   - `ChatGptVisibleTraceTracker` uses `traceStabilityMs = 250ms` to buffer status labels and commentary paragraphs.

### 3.3 Proposed Mutation Observer Improvements
1. **In-Page `MutationObserver` Integration**:
   - Inject a lightweight `MutationObserver` on the active turn container (`conversation-turn-assistant`) that queues element mutations.
   - When mutations occur, notify the worker via an exposed binding (`exposeFunction`) or evaluate promise, avoiding busy-polling when the page is idle.
2. **Delta-Only Snapshot Evaluation**:
   - Keep a snapshot cache inside the page context and return only modified/new segment entries rather than re-evaluating and re-transmitting all historical segments every 250ms.

---

## 4. Stall Detection, Adaptive Heartbeat & CoT Reasoning

### 4.1 Detailed Breakdown of Existing Stall Mechanisms
The codebase has 4 distinct layers of timeout and stall detection:

| Layer | File / Component | Threshold | Current Behavior | Problem in CoT / Long Turns |
|---|---|---|---|---|
| **1. Diagnostic Checkpoint** | `browser-worker.ts:2226` | 30s (`sentAt + 30_000`) | Unconditionally captures screenshot and logs `response-stalled-30s` warning | **False alarm**: Triggers on every turn taking >30s, even when the model is actively thinking or typing smoothly. Causes heavy screenshot I/O. |
| **2. DOM Health Grace** | `ChatGptTurnDomHealthTracker` (`browser-worker.ts:443`) | 60s / 10s / 60s | Fails if: (a) response DOM missing for 60s; (b) empty completion for 10s; (c) completion action missing 60s after stop | Appropriate safety bounds, but needs reset on active reasoning mutations. |
| **3. Bridge Upstream Stall** | `src/bridge.ts` & `src/stall-timeout.ts` | 300s (`DEFAULT_STALL_TIMEOUT_SEC`) | Ticks every 2s (`heartbeatMs`). If no `activity` for 300s, emits `upstream_stall_timeout`. | Safe 5-minute fallback. |
| **4. Adapter Keep-Alive Heartbeat** | `src/adapters/chatgpt-web/index.ts:369` | 10s (`setInterval`) | Unconditionally emits `{ type: "heartbeat" }` to bridge every 10s. | **Masks browser hangs**: Because `index.ts` ticks independently of the browser worker, a frozen browser helper or hung Playwright CDP connection won't trigger the bridge stall timeout. |

### 4.2 The CoT (Chain-of-Thought) Problem
- In OpenAI o1/o3/gpt-5 reasoning models on ChatGPT Web, the model may execute internal reasoning for 30s to 180s before producing the first Markdown answer token.
- During this period:
  - `running` (stop button) is visible.
  - `[data-streaming-response-status]` or `[data-testid*="thought"]` or `[aria-busy="true"]` is active.
  - Animated thinking steps or reasoning summaries are mutating in the DOM.
- **Defects in Current Code**:
  - `response-stalled-30s` fires at 30 seconds unconditionally.
  - The warning log `[chatgpt-web] waiting for completed-turn evidence` is emitted even though the turn is progressing normally.
  - If a true hang occurs (e.g. WebSocket disconnect, Cloudflare challenge, silent error dialog), recovery is delayed or masked by the static 10s heartbeat.

### 4.3 Proposed Adaptive Heartbeat & Stall Mitigation Architecture
1. **Activity-Driven Heartbeat (Replacing Static Interval)**:
   - The browser worker must report **verified page activity** (`lastActivityAt = Date.now()`):
     - Text length increase
     - Trace / status block addition or text change
     - Active mutation events from `MutationObserver`
     - Visible thinking spinner / `aria-busy="true"` state updates
   - Adapter heartbeats to the bridge should be sourced from *actual worker activity* rather than an independent `setInterval`.
2. **Dynamic Inactivity Stall Timer (Replacing Static 30s)**:
   - Replace `sentAt >= 30_000` with `Date.now() - lastActivityAt >= 30_000`.
   - If the model is actively thinking (DOM mutating, reasoning steps changing, spinner running), NO stall diagnostic is triggered.
   - If the DOM is completely frozen for $>30\text{s}$ (no text growth, no trace update, no spinner animation):
     1. Capture `response-stalled-30s` diagnostic.
     2. Check for hidden error overlays or Cloudflare challenges.
     3. If inactivity persists beyond an adaptive threshold (e.g. 60s total silence during generation), trigger prompt recovery / retryable error.
3. **Structured Prompt Recovery for True Hangs**:
   - On verified hang (e.g. browser disconnect or silent network failure), throw a structured `ChatGptWebAdapterError` with `retryable: true` and `code: "upstream_stall_timeout"`.
   - This activates `chatGptWebTurnRetryPolicy` to cleanly re-acquire a fresh browser tab and re-submit the turn without corrupting conversational history.

---

## 5. Test Coverage & Gap Analysis

### 5.1 Existing Test Suite Status
- Project test suite: **354 tests across 38 files** passing cleanly (0 failures).
- TypeScript compilation: **0 errors** (`tsc --noEmit`).

### 5.2 Existing Streaming & Stall Tests
- `tests/browser-worker-contract.test.ts`:
  - Trace tracking (`ChatGptVisibleTraceTracker`): lines 1279–1460 (10 tests).
  - DOM health (`ChatGptTurnDomHealthTracker`): lines 1469–1500 (2 tests).
  - Stalled turn diagnostic parsing: lines 1501–1510 (1 test).
  - Reasoning presence keeping turn healthy: lines 1534–1545 (1 test).
- `tests/rolling-checkpoint.test.ts`:
  - `ChatGptMarkdownBuffer` integration with rolling checkpoints: lines 75–104 (1 test).
- `tests/bridge-platform.test.ts`:
  - SSE streaming, keep-alive heartbeat frames, and stall timeout logic.

### 5.3 Identified Gaps & Required Test Scenarios for R3
1. **Fine-Grained `ChatGptMarkdownBuffer` Tests**:
   - **Single-Paragraph Streaming**: Verify that a single paragraph emitting incremental text streams tokens/words before turn completion.
   - **Multi-Block Transition & Ordering**: Verify that paragraphs, headings, blockquotes, and lists transition smoothly with exact Markdown spacing (`\n\n`).
   - **GFM Formatting Invariance**: Verify tables, nested ordered/unordered lists (`1.`, `-`), and fenced code blocks (```` ``` ````) maintain structural integrity without syntax fragmentation during streaming.
   - **KaTeX / Math Formulas**: Verify `\(` inline and `\[` display math blocks do not emit broken partial LaTeX syntax during hydration.
   - **Rapid Mutation Stability**: Stress test rapid segment updates (e.g. 50 updates in 100ms) to ensure append-only monotonic delta emission without text duplication or retraction.
2. **Adaptive CoT Heartbeat & Inactivity Tests**:
   - **Extended Active Reasoning**: Simulate a 90-second turn with active reasoning trace updates every 5s; verify NO `response-stalled-30s` warning is logged.
   - **True Silence Hang**: Simulate 30 seconds of zero DOM activity; verify stall diagnostic is captured and recovery initiated.
   - **Bridge Stall Integration**: Verify that verified browser silence trips `upstream_stall_timeout` when inactivity exceeds the configured budget.
