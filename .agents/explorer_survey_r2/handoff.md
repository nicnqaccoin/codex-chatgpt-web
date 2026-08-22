# Handoff Report: R2 Context Slimming & Token Economy Optimization

## 1. Observation

1. **Plus Composer Ceiling & Auto-Compaction Limits**:
   - `src/chatgpt-web-models.ts:29-33`:
     - `CHATGPT_WEB_MEDIUM_HIGH_COMPOSER_CHAR_LIMIT = 110_000` characters.
     - `CHATGPT_WEB_MEDIUM_HIGH_AUTO_COMPACT_TOKEN_LIMIT = 60_000` tokens (against a 90,000 window).
     - `CHATGPT_WEB_PLATFORM_RESERVE_TOKENS = 8_192` tokens.
     - Character-to-token ratio in real Codex sessions is measured at **2.63–2.68 chars/token** (average **~2.65 chars/token**).
     - 110,000 chars / 2.65 chars/token yields a hard transport ceiling of **~41,500 tokens** for a single browser prompt.

2. **Irreducible Baseline Token Floor**:
   - Desktop `<app-context>`: `tests/prompt-fit-recovery.test.ts:42` and real runtime payload: ~8,400 tokens (~22,000 characters). Contains `# Codex desktop context`, `### Images/Visuals/Files` rules, shell environment, and Markdown formatting guidelines.
   - Codex Native MCP tool schemas: `src/adapters/chatgpt-web/mcp-server.ts:189-371` and `src/chatgpt-web-models.ts:33`: `CHATGPT_WEB_PLATFORM_RESERVE_TOKENS = 8_192` tokens (~21,700 characters).
   - Base Developer Instructions: `src/responses/parser.ts:285` and `src/adapters/chatgpt-web/prompt.ts:221-233`: `<environment_context>`, `# AGENTS.md`, plugin/skill catalogs: ~4,500 tokens (~12,000 characters).
   - Base Transport Contracts: `src/adapters/chatgpt-web/prompt.ts:368-426`: `sharedContract`, `transportContract`, `<codex_transport_resume>`: ~1,000 tokens (~2,800 characters).
   - Total Irreducible Floor: **~21,000–23,000 tokens (~55,000–60,000 characters)**.
   - Available Headroom for Conversation & Tool Results within 110,000 char composer message: **~50,000–55,000 characters (~19,000–21,000 tokens)**.

3. **Current Truncation & Fitting Mechanism**:
   - `src/adapters/chatgpt-web/prompt.ts:80-90`:
     - `CHATGPT_VERBATIM_TOOL_RESULT_MESSAGES = 6`.
     - `TOOL_RESULT_HEAD_CHARS = 4_000`, `TOOL_RESULT_TAIL_CHARS = 2_000`.
     - Tool results only elided if `text.length > 6_400` chars and message index `< messages.length - 6`.
   - `src/adapters/chatgpt-web/prompt.ts:235-254`:
     - `isInstructionMessage(message)` protects instruction blocks matching `INSTRUCTION_BLOCK_MARKERS`.
     - `nextDroppableIndex(messages)` returns oldest non-instruction, non-newest message.
   - `src/adapters/chatgpt-web/prompt.ts:481-487`:
     - Discards whole messages one by one until `compiled.text.length <= composerCharLimit` (or JSON byte budget for compaction).

4. **Visualization Sentinel Protection Contract**:
   - `src/adapters/chatgpt-web/final-artifacts.ts:6-71`:
     - `VISUALIZE_REFERENCE = /\uE200visualize\uE202(\{[^\r\n]*\})\uE201/g`
     - Private-use sentinels `\uE200` (U+E200) and `\uE201` (U+E201) with delimiter `\uE202` (U+E202) are emitted by `visualizationReference(path)`.
     - `requiredVisualizationReference(parsed)` scans tool results after `latestUserIndex` for `.codex/visualizations/` paths or `apply_patch` lines matching `PATCHED_HTML_LINE = /^\s*[AM]\s+(.+?\.html)\s*$/i`.

5. **Test Suite Baseline & Results**:
   - Running `npx -y bun@1.3.14 test tests/*.test.ts` via Bun: 354 tests pass across 38 files with 0 failures.
   - TypeScript compilation (`npx tsc --noEmit`): 0 errors.

---

## 2. Logic Chain

