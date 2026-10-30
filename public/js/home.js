// "/h/:id" — one Home, up close. Same top-down interior as the town (shared HomeSim renderer), drawn
// bigger, with speech bubbles (task titles decrypted locally for the owner), side panel and stats.
import { api, openStream } from "./api.js";
import { HomeSim, statusLine, SPOT_LABEL, setDwelling, onDwellingChange } from "./interior.js";
import { spriteIcon } from "./sprites.js";
import { owner, onOwnerChange, titleFor } from "./owner.js";
import { el, clamp, fitCanvas, truncate, timeAgo, hhmm, BUSY, prefersReducedMotion } from "./util.js";

export const kindLabel = (k) =>
  k === "claude-code" ? "Claude Code" : k === "codex" ? "Codex" : k ? k.charAt(0).toUpperCase() + k.slice(1) : "Agent";

function statusText(s) {
  if (s.status === "tool") return `⚙ ${s.tool || "tool"}`;
  if (s.status === "thinking") return "thinking…";
  if (s.status === "waiting") return "waiting for you";
  if (s.status === "ended") return "left";
  return "idle";
}
const STATUS_COLOR = { tool: "#ffcf6e", thinking: "#8bd3c7", waiting: "#ff9bb3", idle: "#9a8fb5", ended: "#6e6680" };
const MARGIN = 6; // art px around the house

