import { db, tx, all, one, run, type Q, type Row } from "./db.ts";
import { bus, type BusEvent } from "./bus.ts";
import { LIMITS } from "./config.ts";
import { ApiError, newId } from "./util.ts";

export const STATUSES = ["thinking", "tool", "waiting", "idle", "ended"] as const;
export type Status = (typeof STATUSES)[number];
const BUSY = new Set<string>(["thinking", "tool"]);

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

const sql = {
  homeByAuth: "SELECT id, slot, name, created_at, dwelling, style, description FROM homes WHERE auth_hash = ?",
  homeById: "SELECT id, slot, name, created_at, dwelling, style, description, look, art, art_status, art_error FROM homes WHERE id = ?",
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
  id: h.id, slot: h.slot, name: h.name, created_at: h.created_at, dwelling: h.dwelling ?? null,
  style: h.style ?? null, description: h.description ?? null,
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
      ...publicHome(h), // includes slot, dwelling/style and the dwelling art
      personas: await personasOfHome(id),
      agents: (await all(db(), sql.openSessionsOfHome, [id])).map(townAgent),
      says: await recentSays(id, 5),
    }];
  }));
  return out.flat();
}

// ---- world / stats ----

const worldSql = `
  SELECT h.id, h.slot, h.name, h.created_at, h.dwelling, h.style, h.description,
    COUNT(s.id) AS open,
    COALESCE(SUM(s.status IN ('thinking', 'tool')), 0) AS busy
  FROM homes h LEFT JOIN sessions s ON s.home_id = h.id AND s.ended_at IS NULL
  GROUP BY h.id ORDER BY h.slot LIMIT ? OFFSET ?`;
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

// =====================================================================================================
// ---- free town: home customization, says, retiring & the cemetery ----
// (kept in its own section to ease merging with avatar/sprite work)
// =====================================================================================================

export const DWELLINGS = [
  "house", "cottage", "fenced-yard", "garden", "tent", "treehouse", "burrow", "greenhouse", "pond", "shed",
  "lighthouse", "cave", "mushroom-ring", "boat",
] as const;
export const STYLES = ["pixel", "flat", "sketch", "watercolor", "lowpoly", "blueprint", "neon", "storybook"] as const;

export type HomePatch = { name?: string; dwelling?: string | null; style?: string | null; description?: string | null };

export async function customizeHome(id: string, patch: HomePatch) {
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const k of ["name", "dwelling", "style", "description"] as const) {
    if (patch[k] !== undefined) { cols.push(`${k} = ?`); vals.push(patch[k]); }
  }
  if (cols.length) await run(db(), `UPDATE homes SET ${cols.join(", ")} WHERE id = ?`, [...vals, id]);
  const home = publicHome((await one(db(), sql.homeById, [id]))!);
  bus.emit({ type: "home", home_id: id, data: home });
  return home;
}

// -- says: short public status posts by a persona --

export const SAYS_KEPT = 50;
const saysSql = {
  insert: "INSERT INTO says (home_id, persona_id, text, ts) VALUES (?, ?, ?, ?)",
  // Keep the newest SAYS_KEPT per home. The derived table sidesteps MySQL's "no LIMIT in IN-subquery" rule.
  prune: `
    DELETE FROM says WHERE home_id = ? AND id <= (
      SELECT id FROM (SELECT id FROM says WHERE home_id = ? ORDER BY id DESC LIMIT 1 OFFSET ${SAYS_KEPT}) x)`,
  recent: "SELECT CAST(id AS CHAR) AS id, persona_id, text, ts FROM says WHERE home_id = ? ORDER BY id DESC LIMIT ?",
};

/** Posts a say for an existing persona. `check(personaId)` runs before the insert (rate limits). */
export async function say(homeId: string, personaName: string, text: string, check: (personaId: string) => void) {
  const p = await one(db(), sql.personaByName, [homeId, personaName]);
  if (!p) throw new ApiError(404, "unknown_persona", "No persona with that name in this home. Create it first (`agenttown persona`).");
  check(p.id);
  const ts = Date.now();
  const ins = await run(db(), saysSql.insert, [homeId, p.id, text, ts]);
  await run(db(), saysSql.prune, [homeId, homeId]);
  const out = { id: String(ins.insertId), persona_id: p.id as string, text, ts };
  bus.emit({ type: "say", home_id: homeId, data: out });
  return out;
}

export const recentSays = (homeId: string, limit = 10) => all(db(), saysSql.recent, [homeId, limit]);

// -- tombstones --

