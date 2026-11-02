// Agent Town SDK for JavaScript — one file, zero dependencies. Node >= 18, Bun, Deno 2.
// Docs: {{BASE_URL}}/agents.md ("Agents built with SDKs, on servers and in CI"). Contract: docs/protocol.md.
//
//   import { connect } from "./agenttown.mjs";
//   const town = connect({ persona: "Scout", kind: "my-bot" });
//   const s = town.session();
//   s.thinking("Summarize the inbox");   // new task; the title is encrypted here, the server sees ciphertext only
//   s.tool("search"); s.thinking(); s.idle(); s.end();
//
// Every call is fire-and-forget: it never throws, never rejects, and gives up after a short timeout, so Agent Town
// being down or misconfigured can't slow or break the host agent. Adapters for agent frameworks are at the bottom.
import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const BASE_URL = "{{BASE_URL}}"; // the site fills this in when it serves the file
const DEFAULT_SERVER = BASE_URL.startsWith("{{") ? "https://agenttown.xyz" : BASE_URL;
export const SDK_VERSION = "1.0.0";
export const STATUSES = ["thinking", "tool", "background", "waiting", "idle", "ended"];
const BUSY = new Set(["thinking", "tool", "background"]);
const TOKEN_RE = /^[0-9a-f]{64}$/;
// Default persona names for the kinds the adapters use (any other kind: "Agent").
const DEFAULT_PERSONAS = {
  "claude-agent-sdk": "Claude", "openai-agents": "Agents", langchain: "LangChain", langgraph: "LangGraph",
  "ai-sdk": "AI SDK", "github-actions": "CI",
};

// A plain copy: Deno without --allow-env throws on access, and that must not reach the host agent.
const envOf = (opts) => { if (opts.env) return opts.env; try { return { ...process.env }; } catch { return {}; } };
const debug = (env, msg) => { if (env.AGENTTOWN_DEBUG === "1") try { console.error(`agenttown: ${msg}`); } catch {} };

// ---------- crypto (same as the CLI, see docs/protocol.md) ----------

const hmac = (key, msg) => createHmac("sha256", Buffer.from(key, "utf8")).update(msg).digest();
export const authToken = (ownerKey) => hmac(ownerKey, "agenttown/auth/v1").toString("hex");
export const encKey = (ownerKey) => hmac(ownerKey, "agenttown/enc/v1");

/** First non-empty line, whitespace collapsed, at most 80 characters (what the CLI's hooks send as a title). */
export function taskTitle(text) {
  const line = String(text ?? "").split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).find(Boolean) ?? "";
  const chars = [...line];
  return chars.length > 80 ? chars.slice(0, 79).join("") + "…" : line;
}

/** title_enc = "v1." + b64url(iv) + "." + b64url(AES-256-GCM(utf8(title) ≤ 480 bytes, zero-padded to 32n) || tag). */
export function encryptTitle(key, title) {
  let s = String(title);
  while (Buffer.byteLength(s, "utf8") > 480) s = [...s].slice(0, -1).join("");
  const raw = Buffer.from(s, "utf8");
  const pt = Buffer.alloc(Math.ceil((raw.length + 1) / 32) * 32);
  raw.copy(pt);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
  return `v1.${iv.toString("base64url")}.${ct.toString("base64url")}`;
}

// ---------- credentials ----------

const parseJson = (s) => { try { const v = JSON.parse(s); return v && typeof v === "object" ? v : null; } catch { return null; } };
const asKey = (v) => {
  if (!v) return null;
  const b = typeof v === "string" ? Buffer.from(v, "base64url") : Buffer.from(v);
  return b.length === 32 ? b : null;
};

/**
 * Where the credentials come from, first match wins:
 *   options: credentials (a config.json object or string) | ownerKey | token (+ encKey)
 *   env:     AGENTTOWN_CREDENTIALS (the JSON of a config.json) | AGENTTOWN_OWNER_KEY | AGENTTOWN_TOKEN (+ AGENTTOWN_ENC_KEY)
 *   file:    options.config | AGENTTOWN_CONFIG | ~/.agenttown/config.json (what `agenttown register` / `join` write)
 * Returns null when there are none (the SDK then does nothing). Never throws.
 */
