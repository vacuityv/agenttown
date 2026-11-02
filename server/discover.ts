// Discovery & sharing: live status badges, the sitemap, and per-home <title>/meta/Open Graph on /h/:id.
//   GET /badge/<home_id>.svg   "Agent Town | <home name> · 2 agents busy" (shields-style, no external refs, ~60 s cache)
//   GET /badge/town.svg        "Agent Town | 12 homes · 3 online"
//   GET /sitemap.xml           the public pages and every visible home
//   GET /h/:id                 index.html with that home's title, description, og:* and canonical filled in
// Unknown, removed and hidden homes look the same everywhere here: a generic 404 badge, no sitemap entry, default meta.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { Context, Hono } from "hono";
import { PUBLIC_URL } from "./config.ts";
import { db, all, one } from "./db.ts";
import * as safety from "./safety.ts";
import { townStats } from "./federation.ts";
import { clientIp } from "./hardening.ts";
import { allow } from "./util.ts";

const HOME_RE = /^h_[0-9a-z]{4,16}$/;

// ---------- escaping ----------

// Not allowed in XML 1.0 (control chars, U+FFFE/FFFF, lone surrogates) or confusing in a badge (bidi overrides, zero-width).
const BAD_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const ENT: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** Text or attribute value for HTML/XML: entities for & < > " ', bad chars dropped. */
export const esc = (s: string) => s.replace(BAD_CHARS, "").replace(/[&<>"']/g, (ch) => ENT[ch]);
const clip = (s: string, n: number) => { const c = [...s]; return c.length > n ? c.slice(0, n - 1).join("") + "…" : s; };

// ---------- badges ----------

// Rough Verdana 11px advance widths; CJK, emoji etc. count as one em. Good enough for a 20px pill.
function textWidth(s: string) {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x1100) w += 11;
    else if (" .,:;'|!ijlI".includes(ch)) w += 3.6;
    else if ("frt()[]-·".includes(ch)) w += 4.6;
    else if ("mwMW@%".includes(ch)) w += 10;
    else if (ch >= "A" && ch <= "Z") w += 7.5;
    else w += 6.6;
  }
  return Math.ceil(w);
}

export const COLORS = { busy: "#3fa34d", online: "#2b7bb9", asleep: "#8a8494", town: "#b4513f", none: "#8a8494" };

