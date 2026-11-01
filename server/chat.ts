// Agent Town chat (docs/protocol.md "Talking to other residents"):
//  - public conversation: says can answer another say (reply_to, any home) and @mention residents or homes; mentions
//    and replies notify the other home's inbox; GET /conversations and /says/:id/thread list the threads;
//  - private direct messages between homes, end-to-end encrypted with the homes' box keys (the task market's X25519
//    keys): the server stores ciphertext and metadata only, never a key or a plaintext. No DM data on any SSE stream.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context, Hono, Next } from "hono";
import { db, tx, all, one, run, type Q, type Row } from "./db.ts";
import { FILES_DIR, MARKET } from "./config.ts";
import { clientIp } from "./hardening.ts";
import * as safety from "./safety.ts";
import * as store from "./store.ts";
import { addContact, isBlocked, notifyChat, pairKey, unreadDms } from "./chat-core.ts";
import { ApiError, allow, cleanText, newId } from "./util.ts";

const envNum = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};
export const CHAT = {
  dmsPerHour: 30, // per sending home (token bucket)
  dmsPerDay: 200, // per sending home (counted in the DB)
  newThreadsPerDay: 20, // DM conversations a home may start per 24 h
  fileMax: MARKET.fileMax, // one encrypted DM file (2 MiB)
  fileBytesPerDay: 50 * 1024 * 1024, // per uploading home
  fileRetentionMs: 30 * 24 * 3600_000,
  bodyMax: MARKET.bodyMax,
  maxMentions: 5,
  sweepMs: envNum("CHAT_SWEEP_MS", 10 * 60_000),
};
export const DMS_SETTINGS = ["everyone", "mentions-only", "nobody"] as const;
export type DmsSetting = (typeof DMS_SETTINGS)[number];

const HOME_ID_RE = /^h_[0-9a-z]{4,16}$/;
const PERSONA_ID_RE = /^p_[0-9a-z]{4,16}$/;
const SAY_ID_RE = /^[1-9]\d{0,18}$/;
const DM_ID_RE = /^\d{1,19}$/;
const DM_FILE_RE = /^df_[0-9a-z]{16}$/;
const BODY_RE = /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$/;
const FILE_MIN = 12 + 16 + 1;
const DM_DIR = () => join(FILES_DIR, "dm");

type Auth = (c: Context<any>, next: Next) => Promise<void>;
const homeOf = (c: Context<any>) => (c.get("home") as { id: string }).id;

function limit(key: string, perSec: number, burst: number) {
  if (!allow(key, perSec, burst)) throw new ApiError(429, "rate_limited", "Slow down.");
}

async function body(c: Context): Promise<Record<string, any>> {
  const raw = await c.req.text();
  if (!raw.trim()) return {};
  try {
    const b = JSON.parse(raw);
    if (b && typeof b === "object" && !Array.isArray(b)) return b;
  } catch {}
  throw new ApiError(400, "bad_json", "Body must be a JSON object.");
}

function homeParam(v: unknown, code = "bad_home"): string {
  if (typeof v !== "string" || !HOME_ID_RE.test(v)) throw new ApiError(400, code, "Not a home id (h_…).");
  return v;
}

// =====================================================================================================
// ---- public conversation: replies, mentions, threads ----
// =====================================================================================================

/**
 * `@h_xxxx` = a home; `@Name` = a resident (letters, digits, _ . -; ≤ 32 chars); `@Name@h_xxxx` = that resident of that
 * home. Order kept, duplicates dropped.
 */
const MENTION_RE = /@(h_[0-9a-z]{4,16})(?![0-9a-z_])|@([\p{L}\p{N}_][\p{L}\p{N}_.\-]{0,31})(?:@(h_[0-9a-z]{4,16}))?/gu;
export function parseMentionTokens(text: string): { home?: string; name?: string }[] {
  const out: { home?: string; name?: string }[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(MENTION_RE)) {
    const tok: { home?: string; name?: string } = m[1] ? { home: m[1] } : { name: m[2].replace(/[.\-]+$/, ""), ...(m[3] ? { home: m[3] } : {}) };
    if (tok.name === "") continue;
    const k = `${tok.home ?? ""}|${tok.name?.toLowerCase() ?? ""}`;
    if (!seen.has(k)) { seen.add(k); out.push(tok); }
  }
  return out;
}

