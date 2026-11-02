// Client libraries for SDK / server / CI agents (public/sdk/agenttown.mjs, public/sdk/agenttown.py) and the GitHub
// Action (action.yml) on a freshly emptied test DB (TEST_MYSQL_URL): served files, credentials, E2E titles (never
// plaintext), coalescing, heartbeats, timeouts, the framework adapters with fake payloads, the action's main/post steps,
// and test/sdk.py (skipped if python3 is missing).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { resetTestDb } from "./test-db.ts";
import { TASK_ENC_RE } from "../server/util.ts";

const PORT = 8801;
const BASE = `http://localhost:${PORT}`;
const MYSQL_URL = await resetTestDb();
// Never let a developer's own ~/.agenttown/config.json (a real home) leak into the test.
const NOCFG = { AGENTTOWN_CONFIG: "/nonexistent/agenttown.json" };
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("AGENTTOWN_") && !k.startsWith("INPUT_") && !k.startsWith("STATE_") && !k.startsWith("GITHUB_")));
const env = { ...cleanEnv, MYSQL_URL, POW_DIFFICULTY: "8", ANTHROPIC_API_KEY: "", PORT: String(PORT), PUBLIC_URL: BASE, NEIGHBOR_CHECK: "0" };
const server: ChildProcess = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server/index.ts"], { env, stdio: ["ignore", "pipe", "inherit"] });
await new Promise<void>((ok, fail) => {
  server.stdout!.on("data", (d) => String(d).includes("listening") && ok());
  server.on("exit", (code) => fail(new Error(`server exited (${code})`)));
});

const tmp = mkdtempSync(join(tmpdir(), "agenttown-sdk-"));
const hmac = (k: string, m: string) => createHmac("sha256", Buffer.from(k, "utf8")).update(m).digest();
const ownerKey = "atk_" + randomBytes(32).toString("base64url");
const token = hmac(ownerKey, "agenttown/auth/v1").toString("hex");
const key = hmac(ownerKey, "agenttown/enc/v1");
function open(enc: string) {
  const [, iv, ct] = enc.split(".");
  const buf = Buffer.from(ct, "base64url");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  d.setAuthTag(buf.subarray(-16));
  return Buffer.concat([d.update(buf.subarray(0, -16)), d.final()]);
}
const title = (enc: string) => open(enc).toString("utf8").replace(/\0+$/, "");
const get = async (p: string) => (await fetch(BASE + p)).json() as Promise<any>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function register(name: string) {
  const { challenge, difficulty } = await get("/v1/register/challenge");
  let nonce = 0;
  for (;; nonce++) {
    const h = createHash("sha256").update(`${challenge}:${nonce}`).digest();
    let bits = 0;
    for (const b of h) { if (b === 0) { bits += 8; continue; } bits += Math.clz32(b) - 24; break; }
    if (bits >= difficulty) break;
  }
  const r = await fetch(BASE + "/v1/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ challenge, nonce: String(nonce), auth_token: token, home_name: name }),
  });
  assert.equal(r.status, 201);
  return (await r.json() as any).home.id as string;
}
const sessionOf = async (homeId: string, persona: string) => {
  const h = await get(`/v1/homes/${homeId}`);
  const p = h.personas.find((x: any) => x.name === persona);
  return { persona: p, session: p && h.sessions.find((s: any) => s.persona_id === p.id) };
};

// A fake Agent Town that records what it gets.
const captured: { path: string; raw: string; body: any; headers: IncomingMessage["headers"] }[] = [];
let capStatus = 200;
const cap = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    captured.push({ path: req.url ?? "", raw, body: JSON.parse(raw || "{}"), headers: req.headers });
    res.writeHead(capStatus, { "content-type": "application/json" });
    res.end(JSON.stringify(capStatus === 200 ? { session_id: "s_x", task_no: captured.length } : { error: "unauthorized" }));
  });
});
await new Promise<void>((r) => cap.listen(0, "127.0.0.1", r));
const CAP = `http://127.0.0.1:${(cap.address() as any).port}`;
const last = () => captured.at(-1)!.body;

