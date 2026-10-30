// Hook adapters end-to-end: boots the server on a freshly emptied test DB (TEST_MYSQL_URL), registers via the CLI, then pipes a realistic
// Claude Code session and Codex payloads through `agenttown hook <adapter>` (real detached-flush path) and the
// MCP server, asserting the public home state.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDecipheriv, createHmac } from "node:crypto";
import assert from "node:assert/strict";
import { resetTestDb } from "./test-db.ts";

const PORT = 8796;
const BASE = `http://localhost:${PORT}`;
const CLI = "public/cli/agenttown.mjs";
const dir = mkdtempSync(join(tmpdir(), "agenttown-hooks-"));
const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(PORT), MYSQL_URL: await resetTestDb(), POW_DIFFICULTY: "8", PUBLIC_URL: BASE, ANTHROPIC_API_KEY: "" };
delete env.AGENTTOWN_HOOK_SYNC;
delete env.AGENTTOWN_DISABLED;

const server = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server/index.ts"], { env, stdio: ["ignore", "pipe", "inherit"] });
await new Promise<void>((ok, fail) => {
  server.stdout!.on("data", (d) => String(d).includes("listening") && ok());
  server.on("exit", (code) => fail(new Error(`server exited (${code})`)));
});

const cfgDir = join(dir, "home");
const cfgPath = join(cfgDir, "config.json");
const cliEnv = { ...env, AGENTTOWN_CONFIG: cfgPath, AGENTTOWN_SERVER: BASE };
const get = async (p: string) => (await fetch(BASE + p)).json() as Promise<any>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs one hook like a host would; asserts the contract (silent, exit 0, fast). */
function hook(adapter: string, payload: object | null, { argv = false, envOver = {} as Record<string, string> } = {}) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [CLI, "hook", adapter, ...(argv ? [JSON.stringify(payload)] : [])], {
    env: { ...cliEnv, ...envOver }, input: argv ? "" : JSON.stringify(payload), encoding: "utf8",
  });
  assert.equal(r.status, 0, `hook exits 0 (${r.stderr})`);
  assert.equal(r.stdout, "", "hook never writes stdout");
  assert.equal(r.stderr, "", "hook never writes stderr");
  return Date.now() - t0;
}

/** Waits until the detached flusher has sent everything. */
async function drained() {
  const spool = join(cfgDir, "spool.jsonl"), lock = join(cfgDir, "spool.lock");
  for (let i = 0; i < 200; i++) {
    if (!existsSync(spool) && !existsSync(lock)) return;
    await sleep(25);
  }
  throw new Error("spool not drained");
}

const decrypt = (ownerKey: string, enc: string) => {
  const key = createHmac("sha256", Buffer.from(ownerKey)).update("agenttown/enc/v1").digest();
  const [, iv, ct] = enc.split(".");
  const buf = Buffer.from(ct, "base64url");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  d.setAuthTag(buf.subarray(-16));
  return Buffer.concat([d.update(buf.subarray(0, -16)), d.final()]).toString("utf8").replace(/\0+$/, "");
};

