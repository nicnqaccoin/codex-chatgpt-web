import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { defaultBrokerEndpoint, expandUserPath, resolveBrokerEndpoint } from "../../config";
import { namespacedToolName, type AdapterEvent, type CodexContentPart, type CodexParsedRequest, type CodexProviderConfig, type CodexToolResultMessage, type CodexUsage } from "../../types";
import type { ProviderAdapter } from "../base";
import { parseDataUrl } from "../image";
import { ChatGptWebAdapterError } from "./adapter-error";
import { ChatGptBrowserWorker, type BrowserTurn } from "./browser-worker";
import { CHATGPT_NEW_CHAT_URL } from "../../chatgpt-session";
import {
  chatGptConversationViews,
  chatGptConversationDelta,
  chatGptMessageSignatures,
} from "./conversation-delta";
import { textFromContent } from "./prune";
import { appendDiagnosticRecord } from "./diagnostics-log";
import { extractChatGptTurnEnvironment, extractChatGptTurnIdentity } from "./environment";
import { repairMissingFinalArtifactReference } from "./final-artifacts";
import { CHATGPT_WEB_LUNA_MODEL_ID, resolveChatGptWebModelMode, type ChatGptWebCapabilities } from "./model";
import { chatGptReadOnlyContextWarning, compileChatGptWebPrompt } from "./prompt";
import { chatGptWebTurnRetryPolicy } from "./retry-policy";
import { TurnBroker, type BrokerToolRequest, type BrokerToolResult, type TurnBrokerOwner } from "./turn-broker";
import { ChatGptTextFeed, ChatGptTraceFeed, chatGptCompactionSourceExecutionKey, chatGptTurnExecutionKey, chatGptTurnRetryKey, chatGptTurnSessions, type ChatGptBrowserOutcome, type ChatGptTraceEvent, type ChatGptTurnRuntime, type ChatGptTurnSession } from "./turn-execution";
import { estimateChatGptWebUsage } from "./usage";
import { ChatGptThreadEnvironmentStore } from "./thread-environment";
import {
  ChatGptLunaCheckpointStore,
  type CapturedChatGptLunaCheckpoint,
} from "./rolling-checkpoint";

function brokerSocketPath(provider: CodexProviderConfig): string {
  const configured = provider.chatgptWeb?.brokerSocketPath?.trim();
  return resolveBrokerEndpoint(configured || defaultBrokerEndpoint());
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolveDeferred, rejectDeferred) => {
    resolvePromise = resolveDeferred;
    rejectPromise = rejectDeferred;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

/**
 * How long a browser turn keeps running after its client goes away, so a Codex reconnect can
 * re-attach to the work in progress instead of paying for a fresh turn. Past it, an abandoned turn
 * is stopped rather than left generating an answer nobody will read.
 */
const CHATGPT_CLIENT_ABANDON_GRACE_MS = 60_000;

/**
 * When fit recovery is discarding this much of a turn's history, replaying a checkpoint the model
 * wrote about that history beats replaying nothing. Below it, the history is worth more than the
 * summary: a real session kept 8 messages of 70 at its worst, which is the case this is for.
 */
const CHATGPT_CHECKPOINT_MIN_OMITTED = 8;
const CHATGPT_CHECKPOINT_OMITTED_FRACTION = 4;

/**
 * Whether this turn is losing enough history that a summary of it beats what survives. Replacing
 * the conversation with a précis is the wrong trade for an ordinary trim - two messages of seventy
 * are not worth the other sixty-eight - and the right one once the loss is structural.
 */
export function chatGptWebHistoryIsCollapsing(omitted: number, carried: number): boolean {
  return omitted >= Math.max(
    CHATGPT_CHECKPOINT_MIN_OMITTED,
    Math.floor(carried / CHATGPT_CHECKPOINT_OMITTED_FRACTION),
  );
}

/**
 * A tool-capable compile refuses to run without a broker token, and the pressure probe has no turn
 * to bind to. A real capability is the same length, so the measured prompt matches the one that will
 * actually be sent - the same substitution `usage.ts` makes for its estimates.
 */
const CHATGPT_PRESSURE_PROBE_TOKEN = "turn_00000000000000000000000000000000";

function abortError(): DOMException {
  return new DOMException("ChatGPT web turn aborted", "AbortError");
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolveWait, rejectWait) => {
    const onAbort = () => rejectWait(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolveWait(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        rejectWait(error);
      },
    );
  });
}

