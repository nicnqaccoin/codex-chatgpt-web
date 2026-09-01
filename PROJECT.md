# Project: codex-chatgpt-web Performance & Reliability Optimization

> **SUPERSEDED — historical roadmap, not current guidance.** Several items here have since been
> tried and measured as regressions or overtaken by upstream. Do not implement from this file.
> `AGENTS.md` is the source of truth for what has been attempted and rejected. In particular:
> - Item 4's "110,000 char ceiling" is obsolete — the medium/high composer limit is now 1,048,572.
> - Item 6 (reduce the 750ms stability window to 150-250ms) and items 12/M4 (pre-warmed tab pool)
>   are recorded as regressions in `AGENTS.md`; do not reintroduce them.
> - Item 10's paste injection was later solved differently upstream (`document.execCommand`).
> - Item 9's settle sleeps were measured: only three run on a normal turn, ~750ms total.

## Architecture
`codex-chatgpt-web` bridges Codex desktop application sessions to the ChatGPT Web UI via a local HTTP proxy server and Electron browser host.

```
[ Codex Desktop App ]
         │ (HTTP /v1/chat/completions /v1/models)
         ▼
[ Bridge Proxy Server (src/server.ts, src/bridge.ts) ]
         │
         ├─── Context Slimming & Prompt Compilation (src/adapters/chatgpt-web/prompt.ts, prune.ts)
         │
         ├─── Streaming & Markdown Delta Buffer (src/adapters/chatgpt-web/markdown.ts, index.ts)
         │
         └─── Browser Helper Client / Worker (src/adapters/chatgpt-web/browser-worker.ts)
                     │ (IPC / WebSocket)
                     ▼
         [ Electron Browser Host (launcher/electron/browser-host.cjs) ]
                     │ (Chromium WebContentsView Pool)
                     ▼
         [ ChatGPT Web UI Temporary Chat Surface (chatgpt.com) ]
```

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | R2: Semantic File Read Pruning | Deduplicate repeated reads of the same file in conversation history | M1 (R2) | survey |
| 2 | R2: Semantic Dir Listing Supersession | Replace earlier `list_dir` / `find_by_name` results with concise supersession stubs | M1 (R2) | survey |
| 3 | R2: Semantic Command Output Compaction | Compact older shell/exec command outputs while preserving exit codes & recent outputs | M1 (R2) | survey |
| 4 | R2: 110,000 Char Ceiling & Contract Protection | Protect baseline floor (~21k-23k tokens), instructions, newest message, and `\uE200..\uE201` sentinels | M1 (R2) | survey |
| 5 | R3: Monotonic Leaf Block Streaming | Enable incremental text deltas for active `<p>` blocks in `ChatGptMarkdownBuffer` | M2 (R3) | survey |
| 6 | R3: Reduced Buffer Stability Window | Reduce text block stability window from 750ms to 150-250ms for low-latency streaming | M2 (R3) | survey |
| 7 | R3: Inactivity-Based Stall Detection | Replace static 30s timer with `Date.now() - lastActivityAt >= 30s` resetting on text/DOM growth | M2 (R3) | survey |
| 8 | R3: Verified Browser Heartbeat | Tie adapter heartbeats to verified browser DOM activity to prevent masking hung workers | M2 (R3) | survey |
| 9 | R1: Reactive Wait Settlement | Replace 750ms-1,000ms unconditional `settleChatGptUi` sleeps with reactive state predicates | M3 (R1) | survey |
| 10 | R1: High-Throughput Prompt Injection | Implement synthetic `ClipboardEvent('paste')` directly into Lexical's React PASTE_COMMAND (<50ms) | M3 (R1) | survey |
| 11 | R1: DOM Scan Consolidation | Cache/combine composer & session checks and gate heavy diagnostics to error paths | M3 (R1) | survey |
| 12 | R4: Pre-warmed Worker Tab Pool | Maintain 1-2 pre-warmed tabs at `chatgpt.com/?temporary-chat=true` on shared partition | M4 (R4) | survey |
| 13 | R4: Tab Lifecycle & Idle Reaping | Implement tab lease, background post-turn recycling, idle reaping, and max-turn recreation | M4 (R4) | survey |
| 14 | M5: Regression & Runtime Bundling | Pass all 415+ test suites, zero tsc errors, valid `cli.js` and `browser-helper.cjs` | M5 (Final) | survey |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | R2 Context Slimming & Token Economy | Implement `src/adapters/chatgpt-web/prune.ts`, integrate into `prompt.ts`, add `tests/semantic-pruning.test.ts` | none | DONE |
| M2 | R3 Streaming Responsiveness & CoT Mitigation | Update `markdown.ts`, `browser-worker.ts`, `index.ts`, add streaming & CoT stall tests | none | IN_PROGRESS |
| M3 | R1 Browser Turn Overhead Reduction | Eliminate sleeps, implement fast paste injection in `browser-worker.ts`, update turn tests | M1 | PLANNED |
| M4 | R4 Worker Tab Pool & Concurrency | Implement pre-warmed tab pool in `browser-host.cjs`, tab recycling & leasing, update launcher tests | M3 | PLANNED |
| M5 | Integration & Runtime Bundle Build | Full regression test suite, typecheck, `build-runtime-bundle.ts`, `node --check` validation | M1, M2, M3, M4 | PLANNED |

## Interface Contracts
### `src/adapters/chatgpt-web/prune.ts` ↔ `prompt.ts`
```typescript
export interface SemanticPruneOptions {
  verbatimTailMessages?: number; // default: 6
  maxCommandOutputChars?: number; // default: 1500
}

export function pruneSemanticToolResults(
  messages: readonly CodexMessage[],
  options?: SemanticPruneOptions
): CodexMessage[];
```
- **Invariants**:
  - Never mutates input array or messages in place.
  - Never modifies tool results in the active turn (messages after `latestUserIndex`).
  - Never strips or modifies `\uE200...\uE201` visualization directives.
  - Preserves message roles, `toolCallId`, `toolName`, `toolNamespace`, and `isError`.

### `src/adapters/chatgpt-web/markdown.ts` ↔ `browser-worker.ts`
```typescript
export interface ChatGptMarkdownSegment {
  id: string;
  kind?: string;
  html: string;
  text?: string;
  streamable: boolean;
  activeLeaf?: boolean;
}
```
- **Invariants**:
  - Committed text is strictly append-only.
  - Active leaf streaming only emits monotonic text extensions.
  - Full finish flush guarantees complete Markdown emission.

### `launcher/electron/browser-host.cjs` ↔ `browser-helper-client.ts`
- Tab pool manages `WebContentsView` lifecycle on partition `persist:codex-web-gpt-chatgpt`.
- Worker acquires pre-warmed tab in `<300ms`, navigates to new temporary-chat surface on release, or reaps if idle > 10m.

## Code Layout
- `src/adapters/chatgpt-web/prune.ts` (Semantic tool result deduplication and compaction - DONE)
- `src/adapters/chatgpt-web/prompt.ts` (Prompt compilation, budget fitting, contract protection - DONE)
- `src/adapters/chatgpt-web/markdown.ts` (Markdown delta buffer, leaf streaming)
- `src/adapters/chatgpt-web/browser-worker.ts` (Playwright automation, injection, reactive waits, DOM observer)
- `src/adapters/chatgpt-web/index.ts` (Adapter event loop, adaptive activity heartbeats)
- `launcher/electron/browser-host.cjs` (Electron browser host, tab pool manager)
- `tests/*.test.ts` (Unit and integration tests)
- `scripts/build-runtime-bundle.ts` (Runtime bundler)
