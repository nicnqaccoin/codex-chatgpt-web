import { expect, test, describe } from "bun:test";
import type {
  CodexAssistantContentPart,
  CodexAssistantMessage,
  CodexContentPart,
  CodexDeveloperMessage,
  CodexMessage,
  CodexParsedRequest,
  CodexToolResultMessage,
  CodexUserMessage,
} from "../src/types";
import {
  pruneSemanticToolResults,
  compactToolResultsToReceipts,
  isInstructionMessage,
  getLatestUserIndex,
  textFromContent,
} from "../src/adapters/chatgpt-web/prune";
import {
  compileChatGptWebPrompt,
  withoutDesktopOnlyReplayBlocks,
  withoutRetiredTurnHandles,
  nextDroppableIndex,
  isInstructionMessage as promptIsInstructionMessage,
} from "../src/adapters/chatgpt-web/prompt";
import {
  requiredVisualizationReference,
  repairMissingFinalArtifactReference,
} from "../src/adapters/chatgpt-web/final-artifacts";
import { CHATGPT_WEB_MODEL_ID, type ChatGptWebCapabilities } from "../src/adapters/chatgpt-web/model";

const MOCK_CAPABILITIES: ChatGptWebCapabilities = {
  localToolsEnabled: true,
  solAvailable: true,
  proAvailable: false,
};

function userMsg(content: string | CodexContentPart[], timestamp = 1): CodexUserMessage {
  return { role: "user", content, timestamp };
}

function devMsg(content: string | CodexContentPart[], timestamp = 1): CodexDeveloperMessage {
  return { role: "developer", content, timestamp };
}

function asstMsg(content: CodexAssistantContentPart[] | string, timestamp = 1): CodexAssistantMessage {
  const parts: CodexAssistantContentPart[] = typeof content === "string"
    ? [{ type: "text", text: content }]
    : content;
  return { role: "assistant", content: parts, timestamp };
}

function toolMsg(
  toolCallId: string,
  toolName: string,
  content: string | CodexContentPart[],
  isError = false,
  timestamp = 1,
): CodexToolResultMessage {
  return { role: "toolResult", toolCallId, toolName, content, isError, timestamp };
}

