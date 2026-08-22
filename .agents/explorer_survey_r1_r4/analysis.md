# Architectural Analysis: R1 (Browser Turn Overhead Latency Reduction) & R4 (Concurrency & Tab Pooling)

- **Author**: Explorer Agent (`explorer_survey_r1_r4`)
- **Date**: 2026-08-21
- **Target Systems**: `src/adapters/chatgpt-web/`, `src/launcher-browser-host.ts`, `src/chatgpt-session.ts`, `launcher/electron/`

---

## 1. Executive Summary

This investigation explores the `codex-chatgpt-web` codebase to eliminate latency overhead during browser turns (**R1**) and establish a robust, concurrent worker tab pooling system (**R4**).

### Key Findings Matrix
| Dimension | Current Baseline | Optimized Target | Key Mechanism |
|---|---|---|---|
| **Turn Initialization Latency** | 3.5s – 7.0s per turn | < 0.3s – 0.8s per turn | Pre-warmed Worker Tab Pool (R4) & cached state checks |
| **Prompt Injection Speed (100k)** | ~1.5s – 2.5s (7 chunk rounds) | < 100ms (Single-shot synthetic paste / optimized CDP) | Synthetic `DataTransfer` / Lexical `PASTE_COMMAND` dispatch |
| **Fixed Sleep Overhead** | 750ms – 1,000ms per turn | 0ms (Event-driven / reactive settlement) | Eliminate arbitrary `settleChatGptUi()` sleep cascades |
| **Tab Concurrency & Lifecycle** | Cold create-and-destroy per turn | 1–2 Warm Tab Pool, recycled up to 10 turns | Background pre-warming & shared Electron session partition |

---

## 2. R1 Deep Dive: Browser Turn Overhead Latency Reduction

### 2.1 Profile of Browser Turn Lifecycle Stages

In `src/adapters/chatgpt-web/browser-worker.ts` (`runBrowserTurn`, lines 1975–2278) and `launcher/electron/browser-host.cjs` (`beginTurn`, lines 1022–1065), a single turn executes the following sequential stages:

```
[Turn Start]
   │
   ├─► 1. browser_page (Timeout: 60s)
   │     - notifyLauncherTurn('start') -> allocates WebContentsView at about:blank
   │     - connectLauncherBrowserHost() -> chromium.connectOverCDP() + selectLauncherPage()
   │     - Latency: ~300ms – 800ms
   │
   ├─► 2. temporary_chat_preparation (Timeout: 150s)
   │     - page.goto('https://chatgpt.com/?temporary-chat=true')
   │     - Full SPA script download, parsing, and React 18/19 hydration
   │     - activeComposer() poll + assertAuthenticatedChatGptPage() + assertTemporaryChatPage()
   │     - Latency: ~2,500ms – 4,500ms
   │
   ├─► 3. effort_selection (Timeout: 120s)
   │     - waitFor(CHATGPT_EFFORT_CONTROL_SELECTOR)
   │     - settleChatGptUi() (250ms sleep) + throwIfChatGptRateLimitDialog()
   │     - Read effortControlLabel() -> if match, capture and return
   │     - If mismatch: open menu -> navigate slider/item -> wait aria-checked -> Escape
   │     - Latency: ~350ms (if match) to ~1,500ms (if reselect)
   │
   ├─► 4. prompt_attachment (Timeout: 60s)
   │     - If localTools: selectConnector()
   │         - fill("") -> check connectorIsSelected() -> type "@c" -> wait row -> settleChatGptUi() x2 (500ms sleep!) -> mouse click -> wait selected
   │     - Focus composer -> re-anchor caret
   │     - insertPromptText() in 16k chunks with chunk confirmation & caret re-anchoring
   │     - assertPromptAttached() (DOM clone, clean, text compare)
   │     - Latency: ~1,500ms – 3,500ms
   │
   ├─► 5. file_attachment (Timeout: 120s)
   │     - Input file upload for base64 images (if present)
   │     - Latency: ~50ms (no images) to ~500ms (with images)
   │
   ├─► 6. send (Timeout: 20s)
   │     - Locate sendButton -> wait enabled -> settleChatGptUi() (250ms sleep) -> press("Enter")
   │     - waitForSubmissionAccepted() (poll every 50ms for user turn / assistant turn / stop button)
   │     - Latency: ~350ms – 600ms
   │
   └─► 7. Generation & Stream Observation
         - Poll every 250ms: responseDomSnapshot() -> markdownBuffer deltas -> trace events
         - Completion settling: ChatGptCompletionTracker requires 2,000ms stability after copy button appears
         - Latency: Generation time + 2,000ms settle wait
```

**Total Turn Initialization Latency (Before Generation): ~5.0s – 10.0s!**

---

### 2.2 Prompt Injection: Mechanism Analysis & High-Throughput Design

