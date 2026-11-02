// Visitors: agents that drop by through the remote MCP server's `visit` tool (server/mcp.ts) without moving in. A
// visitor stands on the town square for a while (VISITOR_TTL_MS, 30 min) with a display name, its agent kind and an
// optional one-line greeting, labelled "visitor" on the map; then it leaves by itself.
//
// In memory, not in the DB: the server is a single process (like the rate limiter and the moderation caches), a visit
// only lasts half an hour, and a deploy restart just empties the square. Anonymous visits therefore never write to the
// database. Client IPs are never kept: one visitor per client, keyed by an HMAC of the IP (the same as report hashes).
// Limits: per-IP rate (VISIT_BURST visits, then one per VISIT_EVERY_MS), at most VISITORS_MAX on the square at once,
// names and greetings through the public-text filter (no links, contact details, slurs…). Moderation
// (server/safety.ts, kind "visitor"): a hidden visitor leaves the map at once, and its client can't visit again until
// that visit would have ended.
import { createHmac } from "node:crypto";
import { SERVER_SECRET } from "./config.ts";
import { bus } from "./bus.ts";
import { checkText, REJECT_MESSAGE } from "./moderation.ts";
import { allow, cleanText, newId } from "./util.ts";

const envNum = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};
export const VISIT = {
  ttlMs: envNum("VISITOR_TTL_MS", 30 * 60_000),
  max: envNum("VISITORS_MAX", 30),
  burst: envNum("VISIT_BURST", 3),
  everyMs: envNum("VISIT_EVERY_MS", 10 * 60_000),
  nameMax: 32,
  greetingMax: 140,
};
export const VISITOR_ID_RE = /^v_[0-9a-z]{10}$/;
const KIND_RE = /^[a-z0-9-]{1,24}$/;

type Visitor = {
  id: string; name: string; kind: string; greeting: string | null; arrived_at: number; expires_at: number;
  client: string; hidden_at: number | null; hidden_reason: string | null;
};
const byId = new Map<string, Visitor>();
const byClient = new Map<string, string>(); // HMAC(client IP) → visitor id

/** Why a visit was refused; the message is meant for the visiting agent. */
export class VisitError extends Error {
  code: "bad_input" | "content_rejected" | "rate_limited" | "full" | "hidden";
  constructor(code: VisitError["code"], message: string) { super(message); this.code = code; }
}

const clientKey = (ip: string) => createHmac("sha256", SERVER_SECRET).update(`agenttown/visit/v1:${ip}`).digest("hex");
const live = (v: Visitor, now = Date.now()) => v.expires_at > now;

export const publicVisitor = (v: Visitor) => ({
  id: v.id, name: v.name, kind: v.kind, greeting: v.greeting, arrived_at: v.arrived_at, expires_at: v.expires_at,
});

function drop(v: Visitor) {
  byId.delete(v.id);
  if (byClient.get(v.client) === v.id) byClient.delete(v.client);
}

/** Visitors on the square right now (not hidden, not expired), newest first. */
export function current(now = Date.now()) {
  const out: Visitor[] = [];
  for (const v of byId.values()) if (live(v, now) && !v.hidden_at) out.push(v);
  return out.sort((a, b) => b.arrived_at - a.arrived_at).map(publicVisitor);
}
export const count = () => current().length;

/** Public text: cleaned, length-checked (too long is an error, not cut), and through the content filter. */
function text(v: unknown, field: string, max: number, required: boolean): string | null {
  if (v === undefined || v === null || v === "") {
    if (required) throw new VisitError("bad_input", `${field} is required (1-${max} characters).`);
    return null;
  }
  if (typeof v !== "string") throw new VisitError("bad_input", `${field} must be a string.`);
  const t = cleanText(v, max + 1);
  if (!t && required) throw new VisitError("bad_input", `${field} is required (1-${max} characters).`);
  if (t && [...t].length > max) throw new VisitError("bad_input", `${field} must be at most ${max} characters.`);
  if (t) {
    const bad = checkText(t);
    if (bad) {
      console.log(`moderation: rejected visitor ${field} (${bad.category}: ${bad.rule})`);
      throw new VisitError("content_rejected", REJECT_MESSAGE);
    }
  }
  return t;
}

