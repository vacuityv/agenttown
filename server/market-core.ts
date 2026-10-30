// Task market building blocks shared by the routes (server/market.ts), the home lifecycle (store.ts: create, leave,
// merge) and moderation (safety.ts). Deliberately imports nothing but db/bus/config/util, so store.ts and safety.ts
// can use it without import cycles.
//
// Money rules: homes.coins is never negative and changes only through ledger() — an UPDATE plus a coin_ledger row on
// the same transaction connection. Coins are virtual: no top-ups, no cash-out, no transfers between homes; they only
// move poster → escrow (accept) → assignee (payout) or back to the poster (refund/release).
import { db, all, one, run, type Q, type Row } from "./db.ts";
import { bus } from "./bus.ts";
import { MARKET } from "./config.ts";
import { ApiError } from "./util.ts";

export const TASK_STATUSES = ["open", "assigned", "delivered", "completed", "cancelled", "disputed"] as const;
/** Statuses in which the accepted price sits in escrow. */
export const HELD = ["assigned", "delivered", "disputed"];
export const LEDGER_REASONS = ["grant", "escrow", "release", "refund", "payout", "admin"] as const;
type Reason = (typeof LEDGER_REASONS)[number];

// ---- side effects collected inside a transaction, emitted after commit ----

export type Effects = {
  tasks: Set<string>;
  wallets: Set<string>;
  messages: { task_id: string; from_home: string; to_home: string; message_id: string; ts: number }[];
};
export const effects = (): Effects => ({ tasks: new Set(), wallets: new Set(), messages: [] });
/** tx() may retry its function: start each attempt from scratch. */
export function resetEffects(fx: Effects) {
  fx.tasks.clear();
  fx.wallets.clear();
  fx.messages.length = 0;
}

// ---- public shapes ----

export const tagsOf = (t: Row) => (t.tags ? String(t.tags).split(",").filter(Boolean) : []);

export const publicTask = (t: Row) => ({
  id: t.id as string,
  poster_home: t.poster_home as string,
  assignee_home: (t.assignee_home ?? null) as string | null,
  title: t.title as string,
  summary: t.summary as string,
  budget: t.budget as number,
  price: (t.price ?? null) as number | null,
  tags: tagsOf(t),
  status: t.status as string,
  bids_count: t.bids_count as number,
  revisions: t.revisions as number,
  rating: (t.rating ?? null) as number | null,
  review: (t.review ?? null) as string | null,
  resolution: (t.resolution ?? null) as string | null,
  cancel_requested: t.cancel_requested_at != null,
  disputed_by: (t.disputed_by ?? null) as string | null,
  created_at: t.created_at as number,
  updated_at: t.updated_at as number,
  deadline_at: (t.deadline_at ?? null) as number | null,
  assigned_at: (t.assigned_at ?? null) as number | null,
  delivered_at: (t.delivered_at ?? null) as number | null,
  closed_at: (t.closed_at ?? null) as number | null,
});

/** SSE `task` (town feed): public fields only. */
export const taskEvent = (t: Row) => ({
  id: t.id, status: t.status, poster_home: t.poster_home, assignee_home: t.assignee_home ?? null, title: t.title,
  budget: t.budget, bids_count: t.bids_count, updated_at: t.updated_at,
});

export const publicBid = (b: Row) => ({
  id: b.id as string, bidder_home: b.bidder_home as string, price: b.price as number, status: b.status as string,
  created_at: b.created_at as number, updated_at: b.updated_at as number,
});

export const publicRep = (h: Row) => ({
  done: Number(h.rep_done ?? 0),
  rating: h.rep_rating_n ? Math.round((Number(h.rep_rating_sum) / Number(h.rep_rating_n)) * 10) / 10 : null,
  posted: Number(h.rep_posted ?? 0),
});

// ---- coins ----

/**
 * Moves coins of one home and appends the ledger row. A debit that would go negative returns false (nothing changes).
 * A credit to a home that no longer exists returns false too (its coins vanish with it).
 */
export async function ledger(c: Q, homeId: string, delta: number, reason: Reason, taskId: string | null, now: number, fx: Effects) {
  if (!delta) return true;
  const r = delta < 0
    ? await run(c, "UPDATE homes SET coins = coins + ? WHERE id = ? AND coins >= ?", [delta, homeId, -delta])
    : await run(c, "UPDATE homes SET coins = coins + ? WHERE id = ?", [delta, homeId]);
  if (!r.affectedRows) return false;
  await run(c, "INSERT INTO coin_ledger (home_id, delta, reason, task_id, ts) VALUES (?, ?, ?, ?, ?)", [homeId, delta, reason, taskId, now]);
  fx.wallets.add(homeId);
  return true;
}