#### Why Naive Approaches Failed in the Past:
1. **Playwright `locator.fill(text)`**:
   - `fill()` sets the DOM `.value` and fires an `input` event.
   - ChatGPT’s composer is a Lexical contenteditable editor (`div[contenteditable="true"][data-lexical-editor="true"]`).
   - Standard `fill()` causes Lexical to collapse multiline text into a single paragraph or drop content on Electron.
2. **Unbounded Native CDP `Input.insertText` (100k+ chars)**:
   - Sending 100k+ characters in a single `Input.insertText` CDP command triggers Lexical's internal AST mutation limits.
   - Lexical splits text nodes and drifts the native DOM caret to the start or middle of the document during parsing, resulting in corrupted prefixes or character truncation (documented at `browser-worker.ts:258-262`).
3. **Current Chunked CDP `Input.insertText` (16,000 chars per chunk)**:
   - Splits text into 16k chunks (`CHATGPT_PROMPT_INSERT_CHUNK_CHARS`).
   - After each chunk: calls `waitForPromptChunkAttached` (polls DOM text) and `reanchorPromptCaret` (traverses child nodes, computes Range, calls `requestAnimationFrame`, checks selection).
   - For a 100k char prompt, this does 7 chunk cycles × ~250ms = **~1.75s latency**.

#### High-Throughput High-Fidelity Injection Strategies:

##### Option A: Synthetic `DataTransfer` / `ClipboardEvent("paste")` via DOM Dispatch (Fastest & 100% Lexical Compatible)
Lexical natively listens to the `paste` event on the editor root node and routes it through its `PASTE_COMMAND` handler. Lexical’s paste handler parses plain text and inserts paragraphs atomically within a single React 18/19 transition without native caret drift.

```javascript
// High-throughput synthetic paste injection in Page context
await composer.evaluate((element, text) => {
  element.focus();
  const dt = new DataTransfer();
  dt.setData("text/plain", text);
  const pasteEvent = new ClipboardEvent("paste", {
    bubbles: true,
    cancelable: true,
    clipboardData: dt,
  });
  element.dispatchEvent(pasteEvent);
}, promptText);
```

##### Option B: Optimized Multi-Chunk Injection with Direct Length Checks
If CDP `Input.insertText` is retained for defense-in-depth:
1. Increase chunk size to **32,000** or **48,000** characters (halves chunk roundtrips).
2. Optimize `attachedPromptText` and `waitForPromptChunkAttached`:
   - Replace expensive `cloneNode(true)` + child removal with a single direct `element.innerText.length` or lightweight property check.
3. Fast-path re-anchoring without redundant `requestAnimationFrame` when the selection is already at the end.

---

### 2.3 Redundant DOM Scans, Sleep Cascades & Check Streamlining

1. **Elimination of Arbitrary `settleChatGptUi()` Sleeps**:
   - `browser-worker.ts:93` defines `CHATGPT_UI_SETTLE_MS = 250`.
   - It is called in:
     - `selectModelAndEffort` (line 1006, line 1023) -> 250ms
     - `selectConnector` (lines 1355, 1400, 1401) -> 750ms!
     - `send` (line 2112) -> 250ms
   - **Solution**: Replace unconditional `setTimeout(250)` with explicit condition waits (`waitFor({ state: 'visible' })`, `waitForFunction(...)`). This immediately recovers **750ms – 1,250ms per turn**.

2. **Streamlining Temporary Chat & Session Assertions**:
   - `prepareTemporaryChatSurface` executes:
     1. `activeComposer(page)` (lines 1206)
     2. `assertAuthenticatedChatGptPage(page)` (line 1212) -> executes `page.locator(CHATGPT_COMPOSER_SELECTOR)` again!
     3. `assertTemporaryChatPage(page)` (line 1213) -> parses URL again.
   - **Solution**: `activeComposer()` already proves both authentication and composer presence. Combine these into a single evaluation pass.

3. **Fast-Path Connector & Effort Verification**:
   - In a reused/pooled tab, the connector and effort mode are already selected from the prior turn or pre-warming.
   - Check `connectorIsSelected(composer)` and `effortControlLabel(currentEffort) === mode.displayLabel` immediately. If matched, skip menu opening, typing `@c`, coordinate calculation, and keyboard navigation.

4. **Diagnostic Capture Gating**:
   - Currently, `diagnostics.capture(page, ...)` evaluates 80+ DOM elements and writes JSON to disk across 8+ checkpoints during EVERY normal turn.
   - **Solution**: Gate diagnostic evaluations so full DOM snapshots and disk writes only execute when `process.env.CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS === "1"` or when a turn fails/stalls.

---

## 3. R4 Deep Dive: Concurrency & Tab Pooling Architecture

### 3.1 Current Tab Architecture Analysis

1. **Launcher Browser Host (`launcher/electron/browser-host.cjs`)**:
   - Maintains a single home `view` and a Map of `turnTabs`.
   - When a turn starts (`beginTurn`), it creates a brand new `WebContentsView` with `partition: "persist:codex-web-gpt-chatgpt"`.
   - When a turn ends (`endTurn`), it immediately invokes `removeTurnTab`, destroying the `WebContentsView`.
   - **Impact**: Every turn starts cold from `about:blank`, navigates to `https://chatgpt.com/?temporary-chat=true`, downloads/parses all JavaScript bundles, and hydrates the React tree.

