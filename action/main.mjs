// Agent Town GitHub Action, main step: the job's agent sits down at its desk ("thinking", new task), and a small
// detached process repeats that every 4 minutes so a long job doesn't time out. Never fails the job.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { input, saveState, sessionId, townFromInputs } from "./common.mjs";

const HEARTBEAT_MS = 240_000;
const MAX_JOB_MS = 6 * 3600_000; // GitHub's job limit on hosted runners

try {
  const town = townFromInputs();
  const s = town.session({ id: process.env.AGENTTOWN_SESSION || sessionId() });
  if (process.argv.includes("--heartbeat")) {
    // Killed by the post step; gives up by itself after the longest possible job.
    setInterval(() => s.thinking(), HEARTBEAT_MS);
    setTimeout(() => process.exit(0), MAX_JOB_MS);
  } else if (!town.enabled) {
    console.log("Agent Town: no credentials (set the `credentials` input from a secret); not reporting.");
  } else {
    const repo = process.env.GITHUB_REPOSITORY || "", wf = process.env.GITHUB_WORKFLOW || "";
    s.thinking(input("task") || [repo, wf].filter(Boolean).join(" · ") || true);
    await town.flush();
    saveState("session", s.id);
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--heartbeat"], {
      detached: true, stdio: "ignore", env: { ...process.env, AGENTTOWN_SESSION: s.id },
    });
    child.unref();
    if (child.pid) saveState("heartbeat_pid", String(child.pid));
    console.log(`Agent Town: ${s.persona} (${s.kind}) is at work, session ${s.id}.`);
  }
} catch (e) {
  console.log(`Agent Town: skipped (${e?.message ?? e}).`);
}
