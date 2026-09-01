import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import {
  ChatGptExternalTurnProgress,
  chatGptExternalProgressIsLive,
} from "../src/adapters/chatgpt-web/turn-progress";

const roots: string[] = [];
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "cgw-mcp-progress-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const environment = (root: string) => ({
  cwd: root,
  roots: [root],
  writableRoots: [root],
  sandboxPolicy: { type: "dangerFullAccess" as const },
  tools: [{ name: "exec_command", description: "Simulated command", parameters: { type: "object" } }],
});

/**
 * The bug: activeToolCalls only rises once the adapter drains a batch via nextToolBatch, so a
 * connector invocation that has reached the broker but not yet been picked up leaves the liveness
 * gate reading "not live". Completion fires in that window and revokes the token out from under the
 * call, which then dies with "turn token is invalid or expired". Binding broker activity to the
 * progress must make the invocation raise liveness the instant the broker accepts it - before any
 * nextToolBatch call.
 */
test("a connector invocation raises progress liveness before it becomes a tool batch", async () => {
  const root = scratch();
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  await broker.listen();
  const progress = new ChatGptExternalTurnProgress();
  try {
    const token = await broker.register(environment(root), 60_000, "mcp-progress-test");
    broker.bindMcpActivity(token, {
      begin: () => progress.recordMcpRequestBegin(),
      end: () => progress.recordMcpRequestEnd(),
    });

    // Before any call, nothing is live once the initial timestamp ages out.
    const idle = progress.snapshot();
    expect(idle.activeToolCalls).toBe(0);
    expect(idle.activeMcpRequests ?? 0).toBe(0);

    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    const invocation = callTurnBroker(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "exec_command",
      arguments: { cmd: "pwd" },
    }, 10_000);
    // Give the socket round trip a moment to reach the broker, but crucially do NOT call
    // nextToolBatch - this is the exact window in which the old gate read "not live".
    await Bun.sleep(20);

    const duringCall = progress.snapshot();
    expect(duringCall.activeToolCalls).toBe(0); // adapter has not drained a batch
    expect(duringCall.activeMcpRequests ?? 0).toBe(1); // but the broker call is counted
    // A far-past timestamp proves liveness comes from the in-flight request, not a recent tick.
    expect(chatGptExternalProgressIsLive(duringCall, Date.now() + 60_000_000, 60_000)).toBe(true);

    await broker.revoke(token);
    await invocation.catch(() => undefined); // revoke rejects the pending call

    const afterRevoke = progress.snapshot();
    expect(afterRevoke.activeMcpRequests ?? 0).toBe(0); // settle balanced the begin
  } finally {
    await broker.close();
  }
});

test("completing a call settles the mcp request exactly once", async () => {
  const root = scratch();
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  await broker.listen();
  const progress = new ChatGptExternalTurnProgress();
  try {
    const token = await broker.register(environment(root), 60_000, "mcp-progress-complete");
    broker.bindMcpActivity(token, {
      begin: () => progress.recordMcpRequestBegin(),
      end: () => progress.recordMcpRequestEnd(),
    });
    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    const invocation = callTurnBroker(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "exec_command",
      arguments: { cmd: "pwd" },
    }, 10_000);
    const batch = await broker.nextToolBatch(token);
    expect(progress.snapshot().activeMcpRequests ?? 0).toBe(1);
    await broker.completeTool(token, batch[0]!.callId, {
      content: [{ type: "text", text: "ok" }],
      structuredContent: { simulated: true },
    });
    await invocation;
    // Exactly one end for one begin - never negative, never stuck above zero.
    expect(progress.snapshot().activeMcpRequests ?? 0).toBe(0);
    await broker.revoke(token);
  } finally {
    await broker.close();
  }
});