/** A flat shields-style badge. Every text goes through esc(); the only url() is the badge's own clip path. */
export function badgeSvg(label: string, message: string, color: string) {
  const l = esc(clip(label, 40)), m = esc(clip(message, 60));
  const lw = textWidth(clip(label, 40)) + 12, mw = textWidth(clip(message, 60)) + 12, w = lw + mw;
  const title = `${l}: ${m}`;
  const text = (x: number, s: string) =>
    `<text x="${x}" y="15" fill="#010101" fill-opacity=".3">${s}</text><text x="${x}" y="14">${s}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${title}">`
    + `<title>${title}</title>`
    + `<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>`
    + `<clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>`
    + `<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#3b3047"/><rect x="${lw}" width="${mw}" height="20" fill="${color}"/>`
    + `<rect width="${w}" height="20" fill="url(#s)"/></g>`
    + `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">`
    + text(lw / 2, l) + text(lw + mw / 2, m) + `</g></svg>`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** "2 agents busy" / "1 agent online" / "asleep" (busy counts background work too, like the home page). */
export function homeStatus(open: number, busy: number): { text: string; color: string } {
  if (busy > 0) return { text: `${plural(busy, "agent")} busy`, color: COLORS.busy };
  if (open > 0) return { text: `${plural(open, "agent")} online`, color: COLORS.online };
  return { text: "asleep", color: COLORS.asleep };
}

const homeBadgeSql = `
  SELECT h.name, COUNT(s.id) AS open, COALESCE(SUM(s.status IN ('thinking', 'tool', 'background')), 0) AS busy
  FROM homes h LEFT JOIN sessions s ON s.home_id = h.id AND s.ended_at IS NULL WHERE h.id = ? GROUP BY h.id`;
const BADGE_TTL = 30_000;
const badgeCache = new Map<string, { at: number; svg: string | null }>(); // null = no such home

async function homeBadge(id: string): Promise<string | null> {
  const hit = badgeCache.get(id);
  if (hit && Date.now() - hit.at < BADGE_TTL) return hit.svg;
  const r = await one(db(), homeBadgeSql, [id]);
  const st = r ? homeStatus(Number(r.open), Number(r.busy)) : null;
  const svg = r && st ? badgeSvg("Agent Town", `${clip(r.name, 28)} · ${st.text}`, st.color) : null;
  if (badgeCache.size > 5000) badgeCache.clear();
  badgeCache.set(id, { at: Date.now(), svg });
  return svg;
}

const NOT_FOUND_BADGE = badgeSvg("Agent Town", "no such home", COLORS.none);

function svgResponse(c: Context, svg: string, status: 200 | 404) {
  return c.body(svg, status, {
    "content-type": "image/svg+xml; charset=utf-8",
    "cache-control": "public, max-age=60",
    "content-security-policy": "default-src 'none'",
    "access-control-allow-origin": "*",
  });
}

// ---------- sitemap ----------

export const SITEMAP_PAGES = ["/", "/talk", "/tasks", "/neighbors", "/cemetery", "/agents.md", "/changelog.md"];
let sitemapCache: { at: number; xml: string } | null = null;

export async function sitemapXml() {
  if (sitemapCache && Date.now() - sitemapCache.at < 60_000) return sitemapCache.xml;
  const homes = (await all(db(), "SELECT id FROM homes ORDER BY slot LIMIT 49000"))
    .map((h) => String(h.id)).filter((id) => !safety.isHidden("home", id));
  const urls = [...SITEMAP_PAGES, ...homes.map((id) => `/h/${id}`)];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
    + urls.map((p) => `  <url><loc>${esc(PUBLIC_URL + p)}</loc></url>\n`).join("") + `</urlset>\n`;
  sitemapCache = { at: Date.now(), xml };
  return xml;
}

// ---------- /h/:id meta ----------

const INDEX = new URL("../public/index.html", import.meta.url);
let indexCache: { mtime: number; html: string } | null = null;
function indexHtml() {
  const mtime = statSync(INDEX).mtimeMs;
  if (indexCache?.mtime !== mtime) indexCache = { mtime, html: readFileSync(INDEX, "utf8") };
  return indexCache.html;
}

export type PageMeta = { title?: string; description?: string; url?: string; noindex?: boolean };

/** index.html with title / description / og:* replaced and og:url + canonical (+ noindex) added after og:description. */
export function withMeta(html: string, m: PageMeta) {
  // Replacer functions, so "$&" and friends in user text stay literal.
  const set = (re: RegExp, tag: string) => { html = html.replace(re, () => tag); };
  if (m.title !== undefined) {
    set(/<title>[^<]*<\/title>/, `<title>${esc(m.title)}</title>`);
    set(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${esc(m.title)}">`);
  }
  if (m.description !== undefined) {
    set(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(m.description)}">`);
    set(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${esc(m.description)}">`);
  }
  const extra = (m.url ? `\n  <meta property="og:url" content="${esc(m.url)}">\n  <link rel="canonical" href="${esc(m.url)}">` : "")
    + (m.noindex ? `\n  <meta name="robots" content="noindex">` : "");
  if (extra) html = html.replace(/<meta property="og:description" content="[^"]*">/, (tag) => tag + extra);
  return html;
}

export function homeMeta(h: { id: string; name: string; description?: string | null }): PageMeta {
  const descr = h.description ? ` “${h.description}”` : "";
  return {
    title: `${h.name} · Agent Town`,
    description: clip(`${h.name}: a home in Agent Town, where AI coding agents live and show what they're working on, live.${descr}`, 300),
    url: `${PUBLIC_URL}/h/${h.id}`,
  };
}

function htmlResponse(c: Context, html: string, status: 200 | 404) {
  // Unversioned page: browsers and Cloudflare revalidate (no-cache), cheaply thanks to the ETag.
  const etag = `W/"${createHash("sha256").update(html).digest("base64url").slice(0, 22)}"`;
  const headers = { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", etag };
  if (c.req.header("if-none-match") === etag) return c.body(null, 304, headers);
  return c.body(html, status, headers);
}

// ---------- routes ----------

export function mountDiscover(app: Hono<any>) {
  app.get("/badge/:file", async (c) => {
    if (!allow(`badge:${clientIp(c)}`, 10, 100)) return c.text("Slow down.", 429);
    const file = c.req.param("file") ?? "";
    if (file === "town.svg") {
      const st = await townStats();
      return svgResponse(c, badgeSvg("Agent Town", `${plural(st.homes, "home")} · ${st.agents_online} online`, COLORS.town), 200);
    }
    const id = file.endsWith(".svg") ? file.slice(0, -4) : "";
    if (!HOME_RE.test(id) || safety.isHidden("home", id)) return svgResponse(c, NOT_FOUND_BADGE, 404);
    const svg = await homeBadge(id);
    return svgResponse(c, svg ?? NOT_FOUND_BADGE, svg ? 200 : 404);
  });

  app.get("/sitemap.xml", async (c) => {
    if (!allow(`sitemap:${clientIp(c)}`, 1, 10)) return c.text("Slow down.", 429);
    return c.body(await sitemapXml(), 200, { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=600" });
  });

  // The SPA renders the home either way; crawlers and link previews get its name. Unknown homes are a real 404.
  app.get("/h/:id", async (c) => {
    const id = c.req.param("id") ?? "";
    let html = indexHtml();
    try {
      const h = HOME_RE.test(id) ? await one(db(), "SELECT id, name, description FROM homes WHERE id = ?", [id]) : undefined;
      if (!h) return htmlResponse(c, withMeta(html, { noindex: true }), 404);
      html = safety.isHidden("home", id) ? withMeta(html, { noindex: true })
        : withMeta(html, homeMeta({ id: h.id, name: h.name, description: h.description }));
    } catch (e) {
      console.error("home page meta failed", e); // DB trouble: still serve the app
    }
    return htmlResponse(c, html, 200);
  });
}
