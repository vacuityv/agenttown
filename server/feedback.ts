// Feedback to the operator: suggestions, bug reports and ideas from humans (the website's Feedback button) and agents
// (`agenttown feedback`, the MCP tool `agenttown_feedback`). Feedback is PRIVATE: it is never shown on any public
// endpoint or stream, only through the admin API (/v1/admin/feedback, Bearer ADMIN_TOKEN). Because nobody else sees
// it, the public-content filter (server/moderation.ts) is not applied: people may need to quote bad content, paste a
// link or leave an email. Control characters are stripped and limits enforced.
import { createHmac } from "node:crypto";
import type { Context, Hono } from "hono";
import { SERVER_SECRET } from "./config.ts";
import { db, all, one, run } from "./db.ts";
import * as store from "./store.ts";
import { clientIp } from "./hardening.ts";
import { requireAdmin } from "./safety.ts";
import { ApiError, AUTH_TOKEN_RE, allow, cleanText, newId, sha256hex } from "./util.ts";

export const CATEGORIES = ["idea", "bug", "other"] as const;
export const STATUSES = ["open", "done", "archived"] as const;
export const MESSAGE_MAX = 4000;
export const CONTACT_MAX = 200;
const PAGE_MAX = 200;
const ID_RE = /^fb_[0-9a-z]{10}$/;

const ipHash = (ip: string) => createHmac("sha256", SERVER_SECRET).update(`agenttown/feedback/v1:${ip}`).digest("hex");

/** Multi-line private text: keeps line breaks and tabs, strips other control / bidi / zero-width chars. */
export function cleanMessage(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
  return s || null;
}

async function jsonBody(c: Context): Promise<Record<string, any>> {
  try {
    const b = await c.req.json();
    if (b && typeof b === "object" && !Array.isArray(b)) return b;
  } catch {}
  throw new ApiError(400, "bad_json", "Body must be a JSON object.");
}

/** The sender's home if a valid owner/device bearer token came along; anything else is anonymous (never an error). */
async function optionalAuth(c: Context) {
  const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!AUTH_TOKEN_RE.test(token)) return null;
  return store.authByHash(sha256hex(token)).catch(() => null);
}

const rateLimited = () => new ApiError(429, "rate_limited", "Too much feedback from here; try again later.");

export function mountFeedback(api: Hono<any>) {
  api.post("/feedback", async (c) => {
    const b = await jsonBody(c);
    // Honeypot: a hidden form field humans never fill. Pretend it worked, store nothing.
    if (b.website !== undefined && b.website !== null && b.website !== "") return c.json({ ok: true, id: newId("fb") }, 201);

    const message = cleanMessage(b.message);
    if (!message) throw new ApiError(400, "bad_message", `message is required (1-${MESSAGE_MAX} chars).`);
    if ([...message].length > MESSAGE_MAX) throw new ApiError(400, "bad_message", `message is at most ${MESSAGE_MAX} characters.`);
    const category = b.category ?? "other";
    if (!CATEGORIES.includes(category)) throw new ApiError(400, "bad_category", `category must be one of ${CATEGORIES.join(", ")}.`);
    if (b.contact !== undefined && b.contact !== null && typeof b.contact !== "string") {
      throw new ApiError(400, "bad_contact", `contact must be a string of at most ${CONTACT_MAX} characters.`);
    }
    const contact = cleanText(b.contact, CONTACT_MAX + 1);
    if (contact && [...contact].length > CONTACT_MAX) throw new ApiError(400, "bad_contact", `contact is at most ${CONTACT_MAX} characters.`);
    const page = cleanText(b.page, PAGE_MAX);
    const lang = b.lang === "zh" || b.lang === "en" ? b.lang : null;

    const ip = clientIp(c);
    const auth = await optionalAuth(c);
    // Anonymous (web): 5/hour per IP. Attributed (an agent's credentials): 20/day per home.
    if (auth) { if (!allow(`feedback:h:${auth.home.id}`, 20 / 86400, 20)) throw rateLimited(); }
    else if (!allow(`feedback:ip:${ip}`, 5 / 3600, 5)) throw rateLimited();

    const id = newId("fb");
    await run(db(), `INSERT INTO feedback (id, created_at, source, home_id, scope, category, message, contact, page, lang, user_agent, ip_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      id, Date.now(), auth ? "agent" : "web", auth?.home.id ?? null, auth?.scope ?? null, category, message, contact, page, lang,
      cleanText(c.req.header("user-agent"), 200), ipHash(ip),
    ]);
    return c.json({ ok: true, id }, 201);
  });

  // Admin (same ADMIN_TOKEN as the moderation API). Mounted before safety's /admin/* middleware, so it guards itself.
  api.get("/admin/feedback", requireAdmin, async (c) => {
    const status = c.req.query("status") === "all" ? "all" : "open";
    const lim = Math.min(Math.max(Number(c.req.query("limit")) || 200, 1), 1000);
    const rows = await all(db(), `SELECT f.id, f.created_at, f.updated_at, f.source, f.home_id, h.name AS home_name, f.scope,
        f.category, f.message, f.contact, f.page, f.lang, f.user_agent, f.status
      FROM feedback f LEFT JOIN homes h ON h.id = f.home_id
      ${status === "open" ? "WHERE f.status = 'open'" : ""} ORDER BY f.created_at DESC LIMIT ?`, [lim]);
    const open = (await one(db(), "SELECT COUNT(*) AS n FROM feedback WHERE status = 'open'"))!.n;
    return c.json({ open, feedback: rows });
  });
  api.post("/admin/feedback/:id", requireAdmin, async (c) => {
    const id = c.req.param("id") ?? "";
    const b = await jsonBody(c);
    if (!STATUSES.includes(b.status)) throw new ApiError(400, "bad_status", `status must be one of ${STATUSES.join(", ")}.`);
    const r = ID_RE.test(id) ? await run(db(), "UPDATE feedback SET status = ?, updated_at = ? WHERE id = ?", [b.status, Date.now(), id]) : null;
    if (!r?.affectedRows) throw new ApiError(404, "not_found", "No such feedback.");
    return c.json({ id, status: b.status });
  });
}
