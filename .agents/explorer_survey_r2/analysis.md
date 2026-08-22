# R2 Deep Investigation & Architecture Report: Context Slimming & Token Economy Optimization

## Executive Summary

The `codex-chatgpt-web` bridge proxy translates Codex task sessions into temporary ChatGPT Web browser conversations. On ChatGPT Plus (the default tier for most users running `chatgpt-web/high`), the browser composer imposes a strict physical limit of **110,000 characters** per message. Due to rich JSON framing, code snippets, and Unicode delimiters, real-world sessions encode at **~2.63–2.68 characters per token** (average **~2.65 chars/token**), yielding an effective ceiling of **~41,500 tokens** per single message payload.

Crucially, an irreducible baseline of **~19,000–23,000 tokens** (~50,000–60,000 characters) is permanently consumed by:
1. Desktop `<app-context>` (~8.4k tokens / ~22k chars) containing shell rules, file management, and `Images/Visuals/Files` rendering rules.
2. Codex Native MCP tool schemas (`codex_exec`, `codex_apply_patch`, `codex_view_image`, etc., ~8.2k tokens reserved).
3. Base developer instructions (`<environment_context>`, `# AGENTS.md`, plugins/skills catalog, ~4.5k tokens).
4. Transport & capability wrappers (~1k tokens).

This leaves only **~50,000–55,000 characters (~19,000–21,000 tokens)** of usable headroom in the composer for actual conversation history and tool outputs.

Currently, `prompt.ts` relies on a coarse tool result elision function (`withElidedOlderToolResults`) that only truncates messages older than the last 6 messages if they exceed 6,400 characters, followed by a blunt, all-or-nothing message-dropping fit recovery (`nextDroppableIndex`) when the prompt exceeds 110,000 characters. In multi-turn sessions with repeated file reads, redundant directory listings, and long command outputs, this leads to premature shedding of early user requirements and conversation context while retaining redundant, stale tool data.

This report specifies a comprehensive, structured semantic pruning architecture for R2 that cleanses obsolete tool results while rigorously protecting critical contracts, keeping prompts within the 110,000 character wall and maximizing preserved task context.

---

## 1. Current Context Assembly & Compaction Pipeline

### 1.1 Architecture & Call Flow
```
Responses Request (POST /v1/responses or /v1/responses/compact)
   │
   ▼
parseRequest() [src/responses/parser.ts]
   ├── Normalizes systemPrompt, messages (user, assistant, developer, toolResult)
   ├── Decodes transparent compaction envelopes (`ocx1:...` -> plain text)
   ├── Reconstructs assistant reasoning & toolCall parts
   └── Filters 1x1 pixel PNG sentinels & opaque binary blobs
   │
   ▼
compileChatGptWebPrompt() [src/adapters/chatgpt-web/prompt.ts]
   ├── 1. withoutSupersededModelSwitchContracts(messages)
   │      - Strips obsolete <model_switch> and adjacent <skills_instructions>
   ├── 2. withElidedOlderToolResults(messages)
   │      - If msg index < (len - 6) and text.length > 6,400:
   │        Keeps head 4,000 chars + tail 2,000 chars + elision marker
   ├── 3. inputContent() / messageEnvelope()
   │      - Drops desktop-only blocks (<oai-mem-citation>, <recommended_plugins>, ## What's in Memory)
   │      - Extracts structured images (max 10 attachments; drops older images)
   ├── 4. JSON Serialization into <codex_context_json>
   │      - Strips retired turn handles (`withoutRetiredTurnHandles`)
   ├── 5. Transport Assembly
   │      - Appends sharedContract, transportContract, checkpointContract, omittedHistoryNotice, transportResume
   │
   ▼
Fit Recovery Loop (while exceedsBudget())
   ├── Compaction turn: chatGptPromptJsonBytes(text) > 110,000
   ├── Normal turn: text.length > composerCharLimit (110,000 on Plus Medium/High)
   └── nextDroppableIndex(sourceMessages):
          - Discards oldest non-instruction, non-newest message entirely
          - Rebuilds prompt and checks budget again
   │
   ▼
Post-Fit Validation & Compaction Stall Detection
   ├── Compaction Prompt Size Tracking (`noteCompactionPromptSize`):
   │      - If 3 successive compactions in 10 min window stay within 3% spread -> throws 400 context_length_exceeded
   └── Returns CompiledChatGptWebPrompt { text, images, trimmedCompactionMessages? }
```

