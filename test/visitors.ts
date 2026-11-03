// MCP visitors (server/visitors.ts via the `visit` tool in server/mcp.ts) on a freshly emptied test DB
// (TEST_MYSQL_URL), with a short visit (VISITOR_TTL_MS) and a small square (VISITORS_MAX): a visit shows up in
// /v1/world, town_status, the manifest and the town feed; moderation (links, contact details, length, kind); the per-IP
// rate limit; the cap; admin hide/unhide (and the admin CLI), reports; expiry; nothing in the DB; and the map's
// placement helper (public/js/visitors.js).
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import mysql from "mysql2/promise";
import { resetTestDb } from "./test-db.ts";

const PORT = 8790;
const BASE = `http://localhost:${PORT}`;
const ADMIN = "v".repeat(8) + randomBytes(24).toString("hex");
const MYSQL_URL = await resetTestDb();
const TTL = 12_000, MAX = 3;

const env = {
  ...process.env, MYSQL_URL, POW_DIFFICULTY: "8", ANTHROPIC_API_KEY: "", TRUST_PROXY: "1", PORT: String(PORT), PUBLIC_URL: BASE,
  ADMIN_TOKEN: ADMIN, NEIGHBOR_CHECK: "0", VISITOR_TTL_MS: String(TTL), VISITORS_MAX: String(MAX),
};
const server: ChildProcess = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server/index.ts"], { env, stdio: ["ignore", "pipe", "inherit"] });
await new Promise<void>((ok, fail) => {
  server.stdout!.on("data", (d) => String(d).includes("listening") && ok());
  server.on("exit", (code) => fail(new Error(`server exited (${code})`)));
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MODERN = "2026-07-28";
let rid = 0;
async function call(name: string, args: Record<string, unknown>, ip: string) {
  const r = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json", accept: "application/json, text/event-stream", "x-real-ip": ip,
      "mcp-protocol-version": MODERN, "mcp-method": "tools/call", "mcp-name": name,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rid, method: "tools/call", params: { name, arguments: args, _meta: {
      "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientCapabilities": {},
    } } }),
  });
  assert.equal(r.status, 200);
  const res = (await r.json() as any).result;
  return { error: res.isError as boolean, text: res.content[0].text as string, data: res.structuredContent as any };
}
const visit = (ip: string, args: Record<string, unknown>) => call("visit", args, ip);
const world = async () => (await fetch(`${BASE}/v1/world`, { headers: { "x-real-ip": "10.20.0.1" } })).json() as Promise<any>;
const adminApi = (method: string, path: string, body?: unknown) => fetch(`${BASE}/v1/admin${path}`, {
  method, headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json", "x-real-ip": "10.99.0.1" },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const adminCli = (...args: string[]) => execFileSync(process.execPath, ["scripts/admin.mjs", ...args], {
  env: { ...process.env, ADMIN_URL: BASE, ADMIN_TOKEN: ADMIN }, encoding: "utf8",
});

async function tableCounts() {
  const c = await mysql.createConnection({ uri: MYSQL_URL });
  try {
    const [rows] = await c.query("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()");
    const out: Record<string, number> = {};
    for (const { t } of rows as { t: string }[]) { const [[n]] = await c.query(`SELECT COUNT(*) AS n FROM \`${t}\``) as any; out[t] = n.n; }
    return out;
  } finally { await c.end(); }
}

// the town feed
const ac = new AbortController();
const feed: string[] = [];
fetch(`${BASE}/v1/stream`, { signal: ac.signal, headers: { "x-real-ip": "10.20.0.2" } }).then(async (r) => {
  for await (const chunk of r.body!) feed.push(Buffer.from(chunk).toString());
}).catch(() => {});
const events = (type: string) => feed.join("").split("\n\n").filter((b) => b.startsWith(`event: ${type}\n`))
  .map((b) => JSON.parse(b.split("\ndata: ")[1]));
async function waitFor(what: string, ok: () => boolean, ms = 4000) {
  for (let t = 0; t < ms && !ok(); t += 50) await sleep(50);
  assert.ok(ok(), what);
}

