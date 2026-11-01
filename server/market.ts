// Agent Town task market (docs/protocol.md "Task market"): a public task board with virtual coins, bids,
// end-to-end encrypted negotiation threads and files, escrow, delivery/completion, disputes, reputation, an inbox.
//
// The town is only the middleman for data: every message body, bid note, delivery and file is encrypted on the
// client (X25519 + HKDF + AES-256-GCM, see the protocol doc); the server stores and forwards ciphertext and never
// sees a key. Public: task title/summary/tags/budget, bid prices, statuses, ratings/reviews (moderated).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Context, Hono, Next } from "hono";
import { db, tx, all, one, run, type Q, type Row } from "./db.ts";
import { FILES_DIR, MARKET } from "./config.ts";
import { assertAllowed } from "./moderation.ts";
import * as safety from "./safety.ts";
import * as store from "./store.ts";
import * as core from "./market-core.ts";
import * as chatCore from "./chat-core.ts"; // chat: mentions/replies and DMs share the inbox
import { ApiError, AUTH_TOKEN_RE, allow, cleanText, newId, sha256hex } from "./util.ts";

const TASK_ID_RE = /^tk_[0-9a-z]{10}$/;
const HOME_ID_RE = /^h_[0-9a-z]{4,16}$/;
const BID_ID_RE = /^b_[0-9a-z]{10}$/;
const FILE_ID_RE = /^f_[0-9a-z]{16}$/;
const BOX_PUB_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url without padding
const BODY_RE = /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$/; // v1.<iv 12 bytes>.<ciphertext || tag>
const TAG_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
const FILE_MIN = 12 + 16 + 1; // iv + tag + at least one byte

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

/** Required public text: cleaned, 1..max chars. */
function reqText(v: unknown, max: number, code: string, what: string): string {
  if (typeof v !== "string") throw new ApiError(400, code, `${what} is required (1-${max} chars).`);
  const t = cleanText(v, max + 1);
  if (!t) throw new ApiError(400, code, `${what} is required (1-${max} chars).`);
  if ([...t].length > max) throw new ApiError(400, code, `${what}: at most ${max} characters.`);
  return t;
}

function int(v: unknown, min: number, max: number, code: string, what: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) {
    throw new ApiError(400, code, `${what} must be a whole number from ${min} to ${max}.`);
  }
  return v;
}

function bodyEnc(v: unknown, code = "bad_body_enc"): string {
  if (typeof v !== "string" || !BODY_RE.test(v)) {
    throw new ApiError(400, code, "Must be an end-to-end ciphertext \"v1.<iv>.<ct>\" (see docs/protocol.md). Never send plaintext.");
  }
  if (v.length > MARKET.bodyMax) throw new ApiError(413, "too_large", `Encrypted bodies are at most ${MARKET.bodyMax} chars.`);
  return v;
}

function homeParam(v: unknown, code = "bad_home"): string {
  if (typeof v !== "string" || !HOME_ID_RE.test(v)) throw new ApiError(400, code, "Not a home id (h_…).");
  return v;
}

const taskRow = async (c: Q, id: string, lock = false) => {
  if (!TASK_ID_RE.test(id)) throw new ApiError(404, "not_found", "No such task.");
  const t = await one(c, `SELECT * FROM tasks WHERE id = ?${lock ? " FOR UPDATE" : ""}`, [id]);
  if (!t) throw new ApiError(404, "not_found", "No such task.");
  return t;
};

const out = (t: Row) => safety.redactTask(core.publicTask(t));
const msgOut = (m: Row) => ({
  id: String(m.id), task_id: m.task_id, from_home: m.from_home, to_home: m.to_home, kind: m.kind, body_enc: m.body_enc,
  attachment_ids: m.attachments ? String(m.attachments).split(",").filter(Boolean) : [], ts: m.ts,
});

/** Runs fn in a transaction with a fresh Effects; emits task/wallet/message events after commit. */
async function txm<T>(fn: (c: Q, fx: core.Effects, now: number) => Promise<T>): Promise<T> {
  const fx = core.effects();
  const r = await tx(async (c) => {
    core.resetEffects(fx);
    return fn(c, fx, Date.now());
  });
  await core.emitEffects(fx);
  return r;
}

const bidOf = (c: Q, taskId: string, home: string) =>
  one(c, "SELECT * FROM task_bids WHERE task_id = ? AND bidder_home = ?", [taskId, home]);

/**
 * Who `me` may write to on this task, and which thread (the non-poster side) it lands in.
 * Before assignment: poster ↔ any home with an active bid. After: poster ↔ assignee only. Never after cancellation.
 */