2. **Session Storage & Cookie Synchronization**:
   - All `WebContentsView` instances share `partition: "persist:codex-web-gpt-chatgpt"`.
   - Electron shares cookies, HTTP cache, and origin storage across all views in the same partition in real-time. There is **zero cookie/session desync** between tabs.

---

### 3.2 Target Worker Tab Pool Architecture

```
                 ┌──────────────────────────────────────────────┐
                 │       Electron Launcher Browser Host         │
                 │   (partition: persist:codex-web-gpt-chatgpt) │
                 └──────────────────────┬───────────────────────┘
                                        │
             ┌──────────────────────────┴──────────────────────────┐
             ▼                                                     ▼
┌─────────────────────────┐                             ┌─────────────────────────┐
│   Active Turn Pool      │                             │      Warm Tab Pool      │
│  (Max 5 simultaneous)   │                             │   (Target: 1-2 idle)    │
├─────────────────────────┤                             ├─────────────────────────┤
│ Tab A: [Turn trace_123] │ ◄─── Lease Pre-warmed Tab ──┤ Tab C: [Pre-warmed]     │
│ Tab B: [Turn trace_456] │                             │  - URL: temporary-chat  │
│                         │ ─── Return & Recycle Tab ──►│  - Composer Ready       │
└─────────────────────────┘                             │  - Throttled in bkg     │
                                                        └─────────────────────────┘
```

#### Key Architecture Components:

1. **Pool Data Structures**:
   - `turnTabs`: `Map<string, TurnTab>` (currently leased active turns).
   - `warmPool`: `Array<WarmTab>` (pre-warmed tabs ready for immediate lease).
   - Total capacity invariant: `turnTabs.size + warmPool.length <= MAX_BROWSER_TABS` (5).

2. **Leasing Lifecycle (`beginTurn`)**:
   - If `warmPool.length > 0`:
     - Pop `warmTab` from `warmPool`.
     - Assign `traceId`, `helperPid`, `lastHeartbeatAt = Date.now()`.
     - Disable background throttling (`view.webContents.setBackgroundThrottling(false)`).
     - Move to `turnTabs`.
     - Return `{ surfaceId: tab.surfaceId, tabId: tab.id, prewarmed: true }`.
     - Trigger asynchronous background replenishment of `warmPool`.
   - If `warmPool.length === 0`:
     - Create tab on-demand (fallback to existing flow).

3. **Recycling Lifecycle (`endTurn`)**:
   - Upon turn completion:
     - Check tab health & turn count (`tab.turnCount < MAX_TURNS_PER_TAB`, e.g. 10).
     - If healthy and pool has room (`turnTabs.size + warmPool.length <= MAX_BROWSER_TABS`):
       - Reset composer state (either evaluate `window.location.replace(TEMPORARY_CHAT_URL)` or clear DOM).
       - Set `backgroundThrottling: true`.
       - Push into `warmPool`.
     - If unhealthy, failed, or turn count exceeded:
       - Close and destroy WebContentsView.
       - Spawn fresh pre-warmed tab in background.

4. **Safety & Fault Tolerance**:
   - Heartbeat Sweeper (`reapExpiredTurnTabs`): Checks active tabs every 5s; reaps tabs whose helper died.
   - Idle Pool Expiry: If warm tabs remain unused for >15 minutes, close them to free RAM.
   - Renderer Crash Recovery: `render-process-gone` listener immediately removes tab from pool.

---

## 4. Test Suite Coverage & Verification Strategy

### 4.1 Existing Test Suite Landscape
- **Total Test Files**: 37 in `tests/`, plus launcher test files in `launcher/tests/`.
- **Key Regression Harnesses**:
  - `tests/browser-worker-contract.test.ts`: Verifies prompt chunking, surrogate pair safety, whitespace normalization, stage timeouts, and concurrency limit.
  - `tests/prompt-insertion-fit.test.ts`: Verifies chunk boundary math and non-retryable truncation detection.
  - `tests/launcher-browser-host.test.ts`: Verifies descriptor security, loopback validation, surface ID matching, and session verification.
  - `tests/launcher-helper-client.test.ts`: Verifies stdio protocol, process line writers, and structured error propagation.
  - `tests/chatgpt-web-harness.test.ts`: 51 integration tests simulating full turn flows.

### 4.2 Required Verification for R1 & R4:
1. `tsc --noEmit` -> 0 TypeScript compiler errors.
2. `npx -y bun@1.3.14 test tests` -> All unit/integration tests pass.
3. Add unit test for Synthetic Paste Prompt Injection & chunking fallback.
4. Add unit test for Tab Pool allocation, leasing, recycling, and max-capacity enforcement.
