// Moderation state and routes: hidden content (and its redaction in public outputs), abuse reports with auto-hide,
// bans, and the admin API (/v1/admin/*, Bearer ADMIN_TOKEN). The text filter itself is server/moderation.ts.
//
// Hidden/banned ids are cached in memory (single server process, like the rate limiter); the DB columns
// (hidden_at/hidden_reason, bans) are the source of truth and are loaded at startup by initSafety().
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Context, Hono, Next } from "hono";
import { SERVER_SECRET } from "./config.ts";
import { bus, type BusEvent } from "./bus.ts";
import { db, tx, all, one, run, type Row } from "./db.ts";
import * as store from "./store.ts";
import { clientIp } from "./hardening.ts";
import { ApiError, allow, cleanText } from "./util.ts";

export const KINDS = ["home", "persona", "say", "tombstone"] as const;
export type Kind = (typeof KINDS)[number];
export const REASONS = ["spam", "hate", "harassment", "sexual", "personal_info", "other"] as const;
export const HIDDEN_NAME = "(hidden)";

const TABLE: Record<Kind, string> = { home: "homes", persona: "personas", say: "says", tombstone: "tombstones" };
const ID_RE: Record<Kind, RegExp> = {
  home: /^h_[0-9a-z]{4,16}$/, persona: /^p_[0-9a-z]{4,16}$/, say: /^[1-9]\d{0,18}$/, tombstone: /^t_[0-9a-z]{4,16}$/,
};
const AUTO_HIDE_REPORTS = Number(process.env.AUTO_HIDE_REPORTS) || 3;
const AUTO_HIDE_WINDOW_MS = 24 * 3600_000;

function limit(key: string, perSec: number, burst: number) {
  if (!allow(key, perSec, burst)) throw new ApiError(429, "rate_limited", "Slow down.");
}

// ---- in-memory caches ----

const hidden: Record<Kind, Map<string, string>> = { home: new Map(), persona: new Map(), say: new Map(), tombstone: new Map() };
const bannedHashes = new Set<string>();
const bannedHomes = new Set<string>();

export async function initSafety() {
  for (const k of KINDS) {
    hidden[k].clear();
    for (const r of await all(db(), `SELECT id, hidden_reason FROM ${TABLE[k]} WHERE hidden_at IS NOT NULL`)) {
      hidden[k].set(String(r.id), r.hidden_reason ?? "");
    }
  }
  bannedHashes.clear();
  bannedHomes.clear();
  for (const b of await all(db(), "SELECT auth_hash, home_id FROM bans")) {
    bannedHashes.add(b.auth_hash);
    bannedHomes.add(b.home_id);
  }
  // A retired persona / deleted home leaves graves that copy its text: inherit the hidden flag.
  bus.on((e) => {
    if (e.type !== "tombstone") return;
    const t = e.data as Row;
    if ((t.persona_id && hidden.persona.has(t.persona_id)) || hidden.home.has(t.home_id)) {
      hidden.tombstone.set(t.id, "inherited");
      run(db(), "UPDATE tombstones SET hidden_at = ?, hidden_reason = 'inherited' WHERE id = ?", [Date.now(), t.id])
        .catch((err) => console.error("tombstone hide failed", err));
    }
  });
}

export const isHidden = (kind: Kind, id: string) => hidden[kind].has(String(id));
export const isBanned = (authHash: string, homeId?: string | null) =>
  bannedHashes.has(authHash) || (!!homeId && bannedHomes.has(homeId));

export function assertNotBanned(authHash: string, homeId?: string | null) {
  if (isBanned(authHash, homeId)) {
    throw new ApiError(403, "banned", "This home has been banned from writing to Agent Town.");
  }
}

// ---- redaction (public outputs and SSE) ----

// Image-ish fields of homes/personas (incl. ones other code may add later) that must not leak for hidden items.
const ART_KEYS = ["art", "look", "sprite", "art_svg"];
const nullArt = (o: Record<string, any>) => { for (const k of ART_KEYS) if (k in o) o[k] = null; return o; };

export function redactHome<T extends Record<string, any>>(h: T): T {
  if (!h || !hidden.home.has(h.id)) return h;
  return nullArt({ ...h, name: HIDDEN_NAME, description: null, hidden: true }) as T;
}

export function redactPersona<T extends Record<string, any>>(p: T): T {
  if (!p || !hidden.persona.has(p.id)) return p;
  return nullArt({ ...p, name: HIDDEN_NAME, appearance: null, sprite_error: null, hidden: true }) as T;
}

/** Says of hidden homes, hidden personas, and hidden says are omitted entirely. */
export const sayVisible = (homeId: string, s: { id?: unknown; persona_id?: string }) =>
  !hidden.home.has(homeId) && !(s.persona_id && hidden.persona.has(s.persona_id)) &&
  !(s.id !== undefined && hidden.say.has(String(s.id)));
