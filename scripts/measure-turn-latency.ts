/**
 * Aggregates the per-checkpoint timestamps the browser worker already records into a latency table.
 *
 * Every browser turn writes `~/.codex-chatgpt-web/diagnostics/browser-turns/<turn>/NN-<checkpoint>.json`
 * with a `capturedAt`, which makes the cost of each setup step measurable after the fact - but only
 * one turn at a time and only by hand. This turns the whole directory into medians, so a change to
 * the browser path can be accepted or rejected on evidence instead of on the assumption that fewer
 * milliseconds in a constant means fewer milliseconds in a turn.
 *
 * Usage: bun run scripts/measure-turn-latency.ts [--since <ISO timestamp>]
 */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TURNS_ROOT = join(homedir(), ".codex-chatgpt-web", "diagnostics", "browser-turns");

const sinceArgument = process.argv.indexOf("--since");
const since = sinceArgument >= 0 ? Date.parse(process.argv[sinceArgument + 1] ?? "") : Number.NaN;
if (sinceArgument >= 0 && Number.isNaN(since)) {
  throw new Error("--since needs an ISO timestamp, for example 2026-08-22T02:00:00Z");
}

interface Checkpoint {
  name: string;
  at: number;
}

/** `08-connector-mention-triggered.json` -> `connector-mention-triggered`. */
function checkpointName(fileName: string): string {
  return fileName.replace(/\.json$/, "").replace(/^\d+-/, "");
}

function turnCheckpoints(directory: string): Checkpoint[] {
  const checkpoints: Checkpoint[] = [];
  for (const fileName of readdirSync(directory).sort()) {
    if (!fileName.endsWith(".json")) continue;
    let record: { capturedAt?: string };
    try {
      record = JSON.parse(readFileSync(join(directory, fileName), "utf8")) as typeof record;
    } catch {
      continue;
    }
    const at = Date.parse(record.capturedAt ?? "");
    if (Number.isNaN(at)) continue;
    checkpoints.push({ name: checkpointName(fileName), at });
  }
  return checkpoints.sort((left, right) => left.at - right.at);
}

const durations = new Map<string, number[]>();
let turns = 0;
for (const entry of readdirSync(TURNS_ROOT, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const checkpoints = turnCheckpoints(join(TURNS_ROOT, entry.name));
  if (checkpoints.length < 2) continue;
  if (!Number.isNaN(since) && checkpoints[0]!.at < since) continue;
  turns += 1;
  for (let index = 1; index < checkpoints.length; index += 1) {
    const step = checkpoints[index]!;
    const seconds = (step.at - checkpoints[index - 1]!.at) / 1_000;
    const samples = durations.get(step.name) ?? [];
    samples.push(seconds);
    durations.set(step.name, samples);
  }
}

if (turns === 0) {
  console.log(`No browser turns recorded under ${TURNS_ROOT}${Number.isNaN(since) ? "" : " after --since"}`);
  process.exit(0);
}

// Ranked by total time spent, so the step worth attacking is the first row rather than the widest.
const rows = [...durations.entries()]
  .map(([name, samples]) => {
    const sorted = [...samples].sort((left, right) => left - right);
    return {
      name,
      count: sorted.length,
      median: sorted[sorted.length >> 1]!,
      max: sorted.at(-1)!,
      total: sorted.reduce((sum, value) => sum + value, 0),
    };
  })
  .sort((left, right) => right.total - left.total);

console.log(`${turns} browser turns under ${TURNS_ROOT}\n`);
console.log(`${"step".padEnd(42)}${"n".padStart(4)}${"median s".padStart(11)}${"max s".padStart(10)}`);
for (const row of rows) {
  console.log(
    `${row.name.padEnd(42)}${String(row.count).padStart(4)}`
    + `${row.median.toFixed(2).padStart(11)}${row.max.toFixed(2).padStart(10)}`,
  );
}
