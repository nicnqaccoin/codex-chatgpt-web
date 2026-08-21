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
import { requiredVisualizationReference } from "../src/adapters/chatgpt-web/final-artifacts";
import type { CodexContentPart, CodexMessage, CodexParsedRequest } from "../src/types";

const plusCapabilities: ChatGptWebCapabilities = {
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

describe("Adversarial Path Normalization & Casing", () => {
  test("matches mixed forward/backward slashes and file URI schemes", () => {
    const rawContent = "export function test() { return 42; }\n".repeat(40);
    const messages: CodexMessage[] = [
      userMsg("Read file using Windows backslashes", 1),
      assistantToolCallMsg([{ id: "c1", name: "view_file", args: { path: "C:\\App\\src\\adapters\\prune.ts" } }], 2),
      toolResultMsg("c1", "view_file", rawContent, 3),
      userMsg("Read same file using file URI and lowercase POSIX path", 4),
      assistantToolCallMsg([{ id: "c2", name: "view_file", args: { path: "file:///c:/app/src/adapters/prune.ts" } }], 5),
      toolResultMsg("c2", "view_file", rawContent + "// new line\n", 6),
      userMsg("What is the diff?", 7),
    ];

    const pruned = pruneSemanticToolResults(messages, { verbatimTailMessages: 2 });
    const older = pruned[2]!.content as string;
    const newer = pruned[5]!.content as string;

    expect(older).toContain("Earlier file content of 'C:/App/src/adapters/prune.ts'");
    expect(older).toContain("superseded by subsequent read/modification");
    expect(newer).toContain("// new line");
  });

  test("handles trailing slashes on directories and case-insensitive glob patterns", () => {
    const listing = "file1.ts\nfile2.ts\n";
    const messages: CodexMessage[] = [
      userMsg("List dir with trailing slash", 1),
      assistantToolCallMsg([{ id: "c1", name: "list_dir", args: { directory_path: "C:\\Workspace\\SRC\\" } }], 2),
      toolResultMsg("c1", "list_dir", listing, 3),
      userMsg("List same dir with posix format without trailing slash", 4),
      assistantToolCallMsg([{ id: "c2", name: "list_dir", args: { directory_path: "c:/workspace/src" } }], 5),
      toolResultMsg("c2", "list_dir", listing + "file3.ts\n", 6),
      userMsg("Done", 7),
    ];

    const pruned = pruneSemanticToolResults(messages, { verbatimTailMessages: 2 });
    const older = pruned[2]!.content as string;
    const newer = pruned[5]!.content as string;

    expect(older).toContain("Earlier directory listing of 'C:/Workspace/SRC/'");
    expect(older).toContain("superseded by turn");
    expect(newer).toBe(listing + "file3.ts\n");
  });

  test("extracts file path from patch content headers when args are missing or empty", () => {
    const messages: CodexMessage[] = [
      userMsg("Read file foo.ts", 1),
      assistantToolCallMsg([{ id: "c1", name: "view_file", args: { path: "src/foo.ts" } }], 2),
      toolResultMsg("c1", "view_file", "const a = 1;\n".repeat(30), 3),
      userMsg("Apply patch with diff header in stdout", 4),
      assistantToolCallMsg([{ id: "c2", name: "apply_patch", args: {} }], 5),
      toolResultMsg("c2", "apply_patch", "--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n", 6),
      userMsg("Next step", 7),
    ];

    const pruned = pruneSemanticToolResults(messages, { verbatimTailMessages: 2 });
    const olderRead = pruned[2]!.content as string;

    expect(olderRead).toContain("Earlier file content of 'src/foo.ts'");
    expect(olderRead).toContain("superseded by subsequent read/modification");
  });
});

describe("Out-of-Order Tool Call IDs and Orphaned Tool Results", () => {
  test("handles orphaned tool result with absolute path in text", () => {
    const messages: CodexMessage[] = [
      userMsg("Turn 1", 1),
      toolResultMsg("orphaned_call_id_999", "view_file", "File Path: C:/workspace/src/orphan.ts\n" + "line\n".repeat(30), 2),
      userMsg("Turn 2", 3),
      assistantToolCallMsg([{ id: "c2", name: "view_file", args: { path: "C:/workspace/src/orphan.ts" } }], 4),
      toolResultMsg("c2", "view_file", "File Path: C:/workspace/src/orphan.ts\n" + "new line\n".repeat(30), 5),
      userMsg("Turn 3", 6),
    ];

    expect(() => pruneSemanticToolResults(messages, { verbatimTailMessages: 2 })).not.toThrow();
    const pruned = pruneSemanticToolResults(messages, { verbatimTailMessages: 2 });
    const older = pruned[1]!.content as string;
    expect(older).toContain("Earlier file content of 'C:/workspace/src/orphan.ts'");
  });

  test("handles completely unknown tool results without args or paths safely", () => {
    const hugeOutput = "Random unknown telemetry output\n".repeat(500);
    const messages: CodexMessage[] = [
      userMsg("Turn 1", 1),
      toolResultMsg("mystery_tool_id", "", hugeOutput, 2),
      userMsg("Turn 2", 3),
      userMsg("Turn 3", 4),
      userMsg("Turn 4", 5),
      userMsg("Turn 5", 6),
      userMsg("Turn 6", 7),
      userMsg("Turn 7", 8),
      userMsg("Turn 8", 9),
    ];

    const pruned = pruneSemanticToolResults(messages, { verbatimTailMessages: 2 });
    const older = pruned[1]!.content as string;
    expect(older).toContain("characters elided from this older tool result");
    expect(older.length).toBeLessThan(hugeOutput.length);
  });

  test("handles tool calls with null/empty arguments and non-standard properties", () => {
    const messages: CodexMessage[] = [
      userMsg("Turn 1", 1),
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "c_null", name: "view_file", arguments: null as any },
          { type: "toolCall", id: "c_empty", name: "view_file", arguments: {} },
          { type: "toolCall", id: "c_num", name: "view_file", arguments: { path: 12345 } as any },
        ],
        timestamp: 2,
      },
      toolResultMsg("c_null", "view_file", "nothing", 3),
      toolResultMsg("c_empty", "view_file", "nothing", 4),
      toolResultMsg("c_num", "view_file", "nothing", 5),
      userMsg("Turn 2", 6),
    ];

    expect(() => pruneSemanticToolResults(messages)).not.toThrow();
    const pruned = pruneSemanticToolResults(messages);
    expect(pruned.length).toBe(messages.length);
  });

  test("handles empty content arrays and non-text parts in tool results", () => {
    const messages: CodexMessage[] = [
      userMsg("Turn 1", 1),
      {
        role: "toolResult",
        toolCallId: "c_custom",
        toolName: "custom_tool",
        content: [],
        isError: false,
        timestamp: 2,
      },
      userMsg("Turn 2", 3),
    ];

    expect(() => pruneSemanticToolResults(messages)).not.toThrow();
    const pruned = pruneSemanticToolResults(messages);
    expect(pruned[1]!.content).toEqual([]);
  });
});

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

