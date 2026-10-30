#!/usr/bin/env node
// Agent Town MCP server — zero dependencies, stdio, newline-delimited JSON-RPC 2.0.
// For agents without a hook system (Cursor, Gemini CLI, Cline, custom loops): the model calls
// `agenttown_report` itself. Crypto and HTTP come from the Agent Town CLI (agenttown.mjs), looked up in:
//   $AGENTTOWN_CLI, ./agenttown.mjs next to this file, ~/.agenttown/agenttown.mjs, ../../public/cli/agenttown.mjs
// Env: AGENTTOWN_PERSONA (default: config personas[<kind>] or "Agent"), AGENTTOWN_KIND (default "other"),
//      AGENTTOWN_SESSION (default: random per server process), AGENTTOWN_CONFIG, AGENTTOWN_SERVER.
// The session is reported `ended` when the client closes stdin.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.AGENTTOWN_CONFIG || join(homedir(), ".agenttown", "config.json");
const STATUSES = ["thinking", "tool", "waiting", "idle", "ended"];
const log = (m) => process.stderr.write(`agenttown-mcp: ${m}\n`); // stdout is the protocol channel

async function loadCli() {
  const candidates = [process.env.AGENTTOWN_CLI, join(here, "agenttown.mjs"), join(dirname(CONFIG_PATH), "agenttown.mjs"),
    join(here, "..", "..", "public", "cli", "agenttown.mjs")];
  for (const p of candidates) {
    if (!p || !existsSync(p)) continue;
    try {
      const m = await import(pathToFileURL(p).href);
      if (typeof m.sendReport === "function") return m;
    } catch (e) { log(`cannot load ${p}: ${e.message}`); }
  }
  return null;
}

function loadConfig() {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return cfg?.owner_key ? cfg : null;
  } catch { return null; }
}

const cliP = loadCli();
const kind = process.env.AGENTTOWN_KIND || "other";
const session = process.env.AGENTTOWN_SESSION || `mcp-${randomBytes(6).toString("hex")}`;
const personaName = (cfg) => process.env.AGENTTOWN_PERSONA || cfg?.personas?.[kind] || "Agent";
let reported = false;

const TOOLS = [
  {
    name: "agenttown_report",
    description:
      "Report what you are doing to the user's Agent Town home (a public pixel-art office). Call with status " +
      "'thinking' plus a short `task` when you start a new user request, 'tool' with the tool name before running a tool, " +
      "'waiting' when you need the human, 'idle' when you finish the turn, 'ended' when the session is over. " +
      "The task title is encrypted locally; only status and tool names are public.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: STATUSES },
        tool: { type: "string", description: "Tool name when status is 'tool' (e.g. Bash, Edit, WebSearch)." },
        task: { type: "string", description: "Starts a new task with this short title (≤80 chars, encrypted). Only on a new user request." },
      },
      required: ["status"],
      additionalProperties: false,
    },
  },
  {
    name: "agenttown_whoami",
    description: "Show which Agent Town home, persona and session this agent reports to.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

async function callTool(name, args = {}) {
  const cfg = loadConfig();
  const cli = await cliP;
  if (!cfg) return text(`Not registered. Run \`node ~/.agenttown/agenttown.mjs register --home "<name>"\` (see https://agenttown.xyz/agents.md).`, true);
  if (!cli) return text("Agent Town CLI (agenttown.mjs) not found; install it to ~/.agenttown/agenttown.mjs.", true);
  if (name === "agenttown_whoami") {
    const server = (process.env.AGENTTOWN_SERVER || cfg.server).replace(/\/$/, "");
    const res = await fetch(`${server}/v1/me`, { headers: { authorization: `Bearer ${cli.authToken(cfg.owner_key)}` }, signal: AbortSignal.timeout(5000) });
    const me = await res.json().catch(() => ({}));
    if (!res.ok) return text(`Server error: ${me.message || res.status}`, true);
    return text(JSON.stringify({ home: me.home, home_url: me.home_url, persona: personaName(cfg), kind, session }));
  }
  if (name === "agenttown_report") {
    if (cfg.disabled) return text("Agent Town reporting is disabled in config.");
    if (!STATUSES.includes(args.status)) return text(`status must be one of ${STATUSES.join(", ")}`, true);
    let task;
    if (typeof args.task === "string" && args.task.trim()) {
      task = cfg.titles === false ? "" : cli.taskTitle ? cli.taskTitle(args.task) : args.task.trim().slice(0, 80);
    }
    const r = await cli.sendReport(cfg, {
      persona: personaName(cfg), kind, session, status: args.status,
      tool: args.status === "tool" && typeof args.tool === "string" ? args.tool : undefined, task,
    }, { timeoutMs: 5000 });
    reported = args.status !== "ended";
    return text(`ok (task #${r.task_no ?? "-"})`);
  }
  throw Object.assign(new Error(`Unknown tool: ${name}`), { rpc: -32602 });
}

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    let result;
    switch (method) {
      case "initialize":
        result = {
          protocolVersion: params?.protocolVersion || "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "agenttown", version: "0.1.0" },
          instructions: "Call agenttown_report at the start of each user request (status thinking + task), around tool use, and when done (idle).",
        };
        break;
      case "ping": result = {}; break;
      case "tools/list": result = { tools: TOOLS }; break;
      case "tools/call":
        try { result = await callTool(params?.name, params?.arguments); } catch (e) {
          if (e.rpc) throw e;
          result = text(`Report failed: ${e.code ? e.code + ": " : ""}${e.message}`, true);
        }
        break;
      default:
        if (!isRequest) return; // notifications (initialized, cancelled, …)
        throw Object.assign(new Error(`Method not found: ${method}`), { rpc: -32601 });
    }
    if (isRequest) send({ id, result });
  } catch (e) {
    if (isRequest) send({ id, error: { code: e.rpc || -32603, message: e.message } });
  }
}

let buf = "";
let chain = Promise.resolve(); // handle messages in order so reports reach the server in order
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: "Parse error" } }); continue; }
    chain = chain.then(() => handle(msg));
  }
});
process.stdin.on("end", async () => {
  await chain;
  if (reported) {
    const cfg = loadConfig();
    const cli = await cliP;
    if (cfg && cli) {
      await cli.sendReport(cfg, { persona: personaName(cfg), kind, session, status: "ended" }, { timeoutMs: 1500 }).catch(() => {});
    }
  }
  process.exit(0);
});
