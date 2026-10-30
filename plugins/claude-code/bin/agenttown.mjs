#!/usr/bin/env node
// Agent Town CLI — zero dependencies, Node >= 18.
// Docs: https://agenttown.xyz/agents.md
import { spawn } from "node:child_process";
import { createCipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import {
  appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_SERVER = "https://agenttown.xyz";
const CONFIG_PATH = process.env.AGENTTOWN_CONFIG || join(homedir(), ".agenttown", "config.json");

// ---------- config ----------

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    fail(`Config at ${CONFIG_PATH} is not valid JSON.`);
  }
}

function saveConfig(cfg) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  chmodSync(CONFIG_PATH, 0o600);
}

function requireConfig() {
  const cfg = loadConfig();
  if (!cfg?.owner_key) fail(`Not registered on this machine. Run \`agenttown register --home "<name>"\` or \`agenttown login <owner_key>\`.`);
  return cfg;
}

const serverOf = (cfg, args) => (args.server || process.env.AGENTTOWN_SERVER || cfg?.server || DEFAULT_SERVER).replace(/\/$/, "");

// ---------- crypto (see docs/protocol.md) ----------

const hmac = (key, msg) => createHmac("sha256", Buffer.from(key, "utf8")).update(msg).digest();
export const authToken = (ownerKey) => hmac(ownerKey, "agenttown/auth/v1").toString("hex");
export const encKey = (ownerKey) => hmac(ownerKey, "agenttown/enc/v1");

export function encryptTitle(ownerKey, title) {
  let raw = Buffer.from(String(title), "utf8");
  if (raw.length > 480) {
    let s = String(title);
    while (Buffer.byteLength(s, "utf8") > 480) s = [...s].slice(0, -1).join("");
    raw = Buffer.from(s, "utf8");
  }
  const pt = Buffer.alloc(Math.ceil((raw.length + 1) / 32) * 32);
  raw.copy(pt);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", encKey(ownerKey), iv);
  const ct = Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
  return `v1.${iv.toString("base64url")}.${ct.toString("base64url")}`;
}

function zeroBits(buf) {
  let n = 0;
  for (const b of buf) {
    if (b === 0) { n += 8; continue; }
    return n + Math.clz32(b) - 24;
  }
  return n;
}

function solvePow(challenge, difficulty) {
  for (let i = 0; ; i++) {
    const nonce = i.toString(36);
    if (zeroBits(createHash("sha256").update(`${challenge}:${nonce}`).digest()) >= difficulty) return nonce;
  }
}

// ---------- http ----------

async function call(server, method, path, { token, body, timeoutMs = 10_000 } = {}) {
  const res = await fetch(`${server}/v1${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "user-agent": "agenttown-cli/1",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `HTTP ${res.status}`);
    err.code = data.error;
    throw err;
  }
  return data;
}

// ---------- commands ----------

async function cmdRegister(args) {
  const existing = loadConfig();
  if (existing?.owner_key && !args.force) {
    out(`Already registered on this machine (home ${existing.home_id}). Nothing to do.`);
    out(`Run \`agenttown whoami\` to see it. One home per user — do not register again.`);
    return;
  }
  const home = args.home || args._[0];
  if (!home) fail(`Usage: agenttown register --home "<home name>"`);
  const server = serverOf(existing, args);
  const ownerKey = "atk_" + randomBytes(32).toString("base64url");
  const token = authToken(ownerKey);
  const { challenge, difficulty } = await call(server, "GET", "/register/challenge");
  const nonce = solvePow(challenge, difficulty);
  const r = await call(server, "POST", "/register", { body: { challenge, nonce, auth_token: token, home_name: home } });
  saveConfig({ server, owner_key: ownerKey, home_id: r.home.id });
  out(`Registered home "${r.home.name}" (${r.home.id}).`);
  out(`Home page:  ${r.home_url}`);
  out(`Owner key:  ${ownerKey}`);
  out(`Saved to ${CONFIG_PATH}.`);
  out(``);
  out(`Tell your human: keep the owner key secret. Paste it on the website ("I'm the owner") to see real task names,`);
  out(`and run \`agenttown login <owner_key>\` on other machines instead of registering again.`);
}

