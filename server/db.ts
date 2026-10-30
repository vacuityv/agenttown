import mysql, { type Pool, type PoolConnection, type ResultSetHeader } from "mysql2/promise";
import { MYSQL_URL } from "./config.ts";

// Timestamps are BIGINT epoch ms. supportBigNumbers keeps them exact (they fit in a JS number), decimalNumbers
// turns SUM()/COALESCE(SUM()) (DECIMAL in MySQL) into numbers instead of strings.
let pool: Pool | undefined;
export function db(): Pool {
  if (pool) return pool;
  if (!MYSQL_URL) {
    throw new Error("MYSQL_URL is not set (e.g. mysql://agenttown:secret@127.0.0.1:3306/agenttown)");
  }
  pool = mysql.createPool({
    uri: MYSQL_URL,
    connectionLimit: 10,
    waitForConnections: true,
    timezone: "Z",
    charset: "utf8mb4",
    supportBigNumbers: true,
    decimalNumbers: true,
    enableKeepAlive: true,
  });
  return pool;
}

/** Anything that can run a query: the pool or a transaction's dedicated connection. */
export type Q = Pool | PoolConnection;
export type Row = Record<string, any>;

export async function all(c: Q, sql: string, params: unknown[] = []): Promise<Row[]> {
  const [rows] = await c.query(sql, params);
  return rows as Row[];
}
export async function one(c: Q, sql: string, params: unknown[] = []): Promise<Row | undefined> {
  return (await all(c, sql, params))[0];
}
export async function run(c: Q, sql: string, params: unknown[] = []): Promise<ResultSetHeader> {
  const [res] = await c.query(sql, params);
  return res as ResultSetHeader;
}

const RETRYABLE = new Set(["ER_LOCK_DEADLOCK"]);

/**
 * Runs fn in a READ COMMITTED transaction on one dedicated pool connection (never interleaved with other
 * requests). Deadlocks are retried; with retryDuplicate, so are duplicate-key races (e.g. two first-reports).
 * fn may run more than once: keep side effects (bus events) until after it returns.
 */
export async function tx<T>(fn: (c: PoolConnection) => Promise<T>, { retryDuplicate = false } = {}): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const c = await db().getConnection();
    try {
      await c.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
      await c.beginTransaction();
      try {
        const r = await fn(c);
        await c.commit();
        return r;
      } catch (e) {
        await c.rollback().catch(() => {});
        throw e;
      }
    } catch (e: any) {
      const retry = RETRYABLE.has(e?.code) || (retryDuplicate && e?.code === "ER_DUP_ENTRY");
      if (!retry || attempt >= 4) throw e;
    } finally {
      c.release();
    }
  }
}

// ---- schema ----
// Each migration runs once, in order; schema_migrations records what has been applied.
// Add new schema changes as new entries, never edit applied ones.

const T = "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin"; // binary compare, like SQLite TEXT

