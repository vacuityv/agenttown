// Agent City (federation, phase 1) on a freshly emptied test DB (TEST_MYSQL_URL): the A2A agent card, the stateless
// A2A JSON-RPC endpoint (intents, v1 + v0.3 shapes, errors, stores nothing), the town manifest, the neighbor checker
// (mutual / listed against local stub manifests), /neighbors, discovery hints, and home roles (townhall).
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import mysql from "mysql2/promise";
import { resetTestDb } from "./test-db.ts";
import { checkNeighbors, linksBack, publicNeighbors, resetNeighborState, type NeighborDef } from "../server/federation.ts";

const PORT = 8793;
const BASE = `http://localhost:${PORT}`;
const ADMIN = "a".repeat(8) + randomBytes(24).toString("hex");
const MYSQL_URL = await resetTestDb();
const dir = mkdtempSync(join(tmpdir(), "agenttown-federation-"));

// ---- stub neighbor manifests ----
let toggle = { links: true };
const stub: Server = createServer((req, res) => {
  const send = (code: number, body: string, type = "application/json") => { res.writeHead(code, { "content-type": type }); res.end(body); };
  if (req.url === "/mutual.json") return send(200, JSON.stringify({ schema: "agent-town/0.1", name: "Stub Mutual", neighbors: [{ name: "Agent Town", url: BASE }] }));
  if (req.url === "/xyz.json") return send(200, JSON.stringify({ name: "Links to prod", see: "We love https://agenttown.xyz/neighbors" }));
  if (req.url === "/listed.json") return send(200, JSON.stringify({ name: "Stub Listed", neighbors: [{ url: "https://example.org" }] }));
  if (req.url === "/toggle.json") return send(200, JSON.stringify(toggle.links ? { home: BASE + "/" } : { home: "https://elsewhere.example" }));
  if (req.url === "/html") return send(200, "<html>not json</html>", "text/html");
  if (req.url === "/slow") { setTimeout(() => send(200, "{}"), 3000); return; }
  send(500, "{}");
});
await new Promise<void>((ok) => stub.listen(0, "127.0.0.1", () => ok()));
const STUB = `http://127.0.0.1:${(stub.address() as any).port}`;
const neighborsFile = join(dir, "neighbors.json");
writeFileSync(neighborsFile, JSON.stringify({ neighbors: [
  { name: "Stub Mutual", url: "https://mutual.example", kind: "town", agent_entry: `${STUB}/mutual.json`, manifest_url: `${STUB}/mutual.json`, notes: "links back" },
  { name: "Stub Listed", url: "https://listed.example", kind: "agent-forum", agent_entry: null, manifest_url: `${STUB}/listed.json`, notes: "no link back" },
  { name: "Stub Broken", url: "https://broken.example", kind: "simulation", manifest_url: `${STUB}/broken`, notes: "500s" },
  { name: "No Manifest", url: "https://plain.example", kind: "project", notes: "no manifest", notes_zh: "没有清单" },
  { name: "bad entry", url: "javascript:alert(1)", kind: "x" },
] }));

const env = {
  ...process.env, MYSQL_URL, POW_DIFFICULTY: "8", ANTHROPIC_API_KEY: "", TRUST_PROXY: "1", PORT: String(PORT), PUBLIC_URL: BASE,
  ADMIN_TOKEN: ADMIN, NEIGHBORS_FILE: neighborsFile, NEIGHBOR_CHECK_DELAY_MS: "0", NEIGHBOR_CHECK_TICK_MS: "3600000",
};
const server: ChildProcess = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server/index.ts"], { env, stdio: ["ignore", "pipe", "inherit"] });
await new Promise<void>((ok, fail) => {
  server.stdout!.on("data", (d) => String(d).includes("listening") && ok());
  server.on("exit", (code) => fail(new Error(`server exited (${code})`)));
});

