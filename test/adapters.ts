// Host-agent adapters: payload normalization and install/uninstall round trips (no DB, no network).
//   node --disable-warning=ExperimentalWarning test/adapters.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapHookEvent, NORMALIZE } from "../public/cli/agenttown.mjs";

const CLI = "public/cli/agenttown.mjs";
const map = (adapter: string, ev: object, evName?: string) =>
  mapHookEvent((NORMALIZE as any)[adapter]?.(ev, evName) ?? ev, { encrypt: (t: string) => `enc(${t})` });

// ---- payloads -> reports ----
// Gemini CLI
assert.deepEqual(map("gemini", { session_id: "g1", hook_event_name: "BeforeAgent", prompt: "fix the bug" }),
  [{ session: "g1", status: "thinking", task: { title_enc: "enc(fix the bug)" } }]);
assert.deepEqual(map("gemini", { session_id: "g1", hook_event_name: "BeforeTool", tool_name: "run_shell_command" }),
  [{ session: "g1", status: "tool", tool: "run_shell_command" }]);
assert.deepEqual(map("gemini", { session_id: "g1", hook_event_name: "Notification", notification_type: "ToolPermission" }),
  [{ session: "g1", status: "waiting" }]);
assert.deepEqual(map("gemini", { session_id: "g1", hook_event_name: "AfterAgent" }), [{ session: "g1", status: "idle" }]);
// Qwen Code: the human's prompt is submitted_prompt
assert.deepEqual(map("qwen", { session_id: "q1", hook_event_name: "UserPromptSubmit", prompt: "<tool_result>x</tool_result>", submitted_prompt: "add tests" }),
  [{ session: "q1", status: "thinking", task: { title_enc: "enc(add tests)" } }]);
// Copilot CLI: camelCase payload, event named on the command line
assert.deepEqual(map("copilot", { sessionId: "c1", timestamp: 1, prompt: "ship it" }, "userPromptSubmitted"),
  [{ session: "c1", status: "thinking", task: { title_enc: "enc(ship it)" } }]);
assert.deepEqual(map("copilot", { sessionId: "c1", toolName: "bash", toolArgs: "{}" }, "preToolUse"),
  [{ session: "c1", status: "tool", tool: "bash" }]);
assert.deepEqual(map("copilot", { sessionId: "c1" }, "agentStop"), [{ session: "c1", status: "idle" }]);
assert.deepEqual(map("copilot", { sessionId: "c1", agentId: "a7", agentType: "explore" }, "subagentStop"),
  [{ session: "c1:a7", parent: "c1", status: "ended" }]);
// Auggie: conversation_id, PromptSubmit/user_prompt
assert.deepEqual(map("auggie", { conversation_id: "u1", hook_event_name: "PromptSubmit", user_prompt: "refactor" }),
  [{ session: "u1", status: "thinking", task: { title_enc: "enc(refactor)" } }]);
// Kimi: PermissionRequest = waiting
assert.deepEqual(map("kimi", { session_id: "k1", hook_event_name: "PermissionRequest", tool_name: "Shell" }),
  [{ session: "k1", status: "waiting" }]);
assert.deepEqual(map("kimi", { session_id: "k1", hook_event_name: "Interrupt" }), [{ session: "k1", status: "idle" }]);
// Cursor: conversation_id; postToolUse shows the tool
assert.deepEqual(map("cursor", { conversation_id: "cu", hook_event_name: "beforeSubmitPrompt", prompt: "hi" }, "beforeSubmitPrompt"),
  [{ session: "cu", status: "thinking", task: { title_enc: "enc(hi)" } }]);
assert.deepEqual(map("cursor", { conversation_id: "cu", tool_name: "Shell" }, "postToolUse"), [{ session: "cu", status: "tool", tool: "Shell" }]);
assert.deepEqual(map("cursor", { conversation_id: "cu", status: "completed" }, "stop"), [{ session: "cu", status: "idle" }]);
// Windsurf: trajectory_id, tool from the event
assert.deepEqual(map("windsurf", { agent_action_name: "pre_run_command", trajectory_id: "w1", tool_info: { command_line: "ls" } }),
  [{ session: "w1", status: "tool", tool: "Bash" }]);
assert.deepEqual(map("windsurf", { agent_action_name: "pre_user_prompt", trajectory_id: "w1", tool_info: { user_prompt: "go" } }),
  [{ session: "w1", status: "thinking", task: { title_enc: "enc(go)" } }]);
assert.deepEqual(map("windsurf", { agent_action_name: "post_cascade_response", trajectory_id: "w1" }), [{ session: "w1", status: "idle" }]);
// Cline: VS Code and CLI payload shapes
assert.deepEqual(map("cline", { taskId: "t1", hookName: "PreToolUse", preToolUse: { toolName: "execute_command" } }, "PreToolUse"),
  [{ session: "t1", status: "tool", tool: "execute_command" }]);
