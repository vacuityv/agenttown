import { readFileSync } from "node:fs";
import { Hono, type Context } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { getConnInfo } from "@hono/node-server/conninfo";
import { streamSSE } from "hono/streaming";
import { bodyLimit } from "hono/body-limit";
import { PORT, POW_DIFFICULTY, PUBLIC_URL, TRUST_PROXY } from "./config.ts";
import { bus, type BusEvent } from "./bus.ts";
import * as store from "./store.ts";
import { startAvatarWorker } from "./avatar.ts";
import { initDb } from "./db.ts";
import {
  ApiError, AUTH_TOKEN_RE, TASK_ENC_RE, allow, cleanText, cleanTool, issueChallenge, sha256hex, verifyPow,
} from "./util.ts";

type Env = { Variables: { home: { id: string; name: string } } };
const app = new Hono<Env>();

app.onError((err, c) => {
  if (err instanceof ApiError) return c.json({ error: err.code, message: err.message }, err.status as any);
  console.error(err);
  return c.json({ error: "internal", message: "Internal error" }, 500);
});

const clientIp = (c: Context) =>
  (TRUST_PROXY && c.req.header("x-real-ip")) || getConnInfo(c).remote.address || "unknown";

function limit(key: string, perSec: number, burst: number) {
  if (!allow(key, perSec, burst)) throw new ApiError(429, "rate_limited", "Slow down.");
}

async function body(c: Context): Promise<Record<string, any>> {
  try {
    const b = await c.req.json();
    if (b && typeof b === "object" && !Array.isArray(b)) return b;
  } catch {}
  throw new ApiError(400, "bad_json", "Body must be a JSON object.");
}

const requireAuth = async (c: Context<Env>, next: () => Promise<void>) => {
  const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!AUTH_TOKEN_RE.test(token)) throw new ApiError(401, "unauthorized", "Missing or malformed bearer token.");
  const home = await store.homeByAuth(sha256hex(token));
  if (!home) throw new ApiError(401, "unauthorized", "Unknown token.");
  c.set("home", { id: home.id, name: home.name });
  await next();
};

const api = new Hono<Env>();
api.use("*", bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "too_large" }, 413) }));

// ---- registration ----

api.get("/register/challenge", (c) => {
  limit(`chal:${clientIp(c)}`, 1 / 10, 10);
  return c.json({ challenge: issueChallenge(), difficulty: POW_DIFFICULTY });
});

api.post("/register", async (c) => {
  limit(`reg:${clientIp(c)}`, 5 / 3600, 5);
  const b = await body(c);
  const name = cleanText(b.home_name, 40);
  if (!name) throw new ApiError(400, "bad_home_name", "home_name is required (1-40 chars).");
  if (typeof b.auth_token !== "string" || !AUTH_TOKEN_RE.test(b.auth_token)) {
    throw new ApiError(400, "bad_auth_token", "auth_token must be 64 lowercase hex chars.");
  }
  if (typeof b.challenge !== "string" || typeof b.nonce !== "string" || !verifyPow(b.challenge, b.nonce, POW_DIFFICULTY)) {
    throw new ApiError(400, "bad_pow", "Invalid, expired or reused proof-of-work.");
  }
  const home = await store.createHome(sha256hex(b.auth_token), name);
  return c.json({ home, home_url: `${PUBLIC_URL}/h/${home.id}` }, 201);
});

// ---- authenticated ----

api.get("/me", requireAuth, (c) => {
  const home = c.get("home");
  return c.json({ home: { id: home.id, name: home.name }, home_url: `${PUBLIC_URL}/h/${home.id}` });
});

api.patch("/home", requireAuth, async (c) => {
  const name = cleanText((await body(c)).name, 40);
  if (!name) throw new ApiError(400, "bad_home_name", "name is required (1-40 chars).");
  return c.json({ home: await store.renameHome(c.get("home").id, name) });
});

function personaFields(p: any) {
  const name = cleanText(p?.name, 32);
  const kind = cleanText(p?.kind, 24)?.toLowerCase().replace(/[^a-z0-9-]/g, "-") || "other";
  if (!name) throw new ApiError(400, "bad_persona", "persona.name is required (1-32 chars).");
  return { name, kind };
}

api.post("/personas", requireAuth, async (c) => {
  const home = c.get("home");
  limit(`persona:${home.id}`, 1 / 60, 10);
  const b = await body(c);
  const { name, kind } = personaFields(b);
  const appearance = b.appearance === undefined ? null : cleanText(b.appearance, 200);
  return c.json({ persona: await store.upsertPersona(home.id, name, kind, appearance) });
});

