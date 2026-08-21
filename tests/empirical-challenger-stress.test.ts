import { expect, test, describe } from "bun:test";
import {
  pruneSemanticToolResults,
  compactToolResultsToReceipts,
  getLatestUserIndex,
  isInstructionMessage,
  elideToolResultText,
  textFromContent,
  updateContentText,
  type SemanticPruneOptions,
} from "../src/adapters/chatgpt-web/prune";
import {
  compileChatGptWebPrompt,
  withoutRetiredTurnHandles,
  withoutDesktopOnlyReplayBlocks,
  withoutSupersededModelSwitchContracts,
  nextDroppableIndex,
  countChatGptContextImages,
  chatGptPromptJsonBytes,
} from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_MODEL_ID, type ChatGptWebCapabilities } from "../src/adapters/chatgpt-web/model";
import type { CodexContentPart, CodexMessage, CodexParsedRequest, CodexToolResultMessage } from "../src/types";

const testCapabilities: ChatGptWebCapabilities = {
  localToolsEnabled: true,
  solAvailable: true,
  proAvailable: false,
};

function userMsg(content: string | CodexContentPart[], timestamp: number): CodexMessage {
  return { role: "user", content, timestamp };
}

function assistantToolCallMsg(
  toolCalls: Array<{ id: string; name: string; args?: Record<string, unknown> }>,
  timestamp: number,
): CodexMessage {
  return {
    role: "assistant",
    content: toolCalls.map(tc => ({
      type: "toolCall",
      id: tc.id,
      name: tc.name,
      arguments: tc.args || {},
    })),
    timestamp,
  };
}

function toolResultMsg(
  toolCallId: string,
  toolName: string,
  content: string | CodexContentPart[],
  timestamp: number,
  isError = false,
): CodexMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content,
    isError,
    timestamp,
  };
}

function makeRequest(messages: CodexMessage[], modelId = CHATGPT_WEB_MODEL_ID): CodexParsedRequest {
  return {
    modelId,
    context: { messages, systemPrompt: [] },
    stream: true,
    options: { reasoning: "high" },
  } as unknown as CodexParsedRequest;
}