function structuredContent(text: string): unknown | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function brokerContent(content: string | CodexContentPart[]): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map(part => {
    if (part.type === "text") return { type: "text", text: part.text };
    const parsed = parseDataUrl(part.imageUrl);
    if (parsed) return { type: "image", data: parsed.base64, mimeType: parsed.mediaType };
    return { type: "resource_link", uri: part.imageUrl, name: "Codex tool image", mimeType: "image/*" };
  });
}

function brokerResult(message: CodexToolResultMessage): BrokerToolResult {
  const content = brokerContent(message.content);
  const text = typeof message.content === "string"
    ? message.content
    : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
  const structured = structuredContent(text);
  return {
    content,
    ...(structured !== undefined ? { structuredContent: structured } : {}),
    ...(message.isError ? { isError: true } : {}),
  };
}

function emitToolBatch(requests: BrokerToolRequest[], usage: CodexUsage, emit: (event: AdapterEvent) => void): void {
  for (const request of requests) {
    emit({ type: "tool_call_start", id: request.callId, name: request.wireName });
    emit({
      type: "tool_call_delta",
      arguments: request.freeform
        ? JSON.stringify({ input: request.input ?? "" })
        : JSON.stringify(request.arguments ?? {}),
    });
    emit({ type: "tool_call_end" });
  }
  emit({ type: "done", stopReason: "tool_use", endTurn: false, usage });
}

function emitBrowserCompletion(outcome: ChatGptBrowserOutcome, usage: CodexUsage, emit: (event: AdapterEvent) => void): void {
  if (outcome.type === "error") throw outcome.error;
  emit({ type: "done", stopReason: "stop", endTurn: true, usage });
}

function emitTraceEvents(trace: ChatGptTraceEvent[], emit: (event: AdapterEvent) => void): void {
  for (const event of trace) {
    if (!event.continuation) emit({ type: "assistant_boundary" });
    if (event.kind === "commentary") {
      emit({ type: "text_delta", text: event.text, phase: "commentary" });
    } else {
      emit({ type: "thinking_delta", thinking: event.text });
    }
  }
}

function emitTextDeltas(deltas: string[], emit: (event: AdapterEvent) => void): void {
  for (const text of deltas) emit({ type: "text_delta", text, phase: "final_answer" });
}

function emitReadOnlyContextWarning(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  emit: (event: AdapterEvent) => void,
): void {
  const warning = chatGptReadOnlyContextWarning(parsed, capabilities);
  if (!warning) return;
  emit({ type: "assistant_boundary" });
  emit({ type: "text_delta", text: warning, phase: "commentary" });
  emit({ type: "assistant_boundary" });
}

function replayEvents(events: AdapterEvent[], emit: (event: AdapterEvent) => void): void {
  for (const event of events) emit(event);
}

function currentToolResults(parsed: CodexParsedRequest, session: ChatGptTurnSession): CodexToolResultMessage[] {
  const byId = new Map<string, CodexToolResultMessage>();
  for (const message of parsed.context.messages) {
    if (message.role !== "toolResult" || !session.hasOutstanding(message.toolCallId)) continue;
    if (byId.has(message.toolCallId)) throw new Error(`Codex returned duplicate results for tool call ${message.toolCallId}`);
    byId.set(message.toolCallId, message);
  }
  return [...byId.values()];
}

function validateBatchTools(parsed: CodexParsedRequest, requests: BrokerToolRequest[]): void {
  const available = new Set((parsed.context.tools ?? []).map(tool => namespacedToolName(tool.namespace, tool.name)));
  for (const request of requests) {
    if (!available.has(request.wireName)) {
      throw new Error(`ChatGPT requested a tool that the active Codex round did not advertise: ${request.wireName}`);
    }
  }
}