api.post("/report", requireAuth, async (c) => {
  const home = c.get("home");
  limit(`report:${home.id}`, 20, 120);
  const b = await body(c);
  const persona = personaFields(b.persona);
  const session = typeof b.session === "string" && /^[\w.:-]{1,128}$/.test(b.session) ? b.session : null;
  if (!session) throw new ApiError(400, "bad_session", "session must match [\\w.:-]{1,128}.");
  const parent = typeof b.parent === "string" && /^[\w.:-]{1,128}$/.test(b.parent) ? b.parent : null;
  if (!store.STATUSES.includes(b.status)) {
    throw new ApiError(400, "bad_status", `status must be one of ${store.STATUSES.join(", ")}.`);
  }
  let task: store.ReportInput["task"] = null;
  if (b.task) {
    const enc = b.task.title_enc ?? null;
    if (enc !== null && (typeof enc !== "string" || !TASK_ENC_RE.test(enc))) {
      throw new ApiError(400, "bad_task", "task.title_enc must be a v1 ciphertext (see /agents.md). Never send plaintext.");
    }
    task = { title_enc: enc };
  }
  const r = await store.report(home.id, { persona, session, parent, status: b.status, tool: cleanTool(b.tool), task });
  return c.json(r);
});

// ---- public ----

api.get("/world", async (c) => {
  const lim = Math.min(Number(c.req.query("limit")) || 500, 2000);
  const off = Math.max(Number(c.req.query("offset")) || 0, 0);
  return c.json(await store.world(lim, off));
});

const publicHome = async (c: Context) => {
  const h = await store.homeById(c.req.param("id") ?? "");
  if (!h) throw new ApiError(404, "not_found", "No such home.");
  return h;
};

api.get("/town", async (c) => {
  limit(`town:${clientIp(c)}`, 10, 60);
  const ids = (c.req.query("ids") ?? "").split(",").filter((s) => /^h_[0-9a-z]{4,16}$/.test(s)).slice(0, 100);
  return c.json({ homes: await store.town(ids) });
});

api.get("/homes/:id", async (c) => {
  const h = await publicHome(c);
  return c.json({
    home: store.publicHome(h),
    personas: await store.personasOfHome(h.id),
    sessions: await store.openSessionsOfHome(h.id),
  });
});

api.get("/homes/:id/stats", async (c) => {
  const days = Math.min(Math.max(Number(c.req.query("days")) || 14, 1), 90);
  return c.json(await store.stats((await publicHome(c)).id, days));
});

api.get("/homes/:id/events", async (c) => {
  const before = Number(c.req.query("before")) || Date.now() + 1;
  const lim = Math.min(Number(c.req.query("limit")) || 100, 500);
  return c.json({ events: await store.events((await publicHome(c)).id, before, lim) });
});

// Live updates. ?home=<id>: everything about one home. Without it: the town feed (home, counts, agent, persona).
api.get("/stream", (c) => {
  const only = c.req.query("home");
  return streamSSE(c, async (stream) => {
    const queue: BusEvent[] = [];
    let wake: (() => void) | null = null;
    const off = bus.on((e) => {
      // Home stream: everything about that home. Town stream: homes, counts, agent positions, looks.
      if (only ? e.home_id !== only || e.type === "counts" || e.type === "agent" : e.type === "session") return;
      queue.push(e);
      wake?.();
    });
    stream.onAbort(() => { off(); wake?.(); });
    // Cloudflare drops idle connections after ~100s.
    const ping = setInterval(() => { queue.push({ type: "ping" } as any); wake?.(); }, 25_000);
    await stream.writeSSE({ event: "hello", data: JSON.stringify({ t: Date.now() }) });
    try {
      while (!stream.aborted) {
        if (!queue.length) await new Promise<void>((r) => (wake = r));
        wake = null;
        for (const e of queue.splice(0)) {
          if ((e as any).type === "ping") await stream.writeSSE({ event: "ping", data: "{}" });
          else await stream.writeSSE({ event: e.type, data: JSON.stringify({ home_id: e.home_id, ...(e.data as object) }) });
        }
      }
    } finally {
      clearInterval(ping);
      off();
    }
  });
});

app.route("/v1", api);

// ---- static: agents.md and the CLI get the public URL baked in ----

const templated = (file: string, type: string) => {
  const body = readFileSync(new URL(`../public/${file}`, import.meta.url), "utf8").replaceAll("{{BASE_URL}}", PUBLIC_URL);
  return (c: Context) => c.body(body, 200, { "content-type": type, "cache-control": "public, max-age=300" });
};
app.get("/agents.md", templated("agents.md", "text/markdown; charset=utf-8"));
app.get("/cli/agenttown.mjs", templated("cli/agenttown.mjs", "text/javascript; charset=utf-8"));
app.get("/cli/agenttown-mcp.mjs", templated("../plugins/mcp/agenttown-mcp.mjs", "text/javascript; charset=utf-8"));
app.get("/h/:id", serveStatic({ path: "./public/index.html" }));
app.use("/*", serveStatic({ root: "./public" }));

setInterval(() => {
  store.sweep().catch((e) => console.error("sweep failed", e));
}, 60_000).unref();

try {
  await initDb();
} catch (e) {
  console.error(`agenttown: database init failed: ${(e as Error).message}`);
  process.exit(1);
}

startAvatarWorker();

serve({ fetch: app.fetch, port: PORT }, () => console.log(`agenttown listening on :${PORT} (${PUBLIC_URL})`));
