import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LauncherBrowserHelperClient } from "../src/adapters/chatgpt-web/launcher-helper-client";
import type { ResolvedBrowserConfig } from "../src/adapters/chatgpt-web/browser-worker";
import { LAUNCHER_BROWSER_HOST_KIND } from "../src/launcher-browser-host";

/**
 * In launcher mode the turn is serialised into another process, so `conversation.onEstablished` -
 * a function - cannot travel with it. The resume url goes over as a plain string and the landed
 * conversation comes back as a protocol event. These tests run a real helper process over real
 * stdio, because the bug this guards against is invisible to any in-process test: the flag was
 * already correct and the turns still went to a temporary chat.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function harness(helperSource: string): ResolvedBrowserConfig {
  const root = mkdtempSync(join(tmpdir(), "codex-launcher-conversation-"));
  roots.push(root);
  const helper = join(root, "helper.cjs");
  writeFileSync(helper, helperSource, { mode: 0o700 });
  const descriptorHelper = join(root, "descriptor-helper.cjs");
  writeFileSync(descriptorHelper, "process.exit(99);\n", { mode: 0o700 });
  const descriptorPath = join(root, "launcher.json");
  writeFileSync(descriptorPath, `${JSON.stringify({
    version: 2,
    kind: LAUNCHER_BROWSER_HOST_KIND,
    profile: "production",
    pid: process.pid,
    endpoint: "http://127.0.0.1:39001",
    control: {
      endpoint: "http://127.0.0.1:39002",
      token: "launcher-control-token-0123456789abcdefghijklmnop",
    },
    helper: { executable: process.execPath, script: descriptorHelper },
    partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: "about:blank#codex-web-gpt-browser-host",
    surfaceId: "launcher_surface_id_0123456789AB",
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  return {
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: descriptorPath,
    browserHelperScriptPath: helper,
    storageStatePath: join(root, "unused-state.json"),
    chromeExecutablePath: join(root, "unused-chrome"),
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false,
  };
}

const baseTurn = {
  traceId: "abcdef123456",
  modelId: "gpt-5.6-sol",
  capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: false },
  prepare: async () => ({ text: "inspect", images: [], release: () => {} }),
  onTextDelta: () => {},
};

test("the resume url reaches the helper and the landed conversation comes back", async () => {
  // The helper answers with whatever resume url it was given, so a url that never crossed the
  // boundary shows up as a failed assertion rather than as a silent fall back to temporary chat.
  const config = harness(`
    const readline = require("node:readline").createInterface({ input: process.stdin });
    const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
    send({ type: "ready" });
    readline.on("line", line => {
      const message = JSON.parse(line);
      if (message.type === "shutdown") process.exit(0);
      if (message.type !== "run") return;
      send({ type: "event", id: message.id, event: "conversation", url: "https://chatgpt.com/c/landed-here" });
      send({ type: "result", id: message.id, text: "resumed:" + String(message.turn.conversationResumeUrl) });
    });
  `);
  const established: string[] = [];
  const client = new LauncherBrowserHelperClient(config);
  try {
    const result = await client.run({
      ...baseTurn,
      conversation: {
        resumeUrl: "https://chatgpt.com/c/previous-thread",
        onEstablished: url => established.push(url),
      },
    });
    expect(result).toBe("resumed:https://chatgpt.com/c/previous-thread");
    expect(established).toEqual(["https://chatgpt.com/c/landed-here"]);
  } finally {
    await client.close();
  }
});

test("a turn with no conversation sends no resume url, which is the temporary chat path", async () => {
  const config = harness(`
    const readline = require("node:readline").createInterface({ input: process.stdin });
    const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
    send({ type: "ready" });
    readline.on("line", line => {
      const message = JSON.parse(line);
      if (message.type === "shutdown") process.exit(0);
      if (message.type !== "run") return;
      send({ type: "result", id: message.id, text: "resume:" + String("conversationResumeUrl" in message.turn) });
    });
  `);
  const client = new LauncherBrowserHelperClient(config);
  try {
    expect(await client.run({ ...baseTurn })).toBe("resume:false");
  } finally {
    await client.close();
  }
});

test("a conversation url outside ChatGPT is rejected instead of steering the next turn", async () => {
  const config = harness(`
    const readline = require("node:readline").createInterface({ input: process.stdin });
    const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
    send({ type: "ready" });
    readline.on("line", line => {
      const message = JSON.parse(line);
      if (message.type === "shutdown") process.exit(0);
      if (message.type !== "run") return;
      send({ type: "event", id: message.id, event: "conversation", url: "https://example.com/c/elsewhere" });
      send({ type: "result", id: message.id, text: "done" });
    });
  `);
  const established: string[] = [];
  const client = new LauncherBrowserHelperClient(config);
  try {
    await expect(client.run({
      ...baseTurn,
      conversation: {
        resumeUrl: "https://chatgpt.com/c/previous-thread",
        onEstablished: url => established.push(url),
      },
    })).rejects.toThrow(/conversation url is invalid/);
    expect(established).toEqual([]);
  } finally {
    await client.close();
  }
});
