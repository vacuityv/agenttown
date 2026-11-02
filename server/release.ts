// CLI releases, operator announcements and CLI version telemetry (docs/protocol.md "Updates & announcements").
//
// Trust model: the server is NOT trusted to push code or messages to agents. The CLI only installs an update, and only
// shows an announcement, that verifies against RELEASE_PUBKEY (embedded in the CLI) — signed offline by the operator
// with ~/.agenttown-release/ed25519.key (scripts/sign-release.mjs on deploy, scripts/admin.mjs announce). The server
// merely relays the signatures; it checks them too, so a bad release/announcement is caught here first.
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Context, Hono } from "hono";
import { PUBLIC_URL } from "./config.ts";
import { db, all, one, run } from "./db.ts";
import { requireAdmin } from "./safety.ts";
import { ApiError, cleanText } from "./util.ts";

// ---- the CLI we serve, and its signature ----

const CLI_FILE = process.env.AGENTTOWN_CLI_FILE || new URL("../public/cli/agenttown.mjs", import.meta.url).pathname;
const RELEASE_DIR = (process.env.AGENTTOWN_RELEASE_DIR || new URL("../public/cli/", import.meta.url).pathname).replace(/\/?$/, "/");

const cliSource = readFileSync(CLI_FILE, "utf8");
/** Exactly the bytes GET /cli/agenttown.mjs serves (and the release signature covers). */
export const servedCli = Buffer.from(cliSource.replaceAll("{{BASE_URL}}", PUBLIC_URL), "utf8");
export const cliVersion = /export const CLI_VERSION = "([^"]+)"/.exec(cliSource)?.[1] ?? null;
export const releasePubkey = /export const RELEASE_PUBKEY = "([A-Za-z0-9+/=]+)"/.exec(cliSource)?.[1] ?? null;
const cliSha256 = createHash("sha256").update(servedCli).digest("hex");

const pubKey = releasePubkey
  ? createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(releasePubkey, "base64").toString("base64url") }, format: "jwk" })
  : null;

export function verifySig(bytes: Buffer, sig: unknown): boolean {
  if (!pubKey || typeof sig !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(sig)) return false;
  try { return edVerify(null, bytes, pubKey, Buffer.from(sig, "base64")); } catch { return false; }
}

/** The release signature, if public/cli/release.json signs exactly what we serve. */
export const cliSig: string | null = (() => {
  let rel: any;
  try { rel = JSON.parse(readFileSync(`${RELEASE_DIR}release.json`, "utf8")); } catch {
    console.warn(`release: no ${RELEASE_DIR}release.json; /cli/agenttown.mjs is served unsigned (agents will not auto-update to it)`);
    return null;
  }
  if (rel?.sha256 !== cliSha256 || rel?.version !== cliVersion || !verifySig(servedCli, rel?.sig)) {
    console.warn(`release: release.json does not sign the served CLI ${cliVersion} for ${PUBLIC_URL} ` +
      `(signed ${rel?.version} for ${rel?.base_url}); serving it unsigned. Run scripts/sign-release.mjs --base-url ${PUBLIC_URL}`);
    return null;
  }
  return rel.sig as string;
})();

// ---- announcements ----

export const ANNOUNCEMENT_MAX = 280;
const ANN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
type Announcement = { id: string; text: string; url: string | null; expires_at: number | null; sig: string };

/** What an announcement signature covers (same in public/cli/agenttown.mjs and scripts/release-key.mjs). */
export const announcementMessage = (a: { id: string; text: string; url?: string | null; expires_at?: number | null }) =>
  Buffer.from("agenttown/announcement/v1\n" + JSON.stringify({ id: a.id, text: a.text, url: a.url ?? null, expires_at: a.expires_at ?? null }), "utf8");

let annCache: { at: number; value: Announcement | null } | null = null;

async function loadAnnouncement(): Promise<Announcement | null> {
  if (annCache && Date.now() - annCache.at < 30_000) return annCache.value;
  const row = await one(db(), "SELECT v FROM settings WHERE k = 'announcement'");
  let value: Announcement | null = null;
  try { value = row ? JSON.parse(row.v) : null; } catch {}
  annCache = { at: Date.now(), value };
  return value;
}

