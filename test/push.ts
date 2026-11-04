// Web Push for home owners (server/push.ts), end to end on a freshly emptied test DB (TEST_MYSQL_URL), against a fake
// push service on localhost: VAPID JWTs (ES256, aud, exp), RFC 8291 payload decryption (written out here with plain
// HMAC, independently of the server's hkdfSync), waiting / finished triggers, debouncing, coalescing, prefs, no
// titles or secrets in payloads or public APIs, 404/410 cleanup, log-once failures, the per-home rate limit and
// owner-only auth.
import { spawn, execFileSync } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, verify } from "node:crypto";
import assert from "node:assert/strict";
import { resetTestDb } from "./test-db.ts";

const PORT = 8803;
const BASE = `http://localhost:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), "agenttown-push-"));
const MYSQL_URL = await resetTestDb();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- VAPID keys from the operator script ----
const keysOut = execFileSync(process.execPath, ["scripts/vapid-keys.mjs", "--subject", "mailto:mayor@example.com"], { encoding: "utf8" });
const envLine = (k: string) => new RegExp(`^${k}=(.+)$`, "m").exec(keysOut)![1];
const VAPID_PUBLIC_KEY = envLine("VAPID_PUBLIC_KEY"), VAPID_PRIVATE_KEY = envLine("VAPID_PRIVATE_KEY");
assert.equal(Buffer.from(VAPID_PUBLIC_KEY, "base64url").length, 65);
assert.equal(Buffer.from(VAPID_PRIVATE_KEY, "base64url").length, 32);
assert.equal(envLine("VAPID_SUBJECT"), "mailto:mayor@example.com");

// ---- fake push service: /ep/<name> → 201, /gone/<name> → 410, /fail/<name> → 500 ----
type Got = { path: string; headers: IncomingMessage["headers"]; body: Buffer; at: number };
const got: Got[] = [];
const fake = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c)).on("end", () => {
    const path = req.url ?? "";
    got.push({ path, headers: req.headers, body: Buffer.concat(chunks), at: Date.now() });
    res.writeHead(path.startsWith("/gone/") ? 410 : path.startsWith("/fail/") ? 500 : 201).end();
  });
});
await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
const FAKE = `http://127.0.0.1:${(fake.address() as any).port}`;

const WAIT_DELAY = 1500, MIN_TURN = 1000, DEBOUNCE = 15_000, COALESCE = 1200, HOURLY = 7; // roomy: reports to one home serialize and take ~0.5 s each on the remote test DB
const env = {
  ...process.env, PORT: String(PORT), MYSQL_URL, POW_DIFFICULTY: "8", PUBLIC_URL: BASE, ANTHROPIC_API_KEY: "", NEIGHBOR_CHECK: "0",
  VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT: "mailto:mayor@example.com", PUSH_EXTRA_ORIGINS: FAKE,
  PUSH_WAIT_DELAY_MS: String(WAIT_DELAY), PUSH_MIN_TURN_MS: String(MIN_TURN), PUSH_DONE_DEBOUNCE_MS: String(DEBOUNCE),
  PUSH_COALESCE_MS: String(COALESCE), PUSH_HOURLY_MAX: String(HOURLY),
};
const server = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server/index.ts"], { env, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
server.stderr!.on("data", (d) => { log += d; process.stderr.write(d); });
await new Promise<void>((ok, fail) => {
  server.stdout!.on("data", (d) => { log += d; if (String(d).includes("listening")) ok(); });
  server.on("exit", (code) => fail(new Error(`server exited (${code})`)));
});

