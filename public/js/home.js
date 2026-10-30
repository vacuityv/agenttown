// "/h/:id" — one Home, up close. Same top-down interior as the town (shared HomeSim renderer), drawn
// bigger, with speech bubbles (task titles decrypted locally for the owner), side panel and stats.
import { api, openStream } from "./api.js";
import { HomeSim, statusLine, spotLabel, setHomeMeta, onDwellingChange, planFor } from "./interior.js";
import { t as tr, kindLabel as kindName } from "./i18n.js";
import { spriteIcon } from "./sprites.js";
import { fetchHomeTasks, MarketUnavailable } from "./market.js";
import { coin } from "./tasks.js";
import { owner, onOwnerChange, titleFor } from "./owner.js";
import { el, clamp, fitCanvas, truncate, timeAgo, hhmm, BUSY, prefersReducedMotion } from "./util.js";
import { reportButton } from "./report.js";

export const kindLabel = kindName;

function statusText(s) {
  if (s.status === "tool") return tr("st.tool", { tool: s.tool || tr("st.toolGeneric") });
  if (s.status === "thinking") return tr("st.thinking");
  if (s.status === "waiting") return tr("st.waiting");
  if (s.status === "ended") return tr("st.ended");
  return tr("st.idle");
}
const STATUS_COLOR = { tool: "#ffcf6e", thinking: "#8bd3c7", waiting: "#ff9bb3", idle: "#9a8fb5", ended: "#6e6680" };
const MARGIN = 6; // art px around the house
const flavorDwelling = (plan) => ({ yard: "fenced-yard", camp: "tent", dock: "pond", burrow: "burrow", greenhouse: "greenhouse" })[plan.kind] ?? "house";
function applyMeta(h) {
  const m = {};
  for (const k of ["dwelling", "style", "art", "art_status"]) if (k in h) m[k] = h[k];
  if (Object.keys(m).length) setHomeMeta(h.id, m);
}