assert.deepEqual(map("cline", { taskId: "t1", hookName: "tool_call", tool_call: { name: "read_file" } }, "PreToolUse"),
  [{ session: "t1", status: "tool", tool: "read_file" }]);
assert.deepEqual(map("cline", { taskId: "t1" }, "TaskComplete"), [{ session: "t1", status: "idle" }]);
// Kiro: the prompt arrives in USER_PROMPT
process.env.USER_PROMPT = "write docs";
assert.deepEqual(map("kiro", { session_id: "ki", hook_event_name: "UserPromptSubmit" }),
  [{ session: "ki", status: "thinking", task: { title_enc: "enc(write docs)" } }]);
delete process.env.USER_PROMPT;
// OpenCode (our plugin's forwarded shape, 1.x and 2.x)
assert.deepEqual(map("opencode", { v: 2, event: "prompt", session_id: "o1", prompt: "plan it" }),
  [{ session: "o1", status: "thinking", task: { title_enc: "enc(plan it)" } }]);
assert.deepEqual(map("opencode", { v: 1, event: "tool.before", session_id: "o1", tool: "bash" }), [{ session: "o1", status: "tool", tool: "bash" }]);
assert.deepEqual(map("opencode", { v: 2, event: "session.status", data: { sessionID: "o1", status: { type: "idle" } } }), [{ session: "o1", status: "idle" }]);
assert.deepEqual(map("opencode", { v: 2, event: "session.status", data: { sessionID: "o1", status: { type: "busy" } } }), []);
assert.deepEqual(map("opencode", { v: 1, event: "permission.updated", properties: { sessionID: "o1" } }), [{ session: "o1", status: "waiting" }]);
// Hermes: pre_llm_call = thinking (no new task); on_session_end = end of a turn
assert.deepEqual(map("hermes", { hook_event_name: "pre_llm_call", session_id: "h1", extra: { user_message: "x" } }), [{ session: "h1", status: "thinking" }]);
assert.deepEqual(map("hermes", { hook_event_name: "pre_tool_call", session_id: "h1", tool_name: "terminal" }), [{ session: "h1", status: "tool", tool: "terminal" }]);
assert.deepEqual(map("hermes", { hook_event_name: "on_session_end", session_id: "h1" }), [{ session: "h1", status: "idle" }]);
assert.deepEqual(map("hermes", { hook_event_name: "on_session_finalize", session_id: "h1" }), [{ session: "h1", status: "ended" }]);
// Goose: event + message
assert.deepEqual(map("goose", { event: "UserPromptSubmit", session_id: "go", message: "hello" }),
  [{ session: "go", status: "thinking", task: { title_enc: "enc(hello)" } }]);
// Crush: TurnEnd = idle, PermissionRequest = waiting
assert.deepEqual(map("crush", { hook_event_name: "TurnEnd", session_id: "cr" }), [{ session: "cr", status: "idle" }]);
assert.deepEqual(map("crush", { hook_event_name: "PermissionRequest", session_id: "cr" }), [{ session: "cr", status: "waiting" }]);
// OpenClaw (our extension's forwarded shape)
assert.deepEqual(map("openclaw", { event: "tool_start", session_id: "oc", tool: "exec" }), [{ session: "oc", status: "tool", tool: "exec" }]);
assert.deepEqual(map("openclaw", { event: "turn_end", session_id: "oc" }), [{ session: "oc", status: "idle" }]);
// Claude-compatible hosts pass through unchanged
for (const a of ["codebuddy", "workbuddy", "qoder", "droid"]) {
  assert.deepEqual(map(a, { session_id: "s", hook_event_name: "PreToolUse", tool_name: "Execute" }), [{ session: "s", status: "tool", tool: "Execute" }]);
}

// ---- install / uninstall round trips in a scratch HOME ----
const home = mkdtempSync(join(tmpdir(), "agenttown-adapters-"));
mkdirSync(join(home, ".agenttown"));
writeFileSync(join(home, ".agenttown", "config.json"), JSON.stringify({ server: "http://127.0.0.1:9", home_id: "h_test", owner_key: "atk_" + "0".repeat(32) }));
const cli = (...args: string[]) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, HOME: home, XDG_CONFIG_HOME: "", CRUSH_GLOBAL_CONFIG: "", HERMES_HOME: "", CLAUDE_CONFIG_DIR: "", CODEX_HOME: "", GEMINI_CLI_HOME: "", QWEN_HOME: "", COPILOT_HOME: "", WORKBUDDY_CONFIG_DIR: "", KIMI_CODE_HOME: "" }, encoding: "utf8" });
  assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};
