import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { SERVER_SECRET } from "./config.ts";

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
export function newId(prefix: string, len = 10): string {
  const bytes = randomBytes(len);
  let s = "";
  for (const b of bytes) s += ALPHABET[b & 31];
  return `${prefix}_${s}`;
}

export const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

export function zeroBits(buf: Uint8Array): number {
  let n = 0;
  for (const b of buf) {
    if (b === 0) { n += 8; continue; }
    return n + Math.clz32(b) - 24;
  }
  return n;
}

// Stateless challenge: "<issuedAtMs>.<random>.<sig>", valid for 10 minutes.
const CHALLENGE_TTL = 10 * 60_000;
const usedChallenges = new Map<string, number>();

export function issueChallenge(): string {
  const body = `${Date.now()}.${randomBytes(12).toString("base64url")}`;
  const sig = createHmac("sha256", SERVER_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyPow(challenge: string, nonce: string, difficulty: number): boolean {
  const parts = challenge.split(".");
  if (parts.length !== 3 || nonce.length > 32) return false;
  const [issued, rand, sig] = parts;
  const expect = createHmac("sha256", SERVER_SECRET).update(`${issued}.${rand}`).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== expect.length || !timingSafeEqual(got, expect)) return false;
  if (Date.now() - Number(issued) > CHALLENGE_TTL) return false;
  if (usedChallenges.has(challenge)) return false;
  const h = createHash("sha256").update(`${challenge}:${nonce}`).digest();
  if (zeroBits(h) < difficulty) return false;
  usedChallenges.set(challenge, Date.now());
  return true;
}

// In-memory token buckets; fine for a single process.
const buckets = new Map<string, { tokens: number; at: number }>();
export function allow(key: string, perSec: number, burst: number): boolean {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: burst, at: now };
  b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * perSec);
  b.at = now;
  buckets.set(key, b);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, t] of usedChallenges) if (now - t > CHALLENGE_TTL) usedChallenges.delete(k);
  for (const [k, b] of buckets) if (now - b.at > 3600_000) buckets.delete(k);
}, 60_000).unref();

// Public-facing short text: strip control chars, collapse whitespace, cap length.
export function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f\u007f​-‏‪-‮]/g, " ").replace(/\s+/g, " ").trim();
  return s ? [...s].slice(0, max).join("") : null;
}

// Tool names are public. MCP tool names can leak private server names, so fold them.
export function cleanTool(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  if (v.startsWith("mcp__") || v.startsWith("mcp:")) return "MCP";
  return /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(v) ? v : "Other";
}

export const TASK_ENC_RE = /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{24,800}$/;
export const AUTH_TOKEN_RE = /^[0-9a-f]{64}$/;