const cliEnv = (name: string) => ({ ...env, AGENTTOWN_CONFIG: join(dir, name, "config.json"), AGENTTOWN_SERVER: BASE });
const cli = (cfg: string, ...args: string[]) =>
  execFileSync(process.execPath, ["public/cli/agenttown.mjs", ...args], { env: cliEnv(cfg), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const cfgOf = (name: string) => JSON.parse(readFileSync(join(dir, name, "config.json"), "utf8"));
const authToken = (ownerKey: string) => createHmac("sha256", Buffer.from(ownerKey)).update("agenttown/auth/v1").digest("hex");

async function call(method: string, p: string, token: string | null, body?: unknown) {
  const r = await fetch(BASE + "/v1" + p, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  return { status: r.status, body: await r.json().catch(() => ({})) as any, text: "" };
}
const report = (token: string, persona: string, kind: string, session: string, status: string, extra: Record<string, unknown> = {}) =>
  call("POST", "/report", token, { persona: { name: persona, kind }, session, status, ...extra }).then((r) => {
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  });

// ---- the subscriber side (what a browser does) ----
type Sub = { name: string; endpoint: string; ecdh: ReturnType<typeof createECDH>; pub: Buffer; auth: Buffer };
function browser(kind: "ep" | "gone" | "fail" = "ep"): Sub {
  const ecdh = createECDH("prime256v1");
  const pub = ecdh.generateKeys();
  const name = randomBytes(12).toString("hex");
  return { name, endpoint: `${FAKE}/${kind}/${name}`, ecdh, pub, auth: randomBytes(16) };
}
const subJson = (s: Sub) => ({ endpoint: s.endpoint, keys: { p256dh: s.pub.toString("base64url"), auth: s.auth.toString("base64url") } });
const inbox = (s: Sub) => got.filter((g) => g.path.endsWith("/" + s.name));

// RFC 8291 §3.4 + RFC 8188, by hand: HKDF = HMAC-SHA-256 extract + one expand block.
const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();
function decrypt(s: Sub, body: Buffer) {
  const salt = body.subarray(0, 16), rs = body.readUInt32BE(16), idlen = body[20];
  assert.equal(idlen, 65, "keyid is the sender's uncompressed P-256 key");
  assert.ok(rs >= 18);
  const asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  assert.ok(ct.length <= rs, "a single record");
  const ecdhSecret = s.ecdh.computeSecret(asPub);
  const prkKey = hmac(s.auth, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), s.pub, asPub]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: aes128gcm\0"), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: nonce\0"), Buffer.from([1])])).subarray(0, 12);
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(ct.subarray(-16));
  const pt = Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]);
  let end = pt.length;
  while (end > 0 && pt[end - 1] === 0) end--; // padding
  assert.equal(pt[end - 1], 2, "last-record delimiter");
  return JSON.parse(pt.subarray(0, end - 1).toString("utf8"));
}
function checkVapid(g: Got) {
  const m = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(String(g.headers.authorization));
  assert.ok(m, `VAPID authorization header: ${g.headers.authorization}`);
  const [h, p, sig] = m![1].split(".");
  assert.equal(m![2], VAPID_PUBLIC_KEY, "k = the server's public key");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url").toString()), { typ: "JWT", alg: "ES256" });
  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  assert.equal(claims.aud, FAKE, "aud = the endpoint's origin");
  assert.equal(claims.sub, "mailto:mayor@example.com");
  const now = Date.now() / 1000;
  assert.ok(claims.exp > now && claims.exp <= now + 24 * 3600, "exp in the future, at most 24 h ahead");
  const k = Buffer.from(m![2], "base64url");
  const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: k.subarray(1, 33).toString("base64url"), y: k.subarray(33).toString("base64url") }, format: "jwk" });
  assert.ok(verify("sha256", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url")), "ES256 signature verifies");
  assert.equal(g.headers["content-encoding"], "aes128gcm");
  assert.ok(Number(g.headers.ttl) > 0);
  assert.match(String(g.headers.topic), /^[\w-]{1,32}$/);
}
async function waitFor<T>(fn: () => T | undefined | false, what: string, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}
/** Waits for the n-th message on s, then a little longer to make sure no extra one follows. */
async function expectCount(s: Sub, n: number, what: string, settle = 600) {
  if (n > 0) await waitFor(() => inbox(s).length >= n, what);
  await sleep(settle);
  assert.equal(inbox(s).length, n, what);
  return inbox(s).map((g) => { checkVapid(g); return decrypt(s, g.body); });
}

// Everything secret that must never show up in a public response, a stream or the log.
const secrets: string[] = [];
const streamed: string[] = [];
const ac = new AbortController();

try {
  cli("a", "register", "--home", "Push Home");
  const A = cfgOf("a");
  const tokA = authToken(A.owner_key);
  cli("b", "register", "--home", "Rate Home");
  const tokB = authToken(cfgOf("b").owner_key);
  const inv = /AT-[0-9a-z]{8}-[0-9a-z]{26}/.exec(cli("a", "invite", "--label", "laptop"))![0];
  cli("d", "join", inv);
  const tokD = cfgOf("d").device_token;
  assert.match(tokD, /^[0-9a-f]{64}$/);
  for (const q of [`?home=${A.home_id}`, ""]) {
    fetch(`${BASE}/v1/stream${q}`, { signal: ac.signal }).then(async (r) => {
      for await (const c of r.body!) streamed.push(Buffer.from(c).toString());
    }).catch(() => {});
  }

  // ---- owner-only API ----
  assert.equal((await call("GET", "/push", null)).status, 401);
  assert.equal((await call("GET", "/push", tokD)).status, 403, "device credentials can't manage notifications");
  const info = await call("GET", "/push", tokA);
  assert.equal(info.status, 200);
  assert.equal(info.body.enabled, true);
  assert.equal(info.body.public_key, VAPID_PUBLIC_KEY);
  assert.deepEqual(info.body.prefs, { waiting: true, done: true });
  assert.deepEqual(info.body.devices, []);

  const phone = browser();
  secrets.push(phone.name, phone.auth.toString("base64url"), phone.pub.toString("base64url"));
  assert.equal((await call("POST", "/push/subscriptions", tokD, { subscription: subJson(phone) })).status, 403);
  assert.equal((await call("POST", "/push/subscriptions", null, { subscription: subJson(phone) })).status, 401);
  for (const endpoint of ["https://evil.example/push", "http://10.0.0.1/x", "https://user:pw@fcm.googleapis.com/x", "https://fcm.googleapis.com:8443/x", "not a url"]) {
    const r = await call("POST", "/push/subscriptions", tokA, { subscription: { ...subJson(phone), endpoint } });
    assert.equal(r.status, 400, `endpoint ${endpoint} must be refused`);
    assert.equal(r.body.error, "bad_subscription");
  }
  const badKeys = await call("POST", "/push/subscriptions", tokA, { subscription: { endpoint: phone.endpoint, keys: { p256dh: Buffer.alloc(65, 4).toString("base64url"), auth: phone.auth.toString("base64url") } } });
  assert.equal(badKeys.status, 400, "p256dh must be a point on the curve");
  const sub1 = await call("POST", "/push/subscriptions", tokA, { subscription: subJson(phone), label: "iPhone · Safari", lang: "en" });
  assert.equal(sub1.status, 201);
  assert.match(sub1.body.device.id, /^ps_/);
  assert.equal(sub1.body.device.label, "iPhone · Safari");
  assert.equal(sub1.body.device.endpoint, undefined, "endpoints are never handed back");
  const again = await call("POST", "/push/subscriptions", tokA, { subscription: subJson(phone), label: "iPhone · Safari" });
  assert.equal(again.body.device.id, sub1.body.device.id, "subscribing again is idempotent");
  const devs = (await call("GET", "/push", tokA)).body.devices;
  assert.equal(devs.length, 1);
  assert.ok(!JSON.stringify(devs).includes(phone.name), "device list has no endpoint");

  // ---- test notification: VAPID + decryption ----
  const t1 = await call("POST", "/push/test", tokA, {});
  assert.deepEqual(t1.body, { sent: 1, failed: 0, removed: 0 });
  const [testMsg] = await expectCount(phone, 1, "test push", 0);
  assert.equal(testMsg.title, "Agent Town notifications are on");
  assert.equal(testMsg.url, `/h/${A.home_id}`);

  // ---- waiting: once per episode, after the delay, never for a quick answer ----
  // A real encrypted title via the CLI; the server never sees the plaintext, and the push must not carry the ciphertext.
  cli("a", "report", "--persona", "Claude", "--kind", "claude-code", "--session", "s1", "--status", "thinking", "--task", "SECRET-TITLE fix the login page");
  const enc = (await call("GET", `/homes/${A.home_id}`, null)).body.sessions.find((s: any) => s.task_enc)?.task_enc;
  assert.ok(enc);
  await report(tokA, "Claude", "claude-code", "s1", "waiting");
  for (let i = 0; i < 3; i++) { await sleep(100); await report(tokA, "Claude", "claude-code", "s1", "waiting"); } // heartbeats
  const [w1] = (await expectCount(phone, 2, "one waiting push", 800)).slice(1);
  assert.equal(w1.title, "Claude is waiting for you");
  assert.match(w1.body, /^Claude Code · Push Home · busy /);
  assert.equal(w1.url, `/h/${A.home_id}`);
  assert.equal(inbox(phone)[1].headers.urgency, "high");
  await report(tokA, "Claude", "claude-code", "s1", "waiting"); // still the same episode
  await sleep(WAIT_DELAY + COALESCE + 300);
  assert.equal(inbox(phone).length, 2, "no second push for the same waiting episode");
  await report(tokA, "Claude", "claude-code", "s1", "tool", { tool: "Bash" });
  await report(tokA, "Claude", "claude-code", "s1", "waiting"); // a new episode
  await expectCount(phone, 3, "a new waiting episode pings again");
  await report(tokA, "Claude", "claude-code", "s1", "thinking");
  await report(tokA, "Claude", "claude-code", "s1", "waiting");
  await report(tokA, "Claude", "claude-code", "s1", "tool", { tool: "Edit" }); // answered at the keyboard
  await sleep(WAIT_DELAY + COALESCE + 400);
  assert.equal(inbox(phone).length, 3, "a quickly answered prompt sends nothing");

  // ---- finished: long turns only, subagents never, debounced per persona ----
  await report(tokA, "Ada", "codex", "c1", "thinking");
  await report(tokA, "Ada", "codex", "c1", "idle"); // short turn
  await report(tokA, "Ada", "codex", "c1:sub", "thinking", { parent: "c1" });
  await sleep(MIN_TURN + 200);
  await report(tokA, "Ada", "codex", "c1:sub", "idle", { parent: "c1" }); // a subagent's long turn
  await sleep(COALESCE + 400);
  assert.equal(inbox(phone).length, 3, "short turns and subagents send nothing");
  await report(tokA, "Ada", "codex", "c1", "thinking");
  await sleep(MIN_TURN / 2);
  await report(tokA, "Ada", "codex", "c1", "waiting"); // a permission prompt mid-turn keeps the turn going
  await report(tokA, "Ada", "codex", "c1", "tool", { tool: "Bash" });
  await sleep(MIN_TURN / 2 + 200);
  await report(tokA, "Ada", "codex", "c1", "idle");
  const done = (await expectCount(phone, 4, "finished push"))[3];
  assert.equal(done.title, "Ada finished");
  assert.match(done.body, /^Codex · Push Home · worked (< 1 min|1 min)$/);
  assert.equal(inbox(phone)[3].headers.urgency, "normal");
  // idle_prompt-style waiting right after the finished turn: the same "your turn" moment, no second ping
  await report(tokA, "Ada", "codex", "c1", "waiting");
  await sleep(WAIT_DELAY + COALESCE + 300);
  assert.equal(inbox(phone).length, 4, "waiting from idle right after a finished push is suppressed");
  await report(tokA, "Ada", "codex", "c1", "thinking");
  await sleep(MIN_TURN + 200);
  await report(tokA, "Ada", "codex", "c1", "idle");
  await sleep(COALESCE + 500);
  assert.equal(inbox(phone).length, 4, "a second finished push within the debounce window is dropped");
  await sleep(Math.max(0, inbox(phone)[3].at + DEBOUNCE - MIN_TURN + 300 - Date.now()));
  await report(tokA, "Ada", "codex", "c1", "thinking");
  await sleep(MIN_TURN + 200);
  await report(tokA, "Ada", "codex", "c1", "idle");
  await expectCount(phone, 5, "finished again after the debounce window");

  // ---- bursts coalesce into one notification ----
  await Promise.all([report(tokA, "Claude", "claude-code", "s1", "waiting"), report(tokA, "Bob", "gemini", "g1", "waiting")]);
  const burst = (await expectCount(phone, 6, "one coalesced push", 800))[5];
  assert.equal(burst.title, "2 agents need you");
  assert.match(burst.body, /Claude is waiting/);
  assert.match(burst.body, /Bob is waiting/);
  await report(tokA, "Claude", "claude-code", "s1", "thinking");
  await report(tokA, "Bob", "gemini", "g1", "ended");

  // ---- prefs ----
  assert.equal((await call("PUT", "/push/prefs", tokD, { waiting: false })).status, 403);
  assert.equal((await call("PUT", "/push/prefs", tokA, { waiting: "no" })).status, 400);
  assert.deepEqual((await call("PUT", "/push/prefs", tokA, { waiting: false })).body.prefs, { waiting: false, done: true });
  await report(tokA, "Claude", "claude-code", "s1", "waiting");
  await sleep(WAIT_DELAY + COALESCE + 400);
  assert.equal(inbox(phone).length, 6, "waiting off: nothing");
  assert.deepEqual((await call("PUT", "/push/prefs", tokA, { waiting: true })).body.prefs, { waiting: true, done: true });
  await report(tokA, "Claude", "claude-code", "s1", "thinking");

  // ---- privacy: no titles or secrets in payloads; endpoints nowhere public ----
  const payloads = inbox(phone).map((g) => JSON.stringify(decrypt(phone, g.body)));
  for (const p of payloads) {
    assert.ok(!p.includes("SECRET") && !p.includes("login page"), "no task title");
    assert.ok(!p.includes(enc) && !p.includes("task"), "no title ciphertext or task data");
    assert.ok(!p.includes(phone.name) && !p.includes(VAPID_PRIVATE_KEY));
    assert.deepEqual(Object.keys(JSON.parse(p)).sort(), ["body", "tag", "title", "ts", "url"]);
  }
  const pub = JSON.stringify([
    (await call("GET", `/homes/${A.home_id}`, null)).body, (await call("GET", "/world", null)).body,
    (await call("GET", `/town?ids=${A.home_id}`, null)).body, (await call("GET", "/meta", null)).body,
    (await call("GET", "/me", tokA)).body,
  ]);
  for (const s of secrets) assert.ok(!pub.includes(s), "subscription secrets never on a public API");

  // ---- 410 Gone: the subscription is deleted ----
  const gone = browser("gone");
  secrets.push(gone.name);
  const gsub = await call("POST", "/push/subscriptions", tokA, { subscription: subJson(gone), label: "Old phone", lang: "zh" });
  assert.equal((await call("GET", "/push", tokA)).body.devices.length, 2);
  const t2 = await call("POST", "/push/test", tokA, {});
  assert.deepEqual(t2.body, { sent: 1, failed: 0, removed: 1 });
  assert.equal(inbox(gone).length, 1);
  assert.equal(decrypt(gone, inbox(gone)[0].body).title, "Agent Town 通知已开启", "per-device language");
  assert.deepEqual((await call("GET", "/push", tokA)).body.devices.map((d: any) => d.id), [sub1.body.device.id], "410 → removed");
  assert.equal((await call("DELETE", `/push/subscriptions/${gsub.body.device.id}`, tokA)).status, 404);

  // ---- a failing push service is logged once per subscription, without its endpoint ----
  const broken = browser("fail");
  secrets.push(broken.name);
  const bsub = await call("POST", "/push/subscriptions", tokA, { subscription: subJson(broken), label: "Broken" });
  assert.deepEqual((await call("POST", "/push/test", tokA, {})).body, { sent: 1, failed: 1, removed: 0 });
  assert.deepEqual((await call("POST", "/push/test", tokA, {})).body, { sent: 1, failed: 1, removed: 0 });
  const lines = log.split("\n").filter((l) => l.includes(`delivery to ${bsub.body.device.id}`));
  assert.equal(lines.length, 1, "failures logged at most once per subscription");
  assert.ok(lines[0].includes("HTTP 500") && lines[0].includes("127.0.0.1"));

  // ---- unsubscribe ----
  assert.equal((await call("POST", "/push/unsubscribe", tokD, { endpoint: broken.endpoint })).status, 403);
  assert.deepEqual((await call("POST", "/push/unsubscribe", tokA, { endpoint: broken.endpoint })).body, { removed: 1 });
  assert.deepEqual((await call("POST", "/push/unsubscribe", tokA, { endpoint: broken.endpoint })).body, { removed: 0 });

  // ---- rate limit: at most HOURLY notifications per home per hour ----
  const laptop = browser();
  secrets.push(laptop.name);
  assert.equal((await call("POST", "/push/subscriptions", tokB, { subscription: subJson(laptop) })).status, 201);
  assert.equal((await call("DELETE", `/push/subscriptions/${sub1.body.device.id}`, tokB)).status, 404, "other homes' devices are untouchable");
  const rateStart = inbox(laptop).length;
  for (let i = 0; i < HOURLY + 3; i++) {
    await report(tokB, `P${i}`, "claude-code", `r${i}`, "waiting");
    await sleep(COALESCE + 250); // separate notifications, not one coalesced burst
  }
  await expectCount(laptop, rateStart + HOURLY, `exactly ${HOURLY} pushes (rate limit)`, WAIT_DELAY + 1000);

  // ---- removing a device ----
  assert.equal((await call("DELETE", `/push/subscriptions/${sub1.body.device.id}`, tokD)).status, 403);
  assert.equal((await call("DELETE", `/push/subscriptions/${sub1.body.device.id}`, tokA)).status, 200);
  assert.deepEqual((await call("GET", "/push", tokA)).body.devices, []);

  // ---- nothing secret on the streams or in the log ----
  await sleep(2500); // town "agent" events are delayed 2 s
  const all = streamed.join("") + log;
  for (const s of secrets) assert.ok(!all.includes(s), "no subscription secret on a stream or in the log");
  assert.ok(streamed.join("").includes("event: session"), "the home stream was recorded");

  console.log("push test passed");
} finally {
  ac.abort();
  server.kill();
  fake.close();
}
