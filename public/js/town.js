// "/" — the town overview. Homes sit on a square spiral of lots (slot = order index), so a home's
// position never changes as the town grows. Only lots inside the viewport are drawn.
import { fetchWorld, openStream } from "./api.js";
import { CELL, HOUSE_W, HOUSE_H, PAL, houseImage, lotImage, drawTree, chimneyOf } from "./art.js";
import { el, hash32, clamp, fitCanvas, truncate, prefersReducedMotion } from "./util.js";

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

const ZOOMS = [1, 2, 3, 4, 5, 6];

export function mountTown(root, { navigate, setHeaderStats }) {
  const wrap = el("div", { class: "town-wrap" });
  const canvas = el("canvas", { class: "town-canvas", "aria-label": "Town map. Click a house to enter it." });
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
    el("p", { class: "long", text: "Every house is someone's Home. Lit windows mean their agents are at their desks; smoke means they're busy right now. Click a house to peek inside." }),
    el("p", { class: "zh", text: "每栋小房子里，都有正在敲代码的 AI agent。" }),
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
  let live = "connecting";
  const fake = Number(new URLSearchParams(location.search).get("fake")) || 0;

  const isMobile = matchMedia("(max-width: 640px)").matches;
  const cam = { x: CELL / 2, y: CELL / 2, zoom: isMobile ? 2 : 3 };
  let hover = -1;
  let raf = 0, dead = false;
  const reduced = prefersReducedMotion();

  function updateHeader() {
    setHeaderStats([
      ["homes", totals.homes, "homes"],
      ["open", totals.open, "agents online"],
      ["busy", totals.busy, "busy"],
    ], live);
  }

  function addHome(h) {
    if (byId.has(h.id)) { byId.get(h.id).home = h; return; }
    const e = { home: h, idx: homes.length, open: h.open ?? 0, busy: h.busy ?? 0 };
    homes.push(e);
    byId.set(h.id, e);
  }

  async function loadWorld() {
    try {
      const w = await fetchWorld();
      homes.length = 0; byId.clear();
      for (const h of w.homes) addHome(h);
      for (let i = 0; i < fake; i++) addHome({ id: "fake_" + i, name: "Fake home " + i, open: hash32("o" + i) % 4, busy: hash32("b" + i) % 3, fake: true });
      totals.homes = w.totals.homes + fake;
      totals.open = w.totals.open + homes.slice(w.homes.length).reduce((a, e) => a + e.open, 0);
      totals.busy = w.totals.busy + homes.slice(w.homes.length).reduce((a, e) => a + e.busy, 0);
      status.hidden = true;
      updateHeader();
    } catch (e) {
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
  }, {
    onReconnect: () => loadWorld(),
    onState: (s) => { live = s; updateHeader(); },
  });
  const resyncEvery = setInterval(() => loadWorld(), 120_000);

  // ---- camera ----
  let W = 0, H = 0, dpr = 1;
  const scale = () => Math.max(1, Math.round(cam.zoom * dpr));
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
  function zoomAt(newZoom, px, py) {
    newZoom = clamp(newZoom, ZOOMS[0], ZOOMS[ZOOMS.length - 1]);
    if (newZoom === cam.zoom) return;
    const [wx, wy] = screenToWorld(px, py);
    cam.zoom = newZoom;
    const s = scale();
    cam.x = wx - (px * dpr - W / 2) / s;
    cam.y = wy - (py * dpr - H / 2) / s;
  }
  function zoomBy(d) { zoomAt(cam.zoom + d, W / dpr / 2, H / dpr / 2); }
  function recenter() { cam.x = CELL / 2; cam.y = CELL / 2; }

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
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: cam.zoom };
      drag = null;
    }
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, { x: ev.offsetX, y: ev.offsetY });
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const target = Math.round(pinch.zoom * (d / pinch.d));
      zoomAt(target, (a.x + b.x) / 2, (a.y + b.y) / 2);
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
    const wasDrag = drag && moved;
    const single = pointers.size === 1;
    pointers.delete(ev.pointerId);
    canvas.classList.remove("grabbing");
    if (pointers.size < 2) pinch = null;
    if (ev.type === "pointerup" && single && !moved) click(ev.offsetX, ev.offsetY, ev.pointerType);
    if (pointers.size === 0) drag = null;
    else if (pointers.size === 1) { const [p] = pointers.values(); drag = { x: p.x, y: p.y, cx: cam.x, cy: cam.y }; }
    if (wasDrag) moved = true;
  };
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("pointerleave", () => { if (!drag) { hover = -1; tip.hidden = true; } });
  let wheelAcc = 0;
  canvas.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    wheelAcc += ev.deltaY * (ev.deltaMode === 1 ? 30 : 1);
    if (Math.abs(wheelAcc) >= 60) {
      zoomAt(cam.zoom + (wheelAcc < 0 ? 1 : -1), ev.offsetX, ev.offsetY);
      wheelAcc = 0;
    }
  }, { passive: false });
  const onKey = (ev) => {
    if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement) return;
    const step = CELL / 2;
    if (ev.key === "+" || ev.key === "=") zoomBy(1);
    else if (ev.key === "-") zoomBy(-1);
    else if (ev.key === "ArrowLeft") cam.x -= step;
    else if (ev.key === "ArrowRight") cam.x += step;
    else if (ev.key === "ArrowUp") cam.y -= step;
    else if (ev.key === "ArrowDown") cam.y += step;
  };
  window.addEventListener("keydown", onKey);

  function lotAt(px, py) {
    const [wx, wy] = screenToWorld(px, py);
    const cx = Math.floor(wx / CELL), cy = Math.floor(wy / CELL);
    return spiralIndex(cx, cy);
  }
  function updateHover(px, py, type) {
    const idx = lotAt(px, py);
    hover = idx < homes.length || idx === homes.length ? idx : -1;
    canvas.style.cursor = idx < homes.length ? "pointer" : "grab";
    if (hover < 0 || type === "touch") { tip.hidden = true; return; }
    showTip(hover, px, py);
  }
  function showTip(idx, px, py) {
    tip.replaceChildren();
    if (idx === homes.length) {
      tip.append(el("strong", { text: "An empty lot · 空地" }), el("span", { text: "Your agents could live here." }));
    } else {
      const e = homes[idx];
      const line = e.open === 0 ? "Lights off — nobody home" : `${e.open} agent${e.open === 1 ? "" : "s"} online · ${e.busy} busy`;
      tip.append(el("strong", { text: truncate(e.home.name, 40) }), el("span", { text: line }));
    }
    tip.hidden = false;
    const r = wrap.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = clamp(px + 14, 8, r.width - tw - 8) + "px";
    tip.style.top = clamp(py + 14, 8, r.height - th - 8) + "px";
  }
  function click(px, py, type) {
    const idx = lotAt(px, py);
    if (idx === homes.length) { navigate("/agents.md", true); return; }
    if (idx >= homes.length) return;
    const e = homes[idx];
    if (e.home.fake) return;
    if (type === "touch" && hover !== idx) {
      // first tap shows the label, second tap enters
      hover = idx; showTip(idx, px, py); return;
    }
    navigate(`/h/${e.home.id}`);
  }

  // ---- render ----
  function draw(t) {
    if (dead) return;
    raf = requestAnimationFrame(draw);
    if (document.hidden) return;
    const s = scale();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#132620";
    ctx.fillRect(0, 0, W, H);
    const ox = Math.round(W / 2 - cam.x * s), oy = Math.round(H / 2 - cam.y * s);
    const cs = CELL * s;
    const cx0 = Math.floor(-ox / cs), cx1 = Math.floor((W - ox) / cs);
    const cy0 = Math.floor(-oy / cs), cy1 = Math.floor((H - oy) / cs);
    const n = homes.length;
    const townRing = n ? Math.max(...spiralXY(n).map(Math.abs)) : 0;
    const glows = [], smokes = [], labels = [], lamps = [];

    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const idx = spiralIndex(cx, cy);
        const ring = Math.max(Math.abs(cx), Math.abs(cy));
        const sx = ox + cx * cs, sy = oy + cy * cs;
        const isHome = idx < n;
        const inTown = ring <= townRing + 1;
        ctx.drawImage(lotImage(cx, cy, isHome ? 0 : 1), sx, sy, cs, cs);
        if (((cx % 4) + 4) % 4 === 0) lamps.push([sx + 8 * s, sy + (CELL - 12) * s]);
        if (isHome) {
          const e = homes[idx];
          const lit = e.open > 0;
          const hx = sx + 8 * s, hy = sy + 8 * s;
          if (e.busy > 0) glows.push([hx + (HOUSE_W / 2) * s, hy + (HOUSE_H / 2) * s, e.busy]);
          ctx.drawImage(houseImage(e.home.id, lit ? 1 : 0), hx, hy, HOUSE_W * s, HOUSE_H * s);
          if (lit) {
            // window light spilling onto the lawn
            ctx.fillStyle = "rgba(255, 210, 122, 0.10)";
            ctx.fillRect(hx + 4 * s, hy + (HOUSE_H) * s, (HOUSE_W - 8) * s, 3 * s);
          }
          if (e.busy > 0) smokes.push([e, hx, hy]);
          if (cam.zoom >= 3 || idx === hover) labels.push([e, sx + (CELL / 2) * s, sy + (CELL - 9) * s]);
        } else if (idx === n) {
          drawSign(ctx, sx + 20 * s, sy + 18 * s, s);
        } else {
          const h = hash32(`${cx}:${cy}`);
          const trees = inTown ? (h % 5 === 0 ? 1 : 0) : 1 + (h % 3);
          for (let k = 0; k < trees; k++) {
            const tx = 6 + ((h >>> (k * 5 + 3)) % 34), ty = 2 + ((h >>> (k * 7 + 1)) % 26);
            drawTree(ctx, sx + tx * s, sy + ty * s, s);
          }
        }
        if (idx === hover && idx <= n) {
          ctx.strokeStyle = "rgba(255, 207, 110, 0.8)";
          ctx.lineWidth = Math.max(1, s / 2);
          ctx.strokeRect(sx + 2 * s, sy + 2 * s, cs - 4 * s, cs - 12 * s);
        }
      }
    }

    // warm glow for busy homes (scales with busy count)
    ctx.globalCompositeOperation = "lighter";
    for (const [gx, gy, busy] of glows) {
      const rad = (26 + 8 * Math.log2(busy + 1)) * s;
      const pulse = reduced ? 1 : 0.85 + 0.15 * Math.sin(t / 700 + gx);
      const a = Math.min(0.42, 0.16 + 0.07 * busy) * pulse;
      const g = ctx.createRadialGradient(gx, gy, 2 * s, gx, gy, rad);
      g.addColorStop(0, `rgba(255, 180, 84, ${a})`);
      g.addColorStop(1, "rgba(255, 180, 84, 0)");
      ctx.fillStyle = g;
      ctx.fillRect(gx - rad, gy - rad, rad * 2, rad * 2);
    }
    for (const [lx, ly] of lamps) {
      const rad = 12 * s;
      const g = ctx.createRadialGradient(lx, ly, 0, lx, ly, rad);
      g.addColorStop(0, "rgba(255, 207, 110, 0.18)");
      g.addColorStop(1, "rgba(255, 207, 110, 0)");
      ctx.fillStyle = g;
      ctx.fillRect(lx - rad, ly - rad, rad * 2, rad * 2);
    }
    ctx.globalCompositeOperation = "source-over";
    for (const [lx, ly] of lamps) {
      ctx.fillStyle = PAL.outline; ctx.fillRect(lx - s, ly - 8 * s, 2 * s, 9 * s);
      ctx.fillStyle = PAL.lamp; ctx.fillRect(lx - s, ly - 10 * s, 2 * s, 2 * s);
    }

    // chimney smoke: deterministic puffs drifting up; more and faster when busier
    for (const [e, hx, hy] of smokes) {
      const ch = chimneyOf(e.home.id);
      const count = Math.min(3 + e.busy * 2, 12);
      const speed = 2600 / Math.min(1 + e.busy * 0.3, 2.5);
      const seed = hash32(e.home.id) % 1000;
      for (let k = 0; k < count; k++) {
        const ph = reduced ? k / count : ((t + seed * 7) / speed + k / count) % 1;
        const px = hx + (ch.x + Math.sin(ph * 5 + k + seed) * 2.2 + ph * 3) * s;
        const py = hy + (ch.y - ph * 18) * s;
        const sz = Math.max(1, Math.round((1 + ph * 3) * s));
        ctx.fillStyle = `rgba(201, 194, 216, ${(1 - ph) * 0.6})`;
        ctx.fillRect(Math.round(px - sz / 2), Math.round(py - sz / 2), sz, sz);
      }
    }

    // name labels (screen-space text)
    const fs = Math.round(11 * dpr);
    ctx.font = `600 ${fs}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const [e, lx, ly] of labels) {
      const text = truncate(e.home.name, cam.zoom >= 4 ? 24 : 16);
      const tw = ctx.measureText(text).width;
      const ph = fs + 6 * dpr;
      ctx.fillStyle = "rgba(20, 15, 28, 0.78)";
      ctx.fillRect(Math.round(lx - tw / 2 - 5 * dpr), Math.round(ly - ph / 2), Math.round(tw + 10 * dpr), Math.round(ph));
      ctx.fillStyle = e.busy ? "#ffcf6e" : e.open ? "#f3e9d2" : "#9a8fb5";
      ctx.fillText(text, lx, ly + dpr);
    }
  }
  draw(performance.now());

  function drawSign(ctx, x, y, s) {
    const P = (dx, dy, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(x + dx * s, y + dy * s, w * s, h * s); };
    P(7, 8, 2, 12, PAL.trunk);
    P(0, 0, 16, 10, PAL.outline);
    P(1, 1, 14, 8, "#e9d8b7");
    // tiny house glyph: "a home could go here"
    P(7, 2, 2, 1, "#b4513f");
    P(6, 3, 4, 1, "#b4513f");
    P(5, 4, 6, 1, "#b4513f");
    P(6, 5, 4, 3, "#6b4f8f");
    P(7, 6, 2, 2, PAL.winLit);
  }

  loadWorld();
  updateHeader();

  return () => {
    dead = true;
    cancelAnimationFrame(raf);
    closeStream();
    clearInterval(resyncEvery);
    clearTimeout(resyncTimer);
    ro.disconnect();
    window.removeEventListener("keydown", onKey);
    wrap.remove();
  };
}
