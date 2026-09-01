import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

let cached: string | undefined;

/**
 * The build writes a manifest.json at the bundle root with bundleId, a SHA-256 over the shipped app
 * files. runtimeVersion alone cannot tell two same-semver hotfix builds apart, so diagnostics stamp
 * this short id to keep A/B measurement from averaging across different bundles.
 *
 * The manifest sits one level above the running app directory. Resolving that directory is the whole
 * difficulty: import.meta.dir is correct in every isolated test but returned "dev" under the launcher
 * once, so this tries both import.meta.dir and the directory of the launched script (process.argv[1])
 * and takes the first manifest it can read. When none resolve it returns "unknown" and warns with the
 * exact candidates tried, so a future failure explains itself instead of silently mislabelling builds.
 * Running unbundled from source has no manifest at all and reports "dev".
 */
export function runtimeBuildId(): string {
  if (cached !== undefined) return cached;

  const appDirs = [import.meta.dir, process.argv[1] ? dirname(process.argv[1]) : undefined]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  const tried: string[] = [];
  for (const appDir of appDirs) {
    const path = join(appDir, "..", "manifest.json");
    tried.push(path);
    try {
      const manifest = JSON.parse(readFileSync(path, "utf8")) as { bundleId?: unknown };
      if (typeof manifest.bundleId === "string") {
        cached = manifest.bundleId.slice(0, 12);
        return cached;
      }
    } catch {
      // Try the next candidate.
    }
  }

  // Nothing resolved. A source checkout legitimately has no manifest; anything else is a real miss
  // worth surfacing so the next investigation starts from the paths that were actually tried.
  cached = tried.some(path => path.includes(".codex-chatgpt-web") || path.includes("resources")) ? "unknown" : "dev";
  if (cached === "unknown") {
    console.warn(`[chatgpt-web] runtimeBuildId could not read a build manifest; tried: ${tried.join(", ")}`);
  }
  return cached;
}