/** The current announcement for /v1/meta (and the website), unless expired. */
export async function currentAnnouncement(): Promise<Announcement | null> {
  const a = await loadAnnouncement().catch(() => null);
  return a && (!a.expires_at || a.expires_at > Date.now()) ? a : null;
}

function parseAnnouncement(b: Record<string, any>): Announcement {
  const { id, text, sig } = b;
  const url = b.url ?? null, expires_at = b.expires_at ?? null;
  if (typeof id !== "string" || !ANN_ID_RE.test(id)) throw new ApiError(400, "bad_id", "id: 1-40 chars of letters, digits, . _ -");
  if (typeof text !== "string" || !text || cleanText(text, ANNOUNCEMENT_MAX + 1) !== text || [...text].length > ANNOUNCEMENT_MAX) {
    throw new ApiError(400, "bad_text", `text: 1-${ANNOUNCEMENT_MAX} chars, one line, no control characters, no surrounding spaces.`);
  }
  if (url !== null && (typeof url !== "string" || url.length > 300 || !/^https:\/\/[^\s"'<>\\]+$/.test(url))) {
    throw new ApiError(400, "bad_url", "url: an https:// URL (≤ 300 chars) or null.");
  }
  if (expires_at !== null && (!Number.isSafeInteger(expires_at) || expires_at <= Date.now())) {
    throw new ApiError(400, "bad_expires_at", "expires_at: a future time in ms since the epoch, or null.");
  }
  const a = { id, text, url, expires_at, sig };
  if (!verifySig(announcementMessage(a), sig)) {
    throw new ApiError(400, "bad_sig", "sig does not verify against the release key embedded in the CLI (sign with scripts/admin.mjs announce).");
  }
  return a;
}

// ---- CLI version telemetry: private (owner via /v1/me, operator via /v1/admin/homes) ----

/**
 * "agenttown-cli/1.2.0 (hook)" -> "1.2.0". Older CLIs sent "agenttown-cli/<x.y.z>" or "agenttown-cli/1": anything that
 * is not a full x.y.z is "old". Not a CLI (a browser, curl) -> null: not recorded.
 */
export function cliVersionFromUa(ua: string | undefined): string | null {
  const m = /^agenttown-cli\/(\S*)/.exec(ua ?? "");
  if (!m) return null;
  return /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(m[1]) ? m[1] : "old";
}

export const isOutdated = (v: string | null | undefined) => !!v && !!cliVersion && (v === "old" || newer(cliVersion, v));
function newer(a: string, b: string) {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

const seen = new Map<string, { v: string; at: number }>(); // throttles the writes: version change, or every 10 min
const SEEN_WRITE_MS = 10 * 60_000;

/** Called for every authenticated request. Fire-and-forget; never throws. */
export function noteClient(c: Context, auth: { home: Record<string, any>; device_id: string | null }) {
  const v = cliVersionFromUa(c.req.header("user-agent"));
  if (!v) return;
  const key = auth.device_id ? `d:${auth.device_id}` : `h:${auth.home.id}`;
  const now = Date.now();
  const prev = seen.get(key);
  if (prev && prev.v === v && now - prev.at < SEEN_WRITE_MS) return;
  seen.set(key, { v, at: now });
  if (seen.size > 50_000) seen.clear();
  const q = auth.device_id
    ? run(db(), "UPDATE devices SET cli_version = ?, cli_seen_at = ? WHERE id = ?", [v, now, auth.device_id])
    : run(db(), "UPDATE homes SET cli_version = ?, cli_seen_at = ? WHERE id = ?", [v, now, auth.home.id]);
  q.catch((e) => console.error("cli telemetry write failed", e?.message));
  if (!selfUpdates(v)) nudgeUpdate(auth.home.id);
}

// CLIs before 1.2.0 cannot update themselves, and the only thing they surface on their own is the SessionStart line
// built from inbox COUNTS. So such a home gets one unread "cli_update" inbox item per release: its agent sees
// "1 task update waiting — run `agenttown inbox`", and `inbox` (an interactive command) prints the CLI's own
// "update available: run `agenttown update`" line. No server-written text reaches the agent.
const selfUpdates = (v: string) => v !== "old" && !newer("1.2.0", v);
function nudgeUpdate(homeId: string) {
  if (!cliVersion) return;
  run(db(), `INSERT INTO task_inbox (home_id, kind, task_id, from_home, ts, ref_id)
    SELECT ?, 'cli_update', NULL, NULL, ?, ? FROM DUAL
    WHERE NOT EXISTS (SELECT 1 FROM task_inbox WHERE home_id = ? AND kind = 'cli_update' AND ref_id = ?)`,
    [homeId, Date.now(), cliVersion, homeId, cliVersion]).catch((e) => console.error("cli update nudge failed", e?.message));
}

const ACTIVE_MS = 14 * 86_400_000;

/**
 * For the owner's /v1/me: the OLDEST CLI among this home's credentials (owner key + devices) seen in the last 14 days,
 * so one forgotten old machine still shows up as "outdated". null if no CLI was seen.
 */
export async function cliStatus(homeId: string) {
  const rows = await all(db(), `
    SELECT NULL AS device_id, cli_version, cli_seen_at FROM homes WHERE id = ? AND cli_version IS NOT NULL
    UNION ALL
    SELECT id, cli_version, cli_seen_at FROM devices WHERE home_id = ? AND revoked_at IS NULL AND cli_version IS NOT NULL`, [homeId, homeId]);
  if (!rows.length) return { version: null, seen_at: null, latest: cliVersion, outdated: false };
  const recent = rows.filter((r) => Date.now() - Number(r.cli_seen_at) < ACTIVE_MS);
  const pool = recent.length ? recent : rows;
  const rank = (v: string) => (v === "old" ? "0.0.0" : v);
  const oldest = pool.reduce((a, b) => (newer(rank(a.cli_version), rank(b.cli_version)) ? b : a));
  return { version: oldest.cli_version as string, seen_at: Number(oldest.cli_seen_at), latest: cliVersion, outdated: isOutdated(oldest.cli_version) };
}

// ---- routes ----

export async function meta() {
  const announcement = await currentAnnouncement();
  return {
    cli_version: cliVersion,
    cli_sha256: cliSig ? cliSha256 : null,
    cli_sig: cliSig,
    release_pubkey: releasePubkey,
    ...(announcement ? { announcement } : {}),
  };
}

export function mountRelease(app: Hono<any>, api: Hono<any>) {
  app.get("/cli/agenttown.mjs.sig", (c) => {
    if (!cliSig) return c.text("not signed\n", 404);
    return c.body(cliSig + "\n", 200, { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" });
  });
  app.get("/cli/release.json", (c) => {
    if (!cliSig) return c.json({ error: "not_found", message: "This server's CLI is not signed." }, 404);
    return c.json({ version: cliVersion, base_url: PUBLIC_URL, sha256: cliSha256, sig: cliSig }, 200, { "cache-control": "public, max-age=300" });
  });

  // Admin (Bearer ADMIN_TOKEN) — AND the release-key signature for announcements. Self-guarded like feedback.ts.
  api.post("/admin/announcement", requireAdmin, async (c) => {
    let b: any;
    try { b = await c.req.json(); } catch { throw new ApiError(400, "bad_json", "Body must be a JSON object."); }
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new ApiError(400, "bad_json", "Body must be a JSON object.");
    const a = parseAnnouncement(b);
    await run(db(), "INSERT INTO settings (k, v, updated_at) VALUES ('announcement', ?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v), updated_at = VALUES(updated_at)",
      [JSON.stringify(a), Date.now()]);
    annCache = null;
    return c.json({ announcement: a });
  });
  api.delete("/admin/announcement", requireAdmin, async (c) => {
    await run(db(), "DELETE FROM settings WHERE k = 'announcement'");
    annCache = null;
    return c.json({ ok: true });
  });
  api.get("/admin/homes", requireAdmin, async (c) => {
    const lim = Math.min(Math.max(Number(c.req.query("limit")) || 200, 1), 2000);
    const rows = await all(db(), `
      SELECT h.id, h.name, h.created_at, h.cli_version, h.cli_seen_at,
        (SELECT COUNT(*) FROM devices d WHERE d.home_id = h.id AND d.revoked_at IS NULL) AS devices
      FROM homes h ORDER BY COALESCE(h.cli_seen_at, 0) DESC, h.created_at DESC LIMIT ?`, [lim]);
    const homes = [];
    for (const r of rows) {
      const cli = await cliStatus(r.id);
      homes.push({ id: r.id, name: r.name, created_at: Number(r.created_at), devices: Number(r.devices), cli });
    }
    return c.json({ latest: cliVersion, homes });
  });
}
