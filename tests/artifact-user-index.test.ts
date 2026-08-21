import { expect, test } from "bun:test";
import { requiredVisualizationReference } from "../src/adapters/chatgpt-web/final-artifacts";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import type { CodexMessage, CodexParsedRequest } from "../src/types";

const publishedPath =
  "C:\\Users\\person\\.codex\\visualizations\\2026\\08\\21\\thread\\newton-third-law.html";

const patchOutput =
  `Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess. Updated the following files:\nA ${publishedPath}\n`;

function request(messages: CodexMessage[]): CodexParsedRequest {
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    context: { messages },
    stream: true,
    options: { reasoning: "high" },
  } as unknown as CodexParsedRequest;
}

const ask: CodexMessage = {
  role: "user",
  content: "[@Visualize](plugin://visualize@openai-bundled) newton 3",
  timestamp: 1,
};

const patch: CodexMessage = {
  role: "toolResult",
  toolCallId: "call_1",
  toolName: "apply_patch",
  isError: false,
  content: patchOutput,
  timestamp: 2,
};

/**
 * Codex appends its own contracts as user messages, and in real requests they land after the turn's
 * tool results. Anchoring on the raw last user message left nothing to scan and returned the Result
 * panel empty even though the artifact had been written.
 */
test("a trailing Codex contract does not hide the turn's artifact", () => {
  for (const trailing of [
    "<environment_context><cwd>C:/w</cwd></environment_context>",
    "<recommended_plugins>\nplugins\n</recommended_plugins>",
    "# AGENTS.md instructions\nglobal rules",
  ]) {
    const reference = requiredVisualizationReference(request([
      ask,
      patch,
      { role: "user", content: trailing, timestamp: 3 },
    ]));
    expect(reference).toContain("newton-third-law.html");
  }
});

test("a real follow-up request still wins over an earlier ask", () => {
  const older = publishedPath.replace("newton-third-law", "older-lesson");
  const reference = requiredVisualizationReference(request([
    { role: "user", content: "[@Visualize](plugin://visualize@openai-bundled) older", timestamp: 1 },
    { ...patch, content: patchOutput.replace(publishedPath, older) },
    { role: "user", content: "làm lại đẹp hơn", timestamp: 3 },
    { ...patch, timestamp: 4 },
    { role: "user", content: "<environment_context><cwd>C:/w</cwd></environment_context>", timestamp: 5 },
  ]));

  expect(reference).toContain("newton-third-law.html");
  expect(reference).not.toContain("older-lesson");
});

test("no artifact in this turn still yields no reference", () => {
  const reference = requiredVisualizationReference(request([
    ask,
    { role: "user", content: "<environment_context><cwd>C:/w</cwd></environment_context>", timestamp: 2 },
  ]));

  expect(reference).toBeUndefined();
});
