import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogDriftCheck } from "../src/doctor";
import type { AppConfig } from "../src/config";

// A Plus account with Bigger Context on - the exact configuration that made the 50-image task
// compact twelve times when the static catalog still read 90k/60k.
const config = {
  solAvailable: true,
  proAvailable: false,
  experimentalBiggerContext: true,
} as unknown as AppConfig;

let codexHome: string;
const priorCodexHome = process.env.CODEX_HOME;

function writeCodexConfig(body: string): void {
  writeFileSync(join(codexHome, "config.toml"), body, "utf8");
}

function writeCatalog(name: string, entries: Array<{ slug: string; ctx: number; auto: number }>): string {
  const path = join(codexHome, name);
  writeFileSync(path, JSON.stringify({
    models: entries.map(e => ({ slug: e.slug, context_window: e.ctx, auto_compact_token_limit: e.auto })),
  }), "utf8");
  return path;
}

beforeEach(() => {
  codexHome = mkdtempSync(join(tmpdir(), "codex-doctor-"));
  process.env.CODEX_HOME = codexHome;
});

afterEach(() => {
  if (priorCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = priorCodexHome;
  rmSync(codexHome, { recursive: true, force: true });
});

test("a static catalog frozen at the old 90k/60k limits is reported as drift", () => {
  const catalog = writeCatalog("stale.json", [
    { slug: "chatgpt-web/high", ctx: 90_000, auto: 60_000 },
    { slug: "chatgpt-web/medium", ctx: 90_000, auto: 60_000 },
    { slug: "chatgpt-web/light", ctx: 41_000, auto: 32_000 },
  ]);
  writeCodexConfig(`model_catalog_json = ${JSON.stringify(catalog)}\n`);

  const check = catalogDriftCheck(config);
  expect(check.status).toBe("warning");
  expect(check.message).toContain("compact early");
  // The detail names the routes and both sides of the comparison so the fix is obvious.
  expect(check.detail).toContain("chatgpt-web/high");
  expect(check.detail).toContain("90000/60000");
});

test("a catalog carrying the corrected limits raises no drift", () => {
  const catalog = writeCatalog("current.json", [
    { slug: "chatgpt-web/high", ctx: 270_000, auto: 240_000 },
    { slug: "chatgpt-web/medium", ctx: 270_000, auto: 240_000 },
    { slug: "chatgpt-web/light", ctx: 123_000, auto: 96_000 },
  ]);
  writeCodexConfig(`model_catalog_json = ${JSON.stringify(catalog)}\n`);

  expect(catalogDriftCheck(config).status).toBe("ok");
});

test("no model_catalog_json means Codex reads the live bridge catalog", () => {
  writeCodexConfig(`model_provider = "codex-chatgpt-web"\n`);
  const check = catalogDriftCheck(config);
  expect(check.status).toBe("ok");
  expect(check.message).toContain("live model catalog");
});

test("a configured catalog file that has gone missing is a warning, not a silent pass", () => {
  writeCodexConfig(`model_catalog_json = ${JSON.stringify(join(codexHome, "gone.json"))}\n`);
  expect(catalogDriftCheck(config).status).toBe("warning");
});
