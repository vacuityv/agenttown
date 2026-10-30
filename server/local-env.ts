// Local dev/test only (production gets its env from systemd): loads AGENTTOWN_ENV_FILE, else ./.env, if present.
// Variables already set in the environment win.
import { existsSync } from "node:fs";

export function loadLocalEnv() {
  const file = process.env.AGENTTOWN_ENV_FILE ?? ".env";
  if (existsSync(file)) process.loadEnvFile(file);
  else if (process.env.AGENTTOWN_ENV_FILE) throw new Error(`AGENTTOWN_ENV_FILE not found: ${file}`);
}
