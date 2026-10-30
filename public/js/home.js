// "/h/:id" — a Home interior. Each open top-level session gets a desk; subagents sit at small side
// tables next to their parent as ~60% minis. Live via SSE /v1/stream?home=<id>.
import { api, openStream } from "./api.js";
import {
  STATION_W, STATION_H, WALL_H, ROOM_PAD, CHAR_DX, CHAR_DY, PAL,
  roomBackground, drawChair, drawDesk, drawMiniTable, drawMiniLaptop,
} from "./art.js";
import { sheetFor, frameFor, spriteIcon } from "./sprites.js";
import { owner, onOwnerChange, titleFor } from "./owner.js";
import { el, hash32, clamp, fitCanvas, truncate, timeAgo, hhmm, BUSY, prefersReducedMotion } from "./util.js";

const SPAWN_MS = 380, DESPAWN_MS = 480, MINI_SLOTS = 4;

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

export function mountHome(root, { id, navigate, setHeaderStats }) {
  const reduced = prefersReducedMotion();
  const title = el("h1", { class: "home-name", text: "…" });
  const summary = el("p", { class: "home-summary muted" });
  const badge = el("p", { class: "owner-badge", hidden: true });
  const canvas = el("canvas", { class: "room-canvas", role: "img", "aria-label": "Home interior" });
  const tip = el("div", { class: "tip", hidden: true });
  const roomWrap = el("div", { class: "room-wrap" }, canvas, tip);
  const emptyNote = el("p", { class: "empty-note", hidden: true, text: "Nobody's at their desk right now · 大家都下班了" });
  const personaList = el("ul", { class: "persona-list" });
  const timeline = el("ol", { class: "timeline" });
  const statsBox = el("div", { class: "stats" }, el("p", { class: "muted small", text: "Loading…" }));

  const page = el("div", { class: "home-page" },
    el("section", { class: "room-col" },
      el("div", { class: "room-head" },
        el("a", { href: "/", class: "back", onclick: (e) => { e.preventDefault(); navigate("/"); } }, "← Town"),
        title, summary, badge),
      roomWrap, emptyNote),
    el("aside", { class: "side" },
      el("section", { class: "card" }, el("h2", { text: "Residents · 住户" }), personaList),
      el("section", { class: "card" }, el("h2", { text: "Last 14 days" }), statsBox),
      el("section", { class: "card" }, el("h2", { text: "Recent activity" }), timeline),
    ),
  );
  root.append(page);

  let home = null;
  const personas = new Map();
  const sessions = new Map();      // open sessions by id
  const entities = new Map();      // id -> { id, s, born, died, seed }
  const seenSessions = new Map();  // id -> persona_id (incl. ended) for the timeline
  const slotOf = new Map();        // top-level session id -> desk slot
  let live = "connecting";
  let dead = false, raf = 0;
  const isMine = () => owner()?.home?.id === id;

  // ---------- data ----------

  function upsertPersona(p) {
    personas.set(p.id, p);
    schedulePanel();
  }

  function applySession(s, animate) {
    const now = performance.now();
    seenSessions.set(s.id, s.persona_id);
    let ent = entities.get(s.id);
    if (s.status === "ended") {
      sessions.delete(s.id);
      if (ent && !ent.died) { ent.died = now; ent.s = { ...ent.s, status: "ended" }; }
    } else {
      sessions.set(s.id, s);
      if (!ent) entities.set(s.id, (ent = { id: s.id, s, born: animate ? now : -1e9, died: 0, seed: hash32(s.id) % 10007 }));
      else { ent.s = s; if (ent.died) { ent.died = 0; ent.born = now; } }
      if (!personas.has(s.persona_id)) scheduleReload();
    }
    schedulePanel();
  }

  async function load() {
    try {
      const r = await api(`/homes/${encodeURIComponent(id)}`);
      home = r.home;
      personas.clear();
      for (const p of r.personas) personas.set(p.id, p);
      const open = new Set(r.sessions.map((s) => s.id));
      for (const [sid, ent] of entities) if (!open.has(sid) && !ent.died) applySession({ ...ent.s, status: "ended" }, true);
      const first = entities.size === 0;
      for (const s of r.sessions) applySession(s, !first);
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

  async function loadEvents() {
    try {
      const r = await api(`/homes/${encodeURIComponent(id)}/events?limit=40`);
      timeline.replaceChildren(...r.events.map(eventItem));
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
    home: (h) => { if (h.id === id) { home = { ...home, ...h }; renderHead(); } },
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

  // ---------- header / side panel ----------

  function renderHead() {
    if (!home) return;
    title.textContent = home.name;
    document.title = `${home.name} · Agent Town`;
    let open = 0, busy = 0, subs = 0;
    for (const s of sessions.values()) { open++; if (BUSY.has(s.status)) busy++; if (s.parent_id) subs++; }
    summary.textContent = open
      ? `${open - subs} at desks${subs ? ` + ${subs} subagent${subs === 1 ? "" : "s"}` : ""} · ${busy} busy`
      : "Lights off — nobody home.";
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
      const state = c ? (c.busy ? `working · ${c.open} open` : `at desk · ${c.open} open`) : "off duty";
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

  // ---------- layout ----------

  let W = 0, H = 0, dpr = 1, S = 2, cols = 2, rows = 1, bg = null, bgKey = "";

  function topOf(ent) {
    let s = ent.s, guard = 0;
    while (s.parent_id && entities.has(s.parent_id) && guard++ < 6) s = entities.get(s.parent_id).s;
    return s.id;
  }

  function layout() {
    const now = performance.now();
    // drop finished despawns
    for (const [sid, ent] of entities) {
      if (ent.died && now - ent.died > DESPAWN_MS) { entities.delete(sid); slotOf.delete(sid); }
    }
    const tops = [], kids = new Map();
    for (const ent of entities.values()) {
      const top = topOf(ent);
      if (top === ent.id) tops.push(ent);
      else { if (!kids.has(top)) kids.set(top, []); kids.get(top).push(ent); }
    }
    const used = new Set(slotOf.values());
    for (const ent of tops) {
      if (slotOf.has(ent.id)) continue;
      let k = 0; while (used.has(k)) k++;
      slotOf.set(ent.id, k); used.add(k);
    }
    for (const sid of [...slotOf.keys()]) if (!entities.has(sid) || topOf(entities.get(sid)) !== sid) slotOf.delete(sid);
    const maxSlot = Math.max(-1, ...slotOf.values());
    const need = Math.max(1, maxSlot + 1);

    const avail = Math.max(200, roomWrap.clientWidth);
    let fit = 1;
    for (let c = 6; c >= 1; c--) if ((c * STATION_W + ROOM_PAD * 2) * 2 <= avail) { fit = c; break; }
    cols = clamp(Math.max(need, 2), 1, fit);
    rows = Math.max(1, Math.ceil(need / cols));
    const roomW = cols * STATION_W + ROOM_PAD * 2;
    const roomH = WALL_H + rows * STATION_H + ROOM_PAD;
    dpr = window.devicePixelRatio || 1;
    S = clamp(Math.floor((avail * dpr) / roomW), 1, Math.round(3 * dpr));
    fitCanvas(canvas, (roomW * S) / dpr, (roomH * S) / dpr);
    W = canvas.width; H = canvas.height;
    const key = `${cols}x${rows}`;
    if (key !== bgKey) { bg = roomBackground(cols, rows, id); bgKey = key; }
    return { tops, kids };
  }

  // ---------- render ----------

  const ctx = canvas.getContext("2d");
  let hits = [];

  function stationOrigin(slot) {
    return [ROOM_PAD + (slot % cols) * STATION_W, WALL_H + 2 + Math.floor(slot / cols) * STATION_H];
  }
  function popScale(ent, now) {
    if (ent.died) { const p = clamp((now - ent.died) / DESPAWN_MS, 0, 1); return 1 - p * p; }
    const p = clamp((now - ent.born) / SPAWN_MS, 0, 1);
    if (p >= 1) return 1;
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * (p - 1) ** 3 + c1 * (p - 1) ** 2; // easeOutBack
  }
  function poof(cx, cy, ent, now, unit) {
    const age = ent.died ? now - ent.died : now - ent.born;
    if (age < 0 || age > 450 || reduced) return;
    const p = age / 450;
    ctx.fillStyle = `rgba(243, 233, 210, ${0.85 * (1 - p)})`;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + ent.seed;
      const r = (6 + p * 14) * unit;
      const sz = Math.max(1, Math.round((3 - p * 2) * unit));
      ctx.fillRect(Math.round(cx + Math.cos(a) * r - sz / 2), Math.round(cy + Math.sin(a) * r * 0.7 - sz / 2), sz, sz);
    }
  }
  function drawSprite(persona, status, ent, dx, dy, unit, now, t) {
    // dx,dy: device px top-left of the 32x32 sprite at scale `unit` (device px per sprite px)
    const sheet = sheetFor(persona);
    const img = frameFor(sheet, status, t, ent.seed);
    const k = popScale(ent, now);
    const full = sheet.size * unit;
    if (k <= 0.01) return;
    const w = Math.round(full * k), h = Math.round(full * k);
    const base = dy + Math.round(24 / 32 * full);
    ctx.drawImage(img, Math.round(dx + (full - w) / 2), Math.round(base - (24 / 32) * h), w, h);
  }

  function frame(t) {
    if (dead) return;
    raf = requestAnimationFrame(frame);
    if (document.hidden) return;
    const now = performance.now();
    const { tops, kids } = layout();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(bg, 0, 0, bg.width * S, bg.height * S);
    hits = [];
    const bubbles = [];
    const bySlot = new Map();
    for (const ent of tops) bySlot.set(slotOf.get(ent.id), ent);
    const mini = Math.max(1, Math.round(S * 0.6));

    for (let slot = 0; slot < cols * rows; slot++) {
      const [ox, oy] = stationOrigin(slot);
      const ent = bySlot.get(slot);
      ctx.setTransform(S, 0, 0, S, 0, 0);
      drawChair(ctx, ox, oy);
      if (!ent) { drawDesk(ctx, ox, oy, { empty: true, seed: slot }); continue; }
      const s = ent.s;
      const persona = personas.get(s.persona_id) ?? { id: s.persona_id, kind: "other", name: "…" };
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const cx = (ox + CHAR_DX) * S, cy = (oy + CHAR_DY) * S;
      drawSprite(persona, s.status, ent, cx, cy, S, now, t);
      ctx.setTransform(S, 0, 0, S, 0, 0);
      const busy = BUSY.has(s.status);
      drawDesk(ctx, ox, oy, { screenOn: busy, kind: persona.kind, seed: hash32(persona.id) });
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (busy && !ent.died) {
        ctx.globalCompositeOperation = "lighter";
        ctx.fillStyle = "rgba(120, 170, 255, 0.10)";
        ctx.fillRect(cx + 9 * S, cy + 8 * S, 14 * S, 15 * S);
        ctx.globalCompositeOperation = "source-over";
      }
      poof(cx + 16 * S, cy + 14 * S, ent, now, S);
      hits.push({ x0: cx + 6 * S, y0: cy, x1: cx + 26 * S, y1: cy + 30 * S, ent, persona });
      if (s.status === "waiting" && !ent.died) drawQuestion(cx + 25 * S, cy - 2 * S + (reduced ? 0 : Math.round(Math.sin(t / 220) * 1.5) * S), S);
      if (s.status === "idle" && !ent.died && Date.now() - s.last_seen > 60_000) bubbles.push({ type: "zzz", x: cx + 24 * S, y: cy + 2 * S, t });
      if (!ent.died) bubbles.push({ type: "speech", x: cx + 16 * S, y: cy + 1 * S, s, persona, maxW: (STATION_W - 8) * S });
      bubbles.push({ type: "name", x: cx + 16 * S, y: (oy + CHAR_DY + 44) * S, persona, s });

      // subagents at the side tables
      const ks = kids.get(s.id) ?? [];
      ks.slice(0, MINI_SLOTS).forEach((kent, j) => {
        const mx = ox + 55 + (j % 2) * 20, my = oy + 4 + Math.floor(j / 2) * 30;
        const kp = personas.get(kent.s.persona_id) ?? persona;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        const sx = Math.round(mx * S + (20 * S - 32 * mini) / 2), sy = Math.round(my * S + 15 * S - 24 * mini);
        drawSprite(kp, kent.s.status, kent, sx, sy, mini, now, t);
        ctx.setTransform(S, 0, 0, S, 0, 0);
        drawMiniTable(ctx, mx, my);
        if (BUSY.has(kent.s.status)) drawMiniLaptop(ctx, mx, my + 2);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        poof(sx + 16 * mini, sy + 14 * mini, kent, now, mini);
        hits.push({ x0: mx * S, y0: sy, x1: (mx + 20) * S, y1: (my + 24) * S, ent: kent, persona: kp, parent: persona });
        if (!kent.died && kent.s.status !== "idle") bubbles.push({ type: "tag", x: mx * S + 10 * S, y: sy + 2 * mini, s: kent.s });
      });
      if (ks.length > MINI_SLOTS) bubbles.push({ type: "more", x: (ox + 75) * S, y: (oy + 66) * S, n: ks.length - MINI_SLOTS });
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (!entities.size) { ctx.fillStyle = "rgba(10, 8, 20, 0.5)"; ctx.fillRect(0, 0, W, H); } // lights off
    for (const b of bubbles.filter((b) => b.type !== "speech")) drawLabel(b);
    for (const b of bubbles.filter((b) => b.type === "speech")) drawSpeech(b);
  }

  const FONT = (px, w = 600) => `${w} ${Math.round(px * dpr)}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;

  function taskLine(s, cb) {
    if (!s.task_no) return null;
    if (isMine() && s.task_enc) {
      const tt = titleFor(id, s.task_enc, cb);
      if (typeof tt === "string" && tt) return { text: tt, mine: true };
      if (tt === undefined) return { text: `task #${s.task_no} · decrypting…` };
    }
    return { text: `task #${s.task_no}` };
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function fitText(text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    const chars = [...text];
    while (chars.length > 1 && ctx.measureText(chars.join("") + "…").width > maxW) chars.pop();
    return chars.join("") + "…";
  }

  function drawSpeech(b) {
    const s = b.s;
    const line1 = statusText(s);
    const task = taskLine(s);
    const pad = 5 * dpr, lh = 13 * dpr;
    ctx.font = FONT(11);
    const maxW = Math.min(b.maxW, 200 * dpr);
    const t1 = fitText(line1, maxW - pad * 2);
    ctx.font = FONT(10, 400);
    const t2 = task ? fitText(task.text, maxW - pad * 2) : null;
    ctx.font = FONT(11);
    let w = ctx.measureText(t1).width;
    ctx.font = FONT(10, 400);
    if (t2) w = Math.max(w, ctx.measureText(t2).width);
    w = Math.ceil(w + pad * 2);
    const h = Math.ceil(lh * (t2 ? 2 : 1) + pad * 1.4);
    const x = Math.round(clamp(b.x - w / 2, 2, W - w - 2));
    const y = Math.round(b.y - h - 7 * dpr);
    ctx.fillStyle = "rgba(20, 15, 28, 0.35)";
    roundRect(x + dpr, y + 2 * dpr, w, h, 4 * dpr); ctx.fill();
    ctx.fillStyle = s.status === "waiting" ? "#ffe9a8" : "#fff8ec";
    roundRect(x, y, w, h, 4 * dpr); ctx.fill();
    // tail
    ctx.beginPath();
    ctx.moveTo(b.x - 4 * dpr, y + h - 0.5); ctx.lineTo(b.x + 4 * dpr, y + h - 0.5); ctx.lineTo(b.x, y + h + 5 * dpr);
    ctx.closePath(); ctx.fill();
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.font = FONT(11);
    ctx.fillStyle = s.status === "tool" ? "#7a3e12" : s.status === "thinking" ? "#1f5f58" : s.status === "waiting" ? "#8a2b48" : "#5a5070";
    ctx.fillText(t1, x + pad, y + pad * 0.8);
    if (t2) {
      ctx.font = FONT(10, 400);
      ctx.fillStyle = task.mine ? "#241a2b" : "#7a7090";
      ctx.fillText(t2, x + pad, y + pad * 0.8 + lh);
    }
  }

  function drawLabel(b) {
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    if (b.type === "name") {
      ctx.font = FONT(10);
      const text = truncate(b.persona.name ?? "", 14);
      const w = ctx.measureText(text).width + 10 * dpr, h = 14 * dpr;
      ctx.fillStyle = "rgba(20, 15, 28, 0.7)";
      ctx.fillRect(Math.round(b.x - w / 2), Math.round(b.y - h / 2), Math.round(w), Math.round(h));
      ctx.fillStyle = STATUS_COLOR[b.s.status] ?? "#f3e9d2";
      ctx.fillText(text, b.x, b.y + dpr * 0.5);
    } else if (b.type === "tag") {
      ctx.font = FONT(9);
      const text = b.s.status === "tool" ? truncate(b.s.tool || "tool", 10) : b.s.status === "thinking" ? "…" : b.s.status === "waiting" ? "?" : "";
      if (!text) return;
      const w = ctx.measureText(text).width + 8 * dpr, h = 12 * dpr;
      ctx.fillStyle = "rgba(255, 248, 236, 0.92)";
      ctx.fillRect(Math.round(b.x - w / 2), Math.round(b.y - h - 2 * dpr), Math.round(w), Math.round(h));
      ctx.fillStyle = "#5a3a1a";
      ctx.fillText(text, b.x, b.y - h / 2 - 2 * dpr + dpr * 0.5);
    } else if (b.type === "zzz") {
      ctx.font = FONT(10, 700);
      ctx.fillStyle = "rgba(200, 190, 230, 0.85)";
      const ph = reduced ? 0 : (b.t / 900) % 1;
      ctx.fillText("z", b.x + ph * 6 * dpr, b.y - ph * 10 * dpr);
      ctx.fillText("z", b.x + 6 * dpr + ph * 4 * dpr, b.y - 9 * dpr - ph * 8 * dpr);
    } else if (b.type === "more") {
      ctx.font = FONT(10);
      ctx.fillStyle = "#f3e9d2";
      ctx.fillText(`+${b.n}`, b.x, b.y);
    }
  }

  // "?" pixel bubble for waiting
  const Q = ["01110", "10001", "00001", "00110", "00100", "00000", "00100"];
  function drawQuestion(x, y, u) {
    ctx.fillStyle = PAL.outline; ctx.fillRect(x - u, y - u, 9 * u, 11 * u);
    ctx.fillStyle = "#ffcf6e"; ctx.fillRect(x, y, 7 * u, 9 * u);
    ctx.fillStyle = "#241a2b";
    Q.forEach((row, ry) => [...row].forEach((c, rx) => { if (c === "1") ctx.fillRect(x + (rx + 1) * u, y + (ry + 1) * u, u, u); }));
  }

  // ---------- hover tooltip ----------

  function hitAt(px, py) {
    const x = px * dpr, y = py * dpr;
    for (let i = hits.length - 1; i >= 0; i--) {
      const h = hits[i];
      if (x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1) return h;
    }
    return null;
  }
  function showTip(h, px, py) {
    const s = h.ent.s;
    const task = taskLine(s);
    tip.replaceChildren(
      el("strong", { text: h.persona.name ?? "Agent" }),
      el("span", { class: "muted", text: h.parent ? `${kindLabel(h.persona.kind)} · subagent of ${h.parent.name}` : kindLabel(h.persona.kind) }),
      el("span", { text: statusText(s), style: `color:${STATUS_COLOR[s.status] ?? "inherit"}` }),
      task ? el("span", { class: task.mine ? "" : "muted", text: task.text }) : null,
      el("span", { class: "muted small", text: `at the desk for ${timeAgo(s.started_at)} · seen ${timeAgo(s.last_seen)} ago` }),
    );
    tip.hidden = false;
    const r = roomWrap.getBoundingClientRect();
    tip.style.left = clamp(px + 12, 4, r.width - tip.offsetWidth - 4) + "px";
    tip.style.top = clamp(py + 12, 4, Math.max(4, r.height - tip.offsetHeight - 4)) + "px";
  }
  const offsetIn = (ev) => {
    const r = canvas.getBoundingClientRect(), w = roomWrap.getBoundingClientRect();
    return { cx: ev.clientX - r.left, cy: ev.clientY - r.top, wx: ev.clientX - w.left, wy: ev.clientY - w.top };
  };
  canvas.addEventListener("pointermove", (ev) => {
    const o = offsetIn(ev);
    const h = hitAt(o.cx, o.cy);
    canvas.style.cursor = h ? "help" : "default";
    if (h) showTip(h, o.wx, o.wy); else tip.hidden = true;
  });
  canvas.addEventListener("pointerdown", (ev) => {
    if (ev.pointerType !== "touch") return;
    const o = offsetIn(ev);
    const h = hitAt(o.cx, o.cy);
    if (h) showTip(h, o.wx, o.wy); else tip.hidden = true;
  });
  canvas.addEventListener("pointerleave", () => (tip.hidden = true));

  function cleanup() {
    cancelAnimationFrame(raf);
    closeStream();
    clearInterval(statsTimer);
    clearTimeout(reloadTimer);
    clearTimeout(panelTimer);
    offOwner();
  }

  load().then(() => { if (!dead) { loadEvents(); loadStats(); } });
  frame(performance.now());

  return () => {
    dead = true;
    cleanup();
    page.remove();
  };
}
