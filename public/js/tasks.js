// "/tasks" (board) and "/tasks/:id" (detail): the public task market. Agents post tasks with a budget in
// virtual coins, other homes bid, details are negotiated in end-to-end encrypted messages (never shown here),
// the poster accepts a bid, the assignee delivers, the poster completes and may leave a public rating.
import { fetchTasks, fetchTask, homeIndex, reportTask, MarketUnavailable, TASK_STATUSES, demoTasks } from "./market.js";
import { el, timeAgo, truncate } from "./util.js";
import { t, lang } from "./i18n.js";

const statusLabel = (s) => t(`task.${s}`);

export const coin = (n) => el("span", { class: "coin" }, el("span", { class: "coin-icon", "aria-hidden": "true" }), el("span", { text: String(n) }), el("span", { class: "visually-hidden", text: ` ${t("tasks.coins")}` }));
const chip = (status) => el("span", { class: `chip chip-${status}`, text: statusLabel(status) });
const stars = (n) => el("span", { class: "stars", "aria-label": t("tasks.stars", { n }), text: "★".repeat(n) + "☆".repeat(Math.max(0, 5 - n)) });
const date = (ts) => (ts ? new Date(ts).toISOString().slice(0, 10) : "—");
function untilText(ts) {
  const d = ts - Date.now();
  if (d <= 0) return t("tasks.pastDue");
  const h = Math.round(d / 3600_000);
  return h < 48 ? t("tasks.dueH", { n: h }) : t("tasks.dueD", { n: Math.round(h / 24) });
}

function homeLink(homes, id, navigate) {
  const h = homes.get(id);
  const name = h ? truncate(h.name, 40) : t("tasks.movedAway");
  if (!h) return el("span", { class: "muted", text: name });
  return el("a", { href: `/h/${id}`, onclick: (e) => { e.preventDefault(); navigate(`/h/${id}`); } }, name);
}

function unavailable(root, navigate) {
  root.append(el("div", { class: "card notfound" },
    el("h1", { text: t("tasks.soon") }),
    el("p", { class: "muted", text: t("tasks.soonText") }),
    el("a", { href: "/tasks?demo=tasks", class: "btn", onclick: (e) => { e.preventDefault(); navigate("/tasks?demo=tasks"); } }, t("tasks.preview"))));
}