/** Starting coins for a new home (same transaction as its INSERT). */
export const grantStart = (c: Q, homeId: string, now: number, fx: Effects) =>
  ledger(c, homeId, MARKET.startCoins, "grant", null, now, fx);

export async function heldBy(c: Q, homeId: string): Promise<number> {
  const r = await one(c, `SELECT COALESCE(SUM(price), 0) AS n FROM tasks WHERE poster_home = ? AND status IN (?)`, [homeId, HELD]);
  return Number(r?.n ?? 0);
}

// ---- inbox ----

export const notify = (c: Q, homeId: string, kind: string, taskId: string, fromHome: string | null, now: number) =>
  run(c, "INSERT INTO task_inbox (home_id, kind, task_id, from_home, ts) VALUES (?, ?, ?, ?, ?)", [homeId, kind, taskId, fromHome, now]);

// ---- task transitions shared by routes, sweeper and leaving ----

export const recountBids = (c: Q, taskId: string) => run(c, `
  UPDATE tasks SET bids_count = (SELECT COUNT(*) FROM task_bids WHERE task_id = ? AND status IN ('active', 'accepted'))
  WHERE id = ?`, [taskId, taskId]);

/** Open task → cancelled; active bids are declined and their bidders told. No coins move (nothing is escrowed yet). */
export async function cancelOpen(c: Q, t: Row, now: number, fx: Effects, by: string | null) {
  const bidders = await all(c, "SELECT bidder_home FROM task_bids WHERE task_id = ? AND status = 'active'", [t.id]);
  await run(c, "UPDATE task_bids SET status = 'declined', updated_at = ? WHERE task_id = ? AND status = 'active'", [now, t.id]);
  await run(c, "UPDATE tasks SET status = 'cancelled', closed_at = ?, updated_at = ? WHERE id = ?", [now, now, t.id]);
  await recountBids(c, t.id);
  for (const b of bidders) if (b.bidder_home !== by) await notify(c, b.bidder_home, "cancelled", t.id, by, now);
  fx.tasks.add(t.id);
}

/** Escrowed task → cancelled, the price goes back to the poster. */
export async function refundAndCancel(c: Q, t: Row, reason: "refund" | "release" | "admin", now: number, fx: Effects, notifyHome: string | null, kind: string, extra: { resolution?: string } = {}) {
  await ledger(c, t.poster_home, Number(t.price), reason, t.id, now, fx);
  await run(c, `UPDATE tasks SET status = 'cancelled', closed_at = ?, updated_at = ?, resolution = COALESCE(?, resolution)
    WHERE id = ?`, [now, now, extra.resolution ?? null, t.id]);
  if (notifyHome) await notify(c, notifyHome, kind, t.id, null, now);
  fx.tasks.add(t.id);
}

/** Escrow → assignee; task completed. Rating (1–5) and review are the poster's, both optional. */
export async function completeTask(c: Q, t: Row, now: number, fx: Effects, o: { rating?: number | null; review?: string | null; kind?: string } = {}) {
  await ledger(c, t.assignee_home, Number(t.price), "payout", t.id, now, fx);
  await run(c, `UPDATE tasks SET status = 'completed', closed_at = ?, updated_at = ?, rating = ?, review = ?, cancel_requested_at = NULL
    WHERE id = ?`, [now, now, o.rating ?? null, o.review ?? null, t.id]);
  await run(c, `UPDATE homes SET rep_done = rep_done + 1, rep_rating_sum = rep_rating_sum + ?, rep_rating_n = rep_rating_n + ?
    WHERE id = ?`, [o.rating ?? 0, o.rating ? 1 : 0, t.assignee_home]);
  await notify(c, t.assignee_home, o.kind ?? "completed", t.id, null, now);
  fx.tasks.add(t.id);
}

// ---- home lifecycle ----

/**
 * A home leaves town (owner delete or admin hard delete), inside the caller's transaction, before the home row goes:
 * - as poster: open → cancelled; assigned → cancelled (the escrow would come back to a home that's gone: it vanishes);
 *   delivered/disputed → completed, the assignee is paid (the poster gave up its claim);
 * - as assignee: assigned/delivered/disputed → cancelled, the poster is refunded;
 * - its active bids are withdrawn; its ledger and inbox rows are deleted (coins vanish).
 */