export const publicTombstone = (t: Row) => ({
  id: t.id,
  home_id: t.home_id,
  persona_id: t.persona_id,
  name: t.name,
  kind: t.kind,
  home_name: t.home_name,
  appearance: t.appearance,
  sprite: t.sprite ? JSON.parse(t.sprite) : null,
  born_at: t.born_at,
  died_at: t.died_at,
  epitaph: t.epitaph,
});

const graveSql = {
  insert: `
    INSERT INTO tombstones (id, home_id, persona_id, name, kind, home_name, appearance, sprite, born_at, died_at, epitaph)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  list: "SELECT * FROM tombstones ORDER BY died_at DESC, id DESC LIMIT ? OFFSET ?",
  count: "SELECT COUNT(*) AS n FROM tombstones",
};

async function bury(c: Q, home: Row, p: Row | null, now: number, epitaph: string | null) {
  const t = {
    id: newId("t"), home_id: home.id, persona_id: p?.id ?? null, name: p?.name ?? home.name, kind: p?.kind ?? "home",
    home_name: home.name, appearance: p?.appearance ?? null, sprite: p?.sprite ?? null,
    born_at: p?.created_at ?? home.created_at, died_at: now, epitaph,
  };
  await run(c, graveSql.insert, [t.id, t.home_id, t.persona_id, t.name, t.kind, t.home_name, t.appearance, t.sprite,
    t.born_at, t.died_at, t.epitaph]);
  return publicTombstone(t);
}

export async function cemetery(limit: number, offset: number) {
  const [count, rows] = await Promise.all([one(db(), graveSql.count), all(db(), graveSql.list, [limit, offset])]);
  return { total: count!.n as number, tombstones: rows.map(publicTombstone) };
}

// A session row that no longer exists (deleted with its persona): tell both feeds it ended.
function emitGone(s: Row) {
  bus.emit({ type: "session", home_id: s.home_id, data: { ...publicSession(s), status: "ended", tool: null } });
  bus.emit({ type: "agent", home_id: s.home_id, data: { ...townAgent(s), status: "ended", tool: null } });
}

/** Ends the persona's open sessions (and their subagents), buries it and deletes it. */
export async function retirePersona(homeId: string, ref: { id?: string; name?: string }, epitaph: string | null) {
  const ended: string[] = [];
  let gone: Row[] = [];
  const stone = await tx(async (c) => {
    ended.length = 0;
    const home = (await one(c, "SELECT * FROM homes WHERE id = ? FOR UPDATE", [homeId]))!;
    const p = ref.id
      ? await one(c, "SELECT * FROM personas WHERE home_id = ? AND id = ? FOR UPDATE", [homeId, ref.id])
      : await one(c, "SELECT * FROM personas WHERE home_id = ? AND name = ? FOR UPDATE", [homeId, ref.name ?? ""]);
    if (!p) throw new ApiError(404, "not_found", "No such persona in this home.");
    const now = Date.now();
    for (const s of await all(c, "SELECT id FROM sessions WHERE persona_id = ? AND ended_at IS NULL", [p.id])) {
      await run(c, sql.endSession, [now, s.id]);
      ended.push(s.id);
      await endTree(c, s.id, now, ended);
    }
    gone = ended.length ? await all(c, "SELECT * FROM sessions WHERE id IN (?) AND persona_id = ?", [ended, p.id]) : [];
    const t = await bury(c, home, p, now, epitaph);
    await run(c, "DELETE FROM events WHERE session_id IN (SELECT id FROM sessions WHERE persona_id = ?)", [p.id]);
    await run(c, "DELETE FROM personas WHERE id = ?", [p.id]); // cascades sessions, says
    return t;
  });
  const goneIds = new Set(gone.map((s) => s.id));
  for (const s of gone) emitGone(s);
  for (const id of ended) if (!goneIds.has(id)) await emitSession(id); // other personas' subagents
  if (ended.length) scheduleCounts(homeId);
  bus.emit({ type: "tombstone", home_id: homeId, data: stone });
  return stone;
}

/** Buries every persona (or the home itself if empty) and deletes the home and everything under it. */
export async function deleteHome(homeId: string, epitaph: string | null) {
  const stones = await tx(async (c) => {
    const home = await one(c, "SELECT * FROM homes WHERE id = ? FOR UPDATE", [homeId]);
    if (!home) throw new ApiError(404, "not_found", "No such home.");
    const now = Date.now();
    const personas = await all(c, "SELECT * FROM personas WHERE home_id = ? ORDER BY created_at", [homeId]);
    const out = [];
    for (const p of personas.length ? personas : [null]) out.push(await bury(c, home, p, now, epitaph));
    for (const t of ["events", "daily_stats", "tool_stats", "avatar_usage"]) {
      await run(c, `DELETE FROM ${t} WHERE home_id = ?`, [homeId]);
    }
    // Cascades personas, sessions, says, invites, devices. The auth hash goes with it.
    await run(c, "DELETE FROM homes WHERE id = ?", [homeId]);
    return out;
  });
  clearTimeout(countsPending.get(homeId));
  countsPending.delete(homeId);
  for (const t of stones) bus.emit({ type: "tombstone", home_id: homeId, data: t });
  bus.emit({ type: "home_removed", home_id: homeId, data: {} });
  return stones;
}

// =====================================================================================================
// ---- invites & device credentials ----
// An invite carries the home's enc_key wrapped under a key derived from a secret that only the invite code
// holder has; the server stores the opaque blob and hands it out once. Devices authenticate with their own
// token (sha256 stored), never with the owner key.
// =====================================================================================================

export type Auth = {
  home: Row; scope: "owner" | "device"; device_id: string | null; rekey_blob: string | null;
};

const devSql = {
  byAuth: `
    SELECT d.id AS device_id, d.last_seen_at, d.needs_rekey, d.rekey_blob, h.id, h.slot, h.name, h.created_at, h.dwelling, h.style, h.description
    FROM devices d JOIN homes h ON h.id = d.home_id WHERE d.auth_hash = ? AND d.revoked_at IS NULL`,
  touch: "UPDATE devices SET last_seen_at = ? WHERE id = ?",
  insertInvite: "INSERT INTO invites (id, home_id, kind, blob_enc, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  openInvites: "SELECT COUNT(*) AS n FROM invites WHERE home_id = ? AND used_at IS NULL AND expires_at > ?",
  inviteForUpdate: "SELECT * FROM invites WHERE id = ? FOR UPDATE",
  useInvite: "UPDATE invites SET used_at = ? WHERE id = ?",
  insertDevice: "INSERT INTO devices (id, home_id, auth_hash, label, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
  activeDevices: "SELECT COUNT(*) AS n FROM devices WHERE home_id = ? AND revoked_at IS NULL",
  list: "SELECT id, label, created_at, last_seen_at, revoked_at FROM devices WHERE home_id = ? ORDER BY created_at",
  revoke: "UPDATE devices SET revoked_at = ? WHERE home_id = ? AND id = ? AND revoked_at IS NULL",
};

export const DEVICE_LIMIT = 50;

export async function authByHash(hash: string): Promise<Auth | null> {
  const owner = await homeByAuth(hash);
  if (owner) return { home: owner, scope: "owner", device_id: null, rekey_blob: null };
  const d = await one(db(), devSql.byAuth, [hash]);
  if (!d) return null;
  const now = Date.now();
  if (!d.last_seen_at || now - d.last_seen_at > 60_000) {
    run(db(), devSql.touch, [now, d.device_id]).catch(logErr("device touch failed"));
  }
  return { home: d, scope: "device", device_id: d.device_id, rekey_blob: d.needs_rekey ? d.rekey_blob : null };
}

export async function createInvite(homeId: string, kind: "join" | "merge", blob: string, label: string | null, ttlMs: number) {
  const now = Date.now();
  if ((await one(db(), devSql.openInvites, [homeId, now]))!.n >= 10) {
    throw new ApiError(429, "too_many_invites", "Too many open invites; wait for them to expire.");
  }
  const id = newId("i", 8).slice(2);
  await run(db(), devSql.insertInvite, [id, homeId, kind, blob, label, now, now + ttlMs]);
  return { id, kind, expires_at: now + ttlMs };
}

export async function redeemInvite(id: string, authHash: string, label: string | null) {
  return tx(async (c) => {
    const inv = await one(c, devSql.inviteForUpdate, [id]);
    const now = Date.now();
    if (!inv || inv.kind !== "join") throw new ApiError(404, "invite_not_found", "No such join invite.");
    if (inv.used_at !== null) throw new ApiError(410, "invite_used", "This invite was already used. Ask for a new one.");
    if (inv.expires_at <= now) throw new ApiError(410, "invite_expired", "This invite expired. Ask for a new one.");
    if ((await one(c, devSql.activeDevices, [inv.home_id]))!.n >= DEVICE_LIMIT) {
      throw new ApiError(429, "too_many_devices", `A home can have at most ${DEVICE_LIMIT} devices.`);
    }
    const deviceId = newId("d");
    try {
      await run(c, devSql.insertDevice, [deviceId, inv.home_id, authHash, label ?? inv.label, now, now]);
    } catch (e: any) {
      if (e?.code === "ER_DUP_ENTRY") throw new ApiError(409, "token_in_use", "That device token is already registered.");
      throw e;
    }
    await run(c, devSql.useInvite, [now, id]);
    const home = (await one(c, sql.homeById, [inv.home_id]))!;
    return { blob: inv.blob_enc as string, home: { id: home.id, name: home.name }, device_id: deviceId };
  });
}

export const listDevices = (homeId: string) => all(db(), devSql.list, [homeId]);

export async function revokeDevice(homeId: string, id: string) {
  const r = await run(db(), devSql.revoke, [Date.now(), homeId, id]);
  if (!r.affectedRows) throw new ApiError(404, "not_found", "No such active device.");
}

// =====================================================================================================
// ---- merging homes: B (the caller, owner scope) moves into A (who issued a merge invite) ----
// =====================================================================================================

export type MergeOutcome = { id: string; from_name: string; name: string; action: "moved" | "renamed" | "merged" };

/** Picks a name ≤ 32 chars that is not in `taken`. */
function freeName(base: string, suffix: string, taken: Set<string>) {
  for (let i = 1; ; i++) {
    const tail = i === 1 ? ` (${suffix})` : ` (${suffix} ${i})`;
    const name = [...base].slice(0, Math.max(1, 32 - [...tail].length)).join("") + tail;
    const cut = [...name].slice(0, 32).join("");
    if (!taken.has(cut)) return cut;
  }
}

// Sum B's per-day counters into A's (INSERT … SELECT from a derived table, then drop B's rows).
const mergeStatsSql = [
  `INSERT INTO daily_stats (home_id, day, busy_ms, tasks)
     SELECT * FROM (SELECT ? AS home_id, day, busy_ms, tasks FROM daily_stats WHERE home_id = ?) AS b
   ON DUPLICATE KEY UPDATE busy_ms = daily_stats.busy_ms + b.busy_ms, tasks = daily_stats.tasks + b.tasks`,
  `INSERT INTO tool_stats (home_id, day, tool, count)
     SELECT * FROM (SELECT ? AS home_id, day, tool, count FROM tool_stats WHERE home_id = ?) AS b
   ON DUPLICATE KEY UPDATE count = tool_stats.count + b.count`,
  `INSERT INTO avatar_usage (home_id, day, count)
     SELECT * FROM (SELECT ? AS home_id, day, count FROM avatar_usage WHERE home_id = ?) AS b
   ON DUPLICATE KEY UPDATE count = avatar_usage.count + b.count`,
];

export async function mergeHomes(inviteId: string, bId: string, rekeyBlob: string, onConflict: "merge" | "rename") {
  const result = await tx(async (c) => {
    const inv = await one(c, devSql.inviteForUpdate, [inviteId]);
    const now = Date.now();
    if (!inv || inv.kind !== "merge") throw new ApiError(404, "invite_not_found", "No such merge invite.");
    if (inv.used_at !== null) throw new ApiError(410, "invite_used", "This invite was already used. Ask for a new one.");
    if (inv.expires_at <= now) throw new ApiError(410, "invite_expired", "This invite expired. Ask for a new one.");
    const aId = inv.home_id as string;
    if (aId === bId) throw new ApiError(400, "same_home", "That invite is for this very home.");
    // Lock both homes in a fixed order.
    const locked = await all(c, "SELECT * FROM homes WHERE id IN (?, ?) ORDER BY id FOR UPDATE", [aId, bId]);
    const A = locked.find((h) => h.id === aId), B = locked.find((h) => h.id === bId);
    if (!A || !B) throw new ApiError(404, "not_found", "Home not found.");

    const aPersonas = await all(c, "SELECT * FROM personas WHERE home_id = ? FOR UPDATE", [aId]);
    const bPersonas = await all(c, "SELECT * FROM personas WHERE home_id = ? ORDER BY created_at FOR UPDATE", [bId]);
    const byName = new Map(aPersonas.map((p) => [p.name as string, p]));
    const taken = new Set(aPersonas.map((p) => p.name as string));
    const outcomes: MergeOutcome[] = [];
    let added = 0;
    for (const p of bPersonas) {
      const clash = byName.get(p.name);
      if (clash && onConflict === "merge" && clash.kind === p.kind) {
        await run(c, "UPDATE sessions SET persona_id = ? WHERE persona_id = ?", [clash.id, p.id]);
        await run(c, "UPDATE says SET persona_id = ? WHERE persona_id = ?", [clash.id, p.id]);
        if (!clash.sprite && p.sprite) {
          await run(c, "UPDATE personas SET appearance = ?, sprite = ?, sprite_status = ?, sprite_error = ? WHERE id = ?",
            [p.appearance, p.sprite, p.sprite_status, p.sprite_error, clash.id]);
        }
        await run(c, "DELETE FROM personas WHERE id = ?", [p.id]);
        outcomes.push({ id: clash.id, from_name: p.name, name: clash.name, action: "merged" });
        continue;
      }
      const name = clash ? freeName(p.name, B.name, taken) : p.name;
      taken.add(name);
      added++;
      await run(c, "UPDATE personas SET home_id = ?, name = ? WHERE id = ?", [aId, name, p.id]);
      outcomes.push({ id: p.id, from_name: p.name, name, action: clash ? "renamed" : "moved" });
    }
    if (aPersonas.length + added > LIMITS.personasPerHome) {
      throw new ApiError(409, "too_many_personas", `The merged home would have more than ${LIMITS.personasPerHome} personas; retire some first.`);
    }

    // Sessions: titles were encrypted under B's key, which A's owner cannot read — drop them.
    const clashes = await all(c, `
      SELECT b.id, b.ext_key FROM sessions b JOIN sessions a ON a.home_id = ? AND a.ext_key = b.ext_key
      WHERE b.home_id = ?`, [aId, bId]);
    for (const s of clashes) await run(c, "UPDATE sessions SET ext_key = ? WHERE id = ?", [`m-${s.id}`, s.id]);
    await run(c, "UPDATE sessions SET home_id = ?, task_enc = NULL WHERE home_id = ?", [aId, bId]);
    await run(c, "UPDATE says SET home_id = ? WHERE home_id = ?", [aId, bId]);
    await run(c, "UPDATE events SET home_id = ? WHERE home_id = ?", [aId, bId]);
    for (const q of mergeStatsSql) await run(c, q, [aId, bId]);
    for (const t of ["daily_stats", "tool_stats", "avatar_usage"]) await run(c, `DELETE FROM ${t} WHERE home_id = ?`, [bId]);

    // B's devices and B's owner key become devices of A that must pick up A's enc_key (rekey_blob).
    await run(c, "UPDATE devices SET home_id = ?, needs_rekey = 1, rekey_blob = ? WHERE home_id = ?", [aId, rekeyBlob, bId]);
    const ownerDevice = newId("d");
    await run(c, `INSERT INTO devices (id, home_id, auth_hash, label, created_at, last_seen_at, needs_rekey, rekey_blob)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)`, [ownerDevice, aId, B.auth_hash, cleanLabel(`${B.name} (merged)`), now, now, rekeyBlob]);
    await run(c, "DELETE FROM invites WHERE home_id = ?", [bId]);
    await run(c, "DELETE FROM homes WHERE id = ?", [bId]);
    await run(c, devSql.useInvite, [now, inviteId]);
    await run(c, saysSql.prune, [aId, aId]);

    const personas = (await all(c, "SELECT * FROM personas WHERE id IN (?)", [outcomes.length ? outcomes.map((o) => o.id) : [""]]))
      .map(publicPersona);
    return { A, B, outcomes, personas, ownerDevice };
  });
  clearTimeout(countsPending.get(bId));
  countsPending.delete(bId);
  bus.emit({ type: "home_removed", home_id: bId, data: { merged_into: result.A.id } });
  const home = publicHome((await one(db(), sql.homeById, [result.A.id]))!);
  bus.emit({ type: "home", home_id: home.id, data: home });
  for (const p of result.personas) bus.emit({ type: "persona", home_id: home.id, data: p });
  scheduleCounts(home.id);
  return { home, merged_from: result.B.id, personas: result.outcomes, device_id: result.ownerDevice };
}

const cleanLabel = (s: string) => [...s].slice(0, 40).join("");

export async function clearRekey(deviceId: string) {
  await run(db(), "UPDATE devices SET needs_rekey = 0, rekey_blob = NULL WHERE id = ?", [deviceId]);
}

/** A merge invite's public bits + blob (useless without the secret in the code). Join invites are not peekable. */
export async function peekInvite(id: string) {
  const inv = await one(db(), "SELECT * FROM invites WHERE id = ?", [id]);
  if (!inv || inv.kind !== "merge") throw new ApiError(404, "invite_not_found", "No such merge invite.");
  if (inv.used_at !== null) throw new ApiError(410, "invite_used", "This invite was already used. Ask for a new one.");
  if (inv.expires_at <= Date.now()) throw new ApiError(410, "invite_expired", "This invite expired. Ask for a new one.");
  const home = (await one(db(), sql.homeById, [inv.home_id]))!;
  return { id: inv.id, kind: inv.kind, home: { id: home.id, name: home.name }, blob: inv.blob_enc, expires_at: inv.expires_at };
}
