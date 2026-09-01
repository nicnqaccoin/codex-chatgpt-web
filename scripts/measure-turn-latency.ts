/**
 * Aggregates the per-checkpoint timestamps the browser worker already records into a latency table.
 *
 * Every browser turn writes `~/.codex-chatgpt-web/diagnostics/browser-turns/<turn>/NN-<checkpoint>.json`
 * with a `capturedAt`, which makes the cost of each setup step measurable after the fact - but only
 * one turn at a time and only by hand. This turns the whole directory into medians, so a change to
 * the browser path can be accepted or rejected on evidence instead of on the assumption that fewer
 * milliseconds in a constant means fewer milliseconds in a turn.
 *
 * Usage: bun run scripts/measure-turn-latency.ts [--since <ISO>] [--until <ISO>] [--per-turn]
 */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TURNS_ROOT = join(homedir(), ".codex-chatgpt-web", "diagnostics", "browser-turns");

function isoArgument(flag: string): number {
  const index = process.argv.indexOf(flag);
  if (index < 0) return Number.NaN;
  const value = Date.parse(process.argv[index + 1] ?? "");
  if (Number.isNaN(value)) throw new Error(`${flag} needs an ISO timestamp, for example 2026-08-22T02:00:00Z`);
  return value;
}

const since = isoArgument("--since");
const until = isoArgument("--until");
const perTurn = process.argv.includes("--per-turn");

interface Checkpoint {
  name: string;
  at: number;
}

/** `08-connector-mention-triggered.json` -> `connector-mention-triggered`. */
function checkpointName(fileName: string): string {
  return fileName.replace(/\.json$/, "").replace(/^\d+-/, "");
}

function turnCheckpoints(directory: string): { checkpoints: Checkpoint[]; build: string } {
  const checkpoints: Checkpoint[] = [];
  let runtimeVersion = "unknown";
  let buildId = "";
  for (const fileName of readdirSync(directory).sort()) {
    if (!fileName.endsWith(".json")) continue;
    let record: { capturedAt?: string; runtimeVersion?: string; buildId?: string };
    try {
      record = JSON.parse(readFileSync(join(directory, fileName), "utf8")) as typeof record;
    } catch {
      continue;
    }
    if (typeof record.runtimeVersion === "string") runtimeVersion = record.runtimeVersion;
    if (typeof record.buildId === "string") buildId = record.buildId;
    const at = Date.parse(record.capturedAt ?? "");
    if (Number.isNaN(at)) continue;
    checkpoints.push({ name: checkpointName(fileName), at });
  }
  // Two same-semver builds are different bundles; identify by version+buildId so A/B never averages
  // across them. Old records with no buildId collapse to the version alone.
  const build = buildId ? `${runtimeVersion}+${buildId}` : runtimeVersion;
  return { checkpoints: checkpoints.sort((left, right) => left.at - right.at), build };
}

const durations = new Map<string, number[]>();
const versions = new Map<string, number>();
const perTurnRows: Array<{ turn: string; version: string; totalSec: number; steps: number }> = [];
let turns = 0;
for (const entry of readdirSync(TURNS_ROOT, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const { checkpoints, build } = turnCheckpoints(join(TURNS_ROOT, entry.name));
  if (checkpoints.length < 2) continue;
  if (!Number.isNaN(since) && checkpoints[0]!.at < since) continue;
  if (!Number.isNaN(until) && checkpoints[0]!.at > until) continue;
  turns += 1;
  versions.set(build, (versions.get(build) ?? 0) + 1);
  const totalSec = (checkpoints.at(-1)!.at - checkpoints[0]!.at) / 1_000;
  perTurnRows.push({ turn: entry.name, version: build, totalSec, steps: checkpoints.length });
  for (let index = 1; index < checkpoints.length; index += 1) {
    const step = checkpoints[index]!;
    const seconds = (step.at - checkpoints[index - 1]!.at) / 1_000;
    const samples = durations.get(step.name) ?? [];
    samples.push(seconds);
    durations.set(step.name, samples);
  }
}

if (turns === 0) {
  const bounds = [Number.isNaN(since) ? "" : "--since", Number.isNaN(until) ? "" : "--until"].filter(Boolean).join("/");
  console.log(`No browser turns recorded under ${TURNS_ROOT}${bounds ? ` within ${bounds}` : ""}`);
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

const versionSummary = [...versions.entries()]
  .sort((left, right) => right[1] - left[1])
  .map(([version, count]) => `${version} (${count})`)
  .join(", ");
console.log(`${turns} browser turns under ${TURNS_ROOT}`);
console.log(`builds in window (version+buildId): ${versionSummary}`);
if (versions.size > 1) {
  // Checkpoint names change between builds - send-accepted became assistant-turn-visible - so a
  // median mixing two versions is comparing renamed steps. Bound the window with --since/--until.
  console.log("WARNING: turns from more than one build are mixed; medians below span renamed checkpoints.");
}
console.log("");
console.log(`${"step".padEnd(42)}${"n".padStart(4)}${"median s".padStart(11)}${"max s".padStart(10)}`);
for (const row of rows) {
  console.log(
    `${row.name.padEnd(42)}${String(row.count).padStart(4)}`
    + `${row.median.toFixed(2).padStart(11)}${row.max.toFixed(2).padStart(10)}`,
  );
}

if (perTurn) {
  // Aggregate medians hide time structure; this shows each turn's total so an outlier like the
  // 21-minute run is visible instead of buried in a median.
  console.log(`\n${"turn".padEnd(24)}${"version".padStart(10)}${"total s".padStart(11)}${"steps".padStart(7)}`);
  for (const row of perTurnRows.sort((left, right) => right.totalSec - left.totalSec)) {
    console.log(
      `${row.turn.slice(0, 22).padEnd(24)}${row.version.padStart(10)}`
      + `${row.totalSec.toFixed(2).padStart(11)}${String(row.steps).padStart(7)}`,
    );
  }
}