export async function leaveMarket(c: Q, homeId: string, now: number, fx: Effects) {
  const posted = await all(c, "SELECT * FROM tasks WHERE poster_home = ? AND status IN ('open', 'assigned', 'delivered', 'disputed') FOR UPDATE", [homeId]);
  for (const t of posted) {
    if (t.status === "open") await cancelOpen(c, t, now, fx, homeId);
    else if (t.status === "assigned") {
      await run(c, "UPDATE tasks SET status = 'cancelled', closed_at = ?, updated_at = ? WHERE id = ?", [now, now, t.id]);
      await notify(c, t.assignee_home, "cancelled", t.id, homeId, now);
      fx.tasks.add(t.id);
    } else await completeTask(c, t, now, fx);
  }
  const taken = await all(c, "SELECT * FROM tasks WHERE assignee_home = ? AND status IN (?) FOR UPDATE", [homeId, HELD]);
  for (const t of taken) await refundAndCancel(c, t, "refund", now, fx, t.poster_home, "released");
  const bids = await all(c, "SELECT task_id FROM task_bids WHERE bidder_home = ? AND status = 'active'", [homeId]);
  await run(c, "UPDATE task_bids SET status = 'withdrawn', updated_at = ? WHERE bidder_home = ? AND status = 'active'", [now, homeId]);
  for (const b of bids) { await recountBids(c, b.task_id); fx.tasks.add(b.task_id); }
  await run(c, "DELETE FROM coin_ledger WHERE home_id = ?", [homeId]);
  await run(c, "DELETE FROM task_inbox WHERE home_id = ?", [homeId]);
  fx.wallets.delete(homeId);
}

/**
 * Home B merges into A (inside store.mergeHomes' transaction, homes locked). Refused while B has escrowed work
 * (its threads are encrypted under B's key, which A's machines can't use). B's open tasks are cancelled and its
 * active bids withdrawn; B's balance and reputation are added to A's (ledger row reason "admin"); closed task
 * history moves to A.
 */
export async function mergeMarket(c: Q, aId: string, bId: string, now: number, fx: Effects) {
  const active = await one(c, `SELECT COUNT(*) AS n FROM tasks WHERE (poster_home = ? OR assignee_home = ?) AND status IN (?)`, [bId, bId, HELD]);
  if (Number(active!.n) > 0) {
    throw new ApiError(409, "active_tasks", "This home has task-market work in progress (assigned, delivered or disputed). Finish or cancel it before merging.");
  }
  for (const t of await all(c, "SELECT * FROM tasks WHERE poster_home = ? AND status = 'open' FOR UPDATE", [bId])) await cancelOpen(c, t, now, fx, bId);
  const bids = await all(c, "SELECT task_id FROM task_bids WHERE bidder_home = ? AND status = 'active'", [bId]);
  await run(c, "UPDATE task_bids SET status = 'withdrawn', updated_at = ? WHERE bidder_home = ? AND status = 'active'", [now, bId]);
  for (const b of bids) { await recountBids(c, b.task_id); fx.tasks.add(b.task_id); }
  await run(c, "UPDATE tasks SET poster_home = ? WHERE poster_home = ?", [aId, bId]);
  await run(c, "UPDATE tasks SET assignee_home = ? WHERE assignee_home = ?", [aId, bId]);
  const B = (await one(c, "SELECT coins, rep_posted, rep_done, rep_rating_sum, rep_rating_n FROM homes WHERE id = ?", [bId]))!;
  await run(c, `UPDATE homes SET rep_posted = rep_posted + ?, rep_done = rep_done + ?, rep_rating_sum = rep_rating_sum + ?,
    rep_rating_n = rep_rating_n + ? WHERE id = ?`, [B.rep_posted, B.rep_done, B.rep_rating_sum, B.rep_rating_n, aId]);
  const coins = Number(B.coins);
  if (coins > 0) {
    await ledger(c, bId, -coins, "admin", null, now, fx);
    await ledger(c, aId, coins, "admin", null, now, fx);
  }
  await run(c, "DELETE FROM coin_ledger WHERE home_id = ?", [bId]);
  await run(c, "DELETE FROM task_inbox WHERE home_id = ?", [bId]);
  fx.wallets.delete(bId);
}

// ---- after commit ----

export async function emitEffects(fx: Effects) {
  for (const id of fx.tasks) {
    const t = await one(db(), "SELECT * FROM tasks WHERE id = ?", [id]);
    if (t) bus.emit({ type: "task", home_id: t.poster_home, data: taskEvent(t) });
  }
  for (const homeId of fx.wallets) {
    const h = await one(db(), "SELECT coins FROM homes WHERE id = ?", [homeId]);
    if (h) bus.emit({ type: "wallet", home_id: homeId, data: { coins: Number(h.coins), held: await heldBy(db(), homeId) } });
  }
  for (const m of fx.messages) {
    const data = { task_id: m.task_id, from_home: m.from_home, message_id: m.message_id, ts: m.ts };
    bus.emit({ type: "task_message", home_id: m.to_home, data });
    bus.emit({ type: "task_message", home_id: m.from_home, data });
  }
}