### 1.2 Limitations of the Current Pipeline
1. **No Semantic Tool Awareness**: `withElidedOlderToolResults` treats all tool outputs as raw strings. It cannot differentiate between a directory listing (`list_dir`), a file read (`view_file`), a test execution (`exec`), or an edit (`apply_patch`).
2. **High Character Threshold (6,400 chars)**: A tool result of 6,000 characters is untouched. Ten such tool calls consume 60,000 characters—more than the entire available history headroom—without triggering elision.
3. **Coarse Age Window (Last 6 Messages)**: In an active tool loop (e.g. agent runs 3 tool calls in parallel or sequence), 6 messages represent only 1-2 turn cycles.
4. **All-or-Nothing Message Trimming**: When the 110,000 char ceiling is breached, `nextDroppableIndex` drops entire conversation turns (user requests, assistant plans) instead of pruning the obsolete intermediate tool results inside still-relevant turns.

---

## 2. Stale Tool Results & Token Waste Analysis

Analysis of real-world Codex / AGY developer sessions reveals four primary categories of tool result bloat:

### 2.1 Repeated File Reads of Unchanged or Modified Files
- **Pattern**: An agent views `src/app.ts` (400 lines, ~14,000 chars), makes an edit via `apply_patch`, and views `src/app.ts` again to verify. Or the agent reads the same config file 4 times across a 10-turn session.
- **Waste**: Replaying earlier file contents when a later read or patch has already updated the model's knowledge burns 10,000–30,000 characters per duplicate read.
- **Semantic Insight**: A subsequent read of file `F` renders all prior reads of `F` obsolete. If `F` was edited via `apply_patch`, prior reads of `F` are historically invalid and misleading.

### 2.2 Duplicate & Superseded Directory Listings / Find Results
- **Pattern**: Multiple `list_dir`, `find_by_name`, or `ls`/`dir`/`find` command invocations on the workspace root or key subdirectories.
- **Waste**: A single large directory listing can be 5,000–15,000 characters. Two or three listings of the same directory consume up to 30,000 characters.
- **Semantic Insight**: The newest listing of directory `D` supersedes earlier listings of `D`. Earlier listings can be safely replaced by a compact stub: `[Earlier directory listing of '<dir>' (${itemCount} items) — superseded by turn ${N}]`.

### 2.3 Outdated & Superseded Command Execution Outputs
- **Pattern**: An agent runs `npm test` or `bun test` resulting in 500 lines of failure output (~25,000 chars), modifies code, runs `bun test` again (~25,000 chars), and finally gets a clean pass.
- **Waste**: 50,000 characters of dead stack traces and outdated failure logs from previous iterations remain in context.
- **Semantic Insight**: Once a command is re-run or superseded by subsequent actions, the old stdout is unnecessary. Preserving only the command executed, exit code, and a 5-line summary or tail is sufficient for reasoning continuity.

### 2.4 Superseded Tool Discovery / Inventory States
- **Pattern**: `tool_search` or `codex_tool_inventory` queries that returned large schemas or tool lists that were already consumed or re-queried later.
- **Waste**: 3,000–8,000 characters per search result.
- **Semantic Insight**: Older discovery results can be compacted to just the names of tools that were actually loaded or invoked.

---

## 3. Structured Semantic Pruning Architecture (R2 Design)

We propose a **three-tier graduated semantic pruning engine** integrated into `compileChatGptWebPrompt` in `src/adapters/chatgpt-web/prompt.ts` (and supported by a dedicated module `src/adapters/chatgpt-web/prune.ts`):

