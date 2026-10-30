// Art worker: turns personas with sprite_status = 'pending' into v2 vector sprites (docs/protocol.md "Sprite format
// v2") and homes with art_status = 'pending' into dwelling art (docs/protocol.md "Dwelling art v1").
// Generation + validation live in avatar-gen.ts / dwelling-gen.ts (no DB there); this file is the DB-backed queue.
// One generation at a time; a global hourly cap and per-home daily caps (sprites and dwellings counted separately).
// Personas that already have a v1 pixel sprite keep it.

import Anthropic from "@anthropic-ai/sdk";
import { db, all, one, run, type Row } from "./db.ts";
import { bus } from "./bus.ts";
import { publicHome, publicPersona } from "./store.ts";
import { generateSprite, idPrefixFor, hasApiKey, AVATAR_MODEL, SpriteError, RefusedError, type Usage } from "./avatar-gen.ts";
import { generateDwelling } from "./dwelling-gen.ts";

export { generateSprite, buildSprite, hasApiKey, AVATAR_MODEL, SpriteError, RefusedError } from "./avatar-gen.ts";
export type { SpriteV2, Usage } from "./avatar-gen.ts";

const MAX_PER_HOUR = Number(process.env.AVATAR_MAX_PER_HOUR ?? 60); // sprites + dwellings, process-wide
const SPRITES_PER_HOME_PER_DAY = 3;
const DWELLINGS_PER_HOME_PER_DAY = 2;
const POLL_MS = 5_000;

const utcDay = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------- jobs

/** One kind of queued generation. `col` is the avatar_usage counter that holds its daily cap. */
type Job = {
  kind: "sprite" | "dwelling";
  col: "count" | "dwellings";
  perDay: number;
  nextPending: () => Promise<Row[]>; // rows with id, home_id, text
  generate: (row: Row) => Promise<{ json: unknown; usage: Usage }>;
  setReady: (row: Row, json: string) => Promise<number>; // affected rows
  setFailed: (row: Row, why: string) => Promise<unknown>;
  setNone: (row: Row) => Promise<unknown>;
  emit: (id: string) => Promise<void>;
};

// Writes only land if the description did not change while we were generating (`<=>` is NULL-safe equality).
const SPRITE: Job = {
  kind: "sprite",
  col: "count",
  perDay: SPRITES_PER_HOME_PER_DAY,
  nextPending: () => all(db(), `
    SELECT id, home_id, appearance AS text FROM personas WHERE sprite_status = 'pending'
    ORDER BY created_at LIMIT 50`),
  generate: async (r) => {
    const { sprite, usage } = await generateSprite(r.text, { idPrefix: idPrefixFor(r.id) });
    return { json: sprite, usage };
  },
  setReady: async (r, json) => (await run(db(), `
    UPDATE personas SET sprite = ?, sprite_status = 'ready', sprite_error = NULL
    WHERE id = ? AND sprite_status = 'pending' AND appearance <=> ?`, [json, r.id, r.text])).affectedRows,
  setFailed: (r, why) => run(db(), `
    UPDATE personas SET sprite_status = 'failed', sprite_error = ?
    WHERE id = ? AND sprite_status = 'pending' AND appearance <=> ?`, [why, r.id, r.text]),
  setNone: (r) => run(db(), "UPDATE personas SET sprite_status = 'none' WHERE id = ? AND appearance IS NULL", [r.id]),
  emit: async (id) => {
    const p = await one(db(), "SELECT * FROM personas WHERE id = ?", [id]);
    if (p) bus.emit({ type: "persona", home_id: p.home_id, data: publicPersona(p) });
  },
};

const DWELLING: Job = {
  kind: "dwelling",
  col: "dwellings",
  perDay: DWELLINGS_PER_HOME_PER_DAY,
  nextPending: () => all(db(), `
    SELECT id, id AS home_id, look AS text FROM homes WHERE art_status = 'pending'
    ORDER BY created_at LIMIT 50`),
  generate: async (r) => {
    const { art, usage } = await generateDwelling(r.text, { idPrefix: idPrefixFor(r.id) });
    return { json: art, usage };
  },
  setReady: async (r, json) => (await run(db(), `
    UPDATE homes SET art = ?, art_status = 'ready', art_error = NULL
    WHERE id = ? AND art_status = 'pending' AND look <=> ?`, [json, r.id, r.text])).affectedRows,
  setFailed: (r, why) => run(db(), `
    UPDATE homes SET art_status = 'failed', art_error = ?
    WHERE id = ? AND art_status = 'pending' AND look <=> ?`, [why, r.id, r.text]),
  setNone: (r) => run(db(), "UPDATE homes SET art_status = 'none' WHERE id = ? AND look IS NULL", [r.id]),
  emit: async (id) => {
    const h = await one(db(), "SELECT id, name, created_at, look, art, art_status, art_error FROM homes WHERE id = ?", [id]);
    if (h) bus.emit({ type: "home", home_id: h.id, data: publicHome(h) });
  },
};