async function cmdLogin(args) {
  const ownerKey = args._[0] || args.key;
  if (!ownerKey?.startsWith("atk_")) fail("Usage: agenttown login <owner_key>   (starts with atk_)");
  const server = serverOf(loadConfig(), args);
  const me = await call(server, "GET", "/me", { token: authToken(ownerKey) });
  saveConfig({ server, owner_key: ownerKey, home_id: me.home.id });
  out(`Logged in to home "${me.home.name}" (${me.home.id}). ${me.home_url}`);
}

async function cmdWhoami(args) {
  const cfg = requireConfig();
  const me = await call(serverOf(cfg, args), "GET", "/me", { token: authToken(cfg.owner_key) });
  if (args.json) return out(JSON.stringify(me));
  out(`Home "${me.home.name}" (${me.home.id})\n${me.home_url}`);
}

function cmdKey() {
  out(requireConfig().owner_key);
}

// `home --look "<one sentence>"`: Claude draws the home from it (dwelling art). `--look ""` clears it.
async function cmdHomeLook(cfg, args) {
  if (typeof args.look !== "string") fail(`Usage: agenttown home --look "<what your home looks like>"   (--look "" to clear)`);
  const look = args.look.trim() || null;
  const r = await call(serverOf(cfg, args), "PUT", "/home/look", { token: authToken(cfg.owner_key), body: { look } });
  if (args.json) return out(JSON.stringify(r.home));
  out(look ? `Home look set — dwelling art: ${r.home.art_status}` : "Home look cleared.");
}

async function cmdHome(args) {
  const cfg = requireConfig();
  if (args.look !== undefined) return cmdHomeLook(cfg, args);
  const name = args.name || args._[0];
  if (!name) fail(`Usage: agenttown home --name "<new name>"`);
  const r = await call(serverOf(cfg, args), "PATCH", "/home", { token: authToken(cfg.owner_key), body: { name } });
  out(`Home renamed to "${r.home.name}".`);
}

async function cmdPersona(args) {
  const cfg = requireConfig();
  if (!args.name) fail(`Usage: agenttown persona --name "<name>" [--kind claude-code] [--appearance "<how you look>"]`);
  const body = { name: args.name, kind: args.kind || "other" };
  if (args.appearance !== undefined) body.appearance = args.appearance;
  const r = await call(serverOf(cfg, args), "POST", "/personas", { token: authToken(cfg.owner_key), body });
  if (args.json) return out(JSON.stringify(r.persona));
  out(`Persona "${r.persona.name}" (${r.persona.kind}) — sprite: ${r.persona.sprite_status}`);
}

export async function sendReport(cfg, { persona, kind, session, parent, status, tool, task }, opts = {}) {
  const body = { persona: { name: persona, kind: kind || "other" }, session, status };
  if (parent) body.parent = parent;
  if (tool) body.tool = tool;
  if (task !== undefined && task !== null) body.task = task === "" ? {} : { title_enc: encryptTitle(cfg.owner_key, task) };
  return call(serverOf(cfg, opts), "POST", "/report", { token: authToken(cfg.owner_key), body, timeoutMs: opts.timeoutMs });
}

async function cmdReport(args) {
  const cfg = requireConfig();
  if (!args.persona || !args.session || !args.status) {
    fail(`Usage: agenttown report --persona <name> --kind <kind> --session <id> --status thinking|tool|waiting|idle|ended [--tool <name>] [--task "<title>"] [--parent <session id>]`);
  }
  const r = await sendReport(cfg, {
    persona: args.persona, kind: args.kind, session: args.session, parent: args.parent,
    status: args.status, tool: args.tool, task: args.task === true ? "" : args.task,
  }, args);
  out(JSON.stringify(r));
}

const HELP = `agenttown — report what your AI agent is doing to Agent Town (${DEFAULT_SERVER})

  register --home "<name>"   create your home (once per human; machine-wide)
  login <owner_key>          use an existing home on this machine
  whoami                     show your home
  key                        print the owner key (for the website's owner view)
  home --name "<name>"       rename your home
  home --look "<sentence>"   describe your home; Claude draws it in that style ("" clears)
  persona --name <n> [--kind <k>] [--appearance "<text>"]
                             create/update a character; appearance → generated pixel sprite
  report --persona <n> --kind <k> --session <id> --status <s> [--tool <t>] [--task "<title>"] [--parent <id>]
                             send one status update (task titles are encrypted locally)
  install claude-code|codex  add automatic-reporting hooks to that agent's config (uninstall to undo)
  hook claude-code|codex     read a host hook payload (stdin, or Codex notify argv) and report it;
                             silent, never fails, returns immediately (see plugins/ in the repo)

Global: --server <url>   Config: ${CONFIG_PATH}
Full docs: ${DEFAULT_SERVER}/agents.md`;

