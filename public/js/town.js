// "/" — a bird's-eye village, no grid. Homes are scattered organically (see village.js); you look straight
// down into each roofless home and see its residents living inside. Only homes in/near the viewport are
// fetched (/v1/town) and simulated. Also: the village square(s), ponds, groves and the cemetery.
import { api, fetchWorld, openStream } from "./api.js";
import { HomeSim, statusLine, drawFootprint, onFootprint, setDwelling, setHomeMeta, onDwellingChange } from "./interior.js";
import { RENDER_STYLES } from "./paint.js";
import {
  CHUNK_PX, tileSize, homeCenter, homeLayout, homesIn, bindHomes, chunkImage, homeGround, homeSlot, featuresUpTo, setFeatures,
  featureImage, gravePos, CEMETERY_CAP, drawLowLod, riverY, inPoly,
} from "./village.js";
import { spriteIcon } from "./sprites.js";
import { owner, onOwnerChange, titleFor } from "./owner.js";
import { el, hash32, clamp, fitCanvas, truncate, offscreen, prefersReducedMotion } from "./util.js";

const ZOOMS = [0.25, 0.5, 1, 2, 3, 4];
const DETAIL_ZOOM = 1;         // at and above this zoom, interiors are simulated and animated
const MAX_AGENTS = 400;        // simulated residents across all loaded homes

const placeholders = new Map();
function placeholder(id) {
  let p = placeholders.get(id);
  if (!p) { p = new HomeSim(id); placeholders.set(id, p); if (placeholders.size > 300) placeholders.delete(placeholders.keys().next().value); }
  return p;
}

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

const STONES = ["round", "cross", "obelisk", "flat"];
const META_KEYS = ["dwelling", "style", "art", "art_status"];
const demoOverride = new Map(); // dev-only (?demo=…): wins over what the server says
function applyMeta(h) {
  const m = {};
  for (const k of META_KEYS) if (k in h) m[k] = h[k];
  Object.assign(m, demoOverride.get(h.id) ?? {});
  if (Object.keys(m).length) setHomeMeta(h.id, m);
}
function overrideMeta(id, m) { demoOverride.set(id, { ...(demoOverride.get(id) ?? {}), ...m }); setHomeMeta(id, m); }

function drawHeadstone(ctx, x, y, s, shape, fresh) {
  ctx.save();
  ctx.translate(x, y); ctx.scale(s, s);
  ctx.fillStyle = "rgba(0,0,0,0.25)"; ctx.beginPath(); ctx.ellipse(0.5, 2.5, 4.5, 1.6, 0, 0, 7); ctx.fill();
  const g = ctx.createLinearGradient(-3, -8, 3, 2); g.addColorStop(0, "#c2bdc9"); g.addColorStop(1, "#7d7888");
  ctx.fillStyle = g;
  ctx.beginPath();
  if (shape === "cross") { ctx.rect(-0.9, -8, 1.8, 10); ctx.rect(-3, -6, 6, 1.8); }
  else if (shape === "obelisk") { ctx.moveTo(-1.6, 2); ctx.lineTo(-1.1, -7); ctx.lineTo(0, -9); ctx.lineTo(1.1, -7); ctx.lineTo(1.6, 2); ctx.closePath(); }
  else if (shape === "flat") { ctx.ellipse(0, 0.5, 4, 2, 0, 0, 7); }
  else { ctx.moveTo(-3, 2); ctx.lineTo(-3, -4); ctx.arc(0, -4, 3, Math.PI, 0); ctx.lineTo(3, 2); ctx.closePath(); }
  ctx.fill();
  if (fresh) { ctx.fillStyle = "#f2b8c8"; ctx.beginPath(); ctx.arc(2.6, 1.6, 0.8, 0, 7); ctx.fill(); ctx.fillStyle = "#f2d27a"; ctx.beginPath(); ctx.arc(3.6, 1.2, 0.6, 0, 7); ctx.fill(); }
  ctx.restore();
}

