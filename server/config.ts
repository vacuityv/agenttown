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
