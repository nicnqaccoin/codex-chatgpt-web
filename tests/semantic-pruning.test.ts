import { expect, test } from "bun:test";
import {
  CHATGPT_MAX_SINGLE_TOOL_RESULT_CHARS,
  pruneSemanticToolResults,
  compactToolResultsToReceipts,
  getLatestUserIndex,
  isInstructionMessage,
  type SemanticPruneOptions,
} from "../src/adapters/chatgpt-web/prune";
import {
  compileChatGptWebPrompt,
  CHATGPT_VERBATIM_TOOL_RESULT_MESSAGES,
} from "../src/adapters/chatgpt-web/prompt";
import { requiredVisualizationReference } from "../src/adapters/chatgpt-web/final-artifacts";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import type { ChatGptWebCapabilities } from "../src/adapters/chatgpt-web/model";
import type { CodexMessage, CodexParsedRequest, CodexToolResultMessage } from "../src/types";

const plusCapabilities: ChatGptWebCapabilities = {
  localToolsEnabled: true,
  solAvailable: true,
  proAvailable: false,
};

function userMessage(content: string, timestamp: number): CodexMessage {
  return { role: "user", content, timestamp };
}

function assistantToolCallMessage(
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
  timestamp: number,
): CodexMessage {
  return {
    role: "assistant",
    content: toolCalls.map(tc => ({
      type: "toolCall",
      id: tc.id,
      name: tc.name,
      arguments: tc.args,
    })),
    timestamp,
  };
}

function toolResultMessage(
  toolCallId: string,
  toolName: string,
  content: string,
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

function request(messages: CodexMessage[]): CodexParsedRequest {
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    context: { messages, systemPrompt: [] },
    stream: true,
    options: { reasoning: "high" },
  } as unknown as CodexParsedRequest;
}

test("file read deduplication supersedes earlier reads when the same file is re-read in later turn", () => {
  const fileContent = "const x = 1;\n".repeat(50);
  const messages: CodexMessage[] = [
    userMessage("Please read src/index.ts", 1),
    assistantToolCallMessage([{ id: "call_read_1", name: "view_file", args: { path: "src/index.ts" } }], 2),
    toolResultMessage("call_read_1", "view_file", fileContent, 3),
    userMessage("Now let's check it again after thought", 4),
    assistantToolCallMessage([{ id: "call_read_2", name: "view_file", args: { path: "src/index.ts" } }], 5),
    toolResultMessage("call_read_2", "view_file", fileContent + "// updated\n", 6),
    userMessage("What next?", 7),
  ];

  const pruned = pruneSemanticToolResults(messages, { verbatimTailMessages: 2 });
  const olderResult = pruned[2]!.content as string;
  const newerResult = pruned[5]!.content as string;

  expect(olderResult).toContain("Earlier file content of 'src/index.ts'");
  expect(olderResult).toContain("lines");
  expect(olderResult).toContain("superseded by subsequent read/modification");
  expect(newerResult).toContain("// updated");
});

test("file read deduplication supersedes earlier reads when file is modified by apply_patch", () => {
  const fileContent = "function hello() { return 'world'; }\n".repeat(30);
  const messages: CodexMessage[] = [
    userMessage("Read and update src/hello.ts", 1),
    assistantToolCallMessage([{ id: "call_read_1", name: "view_file", args: { path: "src/hello.ts" } }], 2),
    toolResultMessage("call_read_1", "view_file", fileContent, 3),
    userMessage("Apply the edit now", 4),
    assistantToolCallMessage([{ id: "call_patch_1", name: "apply_patch", args: { path: "src/hello.ts" } }], 5),
    toolResultMessage("call_patch_1", "apply_patch", "Applied patch to src/hello.ts successfully", 6),
    userMessage("What is status?", 7),
  ];

  const pruned = pruneSemanticToolResults(messages, { verbatimTailMessages: 2 });
  const olderResult = pruned[2]!.content as string;
  const patchResult = pruned[5]!.content as string;

  expect(olderResult).toContain("Earlier file content of 'src/hello.ts'");
  expect(olderResult).toContain("superseded by subsequent read/modification");
  expect(patchResult).toBe("Applied patch to src/hello.ts successfully");
});