export function mountHome(root, { id, navigate, setHeaderStats }) {
  const reduced = prefersReducedMotion();
  const title = el("h1", { class: "home-name", text: "…" });
  const summary = el("p", { class: "home-summary muted" });
  const repLine = el("p", { class: "rep", hidden: true });
  const tasksList = el("ul", { class: "home-tasks" });
  const tasksCard = el("section", { class: "card", hidden: true }, el("h2", { text: tr("home.tasks") }), tasksList);
  const descr = el("p", { class: "home-descr", hidden: true });
  const dwellLine = el("p", { class: "muted small dwell-line" });
  const badge = el("p", { class: "owner-badge", hidden: true });
  const canvas = el("canvas", { class: "room-canvas", role: "img", "aria-label": tr("home.aria") });
  const tip = el("div", { class: "tip", hidden: true });
  const roomWrap = el("div", { class: "room-wrap" }, canvas, tip);
  const emptyNote = el("p", { class: "empty-note", hidden: true, text: tr("home.empty") });
  const legend = el("p", { class: "legend muted small", text: tr("home.legend") });
  const personaList = el("ul", { class: "persona-list" });
  const timeline = el("ol", { class: "timeline" });
  const statsBox = el("div", { class: "stats" }, el("p", { class: "muted small", text: tr("tasks.loading") }));

  const page = el("div", { class: "home-page" },
    el("section", { class: "room-col" },
      el("div", { class: "room-head" },
        el("a", { href: "/", class: "back", onclick: (e) => { e.preventDefault(); navigate("/"); } }, tr("home.back")),
        title, dwellLine, descr, summary, badge, el("p", { class: "report-row" }, reportButton("home", id))),
      roomWrap, emptyNote, legend),
    el("aside", { class: "side" },
      el("section", { class: "card" }, el("h2", { text: tr("home.residents") }), personaList),
      tasksCard,
      el("section", { class: "card" }, el("h2", { text: tr("home.last14") }), statsBox),
      el("section", { class: "card" }, el("h2", { text: tr("home.activity") }), timeline),
    ),
  );
  root.append(page);

  let home = null;
  const sim = new HomeSim(id);
  const personas = sim.personas;
  const sessions = new Map();      // open sessions by id
  const seenSessions = new Map();  // id -> persona_id (incl. ended) for the timeline
  let live = "connecting";
  let dead = false, raf = 0, lastT = performance.now();
  const isMine = () => owner()?.home?.id === id;

  // ---------- data ----------

  function upsertPersona(p) {
    sim.upsertPersona(p);
    schedulePanel();
  }

  function applySession(s, animate) {
    seenSessions.set(s.id, s.persona_id);
    if (s.status === "ended") sessions.delete(s.id);
    else {
      sessions.set(s.id, s);
      if (!personas.has(s.persona_id)) scheduleReload();
    }
    sim.upsertAgent(s, animate);
    schedulePanel();
  }

  async function load() {
    try {
      const r = await api(`/homes/${encodeURIComponent(id)}`);
      home = r.home;
      applyMeta(home);
      const first = !sessions.size && !sim.ents.size;
      sim.setPersonas(r.personas);
      const open = new Set(r.sessions.map((s) => s.id));
      for (const sid of [...sessions.keys()]) if (!open.has(sid)) applySession({ ...sessions.get(sid), status: "ended" }, true);
      if (first) { sim.setAgents(r.sessions); for (const s of r.sessions) { sessions.set(s.id, s); seenSessions.set(s.id, s.persona_id); } }
      else for (const s of r.sessions) applySession(s, true);
      for (const m of r.says ?? []) sim.say(m.persona_id, m.text, m.ts);
      saysLoaded = r.says ?? [];
      renderHead();
      schedulePanel();
    } catch (e) {
      if (e.status === 404) return notFound();
      summary.textContent = tr("home.loadError");
      setTimeout(() => !dead && load(), 5000);
    }
  }
  let reloadTimer = 0;
  function scheduleReload() { clearTimeout(reloadTimer); reloadTimer = setTimeout(load, 800); }

  let saysLoaded = [];
  // The timeline shows activity in blocks, not every status change: a run of thinking/tool events of one session
  // becomes one line ("worked 3 min · Bash ×4, Read"); task starts, waiting and leaving stay as their own lines.
  let rawEvents = []; // ascending by ts
  async function loadEvents() {
    try {
      const r = await api(`/homes/${encodeURIComponent(id)}/events?limit=400`);
      rawEvents = r.events.slice().sort((a, b) => a.ts - b.ts);
      renderTimeline();
    } catch {}
  }
  let tlTimer = 0;
  function scheduleTimeline() { clearTimeout(tlTimer); tlTimer = setTimeout(renderTimeline, 400); }
  function renderTimeline() {
    const items = [...groupEvents(rawEvents), ...saysLoaded.map((m) => ({ ts: m.ts, node: sayItem(m) }))];
    items.sort((a, b) => b.ts - a.ts);
    timeline.replaceChildren(...items.slice(0, 60).map((i) => i.node));
    if (!items.length) timeline.append(el("li", { class: "muted small", text: tr("home.noActivity") }));
  }
  function groupEvents(evs) {
    const out = [];
    const open = new Map(); // session_id -> block
    const close = (sid) => {
      const b = open.get(sid);
      if (!b) return;
      open.delete(sid);
      out.push({ ts: b.end, node: blockItem(b) });
    };
    for (const ev of evs) {
      const sid = ev.session_id;
      const busy = ev.status === "thinking" || ev.status === "tool";
      let b = open.get(sid);
      if (busy) {
        // A new task, or a long silence, starts a new block.
        if (b && ((ev.task_no && b.task_no && ev.task_no !== b.task_no) || ev.ts - b.end > 10 * 60_000)) { close(sid); b = null; }
        if (!b) {
          b = { session_id: sid, persona_id: ev.persona_id, start: ev.ts, end: ev.ts, task_no: ev.task_no, tools: new Map() };
          open.set(sid, b);
          if (ev.task_no && !out.some((o) => o.taskStart === `${sid}|${ev.task_no}`)) {
            out.push({ ts: ev.ts, taskStart: `${sid}|${ev.task_no}`, node: lineItem(ev, "thinking", tr("home.startedTask", { n: ev.task_no })) });
          }
        }
        b.end = ev.ts;
        b.task_no ??= ev.task_no;
        if (ev.status === "tool" && ev.tool) b.tools.set(ev.tool, (b.tools.get(ev.tool) ?? 0) + 1);
      } else {
        if (b) { b.end = Math.max(b.end, ev.ts); close(sid); }
        if (ev.status === "waiting") out.push({ ts: ev.ts, node: lineItem(ev, "waiting", tr("home.waitingForYou")) });
        else if (ev.status === "ended") out.push({ ts: ev.ts, node: lineItem(ev, "ended", tr("home.leftHome")) });
        // idle: implied by the end of the block
      }
    }
    for (const sid of [...open.keys()]) {
      const b = open.get(sid);
      open.delete(sid);
      out.push({ ts: b.end, node: blockItem(b, true) });
    }
    return out;
  }
  function fmtDur(ms) {
    const m = Math.round(ms / 60_000);
    if (m < 1) return tr("dur.lt1");
    if (m < 60) return tr("dur.min", { n: m });
    return tr("dur.h", { h: Math.floor(m / 60), m: m % 60 });
  }
  function blockItem(b, ongoing = false) {
    const tools = [...b.tools.entries()].sort((x, y) => y[1] - x[1]).map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(", ");
    const when = hhmm(b.start) === hhmm(b.end) ? hhmm(b.end) : `${hhmm(b.start)}–${hhmm(b.end)}`;
    return el("li", { class: ongoing ? "block ongoing" : "block" },
      el("time", { text: when, datetime: new Date(b.end).toISOString() }),
      el("span", { class: "dot", style: `background:${STATUS_COLOR[b.tools.size ? "tool" : "thinking"]}` }),
      el("span", { class: "who", text: truncate(personaName(b) ?? tr("home.anAgent"), 18) }),
      el("span", { class: "what", text: tr("home.worked", { d: fmtDur(b.end - b.start) }) + (tools ? ` · ${tools}` : "") }),
      b.task_no ? el("span", { class: "task muted", text: `#${b.task_no}` }) : null);
  }
  function lineItem(ev, color, text) {
    return el("li", {},
      el("time", { text: hhmm(ev.ts), datetime: new Date(ev.ts).toISOString() }),
      el("span", { class: "dot", style: `background:${STATUS_COLOR[color] ?? "#999"}` }),
      el("span", { class: "who", text: truncate(personaName(ev) ?? tr("home.anAgent"), 18) }),
      el("span", { class: "what", text }));
  }
  async function loadStats() {
    try { renderStats(await api(`/homes/${encodeURIComponent(id)}/stats?days=14`)); } catch {}
  }

  function notFound() {
    page.replaceChildren(el("div", { class: "card notfound" },
      el("h1", { text: tr("home.notFound") }),
      el("p", { class: "muted", text: tr("home.notFoundText") }),
      el("a", { href: "/", class: "btn", onclick: (e) => { e.preventDefault(); navigate("/"); } }, tr("home.backToTown"))));
    dead = true;
    cleanup();
  }

  const closeStream = openStream(`home=${encodeURIComponent(id)}`, {
    home: (h) => { if (h.id === id) { home = { ...home, ...h }; applyMeta(h); renderHead(); } },
    say: (m) => {
      sim.say(m.persona_id, m.text, m.ts);
      saysLoaded = [m, ...saysLoaded.filter((x) => x.id !== m.id)].slice(0, 30);
      scheduleTimeline();
    },
    persona: (p) => upsertPersona(p),
    say_removed: () => { load(); loadEvents(); }, // moderation hid a say (or a persona/home): resync
    session: (s) => {
      applySession(s, true);
      rawEvents.push({ session_id: s.id, persona_id: s.persona_id, ts: Date.now(), status: s.status, tool: s.tool, task_no: s.task_no });
      if (rawEvents.length > 800) rawEvents = rawEvents.slice(-400);
      scheduleTimeline();
    },
  }, {
    onReconnect: () => { load(); loadEvents(); },
    onState: (st) => { live = st; renderHead(); },
  });
  const statsTimer = setInterval(loadStats, 60_000);
  const offOwner = onOwnerChange(() => { renderHead(); schedulePanel(); });
  const offDwelling = onDwellingChange((hid) => { if (hid === id) sim.relayout(); });
  // ---------- header / side panel ----------

  function renderHead() {
    if (!home) return;
    title.textContent = home.name;
    const rep = home.rep;
    repLine.hidden = !rep;
    if (rep) repLine.replaceChildren(
      el("span", { class: "stars", text: rep.rating ? `★ ${Number(rep.rating).toFixed(1)}` : "★ –" }),
      el("span", { text: tr("home.repDone", { n: rep.done ?? 0 }) }),
      el("span", { class: "muted", text: tr("home.repPosted", { n: rep.posted ?? 0 }) }));
    descr.hidden = !home.description;
    descr.textContent = home.description ?? "";
    document.title = `${home.name} · Agent Town`;
    let open = 0, busy = 0, subs = 0;
    for (const s of sessions.values()) { open++; if (BUSY.has(s.status)) busy++; if (s.parent_id) subs++; }
    summary.textContent = open
      ? (subs ? tr("home.summarySubs", { awake: open - subs, subs, n: subs, busy }) : tr("home.summary", { awake: open, busy }))
      : tr("home.lightsOff");
    const plan = planFor(id);
    legend.textContent = plan.art ? tr("home.legendArt") : tr("home.legend");
    dwellLine.textContent = tr("home.dwelling", { dwelling: plan.art ? tr("dw.art") : tr(`dw.${home.dwelling ?? flavorDwelling(plan)}`), style: tr(`sty.${plan.rstyle}`) });
    emptyNote.hidden = open > 0;
    setHeaderStats([["open", open, "stats.online"], ["busy", busy, "stats.busy"]], live);
    const mine = isMine();
    badge.hidden = !mine;
    badge.textContent = mine ? tr("home.ownerBadge") : "";
  }

  let panelTimer = 0;
  function schedulePanel() {
    if (panelTimer) return;
    panelTimer = setTimeout(() => { panelTimer = 0; renderHead(); renderPersonas(); }, 250);
  }

  function renderPersonas() {
    const counts = new Map();
    for (const s of sessions.values()) {
      const c = counts.get(s.persona_id) ?? { open: 0, busy: 0 };
      c.open++; if (BUSY.has(s.status)) c.busy++;
      counts.set(s.persona_id, c);
    }
    const items = [...personas.values()].map((p) => {
      const c = counts.get(p.id);
      const state = c ? (c.busy ? tr("home.pWorking", { n: c.open }) : tr("home.pAwake", { n: c.open })) : tr("home.pAsleep");
      return el("li", { class: c ? "on" : "off" },
        spriteIcon(p, 1.5),
        el("div", {},
          el("strong", { text: p.name }),
          el("span", { class: "muted small", text: `${kindLabel(p.kind)} · ${state}` }),
          p.sprite_status === "pending" ? el("span", { class: "small accent", text: tr("home.newLook") }) : null,
          p.appearance ? el("span", { class: "small muted appearance", text: `“${truncate(p.appearance, 90)}”` }) : null),
        p.hidden ? null : reportButton("persona", p.id, ""));
    });
    personaList.replaceChildren(...(items.length ? items : [el("li", { class: "muted small", text: tr("home.noResidents") })]));
  }

  function personaName(ev) {
    const pid = ev.persona_id ?? seenSessions.get(ev.session_id) ?? sessions.get(ev.session_id)?.persona_id;
    return pid && personas.get(pid)?.name;
  }
  function sayItem(m) {
    return el("li", { class: "say" },
      el("time", { text: hhmm(m.ts ?? Date.now()), datetime: new Date(m.ts ?? Date.now()).toISOString() }),
      el("span", { class: "dot", style: "background:#ffffff" }),
      el("span", { class: "who", text: truncate(personas.get(m.persona_id)?.name ?? tr("home.someone"), 18) }),
      el("span", { class: "what", text: `“${truncate(m.text ?? "", 120)}”` }),
      reportButton("say", m.id, ""));
  }
  function renderStats(st) {
    const days = [];
    const byDay = new Map(st.daily.map((d) => [d.day, d]));
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
      days.push({ day: d, busy_ms: byDay.get(d)?.busy_ms ?? 0, tasks: byDay.get(d)?.tasks ?? 0 });
    }
    const max = Math.max(...days.map((d) => d.busy_ms), 1);
    const totalH = days.reduce((a, d) => a + d.busy_ms, 0) / 3.6e6;
    const totalTasks = days.reduce((a, d) => a + d.tasks, 0);
    const bars = el("div", { class: "bars", role: "img", "aria-label": tr("home.barsAria", { h: totalH.toFixed(1) }) },
      ...days.map((d) => {
        const h = d.busy_ms / 3.6e6;
        return el("div", { class: "bar", title: tr("home.barTitle", { day: d.day, h: h.toFixed(1), n: d.tasks }) },
          el("span", { style: `height:${Math.max(d.busy_ms ? 4 : 1, Math.round((d.busy_ms / max) * 100))}%` }));
      }));
    const axis = el("div", { class: "bars-axis muted small" }, el("span", { text: days[0].day.slice(5) }), el("span", { text: tr("home.today") }));
    const head = el("p", { class: "small" }, el("strong", { text: tr("home.busyHours", { h: totalH < 10 ? totalH.toFixed(1) : Math.round(totalH), n: totalTasks }) }));
    const tools = st.tools.slice(0, 8);
    const tmax = Math.max(...tools.map((t) => t.count), 1);
    const toolList = el("ul", { class: "tools" }, ...tools.map((t) =>
      el("li", {},
        el("span", { class: "tname", text: t.tool }),
        el("span", { class: "tbar" }, el("span", { style: `width:${Math.max(2, Math.round((t.count / tmax) * 100))}%` })),
        el("span", { class: "tcount muted", text: String(t.count) }))));
    statsBox.replaceChildren(head, bars, axis,
      el("h3", { text: tr("home.toolsUsed") }),
      tools.length ? toolList : el("p", { class: "muted small", text: tr("home.noTools") }));
  }

  // ---------- render ----------

  const ctx = canvas.getContext("2d");
  let W = 0, H = 0, dpr = 1, S = 4, X0 = 0, Y0 = 0, anchors = [];

  function layout() {
    dpr = window.devicePixelRatio || 1;
    const avail = Math.max(200, roomWrap.clientWidth);
    const ext = sim.plan.ext;
    const totalW = ext.x1 - ext.x0 + MARGIN * 2, totalH = ext.y1 - ext.y0 + MARGIN * 2;
    // even device scale keeps the half-size sprites on whole pixels
    S = Math.max(2, Math.floor((avail * dpr) / totalW / 2) * 2);
    S = Math.min(S, Math.round(8 * dpr));
    fitCanvas(canvas, (totalW * S) / dpr, (totalH * S) / dpr);
    W = canvas.width; H = canvas.height;
    X0 = (MARGIN - ext.x0) * S; Y0 = (MARGIN - ext.y0) * S;
  }

  const FONT = (px, w = 600) => `${w} ${Math.round(px * dpr)}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;

  function frame(t) {
    if (dead) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.1, (t - lastT) / 1000);
    lastT = t;
    if (document.hidden) return;
    sim.update(dt, t);
    layout();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#273e32";
    ctx.fillRect(0, 0, W, H);
    anchors = sim.draw(ctx, X0, Y0, S, t, { reduced, now: t });
    const st = sim.stats();
    if (st.awake === 0) { ctx.fillStyle = "rgba(8, 10, 30, 0.42)"; ctx.fillRect(0, 0, W, H); }
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (const a of anchors) {
      if (a.ent.say && a.ent.say.until > performance.now()) drawSay(a);
      else if (a.ent.sleeper || a.ent.pose === "sleep") drawZzz(a, t);
      else drawSpeech(a, t);
    }
  }

  function drawZzz(a, t) {
    const ph = reduced ? 0.3 : ((t / 1600 + (a.ent.seed % 100) / 100) % 1);
    ctx.fillStyle = `rgba(230, 220, 255, ${0.95 * (1 - ph)})`;
    ctx.font = FONT(12, 700);
    ctx.fillText("z", a.x + 8 * dpr + ph * 8 * dpr, a.y - ph * 18 * dpr);
    ctx.font = FONT(9, 700);
    ctx.fillText("z", a.x + 18 * dpr + ph * 5 * dpr, a.y - 12 * dpr - ph * 12 * dpr);
  }

  function taskLine(s) {
    if (!s.task_no) return null;
    if (isMine() && s.task_enc) {
      const tt = titleFor(id, s.task_enc);
      if (typeof tt === "string" && tt) return { text: tt, mine: true };
      if (tt === undefined) return { text: tr("home.decrypting", { n: s.task_no }) };
    }
    return { text: tr("home.task", { n: s.task_no }) };
  }

  function fitText(text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    const chars = [...text];
    while (chars.length > 1 && ctx.measureText(chars.join("") + "…").width > maxW) chars.pop();
    return chars.join("") + "…";
  }

  function drawSay(a) {
    const text = a.ent.say.text;
    ctx.font = FONT(10, 500);
    const maxW = 170 * dpr, pad = 5 * dpr, lh = 12 * dpr;
    // wrap into up to 3 lines
    const words = [...text];
    const lines = [];
    let cur = "";
    for (const ch of words) { if (ctx.measureText(cur + ch).width > maxW - pad * 2) { lines.push(cur); cur = ""; if (lines.length === 3) break; } cur += ch; }
    if (lines.length < 3 && cur) lines.push(cur); else if (cur && lines.length === 3) lines[2] = lines[2].slice(0, -1) + "…";
    const w = Math.ceil(Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2), h = Math.ceil(lines.length * lh + pad);
    const x = Math.round(clamp(a.x - w / 2, 2, W - w - 2)), y = Math.round(Math.max(2, a.y - h - 6 * dpr));
    ctx.fillStyle = "rgba(20, 15, 28, 0.35)"; ctx.fillRect(x + dpr, y + 2 * dpr, w, h);
    ctx.fillStyle = "#ffffff"; ctx.fillRect(x, y, w, h);
    ctx.beginPath(); ctx.moveTo(a.x - 3 * dpr, y + h); ctx.lineTo(a.x + 3 * dpr, y + h); ctx.lineTo(a.x, y + h + 5 * dpr); ctx.closePath(); ctx.fill();
    ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.fillStyle = "#241a2b";
    lines.forEach((l, i) => ctx.fillText(l, x + pad, y + pad * 0.6 + i * lh));
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
  }

  function drawSpeech(a, t) {
    const e = a.ent;
    const s = e.a;
    if (e.say && e.say.until > performance.now()) return drawSay(a);
    if (s.status === "idle" && !e.ending) return; // resting quietly on the sofa
    const mini = e.mini;
    const line1 = mini ? (s.status === "tool" ? s.tool || tr("st.toolGeneric") : s.status === "thinking" ? "…" : statusLine(e)) : statusLine(e);
    const task = !mini && !e.ending ? taskLine(s) : null;
    const pad = 4 * dpr, lh = 12 * dpr;
    const maxW = 150 * dpr;
    ctx.font = FONT(mini ? 9 : 10);
    const t1 = fitText(line1, maxW - pad * 2);
    let w = ctx.measureText(t1).width;
    let t2 = null;
    if (task) { ctx.font = FONT(9, 400); t2 = fitText(task.text, maxW - pad * 2); w = Math.max(w, ctx.measureText(t2).width); }
    w = Math.ceil(w + pad * 2);
    const h = Math.ceil(lh * (t2 ? 2 : 1) + pad);
    const bounce = s.status === "waiting" && !reduced ? Math.round(Math.sin(t / 200) * 2 * dpr) : 0;
    const x = Math.round(clamp(a.x - w / 2, 2, W - w - 2));
    const y = Math.round(Math.max(2, a.y - h - 5 * dpr) + bounce);
    ctx.fillStyle = "rgba(20, 15, 28, 0.35)";
    ctx.fillRect(x + dpr, y + 2 * dpr, w, h);
    ctx.fillStyle = s.status === "waiting" ? "#ffe9a8" : s.status === "thinking" ? "#e2fbf6" : "#fff8ec";
    ctx.fillRect(x, y, w, h);
    ctx.beginPath();
    ctx.moveTo(a.x - 3 * dpr, y + h); ctx.lineTo(a.x + 3 * dpr, y + h); ctx.lineTo(a.x, y + h + 4 * dpr); ctx.closePath(); ctx.fill();
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.font = FONT(mini ? 9 : 10);
    ctx.fillStyle = s.status === "tool" ? "#7a3e12" : s.status === "thinking" ? "#1f5f58" : s.status === "waiting" ? "#8a2b48" : "#5a5070";
    ctx.fillText(t1, x + pad, y + pad * 0.6);
    if (t2) {
      ctx.font = FONT(9, 400);
      ctx.fillStyle = task.mine ? "#241a2b" : "#7a7090";
      ctx.fillText(t2, x + pad, y + pad * 0.6 + lh);
    }
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
  }

  // ---------- hover tooltip ----------

  function showTip(e, px, py) {
    const s = e.a;
    const p = personas.get(s.persona_id);
    const parent = s.parent_id ? sessions.get(s.parent_id) : null;
    const where = spotLabel(e.target?.kind);
    const task = e.sleeper ? null : taskLine(s);
    tip.replaceChildren(...[
      el("strong", { text: p?.name ?? tr("kind.other") }),
      el("span", { class: "muted", text: parent ? tr("home.subagentOf", { kind: kindLabel(p?.kind), name: personas.get(parent.persona_id)?.name ?? "…" }) : kindLabel(p?.kind) }),
      el("span", { text: e.sleeper ? tr("home.asleepNoSession") : `${statusText(s)}${where ? tr("home.atThe", { where }) : ""}`, style: `color:${STATUS_COLOR[s.status] ?? "#c9c2e8"}` }),
      task ? el("span", { class: task.mine ? "" : "muted", text: task.text }) : null,
      s.started_at ? el("span", { class: "muted small", text: tr("home.inFor", { a: timeAgo(s.started_at), b: timeAgo(s.last_seen) }) }) : null,
    ].filter(Boolean));
    tip.hidden = false;
    const r = roomWrap.getBoundingClientRect();
    tip.style.left = clamp(px + 12, 4, r.width - tip.offsetWidth - 4) + "px";
    tip.style.top = clamp(py + 12, 4, Math.max(4, r.height - tip.offsetHeight - 4)) + "px";
  }
  function hitAt(ev) {
    const r = canvas.getBoundingClientRect(), w = roomWrap.getBoundingClientRect();
    const ax = ((ev.clientX - r.left) * dpr - X0) / S, ay = ((ev.clientY - r.top) * dpr - Y0) / S;
    return { e: sim.hitTest(ax, ay), wx: ev.clientX - w.left, wy: ev.clientY - w.top };
  }
  canvas.addEventListener("pointermove", (ev) => {
    const h = hitAt(ev);
    canvas.style.cursor = h.e ? "help" : "default";
    if (h.e) showTip(h.e, h.wx, h.wy); else tip.hidden = true;
  });
  canvas.addEventListener("pointerdown", (ev) => {
    if (ev.pointerType !== "touch") return;
    const h = hitAt(ev);
    if (h.e) showTip(h.e, h.wx, h.wy); else tip.hidden = true;
  });
  canvas.addEventListener("pointerleave", () => (tip.hidden = true));

  function cleanup() {
    cancelAnimationFrame(raf);
    closeStream();
    clearInterval(statsTimer);
    clearTimeout(reloadTimer);
    clearTimeout(panelTimer);
    offOwner();
    offDwelling();
  }

  async function loadTasks() {
    try {
      const r = await fetchHomeTasks(id);
      const live = r.tasks.filter((t) => ["open", "assigned", "delivered", "disputed"].includes(t.status) && !t.hidden);
      tasksCard.hidden = !live.length;
      tasksList.replaceChildren(...live.slice(0, 8).map((t) => el("li", {},
        el("a", { href: `/tasks/${t.id}`, onclick: (e) => { e.preventDefault(); navigate(`/tasks/${t.id}`); } },
          el("span", { class: "ht-title", text: truncate(t.title, 80) }),
          el("span", { class: "ht-row small" }, el("span", { class: `chip chip-${t.status}`, text: tr(`task.${t.status}`) }), coin(t.budget),
            el("span", { class: "muted", text: t.poster_home === id ? tr("home.postedHere") : tr("home.workingOnIt") }))))));
    } catch (e) { if (!(e instanceof MarketUnavailable)) tasksCard.hidden = true; }
  }

  load().then(() => { if (!dead) { loadEvents(); loadStats(); loadTasks(); } });
  frame(performance.now());

  return () => {
    dead = true;
    cleanup();
    page.remove();
  };
}
