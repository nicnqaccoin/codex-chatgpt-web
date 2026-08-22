# Milestone 1 (R2: Context Slimming & Token Economy Optimization) Remediation Analysis

## 1. Executive Summary

Milestone 1 implements semantic context slimming and token economy optimization (`src/adapters/chatgpt-web/prune.ts` and `src/adapters/chatgpt-web/prompt.ts`). Forensic auditing and reviewer reports identified four specific defects:
1. **TypeScript Typecheck Failure TS2339 in `tests/semantic-pruning.test.ts` (and TS2322 in `tests/adversarial-semantic-pruning.test.ts`)** causing `./node_modules/.bin/tsc --noEmit` gate failure.
2. **Read-After-Patch Inverted Supersession Bug in `src/adapters/chatgpt-web/prune.ts`** causing authoritative file verification reads after an `apply_patch` turn to be falsely destroyed and replaced with an erroneous receipt referencing an earlier turn.
3. **Consecutive Slash Path Normalization Flaw in `src/adapters/chatgpt-web/prune.ts`** where double slashes from Windows path conversions (`C:\\path` -> `c://path`) prevented path matching.
4. **Missing Defensive Content Guards in `src/adapters/chatgpt-web/prompt.ts`** where `assistantContent` crashed with `TypeError: content.map is not a function` when encountering string assistant content.

This analysis provides exact, line-by-line file remediation specifications for the Worker.

---

## 2. Root Cause Analysis & Problem Inventory

### Issue 1: TypeScript Compilation Failure TS2339 & TS2322
- **File**: `tests/semantic-pruning.test.ts` (lines 258–260) & `tests/adversarial-semantic-pruning.test.ts` (line 202)
- **Root Cause**: In `tests/semantic-pruning.test.ts`, `output[2]` is typed as `CodexMessage`, which is a union (`CodexUserMessage | CodexAssistantMessage | CodexDeveloperMessage | CodexToolResultMessage`). The assertion `expect(output[2]!.role).toBe("toolResult")` is a runtime assertion and does not narrow the TypeScript discriminated union type. Accessing `.toolCallId`, `.toolName`, and `.isError` directly on `output[2]!` triggers TS2339 compiler errors.
- In `tests/adversarial-semantic-pruning.test.ts`, line 202 instantiates a mock `CodexToolResultMessage` without `isError`, triggering TS2322.

### Issue 2: Read-After-Patch Inverted Supersession Bug
- **File**: `src/adapters/chatgpt-web/prune.ts` (lines 464–472)
- **Root Cause**: `seenFileMods` is pre-populated by scanning all assistant modifications across the entire conversation history prior to backward pruning. When the backward loop reaches a file read (e.g. `view_file` at Turn 2, `messageIndex = 6`), `seenFileMods.get(norm)` finds the prior patch from Turn 1 (`messageIndex = 2`). The check `if (mod || newerRead)` evaluated to truthy even though `mod.messageIndex (2) < i (6)`. As a result, Turn 2's verified read content was discarded and replaced with `[Earlier file content of '...' superseded by subsequent read/modification at turn 1]`.
- **Correct Invariant**: A read is ONLY superseded by a modification if that modification occurred *subsequent* to the read (`mod.messageIndex > i`).

### Issue 3: Missing Consecutive Slash Collapse in Path Normalization
- **File**: `src/adapters/chatgpt-web/prune.ts` (lines 143–157)
- **Root Cause**: `normalizePath` converts Windows backslashes `\\` to `/` via `.replaceAll("\\", "/")`. However, escaped backslashes in Windows file paths (e.g. `C:\\app\\src\\file.ts`) produce `c://app/src//file.ts`. Without `.replace(/\/+/g, "/")`, path matching fails when compared to POSIX paths `c:/app/src/file.ts`.
- **Correct Invariant**: All consecutive slashes `/\/+/g` must be collapsed to `/` and trailing slashes stripped.

