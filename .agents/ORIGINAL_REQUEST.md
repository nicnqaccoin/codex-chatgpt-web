# Original User Request

## Initial Request — 2026-08-21T16:53:31Z

You are the Project Orchestrator for the codex-chatgpt-web optimization project.

# Workspace & Directories
- Workspace Root: C:\Users\nguye\Documents\dev\codex-chatgpt-web
- Your Working Directory: C:\Users\nguye\Documents\dev\codex-chatgpt-web\.agents\orchestrator_1
- Original Request: C:\Users\nguye\Documents\dev\codex-chatgpt-web\.agents\ORIGINAL_REQUEST.md

# Project Goal
Optimize the `codex-chatgpt-web` bridge proxy across four core dimensions:
1. R1: Browser turn overhead latency reduction (profile stages, accelerate prompt injection into ChatGPT composer via high-throughput clipboard/DOM dispatch while maintaining React compatibility, eliminate redundant DOM scans / effort-level / connector state checks).
2. R2: Context slimming & token economy optimization (structured semantic pruning for stale tool results like duplicate directory listings or repeated file reads/outdated command outputs, compaction heuristics under 110,000 char ceiling, protect critical contracts and irreducible baseline ~19k-23k tokens).
3. R3: Real-time streaming responsiveness & stall mitigation (enhance `ChatGptMarkdownBuffer` / mutation observer pipeline for lower buffering delay and smoother terminal rendering, adaptive heartbeat detection for long reasoning CoT to prevent false timeouts / `response-stalled-30s`).
4. R4: Concurrency & tab pooling (clean worker tab allocation for concurrent session execution without cookie/session desync, background tab cleanup & pre-warming).

# Canonical Operating Context & Playbook
- Build / Test / Validate commands (bun is not system-wide, use npx):
  - Typecheck: `./node_modules/.bin/tsc --noEmit`
  - Tests: `npx -y bun@1.3.14 test tests/*.test.ts`
  - Runtime Bundle: `npx -y bun@1.3.14 run scripts/build-runtime-bundle.ts` -> validates `dist/runtime/app/{cli.js,browser-helper.cjs}` with `node --check`
- Constraints:
  - Plus composer limit: 110,000 chars guard.
  - Irreducible floor: ~19,000-23,000 tokens (app-context, codex_app schemas, base instructions).
  - Visualization artifacts: Private-use sentinels `U+E200 ... U+E201` via `visualizationReference()` must remain functional.
  - Tests writing diagnostics: respect `NODE_ENV=test`/`BUN_TEST`.
  - User preference: ChatGPT Web - High default; never disable codex-app-tools.

# Acceptance Criteria
- All existing unit and integration tests (351 tests) pass cleanly.
- TypeScript compilation has 0 errors.
- Runtime bundle builds valid `cli.js` and `browser-helper.cjs`.
- R1, R2, R3, R4 implementations completed, verified, and benchmarked/tested.

# Protocol
1. Initialize your working directory `.agents/orchestrator_1` with `plan.md` and `progress.md`.
2. Keep `progress.md` updated as milestones are reached so Sentinel monitoring can track live progress.
3. Coordinate research, implementation, and verification across specialized subagents or milestones.
4. When complete, write a thorough `handoff.md` and report completion back to Sentinel.