export const redactSays = <T extends { id?: unknown; persona_id?: string }>(homeId: string, says: T[]) =>
  says.filter((s) => sayVisible(homeId, s));

export function redactTombstone<T extends Record<string, any>>(t: T): T {
  if (!t) return t;
  const self = hidden.tombstone.has(t.id) || (t.persona_id && hidden.persona.has(t.persona_id));
  const homeHidden = hidden.home.has(t.home_id);
  if (!self && !homeHidden) return t;
  const out: Record<string, any> = { ...t };
  if (homeHidden) out.home_name = HIDDEN_NAME;
  if (self) Object.assign(out, { name: HIDDEN_NAME, appearance: null, sprite: null, epitaph: null, hidden: true });
  return out as T;
}

/** A /town entry: home + personas + says. */
export const redactTownHome = (h: Record<string, any>) => ({
  ...redactHome(h),
  ...(h.personas ? { personas: h.personas.map(redactPersona) } : {}),
  ...(h.says ? { says: redactSays(h.id, h.says) } : {}),
});

/** SSE: redacted copy of the event, or null to drop it. */
export function redactEvent(e: BusEvent): BusEvent | null {
  switch (e.type) {
    case "home": return { ...e, data: redactHome(e.data as Row) };
    case "persona": return { ...e, data: redactPersona(e.data as Row) };
    case "say": return sayVisible(e.home_id, e.data as Row) ? e : null;
    case "tombstone":
    case "tombstone_update": return { ...e, data: redactTombstone(e.data as Row) };
    default: return e;
  }
}

// ---- hide / unhide ----

async function targetRow(kind: Kind, id: string): Promise<Row | undefined> {
  if (!ID_RE[kind].test(id)) return undefined;
  return one(db(), `SELECT * FROM ${TABLE[kind]} WHERE id = ?`, [id]);
}

/** Pushes the item's current (redacted by the stream) state to live clients. */
async function announce(kind: Kind, row: Row, hiding: boolean) {
  switch (kind) {
    case "home": {
      const h = await store.homeById(row.id);
      if (h) bus.emit({ type: "home", home_id: row.id, data: store.publicHome(h) });
      if (hiding) bus.emit({ type: "say_removed", home_id: row.id, data: {} });
      break;
    }
    case "persona":
      bus.emit({ type: "persona", home_id: row.home_id, data: store.publicPersona(row) });
      if (hiding) bus.emit({ type: "say_removed", home_id: row.home_id, data: { persona_id: row.id } });
      break;
    case "say":
      if (hiding) bus.emit({ type: "say_removed", home_id: row.home_id, data: { id: String(row.id), persona_id: row.persona_id, ts: row.ts } });
      break;
    case "tombstone":
      bus.emit({ type: "tombstone_update", home_id: row.home_id, data: store.publicTombstone(row) });
      break;
  }
}

export async function hide(kind: Kind, id: string, reason: string) {
  const row = await targetRow(kind, id);
  if (!row) throw new ApiError(404, "not_found", `No such ${kind}.`);
  await run(db(), `UPDATE ${TABLE[kind]} SET hidden_at = ?, hidden_reason = ? WHERE id = ?`, [Date.now(), reason, id]);
  hidden[kind].set(String(id), reason);
  await announce(kind, row, true);
  return { kind, id: String(id), hidden: true, reason };
}

export async function unhide(kind: Kind, id: string) {
  const row = await targetRow(kind, id);
  if (!row) throw new ApiError(404, "not_found", `No such ${kind}.`);
  await run(db(), `UPDATE ${TABLE[kind]} SET hidden_at = NULL, hidden_reason = NULL WHERE id = ?`, [id]);
  hidden[kind].delete(String(id));
  // Reviewed: the open reports are settled, so they don't re-hide it right away.
  await run(db(), "UPDATE reports SET status = 'dismissed', resolved_at = ? WHERE kind = ? AND target_id = ? AND status = 'open'",
    [Date.now(), kind, String(id)]);
  await announce(kind, row, false);
  return { kind, id: String(id), hidden: false };
}

// ---- reports ----

const reporterHash = (ip: string) => createHmac("sha256", SERVER_SECRET).update(`agenttown/report/v1:${ip}`).digest("hex");

