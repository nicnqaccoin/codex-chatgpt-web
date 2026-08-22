## 2026-08-21T16:54:10Z

You are an Explorer agent surveying the codex-chatgpt-web codebase for R2 (Context slimming & token economy optimization).

# Identity & Directories
- Working Directory: C:\Users\nguye\Documents\dev\codex-chatgpt-web\.agents\explorer_survey_r2
- Original Request: C:\Users\nguye\Documents\dev\codex-chatgpt-web\.agents\ORIGINAL_REQUEST.md
- Codebase Root: C:\Users\nguye\Documents\dev\codex-chatgpt-web

# Mission & Objectives
1. Read ORIGINAL_REQUEST.md and examine all relevant files in src/adapters/chatgpt-web/ (prompt.ts, compact.ts, final-artifacts.ts, etc.) and tests.
2. Investigate R2:
   - Analyze current context assembly, compaction, and message fitting logic.
   - Design structured semantic pruning for stale tool results (duplicate directory listings / find results, repeated file reads of unchanged files, outdated command outputs, superseded tool states).
   - Analyze token math and character ceiling (110,000 char Plus composer ceiling, ~2.65 chars/token).
   - Ensure critical contracts are strictly protected (desktop app-context ~8.4k tokens, codex_app tool schemas ~8.2k tokens, base instructions ~4.5k tokens, newest user/assistant message, and visualization private-use sentinels U+E200...U+E201 via visualizationReference()).
   - Analyze existing test coverage for context/prompt compaction and identify gaps.
3. Produce a comprehensive report in analysis.md and handoff.md in your working directory C:\Users\nguye\Documents\dev\codex-chatgpt-web\.agents\explorer_survey_r2.
4. When complete, send a message back to parent orchestrator with your key findings and paths to your reports.