### Issue 4: Fragility in `assistantContent` & Content Parts
- **File**: `src/adapters/chatgpt-web/prompt.ts` (lines 173–179, 245–248)
- **Root Cause**: `assistantContent(content)` directly invoked `content.map(...)`. If `content` is a string (common in raw test fixtures, replayed payloads, or fallback assistant messages) or not an array, a runtime exception is thrown (`TypeError: content.map is not a function`).
- **Correct Invariant**: `assistantContent` must defensively check `if (typeof content === "string") return [{ type: "text", text: content }];` and `if (!Array.isArray(content)) return [];`.

---

## 3. Step-by-Step Worker Remediation Specification

### Target File 1: `src/adapters/chatgpt-web/prune.ts`

#### Change 1.1: Path Normalization (`normalizePath` and `cleanDisplayPath`)
**Location**: Lines 143–157  
**Before**:
```typescript
function normalizePath(rawPath: string): string {
  return rawPath
    .trim()
    .replace(/^file:\/\/\/?/i, "")
    .replaceAll("\\", "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function cleanDisplayPath(rawPath: string): string {
  return rawPath
    .trim()
    .replace(/^file:\/\/\/?/i, "")
    .replaceAll("\\", "/");
}
```
**After**:
```typescript
function normalizePath(rawPath: string): string {
  return rawPath
    .trim()
    .replace(/^file:\/\/\/?/i, "")
    .replaceAll("\\", "/")
    .replace(/\/+/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function cleanDisplayPath(rawPath: string): string {
  return rawPath
    .trim()
    .replace(/^file:\/\/\/?/i, "")
    .replaceAll("\\", "/")
    .replace(/\/+/g, "/");
}
```

#### Change 1.2: Read-After-Patch Chronological Guard
**Location**: Lines 463–488  
**Before**:
```typescript
        } else {
          const mod = seenFileMods.get(norm);
          const newerRead = seenFileReads.get(norm);
          if (mod || newerRead) {
            const supersededByTurn = Math.max(mod?.turn ?? 0, newerRead?.turn ?? 0);
            const lineCount = text.split(/\r?\n/).length;
            const charCount = text.length;
            const receipt = `[Earlier file content of '${cleanDisplayPath(filePath)}' (${lineCount} lines, ${charCount} chars) superseded by subsequent read/modification at turn ${supersededByTurn}]`;
            result[i] = { ...msg, content: updateContentText(msg.content, receipt) };
          } else {
            // Newest read of this file
            seenFileReads.set(norm, {
              turn: turnNumbers[i]!,
              messageIndex: i,
              displayPath: cleanDisplayPath(filePath),
            });
            if (text.length > 6400) {
              const elided = elideToolResultText(text);
              if (elided !== text) {
                result[i] = { ...msg, content: updateContentText(msg.content, elided) };
              }
            }
          }
        }
```
**After**:
```typescript
        } else {
          const mod = seenFileMods.get(norm);
          const isModNewer = mod !== undefined && mod.messageIndex > i;
          const newerRead = seenFileReads.get(norm);
          const isReadNewer = newerRead !== undefined && newerRead.messageIndex > i;
          if (isModNewer || isReadNewer) {
            const supersededByTurn = Math.max(isModNewer ? mod.turn : 0, isReadNewer ? newerRead.turn : 0);
            const lineCount = text.split(/\r?\n/).length;
            const charCount = text.length;
            const receipt = `[Earlier file content of '${cleanDisplayPath(filePath)}' (${lineCount} lines, ${charCount} chars) superseded by subsequent read/modification at turn ${supersededByTurn}]`;
            result[i] = { ...msg, content: updateContentText(msg.content, receipt) };
          } else {
            // Newest read of this file (at or after any prior modification)
            seenFileReads.set(norm, {
              turn: turnNumbers[i]!,
              messageIndex: i,
              displayPath: cleanDisplayPath(filePath),
            });
            if (text.length > 6400) {
              const elided = elideToolResultText(text);
              if (elided !== text) {
                result[i] = { ...msg, content: updateContentText(msg.content, elided) };
              }
            }
          }
        }
```

---

### Target File 2: `src/adapters/chatgpt-web/prompt.ts`