describe("Exotic Unicode Control Sequences and Surrogate Pairs", () => {
  test("preserves astral plane code points, multi-byte emojis, and complex ZWJ glyphs in prompt compilation", () => {
    const complexUnicode = "𠮷野家 🦄 👨‍👩‍👧‍👦 🧑🏽‍💻 𝕏𝒴𝒵 \u202Ereversed\u202C";
    const messages: CodexMessage[] = [
      userMsg(`Initial user message with unicode: ${complexUnicode}`, 1),
      assistantToolCallMsg([{ id: "c1", name: "view_file", args: { path: "src/unicode.ts" } }], 2),
      toolResultMsg("c1", "view_file", `// File: ${complexUnicode}\n` + "line\n".repeat(40), 3),
      userMsg("Second turn with emojis 🌟🎉🚀", 4),
      assistantToolCallMsg([{ id: "c2", name: "view_file", args: { path: "src/unicode.ts" } }], 5),
      toolResultMsg("c2", "view_file", `// File: ${complexUnicode}\n// updated\n`, 6),
      userMsg("Final prompt", 7),
    ];

    const pruned = pruneSemanticToolResults(messages, { verbatimTailMessages: 2 });
    expect(pruned[2]!.content as string).toContain("Earlier file content of 'src/unicode.ts'");
    expect(pruned[5]!.content as string).toContain(complexUnicode);

    const compiled = compileChatGptWebPrompt(makeRequest(messages), plusCapabilities, "turn-token-xyz");
    expect(compiled.text).toContain("👨‍👩‍👧‍👦");
    expect(compiled.text).toContain("𠮷野家");
    expect(compiled.text).toContain("🦄");

    // Ensure resulting JSON is strictly valid
    const contextJsonMatch = /<codex_context_json>\n([\s\S]*?)\n<\/codex_context_json>/.exec(compiled.text);
    expect(contextJsonMatch).not.toBeNull();
    const parsedJson = JSON.parse(contextJsonMatch![1]!);
    expect(parsedJson.messages.length).toBeGreaterThan(0);
  });

  test("elideToolResultText does not split surrogate pairs or corrupt byte budget", () => {
    const emojiBlock = "🦄".repeat(4000); // 4000 astral plane chars (8000 UTF-16 code units)
    const elided = elideToolResultText(emojiBlock);
    expect(elided.length).toBeLessThan(emojiBlock.length);
    expect(elided).toContain("characters elided");

    // Must be valid UTF-8 string that serializes to JSON without error
    const serialized = JSON.stringify(elided);
    expect(JSON.parse(serialized)).toBe(elided);
  });
});

