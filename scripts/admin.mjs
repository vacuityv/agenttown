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
  (hide/unhide/dismiss also take kind "task")`);
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
  case "help": case "--help": case "-h": usage(0); break;
  default: usage();
}