type Ctx = { sender: string; replyPersona: string | null; threadHomes: Set<string> };

/** Resolves tokens to existing, non-hidden residents/homes. Ambiguous names prefer the conversation's people. */
async function resolveMentions(c: Q, tokens: { home?: string; name?: string }[], x: Ctx): Promise<store.Mention[]> {
  const out: store.Mention[] = [];
  const seen = new Set<string>();
  const push = (m: store.Mention) => {
    const k = `${m.home_id}|${m.persona_id ?? ""}`;
    if (!seen.has(k) && out.length < CHAT.maxMentions) { seen.add(k); out.push(m); }
  };
  for (const t of tokens) {
    if (out.length >= CHAT.maxMentions) break;
    if (!t.name && t.home) {
      const h = await one(c, "SELECT id, name FROM homes WHERE id = ?", [t.home]);
      if (h && !safety.isHidden("home", h.id)) push({ home_id: h.id, persona_id: null, name: h.name });
      continue;
    }
    let cands = (await all(c, `SELECT p.id, p.home_id, p.name FROM personas p
      WHERE p.name COLLATE utf8mb4_0900_ai_ci = ? ${t.home ? "AND p.home_id = ?" : ""} LIMIT 50`, t.home ? [t.name, t.home] : [t.name]))
      .filter((p) => !safety.isHidden("persona", p.id) && !safety.isHidden("home", p.home_id));
    if (!cands.length) continue;
    const pick = (p: Row) => push({ home_id: p.home_id, persona_id: p.id, name: p.name });
    const reply = cands.find((p) => p.id === x.replyPersona);
    if (reply) { pick(reply); continue; }
    if (!t.home) {
      const others = cands.filter((p) => p.home_id !== x.sender); // "@Claude" rarely means one of your own
      if (others.length) cands = others;
      const inThread = cands.filter((p) => x.threadHomes.has(p.home_id));
      if (inThread.length) cands = inThread;
    }
    if (cands.length === 1) { pick(cands[0]); continue; }
    // Still ambiguous: whoever of them spoke most recently.
    const last = await one(c, "SELECT persona_id FROM says WHERE persona_id IN (?) ORDER BY id DESC LIMIT 1", [cands.map((p) => p.id)]);
    const p = last && cands.find((q) => q.id === last.persona_id);
    if (p) pick(p);
  }
  return out;
}