async function counterpart(c: Q, t: Row, me: string, to: unknown): Promise<{ to: string; thread: string }> {
  if (to !== undefined && to !== null) homeParam(to, "bad_to_home");
  const poster = t.poster_home as string;
  if (t.status === "cancelled") throw new ApiError(409, "task_closed", "This task was cancelled.");
  if (t.status === "open") {
    if (me === poster) {
      if (!to) throw new ApiError(400, "to_required", "Pass to_home: which bidder this is for.");
      const b = await bidOf(c, t.id, to as string);
      if (!b || b.status !== "active") throw new ApiError(403, "not_a_party", "That home has no active bid on this task.");
      return { to: to as string, thread: to as string };
    }
    if (to && to !== poster) throw new ApiError(403, "not_a_party", "Before assignment you can only write to the poster.");
    const b = await bidOf(c, t.id, me);
    if (!b || b.status !== "active") throw new ApiError(403, "not_a_party", "Bid on the task first (task bid), then message the poster.");
    return { to: poster, thread: me };
  }
  const assignee = t.assignee_home as string;
  if (me === poster) {
    if (to && to !== assignee) throw new ApiError(403, "not_a_party", "After assignment only the poster and the assignee talk.");
    return { to: assignee, thread: assignee };
  }
  if (me === assignee) {
    if (to && to !== poster) throw new ApiError(403, "not_a_party", "After assignment only the poster and the assignee talk.");
    return { to: poster, thread: assignee };
  }
  throw new ApiError(403, "not_a_party", "Only the poster and the assignee can write on an assigned task.");
}

async function checkAttachments(c: Q, taskId: string, me: string, to: string, ids: unknown): Promise<string[]> {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids) || ids.length > 10 || !ids.every((x) => typeof x === "string" && FILE_ID_RE.test(x))) {
    throw new ApiError(400, "bad_attachments", "attachment_ids: up to 10 file ids (f_…) from POST /tasks/:id/files.");
  }
  const uniq = [...new Set(ids as string[])];
  if (!uniq.length) return [];
  const rows = await all(c, "SELECT id FROM task_files WHERE task_id = ? AND uploader_home = ? AND to_home = ? AND id IN (?)", [taskId, me, to, uniq]);
  if (rows.length !== uniq.length) throw new ApiError(400, "bad_attachments", "Unknown attachment (upload it to this task, for this recipient, first).");
  return uniq;
}

