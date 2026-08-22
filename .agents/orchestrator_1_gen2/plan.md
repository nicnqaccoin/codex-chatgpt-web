# Execution Plan: codex-chatgpt-web Orchestrator Gen2

## Overview
This plan governs the execution of Milestones M2, M3, M4, and M5 for the `codex-chatgpt-web` optimization project under the DISPATCH-ONLY Project Pattern.

---

## Milestone Execution Pipeline (Per Milestone)
1. **Dispatch Worker**: Specialized implementer agent modifies code and adds dedicated tests.
2. **Dispatch Reviewers (2)**: Independent reviewers examine correctness, adherence to constraints, and potential edge cases.
3. **Dispatch Challengers (2)**: Adversarial testers identify regressions, stress scenarios, and corner cases.
4. **Dispatch Forensic Auditor (1)**: Integrity audit verifying zero cheats, real logic, proper test assertions, and build compliance.
5. **Orchestrator Gate Check**: Tally findings, verify `tsc` + tests, and advance milestone.

---

## Milestone Status & Roadmap

### Milestone M0: Architecture Survey & Technical Baseline Mapping
- **Status**: **DONE** (Inherited from Gen1)

### Milestone M1: R2 Context Slimming & Token Economy
- **Status**: **DONE** (Inherited from Gen1, all 415 tests pass, 0 tsc errors, Gate PASS)

### Milestone M2: R3 Streaming Responsiveness & CoT Stall Mitigation
- **Goal**:
  1. Monotonic leaf-block streaming for active `<p>` paragraphs in `ChatGptMarkdownBuffer`.
  2. Reduce default stability window for standard text (150ms–250ms).
  3. Convert static 30s stall timer in `browser-worker.ts` into a true inactivity timer (`lastActivityAt`).
  4. Tie adapter heartbeats in `index.ts` to verified browser DOM activity.
- **Affected Files**: `src/adapters/chatgpt-web/markdown.ts`, `src/adapters/chatgpt-web/browser-worker.ts`, `src/adapters/chatgpt-web/index.ts`, `tests/markdown-buffer.test.ts`, `tests/stream-stall.test.ts`.
- **Status**: **IN_PROGRESS**

### Milestone M3: R1 Browser Turn Overhead Latency Reduction
- **Goal**:
  1. Fast synthetic paste injection for prompts in `browser-worker.ts` (with chunked fallback).
  2. Eliminate fixed `settleChatGptUi` sleeps in favor of reactive DOM event/readiness predicates.
  3. Consolidate redundant DOM scans in `prepareTemporaryChatSurface` and gate diagnostics evaluations.
- **Affected Files**: `src/adapters/chatgpt-web/browser-worker.ts`, `tests/prompt-insertion-fit.test.ts`, `tests/browser-worker-contract.test.ts`.
- **Status**: **PLANNED**

### Milestone M4: R4 Concurrency & Worker Tab Pooling
- **Goal**:
  1. Implement pre-warmed worker tab pool (1–2 idle tabs) in `launcher/electron/browser-host.cjs`.
  2. Shared session partition management, idle reaping, background throttling.
  3. Tab concurrency guard (`MAX_CHATGPT_BROWSER_TABS = 5`).
- **Affected Files**: `launcher/electron/browser-host.cjs`, `tests/launcher-browser-host.test.ts`.
- **Status**: **PLANNED**

### Milestone M5: Full Regression, Bundling & E2E Verification
- **Goal**:
  1. Full test suite execution across all test files in `tests/`.
  2. Complete TypeScript typecheck with 0 errors.
  3. Runtime bundler build (`scripts/build-runtime-bundle.ts`) and validation (`node --check dist/runtime/app/{cli.js, browser-helper.cjs}`).
  4. Final Gate Verification and Handover.
- **Status**: **PLANNED**