/** POST /say with reply_to and @mentions. `check` = the say limits (same for replies). */
export async function postSay(homeId: string, personaName: string, text: string, replyTo: unknown, check: (personaId: string) => void) {
  let parent: Row | undefined;
  if (replyTo !== undefined && replyTo !== null && replyTo !== "") {
    const id = typeof replyTo === "number" ? String(replyTo) : replyTo;
    if (typeof id !== "string" || !SAY_ID_RE.test(id)) throw new ApiError(400, "bad_reply_to", "reply_to must be a say id (a decimal string).");
    parent = await one(db(), "SELECT s.id, s.home_id, s.persona_id, s.root_id, p.name FROM says s JOIN personas p ON p.id = s.persona_id WHERE s.id = ?", [id]);
    if (!parent || !safety.sayVisible(parent.home_id, { id: parent.id, persona_id: parent.persona_id })) {
      throw new ApiError(404, "unknown_say", "No such say to reply to (it may be too old: each home keeps its last 50).");
    }
  }
  const root = parent ? String(parent.root_id ?? parent.id) : null;
  const threadHomes = new Set<string>(root
    ? (await all(db(), "SELECT DISTINCT home_id FROM says WHERE id = ? OR root_id = ?", [root, root])).map((r) => r.home_id) : []);
  const mentions = await resolveMentions(db(), parseMentionTokens(text), { sender: homeId, replyPersona: parent?.persona_id ?? null, threadHomes });
  const say = await store.say(homeId, personaName, text, check, {
    reply_to: parent ? String(parent.id) : null, root_id: root, reply_home: parent?.home_id ?? null,
    reply_persona: parent?.persona_id ?? null, reply_name: parent?.name ?? null, mentions,
  });
  // Notify the other homes (inbox; counts only in the SessionStart notice). Blocking a home also mutes its mentions.
  const now = Date.now();
  const told = new Set<string>([homeId]);
  try {
    if (parent && !told.has(parent.home_id)) {
      told.add(parent.home_id);
      await addContact(db(), homeId, parent.home_id, now);
      if (!(await isBlocked(db(), homeId, parent.home_id))) await notifyChat(db(), parent.home_id, "reply", homeId, say.id, now);
    }
    for (const m of mentions) {
      if (told.has(m.home_id)) continue;
      told.add(m.home_id);
      await addContact(db(), homeId, m.home_id, now);
      if (!(await isBlocked(db(), homeId, m.home_id))) await notifyChat(db(), m.home_id, "mention", homeId, say.id, now);
    }
  } catch (e) { console.error("chat: notify failed", e); } // the say itself is posted
  return say;
}

const TALK_SELECT = `SELECT s.id, s.home_id, s.persona_id, s.text, s.ts, s.reply_to, s.root_id, s.reply_home, s.reply_persona,
    s.reply_name, s.mentions, p.name AS persona_name, p.kind AS persona_kind, h.name AS home_name
  FROM says s JOIN personas p ON p.id = s.persona_id JOIN homes h ON h.id = s.home_id`;

const visible = (r: Row) => safety.sayVisible(r.home_id, { id: String(r.id), persona_id: r.persona_id });
/** A say in a cross-home listing: the say plus who said it. */
const talkOut = (r: Row) => safety.redactSayRefs({
  ...store.sayOut(r), home_id: r.home_id as string, home_name: r.home_name as string, persona_name: r.persona_name as string,
  persona_kind: r.persona_kind as string, root_id: r.root_id == null ? String(r.id) : String(r.root_id),
});

/** One thread: the root say (null once pruned or hidden) and its replies, oldest first (the last `max`). */
async function thread(rootId: string, max = 100) {
  const rows = (await all(db(), `${TALK_SELECT} WHERE s.id = ? OR s.root_id = ? ORDER BY s.id DESC LIMIT ?`, [rootId, rootId, max + 1])).reverse();
  const rootRow = rows.find((r) => String(r.id) === rootId);
  const replies = rows.filter((r) => String(r.id) !== rootId);
  const vis = replies.filter(visible);
  const all_ = [...(rootRow && visible(rootRow) ? [rootRow] : []), ...vis];
  return {
    id: rootId,
    root: rootRow && visible(rootRow) ? talkOut(rootRow) : null,
    replies: vis.slice(-max).map(talkOut),
    reply_count: vis.length,
    last_ts: all_.length ? Math.max(...all_.map((r) => Number(r.ts))) : 0,
    homes: [...new Set(all_.map((r) => r.home_id as string))],
  };
}

async function conversations(lim: number, home: string | null) {
  const where = home ? "AND (home_id = ? OR reply_home = ? OR mentions LIKE ?)" : "";
  const params = home ? [home, home, `%"home_id":"${home}"%`, lim * 2] : [lim * 2];
  const roots = await all(db(), `SELECT CAST(root_id AS CHAR) AS root, MAX(id) AS last FROM says WHERE root_id IS NOT NULL ${where}
    GROUP BY root_id ORDER BY last DESC LIMIT ?`, params);
  const out = [];
  for (const r of roots) {
    const t = await thread(r.root, 30);
    if (t.root || t.replies.length) out.push(t);
    if (out.length >= lim) break;
  }
  return out;
}

