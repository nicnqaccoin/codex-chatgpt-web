import { expect, test } from "bun:test";
import {
  ChatGptConversationViews,
  chatGptConversationDelta,
  chatGptMessageSignatures,
} from "../src/adapters/chatgpt-web/conversation-delta";
import type { CodexMessage } from "../src/types";

function user(text: string): CodexMessage {
  return { role: "user", content: text, timestamp: 0 } as CodexMessage;
}

function toolResult(text: string): CodexMessage {
  return {
    role: "toolResult",
    toolCallId: `call_${text.length}`,
    toolName: "exec",
    content: text,
    isError: false,
    timestamp: 0,
  } as unknown as CodexMessage;
}

function view(conversationId: string, messages: readonly CodexMessage[]) {
  return { conversationId, signatures: chatGptMessageSignatures(messages), updatedAt: 0 };
}

test("an unchanged prefix sends only the messages ChatGPT has not seen", () => {
  const seen = [user("first"), toolResult("output one")];
  const now = [...seen, user("second"), toolResult("output two")];

  const delta = chatGptConversationDelta(view("conv_1", seen), now);
  expect(delta.kind).toBe("append");
  if (delta.kind !== "append") return;
  expect(delta.messages).toHaveLength(2);
  expect(delta.messages[0]).toBe(now[2]);
  expect(delta.signatures).toHaveLength(4);
});

test("a turn that adds nothing appends nothing rather than rotating", () => {
  const seen = [user("first"), toolResult("output one")];
  const delta = chatGptConversationDelta(view("conv_1", seen), seen);
  expect(delta.kind).toBe("append");
  if (delta.kind !== "append") return;
  expect(delta.messages).toHaveLength(0);
});

/**
 * The failure this whole design exists to prevent: Codex compacts, so a result ChatGPT still holds
 * verbatim arrives as a receipt. Appending on top would let the model answer from text Codex
 * believes it discarded, and no delta can repair that - the conversation has to be abandoned.
 */
test("a compacted message diverges instead of appending on top of stale text", () => {
  const seen = [user("first"), toolResult("x".repeat(40_000))];
  const compacted = [user("first"), toolResult("[Tool 'exec' completed with 40,000 chars of output]")];

  const delta = chatGptConversationDelta(view("conv_1", seen), [...compacted, user("second")]);
  expect(delta.kind).toBe("rotate");
  if (delta.kind !== "rotate") return;
  expect(delta.divergedAt).toBe(1);
  expect(delta.reason).toContain("diverged");
});

test("a history that got shorter diverges", () => {
  const seen = [user("first"), user("second"), user("third")];
  const delta = chatGptConversationDelta(view("conv_1", seen), seen.slice(0, 2));
  expect(delta.kind).toBe("rotate");
  if (delta.kind !== "rotate") return;
  expect(delta.divergedAt).toBe(2);
});

test("no established conversation rotates, which is today's behaviour", () => {
  const delta = chatGptConversationDelta(undefined, [user("first")]);
  expect(delta.kind).toBe("rotate");
  if (delta.kind !== "rotate") return;
  expect(delta.reason).toContain("no conversation");
});

test("an empty conversation id is never trusted", () => {
  const messages = [user("first")];
  const delta = chatGptConversationDelta(view("   ", messages), messages);
  expect(delta.kind).toBe("rotate");
});

test("views are remembered per session and dropped on rotation", () => {
  const views = new ChatGptConversationViews(() => 123);
  const messages = [user("first")];
  expect(views.get("session_a")).toBeUndefined();

  views.remember("session_a", "conv_a", chatGptMessageSignatures(messages));
  expect(views.get("session_a")?.conversationId).toBe("conv_a");
  expect(views.get("session_a")?.updatedAt).toBe(123);
  expect(views.get("session_b")).toBeUndefined();

  views.forget("session_a");
  expect(views.get("session_a")).toBeUndefined();
  expect(views.size()).toBe(0);
});