#### Change 2.1: Defensive `assistantContent` & Helper Guards
**Location**: Lines 173–187  
**Before**:
```typescript
function assistantContent(content: CodexAssistantContentPart[]): unknown[] {
  return content.map(part => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "thinking") return { type: "thinking_summary", text: part.thinking };
    return { type: "tool_call", id: part.id, name: part.name, arguments: part.arguments };
  });
}

function plainMessageText(message: CodexMessage): string | undefined {
  if (message.role === "assistant" || message.role === "toolResult") return undefined;
  if (typeof message.content === "string") return message.content;
  if (message.content.some(part => part.type !== "text")) return undefined;
  return message.content.map(part => part.type === "text" ? part.text : "").join("\n");
}
```
**After**:
```typescript
function assistantContent(content: CodexAssistantContentPart[] | string | unknown): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.map(part => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "thinking") return { type: "thinking_summary", text: part.thinking };
    return { type: "tool_call", id: part.id, name: part.name, arguments: part.arguments };
  });
}

function plainMessageText(message: CodexMessage): string | undefined {
  if (message.role === "assistant" || message.role === "toolResult") return undefined;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content) || message.content.some(part => part.type !== "text")) return undefined;
  return message.content.map(part => part.type === "text" ? part.text : "").join("\n");
}
```

#### Change 2.2: Defensive `isInstructionMessage` Guard
**Location**: Lines 243–249  
**Before**:
```typescript
export function isInstructionMessage(message: CodexMessage): boolean {
  if (message.role === "assistant" || message.role === "toolResult") return false;
  const text = (typeof message.content === "string"
    ? message.content
    : message.content.map(part => part.type === "text" ? part.text : "").join("\n")).trimStart();
  return INSTRUCTION_BLOCK_MARKERS.some(marker => text.startsWith(marker));
}
```
**After**:
```typescript
export function isInstructionMessage(message: CodexMessage): boolean {
  if (message.role === "assistant" || message.role === "toolResult") return false;
  const text = (typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content.map(part => part.type === "text" ? part.text : "").join("\n")
      : "").trimStart();
  return INSTRUCTION_BLOCK_MARKERS.some(marker => text.startsWith(marker));
}
```

---

### Target File 3: `tests/semantic-pruning.test.ts`

#### Change 3.1: Import `CodexToolResultMessage` and Type Narrow `output[2]`
**Location**: Lines 16 & Lines 256–261  
**Before**:
```typescript
// Line 16:
import type { CodexMessage, CodexParsedRequest } from "../src/types";

// Lines 256-261:
  // Message metadata is strictly preserved
  expect(output[2]!.role).toBe("toolResult");
  expect(output[2]!.toolCallId).toBe("c1");
  expect(output[2]!.toolName).toBe("view_file");
  expect(output[2]!.isError).toBe(false);
```
**After**:
```typescript
// Line 16:
import type { CodexMessage, CodexParsedRequest, CodexToolResultMessage } from "../src/types";

// Lines 256-261:
  // Message metadata is strictly preserved
  const toolMsg = output[2] as CodexToolResultMessage;
  expect(toolMsg.role).toBe("toolResult");
  expect(toolMsg.toolCallId).toBe("c1");
  expect(toolMsg.toolName).toBe("view_file");
  expect(toolMsg.isError).toBe(false);
```

---

### Target File 4: `tests/adversarial-semantic-pruning.test.ts`

#### Change 4.1: Fix missing `isError` in test literal
**Location**: Lines 200–210  
**Before**:
```typescript
      {
        role: "toolResult",
        toolCallId: "c_custom",
        toolName: "custom_tool",
        content: [],
        timestamp: 2,
      },
```
**After**:
```typescript
      {
        role: "toolResult",
        toolCallId: "c_custom",
        toolName: "custom_tool",
        content: [],
        isError: false,
        timestamp: 2,
      },
```