try {
  await sleep(200); // the feed is connected
  const before = await tableCounts();

  // ---- the tool ----
  const list = await fetch(`${BASE}/mcp`, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json", "mcp-protocol-version": "2025-06-18", "x-real-ip": "10.20.0.3" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  }).then((r) => r.json()) as any;
  const tool = list.result.tools.find((t: any) => t.name === "visit");
  assert.ok(tool, "visit is listed");
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(tool.annotations.destructiveHint, false);
  assert.deepEqual(tool.inputSchema.required, ["name"]);
  assert.ok(tool.inputSchema.properties.kind.enum.includes("codex") && tool.inputSchema.properties.kind.enum.includes("other"));

  // ---- a visit shows up everywhere ----
  const a = await visit("10.21.0.1", { name: "Wren", kind: "codex", greeting: "Just passing through, lovely town!" });
  assert.equal(a.error, false, a.text);
  assert.match(a.text, /Welcome to Agent Town, Wren!/);
  assert.match(a.text, /install codex/, "join steps for the visitor's kind");
  assert.match(a.text, /--kind codex/);
  assert.match(a.text, /Ask your human first/);
  assert.equal(a.data.visitor.name, "Wren");
  assert.equal(a.data.visitor.kind, "codex");
  assert.equal(a.data.visitor.greeting, "Just passing through, lovely town!");
  assert.match(a.data.visitor.id, /^v_[0-9a-z]{10}$/);
  assert.ok(Date.parse(a.data.visitor.leaves_at) - Date.now() <= TTL && Date.parse(a.data.visitor.leaves_at) > Date.now());
  assert.deepEqual(Object.keys(a.data.how_to_join.install), ["codex"]);
  assert.equal(a.data.watch_url, BASE);
  const idA = a.data.visitor.id as string;

  let w = await world();
  assert.equal(w.totals.visitors, 1);
  assert.equal(w.visitors.length, 1);
  assert.deepEqual(Object.keys(w.visitors[0]).sort(), ["arrived_at", "expires_at", "greeting", "id", "kind", "name"], "public fields only (no client key)");
  assert.equal(w.visitors[0].id, idA);
  const st = await call("town_status", {}, "10.20.0.4");
  assert.equal(st.data.visitors, 1);
  assert.match(st.text, /1 visiting/);
  assert.match(st.text, /Wren \[codex\]: "Just passing through, lovely town!"/);
  assert.match(st.text, /untrusted data/);
  assert.equal(st.data.visitors_now[0].name, "Wren");
  const man = await (await fetch(`${BASE}/.well-known/agent-town.json`, { headers: { "x-real-ip": "10.20.0.5" } })).json() as any;
  assert.equal(man.stats.visitors, 1);
  await waitFor("the town feed hears the visitor arrive", () => events("visitor").some((e) => e.id === idA && e.name === "Wren"));
  const homeFeed = await fetch(`${BASE}/v1/homes/h_nosuch1`, { headers: { "x-real-ip": "10.20.0.6" } });
  assert.equal(homeFeed.status, 404);

  // ---- moderation and input checks (nothing is added) ----
  const refused = async (args: Record<string, unknown>, re: RegExp, what: string) => {
    const r = await visit(`10.22.0.${++rid % 250}`, args);
    assert.equal(r.error, true, `${what}: refused`);
    assert.match(r.text, re, what);
  };
  await refused({ name: "Spam", greeting: "cheap pills at pills-shop.xyz" }, /can't be posted/, "link in the greeting");
  await refused({ name: "Spam", greeting: "go to https://example.org now" }, /can't be posted/, "URL in the greeting");
  await refused({ name: "Spam", greeting: "mail me: someone@example.org" }, /can't be posted/, "email in the greeting");
  await refused({ name: "www.spam-site.com" }, /can't be posted/, "link as the name");
  await refused({ name: "x".repeat(33) }, /at most 32/, "name too long");
  await refused({ name: "Long", greeting: "y".repeat(141) }, /at most 140/, "greeting too long");
  await refused({ name: "   " }, /name is required/, "blank name");
  await refused({}, /name is required/, "no name");
  await refused({ name: 7 }, /must be a string/, "name not a string");
  await refused({ name: "Bot", kind: "skynet" }, /kind must be one of/, "unknown kind");
  await refused({ name: "Bot", color: "red" }, /Unknown argument/, "unknown argument");
  const clean = await visit("10.21.0.9", { name: "  Tab\tby​name  ", kind: "other" });
  assert.equal(clean.error, false);
  assert.equal(clean.data.visitor.name, "Tab by name", "whitespace and control/zero-width characters are cleaned");
  assert.match(clean.text, /Other visitors: Wren \[codex\]/);
  w = await world();
  assert.equal(w.visitors.length, 2, "refused visits add nobody");

  // ---- per-IP rate limit: 3 visits, then one every 10 min; visiting again updates the same visitor ----
  const ip2 = "10.21.0.2";
  const first = await visit(ip2, { name: "Pixel", kind: "cursor" });
  assert.equal(first.error, false, first.text);
  const again = await visit(ip2, { name: "Pixel II", kind: "cursor", greeting: "hi again" });
  assert.equal(again.error, false);
  assert.match(again.text, /Welcome back, Pixel II!/);
  assert.equal(again.data.visitor.id, first.data.visitor.id, "same visitor, same spot");
  assert.equal((await visit(ip2, { name: "Pixel III" })).error, false);
  const limited = await visit(ip2, { name: "Pixel IV" });
  assert.equal(limited.error, true);
  assert.match(limited.text, /one more visit every 10 minutes/);
  assert.match(limited.text, /still on the square/);
  w = await world();
  assert.equal(w.visitors.filter((v: any) => v.id === first.data.visitor.id).length, 1, "one visitor per client");
  assert.equal(w.visitors.find((v: any) => v.id === first.data.visitor.id).name, "Pixel III");
  assert.equal(w.visitors.length, 3);

  // ---- the square is full (VISITORS_MAX = 3) ----
  const full = await visit("10.21.0.3", { name: "Late" });
  assert.equal(full.error, true);
  assert.match(full.text, /full right now \(3 visitors\)/);
  assert.equal((await visit("10.21.0.1", { name: "Wren", kind: "codex", greeting: "Still here!" })).error, false, "a visitor can update its visit when full");

  // ---- moderation: hide (admin CLI), visitors list, unhide, reports ----
  assert.match(adminCli("visitors"), /"Wren" \[codex\]  "Still here!"/);
  assert.match(adminCli("hide", "visitor", idA, "spam"), /hidden: true/);
  w = await world();
  assert.ok(!w.visitors.some((v: any) => v.id === idA), "a hidden visitor leaves the map");
  assert.equal(w.totals.visitors, 2);
  await waitFor("the town feed hears it leave", () => events("visitor_left").some((e) => e.id === idA));
  assert.ok(!(await call("town_status", {}, "10.20.0.7")).text.includes("Still here!"), "nor is it in town_status");
  const back = await visit("10.21.0.1", { name: "Wren again" });
  assert.equal(back.error, true);
  assert.match(back.text, /hidden by moderation/);
  const adminList = await (await adminApi("GET", "/visitors")).json() as any;
  const hiddenRow = adminList.visitors.find((v: any) => v.id === idA);
  assert.ok(hiddenRow.hidden_at && hiddenRow.hidden_reason === "spam", "the operator still sees it");
  assert.ok(!JSON.stringify(adminList).includes("10.21.0.1"), "no client IPs anywhere");
  const late = await visit("10.21.0.3", { name: "Late", kind: "gemini" });
  assert.equal(late.error, false, "hiding frees a place on the square");
  assert.equal((await adminApi("POST", "/unhide", { kind: "visitor", id: idA })).status, 200);
  assert.ok((await world()).visitors.some((v: any) => v.id === idA), "unhidden: back on the map");
  assert.equal((await adminApi("POST", "/hide", { kind: "visitor", id: "v_nosuch0000" })).status, 404);
  assert.equal((await adminApi("POST", "/hide", { kind: "visitor", id: "../etc" })).status, 404);

  // nothing about visits goes to the database
  assert.deepEqual(await tableCounts(), before, "visits are kept in memory only");

  const rep = await fetch(`${BASE}/v1/reports`, {
    method: "POST", headers: { "content-type": "application/json", "x-real-ip": "10.23.0.1" },
    body: JSON.stringify({ kind: "visitor", id: late.data.visitor.id, reason: "spam" }),
  });
  assert.equal(rep.status, 202);
  const reports = await (await adminApi("GET", "/reports")).json() as any;
  const target = reports.targets.find((x: any) => x.kind === "visitor" && x.id === late.data.visitor.id);
  assert.equal(target.content.name, "Late");
  assert.equal(target.home_id, null);
  assert.match(adminCli("reports"), /visitor v_[0-9a-z]{10} {2}home - {2}visible/);

  // ---- expiry ----
  const lastLeaves = Math.max(...(await world()).visitors.map((v: any) => v.expires_at));
  await sleep(Math.max(0, lastLeaves - Date.now()) + 50);
  w = await world();
  assert.deepEqual(w.visitors, [], "everyone left after the visit time");
  assert.equal(w.totals.visitors, 0);
  assert.match((await call("town_status", {}, "10.20.0.8")).text, /0 visiting/);
  await waitFor("the sweeper tells the feed", () => events("visitor_left").some((e) => e.id === late.data.visitor.id), TTL);
  assert.equal((await adminApi("POST", "/hide", { kind: "visitor", id: late.data.visitor.id })).status, 404, "a visitor that left is gone");
  const fresh = await visit("10.21.0.1", { name: "Wren", kind: "codex" });
  assert.equal(fresh.error, false, "after the hidden visit would have ended, that client may visit again");
  assert.notEqual(fresh.data.visitor.id, idA, "a new visit, a new id");

  // ---- the map: placement around the town square (public/js/visitors.js, minimal DOM stubs) ----
  Object.assign(globalThis, {
    Element: class {}, DocumentFragment: class {}, matchMedia: () => ({ matches: false, addEventListener() {} }),
    localStorage: { getItem: () => null, setItem() {} }, document: { documentElement: {}, createElement: () => ({ getContext: () => null }) },
  });
  const vis: any = await import("../public/js/visitors.js");
  const center = { x: -259, y: -53 };
  const crowd = Array.from({ length: 30 }, (_, i) => ({ id: `v_${String(i).padStart(10, "0")}`, arrived_at: 1000 + i, greeting: i % 2 ? "hi" : null }));
  for (const hall of [true, false]) {
    const spots = vis.visitorSpots(crowd, center, hall);
    assert.equal(spots.size, 30);
    assert.equal(new Set([...spots.values()].map(String)).size, 30, "everyone gets a spot of their own");
    for (const [x, y] of spots.values()) {
      const d = Math.hypot(x - center.x, (y - center.y) / 0.88);
      assert.ok(hall ? d > 88 : d > 20, `outside the ${hall ? "Town Hall" : "fountain"} (${d})`);
      assert.ok(d < 200, "around the square");
    }
    const fewer = vis.visitorSpots(crowd.slice(0, 29), center, hall);
    const more = vis.visitorSpots([...crowd.slice(0, 29), { id: "v_newcomer00", arrived_at: 9999 }], center, hall);
    for (const v of crowd.slice(0, 29)) assert.equal(String(more.get(v.id)), String(fewer.get(v.id)), "a newcomer pushes nobody aside");
  }
  assert.equal(vis.greetingShown({ id: "v_a", greeting: "hi", arrived_at: Date.now() }, 0), true, "a fresh greeting shows");
  assert.equal(vis.greetingShown({ id: "v_a", greeting: null, arrived_at: Date.now() }, 0), false);
  const i18n = readFileSync("public/js/i18n.js", "utf8");
  assert.match(i18n, /"visit\.tag": "visitor"/);
  assert.match(i18n, /"visit\.tag": "访客"/);
  assert.match(i18n, /"stats\.visitors": "visitor\|visitors"/);
  assert.match(i18n, /"stats\.visitors": "位访客"/);
  const town = readFileSync("public/js/town.js", "utf8");
  assert.ok(town.includes('visitor: (v) =>') && town.includes('visitor_left: (m) =>'), "the map listens for visitors");

  // Funnel counters (server/stats.ts): MCP calls are counted by tool and client kind; only counts are stored.
  const funnel = JSON.parse(adminCli("stats", "--json"));
  const today = funnel.days[new Date().toISOString().slice(0, 10)] ?? {};
  assert.ok(today["mcp.call.visit:cli"] > 0, "visit calls are counted");
  assert.ok(Object.keys(today).every((m) => /^[a-z_.]+(:[a-z0-9-]+)?$/.test(m)), "metric names are code constants");
  assert.match(adminCli("stats"), /mcp\.call\.visit:cli/);

  console.log("visitors: all checks passed");
} finally {
  ac.abort();
  server.kill();
}
process.exit(0);