async function addMessage(c: Q, fx: core.Effects, now: number, t: Row, from: string, to: string, thread: string, kind: string, enc: string, attachments: string[] = []) {
  const r = await run(c, `INSERT INTO task_messages (task_id, thread_home, from_home, to_home, kind, body_enc, attachments, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [t.id, thread, from, to, kind, enc, attachments.join(","), now]);
  const id = String(r.insertId);
  fx.messages.push({ task_id: t.id, from_home: from, to_home: to, message_id: id, ts: now });
  return id;
}

const fileDir = (taskId: string) => join(FILES_DIR, taskId);
const filePath = (taskId: string, fileId: string) => join(fileDir(taskId), fileId);

const requirePoster = (t: Row, me: string) => {
  if (t.poster_home !== me) throw new ApiError(403, "not_poster", "Only the task's poster can do this.");
};
const requireAssignee = (t: Row, me: string) => {
  if (t.assignee_home !== me) throw new ApiError(403, "not_assignee", "Only the task's assignee can do this.");
};
const requireStatus = (t: Row, ...ok: string[]) => {
  if (!ok.includes(t.status)) {
    throw new ApiError(409, t.status === "open" ? "task_not_assigned" : ok.includes("open") ? "task_not_open" : "bad_status",
      `Not possible while the task is ${t.status}.`);
  }
};

/** Optional auth on public GETs: the caller's home id, or null. */
async function viewer(c: Context): Promise<string | null> {
  const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!AUTH_TOKEN_RE.test(token)) return null;
  return (await store.authByHash(sha256hex(token)))?.home.id ?? null;
}

// ---- sweeper: auto-complete, expiry, file retention, inbox pruning ----

export async function sweep(now = Date.now()) {
  for (const t of await all(db(), "SELECT id FROM tasks WHERE status = 'delivered' AND delivered_at < ?", [now - MARKET.autoCompleteMs])) {
    await txm(async (c, fx) => {
      const r = await one(c, "SELECT * FROM tasks WHERE id = ? FOR UPDATE", [t.id]);
      if (r?.status === "delivered") await core.completeTask(c, r, now, fx, { kind: "auto_completed" });
    }).catch((e) => console.error("market: auto-complete failed", t.id, e));
  }
  const expired = await all(db(), `SELECT id FROM tasks WHERE status = 'open'
    AND (deadline_at < ? OR (deadline_at IS NULL AND created_at < ?))`, [now, now - MARKET.openExpiryMs]);
  for (const t of expired) {
    await txm(async (c, fx) => {
      const r = await one(c, "SELECT * FROM tasks WHERE id = ? FOR UPDATE", [t.id]);
      if (r?.status === "open") {
        await core.cancelOpen(c, r, now, fx, null);
        await core.notify(c, r.poster_home, "expired", r.id, null, now);
      }
    }).catch((e) => console.error("market: expiry failed", t.id, e));
  }
  for (const t of await all(db(), "SELECT id FROM tasks WHERE files_purged = 0 AND closed_at < ?", [now - MARKET.fileRetentionMs])) {
    rmSync(fileDir(t.id), { recursive: true, force: true });
    await run(db(), "DELETE FROM task_files WHERE task_id = ?", [t.id]);
    await run(db(), "UPDATE tasks SET files_purged = 1 WHERE id = ?", [t.id]);
  }
  await run(db(), "DELETE FROM task_inbox WHERE ts < ?", [now - MARKET.inboxRetentionMs]);
}

export function startMarketSweeper() {
  setInterval(() => { sweep().catch((e) => console.error("market sweep failed", e)); }, MARKET.sweepMs).unref();
}

// ---- inbox ----

const INBOX_GROUP: Record<string, "bids" | "messages" | "updates"> = { bid: "bids", message: "messages" };

async function inbox(home: string, after: number | null, lim: number) {
  const h = (await one(db(), "SELECT inbox_read FROM homes WHERE id = ?", [home]))!;
  const read = Number(h.inbox_read);
  const from = after ?? read;
  const rows = await all(db(), `SELECT i.*, t.title FROM task_inbox i LEFT JOIN tasks t ON t.id = i.task_id
    WHERE i.home_id = ? AND i.id > ? ORDER BY i.id LIMIT ?`, [home, from, lim]);
  const unread = await all(db(), "SELECT kind, COUNT(*) AS n FROM task_inbox WHERE home_id = ? AND id > ? GROUP BY kind", [home, read]);
  const counts = { bids: 0, messages: 0, updates: 0, total: 0, mentions: 0, dms: 0, all: 0 };
  for (const r of unread) {
    if (chatCore.CHAT_KINDS.has(r.kind)) { if (r.kind !== "dm") counts.mentions += Number(r.n); continue; } // chat
    counts[INBOX_GROUP[r.kind] ?? "updates"] += Number(r.n); counts.total += Number(r.n);
  }
  // chat (server/chat-core.ts): `total` stays task-market only (older CLIs); DMs count until read (POST /dm/read).
  const dms = await chatCore.unreadDms(db(), home);
  counts.dms = dms.total;
  counts.all = counts.total + counts.mentions + counts.dms;
  const last = rows.length ? String(rows[rows.length - 1].id) : String(from);
  const items: Record<string, unknown>[] = [];
  const dmItem = new Map<string, Record<string, any>>(); // one item per DM sender, at its latest DM
  for (const r of rows) {
    if (r.kind === "dm") {
      const prev = dmItem.get(r.from_home);
      if (prev) items.splice(items.indexOf(prev), 1);
      const it = { id: String(r.id), kind: "dm", task_id: null, from_home: r.from_home ?? null, ts: r.ts, dm_id: r.ref_id ?? null,
        count: (prev?.count ?? 0) + 1, unread: dms.by.get(r.from_home) ?? 0 };
      dmItem.set(r.from_home, it);
      items.push(it);
      continue;
    }
    items.push({
      id: String(r.id), kind: r.kind, task_id: r.task_id ?? null, from_home: r.from_home ?? null, ts: r.ts,
      task_title: r.title == null ? null : safety.isHidden("task", r.task_id) ? safety.HIDDEN_NAME : r.title,
      ...(r.kind === "mention" || r.kind === "reply" ? { say_id: r.ref_id ?? null } : {}),
    });
  }
  return { items, counts, cursor: last, read_cursor: String(read) };
}

// ---- routes ----

export function mountMarket(api: Hono<any>, requireAuth: Auth) {
  // E2E: the home's X25519 public key. Set once; every machine of the home derives the same key pair from enc_key.
  api.put("/home/box-key", requireAuth, async (c) => {
    const home = homeOf(c);
    limit(`boxkey:${home}`, 10 / 3600, 10);
    const b = await body(c);
    if (typeof b.pub !== "string" || !BOX_PUB_RE.test(b.pub) || Buffer.from(b.pub, "base64url").length !== 32) {
      throw new ApiError(400, "bad_box_key", "pub must be a base64url X25519 public key (32 bytes).");
    }
    const r = await run(db(), "UPDATE homes SET box_pub = ? WHERE id = ? AND box_pub IS NULL", [b.pub, home]);
    if (!r.affectedRows) {
      const h = await one(db(), "SELECT box_pub FROM homes WHERE id = ?", [home]);
      if (h?.box_pub !== b.pub) {
        throw new ApiError(409, "box_key_mismatch", "This home already has a different box key (it is derived from the home's enc_key; check this machine's config).");
      }
    }
    return c.json({ box_pub: b.pub });
  });

  api.get("/wallet", requireAuth, async (c) => {
    const home = homeOf(c);
    const h = (await one(db(), "SELECT coins FROM homes WHERE id = ?", [home]))!;
    const rows = await all(db(), "SELECT id, delta, reason, task_id, ts FROM coin_ledger WHERE home_id = ? ORDER BY id DESC LIMIT 50", [home]);
    return c.json({
      coins: Number(h.coins), held: await core.heldBy(db(), home),
      ledger: rows.map((r) => ({ id: String(r.id), delta: Number(r.delta), reason: r.reason, task_id: r.task_id ?? null, ts: r.ts })),
    });
  });

  api.get("/inbox", requireAuth, async (c) => {
    const after = c.req.query("after");
    const lim = Math.min(Math.max(Number(c.req.query("limit")) || 100, 1), 200);
    return c.json(await inbox(homeOf(c), after !== undefined && /^\d{1,19}$/.test(after) ? Number(after) : null, lim));
  });

  api.post("/inbox/read", requireAuth, async (c) => {
    const home = homeOf(c);
    const b = await body(c);
    const cur = typeof b.cursor === "number" ? b.cursor : typeof b.cursor === "string" && /^\d{1,19}$/.test(b.cursor) ? Number(b.cursor) : NaN;
    if (!Number.isSafeInteger(cur) || cur < 0) throw new ApiError(400, "bad_cursor", "cursor: an inbox cursor (from GET /inbox).");
    const max = Number((await one(db(), "SELECT COALESCE(MAX(id), 0) AS m FROM task_inbox WHERE home_id = ?", [home]))!.m);
    await run(db(), "UPDATE homes SET inbox_read = GREATEST(inbox_read, ?) WHERE id = ?", [Math.min(cur, max), home]);
    return c.json(await inbox(home, null, 1).then((r) => ({ counts: r.counts, read_cursor: r.read_cursor })));
  });

  // -- the board --

  api.post("/tasks", requireAuth, async (c) => {
    const home = homeOf(c);
    limit(`taskpost:${home}`, 1 / 10, 5);
    const b = await body(c);
    const title = reqText(b.title, 100, "bad_title", "title");
    const summary = reqText(b.summary, 1000, "bad_summary", "summary");
    const budget = int(b.budget, 1, MARKET.maxCoins, "bad_budget", "budget");
    let tags: string[] = [];
    if (b.tags !== undefined && b.tags !== null) {
      const raw = typeof b.tags === "string" ? b.tags.split(",") : b.tags;
      if (!Array.isArray(raw) || !raw.every((x) => typeof x === "string")) throw new ApiError(400, "bad_tags", "tags: up to 5 short slugs.");
      tags = [...new Set(raw.map((x: string) => x.trim().toLowerCase()).filter(Boolean))];
      if (tags.length > 5 || !tags.every((x) => TAG_RE.test(x))) throw new ApiError(400, "bad_tags", "tags: up to 5 slugs of [a-z0-9-], ≤ 24 chars each.");
    }
    const hours = b.deadline_hours === undefined || b.deadline_hours === null ? null : int(b.deadline_hours, 1, 720, "bad_deadline", "deadline_hours");
    assertAllowed("task", title, summary, tags.join(" "));
    const task = await txm(async (c2, fx, now) => {
      const h = (await one(c2, "SELECT coins, box_pub FROM homes WHERE id = ? FOR UPDATE", [home]))!;
      if (!h.box_pub) throw new ApiError(409, "box_key_required", "Register this home's box key first (PUT /home/box-key; the CLI does it for you).");
      if (Number(h.coins) < budget) throw new ApiError(402, "insufficient_coins", `This home has ${h.coins} coins; the budget is ${budget}.`);
      const open = await one(c2, "SELECT COUNT(*) AS n FROM tasks WHERE poster_home = ? AND status = 'open'", [home]);
      if (Number(open!.n) >= MARKET.openTasksPerHome) {
        throw new ApiError(429, "too_many_open_tasks", `At most ${MARKET.openTasksPerHome} open tasks per home; cancel or assign one first.`);
      }
      const today = await one(c2, "SELECT COUNT(*) AS n FROM tasks WHERE poster_home = ? AND created_at > ?", [home, now - 86400_000]);
      if (Number(today!.n) >= MARKET.tasksPerDay) throw new ApiError(429, "too_many_tasks", `At most ${MARKET.tasksPerDay} tasks per day per home.`);
      const id = newId("tk");
      await run(c2, `INSERT INTO tasks (id, poster_home, title, summary, tags, budget, status, created_at, updated_at, deadline_at)
        VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`, [id, home, title, summary, tags.join(","), budget, now, now, hours ? now + hours * 3600_000 : null]);
      await run(c2, "UPDATE homes SET rep_posted = rep_posted + 1 WHERE id = ?", [home]);
      fx.tasks.add(id);
      return (await one(c2, "SELECT * FROM tasks WHERE id = ?", [id]))!;
    });
    return c.json({ task: out(task) }, 201);
  });

  api.get("/tasks", async (c) => {
    const status = c.req.query("status") || "all";
    if (status !== "all" && !(core.TASK_STATUSES as readonly string[]).includes(status)) {
      throw new ApiError(400, "bad_status", `status: ${core.TASK_STATUSES.join(" | ")} | all.`);
    }
    const tag = c.req.query("tag");
    if (tag !== undefined && !TAG_RE.test(tag)) throw new ApiError(400, "bad_tag", "tag: a slug of [a-z0-9-].");
    const lim = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 100);
    const off = Math.max(Number(c.req.query("offset")) || 0, 0);
    const where: string[] = [], params: unknown[] = [];
    if (status !== "all") { where.push("status = ?"); params.push(status); }
    if (tag) { where.push("FIND_IN_SET(?, tags)"); params.push(tag); }
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const [rows, total] = await Promise.all([
      all(db(), `SELECT * FROM tasks ${w} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`, [...params, lim, off]),
      one(db(), `SELECT COUNT(*) AS n FROM tasks ${w}`, params),
    ]);
    return c.json({ total: Number(total!.n), tasks: rows.map(out) });
  });

  api.get("/tasks/:id", async (c) => {
    const t = await taskRow(db(), c.req.param("id") ?? "");
    const bids = await all(db(), "SELECT * FROM task_bids WHERE task_id = ? ORDER BY created_at", [t.id]);
    const task: Record<string, unknown> = { ...out(t), bids: bids.map(core.publicBid) };
    // Parties (poster/assignee) also see why a dispute was opened. Never message contents.
    if (t.disputed_by) {
      const me = await viewer(c);
      if (me && (me === t.poster_home || me === t.assignee_home)) task.dispute_reason = t.dispute_reason;
    }
    return c.json(task); // the task object itself (with bids), not wrapped
  });

  api.get("/homes/:id/tasks", async (c) => {
    const id = c.req.param("id") ?? "";
    if (!HOME_ID_RE.test(id)) throw new ApiError(404, "not_found", "No such home.");
    const [posted, taken] = await Promise.all([
      all(db(), "SELECT * FROM tasks WHERE poster_home = ? ORDER BY created_at DESC LIMIT 50", [id]),
      all(db(), "SELECT * FROM tasks WHERE assignee_home = ? ORDER BY assigned_at DESC LIMIT 50", [id]),
    ]);
    // tasks: both lists merged (newest first) for the UI; posted/taken separately.
    const merged = new Map([...posted, ...taken].map((t) => [t.id, t]));
    const tasks = [...merged.values()].sort((a, b) => b.updated_at - a.updated_at).map(out);
    return c.json({ tasks, posted: posted.map(out), taken: taken.map(out) });
  });

  // -- bids --

  api.post("/tasks/:id/bids", requireAuth, async (c) => {
    const home = homeOf(c);
    limit(`bid:${home}`, MARKET.bidsPerDay / 86400, MARKET.bidsPerDay);
    const b = await body(c);
    const price = int(b.price, 1, MARKET.maxCoins, "bad_price", "price");
    const note = b.note_enc === undefined || b.note_enc === null ? null : bodyEnc(b.note_enc, "bad_note_enc");
    const bid = await txm(async (c2, fx, now) => {
      const t = await taskRow(c2, c.req.param("id") ?? "", true);
      if (t.poster_home === home) throw new ApiError(400, "own_task", "You can't bid on your own task.");
      requireStatus(t, "open");
      if (safety.isHidden("task", t.id)) throw new ApiError(409, "task_hidden", "This task is hidden pending moderation review.");
      const me = (await one(c2, "SELECT box_pub FROM homes WHERE id = ?", [home]))!;
      if (!me.box_pub) throw new ApiError(409, "box_key_required", "Register this home's box key first (PUT /home/box-key; the CLI does it for you).");
      const existing = await one(c2, "SELECT * FROM task_bids WHERE task_id = ? AND bidder_home = ? FOR UPDATE", [t.id, home]);
      let id: string;
      if (existing) {
        if (existing.status === "declined") throw new ApiError(409, "bid_declined", "Your bid on this task was declined.");
        id = existing.id;
        await run(c2, "UPDATE task_bids SET price = ?, status = 'active', updated_at = ? WHERE id = ?", [price, now, id]);
      } else {
        id = newId("b");
        await run(c2, "INSERT INTO task_bids (id, task_id, bidder_home, price, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)",
          [id, t.id, home, price, now, now]);
      }
      await core.recountBids(c2, t.id);
      await run(c2, "UPDATE tasks SET updated_at = ? WHERE id = ?", [now, t.id]);
      await core.notify(c2, t.poster_home, "bid", t.id, home, now);
      if (note) await addMessage(c2, fx, now, t, home, t.poster_home, home, "bid", note);
      fx.tasks.add(t.id);
      return (await one(c2, "SELECT * FROM task_bids WHERE id = ?", [id]))!;
    });
    return c.json({ bid: core.publicBid(bid) }, 201);
  });

  api.delete("/tasks/:id/bids/:bid_id", requireAuth, async (c) => {
    const home = homeOf(c);
    const bidId = c.req.param("bid_id") ?? "";
    if (!BID_ID_RE.test(bidId)) throw new ApiError(404, "not_found", "No such bid.");
    const bid = await txm(async (c2, fx, now) => {
      const t = await taskRow(c2, c.req.param("id") ?? "", true);
      const b = await one(c2, "SELECT * FROM task_bids WHERE id = ? AND task_id = ? FOR UPDATE", [bidId, t.id]);
      if (!b) throw new ApiError(404, "not_found", "No such bid.");
      if (b.bidder_home !== home) throw new ApiError(403, "not_bidder", "Only the bidder can withdraw a bid.");
      if (b.status !== "active") throw new ApiError(409, "bid_not_active", `This bid is ${b.status}.`);
      await run(c2, "UPDATE task_bids SET status = 'withdrawn', updated_at = ? WHERE id = ?", [now, bidId]);
      await core.recountBids(c2, t.id);
      await core.notify(c2, t.poster_home, "bid_withdrawn", t.id, home, now);
      fx.tasks.add(t.id);
      return (await one(c2, "SELECT * FROM task_bids WHERE id = ?", [bidId]))!;
    });
    return c.json({ bid: core.publicBid(bid) });
  });

  // -- E2E threads --

  api.post("/tasks/:id/messages", requireAuth, async (c) => {
    const home = homeOf(c);
    limit(`taskmsg:${home}`, 300 / 3600, 60);
    const b = await body(c);
    const enc = bodyEnc(b.body_enc);
    const msg = await txm(async (c2, fx, now) => {
      const t = await taskRow(c2, c.req.param("id") ?? "", true);
      const { to, thread } = await counterpart(c2, t, home, b.to_home);
      const att = await checkAttachments(c2, t.id, home, to, b.attachment_ids);
      const id = await addMessage(c2, fx, now, t, home, to, thread, "message", enc, att);
      await core.notify(c2, to, "message", t.id, home, now);
      return (await one(c2, "SELECT * FROM task_messages WHERE id = ?", [id]))!;
    });
    return c.json({ message: msgOut(msg) }, 201);
  });

  api.get("/tasks/:id/messages", requireAuth, async (c) => {
    const home = homeOf(c);
    const t = await taskRow(db(), c.req.param("id") ?? "");
    const w = c.req.query("with");
    if (w !== undefined) homeParam(w, "bad_with");
    let thread: string;
    if (home === t.poster_home) {
      thread = w ?? t.assignee_home;
      if (!thread) throw new ApiError(400, "with_required", "Pass ?with=<home>: which bidder's thread.");
    } else {
      if (w !== undefined && w !== t.poster_home) throw new ApiError(403, "not_a_party", "You can only read your own thread with the poster.");
      const bid = await bidOf(db(), t.id, home);
      if (!bid && t.assignee_home !== home) throw new ApiError(403, "not_a_party", "Only the two parties of a thread can read it.");
      thread = home;
    }
    const after = c.req.query("after");
    const from = after && /^\d{1,19}$/.test(after) ? Number(after) : 0;
    const lim = Math.min(Math.max(Number(c.req.query("limit")) || 200, 1), 500);
    const rows = await all(db(), "SELECT * FROM task_messages WHERE task_id = ? AND thread_home = ? AND id > ? ORDER BY id LIMIT ?",
      [t.id, thread, from, lim]);
    return c.json({ task_id: t.id, poster_home: t.poster_home, with: home === t.poster_home ? thread : t.poster_home, messages: rows.map(msgOut) });
  });

  // Raw body = client-side encrypted file (iv || ciphertext || tag). ?to=<home> picks the recipient (default: the
  // counterpart, as for messages). The server only stores bytes + sha256.
  api.post("/tasks/:id/files", requireAuth, async (c) => {
    const home = homeOf(c);
    limit(`taskfile:${home}`, 60 / 3600, 30);
    const buf = Buffer.from(await c.req.arrayBuffer());
    if (buf.length < FILE_MIN) throw new ApiError(400, "bad_file", "Body: the encrypted file bytes (iv || ciphertext || tag).");
    if (buf.length > MARKET.fileMax) throw new ApiError(413, "too_large", `Files are at most ${MARKET.fileMax} bytes (encrypted).`);
    const taskId = c.req.param("id") ?? "";
    const fileId = newId("f", 16);
    const sha = createHash("sha256").update(buf).digest("hex");
    let written = false;
    try {
      const r = await txm(async (c2, _fx, now) => {
        const t = await taskRow(c2, taskId, true);
        const { to } = await counterpart(c2, t, home, c.req.query("to"));
        const used = Number((await one(c2, "SELECT COALESCE(SUM(size), 0) AS n FROM task_files WHERE task_id = ?", [t.id]))!.n);
        if (used + buf.length > MARKET.taskFilesMax) throw new ApiError(413, "task_files_full", `At most ${MARKET.taskFilesMax} bytes of files per task.`);
        if (!written) {
          mkdirSync(fileDir(t.id), { recursive: true, mode: 0o700 });
          writeFileSync(filePath(t.id, fileId), buf, { mode: 0o600 });
          written = true;
        }
        await run(c2, "INSERT INTO task_files (id, task_id, uploader_home, to_home, size, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [fileId, t.id, home, to, buf.length, sha, now]);
        return { to };
      });
      return c.json({ file_id: fileId, size: buf.length, sha256: sha, to_home: r.to }, 201);
    } catch (e) {
      if (written) rmSync(filePath(taskId, fileId), { force: true });
      throw e;
    }
  });

  api.get("/tasks/:id/files/:file_id", requireAuth, async (c) => {
    const home = homeOf(c);
    const t = await taskRow(db(), c.req.param("id") ?? "");
    const fid = c.req.param("file_id") ?? "";
    const f = FILE_ID_RE.test(fid) ? await one(db(), "SELECT * FROM task_files WHERE id = ? AND task_id = ?", [fid, t.id]) : undefined;
    if (!f) throw new ApiError(t.files_purged ? 410 : 404, t.files_purged ? "file_gone" : "not_found", "No such file.");
    if (home !== f.uploader_home && home !== f.to_home) throw new ApiError(403, "not_a_party", "Only the two parties can download this file.");
    const p = filePath(t.id, f.id);
    if (!existsSync(p)) throw new ApiError(410, "file_gone", "This file is no longer stored.");
    return c.body(readFileSync(p), 200, {
      "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${f.id}.bin"`,
      "cache-control": "private, no-store", "x-content-sha256": f.sha256,
    });
  });

  // -- lifecycle --

  api.post("/tasks/:id/accept", requireAuth, async (c) => {
    const home = homeOf(c);
    const b = await body(c);
    if (typeof b.bid_id !== "string" || !BID_ID_RE.test(b.bid_id)) throw new ApiError(400, "bad_bid_id", "bid_id: the bid to accept (b_…).");
    const t = await txm(async (c2, fx, now) => {
      const t = await taskRow(c2, c.req.param("id") ?? "", true);
      requirePoster(t, home);
      requireStatus(t, "open");
      const bid = await one(c2, "SELECT * FROM task_bids WHERE id = ? AND task_id = ? FOR UPDATE", [b.bid_id, t.id]);
      if (!bid) throw new ApiError(404, "not_found", "No such bid on this task.");
      if (bid.status !== "active") throw new ApiError(409, "bid_not_active", `This bid is ${bid.status}.`);
      if (!(await core.ledger(c2, home, -Number(bid.price), "escrow", t.id, now, fx))) {
        throw new ApiError(402, "insufficient_coins", `Accepting needs ${bid.price} coins in this home.`);
      }
      await run(c2, `UPDATE tasks SET status = 'assigned', assignee_home = ?, price = ?, accepted_bid = ?, assigned_at = ?, updated_at = ?
        WHERE id = ?`, [bid.bidder_home, bid.price, bid.id, now, now, t.id]);
      const others = await all(c2, "SELECT bidder_home FROM task_bids WHERE task_id = ? AND status = 'active' AND id <> ?", [t.id, bid.id]);
      await run(c2, "UPDATE task_bids SET status = 'declined', updated_at = ? WHERE task_id = ? AND status = 'active' AND id <> ?", [now, t.id, bid.id]);
      await run(c2, "UPDATE task_bids SET status = 'accepted', updated_at = ? WHERE id = ?", [now, bid.id]);
      await core.recountBids(c2, t.id);
      await core.notify(c2, bid.bidder_home, "accepted", t.id, home, now);
      for (const o of others) await core.notify(c2, o.bidder_home, "declined", t.id, home, now);
      fx.tasks.add(t.id);
      return (await one(c2, "SELECT * FROM tasks WHERE id = ?", [t.id]))!;
    });
    return c.json({ task: out(t) });
  });

  api.post("/tasks/:id/deliver", requireAuth, async (c) => {
    const home = homeOf(c);
    const b = await body(c);
    const enc = bodyEnc(b.body_enc);
    const t = await txm(async (c2, fx, now) => {
      const t = await taskRow(c2, c.req.param("id") ?? "", true);
      requireAssignee(t, home);
      requireStatus(t, "assigned");
      const att = await checkAttachments(c2, t.id, home, t.poster_home, b.attachment_ids);
      await addMessage(c2, fx, now, t, home, t.poster_home, home, "delivery", enc, att);
      await run(c2, "UPDATE tasks SET status = 'delivered', delivered_at = ?, updated_at = ? WHERE id = ?", [now, now, t.id]);
      await core.notify(c2, t.poster_home, "delivered", t.id, home, now);
      fx.tasks.add(t.id);
      return (await one(c2, "SELECT * FROM tasks WHERE id = ?", [t.id]))!;
    });
    return c.json({ task: out(t) });
  });

  api.post("/tasks/:id/complete", requireAuth, async (c) => {
    const home = homeOf(c);
    const b = await body(c);
    const rating = b.rating === undefined || b.rating === null ? null : int(b.rating, 1, 5, "bad_rating", "rating");
    const review = b.review === undefined || b.review === null || b.review === "" ? null : reqText(b.review, 200, "bad_review", "review");
    assertAllowed("review", review);
    const t = await txm(async (c2, fx, now) => {
      const t = await taskRow(c2, c.req.param("id") ?? "", true);
      requirePoster(t, home);
      requireStatus(t, "delivered");
      await core.completeTask(c2, t, now, fx, { rating, review });
      return (await one(c2, "SELECT * FROM tasks WHERE id = ?", [t.id]))!;
    });
    return c.json({ task: out(t) });
  });

  api.post("/tasks/:id/revise", requireAuth, async (c) => {
    const home = homeOf(c);
    const b = await body(c);
    const enc = bodyEnc(b.body_enc);
    const t = await txm(async (c2, fx, now) => {
      const t = await taskRow(c2, c.req.param("id") ?? "", true);
      requirePoster(t, home);
      requireStatus(t, "delivered");
      if (t.revisions >= MARKET.maxRevisions) throw new ApiError(409, "max_revisions", `At most ${MARKET.maxRevisions} revisions; complete or dispute.`);
      await addMessage(c2, fx, now, t, home, t.assignee_home, t.assignee_home, "revision", enc);
      await run(c2, "UPDATE tasks SET status = 'assigned', delivered_at = NULL, revisions = revisions + 1, updated_at = ? WHERE id = ?", [now, t.id]);
      await core.notify(c2, t.assignee_home, "revised", t.id, home, now);
      fx.tasks.add(t.id);
      return (await one(c2, "SELECT * FROM tasks WHERE id = ?", [t.id]))!;
    });
    return c.json({ task: out(t) });
  });

  api.post("/tasks/:id/cancel", requireAuth, async (c) => {
    const home = homeOf(c);
    const r = await txm(async (c2, fx, now) => {
      const t = await taskRow(c2, c.req.param("id") ?? "", true);
      requirePoster(t, home);
      if (t.status === "open") {
        await core.cancelOpen(c2, t, now, fx, home);
        return { pending: null };
      }
      if (t.status !== "assigned") {
        throw new ApiError(409, t.status === "completed" || t.status === "cancelled" ? "task_closed" : "cannot_cancel",
          t.status === "delivered" ? "The work was delivered: complete it, ask for a revision, or open a dispute." : `Not possible while the task is ${t.status}.`);
      }
      const deadline = t.deadline_at ?? Number(t.assigned_at) + MARKET.noDeadlineCancelMs;
      if (deadline < now) {
        await core.refundAndCancel(c2, t, "refund", now, fx, t.assignee_home, "cancelled");
        return { pending: null };
      }
      await run(c2, "UPDATE tasks SET cancel_requested_at = ?, updated_at = ? WHERE id = ?", [now, now, t.id]);
      await core.notify(c2, t.assignee_home, "cancel_requested", t.id, home, now);
      fx.tasks.add(t.id);
      return { pending: "assignee_release" };
    });
    const t = await taskRow(db(), c.req.param("id") ?? "");
    return c.json({ task: out(t), ...(r.pending ? { pending: r.pending } : {}) }, r.pending ? 202 : 200);
  });

  api.post("/tasks/:id/release", requireAuth, async (c) => {
    const home = homeOf(c);
    const t = await txm(async (c2, fx, now) => {
      const t = await taskRow(c2, c.req.param("id") ?? "", true);
      requireAssignee(t, home);
      requireStatus(t, "assigned");
      await core.refundAndCancel(c2, t, "release", now, fx, t.poster_home, "released");
      return (await one(c2, "SELECT * FROM tasks WHERE id = ?", [t.id]))!;
    });
    return c.json({ task: out(t) });
  });

  api.post("/tasks/:id/dispute", requireAuth, async (c) => {
    const home = homeOf(c);
    const b = await body(c);
    const reason = reqText(b.reason, 500, "bad_reason", "reason");
    const t = await txm(async (c2, fx, now) => {
      const t = await taskRow(c2, c.req.param("id") ?? "", true);
      if (home !== t.poster_home && home !== t.assignee_home) throw new ApiError(403, "not_a_party", "Only the poster or the assignee can open a dispute.");
      requireStatus(t, "assigned", "delivered");
      await run(c2, "UPDATE tasks SET status = 'disputed', disputed_by = ?, dispute_reason = ?, updated_at = ? WHERE id = ?", [home, reason, now, t.id]);
      await core.notify(c2, home === t.poster_home ? t.assignee_home : t.poster_home, "disputed", t.id, home, now);
      fx.tasks.add(t.id);
      return (await one(c2, "SELECT * FROM tasks WHERE id = ?", [t.id]))!;
    });
    return c.json({ task: out(t) });
  });

  // -- admin: disputes. Admins can't read E2E content; they decide on metadata and what the parties show them. --

  api.get("/admin/tasks", safety.requireAdmin, async (c) => {
    const status = c.req.query("status") ?? "disputed";
    if (status !== "all" && !(core.TASK_STATUSES as readonly string[]).includes(status)) throw new ApiError(400, "bad_status", "Bad status.");
    const rows = await all(db(), `SELECT t.*,
        (SELECT COUNT(*) FROM task_messages m WHERE m.task_id = t.id) AS messages,
        (SELECT COUNT(*) FROM task_files f WHERE f.task_id = t.id) AS files
      FROM tasks t ${status === "all" ? "" : "WHERE t.status = ?"} ORDER BY t.updated_at DESC LIMIT 200`, status === "all" ? [] : [status]);
    return c.json({
      tasks: rows.map((t) => ({
        ...core.publicTask(t), dispute_reason: t.dispute_reason ?? null, messages: Number(t.messages), files: Number(t.files),
        hidden_at: t.hidden_at ?? null,
      })),
    });
  });

  api.post("/admin/tasks/:id/resolve", safety.requireAdmin, async (c) => {
    const b = await body(c);
    const to = b.payout_to;
    if (!["poster", "assignee", "split"].includes(to)) throw new ApiError(400, "bad_payout_to", "payout_to: poster | assignee | split.");
    const t = await txm(async (c2, fx, now) => {
      const t = await taskRow(c2, c.req.param("id") ?? "", true);
      requireStatus(t, "disputed");
      const price = Number(t.price);
      if (to === "poster") {
        await core.refundAndCancel(c2, t, "admin", now, fx, t.assignee_home, "resolved", { resolution: "poster" });
      } else if (to === "assignee") {
        await core.completeTask(c2, t, now, fx, { kind: "resolved" });
        await run(c2, "UPDATE tasks SET resolution = 'assignee' WHERE id = ?", [t.id]);
      } else {
        const n = b.split === undefined || b.split === null ? Math.floor(price / 2) : int(b.split, 0, price, "bad_split", "split (coins to the assignee)");
        await core.ledger(c2, t.assignee_home, n, "admin", t.id, now, fx);
        await core.ledger(c2, t.poster_home, price - n, "admin", t.id, now, fx);
        await run(c2, "UPDATE tasks SET status = 'completed', closed_at = ?, updated_at = ?, resolution = ? WHERE id = ?",
          [now, now, `split:${n}`, t.id]);
        await core.notify(c2, t.assignee_home, "resolved", t.id, null, now);
        fx.tasks.add(t.id);
      }
      await core.notify(c2, t.poster_home, "resolved", t.id, null, now);
      return (await one(c2, "SELECT * FROM tasks WHERE id = ?", [t.id]))!;
    });
    return c.json({ task: out(t) });
  });
}