describe("Adversarial Challenge 1: Visualization Sentinel Immunity", () => {
  test("Sentinel in toolResult is 100% immune from supersession, compaction, and elision in historical turns", () => {
    const sentinelStr = "\uE200visualize\uE202{\"path\":\"C:\\\\Users\\\\dev\\\\.codex\\\\visualizations\\\\dashboard.html\"}\uE201";
    const hugePadding = "x".repeat(10_000);
    const toolContentWithSentinel = `Created visualization artifact successfully:\n${sentinelStr}\n${hugePadding}`;

    // Create a 4-turn conversation where the sentinel is in Turn 1 (far outside verbatim tail of 6)
    const messages: CodexMessage[] = [
      userMsg("Create a visualization", 1),
      asstMsg([{ type: "toolCall", id: "call_viz_1", name: "codex_view_file", arguments: { path: "C:/Users/dev/.codex/visualizations/dashboard.html" } }], 2),
      toolMsg("call_viz_1", "view_file", toolContentWithSentinel, false, 3),
      // Subsequent turns pushing Turn 1 far back in history
      userMsg("Turn 2 request", 4),
      asstMsg([{ type: "toolCall", id: "call_2", name: "view_file", arguments: { path: "C:/Users/dev/.codex/visualizations/dashboard.html" } }], 5),
      toolMsg("call_2", "view_file", "read again", false, 6),
      userMsg("Turn 3 request", 7),
      asstMsg("some answer", 8),
      userMsg("Turn 4 request", 9),
      asstMsg("another answer", 10),
      userMsg("Turn 5 request", 11),
      asstMsg("final answer", 12),
      userMsg("Turn 6 request", 13),
      asstMsg("done", 14),
    ];

    // 1. Semantic prune
    const pruned = pruneSemanticToolResults(messages, { verbatimTailMessages: 2 });
    const turn1Result = pruned[2]!;
    const turn1Text = textFromContent(turn1Result.content as string | CodexContentPart[]);

    // It MUST NOT be replaced with a supersession receipt, despite being re-read in Turn 2
    expect(turn1Text).not.toContain("superseded by subsequent read");
    expect(turn1Text).toContain(sentinelStr);
    expect(turn1Text).toBe(toolContentWithSentinel); // Exact byte-for-byte equality

    // 2. Deep receipt compaction
    const compacted = compactToolResultsToReceipts(pruned, 2);
    const compactedTurn1 = compacted[2]!;
    expect(textFromContent(compactedTurn1.content as string | CodexContentPart[])).toBe(toolContentWithSentinel);
  });

  test("Sentinels with various unicode escapes and partial directives are protected", () => {
    const variants = [
      "\uE200visualize\uE202{\"path\":\"/tmp/viz.html\"}\uE201",
      "Prefix text \uE200visualize\uE202{\"path\":\"C:\\\\data\\\\viz.html\"}\uE201 suffix text",
      "Path containing /.codex/visualizations/index.html without sentinels",
      "Path containing C:\\Users\\app\\.codex\\visualizations\\chart.html with Windows backslashes",
      "Individual sentinel character \uE200 alone",
      "Individual sentinel character \uE201 alone",
      "Individual sentinel character \uE202 alone",
    ];

    for (const variant of variants) {
      const messages: CodexMessage[] = [
        userMsg("Turn 1", 1),
        asstMsg([{ type: "toolCall", id: "c1", name: "view_file", arguments: { path: "file.txt" } }], 2),
        toolMsg("c1", "view_file", `${variant}\n${"Z".repeat(8000)}`, false, 3),
        userMsg("Turn 2", 4),
        asstMsg([{ type: "toolCall", id: "c2", name: "view_file", arguments: { path: "file.txt" } }], 5),
        toolMsg("c2", "view_file", "newer content", false, 6),
        userMsg("Turn 3 active", 7),
      ];

      const pruned = pruneSemanticToolResults(messages, { verbatimTailMessages: 1 });
      const toolResultMessage = pruned[2]!;
      const text = textFromContent(toolResultMessage.content as string | CodexContentPart[]);

      // Must be completely preserved because hasVisualizationDirectives is true
      expect(text).toContain(variant);
      expect(text).not.toContain("superseded");
      expect(text.length).toBeGreaterThan(8000);
    }
  });

  test("Sentinel in CodexContentPart array structure is fully preserved", () => {
    const sentinelStr = "\uE200visualize\uE202{\"path\":\"/viz/render.html\"}\uE201";
    const messages: CodexMessage[] = [
      userMsg("Turn 1", 1),
      asstMsg([{ type: "toolCall", id: "c1", name: "cat", arguments: { path: "viz.html" } }], 2),
      toolMsg("c1", "cat", [
        { type: "text", text: "Header line" },
        { type: "text", text: `Artifact: ${sentinelStr}` },
        { type: "text", text: "x".repeat(9000) },
      ], false, 3),
      userMsg("Turn 2", 4),
      asstMsg([{ type: "toolCall", id: "c2", name: "cat", arguments: { path: "viz.html" } }], 5),
      toolMsg("c2", "cat", "re-read", false, 6),
      userMsg("Turn 3", 7),
    ];

    const pruned = pruneSemanticToolResults(messages, { verbatimTailMessages: 1 });
    const text = textFromContent(pruned[2]!.content as string | CodexContentPart[]);
    expect(text).toContain(sentinelStr);
    expect(text).not.toContain("superseded");
  });

  test("withoutRetiredTurnHandles does not alter or corrupt visualize sentinels in JSON", () => {
    const sentinelStr = "\uE200visualize\uE202{\"path\":\"C:/viz/turn_output.html\"}\uE201";
    const rawContent = `Here is the result: ${sentinelStr}`;
    const jsonStr = JSON.stringify({
      version: 3,
      messages: [
        { role: "assistant", content: rawContent },
        { role: "user", content: "turn_1234567890123456789012345678 and binding_abcdefghijklmnopqrstuvwxyz" },
      ],
    });

    const cleaned = withoutRetiredTurnHandles(jsonStr);
    const parsed = JSON.parse(cleaned) as { messages: { content: string }[] };
    expect(parsed.messages[0]!.content).toBe(rawContent);
    expect(parsed.messages[1]!.content).toBe("[retired turn handle] and [retired binding handle]");
  });
});

