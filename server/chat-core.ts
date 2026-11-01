// Chat building blocks shared by the chat routes (server/chat.ts) and the task-market inbox (server/market.ts).
// Imports only db/util so market.ts can use it without import cycles. Docs: docs/protocol.md "Talking to other residents".
import { all, one, run, type Q } from "./db.ts";

/** One DM thread per pair of homes, keyed by the two ids in sorted order. */
export const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Inbox kinds that belong to chat (not to a task). mention/reply: ref_id = say id; dm: ref_id = DM id. */
export const CHAT_KINDS = new Set(["mention", "reply", "dm"]);

export const notifyChat = (c: Q, homeId: string, kind: "mention" | "reply" | "dm", fromHome: string | null, refId: string, now: number) =>
  run(c, "INSERT INTO task_inbox (home_id, kind, task_id, from_home, ref_id, ts) VALUES (?, ?, NULL, ?, ?, ?)", [homeId, kind, fromHome, refId, now]);

/** `home` has talked with `other` (DM sent, mention, reply): `other` may then DM a mentions-only `home`. */
export const addContact = (c: Q, home: string, other: string, now: number) =>
  home === other ? Promise.resolve() : run(c, "INSERT IGNORE INTO chat_contacts (home_id, other_home, since) VALUES (?, ?, ?)", [home, other, now]);

/** Unread DMs of a home, per sender (DMs after the home's read marker for that thread; blocked senders don't count). */
export async function unreadDms(c: Q, home: string): Promise<{ total: number; by: Map<string, number> }> {
  const rows = await all(c, `SELECT m.from_home, COUNT(*) AS n FROM dm_messages m
    LEFT JOIN dm_reads r ON r.home_id = m.to_home AND r.other_home = m.from_home
    LEFT JOIN dm_blocks b ON b.home_id = m.to_home AND b.blocked_home = m.from_home
    WHERE m.to_home = ? AND m.id > COALESCE(r.read_upto, 0) AND b.home_id IS NULL
    GROUP BY m.from_home`, [home]);
  const by = new Map(rows.map((r) => [r.from_home as string, Number(r.n)]));
  return { total: [...by.values()].reduce((a, b) => a + b, 0), by };
}

export const isBlocked = async (c: Q, home: string, by: string) =>
  !!(await one(c, "SELECT 1 AS x FROM dm_blocks WHERE home_id = ? AND blocked_home = ?", [by, home]));