const COMMANDS = {
  register: cmdRegister, login: cmdLogin, whoami: cmdWhoami, key: cmdKey,
  home: cmdHome, persona: cmdPersona, report: cmdReport,
};

// ---------- hooks: automatic reporting from agent hosts ----------
//
// `agenttown hook <adapter>` is run by the host agent (Claude Code / Codex hooks, Codex `notify`).
// Contract: never print to stdout, never exit non-zero, never block the agent.
// The hook process only maps the payload to report bodies (titles are encrypted right here, so
// nothing on disk or on the wire is plaintext), appends them to a local spool and spawns a
// detached `hook-flush` child that sends the spool in order. Only status, public tool names and
// encrypted titles are ever sent — never prompts, code, paths or commands.

export const HOOK_VERSION = 1;
const STATE_DIR = dirname(CONFIG_PATH);
const SPOOL = join(STATE_DIR, "spool.jsonl");
const LOCK = join(STATE_DIR, "spool.lock");
const PENDING = join(STATE_DIR, "pending-subagents");
const HOOK_LOG = join(STATE_DIR, "hook.log");
const HOOK_KINDS = { "claude-code": "claude-code", codex: "codex" };
const DEFAULT_PERSONAS = { "claude-code": "Claude", codex: "Codex" };
const SPAWN_TOOLS = new Set(["Agent", "Task"]);
const WAIT_NOTIFICATIONS = new Set(["permission_prompt", "idle_prompt", "elicitation_dialog", "elicitation_url_dialog", "agent_needs_input"]);

function hookLog(msg) {
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    try { if (statSync(HOOK_LOG).size > 64 * 1024) renameSync(HOOK_LOG, HOOK_LOG + ".1"); } catch {}
    appendFileSync(HOOK_LOG, `${new Date().toISOString()} ${msg}\n`, { mode: 0o600 });
  } catch {}
}

function hookConfig() {
  if (process.env.AGENTTOWN_DISABLED === "1") return null;
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return cfg?.owner_key && !cfg.disabled ? cfg : null;
  } catch {
    return null;
  }
}

/** First non-empty line, whitespace collapsed, ≤ 80 chars. */
export function taskTitle(text) {
  const line = String(text ?? "").split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).find(Boolean) ?? "";
  const chars = [...line];
  return chars.length > 80 ? chars.slice(0, 79).join("") + "…" : line;
}

// Host-injected prompts (subagent hand-backs, task notifications, …) are not new human tasks.
const isSyntheticPrompt = (p) => /^\s*<([a-z][\w-]*)[\s>][\s\S]*<\/\1>/i.test(String(p ?? ""));

const safeId = (v, max = 90) => {
  const s = typeof v === "string" ? v.replace(/[^\w.:-]/g, "-").slice(0, max) : "";
  return s || null;
};

// Remember the description of a subagent spawn until SubagentStart claims it (stored encrypted).
function stashSubagent(sid, title_enc, type) {
  try {
    const dir = join(PENDING, sid);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const now = Date.now();
    for (const f of readdirSync(dir)) if (now - Number(f.split("-")[0]) > 86_400_000) rmSync(join(dir, f), { force: true });
    writeFileSync(join(dir, `${now}-${randomBytes(4).toString("hex")}.json`), JSON.stringify({ title_enc, type }), { mode: 0o600 });
  } catch (e) { hookLog(`stash: ${e.message}`); }
}