const JOBS = [SPRITE, DWELLING];

// ---------------------------------------------------------------- worker

const recentCalls: number[] = []; // timestamps of generations in the last hour (process-local)
const backoff = new Map<string, { until: number; tries: number }>(); // transient API errors, by job:id
let pausedUntil = 0;

async function processOne(): Promise<boolean> {
  const now = Date.now();
  if (now < pausedUntil) return false;
  while (recentCalls.length && recentCalls[0] < now - 3600_000) recentCalls.shift();
  if (recentCalls.length >= MAX_PER_HOUR) return false;

  // Sprites first (fast, ~10 s); dwellings (1-4 min) when no sprite is waiting.
  let job: Job | undefined, r: Row | undefined;
  for (const j of JOBS) {
    r = (await j.nextPending()).find((x) => (backoff.get(`${j.kind}:${x.id}`)?.until ?? 0) <= now);
    if (r) { job = j; break; }
  }
  if (!job || !r) return false;
  const key = `${job.kind}:${r.id}`;
  const tag = `${job.kind} ${r.id}`;
  if (!r.text) { await job.setNone(r); await job.emit(r.id); return true; }

  const day = utcDay();
  const used = (await one(db(), `SELECT ${job.col} AS n FROM avatar_usage WHERE home_id = ? AND day = ?`, [r.home_id, day]))?.n ?? 0;
  if (used >= job.perDay) {
    await job.setFailed(r, "daily_limit");
    await job.emit(r.id);
    console.log(`avatar: ${tag} skipped, home ${r.home_id} hit ${job.perDay} ${job.kind}s/day`);
    return true;
  }
  await run(db(), `
    INSERT INTO avatar_usage (home_id, day, ${job.col}) VALUES (?, ?, 1)
    ON DUPLICATE KEY UPDATE ${job.col} = ${job.col} + 1`, [r.home_id, day]);
  recentCalls.push(now);

  const t0 = Date.now();
  try {
    const { json, usage } = await job.generate(r);
    const n = await job.setReady(r, JSON.stringify(json));
    backoff.delete(key);
    console.log(`avatar: ${tag} ready in ${Date.now() - t0} ms, ${usage.attempts} call(s), ` +
      `tokens in=${usage.input_tokens} out=${usage.output_tokens}${n ? "" : " (stale, discarded)"}` +
      (usage.rejected ? `, rejected first: ${usage.rejected.join("; ")}` : ""));
  } catch (e) {
    if (e instanceof SpriteError || e instanceof RefusedError) {
      // Refused: the client keeps showing the default look.
      await job.setFailed(r, e instanceof RefusedError ? "refused" : "invalid_output");
      console.warn(`avatar: ${tag} failed: ${e.message}`);
    } else if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      pausedUntil = Date.now() + 10 * 60_000;
      console.error(`avatar: API auth error (${e.status}), pausing worker for 10 min`);
    } else if (e instanceof Anthropic.BadRequestError || e instanceof Anthropic.NotFoundError) {
      await job.setFailed(r, "api_error");
      console.error(`avatar: ${tag} API rejected request (${e.status}): ${e.message}`);
    } else {
      // Rate limit / overload / network / timeout: try again later, give up after 3 rounds.
      const b = backoff.get(key) ?? { until: 0, tries: 0 };
      b.tries++;
      b.until = Date.now() + 60_000 * 2 ** b.tries;
      backoff.set(key, b);
      if (b.tries >= 3) { backoff.delete(key); await job.setFailed(r, "api_error"); }
      console.warn(`avatar: ${tag} transient error (try ${b.tries}): ${(e as Error).message}`);
    }
  }
  await job.emit(r.id);
  return true;
}

let started = false;

export function startAvatarWorker() {
  if (started) return;
  started = true;
  if (!hasApiKey()) {
    console.log("avatar: ANTHROPIC_API_KEY not set, sprite/dwelling generation disabled (requests stay pending)");
    return;
  }
  console.log(`avatar: worker on (model ${AVATAR_MODEL}, ≤${MAX_PER_HOUR}/h, per home/day ≤${SPRITES_PER_HOME_PER_DAY} sprites + ≤${DWELLINGS_PER_HOME_PER_DAY} dwellings)`);
  run(db(), "DELETE FROM avatar_usage WHERE day < ?", [new Date(Date.now() - 3 * 86400_000).toISOString().slice(0, 10)])
    .catch((e) => console.error("avatar: prune failed", e));

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
  // On-demand trigger: a persona or home just became pending.
  bus.on((e) => {
    const d = e.data as Row;
    const pending = (e.type === "persona" && d?.sprite_status === "pending") || (e.type === "home" && d?.art_status === "pending");
    if (pending && !busy) setImmediate(tick);
  });
  setImmediate(tick);
}
