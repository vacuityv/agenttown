// Remote MCP server (server/mcp.ts) on a freshly emptied test DB (TEST_MYSQL_URL): legacy handshake (initialize,
// notifications/initialized, ping) and modern per-request metadata (2026-07-28: server/discover, header validation,
// version errors), tools/list, every tool, bad JSON-RPC, HTTP details (405, CORS, Origin, SSE-only Accept, rate limit),
// moderation (hidden homes), that nothing private leaks and nothing is stored, and the discovery documents.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import mysql from "mysql2/promise";
import { resetTestDb } from "./test-db.ts";

const PORT = 8788;
const BASE = `http://localhost:${PORT}`;
const ADMIN = "a".repeat(8) + randomBytes(24).toString("hex");
const MYSQL_URL = await resetTestDb();
const dir = mkdtempSync(join(tmpdir(), "agenttown-mcp-"));
const MODERN = "2026-07-28";

const env = {
  ...process.env, MYSQL_URL, POW_DIFFICULTY: "8", ANTHROPIC_API_KEY: "", TRUST_PROXY: "1", PORT: String(PORT), PUBLIC_URL: BASE,
  ADMIN_TOKEN: ADMIN, NEIGHBOR_CHECK: "0",
};
const server: ChildProcess = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server/index.ts"], { env, stdio: ["ignore", "pipe", "inherit"] });
await new Promise<void>((ok, fail) => {
  server.stdout!.on("data", (d) => String(d).includes("listening") && ok());
  server.on("exit", (code) => fail(new Error(`server exited (${code})`)));
});

let ipSeq = 0;
const freshIp = () => `10.9.${Math.floor(++ipSeq / 250)}.${ipSeq % 250 + 1}`;
const seen: string[] = []; // every MCP response body, for the leak check
async function post(body: unknown, { ip = freshIp(), headers = {} as Record<string, string>, raw = false } = {}) {
  const r = await fetch(`${BASE}/mcp`, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-real-ip": ip, ...headers },
    body: raw ? (body as string) : JSON.stringify(body),
  });
  const text = await r.text();
  seen.push(text);
  return { status: r.status, headers: r.headers, text, body: text && r.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null as any };
}
let rid = 0;
/** Legacy request (initialize-era: no _meta; header optional). */
const legacy = (method: string, params?: unknown, version = "2025-06-18") =>
  post({ jsonrpc: "2.0", id: ++rid, method, ...(params === undefined ? {} : { params }) }, { headers: version ? { "mcp-protocol-version": version } : {} });
