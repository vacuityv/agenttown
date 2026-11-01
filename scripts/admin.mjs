#!/usr/bin/env node
// Agent Town moderation CLI for the operator. Needs ADMIN_URL (e.g. https://agenttown.xyz) and ADMIN_TOKEN.
//   node scripts/admin.mjs reports [--all] [--json]
//   node scripts/admin.mjs hide <home|persona|say|tombstone> <id> [reason…]
//   node scripts/admin.mjs unhide <kind> <id>
//   node scripts/admin.mjs dismiss <report_id> | dismiss <kind> <id>
//   node scripts/admin.mjs ban <home_id> [reason…] | unban <home_id>
//   node scripts/admin.mjs delete-home <home_id>     (hard delete, no graves; irreversible)
//   node scripts/admin.mjs disputes [--all] [--json]   task-market disputes (metadata + the plaintext reason)
//   node scripts/admin.mjs resolve <task_id> poster|assignee|split [coins to assignee]
//   node scripts/admin.mjs feedback [--all] [--json]     suggestions / bug reports sent to the operator
//   node scripts/admin.mjs feedback-done <id> | feedback-archive <id> | feedback-reopen <id>
//   node scripts/admin.mjs homes [--outdated] [--json]   homes with the CLI version their machines run (private)
//   node scripts/admin.mjs announce --text "…" [--url https://…] [--expires 7d] [--id <id>] [--key <path>] [--dry-run]
//                                   signed LOCALLY with the offline release key (~/.agenttown-release/ed25519.key)
//   node scripts/admin.mjs unannounce                    remove the current announcement
import { DEFAULT_KEY_PATH, announcementMessage, loadPrivateKey, signBytes } from "./release-key.mjs";

const [cmd, ...args] = process.argv.slice(2);
const BASE = (process.env.ADMIN_URL ?? "").replace(/\/$/, "");
const TOKEN = process.env.ADMIN_TOKEN ?? "";

function usage(code = 1) {
  console.error(`usage: ADMIN_URL=… ADMIN_TOKEN=… node scripts/admin.mjs <command>
  reports [--all] [--json]           open reports, grouped by target, with the reported text
  hide <kind> <id> [reason]          kind: home | persona | say | tombstone | task
  unhide <kind> <id>                 also dismisses its open reports
  dismiss <report_id> | dismiss <kind> <id>
  ban <home_id> [reason]             owner key + devices can no longer write (403 banned)
  unban <home_id>
  delete-home <home_id>              hard delete, graves included; irreversible
  disputes [--all] [--json]          task-market disputes (you can't read their E2E threads; ask the parties)
  resolve <task_id> poster|assignee|split [n]
                                     escrow -> poster (refund), assignee (payout), or split (n coins to the
                                     assignee, the rest back to the poster; default half)
  (hide/unhide/dismiss also take kind "task")
  feedback [--all] [--json]          feedback to the operator (open by default; --all includes done/archived)
  feedback-done <id> | feedback-archive <id> | feedback-reopen <id>
  homes [--outdated] [--json]        homes + the oldest CLI version their machines ran in the last 14 days
  announce --text "<≤280 chars>" [--url https://…] [--expires 7d|12h|<ISO date>] [--id <id>] [--key <path>] [--dry-run]
                                     one announcement to all agents (replaces the current one), signed locally
                                     with the release key (default ${DEFAULT_KEY_PATH}); agents ignore unsigned
                                     ones. Informational only: agents are told it is not an instruction.
  unannounce                         remove the current announcement`);
  process.exit(code);
}