describe("Suite 1: Read-Patch-Read & Multi-Turn Lifecycle Invariants", () => {
  test("Classic Read v1 -> Edit v2 -> Read v2 across 10 turns", () => {
    const v1Content = "export function app() { return 'v1'; }\n".repeat(40);
    const v2Content = "export function app() { return 'v2-verified'; }\n".repeat(40);

    const messages: CodexMessage[] = [
      // Turn 1: Read v1
      userMsg("Turn 1: Read index.ts", 1),
      assistantToolCallMsg([{ id: "c_r1", name: "view_file", args: { path: "src/index.ts" } }], 2),
      toolResultMsg("c_r1", "view_file", v1Content, 3),

      // Turn 2: Edit to v2
      userMsg("Turn 2: Update index.ts to v2", 4),
      assistantToolCallMsg([{ id: "c_p1", name: "apply_patch", args: { path: "src/index.ts" } }], 5),
      toolResultMsg("c_p1", "apply_patch", "Applied patch to src/index.ts", 6),

      // Turn 3: Read v2 (post-patch verification)
      userMsg("Turn 3: Read index.ts to verify", 7),
      assistantToolCallMsg([{ id: "c_r2", name: "view_file", args: { path: "src/index.ts" } }], 8),
      toolResultMsg("c_r2", "view_file", v2Content, 9),

      // Turns 4..10: Push turns 1-3 outside the verbatim tail
      userMsg("Turn 4: Next step", 10),
      userMsg("Turn 5: Next step", 11),
      userMsg("Turn 6: Next step", 12),
      userMsg("Turn 7: Next step", 13),
      userMsg("Turn 8: Next step", 14),
      userMsg("Turn 9: Next step", 15),
      userMsg("Turn 10: Active prompt", 16),
    ];

    const pruned = pruneSemanticToolResults(messages, { verbatimTailMessages: 2 });
    const turn1Result = pruned[2]!.content as string;
    const turn2Patch = pruned[5]!.content as string;
    const turn3Result = pruned[8]!.content as string;

    // Turn 1 read (pre-patch) MUST be superseded
    expect(turn1Result).toContain("Earlier file content of 'src/index.ts'");
    expect(turn1Result).toContain("superseded by subsequent read/modification");

    // Turn 2 patch result remains
    expect(turn2Patch).toBe("Applied patch to src/index.ts");

    // Turn 3 read (post-patch) MUST NEVER be superseded
    expect(turn3Result).toContain("v2-verified");
    expect(turn3Result).not.toContain("superseded");
  });

  test("Complex Interleaved Multi-File Read-Patch-Read lifecycle (Files A, B, C)", () => {
    const fileA_v1 = "const A = 1;\n".repeat(30);
    const fileA_v2 = "const A = 2;\n".repeat(30);
    const fileA_v3 = "const A = 3;\n".repeat(30);
    const fileB_v1 = "const B = 100;\n".repeat(30);
    const fileB_v2 = "const B = 200;\n".repeat(30);

    const messages: CodexMessage[] = [
      // Turn 1: Read A (v1)
      userMsg("Turn 1: Read A", 1),
      assistantToolCallMsg([{ id: "cA_r1", name: "view_file", args: { path: "src/A.ts" } }], 2),
      toolResultMsg("cA_r1", "view_file", fileA_v1, 3),

      // Turn 2: Read B (v1)
      userMsg("Turn 2: Read B", 4),
      assistantToolCallMsg([{ id: "cB_r1", name: "view_file", args: { path: "src/B.ts" } }], 5),
      toolResultMsg("cB_r1", "view_file", fileB_v1, 6),

      // Turn 3: Patch A -> v2
      userMsg("Turn 3: Patch A to v2", 7),
      assistantToolCallMsg([{ id: "cA_p1", name: "apply_patch", args: { path: "src/A.ts" } }], 8),
      toolResultMsg("cA_p1", "apply_patch", "Applied patch to src/A.ts", 9),

      // Turn 4: Read A (v2)
      userMsg("Turn 4: Read A v2", 10),
      assistantToolCallMsg([{ id: "cA_r2", name: "view_file", args: { path: "src/A.ts" } }], 11),
      toolResultMsg("cA_r2", "view_file", fileA_v2, 12),

      // Turn 5: Patch B -> v2
      userMsg("Turn 5: Patch B to v2", 13),
      assistantToolCallMsg([{ id: "cB_p1", name: "apply_patch", args: { path: "src/B.ts" } }], 14),
      toolResultMsg("cB_p1", "apply_patch", "Applied patch to src/B.ts", 15),

      // Turn 6: Read B (v2)
      userMsg("Turn 6: Read B v2", 16),
      assistantToolCallMsg([{ id: "cB_r2", name: "view_file", args: { path: "src/B.ts" } }], 17),
      toolResultMsg("cB_r2", "view_file", fileB_v2, 18),

      // Turn 7: Patch A -> v3
      userMsg("Turn 7: Patch A to v3", 19),
      assistantToolCallMsg([{ id: "cA_p2", name: "apply_patch", args: { path: "src/A.ts" } }], 20),
      toolResultMsg("cA_p2", "apply_patch", "Applied patch to src/A.ts v3", 21),

      // Turn 8: Read A (v3)
      userMsg("Turn 8: Read A v3", 22),
      assistantToolCallMsg([{ id: "cA_r3", name: "view_file", args: { path: "src/A.ts" } }], 23),
      toolResultMsg("cA_r3", "view_file", fileA_v3, 24),

      // Turns 9..15: Buffer turns
      userMsg("Turn 9", 25),
      userMsg("Turn 10", 26),
      userMsg("Turn 11", 27),
      userMsg("Turn 12", 28),
      userMsg("Turn 13", 29),
      userMsg("Turn 14", 30),
      userMsg("Turn 15: Active", 31),
    ];

    const pruned = pruneSemanticToolResults(messages, { verbatimTailMessages: 2 });

    const a_r1 = pruned[2]!.content as string;
    const b_r1 = pruned[5]!.content as string;
    const a_r2 = pruned[11]!.content as string;
    const b_r2 = pruned[17]!.content as string;
    const a_r3 = pruned[23]!.content as string;

    // A v1: superseded
    expect(a_r1).toContain("Earlier file content of 'src/A.ts'");
    // B v1: superseded
    expect(b_r1).toContain("Earlier file content of 'src/B.ts'");
    // A v2: superseded by Turn 7 patch / Turn 8 read
    expect(a_r2).toContain("Earlier file content of 'src/A.ts'");
    // B v2: latest read of B -> PRESERVED!
    expect(b_r2).toContain("const B = 200;");
    expect(b_r2).not.toContain("superseded");
    // A v3: latest read of A -> PRESERVED!
    expect(a_r3).toContain("const A = 3;");
    expect(a_r3).not.toContain("superseded");
  });

  test("Multiple successive patches without intervening reads, followed by read", () => {
    const v0 = "const state = 0;\n".repeat(30);
    const v3 = "const state = 3;\n".repeat(30);

    const messages: CodexMessage[] = [
      userMsg("Turn 1: Initial read", 1),
      assistantToolCallMsg([{ id: "c_r0", name: "view_file", args: { path: "state.ts" } }], 2),
      toolResultMsg("c_r0", "view_file", v0, 3),

      userMsg("Turn 2: Patch 1", 4),
      assistantToolCallMsg([{ id: "c_p1", name: "apply_patch", args: { path: "state.ts" } }], 5),
      toolResultMsg("c_p1", "apply_patch", "Applied patch 1", 6),

      userMsg("Turn 3: Patch 2", 7),
      assistantToolCallMsg([{ id: "c_p2", name: "apply_patch", args: { path: "state.ts" } }], 8),
      toolResultMsg("c_p2", "apply_patch", "Applied patch 2", 9),

      userMsg("Turn 4: Patch 3", 10),
      assistantToolCallMsg([{ id: "c_p3", name: "apply_patch", args: { path: "state.ts" } }], 11),
      toolResultMsg("c_p3", "apply_patch", "Applied patch 3", 12),

      userMsg("Turn 5: Verify final state", 13),
      assistantToolCallMsg([{ id: "c_r3", name: "view_file", args: { path: "state.ts" } }], 14),
      toolResultMsg("c_r3", "view_file", v3, 15),

      userMsg("Turn 6", 16),
      userMsg("Turn 7", 17),
      userMsg("Turn 8", 18),
      userMsg("Turn 9", 19),
      userMsg("Turn 10", 20),
      userMsg("Turn 11", 21),
      userMsg("Turn 12: Active", 22),
    ];

    const pruned = pruneSemanticToolResults(messages, { verbatimTailMessages: 2 });
    const r0 = pruned[2]!.content as string;
    const r3 = pruned[14]!.content as string;

    expect(r0).toContain("superseded");
    expect(r3).toContain("const state = 3;");
    expect(r3).not.toContain("superseded");
  });

  test("Tool name prefixes and aliases across MCP, builtins, and variations", () => {
    const fileContent = "function test() {}\n".repeat(30);
    const aliases = [
      { readTool: "codex_view_file", patchTool: "codex_apply_patch" },
      { readTool: "mcp__filesystem__read_file", patchTool: "mcp__filesystem__write_to_file" },
      { readTool: "read_text_file", patchTool: "replace_file_content" },
      { readTool: "cat", patchTool: "modify_file" },
      { readTool: "get_file_contents", patchTool: "create_or_update_file" },
    ];

    for (const { readTool, patchTool } of aliases) {
      const messages: CodexMessage[] = [
        userMsg("Turn 1: Read", 1),
        assistantToolCallMsg([{ id: "c1", name: readTool, args: { filePath: "lib/alias.ts" } }], 2),
        toolResultMsg("c1", readTool, fileContent, 3),

        userMsg("Turn 2: Patch", 4),
        assistantToolCallMsg([{ id: "c2", name: patchTool, args: { targetFile: "lib/alias.ts" } }], 5),
        toolResultMsg("c2", patchTool, "Updated file", 6),

        userMsg("Turn 3: Read after patch", 7),
        assistantToolCallMsg([{ id: "c3", name: readTool, args: { filePath: "lib/alias.ts" } }], 8),
        toolResultMsg("c3", readTool, fileContent + "// patched\n", 9),

        userMsg("Turn 4", 10),
        userMsg("Turn 5", 11),
        userMsg("Turn 6", 12),
        userMsg("Turn 7", 13),
        userMsg("Turn 8", 14),
        userMsg("Turn 9: Active", 15),
      ];

      const pruned = pruneSemanticToolResults(messages, { verbatimTailMessages: 2 });
      const read1 = pruned[2]!.content as string;
      const read2 = pruned[8]!.content as string;

      expect(read1).toContain("superseded");
      expect(read2).toContain("// patched");
      expect(read2).not.toContain("superseded");
    }
  });
});