let action: ChildProcess | null = null;
let heartbeatPid = 0;
try {
  const homeId = await register("SDK Street");

  // ---- served files ----
  const js = await fetch(BASE + "/sdk/agenttown.mjs");
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type")!, /^text\/javascript/);
  assert.ok(js.headers.get("content-security-policy")?.includes("script-src 'self'"), "CSP on every response");
  const jsText = await js.text();
  assert.ok(jsText.includes(`const BASE_URL = "${BASE}"`) && !jsText.includes("{{BASE_URL}}"), "BASE_URL filled in");
  const py = await fetch(BASE + "/sdk/agenttown.py");
  assert.equal(py.status, 200);
  assert.match(py.headers.get("content-type")!, /^text\/plain/);
  const pyText = await py.text();
  assert.ok(pyText.includes(`_BASE_URL = "${BASE}"`) && !pyText.includes("{{BASE_URL}}"));
  writeFileSync(join(tmp, "agenttown.mjs"), jsText);
  writeFileSync(join(tmp, "agenttown.py"), pyText);
  const sdk = await import(pathToFileURL(join(tmp, "agenttown.mjs")).href);
  const town = (o: Record<string, unknown> = {}) => sdk.connect({ ownerKey, server: CAP, autoEnd: false, env: NOCFG, ...o });
  const flushAll = async (...ts: any[]) => { for (const t of ts) await t.flush(); };

  // ---- crypto & credentials ----
  assert.equal(sdk.taskTitle("\n  Fix   the login\tpage \nmore"), "Fix the login page");
  assert.equal(sdk.taskTitle("y".repeat(90)), "y".repeat(79) + "…");
  for (const t of ["hi", "猫".repeat(200), "x".repeat(31), "x".repeat(32)]) {
    const enc = sdk.encryptTitle(key, t);
    assert.match(enc, TASK_ENC_RE);
    const pt = open(enc);
    assert.ok(pt.length % 32 === 0 && pt.at(-1) === 0 && Buffer.byteLength(title(enc)) <= 480 && t.startsWith(title(enc)));
  }
  assert.equal(sdk.loadCredentials({ env: NOCFG }), null);
  let c = sdk.loadCredentials({ env: { AGENTTOWN_OWNER_KEY: ownerKey, AGENTTOWN_SERVER: "http://x/" } });
  assert.ok(c.token === token && c.encKey.equals(key) && c.server === "http://x");
  const dev = { device_token: "ab".repeat(32), enc_key: key.toString("base64url"), server: "http://dev", personas: { "ai-sdk": "Vee" } };
  c = sdk.loadCredentials({ env: { AGENTTOWN_CREDENTIALS: JSON.stringify(dev), AGENTTOWN_OWNER_KEY: ownerKey } });
  assert.ok(c.token === "ab".repeat(32) && c.encKey.equals(key) && c.server === "http://dev", "AGENTTOWN_CREDENTIALS wins");
  c = sdk.loadCredentials({ env: { AGENTTOWN_TOKEN: "CD".repeat(32) } });
  assert.ok(c.token === "cd".repeat(32) && c.encKey === null, "bare token: no titles");
  assert.equal(sdk.loadCredentials({ env: { AGENTTOWN_TOKEN: "nope" } }), null);
  assert.equal(sdk.loadCredentials({ env: { AGENTTOWN_CREDENTIALS: "{not json" } }), null);
  writeFileSync(join(tmp, "config.json"), JSON.stringify({ ...dev, titles: false }));
  c = sdk.loadCredentials({ env: { AGENTTOWN_CONFIG: join(tmp, "config.json") } });
  assert.ok(c.token === "ab".repeat(32) && c.titles === false);
  let t0 = sdk.connect({ kind: "ai-sdk", env: { AGENTTOWN_CONFIG: join(tmp, "config.json") }, autoEnd: false });
  assert.ok(t0.persona === "Vee" && !t0.titles, "persona from config.personas[kind]; titles off by config");
  assert.ok(!sdk.connect({ env: { AGENTTOWN_CREDENTIALS: JSON.stringify(dev), AGENTTOWN_DISABLED: "1" } }).enabled);
  assert.equal(sdk.connect({ env: NOCFG }).persona, "Agent");
  assert.equal(sdk.connect({ kind: "openai-agents", env: NOCFG }).persona, "Agents");
  const none = sdk.connect({ env: NOCFG });
  assert.equal(await none.session().thinking("x"), null, "no credentials: a silent no-op");

  // ---- reports, against the capture server ----
  const T = town({ persona: "Pip", kind: "my-bot" });
  const s = T.session();
  assert.ok(s === T.session() && s.id.startsWith("sdk-"));
  s.thinking("Secret title\nnot this line"); await T.flush();
  assert.deepEqual(last().persona, { name: "Pip", kind: "my-bot" });
  assert.ok(last().status === "thinking" && last().session === s.id && title(last().task.title_enc) === "Secret title");
  assert.equal(captured.at(-1)!.headers.authorization, `Bearer ${token}`);
  assert.match(captured.at(-1)!.headers["user-agent"]!, /^agenttown-sdk\/\d+\.\d+\.\d+ \(js\)$/);
  s.tool("web_search"); await T.flush();
  assert.ok(last().tool === "web_search" && !("task" in last()));
  s.thinking(true); await T.flush(); assert.deepEqual(last().task, {});
  s.waiting(); await T.flush(); assert.ok(last().status === "waiting" && !("tool" in last()));
  const kid = s.child("helper-1");
  kid.thinking("sub"); await T.flush();
  assert.ok(last().parent === s.id && last().session === `${s.id}:helper-1`);
  s.end(); await T.flush();
  assert.ok(last().status === "ended" && !T.sessions.has(s.id) && T.session() !== s);
  assert.equal(await s.report("bogus"), null);
  assert.ok(captured.every((x) => !x.raw.includes("Secret title") && !x.raw.includes("not this line")), "never a plaintext title");

  // Coalescing: the latest status wins, every task start goes out, in order.
  let n0 = captured.length;
  const burst = T.session({ id: "burst" });
  for (let i = 0; i < 30; i++) burst.tool(`t${i}`);
  burst.thinking("A"); burst.tool("x"); burst.thinking("B"); burst.idle();
  await T.flush();
  const sent = captured.slice(n0).map((x) => x.body);
  assert.ok(sent.at(-1).status === "idle" && sent.filter((b) => b.task).length === 2 && sent.length <= 6, JSON.stringify(sent));
  assert.deepEqual(sent.filter((b) => b.task).map((b) => title(b.task.title_enc)), ["A", "B"]);

  const T2 = town({ titles: false, toolNames: false });
  T2.session().thinking("hidden"); T2.session().tool("secret_tool"); await T2.flush();
  assert.ok(captured.at(-2)!.body.task && !captured.at(-2)!.body.task.title_enc && last().tool === "Tool");
  assert.ok(!captured.at(-2)!.raw.includes("hidden"));
  const T3 = sdk.connect({ token, server: CAP, autoEnd: false, env: NOCFG }); // token only: numbers, no titles
  assert.ok(!T3.titles);
  T3.session().thinking("tok"); await T3.flush(); assert.deepEqual(last().task, {});

  // Heartbeats: busy desks and keepAlive idle desks are repeated, plain idle ones are not.
  const T4 = town({ heartbeatMs: 150 });
  T4.session({ id: "hb-idle" }).idle();
  T4.session({ id: "hb-keep", keepAlive: true }).idle();
  T4.session({ id: "hb-busy" }).tool("build");
  await sleep(700); await T4.flush();
  const count = (id: string) => captured.filter((x) => x.body.session === id).length;
  assert.ok(count("hb-idle") === 1 && count("hb-keep") >= 2 && count("hb-busy") >= 2, `${count("hb-idle")} ${count("hb-keep")} ${count("hb-busy")}`);
  assert.equal(captured.filter((x) => x.body.session === "hb-busy").at(-1)!.body.tool, "build");
  const T4b = town({ heartbeatMs: 150, busyMaxMs: 100 });
  T4b.session({ id: "hb-stuck" }).thinking();
  await sleep(700); await T4b.flush();
  assert.equal(count("hb-stuck"), 1, "a stuck busy status is not kept alive past busyMaxMs");
  await T4.close();
  assert.equal(last().status, "ended");
  await T4b.close();

  // 401: stop trying. onError sees failures.
  capStatus = 401;
  const errs: any[] = [];
  const T5 = town({ onError: (e: any) => errs.push(e) });
  T5.session().thinking(); await T5.flush();
  assert.ok(!T5.enabled && errs[0]?.status === 401);
  n0 = captured.length; T5.session().idle(); await T5.flush(); assert.equal(captured.length, n0);
  capStatus = 200;

  // Never blocks: a server that never answers, and one that isn't there.
  const hang = createNetServer(() => {});
  await new Promise<void>((r) => hang.listen(0, "127.0.0.1", r));
  const Th = sdk.connect({ ownerKey, server: `http://127.0.0.1:${(hang.address() as any).port}`, timeoutMs: 300, autoEnd: false, env: NOCFG });
  let start = Date.now();
  for (let i = 0; i < 5; i++) Th.session().thinking("x");
  assert.ok(Date.now() - start < 100, "reports only queue");
  await Th.flush();
  assert.ok(Date.now() - start < 2000);
  hang.close();
  const free = createNetServer();
  await new Promise<void>((r) => free.listen(0, "127.0.0.1", r));
  const freePort = (free.address() as any).port;
  free.close();
  const Tu = sdk.connect({ ownerKey, server: `http://127.0.0.1:${freePort}`, timeoutMs: 300, autoEnd: false, env: NOCFG });
  assert.equal(await Tu.session().thinking("x"), undefined);
  await Tu.flush();

  // ---- adapters with fake framework payloads ----
  // Claude Agent SDK hooks
  const A = town({ kind: "claude-agent-sdk" });
  const mine = { PreToolUse: [{ matcher: "Bash", hooks: [async () => ({})] }] };
  const hooks = sdk.claudeAgentSdkHooks(A, mine);
  assert.ok(hooks.PreToolUse.length === 2 && hooks.PreToolUse[0] === mine.PreToolUse[0] && mine.PreToolUse.length === 1);
  assert.deepEqual(Object.keys(hooks).sort(), [...sdk.CLAUDE_AGENT_SDK_EVENTS].sort());
  const fire = async (ev: string, d: Record<string, unknown> = {}) => {
    const out = await hooks[ev].at(-1).hooks[0]({ hook_event_name: ev, session_id: "cas-1", cwd: "/tmp", ...d }, undefined, { signal: AbortSignal.timeout(1000) });
    assert.deepEqual(out, {});
    await A.flush();
    return last();
  };
  assert.equal((await fire("SessionStart", { source: "startup" })).status, "idle");
  let b = await fire("UserPromptSubmit", { prompt: "Refactor auth\nwith details" });
  assert.ok(b.status === "thinking" && b.session === "cas-1" && b.persona.kind === "claude-agent-sdk" && title(b.task.title_enc) === "Refactor auth");
  b = await fire("PreToolUse", { tool_name: "Bash", tool_input: { command: "rm -rf secret" } });
  assert.ok(b.tool === "Bash" && !captured.at(-1)!.raw.includes("rm -rf"));
  assert.equal((await fire("PostToolUse", { tool_name: "Bash" })).status, "thinking");
  b = await fire("SubagentStart", { agent_id: "ag1", agent_type: "Explore" });
  assert.ok(b.session === "cas-1:ag1" && b.parent === "cas-1" && title(b.task.title_enc) === "Explore");
  assert.equal((await fire("PreToolUse", { tool_name: "Grep", agent_id: "ag1", agent_type: "Explore" })).session, "cas-1:ag1");
  assert.equal((await fire("SubagentStop", { agent_id: "ag1", agent_type: "Explore" })).status, "ended");
  assert.equal((await fire("Notification", { notification_type: "permission_prompt", message: "?" })).status, "waiting");
  assert.equal((await fire("PermissionRequest", { tool_name: "Bash" })).status, "waiting");
  assert.equal((await fire("Stop")).status, "idle");
  assert.equal((await fire("SessionEnd", { reason: "exit" })).status, "ended");
  assert.deepEqual(await hooks.Stop.at(-1).hooks[0](null), {}, "junk payloads never throw");
  assert.ok(captured.every((x) => !x.raw.includes("Refactor auth")));

  // OpenAI Agents SDK (a Runner is an event emitter)
  const O = town({ kind: "openai-agents" });
  const runner = new EventEmitter();
  const detach = sdk.openaiAgents(runner, O, { title: (agent: any) => `Run of ${agent.name}` });
  const ctx = {}, planner = { name: "Planner" };
  runner.emit("agent_start", ctx, planner); await O.flush();
  assert.ok(last().status === "thinking" && title(last().task.title_enc) === "Run of Planner");
  runner.emit("agent_tool_start", ctx, planner, { name: "get_weather" }, { toolCall: {} }); await O.flush();
  assert.equal(last().tool, "get_weather");
  runner.emit("agent_tool_end", ctx, planner, { name: "get_weather" }, "sunny", { toolCall: {} });
  runner.emit("agent_handoff", ctx, planner, { name: "Writer" });
  runner.emit("agent_start", ctx, { name: "Writer" }); await O.flush();
  assert.ok(last().status === "thinking" && !last().task, "a handoff is not a new task");
  runner.emit("agent_tool_start", ctx, planner, null); // odd payloads never throw
  runner.emit("agent_end", ctx, planner, "done"); await O.flush();
  assert.equal(last().status, "idle");
  detach();
  n0 = captured.length; runner.emit("agent_start", ctx, planner); await O.flush(); assert.equal(captured.length, n0, "detached");

  // LangChain.js / LangGraph.js
  const L = town({ kind: "langgraph" });
  const lh = sdk.langchainHandler(L, { title: "Plan the trip" });
  lh.handleChainStart({ id: ["langgraph"] }, { messages: [] }, "root", undefined, [], {}, "LangGraph"); await L.flush();
  assert.ok(last().status === "thinking" && title(last().task.title_enc) === "Plan the trip" && last().persona.kind === "langgraph");
  lh.handleChainStart({}, {}, "node", undefined, [], {}, "agent", "root");
  lh.handleChatModelStart({}, [[]], "llm", "node");
  lh.handleToolStart({ id: ["tools", "Calculator"] }, "2+2", "tool", "node", [], {}, "calculator"); await L.flush();
  assert.equal(last().tool, "calculator");
  lh.handleToolEnd("4", "tool", "node"); await L.flush(); assert.equal(last().status, "thinking");
  lh.handleChainEnd({}, "node", "root"); lh.handleChainEnd({}, "root"); await L.flush();
  assert.equal(last().status, "idle");
  lh.handleLLMStart({}, ["p"], "bare"); lh.handleLLMEnd({}, "bare"); await L.flush();
  assert.deepEqual(captured.slice(-2).map((x) => x.body.status), ["thinking", "idle"]);
  lh.handleToolStart({ id: ["x", "Search"] }, "q", "t2"); await L.flush();
  assert.ok(last().tool === "Search" && captured.at(-2)!.body.task, "a bare tool run is a task too, named from tool.id");
  lh.handleToolError(new Error("x"), "t2"); await L.flush(); assert.equal(last().status, "idle");
  assert.equal(lh.name, "agenttown");

  // Vercel AI SDK
  const V = town({ kind: "ai-sdk" });
  const cbs = sdk.aiSdk(V, { title: (e: any) => e.prompt });
  for (const k of ["onStart", "onStepStart", "onToolExecutionStart", "onToolExecutionEnd", "onStepEnd", "onEnd", "onStepFinish", "onFinish", "experimental_onToolCallStart"]) {
    assert.equal(typeof cbs[k], "function", k);
  }
  cbs.onStart({ prompt: "What's the weather in Paris?", messages: [] }); cbs.onStepStart({ stepNumber: 0 }); await V.flush();
  assert.ok(last().status === "thinking" && title(captured.at(-2)!.body.task.title_enc) === "What's the weather in Paris?");
  cbs.onToolExecutionStart({ callId: "c1", toolCall: { toolName: "weather", toolCallId: "t1", input: { city: "Paris" } } }); await V.flush();
  assert.ok(last().tool === "weather" && !captured.at(-1)!.raw.includes("Paris"));
  cbs.experimental_onToolCallStart({ toolCall: { toolName: "geo" } }); await V.flush(); assert.equal(last().tool, "geo");
  cbs.onToolExecutionEnd({}); cbs.onStepEnd({ finishReason: "tool-calls" }); cbs.onEnd({ finishReason: "stop" }); await V.flush();
  assert.equal(last().status, "idle");
  cbs.onStepFinish({}); cbs.onError({ error: new Error("x") }); await V.flush(); assert.equal(last().status, "idle");
  cbs.onToolExecutionStart(undefined); // never throws
  assert.ok(sdk.aiSdk({ server: CAP, ownerKey, env: NOCFG, autoEnd: false }) && sdk.aiSdk({ server: CAP, ownerKey, env: NOCFG, autoEnd: false }), "options instead of a Town");

  // ---- the real server ----
  const R = sdk.connect({ ownerKey, server: BASE, persona: "Jas", kind: "ai-sdk", autoEnd: false, env: NOCFG });
  const rs = R.session({ id: "js-real" });
  rs.thinking("Ship the release\nsecret details"); rs.tool("mcp__github__create_pr"); await R.flush();
  let got = await sessionOf(homeId, "Jas");
  assert.ok(got.persona.kind === "ai-sdk" && got.session.status === "tool" && got.session.tool === "MCP");
  assert.equal(title(got.session.task_enc), "Ship the release");
  const sub = rs.child("w1"); sub.thinking("helper"); await R.flush();
  const home = await get(`/v1/homes/${homeId}`);
  assert.equal(home.sessions.find((x: any) => x.parent_id === got.session.id)?.status, "thinking", "subagent desk");
  rs.end(); await R.flush();
  assert.equal((await sessionOf(homeId, "Jas")).session, undefined, "ended: left the desk (subagents too)");
  const events = (await get(`/v1/homes/${homeId}/events`)).events;
  assert.ok(events.length >= 3);
  assert.ok(!JSON.stringify(await get(`/v1/homes/${homeId}`)).includes("Ship the release"));

  // ---- GitHub Action: main + post ----
  const stateFile = join(tmp, "github_state");
  writeFileSync(stateFile, "");
  const gh = {
    ...cleanEnv, ...NOCFG, GITHUB_STATE: stateFile, GITHUB_RUN_ID: "4242", GITHUB_RUN_ATTEMPT: "2", GITHUB_JOB: "review",
    GITHUB_REPOSITORY: "acme/rocket", GITHUB_WORKFLOW: "Claude review",
    INPUT_CREDENTIALS: JSON.stringify({ owner_key: ownerKey, home_id: homeId }), INPUT_SERVER: BASE, INPUT_KIND: "github-actions",
    INPUT_TITLES: "true", "INPUT_END-STATUS": "idle",
  };
  const main = spawnSync(process.execPath, ["action/main.mjs"], { env: gh, encoding: "utf8", timeout: 15_000 });
  assert.equal(main.status, 0, main.stderr);
  assert.ok(!main.stdout.includes(ownerKey) && !main.stdout.includes(token) && !main.stdout.includes("Claude review"), "no secrets or titles in logs");
  const st = Object.fromEntries(readFileSync(stateFile, "utf8").trim().split("\n").map((l) => l.split("=")));
  assert.equal(st.session, "gha-4242-2-review");
  heartbeatPid = Number(st.heartbeat_pid);
  assert.ok(heartbeatPid > 0 && process.kill(heartbeatPid, 0), "heartbeat process running");
  got = await sessionOf(homeId, "CI");
  assert.ok(got.persona.kind === "github-actions" && got.session.status === "thinking");
  assert.equal(title(got.session.task_enc), "acme/rocket · Claude review");
  const post = spawnSync(process.execPath, ["action/post.mjs"], {
    env: { ...gh, STATE_session: st.session, STATE_heartbeat_pid: st.heartbeat_pid }, encoding: "utf8", timeout: 15_000,
  });
  assert.equal(post.status, 0, post.stderr);
  assert.equal((await sessionOf(homeId, "CI")).session.status, "idle");
  await sleep(200);
  assert.throws(() => process.kill(heartbeatPid, 0), "heartbeat stopped");
  heartbeatPid = 0;
  const post2 = spawnSync(process.execPath, ["action/post.mjs"], {
    env: { ...gh, STATE_session: st.session, "INPUT_END-STATUS": "ended" }, encoding: "utf8", timeout: 15_000,
  });
  assert.equal(post2.status, 0);
  assert.equal((await sessionOf(homeId, "CI")).session, undefined, "end-status: ended");
  writeFileSync(stateFile, "");
  const noCreds = spawnSync(process.execPath, ["action/main.mjs"], { env: { ...gh, INPUT_CREDENTIALS: "" }, encoding: "utf8", timeout: 15_000 });
  assert.ok(noCreds.status === 0 && noCreds.stdout.includes("no credentials") && readFileSync(stateFile, "utf8") === "");
  const noState = spawnSync(process.execPath, ["action/post.mjs"], { env: gh, encoding: "utf8", timeout: 15_000 });
  assert.equal(noState.status, 0, "post without state does nothing");
  const badCreds = spawnSync(process.execPath, ["action/main.mjs"], { env: { ...gh, INPUT_CREDENTIALS: "{oops" }, encoding: "utf8", timeout: 15_000 });
  assert.equal(badCreds.status, 0, "bad credentials never fail the job");

  // ---- Python ----
  const python = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (python.status !== 0) console.log("sdk: python3 not found, skipping test/sdk.py");
  else {
    const r = spawnSync("python3", ["test/sdk.py"], {
      env: { ...cleanEnv, AGENTTOWN_TEST_SDK: join(tmp, "agenttown.py"), AGENTTOWN_TEST_BASE: BASE, AGENTTOWN_TEST_OWNER_KEY: ownerKey, AGENTTOWN_TEST_HOME: homeId },
      encoding: "utf8", timeout: 120_000,
    });
    process.stdout.write(r.stdout);
    assert.equal(r.status, 0, `test/sdk.py failed:\n${r.stdout}\n${r.stderr}`);
    got = await sessionOf(homeId, "Pyra");
    if (r.stdout.includes("crypto=True")) assert.equal(title(got.session.task_enc), "Python title", "Python encrypts, Node decrypts");
    else assert.equal(got.session.task_enc, null);
  }

  console.log("sdk: all checks passed");
} finally {
  if (heartbeatPid) try { process.kill(heartbeatPid); } catch {}
  server.kill();
  cap.close();
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
