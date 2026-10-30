// Avatar worker: turns personas with sprite_status = 'pending' into v2 vector sprites
// (docs/protocol.md "Sprite format v2"). Generation + validation live in avatar-gen.ts (no DB there);
// this file is the DB-backed queue worker. Personas that already have a v1 pixel sprite keep it.

import Anthropic from "@anthropic-ai/sdk";
import { db, all, one, run, type Row } from "./db.ts";
import { bus } from "./bus.ts";
import { publicPersona } from "./store.ts";
import { generateSprite, idPrefixFor, hasApiKey, AVATAR_MODEL, SpriteError, RefusedError } from "./avatar-gen.ts";

export { generateSprite, buildSprite, hasApiKey, AVATAR_MODEL, SpriteError, RefusedError } from "./avatar-gen.ts";
export type { SpriteV2, Usage } from "./avatar-gen.ts";

const MAX_PER_HOUR = Number(process.env.AVATAR_MAX_PER_HOUR ?? 60);
const PER_HOME_PER_DAY = 3;
const POLL_MS = 5_000;

// ---------------------------------------------------------------- worker

const utcDay = () => new Date().toISOString().slice(0, 10);

const sql = {
  nextPending: `
    SELECT id, home_id, appearance FROM personas WHERE sprite_status = 'pending'
    ORDER BY created_at LIMIT 50`,
  usageToday: "SELECT count FROM avatar_usage WHERE home_id = ? AND day = ?",
  bumpUsage: `
    INSERT INTO avatar_usage (home_id, day, count) VALUES (?, ?, 1)
    ON DUPLICATE KEY UPDATE count = count + 1`,
  pruneUsage: "DELETE FROM avatar_usage WHERE day < ?",
  // Only write if the appearance did not change while we were generating.
  setReady: `
    UPDATE personas SET sprite = ?, sprite_status = 'ready', sprite_error = NULL
    WHERE id = ? AND sprite_status = 'pending' AND appearance <=> ?`,
  setFailed: `
    UPDATE personas SET sprite_status = 'failed', sprite_error = ?
    WHERE id = ? AND sprite_status = 'pending' AND appearance <=> ?`,
  setNone: "UPDATE personas SET sprite_status = 'none' WHERE id = ? AND appearance IS NULL",
  byId: "SELECT * FROM personas WHERE id = ?",
};
const q = {
  nextPending: () => all(db(), sql.nextPending),
  usageToday: (homeId: string, day: string) => one(db(), sql.usageToday, [homeId, day]),
  bumpUsage: (homeId: string, day: string) => run(db(), sql.bumpUsage, [homeId, day]),
  pruneUsage: (before: string) => run(db(), sql.pruneUsage, [before]),
  setReady: (sprite: string, id: string, appearance: string) => run(db(), sql.setReady, [sprite, id, appearance]),
  setFailed: (why: string, id: string, appearance: string) => run(db(), sql.setFailed, [why, id, appearance]),
  setNone: (id: string) => run(db(), sql.setNone, [id]),
};

async function emit(id: string) {
  const p = await one(db(), sql.byId, [id]);
  if (p) bus.emit({ type: "persona", home_id: p.home_id, data: publicPersona(p) });
}

const recentCalls: number[] = []; // timestamps of generations in the last hour (process-local)
const backoff = new Map<string, { until: number; tries: number }>(); // transient API errors
let pausedUntil = 0;

async function processOne(): Promise<boolean> {
  const now = Date.now();
  if (now < pausedUntil) return false;
  while (recentCalls.length && recentCalls[0] < now - 3600_000) recentCalls.shift();
  if (recentCalls.length >= MAX_PER_HOUR) return false;

  const p = (await q.nextPending()).find((r) => (backoff.get(r.id)?.until ?? 0) <= now);
  if (!p) return false;
  if (!p.appearance) { await q.setNone(p.id); await emit(p.id); return true; }

  const day = utcDay();
  const used = (await q.usageToday(p.home_id, day))?.count ?? 0;
  if (used >= PER_HOME_PER_DAY) {
    await q.setFailed("daily_limit", p.id, p.appearance);
    await emit(p.id);
    console.log(`avatar: ${p.id} skipped, home ${p.home_id} hit ${PER_HOME_PER_DAY}/day`);
    return true;
  }
  await q.bumpUsage(p.home_id, day);
  recentCalls.push(now);

  const t0 = Date.now();
  try {
    const { sprite, usage } = await generateSprite(p.appearance, { idPrefix: idPrefixFor(p.id) });
    const r = await q.setReady(JSON.stringify(sprite), p.id, p.appearance);
    backoff.delete(p.id);
    console.log(`avatar: ${p.id} ready in ${Date.now() - t0} ms, ${usage.attempts} call(s), ` +
      `tokens in=${usage.input_tokens} out=${usage.output_tokens}${r.affectedRows ? "" : " (stale, discarded)"}`);
  } catch (e) {
    if (e instanceof SpriteError || e instanceof RefusedError) {
      await q.setFailed(e instanceof RefusedError ? "refused" : "invalid_output", p.id, p.appearance);
      console.warn(`avatar: ${p.id} failed: ${e.message}`);
    } else if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      pausedUntil = Date.now() + 10 * 60_000;
      console.error(`avatar: API auth error (${e.status}), pausing worker for 10 min`);
    } else if (e instanceof Anthropic.BadRequestError || e instanceof Anthropic.NotFoundError) {
      await q.setFailed("api_error", p.id, p.appearance);
      console.error(`avatar: ${p.id} API rejected request (${e.status}): ${e.message}`);
    } else {
      // Rate limit / overload / network: try again later, give up after 3 rounds.
      const b = backoff.get(p.id) ?? { until: 0, tries: 0 };
      b.tries++;
      b.until = Date.now() + 60_000 * 2 ** b.tries;
      backoff.set(p.id, b);
      if (b.tries >= 3) { backoff.delete(p.id); await q.setFailed("api_error", p.id, p.appearance); }
      console.warn(`avatar: ${p.id} transient error (try ${b.tries}): ${(e as Error).message}`);
    }
  }
  await emit(p.id);
  return true;
}

let started = false;

export function startAvatarWorker() {
  if (started) return;
  started = true;
  if (!hasApiKey()) {
    console.log("avatar: ANTHROPIC_API_KEY not set, sprite generation disabled (personas stay pending)");
    return;
  }
  console.log(`avatar: worker on (model ${AVATAR_MODEL}, ≤${MAX_PER_HOUR}/h, ≤${PER_HOME_PER_DAY}/home/day)`);
  q.pruneUsage(new Date(Date.now() - 3 * 86400_000).toISOString().slice(0, 10)).catch((e) => console.error("avatar: prune failed", e));

  let busy = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    clearTimeout(timer);
    if (busy) return;
    busy = true;
    try {
      while (await processOne()); // serial: one generation at a time
    } catch (e) {
      console.error("avatar: worker error", e);
    } finally {
      busy = false;
      timer = setTimeout(tick, POLL_MS);
      timer.unref();
    }
  };
  // On-demand trigger: a persona just became pending.
  bus.on((e) => {
    if (e.type === "persona" && (e.data as Row)?.sprite_status === "pending" && !busy) setImmediate(tick);
  });
  setImmediate(tick);
}
