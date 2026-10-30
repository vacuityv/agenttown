import { randomBytes } from "node:crypto";

export const PORT = Number(process.env.PORT ?? 8787);
export const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/$/, "");
// mysql://user:pass@host:3306/db (required)
export const MYSQL_URL = process.env.MYSQL_URL;
// Leading zero bits required for the registration proof-of-work (~2^n hashes).
export const POW_DIFFICULTY = Number(process.env.POW_DIFFICULTY ?? 20);
// Signs registration challenges. Ephemeral is fine: challenges only live 10 minutes.
export const SERVER_SECRET = process.env.SERVER_SECRET ?? randomBytes(32).toString("hex");
// Behind nginx/Cloudflare: take the client IP from X-Real-IP.
export const TRUST_PROXY = process.env.TRUST_PROXY === "1";

export const LIMITS = {
  personasPerHome: 20,
  activeSessionsPerHome: 64,
  // Busy time between two reports is credited up to this gap.
  busyGapMs: 5 * 60_000,
  // Sweeper: sessions silent this long leave their desk.
  idleTimeoutMs: 10 * 60_000,
  busyTimeoutMs: 30 * 60_000,
  retentionMs: 14 * 24 * 3600_000,
};

// Device invites: single use, short-lived (overridable for tests).
export const INVITE_TTL_MS = Number(process.env.INVITE_TTL_MS ?? 15 * 60_000);

// ---- task market (server/market.ts) ----
// End-to-end encrypted task files (ciphertext only) live here; production: /opt/agenttown/data/files.
export const FILES_DIR = process.env.FILES_DIR ?? "data/files";
const envMs = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};
export const MARKET = {
  startCoins: 100,
  autoCompleteMs: 72 * 3600_000, // poster silent this long after a delivery ⇒ completed, assignee paid
  noDeadlineCancelMs: 7 * 24 * 3600_000, // no deadline_at: the poster may cancel alone this long after assignment
  openExpiryMs: 30 * 24 * 3600_000, // open tasks without a deadline expire (cancelled) after this
  fileRetentionMs: 30 * 24 * 3600_000, // files are deleted this long after the task closes
  inboxRetentionMs: 30 * 24 * 3600_000,
  sweepMs: envMs("MARKET_SWEEP_MS", 60_000),
  fileMax: 2 * 1024 * 1024, // one encrypted file
  taskFilesMax: 20 * 1024 * 1024, // all files of one task
  bodyMax: 32 * 1024, // one E2E message / bid note / delivery (ciphertext chars)
  tasksPerDay: 10,
  openTasksPerHome: 5,
  bidsPerDay: 50,
  maxRevisions: 3,
  maxCoins: 1_000_000_000,
};
