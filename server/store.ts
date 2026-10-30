import { db, tx, all, one, run, type Q, type Row } from "./db.ts";
import { bus, type BusEvent } from "./bus.ts";
import { LIMITS } from "./config.ts";
import { ApiError, newId } from "./util.ts";

export const STATUSES = ["thinking", "tool", "waiting", "idle", "ended"] as const;
export type Status = (typeof STATUSES)[number];
const BUSY = new Set<string>(["thinking", "tool"]);

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

const sql = {
  homeByAuth: "SELECT id, name, created_at FROM homes WHERE auth_hash = ?",
  homeById: "SELECT id, name, created_at, look, art, art_status, art_error FROM homes WHERE id = ?",
  insertHome: "INSERT INTO homes (id, auth_hash, name, created_at) VALUES (?, ?, ?, ?)",
  renameHome: "UPDATE homes SET name = ? WHERE id = ?",
  // LAST_INSERT_ID(expr) hands the new value back in the OK packet (insertId) of this very statement.
  bumpTaskSeq: "UPDATE homes SET task_seq = LAST_INSERT_ID(task_seq + 1) WHERE id = ?",

  personaByName: "SELECT * FROM personas WHERE home_id = ? AND name = ?",
  personaById: "SELECT * FROM personas WHERE home_id = ? AND id = ?",
  personasOfHome: "SELECT * FROM personas WHERE home_id = ? ORDER BY created_at",
  countPersonas: "SELECT COUNT(*) AS n FROM personas WHERE home_id = ?",
  // Upsert so two concurrent first-uses of a name queue on the row lock instead of failing.
  // affectedRows: 1 = inserted, 2 = kind changed, 0 = unchanged.
  upsertPersona: `
    INSERT INTO personas (id, home_id, name, kind, created_at) VALUES (?, ?, ?, ?, ?) AS new
    ON DUPLICATE KEY UPDATE kind = new.kind`,
  setAppearance: "UPDATE personas SET appearance = ?, sprite_status = 'pending' WHERE id = ?",

  sessionByKeyForUpdate: "SELECT * FROM sessions WHERE home_id = ? AND ext_key = ? FOR UPDATE",
  sessionByKey: "SELECT * FROM sessions WHERE home_id = ? AND ext_key = ?",
  sessionById: "SELECT * FROM sessions WHERE id = ?",
  openSessionsOfHome: "SELECT * FROM sessions WHERE home_id = ? AND ended_at IS NULL ORDER BY started_at",
  countOpenOthers: "SELECT COUNT(*) AS n FROM sessions WHERE home_id = ? AND ended_at IS NULL AND id <> ?",
  // Insert-or-lock: a no-op on an existing key, but it takes the row's exclusive lock either way, so concurrent
  // reports for one session serialize here. affectedRows: 1 = inserted, 0 = already there.
  ensureSession: `
    INSERT INTO sessions (id, home_id, persona_id, ext_key, parent_id, status, started_at, last_seen)
    VALUES (?, ?, ?, ?, ?, 'idle', ?, ?)
    ON DUPLICATE KEY UPDATE id = id`,
  updateSession: `
    UPDATE sessions SET persona_id = ?, parent_id = ?, status = ?, tool = ?, task_no = ?, task_enc = ?,
      last_seen = ?, started_at = CASE WHEN ended_at IS NULL THEN started_at ELSE ? END, ended_at = ?
    WHERE id = ?`,
  openChildren: "SELECT id FROM sessions WHERE parent_id = ? AND ended_at IS NULL",
  endSession: "UPDATE sessions SET status = 'ended', tool = NULL, ended_at = ? WHERE id = ? AND ended_at IS NULL",
  staleSessions: `
    SELECT id FROM sessions WHERE ended_at IS NULL AND (
      (status IN ('thinking', 'tool') AND last_seen < ?) OR
      (status NOT IN ('thinking', 'tool') AND last_seen < ?))`,

  insertEvent: "INSERT INTO events (home_id, session_id, ts, status, tool, task_no) VALUES (?, ?, ?, ?, ?, ?)",
  addBusy: `
    INSERT INTO daily_stats (home_id, day, busy_ms) VALUES (?, ?, ?) AS new
    ON DUPLICATE KEY UPDATE busy_ms = daily_stats.busy_ms + new.busy_ms`,
  addTask: `
    INSERT INTO daily_stats (home_id, day, tasks) VALUES (?, ?, 1)
    ON DUPLICATE KEY UPDATE tasks = tasks + 1`,
  addTool: `
    INSERT INTO tool_stats (home_id, day, tool, count) VALUES (?, ?, ?, 1)
    ON DUPLICATE KEY UPDATE count = count + 1`,
};