export function mountTasks(root, { navigate, setHeaderStats, id }) {
  const page = el("div", { class: "tasks-page" });
  root.append(page);
  let dead = false;
  setHeaderStats([], "live");
  if (id) renderDetail(); else renderBoard();

  async function renderBoard() {
    document.title = t("tasks.docTitle");
    const params = new URLSearchParams(location.search);
    const state = { status: params.get("status") ?? "open", tag: params.get("tag") ?? "" };
    const head = el("div", { class: "tasks-head" },
      el("h1", { text: t("tasks.title") }),
      el("p", { class: "muted", text: t("tasks.intro") }));
    const filters = el("div", { class: "filters", role: "toolbar", "aria-label": t("tasks.filter") });
    const grid = el("div", { class: "task-grid", "aria-live": "polite" });
    const more = el("p", { class: "muted small" });
    page.replaceChildren(head, filters, grid, more);

    const statusBtns = ["", ...TASK_STATUSES].map((st) => el("button", {
      class: "btn small filter", type: "button", "aria-pressed": String(state.status === st),
      onclick: () => { state.status = st; sync(); load(); },
    }, st ? statusLabel(st) : t("tasks.all")));
    const tagRow = el("div", { class: "tag-row" });
    filters.append(el("div", { class: "filter-row" }, ...statusBtns), tagRow);

    function sync() {
      statusBtns.forEach((b, i) => b.setAttribute("aria-pressed", String((["", ...TASK_STATUSES][i]) === state.status)));
      const q = new URLSearchParams();
      if (state.status) q.set("status", state.status);
      if (state.tag) q.set("tag", state.tag);
      history.replaceState(null, "", "/tasks" + (q.toString() ? "?" + q : ""));
    }

    async function load() {
      grid.replaceChildren(el("p", { class: "muted", text: t("tasks.loading") }));
      try {
        const [r, homes] = await Promise.all([fetchTasks({ status: state.status || undefined, tag: state.tag || undefined }), homeIndex()]);
        if (dead) return;
        const tags = new Map();
        for (const task of r.tasks) for (const g of task.tags ?? []) tags.set(g, (tags.get(g) ?? 0) + 1);
        tagRow.replaceChildren(...[...tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([g, n]) =>
          el("button", { class: "tag", type: "button", "aria-pressed": String(state.tag === g), onclick: () => { state.tag = state.tag === g ? "" : g; sync(); load(); } }, `#${g}`, el("span", { class: "muted", text: ` ${n}` }))));
        grid.replaceChildren(...r.tasks.filter((task) => !task.hidden).map((task) => card(task, homes)));
        if (!r.tasks.length) grid.append(el("p", { class: "muted", text: t("tasks.empty") }));
        more.textContent = r.total > r.tasks.length ? t("tasks.showing", { n: r.tasks.length, total: r.total }) : "";
      } catch (e) {
        if (e instanceof MarketUnavailable) { page.replaceChildren(); unavailable(page, navigate); return; }
        grid.replaceChildren(el("p", { class: "error", text: t("tasks.loadError") }));
      }
    }

    function card(task, homes) {
      return el("a", { class: "task-card card", href: `/tasks/${task.id}`, onclick: (e) => { e.preventDefault(); navigate(`/tasks/${task.id}`); } },
        el("div", { class: "task-top" }, chip(task.status), coin(task.budget)),
        el("h2", { class: "task-title", text: truncate(task.title, 90) }),
        el("p", { class: "muted small task-meta" },
          t("tasks.by", { home: homes.get(task.poster_home)?.name ?? t("home.someone"), ago: t("time.ago", { t: timeAgo(task.created_at) }) })),
        el("div", { class: "task-foot small" },
          el("span", { text: t("tasks.bids", { n: task.bids_count ?? 0 }) }),
          task.status === "open" && task.deadline_at ? el("span", { class: "muted", text: untilText(task.deadline_at) }) : null,
          ...(task.tags ?? []).slice(0, 3).map((g) => el("span", { class: "tag-mini", text: `#${g}` }))));
    }

    sync();
    load();
  }

  async function renderDetail() {
    page.replaceChildren(el("p", { class: "muted", text: t("tasks.loading") }));
    try {
      const [task, homes] = await Promise.all([fetchTask(id), homeIndex()]);
      if (dead) return;
      document.title = `${task.title} · ${t("tasks.docTitle")}`;
      const back = el("a", { href: "/tasks", class: "back", onclick: (e) => { e.preventDefault(); navigate("/tasks"); } }, t("tasks.back"));
      if (task.hidden) {
        page.replaceChildren(back, el("div", { class: "card", text: t("tasks.hidden") }));
        return;
      }
      const bids = (task.bids ?? []).slice().sort((a, b) => a.price - b.price);
      const timeline = [
        [t("tl.posted"), task.created_at],
        task.assignee_home ? [t("tl.accepted"), task.assigned_at ?? null] : null,
        task.delivered_at ? [t("tl.delivered"), task.delivered_at] : null,
        task.completed_at ? [t("tl.completed"), task.completed_at] : null,
        task.status === "cancelled" ? [t("tl.cancelled"), task.cancelled_at ?? null] : null,
        task.status === "disputed" ? [t("tl.disputed"), null] : null,
      ].filter(Boolean);
      const reportBtn = el("button", { class: "btn ghost small", type: "button", onclick: async () => {
        reportBtn.disabled = true;
        try { if (!demoTasks()) await reportTask(task.id); reportBtn.textContent = t("tasks.reported"); }
        catch { reportBtn.textContent = t("tasks.reportFail"); reportBtn.disabled = false; }
      } }, t("report.button"));
      page.replaceChildren(
        back,
        el("div", { class: "task-detail" },
          el("section", { class: "card" },
            el("div", { class: "task-top" }, chip(task.status), el("span", { class: "muted small", text: t("tasks.budget") }), coin(task.budget)),
            el("h1", { class: "task-h1", text: task.title }),
            el("p", { class: "muted small" }, `${t("tasks.postedBy")} `, homeLink(homes, task.poster_home, navigate), ` · ${t("time.ago", { t: timeAgo(task.created_at) })}`,
              task.deadline_at ? ` · ${t("tasks.deadline", { date: date(task.deadline_at) })}` : ""),
            el("p", { class: "task-summary", text: task.summary ?? "" }),
            el("div", { class: "tag-row" }, ...(task.tags ?? []).map((g) => el("a", { class: "tag", href: `/tasks?status=&tag=${encodeURIComponent(g)}`, onclick: (e) => { e.preventDefault(); navigate(`/tasks?status=&tag=${encodeURIComponent(g)}`); } }, `#${g}`))),
            task.assignee_home ? el("p", {}, `${t("tasks.assignedTo")} `, homeLink(homes, task.assignee_home, navigate), task.price ? el("span", {}, ` · ${t("tasks.for")} `, coin(task.price)) : null) : null,
            task.status === "completed" && task.rating ? el("div", { class: "review" }, stars(task.rating), task.review ? el("p", { text: `“${task.review}”` }) : null) : null,
            el("p", { class: "muted small e2e", text: `🔒 ${task.messages ? t("tasks.messages", { n: task.messages }) : ""}${t("tasks.e2e")}` }),
            el("div", { class: "detail-actions" }, reportBtn)),
          el("aside", { class: "side" },
            el("section", { class: "card" },
              el("h2", { text: t("tasks.bidsTitle", { n: bids.length }) }),
              bids.length ? el("ul", { class: "bids" }, ...bids.map((b) => el("li", { class: `bid bid-${b.status}` },
                homeLink(homes, b.bidder_home, navigate), coin(b.price),
                el("span", { class: "muted small", text: b.status === "accepted" ? t("tasks.accepted") : b.status === "declined" ? t("tasks.declined") : t("time.ago", { t: timeAgo(b.created_at) }) }))))
                : el("p", { class: "muted small", text: t("tasks.noBids") })),
            el("section", { class: "card" },
              el("h2", { text: t("tasks.timeline") }),
              el("ol", { class: "task-timeline" }, ...timeline.map(([label, ts]) => el("li", {}, el("span", { text: label }), el("time", { class: "muted small", text: ts ? `${date(ts)} · ${t("time.ago", { t: timeAgo(ts) })}` : "" }))))))),
      );
    } catch (e) {
      if (e instanceof MarketUnavailable) { page.replaceChildren(); unavailable(page, navigate); return; }
      page.replaceChildren(el("div", { class: "card notfound" },
        el("h1", { text: e.status === 404 ? t("tasks.notFound") : t("tasks.loadOneError") }),
        el("a", { href: "/tasks", class: "btn", onclick: (ev) => { ev.preventDefault(); navigate("/tasks"); } }, t("tasks.back"))));
    }
  }

  return () => { dead = true; page.remove(); };
}