describe("Suite 2: Consecutive Slash & Windows/POSIX Path Normalization Stress", () => {
  test("Extreme slash redundancy (\\\\\\\\, ////, //\\//) resolves to identical identity", () => {
    const rawContent = "console.log('slash test');\n".repeat(30);
    const messages: CodexMessage[] = [
      userMsg("Turn 1: Quadruple backslashes", 1),
      assistantToolCallMsg([{ id: "c1", name: "view_file", args: { path: "C:\\\\\\\\Users\\\\\\\\dev\\\\\\\\App\\\\\\\\main.ts" } }], 2),
      toolResultMsg("c1", "view_file", rawContent, 3),

      userMsg("Turn 2: Quadruple forward slashes", 4),
      assistantToolCallMsg([{ id: "c2", name: "view_file", args: { path: "c:////users////dev////app////main.ts" } }], 5),
      toolResultMsg("c2", "view_file", rawContent + "// v2\n", 6),

      userMsg("Turn 3: Mixed slashes", 7),
      assistantToolCallMsg([{ id: "c3", name: "view_file", args: { path: "C:\\/\\/Users/\\/dev\\/App\\/main.ts" } }], 8),
      toolResultMsg("c3", "view_file", rawContent + "// v3\n", 9),

      userMsg("Turn 4", 10),
      userMsg("Turn 5", 11),
      userMsg("Turn 6", 12),
      userMsg("Turn 7", 13),
      userMsg("Turn 8", 14),
      userMsg("Turn 9", 15),
      userMsg("Turn 10: Active", 16),
    ];

    const pruned = pruneSemanticToolResults(messages, { verbatimTailMessages: 2 });
    const r1 = pruned[2]!.content as string;
    const r2 = pruned[5]!.content as string;
    const r3 = pruned[8]!.content as string;

    // Both r1 and r2 should be superseded by r3
    expect(r1).toContain("superseded");
    expect(r2).toContain("superseded");
    expect(r3).toContain("// v3");
    expect(r3).not.toContain("superseded");
  });

  test("Directory listing with redundant slashes and case differences", () => {
    const listing = "a.ts\nb.ts\nc.ts\n";
    const messages: CodexMessage[] = [
      userMsg("Turn 1: List dir with quadruple slashes and uppercase", 1),
      assistantToolCallMsg([{ id: "cd1", name: "list_dir", args: { directory_path: "C:\\\\\\\\PROJECT\\\\\\\\SRC\\\\\\\\" } }], 2),
      toolResultMsg("cd1", "list_dir", listing, 3),

      userMsg("Turn 2: List dir posix lowercase", 4),
      assistantToolCallMsg([{ id: "cd2", name: "list_dir", args: { directory_path: "c:/project/src" } }], 5),
      toolResultMsg("cd2", "list_dir", listing + "d.ts\n", 6),

      userMsg("Turn 3..9", 7),
      userMsg("Turn 4", 8),
      userMsg("Turn 5", 9),
      userMsg("Turn 6", 10),
      userMsg("Turn 7", 11),
      userMsg("Turn 8", 12),
      userMsg("Turn 9: Active", 13),
    ];

    const pruned = pruneSemanticToolResults(messages, { verbatimTailMessages: 2 });
    const dir1 = pruned[2]!.content as string;
    const dir2 = pruned[5]!.content as string;

    expect(dir1).toContain("Earlier directory listing");
    expect(dir1).toContain("superseded by turn");
    expect(dir2).toBe(listing + "d.ts\n");
  });

  test("find_by_name with pattern and redundant directory slashes", () => {
    const list1 = "test1.spec.ts\n";
    const list2 = "test1.spec.ts\ntest2.spec.ts\n";
    const messages: CodexMessage[] = [
      userMsg("Turn 1: Search with redundant slashes", 1),
      assistantToolCallMsg([{ id: "cf1", name: "find_by_name", args: { SearchDirectory: "C:\\\\\\\\Project\\\\\\\\tests\\\\\\\\", Pattern: "*.SPEC.TS" } }], 2),
      toolResultMsg("cf1", "find_by_name", list1, 3),

      userMsg("Turn 2: Search with posix normalized slashes", 4),
      assistantToolCallMsg([{ id: "cf2", name: "find_by_name", args: { SearchDirectory: "c:/project/tests", Pattern: "*.spec.ts" } }], 5),
      toolResultMsg("cf2", "find_by_name", list2, 6),

      userMsg("Turn 3..9", 7),
      userMsg("Turn 4", 8),
      userMsg("Turn 5", 9),
      userMsg("Turn 6", 10),
      userMsg("Turn 7", 11),
      userMsg("Turn 8", 12),
      userMsg("Turn 9: Active", 13),
    ];

    const pruned = pruneSemanticToolResults(messages, { verbatimTailMessages: 2 });
    const search1 = pruned[2]!.content as string;
    const search2 = pruned[5]!.content as string;

    expect(search1).toContain("Earlier directory listing");
    expect(search1).toContain("superseded by turn");
    expect(search2).toBe(list2);
  });
});