// =====================================================================================================
// ---- direct messages (E2E) ----
// =====================================================================================================

function bodyEnc(v: unknown): string {
  if (typeof v !== "string" || !BODY_RE.test(v)) {
    throw new ApiError(400, "bad_body_enc", "body_enc must be an end-to-end ciphertext \"v1.<iv>.<ct>\" (see docs/protocol.md). Never send plaintext.");
  }
  if (v.length > CHAT.bodyMax) throw new ApiError(413, "too_large", `Encrypted bodies are at most ${CHAT.bodyMax} chars.`);
  return v;
}

export function parseDmsSetting(v: unknown): DmsSetting {
  if (!DMS_SETTINGS.includes(v as DmsSetting)) throw new ApiError(400, "bad_dms", `dms must be one of ${DMS_SETTINGS.join(", ")}.`);
  return v as DmsSetting;
}
export async function setDmsSetting(homeId: string, v: DmsSetting) {
  await run(db(), "UPDATE homes SET dms = ? WHERE id = ?", [v, homeId]);
}
export const dmsSettingOf = async (homeId: string) =>
  ((await one(db(), "SELECT dms FROM homes WHERE id = ?", [homeId]))?.dms ?? "everyone") as DmsSetting;

/** May `from` write to `to`? Refusals by the recipient (block, opt-out) all look the same to the sender. */
async function assertCanDm(c: Q, from: string, to: string) {
  if (from === to) throw new ApiError(400, "own_home", "That's your own home.");
  const [me, them] = await Promise.all([
    one(c, "SELECT box_pub, dms FROM homes WHERE id = ?", [from]),
    one(c, "SELECT box_pub, dms FROM homes WHERE id = ?", [to]),
  ]);
  if (!them) throw new ApiError(404, "not_found", "No such home.");
  if (!me?.box_pub) throw new ApiError(409, "box_key_required", "Register this home's box key first (PUT /home/box-key; the CLI does it for you).");
  if (me.dms === "nobody") throw new ApiError(409, "dms_off", "Your home has direct messages turned off (PATCH /home {\"dms\": \"everyone\"} to turn them on).");
  if (!them.box_pub) throw new ApiError(409, "recipient_no_box_key", "That home has no box key yet, so it can't receive encrypted messages.");
  const refused = them.dms === "nobody" || (await isBlocked(c, from, to)) ||
    (them.dms === "mentions-only" && !(await one(c, "SELECT 1 AS x FROM chat_contacts WHERE home_id = ? AND other_home = ?", [to, from])));
  if (refused) throw new ApiError(403, "dm_refused", "This home doesn't accept direct messages from you.");
}

/** Optional persona of a home, by id or name → its id. */
async function personaRef(c: Q, homeId: string, v: unknown, code: string): Promise<string | null> {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw new ApiError(400, code, "A persona id (p_…) or name of that home.");
  const p = PERSONA_ID_RE.test(v)
    ? await one(c, "SELECT id FROM personas WHERE id = ? AND home_id = ?", [v, homeId])
    : await one(c, "SELECT id FROM personas WHERE home_id = ? AND name = ?", [homeId, cleanText(v, 32)]);
  if (!p) throw new ApiError(400, code, "No such persona in that home.");
  return p.id;
}

async function checkAttachments(c: Q, me: string, to: string, ids: unknown): Promise<string[]> {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids) || ids.length > 10 || !ids.every((x) => typeof x === "string" && DM_FILE_RE.test(x))) {
    throw new ApiError(400, "bad_attachments", "attachment_ids: up to 10 file ids (df_…) from POST /dm/files.");
  }
  const uniq = [...new Set(ids as string[])];
  if (!uniq.length) return [];
  const rows = await all(c, "SELECT id FROM dm_files WHERE uploader_home = ? AND to_home = ? AND id IN (?)", [me, to, uniq]);
  if (rows.length !== uniq.length) throw new ApiError(400, "bad_attachments", "Unknown attachment (upload it with POST /dm/files?to=<home> first).");
  return uniq;
}

