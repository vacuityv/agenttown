// Free-town features end-to-end on a freshly emptied test DB (TEST_MYSQL_URL): home customization, says, meta/news/update,
// device invites, retiring & leaving (cemetery), merging homes. Each "machine" is its own HOME + config dir.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDecipheriv, createHmac } from "node:crypto";
import assert from "node:assert/strict";
import mysql from "mysql2/promise";
import { resetTestDb } from "./test-db.ts";

const PORT = 8798;
const BASE = `http://localhost:${PORT}`;
const CLI = "public/cli/agenttown.mjs";
const root = mkdtempSync(join(tmpdir(), "agenttown-town-"));
const MYSQL_URL = await resetTestDb();
const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(PORT), MYSQL_URL, POW_DIFFICULTY: "8", PUBLIC_URL: BASE, ANTHROPIC_API_KEY: "" };
delete env.AGENTTOWN_HOOK_SYNC;
delete env.AGENTTOWN_DISABLED;
delete env.AGENTTOWN_JOIN;

const server = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server/index.ts"], { env, stdio: ["ignore", "pipe", "inherit"] });
await new Promise<void>((ok, fail) => {
  server.stdout!.on("data", (d) => String(d).includes("listening") && ok());
  server.on("exit", (code) => fail(new Error(`server exited (${code})`)));
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const machineEnv = (m: string, extra: Record<string, string> = {}) => {
  const home = join(root, m);
  return {
    ...env, HOME: home, AGENTTOWN_CONFIG: join(home, ".agenttown", "config.json"), AGENTTOWN_SERVER: BASE,
    CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex"), ...extra,
  };
};
const cfgOf = (m: string) => JSON.parse(readFileSync(join(root, m, ".agenttown", "config.json"), "utf8"));
const hasCfg = (m: string) => existsSync(join(root, m, ".agenttown", "config.json"));
function run(m: string, args: string[], extra: Record<string, string> = {}, input = "") {
  const r = spawnSync(process.execPath, [CLI, ...args], { env: machineEnv(m, extra), encoding: "utf8", input });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
/** Async variant, for when this process must keep serving (the fake update server). */
function runAsync(m: string, args: string[]) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: machineEnv(m), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
function ok(m: string, ...args: string[]) {
  const r = run(m, args);
  assert.equal(r.status, 0, `${m}: agenttown ${args.join(" ")} failed:\n${r.stderr}`);
  return r.stdout;
}
const code = (out: string) => /AT-[0-9a-z]{8}-[0-9a-z]{26}/.exec(out)![0];
const get = async (p: string) => (await fetch(BASE + p)).json() as Promise<any>;
const api = async (method: string, p: string, token: string | null, body?: unknown) => {
  const r = await fetch(BASE + "/v1" + p, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  return { status: r.status, headers: r.headers, body: await r.json().catch(() => ({})) as any };
};
const ownerToken = (k: string) => createHmac("sha256", k).update("agenttown/auth/v1").digest("hex");
const tokenOf = (cfg: any) => cfg.owner_key ? ownerToken(cfg.owner_key) : cfg.device_token;
const encKeyOfOwner = (k: string) => createHmac("sha256", Buffer.from(k)).update("agenttown/enc/v1").digest();
const decrypt = (key: Buffer, enc: string) => {
  const [, iv, ct] = enc.split(".");
  const buf = Buffer.from(ct, "base64url");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  d.setAuthTag(buf.subarray(-16));
  return Buffer.concat([d.update(buf.subarray(0, -16)), d.final()]).toString("utf8").replace(/\0+$/, "");
};
const sessionWithTitle = async (homeId: string, key: Buffer, title: string) =>
  (await get(`/v1/homes/${homeId}`)).sessions.find((s: any) => {
    try { return s.task_enc && decrypt(key, s.task_enc) === title; } catch { return false; }
  });

// Town stream recorder.
const ac = new AbortController();
const townSeen: string[] = [];
fetch(`${BASE}/v1/stream`, { signal: ac.signal }).then(async (r) => {
  for await (const chunk of r.body!) townSeen.push(Buffer.from(chunk).toString());
}).catch(() => {});
const townEvents = (type: string) => townSeen.join("").split("\n\n")
  .filter((b) => b.startsWith(`event: ${type}\n`)).map((b) => JSON.parse(b.split("\ndata: ")[1]));

const db = await mysql.createConnection({ uri: MYSQL_URL });

try {
  await sleep(200);
  ok("a1", "register", "--home", "Alpha");
  ok("b1", "register", "--home", "Beta");
  ok("c1", "register", "--home", "Gamma");
  ok("x1", "register", "--home", "Delta");
  const A = cfgOf("a1"), B = cfgOf("b1"), C = cfgOf("c1"), D = cfgOf("x1");
  const encA = encKeyOfOwner(A.owner_key);
  const slotOf = async (id: string) => (await get(`/v1/homes/${id}`)).home.slot;
  const slots = { A: await slotOf(A.home_id), B: await slotOf(B.home_id), C: await slotOf(C.home_id), D: await slotOf(D.home_id) };
  assert.deepEqual(Object.values(slots), [1, 2, 3, 4], "slots in creation order");
  assert.deepEqual((await get("/v1/world")).homes.map((x: any) => x.slot), [1, 2, 3, 4], "/world ordered by slot");

  // ---- meta, changelog, news ----
  const meta = await get("/v1/meta");
  const cliVersion = /export const CLI_VERSION = "([^"]+)"/.exec(readFileSync(CLI, "utf8"))![1];
  assert.deepEqual(meta, {
    version: JSON.parse(readFileSync("package.json", "utf8")).version, cli_version: cliVersion,
    // This test server's PUBLIC_URL is not the one public/cli/release.json (if any) signs: served unsigned.
    cli_sha256: null, cli_sig: null, release_pubkey: /export const RELEASE_PUBKEY = "([^"]+)"/.exec(readFileSync(CLI, "utf8"))![1],
    changelog_url: `${BASE}/changelog.md`, agents_md_url: `${BASE}/agents.md`,
  });
  const changelog = await (await fetch(`${BASE}/changelog.md`)).text();
  assert.ok(changelog.includes("Agent Town opens") && changelog.includes(BASE), "changelog served with the URL baked in");
  assert.match(ok("a1", "news"), /\d{4}-\d{2}-\d{2} — [^\n]+[\s\S]*Full changelog:/);

  // ---- home customization ----
  assert.match(ok("a1", "home", "--dwelling", "treehouse", "--style", "watercolor", "--description", "A cozy   tree\nhouse"), /dwelling: treehouse, style: watercolor/);
  let h = (await get(`/v1/homes/${A.home_id}`)).home;
  assert.equal(h.dwelling, "treehouse");
  assert.equal(h.style, "watercolor");
  assert.match(run("a1", ["home", "--style", "cubist"]).stderr, /Unknown style[\s\S]*storybook/);
  assert.equal((await api("PATCH", "/home", ownerToken(A.owner_key), { style: "cubist" })).body.error, "bad_style");
  assert.equal(h.description, "A cozy tree house", "description is cleaned");
  const bad = run("a1", ["home", "--dwelling", "castle"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Unknown dwelling[\s\S]*lighthouse/);
  const tA = ownerToken(A.owner_key);
  assert.equal((await api("PATCH", "/home", tA, { dwelling: "castle" })).body.error, "bad_dwelling");
  assert.equal((await api("PATCH", "/home", tA, { description: "x".repeat(201) })).body.error, "bad_description");
  assert.equal((await api("PATCH", "/home", tA, { description: 5 })).status, 400);
  assert.equal((await api("PATCH", "/home", tA, {})).body.error, "empty_patch");
  assert.equal((await api("PATCH", "/home", tA, { name: "" })).body.error, "bad_home_name");
  const lh = await api("PATCH", "/home", tA, { dwelling: "lighthouse", description: "y".repeat(200) });
  assert.equal(lh.status, 200);
  assert.equal(lh.body.home.dwelling, "lighthouse");
  assert.equal((await api("PATCH", "/home", ownerToken(D.owner_key), { dwelling: null })).body.home.dwelling, null, "null = auto");
  assert.equal(ok("a1", "home").includes("dwelling: lighthouse"), true, "home without flags shows it");
  const w = (await get("/v1/world")).homes.find((x: any) => x.id === A.home_id);
  assert.equal(w.dwelling, "lighthouse");
  assert.equal(w.description, "y".repeat(200));
  const tw = (await get(`/v1/town?ids=${A.home_id}`)).homes[0];
  assert.equal(tw.dwelling, "lighthouse");
  assert.equal(tw.name, "Alpha");
  assert.equal(tw.slot, slots.A);
  assert.equal(tw.style, "watercolor");
  assert.equal(w.style, "watercolor");

  // ---- say ----
  ok("a1", "persona", "--name", "Claude", "--kind", "claude-code");
  assert.match(ok("a1", "say", "Hello, town!"), /Claude says: "Hello, town!" \(public, say \d+\)/);
  const again = run("a1", ["say", "Too soon"]);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /rate_limited/, "1 say per 30 s per persona");
  assert.equal((await api("POST", "/say", tA, { persona: { name: "Nobody", kind: "x" }, text: "hi" })).body.error, "unknown_persona");
  assert.equal((await api("POST", "/say", tA, { persona: { name: "Claude", kind: "claude-code" }, text: "z".repeat(141) })).body.error, "bad_text");
  assert.equal((await api("POST", "/say", tA, { persona: { name: "Claude", kind: "claude-code" }, text: "  " })).body.error, "bad_text");
  const homeA = await get(`/v1/homes/${A.home_id}`);
  assert.deepEqual(homeA.says.map((s: any) => s.text), ["Hello, town!"]);
  assert.equal(homeA.says[0].persona_id, homeA.personas[0].id);
  assert.ok(Object.keys(homeA.says[0]).sort().join() === "id,mentions,persona_id,reply,reply_to,text,ts");
  assert.match(run("a1", ["help"]).stdout, /PUBLIC[\s\S]*never include/i, "help warns that says are public");
  assert.deepEqual((await get(`/v1/town?ids=${A.home_id}`)).homes[0].says.map((s: any) => s.text), ["Hello, town!"], "/town carries says");

  // ---- invites & devices ----
  const inv1 = ok("a1", "invite", "--label", "build-server");
  assert.match(inv1, /join AT-/);
  assert.match(inv1, /Single use, expires in 15 minutes/);
  const code1 = code(inv1);
  assert.ok(code1.length <= 40);
  assert.match(ok("d1", "join", code1), /Joined home "Alpha"/);
  const D1 = cfgOf("d1");
  assert.equal(D1.owner_key, undefined, "no owner key on a device");
  assert.equal(D1.home_id, A.home_id);
  assert.equal(Buffer.from(D1.enc_key, "base64url").toString("hex"), encA.toString("hex"), "device got the home's enc_key");
  const reuse = run("d2", ["join", code1]);
  assert.equal(reuse.status, 1);
  assert.match(reuse.stderr, /invite_used/);
  assert.ok(!hasCfg("d2"));
  const code2 = code(ok("a1", "invite"));
  await db.query("UPDATE invites SET expires_at = 1 WHERE id = ?", [code2.split("-")[1]]);
  assert.match(run("d2", ["join", code2]).stderr, /invite_expired/);
  // Headless provisioning via AGENTTOWN_JOIN.
  const viaEnv = run("d2", ["join"], { AGENTTOWN_JOIN: code(ok("a1", "invite", "--label", "temp")) });
  assert.equal(viaEnv.status, 0, viaEnv.stderr);

  ok("d1", "persona", "--name", "Codex", "--kind", "codex");
  ok("d1", "report", "--persona", "Codex", "--kind", "codex", "--session", "dev-1", "--status", "thinking", "--task", "device secret title");
  assert.ok(await sessionWithTitle(A.home_id, encA, "device secret title"), "device title decrypts with the owner's enc_key");
  assert.match(ok("d1", "whoami"), /this machine is device d_/);
  assert.match(run("d1", ["key"]).stderr, /no owner key/);
  assert.match(run("d1", ["invite"]).stderr, /needs the owner key/);
  const tD1 = D1.device_token;
  assert.equal((await api("POST", "/invites", tD1, { blob: `v1.${"A".repeat(16)}.${"B".repeat(48)}` })).body.error, "owner_only");
  assert.equal((await api("DELETE", "/home", tD1, { confirm: A.home_id })).status, 403);
  assert.equal((await api("GET", "/devices", tD1)).status, 403);
  assert.equal((await api("PATCH", "/home", tD1, { description: "set from a device" })).status, 200, "devices may customize");
  // Hooks work on device machines.
  const hk = spawnSync(process.execPath, [CLI, "hook", "codex"], {
    env: { ...machineEnv("d1"), AGENTTOWN_HOOK_SYNC: "1" }, encoding: "utf8",
    input: JSON.stringify({ session_id: "dev-hook-1", hook_event_name: "UserPromptSubmit", prompt: "hooked device task" }),
  });
  assert.equal(hk.stdout + hk.stderr, "");
  assert.ok(await sessionWithTitle(A.home_id, encA, "hooked device task"), "device hooks report with encrypted titles");

  const devs = ok("a1", "devices");
  assert.match(devs, /build-server/);
  assert.match(devs, /temp/);
  // Leaving on a device forgets the machine only.
  assert.match(ok("d2", "leave", "--yes"), /The home stays/);
  assert.ok(!hasCfg("d2"));
  assert.equal((await get(`/v1/homes/${A.home_id}`)).home.id, A.home_id);
  assert.match(ok("a1", "devices"), /temp.*REVOKED/);
  // Revoke by label.
  ok("d3", "join", code(ok("a1", "invite", "--label", "doomed")));
  assert.match(ok("a1", "revoke", "doomed"), /Revoked d_/);
  const d3 = run("d3", ["whoami"]);
  assert.equal(d3.status, 1);
  assert.match(d3.stderr, /unauthorized/);

  // ---- retire & leave (home Delta) ----
  ok("x1", "report", "--persona", "Solo", "--kind", "claude-code", "--session", "x-1", "--status", "tool", "--tool", "Bash", "--task", "t");
  ok("x1", "report", "--persona", "Helper", "--kind", "other", "--session", "x-1:sub", "--parent", "x-1", "--status", "thinking");
  ok("x1", "report", "--persona", "Solo", "--kind", "claude-code", "--session", "x-2", "--status", "idle");
  assert.equal((await get(`/v1/homes/${D.home_id}`)).sessions.length, 3);
  assert.match(ok("x1", "retire", "--persona", "Solo", "--epitaph", "Shipped it."), /Solo has retired/);
  const xd = await get(`/v1/homes/${D.home_id}`);
  assert.deepEqual(xd.personas.map((p: any) => p.name), ["Helper"]);
  assert.equal(xd.sessions.length, 0, "the persona's sessions and their subagents ended");
  let cem = await get("/v1/cemetery");
  assert.equal(cem.total, 1);
  assert.equal(cem.tombstones[0].name, "Solo");
  assert.equal(cem.tombstones[0].epitaph, "Shipped it.");
  assert.equal(cem.tombstones[0].home_name, "Delta");
  assert.ok(cem.tombstones[0].born_at <= cem.tombstones[0].died_at);
  assert.equal((await api("DELETE", `/personas/${xd.personas[0].id}`, ownerToken(D.owner_key))).status, 200, "retire by id, no body");
  assert.equal((await api("DELETE", "/personas?name=Ghost", ownerToken(D.owner_key))).status, 404);
  // leave: refuses without --yes, then deletes everything.
  const noYes = run("x1", ["leave"]);
  assert.equal(noYes.status, 1);
  assert.match(noYes.stderr, /cannot be undone/);
  assert.equal((await api("DELETE", "/home", ownerToken(D.owner_key), { confirm: "h_wrong" })).body.error, "confirm_required");
  ok("x1", "install", "claude-code");
  assert.ok(readFileSync(join(root, "x1", ".claude", "settings.json"), "utf8").includes("agenttown"));
  assert.match(ok("x1", "leave", "--epitaph", "So long", "--yes"), /rest in the town cemetery|rests in the town cemetery/);
  assert.ok(!hasCfg("x1"), "local config deleted");
  assert.ok(!readFileSync(join(root, "x1", ".claude", "settings.json"), "utf8").includes("agenttown"), "hooks uninstalled");
  assert.equal((await api("GET", "/me", ownerToken(D.owner_key))).status, 401, "owner key stops working");
  assert.equal((await fetch(`${BASE}/v1/homes/${D.home_id}`)).status, 404);
  assert.ok(!(await get("/v1/world")).homes.some((x: any) => x.id === D.home_id), "world no longer lists it");
  cem = await get("/v1/cemetery?limit=1");
  assert.equal(cem.total, 3);
  assert.equal(cem.tombstones.length, 1);
  assert.equal(cem.tombstones[0].kind, "home", "an empty home gets a grave of its own");
  assert.equal(cem.tombstones[0].name, "Delta");
  assert.equal(cem.tombstones[0].epitaph, "So long");
  const [leftover] = await db.query(
    "SELECT (SELECT COUNT(*) FROM events WHERE home_id = ?) + (SELECT COUNT(*) FROM daily_stats WHERE home_id = ?) AS n", [D.home_id, D.home_id]);
  assert.equal(Number((leftover as any[])[0].n), 0, "events and stats deleted");

  // ---- merge Beta into Alpha (--on-conflict rename) ----
  ok("b1", "report", "--persona", "Claude", "--kind", "claude-code", "--session", "b-1", "--status", "tool", "--tool", "Read", "--task", "beta old title");
  ok("b1", "say", "Beta was here");
  ok("bd1", "join", code(ok("b1", "invite", "--label", "beta-laptop")));
  ok("bd1", "report", "--persona", "Claude", "--kind", "claude-code", "--session", "bd-1", "--status", "thinking", "--task", "beta device old");
  const statsBefore = (await get(`/v1/homes/${A.home_id}/stats`)).daily[0].tasks + (await get(`/v1/homes/${B.home_id}/stats`)).daily[0].tasks;
  const keptInvite = code(ok("a1", "invite", "--label", "kept"));
  const mergeCode = code(ok("a1", "invite", "--merge"));
  // Device scope can't merge.
  assert.match(run("d1", ["merge", mergeCode, "--yes"]).stderr, /needs the owner key/);
  assert.equal((await api("POST", `/invites/${mergeCode.split("-")[1]}/merge`, tD1, { rekey_blob: `v1.${"A".repeat(16)}.${"B".repeat(48)}` })).body.error, "owner_only");
  // A join invite can't be used to merge and vice versa.
  assert.match(run("b1", ["merge", keptInvite, "--yes"]).stderr, /invite_not_found|join invite/);
  assert.match(run("zz", ["join", mergeCode]).stderr, /invite_not_found/);
  const preview = run("b1", ["merge", mergeCode, "--on-conflict", "rename"]);
  assert.equal(preview.status, 1, "merge without --yes only previews");
  assert.match(preview.stdout, /Claude \(claude-code\) moves over, renamed "Claude \(Beta\)"/);
  assert.equal((await get(`/v1/homes/${B.home_id}`)).home.id, B.home_id, "nothing changed yet");
  const merged = ok("b1", "merge", mergeCode, "--on-conflict", "rename", "--yes");
  assert.match(merged, /Merged\. Welcome to "Alpha"/);
  assert.match(merged, /Claude is now "Claude \(Beta\)"/);
  assert.equal((await fetch(`${BASE}/v1/homes/${B.home_id}`)).status, 404);
  assert.ok(!(await get("/v1/world")).homes.some((x: any) => x.id === B.home_id));
  const am = await get(`/v1/homes/${A.home_id}`);
  assert.deepEqual(am.personas.map((p: any) => p.name).sort(), ["Claude", "Claude (Beta)", "Codex"]);
  assert.ok(am.says.some((s: any) => s.text === "Beta was here"), "says moved");
  const bSession = am.sessions.find((s: any) => s.persona_id === am.personas.find((p: any) => p.name === "Claude (Beta)").id && s.tool === "Read");
  assert.ok(bSession, "B's open session moved");
  assert.equal(bSession.task_enc, null, "B's old titles (B's key) are dropped");
  assert.equal((await get(`/v1/homes/${A.home_id}/stats`)).daily[0].tasks, statsBefore, "stats summed");
  // B's owner machine switched right away; the old owner key is backed up.
  const B1 = cfgOf("b1");
  assert.equal(B1.home_id, A.home_id);
  assert.equal(B1.owner_key, undefined);
  assert.equal(B1.device_token, ownerToken(B.owner_key), "the old owner token is now a device token");
  assert.equal(JSON.parse(readFileSync(join(root, "b1", ".agenttown", `config.merged-${B.home_id}.bak.json`), "utf8")).owner_key, B.owner_key);
  ok("b1", "report", "--persona", "Claude (Beta)", "--kind", "claude-code", "--session", "b-1", "--status", "thinking", "--task", "beta owner new");
  assert.ok(await sessionWithTitle(A.home_id, encA, "beta owner new"), "B's owner machine titles decrypt with A's key");
  // B's device switches over silently via the hook flusher.
  const bdEnv = machineEnv("bd1");
  const bdHook = (payload: object) => {
    const r = spawnSync(process.execPath, [CLI, "hook", "claude-code"], { env: bdEnv, input: JSON.stringify(payload), encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.equal(r.stdout + r.stderr, "", "hooks stay silent while rekeying");
  };
  bdHook({ session_id: "bd-1", hook_event_name: "Stop" });
  for (let i = 0; i < 200 && cfgOf("bd1").home_id !== A.home_id; i++) await sleep(25);
  const BD1 = cfgOf("bd1");
  assert.equal(BD1.home_id, A.home_id, "device rekeyed after its next report");
  assert.equal(Buffer.from(BD1.enc_key, "base64url").toString("hex"), encA.toString("hex"));
  let rk = await api("GET", "/me", BD1.device_token);
  for (let i = 0; i < 200 && rk.body.rekey; i++) { await sleep(25); rk = await api("GET", "/me", BD1.device_token); }
  assert.equal(rk.body.rekey, undefined, "rekey acknowledged");
  assert.equal(rk.headers.get("x-agenttown-rekey"), null);
  bdHook({ session_id: "bd-1", hook_event_name: "UserPromptSubmit", prompt: "beta device new" });
  let found = null;
  for (let i = 0; i < 200 && !found; i++) { found = await sessionWithTitle(A.home_id, encA, "beta device new"); if (!found) await sleep(25); }
  assert.ok(found, "B's device titles decrypt with A's key");
  assert.equal(run("zz", ["merge", mergeCode, "--yes"]).status, 1, "merge code is single use");
  assert.equal(run("c1", ["merge", mergeCode, "--yes"]).stderr.includes("invite_used"), true);
  assert.match(ok("kept", "join", keptInvite), /Joined home "Alpha"/, "A's other invites unaffected");
  const removed = townEvents("home_removed").find((e) => e.home_id === B.home_id);
  assert.equal(removed?.merged_into, A.home_id, "home_removed carries merged_into");

  // ---- merge Gamma into Alpha (default: same name + kind become one) ----
  ok("c1", "report", "--persona", "Codex", "--kind", "codex", "--session", "c-1", "--status", "tool", "--tool", "Edit", "--task", "gamma");
  const codexA = am.personas.find((p: any) => p.name === "Codex").id;
  ok("c1", "merge", code(ok("a1", "invite", "--merge")), "--yes");
  const ag = await get(`/v1/homes/${A.home_id}`);
  assert.equal(ag.personas.filter((p: any) => p.name.startsWith("Codex")).length, 1, "personas merged");
  const cSession = ag.sessions.find((s: any) => s.tool === "Edit");
  assert.equal(cSession.persona_id, codexA, "C's session now belongs to A's Codex");

  // ---- slots survive deletes and merges; never reused ----
  assert.equal(await slotOf(A.home_id), slots.A, "A keeps its slot after merges and a delete");
  ok("e1", "register", "--home", "Epsilon");
  const slotE = await slotOf(cfgOf("e1").home_id);
  assert.ok(slotE > Math.max(...Object.values(slots)), `new home gets a fresh slot (${slotE})`);
  assert.deepEqual((await get("/v1/world")).homes.map((x: any) => x.slot), [slots.A, slotE]);
  assert.ok(townEvents("home").some((e) => e.id === cfgOf("e1").home_id && e.slot === slotE), "home events carry slot");

  // ---- update notice, `update`, and silent hooks ----
  const metaPath = join(root, "a1", ".agenttown", "meta.json");
  assert.ok(existsSync(metaPath), "interactive commands cache /v1/meta");
  assert.ok(!ok("a1", "whoami").includes("update available"));
  assert.ok(!run("a1", ["whoami"]).stderr.includes("update"), "no notice when up to date");
  writeFileSync(metaPath, JSON.stringify({ checked_at: Date.now(), meta: { ...meta, cli_version: "99.0.0" } }));
  const notice = run("a1", ["whoami"]);
  assert.match(notice.stderr, /Agent Town CLI 99\.0\.0 is available \(this is [\d.]+\): it installs itself within a day, or run `agenttown update` now; news: http:\/\/localhost:8798\/changelog\.md/);
  assert.match(notice.stdout, /agenttown help merge/, "whoami hints at merging");
  const silent = spawnSync(process.execPath, [CLI, "hook", "claude-code"], {
    env: machineEnv("a1"), input: JSON.stringify({ session_id: "a-hook", hook_event_name: "SessionStart", source: "startup" }), encoding: "utf8",
  });
  assert.equal(silent.status, 0);
  assert.equal(silent.stdout + silent.stderr, "", "hook prints nothing even when an update is available");
  const flush = spawnSync(process.execPath, [CLI, "hook-flush"], { env: machineEnv("a1"), encoding: "utf8" });
  assert.equal(flush.stdout + flush.stderr, "", "hook-flush prints nothing");
  // `update` from a server that has a newer CLI.
  const newer = readFileSync(CLI, "utf8").replace(/export const CLI_VERSION = "[^"]+"/, 'export const CLI_VERSION = "9.9.9"');
  const fake = createServer((req, res) => {
    if (req.url === "/cli/agenttown.mjs") return res.end(newer);
    if (req.url === "/changelog.md") return res.end("# Changelog\n\n## 2027-01-01 — Shiny new things\n\nStuff.\n\n## 2026-10-30 — Agent Town opens\n");
    res.statusCode = 404; res.end("{}");
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  const fakeUrl = `http://127.0.0.1:${(fake.address() as any).port}`;
  assert.match(ok("a1", "update"), new RegExp(`CLI ${cliVersion} installed`));
  const upRun = await runAsync("a1", ["update", "--server", fakeUrl]);
  fake.close();
  assert.equal(upRun.status, 0, upRun.stderr);
  const up = upRun.stdout;
  assert.match(up, new RegExp(`${cliVersion.replaceAll(".", "\\.")} → 9\\.9\\.9`));
  assert.match(up, /Shiny new things/);
  assert.match(readFileSync(join(root, "a1", ".agenttown", "agenttown.mjs"), "utf8"), /CLI_VERSION = "9\.9\.9"/);

  // ---- home edit rate limit (10/hour) ----
  let limited = false;
  for (let i = 0; i < 12 && !limited; i++) limited = (await api("PATCH", "/home", tA, { description: `v${i}` })).status === 429;
  assert.ok(limited, "home customization is rate limited");

  // ---- SSE ----
  await sleep(300);
  assert.ok(townEvents("say").some((e) => e.text === "Hello, town!" && e.home_id === A.home_id), "say on the town stream");
  assert.ok(townEvents("home").some((e) => e.id === A.home_id && e.dwelling === "treehouse" && e.style === "watercolor"), "home events carry dwelling + style");
  assert.ok(townEvents("tombstone").some((e) => e.name === "Solo" && e.persona_id), "tombstone on the town stream");
  assert.ok(townEvents("home_removed").some((e) => e.home_id === D.home_id), "home_removed on the town stream");
  assert.ok(townEvents("agent").some((e) => e.status === "ended"), "retired sessions walk home");

  console.log("town: all checks passed");
} finally {
  ac.abort();
  await db.end();
  server.kill();
}
