#!/usr/bin/env node
// Agent Town hook launcher. Picks the CLI that implements `runHook`, preferring the highest HOOK_VERSION, then the
// highest CLI_VERSION (on a tie, the earlier candidate):
//   1. $AGENTTOWN_CLI
//   2. agenttown.mjs next to the config (~/.agenttown/agenttown.mjs — installed by the agents.md flow, and kept
//      current by the CLI's signed self-update, which also creates it on plugin-only installs)
//   3. ../bin/agenttown.mjs bundled with this plugin (fallback; the release this plugin version shipped with)
// Never prints, always exits 0.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cfgDir = dirname(process.env.AGENTTOWN_CONFIG || join(homedir(), ".agenttown", "config.json"));
const candidates = [process.env.AGENTTOWN_CLI, join(cfgDir, "agenttown.mjs"), join(here, "..", "bin", "agenttown.mjs")];

const newer = (a, b) => {
  const pa = String(a ?? "0").split(".").map(Number), pb = String(b ?? "0").split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};
const better = (m, best) => {
  if (!best) return true;
  const hm = m.HOOK_VERSION || 0, hb = best.HOOK_VERSION || 0;
  return hm !== hb ? hm > hb : newer(m.CLI_VERSION, best.CLI_VERSION);
};

setTimeout(() => process.exit(0), 1500).unref();
let best = null;
for (const p of candidates) {
  if (!p || !existsSync(p)) continue;
  try {
    const m = await import(pathToFileURL(p).href);
    if (typeof m.runHook === "function" && better(m, best)) best = m;
  } catch {}
}
try { if (best) await best.runHook(process.argv[2] || "claude-code", process.argv.slice(3)); } catch {}
process.exit(0);
