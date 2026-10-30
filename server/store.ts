import { db, tx } from "./db.ts";
import { bus } from "./bus.ts";
import { LIMITS } from "./config.ts";
import { ApiError, newId } from "./util.ts";

export const STATUSES = ["thinking", "tool", "waiting", "idle", "ended"] as const;
export type Status = (typeof STATUSES)[number];
const BUSY = new Set<string>(["thinking", "tool"]);

type Row = Record<string, any>;
const day = (t: number) => new Date(t).toISOString().slice(0, 10);

const q = {
  homeByAuth: db.prepare("SELECT id, name, created_at FROM homes WHERE auth_hash = ?"),
  homeById: db.prepare("SELECT id, name, created_at FROM homes WHERE id = ?"),
  insertHome: db.prepare("INSERT INTO homes (id, auth_hash, name, created_at) VALUES (?, ?, ?, ?)"),
  renameHome: db.prepare("UPDATE homes SET name = ? WHERE id = ?"),
  bumpTaskSeq: db.prepare("UPDATE homes SET task_seq = task_seq + 1 WHERE id = ? RETURNING task_seq"),

  personaByName: db.prepare("SELECT * FROM personas WHERE home_id = ? AND name = ?"),
  personaById: db.prepare("SELECT * FROM personas WHERE home_id = ? AND id = ?"),
  personasOfHome: db.prepare("SELECT * FROM personas WHERE home_id = ? ORDER BY created_at"),
  countPersonas: db.prepare("SELECT COUNT(*) AS n FROM personas WHERE home_id = ?"),
  insertPersona: db.prepare(
    "INSERT INTO personas (id, home_id, name, kind, created_at) VALUES (?, ?, ?, ?, ?)",
  ),
  setPersonaKind: db.prepare("UPDATE personas SET kind = ? WHERE id = ?"),
  setAppearance: db.prepare(
    "UPDATE personas SET appearance = ?, sprite_status = 'pending' WHERE id = ?",
  ),

  sessionByKey: db.prepare("SELECT * FROM sessions WHERE home_id = ? AND ext_key = ?"),
  sessionById: db.prepare("SELECT * FROM sessions WHERE id = ?"),
  openSessionsOfHome: db.prepare(
    "SELECT * FROM sessions WHERE home_id = ? AND ended_at IS NULL ORDER BY started_at",
  ),
  countOpen: db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE home_id = ? AND ended_at IS NULL"),
  insertSession: db.prepare(`
    INSERT INTO sessions (id, home_id, persona_id, ext_key, parent_id, status, started_at, last_seen)
    VALUES (?, ?, ?, ?, ?, 'idle', ?, ?)`),
  updateSession: db.prepare(`
    UPDATE sessions SET persona_id = ?, parent_id = ?, status = ?, tool = ?, task_no = ?, task_enc = ?,
      last_seen = ?, ended_at = ?, started_at = CASE WHEN ended_at IS NULL THEN started_at ELSE ? END
    WHERE id = ?`),
  openChildren: db.prepare("SELECT id FROM sessions WHERE parent_id = ? AND ended_at IS NULL"),
  endSession: db.prepare(
    "UPDATE sessions SET status = 'ended', tool = NULL, ended_at = ? WHERE id = ? AND ended_at IS NULL",
  ),
  staleSessions: db.prepare(`
    SELECT id FROM sessions WHERE ended_at IS NULL AND (
      (status IN ('thinking', 'tool') AND last_seen < ?) OR
      (status NOT IN ('thinking', 'tool') AND last_seen < ?))`),

  insertEvent: db.prepare(
    "INSERT INTO events (home_id, session_id, ts, status, tool, task_no) VALUES (?, ?, ?, ?, ?, ?)",
  ),
  addBusy: db.prepare(`
    INSERT INTO daily_stats (home_id, day, busy_ms) VALUES (?, ?, ?)
    ON CONFLICT (home_id, day) DO UPDATE SET busy_ms = busy_ms + excluded.busy_ms`),
  addTask: db.prepare(`
    INSERT INTO daily_stats (home_id, day, tasks) VALUES (?, ?, 1)
    ON CONFLICT (home_id, day) DO UPDATE SET tasks = tasks + 1`),
  addTool: db.prepare(`
    INSERT INTO tool_stats (home_id, day, tool, count) VALUES (?, ?, ?, 1)
    ON CONFLICT (home_id, day, tool) DO UPDATE SET count = count + 1`),
};

// ---- public shapes (what anyone may see) ----

export const publicHome = (h: Row) => ({ id: h.id, name: h.name, created_at: h.created_at });

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