describe("Adversarial Challenge 2: apply_patch & requiredVisualizationReference() Accuracy", () => {
  test("requiredVisualizationReference detects .codex/visualizations/*.html from shell copy / tool results after pruning", () => {
    const publishedPath = "C:/Users/dev/.codex/visualizations/simulation_3d.html";
    const req: CodexParsedRequest = {
      modelId: CHATGPT_WEB_MODEL_ID,
      options: { reasoning: "high" },
      context: {
        messages: [
          userMsg("Run the 3d simulation and visualize", 1),
          asstMsg([{ type: "toolCall", id: "c1", name: "exec_command", arguments: { cmd: `copy out.html ${publishedPath}` } }], 2),
          toolMsg("c1", "exec_command", `Copied 1 file to ${publishedPath}`, false, 3),
        ],
      },
      stream: false,
    };

    // Pre-prune detection
    const initialRef = requiredVisualizationReference(req);
    expect(initialRef).toBe(`\uE200visualize\uE202{"path":"${publishedPath}"}\uE201`);

    // Post-prune detection
    const prunedMessages = pruneSemanticToolResults(req.context.messages);
    const prunedReq: CodexParsedRequest = {
      ...req,
      context: { ...req.context, messages: prunedMessages },
    };
    const prunedRef = requiredVisualizationReference(prunedReq);
    expect(prunedRef).toBe(`\uE200visualize\uE202{"path":"${publishedPath}"}\uE201`);
  });

  test("requiredVisualizationReference detects apply_patch with plugin invocation and survives multi-turn pruning", () => {
    const htmlPath = "C:/workspace/reports/summary.html";
    const patchOutput = `Applied patch to ${htmlPath}\nA ${htmlPath}\n+++ b/${htmlPath}`;

    const req: CodexParsedRequest = {
      modelId: CHATGPT_WEB_MODEL_ID,
      options: { reasoning: "high" },
      context: {
        messages: [
          // Turn 1: Older turn with file reads that will be pruned
          userMsg("Initial research", 1),
          asstMsg([{ type: "toolCall", id: "t1", name: "view_file", arguments: { path: "data.json" } }], 2),
          toolMsg("t1", "view_file", "old data ".repeat(1000), false, 3),
          // Turn 2: Active turn invoking visualize plugin
          userMsg("plugin://visualize@openai-bundled create summary report", 4),
          asstMsg([{ type: "toolCall", id: "t2", name: "apply_patch", arguments: { patch: patchOutput } }], 5),
          toolMsg("t2", "apply_patch", `Success\n${patchOutput}`, false, 6),
        ],
      },
      stream: false,
    };

    const initialRef = requiredVisualizationReference(req);
    expect(initialRef).toBe(`\uE200visualize\uE202{"path":"${htmlPath}"}\uE201`);

    // Apply semantic pruning
    const prunedReq: CodexParsedRequest = {
      ...req,
      context: { ...req.context, messages: pruneSemanticToolResults(req.context.messages) },
    };
    const prunedRef = requiredVisualizationReference(prunedReq);
    expect(prunedRef).toBe(`\uE200visualize\uE202{"path":"${htmlPath}"}\uE201`);

    // Repair missing reference
    const repaired = repairMissingFinalArtifactReference(prunedReq, "Here is the summary of the report.");
    expect(repaired.answer).toBe(`Here is the summary of the report.\n\n\uE200visualize\uE202{"path":"${htmlPath}"}\uE201`);
    expect(repaired.delta).toBe(`\n\n\uE200visualize\uE202{"path":"${htmlPath}"}\uE201`);
  });

  test("Directory inheritance across multiple turns survives pruning", () => {
    const historicalPath = "C:/workspace/charts/monthly_sales.html";
    const followUpPath = "C:/workspace/charts/quarterly_sales.html";

    const req: CodexParsedRequest = {
      modelId: CHATGPT_WEB_MODEL_ID,
      options: { reasoning: "high" },
      context: {
        messages: [
          // Turn 1: Created monthly sales
          userMsg("plugin://visualize@openai-bundled make monthly chart", 1),
          asstMsg(`Created chart:\n\uE200visualize\uE202{"path":"${historicalPath}"}\uE201`, 2),
          // Turn 2: Follow-up without plugin prefix
          userMsg("Now make the quarterly sales chart in the same directory", 3),
          asstMsg([{ type: "toolCall", id: "t2_apply", name: "apply_patch", arguments: { patch: `A ${followUpPath}` } }], 4),
          toolMsg("t2_apply", "apply_patch", `A ${followUpPath}`, false, 5),
        ],
      },
      stream: false,
    };

    const initialRef = requiredVisualizationReference(req);
    expect(initialRef).toBe(`\uE200visualize\uE202{"path":"${followUpPath}"}\uE201`);

    const prunedReq: CodexParsedRequest = {
      ...req,
      context: { ...req.context, messages: pruneSemanticToolResults(req.context.messages) },
    };
    const prunedRef = requiredVisualizationReference(prunedReq);
    expect(prunedRef).toBe(`\uE200visualize\uE202{"path":"${followUpPath}"}\uE201`);
  });

  test("Failed apply_patch or non-html file never produces visualization reference", () => {
    const failedReq: CodexParsedRequest = {
      modelId: CHATGPT_WEB_MODEL_ID,
      options: { reasoning: "high" },
      context: {
        messages: [
          userMsg("plugin://visualize@openai-bundled build chart", 1),
          asstMsg([{ type: "toolCall", id: "f1", name: "apply_patch", arguments: {} }], 2),
          toolMsg("f1", "apply_patch", "A C:/workspace/charts/err.html\nFailed to apply patch: permission denied", true, 3),
        ],
      },
      stream: false,
    };

    expect(requiredVisualizationReference(failedReq)).toBeUndefined();

    const nonHtmlReq: CodexParsedRequest = {
      modelId: CHATGPT_WEB_MODEL_ID,
      options: { reasoning: "high" },
      context: {
        messages: [
          userMsg("plugin://visualize@openai-bundled write script", 1),
          asstMsg([{ type: "toolCall", id: "nh1", name: "apply_patch", arguments: {} }], 2),
          toolMsg("nh1", "apply_patch", "A C:/workspace/charts/script.js", false, 3),
        ],
      },
      stream: false,
    };

    expect(requiredVisualizationReference(nonHtmlReq)).toBeUndefined();
  });
});