// ---- public shapes (what anyone may see) ----

export const publicHome = (h: Row) => ({
  id: h.id, name: h.name, created_at: h.created_at,
  ...publicLook(h),
});

// Dwelling art (docs/protocol.md "Dwelling art v1"); a separate helper so other publicHome fields merge cleanly.
const publicLook = (h: Row) => ({
  look: h.look ?? null,
  art: h.art ? JSON.parse(h.art) : null,
  art_status: h.art_status ?? "none",
  art_error: h.art_status === "failed" ? (h.art_error ?? null) : null,
});

export const publicPersona = (p: Row) => ({
  id: p.id,
  name: p.name,
  kind: p.kind,
  appearance: p.appearance,
  sprite: p.sprite ? JSON.parse(p.sprite) : null,
  sprite_status: p.sprite_status,
  sprite_error: p.sprite_status === "failed" ? (p.sprite_error ?? null) : null,
});

export const publicSession = (s: Row) => ({
  id: s.id,
  persona_id: s.persona_id,
  parent_id: s.parent_id,
  status: s.status,
  tool: s.tool,
  task_no: s.task_no,
  task_enc: s.task_enc,
  started_at: s.started_at,
  last_seen: s.last_seen,
});

const logErr = (what: string) => (e: unknown) => console.error(what, e);

async function emitSession(id: string) {
  const s = await one(db(), sql.sessionById, [id]);
  if (!s) return;
  bus.emit({ type: "session", home_id: s.home_id, data: publicSession(s) });
  scheduleCounts(s.home_id);
  scheduleAgent(s.id);
}

// Town feed: who is where. No task data. Latest state per session, at most one event per 2 s.
export const townAgent = (s: Row) => ({
  id: s.id,
  persona_id: s.persona_id,
  parent_id: s.parent_id,
  status: s.status,
  tool: s.tool,
  last_seen: s.last_seen,
});
const agentPending = new Set<string>();
function scheduleAgent(id: string) {
  if (agentPending.has(id)) return;
  agentPending.add(id);
  setTimeout(() => {
    agentPending.delete(id);
    one(db(), sql.sessionById, [id]).then((s) => {
      if (s) bus.emit({ type: "agent", home_id: s.home_id, data: townAgent(s) });
    }).catch(logErr("agent event failed"));
  }, 2000);
}

// The town view only needs per-home counts; coalesce them to at most one event per home per second.
const countsSql = `
  SELECT COUNT(*) AS open, COALESCE(SUM(status IN ('thinking', 'tool')), 0) AS busy
  FROM sessions WHERE home_id = ? AND ended_at IS NULL`;
const countsPending = new Map<string, NodeJS.Timeout>();
function scheduleCounts(homeId: string) {
  if (countsPending.has(homeId)) return;
  countsPending.set(homeId, setTimeout(() => {
    countsPending.delete(homeId);
    one(db(), countsSql, [homeId]).then((c) => {
      bus.emit({ type: "counts", home_id: homeId, data: { open: c!.open, busy: c!.busy } });
    }).catch(logErr("counts event failed"));
  }, 1000));
}

// ---- homes ----

export async function createHome(authHash: string, name: string) {
  const id = newId("h", 8);
  try {
    await run(db(), sql.insertHome, [id, authHash, name, Date.now()]);
  } catch (e: any) {
    if (e?.code === "ER_DUP_ENTRY") throw new ApiError(409, "already_registered", "This key is already registered. Use `agenttown login` instead.");
    throw e;
  }
  const home = publicHome((await one(db(), sql.homeById, [id]))!);
  bus.emit({ type: "home", home_id: id, data: home });
  return home;
}

export const homeByAuth = (authHash: string) => one(db(), sql.homeByAuth, [authHash]);
export const homeById = (id: string) => one(db(), sql.homeById, [id]);

export async function renameHome(id: string, name: string) {
  await run(db(), sql.renameHome, [name, id]);
  const home = publicHome((await one(db(), sql.homeById, [id]))!);
  bus.emit({ type: "home", home_id: id, data: home });
  return home;
}

/** Sets the home's look and queues dwelling generation; null clears look and art. Repeating the same look is a
 *  no-op unless the last generation failed (then it is queued again; the daily cap still applies). */