test("directory listing supersession replaces older duplicate listings with count stubs", () => {
  const dirListing1 = "file1.ts\nfile2.ts\nfile3.ts\nfile4.ts\nfile5.ts\n";
  const dirListing2 = "file1.ts\nfile2.ts\nfile3.ts\nfile4.ts\nfile5.ts\nfile6.ts\n";

  const messages: CodexMessage[] = [
    userMessage("List directory contents", 1),
    assistantToolCallMessage([{ id: "call_dir_1", name: "list_dir", args: { directory_path: "src/adapters" } }], 2),
    toolResultMessage("call_dir_1", "list_dir", dirListing1, 3),
    userMessage("Now list again to see if file was added", 4),
    assistantToolCallMessage([{ id: "call_dir_2", name: "list_dir", args: { directory_path: "src/adapters" } }], 5),
    toolResultMessage("call_dir_2", "list_dir", dirListing2, 6),
    userMessage("Next step", 7),
  ];

  const pruned = pruneSemanticToolResults(messages, { verbatimTailMessages: 2 });
  const olderResult = pruned[2]!.content as string;
  const newerResult = pruned[5]!.content as string;

  expect(olderResult).toContain("Earlier directory listing of 'src/adapters'");
  expect(olderResult).toContain("items");
  expect(olderResult).toContain("superseded by turn");
  expect(newerResult).toBe(dirListing2);
});

test("re-executed command output is replaced with a concise supersession receipt", () => {
  const longFailureOutput = "Error: Test failed\n" + "  at Stack trace line...\n".repeat(100);
  const successOutput = "All 42 tests passed!\n";

  const messages: CodexMessage[] = [
    userMessage("Run test suite", 1),
    assistantToolCallMessage([{ id: "call_cmd_1", name: "exec_command", args: { command: "bun test" } }], 2),
    toolResultMessage("call_cmd_1", "exec_command", longFailureOutput, 3, true),
    userMessage("Fix the bug and rerun", 4),
    assistantToolCallMessage([{ id: "call_cmd_2", name: "exec_command", args: { command: "bun test" } }], 5),
    toolResultMessage("call_cmd_2", "exec_command", successOutput, 6, false),
    userMessage("What are the results?", 7),
  ];

  const pruned = pruneSemanticToolResults(messages, { verbatimTailMessages: 2 });
  const olderResult = pruned[2]!.content as string;
  const newerResult = pruned[5]!.content as string;

  expect(olderResult).toContain("Command `bun test` output superseded by subsequent execution; Exit code: 1");
  expect(newerResult).toBe(successOutput);
});

test("large non-re-executed command output is compacted while preserving exit code and summary", () => {
  const hugeSuccessLog = "Starting build process...\n" + "Compiling module...\n".repeat(300) + "Build complete with 0 errors.\n";

  const messages: CodexMessage[] = [
    userMessage("Build the package", 1),
    assistantToolCallMessage([{ id: "call_cmd_1", name: "exec_command", args: { command: "npm run build" } }], 2),
    toolResultMessage("call_cmd_1", "exec_command", hugeSuccessLog, 3, false),
    userMessage("Turn 2", 4),
    userMessage("Turn 3", 5),
    userMessage("Turn 4", 6),
    userMessage("Turn 5", 7),
    userMessage("Turn 6", 8),
    userMessage("Turn 7 (latest)", 9),
  ];

  const pruned = pruneSemanticToolResults(messages, { verbatimTailMessages: 2, maxCommandOutputChars: 500 });
  const compacted = pruned[2]!.content as string;

  expect(compacted.length).toBeLessThan(hugeSuccessLog.length);
  expect(compacted).toContain("Starting build process");
  expect(compacted).toContain("characters elided from completed command output");
  expect(compacted).toContain("Build complete with 0 errors");
});

test("active turn tool results after latest user index are never modified", () => {
  const fileContent = "line of code\n".repeat(50);
  const messages: CodexMessage[] = [
    userMessage("Initial user turn", 1),
    toolResultMessage("call_old", "view_file", fileContent, 2),
    userMessage("Active live turn", 3),
    // All tool results below are in the active turn
    toolResultMessage("call_active_1", "view_file", fileContent, 4),
    toolResultMessage("call_active_2", "view_file", fileContent, 5),
  ];

  const pruned = pruneSemanticToolResults(messages, { verbatimTailMessages: 0 });
  // Tool result in active turn must remain verbatim even if re-reading same file
  expect(pruned[3]!.content).toBe(fileContent);
  expect(pruned[4]!.content).toBe(fileContent);
});