function claimSubagent(sid, type) {
  const dir = join(PENDING, sid);
  let files;
  try { files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort(); } catch { return null; }
  const items = files.map((f) => { try { return { f, ...JSON.parse(readFileSync(join(dir, f), "utf8")) }; } catch { return null; } }).filter(Boolean);
  const order = [...items.filter((i) => i.type === type), ...items.filter((i) => i.type !== type)];
  for (const it of order) {
    const claimed = join(dir, it.f + `.${process.pid}.claimed`);
    try { renameSync(join(dir, it.f), claimed); } catch { continue; } // another hook got it
    rmSync(claimed, { force: true });
    return it.title_enc ?? null;
  }
  return null;
}

/** Maps a Claude Code / Codex hook payload (same shape) to report descriptors. */
export function mapHookEvent(ev, { encrypt = (t) => t } = {}) {
  const sid = safeId(ev?.session_id);
  if (!sid) return [];
  const aid = safeId(ev.agent_id, 36);
  const main = { session: sid };
  const sub = aid ? { session: `${sid}:${aid}`, parent: sid } : main;
  switch (ev.hook_event_name) {
    case "SessionStart":
      return ev.source === "compact" ? [] : [{ ...main, status: "idle" }];
    case "UserPromptSubmit":
      if (aid || isSyntheticPrompt(ev.prompt)) return [{ ...sub, status: "thinking" }];
      return [{ ...main, status: "thinking", task: { title_enc: encrypt(taskTitle(ev.prompt)) } }];
    case "PreToolUse": {
      const tool = typeof ev.tool_name === "string" ? ev.tool_name : "Other";
      if (!aid && SPAWN_TOOLS.has(tool)) {
        const ti = ev.tool_input ?? {};
        stashSubagent(sid, encrypt(taskTitle(ti.description || ti.subagent_type || "subagent")), ti.subagent_type || "general-purpose");
      }
      return [{ ...sub, status: "tool", tool }];
    }
    case "PostToolUse":
    case "PostToolUseFailure":
      return [{ ...sub, status: "thinking" }];
    case "Notification":
      return !ev.notification_type || WAIT_NOTIFICATIONS.has(ev.notification_type) ? [{ ...sub, status: "waiting" }] : [];
    case "SubagentStart": {
      if (!aid) return [];
      const title_enc = claimSubagent(sid, ev.agent_type) ?? encrypt(taskTitle(ev.agent_type || "subagent"));
      return [{ ...sub, status: "thinking", task: { title_enc } }];
    }
    case "SubagentStop":
      return aid ? [{ ...sub, status: "ended" }] : [];
    case "Stop":
    case "StopFailure":
    case "Interrupt": // Codex
      return [{ ...main, status: "idle" }];
    case "SessionEnd":
      try { rmSync(join(PENDING, sid), { recursive: true, force: true }); } catch {}
      return [{ ...main, status: "ended" }];
    default:
      return [];
  }
}

/** Codex legacy `notify` (argv JSON, fires once per turn): thinking with the task, then idle. */
export function mapCodexNotify(n, { encrypt = (t) => t } = {}) {
  if (n?.type !== "agent-turn-complete") return [];
  const sid = safeId(n["thread-id"]) || safeId(n["turn-id"]);
  if (!sid) return [];
  const msgs = Array.isArray(n["input-messages"]) ? n["input-messages"] : [];
  const first = msgs.find((m) => typeof m === "string" && m.trim() && !isSyntheticPrompt(m));
  return [
    { session: sid, status: "thinking", ...(first ? { task: { title_enc: encrypt(taskTitle(first)) } } : {}) },
    { session: sid, status: "idle" },
  ];
}

function readStdin(timeoutMs) {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    const chunks = [];
    const done = () => resolve(Buffer.concat(chunks).toString("utf8"));
    setTimeout(done, timeoutMs).unref();
    process.stdin.on("data", (c) => chunks.push(c)).on("end", done).on("error", done);
  });
}

function spawnFlusher() {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "hook-flush"], {
    detached: true, stdio: "ignore", windowsHide: true, env: process.env,
  });
  child.on("error", (e) => hookLog(`spawn: ${e.message}`));
  child.unref();
}