/** Modern request (2026-07-28): _meta in the body, mirrored headers. */
const modern = (method: string, params: Record<string, any> = {}, opts: { headers?: Record<string, string>; meta?: Record<string, any> } = {}) => post({
  jsonrpc: "2.0", id: ++rid, method,
  params: { ...params, _meta: opts.meta ?? { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" } } },
}, { headers: { "mcp-protocol-version": MODERN, "mcp-method": method, ...(method === "tools/call" ? { "mcp-name": params.name } : {}), ...opts.headers } });
const call = (name: string, args?: Record<string, unknown>) => modern("tools/call", { name, ...(args ? { arguments: args } : {}) });
const data = (r: any) => r.body.result.structuredContent;
const text = (r: any) => r.body.result.content[0].text as string;

const cliEnv = (name: string) => ({ ...env, AGENTTOWN_CONFIG: join(dir, name, "config.json"), AGENTTOWN_SERVER: BASE });
const cli = (cfg: string, ...args: string[]) =>
  execFileSync(process.execPath, ["public/cli/agenttown.mjs", ...args], { env: cliEnv(cfg), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const admin = (kind: string, id: string) => fetch(`${BASE}/v1/admin/hide`, {
  method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json", "x-real-ip": "10.99.0.1" }, body: JSON.stringify({ kind, id }),
}).then((r) => r.status);

async function tableCounts() {
  const c = await mysql.createConnection({ uri: MYSQL_URL });
  try {
    const [rows] = await c.query("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()");
    const out: Record<string, number> = {};
    for (const { t } of rows as { t: string }[]) { const [[n]] = await c.query(`SELECT COUNT(*) AS n FROM \`${t}\``) as any; out[t] = n.n; }
    return out;
  } finally { await c.end(); }
}

try {
  // ---- residents: A is busy on a secret task and talks; B gets hidden by moderation ----
  const SECRET = `secret-title-${randomBytes(6).toString("hex")}`;
  const HIDDEN_NAME = `Rude Name ${randomBytes(3).toString("hex")}`;
  assert.match(cli("a", "register", "--home", "Lantern House"), /Registered home/);
  assert.match(cli("b", "register", "--home", HIDDEN_NAME), /Registered home/);
  const cfgA = JSON.parse(readFileSync(join(dir, "a", "config.json"), "utf8"));
  const cfgB = JSON.parse(readFileSync(join(dir, "b", "config.json"), "utf8"));
  const homeA = cfgA.home_id as string, homeB = cfgB.home_id as string;
  cli("a", "persona", "--name", "Moth", "--kind", "codex", "--appearance", "a paper moth with ink wings");
  cli("a", "report", "--persona", "Moth", "--kind", "codex", "--session", "s-1", "--status", "thinking", "--task", SECRET);
  cli("a", "report", "--persona", "Moth", "--kind", "codex", "--session", "s-1", "--status", "tool", "--tool", "Bash");
  cli("a", "say", "--persona", "Moth", "hello from the lantern house");
  cli("b", "persona", "--name", "Grump", "--kind", "cursor", "--appearance", "a grumpy cloud");
  cli("b", "say", "--persona", "Grump", "a say that moderation will hide");
  const taskEnc = (await (await fetch(`${BASE}/v1/homes/${homeA}`, { headers: { "x-real-ip": freshIp() } })).json() as any).sessions[0].task_enc as string;
  assert.ok(taskEnc && taskEnc.startsWith("v1."), "the session has an encrypted title");
  assert.equal(await admin("home", homeB), 200);
  const before = await tableCounts();

  // ---- legacy handshake ----
  const init = await legacy("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "legacy", version: "1" } }, "");
  assert.equal(init.status, 200);
  assert.equal(init.headers.get("content-type")?.split(";")[0], "application/json");
  assert.equal(init.headers.get("mcp-session-id"), null, "no session id is minted");
  assert.equal(init.body.result.protocolVersion, "2025-06-18", "a supported legacy version is echoed");
  assert.deepEqual(init.body.result.capabilities, { tools: { listChanged: false } });
  assert.equal(init.body.result.serverInfo.name, "agenttown");
  assert.match(init.body.result.instructions, /read-only/);
  assert.equal((await legacy("initialize", { protocolVersion: "2099-01-01", capabilities: {} }, "")).body.result.protocolVersion, "2025-11-25",
    "an unknown version negotiates to the latest legacy one");
  assert.equal((await legacy("initialize", { protocolVersion: "2025-03-26", capabilities: {} }, "")).body.result.protocolVersion, "2025-03-26");
  const notif = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, { headers: { "mcp-protocol-version": "2025-06-18" } });
  assert.equal(notif.status, 202);
  assert.equal(notif.text, "", "202 has no body");
  assert.equal((await post({ jsonrpc: "2.0", id: "x", result: {} })).status, 202, "a stray client response is accepted and ignored");
  const ping = await legacy("ping");
  assert.deepEqual(ping.body, { jsonrpc: "2.0", id: rid, result: {} });
  assert.equal((await legacy("ping", undefined, "")).status, 200, "no header = 2025-03-26");
  const ltools = await legacy("tools/list", {}, "2025-11-25");
  const names = ltools.body.result.tools.map((t: any) => t.name);
  assert.deepEqual(names, ["town_status", "list_homes", "get_home", "recent_talk", "how_to_join"]);
  assert.equal(ltools.body.result.resultType, undefined, "legacy results have no resultType");
  for (const t of ltools.body.result.tools) {
    assert.ok(t.title && t.description && t.inputSchema?.type === "object", `${t.name}: title, description, inputSchema`);
    assert.equal(t.annotations.readOnlyHint, true, `${t.name} is read-only`);
    assert.equal(t.annotations.destructiveHint, false);
  }
  const lcall = await legacy("tools/call", { name: "town_status", arguments: {} });
  assert.equal(lcall.body.result.isError, false);
  assert.equal(lcall.body.result.resultType, undefined);
  const lnf = await legacy("resources/list");
  assert.equal(lnf.status, 200, "legacy: JSON-RPC errors come with 200");
  assert.equal(lnf.body.error.code, -32601);

  // ---- modern (2026-07-28) ----
  const disc = await modern("server/discover");
  assert.equal(disc.status, 200);
  const dr = disc.body.result;
  assert.equal(dr.resultType, "complete");
  assert.deepEqual(dr.supportedVersions, [MODERN, "2025-11-25", "2025-06-18", "2025-03-26"]);
  assert.deepEqual(dr.capabilities, { tools: { listChanged: false } });
  assert.equal(dr._meta["io.modelcontextprotocol/serverInfo"].name, "agenttown");
  assert.ok(dr.instructions && dr.ttlMs > 0 && dr.cacheScope === "public");
  const mtools = await modern("tools/list");
  assert.equal(mtools.body.result.resultType, "complete");
  assert.equal(mtools.body.result.cacheScope, "public");
  assert.ok(mtools.body.result.ttlMs > 0);
  assert.deepEqual(mtools.body.result.tools, ltools.body.result.tools, "same tools in both eras");

  // town_status
  const st = await call("town_status");
  assert.equal(st.body.result.resultType, "complete");
  assert.equal(st.body.result.isError, false);
  assert.deepEqual({ homes: data(st).homes, online: data(st).agents_online, busy: data(st).busy }, { homes: 2, online: 1, busy: 1 });
  assert.ok(data(st).newest_homes.some((h: any) => h.name === "Lantern House" && h.url === `${BASE}/h/${homeA}`));
  assert.ok(!data(st).newest_homes.some((h: any) => h.url.endsWith(homeB)), "hidden homes are not among the newest");
  assert.match(text(st), /2 homes, 1 agents online, 1 busy/);
  assert.deepEqual(JSON.parse(st.body.result.content[1].text), data(st), "structured content is mirrored as JSON text");

  // list_homes
  const lh = await call("list_homes", { limit: 1 });
  assert.equal(data(lh).total, 2);
  assert.equal(data(lh).homes.length, 1);
  assert.equal(data(lh).next_offset, 1);
  const a = data(lh).homes[0];
  assert.equal(a.id, homeA);
  assert.equal(a.name, "Lantern House");
  assert.equal(a.url, `${BASE}/h/${homeA}`);
  assert.equal(a.status, "busy");
  assert.deepEqual(a.residents, [{ name: "Moth", kind: "codex" }]);
  const lh2 = await call("list_homes", { limit: 1, offset: 1 });
  const b = data(lh2).homes[0];
  assert.equal(data(lh2).next_offset, null);
  assert.equal(b.id, homeB);
  assert.equal(b.name, "(hidden)", "hidden homes are redacted exactly like /v1/world");
  assert.equal(b.hidden, true);
  assert.deepEqual(b.residents, []);
  const world = (await (await fetch(`${BASE}/v1/world`, { headers: { "x-real-ip": freshIp() } })).json() as any).homes;
  assert.equal(world.find((h: any) => h.id === homeB).name, b.name, "same redaction as /v1/world");
  const bad = await call("list_homes", { limit: 1000 });
  assert.equal(bad.status, 200);
  assert.equal(bad.body.result.isError, true, "bad arguments are tool errors the model can fix");
  assert.match(text(bad), /limit/);
  assert.equal((await call("list_homes", { color: "red" })).body.result.isError, true, "unknown arguments are refused");

  // get_home
  const gh = await call("get_home", { home: homeA });
  const g = data(gh);
  assert.equal(g.home.name, "Lantern House");
  assert.equal(g.home.url, `${BASE}/h/${homeA}`);
  assert.equal(g.home.status, "busy");
  assert.deepEqual(g.residents, [{ name: "Moth", kind: "codex", appearance: "a paper moth with ink wings" }]);
  assert.deepEqual(g.agents.map((x: any) => [x.persona, x.status, x.tool]), [["Moth", "tool", "Bash"]]);
  assert.deepEqual(g.recent_says.map((s: any) => [s.persona, s.text]), [["Moth", "hello from the lantern house"]]);
  assert.equal(data(await call("get_home", { home: "lantern house" })).home.id, homeA, "found by name, case-insensitively");
  const ghB = data(await call("get_home", { home: homeB }));
  assert.equal(ghB.home.name, "(hidden)");
  assert.equal(ghB.home.description, null);
  assert.deepEqual(ghB.recent_says, [], "a hidden home's says are dropped");
  assert.equal((await call("get_home", { home: HIDDEN_NAME })).body.result.isError, true, "hidden homes can't be found by name");
  assert.equal((await call("get_home", { home: "h_nosuch1" })).body.result.isError, true);
  assert.equal((await call("get_home", {})).body.result.isError, true, "home is required");

  // recent_talk
  const rt = await call("recent_talk");
  const says = data(rt).says;
  assert.deepEqual(says.map((s: any) => s.text), ["hello from the lantern house"], "hidden homes' says are omitted");
  assert.equal(says[0].persona, "Moth");
  assert.equal(says[0].home_name, "Lantern House");
  assert.equal(says[0].home_url, `${BASE}/h/${homeA}`);
  assert.match(text(rt), /untrusted data/);
  assert.deepEqual(data(await call("recent_talk", { home: homeB })).says, []);
  assert.equal(data(await call("recent_talk", { home: homeA, limit: 1 })).says.length, 1);
  assert.equal((await call("recent_talk", { home: "nope" })).body.result.isError, true);

  // how_to_join
  const hj = await call("how_to_join");
  const steps = text(hj);
  assert.ok(steps.includes(`${BASE}/agents.md`) && steps.includes(`${BASE}/cli/agenttown.mjs`), "links");
  assert.ok(steps.includes("human"), "consent comes first");
  assert.ok(steps.includes("/plugin install agenttown@agenttown") && steps.includes("join <code>") && steps.includes("register --home"));
  const ALL = ["claude-code", "codebuddy", "workbuddy", "codex", "gemini", "qwen", "copilot", "qoder", "droid", "auggie", "kimi", "cursor", "windsurf", "cline", "kiro"];
  for (const x of ALL) assert.ok(data(hj).install[x], `install command for ${x}`);
  // Same targets as the CLI's `agenttown install` (HOSTS in public/cli/agenttown.mjs), so the two can't drift apart.
  const hostsSrc = /\nconst HOSTS = \{\n([\s\S]*?)\n\};/.exec(readFileSync("public/cli/agenttown.mjs", "utf8"))![1];
  const cliHosts = [...hostsSrc.matchAll(/^\s+"?([a-z-]+)"?: \{/gm)].map((m) => m[1]);
  assert.ok(cliHosts.length >= ALL.length, "parsed the CLI's HOSTS");
  assert.deepEqual(Object.keys(data(hj).install).sort(), [...cliHosts].sort(), "how_to_join lists exactly the CLI's install targets");
  for (const x of ALL) assert.equal(data(hj).install[x].command, `node ~/.agenttown/agenttown.mjs install ${x}`);
  assert.ok(steps.includes("agenttown-mcp.mjs") && steps.includes("agenttown report"), "MCP and manual fallbacks");
  const hjc = await call("how_to_join", { agent: "codex" });
  assert.match(text(hjc), /install codex/);
  assert.match(text(hjc), /\/hooks/);
  assert.match(text(hjc), /--kind codex/);
  assert.deepEqual(Object.keys(data(hjc).install), ["codex"]);
  assert.equal((await call("how_to_join", { agent: "skynet" })).body.result.isError, true);

  // ---- modern: protocol errors ----
  const errOf = (r: any, status: number, code: number) => {
    assert.equal(r.status, status, r.text);
    assert.equal(r.body.jsonrpc, "2.0");
    assert.equal(r.body.error.code, code, r.text);
    return r.body.error;
  };
  const uv = errOf(await modern("tools/list", {}, { meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01", "io.modelcontextprotocol/clientCapabilities": {} },
    headers: { "mcp-protocol-version": "1900-01-01" } }), 400, -32022);
  assert.deepEqual(uv.data, { supported: [MODERN, "2025-11-25", "2025-06-18", "2025-03-26"], requested: "1900-01-01" });
  errOf(await legacy("tools/list", {}, "1999-09-09"), 400, -32022); // legacy client, unknown header version
  errOf(await modern("tools/list", {}, { headers: { "mcp-protocol-version": "2025-11-25" } }), 400, -32020); // header ≠ body
  errOf(await modern("tools/list", {}, { headers: { "mcp-method": "tools/call" } }), 400, -32020);
  errOf(await post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientCapabilities": {} } } },
    { headers: { "mcp-protocol-version": MODERN } }), 400, -32020); // Mcp-Method missing
  errOf(await modern("tools/call", { name: "town_status" }, { headers: { "mcp-name": "get_home" } }), 400, -32020);
  const b64 = await modern("tools/call", { name: "town_status" }, { headers: { "mcp-name": `=?base64?${Buffer.from("town_status").toString("base64")}?=` } });
  assert.equal(b64.status, 200, "Mcp-Name in the base64 sentinel form is decoded");
  errOf(await modern("tools/list", {}, { meta: { "io.modelcontextprotocol/protocolVersion": MODERN } }), 400, -32602); // no clientCapabilities
  errOf(await legacy("tools/list", {}, MODERN), 400, -32602); // modern header but no _meta
  const nf = errOf(await modern("resources/list"), 404, -32601);
  assert.match(nf.message, /Method not found/);
  errOf(await modern("tools/call", { name: "launch_rockets" }), 200, -32602); // unknown tool: protocol error
  errOf(await modern("tools/call", { name: "town_status", arguments: [1] }), 200, -32602);

  // ---- bad JSON-RPC ----
  errOf(await post("{not json", { raw: true }), 400, -32700);
  errOf(await post([{ jsonrpc: "2.0", id: 1, method: "ping" }]), 400, -32600); // batches
  errOf(await post({ id: 1, method: "ping" }), 400, -32600); // no jsonrpc
  errOf(await post({ jsonrpc: "2.0", id: 1, method: 7 }), 400, -32600);
  errOf(await post({ jsonrpc: "2.0", id: null, method: "ping" }), 400, -32600);
  errOf(await post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: [1] }), 400, -32602);
  errOf(await post("x".repeat(70_000), { raw: true }), 413, -32600);

  // ---- HTTP details ----
  const get = await fetch(`${BASE}/mcp`);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST, OPTIONS");
  assert.equal((await fetch(`${BASE}/mcp`, { method: "DELETE" })).status, 405);
  const opt = await fetch(`${BASE}/mcp`, { method: "OPTIONS" });
  assert.equal(opt.status, 204);
  assert.equal(opt.headers.get("access-control-allow-origin"), "*");
  assert.match(opt.headers.get("access-control-allow-headers")!, /mcp-protocol-version/);
  assert.equal(st.headers.get("access-control-allow-origin"), "*");
  assert.equal(st.headers.get("cache-control"), "no-store");
  errOf(await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { headers: { origin: "null" } }), 403, -32600);
  assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { headers: { origin: "https://inspector.example" } })).status, 200);
  const sse = await post({ jsonrpc: "2.0", id: 5, method: "ping" }, { headers: { accept: "text/event-stream" } });
  assert.equal(sse.headers.get("content-type"), "text/event-stream");
  assert.deepEqual(JSON.parse(/^event: message\ndata: (.*)\n\n$/.exec(sse.text)![1]), { jsonrpc: "2.0", id: 5, result: {} });
  const ip = freshIp();
  const burst = await Promise.all(Array.from({ length: 50 }, () => post({ jsonrpc: "2.0", id: 1, method: "ping" }, { ip })));
  const limited = burst.find((r) => r.status === 429);
  assert.ok(limited, "rate limited");
  assert.equal(limited!.body.error.code, 429);

  // ---- nothing private leaks, nothing is stored ----
  const all = seen.join("\n");
  for (const [what, v] of [
    ["task title", SECRET], ["encrypted title", taskEnc], ["owner key", cfgA.owner_key], ["owner key B", cfgB.owner_key],
    ["hidden home name", HIDDEN_NAME], ["hidden say", "moderation will hide"], ["hidden persona's home talk", "Grump"],
  ] as [string, string][]) {
    assert.ok(v && !all.includes(v), `${what} never appears in MCP output`);
  }
  for (const k of ["task_enc", "box_pub", "auth_hash", "owner_key", "enc_key", "device_token", "\"art\""]) assert.ok(!all.includes(k), `no ${k} field`);
  assert.deepEqual(await tableCounts(), before, "the MCP endpoint stores nothing");

  // ---- discovery ----
  const card = await fetch(`${BASE}/mcp/server-card`);
  assert.equal(card.status, 200);
  assert.equal(card.headers.get("content-type"), "application/mcp-server-card+json");
  assert.equal(card.headers.get("access-control-allow-origin"), "*");
  const cj = await card.json() as any;
  assert.equal(cj.$schema, "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json");
  assert.equal(cj.name, "io.github.vacuityv/agenttown");
  assert.ok(cj.description.length <= 100);
  assert.deepEqual(cj.remotes, [{ type: "streamable-http", url: `${BASE}/mcp`, supportedProtocolVersions: dr.supportedVersions }]);
  const man = await (await fetch(`${BASE}/.well-known/agent-town.json`, { headers: { "x-real-ip": freshIp() } })).json() as any;
  assert.equal(man.standards.mcp_endpoint, `${BASE}/mcp`);
  assert.equal(man.standards.mcp_transport, "streamable-http");
  assert.deepEqual(man.standards.mcp_versions, dr.supportedVersions);
  const agentCard = await (await fetch(`${BASE}/.well-known/agent-card.json`)).json() as any;
  assert.ok(agentCard.description.includes(`${BASE}/mcp`));
  assert.ok((await (await fetch(`${BASE}/llms.txt`)).text()).includes("(/mcp)"));
  assert.ok((await (await fetch(`${BASE}/robots.txt`)).text()).includes("Allow: /mcp"));
  const agentsMd = await (await fetch(`${BASE}/agents.md`)).text();
  assert.ok(agentsMd.includes("## Remote MCP") && agentsMd.includes(`${BASE}/mcp`));
  const sj = JSON.parse(readFileSync("server.json", "utf8"));
  assert.equal(sj.$schema, "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json");
  assert.equal(sj.name, "io.github.vacuityv/agenttown");
  assert.ok(sj.description.length >= 1 && sj.description.length <= 100, "registry: description ≤ 100 chars");
  assert.ok(sj.version && sj.version !== "latest");
  assert.deepEqual(sj.remotes, [{ type: "streamable-http", url: "https://agenttown.xyz/mcp" }]);
  assert.deepEqual(sj.repository, { url: "https://github.com/vacuityv/agenttown", source: "github" });
  assert.equal(JSON.parse(readFileSync("glama.json", "utf8")).maintainers[0], "vacuityv");

  console.log("mcp: all checks passed");
} finally {
  server.kill();
}
process.exit(0);
