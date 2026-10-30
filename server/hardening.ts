// Security hardening: client IP, response security headers, a generous per-IP API rate limit, SSE connection caps.
import type { Context, Next } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { TRUST_PROXY } from "./config.ts";
import { ApiError, allow } from "./util.ts";

/**
 * The only source of the client IP. With TRUST_PROXY=1 it is X-Real-IP, which nginx sets from Cloudflare's
 * CF-Connecting-IP; that is only trustworthy if the origin accepts traffic from Cloudflare alone (see
 * deploy/nginx.conf). Without TRUST_PROXY it is the TCP peer. X-Forwarded-For is never read.
 */
export const clientIp = (c: Context) =>
  (TRUST_PROXY && c.req.header("x-real-ip")) || getConnInfo(c).remote.address || "unknown";

const envNum = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};

// ---- headers ----

// The UI is same-origin vanilla JS. Images: sprites/dwellings are rendered as SVG via blob: URLs, the favicon is a
// data: URL. No inline <script>; style attributes are not needed either (el() sets styles through the CSSOM, which
// CSP doesn't restrict), so style-src stays 'self'.
export const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

export async function securityHeaders(c: Context, next: Next) {
  await next();
  const h = c.res.headers;
  if (!h.has("content-security-policy")) h.set("Content-Security-Policy", CSP);
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "no-referrer");
  h.set("X-Frame-Options", "DENY");
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()");
}

// ---- API rate limit ----

// Per IP, across all of /v1. Generous: a busy machine with many agents and a few browser tabs stays far below it;
// specific endpoints keep their own tighter limits.
const API_RATE = envNum("API_RATE_PER_SEC", 20);
const API_BURST = envNum("API_RATE_BURST", 300);

export async function apiRateLimit(c: Context, next: Next) {
  if (!allow(`api:${clientIp(c)}`, API_RATE, API_BURST)) throw new ApiError(429, "rate_limited", "Too many requests. Slow down.");
  await next();
}

// ---- SSE caps ----

export const SSE_PER_IP = envNum("SSE_MAX_PER_IP", 6);
export const SSE_MAX = envNum("SSE_MAX_TOTAL", 5000);
const sseByIp = new Map<string, number>();
let sseTotal = 0;
export const sseStats = () => ({ total: sseTotal, ips: sseByIp.size });

/** Takes a stream slot for this IP or throws 429. Call the returned release() exactly when the stream ends (idempotent). */
export function sseAcquire(ip: string): () => void {
  const n = sseByIp.get(ip) ?? 0;
  if (n >= SSE_PER_IP) throw new ApiError(429, "too_many_streams", `At most ${SSE_PER_IP} live streams per client.`);
  if (sseTotal >= SSE_MAX) throw new ApiError(429, "server_busy", "Too many live streams right now; try again later.");
  sseByIp.set(ip, n + 1);
  sseTotal++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    sseTotal--;
    const m = (sseByIp.get(ip) ?? 1) - 1;
    if (m <= 0) sseByIp.delete(ip); else sseByIp.set(ip, m);
  };
}
