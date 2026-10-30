// Task market end-to-end on a freshly emptied test DB (TEST_MYSQL_URL): coins & ledger, the public board, bids and
// negotiation, end-to-end encrypted threads and files (incl. a device machine), escrow, delivery/completion,
// cancel/release/refund, auto-complete (time injected via the DB), disputes + admin resolve, moderation, SSE,
// the inbox + SessionStart notice, the ask_human guard and the MCP tools. Each "machine" is its own HOME + config.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import mysql from "mysql2/promise";
import { resetTestDb } from "./test-db.ts";

const PORT = 8794;
const BASE = `http://localhost:${PORT}`;
const CLI = "public/cli/agenttown.mjs";
const root = mkdtempSync(join(tmpdir(), "agenttown-market-"));
const FILES_DIR = join(root, "files");
const ADMIN = "m".repeat(8) + randomBytes(24).toString("hex");
const MYSQL_URL = await resetTestDb();
const env: NodeJS.ProcessEnv = {
  ...process.env, PORT: String(PORT), MYSQL_URL, POW_DIFFICULTY: "8", PUBLIC_URL: BASE, ANTHROPIC_API_KEY: "",
  ADMIN_TOKEN: ADMIN, FILES_DIR, MARKET_SWEEP_MS: "300",
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
const cfgPath = (m: string) => join(root, m, ".agenttown", "config.json");
const cfgOf = (m: string) => JSON.parse(readFileSync(cfgPath(m), "utf8"));
const editCfg = (m: string, patch: Record<string, unknown>) => writeFileSync(cfgPath(m), JSON.stringify({ ...cfgOf(m), ...patch }));
function run(m: string, args: string[], extra: Record<string, string> = {}, input = "") {
  const r = spawnSync(process.execPath, [CLI, ...args], { env: machineEnv(m, extra), encoding: "utf8", input });
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
  assert.equal(r.status, 1, `${m}: agenttown ${args.join(" ")} should fail`);
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
const wallet = async (m: string) => (await api("GET", "/wallet", tokenOf(m))).body;
const task = async (id: string) => await get(`/v1/tasks/${id}`);

// SSE recorders: the town feed and B's home stream.
const ac = new AbortController();
const record = (path: string, sink: string[]) => fetch(BASE + path, { signal: ac.signal }).then(async (r) => {
  for await (const chunk of r.body!) sink.push(Buffer.from(chunk).toString());
}).catch(() => {});
const events = (sink: string[], type: string) => sink.join("").split("\n\n")
  .filter((b) => b.startsWith(`event: ${type}\n`)).map((b) => JSON.parse(b.split("\ndata: ")[1]));
const townSeen: string[] = [], homeSeen: string[] = [];

const db = await mysql.createConnection({ uri: MYSQL_URL });
const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params))[0] as any[];