test("visualization sentinels are strictly preserved and never damaged", () => {
  const vizSentinel = '\uE200visualize\uE202{"path":"C:/project/.codex/visualizations/demo.html"}\uE201';
  const messages: CodexMessage[] = [
    userMessage("Show visualization", 1),
    toolResultMessage("call_viz_1", "exec_command", `Created ${vizSentinel}\nOutput: done`, 2),
    userMessage("Follow up", 3),
    userMessage("Turn 3", 4),
    userMessage("Turn 4", 5),
    userMessage("Turn 5", 6),
    userMessage("Turn 6", 7),
    userMessage("Turn 7", 8),
    userMessage("Turn 8", 9),
  ];

  const pruned = pruneSemanticToolResults(messages, { verbatimTailMessages: 2 });
  const vizResult = pruned[1]!.content as string;

  expect(vizResult).toContain(vizSentinel);
  expect(vizResult).toContain("\uE200");
  expect(vizResult).toContain("\uE201");
});

test("requiredVisualizationReference functions correctly with pruned tool results in active turn", () => {
  const htmlPath = "C:/app/.codex/visualizations/chart.html";
  const messages: CodexMessage[] = [
    userMessage("Create visualization plugin://visualize@openai-bundled", 1),
    assistantToolCallMessage([{ id: "call_patch", name: "apply_patch", args: { path: htmlPath } }], 2),
    toolResultMessage("call_patch", "apply_patch", `A ${htmlPath}\nUpdated 1 file.`, 3),
  ];

  const req = request(messages);
  const ref = requiredVisualizationReference(req);
  expect(ref).toBe(`\uE200visualize\uE202{"path":"${htmlPath}"}\uE201`);
});

test("immutability: input messages array and message objects are not mutated in place", () => {
  const fileContent = "const foo = 'bar';\n".repeat(40);
  const msg1 = userMessage("Read file", 1);
  const msg2 = assistantToolCallMessage([{ id: "c1", name: "view_file", args: { path: "foo.ts" } }], 2);
  const msg3 = toolResultMessage("c1", "view_file", fileContent, 3);
  const msg4 = userMessage("Read again", 4);
  const msg5 = assistantToolCallMessage([{ id: "c2", name: "view_file", args: { path: "foo.ts" } }], 5);
  const msg6 = toolResultMessage("c2", "view_file", fileContent, 6);
  const msg7 = userMessage("Next", 7);

  const input = [msg1, msg2, msg3, msg4, msg5, msg6, msg7];
  const inputCopy = [...input];

  const output = pruneSemanticToolResults(input, { verbatimTailMessages: 2 });

  // Input array was not mutated
  expect(input).toEqual(inputCopy);
  // Input message 3 was not mutated in place
  expect(msg3.content).toBe(fileContent);
  // Output is a distinct message object
  expect(output[2]).not.toBe(msg3);
  // Message metadata is strictly preserved
  const toolMsg = output[2] as CodexToolResultMessage;
  expect(toolMsg.role).toBe("toolResult");
  expect(toolMsg.toolCallId).toBe("c1");
  expect(toolMsg.toolName).toBe("view_file");
  expect(toolMsg.isError).toBe(false);
});

