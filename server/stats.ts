// Daily funnel counters: who reaches the town and how far they get (docs and CLI fetched, MCP tool calls, sign-ups,
// new personas), split by the kind of client. Counted in memory and added to `funnel_stats` once a minute; only
// counts are stored — no IPs, user agents or ids. Read with `scripts/admin.mjs stats` (GET /v1/admin/stats).

import type { Hono } from "hono";
import { db, all, run } from "./db.ts";
import { requireAdmin } from "./safety.ts";

const pending = new Map<string, number>(); // "YYYY-MM-DD|metric" -> n

/** Adds n to today's (UTC) counter. Metric names are code constants plus at most a uaClass / kind suffix. */
export function bump(metric: string, n = 1) {
  const key = `${new Date().toISOString().slice(0, 10)}|${metric.slice(0, 64)}`;
  pending.set(key, (pending.get(key) ?? 0) + n);
}

/** Who is asking, from the User-Agent: "bot" (crawlers, scanners, monitors), "browser" (a person) or "cli". */
export function uaClass(ua: string | undefined) {
  if (!ua || /bot|crawl|spider|monitor|probe|scanner|indexer|collector|uptime|preview|externalhit|validator/i.test(ua)) return "bot";
  return /^mozilla\//i.test(ua) ? "browser" : "cli";
}

export async function flushStats() {
  if (!pending.size) return;
  const rows = [...pending];
  pending.clear();
  try {
    for (const [key, n] of rows) {
      const [day, metric] = key.split("|");
      await run(db(), "INSERT INTO funnel_stats (day, metric, n) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE n = n + VALUES(n)", [day, metric, n]);
    }
  } catch (e) {
    for (const [key, n] of rows) pending.set(key, (pending.get(key) ?? 0) + n); // keep them for the next try
    console.error(`stats: flush failed: ${(e as Error).message}`);
  }
}

export function startStats() {
  setInterval(() => { flushStats(); }, 60_000).unref();
  process.once("SIGTERM", () => { flushStats().finally(() => process.exit(0)); });
}

export function mountStats(api: Hono<any>) {
  api.get("/admin/stats", requireAdmin, async (c) => {
    await flushStats();
    const days = Math.min(Math.max(Number(c.req.query("days")) || 7, 1), 90);
    const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
    const rows = await all(db(), "SELECT DATE_FORMAT(day, '%Y-%m-%d') AS day, metric, n FROM funnel_stats WHERE day >= ? ORDER BY day, metric", [since]);
    const byDay: Record<string, Record<string, number>> = {};
    for (const r of rows) (byDay[String(r.day)] ??= {})[r.metric] = Number(r.n);
    return c.json({ since, days: byDay });
  });
}