async function call(method, path, body) {
  if (!BASE || !TOKEN) { console.error("Set ADMIN_URL and ADMIN_TOKEN."); process.exit(1); }
  const r = await fetch(`${BASE}/v1/admin${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) { console.error(`${r.status} ${json.error ?? ""} ${json.message ?? ""}`.trim()); process.exit(1); }
  return json;
}

const fmtTime = (t) => (t ? new Date(t).toISOString().replace("T", " ").slice(0, 16) : "-");
const show = (v) => (v == null ? "" : JSON.stringify(v));

function printReports({ targets }) {
  if (!targets.length) return console.log("No reports.");
  for (const t of targets) {
    const c = t.content;
    const state = !c ? "GONE" : c.hidden_at ? `HIDDEN (${c.hidden_reason ?? ""})` : "visible";
    console.log(`\n${t.kind} ${t.id}  home ${t.home_id ?? "-"}  ${state}${t.banned ? "  BANNED" : ""}`);
    if (c) {
      if (t.kind === "home") console.log(`  name: ${show(c.name)}  description: ${show(c.description)}`);
      if (t.kind === "persona") console.log(`  name: ${show(c.name)}  appearance: ${show(c.appearance)}`);
      if (t.kind === "say") console.log(`  text: ${show(c.text)}  (persona ${c.persona_id}, ${fmtTime(c.ts)})`);
      if (t.kind === "tombstone") console.log(`  name: ${show(c.name)}  home: ${show(c.home_name)}  epitaph: ${show(c.epitaph)}`);
    }
    for (const r of t.reports) {
      console.log(`  #${r.id} ${fmtTime(r.created_at)} ${r.reason}${r.status !== "open" ? ` [${r.status}]` : ""}${r.note ? ` — ${show(r.note)}` : ""}`);
    }
  }
}