function emitSession(id: string) {
  const s = q.sessionById.get(id) as Row | undefined;
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
    const s = q.sessionById.get(id) as Row | undefined;
    if (s) bus.emit({ type: "agent", home_id: s.home_id, data: townAgent(s) });
  }, 2000);
}

// The town view only needs per-home counts; coalesce them to at most one event per home per second.
const countsStmt = db.prepare(`
  SELECT COUNT(*) AS open, COALESCE(SUM(status IN ('thinking', 'tool')), 0) AS busy
  FROM sessions WHERE home_id = ? AND ended_at IS NULL`);
const countsPending = new Map<string, NodeJS.Timeout>();
function scheduleCounts(homeId: string) {
  if (countsPending.has(homeId)) return;
  countsPending.set(homeId, setTimeout(() => {
    countsPending.delete(homeId);
    const c = countsStmt.get(homeId) as { open: number; busy: number };
    bus.emit({ type: "counts", home_id: homeId, data: { open: c.open, busy: c.busy } });
  }, 1000));
}

// ---- homes ----

export function createHome(authHash: string, name: string) {
  const id = newId("h", 8);
  try {
    q.insertHome.run(id, authHash, name, Date.now());
  } catch (e: any) {
    if (String(e.message).includes("UNIQUE")) throw new ApiError(409, "already_registered", "This key is already registered. Use `agenttown login` instead.");
    throw e;
  }
  const home = publicHome(q.homeById.get(id) as Row);
  bus.emit({ type: "home", home_id: id, data: home });
  return home;
}

export const homeByAuth = (authHash: string) => q.homeByAuth.get(authHash) as Row | undefined;
export const homeById = (id: string) => q.homeById.get(id) as Row | undefined;

export function renameHome(id: string, name: string) {
  q.renameHome.run(name, id);
  const home = publicHome(q.homeById.get(id) as Row);
  bus.emit({ type: "home", home_id: id, data: home });
  return home;
}

// ---- personas ----

function ensurePersona(homeId: string, name: string, kind: string): Row {
  const existing = q.personaByName.get(homeId, name) as Row | undefined;
  if (existing) {
    if (existing.kind !== kind) q.setPersonaKind.run(kind, existing.id);
    return { ...existing, kind };
  }
  if ((q.countPersonas.get(homeId) as Row).n >= LIMITS.personasPerHome) {
    throw new ApiError(429, "too_many_personas", `A home can have at most ${LIMITS.personasPerHome} personas.`);
  }
  const id = newId("p");
  q.insertPersona.run(id, homeId, name, kind, Date.now());
  const p = q.personaById.get(homeId, id) as Row;
  bus.emit({ type: "persona", home_id: homeId, data: publicPersona(p) });
  return p;
}

export function upsertPersona(homeId: string, name: string, kind: string, appearance: string | null) {
  return tx(() => {
    const p = ensurePersona(homeId, name, kind);
    if (appearance !== null && appearance !== p.appearance) q.setAppearance.run(appearance, p.id);
    const out = publicPersona(q.personaById.get(homeId, p.id) as Row);
    bus.emit({ type: "persona", home_id: homeId, data: out });
    return out;
  });
}

export const personasOfHome = (homeId: string) =>
  (q.personasOfHome.all(homeId) as Row[]).map(publicPersona);

// ---- reports ----

export type ReportInput = {
  persona: { name: string; kind: string };
  session: string;
  parent: string | null;
  status: Status;
  tool: string | null;
  task: { title_enc: string | null } | null;
};

export function report(homeId: string, r: ReportInput) {
  const now = Date.now();
  const ended: string[] = [];
  const out = tx(() => {
    const persona = ensurePersona(homeId, r.persona.name, r.persona.kind);
    const parent = r.parent ? (q.sessionByKey.get(homeId, r.parent) as Row | undefined) : undefined;

    let s = q.sessionByKey.get(homeId, r.session) as Row | undefined;
    if (!s || s.ended_at !== null) {
      if ((q.countOpen.get(homeId) as Row).n >= LIMITS.activeSessionsPerHome) {
        throw new ApiError(429, "too_many_sessions", `At most ${LIMITS.activeSessionsPerHome} open sessions per home.`);
      }
    }
    if (!s) {
      const id = newId("s");
      q.insertSession.run(id, homeId, persona.id, r.session, parent?.id ?? null, now, now);
      s = q.sessionById.get(id) as Row;
    } else if (s.ended_at === null && BUSY.has(s.status)) {
      const gap = Math.min(now - s.last_seen, LIMITS.busyGapMs);
      if (gap > 0) q.addBusy.run(homeId, day(now), gap);
    }

    let taskNo = s.task_no as number | null;
    let taskEnc = s.task_enc as string | null;
    if (r.task) {
      taskNo = (q.bumpTaskSeq.get(homeId) as Row).task_seq;
      taskEnc = r.task.title_enc;
      q.addTask.run(homeId, day(now));
    }
    const tool = r.status === "tool" ? r.tool : null;
    const endedAt = r.status === "ended" ? now : null;
    q.updateSession.run(persona.id, parent?.id ?? s.parent_id, r.status, tool, taskNo, taskEnc, now, endedAt, now, s.id);
    q.insertEvent.run(homeId, s.id, now, r.status, tool, taskNo);
    if (tool) q.addTool.run(homeId, day(now), tool);

    if (r.status === "ended") endTree(s.id, now, ended);
    return { session_id: s.id as string, task_no: taskNo };
  });
  emitSession(out.session_id);
  for (const id of ended) emitSession(id);
  return out;
}

