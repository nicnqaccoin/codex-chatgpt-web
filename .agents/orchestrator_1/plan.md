# Optimization Plan: codex-chatgpt-web Bridge Proxy

## Objectives
Deliver high-performance, robust optimizations for `codex-chatgpt-web` across:
1. **R1: Browser Turn Overhead Latency Reduction**
   - Profile turn lifecycle stages (page, temporary-chat, composer-ready, effort, connector, prompt attachment, send, response-visible).
   - High-throughput prompt injection into ChatGPT composer via optimized clipboard/DOM event dispatch while maintaining React 18/19 input state sync.
   - Eliminate redundant DOM scans, duplicate effort-level checks, and repetitive connector state validations.
2. **R2: Context Slimming & Token Economy Optimization**
   - Structured semantic pruning for stale tool results (duplicate directory listings, repeated file reads, outdated command outputs, superseded tool states).
   - Smart compaction heuristics maintaining composer payload under 110,000 char ceiling.
   - Strict preservation of critical contracts (app-context, codex_app schemas, base instructions, visualization sentinels U+E200..U+E201, newest message).
3. **R3: Real-time Streaming Responsiveness & Stall Mitigation**
   - Optimize `ChatGptMarkdownBuffer` / mutation observer pipeline to minimize delta buffering latency and smooth terminal token streaming.
   - Adaptive heartbeat / activity detection during extended reasoning / CoT phases to prevent false `response-stalled-30s` timeouts while catching real freezes.
4. **R4: Concurrency & Tab Pooling**
   - Worker tab allocation pool allowing parallel/concurrent session execution without cookie, session storage, or context desync.
   - Background tab recycling, warm-up, and graceful cleanup lifecycle.

## Milestone Phases
- **M0: Survey & Technical Baseline Mapping (Current)**
  - Spawn 3 Explorers across R1/R4, R2, and R3.
  - Compile `PROJECT.md` Feature Inventory and Interface Contracts.
- **M1: R1 Browser Turn Overhead Latency Reduction**
  - Implement and benchmark composer injection & DOM scan eliminations.
  - Gate verification (Reviewers, Challengers, Auditor).
- **M2: R2 Context Slimming & Token Economy Optimization**
  - Implement structured semantic pruning & compaction heuristics.
  - Gate verification.
- **M3: R3 Real-Time Streaming Responsiveness & CoT Stall Mitigation**
  - Implement streaming pipeline enhancements & adaptive heartbeat.
  - Gate verification.
- **M4: R4 Concurrency & Tab Pooling**
  - Implement tab pool manager and session isolation.
  - Gate verification.
- **M5: Integration, Full Regression & Runtime Bundling**
  - Full suite testing (`tsc`, `bun test tests/*.test.ts`, `build-runtime-bundle.ts`, `node --check`).
  - Final audit and handoff.
