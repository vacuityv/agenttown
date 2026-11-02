// Agent Town GitHub Action, post step (always runs): stop the heartbeat, then idle (or ended). Never fails the job.
import { input, state, townFromInputs } from "./common.mjs";

try {
  const pid = Number(state("heartbeat_pid"));
  if (pid > 0) try { process.kill(pid); } catch {}
  const id = state("session");
  if (id) {
    const town = townFromInputs();
    const status = input("end-status", "idle") === "ended" ? "ended" : "idle";
    town.session({ id }).report(status);
    await town.flush();
    console.log(`Agent Town: session ${id} is ${status}.`);
  }
} catch (e) {
  console.log(`Agent Town: skipped (${e?.message ?? e}).`);
}
