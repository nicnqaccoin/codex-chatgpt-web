import { expect, test } from "bun:test";
import { normalizeEffortLabel } from "../src/adapters/chatgpt-web/browser-worker";
import { resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";

const plus = { localToolsEnabled: true, solAvailable: true, proAvailable: false };

test("a control already showing the target effort matches its display label", () => {
  const mode = resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "high", plus);
  expect(normalizeEffortLabel("High")).toBe(mode.displayLabel);
  expect(normalizeEffortLabel("  High \n")).toBe(mode.displayLabel);
});

test("a different or decorated effort label never counts as a match", () => {
  const mode = resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "high", plus);
  for (const label of ["Medium", "Instant", "Extra High", "High effort", "", null]) {
    expect(normalizeEffortLabel(label)).not.toBe(label === "High" ? "" : mode.displayLabel);
  }
});

test("each Plus effort keeps a distinct label so a stale control cannot pass", () => {
  const labels = (["low", "medium", "high"] as const).map(effort =>
    resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, effort, plus).displayLabel
  );
  expect(new Set(labels).size).toBe(labels.length);
  expect(labels).toEqual(["Instant", "Medium", "High"]);
});
