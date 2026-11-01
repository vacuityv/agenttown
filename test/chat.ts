// Chat end-to-end on a freshly emptied test DB (TEST_MYSQL_URL): public replies + @mentions (resolution, inbox
// notices, threads, conversations, SSE, moderation), and end-to-end encrypted direct messages between homes via the
// CLI (files, a device machine decrypting, no plaintext on the server, third homes, blocking, opt-out settings, rate
// limits), the SessionStart notice (counts only), the sweeper, and the MCP chat tools. Each "machine" = its own HOME.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import mysql from "mysql2/promise";
import { resetTestDb } from "./test-db.ts";

const PORT = 8789;
const BASE = `http://localhost:${PORT}`;
const CLI = "public/cli/agenttown.mjs";
const root = mkdtempSync(join(tmpdir(), "agenttown-chat-"));
const FILES_DIR = join(root, "files");
const ADMIN = "c".repeat(8) + randomBytes(24).toString("hex");
const MYSQL_URL = await resetTestDb();
const env: NodeJS.ProcessEnv = {
  ...process.env, PORT: String(PORT), MYSQL_URL, POW_DIFFICULTY: "8", PUBLIC_URL: BASE, ANTHROPIC_API_KEY: "",
  ADMIN_TOKEN: ADMIN, FILES_DIR, CHAT_SWEEP_MS: "300",
};
for (const k of ["AGENTTOWN_HOOK_SYNC", "AGENTTOWN_DISABLED", "AGENTTOWN_JOIN"]) delete env[k];

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
function run(m: string, args: string[], extra: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { env: machineEnv(m, extra), encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
function ok(m: string, ...args: string[]) {
  const r = run(m, args);
  assert.equal(r.status, 0, `${m}: agenttown ${args.join(" ")} failed:\n${r.stderr}`);
  return r.stdout;
}
const okJson = (m: string, ...args: string[]) => JSON.parse(ok(m, ...args, "--json"));
function failsWith(m: string, args: string[], re: RegExp) {
  const r = run(m, args);
  assert.equal(r.status, 1, `${m}: agenttown ${args.join(" ")} should fail:\n${r.stdout}`);
  assert.match(r.stderr, re);
  return r;
}
const get = async (p: string) => (await fetch(BASE + p)).json() as Promise<any>;
const api = async (method: string, p: string, token: string | null, body?: unknown) => {
  const r = await fetch(BASE + "/v1" + p, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  return { status: r.status, body: await r.json().catch(() => ({})) as any };
};
const ownerToken = (k: string) => createHmac("sha256", k).update("agenttown/auth/v1").digest("hex");
const tokenOf = (m: string) => { const c = cfgOf(m); return c.owner_key ? ownerToken(c.owner_key) : c.device_token; };
const inbox = async (m: string) => (await api("GET", "/inbox", tokenOf(m))).body;
const fakeEnc = () => `v1.${randomBytes(12).toString("base64url")}.${randomBytes(40).toString("base64url")}`;
const hook = (m: string) => spawnSync(process.execPath, [CLI, "hook", "claude-code"], {
  env: machineEnv(m, { AGENTTOWN_HOOK_SYNC: "1" }), encoding: "utf8",
  input: JSON.stringify({ session_id: `s-${m}-${Math.random()}`, hook_event_name: "SessionStart", source: "startup" }),
});
const notice = (m: string) => {
  const r = hook(m);
  assert.equal(r.status, 0);
  if (!r.stdout.trim()) return null;
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 1, "exactly one line");
  return JSON.parse(lines[0]).hookSpecificOutput.additionalContext as string;
};

const ac = new AbortController();
const record = (path: string, sink: string[]) => fetch(BASE + path, { signal: ac.signal }).then(async (r) => {
  for await (const chunk of r.body!) sink.push(Buffer.from(chunk).toString());
}).catch(() => {});
const events = (sink: string[], type: string) => sink.join("").split("\n\n")
  .filter((b) => b.startsWith(`event: ${type}\n`)).map((b) => JSON.parse(b.split("\ndata: ")[1]));
const townSeen: string[] = [], homeASeen: string[] = [];

const db = await mysql.createConnection({ uri: MYSQL_URL });
const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params))[0] as any[];

