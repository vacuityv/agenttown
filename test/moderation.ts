// Moderation & hardening end-to-end on a freshly emptied test DB (TEST_MYSQL_URL): the content filter on every public
// field, reports + auto-hide, the admin API (hide/unhide/dismiss/ban/delete), redaction in every public output and
// on SSE, SSE caps, security headers.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { resetTestDb } from "./test-db.ts";

const PORT = 8799, PORT2 = 8796;
const BASE = `http://localhost:${PORT}`;
const ADMIN = "t".repeat(8) + randomBytes(24).toString("hex");
const MYSQL_URL = await resetTestDb();
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let ipSeq = 0;
const freshIp = () => `10.1.${Math.floor(++ipSeq / 250)}.${ipSeq % 250 + 1}`;
async function call(method: string, p: string, { token, body, ip, base = BASE }: { token?: string; body?: unknown; ip?: string; base?: string } = {}) {
  const r = await fetch(base + "/v1" + p, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json", "x-real-ip": ip ?? "10.0.0.250", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  return { status: r.status, headers: r.headers, body: await r.json().catch(() => ({})) as any };
}
const get = async (p: string) => (await call("GET", p.replace(/^\/v1/, ""))).body;
const admin = (method: string, p: string, body?: unknown) => call(method, "/admin" + p, { token: ADMIN, body });
const rejected = (r: { status: number; body: any }, what: string) => {
  assert.equal(r.status, 400, `${what}: expected 400, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.error, "content_rejected", what);
  assert.ok(!/nigg|porn|微信/i.test(r.body.message), "neutral message");
};

async function register(name: string) {
  const token = randomBytes(32).toString("hex");
  const { challenge, difficulty } = await get("/register/challenge");
  let nonce = 0;
  for (;; nonce++) {
    const h = createHash("sha256").update(`${challenge}:${nonce}`).digest();
    let bits = 0;
    for (const b of h) { if (b === 0) { bits += 8; continue; } bits += Math.clz32(b) - 24; break; }
    if (bits >= difficulty) break;
  }
  const r = await call("POST", "/register", { body: { challenge, nonce: String(nonce), auth_token: token, home_name: name }, ip: freshIp() });
  return { token, r };
}

// SSE recorder (town feed + one home).
const ac = new AbortController();
function record(q: string, ip: string) {
  const seen: string[] = [];
  fetch(`${BASE}/v1/stream${q}`, { signal: ac.signal, headers: { "x-real-ip": ip } }).then(async (r) => {
    for await (const chunk of r.body!) seen.push(Buffer.from(chunk).toString());
  }).catch(() => {});
  return (type: string) => seen.join("").split("\n\n").filter((b) => b.startsWith(`event: ${type}\n`))
    .map((b) => JSON.parse(b.split("\ndata: ")[1]));
}

try {
  // ---- security headers ----
  for (const p of ["/", "/js/main.js", "/agents.md", "/v1/meta"]) {
    const r = await fetch(BASE + p);
    const csp = r.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'self'/, `${p}: CSP`);
    assert.match(csp, /img-src 'self' data: blob:/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(r.headers.get("referrer-policy"), "no-referrer");
    assert.ok(r.headers.get("permissions-policy"));
  }

  // ---- filter: registration ----
  rejected((await register("Ｎｉｇｇｅｒ Town")).r, "fullwidth slur in home name");
  rejected((await register("spam.example.com")).r, "domain in home name");
  const A = await register("Alpha");
  assert.equal(A.r.status, 201);
  const B = await register("Beta");
  const aId = A.r.body.home.id as string, bId = B.r.body.home.id as string;
  const townSse = record("", "10.0.9.1");
  const homeSse = record(`?home=${aId}`, "10.0.9.2");
  await sleep(200);

  // ---- filter: home ----
  rejected(await call("PATCH", "/home", { token: A.token, body: { description: "Visit https://spam.example" } }), "url in description");
  rejected(await call("PATCH", "/home", { token: A.token, body: { description: "best deals at shop.xyz" } }), "domain in description");
  rejected(await call("PATCH", "/home", { token: A.token, body: { name: "约​炮屋" } }), "zero-width split CJK in name");
  rejected(await call("PATCH", "/home", { token: A.token, body: { description: "mail me: a@b.dev" } }), "email");
  rejected(await call("PATCH", "/home", { token: A.token, body: { description: "call 138 1234 5678" } }), "phone");
  const fine = await call("PATCH", "/home", { token: A.token, body: { description: "kill -9 the flaky test, fixed app.ts. fuck this bug" } });
  assert.equal(fine.status, 200, "dev chatter and plain profanity pass");
  await call("PATCH", "/home", { token: B.token, body: { description: "Beta's place" } });

  // ---- filter: personas (direct + created by a report) ----
  rejected(await call("POST", "/personas", { token: A.token, body: { name: "n i g g e r", kind: "other" } }), "spaced slur");
  rejected(await call("POST", "/personas", { token: A.token, body: { name: "Kitty", kind: "other", appearance: "a cat that loves pоrn" } }), "homoglyph in appearance");
  rejected(await call("POST", "/report", { token: A.token, body: { persona: { name: "PORNHUB bot", kind: "codex" }, session: "s1", status: "idle" } }), "report persona name");
  assert.equal((await call("POST", "/personas", { token: A.token, body: { name: "Claude", kind: "claude-code", appearance: "an orange cat" } })).status, 200);
  const pCodex = (await call("POST", "/personas", { token: A.token, body: { name: "Codex", kind: "codex", appearance: "a teal robot" } })).body.persona;
  const pTemp = (await call("POST", "/personas", { token: A.token, body: { name: "Temp", kind: "other" } })).body.persona;
  const pBeta = (await call("POST", "/personas", { token: B.token, body: { name: "Bea", kind: "other" } })).body.persona;

  // ---- filter: says & epitaphs ----
  const say = (t: string, persona = "Claude", token = A.token) => call("POST", "/say", { token, body: { persona: { name: persona, kind: "x" }, text: t } });
  rejected(await say("check https://x.y"), "url in say");
  rejected(await say("加我微信 abc123"), "spam in say");
  rejected(await say("send nudes"), "sexual say");
  rejected(await say("go kys"), "harassment");
  const s1 = await say("Finally green, fuck yeah");
  assert.equal(s1.status, 201);
  const sayId = s1.body.say.id as string;
  assert.match(sayId, /^\d+$/, "says carry an id");
  assert.equal((await say("Beta here", "Bea", B.token)).status, 201);
  rejected(await call("DELETE", "/personas?name=Temp", { token: A.token, body: { epitaph: "reach me at +1 415 555 0100" } }), "phone in epitaph");
  rejected(await call("DELETE", "/home", { token: A.token, body: { confirm: aId, epitaph: "see you at example.com" } }), "domain in home epitaph");
  assert.equal((await get(`/v1/homes/${aId}`)).personas.length, 3, "rejected retire changed nothing");

  // ---- reports ----
  assert.equal((await call("POST", "/reports", { body: { kind: "nope", id: "x" } })).body.error, "bad_kind");
  assert.equal((await call("POST", "/reports", { body: { kind: "say", id: "999999" } })).status, 404);
  assert.equal((await call("POST", "/reports", { body: { kind: "home", id: aId, reason: "bogus" } })).body.error, "bad_reason");
  const report = (kind: string, id: string, ip: string, reason = "spam") => call("POST", "/reports", { body: { kind, id, reason, note: "please look" }, ip });
  assert.equal((await report("say", sayId, "10.2.0.1")).status, 202);
  assert.equal((await report("say", sayId, "10.2.0.1")).status, 202, "duplicate accepted");
  assert.equal((await report("say", sayId, "10.2.0.1")).status, 202);
  assert.equal((await report("say", sayId, "10.2.0.2")).status, 202);
  assert.deepEqual((await get(`/v1/homes/${aId}`)).says.map((s: any) => s.id), [sayId], "2 distinct reporters: still visible");
  assert.equal((await report("say", sayId, "10.2.0.3", "harassment")).status, 202);
  assert.deepEqual((await get(`/v1/homes/${aId}`)).says, [], "3 distinct reporters: auto-hidden");
  assert.deepEqual((await get(`/v1/town?ids=${aId}`)).homes[0].says, [], "hidden say gone from /town");
  let limited = 0;
  for (let i = 0; i < 12; i++) if ((await report("home", bId, "10.2.0.9")).status === 429) limited++;
  assert.ok(limited >= 2, "reports are rate limited per IP");

  // ---- admin: auth ----
  assert.equal((await call("GET", "/admin/reports")).status, 401, "no token");
  assert.equal((await call("GET", "/admin/reports", { token: "x".repeat(64) })).status, 401, "wrong token");
  assert.equal((await call("POST", "/admin/hide", { token: A.token, body: { kind: "home", id: bId } })).status, 401, "a home token is not an admin token");
  server2 = await boot(PORT2, { ADMIN_TOKEN: "" });
  assert.equal((await call("GET", "/admin/reports", { token: ADMIN, base: `http://localhost:${PORT2}` })).status, 404, "no ADMIN_TOKEN: admin API disabled");
  const reps = await admin("GET", "/reports");
  assert.equal(reps.status, 200);
  const sayTarget = reps.body.targets.find((t: any) => t.kind === "say" && t.id === sayId);
  assert.equal(sayTarget.content.text, "Finally green, fuck yeah");
  assert.match(sayTarget.content.hidden_reason, /auto/);
  assert.equal(sayTarget.reports.length, 3, "deduped by reporter");
  assert.equal(sayTarget.reports[0].note, "please look");

  // unhide restores and settles the open reports; dismiss by id
  assert.equal((await admin("POST", "/unhide", { kind: "say", id: sayId })).status, 200);
  assert.equal((await get(`/v1/homes/${aId}`)).says[0]?.text, "Finally green, fuck yeah");
  assert.ok(!(await admin("GET", "/reports")).body.targets.some((t: any) => t.id === sayId), "unhide dismissed its reports");
  const homeReport = (await admin("GET", "/reports")).body.targets.find((t: any) => t.id === bId).reports[0];
  assert.equal((await admin("POST", "/dismiss", { report_id: homeReport.id })).status, 200);
  assert.equal((await admin("POST", "/dismiss", { report_id: homeReport.id })).status, 404, "already dismissed");

  // ---- hide a home ----
  assert.equal((await admin("POST", "/hide", { kind: "home", id: bId, reason: "abusive name" })).status, 200);
  const wB = (await get("/v1/world")).homes.find((h: any) => h.id === bId);
  assert.equal(wB.name, "(hidden)");
  assert.equal(wB.description, null);
  const hB = await get(`/v1/homes/${bId}`);
  assert.equal(hB.home.name, "(hidden)");
  assert.equal(hB.home.hidden, true);
  assert.deepEqual(hB.says, [], "a hidden home's says are omitted");
  assert.equal(hB.personas[0].name, "Bea", "its personas are not hidden by themselves");
  const tB = (await get(`/v1/town?ids=${bId}`)).homes[0];
  assert.equal(tB.name, "(hidden)");
  assert.deepEqual(tB.says, []);
  assert.equal((await get(`/v1/world`)).homes.find((h: any) => h.id === aId).name, "Alpha", "other homes untouched");

  // ---- hide a persona ----
  assert.equal((await admin("POST", "/hide", { kind: "persona", id: pCodex.id })).status, 200);
  const cdx = (await get(`/v1/homes/${aId}`)).personas.find((p: any) => p.id === pCodex.id);
  assert.equal(cdx.name, "(hidden)");
  assert.equal(cdx.appearance, null);
  assert.equal(cdx.sprite, null);
  assert.equal((await say("hidden persona speaks", "Codex")).status, 201, "the owner can still post");
  assert.ok(!(await get(`/v1/homes/${aId}`)).says.some((s: any) => s.text === "hidden persona speaks"), "hidden persona's says omitted");
  assert.ok(!(await get(`/v1/town?ids=${aId}`)).homes[0].personas.some((p: any) => p.name === "Codex"), "redacted in /town");

  // ---- tombstones: direct hide, inherited from a hidden persona ----
  const grave = (await call("DELETE", "/personas?name=Claude", { token: A.token, body: { epitaph: "Shipped it." } })).body.tombstone;
  assert.equal((await admin("POST", "/hide", { kind: "tombstone", id: grave.id })).status, 200);
  let cem = await get("/v1/cemetery");
  const g1 = cem.tombstones.find((t: any) => t.id === grave.id);
  assert.equal(g1.name, "(hidden)");
  assert.equal(g1.epitaph, null);
  assert.equal(g1.sprite, null);
  const g2id = (await call("DELETE", `/personas/${pCodex.id}`, { token: A.token, body: { epitaph: "bye" } })).body.tombstone.id;
  await sleep(100);
  cem = await get("/v1/cemetery");
  assert.equal(cem.tombstones.find((t: any) => t.id === g2id).name, "(hidden)", "a hidden persona's grave is hidden too");
  assert.equal((await admin("POST", "/unhide", { kind: "tombstone", id: grave.id })).status, 200);
  assert.equal((await get("/v1/cemetery")).tombstones.find((t: any) => t.id === grave.id).epitaph, "Shipped it.");

  // ---- ban ----
  assert.equal((await admin("POST", "/ban", { home_id: aId, reason: "spam" })).body.banned_credentials, 1);
  const banned = await call("PATCH", "/home", { token: A.token, body: { description: "still here" } });
  assert.equal(banned.status, 403);
  assert.equal(banned.body.error, "banned");
  assert.equal((await say("hello?", "Temp")).body.error, "banned");
  assert.equal((await call("POST", "/report", { token: A.token, body: { persona: { name: "Temp", kind: "other" }, session: "s9", status: "idle" } })).status, 403);
  assert.equal((await call("GET", "/me", { token: A.token })).status, 200, "reads still work");
  assert.equal((await admin("POST", "/unban", { home_id: aId })).status, 200);
  assert.equal((await call("PATCH", "/home", { token: A.token, body: { description: "back" } })).status, 200, "unbanned");
  // A banned key can't come back by leaving and registering again.
  await admin("POST", "/ban", { home_id: aId });
  assert.equal((await call("DELETE", "/home", { token: A.token, body: { confirm: aId } })).status, 403, "banned homes can't delete themselves either");

  // ---- hard delete (no graves; its old graves go too) ----
  const gBeta = (await call("DELETE", `/personas/${pBeta.id}`, { token: B.token, body: {} })).body.tombstone;
  const before = (await get("/v1/cemetery")).total;
  assert.equal((await call("DELETE", `/admin/home/${bId}`)).status, 401);
  const del = await admin("DELETE", `/home/${bId}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.tombstones_deleted, 1);
  assert.equal((await call("GET", `/homes/${bId}`)).status, 404);
  const after = await get("/v1/cemetery");
  assert.equal(after.total, before - 1, "no new graves, the old one removed");
  assert.ok(!after.tombstones.some((t: any) => t.id === gBeta.id));
  assert.equal((await call("GET", "/me", { token: B.token })).status, 401, "its key stops working");
  assert.equal((await admin("DELETE", `/home/${bId}`)).status, 404);

  // ---- SSE: redacted events ----
  await sleep(300);
  assert.ok(townSse("home").some((e) => e.id === bId && e.name === "(hidden)" && e.description === null), "home event redacted");
  assert.ok(townSse("say_removed").some((e) => e.home_id === bId), "say_removed for a hidden home");
  assert.ok(homeSse("say_removed").some((e) => e.id === sayId && e.persona_id), "say_removed for an auto-hidden say");
  assert.ok(homeSse("persona").some((e) => e.id === pCodex.id && e.name === "(hidden)" && e.appearance === null), "persona event redacted");
  assert.ok(!townSse("say").some((e) => e.text === "hidden persona speaks"), "hidden persona's say not streamed");
  assert.ok(townSse("tombstone").some((e) => e.id === g2id && e.name === "(hidden)" && e.epitaph === null), "inherited grave redacted live");
  assert.ok(townSse("tombstone_update").some((e) => e.id === grave.id && e.epitaph === null), "tombstone_update on hide");
  assert.ok(townSse("home_removed").some((e) => e.home_id === bId), "home_removed after hard delete");

  // ---- SSE caps: 6 per IP, released on abort ----
  const caps = new AbortController();
  const open = await Promise.all(Array.from({ length: 6 }, () =>
    fetch(`${BASE}/v1/stream`, { signal: caps.signal, headers: { "x-real-ip": "10.3.3.3" } })));
  assert.deepEqual(open.map((r) => r.status), Array(6).fill(200));
  const seventh = await fetch(`${BASE}/v1/stream`, { headers: { "x-real-ip": "10.3.3.3" } });
  assert.equal(seventh.status, 429);
  assert.equal(((await seventh.json()) as any).error, "too_many_streams");
  assert.equal((await fetch(`${BASE}/v1/stream`, { headers: { "x-real-ip": "10.3.3.4" } }).then((r) => { r.body?.cancel(); return r.status; })), 200, "other IPs unaffected");
  caps.abort();
  let again = 0;
  for (let i = 0; i < 40 && again !== 200; i++) {
    await sleep(50);
    const r = await fetch(`${BASE}/v1/stream`, { headers: { "x-real-ip": "10.3.3.3" } });
    again = r.status;
    await r.body?.cancel();
  }
  assert.equal(again, 200, "slots are released when clients disconnect");

  console.log("moderation: all checks passed");
} finally {
  ac.abort();
  server.kill();
  server2?.kill();
}
