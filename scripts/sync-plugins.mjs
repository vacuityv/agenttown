// Copies the CLI into the plugins that bundle it (BASE_URL baked to production) and sets the Claude Code plugin's
// version to CLI_VERSION (Claude Code only ships a new plugin copy to users when plugin.json's version changes).
// Run after editing public/cli/agenttown.mjs:  npm run sync:plugins
import { readFileSync, writeFileSync } from "node:fs";

export const BUNDLED_BASE_URL = "https://agenttown.xyz";
export const bundledCli = () =>
  readFileSync(new URL("../public/cli/agenttown.mjs", import.meta.url), "utf8").replaceAll("{{BASE_URL}}", BUNDLED_BASE_URL);
export const TARGETS = ["plugins/claude-code/bin/agenttown.mjs"];
export const PLUGIN_JSON = "plugins/claude-code/.claude-plugin/plugin.json";
export const cliVersion = () => /export const CLI_VERSION = "([^"]+)"/.exec(bundledCli())?.[1];

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  for (const t of TARGETS) writeFileSync(new URL(`../${t}`, import.meta.url), bundledCli());
  const url = new URL(`../${PLUGIN_JSON}`, import.meta.url);
  const pj = JSON.parse(readFileSync(url, "utf8"));
  if (pj.version !== cliVersion()) writeFileSync(url, JSON.stringify({ ...pj, version: cliVersion() }, null, 2) + "\n");
  console.log(`synced ${TARGETS.join(", ")}; ${PLUGIN_JSON} version ${cliVersion()}`);
}