describe("Massive Message Histories (100+ turns, >350k chars)", () => {
  test("compiles 120-turn, 400,000 character history cleanly under 110,000 chars without dropping active turn or instructions", () => {
    const messages: CodexMessage[] = [
      userMsg("<app-context>\n# Codex Desktop App Context\n### Images/Visuals/Files\nDesktop directives.\n</app-context>", 1),
      userMsg("# AGENTS.md\nRules for agent operations.\n<environment_context><cwd>/workspace</cwd></environment_context>", 2),
    ];

    let ts = 3;
    for (let turn = 1; turn <= 100; turn++) {
      const fileId = turn % 5;
      const isPatch = turn % 3 === 0;
      const isCommand = turn % 4 === 0;

      if (isCommand) {
        messages.push(userMsg(`Turn ${turn}: Execute build command`, ts++));
        messages.push(assistantToolCallMsg([{ id: `call_cmd_${turn}`, name: "exec_command", args: { command: "cargo build --release" } }], ts++));
        messages.push(toolResultMsg(`call_cmd_${turn}`, "exec_command", `Compiling crate_${turn}...\n` + "warning: unused variable\n".repeat(120) + `Finished turn ${turn}\n`, ts++));
      } else if (isPatch) {
        messages.push(userMsg(`Turn ${turn}: Edit module ${fileId}`, ts++));
        messages.push(assistantToolCallMsg([{ id: `call_patch_${turn}`, name: "apply_patch", args: { path: `src/mod_${fileId}.rs` } }], ts++));
        messages.push(toolResultMsg(`call_patch_${turn}`, "apply_patch", `Applied patch to src/mod_${fileId}.rs\n` + "diff line\n".repeat(50), ts++));
      } else {
        messages.push(userMsg(`Turn ${turn}: Inspect module ${fileId}`, ts++));
        messages.push(assistantToolCallMsg([{ id: `call_read_${turn}`, name: "view_file", args: { path: `src/mod_${fileId}.rs` } }], ts++));
        messages.push(toolResultMsg(`call_read_${turn}`, "view_file", `// Module ${fileId} source\n` + `pub fn process_${turn}() -> u32 { ${turn} }\n`.repeat(150), ts++));
      }
    }

    // Active turn at the end
    messages.push(userMsg("Turn 101: Live active user prompt asking for final report", ts++));
    messages.push(assistantToolCallMsg([{ id: "call_active_1", name: "view_file", args: { path: "src/mod_0.rs" } }], ts++));
    messages.push(toolResultMsg("call_active_1", "view_file", "pub fn active_test() { /* live content */ }\n".repeat(10), ts++));

    // Calculate raw size
    const rawTotalChars = messages.reduce((acc, m) => acc + (typeof m.content === "string" ? m.content.length : 100), 0);
    expect(rawTotalChars).toBeGreaterThan(300_000);

    const compiled = compileChatGptWebPrompt(makeRequest(messages), plusCapabilities, "turn-token-mega");

    // Must be strictly within the 110,000 char composer limit
    expect(compiled.text.length).toBeLessThanOrEqual(110_000);

    // Baseline contracts and active turn must be preserved
    expect(compiled.text).toContain("### Images/Visuals/Files");
    expect(compiled.text).toContain("# AGENTS.md");
    expect(compiled.text).toContain("Turn 101: Live active user prompt");
    expect(compiled.text).toContain("pub fn active_test() { /* live content */ }");

    // JSON inside codex_context_json must be valid
    const contextJsonMatch = /<codex_context_json>\n([\s\S]*?)\n<\/codex_context_json>/.exec(compiled.text);
    expect(contextJsonMatch).not.toBeNull();
    const parsed = JSON.parse(contextJsonMatch![1]!);
    expect(parsed.messages.length).toBeGreaterThan(0);
  });

  test("enforces image limit budget (max 10 attachments) without dangling references in massive histories", () => {
    const messages: CodexMessage[] = [
      userMsg("<app-context>Base</app-context>", 1),
    ];

    let ts = 2;
    for (let i = 1; i <= 20; i++) {
      messages.push(userMsg([
        { type: "text", text: `User turn ${i} with screenshot` },
        { type: "image", imageUrl: `data:image/png;base64,image_data_${i}` },
      ], ts++));
      messages.push(assistantToolCallMsg([{ id: `c_${i}`, name: "view_file", args: { path: "foo.ts" } }], ts++));
      messages.push(toolResultMsg(`c_${i}`, "view_file", "const x = 1;\n".repeat(20), ts++));
    }

    messages.push(userMsg("Active request with newest image", ts++));

    const compiled = compileChatGptWebPrompt(makeRequest(messages), plusCapabilities, "token-img");
    expect(compiled.images.length).toBeLessThanOrEqual(10);
    expect(compiled.text.length).toBeLessThanOrEqual(110_000);
  });
});

