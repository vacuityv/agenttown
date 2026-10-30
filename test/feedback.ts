// Feedback to the operator, end to end on a freshly emptied test DB (TEST_MYSQL_URL): web and CLI submissions (anonymous
// and attributed), the honeypot, limits, rate limits, privacy (never on a public endpoint or stream) and the admin API /
// scripts/admin.mjs.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { resetTestDb } from "./test-db.ts";

const PORT = 8792, PORT2 = 8791;
const BASE = `http://localhost:${PORT}`;
const ADMIN = "f".repeat(8) + randomBytes(24).toString("hex");
const MYSQL_URL = await resetTestDb();
const dir = mkdtempSync(join(tmpdir(), "agenttown-feedback-"));
const env = { ...process.env, MYSQL_URL, POW_DIFFICULTY: "8", ANTHROPIC_API_KEY: "", TRUST_PROXY: "1" };

function boot(port: number, extra: Record<string, string>): Promise<ChildProcess> {
  const p = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server/index.ts"], {
    env: { ...env, PORT: String(port), PUBLIC_URL: `http://localhost:${port}`, ...extra }, stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((ok, fail) => {
    p.stdout!.on("data", (d) => String(d).includes("listening") && ok(p));
    p.on("exit", (code) => fail(new Error(`server exited (${code})`)));
  });
}
const server = await boot(PORT, { ADMIN_TOKEN: ADMIN });
let server2: ChildProcess | null = null;