describe("Adversarial Challenge 3: Instruction & <app-context> Block Invariants", () => {
  test("All instruction block markers are correctly identified by isInstructionMessage", () => {
    const markers = [
      "<app-context>\nDesktop app environment and tools",
      "  <app-context> with leading spaces",
      "\n<recommended_plugins>some plugins</recommended_plugins>",
      "<environment_context>OS: windows</environment_context>",
      "<skills_instructions>Skill catalog</skills_instructions>",
      "<model_switch>Switched to gpt-5</model_switch>",
      "<permissions instructions>read/write allowed",
      "<collaboration_mode>teamwork",
      "<apps_instructions>desktop apps",
      "<plugins_instructions>plugin list",
      "# AGENTS.md\nAgent rules and workflow",
      "Capabilities from the following skills:",
    ];

    for (const marker of markers) {
      const uMsg = userMsg(marker);
      const dMsg = devMsg(marker);

      expect(isInstructionMessage(uMsg)).toBe(true);
      expect(isInstructionMessage(dMsg)).toBe(true);
      expect(promptIsInstructionMessage(uMsg)).toBe(true);

      // Assistant and toolResult roles MUST return false
      const aMsg = asstMsg(marker);
      const tMsg = toolMsg("c", "t", marker);
      expect(isInstructionMessage(aMsg)).toBe(false);
      expect(isInstructionMessage(tMsg)).toBe(false);
    }
  });

  test("getLatestUserIndex ignores instruction user messages and locates the actual human turn", () => {
    const messages: CodexMessage[] = [
      userMsg("Real Human Prompt Turn 1", 1),
      asstMsg("Reply 1", 2),
      userMsg("Real Human Prompt Turn 2", 3),
      asstMsg("Reply 2", 4),
      // Codex injected trailing instruction messages formatted as 'user'
      userMsg("<environment_context>\nUser OS: Windows\nWorking Directory: C:/dev</environment_context>", 5),
      userMsg("# AGENTS.md\nFollow teamwork guidelines", 6),
      userMsg("<skills_instructions>\nAvailable skills: none</skills_instructions>", 7),
    ];

    const idx = getLatestUserIndex(messages);
    expect(idx).toBe(2);
    expect(messages[idx]!.content).toBe("Real Human Prompt Turn 2");
  });

  test("nextDroppableIndex NEVER drops instruction messages even under extreme trimming pressure", () => {
    const instruction1 = userMsg("<app-context>Core tool schemas and Images/Visuals rules</app-context>", 1);
    const instruction2 = devMsg("<skills_instructions>Skill definitions</skills_instructions>", 2);
    const instruction3 = userMsg("# AGENTS.md instructions", 7);

    const messages: CodexMessage[] = [
      instruction1,
      instruction2,
      userMsg("Old conversation message 1", 3),
      asstMsg("Old reply 1", 4),
      userMsg("Old conversation message 2", 5),
      asstMsg("Old reply 2", 6),
      instruction3,
      userMsg("Active user request", 8), // newest
    ];

    let currentMessages = [...messages];
    const droppedTexts: string[] = [];

    while (true) {
      const droppableIdx = nextDroppableIndex(currentMessages);
      if (droppableIdx < 0) break;
      const droppedMsg = currentMessages[droppableIdx]!;
      droppedTexts.push(textFromContent(droppedMsg.content as string | CodexContentPart[]));
      currentMessages = [
        ...currentMessages.slice(0, droppableIdx),
        ...currentMessages.slice(droppableIdx + 1),
      ];
    }

    // Only the regular conversation messages should have been droppable
    expect(droppedTexts).toEqual([
      "Old conversation message 1",
      "Old reply 1",
      "Old conversation message 2",
      "Old reply 2",
    ]);

    // Remaining messages must be all instructions and the newest active user request
    expect(currentMessages.length).toBe(4);
    expect(currentMessages).toContain(instruction1);
    expect(currentMessages).toContain(instruction2);
    expect(currentMessages).toContain(instruction3);
    expect(currentMessages[currentMessages.length - 1]!.content).toBe("Active user request");
  });

  test("withoutDesktopOnlyReplayBlocks preserves <app-context> and core rules intact on realistic payloads", () => {
    const padding = "A".repeat(2500);
    const appContextText = `<app-context>
<system_information>Windows 11 ${padding}</system_information>
<tools_schema>
  <tool name="view_file" />
  <tool name="apply_patch" />
</tools_schema>
<images_visuals_rules>
  Preserve sentinels \\uE200visualize...
</images_visuals_rules>
</app-context>
<oai-mem-citation>User loves TypeScript</oai-mem-citation>
<recommended_plugins>
  <plugin name="uninstalled-plugin-foo" />
</recommended_plugins>
## What's in Memory
User prefers clean code.
<skills_instructions>
Actual skill instructions
</skills_instructions>`;

    const stripped = withoutDesktopOnlyReplayBlocks(appContextText);

    // <app-context> MUST be completely intact
    expect(stripped).toContain("<app-context>");
    expect(stripped).toContain("Windows 11");
    expect(stripped).toContain("<images_visuals_rules>");
    expect(stripped).toContain("</app-context>");

    // <skills_instructions> MUST be completely intact
    expect(stripped).toContain("<skills_instructions>");
    expect(stripped).toContain("Actual skill instructions");
    expect(stripped).toContain("</skills_instructions>");

    // Desktop-only UI blocks MUST be removed
    expect(stripped).not.toContain("<oai-mem-citation>");
    expect(stripped).not.toContain("<recommended_plugins>");
    expect(stripped).not.toContain("## What's in Memory");
  });
});