/** Entry point for `agenttown hook <adapter> [notify-json]`. Always resolves; never writes stdout. */
export async function runHook(adapter, extra = []) {
  setTimeout(() => process.exit(0), 1500).unref(); // hard cap, whatever happens
  try {
    const kind = HOOK_KINDS[adapter];
    const argJson = extra.find((a) => typeof a === "string" && a.trim().startsWith("{"));
    const raw = argJson ?? (await readStdin(1000));
    const cfg = hookConfig();
    if (!kind || !cfg) return;
    const ev = JSON.parse(raw || "{}");
    const encrypt = cfg.titles === false ? () => null : (t) => encryptTitle(cfg.owner_key, t || "task");
    const reports = argJson ? mapCodexNotify(ev, { encrypt }) : mapHookEvent(ev, { encrypt });
    if (!reports.length) return;
    const persona = { name: cfg.personas?.[adapter] || DEFAULT_PERSONAS[adapter], kind };
    const lines = reports.map((r) => JSON.stringify({ persona, ...r })).join("\n") + "\n";
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    try { if (statSync(SPOOL).size > 1024 * 1024) rmSync(SPOOL, { force: true }); } catch {}
    appendFileSync(SPOOL, lines, { mode: 0o600 });
    if (process.env.AGENTTOWN_HOOK_SYNC === "1") await flushSpool();
    else spawnFlusher();
  } catch (e) {
    hookLog(`hook ${adapter}: ${e instanceof SyntaxError ? "invalid JSON payload" : e.message}`); // never echo payloads
  }
}

function acquireLock() {
  for (let i = 0; i < 2; i++) {
    try { mkdirSync(LOCK); return true; } catch (e) {
      if (e.code !== "EEXIST") return false;
      try { if (Date.now() - statSync(LOCK).mtimeMs > 30_000) { rmSync(LOCK, { recursive: true, force: true }); continue; } } catch { continue; }
      return false; // a live flusher will pick our lines up
    }
  }
  return false;
}

/** Sends spooled reports in order. One flusher at a time; others leave their lines to it. */
export async function flushSpool() {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!acquireLock()) return;
    try {
      for (let round = 0; round < 100; round++) {
        const batch = `${SPOOL}.${process.pid}.sending`;
        try { renameSync(SPOOL, batch); } catch { break; } // spool empty
        const lines = readFileSync(batch, "utf8").split("\n").filter(Boolean);
        rmSync(batch, { force: true });
        const cfg = hookConfig();
        if (!cfg) break;
        const server = serverOf(cfg, {});
        const token = authToken(cfg.owner_key);
        for (const line of lines) {
          let body;
          try { body = JSON.parse(line); } catch { continue; }
          try {
            await call(server, "POST", "/report", { token, body, timeoutMs: 5000 });
          } catch (e) {
            hookLog(`report ${body.status}: ${e.code || "network"}: ${e.message}`);
            if (!e.code) break; // offline: drop the rest of this batch rather than stall
          }
        }
      }
    } finally {
      try { rmSync(LOCK, { recursive: true, force: true }); } catch {}
    }
    if (!existsSync(SPOOL)) return; // else: lines arrived while we released the lock
  }
}

COMMANDS.hook = async (args) => { await runHook(args._[0], args._.slice(1)); process.exit(0); };
COMMANDS["hook-flush"] = async () => {
  setTimeout(() => process.exit(0), 25_000).unref();
  try { await flushSpool(); } catch (e) { hookLog(`flush: ${e.message}`); }
};

// ---------- install / uninstall hooks into host agents ----------
// Writes plain hook entries that call this CLI; no plugin marketplace needed. Idempotent; keeps a backup.

const HOOK_CMD = (adapter) => `node "$HOME/.agenttown/agenttown.mjs" hook ${adapter}`;
const CLAUDE_EVENTS = {
  SessionStart: null, UserPromptSubmit: null, PreToolUse: "*", PostToolUse: "*", PostToolUseFailure: "*",
  Notification: null, SubagentStart: null, SubagentStop: null, Stop: null, StopFailure: null, SessionEnd: null,
};
const CODEX_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "SubagentStart", "SubagentStop", "Stop", "Interrupt", "SessionEnd"];
const isOurs = (h, adapter) => typeof h?.command === "string" && h.command.includes(`agenttown.mjs" hook ${adapter}`);

const claudeSettingsPath = () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json");
const codexConfigPath = () => join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");

function backup(path) {
  if (existsSync(path)) writeFileSync(`${path}.agenttown-bak`, readFileSync(path));
}

