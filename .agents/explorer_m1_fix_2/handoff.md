# Explorer Handoff Report — Milestone 1 (R2 Context Slimming) Fix Specification

## 1. Observation

1. **Forensic Audit & Review Findings**:
   - Auditor (`auditor_m1`), Reviewer 1 (`reviewer_m1_1`), and Reviewer 2 (`reviewer_m1_2`) verified that `./node_modules/.bin/tsc --noEmit` fails with exit code 1 due to 3 errors in `tests/semantic-pruning.test.ts` (lines 258–260) and 1 error in `tests/adversarial-semantic-pruning.test.ts` (line 202).
   - Challenger 1 (`challenger_m1_1`) proved a critical algorithmic bug in `src/adapters/chatgpt-web/prune.ts`: `seenFileMods` is pre-scanned globally, causing post-patch file reads (`view_file` at turn $N+1$) to be erroneously superseded by prior patches (`apply_patch` at turn $N$) because `mod.messageIndex > i` was not checked.
   - Challenger 1 proved a path normalization defect in `prune.ts`: consecutive slashes (e.g. from Windows backslash conversion `C:\\app\\src` -> `c://app/src`) are not collapsed, breaking path equality matches.
   - Reviewer 2 identified that `assistantContent` in `src/adapters/chatgpt-web/prompt.ts` lacks string and non-array guards, leading to `TypeError: content.map is not a function` on string content.

2. **Codebase Inspection**:
   - `tests/semantic-pruning.test.ts`: lines 258–260 directly dereference `output[2]!.toolCallId`, `toolName`, `isError` without union casting from `CodexMessage`.
   - `tests/adversarial-semantic-pruning.test.ts`: line 202 creates a `CodexToolResultMessage` literal missing `isError: false`.
   - `src/adapters/chatgpt-web/prune.ts`: lines 143–157 (`normalizePath` and `cleanDisplayPath`) do not collapse consecutive slashes `replace(/\/+/g, "/")`.
   - `src/adapters/chatgpt-web/prune.ts`: lines 464–472 check `if (mod || newerRead)` without verifying `mod.messageIndex > i` and `newerRead.messageIndex > i`.
   - `src/adapters/chatgpt-web/prompt.ts`: line 173 (`assistantContent`) and line 245 (`isInstructionMessage`) lack string and `Array.isArray` fallback guards.

---

## 2. Logic Chain

1. **Step 1 (Typecheck Gate)**: In `tests/semantic-pruning.test.ts`, casting `const toolMsg = output[2] as CodexToolResultMessage;` and adding `isError: false` to `tests/adversarial-semantic-pruning.test.ts:202` resolves all 4 TypeScript compiler errors, allowing `./node_modules/.bin/tsc --noEmit` to pass with 0 errors.
2. **Step 2 (Read-After-Patch Invariance)**: In multi-turn sessions, an agent edits a file in turn $N$ and inspects it in turn $N+1$ to verify correctness. The turn $N+1$ read is the authoritative current workspace state. Checking `const isModNewer = mod !== undefined && mod.messageIndex > i;` guarantees that prior modifications cannot supersede subsequent reads.
3. **Step 3 (Path Normalization)**: Collapsing consecutive slashes via `.replace(/\/+/g, "/")` in `normalizePath` and `cleanDisplayPath` ensures cross-platform consistency for escaped backslashes, double slashes, and `file:///` URIs.
4. **Step 4 (Defensive Content Handling)**: Adding type and array guards in `assistantContent` (`if (typeof content === "string") return [{ type: "text", text: content }]; if (!Array.isArray(content)) return [];`) prevents unhandled runtime exceptions when processing string-based assistant messages.

---

## 3. Caveats

- **Scope Boundary**: All 4 changes are strictly scoped to `src/adapters/chatgpt-web/prune.ts`, `src/adapters/chatgpt-web/prompt.ts`, `tests/semantic-pruning.test.ts`, and `tests/adversarial-semantic-pruning.test.ts`. No other modules or interfaces need modification.
- **Contract Invariance**: Visualization sentinels (`\uE200..\uE201`), active turn immunity (`latestUserIndex`), `<app-context>` blocks, and 110k character composer ceiling are fully preserved and validated.

---

## 4. Conclusion

The remediation plan is completely specified in `analysis.md` with exact before/after code blocks. The Worker should apply the 4 target modifications, run `tsc --noEmit`, run `bun test`, and verify the runtime bundler.

---

## 5. Verification Method

To verify the remediation:

1. **Run TypeScript typecheck**:
   ```powershell
   ./node_modules/.bin/tsc --noEmit
   ```
   *Expected: Exit code 0, 0 errors.*

2. **Run semantic pruning and adversarial unit tests**:
   ```powershell
   npx -y bun@1.3.14 test tests/semantic-pruning.test.ts tests/adversarial-semantic-pruning.test.ts
   ```
   *Expected: 29 pass, 0 fail.*

3. **Run full repository regression test suite**:
   ```powershell
   node -e "const fs = require('fs'); const cp = require('child_process'); const files = fs.readdirSync('tests').filter(f => f.endsWith('.test.ts')).map(f => 'tests/' + f); console.log(cp.execSync('npx -y bun@1.3.14 test ' + files.join(' '), { encoding: 'utf8' }))"
   ```
   *Expected: 398 pass across 41 files, 0 fail.*

4. **Verify runtime bundle build & syntax validation**:
   ```powershell
   npx -y bun@1.3.14 run scripts/build-runtime-bundle.ts
   node --check dist/runtime/app/cli.js
   node --check dist/runtime/app/browser-helper.cjs
   ```
   *Expected: Exit code 0.*