```
+-------------------------------------------------------------------------+
|                        Incoming Codex Messages                          |
+-------------------------------------------------------------------------+
                                     │
                                     ▼
+-------------------------------------------------------------------------+
| Stage 1: Message Contract Pre-Pass                                      |
| - Strip obsolete model switches (withoutSupersededModelSwitchContracts) |
| - Strip desktop-only blocks (withoutDesktopOnlyReplayBlocks)            |
| - Filter 1x1 pixel PNG sentinels & non-semantic images                  |
+-------------------------------------------------------------------------+
                                     │
                                     ▼
+-------------------------------------------------------------------------+
| Stage 2: Structured Semantic Pruning (pruneSemanticToolResults)         |
| 1. Scan tool calls & results from newest to oldest                      |
| 2. File Read Pruning: supersede older reads of file F when newer read   |
|    or patch exists                                                      |
| 3. Directory Listing Pruning: supersede older listings of directory D   |
| 4. Command Output Pruning: compact older command outputs to exit code   |
|    + head/tail summary if superseded                                    |
| 5. Age-Graduated Elision: for remaining older tool results > 1,500 chars|
|    keep head 1,000 + tail 500 chars                                     |
+-------------------------------------------------------------------------+
                                     │
                                     ▼
+-------------------------------------------------------------------------+
| Stage 3: Progressive Fit Recovery (Budget-Aware Fallback)               |
| If prompt still exceeds 110,000 char composer ceiling:                  |
| 1. Deep Tool Result Compaction: reduce all non-recent tool results to   |
|    minimal 1-line semantic receipts                                     |
| 2. Whole-Message Discarding (nextDroppableIndex): drop oldest           |
|    conversation turns one by one                                        |
| 3. Strictly Protect: app-context, base instructions, newest user turn,  |
|    and visualization sentinels                                          |
+-------------------------------------------------------------------------+
```

### 3.1 Detailed Semantic Pruning Rules

#### Rule A: File Read Deduplication & Supersession
- **Detection**: Tool results from `view_file`, `read_file`, `cat`, `Get-Content`, or tool calls with path arguments.
- **Logic**:
  - Maintain a registry of `seenFiles = Map<canonicalPath, { newestTurn: number, hasModifications: boolean }>`.
  - If a tool result represents reading `path/to/file` and a newer tool result or `apply_patch` touched that same path, replace the content with:
    ```
    [Earlier file content of 'src/adapters/chatgpt-web/prompt.ts' (${lineCount} lines, ${charCount} chars) superseded by subsequent read/modification at turn ${turnId}]
    ```
  - **Exception**: The most recent read of any file is kept intact.

#### Rule B: Directory Listing & File Search Supersession
- **Detection**: Tool results from `list_dir`, `find_by_name`, `grep_search`, `ls`, `dir`, `fd`, `find`.
- **Logic**:
  - Track directory / glob targets.
  - If the same directory path is queried again in a later turn, replace earlier results with:
    ```
    [Earlier directory listing of 'src/adapters/' (${itemCount} items) superseded by turn ${turnId}]
    ```

#### Rule C: Outdated Command Output Compaction
- **Detection**: Tool results from `exec_command`, `shell_command`, `exec`, `codex_exec` where index < `(messages.length - CHATGPT_VERBATIM_TOOL_RESULT_MESSAGES)`.
- **Logic**:
  - If the command output length > 1,500 characters:
    - If exit code == 0 (success): preserve first 300 chars + `[... ${elided} chars omitted for completed command ...]`.
    - If exit code != 0 (failure): preserve first 500 chars (command + start) + last 500 chars (error details / stack trace) + `[... ${elided} chars elided ...]`.
    - If the exact same command was executed later in history, condense the earlier output to:
      ```
      [Command `${cmd}` output superseded by subsequent execution; Exit code: ${exitCode}]
      ```

#### Rule D: Protecting Active Tool Loop
- Recent messages within the active turn (messages since `latestUserIndex`, or at least the last 4–6 messages) are **verbatim** to ensure multi-step reasoning has complete, uncorrupted observation data.

---

## 4. Token Math & Character Ceiling Analysis

