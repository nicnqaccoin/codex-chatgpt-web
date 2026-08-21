import type { CodexMessage, CodexParsedRequest } from "../../types";

const VISUALIZE_PLUGIN = /plugin:\/\/visualize@openai-bundled/i;
const VISUALIZE_REFERENCE = /visualize(\{[^\r\n]*\})/g;
const PATCHED_HTML_LINE = /^\s*[AM]\s+(.+?\.html)\s*$/i;

function isAbsoluteHtmlPath(path: string): boolean {
  return (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/"))
    && !/[\u0000-\u001f"<>|]/.test(path);
}

function textContent(content: CodexMessage["content"]): string {
  if (typeof content === "string") return content;
  const text: string[] = [];
  for (const part of content) {
    if (part.type === "text") text.push(part.text);
  }
  return text.join("\n");
}

function latestUserIndex(messages: readonly CodexMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.role === "user") return index;
  }
  return -1;
}

function artifactDirectory(path: string): string {
  return path.replace(/[\\/][^\\/]+$/, "").replaceAll("\\", "/").toLowerCase();
}

function priorVisualizationDirectories(
  messages: readonly CodexMessage[],
  beforeIndex: number,
): Set<string> {
  const directories = new Set<string>();
  for (const message of messages.slice(0, beforeIndex)) {
    if (message.role !== "assistant") continue;
    for (const match of textContent(message.content).matchAll(VISUALIZE_REFERENCE)) {
      try {
        const reference = JSON.parse(match[1]!) as { path?: unknown };
        if (typeof reference.path === "string" && isAbsoluteHtmlPath(reference.path)) {
          directories.add(artifactDirectory(reference.path));
        }
      } catch {
        // Ignore malformed historical directives; only valid prior artifacts establish continuity.
      }
    }
  }
  return directories;
}

/**
 * Recover the artifact reference required by the bundled Visualize skill from trusted successful
 * apply_patch output. ChatGPT Web occasionally finishes with prose after creating the HTML and
 * omits the Codex-only content-reference directive, leaving the app's Result panel empty.
 */
export function requiredVisualizationReference(parsed: CodexParsedRequest): string | undefined {
  if (parsed._compactionRequest) return undefined;
  const messages = parsed.context.messages;
  const userIndex = latestUserIndex(messages);
  if (userIndex < 0) return undefined;
  const user = messages[userIndex]!;
  if (user.role !== "user") return undefined;
  const explicitInvocation = VISUALIZE_PLUGIN.test(textContent(user.content));
  const inheritedDirectories = priorVisualizationDirectories(messages, userIndex);
  if (!explicitInvocation && inheritedDirectories.size === 0) return undefined;

  let visualizationPath: string | undefined;
  for (const message of messages.slice(userIndex + 1)) {
    if (
      message.role !== "toolResult"
      || message.isError
      || !/(^|__)apply_patch$/i.test(message.toolName)
    ) continue;
    for (const line of textContent(message.content).split(/\r?\n/)) {
      const path = PATCHED_HTML_LINE.exec(line)?.[1]?.trim();
      if (
        path
        && isAbsoluteHtmlPath(path)
        && (explicitInvocation || inheritedDirectories.has(artifactDirectory(path)))
      ) visualizationPath = path;
    }
  }
  if (!visualizationPath) return undefined;
  return `visualize${JSON.stringify({ path: visualizationPath })}`;
}

export function repairMissingFinalArtifactReference(
  parsed: CodexParsedRequest,
  answer: string,
): { answer: string; delta: string } {
  const reference = requiredVisualizationReference(parsed);
  if (!reference || answer.includes(reference)) return { answer, delta: "" };
  const separator = !answer ? "" : answer.endsWith("\n\n") ? "" : answer.endsWith("\n") ? "\n" : "\n\n";
  const delta = `${separator}${reference}`;
  return { answer: `${answer}${delta}`, delta };
}
