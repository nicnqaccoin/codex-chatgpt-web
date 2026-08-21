import { expect, test } from "bun:test";
import { requiredVisualizationReference } from "../src/adapters/chatgpt-web/final-artifacts";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import type { CodexMessage, CodexParsedRequest } from "../src/types";

const publishedPath =
  "C:\\Users\\person\\.codex\\visualizations\\2026\\08\\21\\thread-id\\newton-third-law-cinematic.html";

function request(messages: CodexMessage[]): CodexParsedRequest {
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    context: { messages },
    stream: true,
    options: { reasoning: "high" },
  } as unknown as CodexParsedRequest;
}

function toolResult(toolName: string, content: string, timestamp: number): CodexMessage {
  return { role: "toolResult", toolCallId: `call_${timestamp}`, toolName, isError: false, content, timestamp };
}

/**
 * The observed Visualize flow: apply_patch writes a workspace-relative file, then a shell command
 * copies it into the app's visualization directory. Neither step yields an absolute apply_patch
 * path, so inheritance-based detection produced an empty Result panel while the artifact existed.
 */
test("a follow-up publishes the artifact the shell copy created", () => {
  const reference = requiredVisualizationReference(request([
    { role: "user", content: "làm lại 1 cái đẹp hơn nữa đi", timestamp: 1 },
    toolResult("apply_patch", "Success. Updated the following files:\nA work/newton-third-law-cinematic.html\n", 2),
    toolResult("exec_command", `Copy-Item ... -Destination '${publishedPath}'\nExit code: 0`, 3),
  ]));

  expect(reference).toContain(publishedPath.replaceAll("\\", "\\\\"));
});

test("detection survives compaction erasing the earlier visualize directives", () => {
  const reference = requiredVisualizationReference(request([
    { role: "user", content: "[compacted summary of the earlier lesson work]", timestamp: 1 },
    { role: "user", content: "make it prettier", timestamp: 2 },
    toolResult("exec_command", `wrote ${publishedPath}`, 3),
  ]));

  expect(reference).toContain("newton-third-law-cinematic.html");
});

test("the newest published artifact wins when a turn republishes", () => {
  const older = publishedPath.replace("-cinematic", "-draft");
  const reference = requiredVisualizationReference(request([
    { role: "user", content: "make it prettier", timestamp: 1 },
    toolResult("exec_command", `wrote ${older}`, 2),
    toolResult("exec_command", `wrote ${publishedPath}`, 3),
  ]));

  expect(reference).toContain("newton-third-law-cinematic.html");
  expect(reference).not.toContain("-draft");
});

test("html written outside the visualization directory is not published", () => {
  const reference = requiredVisualizationReference(request([
    { role: "user", content: "build me a report", timestamp: 1 },
    toolResult("exec_command", "wrote C:\\Users\\person\\Documents\\report.html", 2),
  ]));

  expect(reference).toBeUndefined();
});

test("a failed tool result never publishes an artifact", () => {
  const reference = requiredVisualizationReference(request([
    { role: "user", content: "make it prettier", timestamp: 1 },
    {
      role: "toolResult",
      toolCallId: "call_2",
      toolName: "exec_command",
      isError: true,
      content: `failed to write ${publishedPath}`,
      timestamp: 2,
    },
  ]));

  expect(reference).toBeUndefined();
});

test("a compaction turn never carries an artifact reference", () => {
  const compaction = request([
    { role: "user", content: "make it prettier", timestamp: 1 },
    toolResult("exec_command", `wrote ${publishedPath}`, 2),
  ]);
  (compaction as { _compactionRequest?: boolean })._compactionRequest = true;

  expect(requiredVisualizationReference(compaction)).toBeUndefined();
});
