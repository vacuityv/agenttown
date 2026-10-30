// End-to-end smoke test: boots the server on a freshly emptied test DB (TEST_MYSQL_URL) and drives it through the CLI.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDecipheriv, createHmac } from "node:crypto";
import assert from "node:assert/strict";
import { resetTestDb } from "./test-db.ts";

const PORT = 8797;
const BASE = `http://localhost:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), "agenttown-smoke-"));
const env = { ...process.env, PORT: String(PORT), MYSQL_URL: await resetTestDb(), POW_DIFFICULTY: "8", PUBLIC_URL: BASE, ANTHROPIC_API_KEY: "" };

const server = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server/index.ts"], { env, stdio: ["ignore", "pipe", "inherit"] });
await new Promise<void>((ok, fail) => {
  server.stdout!.on("data", (d) => String(d).includes("listening") && ok());
  server.on("exit", (code) => fail(new Error(`server exited (${code})`)));
});

const cliEnv = (name: string) => ({ ...env, AGENTTOWN_CONFIG: join(dir, name, "config.json"), AGENTTOWN_SERVER: BASE });
const cli = (cfg: string, ...args: string[]) =>
  execFileSync(process.execPath, ["public/cli/agenttown.mjs", ...args], { env: cliEnv(cfg), encoding: "utf8" });
const get = async (p: string) => (await fetch(BASE + p)).json() as Promise<any>;

try {
  // Served CLI has the URL baked in.
  const served = await (await fetch(`${BASE}/cli/agenttown.mjs`)).text();
  assert.ok(served.includes(`const DEFAULT_SERVER = "${BASE}"`));

  // Register once; second register is a no-op.
  assert.match(cli("a", "register", "--home", "Smoke Home"), /Registered home "Smoke Home"/);
  assert.match(cli("a", "register", "--home", "Again"), /Already registered/);
  const cfg = JSON.parse(readFileSync(join(dir, "a", "config.json"), "utf8"));
  assert.match(cfg.owner_key, /^atk_/);

  // Another machine logs in with the same key.
  assert.match(cli("b", "login", cfg.owner_key), new RegExp(cfg.home_id));

  // SSE listener.
  const seen: string[] = [];
  const ac = new AbortController();
  fetch(`${BASE}/v1/stream?home=${cfg.home_id}`, { signal: ac.signal }).then(async (r) => {
    for await (const chunk of r.body!) seen.push(Buffer.from(chunk).toString());
  }).catch(() => {});
  const worldSeen: string[] = [];
  fetch(`${BASE}/v1/stream`, { signal: ac.signal }).then(async (r) => {
    for await (const chunk of r.body!) worldSeen.push(Buffer.from(chunk).toString());
  }).catch(() => {});
  await new Promise((r) => setTimeout(r, 200));

  cli("a", "persona", "--name", "Claude", "--kind", "claude-code", "--appearance", "戴耳机的橘猫");
  const r1 = JSON.parse(cli("a", "report", "--persona", "Claude", "--kind", "claude-code", "--session", "s-1", "--status", "thinking", "--task", "修复登录页的 bug"));
  assert.equal(r1.task_no, 1);
  cli("b", "report", "--persona", "Claude", "--kind", "claude-code", "--session", "s-1", "--status", "tool", "--tool", "Bash");
  cli("a", "report", "--persona", "Claude", "--kind", "claude-code", "--session", "s-1:sub1", "--parent", "s-1", "--status", "tool", "--tool", "mcp__secret_corp__query", "--task", "调研");

  const home = await get(`/v1/homes/${cfg.home_id}`);
  assert.equal(home.personas.length, 1);
  assert.equal(home.personas[0].sprite_status, "pending");
  assert.equal(home.sessions.length, 2);
  const [main, sub] = home.sessions;
  assert.equal(main.status, "tool");
  assert.equal(main.tool, "Bash");
  assert.equal(sub.parent_id, main.id);
  assert.equal(sub.tool, "MCP", "mcp tool names are folded");
  assert.ok(!JSON.stringify(home).includes("修复"), "no plaintext on the public API");

  // Owner can decrypt with the derived key.
  const key = createHmac("sha256", Buffer.from(cfg.owner_key)).update("agenttown/enc/v1").digest();
  const [, iv, ct] = main.task_enc.split(".");
  const buf = Buffer.from(ct, "base64url");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  d.setAuthTag(buf.subarray(-16));
  const pt = Buffer.concat([d.update(buf.subarray(0, -16)), d.final()]).toString("utf8").replace(/\0+$/, "");
  assert.equal(pt, "修复登录页的 bug");

  // Ending the parent ends the subagent.
  cli("a", "report", "--persona", "Claude", "--kind", "claude-code", "--session", "s-1", "--status", "ended");
  assert.equal((await get(`/v1/homes/${cfg.home_id}`)).sessions.length, 0);

  const world = await get("/v1/world");
  assert.equal(world.totals.homes, 1);
  const stats = await get(`/v1/homes/${cfg.home_id}/stats`);
  assert.equal(stats.daily[0].tasks, 2);
  assert.ok(stats.tools.some((t: any) => t.tool === "Bash"));
  assert.equal((await get(`/v1/homes/${cfg.home_id}/events`)).events.length, 4);

  // Bad input is rejected.
  const bad = await fetch(`${BASE}/v1/report`, { method: "POST", headers: { authorization: "Bearer " + "0".repeat(64) }, body: "{}" });
  assert.equal(bad.status, 401);

  assert.ok((await get(`/v1/homes/${cfg.home_id}/events`)).events.every((e: any) => e.persona_id), "events carry persona_id");

  // 20 parallel first-reports for one new session (and a new persona, each with a task): one session, no errors.
  const token = createHmac("sha256", cfg.owner_key).update("agenttown/auth/v1").digest("hex");
  const enc = `v1.${"A".repeat(16)}.${"B".repeat(48)}`;
  const race = await Promise.all(Array.from({ length: 20 }, (_, i) => fetch(`${BASE}/v1/report`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ persona: { name: "Racer", kind: "codex" }, session: "race-1", status: i % 2 ? "tool" : "thinking", tool: "Bash", task: { title_enc: enc } }),
  }).then(async (r) => ({ status: r.status, body: await r.json() as any }))));
  assert.deepEqual(race.map((r) => r.status), Array(20).fill(200), "no errors under concurrent first-reports");
  assert.equal(new Set(race.map((r) => r.body.session_id)).size, 1, "exactly one session");
  assert.equal(new Set(race.map((r) => r.body.task_no)).size, 20, "task numbers are unique");
  const raced = await get(`/v1/homes/${cfg.home_id}`);
  assert.equal(raced.sessions.length, 1);
  assert.equal(raced.personas.filter((p: any) => p.name === "Racer").length, 1, "exactly one persona");
  assert.equal(raced.sessions[0].task_no, Math.max(...race.map((r) => r.body.task_no)));

  await new Promise((r) => setTimeout(r, 2300)); // counts/agent events are coalesced
  ac.abort();
  const sse = seen.join("");
  assert.ok(sse.includes("event: session") && sse.includes("event: persona"), "home stream delivered events");
  const town = worldSeen.join("");
  assert.ok(town.includes("event: counts") && town.includes("event: agent") && !town.includes("event: session"), "town stream: counts + agents");
  assert.ok(!town.includes("task_enc") && !town.includes("task_no"), "town stream carries no task data");
  const t = await get(`/v1/town?ids=${cfg.home_id},h_nonexistent`);
  assert.equal(t.homes.length, 1);
  assert.equal(t.homes[0].personas[0].name, "Claude");

  // Dwelling look: CLI sets it (no API key here, so it stays pending), same look again is a no-op, "" clears.
  assert.equal((await get(`/v1/homes/${cfg.home_id}`)).home.art_status, "none");
  assert.match(cli("a", "home", "--look", "a treehouse with <b>lanterns</b>"), /dwelling art: pending/);
  let hv = (await get(`/v1/homes/${cfg.home_id}`)).home;
  assert.equal(hv.look, "a treehouse with <b>lanterns</b>"); // stored as text; clients render it as text
  assert.equal(hv.art, null);
  assert.equal(hv.art_error, null);
  assert.equal((await get(`/v1/town?ids=${cfg.home_id}`)).homes[0].home.art_status, "pending");
  const putLook = (look: unknown) => fetch(`${BASE}/v1/home/look`, {
    method: "PUT", headers: { authorization: `Bearer ${authToken}`, "content-type": "application/json" }, body: JSON.stringify({ look }),
  });
  const authToken = createHmac("sha256", cfg.owner_key).update("agenttown/auth/v1").digest("hex");
  assert.equal((await putLook(42)).status, 400);
  assert.equal((await putLook("   ")).status, 400);
  assert.match(cli("a", "home", "--look", ""), /cleared/);
  hv = (await get(`/v1/homes/${cfg.home_id}`)).home;
  assert.equal(hv.look, null);
  assert.equal(hv.art_status, "none");
  assert.equal((await fetch(`${BASE}/v1/home/look`, { method: "PUT", body: "{}" })).status, 401);

  console.log("smoke: all checks passed");
} finally {
  server.kill();
}