const MIGRATIONS: { version: number; statements: string[] }[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS homes (
        id         VARCHAR(32)  NOT NULL PRIMARY KEY,
        auth_hash  CHAR(64)     NOT NULL,          -- sha256(auth_token); the owner key never reaches us
        name       VARCHAR(64)  NOT NULL,
        task_seq   INT UNSIGNED NOT NULL DEFAULT 0,
        created_at BIGINT       NOT NULL,
        UNIQUE KEY homes_auth (auth_hash),
        KEY homes_created (created_at)
      ) ${T}`,
      `CREATE TABLE IF NOT EXISTS personas (
        id            VARCHAR(32)  NOT NULL PRIMARY KEY,
        home_id       VARCHAR(32)  NOT NULL,
        name          VARCHAR(64)  NOT NULL,
        kind          VARCHAR(32)  NOT NULL,       -- claude-code | codex | other ...
        appearance    VARCHAR(255) NULL,           -- self-description, public
        sprite        MEDIUMTEXT   NULL,           -- generated pixel sprite JSON
        sprite_status VARCHAR(16)  NOT NULL DEFAULT 'none',  -- none | pending | ready | failed
        sprite_error  VARCHAR(64)  NULL,           -- why sprite_status = 'failed'
        created_at    BIGINT       NOT NULL,
        UNIQUE KEY personas_name (home_id, name),
        KEY personas_status (sprite_status, created_at),
        CONSTRAINT personas_home FOREIGN KEY (home_id) REFERENCES homes(id) ON DELETE CASCADE
      ) ${T}`,
      `CREATE TABLE IF NOT EXISTS sessions (
        id         VARCHAR(32)   NOT NULL PRIMARY KEY,
        home_id    VARCHAR(32)   NOT NULL,
        persona_id VARCHAR(32)   NOT NULL,
        ext_key    VARCHAR(128)  NOT NULL,         -- client's session id, never exposed
        parent_id  VARCHAR(32)   NULL,
        status     VARCHAR(16)   NOT NULL,         -- thinking | tool | waiting | idle | ended
        tool       VARCHAR(64)   NULL,
        task_no    INT UNSIGNED  NULL,
        task_enc   VARCHAR(1024) NULL,             -- AES-GCM ciphertext, only the owner can read it
        started_at BIGINT        NOT NULL,
        last_seen  BIGINT        NOT NULL,
        ended_at   BIGINT        NULL,
        UNIQUE KEY sessions_key (home_id, ext_key),
        KEY sessions_open (home_id, ended_at),
        KEY sessions_ended (ended_at, last_seen),
        KEY sessions_parent (parent_id),
        CONSTRAINT sessions_home FOREIGN KEY (home_id) REFERENCES homes(id) ON DELETE CASCADE,
        CONSTRAINT sessions_persona FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE CASCADE,
        CONSTRAINT sessions_parent FOREIGN KEY (parent_id) REFERENCES sessions(id) ON DELETE SET NULL
      ) ${T}`,
      `CREATE TABLE IF NOT EXISTS events (
        id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        home_id    VARCHAR(32)  NOT NULL,
        session_id VARCHAR(32)  NOT NULL,
        ts         BIGINT       NOT NULL,
        status     VARCHAR(16)  NOT NULL,
        tool       VARCHAR(64)  NULL,
        task_no    INT UNSIGNED NULL,
        KEY events_home_ts (home_id, ts),
        KEY events_ts (ts)
      ) ${T}`,
      `CREATE TABLE IF NOT EXISTS daily_stats (
        home_id VARCHAR(32) NOT NULL,
        day     CHAR(10)    NOT NULL,              -- UTC yyyy-mm-dd
        busy_ms BIGINT      NOT NULL DEFAULT 0,
        tasks   INT         NOT NULL DEFAULT 0,
        PRIMARY KEY (home_id, day)
      ) ${T}`,
      `CREATE TABLE IF NOT EXISTS tool_stats (
        home_id VARCHAR(32) NOT NULL,
        day     CHAR(10)    NOT NULL,
        tool    VARCHAR(64) NOT NULL,
        count   INT         NOT NULL DEFAULT 0,
        PRIMARY KEY (home_id, day, tool)
      ) ${T}`,
      // avatar generation (server/avatar.ts)
      `CREATE TABLE IF NOT EXISTS avatar_usage (
        home_id VARCHAR(32) NOT NULL,
        day     CHAR(10)    NOT NULL,              -- UTC yyyy-mm-dd
        count   INT         NOT NULL DEFAULT 0,    -- sprite generations started that day
        PRIMARY KEY (home_id, day),
        KEY avatar_usage_day (day)
      ) ${T}`,
    ],
  },
  {
    // Free town: home customization, public says, the cemetery; invites + device credentials.
    version: 2,
    statements: [
      `ALTER TABLE homes
        ADD COLUMN dwelling    VARCHAR(24)  NULL,  -- house | cottage | ... ; NULL = client picks from hash(id)
        ADD COLUMN style       VARCHAR(24)  NULL,  -- pixel | flat | ... ; NULL = client picks from hash(id)
        ADD COLUMN description VARCHAR(255) NULL  -- public, <= 200 chars
      `,
      `CREATE TABLE IF NOT EXISTS says (
        id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        home_id    VARCHAR(32)  NOT NULL,
        persona_id VARCHAR(32)  NOT NULL,
        text       VARCHAR(512) NOT NULL,          -- public, <= 140 chars
        ts         BIGINT       NOT NULL,
        KEY says_home (home_id, id),
        CONSTRAINT says_home FOREIGN KEY (home_id) REFERENCES homes(id) ON DELETE CASCADE,
        CONSTRAINT says_persona FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE CASCADE
      ) ${T}`,
      // Graves outlive their home: no foreign keys.
      `CREATE TABLE IF NOT EXISTS tombstones (
        id         VARCHAR(32)  NOT NULL PRIMARY KEY,
        home_id    VARCHAR(32)  NOT NULL,
        persona_id VARCHAR(32)  NULL,              -- NULL: the grave of an empty home
        name       VARCHAR(64)  NOT NULL,
        kind       VARCHAR(32)  NOT NULL,
        home_name  VARCHAR(64)  NOT NULL,
        appearance VARCHAR(255) NULL,
        sprite     MEDIUMTEXT   NULL,
        born_at    BIGINT       NOT NULL,
        died_at    BIGINT       NOT NULL,
        epitaph    VARCHAR(512) NULL,
        KEY tombstones_died (died_at)
      ) ${T}`,
      `CREATE TABLE IF NOT EXISTS invites (
        id         VARCHAR(32)  NOT NULL PRIMARY KEY,
        home_id    VARCHAR(32)  NOT NULL,
        blob_enc   VARCHAR(1024) NOT NULL,         -- home enc_key wrapped under a key only the code holder has
        kind       VARCHAR(8)   NOT NULL DEFAULT 'join',  -- join (new device) | merge (another home moves in)
        label      VARCHAR(64)  NULL,
        created_at BIGINT       NOT NULL,
        expires_at BIGINT       NOT NULL,
        used_at    BIGINT       NULL,
        KEY invites_home (home_id),
        CONSTRAINT invites_home FOREIGN KEY (home_id) REFERENCES homes(id) ON DELETE CASCADE
      ) ${T}`,
      `CREATE TABLE IF NOT EXISTS devices (
        id           VARCHAR(32) NOT NULL PRIMARY KEY,
        home_id      VARCHAR(32) NOT NULL,
        auth_hash    CHAR(64)    NOT NULL,         -- sha256(device_token)
        label        VARCHAR(64) NULL,
        created_at   BIGINT      NOT NULL,
        last_seen_at BIGINT      NULL,
        revoked_at   BIGINT      NULL,
        needs_rekey  TINYINT     NOT NULL DEFAULT 0,  -- 1: its home was merged away; fetch rekey_blob via /me
        rekey_blob   VARCHAR(1024) NULL,           -- new home's enc_key, wrapped under the old home's enc_key
        UNIQUE KEY devices_auth (auth_hash),
        KEY devices_home (home_id),
        CONSTRAINT devices_home FOREIGN KEY (home_id) REFERENCES homes(id) ON DELETE CASCADE
      ) ${T}`,
    ],
  },
  {
    // Permanent map slots: assigned once (AUTO_INCREMENT, persisted by InnoDB), never reused after a delete/merge.
    // Existing homes get slots in created_at order.
    version: 3,
    statements: [
      `ALTER TABLE homes ADD COLUMN slot BIGINT UNSIGNED NULL`,
      `UPDATE homes h JOIN (SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS rn FROM homes) x ON x.id = h.id
        SET h.slot = x.rn`,
      `ALTER TABLE homes MODIFY slot BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, ADD UNIQUE KEY homes_slot (slot)`,
    ],
  },
  // Dwelling art (server/dwelling-gen.ts). Numbered 100+ so it can't collide with versions added on other branches.
  {
    version: 100,
    statements: [
      `ALTER TABLE homes
        ADD COLUMN look       VARCHAR(300) NULL,                    -- one-sentence description of the home, public
        ADD COLUMN art        MEDIUMTEXT   NULL,                    -- generated dwelling art JSON
        ADD COLUMN art_status VARCHAR(16)  NOT NULL DEFAULT 'none', -- none | pending | ready | failed
        ADD COLUMN art_error  VARCHAR(64)  NULL,                    -- why art_status = 'failed'
        ADD KEY homes_art_status (art_status, created_at)`,
      // avatar_usage.count = sprite generations, .dwellings = dwelling generations (separate daily caps)
      "ALTER TABLE avatar_usage ADD COLUMN dwellings INT NOT NULL DEFAULT 0",
    ],
  },
  // ---- moderation (server/safety.ts). Versions >= 200 are reserved for moderation/security changes. ----
  {
    // Hidden content (public outputs redact it), abuse reports, bans.
    version: 200,
    statements: [
      ...["homes", "personas", "says", "tombstones"].map((t) =>
        `ALTER TABLE ${t} ADD COLUMN hidden_at BIGINT NULL, ADD COLUMN hidden_reason VARCHAR(255) NULL`),
      // Reports outlive their targets: no foreign keys. One per reporter (HMAC of the IP) and target.
      `CREATE TABLE IF NOT EXISTS reports (
        id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        kind          VARCHAR(16)  NOT NULL,          -- home | persona | say | tombstone
        target_id     VARCHAR(32)  NOT NULL,
        home_id       VARCHAR(32)  NULL,              -- the target's home, for review context
        reporter_hash CHAR(64)     NOT NULL,          -- HMAC-SHA256(SERVER_SECRET, client IP)
        reason        VARCHAR(32)  NOT NULL,
        note          VARCHAR(512) NULL,              -- optional, only admins see it
        status        VARCHAR(16)  NOT NULL DEFAULT 'open',  -- open | dismissed | actioned
        created_at    BIGINT       NOT NULL,
        resolved_at   BIGINT       NULL,
        UNIQUE KEY reports_dedupe (kind, target_id, reporter_hash),
        KEY reports_status (status, created_at),
        KEY reports_home (home_id)
      ) ${T}`,
      // Banned credentials (owner auth hash + device hashes) survive the home being deleted.
      `CREATE TABLE IF NOT EXISTS bans (
        auth_hash  CHAR(64)     NOT NULL PRIMARY KEY,
        home_id    VARCHAR(32)  NOT NULL,
        reason     VARCHAR(255) NULL,
        created_at BIGINT       NOT NULL,
        KEY bans_home (home_id)
      ) ${T}`,
    ],
  },
  // ---- end moderation ----
];

export async function initDb() {
  const c = await db().getConnection();
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INT    NOT NULL PRIMARY KEY,
      applied_at BIGINT NOT NULL
    ) ${T}`);
    await c.query("SELECT GET_LOCK('agenttown_migrate', 30)");
    try {
      const done = new Set((await all(c, "SELECT version FROM schema_migrations")).map((r) => r.version));
      for (const m of MIGRATIONS) {
        if (done.has(m.version)) continue;
        for (const sql of m.statements) await c.query(sql); // DDL commits implicitly
        await c.query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [m.version, Date.now()]);
        console.log(`db: applied migration ${m.version}`);
      }
    } finally {
      await c.query("SELECT RELEASE_LOCK('agenttown_migrate')");
    }
  } finally {
    c.release();
  }
}
