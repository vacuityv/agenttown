// "/" — a bird's-eye town. Every lot is a roofless home: you look straight down into the rooms and see
// its residents living inside. Homes sit on a square spiral of lots (slot = order index), so positions
// never change as the town grows. Only homes in/near the viewport are fetched (/v1/town) and simulated.
import { api, fetchWorld, openStream } from "./api.js";
import { PAL, drawTree } from "./art.js";
import { HomeSim, HOUSE_W, HOUSE_H, WALL, FRONT_DOOR, statusLine, houseBase } from "./interior.js";
import { owner, onOwnerChange, titleFor } from "./owner.js";
import { el, hash32, rng, clamp, fitCanvas, truncate, offscreen, prefersReducedMotion } from "./util.js";

// ---- square spiral: slot index <-> lot coordinates ----
export function spiralXY(i) {
  if (i === 0) return [0, 0];
  const k = Math.ceil((Math.sqrt(i + 1) - 1) / 2);
  const t = i - (2 * k - 1) ** 2;
  if (t < 2 * k) return [k, -k + 1 + t];
  if (t < 4 * k) return [k - 1 - (t - 2 * k), k];
  if (t < 6 * k) return [-k, k - 1 - (t - 4 * k)];
  return [-k + 1 + (t - 6 * k), -k];
}
export function spiralIndex(x, y) {
  const k = Math.max(Math.abs(x), Math.abs(y));
  if (k === 0) return 0;
  const base = (2 * k - 1) ** 2;
  if (x === k && y > -k) return base + (y + k - 1);
  if (y === k) return base + 2 * k + (k - 1 - x);
  if (x === -k) return base + 4 * k + (k - 1 - y);
  return base + 6 * k + (x + k - 1);
}

// Lot geometry (art px). House sits at (HX, HY) inside the lot; street along the bottom,
// a north-south street on the left edge of every 4th column.
export const LOT_W = 160, LOT_H = 124, HX = 9, HY = 6;
const ZOOMS = [0.25, 0.5, 1, 2, 3, 4];
const DETAIL_ZOOM = 1;         // at and above this zoom, interiors are simulated and animated
const MAX_AGENTS = 400;        // simulated residents across all loaded homes

const lotCache = new Map();
function lotImage(cx, cy) {
  const road = ((cx % 4) + 4) % 4 === 0;
  const v = hash32(`${cx},${cy}`) % 3;
  const key = `${road}|${v}`;
  let img = lotCache.get(key);
  if (img) return img;
  const [c, ctx] = offscreen(LOT_W, LOT_H);
  const r = rng(hash32(key));
  const R = (x, y, w, h, col) => { ctx.fillStyle = col; ctx.fillRect(x, y, w, h); };
  R(0, 0, LOT_W, LOT_H, PAL.grass);
  for (let i = 0; i < 120; i++) R((r() * LOT_W) | 0, (r() * (LOT_H - 10)) | 0, 1, 1, r() < 0.5 ? PAL.grass2 : PAL.grass3);
  for (let i = 0; i < 14; i++) R((r() * LOT_W) | 0, (r() * (LOT_H - 10)) | 0, 1, 1, r() < 0.5 ? PAL.flower : PAL.flower2);
  R(0, LOT_H - 10, LOT_W, 2, PAL.walk);
  R(0, LOT_H - 8, LOT_W, 8, PAL.road);
  for (let x = v * 3; x < LOT_W; x += 10) R(x, LOT_H - 5, 5, 1, PAL.roadLine);
  if (road) {
    R(0, 0, 7, LOT_H, PAL.road);
    R(7, 0, 2, LOT_H - 10, PAL.walk);
    for (let y = 3; y < LOT_H - 10; y += 10) R(3, y, 1, 5, PAL.roadLine);
  }
  // garden path from the front door to the sidewalk
  R(HX + WALL + FRONT_DOOR[0] - 6, HY + HOUSE_H, 12, LOT_H - 10 - HY - HOUSE_H, "#4d4660");
  lotCache.set(key, c);
  return c;
}

// Pre-rendered warm glow (drawn scaled, much cheaper than a gradient per house per frame).
let glowCanvas = null;
function glowImage() {
  if (glowCanvas) return glowCanvas;
  const [c, x] = offscreen(64, 64);
  const g = x.createRadialGradient(32, 32, 2, 32, 32, 32);
  g.addColorStop(0, "rgba(255, 180, 84, 0.3)");
  g.addColorStop(1, "rgba(255, 180, 84, 0)");
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  return (glowCanvas = c);
}