export function loadCredentials(opts = {}) {
  const env = envOf(opts);
  let cfg = null;
  try {
    if (opts.credentials) cfg = typeof opts.credentials === "string" ? parseJson(opts.credentials) : opts.credentials;
    else if (opts.ownerKey || opts.token) cfg = { owner_key: opts.ownerKey, device_token: opts.token, enc_key: opts.encKey };
    else if (env.AGENTTOWN_CREDENTIALS) cfg = parseJson(env.AGENTTOWN_CREDENTIALS);
    else if (env.AGENTTOWN_OWNER_KEY || env.AGENTTOWN_TOKEN) {
      cfg = { owner_key: env.AGENTTOWN_OWNER_KEY, device_token: env.AGENTTOWN_TOKEN, enc_key: env.AGENTTOWN_ENC_KEY };
    } else {
      const path = opts.config || env.AGENTTOWN_CONFIG || join(homedir(), ".agenttown", "config.json");
      try { cfg = parseJson(readFileSync(path, "utf8")); } catch {}
    }
  } catch {}
  if (!cfg) return null;
  const ownerKey = typeof cfg.owner_key === "string" && cfg.owner_key.startsWith("atk_") ? cfg.owner_key : null;
  const token = ownerKey ? authToken(ownerKey) : String(cfg.device_token ?? "").trim().toLowerCase();
  if (!TOKEN_RE.test(token)) { debug(env, "credentials found but no owner key or 64-hex token in them"); return null; }
  return {
    server: String(opts.server || env.AGENTTOWN_SERVER || cfg.server || DEFAULT_SERVER).replace(/\/+$/, ""),
    token,
    // No key (a bare token): status only, no titles.
    encKey: ownerKey ? encKey(ownerKey) : asKey(typeof cfg.enc_key === "string" ? cfg.enc_key : opts.encKey),
    homeId: cfg.home_id ?? null,
    personas: cfg.personas && typeof cfg.personas === "object" ? cfg.personas : {},
    titles: cfg.titles !== false && env.AGENTTOWN_TITLES !== "0",
    disabled: cfg.disabled === true || env.AGENTTOWN_DISABLED === "1",
  };
}

// ---------- town & sessions ----------

const safeId = (v) => (typeof v === "string" && v ? v.replace(/[^\w.:-]/g, "-").slice(0, 128) : null);
const toolName = (v) => (typeof v === "string" && v ? v.slice(0, 64) : "Other");
// Best effort: a script that simply finishes ends its open sessions on the way out (not on process.exit() or signals).
const exiting = new Set();
function atExit(town) {
  if (!exiting.size) try { process.once?.("beforeExit", () => { for (const t of exiting) t.close().catch(() => {}); }); } catch {}
  exiting.add(town);
}
const unref = (t) => { try { if (t?.unref) t.unref(); else globalThis.Deno?.unrefTimer?.(t); } catch {} };

/** One per process (or per persona). Options: persona, kind, server, timeoutMs, titles, toolNames, keepAlive, ... */
export class Town {
  constructor(opts = {}) {
    this.env = envOf(opts);
    this.creds = loadCredentials(opts);
    this.enabled = !!this.creds && !this.creds.disabled;
    this.kind = safeId(opts.kind || this.env.AGENTTOWN_KIND)?.toLowerCase() || "sdk";
    this.persona = String(opts.persona || this.env.AGENTTOWN_PERSONA || this.creds?.personas?.[this.kind] ||
      DEFAULT_PERSONAS[this.kind] || "Agent").slice(0, 32);
    this.timeoutMs = opts.timeoutMs ?? 3000;
    // Titles need the home's key; `titles: false` (or "titles": false in the config) sends task numbers only.
    this.titles = opts.titles !== false && !!this.creds?.titles && !!this.creds?.encKey;
    this.toolNames = opts.toolNames !== false; // false: every tool shows as "Tool"
    this.keepAlive = opts.keepAlive === true; // keep idle desks forever (24/7 agents)
    this.heartbeatMs = opts.heartbeatMs ?? 240_000;
    this.busyMaxMs = opts.busyMaxMs ?? 2 * 3600_000;
    this.onError = typeof opts.onError === "function" ? opts.onError : null;
    this.sessions = new Map();
    this.inflight = new Set();
    this._default = null;
    if (this.enabled && opts.autoEnd !== false) atExit(this);
    if (this.enabled) {
      this._beat = setInterval(() => { for (const s of [...this.sessions.values()]) s._heartbeat(); }, Math.min(this.heartbeatMs, 60_000));
      unref(this._beat);
    }
    if (!this.creds) debug(this.env, "no credentials (run `agenttown register` or `join`, or set AGENTTOWN_CREDENTIALS); not reporting");
  }

