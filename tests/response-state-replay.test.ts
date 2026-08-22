import { expect, test } from "bun:test";
import {
  expandPreviousResponseInput,
  previousResponseReplayPrefixLength,
  rememberResponseState,
} from "../src/responses/state";

function turnIdOf(item: unknown): string | undefined {
  const passthrough = (item as { internal_chat_message_metadata_passthrough?: { turn_id?: string } })
    ?.internal_chat_message_metadata_passthrough;
  return passthrough?.turn_id;
}

/**
 * A rolling checkpoint is keyed to the exact assistant answer it summarises, and that answer is
 * located by walking back from the replayed prefix for an item that declares a turn identity. Our
 * own response output declares none, so on a `previous_response_id` chain - which is how Codex
 * continues a turn - the parent was invisible and the checkpoint could never be applied.
 */
test("replayed response output carries the identity of the turn that produced it", () => {
  const turnId = "turn-parent-0001";
  const request = {
    store: false,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "do the thing" }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    ],
  };
  rememberResponseState(request, {
    id: "resp-parent-0001",
    status: "completed",
    output: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "the thing is done" }] },
    ],
  }, { force: true });

  const expanded = expandPreviousResponseInput({
    previous_response_id: "resp-parent-0001",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "now the next thing" }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn-child-0002" },
      },
    ],
  }) as { input: unknown[] };

  const boundary = previousResponseReplayPrefixLength(expanded);
  expect(boundary).toBeGreaterThan(0);

  // This is the item `parentAssistantAnswer` inspects first, and it has to be identifiable.
  const parent = expanded.input[boundary - 1] as { role?: string };
  expect(parent.role).toBe("assistant");
  expect(turnIdOf(parent)).toBe(turnId);
});

test("an item that already declares a turn identity keeps its own", () => {
  const request = {
    store: false,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn-request" },
      },
    ],
  };
  rememberResponseState(request, {
    id: "resp-keeps-own",
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "hi" }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn-already-set" },
      },
    ],
  }, { force: true });

  const expanded = expandPreviousResponseInput({
    previous_response_id: "resp-keeps-own",
    input: [],
  }) as { input: unknown[] };
  const boundary = previousResponseReplayPrefixLength(expanded);
  expect(turnIdOf(expanded.input[boundary - 1])).toBe("turn-already-set");
});