export function mountTown(root, { navigate, setHeaderStats }) {
  const wrap = el("div", { class: "town-wrap" });
  const canvas = el("canvas", { class: "town-canvas", "aria-label": "Town map. Each house is shown from above with its residents inside. Click a house to open it." });
  const tip = el("div", { class: "tip", hidden: true });
  const controls = el("div", { class: "map-controls" },
    el("button", { class: "btn icon", title: "Zoom in", "aria-label": "Zoom in", onclick: () => zoomBy(1) }, "+"),
    el("button", { class: "btn icon", title: "Zoom out", "aria-label": "Zoom out", onclick: () => zoomBy(-1) }, "−"),
    el("button", { class: "btn icon", title: "Back to the town square", "aria-label": "Recenter", onclick: () => recenter() }, "◎"),
  );
  let introDismissed = false;
  try { introDismissed = localStorage.getItem("agenttown.intro") === "1"; } catch {}
  const intro = introDismissed ? null : el("div", { class: "intro card" },
    el("button", { class: "close", "aria-label": "Dismiss", onclick: () => { intro.remove(); try { localStorage.setItem("agenttown.intro", "1"); } catch {} } }, "×"),
    el("p", { class: "intro-title", text: "A little town of AI coding agents" }),
    el("p", { class: "long", text: "The roofs are off: peek into every home and watch its agents at work — typing at desks, reading at the bookshelf, napping in bed. Click a house to visit." }),
    el("p", { class: "zh", text: "掀开屋顶，看看每家的 AI agent 在忙什么。" }),
    el("a", { href: "/agents.md", class: "btn primary small" }, "Invite your agent · 让你的 agent 入住"),
  );
  const status = el("div", { class: "map-status", text: "Loading town…" });
  wrap.append(canvas, tip, controls, status);
  if (intro) wrap.append(intro);
  root.append(wrap);

  const ctx = canvas.getContext("2d");
  const homes = [];         // slot order
  const byId = new Map();   // id -> entry {home, idx, open, busy}
  const totals = { homes: 0, open: 0, busy: 0 };
  const sims = new Map();   // homeId -> { sim, loadedAt }
  const loading = new Set();
  let live = "connecting";
  const fake = Number(new URLSearchParams(location.search).get("fake")) || 0;

  const isMobile = matchMedia("(max-width: 640px)").matches;
  const cam = { x: LOT_W / 2, y: LOT_H / 2, zoom: isMobile ? 1 : 2 };
  let hover = null; // { idx } or { idx, ent }
  let raf = 0, dead = false, lastT = performance.now();
  const reduced = prefersReducedMotion();

  function updateHeader() {
    setHeaderStats([
      ["homes", totals.homes, "homes"],
      ["open", totals.open, "agents online"],
      ["busy", totals.busy, "busy"],
    ], live);
  }

  function addHome(h) {
    if (byId.has(h.id)) { Object.assign(byId.get(h.id).home, h); return; }
    const e = { home: h, idx: homes.length, open: h.open ?? 0, busy: h.busy ?? 0 };
    homes.push(e);
    byId.set(h.id, e);
  }

  async function loadWorld() {
    try {
      const w = await fetchWorld();
      for (const h of w.homes) {
        const e = byId.get(h.id);
        if (e) { e.home.name = h.name; e.open = h.open; e.busy = h.busy; } else addHome(h);
      }
      for (let i = 0; i < fake; i++) addHome({ id: "fake_" + i, name: "Fake home " + i, open: hash32("o" + i) % 4, busy: hash32("b" + i) % 3, fake: true });
      totals.homes = w.totals.homes + fake;
      totals.open = w.totals.open;
      totals.busy = w.totals.busy;
      status.hidden = true;
      updateHeader();
    } catch {
      status.textContent = "Couldn't reach the town. Retrying…";
      status.hidden = false;
      setTimeout(() => !dead && loadWorld(), 5000);
    }
  }

  function onCounts(c) {
    const e = byId.get(c.home_id);
    if (!e) return scheduleResync();
    totals.open += c.open - e.open;
    totals.busy += c.busy - e.busy;
    e.open = c.open; e.busy = c.busy;
    updateHeader();
  }

  let resyncTimer = 0;
  function scheduleResync() {
    clearTimeout(resyncTimer);
    resyncTimer = setTimeout(() => loadWorld(), 1500);
  }

  const closeStream = openStream("", {
    home: (h) => {
      const isNew = !byId.has(h.id);
      addHome({ id: h.id, name: h.name, created_at: h.created_at, open: 0, busy: 0 });
      if (isNew) { totals.homes++; updateHeader(); }
    },
    counts: onCounts,
    agent: (a) => sims.get(a.home_id)?.sim.upsertAgent(a, true),
    persona: (p) => sims.get(p.home_id)?.sim.upsertPersona(p),
  }, {
    onReconnect: () => { loadWorld(); for (const v of sims.values()) v.loadedAt = 0; },
    onState: (s) => { live = s; updateHeader(); },
  });
  const resyncEvery = setInterval(() => loadWorld(), 120_000);

  // ---- residents of homes near the viewport ----
  function agentCount() { let n = 0; for (const v of sims.values()) n += v.sim.ents.size; return n; }

  function visibleLots(margin) {
    const s = scale();
    const ox = W / 2 - cam.x * s, oy = H / 2 - cam.y * s;
    return {
      cx0: Math.floor(-ox / (LOT_W * s)) - margin, cx1: Math.floor((W - ox) / (LOT_W * s)) + margin,
      cy0: Math.floor(-oy / (LOT_H * s)) - margin, cy1: Math.floor((H - oy) / (LOT_H * s)) + margin,
    };
  }

  async function refreshResidents() {
    if (dead) return;
    if (cam.zoom < DETAIL_ZOOM) return;
    const near = visibleLots(1), keep = visibleLots(3);
    // unload far homes
    for (const [id, v] of sims) {
      const e = byId.get(id);
      if (!e) { sims.delete(id); continue; }
      const [x, y] = spiralXY(e.idx);
      if (x < keep.cx0 || x > keep.cx1 || y < keep.cy0 || y > keep.cy1) sims.delete(id);
    }
    const want = [];
    const ccx = Math.floor(cam.x / LOT_W), ccy = Math.floor(cam.y / LOT_H);
    for (let cy = near.cy0; cy <= near.cy1; cy++) for (let cx = near.cx0; cx <= near.cx1; cx++) {
      const idx = spiralIndex(cx, cy);
      const e = homes[idx];
      if (!e || e.home.fake || loading.has(e.home.id)) continue;
      const v = sims.get(e.home.id);
      if (v && performance.now() - v.loadedAt < 90_000) continue;
      want.push([Math.abs(cx - ccx) + Math.abs(cy - ccy), e.home.id]);
    }
    if (!want.length) return;
    want.sort((a, b) => a[0] - b[0]);
    const budget = MAX_AGENTS - agentCount();
    const ids = want.slice(0, budget > 0 ? 100 : 0).map((w) => w[1]);
    if (!ids.length) return;
    for (const id of ids) loading.add(id);
    try {
      const r = await api(`/town?ids=${ids.map(encodeURIComponent).join(",")}`);
      for (const h of r.homes) {
        let v = sims.get(h.id);
        if (!v) { v = { sim: new HomeSim(h.id), loadedAt: 0 }; sims.set(h.id, v); }
        v.sim.setPersonas(h.personas);
        v.sim.setAgents(h.agents);
        v.loadedAt = performance.now();
      }
      // homes that came back empty (deleted) — remember so we don't refetch every tick
      for (const id of ids) if (!sims.has(id)) sims.set(id, { sim: new HomeSim(id), loadedAt: performance.now() });
    } catch {} finally {
      for (const id of ids) loading.delete(id);
    }
    refreshOwnerTasks();
  }
  const residentTimer = setInterval(() => { refreshResidents(); refreshOwnerTasks(); }, 1000);

  // Owner: decrypted task titles for their own home, on hover.
  let ownerTaskAt = 0;
  async function refreshOwnerTasks() {
    const o = owner();
    if (!o) return;
    const v = sims.get(o.home.id);
    if (!v || performance.now() - ownerTaskAt < 15_000) return;
    ownerTaskAt = performance.now();
    try { v.sim.mergeTasks((await api(`/homes/${encodeURIComponent(o.home.id)}`)).sessions); } catch {}
  }
  const offOwner = onOwnerChange(() => { ownerTaskAt = 0; refreshOwnerTasks(); });

  // ---- camera ----
  let W = 0, H = 0, dpr = 1;
  const scale = () => (cam.zoom >= 1 ? Math.max(1, Math.round(cam.zoom * dpr)) : cam.zoom * dpr);
  function resize() {
    const r = wrap.getBoundingClientRect();
    dpr = fitCanvas(canvas, r.width, r.height);
    W = canvas.width; H = canvas.height;
  }
  const ro = new ResizeObserver(resize);
  ro.observe(wrap);
  resize();

  function screenToWorld(px, py) {
    const s = scale();
    return [cam.x + (px * dpr - W / 2) / s, cam.y + (py * dpr - H / 2) / s];
  }
  function zoomTo(i, px, py) {
    i = clamp(i, 0, ZOOMS.length - 1);
    const z = ZOOMS[i];
    if (z === cam.zoom) return;
    const [wx, wy] = screenToWorld(px, py);
    cam.zoom = z;
    const s = scale();
    cam.x = wx - (px * dpr - W / 2) / s;
    cam.y = wy - (py * dpr - H / 2) / s;
    refreshResidents();
  }
  const zoomIndex = () => ZOOMS.indexOf(cam.zoom);
  function zoomBy(d) { zoomTo(zoomIndex() + d, W / dpr / 2, H / dpr / 2); }
  function recenter() { cam.x = LOT_W / 2; cam.y = LOT_H / 2; }

  // ---- input ----
  const pointers = new Map();
  let drag = null, pinch = null, moved = false;
  canvas.addEventListener("pointerdown", (ev) => {
    canvas.setPointerCapture(ev.pointerId);
    pointers.set(ev.pointerId, { x: ev.offsetX, y: ev.offsetY });
    moved = false;
    if (pointers.size === 1) drag = { x: ev.offsetX, y: ev.offsetY, cx: cam.x, cy: cam.y };
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zi: zoomIndex() };
      drag = null;
    }
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, { x: ev.offsetX, y: ev.offsetY });
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const ratio = Math.hypot(a.x - b.x, a.y - b.y) / pinch.d;
      zoomTo(pinch.zi + Math.round(Math.log2(ratio) * 1.5), (a.x + b.x) / 2, (a.y + b.y) / 2);
      moved = true;
      return;
    }
    if (drag) {
      const dx = ev.offsetX - drag.x, dy = ev.offsetY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 5) moved = true;
      if (moved) {
        const s = scale();
        cam.x = drag.cx - (dx * dpr) / s;
        cam.y = drag.cy - (dy * dpr) / s;
        tip.hidden = true;
        canvas.classList.add("grabbing");
      }
      return;
    }
    updateHover(ev.offsetX, ev.offsetY, ev.pointerType);
  });
  const endPointer = (ev) => {
    const single = pointers.size === 1;
    pointers.delete(ev.pointerId);
    canvas.classList.remove("grabbing");
    if (pointers.size < 2) pinch = null;
    if (ev.type === "pointerup" && single && !moved) click(ev.offsetX, ev.offsetY, ev.pointerType);
    if (pointers.size === 0) { drag = null; if (moved) refreshResidents(); }
    else if (pointers.size === 1) { const [p] = pointers.values(); drag = { x: p.x, y: p.y, cx: cam.x, cy: cam.y }; }
  };
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("pointerleave", () => { if (!drag) { hover = null; tip.hidden = true; } });
  let wheelAcc = 0;
  canvas.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    wheelAcc += ev.deltaY * (ev.deltaMode === 1 ? 30 : 1);
    if (Math.abs(wheelAcc) >= 60) {
      zoomTo(zoomIndex() + (wheelAcc < 0 ? 1 : -1), ev.offsetX, ev.offsetY);
      wheelAcc = 0;
    }
  }, { passive: false });
  const onKey = (ev) => {
    if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement) return;
    const step = LOT_W / 2;
    if (ev.key === "+" || ev.key === "=") zoomBy(1);
    else if (ev.key === "-") zoomBy(-1);
    else if (ev.key === "ArrowLeft") cam.x -= step;
    else if (ev.key === "ArrowRight") cam.x += step;
    else if (ev.key === "ArrowUp") cam.y -= step;
    else if (ev.key === "ArrowDown") cam.y += step;
    else return;
    refreshResidents();
  };
  window.addEventListener("keydown", onKey);

  function pick(px, py) {
    const [wx, wy] = screenToWorld(px, py);
    const cx = Math.floor(wx / LOT_W), cy = Math.floor(wy / LOT_H);
    const idx = spiralIndex(cx, cy);
    if (idx > homes.length) return null;
    const out = { idx };
    if (idx < homes.length) {
      const v = sims.get(homes[idx].home.id);
      if (v && cam.zoom >= DETAIL_ZOOM) {
        const ax = wx - cx * LOT_W - HX - WALL, ay = wy - cy * LOT_H - HY - WALL;
        const ent = v.sim.hitTest(ax, ay);
        if (ent) { out.ent = ent; out.sim = v.sim; }
      }
    }
    return out;
  }
  function updateHover(px, py, type) {
    hover = pick(px, py);
    canvas.style.cursor = hover && hover.idx < homes.length ? "pointer" : "grab";
    if (!hover || type === "touch") { tip.hidden = true; return; }
    showTip(hover, px, py);
  }
  function showTip(h, px, py) {
    tip.replaceChildren();
    if (h.idx === homes.length) {
      tip.append(el("strong", { text: "An empty lot · 空地" }), el("span", { text: "Your agents could live here." }));
    } else if (h.ent) {
      const e = homes[h.idx];
      const p = h.sim.personas.get(h.ent.a.persona_id);
      tip.append(
        el("strong", { text: p?.name ?? "Agent" }),
        el("span", { class: "muted", text: `${h.ent.mini ? "subagent · " : ""}${truncate(e.home.name, 32)}` }),
        el("span", { text: statusLine(h.ent) }));
      const o = owner();
      if (o && o.home.id === e.home.id && h.ent.a.task_enc) {
        const title = titleFor(e.home.id, h.ent.a.task_enc);
        tip.append(el("span", { class: "accent", text: typeof title === "string" ? title : `task #${h.ent.a.task_no ?? "?"}` }));
      } else if (h.ent.a.task_no && o?.home.id === e.home.id) tip.append(el("span", { class: "muted", text: `task #${h.ent.a.task_no}` }));
    } else {
      const e = homes[h.idx];
      const line = e.open === 0 ? "Lights off — everyone's asleep" : `${e.open} agent${e.open === 1 ? "" : "s"} online · ${e.busy} busy`;
      tip.append(el("strong", { text: truncate(e.home.name, 40) }), el("span", { text: line }));
    }
    tip.hidden = false;
    const r = wrap.getBoundingClientRect();
    tip.style.left = clamp(px + 14, 8, r.width - tip.offsetWidth - 8) + "px";
    tip.style.top = clamp(py + 14, 8, r.height - tip.offsetHeight - 8) + "px";
  }
  function click(px, py, type) {
    const h = pick(px, py);
    if (!h) return;
    if (h.idx === homes.length) { navigate("/agents.md", true); return; }
    const e = homes[h.idx];
    if (e.home.fake) return;
    if (type === "touch" && (hover?.idx !== h.idx || hover?.ent !== h.ent)) { hover = h; showTip(h, px, py); return; }
    navigate(`/h/${e.home.id}`);
  }

  // ---- render ----
  const FONT = (px, w = 600) => `${w} ${Math.round(px * dpr)}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;

  function draw(t) {
    if (dead) return;
    raf = requestAnimationFrame(draw);
    const dt = Math.min(0.1, (t - lastT) / 1000);
    lastT = t;
    if (document.hidden) return;
    for (const v of sims.values()) v.sim.update(dt, t);

    const s = scale();
    const detail = cam.zoom >= DETAIL_ZOOM;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#132620";
    ctx.fillRect(0, 0, W, H);
    const ox = Math.round(W / 2 - cam.x * s), oy = Math.round(H / 2 - cam.y * s);
    const lw = LOT_W * s, lh = LOT_H * s;
    const cx0 = Math.floor(-ox / lw), cx1 = Math.floor((W - ox) / lw);
    const cy0 = Math.floor(-oy / lh), cy1 = Math.floor((H - oy) / lh);
    const n = homes.length;
    const townRing = n ? Math.max(...spiralXY(n).map(Math.abs)) : 0;
    const glows = [], labels = [], bubbles = [], zzz = [];
    const o = owner();

    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const idx = spiralIndex(cx, cy);
        const sx = ox + cx * lw, sy = oy + cy * lh;
        ctx.drawImage(lotImage(cx, cy), Math.round(sx), Math.round(sy), Math.ceil(lw), Math.ceil(lh));
        const hx = sx + HX * s, hy = sy + HY * s;
        if (idx < n) {
          const e = homes[idx];
          const v = sims.get(e.home.id);
          const X0 = hx + WALL * s, Y0 = hy + WALL * s;
          let awake = e.open, busy = e.busy;
          if (detail && v) {
            const anchors = v.sim.draw(ctx, X0, Y0, s, t, { reduced, now: t });
            const st = v.sim.stats();
            awake = st.awake; busy = st.busy;
            const hovered = hover?.idx === idx;
            for (const a of anchors) {
              if (a.ent.sleeper || a.ent.pose === "sleep") { zzz.push([a.x + 3 * s, a.y + 2 * s, a.ent.seed]); continue; }
              if (cam.zoom >= 2 || hovered) bubbles.push({ a, mine: o?.home.id === e.home.id, homeId: e.home.id });
            }
          } else {
            ctx.drawImage(houseBase(detail ? e.home.id : "v" + (hash32(e.home.id) % 12), 3, 2), Math.round(hx), Math.round(hy), Math.round(HOUSE_W * s), Math.round(HOUSE_H * s));
            if (e.open === 0 && detail) zzz.push([hx + 110 * s, hy + 60 * s, idx]);
          }
          if (awake === 0) { // lights off
            ctx.fillStyle = "rgba(8, 10, 30, 0.5)";
            ctx.fillRect(Math.round(hx), Math.round(hy), Math.round(HOUSE_W * s), Math.round(HOUSE_H * s));
          } else {
            ctx.fillStyle = "rgba(255, 200, 120, 0.06)";
            ctx.fillRect(Math.round(hx), Math.round(hy), Math.round(HOUSE_W * s), Math.round(HOUSE_H * s));
          }
          if (!detail && e.open > 0) drawDots(hx, hy, s, e.open, e.busy);
          if (busy > 0) glows.push([hx + (HOUSE_W / 2) * s, hy + (HOUSE_H / 2) * s, busy]);
          if (cam.zoom >= 0.5 || hover?.idx === idx) labels.push([e, sx + (LOT_W / 2) * s, sy + (LOT_H - 14) * s]);
          if (hover?.idx === idx && !hover.ent) {
            ctx.strokeStyle = "rgba(255, 207, 110, 0.9)";
            ctx.lineWidth = Math.max(1, s);
            ctx.strokeRect(Math.round(hx), Math.round(hy), Math.round(HOUSE_W * s), Math.round(HOUSE_H * s));
          }
        } else if (idx === n) {
          drawSign(sx + 70 * s, sy + 44 * s, s);
        } else {
          const ring = Math.max(Math.abs(cx), Math.abs(cy));
          const h = hash32(`${cx}:${cy}`);
          const trees = ring <= townRing + 1 ? 1 + (h % 2) : 3 + (h % 4);
          for (let k = 0; k < trees; k++) {
            const tx = 10 + ((h >>> (k * 4 + 1)) % 130), ty = 4 + ((h >>> (k * 5 + 3)) % 90);
            drawTree(ctx, Math.round(sx + tx * s), Math.round(sy + ty * s), s);
          }
        }
      }
    }

    ctx.globalCompositeOperation = "lighter";
    ctx.imageSmoothingEnabled = true;
    for (const [gx, gy, busy] of glows) {
      const rad = (70 + 14 * Math.log2(busy + 1)) * s;
      const pulse = reduced ? 1 : 0.85 + 0.15 * Math.sin(t / 700 + gx);
      ctx.globalAlpha = Math.min(1, (0.1 + 0.05 * busy) / 0.3) * pulse;
      ctx.drawImage(glowImage(), gx - rad, gy - rad, rad * 2, rad * 2);
    }
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = false;
    ctx.globalCompositeOperation = "source-over";

    // Zzz over sleepers
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (const [zx, zy, seed] of zzz) {
      const ph = reduced ? 0.3 : ((t / 1600 + (seed % 100) / 100) % 1);
      ctx.font = FONT(Math.max(8, 4 * s / dpr + 6), 700);
      ctx.fillStyle = `rgba(220, 210, 255, ${0.9 * (1 - ph)})`;
      ctx.fillText("z", zx + ph * 6 * dpr, zy - ph * 14 * dpr);
      ctx.font = FONT(Math.max(6, 3 * s / dpr + 4), 700);
      ctx.fillText("z", zx + 8 * dpr + ph * 4 * dpr, zy - 10 * dpr - ph * 10 * dpr);
    }
    for (const b of bubbles) drawBubble(b, t);

    // home name plates
    ctx.font = FONT(11);
    for (const [e, lx, ly] of labels) {
      const text = truncate(e.home.name, cam.zoom >= 2 ? 28 : 18);
      const tw = ctx.measureText(text).width;
      const ph = 11 * dpr + 6 * dpr;
      ctx.fillStyle = "rgba(20, 15, 28, 0.82)";
      ctx.fillRect(Math.round(lx - tw / 2 - 5 * dpr), Math.round(ly - ph / 2), Math.round(tw + 10 * dpr), Math.round(ph));
      ctx.fillStyle = e.busy ? "#ffcf6e" : e.open ? "#f3e9d2" : "#9a8fb5";
      ctx.fillText(text, lx, ly + dpr);
    }
  }

  function drawBubble(b, t) {
    const e = b.a.ent;
    let text = e.a.status === "tool" ? (e.a.tool || "tool") : e.a.status === "thinking" ? "…" : e.a.status === "waiting" ? "?" : e.ending ? "bye" : "";
    if (!text) return;
    if (b.mine && e.a.task_enc && cam.zoom >= 3) {
      const title = titleFor(b.homeId, e.a.task_enc);
      if (typeof title === "string" && title) text = `${text} · ${truncate(title, 22)}`;
    }
    ctx.font = FONT(e.mini ? 9 : 10);
    const w = ctx.measureText(text).width + 8 * dpr, h = (e.mini ? 12 : 14) * dpr;
    const x = Math.round(b.a.x - w / 2), y = Math.round(b.a.y - h - 3 * dpr);
    const waiting = e.a.status === "waiting";
    const bounce = waiting && !reduced ? Math.round(Math.sin(t / 200) * 2 * dpr) : 0;
    ctx.fillStyle = waiting ? "#ffcf6e" : e.a.status === "thinking" ? "#d6fff8" : "#fff8ec";
    ctx.fillRect(x, y + bounce, Math.round(w), Math.round(h));
    ctx.fillStyle = "rgba(20,15,28,0.6)";
    ctx.fillRect(x, y + bounce + Math.round(h), Math.round(w), Math.max(1, Math.round(dpr)));
    ctx.fillStyle = waiting ? "#5a2a10" : "#3a2a1a";
    ctx.fillText(text, b.a.x, y + bounce + h / 2 + dpr * 0.5);
  }

  function drawDots(hx, hy, s, open, busy) {
    const cols = 6;
    for (let i = 0; i < Math.min(open, 18); i++) {
      const x = hx + (16 + (i % cols) * 18) * s, y = hy + (24 + Math.floor(i / cols) * 22) * s;
      const sz = Math.max(2, Math.round(8 * s));
      ctx.fillStyle = i < busy ? "#ffcf6e" : "#8bd3c7";
      ctx.fillRect(Math.round(x), Math.round(y), sz, sz);
    }
  }

  function drawSign(x, y, s) {
    const P = (dx, dy, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(Math.round(x + dx * s), Math.round(y + dy * s), Math.ceil(w * s), Math.ceil(h * s)); };
    P(7, 8, 2, 12, PAL.trunk);
    P(0, 0, 16, 10, PAL.outline);
    P(1, 1, 14, 8, "#e9d8b7");
    P(7, 2, 2, 1, "#b4513f"); P(6, 3, 4, 1, "#b4513f"); P(5, 4, 6, 1, "#b4513f");
    P(6, 5, 4, 3, "#6b4f8f"); P(7, 6, 2, 2, PAL.winLit);
  }

  loadWorld().then(refreshResidents);
  updateHeader();
  draw(performance.now());

  return () => {
    dead = true;
    cancelAnimationFrame(raf);
    closeStream();
    clearInterval(resyncEvery);
    clearInterval(residentTimer);
    clearTimeout(resyncTimer);
    offOwner();
    ro.disconnect();
    window.removeEventListener("keydown", onKey);
    wrap.remove();
  };
}
