// Copies the CLI into the plugins that bundle it (BASE_URL baked to production).
// Run after editing public/cli/agenttown.mjs:  npm run sync:plugins
import { readFileSync, writeFileSync } from "node:fs";

export const BUNDLED_BASE_URL = "https://agenttown.xyz";
export const bundledCli = () =>
  readFileSync(new URL("../public/cli/agenttown.mjs", import.meta.url), "utf8").replaceAll("{{BASE_URL}}", BUNDLED_BASE_URL);
export const TARGETS = ["plugins/claude-code/bin/agenttown.mjs"];

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  for (const t of TARGETS) writeFileSync(new URL(`../${t}`, import.meta.url), bundledCli());
  console.log(`synced ${TARGETS.join(", ")}`);
}
