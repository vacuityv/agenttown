// Web Push for home owners: "tell my phone when one of my agents needs me or finishes" (docs/protocol.md
// "Notifications"). Standard Web Push (RFC 8030) with VAPID (RFC 8292) and aes128gcm payloads (RFC 8291, RFC 8188),
// built on node:crypto only.
//
// Privacy: the server never has task titles (they are end-to-end encrypted), and pushes carry nothing that isn't
// public anyway: home and persona names, the agent kind, the status and how long it worked. Subscription endpoints
// and keys are secrets: owner-only API, never in a public response, a stream or a log line.
//
// Triggers come from the bus ("session" events, emitted right after every report commits), handled synchronously
// with in-memory state only; delivery happens later on a small queue, so reports never wait for push services.
import { createCipheriv, createECDH, createHash, createPrivateKey, createPublicKey, hkdfSync, randomBytes, sign, type KeyObject } from "node:crypto";
import type { Context, Hono, Next } from "hono";
import { db, all, one, run, type Row } from "./db.ts";
import { bus } from "./bus.ts";
import { PUSH } from "./config.ts";
import { ApiError, allow, cleanText, newId, sha256hex } from "./util.ts";

type Auth = (c: Context<any>, next: Next) => Promise<void>;
const homeOf = (c: Context<any>) => (c.get("home") as { id: string }).id;
function limit(key: string, perSec: number, burst: number) {
  if (!allow(key, perSec, burst)) throw new ApiError(429, "rate_limited", "Slow down.");
}
const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const logErr = (what: string) => (e: unknown) => console.error(what, e);

// ---- VAPID (RFC 8292) ----

function loadKey(): KeyObject | null {
  if (!PUSH.publicKey || !PUSH.privateKey) return null;
  try {
    const pub = Buffer.from(PUSH.publicKey, "base64url"), d = Buffer.from(PUSH.privateKey, "base64url");
    if (pub.length !== 65 || pub[0] !== 4 || d.length !== 32) throw new Error("expected a 65-byte public point and a 32-byte private key");
    const key = createPrivateKey({ key: { kty: "EC", crv: "P-256", x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)), d: b64u(d) }, format: "jwk" });
    const jwk = createPublicKey(key).export({ format: "jwk" });
    if (jwk.x !== b64u(pub.subarray(1, 33)) || jwk.y !== b64u(pub.subarray(33))) throw new Error("VAPID_PUBLIC_KEY does not match VAPID_PRIVATE_KEY");
    return key;
  } catch (e) {
    console.error(`push: notifications disabled, bad VAPID keys (${(e as Error).message})`);
    return null;
  }
}
const vapidKey = loadKey();
export const pushEnabled = () => vapidKey !== null;

// One JWT per push service origin, valid 12 h (RFC 8292 allows up to 24 h), renewed an hour before it expires.
const jwts = new Map<string, { jwt: string; exp: number }>();
function vapidHeader(endpoint: string) {
  const aud = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);
  let c = jwts.get(aud);
  if (!c || c.exp - now < 3600) {
    const exp = now + 12 * 3600;
    const unsigned = `${b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }))}.${b64u(JSON.stringify({ aud, exp, sub: PUSH.subject }))}`;
    const sig = sign("sha256", Buffer.from(unsigned), { key: vapidKey!, dsaEncoding: "ieee-p1363" });
    c = { jwt: `${unsigned}.${b64u(sig)}`, exp };
    jwts.set(aud, c);
  }
  return `vapid t=${c.jwt}, k=${PUSH.publicKey}`;
}

// ---- payload encryption (RFC 8291, aes128gcm content coding of RFC 8188, one record) ----

const hkdf = (ikm: Buffer, salt: Buffer, info: Buffer, len: number) => Buffer.from(hkdfSync("sha256", ikm, salt, info, len));