let ipSeq = 0;
const freshIp = () => `10.7.${Math.floor(++ipSeq / 250)}.${ipSeq % 250 + 1}`;
async function call(method: string, p: string, { token, body, ip, base = BASE }: { token?: string; body?: unknown; ip?: string; base?: string } = {}) {
  const r = await fetch(base + "/v1" + p, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json", "x-real-ip": ip ?? freshIp(), ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  return { status: r.status, body: await r.json().catch(() => ({})) as any };
}
const send = (body: unknown, opts: { token?: string; ip?: string } = {}) => call("POST", "/feedback", { body, ...opts });
const admin = (method: string, p: string, body?: unknown, token = ADMIN) => call(method, "/admin" + p, { token, body, ip: "10.9.9.9" });
const listAll = async () => (await admin("GET", "/feedback?status=all")).body.feedback as any[];
const byId = async (id: string) => (await listAll()).find((f) => f.id === id);

const cliEnv = (name: string) => ({ ...env, AGENTTOWN_CONFIG: join(dir, name, "config.json"), AGENTTOWN_SERVER: BASE });
const cli = (cfg: string, ...args: string[]) =>
  execFileSync(process.execPath, ["public/cli/agenttown.mjs", ...args], { env: cliEnv(cfg), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// SSE recorders: feedback must never appear on either stream.
const ac = new AbortController();
const streamed: string[] = [];
function record(q: string) {
  fetch(`${BASE}/v1/stream${q}`, { signal: ac.signal, headers: { "x-real-ip": freshIp() } }).then(async (r) => {
    for await (const chunk of r.body!) streamed.push(Buffer.from(chunk).toString());
  }).catch(() => {});
}

try {
  // ---- web submission ----
  const MARK = `marker-${randomBytes(6).toString("hex")}`;
  const msg = `Love it! ${MARK}\r\nIdea: quote of a bad say "go kys" + https://example.com/bug and mail me@example.com\u0007​\n\n\n\n\nend`;
  const w = await send({ message: msg, category: "idea", contact: "  me@example.com  ", page: "/h/h_abc", lang: "zh" });
  assert.equal(w.status, 201, JSON.stringify(w.body));
  assert.equal(w.body.ok, true);
  assert.match(w.body.id, /^fb_[0-9a-z]{10}$/);
  const wf = await byId(w.body.id);
  assert.equal(wf.source, "web");
  assert.equal(wf.home_id, null);
  assert.equal(wf.category, "idea");
  assert.equal(wf.contact, "me@example.com");
  assert.equal(wf.page, "/h/h_abc");
  assert.equal(wf.lang, "zh");
  assert.equal(wf.status, "open");
  assert.ok(wf.user_agent, "user agent kept");
  assert.ok(!("ip_hash" in wf), "admin list does not need the IP hash");
  // Not content-filtered (private), but control / zero-width chars stripped, line breaks kept, blank runs capped.
  assert.ok(wf.message.includes("https://example.com/bug") && wf.message.includes("go kys") && wf.message.includes("me@example.com"));
  assert.ok(!/[\u0007​\r]/.test(wf.message), "control chars stripped");
  assert.ok(wf.message.includes(`${MARK}\nIdea`), "newline kept");
  assert.ok(wf.message.endsWith("\n\n\nend"), "at most two blank lines in a row");

  // defaults: category other, no contact/page/lang; bad lang ignored
  const d = await send({ message: "plain", lang: "fr" });
  assert.equal(d.status, 201);
  const df = await byId(d.body.id);
  assert.deepEqual([df.category, df.contact, df.page, df.lang], ["other", null, null, null]);

  // ---- validation & limits ----
  for (const [body, code] of [
    [{}, "bad_message"], [{ message: "" }, "bad_message"], [{ message: " \n\t " }, "bad_message"], [{ message: 42 }, "bad_message"],
    [{ message: "x".repeat(4001) }, "bad_message"], [{ message: "ok", category: "praise" }, "bad_category"],
    [{ message: "ok", contact: "c".repeat(201) }, "bad_contact"], [{ message: "ok", contact: { a: 1 } }, "bad_contact"],
  ] as const) {
    const r = await send(body);
    assert.equal(r.status, 400, `${JSON.stringify(body).slice(0, 60)} → ${r.status}`);
    assert.equal(r.body.error, code);
  }
  assert.equal((await call("POST", "/feedback", { body: [1] })).body.error, "bad_json");
  const max = await send({ message: "字".repeat(4000), contact: "c".repeat(200) });
  assert.equal(max.status, 201, "4000 chars (CJK) and a 200-char contact are fine");
  const emoji = await send({ message: "🐞".repeat(4000) });
  assert.equal(emoji.status, 201, "4000 emoji fit the body limit");
  assert.equal((await byId(emoji.body.id)).message.length, 8000);

  // ---- honeypot: looks like success, nothing stored ----
  const before = (await listAll()).length;
  const hp = await send({ message: `bot ${MARK}`, website: "http://spam.example" });
  assert.equal(hp.status, 201);
  assert.equal(hp.body.ok, true);
  assert.match(hp.body.id, /^fb_/);
  assert.equal((await listAll()).length, before, "honeypot not stored");
  assert.equal(await byId(hp.body.id), undefined);
  assert.equal((await admin("POST", `/feedback/${hp.body.id}`, { status: "done" })).status, 404);

  // ---- rate limit: 5/hour per IP (anonymous) ----
  const ip = freshIp();
  for (let i = 0; i < 5; i++) assert.equal((await send({ message: `burst ${i}` }, { ip })).status, 201);
  const limited = await send({ message: "one too many" }, { ip });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, "rate_limited");
  assert.equal((await send({ message: "other ip" })).status, 201, "per IP");

  // ---- attributed agent feedback via the CLI ----
  assert.match(cli("a", "register", "--home", "Feedback Home"), /Registered/);
  const cfg = JSON.parse(readFileSync(join(dir, "a", "config.json"), "utf8"));
  const out = cli("a", "feedback", `The CLI help could list examples ${MARK}`, "--category", "bug", "--contact", "human@example.com");
  const agentId = /Feedback (fb_[0-9a-z]{10}) sent from home/.exec(out)?.[1];
  assert.ok(agentId, out);
  const af = await byId(agentId!);
  assert.deepEqual([af.source, af.home_id, af.scope, af.category, af.contact, af.home_name],
    ["agent", cfg.home_id, "owner", "bug", "human@example.com", "Feedback Home"]);
  assert.match(af.user_agent, /^agenttown-cli\//);
  // unregistered machine: anonymous
  const anonOut = cli("nobody", "feedback", "hello", "from", "nowhere", "--json");
  const anon = await byId(JSON.parse(anonOut).id);
  assert.equal(anon.source, "web");
  assert.equal(anon.message, "hello from nowhere");
  assert.throws(() => cli("a", "feedback", "x", "--category", "rant"), /Usage: agenttown feedback/);
  assert.throws(() => cli("a", "feedback"), /Usage: agenttown feedback/);
  // a garbage / unknown bearer is simply anonymous, never an error
  const junk = await send({ message: "junk token" }, { token: "0".repeat(64) });
  assert.equal(junk.status, 201);
  assert.equal((await byId(junk.body.id)).source, "web");

  // ---- rate limit: 20/day per home (attributed), whatever the IP ----
  const token = execFileSync(process.execPath, ["-e",
    `import("./public/cli/agenttown.mjs").then((m) => process.stdout.write(m.authToken(${JSON.stringify(cfg.owner_key)})))`], { encoding: "utf8" });
  for (let i = 1; i < 20; i++) assert.equal((await send({ message: `agent ${i}` }, { token })).status, 201, `agent #${i + 1}`);
  const homeLimited = await send({ message: "21st" }, { token });
  assert.equal(homeLimited.status, 429);

  // ---- privacy: never on any public endpoint or stream ----
  record("");
  record(`?home=${cfg.home_id}`);
  await new Promise((r) => setTimeout(r, 300));
  await send({ message: `live ${MARK}` });
  await new Promise((r) => setTimeout(r, 300));
  const pub = [
    "/world", `/town?ids=${cfg.home_id}`, `/homes/${cfg.home_id}`, `/homes/${cfg.home_id}/events`, `/homes/${cfg.home_id}/stats`,
    "/cemetery", "/meta", "/tasks", `/homes/${cfg.home_id}/tasks`, "/feedback",
  ];
  for (const p of pub) {
    const r = await fetch(BASE + "/v1" + p, { headers: { "x-real-ip": freshIp() } });
    const text = await r.text();
    assert.ok(!text.includes(MARK) && !text.includes("human@example.com"), `${p} leaks feedback`);
  }
  assert.equal((await fetch(BASE + "/v1/feedback", { headers: { "x-real-ip": freshIp() } })).status, 404, "no public GET");
  assert.equal((await fetch(`${BASE}/v1/feedback/${agentId}`, { headers: { "x-real-ip": freshIp() } })).status, 404);
  assert.ok(!streamed.join("").includes(MARK), "not on SSE");
  for (const p of ["/", "/agents.md"]) assert.ok(!(await (await fetch(BASE + p)).text()).includes(MARK));

  // ---- admin API ----
  assert.equal((await admin("GET", "/feedback", undefined, "")).status, 401);
  assert.equal((await admin("GET", "/feedback", undefined, "x".repeat(40))).status, 401);
  assert.equal((await admin("POST", `/feedback/${agentId}`, { status: "done" }, "x".repeat(40))).status, 401);
  const open1 = (await admin("GET", "/feedback")).body;
  assert.ok(open1.feedback.every((f: any) => f.status === "open"));
  assert.equal(open1.open, open1.feedback.length);
  assert.equal(open1.feedback[0].message, `live ${MARK}`, "newest first");
  assert.equal((await admin("GET", "/feedback?limit=2")).body.feedback.length, 2);
  const done = await admin("POST", `/feedback/${agentId}`, { status: "done" });
  assert.deepEqual(done.body, { id: agentId, status: "done" });
  assert.equal((await admin("POST", `/feedback/${w.body.id}`, { status: "archived" })).status, 200);
  const open2 = (await admin("GET", "/feedback")).body;
  assert.equal(open2.open, open1.open - 2);
  assert.ok(!open2.feedback.some((f: any) => f.id === agentId || f.id === w.body.id), "done/archived leave the open list");
  assert.equal((await byId(agentId!)).status, "done");
  assert.ok((await byId(agentId!)).updated_at > 0);
  assert.equal((await admin("POST", `/feedback/${agentId}`, { status: "deleted" })).body.error, "bad_status");
  assert.equal((await admin("POST", "/feedback/fb_0000000000", { status: "done" })).status, 404);
  assert.equal((await admin("POST", "/feedback/nope", { status: "done" })).status, 404);

  // scripts/admin.mjs
  const adminEnv = { ...process.env, ADMIN_URL: BASE, ADMIN_TOKEN: ADMIN };
  const adm = (...a: string[]) => execFileSync(process.execPath, ["scripts/admin.mjs", ...a], { env: adminEnv, encoding: "utf8" });
  const listing = adm("feedback");
  assert.ok(listing.includes(`live ${MARK}`) && !listing.includes(agentId!), listing.slice(0, 300));
  assert.match(listing, /\d+ open\./);
  const all = adm("feedback", "--all");
  assert.ok(all.includes(agentId!) && all.includes("[done]") && all.includes("human@example.com") && all.includes(cfg.home_id));
  assert.ok(all.includes(`| ${MARK}`) || all.includes(MARK));
  assert.match(adm("feedback-archive", agentId!), new RegExp(`${agentId}: archived`));
  assert.match(adm("feedback-reopen", agentId!), new RegExp(`${agentId}: open`));
  assert.match(adm("feedback-done", agentId!), new RegExp(`${agentId}: done`));

  // ADMIN_TOKEN unset: the admin feedback routes don't exist; public feedback still works
  server2 = await boot(PORT2, {});
  const base2 = `http://localhost:${PORT2}`;
  assert.equal((await call("GET", "/admin/feedback", { token: ADMIN, base: base2 })).status, 404);
  assert.equal((await call("POST", `/admin/feedback/${agentId}`, { token: ADMIN, body: { status: "open" }, base: base2 })).status, 404);
  assert.equal((await call("POST", "/feedback", { body: { message: "second server" }, base: base2 })).status, 201);

  console.log("feedback test: OK");
} finally {
  ac.abort();
  server.kill();
  server2?.kill();
}