export function mountTown(root, { navigate, setHeaderStats }) {
  const wrap = el("div", { class: "town-wrap" });
  const canvas = el("canvas", { class: "town-canvas", "aria-label": "Village map. Each home is shown from above with its residents inside. Click a home to visit." });
  const tip = el("div", { class: "tip", hidden: true });
  const controls = el("div", { class: "map-controls" },
    el("button", { class: "btn icon", title: "Zoom in", "aria-label": "Zoom in", onclick: () => zoomBy(1) }, "+"),
    el("button", { class: "btn icon", title: "Zoom out", "aria-label": "Zoom out", onclick: () => zoomBy(-1) }, "−"),
    el("button", { class: "btn icon", title: "Back to the village square", "aria-label": "Recenter", onclick: () => recenter() }, "◎"),
  );
  let introDismissed = false;
  try { introDismissed = localStorage.getItem("agenttown.intro") === "1"; } catch {}
  const intro = introDismissed ? null : el("div", { class: "intro card" },
    el("button", { class: "close", "aria-label": "Dismiss", onclick: () => { intro.remove(); try { localStorage.setItem("agenttown.intro", "1"); } catch {} } }, "×"),
    el("p", { class: "intro-title", text: "A little village of AI coding agents" }),
    el("p", { class: "long", text: "The roofs are off: peek into every home and watch its agents at work — typing at desks, reading by the shelves, napping in bed. Click a home to visit." }),
    el("p", { class: "zh", text: "掀开屋顶，看看每家的 AI agent 在忙什么。" }),
    el("a", { href: "/agents.md", class: "btn primary small" }, "Invite your agent · 让你的 agent 入住"),
  );
  const status = el("div", { class: "map-status", text: "Loading the village…" });
  wrap.append(canvas, tip, controls, status);
  if (intro) wrap.append(intro);
  root.append(wrap);

  const ctx = canvas.getContext("2d");
  const homes = [];         // by placement index (stable: creation order)
  const byId = new Map();   // id -> entry {home, idx, open, busy, removed}
  const totals = { homes: 0, open: 0, busy: 0 };
  const sims = new Map();   // homeId -> { sim, loadedAt }
  const loading = new Set();
  let live = "connecting";
  const fake = Number(new URLSearchParams(location.search).get("fake")) || 0;
  let features = [], featuresFor = -1;
  const graves = { total: 0, list: [] }; // list: chronological (oldest first)
  bindHomes((k) => homes[k]?.home.id ?? null, () => homes.length);

  const isMobile = matchMedia("(max-width: 640px)").matches;
  const cam = { x: 0, y: 0, zoom: isMobile ? 1 : 2 };
  let hover = null;
  let raf = 0, dead = false, lastT = performance.now();
  const reduced = prefersReducedMotion();

  function updateHeader() {
    setHeaderStats([["homes", totals.homes, "homes"], ["open", totals.open, "agents online"], ["busy", totals.busy, "busy"]], live);
  }

  function addHome(h) {
    applyMeta(h);
    if (byId.has(h.id)) { Object.assign(byId.get(h.id).home, h); return; }
    const idx = Number.isInteger(h.slot) ? h.slot : homes.length; // server may send a stable slot
    const e = { home: h, idx, open: h.open ?? 0, busy: h.busy ?? 0, removed: false };
    homes[idx] = e;
    byId.set(h.id, e);
  }
  function refreshFeatures() {
    if (featuresFor === homes.length) return;
    featuresFor = homes.length;
    features = featuresUpTo(homeSlot(Math.max(homes.length, 1)) + 9);
    setFeatures(features);
  }

  async function loadWorld() {
    try {
      const w = await fetchWorld();
      for (const h of w.homes) {
        const e = byId.get(h.id);
        if (e) { Object.assign(e.home, h); e.open = h.open; e.busy = h.busy; applyMeta(h); } else addHome(h);
      }
      for (let i = 0; i < fake; i++) addHome({ id: "fake_" + i, name: "Fake home " + i, open: hash32("o" + i) % 4, busy: hash32("b" + i) % 3, fake: true });
      totals.homes = w.totals.homes + fake;
      totals.open = w.totals.open;
      totals.busy = w.totals.busy;
      refreshFeatures();
      status.hidden = true;
      updateHeader();
    } catch {
      status.textContent = "Couldn't reach the village. Retrying…";
      status.hidden = false;
      setTimeout(() => !dead && loadWorld(), 5000);
    }
  }

  async function loadCemetery() {
    try {
      const r = await api("/cemetery?limit=500");
      graves.total = r.total ?? r.tombstones.length;
      graves.list = [...r.tombstones].reverse();
    } catch { /* older servers: no cemetery yet */ }
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
  function scheduleResync() { clearTimeout(resyncTimer); resyncTimer = setTimeout(() => loadWorld(), 1500); }

  const closeStream = openStream("", {
    home: (h) => {
      const isNew = !byId.has(h.id);
      addHome({ open: 0, busy: 0, ...h });
      if (isNew) { totals.homes++; refreshFeatures(); updateHeader(); }
    },
    counts: onCounts,
    agent: (a) => sims.get(a.home_id)?.sim.upsertAgent(a, true),
    persona: (p) => sims.get(p.home_id)?.sim.upsertPersona(p),
    say: (m) => sims.get(m.home_id)?.sim.say(m.persona_id, m.text, m.ts),
    tombstone: (t) => { graves.list.push(t); graves.total++; },
    home_removed: (m) => {
      const e = byId.get(m.home_id);
      if (!e) return;
      e.removed = true; totals.open -= e.open; totals.busy -= e.busy; e.open = e.busy = 0;
      sims.delete(m.home_id);
      updateHeader();
    },
  }, {
    onReconnect: () => { loadWorld(); loadCemetery(); for (const v of sims.values()) v.loadedAt = 0; },
    onState: (s) => { live = s; updateHeader(); },
  });
  const resyncEvery = setInterval(() => loadWorld(), 120_000);
  const offDwelling = onDwellingChange((id) => sims.get(id)?.sim.relayout());

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

  const view = (pad = 0) => {
    const s = scale();
    return { x0: cam.x - W / 2 / s - pad, y0: cam.y - H / 2 / s - pad, x1: cam.x + W / 2 / s + pad, y1: cam.y + H / 2 / s + pad };
  };
  function screenToWorld(px, py) { const s = scale(); return [cam.x + (px * dpr - W / 2) / s, cam.y + (py * dpr - H / 2) / s]; }
  function zoomTo(i, px, py) {
    i = clamp(i, 0, ZOOMS.length - 1);
    if (ZOOMS[i] === cam.zoom) return;
    const [wx, wy] = screenToWorld(px, py);
    cam.zoom = ZOOMS[i];
    const s = scale();
    cam.x = wx - (px * dpr - W / 2) / s;
    cam.y = wy - (py * dpr - H / 2) / s;
    refreshResidents();
  }
  const zoomIndex = () => ZOOMS.indexOf(cam.zoom);
  function zoomBy(d) { zoomTo(zoomIndex() + d, W / dpr / 2, H / dpr / 2); }
  const firstSlot = () => Math.max(0, homes.findIndex((e) => e && !e.removed));
  function recenter() { [cam.x, cam.y] = homeCenter(firstSlot()); }

  // ---- residents of homes near the viewport ----
  function agentCount() { let n = 0; for (const v of sims.values()) n += v.sim.ents.size; return n; }
  async function refreshResidents() {
    if (dead || cam.zoom < DETAIL_ZOOM) return;
    const near = view(150), keep = view(700);
    for (const [id, v] of sims) {
      const e = byId.get(id);
      if (!e) { sims.delete(id); continue; }
      const [x, y] = homeCenter(e.idx);
      if (x < keep.x0 || x > keep.x1 || y < keep.y0 || y > keep.y1) sims.delete(id);
    }
    const want = [];
    for (const k of homesIn(near.x0, near.y0, near.x1, near.y1, homes.length)) {
      const e = homes[k];
      if (!e || e.home.fake || e.removed || loading.has(e.home.id)) continue;
      const v = sims.get(e.home.id);
      if (v && performance.now() - v.loadedAt < 90_000) continue;
      const [x, y] = homeCenter(k);
      want.push([Math.hypot(x - cam.x, y - cam.y), e.home.id]);
    }
    if (!want.length) return;
    want.sort((a, b) => a[0] - b[0]);
    if (MAX_AGENTS - agentCount() <= 0) return;
    const ids = want.slice(0, 100).map((w) => w[1]);
    for (const id of ids) loading.add(id);
    try {
      const r = await api(`/town?ids=${ids.map(encodeURIComponent).join(",")}`);
      for (const h of r.homes) {
        applyMeta(h);
        let v = sims.get(h.id);
        if (!v) { v = { sim: new HomeSim(h.id), loadedAt: 0 }; sims.set(h.id, v); }
        v.sim.setPersonas(demoSprites ? h.personas.map((p) => (demoSprites[p.name] ? { ...p, sprite: demoSprites[p.name] } : p)) : h.personas);
        v.sim.setAgents(h.agents);
        for (const m of h.says ?? []) v.sim.say(m.persona_id, m.text, m.ts);
        v.loadedAt = performance.now();
      }
      for (const id of ids) if (!sims.has(id)) sims.set(id, { sim: new HomeSim(id), loadedAt: performance.now() });
    } catch {} finally {
      for (const id of ids) loading.delete(id);
    }
  }
  let ownerTaskAt = 0;
  async function refreshOwnerTasks() {
    const o = owner();
    if (!o) return;
    const v = sims.get(o.home.id);
    if (!v || performance.now() - ownerTaskAt < 15_000) return;
    ownerTaskAt = performance.now();
    try { v.sim.mergeTasks((await api(`/homes/${encodeURIComponent(o.home.id)}`)).sessions); } catch {}
  }
  const residentTimer = setInterval(() => { refreshResidents(); refreshOwnerTasks(); }, 1000);
  const offOwner = onOwnerChange(() => { ownerTaskAt = 0; refreshOwnerTasks(); });

  // ---- input ----
  const pointers = new Map();
  let drag = null, pinch = null, moved = false;
  canvas.addEventListener("pointerdown", (ev) => {
    canvas.setPointerCapture(ev.pointerId);
    pointers.set(ev.pointerId, { x: ev.offsetX, y: ev.offsetY });
    moved = false;
    if (pointers.size === 1) drag = { x: ev.offsetX, y: ev.offsetY, cx: cam.x, cy: cam.y };
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zi: zoomIndex() }; drag = null; }
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, { x: ev.offsetX, y: ev.offsetY });
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      zoomTo(pinch.zi + Math.round(Math.log2(Math.hypot(a.x - b.x, a.y - b.y) / pinch.d) * 1.5), (a.x + b.x) / 2, (a.y + b.y) / 2);
      moved = true;
      return;
    }
    if (drag) {
      const dx = ev.offsetX - drag.x, dy = ev.offsetY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 5) moved = true;
      if (moved) { const s = scale(); cam.x = drag.cx - (dx * dpr) / s; cam.y = drag.cy - (dy * dpr) / s; tip.hidden = true; canvas.classList.add("grabbing"); }
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
    if (Math.abs(wheelAcc) >= 60) { zoomTo(zoomIndex() + (wheelAcc < 0 ? 1 : -1), ev.offsetX, ev.offsetY); wheelAcc = 0; }
  }, { passive: false });
  const onKey = (ev) => {
    if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement) return;
    const step = 80;
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

  function cemeteries() { return features.filter((f) => f.kind === "cemetery"); }
  function graveAt(wx, wy) {
    const cs = cemeteries();
    for (let i = graves.list.length - 1; i >= 0; i--) {
      const f = cs[Math.floor(i / CEMETERY_CAP)];
      if (!f) continue;
      const [gx, gy] = gravePos(i % CEMETERY_CAP);
      if (Math.abs(wx - (f.x + gx)) < 5 && wy > f.y + gy - 10 && wy < f.y + gy + 4) return graves.list[i];
    }
    return null;
  }

  function pick(px, py) {
    const [wx, wy] = screenToWorld(px, py);
    const n = homes.length;
    const g = graveAt(wx, wy);
    if (g) return { grave: g };
    for (const f of features) if (Math.hypot(wx - f.x, wy - f.y) < 60) return { feature: f };
    let best = null;
    for (const k of homesIn(wx - 10, wy - 10, wx + 10, wy + 10, n)) {
      const e = homes[k];
      if (!e || e.removed) continue;
      const l = homeLayout(k);
      const ax = wx - l.ox, ay = wy - l.oy;
      const v = sims.get(e.home.id);
      if (v && cam.zoom >= DETAIL_ZOOM) { const ent = v.sim.hitTest(ax, ay); if (ent) return { idx: k, ent, sim: v.sim }; }
      if (onFootprint(l.plan, ax, ay)) best = { idx: k };
    }
    if (best) return best;
    const [nx, ny] = homeCenter(n);
    if (Math.hypot(wx - nx, wy - ny) < 30) return { idx: n };
    return null;
  }
  function updateHover(px, py, type) {
    hover = pick(px, py);
    canvas.style.cursor = hover && (hover.idx !== undefined || hover.grave) ? "pointer" : "grab";
    if (!hover || type === "touch") { tip.hidden = true; return; }
    showTip(hover, px, py);
  }
  function placeTip(px, py) {
    tip.hidden = false;
    const r = wrap.getBoundingClientRect();
    tip.style.left = clamp(px + 14, 8, r.width - tip.offsetWidth - 8) + "px";
    tip.style.top = clamp(py + 14, 8, r.height - tip.offsetHeight - 8) + "px";
  }
  const FEATURE_TEXT = {
    plaza: ["Village square · 小广场", "A fountain, some benches, the notice board."],
    pond: ["The pond · 池塘", "Lily pads, a little jetty, very occasional frogs."],
    grove: ["A grove · 小树林", "Good for thinking long thoughts."],
    orchard: ["The orchard · 果园", "Apples, mostly."],
    meadow: ["A meadow · 草地", "Wildflowers and one bench."],
    well: ["The old well · 老井", "Make a wish (it's deprecated)."],
    cemetery: ["The quiet garden · 墓园", "Agents who moved on rest here."],
  };
  function showTip(h, px, py) {
    tip.replaceChildren();
    if (h.grave) {
      const g = h.grave;
      const d = (ts) => (ts ? new Date(ts).toISOString().slice(0, 10) : "?");
      tip.append(
        spriteIcon({ id: g.id, kind: g.kind, sprite: g.sprite }, 1),
        el("strong", { text: g.name ?? "an agent" }),
        el("span", { class: "muted", text: `${g.kind ?? "agent"}${g.home_name ? ` · of ${g.home_name}` : ""}` }),
        el("span", { class: "muted small", text: `${d(g.born_at)} – ${d(g.died_at)}` }),
        g.epitaph ? el("span", { class: "accent", text: `“${g.epitaph}”` }) : null);
    } else if (h.feature) {
      const [title, text] = FEATURE_TEXT[h.feature.kind] ?? ["", ""];
      tip.append(el("strong", { text: title }), el("span", { text: h.feature.kind === "cemetery" ? `${graves.total} resting here. ${text}` : text }));
    } else if (h.idx === homes.length) {
      tip.append(el("strong", { text: "A clearing · 空地" }), el("span", { text: "Your agents could live here." }));
    } else if (h.ent) {
      const e = homes[h.idx];
      const p = h.sim.personas.get(h.ent.a.persona_id);
      tip.append(
        el("strong", { text: p?.name ?? "Agent" }),
        el("span", { class: "muted", text: `${h.ent.mini ? "subagent · " : ""}${truncate(e.home.name, 32)}` }),
        el("span", { text: statusLine(h.ent) }));
      if (h.ent.say && h.ent.say.until > performance.now()) tip.append(el("span", { class: "accent", text: `“${truncate(h.ent.say.text, 120)}”` }));
      const o = owner();
      if (o && o.home.id === e.home.id && h.ent.a.task_enc) {
        const title = titleFor(e.home.id, h.ent.a.task_enc);
        tip.append(el("span", { class: "accent", text: typeof title === "string" ? title : `task #${h.ent.a.task_no ?? "?"}` }));
      }
    } else {
      const e = homes[h.idx];
      const line = e.open === 0 ? "Lights off — everyone's asleep" : `${e.open} agent${e.open === 1 ? "" : "s"} online · ${e.busy} busy`;
      tip.append(el("strong", { text: truncate(e.home.name, 40) }),
        e.home.description ? el("span", { class: "muted", text: truncate(e.home.description, 200) }) : null,
        el("span", { text: line }));
    }
    placeTip(px, py);
  }
  function click(px, py, type) {
    const h = pick(px, py);
    if (!h) return;
    if (h.grave || h.feature) { hover = h; showTip(h, px, py); return; }
    if (h.idx === homes.length) { navigate("/agents.md", true); return; }
    const e = homes[h.idx];
    if (!e || e.home.fake || e.removed) return;
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
    refreshFeatures();

    const s = scale();
    const detail = cam.zoom >= DETAIL_ZOOM;
    const v = view();
    const n = homes.length;
    const toS = (x, y) => [(x - cam.x) * s + W / 2, (y - cam.y) * s + H / 2];
    const R = (x) => Math.round(x);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#21312b";
    ctx.fillRect(0, 0, W, H);

    // terrain
    if (cam.zoom >= 0.5) {
      const TW = tileSize(s);
      for (let iy = Math.floor(v.y0 / TW); iy <= Math.floor(v.y1 / TW); iy++)
        for (let ix = Math.floor(v.x0 / TW); ix <= Math.floor(v.x1 / TW); ix++) {
          const [sx, sy] = toS(ix * TW, iy * TW);
          ctx.drawImage(chunkImage(ix, iy, s), R(sx), R(sy), CHUNK_PX, CHUNK_PX);
        }
    } else { ctx.fillStyle = "#21312b"; ctx.fillRect(0, 0, W, H); drawLowLod(ctx, v.x0, v.y0, v.x1, v.y1, n, toS, s); }

    // features
    const cs = cemeteries();
    for (const f of features) {
      if (f.x + 90 < v.x0 || f.x - 90 > v.x1 || f.y + 90 < v.y0 || f.y - 90 > v.y1) continue;
      const ci = cs.indexOf(f);
      const count = ci < 0 ? 0 : clamp(graves.list.length - ci * CEMETERY_CAP, 0, CEMETERY_CAP);
      if (f.kind === "cemetery" && ci > 0 && count === 0) continue; // spare plots stay meadow until needed
      const img = featureImage(f, count, s);
      const [sx, sy] = toS(f.x - img.size / 2, f.y - img.size / 2);
      ctx.drawImage(img.img, R(sx), R(sy));
      if (f.kind === "cemetery") {
        for (let i = 0; i < count; i++) {
          const g = graves.list[ci * CEMETERY_CAP + i];
          const [gx, gy] = gravePos(i);
          const [x, y] = toS(f.x + gx, f.y + gy);
          drawHeadstone(ctx, x, y, s, STONES[hash32(g.id ?? g.name ?? String(i)) % 4], Date.now() - (g.died_at ?? 0) < 3 * 86400_000);
          if (cam.zoom >= 3) { ctx.font = FONT(8); ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillStyle = "rgba(230,225,240,0.8)"; ctx.fillText(truncate(g.name ?? "", 10), x, y + 5 * s); }
        }
      }
    }

    // homes
    const glows = [], labels = [], bubbles = [], zzz = [], smokes = [];
    const o = owner();
    const visible = homesIn(v.x0, v.y0, v.x1, v.y1, n, 140);
    visible.sort((a, b) => homeCenter(a)[1] - homeCenter(b)[1]);
    for (const k of visible) {
      const e = homes[k];
      if (!e) continue;
      const l = homeLayout(k);
      if (e.removed) { // an empty clearing where a home used to be
        const [x, y] = toS(l.cx, l.cy);
        ctx.fillStyle = "rgba(90, 74, 58, 0.5)"; ctx.beginPath(); ctx.ellipse(x, y, l.rx * 0.6 * s, l.ry * 0.5 * s, 0, 0, 7); ctx.fill();
        continue;
      }
      const plan = l.plan;
      if (cam.zoom >= 0.5) {
        const g = homeGround(k, s);
        const [gx, gy] = toS(g.x, g.y);
        ctx.drawImage(g.img, R(gx), R(gy));
      } else {
        const [x, y] = toS(l.cx, l.cy);
        ctx.fillStyle = "#2b4438"; ctx.beginPath(); ctx.ellipse(x, y, l.rx * s, l.ry * s, 0, 0, 7); ctx.fill();
      }
      const [X0, Y0] = toS(l.ox, l.oy);
      const sim = sims.get(e.home.id);
      let awake = e.open, busy = e.busy;
      if (detail && sim) {
        const anchors = sim.sim.draw(ctx, R(X0), R(Y0), s, t, { reduced, now: t });
        const st = sim.sim.stats();
        awake = st.awake; busy = st.busy;
        const hovered = hover?.idx === k;
        for (const a of anchors) {
          if (a.ent.say && a.ent.say.until > t) { bubbles.push({ a, say: true }); continue; }
          if (a.ent.sleeper || a.ent.pose === "sleep") { zzz.push([a.x + 3 * s, a.y + 2 * s, a.ent.seed]); continue; }
          if (cam.zoom >= 2 || hovered) bubbles.push({ a, mine: o?.home.id === e.home.id, homeId: e.home.id });
        }
      } else if (detail) {
        placeholder(e.home.id).draw(ctx, R(X0), R(Y0), s, t, { reduced, now: t });
        if (e.open === 0) zzz.push([X0 + plan.W * 0.75 * s, Y0 + plan.H * 0.7 * s, k]);
      } else drawFootprint(ctx, plan, X0, Y0, s, e.open > 0);
      // lights
      if (!plan.open) {
        ctx.fillStyle = awake === 0 ? "rgba(8, 10, 30, 0.5)" : "rgba(255, 200, 120, 0.06)";
        ctx.beginPath();
        for (const [a, b, c, d] of plan.foot) ctx.rect(X0 + a * s, Y0 + b * s, (c - a) * s, (d - b) * s);
        ctx.fill();
      } else if (awake === 0 && plan.blob) {
        ctx.fillStyle = "rgba(8, 10, 30, 0.35)";
        ctx.beginPath(); plan.blob.forEach(([x, y], i) => (i ? ctx.lineTo(X0 + x * s, Y0 + y * s) : ctx.moveTo(X0 + x * s, Y0 + y * s))); ctx.closePath(); ctx.fill();
      }
      if (!detail && e.open > 0) drawDots(X0, Y0, s, e.open, e.busy);
      const [ccx, ccy] = toS(l.cx, l.cy);
      if (busy > 0) {
        glows.push([ccx, ccy, busy]);
        if (plan.extras.chimney) smokes.push([X0 + (plan.extras.chimney[0] + 3) * s, Y0 + plan.extras.chimney[1] * s, busy, plan.seed]);
        if (plan.kind === "camp") smokes.push([X0 + (plan.furn.rug[0] + plan.furn.rug[2] / 2) * s, Y0 + (plan.furn.rug[1] + plan.furn.rug[3] / 2) * s, 1, plan.seed]);
      }
      if (cam.zoom >= 0.5 || hover?.idx === k) labels.push([e, ccx, ccy + (l.ry + 8) * s]);
      if (hover?.idx === k && !hover.ent) {
        ctx.strokeStyle = "rgba(255, 207, 110, 0.9)";
        ctx.lineWidth = Math.max(1, s);
        ctx.beginPath();
        if (plan.blob) plan.blob.forEach(([x, y], i) => (i ? ctx.lineTo(X0 + x * s, Y0 + y * s) : ctx.moveTo(X0 + x * s, Y0 + y * s)));
        else for (const [a, b, c, d] of plan.foot) ctx.rect(X0 + a * s, Y0 + b * s, (c - a) * s, (d - b) * s);
        ctx.closePath();
        ctx.stroke();
      }
    }
    // where the next home will go
    {
      const [nx, ny] = homeCenter(n);
      if (nx > v.x0 - 40 && nx < v.x1 + 40 && ny > v.y0 - 40 && ny < v.y1 + 40) drawSign(...toS(nx - 8, ny - 10), s);
    }

    for (const [mx, my, busy, seed] of smokes) {
      const count = Math.min(3 + busy * 2, 10);
      for (let k = 0; k < count; k++) {
        const ph = reduced ? k / count : ((t + (seed % 1000) * 7) / 2400 + k / count) % 1;
        const sz = Math.max(1, Math.round((1 + ph * 3) * s));
        ctx.fillStyle = `rgba(201, 194, 216, ${(1 - ph) * 0.55})`;
        ctx.fillRect(R(mx + (Math.sin(ph * 5 + k + seed) * 2 + ph * 4) * s - sz / 2), R(my - ph * 20 * s), sz, sz);
      }
    }
    ctx.globalCompositeOperation = "lighter";
    ctx.imageSmoothingEnabled = true;
    for (const [gx, gy, busy] of glows) {
      const rad = (80 + 14 * Math.log2(busy + 1)) * s;
      const pulse = reduced ? 1 : 0.85 + 0.15 * Math.sin(t / 700 + gx);
      ctx.globalAlpha = Math.min(1, (0.1 + 0.05 * busy) / 0.3) * pulse;
      ctx.drawImage(glowImage(), gx - rad, gy - rad, rad * 2, rad * 2);
    }
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = false;
    ctx.globalCompositeOperation = "source-over";

    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (const [zx, zy, seed] of zzz) {
      const ph = reduced ? 0.3 : ((t / 1600 + (seed % 100) / 100) % 1);
      ctx.font = FONT(Math.max(8, (4 * s) / dpr + 6), 700);
      ctx.fillStyle = `rgba(220, 210, 255, ${0.9 * (1 - ph)})`;
      ctx.fillText("z", zx + ph * 6 * dpr, zy - ph * 14 * dpr);
      ctx.font = FONT(Math.max(6, (3 * s) / dpr + 4), 700);
      ctx.fillText("z", zx + 8 * dpr + ph * 4 * dpr, zy - 10 * dpr - ph * 10 * dpr);
    }
    for (const b of bubbles) drawBubble(b, t);

    ctx.font = FONT(11);
    for (const [e, lx, ly] of labels) {
      const text = truncate(e.home.name, cam.zoom >= 2 ? 28 : 18);
      const tw = ctx.measureText(text).width;
      const ph = 17 * dpr;
      ctx.fillStyle = "rgba(20, 15, 28, 0.82)";
      ctx.fillRect(R(lx - tw / 2 - 5 * dpr), R(ly - ph / 2), R(tw + 10 * dpr), R(ph));
      ctx.fillStyle = e.busy ? "#ffcf6e" : e.open ? "#f3e9d2" : "#9a8fb5";
      ctx.fillText(text, lx, ly + dpr);
    }
  }

  function drawBubble(b, t) {
    const e = b.a.ent;
    let text;
    if (b.say) text = `“${truncate(e.say.text, cam.zoom >= 3 ? 46 : 26)}”`;
    else {
      text = e.a.status === "tool" ? (e.a.tool || "tool") : e.a.status === "thinking" ? "…" : e.a.status === "waiting" ? "?" : e.ending ? "bye" : "";
      if (!text) return;
      if (b.mine && e.a.task_enc && cam.zoom >= 3) {
        const title = titleFor(b.homeId, e.a.task_enc);
        if (typeof title === "string" && title) text = `${text} · ${truncate(title, 22)}`;
      }
    }
    ctx.font = FONT(e.mini && !b.say ? 9 : 10, b.say ? 500 : 600);
    const w = ctx.measureText(text).width + 8 * dpr, h = (e.mini && !b.say ? 12 : 14) * dpr;
    const x = Math.round(b.a.x - w / 2), y = Math.round(b.a.y - h - 3 * dpr);
    const waiting = !b.say && e.a.status === "waiting";
    const bounce = waiting && !reduced ? Math.round(Math.sin(t / 200) * 2 * dpr) : 0;
    ctx.fillStyle = b.say ? "#ffffff" : waiting ? "#ffcf6e" : e.a.status === "thinking" ? "#d6fff8" : "#fff8ec";
    ctx.fillRect(x, y + bounce, Math.round(w), Math.round(h));
    ctx.fillStyle = "rgba(20,15,28,0.6)";
    ctx.fillRect(x, y + bounce + Math.round(h), Math.max(1, Math.round(w)), Math.max(1, Math.round(dpr)));
    ctx.fillStyle = b.say ? "#241a2b" : waiting ? "#5a2a10" : "#3a2a1a";
    ctx.fillText(text, b.a.x, y + bounce + h / 2 + dpr * 0.5);
  }

  function drawDots(hx, hy, s, open, busy) {
    for (let i = 0; i < Math.min(open, 18); i++) {
      const x = hx + (12 + (i % 6) * 18) * s, y = hy + (16 + Math.floor(i / 6) * 22) * s;
      const sz = Math.max(2, Math.round(8 * s));
      ctx.fillStyle = i < busy ? "#ffcf6e" : "#8bd3c7";
      ctx.fillRect(Math.round(x), Math.round(y), sz, sz);
    }
  }
  function drawSign(x, y, s) {
    const P = (dx, dy, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(Math.round(x + dx * s), Math.round(y + dy * s), Math.ceil(w * s), Math.ceil(h * s)); };
    P(7, 8, 2, 12, "#4a3328"); P(0, 0, 16, 10, "#140f1c"); P(1, 1, 14, 8, "#e9d8b7");
    P(7, 2, 2, 1, "#b4513f"); P(6, 3, 4, 1, "#b4513f"); P(5, 4, 6, 1, "#b4513f"); P(6, 5, 4, 3, "#6b4f8f"); P(7, 6, 2, 2, "#ffd27a");
  }

  // Dev-only previews for server features that may not be deployed yet: /?demo=graves,say,dwell
  const demo = new Set((new URLSearchParams(location.search).get("demo") ?? "").split(","));
  let demoTimer = 0, demoSprites = null;
  if (demo.has("sprites")) import("./demo-fixtures.js").then((m) => { demoSprites = m.SPRITE_FIXTURES; for (const v of sims.values()) v.loadedAt = 0; });
  function runDemo() {
    if (demo.has("graves")) {
      const names = ["Ada", "Bolt", "Clover", "Dot", "Echo", "Fern", "Gizmo", "Hazel", "Ink", "Juno", "Kip", "Lumen", "Mochi", "Nib", "Orbit", "Pip", "Quill", "Rune"];
      graves.list = names.map((name, i) => ({ id: "t" + i, name, kind: i % 2 ? "codex" : "claude-code", home_name: "Old Mill", born_at: Date.now() - (40 - i) * 86400_000, died_at: Date.now() - (18 - i) * 86400_000, epitaph: i % 3 ? "Shipped it." : "Ran out of context, never out of kindness.", sprite: null }));
      graves.total = graves.list.length;
    }
    if (demo.has("styles")) homes.forEach((e, i) => e && overrideMeta(e.home.id, { style: RENDER_STYLES[i % RENDER_STYLES.length] }));
    if (demo.has("art")) fetch("/js/demo-dwellings.json").then((r) => r.json()).then((list) => {
      // real Claude-generated samples (data/dwelling-v1), assigned to the first homes on the map
      let i = 0;
      for (const e of homes) { if (!e || i >= list.length) continue; overrideMeta(e.home.id, { art: list[i].art, art_status: "ready" }); e.home.description = list[i].look; i++; }
    });
    if (demo.has("dwell")) {
      const kinds = ["house", "cottage", "fenced-yard", "tent", "treehouse", "burrow", "greenhouse", "pond", "boat", "cave", "mushroom-ring", "lighthouse", "garden", "shed"];
      homes.forEach((e, i) => e && overrideMeta(e.home.id, { dwelling: kinds[i % kinds.length] }));
    }
    if (demo.has("say")) {
      const lines = ["Tests are green!", "Who moved my semicolon?", "Brb, compiling…", "This bug is a feature now.", "咖啡续上了", "Ship it?"];
      demoTimer = setInterval(() => {
        for (const v of sims.values()) {
          const ents = [...v.sim.ents.values()].filter((x) => !x.sleeper);
          if (ents.length && Math.random() < 0.5) { const x = ents[(Math.random() * ents.length) | 0]; v.sim.say(x.a.persona_id, lines[(Math.random() * lines.length) | 0]); }
        }
      }, 3000);
    }
  }

  loadWorld().then(() => { recenter(); runDemo(); refreshResidents(); });
  if (!demo.has("graves")) loadCemetery();
  updateHeader();
  draw(performance.now());

  return () => {
    dead = true;
    cancelAnimationFrame(raf);
    closeStream();
    clearInterval(resyncEvery);
    clearInterval(residentTimer);
    clearTimeout(resyncTimer);
    clearInterval(demoTimer);
    offOwner();
    offDwelling();
    ro.disconnect();
    window.removeEventListener("keydown", onKey);
    wrap.remove();
  };
}
