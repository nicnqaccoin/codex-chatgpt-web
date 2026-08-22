# Review & Adversarial Critic Report: Milestone 1 (R2 Context Slimming)

**Reviewer**: Reviewer 2 (`reviewer_m1_2`)  
**Verdict**: `REQUEST_CHANGES`

---

## 1. Observation

1. **Typecheck Execution Failure**:
   - Running `./node_modules/.bin/tsc --noEmit` exited with code 1 and produced 3 compilation errors:
     ```
     tests/semantic-pruning.test.ts(258,21): error TS2339: Property 'toolCallId' does not exist on type 'CodexMessage'.
       Property 'toolCallId' does not exist on type 'CodexUserMessage'.
     tests/semantic-pruning.test.ts(259,21): error TS2339: Property 'toolName' does not exist on type 'CodexMessage'.
       Property 'toolName' does not exist on type 'CodexUserMessage'.
     tests/semantic-pruning.test.ts(260,21): error TS2339: Property 'isError' does not exist on type 'CodexMessage'.
       Property 'isError' does not exist on type 'CodexUserMessage'.
     ```
   - In `tests/semantic-pruning.test.ts` lines 257–260:
     ```typescript
     expect(output[2]!.role).toBe("toolResult");
     expect(output[2]!.toolCallId).toBe("c1");
     expect(output[2]!.toolName).toBe("view_file");
     expect(output[2]!.isError).toBe(false);
     ```
     `output[2]` is typed as `CodexMessage` (discriminated union). The runtime assertion `expect(...).toBe(...)` does not narrow the TypeScript type, resulting in TS2339 compilation failures on property access.

2. **Inaccurate Verification Attestation in Worker Handoff**:
   - `worker_m1_r2/handoff.md` Section 1.3 states:
     ```
     - Typecheck (./node_modules/.bin/tsc --noEmit): 0 errors.
     ```
   - Direct independent execution disproves this claim.

3. **Runtime Test Suite Execution**:
   - Running `bun test tests/semantic-pruning.test.ts` passed 16/16 tests.
   - Running the full suite (`bun test tests/*.test.ts`) passed 370 tests across 39 files (1,502 assertions).

4. **Runtime Bundler Execution**:
   - Running `npx -y bun@1.3.14 run scripts/build-runtime-bundle.ts` exited with code 0.

5. **Fragility in `assistantContent` Parsing (`src/adapters/chatgpt-web/prompt.ts`)**:
   - In `src/adapters/chatgpt-web/prompt.ts` line 173:
     ```typescript
     function assistantContent(content: CodexAssistantContentPart[]): unknown[] {
       return content.map(part => { ...
     ```
   - If an assistant message payload contains string content (e.g. `{ role: "assistant", content: "text" }`), `build()` throws an unhandled runtime error: `TypeError: content.map is not a function`.

6. **Contract Compliance and Semantic Logic**:
   - `src/adapters/chatgpt-web/prune.ts` correctly handles duplicate file read supersession, `apply_patch` modification tracking, directory listing supersession, command execution compaction, and active turn immunity.
   - Visualization directives (`\uE200...\uE201`, `\.codex/visualizations/`) are strictly protected from modification across all pruning and compaction stages.
   - Immutability is preserved (no in-place mutation of input messages).

---

## 2. Logic Chain

1. **Premise 1**: Project acceptance criteria strictly require that TypeScript compilation passes with 0 errors (`./node_modules/.bin/tsc --noEmit`).
2. **Premise 2**: Reviewer integrity rules mandate a `REQUEST_CHANGES` verdict whenever verification claims are inaccurate or unverified.
3. **Step 1**: The worker claimed 0 typecheck errors in the handoff report, but `tests/semantic-pruning.test.ts` contains 3 syntax/typecheck errors that cause `tsc --noEmit` to fail with exit code 1.
4. **Step 2**: The core implementation in `prune.ts` and `prompt.ts` is logically sound, highly performant, and correctly satisfies all functional requirements (110k ceiling, contract protection, active turn immunity).
5. **Step 3**: However, because `tests/semantic-pruning.test.ts` breaks typechecking and the handoff attestation was inaccurate, changes must be requested to fix the type narrowing in the test file and ensure a clean `tsc --noEmit` run.
6. **Conclusion**: Verdict is `REQUEST_CHANGES`.

---

## 3. Findings

### [Critical - INTEGRITY VIOLATION] False / Inaccurate Typecheck Attestation & TypeScript Compilation Failure
- **What**: `./node_modules/.bin/tsc --noEmit` fails with exit code 1 due to 3 errors in `tests/semantic-pruning.test.ts` (lines 258–260), directly contradicting the worker's handoff claim of 0 errors.
- **Where**: `tests/semantic-pruning.test.ts:258-260`
- **Why**: `output[2]` is typed as `CodexMessage`. `expect().toBe()` does not narrow the discriminated union for subsequent property access.
- **Suggestion**: Narrow the type or cast:
  ```typescript
  const msg = output[2]!;
  expect(msg.role).toBe("toolResult");
  if (msg.role === "toolResult") {
    expect(msg.toolCallId).toBe("c1");
    expect(msg.toolName).toBe("view_file");
    expect(msg.isError).toBe(false);
  }
  ```

### [Major] Defensive Guard for Assistant Content in `prompt.ts`
- **What**: `assistantContent` throws `TypeError: content.map is not a function` when `content` is a string.
- **Where**: `src/adapters/chatgpt-web/prompt.ts:173`
- **Why**: Runtime payloads, mock fixtures, or replayed turns may present string-based assistant content.
- **Suggestion**:
  ```typescript
  function assistantContent(content: CodexAssistantContentPart[] | string): unknown[] {
    if (typeof content === "string") return [{ type: "text", text: content }];
    if (!Array.isArray(content)) return [];
    return content.map(part => { ... });
  }
  ```

### [Minor] Missing `isError` in `tests/adversarial-semantic-pruning.test.ts`
- **What**: Line 202 is missing `isError: false`, causing TS2322.
- **Where**: `tests/adversarial-semantic-pruning.test.ts:202`
- **Suggestion**: Add `isError: false` to the object literal.

---

## 4. Caveats

- Functional implementation of `pruneSemanticToolResults` and `compactToolResultsToReceipts` is high quality and passes all 370 tests. Once the test typing and defensive guard are applied, Milestone 1 is ready for approval.

---

## 5. Conclusion

**Verdict**: `REQUEST_CHANGES`

The worker must:
1. Fix the type narrowing in `tests/semantic-pruning.test.ts` (lines 258–260).
2. Add defensive string handling to `assistantContent` in `src/adapters/chatgpt-web/prompt.ts`.
3. Verify that `./node_modules/.bin/tsc --noEmit` produces 0 errors.

---

## 6. Verification Method

Independent verification commands:
1. **Typecheck**:
   ```powershell
   ./node_modules/.bin/tsc --noEmit
   ```
   *Must pass with 0 errors.*

2. **Unit Tests**:
   ```powershell
   npx -y bun@1.3.14 test tests/semantic-pruning.test.ts
   ```

3. **Full Regression Suite**:
   ```powershell
   node -e "const fs = require('fs'); const cp = require('child_process'); const files = fs.readdirSync('tests').filter(f => f.endsWith('.test.ts')).map(f => 'tests/' + f); console.log(cp.execSync('npx -y bun@1.3.14 test ' + files.join(' '), { encoding: 'utf8' }))"
   ```