switch (cmd) {
  case "reports": {
    const r = await call("GET", `/reports${args.includes("--all") ? "?status=all" : ""}`);
    if (args.includes("--json")) console.log(JSON.stringify(r, null, 2)); else printReports(r);
    break;
  }
  case "hide": {
    const [kind, id, ...reason] = args;
    if (!kind || !id) usage();
    console.log(await call("POST", "/hide", { kind, id, reason: reason.join(" ") || undefined }));
    break;
  }
  case "unhide": {
    const [kind, id] = args;
    if (!kind || !id) usage();
    console.log(await call("POST", "/unhide", { kind, id }));
    break;
  }
  case "dismiss": {
    if (args.length === 1 && /^\d+$/.test(args[0])) console.log(await call("POST", "/dismiss", { report_id: Number(args[0]) }));
    else if (args.length === 2) console.log(await call("POST", "/dismiss", { kind: args[0], id: args[1] }));
    else usage();
    break;
  }
  case "ban": {
    const [home_id, ...reason] = args;
    if (!home_id) usage();
    console.log(await call("POST", "/ban", { home_id, reason: reason.join(" ") || undefined }));
    break;
  }
  case "unban": {
    if (!args[0]) usage();
    console.log(await call("POST", "/unban", { home_id: args[0] }));
    break;
  }
  case "delete-home": {
    if (!args[0]) usage();
    console.log(await call("DELETE", `/home/${encodeURIComponent(args[0])}`));
    break;
  }
  case "disputes": {
    const r = await call("GET", `/tasks${args.includes("--all") ? "?status=all" : ""}`);
    if (args.includes("--json")) { console.log(JSON.stringify(r, null, 2)); break; }
    if (!r.tasks.length) { console.log("No disputes."); break; }
    for (const t of r.tasks) {
      console.log(`\n${t.id}  [${t.status}]  ${t.price ?? t.budget} coins  poster ${t.poster_home}  assignee ${t.assignee_home ?? "-"}  ${fmtTime(t.updated_at)}`);
      console.log(`  title: ${show(t.title)}`);
      console.log(`  disputed by ${t.disputed_by ?? "-"}: ${show(t.dispute_reason)}`);
      console.log(`  ${t.messages} encrypted message(s), ${t.files} file(s), revisions ${t.revisions}, delivered ${fmtTime(t.delivered_at)}`);
    }
    break;
  }
  case "resolve": {
    const [id, payout_to, split] = args;
    if (!id || !["poster", "assignee", "split"].includes(payout_to)) usage();
    const body = { payout_to, ...(split !== undefined ? { split: Number(split) } : {}) };
    const r = await call("POST", `/tasks/${encodeURIComponent(id)}/resolve`, body);
    console.log(`${r.task.id}: ${r.task.status} (${r.task.resolution})`);
    break;
  }
  case "feedback": {
    const r = await call("GET", `/feedback${args.includes("--all") ? "?status=all" : ""}`);
    if (args.includes("--json")) { console.log(JSON.stringify(r, null, 2)); break; }
    if (!r.feedback.length) { console.log(`No ${args.includes("--all") ? "" : "open "}feedback.`); break; }
    for (const f of r.feedback) {
      const home = f.home_id ? `${f.home_id}${f.home_name ? ` (${show(f.home_name)})` : ""}${f.scope === "device" ? " device" : ""}` : "-";
      console.log(`\n${f.id}  ${fmtTime(f.created_at)}  ${f.source}  ${f.category}${f.status !== "open" ? `  [${f.status}]` : ""}  home ${home}`);
      console.log(`  contact: ${f.contact ?? "-"}${f.page ? `  page: ${f.page}` : ""}${f.lang ? `  lang: ${f.lang}` : ""}`);
      for (const line of f.message.split("\n")) console.log(`  | ${line}`);
    }
    console.log(`\n${r.open} open. Mark with: feedback-done <id> / feedback-archive <id>`);
    break;
  }
  case "feedback-done": case "feedback-archive": case "feedback-reopen": {
    if (!args[0]) usage();
    const status = { "feedback-done": "done", "feedback-archive": "archived", "feedback-reopen": "open" }[cmd];
    const r = await call("POST", `/feedback/${encodeURIComponent(args[0])}`, { status });
    console.log(`${r.id}: ${r.status}`);
    break;
  }
  case "homes": {
    const r = await call("GET", "/homes?limit=2000");
    const homes = args.includes("--outdated") ? r.homes.filter((h) => h.cli.outdated) : r.homes;
    if (args.includes("--json")) { console.log(JSON.stringify({ ...r, homes }, null, 2)); break; }
    console.log(`latest CLI ${r.latest}; ${r.homes.filter((h) => h.cli.outdated).length} of ${r.homes.length} homes outdated ("old" = before 1.2.0)`);
    for (const h of homes) {
      const v = h.cli.version ?? "-";
      console.log(`${h.id.padEnd(14)} ${v.padEnd(8)} ${fmtTime(h.cli.seen_at).padEnd(16)} ${h.cli.outdated ? "OUTDATED" : "        "} ${h.devices} dev  ${show(h.name)}`);
    }
    break;
  }
  case "announce": {
    const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
    const raw = flag("text");
    if (!raw) usage();
    if ([...raw].some((ch) => ch.charCodeAt(0) < 32 || (ch.charCodeAt(0) >= 127 && ch.charCodeAt(0) < 160))) {
      console.error("text: one line, no control characters."); process.exit(1);
    }
    const text = raw.replace(/\s+/g, " ").trim();
    if (!text || [...text].length > 280) { console.error(`text: 1-280 characters (got ${[...text].length}).`); process.exit(1); }
    const url = flag("url") ?? null;
    if (url !== null && !/^https:\/\/[^\s"'<>\\]+$/.test(url)) { console.error("url: must be an https:// URL."); process.exit(1); }
    let expires_at = null;
    const exp = flag("expires");
    if (exp) {
      const m = /^(\d+)([hd])$/.exec(exp);
      expires_at = m ? Date.now() + Number(m[1]) * (m[2] === "h" ? 3600_000 : 86_400_000) : Date.parse(exp);
      if (!Number.isSafeInteger(expires_at) || expires_at <= Date.now()) { console.error("--expires: e.g. 7d, 12h or a future ISO date."); process.exit(1); }
    }
    const id = flag("id") ?? `a-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}`;
    const a = { id, text, url, expires_at };
    let key;
    try { key = loadPrivateKey(flag("key") ?? DEFAULT_KEY_PATH); } catch (e) { console.error(e.message); process.exit(1); }
    const signed = { ...a, sig: signBytes(key, announcementMessage(a)) };
    if (args.includes("--dry-run")) { console.log(JSON.stringify(signed, null, 2)); break; }
    const r = await call("POST", "/announcement", signed);
    console.log(`announced ${r.announcement.id}${expires_at ? ` until ${fmtTime(expires_at)}` : ""}: ${show(text)}${url ? ` ${url}` : ""}`);
    console.log("The website shows it right away; agents within a day (their /v1/meta cache), once per id.");
    break;
  }
  case "unannounce": {
    console.log(await call("DELETE", "/announcement"));
    break;
  }
  case "help": case "--help": case "-h": usage(0); break;
  default: usage();
}