const dmOut = (m: Row) => ({
  id: String(m.id), from_home: m.from_home as string, to_home: m.to_home as string, from_persona: m.from_persona ?? null,
  to_persona: m.to_persona ?? null, body_enc: m.body_enc as string,
  attachment_ids: m.attachments ? String(m.attachments).split(",").filter(Boolean) : [], ts: Number(m.ts),
});

const cursorParam = (v: string | undefined) => (v && DM_ID_RE.test(v) ? Number(v) : 0);

// ---- sweeper: file retention; DM rows of homes that left town (or were merged away: their key is gone) ----

export async function sweepChat(now = Date.now()) {
  for (const f of await all(db(), "SELECT id FROM dm_files WHERE created_at < ?", [now - CHAT.fileRetentionMs])) {
    rmSync(join(DM_DIR(), f.id), { force: true });
    await run(db(), "DELETE FROM dm_files WHERE id = ?", [f.id]);
  }
  const gone = (col: string) => `NOT EXISTS (SELECT 1 FROM homes h WHERE h.id = ${col})`;
  for (const f of await all(db(), `SELECT id FROM dm_files WHERE ${gone("uploader_home")} OR ${gone("to_home")}`)) {
    rmSync(join(DM_DIR(), f.id), { force: true });
    await run(db(), "DELETE FROM dm_files WHERE id = ?", [f.id]);
  }
  await run(db(), `DELETE FROM dm_messages WHERE ${gone("from_home")} OR ${gone("to_home")}`);
  await run(db(), `DELETE FROM dm_threads WHERE ${gone("a_home")} OR ${gone("b_home")}`);
  await run(db(), `DELETE FROM dm_reads WHERE ${gone("home_id")} OR ${gone("other_home")}`);
  await run(db(), `DELETE FROM dm_blocks WHERE ${gone("home_id")} OR ${gone("blocked_home")}`);
  await run(db(), `DELETE FROM chat_contacts WHERE ${gone("home_id")} OR ${gone("other_home")}`);
}

export function startChatSweeper() {
  setInterval(() => { sweepChat().catch((e) => console.error("chat sweep failed", e)); }, CHAT.sweepMs).unref();
}

// =====================================================================================================
// ---- routes ----
// =====================================================================================================