export function createChatGptWebAdapter(
  provider: CodexProviderConfig,
  dependencies: { broker?: TurnBrokerOwner } = {},
): ProviderAdapter {
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const broker = dependencies.broker ?? TurnBroker.forSocket(brokerSocketPath(provider));
  const timeoutMs = provider.chatgptWeb?.turnTimeoutMs;
  const configuredCapabilities: ChatGptWebCapabilities = {
    localToolsEnabled: provider.chatgptWeb?.localToolsEnabled === true,
    solAvailable: provider.chatgptWeb?.solAvailable !== false,
    proAvailable: provider.chatgptWeb?.proAvailable === true,
  };
  const executionNamespace = createHash("sha256").update(JSON.stringify({
    baseUrl: provider.baseUrl,
    chatgptWeb: provider.chatgptWeb ?? {},
  })).digest("hex");
  const environmentStore = new ChatGptThreadEnvironmentStore(
    provider.chatgptWeb?.threadEnvironmentStatePath
      ? resolve(expandUserPath(provider.chatgptWeb.threadEnvironmentStatePath))
      : undefined,
  );
  const lunaCheckpointStore = new ChatGptLunaCheckpointStore(
    provider.chatgptWeb?.lunaCheckpointStatePath
      ? resolve(expandUserPath(provider.chatgptWeb.lunaCheckpointStatePath))
      : undefined,
  );
  const currentUsageInput = (parsed: CodexParsedRequest): CodexParsedRequest => (
    parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID && !parsed._compactionRequest
      ? lunaCheckpointStore.apply(parsed).parsed
      : parsed
  );

  const startRuntime = (
    parsed: CodexParsedRequest,
    environment: ReturnType<typeof extractChatGptTurnEnvironment> | undefined,
    traceId: string,
    turnCapabilities: ChatGptWebCapabilities,
  ): ChatGptTurnRuntime => {
    const mode = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities);
    const identity = extractChatGptTurnIdentity(parsed);
    const lunaTurn = parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID;
    const checkpointEligible = !parsed._compactionRequest && Boolean(identity.threadId && identity.turnId);

    // Luna always rides the checkpoint: its ceiling is the browser envelope, not the model window.
    // Every other mode pays for the composer ceiling in discarded history instead, and only finds
    // out after compiling. Compiling twice to learn that costs a millisecond - it was measured at 1ms
    // median, 35ms at worst - which buys the difference between summarising the history and losing it.
    const pressure = !lunaTurn && checkpointEligible
      ? compileChatGptWebPrompt(
        parsed,
        turnCapabilities,
        mode.localTools ? CHATGPT_PRESSURE_PROBE_TOKEN : undefined,
      )
      : undefined;
    const omitted = pressure?.omittedMessages ?? 0;
    const carried = pressure?.sourceMessages ?? 0;

    // Writing a checkpoint costs output tokens on every turn that asks for one, so it starts only
    // once a turn has actually begun losing history - which is also when the next turn will want it.
    const captureLunaCheckpoint = checkpointEligible && (lunaTurn || omitted > 0);

    // Replacing the whole history with a summary is the right trade only against a large loss.
    // Losing two messages out of seventy is not worth trading sixty-eight real ones for a précis.
    const historyCollapsing = chatGptWebHistoryIsCollapsing(omitted, carried);
    const checkpointInput = checkpointEligible && (lunaTurn || historyCollapsing)
      ? lunaCheckpointStore.apply(parsed)
      : { parsed, applied: false };
    if (captureLunaCheckpoint) {
      console.info(
        `[chatgpt-web] rolling checkpoint capture=on applied=${checkpointInput.applied}`
        + `${checkpointInput.reason ? ` reason=${checkpointInput.reason}` : ""}`
        + `${lunaTurn ? "" : ` omitted=${omitted}/${carried}`}`,
      );
      // The applied path cannot be replayed offline: it needs a stored checkpoint whose hash matches
      // the exact parent answer. Record each decision so the trade can be read from real turns.
      // `gate` and `detail` name the step that decided and what it saw: eleven recorded decisions
      // have never once applied, and all four taken under real pressure stopped at the same gate,
      // which the reason string alone could not have told us.
      if (!lunaTurn) {
        appendDiagnosticRecord("checkpoint.jsonl", {
          traceId,
          omitted,
          carried,
          collapsing: historyCollapsing,
          applied: checkpointInput.applied,
          ...(checkpointInput.reason ? { reason: checkpointInput.reason } : {}),
          ...(checkpointInput.gate ? { gate: checkpointInput.gate } : {}),
          ...(checkpointInput.detail ? { detail: checkpointInput.detail } : {}),
        });
      }
    }
    let capturedCheckpoint: CapturedChatGptLunaCheckpoint | undefined;
    let checkpointCaptureError: Error | undefined;
    const captureCheckpoint = (captured: CapturedChatGptLunaCheckpoint): void => {
      if (capturedCheckpoint) {
        checkpointCaptureError = new Error("ChatGPT Luna emitted more than one rolling checkpoint");
        return;
      }
      capturedCheckpoint = captured;
    };
    const finalizeCheckpoint = (browser: Promise<string>): Promise<string> => browser.then(answer => {
      if (!captureLunaCheckpoint) return answer;
      if (checkpointCaptureError) throw checkpointCaptureError;
      if (capturedCheckpoint) lunaCheckpointStore.commit(parsed, capturedCheckpoint, answer);
      return answer;
    });
    // Every turn otherwise opens a fresh Temporary Chat, so the instruction contract - about a fifth
    // of the composer budget, and identical between turns - is retyped each time. Keeping one
    // conversation per session and sending only the tail removes that cost, but only while both
    // sides still agree on what was already said; when they do not, this rotates to a new
    // conversation and replays everything, which is exactly the behaviour without the flag.
    const persistentConversation = provider.chatgptWeb?.persistentConversation === true
      && !parsed._compactionRequest
      && !lunaTurn
      && Boolean(identity.threadId);
    let promptInput = checkpointInput.parsed;
    let conversation: BrowserTurn["conversation"];
    if (persistentConversation) {
      const sessionKey = `${executionNamespace}:${identity.threadId}`;
      const messages = checkpointInput.parsed.context.messages;
      const signatures = chatGptMessageSignatures(messages);
      const view = chatGptConversationViews.get(sessionKey);
      const delta = chatGptConversationDelta(view, messages);
      const remember = (conversationUrl: string): void => {
        chatGptConversationViews.remember(sessionKey, conversationUrl, signatures);
      };
      if (delta.kind === "append" && view) {
        promptInput = {
          ...checkpointInput.parsed,
          context: { ...checkpointInput.parsed.context, messages: delta.messages },
        };
        conversation = { resumeUrl: view.conversationId, onEstablished: remember };
        appendDiagnosticRecord("conversation.jsonl", {
          kind: "append",
          seenMessages: view.signatures.length,
          totalMessages: messages.length,
          sentMessages: delta.messages.length,
        });
      } else {
        // Rotation is the safety valve, not a failure: the worst case is one full replay, which is
        // what every turn costs today.
        chatGptConversationViews.forget(sessionKey);
        conversation = { resumeUrl: CHATGPT_NEW_CHAT_URL, onEstablished: remember };
        if (delta.kind === "rotate") {
          // The reason only ever reached stdout, which the launcher discards, so a rotation that
          // should not have happened left nothing behind to diagnose. Record it instead.
          const diverged = delta.divergedAt === undefined ? undefined : messages[delta.divergedAt];
          appendDiagnosticRecord("conversation.jsonl", {
            kind: "rotate",
            reason: delta.reason,
            seenMessages: view?.signatures.length ?? 0,
            totalMessages: messages.length,
            ...(delta.divergedAt === undefined ? {} : {
              divergedAt: delta.divergedAt,
              divergedRole: diverged?.role,
              divergedChars: textFromContent(diverged?.content as never).length,
            }),
          });
          console.info(
            `[chatgpt-web] conversation rotated (${delta.reason}`
            + `${delta.divergedAt === undefined ? "" : `, divergedAt=${delta.divergedAt}`})`,
          );
        }
      }
    }
    const browserAbort = new AbortController();
    const trace = new ChatGptTraceFeed();
    const text = new ChatGptTextFeed();
    if (!mode.localTools) {
      const browser = finalizeCheckpoint(worker.run({
        traceId,
        modelId: parsed.modelId,
        reasoning: parsed.options.reasoning,
        capabilities: turnCapabilities,
        prepare: async () => ({
          ...compileChatGptWebPrompt(
            promptInput,
            turnCapabilities,
            undefined,
            { captureLunaCheckpoint },
          ),
          release: () => {},
        }),
        abortSignal: browserAbort.signal,
        ...(parsed._compactionRequest ? { compaction: true } : {}),
        onReasoningSummary: (text, continuation) => trace.push({ kind: "reasoning", text, ...(continuation ? { continuation: true } : {}) }),
        onCommentary: (text, continuation) => trace.push({ kind: "commentary", text, ...(continuation ? { continuation: true } : {}) }),
        onTextDelta: delta => text.push(delta),
        ...(conversation ? { conversation } : {}),
        ...(captureLunaCheckpoint ? {
          captureLunaCheckpoint: true,
          onLunaCheckpoint: captureCheckpoint,
        } : {}),
      }));
      return {
        mode: "read-only",
        browser,
        trace,
        text,
        cancel: () => browserAbort.abort(),
      };
    }
    if (!environment) throw new Error("Tool-capable ChatGPT web mode requires a trusted Codex environment");
    const token = deferred<string>();
    let tokenSettled = false;
    let activeToken: string | undefined;
    const browser = finalizeCheckpoint(worker.run({
      traceId,
      modelId: parsed.modelId,
      reasoning: parsed.options.reasoning,
      capabilities: turnCapabilities,
      prepare: async () => {
        const turnToken = await broker.register(
          environment,
          timeoutMs === undefined ? undefined : timeoutMs + 60_000,
          traceId,
        );
        activeToken = turnToken;
        tokenSettled = true;
        token.resolve(turnToken);
        try {
          const compiled = compileChatGptWebPrompt(
            promptInput,
            turnCapabilities,
            turnToken,
            { captureLunaCheckpoint },
          );
          return { ...compiled, release: () => {} };
        } catch (error) {
          await broker.revoke(turnToken);
          throw error;
        }
      },
      abortSignal: browserAbort.signal,
      ...(parsed._compactionRequest ? { compaction: true } : {}),
      onReasoningSummary: (text, continuation) => trace.push({ kind: "reasoning", text, ...(continuation ? { continuation: true } : {}) }),
      onCommentary: (text, continuation) => trace.push({ kind: "commentary", text, ...(continuation ? { continuation: true } : {}) }),
      onTextDelta: delta => text.push(delta),
      ...(conversation ? { conversation } : {}),
      ...(captureLunaCheckpoint ? {
        captureLunaCheckpoint: true,
        onLunaCheckpoint: captureCheckpoint,
      } : {}),
    }));
    void browser.catch(error => {
      if (!tokenSettled) {
        tokenSettled = true;
        token.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return {
      mode: "tools",
      token: token.promise,
      browser,
      trace,
      text,
      cancel: () => {
        browserAbort.abort();
        if (activeToken) {
          void Promise.resolve(broker.revoke(activeToken)).catch(error => {
            console.error(`[chatgpt-web] failed to revoke cancelled turn token: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
      },
    };
  };

  return {
    name: "chatgpt-web",
    async runTurn(parsed, incoming, emit) {
      if (parsed._opaqueMultiAgentV2Payload) {
        throw new Error(
          "ChatGPT Web subagents currently require a V1-rooted task. "
          + "Refresh the Codex model catalog and start a new task; an existing V2 task cannot migrate surfaces. "
          + "Codex MultiAgent V2 encrypts cross-backend task payloads.",
        );
      }
      const turnCapabilities = parsed._compactionRequest
        ? { ...configuredCapabilities, localToolsEnabled: false }
        : configuredCapabilities;
      const mode = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities);
      const retryKey = `${executionNamespace}:${chatGptTurnRetryKey(parsed)}`;
      const exhaustedRetry = chatGptWebTurnRetryPolicy.exhaustedError(retryKey);
      if (exhaustedRetry) {
        emit({
          type: "error",
          message: exhaustedRetry.message,
          status: exhaustedRetry.status,
          errorType: exhaustedRetry.errorType,
          code: exhaustedRetry.code,
          retryable: false,
        });
        return;
      }
      let environment: ReturnType<typeof extractChatGptTurnEnvironment> | undefined;
      if (mode.localTools) {
        try {
          environment = environmentStore.resolve(parsed);
        } catch (error) {
          const identity = extractChatGptTurnIdentity(parsed);
          console.warn(
            `[chatgpt-web] trusted environment unavailable (thread_id=${identity.threadId ? "present" : "missing"}, turn_id=${identity.turnId ? "present" : "missing"}, previous_response_id=${parsed.previousResponseId ?? "none"}, replay_prefix_items=${parsed._replayPrefixLen ?? 0}, context_messages=${parsed.context.messages.length})`,
          );
          throw error;
        }
      }
      if (parsed._compactionRequest) {
        const responseExecutionKey = `${executionNamespace}:${chatGptCompactionSourceExecutionKey(parsed)}`;
        await chatGptTurnSessions.retireAndWait(responseExecutionKey);
      }
      const executionKey = `${executionNamespace}:${chatGptTurnExecutionKey(parsed)}`;
      await chatGptTurnSessions.waitForRetirement(executionKey);
      const traceId = createHash("sha256").update(executionKey).digest("hex").slice(0, 12);
      const session = chatGptTurnSessions.getOrCreate(
        executionKey,
        () => startRuntime(parsed, environment, traceId, turnCapabilities),
      );
      // A client that closes the stream looks the same whether the user pressed stop or the
      // connection blipped, so the session is deliberately kept alive for a reconnect to re-attach.
      // Nothing ever ended it in the first case: pressing stop left ChatGPT generating to the end,
      // holding a browser tab and spending the account's quota on an answer nobody would read, until
      // the registry's thirty minute TTL got around to it. Give the reconnect its window, then stop.
      const abandonIfUnclaimed = (): void => {
        const abandonedAt = Date.now();
        setTimeout(() => {
          if (!session.isActive()) return;
          if (session.lastUsedAt() > abandonedAt) return;
          chatGptTurnSessions.retire(executionKey, session);
        }, CHATGPT_CLIENT_ABANDON_GRACE_MS);
      };
      if (incoming.abortSignal?.aborted) abandonIfUnclaimed();
      else incoming.abortSignal?.addEventListener("abort", abandonIfUnclaimed, { once: true });

      const heartbeat = setInterval(() => emit({ type: "heartbeat" }), 10_000);
      try {
        emit({ type: "heartbeat" });
        await session.runExclusive(async () => {
          const settled = session.settledOutcome();
          if (settled) {
            if (settled.type === "error") throw settled.error;
            let reasoning = session.reasoningForFinalReplay();
            let answer = settled.answer;
            const replay = session.eventsForFinalReplay();
            if (replay.length > 0) {
              replayEvents(replay, emit);
            } else {
              const events: AdapterEvent[] = [];
              const emitCaptured = (event: AdapterEvent) => {
                events.push(event);
                emit(event);
              };
              if (!parsed._compactionRequest) emitReadOnlyContextWarning(parsed, turnCapabilities, emitCaptured);
              const trace = session.runtime.trace.drain();
              reasoning = trace.map(event => event.text);
              emitTraceEvents(trace, emitCaptured);
              emitTextDeltas(session.runtime.text.drain(), emitCaptured);
              if (session.runtime.text.value() !== settled.answer) {
                throw new Error("ChatGPT browser Markdown stream did not reproduce the completed answer");
              }
              // A tool loop usually settles the browser answer before Codex comes back for it, so
              // this replay - not the live branch below - is where a Visualize turn finishes. The
              // artifact repair has to run here too, and its delta belongs in the stored events so
              // later replays of the same outcome stay identical.
              const repaired = repairMissingFinalArtifactReference(parsed, settled.answer);
              if (repaired.delta) {
                emitTextDeltas([repaired.delta], emitCaptured);
                console.info("[chatgpt-web] restored missing Codex visualization reference in settled answer");
              }
              answer = repaired.answer;
              session.setFinalReasoning(reasoning);
              session.setFinalEvents(events);
            }
            emitBrowserCompletion(settled, estimateChatGptWebUsage(currentUsageInput(parsed), { answer, reasoning }, turnCapabilities), emit);
            chatGptWebTurnRetryPolicy.clear(retryKey);
            return;
          }

          let turnToken: string | undefined;
          if (session.runtime.mode === "tools") {
            turnToken = await withAbort(session.runtime.token, incoming.abortSignal);
            if (!environment) throw new Error("Tool-capable ChatGPT web runtime lost its trusted environment");
            await broker.updateEnvironment(turnToken, environment);

            const outstanding = session.outstanding();
            if (outstanding.length > 0) {
              const results = currentToolResults(parsed, session);
              if (results.length === 0) {
                const reasoning = session.reasoningForOutstandingReplay();
                replayEvents(session.eventsForOutstandingReplay(), emit);
                emitToolBatch(outstanding, estimateChatGptWebUsage(currentUsageInput(parsed), { reasoning, toolRequests: outstanding }, turnCapabilities), emit);
                return;
              }
              if (results.length !== outstanding.length) {
                throw new Error(`Codex returned ${results.length} of ${outstanding.length} results for a parallel ChatGPT tool batch`);
              }
              for (const message of results) {
                await broker.completeTool(turnToken, message.toolCallId, brokerResult(message));
                session.markResultDelivered(message.toolCallId);
              }
            }
          } else if (session.outstanding().length > 0) {
            throw new Error("Read-only ChatGPT Web runtime cannot own local tool calls");
          }

          const toolWaitAbort = new AbortController();
          try {
            const roundReasoning: string[] = [];
            const roundEvents: AdapterEvent[] = [];
            const emitRound = (event: AdapterEvent) => {
              roundEvents.push(event);
              emit(event);
            };
            const emitNewTrace = (trace: ChatGptTraceEvent[]) => {
              roundReasoning.push(...trace.map(event => event.text));
              emitTraceEvents(trace, emitRound);
            };
            const emitNewText = (deltas: string[]) => emitTextDeltas(deltas, emitRound);
            if (!parsed._compactionRequest) emitReadOnlyContextWarning(parsed, turnCapabilities, emitRound);
            emitNewTrace(session.runtime.trace.drain());
            emitNewText(session.runtime.text.drain());
            const nextTools = turnToken
              ? broker.nextToolBatch(turnToken, toolWaitAbort.signal).then(requests => ({ type: "tools" as const, requests }))
              : undefined;
            const browserOutcome = session.browserOutcome.then(outcome => ({ type: "browser" as const, outcome }));
            let nextTrace = session.runtime.trace.next(toolWaitAbort.signal).then(event => ({ type: "trace" as const, event }));
            let nextText = session.runtime.text.wait(toolWaitAbort.signal).then(() => ({ type: "text" as const }));
            for (;;) {
              const next = await withAbort(
                Promise.race([
                  ...(nextTools ? [nextTools] : []),
                  browserOutcome,
                  nextTrace,
                  nextText,
                ]),
                incoming.abortSignal,
              );
              if (next.type === "trace") {
                emitNewTrace([next.event]);
                nextTrace = session.runtime.trace.next(toolWaitAbort.signal).then(event => ({ type: "trace" as const, event }));
                continue;
              }
              if (next.type === "text") {
                emitNewText(session.runtime.text.drain());
                nextText = session.runtime.text.wait(toolWaitAbort.signal).then(() => ({ type: "text" as const }));
                continue;
              }
              emitNewTrace(session.runtime.trace.drain());
              emitNewText(session.runtime.text.drain());
              if (next.type === "browser") {
                session.setFinalReasoning(roundReasoning);
                session.setFinalEvents(roundEvents);
                if (turnToken) await broker.revoke(turnToken);
                if (next.outcome.type === "error") throw next.outcome.error;
                if (session.runtime.text.value() !== next.outcome.answer) {
                  throw new Error("ChatGPT browser Markdown stream did not reproduce the completed answer");
                }
                const repaired = repairMissingFinalArtifactReference(parsed, next.outcome.answer);
                if (repaired.delta) {
                  emitNewText([repaired.delta]);
                  console.info("[chatgpt-web] restored missing Codex visualization reference in final answer");
                }
                session.setFinalReasoning(roundReasoning);
                session.setFinalEvents(roundEvents);
                emitBrowserCompletion(
                  next.outcome,
                  estimateChatGptWebUsage(currentUsageInput(parsed), { answer: repaired.answer, reasoning: roundReasoning }, turnCapabilities),
                  emit,
                );
                chatGptWebTurnRetryPolicy.clear(retryKey);
                return;
              }
              if (!turnToken || session.runtime.mode !== "tools") {
                throw new Error("Read-only ChatGPT Web runtime received a broker tool batch");
              }
              if (next.requests.length === 0) throw new Error("ChatGPT tool bridge returned an empty batch");
              validateBatchTools(parsed, next.requests);
              session.setOutstanding(next.requests, roundReasoning, roundEvents);
              emitToolBatch(
                next.requests,
                estimateChatGptWebUsage(currentUsageInput(parsed), { reasoning: roundReasoning, toolRequests: next.requests }, turnCapabilities),
                emit,
              );
              return;
            }
          } finally {
            toolWaitAbort.abort();
          }
        });
      } catch (error) {
        // A failed turn only left a diagnostics directory that later turns rotate away, so after the
        // fact there was no way to say what actually breaks - the question could not be answered
        // even once. An unclassified failure is the expensive kind: it is rethrown rather than
        // reported, and the client answers by replaying the whole turn.
        //
        // A turn the user interrupted arrives here as an AbortError, and it is not a failure. Every
        // interruption would otherwise be filed as the expensive unclassified kind and the log would
        // read as constant breakage while the user was simply steering.
        // A stage timeout also arrives as an AbortError, so filing neither left four failed attempts
        // of one turn with no record at all, and the log read as a clean run for one that visibly
        // struggled. Record both and mark which is which, so an interruption still does not read as
        // breakage while a timeout stops being invisible.
        const aborted = error instanceof Error && error.name === "AbortError";
        appendDiagnosticRecord("turn-failures.jsonl", {
          traceId,
          ...(aborted ? { aborted: true } : {}),
          mode: session.runtime.mode,
          classified: error instanceof ChatGptWebAdapterError,
          retryable: error instanceof ChatGptWebAdapterError ? error.retryable : false,
          code: error instanceof ChatGptWebAdapterError ? error.code : "unclassified",
          name: error instanceof Error ? error.name : typeof error,
          message: (error instanceof Error ? error.message : String(error)).slice(0, 400),
        });
        const handledError = error instanceof ChatGptWebAdapterError && error.retryable
          ? chatGptWebTurnRetryPolicy.recordRetryableFailure(retryKey, error)
          : error;
        if (!(error instanceof ChatGptWebAdapterError && error.retryable)) {
          chatGptWebTurnRetryPolicy.clear(retryKey);
        }
        if (handledError instanceof ChatGptWebAdapterError && !handledError.retryable) {
          // A deterministic request failure remains replayable so a native reconnect cannot burn
          // another browser attempt. Every other failure retires the browser session: client
          // disconnects, stage failures, and retryable ChatGPT errors must start a fresh surface
          // instead of replaying one rejected browser outcome for the registry's full TTL.
          session.cancel();
        } else {
          chatGptTurnSessions.retire(executionKey, session);
        }
        if (session.runtime.mode === "tools") {
          void session.runtime.token.then(turnToken => broker.revoke(turnToken)).catch(() => {});
        }
        if (handledError instanceof ChatGptWebAdapterError) {
          emit({
            type: "error",
            message: handledError.message,
            status: handledError.status,
            errorType: handledError.errorType,
            code: handledError.code,
            retryable: handledError.retryable,
          });
          return;
        }
        chatGptWebTurnRetryPolicy.clear(retryKey);
        throw error;
      } finally {
        clearInterval(heartbeat);
      }
    },
  };
}
