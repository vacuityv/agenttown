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
  // Turn ended but background work (shells, subagents…) is still running: long builds are normal.
  backgroundTimeoutMs: 2 * 3600_000,
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
  // Referral: a home registered with ?ref=<home> → both get this bonus; the referrer at most referralDailyCap times a day.
  referralBonus: 50,
  referralDailyCap: 10,
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

// ---- Web Push notifications for home owners (server/push.ts) ----
// The VAPID key pair (base64url: public = 65-byte uncompressed P-256 point, private = 32-byte scalar); make one with
// `node scripts/vapid-keys.mjs`. Either key unset = notifications are off and the UI hides them.
export const PUSH = {
  publicKey: process.env.VAPID_PUBLIC_KEY ?? "",
  privateKey: process.env.VAPID_PRIVATE_KEY ?? "",
  subject: process.env.VAPID_SUBJECT || PUBLIC_URL, // "mailto:…" or an https URL the push services can reach us at
  hourlyMax: envMs("PUSH_HOURLY_MAX", 30), // notifications per home per hour (all of its devices count as one)
  waitDelayMs: envMs("PUSH_WAIT_DELAY_MS", 10_000), // answered at the keyboard within this: no push
  minTurnMs: envMs("PUSH_MIN_TURN_MS", 60_000), // "finished" only for turns that were busy at least this long
  doneDebounceMs: envMs("PUSH_DONE_DEBOUNCE_MS", 10 * 60_000), // at most one "finished" per persona per this
  coalesceMs: envMs("PUSH_COALESCE_MS", 2000), // events of one home within this become one notification
  devicesPerHome: 20,
  // Endpoints must be https on a known push service (SSRF guard); extra origins (http allowed) are for tests only.
  hosts: ["fcm.googleapis.com", "push.services.mozilla.com", "push.apple.com", "notify.windows.com"],
  extraOrigins: (process.env.PUSH_EXTRA_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
};