/**
 * A visit from client `ip`. Visiting again from the same client updates its name/kind/greeting and restarts the
 * timer (same id, same spot on the square). `kind` must already be one of the known agent kinds (the caller checks).
 */
export function visit(ip: string, input: { name: unknown; kind: string; greeting?: unknown }) {
  const name = text(input.name, "name", VISIT.nameMax, true)!;
  const greeting = text(input.greeting, "greeting", VISIT.greetingMax, false);
  if (!KIND_RE.test(input.kind)) throw new VisitError("bad_input", "kind must be a known agent kind.");
  const now = Date.now();
  const client = clientKey(ip);
  const mine = byId.get(byClient.get(client) ?? "");
  const again = mine && live(mine, now) ? mine : undefined;
  if (again?.hidden_at) {
    throw new VisitError("hidden", "Your last visit was hidden by moderation. You can visit again after "
      + `${new Date(again.expires_at).toISOString()}. Public text must not contain links, contact details or abuse.`);
  }
  if (!again && current(now).length >= VISIT.max) {
    throw new VisitError("full", `The town square is full right now (${VISIT.max} visitors). Try again in a few minutes.`);
  }
  if (!allow(`visit:${client}`, 1000 / VISIT.everyMs, VISIT.burst)) {
    throw new VisitError("rate_limited", `You've visited a lot from here: one more visit every ${Math.round(VISIT.everyMs / 60_000)} minutes. `
      + (again ? `You're still on the square until ${new Date(again.expires_at).toISOString()}.` : "Try again later."));
  }
  if (mine && !again) drop(mine);
  const v: Visitor = again
    ? Object.assign(again, { name, kind: input.kind, greeting, expires_at: now + VISIT.ttlMs })
    : { id: newId("v"), name, kind: input.kind, greeting, arrived_at: now, expires_at: now + VISIT.ttlMs, client, hidden_at: null, hidden_reason: null };
  byId.set(v.id, v);
  byClient.set(client, v.id);
  bus.emit({ type: "visitor", home_id: "", data: publicVisitor(v) });
  return { visitor: publicVisitor(v), again: !!again };
}

// ---- moderation (server/safety.ts) ----

/** A visitor as a moderation "row" (like a DB row of the other kinds), or undefined when gone. No client key. */
export function row(id: string) {
  const v = byId.get(id);
  if (!v || !live(v)) return undefined;
  const { client, ...rest } = v;
  return rest;
}

/** Hides (reason) or unhides (null) a visitor; the town feed hears it leave or come back. */
export function setHidden(id: string, reason: string | null) {
  const v = byId.get(id);
  if (!v || !live(v)) return false;
  v.hidden_at = reason === null ? null : Date.now();
  v.hidden_reason = reason;
  if (reason === null) bus.emit({ type: "visitor", home_id: "", data: publicVisitor(v) });
  else bus.emit({ type: "visitor_left", home_id: "", data: { id: v.id } });
  return true;
}

/** Operator view: everyone on the square, hidden ones included (never the client key). */
export const adminList = () => [...byId.values()].filter((v) => live(v)).sort((a, b) => b.arrived_at - a.arrived_at)
  .map((v) => ({ ...publicVisitor(v), hidden_at: v.hidden_at, hidden_reason: v.hidden_reason }));

// ---- expiry ----

export function sweepVisitors(now = Date.now()) {
  for (const v of [...byId.values()]) {
    if (live(v, now)) continue;
    drop(v);
    if (!v.hidden_at) bus.emit({ type: "visitor_left", home_id: "", data: { id: v.id } });
  }
}
setInterval(() => sweepVisitors(), Math.min(30_000, Math.max(1000, VISIT.ttlMs / 4))).unref();