test("prompt compilation fits within 110,000 char budget with semantic pruning on multi-turn load", () => {
  const largeFile = "export class BigDataService {\n" + "  public processChunk(): void {}\n".repeat(150) + "}\n";
  const messages: CodexMessage[] = [
    userMessage("<app-context>\n# Codex desktop context\n### Images/Visuals/Files\nRules.\n</app-context>", 1),
    userMessage("# AGENTS.md instructions\nGlobal rules.\n<environment_context><cwd>/w</cwd></environment_context>", 2),
    userMessage("Task 1: Read big file", 3),
    assistantToolCallMessage([{ id: "c1", name: "view_file", args: { path: "src/big.ts" } }], 4),
    toolResultMessage("c1", "view_file", largeFile, 5),
    userMessage("Task 2: Read big file again", 6),
    assistantToolCallMessage([{ id: "c2", name: "view_file", args: { path: "src/big.ts" } }], 7),
    toolResultMessage("c2", "view_file", largeFile, 8),
    userMessage("Task 3: Read big file third time", 9),
    assistantToolCallMessage([{ id: "c3", name: "view_file", args: { path: "src/big.ts" } }], 10),
    toolResultMessage("c3", "view_file", largeFile, 11),
    userMessage("Task 4: Run tests", 12),
    assistantToolCallMessage([{ id: "c4", name: "exec_command", args: { command: "bun test" } }], 13),
    toolResultMessage("c4", "exec_command", "FAIL tests\n" + "stack trace line\n".repeat(100), 14, true),
    userMessage("Task 5: Rerun tests", 15),
    assistantToolCallMessage([{ id: "c5", name: "exec_command", args: { command: "bun test" } }], 16),
    toolResultMessage("c5", "exec_command", "354 passed\n", 17, false),
    userMessage("Task 6: Check status", 18),
    userMessage("Task 7: Check logs", 19),
    userMessage("Task 8: Final check", 20),
  ];

  const compiled = compileChatGptWebPrompt(request(messages), plusCapabilities, "turn-token-123");

  expect(compiled.text.length).toBeLessThanOrEqual(110_000);
  expect(compiled.text).toContain("### Images/Visuals/Files");
  expect(compiled.text).toContain("# AGENTS.md instructions");
  expect(compiled.text).toContain("Earlier file content of 'src/big.ts'");
  expect(compiled.text).toContain("Command `bun test` output superseded");
});

test("compactToolResultsToReceipts converts remaining older bulky results to 1-line receipts", () => {
  const hugeContent = "x".repeat(10_000);
  const messages: CodexMessage[] = [
    userMessage("Perform search", 1),
    toolResultMessage("call_search", "custom_mcp_search", hugeContent, 2),
    userMessage("Turn 2", 3),
    userMessage("Turn 3", 4),
    userMessage("Turn 4", 5),
    userMessage("Turn 5", 6),
    userMessage("Turn 6", 7),
    userMessage("Turn 7", 8),
    userMessage("Turn 8", 9),
  ];

  const compacted = compactToolResultsToReceipts(messages, 2);
  const resultText = compacted[1]!.content as string;

  expect(resultText).toContain("[Tool 'custom_mcp_search' completed with 10,000 chars of output]");
  expect(resultText.length).toBeLessThan(100);
});

// A live session held a 138,893 character tool result. Left verbatim in the recent window it could
// not fit any composer ceiling on its own, so fit recovery discarded the conversation around it and
// the model received a single message.
test("an oversized recent tool result is cut down instead of starving the conversation", () => {
  const monster = "y".repeat(140_000);
  const messages: CodexMessage[] = [
    userMessage("Run the build", 1),
    assistantToolCallMessage([{ id: "c1", name: "exec_command", args: { command: "bun run build" } }], 2),
    toolResultMessage("c1", "exec_command", monster, 3),
    userMessage("What failed?", 4),
  ];

  const compacted = compactToolResultsToReceipts(messages);
  const resultText = compacted[2]!.content as string;

  // Inside the verbatim window, so it keeps head and tail rather than collapsing to a receipt.
  expect(resultText).not.toContain("completed with");
  expect(resultText).toContain("characters elided");
  expect(resultText.startsWith("yyy")).toBe(true);
  expect(resultText.endsWith("yyy")).toBe(true);
  expect(resultText.length).toBeLessThan(CHATGPT_MAX_SINGLE_TOOL_RESULT_CHARS);
});

test("a recent tool result under the single-result ceiling is left verbatim", () => {
  const sizeable = "z".repeat(CHATGPT_MAX_SINGLE_TOOL_RESULT_CHARS - 1);
  const messages: CodexMessage[] = [
    userMessage("Run the build", 1),
    assistantToolCallMessage([{ id: "c1", name: "exec_command", args: { command: "bun run build" } }], 2),
    toolResultMessage("c1", "exec_command", sizeable, 3),
    userMessage("What failed?", 4),
  ];

  expect(compactToolResultsToReceipts(messages)[2]!.content).toBe(sizeable);
});

