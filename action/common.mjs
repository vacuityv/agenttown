// Shared by the Agent Town GitHub Action's steps (action.yml). No dependencies: the runner's Node + the SDK.
import { appendFileSync } from "node:fs";
import { connect } from "../public/sdk/agenttown.mjs";

/** An action input (INPUT_<NAME>; the runner keeps hyphens). */
export const input = (name, def = "") => String(process.env[`INPUT_${name.toUpperCase()}`] ?? "").trim() || def;

/** One desk per job of a workflow run (re-runs get their own). */
export const sessionId = (env = process.env) =>
  `gha-${env.GITHUB_RUN_ID || "local"}-${env.GITHUB_RUN_ATTEMPT || "1"}-${env.GITHUB_JOB || "job"}`.replace(/[^\w.:-]/g, "-").slice(0, 128);

export function townFromInputs() {
  const opts = {
    kind: input("kind", "github-actions"), timeoutMs: 5000, autoEnd: false, titles: input("titles", "true") !== "false",
  };
  if (input("persona")) opts.persona = input("persona");
  if (input("server")) opts.server = input("server");
  // Inputs first; without them the SDK falls back to AGENTTOWN_* env vars and then ~/.agenttown/config.json.
  if (input("credentials")) opts.credentials = input("credentials");
  else if (input("token")) Object.assign(opts, { token: input("token"), encKey: input("enc-key") || undefined });
  return connect(opts);
}

export function saveState(name, value) {
  if (process.env.GITHUB_STATE) appendFileSync(process.env.GITHUB_STATE, `${name}=${value}\n`);
  else console.log(`::save-state name=${name}::${value}`);
}
export const state = (name) => process.env[`STATE_${name}`] ?? "";