#### Change 4.2: Update Read-After-Patch test assertion to verify non-supersession
**Location**: Lines 218–246  
**Before**:
```typescript
describe("Circular Supersessions & Read-After-Patch Anomaly Reproduction", () => {
  test("BUG EMPIRICAL REPRODUCTION: file read AFTER apply_patch is falsely superseded by earlier patch turn", () => {
    const messages: CodexMessage[] = [
      // Turn 1: Edit file
      userMsg("Turn 1: Please edit config.ts", 1),
      assistantToolCallMsg([{ id: "call_patch_1", name: "apply_patch", args: { path: "src/config.ts" } }], 2),
      toolResultMsg("call_patch_1", "apply_patch", "Applied patch to src/config.ts successfully", 3),

      // Turn 2: Read file to verify the edit
      userMsg("Turn 2: Now read config.ts to verify", 4),
      assistantToolCallMsg([{ id: "call_read_1", name: "view_file", args: { path: "src/config.ts" } }], 5),
      toolResultMsg("call_read_1", "view_file", "export const config = { verified: true };\n".repeat(20), 6),

      // Turn 3..8: Subsequent turns pushing Turn 2 outside verbatim window
      userMsg("Turn 3: What do you think?", 7),
      userMsg("Turn 4: Next step", 8),
      userMsg("Turn 5: Next step", 9),
      userMsg("Turn 6: Next step", 10),
      userMsg("Turn 7: Next step", 11),
      userMsg("Turn 8: Active turn", 12),
    ];

    const pruned = pruneSemanticToolResults(messages, { verbatimTailMessages: 2 });
    const turn2ReadResult = pruned[5]!.content as string;

    // This demonstrates the bug: Turn 2's read content was superseded by Turn 1 (an earlier turn!)
    expect(turn2ReadResult).toContain("superseded by subsequent read/modification at turn 1");
  });
});
```
**After**:
```typescript
describe("Circular Supersessions & Read-After-Patch Anomaly Reproduction", () => {
  test("file read AFTER apply_patch is preserved and not superseded by earlier patch turn", () => {
    const messages: CodexMessage[] = [
      // Turn 1: Edit file
      userMsg("Turn 1: Please edit config.ts", 1),
      assistantToolCallMsg([{ id: "call_patch_1", name: "apply_patch", args: { path: "src/config.ts" } }], 2),
      toolResultMsg("call_patch_1", "apply_patch", "Applied patch to src/config.ts successfully", 3),

      // Turn 2: Read file to verify the edit
      userMsg("Turn 2: Now read config.ts to verify", 4),
      assistantToolCallMsg([{ id: "call_read_1", name: "view_file", args: { path: "src/config.ts" } }], 5),
      toolResultMsg("call_read_1", "view_file", "export const config = { verified: true };\n".repeat(20), 6),

      // Turn 3..8: Subsequent turns pushing Turn 2 outside verbatim window
      userMsg("Turn 3: What do you think?", 7),
      userMsg("Turn 4: Next step", 8),
      userMsg("Turn 5: Next step", 9),
      userMsg("Turn 6: Next step", 10),
      userMsg("Turn 7: Next step", 11),
      userMsg("Turn 8: Active turn", 12),
    ];

    const pruned = pruneSemanticToolResults(messages, { verbatimTailMessages: 2 });
    const turn2ReadResult = pruned[5]!.content as string;

    // Verified: Turn 2's read content is preserved as authoritative current file state
    expect(turn2ReadResult).toContain("export const config = { verified: true };");
    expect(turn2ReadResult).not.toContain("superseded");
  });
});
```

---

## 4. Verification Gate Commands for Worker

1. **TypeScript Typecheck Gate**:
   ```powershell
   ./node_modules/.bin/tsc --noEmit
   ```
   *Expected: Exit code 0, 0 errors.*

2. **Unit Test Suite**:
   ```powershell
   npx -y bun@1.3.14 test tests/semantic-pruning.test.ts tests/adversarial-semantic-pruning.test.ts
   ```
   *Expected: 29 pass, 0 fail.*

3. **Full Repository Test Suite**:
   ```powershell
   node -e "const fs = require('fs'); const cp = require('child_process'); const files = fs.readdirSync('tests').filter(f => f.endsWith('.test.ts')).map(f => 'tests/' + f); console.log(cp.execSync('npx -y bun@1.3.14 test ' + files.join(' '), { encoding: 'utf8' }))"
   ```
   *Expected: 398+ pass across 41 files, 0 fail.*

4. **Runtime Bundling Check**:
   ```powershell
   npx -y bun@1.3.14 run scripts/build-runtime-bundle.ts
   node --check dist/runtime/app/cli.js
   node --check dist/runtime/app/browser-helper.cjs
   ```
   *Expected: Exit code 0.*