describe("Adversarial Challenge 4: Composer Ceiling & Multi-turn Stress Testing", () => {
  test("Massive 40-turn load with 200,000 chars is pruned and compacted below 110,000 ceiling without losing active turn or instructions", () => {
    const messages: CodexMessage[] = [
      userMsg("<app-context>Irreducible Desktop Baseline (~22,000 tokens of schemas and rules) " + "K".repeat(30_000) + "</app-context>", 1),
      devMsg("<skills_instructions>Skills definitions " + "S".repeat(5_000) + "</skills_instructions>", 2),
    ];

    let ts = 3;
    // Build 30 historical turns of duplicate file reads, duplicate dir listings, and huge command outputs
    for (let turn = 1; turn <= 30; turn++) {
      messages.push(
        userMsg(`Turn ${turn} user request`, ts++),
        asstMsg([
          { type: "toolCall", id: `call_view_${turn}`, name: "view_file", arguments: { path: "src/server.ts" } },
          { type: "toolCall", id: `call_ls_${turn}`, name: "list_dir", arguments: { directory_path: "src/" } },
          { type: "toolCall", id: `call_cmd_${turn}`, name: "exec_command", arguments: { cmd: "npm test" } },
        ], ts++),
        toolMsg(`call_view_${turn}`, "view_file", `Content of src/server.ts turn ${turn}:\n` + "Line code with lots of functions and statements;\n".repeat(80), false, ts++),
        toolMsg(`call_ls_${turn}`, "list_dir", `Directory listing src/ (turn ${turn}):\nfile1.ts\nfile2.ts\nfile3.ts\n` + "more_file_entry_in_the_directory_tree.ts\n".repeat(60), false, ts++),
        toolMsg(`call_cmd_${turn}`, "exec_command", `Test output turn ${turn}:\nPASS tests/a.test.ts\n` + "test log output line with verbose traces...\n".repeat(60) + "Exit code: 0", false, ts++),
        asstMsg(`Turn ${turn} completed answer`, ts++),
      );
    }

    // Active turn (Turn 31) with visualize sentinel and active apply_patch
    const activeVizPath = "C:/workspace/.codex/visualizations/final_result.html";
    messages.push(
      userMsg("plugin://visualize@openai-bundled generate final visualization dashboard", ts++),
      asstMsg([
        { type: "toolCall", id: "call_active_patch", name: "apply_patch", arguments: { patch: `A ${activeVizPath}` } },
      ], ts++),
      toolMsg("call_active_patch", "apply_patch", `Applied patch successfully:\nA ${activeVizPath}\n\uE200visualize\uE202{"path":"${activeVizPath}"}\uE201`, false, ts++),
    );

    const totalRawChars = messages.reduce((acc, m) => acc + textFromContent(m.content as string | CodexContentPart[]).length, 0);
    expect(totalRawChars).toBeGreaterThan(150_000);

    const req: CodexParsedRequest = {
      modelId: CHATGPT_WEB_MODEL_ID,
      options: { reasoning: "high" },
      context: { messages },
      stream: false,
    };

    const compiled = compileChatGptWebPrompt(req, MOCK_CAPABILITIES, "turn_token_test_12345678901234567890");

    // 1. Prompt text length MUST be <= 110,000 characters (the Plus composer ceiling)
    expect(compiled.text.length).toBeLessThanOrEqual(110_000);

    // 2. <app-context> instruction MUST be preserved
    expect(compiled.text).toContain("<app-context>");

    // 3. Active user prompt MUST be preserved
    expect(compiled.text).toContain("plugin://visualize@openai-bundled generate final visualization dashboard");

    // 4. Active turn tool result with sentinel MUST be preserved
    expect(compiled.text).toContain(activeVizPath);
    expect(compiled.text).toContain("\uE200visualize\uE202");
    expect(compiled.text).toContain("\uE201");

    // 5. requiredVisualizationReference on the parsed request must accurately detect the artifact
    const vizRef = requiredVisualizationReference(req);
    expect(vizRef).toBe(`\uE200visualize\uE202{"path":"${activeVizPath}"}\uE201`);
  });

  test("Namespaced tool names (e.g. codex__apply_patch, codex__view_file) and multiple sequential patches in active turn work flawlessly", () => {
    const viz1 = "C:/workspace/reports/draft.html";
    const viz2 = "C:/workspace/reports/final.html";

    const req: CodexParsedRequest = {
      modelId: CHATGPT_WEB_MODEL_ID,
      options: { reasoning: "high" },
      context: {
        messages: [
          userMsg("plugin://visualize@openai-bundled make report", 1),
          asstMsg([
            { type: "toolCall", id: "p1", name: "codex__apply_patch", arguments: { patch: `A ${viz1}` } },
            { type: "toolCall", id: "p2", name: "codex__apply_patch", arguments: { patch: `A ${viz2}` } },
          ], 2),
          toolMsg("p1", "codex__apply_patch", `A ${viz1}`, false, 3),
          toolMsg("p2", "codex__apply_patch", `A ${viz2}`, false, 4),
        ],
      },
      stream: false,
    };

    // Last patched HTML path in active turn should win
    const ref = requiredVisualizationReference(req);
    expect(ref).toBe(`\uE200visualize\uE202{"path":"${viz2}"}\uE201`);

    // Pruned version
    const prunedReq: CodexParsedRequest = {
      ...req,
      context: { ...req.context, messages: pruneSemanticToolResults(req.context.messages) },
    };
    expect(requiredVisualizationReference(prunedReq)).toBe(`\uE200visualize\uE202{"path":"${viz2}"}\uE201`);
  });

  test("Complex file read -> apply_patch -> file read -> apply_patch multi-turn chain supersedes correctly", () => {
    const filePath = "C:/workspace/src/config.ts";

    const messages: CodexMessage[] = [
      // Turn 1: Initial read
      userMsg("Check config", 1),
      asstMsg([{ type: "toolCall", id: "c1", name: "view_file", arguments: { path: filePath } }], 2),
      toolMsg("c1", "view_file", "INITIAL CONFIG CONTENT", false, 3),
      asstMsg("Read turn 1", 4),

      // Turn 2: Patch config
      userMsg("Update config port to 8080", 5),
      asstMsg([{ type: "toolCall", id: "c2", name: "apply_patch", arguments: { target_file: filePath } }], 6),
      toolMsg("c2", "apply_patch", `Applied patch to ${filePath}\nM ${filePath}`, false, 7),
      asstMsg("Patched turn 2", 8),

      // Turn 3: Re-read config
      userMsg("Verify config", 9),
      asstMsg([{ type: "toolCall", id: "c3", name: "view_file", arguments: { path: filePath } }], 10),
      toolMsg("c3", "view_file", "UPDATED CONFIG CONTENT WITH PORT 8080", false, 11),
      asstMsg("Read turn 3", 12),

      // Turn 4: Patch again
      userMsg("Update config host", 13),
      asstMsg([{ type: "toolCall", id: "c4", name: "apply_patch", arguments: { target_file: filePath } }], 14),
      toolMsg("c4", "apply_patch", `Applied patch to ${filePath}\nM ${filePath}`, false, 15),
      asstMsg("Patched turn 4", 16),

      // Turn 5: Active turn
      userMsg("What is current status?", 17),
    ];

    const pruned = pruneSemanticToolResults(messages, { verbatimTailMessages: 1 });

    // Turn 1 read (index 2) must be superseded
    const t1Text = textFromContent(pruned[2]!.content as string | CodexContentPart[]);
    expect(t1Text).toContain("superseded by subsequent read/modification at turn 4");

    // Turn 3 read (index 10) must be superseded by turn 4 patch
    const t3Text = textFromContent(pruned[10]!.content as string | CodexContentPart[]);
    expect(t3Text).toContain("superseded by subsequent read/modification at turn 4");
  });
});