test("path normalization handles Windows backslashes and case-insensitivity correctly", () => {
  const fileContent = "export const config = { enabled: true };\n".repeat(40);
  const messages: CodexMessage[] = [
    userMessage("Read config with Windows path", 1),
    assistantToolCallMessage([{ id: "c1", name: "view_file", args: { path: "src\\config\\App.ts" } }], 2),
    toolResultMessage("c1", "view_file", fileContent, 3),
    userMessage("Now read config with POSIX path and lowercase", 4),
    assistantToolCallMessage([{ id: "c2", name: "view_file", args: { path: "src/config/app.ts" } }], 5),
    toolResultMessage("c2", "view_file", fileContent + "// extra", 6),
    userMessage("Done", 7),
  ];

  const pruned = pruneSemanticToolResults(messages, { verbatimTailMessages: 2 });
  const olderResult = pruned[2]!.content as string;

  expect(olderResult).toContain("Earlier file content of 'src/config/App.ts'");
  expect(olderResult).toContain("superseded by subsequent read/modification");
});

test("handles tool result content formatted as CodexContentPart array", () => {
  const fileContent = "console.log('hello');\n".repeat(30);
  const messages: CodexMessage[] = [
    userMessage("Read script", 1),
    assistantToolCallMessage([{ id: "c1", name: "view_file", args: { path: "script.js" } }], 2),
    {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "view_file",
      content: [{ type: "text", text: fileContent }],
      isError: false,
      timestamp: 3,
    },
    userMessage("Read again", 4),
    assistantToolCallMessage([{ id: "c2", name: "view_file", args: { path: "script.js" } }], 5),
    {
      role: "toolResult",
      toolCallId: "c2",
      toolName: "view_file",
      content: [{ type: "text", text: fileContent + "// modified" }],
      isError: false,
      timestamp: 6,
    },
    userMessage("Finished", 7),
  ];

  const pruned = pruneSemanticToolResults(messages, { verbatimTailMessages: 2 });
  const olderPart = pruned[2]!.content;
  expect(Array.isArray(olderPart)).toBe(true);
  if (Array.isArray(olderPart)) {
    expect((olderPart[0] as { text: string }).text).toContain("Earlier file content of 'script.js'");
  }
});

test("distinct files are preserved and not accidentally superseded", () => {
  const contentA = "const a = 1;\n".repeat(30);
  const contentB = "const b = 2;\n".repeat(30);
  const messages: CodexMessage[] = [
    userMessage("Read A", 1),
    assistantToolCallMessage([{ id: "c1", name: "view_file", args: { path: "src/a.ts" } }], 2),
    toolResultMessage("c1", "view_file", contentA, 3),
    userMessage("Read B", 4),
    assistantToolCallMessage([{ id: "c2", name: "view_file", args: { path: "src/b.ts" } }], 5),
    toolResultMessage("c2", "view_file", contentB, 6),
    userMessage("Done", 7),
  ];

  const pruned = pruneSemanticToolResults(messages, { verbatimTailMessages: 2 });
  // Neither A nor B was re-read or modified, so both remain intact
  expect(pruned[2]!.content).toBe(contentA);
  expect(pruned[5]!.content).toBe(contentB);
});

test("find_by_name supersession tracks pattern and directory", () => {
  const match1 = "src/a.ts\nsrc/b.ts\n";
  const match2 = "src/a.ts\nsrc/b.ts\nsrc/c.ts\n";
  const messages: CodexMessage[] = [
    userMessage("Find ts files in src", 1),
    assistantToolCallMessage([{ id: "c1", name: "find_by_name", args: { SearchDirectory: "src", Pattern: "*.ts" } }], 2),
    toolResultMessage("c1", "find_by_name", match1, 3),
    userMessage("Find again later", 4),
    assistantToolCallMessage([{ id: "c2", name: "find_by_name", args: { SearchDirectory: "src", Pattern: "*.ts" } }], 5),
    toolResultMessage("c2", "find_by_name", match2, 6),
    userMessage("End", 7),
  ];

  const pruned = pruneSemanticToolResults(messages, { verbatimTailMessages: 2 });
  const olderResult = pruned[2]!.content as string;

  expect(olderResult).toContain("Earlier directory listing of 'src'");
  expect(olderResult).toContain("superseded by turn");
});

test("handles empty and edge case inputs safely", () => {
  expect(pruneSemanticToolResults([])).toEqual([]);
  expect(getLatestUserIndex([])).toBe(-1);

  const onlyInstructions: CodexMessage[] = [
    userMessage("<app-context>\nDesktop\n</app-context>", 1),
    userMessage("# AGENTS.md\nInstructions\n", 2),
  ];
  expect(getLatestUserIndex(onlyInstructions)).toBe(1);
  expect(isInstructionMessage(onlyInstructions[0]!)).toBe(true);
});
