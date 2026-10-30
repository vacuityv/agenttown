#!/usr/bin/env node
// Agent Town hook launcher. Picks the CLI that implements `runHook`, preferring the highest HOOK_VERSION:
//   1. $AGENTTOWN_CLI
//   2. agenttown.mjs next to the config (~/.agenttown/agenttown.mjs — installed by the agents.md flow,
//      re-downloaded from the server you registered with)
//   3. ../bin/agenttown.mjs bundled with this plugin (fallback; same code)
// Never prints, always exits 0.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cfgDir = dirname(process.env.AGENTTOWN_CONFIG || join(homedir(), ".agenttown", "config.json"));
const candidates = [process.env.AGENTTOWN_CLI, join(cfgDir, "agenttown.mjs"), join(here, "..", "bin", "agenttown.mjs")];

setTimeout(() => process.exit(0), 1500).unref();
let best = null;
for (const p of candidates) {
  if (!p || !existsSync(p)) continue;
  try {
    const m = await import(pathToFileURL(p).href);
    if (typeof m.runHook === "function" && (!best || (m.HOOK_VERSION || 0) > (best.HOOK_VERSION || 0))) best = m;
  } catch {}
}
try { if (best) await best.runHook(process.argv[2] || "claude-code", process.argv.slice(3)); } catch {}
process.exit(0);