// a Hermes config of the user's (no hooks yet) keeps its settings
mkdirSync(join(home, ".hermes"));
writeFileSync(join(home, ".hermes", "config.yaml"), "model: hermes-4\n");
// a user setting that must survive
mkdirSync(join(home, ".gemini"));
writeFileSync(join(home, ".gemini", "settings.json"), JSON.stringify({ theme: "dark", hooks: { BeforeTool: [{ hooks: [{ type: "command", command: "mine" }] }] } }));
const FILES: Record<string, string> = {
  "claude-code": ".claude/settings.json", codebuddy: ".codebuddy/settings.json", codex: ".codex/config.toml", gemini: ".gemini/settings.json",
  qwen: ".qwen/settings.json", copilot: ".copilot/hooks/agenttown.json", workbuddy: ".workbuddy/settings.json", qoder: ".qoder/settings.json",
  droid: ".factory/settings.json", auggie: ".augment/settings.json", kimi: ".kimi-code/config.toml",
  cursor: ".cursor/hooks.json", windsurf: ".codeium/windsurf/hooks.json", cline: "Documents/Cline/Hooks/PreToolUse",
  kiro: ".kiro/hooks/agenttown.json", opencode: ".config/opencode/plugins/agenttown.js", hermes: ".hermes/config.yaml",
  goose: ".agents/plugins/agenttown/hooks/hooks.json", crush: ".config/crush/crushrc", openclaw: ".openclaw/extensions/agenttown/index.js",
};
for (const [a, f] of Object.entries(FILES)) {
  cli("install", a);
  cli("install", a); // idempotent
  const text = readFileSync(join(home, f), "utf8");
  const n = text.split(`hook ${a}`).length - 1 + text.split(`"hook", "${a}"`).length - 1;
  const expect = { cline: 1, crush: 1, opencode: 1, openclaw: 1 }[a];
  assert.ok(expect ? n === expect : n >= 6, `${a}: hooks written to ${f} (${n})`);
}
// Cursor needs {"continue": true} from beforeSubmitPrompt — even when this machine isn't registered
const reply = spawnSync(process.execPath, [CLI, "hook", "cursor", "beforeSubmitPrompt"], { env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), "agenttown-nohome-")) }, input: "{}", encoding: "utf8" });
assert.deepEqual([reply.status, JSON.parse(reply.stdout)], [0, { continue: true }]);
const cur = JSON.parse(readFileSync(join(home, FILES.cursor), "utf8"));
assert.equal(cur.version, 1);
assert.ok(!cur.hooks.preToolUse, "no permission-class hooks for Cursor");
assert.match(cur.hooks.stop[0].command, /hook cursor stop$/);
// a user's own Cline hook with one of our names is left alone
writeFileSync(join(home, "Documents/Cline/Hooks/TaskError"), "#!/bin/sh\necho mine\n");
cli("install", "cline");
assert.equal(readFileSync(join(home, "Documents/Cline/Hooks/TaskError"), "utf8"), "#!/bin/sh\necho mine\n");
const gem = JSON.parse(readFileSync(join(home, ".gemini/settings.json"), "utf8"));
assert.equal(gem.theme, "dark");
assert.equal(gem.hooks.BeforeTool.length, 2, "user's own hook kept, ours added once");
assert.equal(gem.hooks.BeforeTool[1].hooks[0].timeout, 5000, "Gemini timeouts are milliseconds");
const cop = JSON.parse(readFileSync(join(home, FILES.copilot), "utf8"));
assert.equal(cop.version, 1);
assert.match(cop.hooks.preToolUse[0].bash, /hook copilot preToolUse$/);
for (const a of Object.keys(FILES)) cli("uninstall", a);
assert.deepEqual(JSON.parse(readFileSync(join(home, ".gemini/settings.json"), "utf8")),
  { theme: "dark", hooks: { BeforeTool: [{ hooks: [{ type: "command", command: "mine" }] }] } }, "uninstall leaves the user's settings");
assert.ok(!existsSync(join(home, FILES.copilot)));
assert.equal(readFileSync(join(home, ".hermes", "config.yaml"), "utf8"), "model: hermes-4\n", "Hermes config restored");
assert.ok(existsSync(join(home, "Documents/Cline/Hooks/TaskError")), "user's Cline hook kept on uninstall");
for (const f of Object.values(FILES)) if (existsSync(join(home, f))) assert.ok(!readFileSync(join(home, f), "utf8").includes("agenttown.mjs"), `${f} cleaned`);

console.log("adapters: all checks passed");