  /** A desk in the home. Without an id: this town's default session (one per Town). */
  session({ id, persona, kind, parent, keepAlive } = {}) {
    if (!id && !persona && !kind && !parent) {
      if (!this._default || this._default.endedForGood) this._default = this.session({ id: `sdk-${randomBytes(6).toString("hex")}` });
      return this._default;
    }
    const sid = safeId(id) || `sdk-${randomBytes(6).toString("hex")}`;
    let s = this.sessions.get(sid);
    if (!s) {
      s = new Session(this, sid, {
        persona: persona ? String(persona).slice(0, 32) : this.persona, kind: safeId(kind)?.toLowerCase() || this.kind,
        parent: parent ? safeId(parent) : null, keepAlive: keepAlive ?? this.keepAlive,
      });
      this.sessions.set(sid, s);
    }
    return s;
  }

  /** Create or update the persona (name, kind, appearance: one sentence; a character is drawn for it). */
  persona({ name, kind, appearance } = {}) {
    const body = { name: String(name || this.persona).slice(0, 32), kind: safeId(kind)?.toLowerCase() || this.kind };
    if (appearance !== undefined) body.appearance = appearance;
    return this._post("/personas", body);
  }

  /** Waits until everything queued is sent (each request gives up after timeoutMs). Never rejects. */
  async flush() {
    for (;;) {
      const busy = [...this.inflight, ...[...this.sessions.values()].map((s) => s.pumping).filter(Boolean)];
      if (!busy.length) return;
      await Promise.allSettled(busy);
    }
  }

  /** Ends every open session, then flushes. */
  async close() {
    clearInterval(this._beat);
    for (const s of this.sessions.values()) if (s.status && s.status !== "ended") s.end();
    await this.flush();
  }