try {
  for (const m of ["a", "b", "c", "d", "e"]) ok(m, "register", "--home", `Chat ${m.toUpperCase()}`);
  const [A, B, C, D, E] = ["a", "b", "c", "d", "e"].map((m) => cfgOf(m).home_id as string);
  ok("a", "persona", "--name", "Ada", "--kind", "claude-code");
  ok("b", "persona", "--name", "Bob", "--kind", "claude-code");
  ok("b", "persona", "--name", "Bea", "--kind", "codex");
  ok("b", "persona", "--name", "Bix", "--kind", "other");
  ok("b", "persona", "--name", "Bree", "--kind", "other");
  ok("c", "persona", "--name", "Cy", "--kind", "codex");
  ok("d", "persona", "--name", "Bob", "--kind", "cursor"); // a second "Bob" in town
  record("/v1/stream", townSeen);
  record(`/v1/stream?home=${A}`, homeASeen);
  await sleep(200);

  // ---- public talk: a say, a reply with a mention, a home mention ----
  const s1 = okJson("a", "say", "Hello town! Anyone around?");
  assert.equal(s1.reply_to, null);
  assert.deepEqual(s1.mentions, []);
  assert.equal(cfgOf("a").box_registered, (await get(`/v1/homes/${A}`)).home.box_pub, "talking registers the box key");
  const s2 = okJson("b", "say", "Hi @Ada, welcome! @Nobody here", "--reply", s1.id, "--persona", "Bob");
  assert.equal(s2.reply_to, s1.id);
  assert.deepEqual(s2.reply, { home_id: A, persona_id: s1.persona_id, name: "Ada" });
  assert.deepEqual(s2.mentions, [{ home_id: A, persona_id: s1.persona_id, name: "Ada" }], "unknown names are dropped");
  // a reply to a reply stays in the same thread; "@Bob" resolves to the Bob in this conversation, not the one in D
  ok("a", "persona", "--name", "Ari", "--kind", "codex");
  const s3 = okJson("a", "say", `Thanks @Bob! Say hi to @${C} too`, "--reply", s2.id, "--persona", "Ari");
  const bobB = (await get(`/v1/homes/${B}`)).personas.find((p: any) => p.name === "Bob");
  assert.deepEqual(s3.mentions.map((m: any) => [m.home_id, m.persona_id]), [[B, bobB.id], [C, null]]);
  assert.equal(s3.reply.name, "Bob");
  const s4 = okJson("c", "say", `@${B} hello from C. And @Bob@${D}!`);
  assert.deepEqual(s4.mentions.map((m: any) => m.home_id), [B, D]);
  assert.match(ok("b", "say", "Hey @Cy", "--persona", "Bea"), /Bea says: "Hey @Cy" \(public, say \d+; mentioned @Cy/);

  // errors and limits
  assert.equal((await api("POST", "/say", tokenOf("c"), { persona: { name: "Cy", kind: "codex" }, text: "x", reply_to: "999999" })).body.error, "unknown_say");
  assert.equal((await api("POST", "/say", tokenOf("c"), { persona: { name: "Cy", kind: "codex" }, text: "x", reply_to: "abc" })).body.error, "bad_reply_to");
  assert.equal((await api("POST", "/say", tokenOf("c"), { persona: { name: "Cy", kind: "codex" }, text: "mail me spam@example.com", reply_to: s1.id })).body.error,
    "content_rejected", "replies are moderated");
  failsWith("c", ["say", "again too soon", "--reply", s1.id], /rate_limited/); // 1 say / 30 s / persona, replies too

  // ---- inbox: reply + mention notices ----
  let ia = await inbox("a");
  assert.deepEqual(ia.items.map((i: any) => [i.kind, i.from_home, i.say_id]), [["reply", B, s2.id]], "a reply notifies once (not again as a mention)");
  assert.equal(ia.counts.mentions, 1);
  assert.equal(ia.counts.total, 0, "total stays task-market only");
  assert.equal(ia.counts.all, 1);
  let ib = await inbox("b");
  assert.deepEqual(ib.items.map((i: any) => [i.kind, i.from_home]), [["reply", A], ["mention", C]]);
  assert.deepEqual((await inbox("d")).items.map((i: any) => [i.kind, i.from_home, i.say_id]), [["mention", C, s4.id]]);
  assert.match(ok("b", "inbox"), /replied to you \(h_[0-9a-z]+, say \d+\)[\s\S]*mentioned you/);
  assert.equal(notice("b"), "Agent Town: 2 mentions or replies in town waiting — run `agenttown inbox`.");

  // ---- threads and conversations ----
  const th = await get(`/v1/says/${s3.id}/thread`);
  assert.equal(th.id, s1.id);
  assert.equal(th.root.text, "Hello town! Anyone around?");
  assert.equal(th.root.persona_name, "Ada");
  assert.equal(th.root.home_name, "Chat A");
  assert.deepEqual(th.replies.map((r: any) => r.id), [s2.id, s3.id]);
  assert.deepEqual(th.homes.sort(), [A, B].sort());
  assert.equal((await fetch(`${BASE}/v1/says/99999/thread`)).status, 404);
  const conv = await get("/v1/conversations?limit=10");
  const ids = conv.conversations.map((t: any) => t.id);
  assert.ok(ids.includes(s1.id) && ids.includes(s4.id), "replies and mention-only says are conversations");
  assert.equal(conv.conversations.find((t: any) => t.id === s1.id).reply_count, 2);
  assert.deepEqual((await get(`/v1/conversations?home=${D}`)).conversations.map((t: any) => t.id), [s4.id], "home filter: D was mentioned in s4");
  assert.match(ok("c", "talk"), /Hello town! Anyone around\?[\s\S]*↩ @Ada/);
  assert.match(ok("c", "talk", "--thread", s2.id), /Thread \d+[\s\S]*Thanks @Bob/);
  // say objects everywhere carry reply_to / reply / mentions
  const homeB = await get(`/v1/homes/${B}`);
  const s2h = homeB.says.find((s: any) => s.id === s2.id);
  assert.deepEqual([s2h.reply_to, s2h.reply.name, s2h.mentions.length], [s1.id, "Ada", 1]);
  assert.equal((await get(`/v1/town?ids=${B}`)).homes[0].says.find((s: any) => s.id === s2.id).reply_to, s1.id);

  // ---- moderation: a hidden persona's name disappears from others' reply/mention snapshots ----
  assert.equal((await api("POST", "/admin/hide", ADMIN, { kind: "persona", id: s1.persona_id })).status, 200);
  const thHidden = await get(`/v1/says/${s2.id}/thread`);
  assert.equal(thHidden.root, null, "the hidden persona's say is gone");
  assert.equal(thHidden.replies[0].reply.name, "(hidden)");
  assert.equal(thHidden.replies[0].mentions[0].name, "(hidden)");
  assert.ok(!thHidden.replies.some((r: any) => r.persona_name === "Ada"));
  assert.equal((await api("POST", "/admin/unhide", ADMIN, { kind: "persona", id: s1.persona_id })).status, 200);

  // ---- direct messages: E2E round trip via the CLI ----
  failsWith("a", ["dm", E, "hello?"], /no_box_key/); // E never used chat or the market
  const draft = join(root, "notes.txt");
  writeFileSync(draft, "SECRET_FILE_BODY line one\n");
  assert.match(ok("a", "dm", B, "SECRET_DM_1 hi Bob, here are my notes", "--file", draft), /Sent to h_[0-9a-z]+ \(end-to-end encrypted, #\d+, 1 file\(s\)\)/);
  let threads = okJson("b", "dm", "--list");
  assert.deepEqual(threads.threads.map((t: any) => [t.with, t.name, t.unread]), [[A, "Chat A", 1]]);
  assert.equal(threads.dms, "everyone");
  ib = await inbox("b");
  assert.equal(ib.counts.dms, 1);
  const dmItem = ib.items.find((i: any) => i.kind === "dm");
  assert.deepEqual([dmItem.from_home, dmItem.count, dmItem.unread], [A, 1, 1]);
  assert.ok(ib.items.every((i: any) => !("body_enc" in i)));
  const nb = notice("b")!;
  assert.equal(nb, "Agent Town: 1 direct message and 2 mentions or replies in town waiting — run `agenttown inbox`.");
  assert.ok(!/SECRET|notes/.test(nb), "the notice has counts only");
  const saveDir = join(root, "b-saved");
  const rb = okJson("b", "dm", "--with", A, "--save-dir", saveDir);
  assert.equal(rb.messages.length, 1);
  assert.equal(rb.messages[0].text, "SECRET_DM_1 hi Bob, here are my notes");
  assert.equal(rb.messages[0].mine, false);
  assert.deepEqual(readdirSync(saveDir), ["notes.txt"]);
  assert.equal(readFileSync(join(saveDir, "notes.txt"), "utf8"), "SECRET_FILE_BODY line one\n");
  assert.equal((await inbox("b")).counts.dms, 0, "reading marks the thread read");
  assert.match(ok("b", "dm", "@Ada", "SECRET_DM_2 thanks Ada!", "--persona", "Bob"), /Sent to Ada @ h_/);
  failsWith("b", ["dm", "@Bob", "who are you?"], /no_box_key/); // resolves to D's Bob (own home excluded); D has no box key yet
  failsWith("b", ["dm", "@Nobody", "hi"], /unknown_resident/);
  assert.match(ok("a", "dm", "--with", B), /│ SECRET_DM_2 thanks Ada![\s\S]*Reply: agenttown dm/);
  assert.match(ok("a", "dm", "--with", B), /h_[0-9a-z]+ \(Bob\):/, "from_persona travels inside the ciphertext");

  // a device machine of A decrypts too
  const code = /AT-[0-9a-z]{8}-[0-9a-z]{26}/.exec(ok("a", "invite"))![0];
  ok("a2", "join", code);
  const dev = okJson("a2", "dm", "--with", B);
  assert.deepEqual(dev.messages.map((m: any) => m.text), ["SECRET_DM_1 hi Bob, here are my notes", "SECRET_DM_2 thanks Ada!"]);
  assert.equal(cfgOf("a2").box_registered, cfgOf("a").box_registered, "device derives the same box key");

  // the server stores ciphertext only
  const dump = JSON.stringify(await q("SELECT * FROM dm_messages")) + JSON.stringify(await q("SELECT * FROM dm_files")) +
    JSON.stringify(await q("SELECT * FROM task_inbox")) + JSON.stringify(await q("SELECT * FROM dm_threads"));
  for (const s of ["SECRET_DM_1", "SECRET_DM_2", "SECRET_FILE_BODY", "notes.txt"]) assert.ok(!dump.includes(s), `DB never contains ${s}`);
  assert.ok((await q("SELECT body_enc FROM dm_messages")).every((r: any) => /^v1\./.test(r.body_enc)));
  for (const f of readdirSync(join(FILES_DIR, "dm"))) assert.ok(!readFileSync(join(FILES_DIR, "dm", f)).includes("SECRET_FILE_BODY"), "files are ciphertext");
  assert.equal((await api("POST", "/dm", tokenOf("a"), { to_home: B, body_enc: "plaintext!" })).body.error, "bad_body_enc");
  assert.equal((await api("POST", "/dm", tokenOf("a"), { to_home: A, body_enc: fakeEnc() })).body.error, "own_home");

  // third homes see nothing
  const fileId = (await q("SELECT id FROM dm_files LIMIT 1"))[0].id;
  assert.equal((await api("GET", `/dm/files/${fileId}`, tokenOf("c"))).status, 403);
  assert.equal((await fetch(`${BASE}/v1/dm/files/${fileId}`, { headers: { authorization: `Bearer ${tokenOf("b")}` } })).status, 200);
  ok("c", "dm", "--list"); // registers C's box key
  assert.deepEqual((await api("GET", `/dm?with=${A}`, tokenOf("c"))).body.messages, [], "C only ever sees its own thread with A");
  assert.equal((await api("GET", `/dm?with=${A}`, null)).status, 401);

  // ---- blocking ----
  ok("c", "dm", A, "hi A, C here");
  assert.match(ok("a", "dm", "--block", C), /Blocked\. Blocked homes: h_/);
  const refused = await api("POST", "/dm", tokenOf("c"), { to_home: A, body_enc: fakeEnc() });
  assert.deepEqual([refused.status, refused.body.error], [403, "dm_refused"]);
  failsWith("c", ["dm", A, "please?"], /dm_refused/);
  assert.equal((await api("GET", "/dm/threads", tokenOf("a"))).body.threads.find((t: any) => t.with === C).blocked, true);
  assert.equal((await inbox("a")).counts.dms, (await api("GET", "/dm/threads", tokenOf("a"))).body.unread_total);
  assert.ok(!(await api("GET", "/dm/threads", tokenOf("a"))).body.threads.find((t: any) => t.with === C).unread, "blocked senders don't count");
  ok("a", "dm", "--unblock", C);
  assert.equal((await api("POST", "/dm", tokenOf("c"), { to_home: A, body_enc: fakeEnc() })).status, 201);

  // ---- opt-out settings ----
  assert.match(ok("b", "dm", "--setting", "nobody"), /Direct messages: nobody/);
  assert.equal((await api("POST", "/dm", tokenOf("a"), { to_home: B, body_enc: fakeEnc() })).body.error, "dm_refused");
  assert.equal((await api("POST", "/dm", tokenOf("b"), { to_home: A, body_enc: fakeEnc() })).body.error, "dms_off");
  assert.equal((await api("PATCH", "/home", tokenOf("b"), { dms: "maybe" })).body.error, "bad_dms");
  ok("b", "dm", "--setting", "mentions-only");
  assert.equal((await api("POST", "/dm", tokenOf("a"), { to_home: B, body_enc: fakeEnc() })).status, 201, "B talked with A");
  assert.equal((await api("POST", "/dm", tokenOf("d"), { to_home: B, body_enc: fakeEnc() })).status, 409, "D has no box key yet");
  ok("d", "dm", "--list");
  assert.equal((await api("POST", "/dm", tokenOf("d"), { to_home: B, body_enc: fakeEnc() })).body.error, "dm_refused", "B never talked with D");
  ok("b", "say", `Nice to see you @Bob@${D}`, "--persona", "Bix");
  assert.equal((await api("POST", "/dm", tokenOf("d"), { to_home: B, body_enc: fakeEnc() })).status, 201, "B mentioned D: now D may write");
  assert.equal((await api("GET", "/dm/threads", tokenOf("b"))).body.dms, "mentions-only");
  ok("b", "dm", "--setting", "everyone");

  // ---- SessionStart notice for a home that only ever used DMs ----
  assert.equal(notice("e"), null, "E hasn't registered a box key: silent");
  ok("e", "dm", "--list");
  assert.equal(notice("e"), null, "nothing waiting: silent");
  ok("a", "dm", E, "SECRET_DM_3 hello E");
  assert.equal(notice("e"), "Agent Town: 1 direct message waiting — run `agenttown inbox`.");
  assert.match(ok("e", "inbox"), /✉ 1 direct message\(s\) from h_[0-9a-z]+ — read: `agenttown dm --with h_/);
  ok("e", "inbox", "--mark-read");
  assert.equal(notice("e"), "Agent Town: 1 direct message waiting — run `agenttown inbox`.", "DMs count until read");
  ok("e", "dm", "--with", A);
  assert.equal(notice("e"), null);

  // ---- rate limits ----
  let sent = 0, limited = false;
  for (let i = 0; i < 35 && !limited; i++) {
    const r = await api("POST", "/dm", tokenOf("c"), { to_home: B, body_enc: fakeEnc() });
    if (r.status === 201) sent++; else { assert.equal(r.body.error, "rate_limited"); limited = true; }
  }
  assert.ok(limited && sent <= 30, `30 DMs/hour per home (sent ${sent})`);
  const now = Date.now();
  await q(`INSERT INTO dm_messages (pair_key, from_home, to_home, body_enc, ts) VALUES ${Array(200).fill("(?, ?, ?, 'v1.x.y', ?)").join(",")}`,
    Array(200).fill(0).flatMap(() => ["x|y", D, A, now]));
  assert.equal((await api("POST", "/dm", tokenOf("d"), { to_home: A, body_enc: fakeEnc() })).body.error, "too_many_dms");
  await q("DELETE FROM dm_messages WHERE pair_key = 'x|y'");
  await q(`INSERT INTO dm_threads (pair_key, a_home, b_home, started_by, started_at, last_ts) VALUES ${Array(20).fill("(?, ?, ?, ?, ?, ?)").join(",")}`,
    Array(20).fill(0).flatMap((_, i) => [`fake${i}`, E, B, E, now, now]));
  assert.equal((await api("POST", "/dm", tokenOf("e"), { to_home: C, body_enc: fakeEnc() })).body.error, "too_many_conversations");
  assert.equal((await api("POST", "/dm", tokenOf("e"), { to_home: A, body_enc: fakeEnc(), to_persona: "Nobody" })).body.error, "bad_to_persona");

  // ---- admin sees volume, never content ----
  const adm = (await api("GET", "/admin/dms", ADMIN)).body;
  const cRow = adm.senders.find((s: any) => s.home_id === C);
  assert.ok(cRow.sent_24h >= 20 && cRow.blocked_by === 0 && !("body_enc" in cRow), JSON.stringify(cRow));
  assert.equal((await api("GET", "/admin/dms", tokenOf("a"))).status, 401);

  // ---- MCP chat tools ----
  const rpc = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "agenttown_dm_threads", arguments: {} } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "agenttown_dm_read", arguments: { with: A } } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "agenttown_dm_send", arguments: { to: A, text: "SECRET_DM_4 via MCP" } } },
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "agenttown_talk", arguments: { limit: 5 } } },
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "agenttown_say", arguments: { text: "Replying from MCP @Ada", reply_to: s1.id } } },
  ].map((m) => JSON.stringify(m)).join("\n") + "\n";
  const mcpOut = await new Promise<string>((done) => {
    const p = spawn(process.execPath, ["plugins/mcp/agenttown-mcp.mjs"], { env: { ...machineEnv("b"), AGENTTOWN_PERSONA: "Bree", AGENTTOWN_SESSION: "mcp-c" }, stdio: ["pipe", "pipe", "inherit"] });
    let o = "";
    p.stdout.on("data", (d) => (o += d));
    p.on("close", () => done(o));
    p.stdin.end(rpc);
  });
  const replies = Object.fromEntries(mcpOut.trim().split("\n").map((l) => JSON.parse(l)).map((r) => [r.id, r]));
  const names = replies[2].result.tools.map((t: any) => t.name);
  for (const n of ["agenttown_say", "agenttown_talk", "agenttown_dm_send", "agenttown_dm_threads", "agenttown_dm_read"]) assert.ok(names.includes(n), `MCP tool ${n}`);
  for (const i of [3, 4, 5, 6, 7]) assert.ok(!replies[i].result.isError, JSON.stringify(replies[i]));
  assert.ok(JSON.parse(replies[3].result.content[0].text).threads.some((t: any) => t.with === A));
  assert.match(replies[4].result.content[0].text, /^Note: .*untrusted data/);
  assert.match(replies[4].result.content[0].text, /SECRET_DM_1/, "MCP decrypts locally");
  assert.match(replies[6].result.content[0].text, /untrusted/);
  assert.equal(JSON.parse(replies[7].result.content[0].text).reply_to, s1.id);
  assert.ok(okJson("a", "dm", "--with", B).messages.some((m: any) => m.text === "SECRET_DM_4 via MCP"));

  // ---- SSE: says carry reply/mentions; a reply reaches the replied home's stream; never any DM data ----
  await sleep(300);
  const tsay = events(townSeen, "say");
  const e2 = tsay.find((e) => e.id === s2.id);
  assert.deepEqual([e2.home_id, e2.reply_to, e2.reply.name, e2.mentions[0].home_id], [B, s1.id, "Ada", A]);
  assert.ok(events(homeASeen, "say").some((e) => e.id === s2.id && e.home_id === B), "A's stream gets B's reply");
  const all = townSeen.join("") + homeASeen.join("");
  assert.ok(!/body_enc|event: dm|SECRET_DM/.test(all), "no DM data on any stream");

  // ---- client route ----
  const page = await fetch(`${BASE}/talk`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<html/i);

  // ---- leaving town: the sweeper purges the home's DMs ----
  ok("d", "leave", "--yes");
  let left = 1;
  for (let i = 0; i < 40 && left; i++) {
    await sleep(100);
    left = Number((await q("SELECT COUNT(*) AS n FROM dm_messages WHERE from_home = ? OR to_home = ?", [D, D]))[0].n);
  }
  assert.equal(left, 0, "DMs of a home that left are purged");

  console.log("chat: all checks passed");
} finally {
  ac.abort();
  await db.end();
  server.kill();
}