function editClaudeSettings(fn) {
  const path = claudeSettingsPath();
  let settings = {};
  if (existsSync(path)) {
    try { settings = JSON.parse(readFileSync(path, "utf8")); } catch { fail(`${path} is not valid JSON; fix it first (nothing changed).`); }
  }
  // Drop our previous entries, then let fn add fresh ones (so re-running upgrades in place).
  const hooks = settings.hooks ?? {};
  for (const ev of Object.keys(hooks)) {
    hooks[ev] = (hooks[ev] ?? [])
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h, "claude-code")) }))
      .filter((g) => g.hooks.length);
    if (!hooks[ev].length) delete hooks[ev];
  }
  fn(hooks);
  if (Object.keys(hooks).length) settings.hooks = hooks; else delete settings.hooks;
  backup(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
  return path;
}

const CODEX_BEGIN = "# >>> agenttown hooks >>>";
const CODEX_END = "# <<< agenttown hooks <<<";
function editCodexConfig(add) {
  const path = codexConfigPath();
  const old = existsSync(path) ? readFileSync(path, "utf8") : "";
  let text = old.replace(new RegExp(`\\n?${CODEX_BEGIN}[\\s\\S]*?${CODEX_END}\\n?`), "\n");
  if (add) {
    const blocks = CODEX_EVENTS.map((ev) =>
      `[[hooks.${ev}]]\n[[hooks.${ev}.hooks]]\ntype = "command"\ncommand = '${HOOK_CMD("codex")}'\ntimeout = 5\n`).join("\n");
    text = `${text.trimEnd()}\n\n${CODEX_BEGIN}\n${blocks}${CODEX_END}\n`;
  }
  backup(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text.replace(/^\n+/, ""));
  return path;
}

function installCliCopy() {
  // Hooks call ~/.agenttown/agenttown.mjs; make sure this exact CLI is there.
  const dest = join(homedir(), ".agenttown", "agenttown.mjs");
  const self = fileURLToPath(import.meta.url);
  if (self !== dest) {
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(self));
  }
}

async function cmdInstall(args) {
  const target = args._[0];
  if (target === "claude-code") {
    requireConfig();
    installCliCopy();
    const path = editClaudeSettings((hooks) => {
      for (const [ev, matcher] of Object.entries(CLAUDE_EVENTS)) {
        (hooks[ev] ??= []).push({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: HOOK_CMD("claude-code"), timeout: 5 }] });
      }
    });
    out(`Installed Agent Town hooks into ${path} (backup: ${path}.agenttown-bak).`);
    out(`They take effect in new Claude Code sessions. Undo with \`agenttown uninstall claude-code\`.`);
  } else if (target === "codex") {
    requireConfig();
    installCliCopy();
    const path = editCodexConfig(true);
    out(`Installed Agent Town hooks into ${path} (backup: ${path}.agenttown-bak).`);
    out(`Codex asks to trust new hooks once: open Codex and run /hooks to approve them. Undo with \`agenttown uninstall codex\`.`);
    out(`Don't also configure \`notify\` for agenttown — each turn would count twice.`);
  } else {
    fail("Usage: agenttown install claude-code | codex");
  }
}

async function cmdUninstall(args) {
  const target = args._[0];
  if (target === "claude-code") out(`Removed Agent Town hooks from ${editClaudeSettings(() => {})}.`);
  else if (target === "codex") out(`Removed Agent Town hooks from ${editCodexConfig(false)}.`);
  else fail("Usage: agenttown uninstall claude-code | codex");
}

COMMANDS.install = cmdInstall;
COMMANDS.uninstall = cmdUninstall;

// ---------- plumbing ----------

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      if (v !== undefined) args[k] = v;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) args[k] = argv[++i];
      else args[k] = true;
    } else args._.push(a);
  }
  return args;
}

function out(s) { process.stdout.write(s + "\n"); }
function fail(msg) { process.stderr.write(`agenttown: ${msg}\n`); process.exit(1); }

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  const fn = COMMANDS[cmd];
  if (!fn) { out(HELP); process.exit(cmd && cmd !== "help" && cmd !== "--help" ? 1 : 0); }
  Promise.resolve(fn(parseArgs(rest))).catch((e) => fail(e.code ? `${e.code}: ${e.message}` : e.message));
}