try {
  // Not registered ⇒ silent no-op.
  hook("claude-code", { session_id: "x", hook_event_name: "SessionStart", source: "startup" });
  assert.ok(!existsSync(join(cfgDir, "spool.jsonl")), "nothing spooled when not registered");

  spawnSync(process.execPath, [CLI, "register", "--home", "Hook Home"], { env: cliEnv, encoding: "utf8" });
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  const homeUrl = `/v1/homes/${cfg.home_id}`;
  const state = async () => (await get(homeUrl)).sessions as any[];
  const byKey = (sessions: any[], n: number) => sessions[n];

  // ---- Claude Code session ----
  const sid = "8b9acbb1-359f-441d-a3cc-8dc7853d2c1a";
  const common = { session_id: sid, transcript_path: "/Users/me/.claude/projects/x/y.jsonl", cwd: "/Users/me/secret-project", permission_mode: "default" };
  const ms = hook("claude-code", { ...common, hook_event_name: "SessionStart", source: "startup" });
  assert.ok(ms < 1500, `hook returns fast (${ms} ms)`);
  hook("claude-code", { ...common, hook_event_name: "UserPromptSubmit", prompt: "\n  修复登录页的 bug，   顺便加测试\nsecond line with SECRET_CODE" });
  hook("claude-code", { ...common, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "cat /etc/SECRET_PATH" }, tool_use_id: "toolu_1" });
  await drained();
  let s = await state();
  assert.equal(s.length, 1);
  assert.equal(s[0].status, "tool");
  assert.equal(s[0].tool, "Bash");
  assert.equal(decrypt(cfg.owner_key, s[0].task_enc), "修复登录页的 bug， 顺便加测试", "title = first line, collapsed");
  const mainTask = s[0].task_no;

  hook("claude-code", { ...common, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: {}, tool_response: { stdout: "SECRET" }, tool_use_id: "toolu_1" });
  // Subagent: Agent tool in the main session, then the subagent's own lifecycle and tools.
  hook("claude-code", { ...common, hook_event_name: "PreToolUse", tool_name: "Agent", tool_use_id: "toolu_2",
    tool_input: { description: "Explore auth module", prompt: "long SECRET prompt", subagent_type: "Explore" } });
  const agent = { ...common, agent_id: "a1d872093aabdc583", agent_type: "Explore" };
  hook("claude-code", { ...agent, hook_event_name: "SubagentStart" });
  hook("claude-code", { ...agent, hook_event_name: "PreToolUse", tool_name: "Grep", tool_input: { pattern: "x" }, tool_use_id: "toolu_3" });
  await drained();
  s = await state();
  assert.equal(s.length, 2);
  const [main, sub] = [s.find((x) => !x.parent_id), s.find((x) => x.parent_id)];
  assert.equal(main.status, "tool");
  assert.equal(main.tool, "Agent");
  assert.equal(sub.parent_id, main.id);
  assert.equal(sub.status, "tool");
  assert.equal(sub.tool, "Grep");
  assert.equal(decrypt(cfg.owner_key, sub.task_enc), "Explore auth module", "subagent title = Agent tool description");
  assert.notEqual(sub.task_no, mainTask);

  hook("claude-code", { ...agent, hook_event_name: "PostToolUse", tool_name: "Grep", tool_input: {}, tool_response: {}, tool_use_id: "toolu_3" });
  hook("claude-code", { ...agent, hook_event_name: "SubagentStop", stop_hook_active: false, agent_transcript_path: "/x", last_assistant_message: "SECRET" });
  hook("claude-code", { ...common, hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: {}, tool_response: {}, tool_use_id: "toolu_2" });
  // Host-injected hand-back is not a new task.
  hook("claude-code", { ...common, hook_event_name: "UserPromptSubmit", prompt: '<agent-message from="a1d8">done</agent-message>' });
  hook("claude-code", { ...common, hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" });
  await drained();
  s = await state();
  assert.equal(s.length, 1, "subagent ended on SubagentStop");
  assert.equal(s[0].status, "waiting");
  assert.equal(s[0].task_no, mainTask, "synthetic prompt keeps the task");

  hook("claude-code", { ...common, hook_event_name: "Notification", notification_type: "auth_success", message: "x" }); // ignored
  hook("claude-code", { ...common, hook_event_name: "Stop", stop_hook_active: false });
  await drained();
  assert.equal(byKey(await state(), 0).status, "idle");

  hook("claude-code", { ...common, hook_event_name: "SessionEnd", reason: "prompt_input_exit" });
  await drained();
  assert.equal((await state()).length, 0, "SessionEnd ⇒ ended");

  // ---- Codex hooks (same stdin shape) + legacy notify (argv JSON) ----
  const thread = "01a18ac5-eff4-7353-a574-113f81d5b530";
  const cx = { session_id: thread, turn_id: "t1", cwd: "/tmp", model: "gpt-x", transcript_path: null };
  hook("codex", { ...cx, hook_event_name: "SessionStart", source: "startup" });
  hook("codex", { ...cx, hook_event_name: "UserPromptSubmit", prompt: "Refactor the parser" });
  hook("codex", { ...cx, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "c1", tool_input: { command: "ls" } });
  await drained();
  s = await state();
  assert.equal(s.length, 1);
  assert.equal(s[0].tool, "Bash");
  hook("codex", { ...cx, hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "ok" });
  await drained();
  assert.equal((await state())[0].status, "idle");

  const notify = { type: "agent-turn-complete", "thread-id": "notify-thread-1", "turn-id": "t9", cwd: "/tmp", client: "codex_exec",
    "input-messages": ["Write the README\nwith details"], "last-assistant-message": "done" };
  hook("codex", notify, { argv: true });
  hook("codex", { type: "something-else" }, { argv: true }); // ignored
  await drained();
  s = await state();
  const notified = s.find((x) => x.task_enc && decrypt(cfg.owner_key, x.task_enc) === "Write the README");
  assert.ok(notified, "notify ⇒ task with first line of the input message");
  assert.equal(notified.status, "idle", "notify ⇒ ends the turn idle");

  const home = await get(homeUrl);
  const kinds = Object.fromEntries(home.personas.map((p: any) => [p.name, p.kind]));
  assert.deepEqual(kinds, { Claude: "claude-code", Codex: "codex" }, "default persona names, never hostname/username");
  const pub = JSON.stringify(home) + JSON.stringify(await get(`${homeUrl}/events?limit=500`));
  for (const secret of ["SECRET", "修复", "Refactor", "README", "secret-project", "/Users/me"]) {
    assert.ok(!pub.includes(secret), `public API never contains "${secret}"`);
  }

  // ---- config: personas override, titles:false, disabled ----
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, personas: { "claude-code": "Opus" }, titles: false }));
  hook("claude-code", { session_id: "s2", hook_event_name: "UserPromptSubmit", prompt: "hidden title" });
  await drained();
  const s2 = (await get(homeUrl)).sessions.find((x: any) => x.task_enc === null && x.status === "thinking");
  assert.ok(s2, "titles:false ⇒ task without title");
  assert.ok((await get(homeUrl)).personas.some((p: any) => p.name === "Opus"));
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, disabled: true }));
  hook("claude-code", { session_id: "s3", hook_event_name: "SessionStart", source: "startup" });
  assert.ok(!existsSync(join(cfgDir, "spool.jsonl")), "disabled ⇒ no-op");
  writeFileSync(cfgPath, JSON.stringify(cfg));

  // ---- garbage / offline never fail ----
  const g = spawnSync(process.execPath, [CLI, "hook", "claude-code"], { env: cliEnv, input: "not json{", encoding: "utf8" });
  assert.equal(g.status, 0);
  assert.equal(g.stdout + g.stderr, "");
  assert.ok(!readFileSync(join(cfgDir, "hook.log"), "utf8").includes("not json"), "hook.log never echoes payloads");
  const offline = hook("claude-code", { session_id: "s4", hook_event_name: "Stop" }, { envOver: { AGENTTOWN_SERVER: "http://127.0.0.1:9" } });
  assert.ok(offline < 1500);
  await drained();

  // ---- Claude Code plugin launcher (uses the CLI next to the config, else the bundled copy) ----
  const viaPlugin = spawnSync(process.execPath, ["plugins/claude-code/scripts/hook.mjs", "claude-code"], {
    env: cliEnv, input: JSON.stringify({ session_id: "plug-1", hook_event_name: "SessionStart", source: "startup" }), encoding: "utf8",
  });
  assert.equal(viaPlugin.status, 0);
  assert.equal(viaPlugin.stdout, "");
  await drained();
  assert.ok((await get(homeUrl)).sessions.some((x: any) => x.status === "idle"), "plugin launcher reports");
  const { bundledCli } = await import("../scripts/sync-plugins.mjs");
  assert.equal(readFileSync("plugins/claude-code/bin/agenttown.mjs", "utf8"), bundledCli(), "bundled CLI in sync (npm run sync:plugins)");

  // ---- MCP server ----
  const rpc = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "agenttown_report", arguments: { status: "thinking", task: "MCP task" } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "agenttown_report", arguments: { status: "tool", tool: "Edit" } } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "agenttown_whoami", arguments: {} } },
    { jsonrpc: "2.0", id: 6, method: "bogus" },
  ].map((m) => JSON.stringify(m)).join("\n") + "\n";
  const mcpEnv = { ...cliEnv, AGENTTOWN_SESSION: "mcp-test", AGENTTOWN_KIND: "gemini-cli", AGENTTOWN_PERSONA: "Gemini" };
  const mcpOut = await new Promise<string>((ok) => {
    const p = spawn(process.execPath, ["plugins/mcp/agenttown-mcp.mjs"], { env: mcpEnv, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => ok(out));
    p.stdin.end(rpc);
  });
  const replies = mcpOut.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(replies.length, 6, "no reply to notifications");
  assert.equal(replies[0].result.serverInfo.name, "agenttown");
  assert.deepEqual(replies[1].result.tools.map((t: any) => t.name), ["agenttown_report", "agenttown_whoami"]);
  assert.match(replies[2].result.content[0].text, /^ok \(task #\d+\)/);
  assert.equal(JSON.parse(replies[4].result.content[0].text).home.id, cfg.home_id);
  assert.equal(replies[5].error.code, -32601);
  const ev = (await get(`${homeUrl}/events?limit=500`)).events;
  const mcpSess = (await get(homeUrl)).personas.find((p: any) => p.name === "Gemini");
  assert.ok(mcpSess && mcpSess.kind === "gemini-cli");
  assert.ok(ev.some((e: any) => e.tool === "Edit"));
  assert.equal(ev[0].status, "ended", "MCP session ended when stdin closed");

  console.log("hooks: all checks passed");
} finally {
  server.kill();
}