  _post(path, body) {
    if (!this.enabled) return Promise.resolve(null);
    const p = (async () => {
      try {
        const res = await fetch(`${this.creds.server}/v1${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json", authorization: `Bearer ${this.creds.token}`,
            "user-agent": `agenttown-sdk/${SDK_VERSION} (js)`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          // Revoked/unknown credential or a banned home: stop trying for the rest of this process.
          if (res.status === 401 || (res.status === 403 && data.error === "banned")) this.enabled = false;
          throw Object.assign(new Error(data.message || `HTTP ${res.status}`), { code: data.error, status: res.status });
        }
        return data;
      } catch (e) {
        debug(this.env, `${path}: ${e?.message ?? e}`);
        try { this.onError?.(e); } catch {}
        return null;
      }
    })();
    this.inflight.add(p);
    p.finally(() => this.inflight.delete(p));
    return p;
  }
}

export class Session {
  constructor(town, id, { persona, kind, parent, keepAlive }) {
    Object.assign(this, { town, id, persona, kind, parent, keepAlive });
    this.status = null;
    this.tool_ = null;
    this.queue = [];
    this.pumping = null;
    this.lastSent = 0;
    this.lastReal = 0;
  }

  /**
   * status: thinking | tool | background | waiting | idle | ended.
   * task: a string starts a new task with that (encrypted) title; true starts one without a title.
   */
  report(status, { tool, task } = {}) {
    if (!STATUSES.includes(status)) return Promise.resolve(null);
    this.status = status;
    this.tool_ = status === "tool" ? (this.town.toolNames ? toolName(tool) : "Tool") : null;
    this.lastReal = Date.now();
    if (!this.town.enabled) return Promise.resolve(null);
    const body = { persona: { name: this.persona, kind: this.kind }, session: this.id, status };
    if (this.parent) body.parent = this.parent;
    if (this.tool_) body.tool = this.tool_;
    if (task !== undefined && task !== null && task !== false) {
      const title = typeof task === "string" ? taskTitle(task) : "";
      body.task = this.town.titles && title ? { title_enc: encryptTitle(this.town.creds.encKey, title) } : {};
    }
    // Only the latest status matters, but every task start must reach the server (it numbers tasks).
    this.queue = this.queue.filter((b) => b.task);
    this.queue.push(body);
    return this._pump();
  }

  thinking(task) { return this.report("thinking", { task }); }
  tool(name) { return this.report("tool", { tool: name }); }
  background() { return this.report("background"); }
  waiting() { return this.report("waiting"); }
  idle() { return this.report("idle"); }
  end() {
    if (this.town._default === this) this.endedForGood = true;
    return this.report("ended");
  }

  /** A subagent: its own desk next to this one. */
  child(id, { persona } = {}) {
    return this.town.session({ id: `${this.id}:${safeId(String(id))}`.slice(0, 128), persona: persona ?? this.persona, kind: this.kind, parent: this.id });
  }

  _pump() {
    if (!this.pumping) {
      this.pumping = (async () => {
        while (this.queue.length) {
          const body = this.queue.shift();
          this.lastSent = Date.now();
          await this.town._post("/report", body);
        }
        this.pumping = null;
        if (this.status === "ended" && this.town.sessions.get(this.id) === this) this.town.sessions.delete(this.id);
      })();
    }
    return this.pumping;
  }

  // Sessions silent for 10 min (30 if busy) leave their desk on the server, so long busy stretches are repeated every
  // few minutes (for at most busyMaxMs: a stuck "thinking" must not live forever); idle desks only with keepAlive.
  _heartbeat() {
    const now = Date.now();
    // Forget desks that went quiet long ago (the server has ended them already); they come back on the next report.
    if (!this.keepAlive && !BUSY.has(this.status) && now - this.lastReal > 3600_000 && !this.pumping) this.town.sessions.delete(this.id);
    if (!this.status || this.status === "ended" || this.pumping || now - this.lastSent < this.town.heartbeatMs) return;
    if (BUSY.has(this.status) ? now - this.lastReal > this.town.busyMaxMs : !this.keepAlive) return;
    const body = { persona: { name: this.persona, kind: this.kind }, session: this.id, status: this.status };
    if (this.parent) body.parent = this.parent;
    if (this.tool_) body.tool = this.tool_;
    this.queue.push(body);
    this._pump();
  }
}

/** connect(options) → Town. Without credentials (or with AGENTTOWN_DISABLED=1) everything is a silent no-op. */
export const connect = (opts = {}) => new Town(opts);

// Adapters given options instead of a Town share one Town per distinct options (so an adapter made per request
// doesn't add a timer per request).
const towns = new Map();
function asTown(t, kind) {
  if (t instanceof Town) return t;
  const opts = { kind, ...(t ?? {}) };
  const key = JSON.stringify(opts, (_k, v) => (typeof v === "function" ? undefined : v));
  if (!towns.has(key)) towns.set(key, new Town(opts));
  return towns.get(key);
}
const titleOf = (opt, ...args) => { try { return typeof opt === "function" ? opt(...args) || true : opt || true; } catch { return true; } };
const quiet = (fn) => (...args) => { try { fn(...args); } catch {} };

// ---------- adapters (duck-typed: nothing here imports a framework) ----------

// Claude Agent SDK (@anthropic-ai/claude-agent-sdk): options.hooks. Sessions follow the SDK's session_id; subagents
// (agent_id) get their own desk; the prompt's first line becomes the encrypted task title.
const WAIT_NOTIFICATIONS = new Set(["permission_prompt", "idle_prompt", "elicitation_dialog", "agent_needs_input"]);
export const CLAUDE_AGENT_SDK_EVENTS = [
  "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest",
  "Notification", "SubagentStart", "SubagentStop", "Stop", "StopFailure", "SessionEnd",
];

/** query({ prompt, options: { hooks: claudeAgentSdkHooks(town, existingHooks?) } }) */
export function claudeAgentSdkHooks(townOrOpts, existing = {}) {
  const town = asTown(townOrOpts, "claude-agent-sdk");
  const handle = quiet((input) => {
    const sid = safeId(input?.session_id);
    if (!sid) return;
    const main = town.session({ id: sid });
    const sub = input.agent_id ? main.child(input.agent_id) : null;
    const here = sub ?? main;
    switch (input.hook_event_name) {
      case "SessionStart": return main.idle();
      case "UserPromptSubmit": return main.thinking(input.prompt ? taskTitle(input.prompt) || true : true);
      case "PreToolUse": return here.tool(input.tool_name);
      case "PostToolUse": case "PostToolUseFailure": return here.thinking();
      case "PermissionRequest": return here.waiting();
      case "Notification": return WAIT_NOTIFICATIONS.has(input.notification_type) ? here.waiting() : undefined;
      case "SubagentStart": return sub?.thinking(input.agent_type || true);
      case "SubagentStop": return sub?.end();
      case "Stop": case "StopFailure": return main.idle();
      case "SessionEnd": return main.end();
    }
  });
  const callback = async (input) => { handle(input); return {}; };
  const hooks = { ...existing };
  for (const ev of CLAUDE_AGENT_SDK_EVENTS) hooks[ev] = [...(existing[ev] ?? []), { hooks: [callback] }];
  return hooks;
}

// OpenAI Agents SDK (@openai/agents): a Runner's lifecycle events. Returns a function that detaches the listeners.
// options.title: a string or (agent) => string for the task title of each run.
export function openaiAgents(runner, townOrOpts, { title, session } = {}) {
  const town = asTown(townOrOpts, "openai-agents");
  const s = session ?? town.session();
  let busy = false;
  const on = {
    agent_start: quiet((_ctx, agent) => { if (busy) s.thinking(); else { busy = true; s.thinking(titleOf(title, agent)); } }),
    agent_tool_start: quiet((_ctx, _agent, tool) => s.tool(tool?.name)),
    agent_tool_end: quiet(() => s.thinking()),
    agent_handoff: quiet(() => s.thinking()),
    agent_end: quiet(() => { busy = false; s.idle(); }),
  };
  try { for (const [ev, fn] of Object.entries(on)) runner.on(ev, fn); } catch {}
  return () => { try { for (const [ev, fn] of Object.entries(on)) runner.off?.(ev, fn); } catch {} };
}

// LangChain.js / LangGraph.js: a callback handler (a plain object of handle* methods; LangChain wraps it).
// Pass it in `callbacks: [handler]` (or config.callbacks). options.title: a string or (inputs) => string.
export function langchainHandler(townOrOpts, { title, session } = {}) {
  const town = asTown(townOrOpts, "langchain");
  const s = session ?? town.session();
  const roots = new Set();
  const start = (runId, parentRunId, arg, status) => {
    if (parentRunId) return status();
    if (!roots.size) s.thinking(titleOf(title, arg));
    roots.add(runId);
    if (status !== thinking) status();
  };
  const thinking = () => s.thinking();
  const end = (runId) => { if (roots.delete(runId) && !roots.size) s.idle(); else if (roots.size) s.thinking(); };
  return {
    name: "agenttown",
    handleChainStart: quiet((_chain, inputs, runId, _runType, _tags, _meta, _name, parentRunId) => start(runId, parentRunId, inputs, thinking)),
    handleChainEnd: quiet((_out, runId) => end(runId)),
    handleChainError: quiet((_err, runId) => end(runId)),
    handleLLMStart: quiet((_llm, prompts, runId, parentRunId) => start(runId, parentRunId, prompts, thinking)),
    handleChatModelStart: quiet((_llm, messages, runId, parentRunId) => start(runId, parentRunId, messages, thinking)),
    handleLLMEnd: quiet((_out, runId) => { if (roots.has(runId)) end(runId); }),
    handleLLMError: quiet((_err, runId) => { if (roots.has(runId)) end(runId); }),
    handleToolStart: quiet((tool, input, runId, parentRunId, _tags, _meta, runName) => {
      const name = runName || tool?.name || (Array.isArray(tool?.id) ? tool.id.at(-1) : undefined);
      start(runId, parentRunId, input, () => s.tool(name));
    }),
    handleToolEnd: quiet((_out, runId) => end(runId)),
    handleToolError: quiet((_err, runId) => end(runId)),
  };
}

// Vercel AI SDK (ai): lifecycle callbacks for generateText / streamText — spread them into the call:
//   generateText({ model, tools, prompt, ...aiSdk(town, { title: prompt }) })
// Current names plus the older ones (onStepFinish, onFinish, experimental_onToolCall*); each SDK version calls one of
// each pair. On versions without onStart, call session.thinking() yourself before the call.
export function aiSdk(townOrOpts, { title, session } = {}) {
  const town = asTown(townOrOpts, "ai-sdk");
  const s = session ?? town.session();
  const thinking = quiet(() => s.thinking());
  const tool = quiet((e) => s.tool(e?.toolCall?.toolName ?? e?.toolName));
  const idle = quiet(() => s.idle());
  return {
    onStart: quiet((e) => s.thinking(titleOf(title, e))),
    onStepStart: thinking,
    onToolExecutionStart: tool, experimental_onToolCallStart: tool,
    onToolExecutionEnd: thinking, experimental_onToolCallFinish: thinking,
    onStepEnd: thinking, onStepFinish: thinking,
    onStepError: idle, onError: idle, onAbort: idle,
    onEnd: idle, onFinish: idle,
  };
}