export async function fileReport(ip: string, kind: Kind, id: string, reason: string, note: string | null) {
  const row = await targetRow(kind, id);
  if (!row) throw new ApiError(404, "not_found", `No such ${kind}.`);
  const homeId = kind === "home" ? row.id : row.home_id;
  const now = Date.now();
  await run(db(), `INSERT IGNORE INTO reports (kind, target_id, home_id, reporter_hash, reason, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`, [kind, String(id), homeId, reporterHash(ip), reason, note, now]);
  if (!hidden[kind].has(String(id))) {
    const n = (await one(db(), `SELECT COUNT(DISTINCT reporter_hash) AS n FROM reports
      WHERE kind = ? AND target_id = ? AND status = 'open' AND created_at > ?`, [kind, String(id), now - AUTO_HIDE_WINDOW_MS]))!.n;
    if (n >= AUTO_HIDE_REPORTS) {
      await hide(kind, String(id), `auto: ${n} reports, pending review`);
      console.log(`moderation: auto-hid ${kind} ${id} after ${n} reports`);
    }
  }
}

function contentOf(kind: Kind, r: Row | undefined) {
  if (!r) return null;
  const base = { hidden_at: r.hidden_at ?? null, hidden_reason: r.hidden_reason ?? null };
  switch (kind) {
    case "home": return { id: r.id, name: r.name, description: r.description, ...base };
    case "persona": return { id: r.id, home_id: r.home_id, name: r.name, kind: r.kind, appearance: r.appearance, ...base };
    case "say": return { id: String(r.id), home_id: r.home_id, persona_id: r.persona_id, text: r.text, ts: r.ts, ...base };
    case "tombstone": return {
      id: r.id, home_id: r.home_id, name: r.name, home_name: r.home_name, appearance: r.appearance, epitaph: r.epitaph, ...base,
    };
  }
}

/** Reports grouped by target, with the target's current content (null if it's gone). */
export async function listReports(status: "open" | "all", lim: number) {
  const rows = await all(db(), `SELECT * FROM reports ${status === "open" ? "WHERE status = 'open'" : ""}
    ORDER BY created_at DESC LIMIT ?`, [lim]);
  const groups = new Map<string, any>();
  for (const r of rows) {
    const key = `${r.kind}:${r.target_id}`;
    if (!groups.has(key)) groups.set(key, { kind: r.kind, id: r.target_id, home_id: r.home_id, reports: [] });
    groups.get(key).reports.push({ id: r.id, reason: r.reason, note: r.note, status: r.status, created_at: r.created_at });
  }
  const targets = await Promise.all([...groups.values()].map(async (g) => {
    const row = await targetRow(g.kind, g.id);
    return { ...g, content: contentOf(g.kind, row), banned: g.home_id ? bannedHomes.has(g.home_id) : false };
  }));
  return { targets };
}

// ---- bans & hard delete ----

export async function ban(homeId: string, reason: string | null) {
  const home = await one(db(), "SELECT id, auth_hash FROM homes WHERE id = ?", [homeId]);
  if (!home) throw new ApiError(404, "not_found", "No such home.");
  const hashes = [home.auth_hash as string, ...(await all(db(), "SELECT auth_hash FROM devices WHERE home_id = ?", [homeId])).map((d) => d.auth_hash as string)];
  const now = Date.now();
  for (const h of hashes) {
    await run(db(), "INSERT INTO bans (auth_hash, home_id, reason, created_at) VALUES (?, ?, ?, ?) AS new ON DUPLICATE KEY UPDATE reason = new.reason",
      [h, homeId, reason, now]);
    bannedHashes.add(h);
  }
  bannedHomes.add(homeId);
  return { home_id: homeId, banned_credentials: hashes.length };
}

export async function unban(homeId: string) {
  const rows = await all(db(), "SELECT auth_hash FROM bans WHERE home_id = ?", [homeId]);
  await run(db(), "DELETE FROM bans WHERE home_id = ?", [homeId]);
  for (const r of rows) bannedHashes.delete(r.auth_hash);
  bannedHomes.delete(homeId);
  return { home_id: homeId, unbanned_credentials: rows.length };
}

/** Abuse removal: deletes the home and everything under it, its graves included, without creating new graves. */
export async function hardDeleteHome(homeId: string) {
  const graves = await tx(async (c) => {
    const home = await one(c, "SELECT id FROM homes WHERE id = ? FOR UPDATE", [homeId]);
    if (!home) throw new ApiError(404, "not_found", "No such home.");
    for (const t of ["events", "daily_stats", "tool_stats", "avatar_usage"]) await run(c, `DELETE FROM ${t} WHERE home_id = ?`, [homeId]);
    const g = await run(c, "DELETE FROM tombstones WHERE home_id = ?", [homeId]);
    await run(c, "DELETE FROM homes WHERE id = ?", [homeId]); // cascades personas, sessions, says, invites, devices
    await run(c, "UPDATE reports SET status = 'actioned', resolved_at = ? WHERE home_id = ? AND status = 'open'", [Date.now(), homeId]);
    return g.affectedRows;
  });
  bus.emit({ type: "home_removed", home_id: homeId, data: { removed: true } });
  return { deleted: homeId, tombstones_deleted: graves };
}