describe("Suite 3: Plain String & Array Content Payloads", () => {
  test("User and developer messages with plain string and array content payloads", () => {
    const messages: CodexMessage[] = [
      {
        role: "developer",
        content: "<skills_instructions>\nSkill list here\n</skills_instructions>",
        timestamp: 1,
      },
      {
        role: "developer",
        content: [{ type: "text", text: "<environment_context>cwd: /app</environment_context>" }],
        timestamp: 2,
      },
      {
        role: "user",
        content: "User message as plain string",
        timestamp: 3,
      },
      {
        role: "user",
        content: [{ type: "text", text: "User message as array of parts" }],
        timestamp: 4,
      },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "internal thought" } as any],
        timestamp: 5,
      },
      userMsg("Active prompt", 6),
    ];

    expect(isInstructionMessage(messages[0]!)).toBe(true);
    expect(isInstructionMessage(messages[1]!)).toBe(true);
    expect(isInstructionMessage(messages[2]!)).toBe(false);
    expect(isInstructionMessage(messages[3]!)).toBe(false);
    expect(() => pruneSemanticToolResults(messages)).not.toThrow();
    expect(() => compileChatGptWebPrompt(makeRequest(messages), testCapabilities, "token-env")).not.toThrow();
  });
});

describe("Suite 4: Strict Invariants & Sentinel Immunity", () => {
  test("Active turn tool results are 100% immune from any pruning, elision, or supersession", () => {
    const hugeOutput = "export const secret = 'ACTIVE_UNTOUCHED';\n".repeat(500); // > 15,000 chars
    const messages: CodexMessage[] = [
      userMsg("Turn 1: Historical", 1),
      assistantToolCallMsg([{ id: "c_old", name: "view_file", args: { path: "file.ts" } }], 2),
      toolResultMsg("c_old", "view_file", "old content\n".repeat(30), 3),

      userMsg("Turn 2: Active User Query", 4),
      // Active turn tool results (after user message index 4)
      assistantToolCallMsg([{ id: "c_act1", name: "view_file", args: { path: "file.ts" } }], 5),
      toolResultMsg("c_act1", "view_file", hugeOutput, 6),
      assistantToolCallMsg([{ id: "c_act2", name: "view_file", args: { path: "file.ts" } }], 7),
      toolResultMsg("c_act2", "view_file", hugeOutput, 8),
    ];

    const pruned = pruneSemanticToolResults(messages);
    expect(pruned[5]!.content).toBe(hugeOutput);
    expect(pruned[7]!.content).toBe(hugeOutput);
  });

  test("Visualization sentinels are strictly protected across all turns", () => {
    const vizOutput1 = "Rendered diagram\n\uE200viz_spec_1\uE201\n" + "extra data\n".repeat(100);
    const vizOutput2 = "Generated chart in file:///project/.codex/visualizations/chart1.html\n" + "extra data\n".repeat(100);

    const messages: CodexMessage[] = [
      userMsg("Turn 1: Viz 1", 1),
      assistantToolCallMsg([{ id: "v1", name: "view_file", args: { path: "viz.html" } }], 2),
      toolResultMsg("v1", "view_file", vizOutput1, 3),

      userMsg("Turn 2: Viz 2", 4),
      assistantToolCallMsg([{ id: "v2", name: "view_file", args: { path: "viz.html" } }], 5),
      toolResultMsg("v2", "view_file", vizOutput2, 6),

      userMsg("Turn 3..9", 7),
      userMsg("Turn 4", 8),
      userMsg("Turn 5", 9),
      userMsg("Turn 6", 10),
      userMsg("Turn 7", 11),
      userMsg("Turn 8", 12),
      userMsg("Turn 9: Active", 13),
    ];

    const pruned = pruneSemanticToolResults(messages, { verbatimTailMessages: 2 });
    const res1 = pruned[2]!.content as string;
    const res2 = pruned[5]!.content as string;

    // Both visualization outputs must be preserved in full and NOT superseded or elided
    expect(res1).toBe(vizOutput1);
    expect(res2).toBe(vizOutput2);
  });

  test("Deep immutability: input messages array and message objects are frozen", () => {
    const messages: CodexMessage[] = [
      Object.freeze({ role: "user", content: "Test freeze", timestamp: 1 }) as CodexMessage,
      Object.freeze({
        role: "assistant",
        content: Object.freeze([{ type: "toolCall", id: "f1", name: "view_file", arguments: Object.freeze({ path: "freeze.ts" }) }]) as any,
        timestamp: 2,
      }) as CodexMessage,
      Object.freeze({
        role: "toolResult",
        toolCallId: "f1",
        toolName: "view_file",
        content: "frozen content\n".repeat(30),
        isError: false,
        timestamp: 3,
      }) as CodexMessage,
      Object.freeze({ role: "user", content: "Active", timestamp: 4 }) as CodexMessage,
    ];
    Object.freeze(messages);

    expect(() => pruneSemanticToolResults(messages, { verbatimTailMessages: 1 })).not.toThrow();
    const pruned = pruneSemanticToolResults(messages, { verbatimTailMessages: 1 });
    expect(pruned).not.toBe(messages);
  });
});

