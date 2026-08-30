import { expect, test } from "bun:test";
import { ChatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import type { ChatGptTurnRuntime } from "../src/adapters/chatgpt-web/turn-execution";

function deferredRuntime(): { runtime: ChatGptTurnRuntime; release: () => void; cancelled: () => boolean } {
  let release!: () => void;
  const browser = new Promise<string>(resolve => {
    release = () => resolve("answer");
  });
  let cancelled = false;
  const runtime = {
    mode: "read-only",
    browser,
    trace: {},
    text: {},
    // The session now waits on the tab actually being released, not just on the answer, so a runtime
    // without this settles nothing and the retirement under test never completes.
    physicalSettlement: browser.then(() => undefined, () => undefined),
    cancel: () => {
      cancelled = true;
    },
  } as unknown as ChatGptTurnRuntime;
  return { runtime, release, cancelled: () => cancelled };
}

/**
 * `retire` is the fire-and-forget sibling of `retireAndWait`, taken when a client stops reading and
 * the abandon grace expires. Cancelling only starts the browser turn's unwind, so retirement is not
 * complete until `browserOutcome` settles and the tab is released. When that wait went unrecorded,
 * `waitForRetirement` resolved on an empty map, the reconnect built a fresh session, and the worker
 * re-entered under the same deterministic traceId - which it rejects as a duplicate, killing the
 * reconnect this whole path exists to support.
 */
test("retire makes the next attempt wait until the browser turn releases its tab", async () => {
  const sessions = new ChatGptTurnSessions();
  const { runtime, release, cancelled } = deferredRuntime();

  const session = sessions.getOrCreate("execution-key", () => runtime);
  expect(sessions.retire("execution-key", session)).toBe(true);
  expect(cancelled()).toBe(true);

  let retired = false;
  const waiting = sessions.waitForRetirement("execution-key").then(() => {
    retired = true;
  });

  await new Promise(resolve => setTimeout(resolve, 20));
  expect(retired).toBe(false);

  release();
  await waiting;
  expect(retired).toBe(true);
});

test("a settled retirement stops blocking later attempts for the same key", async () => {
  const sessions = new ChatGptTurnSessions();
  const { runtime, release } = deferredRuntime();

  const session = sessions.getOrCreate("execution-key", () => runtime);
  sessions.retire("execution-key", session);
  release();
  await sessions.waitForRetirement("execution-key");

  // The recorded wait has to be dropped once it settles, otherwise every later turn on this key
  // keeps awaiting a promise for a tab that was released long ago.
  const second = deferredRuntime();
  const reused = sessions.getOrCreate("execution-key", () => second.runtime);
  expect(reused.runtime).toBe(second.runtime);
  await sessions.waitForRetirement("execution-key");
});
