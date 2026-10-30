import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DB_PATH } from "./config.ts";

if (DB_PATH !== ":memory:") mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 3000;

CREATE TABLE IF NOT EXISTS homes (
  id         TEXT PRIMARY KEY,
  auth_hash  TEXT NOT NULL UNIQUE,     -- sha256(auth_token); the owner key never reaches us
  name       TEXT NOT NULL,
  task_seq   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS personas (
  id            TEXT PRIMARY KEY,
  home_id       TEXT NOT NULL REFERENCES homes(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL,         -- claude-code | codex | other ...
  appearance    TEXT,                  -- self-description, public
  sprite        TEXT,                  -- generated pixel sprite JSON
  sprite_status TEXT NOT NULL DEFAULT 'none',  -- none | pending | ready | failed
  created_at    INTEGER NOT NULL,
  UNIQUE (home_id, name)
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  home_id    TEXT NOT NULL REFERENCES homes(id) ON DELETE CASCADE,
  persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  ext_key    TEXT NOT NULL,            -- client's session id, never exposed
  parent_id  TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  status     TEXT NOT NULL,            -- thinking | tool | waiting | idle | ended
  tool       TEXT,
  task_no    INTEGER,
  task_enc   TEXT,                     -- AES-GCM ciphertext, only the owner can read it
  started_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  ended_at   INTEGER,
  UNIQUE (home_id, ext_key)
);
CREATE INDEX IF NOT EXISTS sessions_open ON sessions (home_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS sessions_parent ON sessions (parent_id);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY,
  home_id    TEXT NOT NULL,
  session_id TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  status     TEXT NOT NULL,
  tool       TEXT,
  task_no    INTEGER
);
CREATE INDEX IF NOT EXISTS events_home_ts ON events (home_id, ts);

CREATE TABLE IF NOT EXISTS daily_stats (
  home_id TEXT NOT NULL,
  day     TEXT NOT NULL,               -- UTC yyyy-mm-dd
  busy_ms INTEGER NOT NULL DEFAULT 0,
  tasks   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (home_id, day)
);

CREATE TABLE IF NOT EXISTS tool_stats (
  home_id TEXT NOT NULL,
  day     TEXT NOT NULL,
  tool    TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (home_id, day, tool)
);
`);

// ---- avatar generation (server/avatar.ts) ----
db.exec(`
CREATE TABLE IF NOT EXISTS avatar_usage (
  home_id TEXT NOT NULL,
  day     TEXT NOT NULL,               -- UTC yyyy-mm-dd
  count   INTEGER NOT NULL DEFAULT 0,  -- sprite generations started that day
  PRIMARY KEY (home_id, day)
);
`);
if (!(db.prepare("PRAGMA table_info(personas)").all() as { name: string }[]).some((c) => c.name === "sprite_error")) {
  db.exec("ALTER TABLE personas ADD COLUMN sprite_error TEXT"); // why sprite_status = 'failed'
}

export function tx<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