### 4.1 Plus vs Pro Account Limits
| Parameter | Plus (Instant) | Plus (Medium/High) [Default] | Pro (Instant) | Pro (Reasoning) | Pro (Model) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Model** | `gpt-5.6-sol` | `gpt-5.6-sol` | `gpt-5.6-sol` | `gpt-5.6-sol` | `gpt-5.6-sol` |
| **Codex Effort** | `low` | `medium` / `high` | `low` | `xhigh` | `ultra` (`max`) |
| **Context Window** | 41,000 tokens | 90,000 tokens | 111,193 tokens | 111,193 tokens | 112,193 tokens |
| **Auto-Compact Limit** | 32,000 tokens | 60,000 tokens | 95,000 tokens | 95,000 tokens | 95,000 tokens |
| **Composer Char Ceiling**| 211,256 chars | **110,000 chars** | 545,000 chars | 1,045,000 chars | 1,635,000 chars |
| **Approx Token Ceiling**| ~79,700 tokens | **~41,500 tokens** | ~205,000 tokens | ~394,000 tokens | ~617,000 tokens |

### 4.2 Breakdown of the Irreducible Floor (~21k–23k Tokens / ~55k–60k Chars)
1. **Desktop `<app-context>`**: ~8,400 tokens (~22,200 chars)
   - Carries system instructions, OS environment, shell specifics, and critical `### Images/Visuals/Files` contract.
2. **Codex Native Tool Schemas**: ~8,192 tokens (~21,700 chars)
   - Reserved via `CHATGPT_WEB_PLATFORM_RESERVE_TOKENS` for `codex_exec`, `codex_apply_patch`, `codex_view_image`, `codex_write_stdin`, `codex_tool_inventory`, `codex_tool_call`.
3. **Base Developer / AGENTS.md Instructions**: ~4,500 tokens (~12,000 chars)
   - `<environment_context>`, `# AGENTS.md`, active skills and plugins.
4. **Transport Wrapper & Contracts**: ~1,000 tokens (~2,800 chars)
   - `sharedContract`, `transportContract`, JSON envelope markers.

### 4.3 Working Budget on Plus Medium/High
- **Total Composer Budget**: 110,000 chars (~41,500 tokens).
- **Irreducible Floor**: ~58,000 chars (~22,000 tokens).
- **Available History & Tool Budget**: **~52,000 chars (~19,500 tokens)**.

Without semantic pruning, 2–3 file reads and a test output immediately consume 50,000 chars, causing fit recovery to discard early user requirements. With semantic pruning, stale tool data is compressed by 70–90%, preserving 3x to 5x more conversation turns within the same 110,000 character wall.

---

## 5. Critical Contract Protections

Any context slimming implementation MUST guarantee the following contracts remain 100% intact:

### 5.1 Desktop `<app-context>` Protection
- Defined in `isInstructionMessage()` in `prompt.ts`.
- Markers: `<app-context>`, `<environment_context>`, `<skills_instructions>`, `<model_switch>`, `<permissions instructions>`, `<collaboration_mode>`, `<apps_instructions>`, `<plugins_instructions>`, `# AGENTS.md`, `Capabilities from the`.
- These messages MUST NEVER be dropped by `nextDroppableIndex()` or modified by semantic pruning.

### 5.2 Visualization Private-Use Sentinels (U+E200 ... U+E201)
- Format: `\uE200visualize\uE202{"path":"<absolute_html_path>"}\uE201`
- Generated by `visualizationReference(path)` in `src/adapters/chatgpt-web/final-artifacts.ts`.
- `requiredVisualizationReference()` scans tool results following `latestUserIndex` for `.codex/visualizations/` files or `apply_patch` lines matching `PATCHED_HTML_LINE` (`/^\s*[AM]\s+(.+?\.html)\s*$/i`).
- **Protection Rule**: Semantic pruning must NEVER mutate tool results in `parsed.context.messages` destructively. Pruning applies ONLY to the cloned/compiled message list inside `compileChatGptWebPrompt`. Furthermore, `apply_patch` results in the active turn must retain their file path lines.

### 5.3 Luna Rolling Checkpoint Sentinel
- Free/Luna accounts use `CHATGPT_LUNA_CHECKPOINT_MARKER = "CODEXLUNAPRIVATECHECKPOINTV1A7F3C9D2"` (max 4,000 tokens).
- `ChatGptLunaCheckpointStore` exact-parent matching replaces full historical replay with the private checkpoint.
- Must not be altered or mixed with standard v1/v2 compaction.

