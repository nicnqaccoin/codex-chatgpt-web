import { expect, test } from "bun:test";
import {
  repairMissingFinalArtifactReference,
  requiredVisualizationReference,
} from "../src/adapters/chatgpt-web/final-artifacts";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import type { CodexParsedRequest } from "../src/types";

const visualizationPath = "C:\\Users\\person\\.codex\\visualizations\\2026\\08\\21\\thread-id\\newton-second-law.html";

function visualizeRequest(): CodexParsedRequest {
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    context: {
      messages: [
        {
          role: "user",
          content: "[@Visualize](plugin://visualize@openai-bundled) create a Newton lesson",
          timestamp: 1,
        },
        {
          role: "toolResult",
          toolCallId: "call_patch",
          toolName: "apply_patch",
          isError: false,
          content: `Exit code: 0\nOutput:\nSuccess. Updated the following files:\nM ${visualizationPath}\n`,
          timestamp: 2,
        },
      ],
    },
    stream: true,
    options: { reasoning: "high" },
  };
}

test("recovers the current Visualize artifact from successful patch output", () => {
  const request = visualizeRequest();
  const reference = `visualize${JSON.stringify({ path: visualizationPath })}`;

  expect(requiredVisualizationReference(request)).toBe(reference);
  expect(repairMissingFinalArtifactReference(request, "Done.")).toEqual({
    answer: `Done.\n\n${reference}`,
    delta: `\n\n${reference}`,
  });
});

test("accepts a durable absolute visualization path outside the default Codex home", () => {
  const request = visualizeRequest();
  const result = request.context.messages[1]!;
  if (result.role !== "toolResult") throw new Error("test fixture mismatch");
  const path = "D:\\durable visualizations\\lesson.html";
  result.content = `Success. Added the following files:\nA ${path}\n`;

  expect(requiredVisualizationReference(request)).toBe(
    `visualize${JSON.stringify({ path })}`,
  );
});

test("does not duplicate an existing Visualize reference", () => {
  const request = visualizeRequest();
  const reference = requiredVisualizationReference(request)!;

  expect(repairMissingFinalArtifactReference(request, `Done.\n\n${reference}`)).toEqual({
    answer: `Done.\n\n${reference}`,
    delta: "",
  });
});

test("recovers a new sibling visualization created by a plain-language follow-up", () => {
  const request = visualizeRequest();
  const previousPath = visualizationPath;
  const improvedPath = "C:\\Users\\person\\.codex\\visualizations\\2026\\08\\21\\thread-id\\newton-second-law-lab.html";
  request.context.messages = [
    request.context.messages[0]!,
    {
      role: "assistant",
      content: [{ type: "text", text: `Original lesson.\n\nvisualize${JSON.stringify({ path: previousPath })}` }],
      timestamp: 2,
    },
    { role: "user", content: "Make it prettier", timestamp: 3 },
    {
      role: "toolResult",
      toolCallId: "call_improve",
      toolName: "apply_patch",
      content: `Success. Updated the following files:\nA ${improvedPath}\n`,
      isError: false,
      timestamp: 4,
    },
  ];

  expect(requiredVisualizationReference(request)).toBe(
    `visualize${JSON.stringify({ path: improvedPath })}`,
  );
});

test("does not inherit Visualize scope for an unrelated HTML directory", () => {
  const request = visualizeRequest();
  request.context.messages = [
    request.context.messages[0]!,
    {
      role: "assistant",
      content: [{ type: "text", text: `visualize${JSON.stringify({ path: visualizationPath })}` }],
      timestamp: 2,
    },
    { role: "user", content: "Now update the project landing page", timestamp: 3 },
    {
      role: "toolResult",
      toolCallId: "call_unrelated",
      toolName: "apply_patch",
      content: "Success. Updated the following files:\nM D:\\project\\index.html\n",
      isError: false,
      timestamp: 4,
    },
  ];

  expect(requiredVisualizationReference(request)).toBeUndefined();
});

test("does not infer artifacts from stale turns, errors, or unrelated HTML", () => {
  const stale = visualizeRequest();
  stale.context.messages.push({ role: "user", content: "Explain the result", timestamp: 3 });
  expect(requiredVisualizationReference(stale)).toBeUndefined();

  const failed = visualizeRequest();
  const failedResult = failed.context.messages[1]!;
  if (failedResult.role !== "toolResult") throw new Error("test fixture mismatch");
  failedResult.isError = true;
  expect(requiredVisualizationReference(failed)).toBeUndefined();

  const unrelated = visualizeRequest();
  const unrelatedResult = unrelated.context.messages[1]!;
  if (unrelatedResult.role !== "toolResult") throw new Error("test fixture mismatch");
  unrelatedResult.content = "Success. Updated the following files:\nM work\\preview.html\n";
  expect(requiredVisualizationReference(unrelated)).toBeUndefined();
});