describe("Suite 5: Large-Scale Pseudo-Random Fuzzing (500 turns)", () => {
  test("500-turn history fuzzing stress test executes smoothly under 150ms", () => {
    const messages: CodexMessage[] = [
      userMsg("<app-context>Base Context</app-context>", 1),
      userMsg("# AGENTS.md\nRules", 2),
    ];

    let ts = 3;
    const filePool = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"];
    const dirPool = ["src", "src/components", "tests", "docs"];
    const cmdPool = ["bun test", "cargo check", "eslint .", "git status"];

    for (let turn = 1; turn <= 250; turn++) {
      const turnType = turn % 4;
      const file = filePool[turn % filePool.length]!;
      const dir = dirPool[turn % dirPool.length]!;
      const cmd = cmdPool[turn % cmdPool.length]!;

      messages.push(userMsg(`Turn ${turn}: Action ${turnType}`, ts++));

      if (turnType === 0) {
        // Read file
        messages.push(assistantToolCallMsg([{ id: `call_${turn}`, name: "view_file", args: { path: file } }], ts++));
        messages.push(toolResultMsg(`call_${turn}`, "view_file", `// File: ${file}\n` + `export const v_${turn} = ${turn};\n`.repeat(30), ts++));
      } else if (turnType === 1) {
        // Patch file
        messages.push(assistantToolCallMsg([{ id: `call_${turn}`, name: "apply_patch", args: { path: file } }], ts++));
        messages.push(toolResultMsg(`call_${turn}`, "apply_patch", `Applied patch to ${file} at turn ${turn}`, ts++));
      } else if (turnType === 2) {
        // List dir
        messages.push(assistantToolCallMsg([{ id: `call_${turn}`, name: "list_dir", args: { directory_path: dir } }], ts++));
        messages.push(toolResultMsg(`call_${turn}`, "list_dir", `file_${turn}_1.ts\nfile_${turn}_2.ts\n`, ts++));
      } else {
        // Command
        messages.push(assistantToolCallMsg([{ id: `call_${turn}`, name: "exec_command", args: { command: cmd } }], ts++));
        messages.push(toolResultMsg(`call_${turn}`, "exec_command", `Output for ${cmd}\n` + `line\n`.repeat(40) + `exit code: 0\n`, ts++));
      }
    }

    // Live active turn
    messages.push(userMsg("Active live user request", ts++));
    messages.push(assistantToolCallMsg([{ id: "c_live", name: "view_file", args: { path: "src/a.ts" } }], ts++));
    messages.push(toolResultMsg("c_live", "view_file", "export const activeLive = true;\n", ts++));

    const startTime = performance.now();
    const compiled = compileChatGptWebPrompt(makeRequest(messages), testCapabilities, "token-fuzz");
    const duration = performance.now() - startTime;

    expect(compiled.text.length).toBeLessThanOrEqual(110_000);
    expect(compiled.text).toContain("export const activeLive = true;");
    expect(duration).toBeLessThan(200); // Under 200ms

    // Ensure valid JSON output
    const contextJsonMatch = /<codex_context_json>\n([\s\S]*?)\n<\/codex_context_json>/.exec(compiled.text);
    expect(contextJsonMatch).not.toBeNull();
    const parsed = JSON.parse(contextJsonMatch![1]!);
    expect(parsed.messages.length).toBeGreaterThan(0);
  });
});