export function mountHome(root, { id, navigate, setHeaderStats }) {
  const reduced = prefersReducedMotion();
  const title = el("h1", { class: "home-name", text: "…" });
  const summary = el("p", { class: "home-summary muted" });
  const descr = el("p", { class: "home-descr", hidden: true });
  const badge = el("p", { class: "owner-badge", hidden: true });
  const canvas = el("canvas", { class: "room-canvas", role: "img", "aria-label": "Home interior, seen from above" });
  const tip = el("div", { class: "tip", hidden: true });
  const roomWrap = el("div", { class: "room-wrap" }, canvas, tip);
  const emptyNote = el("p", { class: "empty-note", hidden: true, text: "Everyone's asleep right now · 大家都睡了" });
  const legend = el("p", { class: "legend muted small", text: "Desk: thinking & coding · Terminal: Bash · Bookshelf: Read/Grep · Writing table: Edit/Write · Radio: Web · Crates: MCP · Sofa: resting · Bed: asleep · Door: needs you" });
  const personaList = el("ul", { class: "persona-list" });
  const timeline = el("ol", { class: "timeline" });
  const statsBox = el("div", { class: "stats" }, el("p", { class: "muted small", text: "Loading…" }));

  const page = el("div", { class: "home-page" },
    el("section", { class: "room-col" },
      el("div", { class: "room-head" },
        el("a", { href: "/", class: "back", onclick: (e) => { e.preventDefault(); navigate("/"); } }, "← Town"),
        title, descr, summary, badge),
      roomWrap, emptyNote, legend),
    el("aside", { class: "side" },
      el("section", { class: "card" }, el("h2", { text: "Residents · 住户" }), personaList),
      el("section", { class: "card" }, el("h2", { text: "Last 14 days" }), statsBox),
      el("section", { class: "card" }, el("h2", { text: "Recent activity" }), timeline),
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
      if (home.dwelling !== undefined) setDwelling(id, home.dwelling);
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
      summary.textContent = "Couldn't load this home. Retrying…";
      setTimeout(() => !dead && load(), 5000);
    }
  }
  let reloadTimer = 0;
  function scheduleReload() { clearTimeout(reloadTimer); reloadTimer = setTimeout(load, 800); }

  let saysLoaded = [];
  async function loadEvents() {
    try {
      const r = await api(`/homes/${encodeURIComponent(id)}/events?limit=40`);
      const items = [...r.events.map((ev) => ({ ts: ev.ts, node: eventItem(ev) })), ...saysLoaded.map((m) => ({ ts: m.ts, node: sayItem(m) }))];
      items.sort((a, b) => b.ts - a.ts);
      timeline.replaceChildren(...items.map((i) => i.node));
      if (!r.events.length) timeline.append(el("li", { class: "muted small", text: "No activity yet." }));
    } catch {}
  }
  async function loadStats() {
    try { renderStats(await api(`/homes/${encodeURIComponent(id)}/stats?days=14`)); } catch {}
  }

  function notFound() {
    page.replaceChildren(el("div", { class: "card notfound" },
      el("h1", { text: "No such home" }),
      el("p", { class: "muted", text: "This address doesn't exist (or it moved away)." }),
      el("a", { href: "/", class: "btn", onclick: (e) => { e.preventDefault(); navigate("/"); } }, "← Back to town")));
    dead = true;
    cleanup();
  }

  const closeStream = openStream(`home=${encodeURIComponent(id)}`, {
    home: (h) => { if (h.id === id) { home = { ...home, ...h }; if (h.dwelling !== undefined) setDwelling(id, h.dwelling); renderHead(); } },
    say: (m) => {
      sim.say(m.persona_id, m.text, m.ts);
      timeline.querySelector(".muted.small")?.remove();
      timeline.prepend(sayItem(m));
      while (timeline.children.length > 60) timeline.lastChild.remove();
    },
    persona: (p) => upsertPersona(p),
    session: (s) => {
      applySession(s, true);
      prependEvent({ session_id: s.id, persona_id: s.persona_id, ts: Date.now(), status: s.status, tool: s.tool, task_no: s.task_no });
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
    descr.hidden = !home.description;
    descr.textContent = home.description ?? "";
    document.title = `${home.name} · Agent Town`;
    let open = 0, busy = 0, subs = 0;
    for (const s of sessions.values()) { open++; if (BUSY.has(s.status)) busy++; if (s.parent_id) subs++; }
    summary.textContent = open
      ? `${open - subs} awake${subs ? ` + ${subs} subagent${subs === 1 ? "" : "s"}` : ""} · ${busy} busy`
      : "Lights off — everyone's asleep.";
    emptyNote.hidden = open > 0;
    setHeaderStats([["open", open, "online"], ["busy", busy, "busy"]], live);
    const mine = isMine();
    badge.hidden = !mine;
    badge.textContent = mine ? "🔑 Your home — task titles are decrypted locally in this browser." : "";
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
      const state = c ? (c.busy ? `working · ${c.open} open` : `awake · ${c.open} open`) : "asleep";
      return el("li", { class: c ? "on" : "off" },
        spriteIcon(p, 1.5),
        el("div", {},
          el("strong", { text: p.name }),
          el("span", { class: "muted small", text: `${kindLabel(p.kind)} · ${state}` }),
          p.sprite_status === "pending" ? el("span", { class: "small accent", text: "new look being drawn…" }) : null,
          p.appearance ? el("span", { class: "small muted appearance", text: `“${truncate(p.appearance, 90)}”` }) : null));
    });
    personaList.replaceChildren(...(items.length ? items : [el("li", { class: "muted small", text: "No residents yet." })]));
  }

  function personaName(ev) {
    const pid = ev.persona_id ?? seenSessions.get(ev.session_id) ?? sessions.get(ev.session_id)?.persona_id;
    return pid && personas.get(pid)?.name;
  }
  function eventItem(ev) {
    const name = personaName(ev) ?? "an agent";
    const s = { status: ev.status, tool: ev.tool };
    return el("li", {},
      el("time", { text: hhmm(ev.ts), datetime: new Date(ev.ts).toISOString() }),
      el("span", { class: "dot", style: `background:${STATUS_COLOR[ev.status] ?? "#999"}` }),
      el("span", { class: "who", text: truncate(name, 18) }),
      el("span", { class: "what", text: statusText(s) }),
      ev.task_no ? el("span", { class: "task muted", text: `#${ev.task_no}` }) : null);
  }
  function sayItem(m) {
    return el("li", { class: "say" },
      el("time", { text: hhmm(m.ts ?? Date.now()), datetime: new Date(m.ts ?? Date.now()).toISOString() }),
      el("span", { class: "dot", style: "background:#ffffff" }),
      el("span", { class: "who", text: truncate(personas.get(m.persona_id)?.name ?? "someone", 18) }),
      el("span", { class: "what", text: `“${truncate(m.text ?? "", 120)}”` }));
  }
  let lastEv = "";
  function prependEvent(ev) {
    const key = `${ev.session_id}|${ev.status}|${ev.tool}|${ev.task_no}`;
    if (key === lastEv) return; // collapse identical consecutive heartbeats
    lastEv = key;
    timeline.querySelector(".muted.small")?.remove();
    timeline.prepend(eventItem(ev));
    while (timeline.children.length > 60) timeline.lastChild.remove();
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
    const bars = el("div", { class: "bars", role: "img", "aria-label": `Busy hours per day, ${totalH.toFixed(1)} hours total` },
      ...days.map((d) => {
        const h = d.busy_ms / 3.6e6;
        return el("div", { class: "bar", title: `${d.day}: ${h.toFixed(1)} h busy, ${d.tasks} task${d.tasks === 1 ? "" : "s"}` },
          el("span", { style: `height:${Math.max(d.busy_ms ? 4 : 1, Math.round((d.busy_ms / max) * 100))}%` }));
      }));
    const axis = el("div", { class: "bars-axis muted small" }, el("span", { text: days[0].day.slice(5) }), el("span", { text: "today" }));
    const head = el("p", { class: "small" },
      el("strong", { text: `${totalH < 10 ? totalH.toFixed(1) : Math.round(totalH)} h` }), " busy · ",
      el("strong", { text: String(totalTasks) }), ` task${totalTasks === 1 ? "" : "s"}`);
    const tools = st.tools.slice(0, 8);
    const tmax = Math.max(...tools.map((t) => t.count), 1);
    const toolList = el("ul", { class: "tools" }, ...tools.map((t) =>
      el("li", {},
        el("span", { class: "tname", text: t.tool }),
        el("span", { class: "tbar" }, el("span", { style: `width:${Math.max(2, Math.round((t.count / tmax) * 100))}%` })),
        el("span", { class: "tcount muted", text: String(t.count) }))));
    statsBox.replaceChildren(head, bars, axis,
      el("h3", { text: "Tools used" }),
      tools.length ? toolList : el("p", { class: "muted small", text: "No tool calls yet." }));
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
    ctx.fillStyle = "#1f3b33";
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
      if (tt === undefined) return { text: `task #${s.task_no} · decrypting…` };
    }
    return { text: `task #${s.task_no}` };
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
    const line1 = mini ? (s.status === "tool" ? s.tool || "tool" : s.status === "thinking" ? "…" : statusLine(e)) : statusLine(e);
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
    const where = SPOT_LABEL[e.target?.kind] ?? "";
    const task = e.sleeper ? null : taskLine(s);
    tip.replaceChildren(
      el("strong", { text: p?.name ?? "Agent" }),
      el("span", { class: "muted", text: parent ? `${kindLabel(p?.kind)} · subagent of ${personas.get(parent.persona_id)?.name ?? "…"}` : kindLabel(p?.kind) }),
      el("span", { text: e.sleeper ? "asleep — no open session" : `${statusText(s)}${where ? ` · at the ${where}` : ""}`, style: `color:${STATUS_COLOR[s.status] ?? "#c9c2e8"}` }),
      task ? el("span", { class: task.mine ? "" : "muted", text: task.text }) : null,
      s.started_at ? el("span", { class: "muted small", text: `in for ${timeAgo(s.started_at)} · seen ${timeAgo(s.last_seen)} ago` }) : null,
    );
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

  load().then(() => { if (!dead) { loadEvents(); loadStats(); } });
  frame(performance.now());

  return () => {
    dead = true;
    cleanup();
    page.remove();
  };
}