// Ending a session also ends its open subagents, recursively.
function endTree(id: string, now: number, ended: string[]) {
  for (const c of q.openChildren.all(id) as Row[]) {
    q.endSession.run(now, c.id);
    ended.push(c.id);
    endTree(c.id, now, ended);
  }
}

export const openSessionsOfHome = (homeId: string) =>
  (q.openSessionsOfHome.all(homeId) as Row[]).map(publicSession);

// Batch lookup for the town view: residents and their open sessions for the visible homes.
export function town(homeIds: string[]) {
  return homeIds.flatMap((id) => {
    if (!q.homeById.get(id)) return [];
    return [{
      id,
      personas: personasOfHome(id),
      agents: (q.openSessionsOfHome.all(id) as Row[]).map(townAgent),
    }];
  });
}

// ---- world / stats ----

const worldStmt = db.prepare(`
  SELECT h.id, h.name, h.created_at,
    COUNT(s.id) AS open,
    COALESCE(SUM(s.status IN ('thinking', 'tool')), 0) AS busy
  FROM homes h LEFT JOIN sessions s ON s.home_id = h.id AND s.ended_at IS NULL
  GROUP BY h.id ORDER BY h.created_at LIMIT ? OFFSET ?`);
const totalsStmt = db.prepare(`
  SELECT (SELECT COUNT(*) FROM homes) AS homes,
    (SELECT COUNT(*) FROM sessions WHERE ended_at IS NULL) AS open,
    (SELECT COUNT(*) FROM sessions WHERE ended_at IS NULL AND status IN ('thinking', 'tool')) AS busy`);

export function world(limit: number, offset: number) {
  return { totals: totalsStmt.get(), homes: worldStmt.all(limit, offset) };
}

const dailyStmt = db.prepare(
  "SELECT day, busy_ms, tasks FROM daily_stats WHERE home_id = ? AND day >= ? ORDER BY day",
);
const toolsStmt = db.prepare(`
  SELECT tool, SUM(count) AS count FROM tool_stats WHERE home_id = ? AND day >= ?
  GROUP BY tool ORDER BY count DESC LIMIT 20`);
const eventsStmt = db.prepare(`
  SELECT e.session_id, s.persona_id, e.ts, e.status, e.tool, e.task_no
  FROM events e LEFT JOIN sessions s ON s.id = e.session_id
  WHERE e.home_id = ? AND e.ts < ? ORDER BY e.ts DESC LIMIT ?`);

export function stats(homeId: string, days: number) {
  const since = day(Date.now() - (days - 1) * 86400_000);
  return { daily: dailyStmt.all(homeId, since), tools: toolsStmt.all(homeId, since) };
}

export const events = (homeId: string, before: number, limit: number) =>
  eventsStmt.all(homeId, before, limit);

// ---- maintenance ----

const pruneEvents = db.prepare("DELETE FROM events WHERE ts < ?");
const pruneSessions = db.prepare("DELETE FROM sessions WHERE ended_at IS NOT NULL AND ended_at < ?");

export function sweep() {
  const now = Date.now();
  const stale = q.staleSessions.all(now - LIMITS.busyTimeoutMs, now - LIMITS.idleTimeoutMs) as Row[];
  const ended: string[] = [];
  tx(() => {
    for (const s of stale) {
      q.endSession.run(now, s.id);
      ended.push(s.id);
      endTree(s.id, now, ended);
    }
    pruneEvents.run(now - LIMITS.retentionMs);
    pruneSessions.run(now - LIMITS.retentionMs);
  });
  for (const id of ended) emitSession(id);
  return ended.length;
}