1. **Premise**: On Plus accounts (default `chatgpt-web/high`), the composer rejects prompts exceeding 110,000 characters.
2. **Observation 1**: The irreducible baseline floor consumes ~55,000–60,000 characters (~21k–23k tokens), leaving only ~50,000–55,000 characters of headroom.
3. **Observation 2**: Current tool elision (`withElidedOlderToolResults`) only triggers on tool results > 6,400 characters that are older than 6 messages, and has no semantic awareness of repeated file reads, duplicate directory listings, or outdated command outputs.
4. **Observation 3**: In active development sessions, an agent may read a 400-line file multiple times (or read it before editing and re-read it after), list directory trees multiple times, and re-run test commands. Each un-pruned tool result adds 5,000–20,000 characters to context.
5. **Observation 4**: When total prompt characters exceed 110,000, `compileChatGptWebPrompt` uses `nextDroppableIndex` to drop whole conversation messages (user prompts and assistant reasoning) rather than pruning the dead tool results that caused the bloat.
6. **Inference**: Introducing structured semantic pruning (deduplicating file reads, superseding directory listings, compacting older command outputs) will reclaim 20,000–40,000 characters per multi-turn session.
7. **Conclusion**: Semantic pruning should be executed before whole-message fit recovery. Stale tool results are reduced to lightweight semantic stubs, allowing the user's conversation history and active reasoning to remain intact within the 110,000 character limit without breaking critical contracts.

---

## 3. Caveats

1. **Active Turn Protection**: Pruning MUST NOT touch tool results generated in the active user turn (messages after `latestUserIndex`), nor the last 6 messages (`CHATGPT_VERBATIM_TOOL_RESULT_MESSAGES`), because the model is actively reasoning about them.
2. **`apply_patch` Path Preservation**: `requiredVisualizationReference()` in `final-artifacts.ts` parses `parsed.context.messages` for `apply_patch` output lines (`A <path>.html`). Pruning must operate on the prompt-building message clone and never destructively modify `parsed.context.messages`.
3. **Tool Metadata Invariants**: Pruned tool result messages must preserve `role: "toolResult"`, `toolCallId`, `toolName`, `toolNamespace`, and `isError`.
4. **Pro Account Scale**: Pro accounts have much larger limits (up to 1.635M characters), but semantic pruning should still apply uniformly to maintain prompt hygiene and avoid latency from processing redundant tokens.

---

## 4. Conclusion

For R2 implementation, the recommended technical blueprint consists of:
1. **New Module `src/adapters/chatgpt-web/prune.ts`**:
   - `pruneSemanticToolResults(messages: readonly CodexMessage[]): CodexMessage[]`
   - File read deduplication: detects `view_file` / `read_file` / `cat` and supersedes earlier reads of the same file.
   - Directory listing supersession: detects `list_dir` / `find_by_name` / `dir` / `ls` and replaces older duplicate directory listings with `[Earlier directory listing of '<dir>' (${count} items) superseded by turn ${N}]`.
   - Command output compaction: for older `exec_command` / `shell_command` / `exec` results, retains exit code and compact head/tail if output > 1,500 chars, or replaces with supersession receipt if re-executed.
2. **Integration into `src/adapters/chatgpt-web/prompt.ts`**:
   - Pipeline order: `withoutSupersededModelSwitchContracts` -> `pruneSemanticToolResults` -> `messageEnvelope` -> build prompt -> check 110k budget -> progressive deep tool receipt compaction -> `nextDroppableIndex` whole-message drop.
3. **New Test Suite `tests/semantic-pruning.test.ts`**:
   - Tests file read deduplication, directory listing supersession, command output compaction, and budget enforcement.

---

## 5. Verification Method

1. **Typecheck**:
   ```powershell
   npx tsc --noEmit
   ```
   *Expected: 0 errors.*

2. **Full Unit Test Suite**:
   ```powershell
   npx -y bun@1.3.14 -e "const fs = require('fs'); const cp = require('child_process'); const files = fs.readdirSync('tests').filter(f => f.endsWith('.test.ts')).map(f => 'tests/' + f); console.log(cp.execSync('bun test ' + files.join(' '), { encoding: 'utf8' }))"
   ```
   *Expected: 354+ tests pass cleanly across all test files.*

3. **Compaction & Prompt Fit Tests**:
   ```powershell
   npx -y bun@1.3.14 test tests/prompt-contract.test.ts tests/prompt-fit-recovery.test.ts tests/compaction-v1.test.ts tests/server-compaction.test.ts tests/visualization-publish.test.ts tests/token-estimate.test.ts
   ```
   *Expected: All pass cleanly.*

4. **Runtime Bundle Build Verification**:
   ```powershell
   npx -y bun@1.3.14 run scripts/build-runtime-bundle.ts
   ```
   *Expected: Successfully produces valid dist/runtime/app/cli.js and dist/runtime/app/browser-helper.cjs passing node --check.*