export async function setLook(id: string, look: string | null) {
  if (look === null) {
    await run(db(), "UPDATE homes SET look = NULL, art = NULL, art_status = 'none', art_error = NULL WHERE id = ?", [id]);
  } else {
    await run(db(), `UPDATE homes SET look = ?, art_status = 'pending', art_error = NULL
      WHERE id = ? AND NOT (look <=> ? AND art_status IN ('pending', 'ready'))`, [look, id, look]);
  }
  const home = publicHome((await one(db(), sql.homeById, [id]))!);
  bus.emit({ type: "home", home_id: id, data: home });
  return home;
}

// ---- personas ----

/** Finds or creates the persona inside a transaction. Bus events go to `emits` (sent after commit). */
async function ensurePersona(c: Q, homeId: string, name: string, kind: string, emits: BusEvent[]): Promise<Row> {
  const existing = await one(c, sql.personaByName, [homeId, name]);
  if (existing && existing.kind === kind) return existing;
  const res = await run(c, sql.upsertPersona, [newId("p"), homeId, name, kind, Date.now()]);
  const p = (await one(c, sql.personaByName, [homeId, name]))!;
  if (res.affectedRows === 1) { // newly created
    if ((await one(c, sql.countPersonas, [homeId]))!.n > LIMITS.personasPerHome) {
      throw new ApiError(429, "too_many_personas", `A home can have at most ${LIMITS.personasPerHome} personas.`);
    }
    emits.push({ type: "persona", home_id: homeId, data: publicPersona(p) });
  }
  return p;
}

export async function upsertPersona(homeId: string, name: string, kind: string, appearance: string | null) {
  const emits: BusEvent[] = [];
  const out = await tx(async (c) => {
    emits.length = 0;
    const p = await ensurePersona(c, homeId, name, kind, emits);
    if (appearance !== null && appearance !== p.appearance) await run(c, sql.setAppearance, [appearance, p.id]);
    return publicPersona((await one(c, sql.personaById, [homeId, p.id]))!);
  }, { retryDuplicate: true });
  for (const e of emits) bus.emit(e);
  bus.emit({ type: "persona", home_id: homeId, data: out });
  return out;
}

export const personasOfHome = async (homeId: string) =>
  (await all(db(), sql.personasOfHome, [homeId])).map(publicPersona);

// ---- reports ----

export type ReportInput = {
  persona: { name: string; kind: string };
  session: string;
  parent: string | null;
  status: Status;
  tool: string | null;
  task: { title_enc: string | null } | null;
};

// Lock order inside a report: homes (task_seq) → personas → sessions → stats. Keeping it fixed avoids deadlocks;
// tx() retries the rare one that remains (and duplicate-key races) from scratch.
export async function report(homeId: string, r: ReportInput) {
  const emits: BusEvent[] = [];
  const ended: string[] = [];
  const out = await tx(async (c) => {
    const now = Date.now();
    emits.length = 0;
    ended.length = 0;
    let newTaskNo: number | null = null;
    if (r.task) newTaskNo = (await run(c, sql.bumpTaskSeq, [homeId])).insertId;

    const persona = await ensurePersona(c, homeId, r.persona.name, r.persona.kind, emits);
    const parent = r.parent ? await one(c, sql.sessionByKey, [homeId, r.parent]) : undefined;

    const created = (await run(c, sql.ensureSession,
      [newId("s"), homeId, persona.id, r.session, parent?.id ?? null, now, now])).affectedRows === 1;
    const s = (await one(c, sql.sessionByKeyForUpdate, [homeId, r.session]))!;
    if (created || s.ended_at !== null) {
      if ((await one(c, sql.countOpenOthers, [homeId, s.id]))!.n >= LIMITS.activeSessionsPerHome) {
        throw new ApiError(429, "too_many_sessions", `At most ${LIMITS.activeSessionsPerHome} open sessions per home.`);
      }
    }

    let taskNo = s.task_no as number | null;
    let taskEnc = s.task_enc as string | null;
    if (r.task) {
      taskNo = newTaskNo;
      taskEnc = r.task.title_enc;
    }
    const tool = r.status === "tool" ? r.tool : null;
    const endedAt = r.status === "ended" ? now : null;
    await run(c, sql.updateSession, [persona.id, parent?.id ?? s.parent_id, r.status, tool, taskNo, taskEnc, now, now, endedAt, s.id]);
    await run(c, sql.insertEvent, [homeId, s.id, now, r.status, tool, taskNo]);

    if (!created && s.ended_at === null && BUSY.has(s.status)) {
      const gap = Math.min(now - s.last_seen, LIMITS.busyGapMs);
      if (gap > 0) await run(c, sql.addBusy, [homeId, day(now), gap]);
    }
    if (r.task) await run(c, sql.addTask, [homeId, day(now)]);
    if (tool) await run(c, sql.addTool, [homeId, day(now), tool]);

    if (r.status === "ended") await endTree(c, s.id, now, ended);
    return { session_id: s.id as string, task_no: taskNo };
  }, { retryDuplicate: true });
  for (const e of emits) bus.emit(e);
  await emitSession(out.session_id);
  for (const id of ended) await emitSession(id);
  return out;
}