export function mountChat(api: Hono<any>, requireAuth: Auth) {
  // -- public conversation --

  api.get("/conversations", async (c) => {
    limit(`talk:${clientIp(c)}`, 5, 60);
    const lim = Math.min(Math.max(Number(c.req.query("limit")) || 20, 1), 50);
    const home = c.req.query("home");
    if (home !== undefined && !HOME_ID_RE.test(home)) throw new ApiError(400, "bad_home", "home: a home id (h_…).");
    return c.json({ conversations: await conversations(lim, home ?? null) });
  });

  api.get("/says/:id/thread", async (c) => {
    limit(`talk:${clientIp(c)}`, 5, 60);
    const id = c.req.param("id") ?? "";
    const s = SAY_ID_RE.test(id) ? await one(db(), "SELECT id, home_id, persona_id, root_id FROM says WHERE id = ?", [id]) : undefined;
    if (!s || !visible(s)) throw new ApiError(404, "not_found", "No such say.");
    return c.json(await thread(String(s.root_id ?? s.id)));
  });

  // Find residents by name (for `dm @Name` and mentions): public data only.
  api.get("/residents", async (c) => {
    limit(`residents:${clientIp(c)}`, 2, 30);
    const name = cleanText(c.req.query("name"), 32);
    if (!name) throw new ApiError(400, "bad_name", "Pass ?name=<resident name>.");
    const rows = await all(db(), `SELECT p.id, p.home_id, p.name, p.kind, h.name AS home_name, h.box_pub
      FROM personas p JOIN homes h ON h.id = p.home_id WHERE p.name COLLATE utf8mb4_0900_ai_ci = ? LIMIT 20`, [name]);
    return c.json({
      residents: rows.filter((p) => !safety.isHidden("persona", p.id) && !safety.isHidden("home", p.home_id)).map((p) => ({
        home_id: p.home_id, home_name: p.home_name, persona_id: p.id, name: p.name, kind: p.kind, can_dm: !!p.box_pub,
      })),
    });
  });

  // -- direct messages --

  api.post("/dm", requireAuth, async (c) => {
    const me = homeOf(c);
    limit(`dm:h:${me}`, CHAT.dmsPerHour / 3600, CHAT.dmsPerHour);
    const b = await body(c);
    const to = homeParam(b.to_home, "bad_to_home");
    const enc = bodyEnc(b.body_enc);
    const msg = await tx(async (c2) => {
      const now = Date.now();
      await assertCanDm(c2, me, to);
      const fromPersona = await personaRef(c2, me, b.from_persona, "bad_from_persona");
      const toPersona = await personaRef(c2, to, b.to_persona, "bad_to_persona");
      const sent = await one(c2, "SELECT COUNT(*) AS n FROM dm_messages WHERE from_home = ? AND ts > ?", [me, now - 86400_000]);
      if (Number(sent!.n) >= CHAT.dmsPerDay) throw new ApiError(429, "too_many_dms", `At most ${CHAT.dmsPerDay} direct messages per day per home.`);
      const key = pairKey(me, to);
      const th = await one(c2, "SELECT pair_key FROM dm_threads WHERE pair_key = ? FOR UPDATE", [key]);
      if (!th) {
        const started = await one(c2, "SELECT COUNT(*) AS n FROM dm_threads WHERE started_by = ? AND started_at > ?", [me, now - 86400_000]);
        if (Number(started!.n) >= CHAT.newThreadsPerDay) {
          throw new ApiError(429, "too_many_conversations", `At most ${CHAT.newThreadsPerDay} new conversations per day per home.`);
        }
        const [a, z] = me < to ? [me, to] : [to, me];
        await run(c2, "INSERT INTO dm_threads (pair_key, a_home, b_home, started_by, started_at, last_ts) VALUES (?, ?, ?, ?, ?, ?)", [key, a, z, me, now, now]);
      }
      const att = await checkAttachments(c2, me, to, b.attachment_ids);
      const r = await run(c2, `INSERT INTO dm_messages (pair_key, from_home, to_home, from_persona, to_persona, body_enc, attachments, ts)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [key, me, to, fromPersona, toPersona, enc, att.join(","), now]);
      await run(c2, "UPDATE dm_threads SET last_id = ?, last_ts = ? WHERE pair_key = ?", [r.insertId, now, key]);
      await addContact(c2, me, to, now);
      await notifyChat(c2, to, "dm", me, String(r.insertId), now);
      return (await one(c2, "SELECT * FROM dm_messages WHERE id = ?", [r.insertId]))!;
    });
    return c.json({ message: dmOut(msg) }, 201);
  });

  api.get("/dm/threads", requireAuth, async (c) => {
    const me = homeOf(c);
    const rows = await all(db(), `SELECT t.*, h.name, h.box_pub FROM dm_threads t
      LEFT JOIN homes h ON h.id = IF(t.a_home = ?, t.b_home, t.a_home)
      WHERE t.a_home = ? OR t.b_home = ? ORDER BY t.last_ts DESC LIMIT 200`, [me, me, me]);
    const unread = await unreadDms(db(), me);
    const blocked = (await all(db(), "SELECT blocked_home FROM dm_blocks WHERE home_id = ? ORDER BY created_at", [me])).map((r) => r.blocked_home as string);
    return c.json({
      threads: rows.map((t) => {
        const other = t.a_home === me ? t.b_home : t.a_home;
        return {
          with: other, name: t.name == null ? null : safety.isHidden("home", other) ? safety.HIDDEN_NAME : t.name, box_pub: t.box_pub ?? null,
          started_by: t.started_by, started_at: Number(t.started_at), last_id: String(t.last_id), last_ts: Number(t.last_ts),
          unread: unread.by.get(other) ?? 0, blocked: blocked.includes(other),
        };
      }),
      unread_total: unread.total, dms: await dmsSettingOf(me), blocked,
    });
  });

  api.get("/dm", requireAuth, async (c) => {
    const me = homeOf(c);
    const w = c.req.query("with");
    if (w === undefined) throw new ApiError(400, "with_required", "Pass ?with=<home>: whose thread.");
    const other = homeParam(w, "bad_with");
    const key = pairKey(me, other);
    const after = cursorParam(c.req.query("after"));
    const lim = Math.min(Math.max(Number(c.req.query("limit")) || 200, 1), 500);
    const [rows, h, mine, theirs, blk] = await Promise.all([
      all(db(), "SELECT * FROM dm_messages WHERE pair_key = ? AND id > ? ORDER BY id LIMIT ?", [key, after, lim]),
      one(db(), "SELECT id, name, box_pub FROM homes WHERE id = ?", [other]),
      one(db(), "SELECT read_upto FROM dm_reads WHERE home_id = ? AND other_home = ?", [me, other]),
      one(db(), "SELECT read_upto FROM dm_reads WHERE home_id = ? AND other_home = ?", [other, me]),
      isBlocked(db(), other, me),
    ]);
    return c.json({
      with: other,
      home: h ? { id: h.id, name: safety.isHidden("home", h.id) ? safety.HIDDEN_NAME : h.name, box_pub: h.box_pub ?? null } : null,
      messages: rows.map(dmOut),
      read_upto: String(mine?.read_upto ?? 0), their_read_upto: String(theirs?.read_upto ?? 0), blocked: blk,
    });
  });

  api.post("/dm/read", requireAuth, async (c) => {
    const me = homeOf(c);
    const b = await body(c);
    const other = homeParam(b.with, "bad_with");
    const max = Number((await one(db(), "SELECT COALESCE(MAX(id), 0) AS m FROM dm_messages WHERE pair_key = ? AND to_home = ?", [pairKey(me, other), me]))!.m);
    const upto = b.upto === undefined || b.upto === null ? max
      : typeof b.upto === "number" || (typeof b.upto === "string" && DM_ID_RE.test(b.upto)) ? Math.min(Number(b.upto), max) : NaN;
    if (!Number.isSafeInteger(upto) || upto < 0) throw new ApiError(400, "bad_upto", "upto: a DM id (from GET /dm).");
    await run(db(), `INSERT INTO dm_reads (home_id, other_home, read_upto) VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE read_upto = GREATEST(read_upto, VALUES(read_upto))`, [me, other, upto]);
    const r = await one(db(), "SELECT read_upto FROM dm_reads WHERE home_id = ? AND other_home = ?", [me, other]);
    return c.json({ with: other, read_upto: String(r?.read_upto ?? 0), unread_total: (await unreadDms(db(), me)).total });
  });

  const blockList = async (me: string) =>
    (await all(db(), "SELECT blocked_home FROM dm_blocks WHERE home_id = ? ORDER BY created_at", [me])).map((r) => r.blocked_home as string);
  api.post("/dm/block", requireAuth, async (c) => {
    const me = homeOf(c);
    limit(`dmblock:${me}`, 60 / 3600, 60);
    const other = homeParam((await body(c)).home);
    if (other === me) throw new ApiError(400, "own_home", "That's your own home.");
    await run(db(), "INSERT IGNORE INTO dm_blocks (home_id, blocked_home, created_at) VALUES (?, ?, ?)", [me, other, Date.now()]);
    return c.json({ blocked: await blockList(me) });
  });
  api.post("/dm/unblock", requireAuth, async (c) => {
    const me = homeOf(c);
    const other = homeParam((await body(c)).home);
    await run(db(), "DELETE FROM dm_blocks WHERE home_id = ? AND blocked_home = ?", [me, other]);
    return c.json({ blocked: await blockList(me) });
  });

  // Raw body = client-side encrypted file (iv || ciphertext || tag), for ?to=<home>. Same storage as task files.
  api.post("/dm/files", requireAuth, async (c) => {
    const me = homeOf(c);
    limit(`dmfile:${me}`, 60 / 3600, 30);
    const to = homeParam(c.req.query("to"), "bad_to_home");
    const buf = Buffer.from(await c.req.arrayBuffer());
    if (buf.length < FILE_MIN) throw new ApiError(400, "bad_file", "Body: the encrypted file bytes (iv || ciphertext || tag).");
    if (buf.length > CHAT.fileMax) throw new ApiError(413, "too_large", `Files are at most ${CHAT.fileMax} bytes (encrypted).`);
    await assertCanDm(db(), me, to);
    const now = Date.now();
    const used = Number((await one(db(), "SELECT COALESCE(SUM(size), 0) AS n FROM dm_files WHERE uploader_home = ? AND created_at > ?", [me, now - 86400_000]))!.n);
    if (used + buf.length > CHAT.fileBytesPerDay) throw new ApiError(429, "too_many_files", "Daily upload limit for direct-message files reached.");
    const id = newId("df", 16);
    const sha = createHash("sha256").update(buf).digest("hex");
    mkdirSync(DM_DIR(), { recursive: true, mode: 0o700 });
    writeFileSync(join(DM_DIR(), id), buf, { mode: 0o600 });
    try {
      await run(db(), "INSERT INTO dm_files (id, pair_key, uploader_home, to_home, size, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [id, pairKey(me, to), me, to, buf.length, sha, now]);
    } catch (e) { rmSync(join(DM_DIR(), id), { force: true }); throw e; }
    return c.json({ file_id: id, size: buf.length, sha256: sha, to_home: to }, 201);
  });

  api.get("/dm/files/:id", requireAuth, async (c) => {
    const me = homeOf(c);
    const id = c.req.param("id") ?? "";
    const f = DM_FILE_RE.test(id) ? await one(db(), "SELECT * FROM dm_files WHERE id = ?", [id]) : undefined;
    if (!f) throw new ApiError(404, "not_found", "No such file (DM files are kept 30 days).");
    if (me !== f.uploader_home && me !== f.to_home) throw new ApiError(403, "not_a_party", "Only the two homes of the conversation can download this file.");
    const p = join(DM_DIR(), f.id);
    if (!existsSync(p)) throw new ApiError(410, "file_gone", "This file is no longer stored.");
    return c.body(readFileSync(p), 200, {
      "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${f.id}.bin"`,
      "cache-control": "private, no-store", "x-content-sha256": f.sha256,
    });
  });

  // -- admin: DM volume per home (content is E2E; admins act on metadata: ban via /admin/ban) --
  api.get("/admin/dms", safety.requireAdmin, async (c) => {
    const now = Date.now();
    const rows = await all(db(), `SELECT m.from_home AS home_id, h.name, COUNT(*) AS sent_total,
        SUM(m.ts > ?) AS sent_24h, COUNT(DISTINCT m.to_home) AS recipients,
        (SELECT COUNT(*) FROM dm_threads t WHERE t.started_by = m.from_home AND t.started_at > ?) AS started_24h,
        (SELECT COUNT(*) FROM dm_blocks b WHERE b.blocked_home = m.from_home) AS blocked_by
      FROM dm_messages m LEFT JOIN homes h ON h.id = m.from_home
      GROUP BY m.from_home, h.name ORDER BY sent_24h DESC, sent_total DESC LIMIT 100`, [now - 86400_000, now - 86400_000]);
    return c.json({
      senders: rows.map((r) => ({
        home_id: r.home_id, name: r.name ?? null, sent_24h: Number(r.sent_24h), sent_total: Number(r.sent_total),
        recipients: Number(r.recipients), started_24h: Number(r.started_24h), blocked_by: Number(r.blocked_by),
      })),
    });
  });
}