let ipSeq = 0;
const freshIp = () => `10.8.${Math.floor(++ipSeq / 250)}.${ipSeq % 250 + 1}`;
const getJson = async (p: string) => { const r = await fetch(BASE + p, { headers: { "x-real-ip": freshIp() } }); return { status: r.status, headers: r.headers, body: await r.json() as any }; };
async function rpc(body: unknown, { ip = freshIp(), headers = {} as Record<string, string>, raw = false } = {}) {
  const r = await fetch(`${BASE}/a2a`, {
    method: "POST", headers: { "content-type": "application/json", "x-real-ip": ip, ...headers },
    body: raw ? (body as string) : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() as any };
}
const send = (text: string, method = "SendMessage", extra: Record<string, unknown> = {}) => rpc({
  jsonrpc: "2.0", id: 7, method,
  params: { message: { messageId: "m-" + randomBytes(4).toString("hex"), role: method === "SendMessage" ? "ROLE_USER" : "user",
    parts: [method === "SendMessage" ? { text } : { kind: "text", text }], ...extra } },
});
const textOf = (r: any) => (r.body.result.message ?? r.body.result).parts.map((p: any) => p.text ?? "").join("\n");
const dataOf = (r: any) => (r.body.result.message ?? r.body.result).parts.find((p: any) => p.data)?.data;

const cliEnv = (name: string) => ({ ...env, AGENTTOWN_CONFIG: join(dir, name, "config.json"), AGENTTOWN_SERVER: BASE });
const cli = (cfg: string, ...args: string[]) =>
  execFileSync(process.execPath, ["public/cli/agenttown.mjs", ...args], { env: cliEnv(cfg), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const admin = (...args: string[]) => execFileSync(process.execPath, ["scripts/admin.mjs", ...args],
  { env: { ...process.env, ADMIN_URL: BASE, ADMIN_TOKEN: ADMIN }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

async function tableCounts() {
  const c = await mysql.createConnection({ uri: MYSQL_URL });
  try {
    const [rows] = await c.query("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()");
    const out: Record<string, number> = {};
    for (const { t } of rows as { t: string }[]) {
      const [[n]] = await c.query(`SELECT COUNT(*) AS n FROM \`${t}\``) as any;
      out[t] = n.n;
    }
    return out;
  } finally { await c.end(); }
}

try {
  // ---- residents ----
  assert.match(cli("a", "register", "--home", "Mayor's Office"), /Registered home/);
  assert.match(cli("b", "register", "--home", "Second Home"), /Registered home/);
  const homeA = JSON.parse(readFileSync(join(dir, "a", "config.json"), "utf8")).home_id as string;
  const homeB = JSON.parse(readFileSync(join(dir, "b", "config.json"), "utf8")).home_id as string;
  cli("a", "report", "--persona", "Mayor", "--kind", "claude-code", "--session", "s-1", "--status", "thinking");

  // ---- agent card ----
  const card = await getJson("/.well-known/agent-card.json");
  assert.equal(card.status, 200);
  assert.equal(card.headers.get("access-control-allow-origin"), "*");
  const c = card.body;
  for (const k of ["name", "description", "supportedInterfaces", "version", "capabilities", "defaultInputModes", "defaultOutputModes", "skills"]) {
    assert.ok(c[k] !== undefined, `agent card has required field ${k}`);
  }
  assert.equal(c.name, "Agent Town");
  assert.equal(c.version, JSON.parse(readFileSync("package.json", "utf8")).version);
  assert.deepEqual(c.provider, { organization: "Agent Town", url: BASE });
  assert.equal(c.documentationUrl, `${BASE}/agents.md`);
  assert.ok(c.supportedInterfaces.length >= 1);
  for (const i of c.supportedInterfaces) { assert.ok(i.url && i.protocolBinding && i.protocolVersion, "AgentInterface required fields"); }
  assert.deepEqual(c.supportedInterfaces[0], { url: `${BASE}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0" });
  assert.equal(c.capabilities.streaming, false);
  assert.equal(c.capabilities.pushNotifications, false);
  assert.ok(c.defaultInputModes.includes("text/plain") && c.defaultOutputModes.includes("text/plain"));
  assert.deepEqual(c.skills.map((s: any) => s.id).sort(), ["move-in", "neighbors", "town-status"]);
  for (const s of c.skills) assert.ok(s.id && s.name && s.description && Array.isArray(s.tags) && s.tags.length, "AgentSkill required fields");
  assert.equal(c.url, `${BASE}/a2a`, "v0.3 compat url");
  assert.deepEqual((await getJson("/.well-known/agent.json")).body, c, "older well-known path serves the same card");

  // ---- A2A: nothing stored ----
  const before = await tableCounts();
  const MARK = `marker-${randomBytes(6).toString("hex")}`;

  const joinR = await send(`Hi! How do I join Agent Town? ${MARK}`);
  assert.equal(joinR.status, 200);
  assert.equal(joinR.body.jsonrpc, "2.0");
  assert.equal(joinR.body.id, 7);
  const jm = joinR.body.result.message;
  assert.equal(jm.role, "ROLE_AGENT");
  assert.ok(jm.messageId && jm.contextId);
  assert.equal(jm.parts[0].mediaType, "text/plain");
  const jt = textOf(joinR);
  assert.ok(jt.includes(`${BASE}/agents.md`) && jt.includes("/plugin install agenttown@agenttown") && jt.includes("agenttown join"), jt);
  assert.ok(jt.includes("human"), "consent is mentioned");
  assert.ok(!JSON.stringify(joinR.body).includes(MARK), "input is never echoed");
  assert.equal(dataOf(joinR).intent, "join");
  assert.equal(dataOf(joinR).links.llms_txt, `${BASE}/llms.txt`);

  const who = await send("who's online right now?");
  const st = dataOf(who);
  assert.equal(st.intent, "status");
  assert.equal(st.stats.homes, 2);
  assert.equal(st.stats.agents_online, 1);
  assert.equal(st.stats.busy, 1);
  assert.ok(st.stats.newest_homes.some((h: any) => h.name === "Second Home" && h.url === `${BASE}/h/${homeB}`));
  assert.match(textOf(who), /2 homes, 1 agents online, 1 busy/);

  const nb = await send("Are there other towns nearby?");
  assert.equal(dataOf(nb).intent, "neighbors");
  assert.ok(textOf(nb).includes("Stub Mutual") && textOf(nb).includes("No Manifest"));
  assert.ok(!textOf(nb).includes("bad entry"), "invalid neighbor entries are skipped");
  assert.ok(textOf(nb).includes("private data"));

  const hello = await send("hello there");
  assert.equal(dataOf(hello).intent, "overview");
  const zh = await send("我怎么入住？");
  assert.equal(dataOf(zh).intent, "join");
  const bySkill = await rpc({ jsonrpc: "2.0", id: "x", method: "SendMessage", params: { message: { messageId: "m", role: "ROLE_USER", parts: [{ data: { skill: "town-status" } }] } } });
  assert.equal(dataOf(bySkill).intent, "status", "data.skill picks the skill");

  // v0.3 shape
  const old = await send("how can I move in?", "message/send", { contextId: "ctx-123" });
  assert.equal(old.body.result.kind, "message");
  assert.equal(old.body.result.role, "agent");
  assert.equal(old.body.result.contextId, "ctx-123");
  assert.equal(old.body.result.parts[0].kind, "text");
  assert.equal(old.body.result.parts[1].kind, "data");
  assert.ok(old.body.result.parts[0].text.includes("/agents.md"));
  const badCtx = await send("hi", "SendMessage", { contextId: "<script>" + MARK });
  assert.notEqual(badCtx.body.result.message.contextId, "<script>" + MARK, "odd contextIds are not echoed");

  // errors
  const err = async (body: unknown, code: number, opts?: Parameters<typeof rpc>[1]) => {
    const r = await rpc(body, opts);
    assert.ok(r.body.error, JSON.stringify(r.body));
    assert.equal(r.body.error.code, code, JSON.stringify(r.body));
    assert.equal(r.body.jsonrpc, "2.0");
    return r;
  };
  await err({ jsonrpc: "2.0", id: 1, method: "tasks/get", params: { id: "t1" } }, -32004);
  await err({ jsonrpc: "2.0", id: 1, method: "GetTask", params: { id: "t1" } }, -32004);
  await err({ jsonrpc: "2.0", id: 1, method: "SendStreamingMessage", params: {} }, -32004);
  await err({ jsonrpc: "2.0", id: 1, method: "GetExtendedAgentCard" }, -32007);
  const nf = await err({ jsonrpc: "2.0", id: 9, method: "summon/dragon" }, -32601);
  assert.equal(nf.body.id, 9);
  await err({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: {} }, -32602);
  await err({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { parts: [] } } }, -32602);
  await err([{ jsonrpc: "2.0", id: 1, method: "SendMessage" }], -32600);
  await err({ id: 1, method: "SendMessage" }, -32600);
  await err("{not json", -32700, { raw: true });
  await err({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { parts: [{ text: "hi" }] } } }, -32009, { headers: { "A2A-Version": "9.9" } });
  assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { parts: [{ text: "hi" }] } } }, { headers: { "A2A-Version": "0.3" } })).status, 200);
  const big = await rpc(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { parts: [{ text: "x".repeat(70_000) }] } } }), { raw: true });
  assert.equal(big.status, 413);
  assert.equal(big.body.error.code, -32600);
  // rate limit: 1/s per IP, burst 20
  const ip = freshIp();
  const burst = await Promise.all(Array.from({ length: 26 }, () => rpc({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { parts: [{ text: "hi" }] } } }, { ip })));
  assert.ok(burst.some((r) => r.status === 429 && r.body.error?.code === -32000), "rate limited");
  assert.equal((await fetch(`${BASE}/a2a`)).status, 405, "GET /a2a explains itself");

  assert.deepEqual(await tableCounts(), before, "the A2A endpoint stores nothing");

  // ---- manifest + neighbor checker ----
  let man: any;
  for (let i = 0; i < 50; i++) { // the checker's first run starts at boot (NEIGHBOR_CHECK_DELAY_MS=0)
    man = (await getJson("/.well-known/agent-town.json")).body;
    if (man.neighbors.find((n: any) => n.name === "Stub Mutual")?.relation === "mutual") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(man.schema, "agent-town/0.1");
  assert.equal(man.name, "Agent Town");
  assert.equal(man.url, BASE);
  assert.deepEqual(man.operator, { name: "The Mayor (an AI agent) on behalf of the founder", url: "https://agenttown.xyz/h/h_ysz4h16y" });
  assert.equal(man.license, "MIT");
  assert.match(man.source, /github\.com/);
  assert.equal(man.docs.agents_md, `${BASE}/agents.md`);
  assert.equal(man.docs.llms_txt, `${BASE}/llms.txt`);
  assert.ok(man.docs.protocol.endsWith("docs/protocol.md"));
  assert.equal(man.standards.a2a_agent_card, `${BASE}/.well-known/agent-card.json`);
  assert.equal(man.standards.a2a_endpoint, `${BASE}/a2a`);
  assert.deepEqual({ method: man.join.method, instructions: man.join.instructions, human_approval: man.join.human_approval },
    { method: "agent-self-onboarding", instructions: `${BASE}/agents.md`, human_approval: "the agent's own human decides" });
  assert.deepEqual(Object.keys(man.public_api).sort(), ["cemetery", "stream", "tasks", "town", "world"]);
  assert.equal(man.public_api.world, `${BASE}/v1/world`);
  assert.ok(man.privacy.encrypted && man.privacy.public.includes("tool names"));
  assert.deepEqual({ homes: man.stats.homes, agents_online: man.stats.agents_online, busy: man.stats.busy }, { homes: 2, agents_online: 1, busy: 1 });
  assert.ok(!Number.isNaN(Date.parse(man.updated_at)));
  const rel = Object.fromEntries(man.neighbors.map((n: any) => [n.name, n.relation]));
  assert.deepEqual(rel, { "Stub Mutual": "mutual", "Stub Listed": "listed", "Stub Broken": "listed", "No Manifest": "listed" });
  for (const n of man.neighbors) for (const k of ["name", "url", "kind", "agent_entry", "relation", "notes"]) assert.ok(k in n, `neighbor.${k}`);
  assert.equal(man.neighbors.find((n: any) => n.name === "No Manifest").notes_zh, "没有清单");

  // checker logic in-process: upgrade, downgrade, failures keep the last relation, never throws
  resetNeighborState();
  const list: NeighborDef[] = [
    { name: "T", url: "https://t.example", kind: "town", manifest_url: `${STUB}/toggle.json` },
    { name: "X", url: "https://x.example", kind: "town", manifest_url: `${STUB}/xyz.json` },
    { name: "H", url: "https://h.example", kind: "town", manifest_url: `${STUB}/html` },
    { name: "S", url: "https://s.example", kind: "town", manifest_url: `${STUB}/slow` },
  ];
  const relOf = () => Object.fromEntries(publicNeighbors(list).map((n) => [n.name, n.relation]));
  toggle.links = true;
  await checkNeighbors(list, { publicUrl: BASE, timeoutMs: 500, minAgeMs: 0 });
  assert.deepEqual(relOf(), { T: "mutual", X: "mutual", H: "listed", S: "listed" });
  toggle.links = false;
  await checkNeighbors(list, { publicUrl: BASE, timeoutMs: 500 }); // not due yet (6 h): nothing changes
  assert.equal(relOf().T, "mutual");
  await checkNeighbors(list, { publicUrl: BASE, timeoutMs: 500, now: Date.now() + 6 * 3600_000 + 1 });
  assert.equal(relOf().T, "listed", "downgraded when the link back disappears");
  list[0].manifest_url = `${STUB}/broken`;
  toggle.links = true;
  await checkNeighbors([list[1]], { publicUrl: BASE, minAgeMs: 0, fetchImpl: (async () => { throw new Error("offline"); }) as any });
  assert.equal(relOf().X, "mutual", "a failed fetch keeps the last relation");
  assert.equal(linksBack({ a: ["see http://agenttown.xyz.evil.example/x"] }, BASE), false, "look-alike hosts don't count");
  assert.equal(linksBack({ a: { b: "https://www.agenttown.xyz" } }, BASE), true);

  // ---- web + discovery hints ----
  const page = await fetch(`${BASE}/neighbors`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('<main id="main">'), "/neighbors serves index.html");
  assert.ok(page.headers.get("content-security-policy")?.includes("script-src 'self'"));
  assert.ok(html.includes('<link rel="alternate" type="application/json" href="/.well-known/agent-town.json"'));
  assert.ok(html.includes('<meta name="agent-town"'));
  assert.ok(html.includes('href="/neighbors"'), "footer link");
  const llms = await (await fetch(`${BASE}/llms.txt`)).text();
  assert.ok(llms.includes("/.well-known/agent-card.json") && llms.includes("/.well-known/agent-town.json") && llms.includes("(/a2a)"));
  const robots = await (await fetch(`${BASE}/robots.txt`)).text();
  assert.ok(robots.includes("Allow: /.well-known/") && robots.includes("Allow: /a2a"));
  const agentsMd = await (await fetch(`${BASE}/agents.md`)).text();
  assert.ok(agentsMd.includes(`${BASE}/a2a`) && agentsMd.includes("Neighboring towns (Agent City)"));

  // ---- home roles ----
  const role = (id: string, body: unknown, token = ADMIN) => fetch(`${BASE}/v1/admin/homes/${id}/role`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-real-ip": "10.9.9.9" }, body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() as any }));
  const roleOf = async (id: string) => (await getJson("/v1/world")).body.homes.find((h: any) => h.id === id).role;
  assert.equal(await roleOf(homeA), null, "role is public and null by default");
  assert.equal((await role(homeA, { role: "townhall" }, "nope".repeat(10))).status, 401);
  assert.equal((await role(homeA, { role: "castle" })).status, 400);
  assert.equal((await role("h_nonexist", { role: "townhall" })).status, 404);
  assert.match(admin("set-role", homeA, "townhall"), new RegExp(`${homeA}: role townhall`));
  assert.equal(await roleOf(homeA), "townhall");
  assert.equal((await getJson(`/v1/homes/${homeA}`)).body.home.role, "townhall");
  assert.equal((await getJson(`/v1/town?ids=${homeA}`)).body.homes[0].role, "townhall");
  const moved = await role(homeB, { role: "townhall" });
  assert.equal(moved.status, 200);
  assert.deepEqual(moved.body.cleared, [homeA], "only one townhall: setting it moves it");
  assert.equal(await roleOf(homeA), null);
  assert.equal(await roleOf(homeB), "townhall");
  assert.match(admin("set-role", homeB, "null"), /role none/);
  assert.equal(await roleOf(homeB), null);

  // ---- map placement (public/js/village.js, with minimal DOM stubs): the townhall moves to the center, nobody else moves ----
  Object.assign(globalThis, {
    Element: class {}, DocumentFragment: class {}, matchMedia: () => ({ matches: false, addEventListener() {} }),
    localStorage: { getItem: () => null, setItem() {} }, document: { documentElement: {}, createElement: () => ({ getContext: () => null }) },
  });
  const village: any = await import("../public/js/village.js");
  const N = 60;
  village.bindHomes((k: number) => `h_test${k}`, () => N);
  const pos0 = Array.from({ length: N }, (_, k) => String(village.homeCenter(k)));
  const featKinds0 = village.featuresUpTo(village.homeSlot(N) + 9).map((f: any) => f.kind);
  assert.ok(!featKinds0.includes("square") && !featKinds0.includes("lot") && featKinds0.includes("signpost"));
  assert.equal(village.setTownhall(23), true);
  const center = village.townCenter();
  assert.deepEqual(village.homeCenter(23), [center.x, center.y], "the townhall stands at the town center");
  for (let k = 0; k < N; k++) if (k !== 23) assert.equal(String(village.homeCenter(k)), pos0[k], `home ${k} did not move`);
  const feats = village.featuresUpTo(village.homeSlot(N) + 9);
  const sq = feats.find((f: any) => f.kind === "square"), lot = feats.find((f: any) => f.kind === "lot");
  assert.equal(sq.slot, center.slot, "its square replaces the central plaza");
  assert.equal(feats.filter((f: any) => f.slot === center.slot).length, 1, "no plaza on top of the town hall");
  assert.equal(String([lot.x, lot.y]), pos0[23], "its own slot is an empty lot");
  assert.equal(village.homeLayout(23).f, village.HALL_SCALE);
  assert.ok(village.homeLayout(23).rx > village.homeLayout(5).rx * 1.1 || village.HALL_SCALE > 1, "drawn larger");
  assert.ok(village.homesIn(center.x - 5, center.y - 5, center.x + 5, center.y + 5, N).includes(23), "spatial index follows the move");
  const sign = feats.find((f: any) => f.kind === "signpost");
  const maxR = Math.max(...Array.from({ length: N }, (_, k) => Math.hypot(...(village.homeCenter(k) as [number, number]))));
  assert.ok(Math.hypot(sign.x, sign.y) > maxR + 60, "the Agent City signpost is outside the explored area");
  assert.deepEqual(village.signpostPos(village.homeSlot(N) + 9), { x: sign.x, y: sign.y }, "deterministic");
  village.setTownhall(null);
  assert.equal(String(village.homeCenter(23)), pos0[23]);

  console.log("federation: all checks passed");
} finally {
  server.kill();
  stub.close();
  stub.closeAllConnections?.();
}
process.exit(0);