// Ending a session also ends its open subagents, recursively.
async function endTree(c: Q, id: string, now: number, ended: string[]) {
  for (const ch of await all(c, sql.openChildren, [id])) {
    await run(c, sql.endSession, [now, ch.id]);
    ended.push(ch.id);
    await endTree(c, ch.id, now, ended);
  }
}

export const openSessionsOfHome = async (homeId: string) =>
  (await all(db(), sql.openSessionsOfHome, [homeId])).map(publicSession);

// Batch lookup for the town view: residents and their open sessions for the visible homes.
export async function town(homeIds: string[]) {
  const out = await Promise.all(homeIds.map(async (id) => {
    const h = await homeById(id);
    if (!h) return [];
    return [{
      id,
      home: publicHome(h), // includes look / dwelling art

      personas: await personasOfHome(id),
      agents: (await all(db(), sql.openSessionsOfHome, [id])).map(townAgent),
    }];
  }));
  return out.flat();
}

// ---- world / stats ----

const worldSql = `
  SELECT h.id, h.name, h.created_at,
    COUNT(s.id) AS open,
    COALESCE(SUM(s.status IN ('thinking', 'tool')), 0) AS busy
  FROM homes h LEFT JOIN sessions s ON s.home_id = h.id AND s.ended_at IS NULL
  GROUP BY h.id ORDER BY h.created_at LIMIT ? OFFSET ?`;
const totalsSql = `
  SELECT (SELECT COUNT(*) FROM homes) AS homes,
    (SELECT COUNT(*) FROM sessions WHERE ended_at IS NULL) AS open,
    (SELECT COUNT(*) FROM sessions WHERE ended_at IS NULL AND status IN ('thinking', 'tool')) AS busy`;

export async function world(limit: number, offset: number) {
  const [totals, homes] = await Promise.all([one(db(), totalsSql), all(db(), worldSql, [limit, offset])]);
  return { totals, homes };
}

const dailySql = "SELECT day, busy_ms, tasks FROM daily_stats WHERE home_id = ? AND day >= ? ORDER BY day";
const toolsSql = `
  SELECT tool, SUM(count) AS count FROM tool_stats WHERE home_id = ? AND day >= ?
  GROUP BY tool ORDER BY count DESC LIMIT 20`;
const eventsSql = `
  SELECT e.session_id, s.persona_id, e.ts, e.status, e.tool, e.task_no
  FROM events e LEFT JOIN sessions s ON s.id = e.session_id
  WHERE e.home_id = ? AND e.ts < ? ORDER BY e.ts DESC, e.id DESC LIMIT ?`;

export async function stats(homeId: string, days: number) {
  const since = day(Date.now() - (days - 1) * 86400_000);
  const [daily, tools] = await Promise.all([all(db(), dailySql, [homeId, since]), all(db(), toolsSql, [homeId, since])]);
  return { daily, tools };
}

export const events = (homeId: string, before: number, limit: number) =>
  all(db(), eventsSql, [homeId, before, limit]);

// ---- maintenance ----

export async function sweep() {
  const now = Date.now();
  const stale = await all(db(), sql.staleSessions, [now - LIMITS.busyTimeoutMs, now - LIMITS.idleTimeoutMs]);
  const ended: string[] = [];
  await tx(async (c) => {
    ended.length = 0;
    for (const s of stale) {
      await run(c, sql.endSession, [now, s.id]);
      ended.push(s.id);
      await endTree(c, s.id, now, ended);
    }
    await run(c, "DELETE FROM events WHERE ts < ?", [now - LIMITS.retentionMs]);
    await run(c, "DELETE FROM sessions WHERE ended_at IS NOT NULL AND ended_at < ?", [now - LIMITS.retentionMs]);
  });
  for (const id of ended) await emitSession(id);
  return ended.length;
}
