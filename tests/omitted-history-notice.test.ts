import { expect, test } from "bun:test";
import { compileChatGptWebPrompt, omittedHistoryNotice } from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import type { ChatGptWebCapabilities } from "../src/adapters/chatgpt-web/model";
import type { CodexMessage, CodexParsedRequest } from "../src/types";

const plus: ChatGptWebCapabilities = { localToolsEnabled: true, solAvailable: true, proAvailable: false };

const APP_CONTEXT = "<app-context>\n# Codex desktop context\n### Images/Visuals/Files\n</app-context>";

function request(messages: CodexMessage[]): CodexParsedRequest {
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    context: { messages, systemPrompt: [] },
    stream: true,
    options: { reasoning: "high" },
  } as unknown as CodexParsedRequest;
}

test("no notice when the whole history fits", () => {
  expect(omittedHistoryNotice(0)).toEqual([]);
  expect(omittedHistoryNotice(-1)).toEqual([]);

  const compiled = compileChatGptWebPrompt(
    request([
      { role: "user", content: APP_CONTEXT, timestamp: 1 },
      { role: "user", content: "small ask", timestamp: 2 },
    ]),
    plus,
    "turn-token",
  );
  expect(compiled.text).not.toContain("older task message(s) were omitted");
});

test("a trimmed turn tells the model its view is partial", () => {
  const filler = "conversation ".repeat(200_000);
  const compiled = compileChatGptWebPrompt(
    request([
      { role: "user", content: APP_CONTEXT, timestamp: 1 },
      { role: "user", content: filler, timestamp: 2 },
      { role: "user", content: filler, timestamp: 3 },
      { role: "user", content: filler, timestamp: 4 },
      { role: "user", content: "make it prettier", timestamp: 5 },
    ]),
    plus,
    "turn-token",
  );

  expect(compiled.text).toContain("older task message(s) were omitted");
  expect(compiled.text).toContain("instead of guessing");
  // The notice is inside the budget it reports on, not bolted on afterwards.
  expect(compiled.text.length).toBeLessThanOrEqual(110_000);
  expect(compiled.text).toContain("### Images/Visuals/Files");
});

test("the notice counts every omitted message", () => {
  expect(omittedHistoryNotice(1)[0]).toContain("1 older task message(s)");
  expect(omittedHistoryNotice(12)[0]).toContain("12 older task message(s)");
});