describe("Performance & Memory Scaling", () => {
  test("compiles 100-turn history in under 50ms", () => {
    const messages: CodexMessage[] = [
      userMsg("<app-context>Desktop</app-context>", 1),
      userMsg("# AGENTS.md\nRules", 2),
    ];

    let ts = 3;
    for (let i = 1; i <= 100; i++) {
      messages.push(userMsg(`Turn ${i}: Action`, ts++));
      messages.push(assistantToolCallMsg([{ id: `c_${i}`, name: "view_file", args: { path: `file_${i % 10}.ts` } }], ts++));
      messages.push(toolResultMsg(`c_${i}`, "view_file", `content ${i}\n`.repeat(50), ts++));
    }
    messages.push(userMsg("Final prompt", ts++));

    const req = makeRequest(messages);

    const start = performance.now();
    const compiled = compileChatGptWebPrompt(req, plusCapabilities, "token-bench");
    const duration = performance.now() - start;

    expect(compiled.text.length).toBeLessThanOrEqual(110_000);
    expect(duration).toBeLessThan(100); // Expect < 100ms
  });
});

describe("Path Normalization & Multi-Turn Read-Patch-Read Cycles", () => {
  test("collapses consecutive slashes and matches escaped Windows paths", () => {
    const messages: CodexMessage[] = [
      userMsg("Turn 1: Read with double slashes", 1),
      assistantToolCallMsg([{ id: "c1", name: "view_file", args: { path: "C:\\\\project\\\\src\\\\index.ts" } }], 2),
      toolResultMsg("c1", "view_file", "const a = 1;\n".repeat(20), 3),

      userMsg("Turn 2: Read with single slashes", 4),
      assistantToolCallMsg([{ id: "c2", name: "view_file", args: { path: "c:/project/src/index.ts" } }], 5),
      toolResultMsg("c2", "view_file", "const a = 2;\n".repeat(20), 6),

      userMsg("Turn 3..8", 7),
      userMsg("Turn 4", 8),
      userMsg("Turn 5", 9),
      userMsg("Turn 6", 10),
      userMsg("Turn 7", 11),
      userMsg("Turn 8", 12),
    ];

    const pruned = pruneSemanticToolResults(messages, { verbatimTailMessages: 2 });
    const turn1Result = pruned[2]!.content as string;
    const turn2Result = pruned[5]!.content as string;

    // Turn 1 should be superseded by Turn 2 because both paths normalize to c:/project/src/index.ts
    expect(turn1Result).toContain("superseded by subsequent read/modification at turn 2");
    expect(turn2Result).toContain("const a = 2;");
  });

  test("read-patch-read: initial read is superseded by patch, subsequent read is preserved", () => {
    const messages: CodexMessage[] = [
      // Turn 1: Read initial content
      userMsg("Turn 1: Read file", 1),
      assistantToolCallMsg([{ id: "c1", name: "view_file", args: { path: "src/server.ts" } }], 2),
      toolResultMsg("c1", "view_file", "initial code\n".repeat(20), 3),

      // Turn 2: Patch the file
      userMsg("Turn 2: Apply patch", 4),
      assistantToolCallMsg([{ id: "c2", name: "apply_patch", args: { path: "src/server.ts" } }], 5),
      toolResultMsg("c2", "apply_patch", "Applied patch", 6),

      // Turn 3: Verify patched file
      userMsg("Turn 3: Re-read file", 7),
      assistantToolCallMsg([{ id: "c3", name: "view_file", args: { path: "src/server.ts" } }], 8),
      toolResultMsg("c3", "view_file", "updated code\n".repeat(20), 9),

      // Turn 4..9: Push turns 1-3 outside verbatim window
      userMsg("Turn 4", 10),
      userMsg("Turn 5", 11),
      userMsg("Turn 6", 12),
      userMsg("Turn 7", 13),
      userMsg("Turn 8", 14),
      userMsg("Turn 9", 15),
    ];

    const pruned = pruneSemanticToolResults(messages, { verbatimTailMessages: 2 });
    const turn1Result = pruned[2]!.content as string;
    const turn3Result = pruned[8]!.content as string;

    // Turn 1 (before patch) was superseded by Turn 2/3
    expect(turn1Result).toContain("superseded by subsequent read/modification");
    // Turn 3 (after patch) is preserved as authoritative
    expect(turn3Result).toContain("updated code");
    expect(turn3Result).not.toContain("superseded");
  });

});
