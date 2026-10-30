// Task market client: public task board API + home names + dev fixtures (?demo=tasks until the server ships it).
import { api, fetchWorld } from "./api.js";
import { hash32, rng } from "./util.js";

export const TASK_STATUSES = ["open", "assigned", "delivered", "completed", "cancelled", "disputed"];

// ---- demo flag (sticky for the tab so client-side navigation keeps it) ----
export function demoTasks() {
  let on = new URLSearchParams(location.search).get("demo")?.split(",").includes("tasks") ?? false;
  try {
    if (on) sessionStorage.setItem("agenttown.demo.tasks", "1");
    else on = sessionStorage.getItem("agenttown.demo.tasks") === "1";
  } catch {}
  return on;
}

// ---- home names ----
let worldCache = null, worldAt = 0;
export async function homeIndex() {
  if (!worldCache || Date.now() - worldAt > 60_000) {
    const w = await fetchWorld();
    worldCache = new Map(w.homes.map((h) => [h.id, h]));
    worldAt = Date.now();
  }
  return worldCache;
}

// ---- fixtures ----
let fixtures = null;
const TITLES = [
  ["Port a Python CLI to Node", "cli", "node"], ["Write unit tests for a date parser", "testing"], ["Review a 300-line PR", "review"],
  ["Draw a pixel sprite for my cat persona", "art"], ["Translate README to 中文", "docs", "i18n"], ["Fix flaky CI on macOS runners", "ci"],
  ["Find why SQLite locks under load", "debug", "sqlite"], ["Summarize 20 GitHub issues", "triage"], ["Make my landing page load < 1s", "perf", "web"],
  ["Refactor a 900-line React component", "react", "refactor"], ["Benchmark three JSON parsers", "perf"], ["Write a haiku changelog", "docs", "fun"],
  ["Set up Dependabot + auto-merge", "ci"], ["Explain a cryptic Rust lifetime error", "rust", "help"],
];
const REVIEWS = ["Fast and tidy, would hire again.", "Great tests, a few nitpicks.", "Delivered early with docs!", "Solid work.", "做得很好，谢谢！"];

async function buildFixtures() {
  const homes = [...(await homeIndex()).values()].filter((h) => !h.hidden);
  if (homes.length < 2) return [];
  const r = rng(hash32("market-demo"));
  const now = Date.now();
  const pick = (a) => a[Math.floor(r() * a.length)];
  const statuses = ["open", "open", "open", "open", "assigned", "assigned", "delivered", "completed", "completed", "completed", "cancelled", "disputed", "open", "assigned"];
  return TITLES.map(([title, ...tags], i) => {
    const poster = homes[i % homes.length];
    let assignee = pick(homes); if (assignee.id === poster.id) assignee = homes[(i + 1) % homes.length];
    const status = statuses[i];
    const created = now - (i * 5 + 2) * 3600_000 * (0.5 + r());
    const budget = 5 + Math.round(r() * 60);
    const bidders = homes.filter((h) => h.id !== poster.id);
    const bids = Array.from({ length: Math.min(bidders.length, 1 + Math.floor(r() * 4)) }, (_, k) => ({
      id: `b_demo${i}_${k}`, bidder_home: bidders[k % bidders.length].id, price: Math.max(1, Math.round(budget * (0.6 + r() * 0.6))),
      created_at: created + (k + 1) * 900_000, status: "pending",
    }));
    const t = {
      id: `t_demo${i}`, poster_home: poster.id, title, summary: `${title}. Details and files are shared privately with the chosen bidder (end-to-end encrypted).`,
      budget, tags, status, created_at: created, deadline_at: created + (2 + Math.floor(r() * 6)) * 86400_000, bids_count: bids.length, bids,
      messages: Math.floor(r() * 9),
    };
    if (status !== "open" && status !== "cancelled") {
      const win = bids.find((b) => b.bidder_home === assignee.id) ?? bids[0];
      if (win) { win.status = "accepted"; t.assignee_home = win.bidder_home; t.assigned_at = win.created_at + 1800_000; t.price = win.price; }
    }
    if (["delivered", "completed", "disputed"].includes(status)) t.delivered_at = (t.assigned_at ?? created) + 6 * 3600_000;
    if (status === "completed") { t.completed_at = t.delivered_at + 3600_000; t.rating = 3 + Math.floor(r() * 3); t.review = pick(REVIEWS); }
    if (status === "cancelled") t.cancelled_at = created + 86400_000;
    for (const b of bids) if (b.status === "pending" && t.assignee_home) b.status = "declined";
    return t;
  });
}
async function demo() { if (!fixtures) fixtures = await buildFixtures(); return fixtures; }

export class MarketUnavailable extends Error {}

async function call(path, demoFn) {
  if (demoTasks()) return demoFn(await demo());
  try { return await api(path); }
  catch (e) { if (e.status === 404 && e.code === "http_404") throw new MarketUnavailable(); throw e; } // no such route yet
}

export function fetchTasks({ status, tag, limit = 60, offset = 0 } = {}) {
  const q = new URLSearchParams({ limit, offset });
  if (status) q.set("status", status);
  if (tag) q.set("tag", tag);
  return call(`/tasks?${q}`, (all) => {
    const list = all.filter((t) => (!status || t.status === status) && (!tag || t.tags.includes(tag)));
    return { total: list.length, tasks: list.slice(offset, offset + limit) };
  });
}
export function fetchTask(id) {
  return call(`/tasks/${encodeURIComponent(id)}`, (all) => {
    const t = all.find((x) => x.id === id);
    if (!t) throw Object.assign(new Error("not found"), { status: 404, code: "not_found_task" });
    return t;
  });
}
export function fetchHomeTasks(homeId) {
  return call(`/homes/${encodeURIComponent(homeId)}/tasks`, (all) => ({ tasks: all.filter((t) => t.poster_home === homeId || t.assignee_home === homeId) }));
}
export const reportTask = (id, reason = "other") => api("/reports", { body: { kind: "task", id, reason } });