### 5.4 Newest User / Assistant Message
- The newest message in `messages` is the active user turn or compaction instruction.
- It is strictly protected by `nextDroppableIndex()` (`if (index === newest) continue;`).

---

## 6. Test Coverage & Gap Analysis

### 6.1 Existing Coverage
- `tests/prompt-contract.test.ts` (16 tests): Tests prompt compilation, image attachments, broker token injection, compaction JSON budget, rich result markdown contracts.
- `tests/prompt-insertion-fit.test.ts` (7 tests): Tests chunking, whitespace normalization, surrogate pair preservation, truncation vs divergence error classification.
- `tests/prompt-fit-recovery.test.ts` (8 tests): Tests `isInstructionMessage`, `nextDroppableIndex`, dropping old conversation while keeping app-context, `withElidedOlderToolResults`, compaction stall detection.
- `tests/compaction-v1.test.ts` (3 tests): Tests v1 summary prefix parsing, image retention bounds (max 10), 1x1 png sentinel filtering.
- `tests/server-compaction.test.ts` (11 tests): Tests `/v1/responses/compact` and v2 `compaction_trigger`, single compaction item output, Luna rejection of separate compaction, Pro model rejection on non-Pro accounts.
- `tests/token-estimate.test.ts` (4 tests): Tests o200k tokenizer chunking, dense JSON counting, repeated text chunking.
- `tests/visualization-publish.test.ts` (6 tests): Tests visualization reference repair, directory matching, shell copy detection, error filtering.
- `tests/chatgpt-web-usage.test.ts` (2 tests): Tests usage token estimation without character pressure inflation.

### 6.2 Identified Gaps & Missing Test Cases
1. **Semantic Tool Deduplication Tests**:
   - No test verifying that reading the same file twice results in the older read being pruned while the newer read is preserved verbatim.
   - No test verifying that a file read followed by an `apply_patch` on that file prunes the pre-patch file read.
2. **Directory Listing Supersession Tests**:
   - No test verifying that duplicate `list_dir` or `find_by_name` results on the same path prune earlier listings to a lightweight reference.
3. **Command Output Compaction Tests**:
   - No test verifying that long command stdout (e.g. 5,000 chars) in older turns is compacted to exit code + head/tail summary.
   - No test verifying that re-running the same command in a later turn supersedes the earlier command output.
4. **Multi-Stage Fit Recovery Hierarchy Tests**:
   - No test verifying that when prompt exceeds 110,000 characters, semantic tool pruning executes FIRST before whole conversation messages are dropped.
5. **Contract Protection Interaction Tests**:
   - No test verifying that semantic pruning does NOT remove or corrupt `apply_patch` lines needed by `requiredVisualizationReference`.
   - No test verifying that tool result `isError` flags and `toolCallId` attributes are strictly preserved through semantic pruning.

---

## 7. Actionable Implementation Recommendations for R2 Developer Agent

1. **Create `src/adapters/chatgpt-web/prune.ts`**:
   - Implement `pruneSemanticToolResults(messages: readonly CodexMessage[]): CodexMessage[]`.
   - Implement deduplication of file reads (`view_file`, `read_file`, `cat`).
   - Implement supersession of directory listings (`list_dir`, `find_by_name`, `dir`, `ls`).
   - Implement compaction of older command execution outputs (`exec_command`, `shell_command`, `exec`).
   - Preserve recent window (last 6 messages) verbatim.
   - Strictly preserve `isError`, `toolCallId`, and `toolName`.

2. **Integrate into `compileChatGptWebPrompt` in `src/adapters/chatgpt-web/prompt.ts`**:
   - Replace or enhance `withElidedOlderToolResults` with `pruneSemanticToolResults`.
   - Order of operations:
     1. `withoutSupersededModelSwitchContracts`
     2. `pruneSemanticToolResults`
     3. Build initial prompt and check budget.
     4. If still exceeding budget, apply aggressive tool receipt compaction before dropping whole conversation messages via `nextDroppableIndex`.

3. **Add Comprehensive Test Suite `tests/semantic-pruning.test.ts`**:
   - Test all deduplication and supersession heuristics.
   - Test interaction with `requiredVisualizationReference`.
   - Test 110,000 character limit enforcement under heavy tool output loads.
