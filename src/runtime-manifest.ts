import { readFileSync } from "node:fs";
import { join } from "node:path";

let cached: string | undefined;

/**
 * The build writes a manifest.json at the bundle root with bundleId, a SHA-256 over the shipped
 * app files. runtimeVersion alone cannot tell two same-semver hotfix builds apart, so diagnostics
 * stamp this short id to keep A/B measurement from averaging across different bundles.
 *
 * The manifest sits one level above the running app directory. When run unbundled from source there
 * is no manifest, so this reports "dev"; any read failure reports "unknown" rather than throwing.
 */
export function runtimeBuildId(): string {
  if (cached !== undefined) return cached;
  try {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "manifest.json"), "utf8"),
    ) as { bundleId?: unknown };
    cached = typeof manifest.bundleId === "string" ? manifest.bundleId.slice(0, 12) : "unknown";
  } catch {
    cached = "dev";
  }
  return cached;
}