export function encryptPayload(plain: Buffer, p256dh: Buffer, auth: Buffer): Buffer {
  const ecdh = createECDH("prime256v1");
  const asPub = ecdh.generateKeys(); // uncompressed point, 65 bytes
  const secret = ecdh.computeSecret(p256dh);
  const ikm = hkdf(secret, auth, Buffer.concat([Buffer.from("WebPush: info\0"), p256dh, asPub]), 32);
  const salt = randomBytes(16);
  const cek = hkdf(ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.concat([plain, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]); // 0x02: last record
  const header = Buffer.alloc(21);
  salt.copy(header);
  header.writeUInt32BE(4096, 16); // record size
  header[20] = asPub.length; // keyid = the sender's public key
  return Buffer.concat([header, asPub, ct]);
}

// ---- subscriptions ----

const sql = {
  subsOfHome: "SELECT * FROM push_subs WHERE home_id = ? ORDER BY created_at",
  countSubs: "SELECT COUNT(*) AS n FROM push_subs WHERE home_id = ?",
  upsert: `INSERT INTO push_subs (id, home_id, endpoint_hash, endpoint, p256dh, auth, label, lang, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) AS new
    ON DUPLICATE KEY UPDATE p256dh = new.p256dh, auth = new.auth, label = new.label, lang = new.lang, fails = 0`,
  byHash: "SELECT * FROM push_subs WHERE home_id = ? AND endpoint_hash = ?",
  prefs: "SELECT waiting, done FROM push_prefs WHERE home_id = ?",
  setPrefs: `INSERT INTO push_prefs (home_id, waiting, done, updated_at) VALUES (?, ?, ?, ?) AS new
    ON DUPLICATE KEY UPDATE waiting = new.waiting, done = new.done, updated_at = new.updated_at`,
  ok: "UPDATE push_subs SET last_ok_at = ?, fails = 0 WHERE id = ?",
  fail: "UPDATE push_subs SET fails = fails + 1 WHERE id = ?",
  drop: "DELETE FROM push_subs WHERE id = ?",
  dropDead: "DELETE FROM push_subs WHERE id = ? AND fails >= ?",
};
const MAX_FAILS = 50; // consecutive failed deliveries (not 404/410, those go at once) before a subscription is dropped

/** What the owner sees about a device: never the endpoint or keys. */
const deviceOut = (s: Row) => ({ id: s.id as string, label: (s.label ?? null) as string | null, lang: s.lang as string,
  created_at: Number(s.created_at), last_ok_at: s.last_ok_at == null ? null : Number(s.last_ok_at) });

type Prefs = { waiting: boolean; done: boolean };
async function prefsOf(homeId: string): Promise<Prefs> {
  const r = await one(db(), sql.prefs, [homeId]);
  return { waiting: r ? !!r.waiting : true, done: r ? !!r.done : true };
}

function checkEndpoint(v: unknown): string {
  const bad = () => new ApiError(400, "bad_subscription", "subscription.endpoint must be the https URL of a known push service.");
  if (typeof v !== "string" || v.length > 2000) throw bad();
  let u: URL;
  try { u = new URL(v); } catch { throw bad(); }
  if (u.username || u.password) throw bad();
  if (PUSH.extraOrigins.includes(u.origin)) return v;
  const host = u.hostname.toLowerCase();
  if (u.protocol !== "https:" || u.port || !PUSH.hosts.some((h) => host === h || host.endsWith("." + h))) throw bad();
  return v;
}
const probe = createECDH("prime256v1");
probe.generateKeys();
function checkKeys(k: any) {
  const p256dh = typeof k?.p256dh === "string" ? Buffer.from(k.p256dh, "base64url") : null;
  const auth = typeof k?.auth === "string" ? Buffer.from(k.auth, "base64url") : null;
  let ok = !!p256dh && p256dh.length === 65 && p256dh[0] === 4 && !!auth && auth.length === 16;
  if (ok) try { probe.computeSecret(p256dh!); } catch { ok = false; } // must be a point on the curve
  if (!ok) throw new ApiError(400, "bad_subscription", "subscription.keys must hold p256dh (P-256 point) and auth (16 bytes), base64url.");
  return { p256dh: b64u(p256dh!), auth: b64u(auth!) };
}

// ---- messages ----

const KINDS: Record<string, string> = {
  "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor", gemini: "Gemini CLI", qwen: "Qwen Code", copilot: "Copilot",
  windsurf: "Windsurf", cline: "Cline", kiro: "Kiro", opencode: "OpenCode", codebuddy: "CodeBuddy", workbuddy: "WorkBuddy",
  qoder: "Qoder", droid: "Droid", auggie: "Auggie", kimi: "Kimi", hermes: "Hermes", goose: "Goose", crush: "Crush",
  openclaw: "OpenClaw", amp: "Amp", trae: "Trae", "claude-agent-sdk": "Claude Agent SDK", "openai-agents": "OpenAI Agents",
  langchain: "LangChain", langgraph: "LangGraph", "ai-sdk": "AI SDK", "github-actions": "GitHub Actions", other: "Agent",
};
const kindLabel = (k: string) => KINDS[k] ?? (k ? k.charAt(0).toUpperCase() + k.slice(1) : "Agent");

const TEXT = {
  en: {
    waiting: (n: string) => `${n} is waiting for you`, done: (n: string) => `${n} finished`,
    many: (k: number) => `${k} agents need you`, waitingShort: (n: string) => `${n} is waiting`, doneShort: (n: string) => `${n} finished`,
    busy: (d: string) => `busy ${d}`, worked: (d: string) => `worked ${d}`,
    lt1: "< 1 min", min: (m: number) => `${m} min`, h: (h: number, m: number) => (m ? `${h} h ${m} min` : `${h} h`),
    testTitle: "Agent Town notifications are on", testBody: (home: string) => `${home} · this is how your agents will reach you.`,
  },
  zh: {
    waiting: (n: string) => `${n} 在等你`, done: (n: string) => `${n} 忙完了`,
    many: (k: number) => `${k} 个 agent 需要你`, waitingShort: (n: string) => `${n} 在等你`, doneShort: (n: string) => `${n} 忙完了`,
    busy: (d: string) => `已忙 ${d}`, worked: (d: string) => `忙了 ${d}`,
    lt1: "不到 1 分钟", min: (m: number) => `${m} 分钟`, h: (h: number, m: number) => (m ? `${h} 小时 ${m} 分钟` : `${h} 小时`),
    testTitle: "Agent Town 通知已开启", testBody: (home: string) => `${home} · 你的 agent 以后就这样找你。`,
  },
};
type Lang = keyof typeof TEXT;
const langOf = (s: Row): Lang => (s.lang === "zh" ? "zh" : "en");
function dur(L: (typeof TEXT)[Lang], ms: number) {
  const m = Math.round(ms / 60_000);
  return m < 1 ? L.lt1 : m < 60 ? L.min(m) : L.h(Math.floor(m / 60), m % 60);
}

type PushEvent = { type: "waiting" | "done"; persona_id: string; session_id: string; busy_ms: number | null };
type Msg = { title: string; body: string; url: string; tag: string; ts: number };

function compose(lang: Lang, homeId: string, homeName: string, evs: PushEvent[], personas: Map<string, Row>): Msg {
  const L = TEXT[lang];
  const name = (e: PushEvent) => personas.get(e.persona_id)?.name ?? "Agent";
  const url = `/h/${homeId}`, ts = Date.now();
  if (evs.length === 1) {
    const e = evs[0], p = personas.get(e.persona_id);
    const parts = [kindLabel(p?.kind ?? "other"), homeName];
    if (e.busy_ms !== null) parts.push(e.type === "done" ? L.worked(dur(L, e.busy_ms)) : L.busy(dur(L, e.busy_ms)));
    return { title: e.type === "waiting" ? L.waiting(name(e)) : L.done(name(e)), body: parts.join(" · "), url, tag: `p-${e.persona_id}`, ts };
  }
  const list = evs.map((e) => (e.type === "waiting" ? L.waitingShort(name(e)) : L.doneShort(name(e))));
  return { title: L.many(evs.length), body: `${list.join(", ")} · ${homeName}`, url, tag: `h-${homeId}`, ts };
}

// ---- delivery: fire-and-forget queue ----

const queue: (() => Promise<void>)[] = [];
let active = 0;
const MAX_ACTIVE = 8, MAX_QUEUE = 5000;
function enqueue(job: () => Promise<void>) {
  if (queue.length >= MAX_QUEUE) return; // push services down: drop instead of piling up
  queue.push(job);
  pump();
}
function pump() {
  while (active < MAX_ACTIVE && queue.length) {
    const job = queue.shift()!;
    active++;
    job().catch(logErr("push job failed")).finally(() => { active--; pump(); });
  }
}

// A failing subscription is logged once (by id and push service host, never its endpoint) per process.
const loggedFail = new Set<string>();
function noteFail(s: Row, why: string) {
  if (loggedFail.has(s.id)) return;
  loggedFail.add(s.id);
  let host = "?";
  try { host = new URL(s.endpoint).hostname; } catch {}
  console.error(`push: delivery to ${s.id} (home ${s.home_id}, ${host}) failed: ${why}`);
}

type Result = "ok" | "gone" | "failed";
async function deliver(s: Row, msg: Msg, urgency: "high" | "normal", topic: string, ttl: number): Promise<Result> {
  const body = encryptPayload(Buffer.from(JSON.stringify(msg)), Buffer.from(s.p256dh, "base64url"), Buffer.from(s.auth, "base64url"));
  let status: number;
  try {
    const res = await fetch(s.endpoint, {
      method: "POST", body: new Uint8Array(body), redirect: "manual", signal: AbortSignal.timeout(10_000),
      headers: {
        authorization: vapidHeader(s.endpoint), "content-encoding": "aes128gcm", "content-type": "application/octet-stream",
        ttl: String(ttl), urgency, topic,
      },
    });
    status = res.status;
    await res.arrayBuffer().catch(() => {});
  } catch (e) {
    noteFail(s, (e as Error).name || "network error");
    await run(db(), sql.fail, [s.id]);
    await run(db(), sql.dropDead, [s.id, MAX_FAILS]);
    return "failed";
  }
  if (status === 404 || status === 410) { // the browser unsubscribed or the subscription expired
    await run(db(), sql.drop, [s.id]);
    return "gone";
  }
  if (status >= 200 && status < 300) {
    if (!s.last_ok_at || Date.now() - Number(s.last_ok_at) > 60_000 || s.fails) await run(db(), sql.ok, [Date.now(), s.id]);
    return "ok";
  }
  noteFail(s, `HTTP ${status}`);
  await run(db(), sql.fail, [s.id]);
  await run(db(), sql.dropDead, [s.id, MAX_FAILS]);
  return "failed";
}

// Topic (RFC 8030 §5.4): a newer push with the same topic replaces an undelivered one. ≤ 32 base64url chars.
const topicOf = (tag: string) => createHash("sha256").update(tag).digest("base64url").slice(0, 32);

// ---- per-home outbox: coalesce bursts, prefs, debounce, rate limit ----

const outbox = new Map<string, PushEvent[]>();
const sentAt = new Map<string, number[]>(); // home -> notification timestamps of the last hour
const doneAt = new Map<string, number>(); // home|persona -> last "finished" push

function queueEvent(homeId: string, e: PushEvent) {
  const pending = outbox.get(homeId);
  if (pending) { pending.push(e); return; }
  outbox.set(homeId, [e]);
  setTimeout(() => {
    const evs = outbox.get(homeId) ?? [];
    outbox.delete(homeId);
    enqueue(() => flush(homeId, evs));
  }, PUSH.coalesceMs).unref();
}

function underRate(homeId: string, now: number) {
  const recent = (sentAt.get(homeId) ?? []).filter((t) => now - t < 3600_000);
  if (recent.length >= PUSH.hourlyMax) { sentAt.set(homeId, recent); return false; }
  recent.push(now);
  sentAt.set(homeId, recent);
  return true;
}

async function flush(homeId: string, evs: PushEvent[]) {
  const subs = await all(db(), sql.subsOfHome, [homeId]);
  if (!subs.length) return;
  const prefs = await prefsOf(homeId);
  const now = Date.now();
  const seen = new Set<string>();
  const wanted = evs.filter((e) => {
    const k = `${e.type}|${e.persona_id}`;
    if (!prefs[e.type] || seen.has(k)) return false;
    seen.add(k);
    if (e.type === "done") {
      const key = `${homeId}|${e.persona_id}`;
      if (now - (doneAt.get(key) ?? 0) < PUSH.doneDebounceMs) return false;
      doneAt.set(key, now);
    }
    return true;
  });
  if (!wanted.length || !underRate(homeId, now)) return;
  const home = await one(db(), "SELECT name FROM homes WHERE id = ?", [homeId]);
  if (!home) return;
  const personas = new Map((await all(db(), "SELECT id, name, kind FROM personas WHERE home_id = ?", [homeId])).map((p) => [p.id as string, p]));
  const waiting = wanted.some((e) => e.type === "waiting");
  for (const s of subs) {
    const msg = compose(langOf(s), homeId, home.name, wanted, personas);
    enqueue(async () => { await deliver(s, msg, waiting ? "high" : "normal", topicOf(msg.tag), 3600); });
  }
}

// ---- triggers: session status changes ----

const BUSY = new Set(["thinking", "tool", "background"]);
type Track = {
  status: string; persona: string; parent: string | null; seen: number;
  busySince: number | null; // start of the current turn (kept across waiting)
  episode: number; waitTimer: NodeJS.Timeout | null; doneAt: number;
};
const tracks = new Map<string, Track>();

function onSession(homeId: string, s: any) {
  if (!s?.id) return;
  const now = Date.now();
  let t = tracks.get(s.id);
  if (!t) {
    t = { status: "", persona: s.persona_id, parent: s.parent_id ?? null, seen: now, busySince: null, episode: 0, waitTimer: null, doneAt: 0 };
    tracks.set(s.id, t);
  }
  t.seen = now;
  t.persona = s.persona_id;
  t.parent = s.parent_id ?? null;
  const prev = t.status, st = s.status as string;
  if (st === prev) return; // a heartbeat: same episode, nothing new
  t.status = st;
  if (t.waitTimer) { clearTimeout(t.waitTimer); t.waitTimer = null; }
  if (st === "ended") { tracks.delete(s.id); return; }
  if (BUSY.has(st)) { t.busySince ??= now; return; }
  if (st === "waiting") {
    // Waiting right after a turn we already announced as finished (e.g. Claude Code's idle_prompt a minute later)
    // is the same "your turn" moment: don't ping twice.
    if (t.busySince === null && now - t.doneAt < PUSH.doneDebounceMs) return;
    const episode = ++t.episode, tr = t;
    t.waitTimer = setTimeout(() => {
      tr.waitTimer = null;
      if (tr.status !== "waiting" || tr.episode !== episode || tracks.get(s.id) !== tr) return;
      queueEvent(homeId, { type: "waiting", persona_id: tr.persona, session_id: s.id, busy_ms: tr.busySince === null ? null : Date.now() - tr.busySince });
    }, PUSH.waitDelayMs);
    t.waitTimer.unref();
    return;
  }
  if (st === "idle") {
    // A turn ended. Subagents finishing are part of their parent's turn; short turns are not worth a ping.
    const busy = t.busySince === null ? 0 : now - t.busySince;
    t.busySince = null;
    if (!t.parent && busy >= PUSH.minTurnMs) {
      t.doneAt = now;
      queueEvent(homeId, { type: "done", persona_id: t.persona, session_id: s.id, busy_ms: busy });
    }
  }
}

export function startPush() {
  if (!pushEnabled()) return;
  bus.on((e) => { if (e.type === "session") onSession(e.home_id, e.data); });
  // Sessions that vanished without an "ended" (deleted homes) and stale debounce / rate entries.
  setInterval(() => {
    const now = Date.now();
    for (const [id, t] of tracks) if (now - t.seen > 3 * 3600_000) { if (t.waitTimer) clearTimeout(t.waitTimer); tracks.delete(id); }
    for (const [k, ts] of doneAt) if (now - ts > PUSH.doneDebounceMs) doneAt.delete(k);
    for (const [k, ts] of sentAt) if (!ts.some((x) => now - x < 3600_000)) sentAt.delete(k);
  }, 10 * 60_000).unref();
}

// ---- API (owner key only): /v1/push… ----

export function mountPush(api: Hono<any>, requireAuth: Auth, ownerOnly: Auth) {
  const needEnabled = () => {
    if (!pushEnabled()) throw new ApiError(503, "push_disabled", "Notifications are not set up on this server.");
  };

  api.get("/push", requireAuth, ownerOnly, async (c) => {
    if (!pushEnabled()) return c.json({ enabled: false });
    const home = homeOf(c);
    const [prefs, subs] = await Promise.all([prefsOf(home), all(db(), sql.subsOfHome, [home])]);
    return c.json({ enabled: true, public_key: PUSH.publicKey, prefs, devices: subs.map(deviceOut), max_devices: PUSH.devicesPerHome });
  });

  // Subscribe this browser (idempotent per endpoint: a repeat updates its keys, label and language).
  api.post("/push/subscriptions", requireAuth, ownerOnly, async (c) => {
    needEnabled();
    const home = homeOf(c);
    limit(`pushsub:${home}`, 20 / 3600, 20);
    const b = await c.req.json().catch(() => null);
    const endpoint = checkEndpoint(b?.subscription?.endpoint);
    const keys = checkKeys(b?.subscription?.keys);
    const label = cleanText(b?.label, 40);
    const lang = b?.lang === "zh" ? "zh" : "en";
    const hash = sha256hex(endpoint);
    if (!(await one(db(), sql.byHash, [home, hash])) && (await one(db(), sql.countSubs, [home]))!.n >= PUSH.devicesPerHome) {
      throw new ApiError(429, "too_many_devices", `At most ${PUSH.devicesPerHome} devices per home; remove one first.`);
    }
    await run(db(), sql.upsert, [newId("ps"), home, hash, endpoint, keys.p256dh, keys.auth, label, lang, Date.now()]);
    return c.json({ device: deviceOut((await one(db(), sql.byHash, [home, hash]))!) }, 201);
  });

  api.delete("/push/subscriptions/:id", requireAuth, ownerOnly, async (c) => {
    const r = await run(db(), "DELETE FROM push_subs WHERE home_id = ? AND id = ?", [homeOf(c), c.req.param("id") ?? ""]);
    if (!r.affectedRows) throw new ApiError(404, "not_found", "No such device.");
    return c.json({ removed: c.req.param("id") });
  });

  // "Turn off on this device" when the browser knows its endpoint but not the device id (the endpoint stays in the body).
  api.post("/push/unsubscribe", requireAuth, ownerOnly, async (c) => {
    const b = await c.req.json().catch(() => null);
    if (typeof b?.endpoint !== "string") throw new ApiError(400, "bad_endpoint", "Send {\"endpoint\": \"…\"}.");
    const r = await run(db(), "DELETE FROM push_subs WHERE home_id = ? AND endpoint_hash = ?", [homeOf(c), sha256hex(b.endpoint)]);
    return c.json({ removed: r.affectedRows });
  });

  api.put("/push/prefs", requireAuth, ownerOnly, async (c) => {
    const home = homeOf(c);
    limit(`pushprefs:${home}`, 60 / 3600, 30);
    const b = await c.req.json().catch(() => null);
    const cur = await prefsOf(home);
    for (const k of ["waiting", "done"] as const) {
      if (b?.[k] === undefined) continue;
      if (typeof b[k] !== "boolean") throw new ApiError(400, "bad_prefs", `${k} must be true or false.`);
      cur[k] = b[k];
    }
    await run(db(), sql.setPrefs, [home, cur.waiting ? 1 : 0, cur.done ? 1 : 0, Date.now()]);
    return c.json({ prefs: cur });
  });

  // A test notification to every device of the home, delivered now (so the owner sees whether it worked).
  api.post("/push/test", requireAuth, ownerOnly, async (c) => {
    needEnabled();
    const home = homeOf(c);
    limit(`pushtest:${home}`, 5 / 600, 5);
    const subs = await all(db(), sql.subsOfHome, [home]);
    const name = (await one(db(), "SELECT name FROM homes WHERE id = ?", [home]))!.name as string;
    const results = await Promise.all(subs.map((s) => {
      const L = TEXT[langOf(s)];
      const msg = { title: L.testTitle, body: L.testBody(name), url: `/h/${home}`, tag: "test", ts: Date.now() };
      return deliver(s, msg, "normal", topicOf("test"), 600).catch((e): Result => { logErr("push test failed")(e); return "failed"; });
    }));
    const count = (r: Result) => results.filter((x) => x === r).length;
    return c.json({ sent: count("ok"), failed: count("failed"), removed: count("gone") });
  });
}