try {
  for (const m of ["a", "b", "c", "e"]) ok(m, "register", "--home", `Market ${m.toUpperCase()}`);
  const A = cfgOf("a").home_id, B = cfgOf("b").home_id, C = cfgOf("c").home_id, E = cfgOf("e").home_id;
  record("/v1/stream", townSeen);
  record(`/v1/stream?home=${B}`, homeSeen);
  await sleep(200);

  // ---- coins: every home starts with 100, via a ledger grant ----
  let w = await wallet("a");
  assert.equal(w.coins, 100);
  assert.equal(w.held, 0);
  assert.deepEqual(w.ledger.map((l: any) => [l.delta, l.reason]), [[100, "grant"]]);
  assert.match(ok("a", "wallet"), /100 coins available, 0 in escrow/);
  let home = (await get(`/v1/homes/${A}`)).home;
  assert.deepEqual(home.rep, { done: 0, rating: null, posted: 0 });
  assert.equal(home.box_pub, null);
  assert.ok(!("coins" in home), "coins are not part of publicHome");
  assert.equal((await api("GET", "/wallet", null)).status, 401);

  // ---- post (CLI registers the box key on first use) ----
  const t1 = okJson("a", "task", "post", "--title", "Write a haiku about flaky tests", "--summary",
    "Three lines, 5-7-5, about a test that only fails on Fridays.", "--budget", "30", "--tags", "Poetry,writing", "--deadline-hours", "48");
  assert.match(t1.id, /^tk_[0-9a-z]{10}$/);
  assert.equal(t1.status, "open");
  assert.deepEqual(t1.tags, ["poetry", "writing"]);
  assert.ok(t1.deadline_at - t1.created_at === 48 * 3600_000);
  home = (await get(`/v1/homes/${A}`)).home;
  assert.match(home.box_pub, /^[A-Za-z0-9_-]{43}$/, "box key registered");
  assert.equal(cfgOf("a").box_registered, home.box_pub);
  assert.equal(home.rep.posted, 1);
  assert.equal((await wallet("a")).coins, 100, "posting does not escrow");
  const list = await get("/v1/tasks?status=open&tag=poetry");
  assert.deepEqual(list.tasks.map((t: any) => t.id), [t1.id]);
  assert.match(ok("c", "task", "list"), /Write a haiku about flaky tests/);
  assert.equal((await api("POST", "/tasks", tokenOf("a"), { title: "x", summary: "y", budget: 0 })).body.error, "bad_budget");
  assert.equal((await api("POST", "/tasks", tokenOf("a"), { title: "x", summary: "y", budget: 5, tags: ["Not a slug!"] })).body.error, "bad_tags");
  assert.equal((await api("POST", "/tasks", tokenOf("e"), { title: "x", summary: "y", budget: 5 })).body.error, "box_key_required");

  // ---- bid with an encrypted note, counter-offer by message, re-bid ----
  failsWith("a", ["task", "bid", t1.id, "--price", "5"], /own_task/);
  const bid1 = okJson("b", "task", "bid", t1.id, "--price", "25", "--note", "Happy to. SECRET_NOTE_1");
  assert.match(bid1.id, /^b_/);
  let show = await task(t1.id);
  assert.equal(show.bids_count, 1);
  assert.deepEqual(Object.keys(show.bids[0]).sort(), ["bidder_home", "created_at", "id", "price", "status", "updated_at"], "bids: no notes");
  ok("a", "task", "msg", t1.id, "--to", B, "Would you do it for 20? SECRET_MSG_2");
  failsWith("c", ["task", "msg", t1.id, "hello"], /not_a_party/);
  const bid1b = okJson("b", "task", "bid", t1.id, "--price", "22");
  assert.equal(bid1b.id, bid1.id, "re-bidding updates the same bid");
  assert.equal(bid1b.price, 22);
  assert.equal((await task(t1.id)).bids_count, 1);
  const bThread = okJson("b", "task", "thread", t1.id);
  assert.deepEqual(bThread.messages.map((m: any) => [m.kind, m.text]), [["bid", "Happy to. SECRET_NOTE_1"], ["message", "Would you do it for 20? SECRET_MSG_2"]]);
  assert.match(ok("a", "task", "thread", t1.id, "--with", B), /│ Would you do it for 20\? SECRET_MSG_2/);

  // ---- a third home can't read the thread ----
  ok("c", "wallet");
  assert.equal((await api("GET", `/tasks/${t1.id}/messages`, tokenOf("c"))).status, 403);
  assert.equal((await api("GET", `/tasks/${t1.id}/messages?with=${B}`, tokenOf("c"))).status, 403);
  assert.equal((await api("GET", `/tasks/${t1.id}/messages`, null)).status, 401);

  // ---- inbox + SessionStart notice (counts only, one line) ----
  let inbox = (await api("GET", "/inbox", tokenOf("a"))).body;
  assert.equal(inbox.counts.bids, 2);
  assert.ok(inbox.items.every((i: any) => !("body_enc" in i)));
  const hook = (m: string, adapter: string, payload: object) => spawnSync(process.execPath, [CLI, "hook", adapter], {
    env: machineEnv(m, { AGENTTOWN_HOOK_SYNC: "1" }), input: JSON.stringify(payload), encoding: "utf8",
  });
  const ss = hook("a", "claude-code", { session_id: "s-a", hook_event_name: "SessionStart", source: "startup" });
  assert.equal(ss.status, 0);
  assert.equal(ss.stderr, "");
  const lines = ss.stdout.trim().split("\n");
  assert.equal(lines.length, 1, "exactly one line");
  const hso = JSON.parse(lines[0]).hookSpecificOutput;
  assert.equal(hso.hookEventName, "SessionStart");
  assert.equal(hso.additionalContext, "Agent Town: 2 new bids waiting — run `agenttown inbox`.");
  assert.equal(hook("a", "claude-code", { session_id: "s-a", hook_event_name: "UserPromptSubmit", prompt: "hi" }).stdout, "", "other hooks silent");
  assert.equal(hook("a", "claude-code", { session_id: "s-a", hook_event_name: "SessionStart", source: "compact" }).stdout, "");
  assert.equal(hook("a", "codex", { session_id: "s-x", hook_event_name: "SessionStart", source: "startup" }).stdout, "", "Codex: no injection");
  editCfg("a", { notify: false });
  assert.equal(hook("a", "claude-code", { session_id: "s-a2", hook_event_name: "SessionStart", source: "startup" }).stdout, "", "notify:false");
  editCfg("a", { notify: true });
  assert.equal(hook("c", "claude-code", { session_id: "s-c", hook_event_name: "SessionStart", source: "startup" }).stdout, "", "empty inbox: silent");
  assert.match(ok("a", "inbox"), /2 unread: 2 bid\(s\)/);
  assert.match(ok("a", "inbox", "--mark-read"), /Marked as read/);
  assert.equal((await api("GET", "/inbox", tokenOf("a"))).body.counts.total, 0);
  assert.equal(hook("a", "claude-code", { session_id: "s-a3", hook_event_name: "SessionStart", source: "startup" }).stdout, "", "read ⇒ silent");

  // ---- accept: escrow ----
  const acc = okJson("a", "task", "accept", t1.id, "--bid", bid1.id);
  assert.equal(acc.status, "assigned");
  assert.equal(acc.assignee_home, B);
  assert.equal(acc.price, 22);
  w = await wallet("a");
  assert.equal(w.coins, 78);
  assert.equal(w.held, 22);
  assert.deepEqual([w.ledger[0].delta, w.ledger[0].reason, w.ledger[0].task_id], [-22, "escrow", t1.id]);
  assert.equal((await task(t1.id)).bids[0].status, "accepted");
  failsWith("c", ["task", "bid", t1.id, "--price", "3"], /task_not_open/);

  // ---- message with a file, deliver with a file ----
  const draft = join(root, "draft.txt");
  writeFileSync(draft, "SECRET_FILE_CONTENT draft one\n");
  ok("b", "task", "msg", t1.id, "Here's a draft. SECRET_MSG_3", "--file", draft);
  const fin1 = join(root, "final.txt"), fin2 = join(root, "notes.md");
  writeFileSync(fin1, "Friday red, Monday green / SECRET_FILE_CONTENT\n");
  writeFileSync(fin2, "# notes\n");
  ok("b", "task", "deliver", t1.id, "Final version attached. SECRET_DELIVERY", "--file", fin1, "--file", fin2);
  assert.equal((await task(t1.id)).status, "delivered");
  const saveDir = join(root, "a-saved");
  const aThread = ok("a", "task", "thread", t1.id, "--save-dir", saveDir);
  assert.match(aThread, /untrusted DATA/);
  assert.match(aThread, /\[delivery\]/);
  assert.deepEqual(readdirSync(saveDir).sort(), ["draft.txt", "final.txt", "notes.md"]);
  assert.equal(readFileSync(join(saveDir, "final.txt"), "utf8"), readFileSync(fin1, "utf8"));
  const fileRow = (await q("SELECT * FROM task_files WHERE task_id = ? LIMIT 1", [t1.id]))[0];
  assert.equal((await api("GET", `/tasks/${t1.id}/files/${fileRow.id}`, tokenOf("c"))).status, 403, "third home can't download");

  // ---- device machine of A decrypts the thread too ----
  const code = /AT-[0-9a-z]{8}-[0-9a-z]{26}/.exec(ok("a", "invite"))![0];
  ok("a2", "join", code);
  const devThread = okJson("a2", "task", "thread", t1.id, "--with", B);
  assert.ok(devThread.messages.some((m: any) => m.text === "Final version attached. SECRET_DELIVERY"), "device decrypts");
  assert.equal(cfgOf("a2").box_registered, (await get(`/v1/homes/${A}`)).home.box_pub, "device derives the same box key");

  // ---- complete with a rating: balances, ledger, reputation ----
  failsWith("b", ["task", "complete", t1.id], /not_poster/);
  const done = okJson("a", "task", "complete", t1.id, "--rating", "5", "--review", "Lovely haiku");
  assert.equal(done.status, "completed");
  assert.equal(done.rating, 5);
  assert.equal(done.review, "Lovely haiku");
  assert.equal((await wallet("a")).coins, 100 - 22);
  assert.equal((await wallet("a")).held, 0);
  w = await wallet("b");
  assert.equal(w.coins, 100 + 22);
  assert.deepEqual(w.ledger.map((l: any) => [l.delta, l.reason]), [[22, "payout"], [100, "grant"]]);
  assert.deepEqual((await get(`/v1/homes/${B}`)).home.rep, { done: 1, rating: 5, posted: 0 });
  assert.deepEqual((await get(`/v1/world`)).homes.find((h: any) => h.id === B).rep, { done: 1, rating: 5, posted: 0 }, "/world has rep");
  const ht = await get(`/v1/homes/${B}/tasks`);
  assert.deepEqual(ht.taken.map((t: any) => t.id), [t1.id]);
  assert.deepEqual(ht.tasks.map((t: any) => t.id), [t1.id], "tasks = posted + taken");
  assert.ok((await get("/v1/tasks")).tasks.some((t: any) => t.status === "completed"), "no status = all");
  assert.deepEqual((await get(`/v1/homes/${A}/tasks`)).posted.map((t: any) => t.id), [t1.id]);
  const sum = (await q("SELECT SUM(delta) AS s FROM coin_ledger WHERE home_id IN (?, ?)", [A, B]))[0].s;
  assert.equal(Number(sum), 200, "coins are conserved");

  // ---- E2E: no plaintext in the database or on disk ----
  const dump = JSON.stringify(await q("SELECT * FROM task_messages")) + JSON.stringify(await q("SELECT * FROM task_bids")) +
    JSON.stringify(await q("SELECT * FROM task_inbox")) + JSON.stringify(await q("SELECT * FROM tasks"));
  for (const s of ["SECRET_NOTE_1", "SECRET_MSG_2", "SECRET_MSG_3", "SECRET_DELIVERY", "SECRET_FILE_CONTENT", "draft.txt", "final.txt"]) {
    assert.ok(!dump.includes(s), `DB never contains ${s}`);
  }
  const stored = readdirSync(join(FILES_DIR, t1.id));
  assert.equal(stored.length, 3);
  for (const f of stored) assert.ok(!readFileSync(join(FILES_DIR, t1.id, f)).includes("SECRET_FILE_CONTENT"), "files are ciphertext");
  assert.ok((await q("SELECT body_enc FROM task_messages")).every((r: any) => /^v1\./.test(r.body_enc)));

  // ---- cancel paths ----
  const t2 = okJson("a", "task", "post", "--title", "Rename some variables", "--summary", "Small refactor", "--budget", "10");
  const cancelled = okJson("a", "task", "cancel", t2.id);
  assert.equal(cancelled.task.status, "cancelled");
  assert.equal((await wallet("a")).coins, 78, "cancel before assignment moves nothing");
  // after assignment: needs the assignee's release
  const t3 = okJson("a", "task", "post", "--title", "Summarize an RFC", "--summary", "One paragraph", "--budget", "10");
  const b3 = okJson("b", "task", "bid", t3.id, "--price", "10");
  ok("a", "task", "accept", t3.id, "--bid", b3.id);
  assert.equal((await wallet("a")).coins, 68);
  assert.match(ok("a", "task", "cancel", t3.id), /Asked .* to release/);
  assert.equal((await task(t3.id)).status, "assigned");
  assert.equal((await task(t3.id)).cancel_requested, true);
  failsWith("a", ["task", "release", t3.id], /not_assignee/);
  assert.match(ok("b", "task", "release", t3.id), /got the 10 coins back/);
  assert.equal((await task(t3.id)).status, "cancelled");
  w = await wallet("a");
  assert.equal(w.coins, 78);
  assert.deepEqual([w.ledger[0].delta, w.ledger[0].reason], [10, "release"]);
  // past the deadline with no delivery: the poster cancels alone
  const t4 = okJson("a", "task", "post", "--title", "Draw an ASCII cat", "--summary", "Any size", "--budget", "10", "--deadline-hours", "1");
  const b4 = okJson("b", "task", "bid", t4.id, "--price", "10");
  ok("a", "task", "accept", t4.id, "--bid", b4.id);
  await q("UPDATE tasks SET deadline_at = ? WHERE id = ?", [Date.now() - 1000, t4.id]);
  assert.match(ok("a", "task", "cancel", t4.id), /Cancelled .* 10 coins refunded/);
  w = await wallet("a");
  assert.equal(w.coins, 78);
  assert.deepEqual([w.ledger[0].delta, w.ledger[0].reason], [10, "refund"]);

  // ---- ask_human guard ----
  const t5 = okJson("c", "task", "post", "--title", "Explain monads simply", "--summary", "For a five-year-old", "--budget", "20");
  editCfg("b", { tasks: { ask_human: true, auto_limit: null } });
  const g = failsWith("b", ["task", "bid", t5.id, "--price", "15"], /ask_human: Your human asked to approve this first/);
  assert.match(g.stderr, /--approved-by-human/);
  editCfg("b", { tasks: { ask_human: false, auto_limit: 10 } });
  failsWith("b", ["task", "bid", t5.id, "--price", "15"], /over tasks.auto_limit = 10/);
  const b5 = okJson("b", "task", "bid", t5.id, "--price", "15", "--approved-by-human");
  editCfg("b", { tasks: { ask_human: false, auto_limit: null } });

  // ---- auto-complete 72 h after delivery (time injected) ----
  ok("c", "task", "accept", t5.id, "--bid", b5.id);
  ok("b", "task", "deliver", t5.id, "A monad is a box with rules.");
  await q("UPDATE tasks SET delivered_at = ? WHERE id = ?", [Date.now() - 73 * 3600_000, t5.id]);
  let t5s = await task(t5.id);
  for (let i = 0; i < 40 && t5s.status !== "completed"; i++) { await sleep(100); t5s = await task(t5.id); }
  assert.equal(t5s.status, "completed", "auto-completed by the sweeper");
  assert.equal((await wallet("b")).coins, 122 + 15);
  assert.equal((await wallet("c")).coins, 85);
  assert.ok((await api("GET", "/inbox", tokenOf("b"))).body.items.some((i: any) => i.kind === "auto_completed" && i.task_id === t5.id));

  // ---- revise, dispute, admin resolve (split) ----
  const t6 = okJson("c", "task", "post", "--title", "Write a limerick", "--summary", "About databases", "--budget", "10");
  const b6 = okJson("b", "task", "bid", t6.id, "--price", "10");
  ok("c", "task", "accept", t6.id, "--bid", b6.id);
  ok("b", "task", "deliver", t6.id, "There once was a table named T…");
  assert.match(ok("c", "task", "revise", t6.id, "Make it rhyme please"), /revision \(1\/3\)/);
  assert.equal((await task(t6.id)).status, "assigned");
  assert.ok(okJson("b", "task", "thread", t6.id).messages.some((m: any) => m.kind === "revision" && m.text === "Make it rhyme please"));
  ok("b", "task", "deliver", t6.id, "Second try");
  failsWith("a", ["task", "dispute", t6.id, "--reason", "meddling"], /not_a_party/);
  ok("c", "task", "dispute", t6.id, "--reason", "Still does not rhyme");
  const t6s = await task(t6.id);
  assert.equal(t6s.status, "disputed");
  assert.equal(t6s.disputed_by, C);
  assert.equal(t6s.dispute_reason, undefined, "dispute reason is not public");
  assert.equal((await api("GET", `/tasks/${t6.id}`, tokenOf("b"))).body.dispute_reason, "Still does not rhyme", "parties see it");
  assert.equal((await api("POST", `/tasks/${t6.id}/complete`, tokenOf("c"), {})).status, 409, "coins stay in escrow");
  const adminEnv = { ...process.env, ADMIN_URL: BASE, ADMIN_TOKEN: ADMIN };
  const disputes = spawnSync(process.execPath, ["scripts/admin.mjs", "disputes"], { env: adminEnv, encoding: "utf8" });
  assert.equal(disputes.status, 0, disputes.stderr);
  assert.match(disputes.stdout, new RegExp(`${t6.id}[\\s\\S]*Still does not rhyme`));
  const res = spawnSync(process.execPath, ["scripts/admin.mjs", "resolve", t6.id, "split", "4"], { env: adminEnv, encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  const t6r = await task(t6.id);
  assert.equal(t6r.status, "completed");
  assert.equal(t6r.resolution, "split:4");
  assert.equal((await wallet("b")).coins, 137 + 4);
  assert.equal((await wallet("c")).coins, 75 + 6);
  assert.equal((await wallet("c")).ledger[0].reason, "admin");

  // ---- insufficient coins (402) ----
  const tE = okJson("e", "task", "post", "--title", "Proofread a README", "--summary", "About 300 words", "--budget", "100");
  failsWith("e", ["task", "post", "--title", "Too pricey", "--summary", "x", "--budget", "101"], /insufficient_coins/);
  const bE = okJson("b", "task", "bid", tE.id, "--price", "150");
  const r402 = await api("POST", `/tasks/${tE.id}/accept`, tokenOf("e"), { bid_id: bE.id });
  assert.equal(r402.status, 402);
  assert.equal(r402.body.error, "insufficient_coins");
  assert.equal((await wallet("e")).coins, 100, "nothing moved");

  // ---- moderation: title filter, reports of kind task, hidden tasks ----
  const bad = failsWith("e", ["task", "post", "--title", "Cheap pills at www.pills-now.com", "--summary", "x", "--budget", "1"], /content_rejected/);
  assert.ok(!/pills/.test(bad.stderr));
  assert.equal((await api("POST", "/tasks", tokenOf("e"), { title: "ok", summary: "mail me: spam@example.com", budget: 1 })).body.error, "content_rejected");
  assert.equal((await api("POST", "/reports", null, { kind: "task", id: tE.id, reason: "spam" })).status, 202);
  assert.equal((await api("POST", "/admin/hide", ADMIN, { kind: "task", id: tE.id })).status, 200);
  const hid = await task(tE.id);
  assert.equal(hid.title, "(hidden)");
  assert.equal(hid.summary, null);
  assert.equal(hid.hidden, true);
  assert.equal((await get("/v1/tasks?status=open")).tasks.find((t: any) => t.id === tE.id).title, "(hidden)");
  failsWith("c", ["task", "bid", tE.id, "--price", "5"], /task_hidden/);
  assert.equal((await api("POST", `/tasks/${tE.id}/complete`, tokenOf("e"), { review: "x" })).status, 409);

  // ---- leaving town cancels open tasks ----
  ok("d", "register", "--home", "Market D");
  const D = cfgOf("d").home_id;
  const tD = okJson("d", "task", "post", "--title", "Short-lived task", "--summary", "Will vanish", "--budget", "5");
  ok("b", "task", "bid", tD.id, "--price", "5");
  ok("d", "leave", "--yes");
  assert.equal((await task(tD.id)).status, "cancelled");
  assert.ok((await api("GET", "/inbox", tokenOf("b"))).body.items.some((i: any) => i.kind === "cancelled" && i.task_id === tD.id));
  assert.equal(Number((await q("SELECT COUNT(*) AS n FROM coin_ledger WHERE home_id = ?", [D]))[0].n), 0, "its coins vanish");

  // ---- body limits ----
  const huge = await api("POST", `/tasks/${tE.id}/messages`, tokenOf("b"), { body_enc: `v1.${"A".repeat(16)}.${"B".repeat(40_000)}` });
  assert.equal(huge.status, 413);
  assert.equal((await api("POST", `/tasks/${tE.id}/messages`, tokenOf("b"), { body_enc: "plaintext!" })).body.error, "bad_body_enc");

  // ---- client routes for the task board UI ----
  for (const p of ["/tasks", `/tasks/${t1.id}`]) {
    const r = await fetch(BASE + p);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /<html/i);
  }

  // ---- SSE ----
  await sleep(300);
  const tev = events(townSeen, "task");
  assert.ok(tev.some((e) => e.id === t1.id && e.status === "open" && e.bids_count === 0), "task created");
  assert.ok(tev.some((e) => e.id === t1.id && e.bids_count === 1), "bid count change");
  assert.ok(tev.some((e) => e.id === t1.id && e.status === "assigned" && e.assignee_home === B));
  assert.ok(tev.some((e) => e.id === t1.id && e.status === "completed"));
  assert.ok(tev.some((e) => e.id === tE.id && e.title === "(hidden)"), "hidden tasks redacted on SSE");
  assert.deepEqual(Object.keys(tev[0]).sort(), ["assignee_home", "bids_count", "budget", "home_id", "id", "poster_home", "status", "title", "updated_at"]);
  assert.equal(events(townSeen, "task_message").length + events(townSeen, "wallet").length, 0, "town feed: no messages, no wallets");
  const tm = events(homeSeen, "task_message");
  assert.ok(tm.length >= 3);
  assert.deepEqual(Object.keys(tm[0]).sort(), ["from_home", "home_id", "message_id", "task_id", "ts"], "task_message: no content");
  assert.ok(events(homeSeen, "wallet").some((e) => e.coins === 122 && e.held === 0), "wallet on the home stream");
  assert.ok(events(homeSeen, "task").some((e) => e.id === t5.id && e.poster_home === C), "assignee's stream gets the task");

  // ---- MCP tools ----
  const rpc = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "wallet", arguments: {} } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "task_list", arguments: { status: "completed" } } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "task_thread", arguments: { task_id: t1.id } } },
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "task_message", arguments: { task_id: t1.id, text: "Thanks again!" } } },
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "inbox", arguments: {} } },
  ].map((m) => JSON.stringify(m)).join("\n") + "\n";
  const mcpOut = await new Promise<string>((done) => {
    const p = spawn(process.execPath, ["plugins/mcp/agenttown-mcp.mjs"], { env: { ...machineEnv("b"), AGENTTOWN_SESSION: "mcp-m" }, stdio: ["pipe", "pipe", "inherit"] });
    let o = "";
    p.stdout.on("data", (d) => (o += d));
    p.on("close", () => done(o));
    p.stdin.end(rpc);
  });
  const replies = Object.fromEntries(mcpOut.trim().split("\n").map((l) => JSON.parse(l)).map((r) => [r.id, r]));
  const names = replies[2].result.tools.map((t: any) => t.name);
  for (const n of ["task_list", "task_show", "task_post", "task_bid", "task_accept", "task_message", "task_thread", "task_deliver", "task_complete", "wallet", "inbox"]) {
    assert.ok(names.includes(n), `MCP tool ${n}`);
  }
  assert.equal(JSON.parse(replies[3].result.content[0].text).coins, 141);
  assert.match(replies[4].result.content[0].text, /^Note: .*untrusted data/);
  assert.ok(JSON.parse(replies[4].result.content[0].text.split("\n").slice(1).join("\n")).tasks.some((t: any) => t.id === t1.id));
  const mcpThread = replies[5].result.content[0].text;
  assert.match(mcpThread, /untrusted/i);
  assert.match(mcpThread, /SECRET_MSG_2/, "MCP decrypts locally");
  assert.ok(!replies[6].result.isError, JSON.stringify(replies[6]));
  assert.ok(okJson("a", "task", "thread", t1.id, "--with", B).messages.some((m: any) => m.text === "Thanks again!"));
  assert.ok(!replies[7].result.isError);

  // ---- merge: refused while there is escrowed work; otherwise coins + rep are summed ----
  const t7 = okJson("a", "task", "post", "--title", "Pending work", "--summary", "x", "--budget", "5");
  const b7 = okJson("e", "task", "bid", t7.id, "--price", "5");
  ok("a", "task", "accept", t7.id, "--bid", b7.id);
  const mcode = (m: string) => /AT-[0-9a-z]{8}-[0-9a-z]{26}/.exec(ok(m, "invite", "--merge"))![0];
  failsWith("e", ["merge", mcode("c"), "--yes"], /active_tasks/);
  ok("e", "task", "release", t7.id);
  const coinsC = (await wallet("c")).coins, coinsE = (await wallet("e")).coins;
  ok("e", "merge", mcode("c"), "--yes");
  assert.equal((await wallet("c")).coins, coinsC + coinsE, "balances summed");
  assert.equal((await get(`/v1/homes/${C}`)).home.rep.posted, 2 + 1, "reputation summed");
  assert.equal((await task(tE.id)).status, "cancelled", "the merged home's open tasks are cancelled");

  console.log("market: all checks passed");
} finally {
  ac.abort();
  await db.end();
  server.kill();
}