// ---- routes ----

const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";
if (ADMIN_TOKEN && ADMIN_TOKEN.length < 32) console.error("ADMIN_TOKEN is shorter than 32 chars: admin API disabled");
const adminEnabled = ADMIN_TOKEN.length >= 32;
const adminDigest = createHash("sha256").update(ADMIN_TOKEN).digest();

async function requireAdmin(c: Context, next: Next) {
  if (!adminEnabled) throw new ApiError(404, "not_found", "Not found.");
  const got = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const ok = timingSafeEqual(createHash("sha256").update(got).digest(), adminDigest);
  if (!ok) {
    limit(`adminfail:${clientIp(c)}`, 10 / 3600, 10);
    throw new ApiError(401, "unauthorized", "Bad admin token.");
  }
  await next();
}

async function jsonBody(c: Context): Promise<Record<string, any>> {
  try {
    const b = await c.req.json();
    if (b && typeof b === "object" && !Array.isArray(b)) return b;
  } catch {}
  throw new ApiError(400, "bad_json", "Body must be a JSON object.");
}

function kindAndId(b: Record<string, any>): [Kind, string] {
  if (!KINDS.includes(b.kind)) throw new ApiError(400, "bad_kind", `kind must be one of ${KINDS.join(", ")}.`);
  const id = typeof b.id === "number" ? String(b.id) : b.id;
  if (typeof id !== "string" || !ID_RE[b.kind as Kind].test(id)) throw new ApiError(404, "not_found", `No such ${b.kind}.`);
  return [b.kind, id];
}

export function mountSafety(api: Hono<any>) {
  // Public: report something. 10/hour/IP; one report per IP and target counts.
  api.post("/reports", async (c) => {
    const ip = clientIp(c);
    limit(`flag:${ip}`, 10 / 3600, 10);
    const b = await jsonBody(c);
    const [kind, id] = kindAndId(b);
    const reason = b.reason ?? "other";
    if (!REASONS.includes(reason)) throw new ApiError(400, "bad_reason", `reason must be one of ${REASONS.join(", ")}.`);
    const note = cleanText(b.note, 300);
    await fileReport(ip, kind, id, reason, note);
    return c.json({ ok: true }, 202);
  });

  const admin = api.basePath("/admin");
  admin.use("*", requireAdmin);
  admin.get("/reports", async (c) => {
    const status = c.req.query("status") === "all" ? "all" : "open";
    const lim = Math.min(Math.max(Number(c.req.query("limit")) || 200, 1), 1000);
    return c.json(await listReports(status, lim));
  });
  admin.post("/hide", async (c) => {
    const b = await jsonBody(c);
    const [kind, id] = kindAndId(b);
    return c.json(await hide(kind, id, cleanText(b.reason, 200) ?? "admin"));
  });
  admin.post("/unhide", async (c) => {
    const [kind, id] = kindAndId(await jsonBody(c));
    return c.json(await unhide(kind, id));
  });
  admin.post("/dismiss", async (c) => {
    const b = await jsonBody(c);
    const now = Date.now();
    if (b.report_id !== undefined) {
      const r = await run(db(), "UPDATE reports SET status = 'dismissed', resolved_at = ? WHERE id = ? AND status = 'open'", [now, Number(b.report_id) || 0]);
      if (!r.affectedRows) throw new ApiError(404, "not_found", "No such open report.");
      return c.json({ dismissed: r.affectedRows });
    }
    const [kind, id] = kindAndId(b); // dismiss every open report about one target
    const r = await run(db(), "UPDATE reports SET status = 'dismissed', resolved_at = ? WHERE kind = ? AND target_id = ? AND status = 'open'", [now, kind, id]);
    return c.json({ dismissed: r.affectedRows });
  });
  admin.post("/ban", async (c) => {
    const b = await jsonBody(c);
    if (typeof b.home_id !== "string" || !ID_RE.home.test(b.home_id)) throw new ApiError(404, "not_found", "No such home.");
    return c.json(await ban(b.home_id, cleanText(b.reason, 200)));
  });
  admin.post("/unban", async (c) => {
    const b = await jsonBody(c);
    if (typeof b.home_id !== "string" || !ID_RE.home.test(b.home_id)) throw new ApiError(404, "not_found", "No such home.");
    return c.json(await unban(b.home_id));
  });
  admin.delete("/home/:id", async (c) => {
    const id = c.req.param("id") ?? "";
    if (!ID_RE.home.test(id)) throw new ApiError(404, "not_found", "No such home.");
    return c.json(await hardDeleteHome(id));
  });
}
