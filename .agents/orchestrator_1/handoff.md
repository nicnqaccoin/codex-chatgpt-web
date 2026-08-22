# Orchestrator Soft Handoff: codex-chatgpt-web Optimization Project

- **Agent**: Project Orchestrator Generation 1 (`orchestrator_1`)
- **Recipient**: Project Orchestrator Generation 2 (`orchestrator_1_gen2`)
- **Original Parent**: `1c16b488-2e52-475c-9f50-7aca6b52af56`
- **Timestamp**: 2026-08-22T00:26:15+07:00

---

## 1. Milestone State
| Milestone | Status | Details |
|-----------|--------|---------|
| **M0: Survey & Technical Baseline Mapping** | **DONE** | Complete architectural surveys across R1, R2, R3, R4 compiled into `PROJECT.md`. |
| **M1: R2 Context Slimming & Token Economy** | **DONE** | Fully implemented in `src/adapters/chatgpt-web/prune.ts`, integrated into `prompt.ts`, passed 2 iterations of Reviewers, Challengers, and Forensic Auditor. All 415 tests pass, 0 tsc errors. Gate result: **PASS**. |
| **M2: R3 Streaming Responsiveness & CoT Stall Mitigation** | **IN_PROGRESS** | Survey completed (`.agents/explorer_survey_r3/handoff.md`). Ready for Worker implementation in `src/adapters/chatgpt-web/markdown.ts`, `browser-worker.ts`, `index.ts`. |
| **M3: R1 Browser Turn Overhead Latency Reduction** | **PLANNED** | Survey completed (`.agents/explorer_survey_r1_r4/handoff.md`). Ready for implementation in `browser-worker.ts` (synthetic paste injection, reactive waits). |
| **M4: R4 Concurrency & Worker Tab Pooling** | **PLANNED** | Survey completed (`.agents/explorer_survey_r1_r4/handoff.md`). Ready for implementation in `launcher/electron/browser-host.cjs`. |
| **M5: Full Regression, Bundling & E2E Verification** | **PLANNED** | Final validation across all test suites, typecheck, `build-runtime-bundle.ts`, `node --check`. |

---

## 2. Active Subagents
- All 16 subagents spawned in Generation 1 have completed their tasks and delivered their handoffs.
- Active pending subagents: None.

---

## 3. Pending Decisions & Critical Context
1. **M1 Implemented Features**:
   - `pruneSemanticToolResults`: Deduplicates file reads (re-read or patch-modified), supersedes duplicate directory listings with item counts, compacts older non-re-executed command outputs, and replaces re-executed command outputs with exit code receipts.
   - Chronological protection: `mod.messageIndex > i` ensures post-patch verification reads are NEVER superseded by earlier modifications.
   - Slash normalization: `replace(/\/+/g, "/")` collapses consecutive slashes across OS platforms.
   - Invariants: Desktop `<app-context>` (~8.4k tokens), `# AGENTS.md`, and base instructions are strictly protected. Active turns after `latestUserIndex` and the verbatim tail (6 messages) remain 100% untouched. Visualization private-use sentinels `\uE200...\uE201` are never damaged.
2. **M2 Immediate Next Steps (R3 Streaming & CoT Mitigation)**:
   - File blueprints: `src/adapters/chatgpt-web/markdown.ts`, `browser-worker.ts`, `index.ts`.
   - Core changes needed:
     1. Monotonic leaf-block streaming for active `<p>` paragraphs in `ChatGptMarkdownBuffer` so tokens stream in real time rather than waiting for block completion.
     2. Reduce default stability window for text from 750ms to 150ms–250ms.
     3. Replace static 30s timer (`Date.now() - sentAt >= 30_000`) in `browser-worker.ts` with a true inactivity timer (`Date.now() - lastActivityAt >= 30_000`) that resets on visible text growth, trace block updates, or thinking spinner activity.
     4. Tie adapter heartbeats in `index.ts` to verified browser DOM activity.
   - Worker instructions are ready in `C:\Users\nguye\Documents\dev\codex-chatgpt-web\.agents\explorer_survey_r3\handoff.md`.

---

## 4. Remaining Work (Concrete Next Steps for Successor)
1. **Kick off Milestone M2 (R3 Streaming & CoT)**:
   - Spawn Worker with write ownership over `src/adapters/chatgpt-web/markdown.ts`, `src/adapters/chatgpt-web/browser-worker.ts`, `src/adapters/chatgpt-web/index.ts`, and test files (e.g. `tests/markdown-buffer.test.ts`, `tests/stream-stall.test.ts`).
   - Run gating cycle: Reviewers (2) + Challengers (2) + Forensic Auditor (1).
2. **Execute Milestone M3 (R1 Turn Overhead)**:
   - Worker implements fast synthetic paste injection, reactive waits (`settleChatGptUi` elimination), and DOM scan consolidation.
   - Gate verification.
3. **Execute Milestone M4 (R4 Tab Pooling & Concurrency)**:
   - Worker implements 1–2 tab pre-warmed worker pool in `launcher/electron/browser-host.cjs`.
   - Gate verification.
4. **Execute Milestone M5 (Full Regression & Bundle Build)**:
   - Verify 0 tsc errors, full test suite pass, runtime bundle generation (`dist/runtime/app/{cli.js, browser-helper.cjs}` passing `node --check`).
5. **Final User Handoff**: Deliver completion report to the user / Sentinel.

---

## 5. Key Artifacts
- `C:\Users\nguye\Documents\dev\codex-chatgpt-web\.agents\ORIGINAL_REQUEST.md` — Original User Request
- `C:\Users\nguye\Documents\dev\codex-chatgpt-web\PROJECT.md` — Authoritative Architecture, Milestones & Contracts
- `C:\Users\nguye\Documents\dev\codex-chatgpt-web\.agents\orchestrator_1\progress.md` — Progress & State Checkpoint
- `C:\Users\nguye\Documents\dev\codex-chatgpt-web\.agents\orchestrator_1\GATE_STATUS.md` — Milestone Gate History
- `C:\Users\nguye\Documents\dev\codex-chatgpt-web\.agents\explorer_survey_r1_r4\handoff.md` — R1/R4 Survey Blueprint
- `C:\Users\nguye\Documents\dev\codex-chatgpt-web\.agents\explorer_survey_r2\handoff.md` — R2 Survey Blueprint
- `C:\Users\nguye\Documents\dev\codex-chatgpt-web\.agents\explorer_survey_r3\handoff.md` — R3 Survey Blueprint
- `C:\Users\nguye\Documents\dev\codex-chatgpt-web\.agents\worker_m1_remediate\handoff.md` — M1 Implementation Details

---

## 6. Verification Method
- **Typecheck**: `./node_modules/.bin/tsc --noEmit` (must exit 0)
- **Tests**: `node -e "const fs = require('fs'); const cp = require('child_process'); const files = fs.readdirSync('tests').filter(f => f.endsWith('.test.ts')).map(f => 'tests/' + f); console.log(cp.execSync('npx -y bun@1.3.14 test ' + files.join(' '), { encoding: 'utf8' }))"` (415 pass, 0 fail)
- **Runtime Bundler**: `npx -y bun@1.3.14 run scripts/build-runtime-bundle.ts`
