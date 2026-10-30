// Shared top-down home interior: a per-home floor plan + furniture + residents who walk between
// activity spots. Used by the town (every lot is a roofless cutaway) and by /h/:id (same renderer, bigger).
//
// Every home gets its own deterministic plan from hash(home id): room sizes, a staggered (L/step-shaped)
// footprint, mirrored layouts, wall & floor materials, porches, bay windows, sunrooms, chimneys and small
// odd details. The four activity areas always exist: office (desks), study (bookshelf, terminal, writing
// table, MCP crates), living room (sofa, radio, front door) and bedroom (beds).
//
// Coordinates are "interior art px": (0,0) = top-left of the rooms' bounding box (outer walls sit at -3).
// Characters are 32x32 sprites drawn at half size (16 art px) — the classic pixel-RPG look.
import { sheetFor, frameFor, posesFor } from "./sprites.js";
import { lookFor, drawV2 } from "./creatures.js";
import { hash32, rng, offscreen, clamp, BUSY } from "./util.js";
import { shade } from "./art.js";
import { RENDER_STYLES, isRenderStyle, styledCanvas } from "./paint.js";
import { svgRaster, sharedDefs } from "./creatures.js";

export const WALL = 3;
export const IDLE_SLEEP_MS = 3 * 60_000;
const PAD = 12;          // room around the walls in the cached base image (porch, bay, annex, chimney)
const K = 0.5;           // sprite px -> art px
const MINI = 0.6;        // subagent size
const WALK = 26, RUN = 46; // art px / s
const SPAWN_MS = 380, POP_MS = 420;
const O = "#140f1c";

const TOOL_SPOT = {
  Bash: "bench", Read: "shelf", Grep: "shelf", Glob: "shelf", LS: "shelf",
  Edit: "write", Write: "write", MultiEdit: "write", NotebookEdit: "write", apply_patch: "write",
  WebFetch: "radio", WebSearch: "radio", MCP: "mcp", Task: "agent", Agent: "agent",
};
import { t as tr } from "./i18n.js";
// Localized name of an activity spot ("desk", "bookshelf", …).
export const spotLabel = (kind) => (kind ? tr(`spot.${kind}`) : "");

// ---------- seasons (a few touches follow the calendar) ----------
export function season(d = new Date()) {
  const m = d.getMonth(), day = d.getDate();
  if ((m === 9 && day >= 15) || (m === 10 && day <= 3)) return "halloween";
  if (m === 11 || (m === 0 && day <= 6)) return "winter";
  if (m >= 2 && m <= 4) return "spring";
  if (m >= 8 && m <= 10) return "autumn";
  return "summer";
}

// ---------- materials ----------

const WALLS = [
  { name: "plaster", c: "#e2d3b5", d: "#c9b896" },
  { name: "brick", c: "#b0634a", d: "#8a4a36" },
  { name: "stone", c: "#a7a3ad", d: "#86828e" },
  { name: "timber", c: "#7a5638", d: "#5e4029" },
  { name: "whitewash", c: "#d6dee6", d: "#b4bfca" },
  { name: "sage", c: "#b9c7a5", d: "#97a785" },
];
const FLOORS = ["oak", "walnut", "pine", "tatami", "stone", "terracotta", "parquet", "checker", "carpet"];
const CARPETS = ["#5a4a78", "#4a6a6a", "#7a4a5a", "#4a5a7a", "#6a5a3a", "#3f5a4a"];

function drawFloor(c, kind, x, y, w, h, r, tint) {
  const R = (a, b, ww, hh, col) => { c.fillStyle = col; c.fillRect(a, b, ww, hh); };
  if (kind === "oak" || kind === "walnut" || kind === "pine") {
    const base = kind === "oak" ? ["#8a6648", "#7c5a3f"] : kind === "walnut" ? ["#6a4a36", "#5e412f"] : ["#b08a5a", "#a27e50"];
    for (let yy = 0; yy < h; yy += 4) {
      R(x, y + yy, w, Math.min(4, h - yy), (yy / 4) % 2 ? base[0] : base[1]);
      for (let xx = ((yy / 4) * 11) % 24; xx < w; xx += 24) R(x + xx, y + yy, 1, Math.min(4, h - yy), shade(base[1], -0.2));
    }
  } else if (kind === "tatami") {
    R(x, y, w, h, "#c8c08a");
    for (let yy = 0; yy < h; yy += 8) for (let xx = ((yy / 8) % 2) * 8; xx < w; xx += 16) {
      c.strokeStyle = "#8f8752"; c.lineWidth = 1; c.strokeRect(x + xx + 0.5, y + yy + 0.5, Math.min(16, w - xx) - 1, Math.min(8, h - yy) - 1);
    }
  } else if (kind === "stone") {
    for (let yy = 0; yy < h; yy += 6) for (let xx = (yy / 6) % 2 ? -3 : 0; xx < w; xx += 6) {
      R(x + Math.max(0, xx), y + yy, Math.min(6, w - Math.max(0, xx)), Math.min(6, h - yy), r() < 0.5 ? "#8e8a96" : "#9a96a2");
      R(x + Math.max(0, xx), y + yy, Math.min(6, w - Math.max(0, xx)), 1, "#76727e");
    }
  } else if (kind === "terracotta") {
    for (let yy = 0; yy < h; yy += 6) for (let xx = 0; xx < w; xx += 6) {
      R(x + xx, y + yy, Math.min(6, w - xx), Math.min(6, h - yy), ((xx + yy) / 6) % 2 ? "#b8704a" : "#ac6642");
      R(x + xx, y + yy, Math.min(6, w - xx), 1, "#8a4f33"); R(x + xx, y + yy, 1, Math.min(6, h - yy), "#8a4f33");
    }
  } else if (kind === "parquet") {
    for (let yy = 0; yy < h; yy += 4) for (let xx = 0; xx < w; xx += 4) {
      const v = ((xx + yy) / 4) % 2;
      R(x + xx, y + yy, Math.min(4, w - xx), Math.min(4, h - yy), v ? "#9a7350" : "#8a6545");
      if (v) R(x + xx, y + yy + 2, Math.min(4, w - xx), 1, "#7a583a"); else R(x + xx + 2, y + yy, 1, Math.min(4, h - yy), "#7a583a");
    }
  } else if (kind === "checker") {
    for (let yy = 0; yy < h; yy += 6) for (let xx = 0; xx < w; xx += 6) R(x + xx, y + yy, Math.min(6, w - xx), Math.min(6, h - yy), ((xx + yy) / 6) % 2 ? "#e8e0d0" : "#4a4458");
  } else if (kind === "dirt" || kind === "straw") {
    R(x, y, w, h, kind === "straw" ? "#a8884a" : "#7a5a3c");
    for (let i = 0; i < (w * h) / 14; i++) R(x + ((r() * w) | 0), y + ((r() * h) | 0), 1, 1, kind === "straw" ? (r() < 0.5 ? "#c9a85a" : "#8a6a3a") : (r() < 0.5 ? "#8a6a4a" : "#5e4430"));
  } else if (kind === "deck") {
    for (let yy = 0; yy < h; yy += 3) { R(x, y + yy, w, Math.min(3, h - yy), (yy / 3) % 2 ? "#9a7652" : "#8c6a48"); R(x, y + yy + 2, w, 1, "#6e5238"); }
    for (let xx = (r() * 20) | 0; xx < w; xx += 22) R(x + xx, y, 1, h, "#6e5238");
  } else if (kind === "lawn") {
    for (let i = 0; i < (w * h) / 10; i++) R(x + ((r() * w) | 0), y + ((r() * h) | 0), 1, 1, r() < 0.5 ? "#2f5a3e" : "#3a6a48");
  } else { // carpet
    R(x, y, w, h, tint);
    for (let yy = 2; yy < h; yy += 4) for (let xx = (yy % 8 ? 2 : 0); xx < w; xx += 4) R(x + xx, y + yy, 1, 1, shade(tint, 0.12));
  }
}

// ---------- shapes ----------
function blobPoly(cx, cy, rx, ry, seed, n = 30, wob = 0.12) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const w = 1 + wob * (Math.sin(a * 3 + seed) * 0.6 + Math.sin(a * 5 + seed * 1.7) * 0.4);
    pts.push([cx + Math.cos(a) * rx * w, cy + Math.sin(a) * ry * w]);
  }
  return pts;
}
function inPoly(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const scalePoly = (pts, cx, cy, k) => pts.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k]);
function fillPoly(c, pts, col) { c.fillStyle = col; c.beginPath(); pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.closePath(); c.fill(); }
function walkPoly(pts, step, fn) {
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
    const len = Math.hypot(x1 - x0, y1 - y0);
    for (let t = 0; t < len; t += step) fn(Math.round(x0 + ((x1 - x0) * t) / len), Math.round(y0 + ((y1 - y0) * t) / len));
  }
}

// ---------- floor plan ----------

const planCache = new Map();
const meta = new Map(); // homeId -> { dwelling, style, art, art_status } from the server
const listeners = new Set();
export const onDwellingChange = (fn) => (listeners.add(fn), () => listeners.delete(fn));

// The owner can pick a dwelling; null/unknown = picked from the home id hash.
const DWELLING_KIND = {
  house: ["house"], cottage: ["house", "small"], shed: ["house", "small", "timber"], lighthouse: ["house", "lighthouse"],
  "fenced-yard": ["yard"], garden: ["yard", "garden"], "mushroom-ring": ["yard", "mushroom"],
  tent: ["camp"], burrow: ["burrow"], cave: ["burrow", "cave"], greenhouse: ["greenhouse"],
  pond: ["dock"], boat: ["dock", "boat"], treehouse: ["dock", "tree"],
};
export function setDwelling(homeId, dwelling) { setHomeMeta(homeId, { dwelling }); }
// Accepts any subset of { dwelling, style, art, art_status }; re-plans the home when something changed.
export function setHomeMeta(homeId, m) {
  const prev = meta.get(homeId) ?? {};
  const next = { ...prev };
  if ("dwelling" in m) next.dwelling = DWELLING_KIND[m.dwelling] ? m.dwelling : null;
  if ("style" in m) next.style = isRenderStyle(m.style) ? m.style : null;
  if ("art" in m) next.art = m.art ?? null;
  if ("art_status" in m) next.art_status = m.art_status ?? null;
  const sig = (o) => `${o.dwelling ?? ""}|${o.style ?? ""}|${o.art_status ?? ""}|${o.art ? JSON.stringify(o.art).length : 0}`;
  if (sig(prev) === sig(next)) return;
  meta.set(homeId, next);
  planCache.delete(homeId);
  for (const k of [...baseCache.keys()]) if (k.startsWith(homeId + "|")) baseCache.delete(k);
  for (const fn of listeners) fn(homeId);
}

export function planFor(homeId) {
  let plan = planCache.get(homeId);
  if (plan) return plan;
  const m = meta.get(homeId) ?? {};
  if (m.art_status === "ready" && validArt(m.art)) {
    plan = planFromArt(homeId, m.art, m.style);
    planCache.set(homeId, plan);
    return plan;
  }
  const chosen = DWELLING_KIND[m.dwelling] ?? null;
  const flavor = chosen?.[1] ?? null;
  const h = hash32(homeId || "home");
  const r = rng(h ^ 0x9e3779b9);
  const ri = (a, b) => a + Math.floor(r() * (b - a + 1));
  const pick = (a) => a[Math.floor(r() * a.length)];

  // sizes: cottages to roomy two-wing houses
  const big = r();
  const wl = flavor === "small" ? 64 : big < 0.35 ? 64 : big < 0.7 ? ri(66, 76) : 80;
  const wr = ri(50, 56), ho = ri(53, 56), hlv = ri(36, 42), hs = ri(42, 50), hb = ri(36, 42);
  const sy = ri(-6, 6);                                // the right wing is staggered up or down
  const y0 = Math.min(0, sy);
  const W = wl + 2 + wr;
  const H = Math.max(ho + 2 + hlv, sy + hs + 2 + hb) - y0;
  const mirror = r() < 0.5;
  const kr = rng(hash32((homeId || "home") + "|kind"))();
  const kind = chosen ? chosen[0] : kr < 0.56 ? "house" : kr < 0.66 ? "yard" : kr < 0.75 ? "camp" : kr < 0.83 ? "greenhouse" : kr < 0.92 ? "burrow" : "dock";
  const open = kind === "yard" || kind === "camp" || kind === "dock" || kind === "burrow";
  const mx = (x) => (mirror ? W - x : x);
  const Rc = (x, y, w, hh) => [mirror ? W - x - w : x, y - y0, w, hh];
  const Pt = (x, y) => [mx(x), y - y0];
  const box = (rc) => [rc[0], rc[1], rc[0] + rc[2], rc[1] + rc[3]];

  // unmirrored room rects (x0, y0, x1, y1) in pre-shift space
  const Ou = [0, 0, wl, ho], Lu = [0, ho + 2, wl, ho + 2 + hlv];
  const Su = [wl + 2, sy, wl + 2 + wr, sy + hs], Bu = [wl + 2, sy + hs + 2, wl + 2 + wr, sy + hs + 2 + hb];
  const rooms = {};
  for (const [k, u] of Object.entries({ O: Ou, L: Lu, S: Su, B: Bu })) rooms[k] = box(Rc(u[0], u[1], u[2] - u[0], u[3] - u[1]));

  // doorways between rooms (gap rects across the 2px inner walls) + their centre points
  const osY = clamp(30, Math.max(0, sy) + 9, Math.min(ho, sy + hs) - 9);
  const lbA = Math.max(Lu[1], Bu[1]), lbB = Math.min(Lu[3], Bu[3]);
  const lbY = Math.round(clamp((lbA + lbB) / 2, lbA + 8, lbB - 8));
  const gaps = [Rc(wl, osY - 7, 2, 14), Rc(wl - 14, ho, 12, 2), Rc(Su[0] + 22, Su[3], 12, 2), Rc(wl, lbY - 7, 2, 14)];
  const doors = { OS: Pt(wl + 1, osY), OL: Pt(wl - 8, ho + 1), SB: Pt(Su[0] + 28, Su[3] + 1), LB: Pt(wl + 1, lbY) };

  // front door on the living room's outer bottom wall
  const fx0 = ri(20, wl - 18);
  const front = Rc(fx0, Lu[3], 14, WALL);
  const frontPt = Pt(fx0 + 7, Lu[3] - 3);

  // office desks
  const cols = wl >= 78 ? 3 : 2;
  const start = Math.floor((wl - (cols * 20 + (cols - 1) * 6)) / 2);
  const desks = [];
  for (let row = 0; row < 2; row++) for (let col = 0; col < cols; col++) desks.push([Rc(start + col * 26, 0, 20, 0)[0], 20 + row * 24 - y0]);

  // study furniture
  const furn = {
    shelf: Rc(Su[0] + 2, Su[1], 18, 8),
    bench: Rc(Su[2] - 22, Su[1], 21, 9),
    write: Rc(Su[0] + 2, Su[3] - 11, 20, 9),
    crates: Rc(Su[2] - 15, Su[3] - 17, 14, 16),
    sofa: Rc(Lu[0] + 4, Lu[1] + 2, 34, 12),
    arm: Rc(Lu[0] + 40, Lu[1] + 3, 11, 11),
    rug: Rc(Lu[0] + 6, Lu[1] + 18, Math.max(20, wl - 26), Math.max(10, hlv - 24)),
    radio: Rc(Lu[0] + 2, Lu[3] - 10, 10, 7),
    plant: Rc(Lu[2] - 9, Lu[1] + 2, 7, 9),
    night: Rc(Bu[2] - 8, Bu[3] - 8, 6, 6),
  };
  const nBeds = Math.min(4, Math.floor((wr - 4) / 13));
  const beds = [];
  for (let i = 0; i < nBeds; i++) { const rc = Rc(Bu[0] + 3 + i * 13, Bu[1] + 3, 11, 30); beds.push({ x: rc[0], y: rc[1] }); }
  const spots = {
    shelf: { pose: "stand", pts: [Pt(Su[0] + 7, Su[1] + 19), Pt(Su[0] + 16, Su[1] + 19)] },
    bench: { pose: "stand", pts: [Pt(Su[2] - 16, Su[1] + 19), Pt(Su[2] - 6, Su[1] + 19)] },
    write: { pose: "seat", pts: [Pt(Su[0] + 7, Su[3] - 11), Pt(Su[0] + 17, Su[3] - 11)] },
    mcp: { pose: "stand", pts: [Pt(Su[2] - 20, Su[3] - 2), Pt(Su[2] - 8, Su[3] - 19)] },
    radio: { pose: "stand", pts: [Pt(Lu[0] + 15, Lu[3] - 3), Pt(Lu[0] + 8, Lu[3] - 13)] },
    rest: { pose: "sit", pts: [Pt(Lu[0] + 11, Lu[1] + 15), Pt(Lu[0] + 21, Lu[1] + 15), Pt(Lu[0] + 31, Lu[1] + 15), Pt(Lu[0] + 45, Lu[1] + 16)] },
    door: { pose: "stand", pts: [frontPt, Pt(fx0 + 1, Lu[3] - 7), Pt(fx0 + 13, Lu[3] - 7)] },
  };

  // exterior extras
  const extras = { windows: [] };
  const exposedTop = [Ou, Su], sides = [[Ou, -1], [Lu, -1], [Su, 1], [Bu, 1]];
  for (const u of exposedTop) if (r() < 0.75) { const len = ri(10, 14); const x = ri(u[0] + 4, u[2] - len - 4); extras.windows.push(Rc(x, u[1] - WALL, len, WALL)); }
  for (const [u, side] of sides) if (r() < 0.6) { const len = ri(8, 12); const y = ri(u[1] + 4, u[3] - len - 4); extras.windows.push(Rc(side < 0 ? u[0] - WALL : u[2], y, WALL, len)); }
  const xr = [r(), r(), r(), r()];
  if (flavor === "lighthouse") extras.annex = Rc(Su[2] + WALL, Su[1] + 4, 12, 12);
  if (kind === "house") {
    if (xr[0] < 0.6) extras.porch = Rc(fx0 - 6, Lu[3] + WALL, 26, 7);
    if (xr[1] < 0.35) extras.bay = Rc(Ou[0] - WALL - 3, ri(14, ho - 22), 3, 14);
    if (xr[2] < 0.3) extras.annex = Rc(Su[2] + WALL, Su[1] + ri(6, Math.max(6, hs - 24)), 10, 18);
    if (xr[3] < 0.55) extras.chimney = Rc(ri(Ou[0] + 6, Ou[2] - 14), Ou[1] - WALL - 3, 7, 6);
  }
  if (kind !== "house" && kind !== "greenhouse") extras.windows = [];

  const wallM = flavor === "cave" ? { name: "stone", c: "#5e5a66", d: "#46424e" }
    : flavor === "timber" ? WALLS[3] : flavor === "lighthouse" ? { name: "whitewash", c: "#f0ece4", d: "#d9534f" }
    : kind === "greenhouse" ? { name: "glass", c: "#bfe6f0", d: "#8fc6d8" } : kind === "burrow" ? { name: "earth", c: "#6b4a30", d: "#4f3520" } : pick(WALLS);
  const style = {
    wall: wallM,
    floor: kind === "greenhouse" ? { O: "terracotta", S: "terracotta", L: "stone", B: "stone" }
      : kind === "burrow" ? { O: "dirt", S: "dirt", L: "dirt", B: "straw" }
      : kind === "dock" ? { O: "deck", S: "deck", L: "deck", B: "deck" }
      : kind === "camp" ? { O: "dirt", S: "dirt", L: "dirt", B: "dirt" }
      : kind === "yard" ? { O: "lawn", S: "lawn", L: "lawn", B: "lawn" }
      : { O: pick(FLOORS.slice(0, 7)), S: pick(FLOORS.slice(0, 7)), L: pick(["stone", "terracotta", "checker", "oak", "parquet", "tatami"]), B: pick(["carpet", "carpet", "tatami", "pine"]) },
    carpet: pick(CARPETS),
    sofa: pick(["#3d5a80", "#81b29a", "#c97b3a", "#6b4f8f", "#b04a4a", "#2f7f7a"]),
    blankets: [pick(BLANKETS), pick(BLANKETS), pick(BLANKETS), pick(BLANKETS)],
    details: [r(), r(), r(), r(), r()],
  };

  // outer extent (walls + extras) for layout and hit testing
  const rects = Object.values(rooms).map(([a, b, c2, d]) => [a - WALL, b - WALL, c2 + WALL, d + WALL]);
  let blob = null;
  if (open) { // free-form ground: a wobbly blob around all activity spots
    const grow = kind === "dock" ? 12 : kind === "burrow" ? 9 : 6;
    blob = blobPoly(W / 2, H / 2, W / 2 + grow, H / 2 + grow, (h % 1000) / 100, 32, 0.07);
    rects.length = 0;
    rects.push([Math.min(...blob.map((q) => q[0])), Math.min(...blob.map((q) => q[1])), Math.max(...blob.map((q) => q[0])), Math.max(...blob.map((q) => q[1]))]);
  }
  const extraRects = [extras.porch, extras.bay, extras.annex, extras.chimney].filter(Boolean).map(box);
  // keep the house inside its lot's buildable area (144 x 118 incl. walls and extras)
  const span = (list, i0, i1) => Math.max(...list.map((q) => q[i1])) - Math.min(...list.map((q) => q[i0]));
  for (const drop of ["annex", "bay", "chimney", "porch"]) {
    const list = [...rects, ...[extras.porch, extras.bay, extras.annex, extras.chimney].filter(Boolean).map(box)];
    if (span(list, 0, 2) <= 144 && span(list, 1, 3) <= 118) break;
    extras[drop] = null;
  }
  extraRects.length = 0;
  extraRects.push(...[extras.porch, extras.bay, extras.annex, extras.chimney].filter(Boolean).map(box));
  const all = [...rects, ...extraRects];
  const ext = { x0: Math.min(...all.map((q) => q[0])), y0: Math.min(...all.map((q) => q[1])), x1: Math.max(...all.map((q) => q[2])), y1: Math.max(...all.map((q) => q[3])) };

  const roomOf = (x, y) => {
    let best = "O", bd = Infinity;
    for (const [k, [a, b, c2, d]] of Object.entries(rooms)) {
      const dx = Math.max(a - x, 0, x - c2), dy = Math.max(b - y, 0, y - d);
      const dd = dx * dx + dy * dy;
      if (dd < bd) { bd = dd; best = k; }
    }
    return best;
  };

  const rstyle = m.style ?? RENDER_STYLES[hash32((homeId || "home") + "|style") % RENDER_STYLES.length];
  plan = { id: homeId, kind, flavor, open, blob, rstyle, seed: h, W, H, mirror, rooms, gaps, doors, front, frontPt, desks, beds, furn, spots, extras, style, ext, foot: [...rects, ...extraRects], roomOf, cols };
  if (planCache.size > 4000) planCache.delete(planCache.keys().next().value);
  planCache.set(homeId, plan);
  return plan;
}

const BLANKETS = ["#e07a5f", "#5fa8d3", "#81b29a", "#f2cc8f", "#9d6bd8", "#e5989b", "#c97b3a"];
const ADJ = { O: { S: "OS", L: "OL" }, S: { O: "OS", B: "SB" }, L: { O: "OL", B: "LB" }, B: { S: "SB", L: "LB" } };

function routeTo(plan, x0, y0, x1, y1) {
  if (plan.open) return [[x1, y1]];
  const a = plan.roomOf(x0, y0), b = plan.roomOf(x1, y1);
  if (a === b) return [[x1, y1]];
  const D = plan.doors;
  if (ADJ[a][b]) return [D[ADJ[a][b]], [x1, y1]];
  let best = null, bestD = Infinity;
  for (const m of Object.keys(ADJ[a]).filter((q) => ADJ[q][b])) {
    const d1 = D[ADJ[a][m]], d2 = D[ADJ[m][b]];
    const d = Math.hypot(d1[0] - x0, d1[1] - y0) + Math.hypot(d2[0] - d1[0], d2[1] - d1[1]) + Math.hypot(x1 - d2[0], y1 - d2[1]);
    if (d < bestD) { bestD = d; best = [d1, d2]; }
  }
  return [...best, [x1, y1]];
}

// Is an interior-space point on the house (walls, rooms, porch…)? Used for hover/click.
export function onFootprint(plan, x, y) {
  if (plan.blob) return inPoly(plan.blob, x, y);
  return plan.foot.some(([a, b, c, d]) => x >= a && x <= c && y >= b && y <= d);
}

// ---------- static art ----------

function R(c, x, y, w, h, col) { c.fillStyle = col; c.fillRect(x, y, w, h); }
const baseCache = new Map();
const baseScale = (s) => Math.min(8, Math.max(1, Math.round(s)));

export function houseBase(homeId, desks, beds, s = 1) {
  const plan = planFor(homeId);
  const pixel = plan.rstyle === "pixel";
  const sc = pixel ? 1 : baseScale(s);
  const key = `${homeId}|${desks}|${beds}|${season()}|${plan.rstyle}|${sc}`;
  let img = baseCache.get(key);
  if (img) { baseCache.delete(key); baseCache.set(key, img); return img; }
  if (baseCache.size > (pixel ? 400 : 80)) baseCache.delete(baseCache.keys().next().value);
  const { W, H, rooms, style, furn, extras } = plan;
  const r = rng(plan.seed ^ 0x51ed);
  const [cv, c] = styledCanvas(W + PAD * 2, H + PAD * 2, sc, plan.rstyle, plan.seed);
  c.translate(PAD, PAD);
  const wall = style.wall;

  // extras that sit outside, under the walls
  if (extras.porch) {
    const [x, y, w, h] = extras.porch;
    R(c, x - 1, y - 1, w + 2, h + 2, O);
    for (let i = 0; i < h; i += 2) R(c, x, y + i, w, 2, i % 4 ? "#9a6e48" : "#8a6040");
    R(c, x + 1, y + 1, 2, 2, "#5a3a26"); R(c, x + w - 3, y + 1, 2, 2, "#5a3a26");
  }
  if (extras.annex) {
    const [x, y, w, h] = extras.annex;
    R(c, x - 1, y - 1, w + 2, h + 2, O); R(c, x, y, w, h, "#a8d8e8");
    R(c, x + 1, y + 1, w - 2, h - 2, "#bfe6d4");
    for (let i = 0; i < 4; i++) { R(c, x + 2 + (i % 2) * 4, y + 2 + i * 4, 3, 3, "#4f9a5c"); R(c, x + 3 + (i % 2) * 4, y + 1 + i * 4, 1, 1, "#e8a0b4"); }
    R(c, x + Math.floor(w / 2), y, 1, h, "#e9f5ff");
  }
  if (extras.bay) {
    const [x, y, w, h] = extras.bay;
    R(c, x - 1, y - 1, w + 2, h + 2, O); R(c, x, y, w, h, "#7fb2e6"); R(c, x, y + Math.floor(h / 2), w, 1, O);
  }

  if (plan.open) { paintOpenBase(c, plan, desks, beds, r); baseCache.set(key, cv); return cv; }
  // walls: inflate every room by WALL and fill; the 2px gaps between rooms become inner walls
  for (const [a, b, c2, d] of Object.values(rooms)) R(c, a - WALL, b - WALL, c2 - a + WALL * 2, d - b + WALL * 2, O);
  for (const [a, b, c2, d] of Object.values(rooms)) R(c, a - WALL + 1, b - WALL + 1, c2 - a + WALL * 2 - 2, d - b + WALL * 2 - 2, wall.c);
  // material texture on the walls
  for (const [a, b, c2, d] of Object.values(rooms)) {
    for (let x = a - WALL + 1; x < c2 + WALL - 1; x++) for (const yy of [b - WALL + 1, d + 1]) {
      if (wall.name === "brick" && (x + yy) % 4 === 0) R(c, x, yy, 1, 2, wall.d);
      if (wall.name === "stone" && r() < 0.25) R(c, x, yy, 1, 1, wall.d);
      if (wall.name === "timber" && x % 6 === 0) R(c, x, yy, 1, 2, wall.d);
      if (wall.name === "glass" && x % 8 === 0) R(c, x, yy, 1, 2, "#e9f8ff");
      if (wall.name === "earth" && r() < 0.3) R(c, x, yy, 1, 1, r() < 0.5 ? wall.d : "#8a6a4a");
    }
  }
  // rounded convex corners
  const inside = (x, y) => Object.values(rooms).some(([a, b, c2, d]) => x >= a - WALL && x < c2 + WALL && y >= b - WALL && y < d + WALL);
  for (const [a, b, c2, d] of Object.values(rooms)) {
    for (const [x, y, dx, dy] of [[a - WALL, b - WALL, 1, 1], [c2 + WALL - 1, b - WALL, -1, 1], [a - WALL, d + WALL - 1, 1, -1], [c2 + WALL - 1, d + WALL - 1, -1, -1]]) {
      if (inside(x - dx, y) || inside(x, y - dy)) continue;
      c.clearRect(x, y, 1, 1);
      R(c, x + dx, y + dy, 1, 1, O);
    }
  }
  // floors
  for (const [, [a, b, c2, d]] of Object.entries(rooms)) c.backdrop?.(a, b, c2 - a, d - b);
  for (const [k, [a, b, c2, d]] of Object.entries(rooms)) drawFloor(c, style.floor[k], a, b, c2 - a, d - b, r, style.carpet);
  // doorways (floor shows through) + front door threshold
  for (const [x, y, w, h] of plan.gaps) R(c, x, y, w, h, "#7a5a40");
  { const [x, y, w] = plan.front; R(c, x, y, w, WALL, "#6b4a35"); R(c, x, y + WALL - 1, w, 1, "#4a3020"); }
  for (const [x, y, w, h] of extras.windows) { R(c, x, y, w, h, "#7fb2e6"); if (w > h) R(c, x + (w >> 1), y, 1, h, O); else R(c, x, y + (h >> 1), w, 1, O); }
  if (extras.chimney) { const [x, y, w, h] = extras.chimney; R(c, x - 1, y - 1, w + 2, h + 2, O); R(c, x, y, w, h, "#8a4a36"); R(c, x + 1, y + 1, w - 2, h - 2, "#2a1e22"); }

  const { O: Or, S: Sr, L: Lr, B: Br } = rooms;
  // ---- study
  { const [x, y, w, h] = furn.shelf; R(c, x, y, w, h + 1, O); R(c, x + 1, y, w - 2, h, "#6b4430");
    for (let row = 0; row < 2; row++) for (let i = 0; i < (w - 2) / 2; i++) R(c, x + 2 + i * 2, y + 1 + row * 4, 1, 3, ["#d9534f", "#5fa8d3", "#f2cc8f", "#81b29a", "#9d6bd8", "#e5989b"][(i + row * 3 + plan.seed) % 6]); }
  { const [x, y, w, h] = furn.bench; R(c, x, y, w, h + 1, O); R(c, x + 1, y, w - 2, h, "#5a5a6a"); R(c, x + 1, y + h - 1, w - 2, 1, "#3a3a4a");
    for (const ox of [3, 12]) { R(c, x + ox, y + 1, 7, 6, O); R(c, x + ox + 1, y + 2, 5, 4, "#0f2a1a"); R(c, x + ox + 2, y + 3, 3, 1, "#7fd36b"); } }
  { const [x, y, w, h] = furn.crates; R(c, x, y, w, h, O); R(c, x + 1, y + 1, w - 2, 7, "#a8783a"); R(c, x + 1, y + 8, w - 2, h - 9, "#946a32");
    R(c, x + 1, y + 4, w - 2, 1, "#7a5528"); R(c, x + 1, y + 12, w - 2, 1, "#7a5528");
    R(c, x + 4, y - 3, 6, 4, O); R(c, x + 5, y - 2, 4, 2, "#d9534f"); }
  // ---- living
  { const [x, y, w, h] = furn.rug; R(c, x, y, w, h, "#7a3f4f"); R(c, x + 2, y + 2, w - 4, h - 4, "#8a4a5c"); R(c, x + 4, y + 4, w - 8, 1, "#a8687a");
    const tw = Math.min(16, w - 10); R(c, x + ((w - tw) >> 1), y + (h >> 1) - 3, tw, 6, O); R(c, x + ((w - tw) >> 1) + 1, y + (h >> 1) - 2, tw - 2, 4, "#9a6a45"); }
  { const [x, y, w, h] = furn.sofa; const s = style.sofa;
    R(c, x, y, w, h, O); R(c, x + 1, y + 1, w - 2, 6, shade(s, -0.2)); R(c, x + 1, y + 7, w - 2, 4, s); R(c, x, y + 2, 3, 10, shade(s, -0.3)); R(c, x + w - 3, y + 2, 3, 10, shade(s, -0.3)); }
  { const [x, y, w, h] = furn.arm; R(c, x, y, w, h, O); R(c, x + 1, y + 1, w - 2, 5, shade(style.sofa, -0.25)); R(c, x + 1, y + 6, w - 2, 4, style.sofa); }
  { const [x, y, w, h] = furn.radio; R(c, x, y, w, h, O); R(c, x + 1, y + 1, w - 2, h - 2, "#8a5d3f"); R(c, x + 2, y - 2, 6, 4, O); R(c, x + 3, y - 1, 4, 2, "#c9a86a"); R(c, x + 4, y - 1, 1, 1, O); }
  { const [x, y] = furn.plant; R(c, x, y + 3, 7, 6, O); R(c, x + 1, y + 4, 5, 4, "#a8683a"); R(c, x, y, 7, 4, "#4f9a5c"); R(c, x + 2, y - 1, 3, 2, "#6ab874"); }
  // ---- bedroom
  for (let i = 0; i < Math.min(beds, plan.beds.length); i++) {
    const { x, y } = plan.beds[i];
    if (plan.kind === "burrow") { R(c, x - 1, y, 13, 30, "#5a3f2a"); R(c, x, y + 1, 11, 28, "#c9a85a"); R(c, x + 2, y + 2, 7, 4, "#e8d08a"); continue; }
    R(c, x, y, 11, 30, O); R(c, x + 1, y + 1, 9, 28, "#d9c9b0"); R(c, x + 2, y + 2, 7, 4, "#fff8ec");
    const bl = style.blankets[i % 4];
    R(c, x + 1, y + 7, 9, 22, bl); R(c, x + 1, y + 7, 9, 1, shade(bl, 0.25));
  }
  { const [x, y] = furn.night; R(c, x, y, 6, 6, O); R(c, x + 1, y + 1, 4, 4, "#8a5d3f"); R(c, x + 2, y + 2, 2, 1, "#ffcf6e"); }
  // ---- office chairs (desks are drawn later, in front of seated residents)
  for (let i = 0; i < Math.min(desks, plan.desks.length); i++) {
    const [x, top] = plan.desks[i];
    R(c, x + 5, top - 9, 10, 9, O); R(c, x + 6, top - 8, 8, 7, "#3a4a6b"); R(c, x + 6, top - 8, 8, 1, "#4d5f85");
  }
  // ---- little odd details, deterministic per home
  const det = style.details;
  const [ra, rb, rc2, rd] = Lr;
  if (det[0] < 0.35) { const x = Math.round((ra + rc2) / 2) + 6, y = rd - 9; R(c, x, y, 5, 3, "#e8913a"); R(c, x + 4, y - 1, 2, 2, "#e8913a"); R(c, x + 1, y + 1, 1, 1, O); } // sleeping cat
  if (det[1] < 0.4) { const x = Br[0] + 2, y = Br[3] - 7; R(c, x, y, 5, 5, O); R(c, x + 1, y + 1, 3, 3, "#7fb2e6"); R(c, x + 2, y + 2, 1, 1, "#ff9a3c"); } // fishbowl
  if (det[2] < 0.4) { const x = Or[0] + 1, y = Or[3] - 7; R(c, x, y, 3, 6, "#6b4430"); R(c, x, y, 3, 1, "#d9534f"); R(c, x, y + 2, 3, 1, "#5fa8d3"); } // stack of books
  if (det[3] < 0.3) { const x = Lr[2] - 5, y = Lr[3] - 12; R(c, x, y, 3, 8, "#a8683a"); R(c, x + 1, y - 3, 1, 3, "#5a3a26"); } // guitar
  if (det[4] < 0.5) { const x = Sr[0] + 22, y = Sr[1] + 1; R(c, x, y, 4, 4, "#4f9a5c"); R(c, x + 1, y + 4, 2, 2, "#a8683a"); } // cactus
  const sz = season();
  if (sz === "halloween") { const [x, y] = plan.frontPt; R(c, x - 12, y - 1, 4, 3, "#e8732a"); R(c, x - 11, y - 2, 1, 1, "#4f9a5c"); R(c, x - 11, y, 2, 1, "#ffd27a"); }
  if (sz === "winter") { for (const [a, b, c2] of Object.values(rooms)) for (let x = a; x < c2; x += 4) R(c, x, b - WALL, 1, 1, ["#ff6b5b", "#ffd27a", "#7fd36b", "#5fa8d3"][(x >> 2) % 4]); }
  baseCache.set(key, cv);
  return cv;
}

const overlayCache = new Map();
let artStyle = "pixel", artScale = 1;
function cachedArt(key, w, h, paint) {
  const sc = artStyle === "pixel" ? 1 : baseScale(artScale);
  const k2 = `${key}|${artStyle}|${sc}`;
  let img = overlayCache.get(k2);
  if (!img) {
    const [cv, c] = styledCanvas(w, h, sc, artStyle, hash32(key));
    paint(c);
    overlayCache.set(k2, (img = cv));
    if (overlayCache.size > 600) overlayCache.delete(overlayCache.keys().next().value);
  }
  return img;
}
const deskImg = (kind) => cachedArt("desk|" + kind, 20, 10, (c) => {
  if (kind === "yard" || kind === "camp") { // tree stump / log table
    R(c, 1, 0, 18, 9, O); R(c, 2, 1, 16, 3, "#c9a06a"); R(c, 4, 2, 12, 1, "#a8804a"); R(c, 2, 4, 16, 4, "#6b4a30"); R(c, 5, 5, 1, 3, "#5a3a26"); R(c, 13, 5, 1, 3, "#5a3a26");
    return;
  }
  if (kind === "burrow") { R(c, 0, 1, 20, 8, O); R(c, 1, 2, 18, 3, "#a7a3ad"); R(c, 1, 5, 18, 3, "#7a7684"); R(c, 4, 2, 3, 1, "#c9c5cf"); return; }
  if (kind === "dock") { R(c, 0, 0, 20, 9, O); R(c, 1, 1, 18, 7, "#a8783a"); R(c, 1, 4, 18, 1, "#7a5528"); R(c, 9, 1, 1, 7, "#7a5528"); return; }
  R(c, 0, 0, 20, 9, O); R(c, 1, 1, 18, 3, "#c9966a"); R(c, 1, 4, 18, 4, "#8a5d3f"); R(c, 1, 1, 18, 1, "#dcae84");
  R(c, 2, 9, 2, 1, O); R(c, 16, 9, 2, 1, O);
});
const laptopImg = (on, kind) => cachedArt(`lap|${on}|${kind}`, 8, 6, (c) => {
  R(c, 0, 0, 8, 5, O); R(c, 1, 1, 6, 3, "#c9cbd6");
  const logo = kind === "claude-code" ? "#d97757" : kind === "codex" ? "#2a9d8f" : "#9d6bd8";
  R(c, 3, 2, 2, 1, on ? logo : shade(logo, -0.45));
  R(c, 0, 5, 8, 1, "#8e90a0");
});
const writeTableImg = () => cachedArt("write", 20, 10, (c) => {
  R(c, 0, 0, 20, 9, O); R(c, 1, 1, 18, 3, "#b98a5a"); R(c, 1, 4, 18, 4, "#7a5035");
  R(c, 3, 1, 5, 2, "#fff8ec"); R(c, 12, 1, 5, 2, "#fff8ec"); R(c, 9, 1, 1, 2, "#241a2b");
});
const blanketImg = (col, kind) => cachedArt(`bl|${col}|${kind}`, 9, 22, (c) => {
  if (kind === "burrow" || kind === "yard") { // straw / hay pulled up to the chin
    R(c, 0, 0, 9, 22, "#c9a85a"); for (let i = 0; i < 30; i++) R(c, (i * 7) % 9, (i * 5) % 22, 1, 2, i % 2 ? "#e8d08a" : "#a8884a"); return;
  }
  if (kind === "camp") { R(c, 0, 0, 9, 22, "#3f6a4a"); R(c, 0, 0, 9, 2, "#5a8a5a"); R(c, 4, 2, 1, 20, "#2a4a34"); return; } // sleeping bag
  R(c, 0, 0, 9, 22, col); R(c, 0, 0, 9, 1, shade(col, 0.3)); R(c, 0, 3, 9, 1, shade(col, -0.15));
});

// Open-air dwellings: a fenced garden plot, a campsite, a dock around a pond.
function paintOpenBase(c, plan, desks, beds, r) {
  const { rooms, furn, kind, blob, W, H } = plan;
  const cx = W / 2, cy = H / 2;
  if (kind === "dock" && plan.flavor === "tree") { // a big round canopy, the deck up in the branches
    fillPoly(c, scalePoly(blob, cx, cy, 1.04), "#1c4a34");
    for (let i = 0; i < 70; i++) { const a = r() * 6.283, k = 0.92 + r() * 0.12; R(c, Math.round(cx + Math.cos(a) * (W / 2 + 12) * k), Math.round(cy + Math.sin(a) * (H / 2 + 12) * k), 3, 2, r() < 0.5 ? "#3f8a5a" : "#2a6a48"); }
    fillPoly(c, scalePoly(blob, cx, cy, 0.9), O);
  } else if (kind === "dock") { // a round pond with a deck island
    fillPoly(c, blob, "#5a4a3a"); fillPoly(c, scalePoly(blob, cx, cy, 0.97), "#2f5a86");
    for (let i = 0; i < 26; i++) { const a = r() * 6.283; R(c, Math.round(cx + Math.cos(a) * (W / 2 + 7)), Math.round(cy + Math.sin(a) * (H / 2 + 7)), 3, 1, "#7fb2e6"); }
    for (let i = 0; i < 4; i++) { const a = r() * 6.283; const x = Math.round(cx + Math.cos(a) * (W / 2 + 6)), y = Math.round(cy + Math.sin(a) * (H / 2 + 6)); R(c, x, y, 4, 3, "#4f9a5c"); R(c, x + 1, y, 1, 1, "#f2b8c8"); }
    fillPoly(c, scalePoly(blob, cx, cy, 0.86), O);
  } else if (kind === "burrow") { // a round den dug into a mound
    fillPoly(c, blob, "#3a2a1e"); fillPoly(c, scalePoly(blob, cx, cy, 0.97), "#5a3f2a");
    walkPoly(scalePoly(blob, cx, cy, 0.95), 5, (x, y) => R(c, x, y, 2, 1, "#7a5a3c"));
    fillPoly(c, scalePoly(blob, cx, cy, 0.9), O);
  } else if (kind === "camp") fillPoly(c, blob, "#5e4430");
  else fillPoly(c, blob, "#2a4a34");
  // floor, clipped to the inner blob
  const inner = kind === "dock" || kind === "burrow" ? scalePoly(blob, cx, cy, kind === "dock" ? 0.85 : 0.89) : scalePoly(blob, cx, cy, 0.97);
  c.save();
  c.beginPath(); inner.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.closePath(); c.clip();
  c.backdrop?.(-20, -20, W + 40, H + 40);
  drawFloor(c, plan.style.floor.O, -20, -20, W + 40, H + 40, r, plan.style.carpet);
  if (kind === "burrow") for (let i = 0; i < 10; i++) { const x = (r() * W) | 0, y = (r() * H) | 0; R(c, x, y, 6, 1, "#4a3020"); R(c, x + 5, y + 1, 3, 1, "#4a3020"); } // roots
  c.restore();
  // boundary: picket fence for yards, mushrooms for fairy rings, rope posts for docks
  const [fx, fy, fw] = plan.front;
  const gate = (x, y) => y > cy && Math.abs(x - (fx + fw / 2)) < 8;
  if (plan.flavor === "mushroom") walkPoly(scalePoly(blob, cx, cy, 1.02), 7, (x, y) => { if (gate(x, y)) return; R(c, x, y, 5, 3, ["#d9534f", "#c97b3a", "#9d6bd8"][(x + y) & 1 ? 0 : (x % 3)]); R(c, x + 1, y, 1, 1, "#fff8ec"); R(c, x + 2, y + 3, 1, 2, "#efe6d4"); });
  else if (kind === "yard") walkPoly(blob, 3, (x, y) => { if (!gate(x, y)) { R(c, x, y - 2, 1, 3, "#efe6d4"); R(c, x - 1, y - 1, 3, 1, "#cfc6b4"); } });
  else if (kind === "dock") walkPoly(scalePoly(blob, cx, cy, 0.86), 9, (x, y) => { if (!gate(x, y)) R(c, x, y - 1, 2, 2, "#5a3a26"); });
  else if (kind === "camp") { R(c, fx - 3, fy - 2, 1, 6, PAL_TRUNK); R(c, fx - 6, fy - 4, 6, 3, "#9a6e48"); }
  if (kind === "dock" || kind === "burrow") { R(c, fx, fy - 2, fw, 9, kind === "dock" ? "#8c6a48" : "#5a3f2a"); } // jetty / tunnel mouth
  const { O: Or, S: Sr, L: Lr, B: Br } = rooms;
  // study corner: crate of books, tool bench, garden table, wheelbarrow/crates
  { const [x, y, w, h] = furn.shelf; R(c, x, y, w, h, O); R(c, x + 1, y + 1, w - 2, h - 2, "#a8783a"); for (let i = 0; i < w - 4; i += 2) R(c, x + 2 + i, y + 2, 1, 3, ["#d9534f", "#5fa8d3", "#f2cc8f", "#81b29a"][i % 4]); }
  { const [x, y, w, h] = furn.bench; R(c, x, y, w, h, O); R(c, x + 1, y + 1, w - 2, h - 3, kind === "dock" ? "#6e6878" : "#8a5d3f"); R(c, x + 3, y + 2, 6, 4, "#d9534f"); R(c, x + 12, y + 2, 6, 4, O); R(c, x + 13, y + 3, 4, 2, "#0f2a1a"); R(c, x + 14, y + 3, 2, 1, "#7fd36b"); }
  { const [x, y, w, h] = furn.crates; R(c, x, y, w, h, O); R(c, x + 1, y + 1, w - 2, h - 2, kind === "dock" ? "#5a7a9a" : "#946a32"); R(c, x + 1, y + 7, w - 2, 1, "#5a3a26"); if (kind === "dock") { R(c, x + 3, y + 3, 6, 2, "#c9cbd6"); } }
  { const [x, y, w, h] = furn.radio; R(c, x + 4, y - 6, 1, 13, PAL_TRUNK); R(c, x + 1, y - 2, 8, 5, O); R(c, x + 2, y - 1, 6, 3, "#c9a86a"); R(c, x + 3, y, 1, 1, O); if (kind === "camp") R(c, x + 6, y - 9, 1, 7, "#c9cbd6"); }
  // rest corner
  const [sx, sy, sw, sh] = furn.sofa;
  if (kind === "yard") { // hammock between two trees
    R(c, sx - 3, sy - 2, 5, 5, "#2a5e40"); R(c, sx + sw - 2, sy - 2, 5, 5, "#2a5e40");
    R(c, sx + 2, sy + 4, sw - 4, 6, "#e07a5f"); R(c, sx + 2, sy + 6, sw - 4, 1, "#f2cc8f"); R(c, sx + 2, sy + 3, sw - 4, 1, "#5a3a26");
  } else if (kind === "camp") { // logs around a campfire
    R(c, sx, sy + 4, sw, 6, O); R(c, sx + 1, sy + 5, sw - 2, 4, "#7a5a3c"); R(c, sx + 2, sy + 6, 2, 2, "#c9a06a");
    const [rx, ry, rw, rh] = furn.rug; const fx2 = rx + (rw >> 1) - 5, fy2 = ry + (rh >> 1) - 4;
    R(c, fx2, fy2, 10, 8, "#6e6878"); R(c, fx2 + 1, fy2 + 1, 8, 6, "#2a1e22"); R(c, fx2 + 3, fy2 + 2, 4, 4, "#e8732a"); R(c, fx2 + 4, fy2 + 1, 2, 3, "#ffd27a");
  } else { // dock: a little rowboat to lounge in
    R(c, sx, sy + 1, sw, 11, O); R(c, sx + 2, sy, sw - 4, 13, O); R(c, sx + 1, sy + 2, sw - 2, 8, "#b0634a"); R(c, sx + 3, sy + 3, sw - 6, 6, "#d9b48a"); R(c, sx + 10, sy + 3, 1, 6, "#8a4a36"); R(c, sx + 22, sy + 3, 1, 6, "#8a4a36");
  }
  { const [x, y, w, h] = furn.arm; R(c, x, y + 2, w, h - 2, O); R(c, x + 1, y + 3, w - 2, h - 4, kind === "camp" ? "#7a5a3c" : kind === "dock" ? "#d9b48a" : "#c9a85a"); }
  if (kind === "camp") { // a round tent over each sleeping mat
    for (let i = 0; i < Math.min(beds, plan.beds.length); i++) {
      const { x, y } = plan.beds[i];
      c.fillStyle = O; c.beginPath(); c.ellipse(x + 5.5, y + 12, 9, 14, 0, 0, 7); c.fill();
      c.fillStyle = ["#d97757", "#5fa8d3", "#81b29a", "#f2cc8f"][i % 4]; c.beginPath(); c.ellipse(x + 5.5, y + 12, 8, 13, 0, 0, 7); c.fill();
      R(c, x + 5, y - 1, 1, 26, "rgba(0,0,0,0.25)");
    }
  }
  // beds: haystacks / sleeping mats / hammocks
  for (let i = 0; i < Math.min(beds, plan.beds.length); i++) {
    const { x, y } = plan.beds[i];
    if (kind === "burrow") { R(c, x - 1, y, 13, 30, "#3a2a1e"); R(c, x, y + 1, 11, 28, "#c9a85a"); R(c, x + 2, y + 2, 7, 4, "#e8d08a"); }
    else if (kind === "yard") { R(c, x - 1, y, 13, 30, "#8a6a3a"); R(c, x, y + 1, 11, 28, "#c9a85a"); R(c, x + 2, y + 2, 7, 4, "#e8d08a"); }
    else if (kind === "camp") { R(c, x, y, 11, 30, O); R(c, x + 1, y + 1, 9, 28, "#5a6a7a"); R(c, x + 2, y + 2, 7, 4, "#c9cbd6"); }
    else { R(c, x + 4, y - 2, 3, 2, "#5a3a26"); R(c, x + 4, y + 30, 3, 2, "#5a3a26"); R(c, x, y, 11, 30, "#e8e0d0"); R(c, x + 1, y + 1, 9, 28, "#f3e9d2"); R(c, x + 2, y + 2, 7, 4, "#fff8ec"); }
  }
  // scattered details
  if (kind === "yard") { for (let i = 0; i < 6; i++) R(c, Lr[0] + 4 + ((r() * (Lr[2] - Lr[0] - 8)) | 0), Lr[3] - 4 - ((r() * 8) | 0), 1, 1, [PAL_FLOWER, "#f2d27a"][i % 2]); R(c, Br[2] - 10, Br[3] - 9, 8, 7, "#5a3a26"); R(c, Br[2] - 9, Br[3] - 8, 6, 5, "#6ab874"); }
  if (kind === "dock") { R(c, Or[0] + 2, Or[3] - 6, 4, 4, O); R(c, Or[0] + 3, Or[3] - 5, 2, 2, "#e8732a"); }
  const sz = season();
  if (sz === "halloween") { const [x, y] = plan.frontPt; R(c, x + 9, y - 2, 4, 3, "#e8732a"); R(c, x + 10, y - 3, 1, 1, "#4f9a5c"); R(c, x + 10, y - 1, 2, 1, "#ffd27a"); }
  // chairs behind desks
  for (let i = 0; i < Math.min(desks, plan.desks.length); i++) {
    const [x, top] = plan.desks[i];
    if (kind === "yard" || kind === "camp") { R(c, x + 6, top - 6, 8, 5, O); R(c, x + 7, top - 5, 6, 3, "#9a7652"); }
    else { R(c, x + 6, top - 7, 8, 6, O); R(c, x + 7, top - 6, 6, 4, "#a8783a"); }
  }
}
const PAL_TRUNK = "#4a3328", PAL_FLOWER = "#e8a0b4";

// Cheap stand-in for far zoom levels: footprint only.
export function drawFootprint(ctx, plan, X0, Y0, s, lit) {
  if (plan.art && drawArtLayers(ctx, plan, X0, Y0, s, 0, true)) return;
  if (plan.blob) {
    const path = (k) => { const cx = plan.W / 2, cy = plan.H / 2; ctx.beginPath(); plan.blob.forEach(([x, y], i) => { const px = X0 + (cx + (x - cx) * k) * s, py = Y0 + (cy + (y - cy) * k) * s; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }); ctx.closePath(); };
    ctx.fillStyle = plan.kind === "dock" ? "#2f5a86" : plan.kind === "camp" ? "#5e4430" : plan.kind === "burrow" ? "#3a2a1e" : "#efe6d4";
    path(1); ctx.fill();
    ctx.fillStyle = plan.kind === "dock" ? "#8c6a48" : plan.kind === "camp" ? "#7a5a3c" : plan.kind === "burrow" ? "#7a5a3c" : "#2f5a3e";
    path(plan.kind === "dock" ? 0.85 : 0.93); ctx.fill();
    return;
  }
  ctx.fillStyle = O;
  for (const [a, b, c, d] of Object.values(plan.rooms)) ctx.fillRect(X0 + (a - WALL) * s, Y0 + (b - WALL) * s, (c - a + WALL * 2) * s, (d - b + WALL * 2) * s);
  ctx.fillStyle = plan.style.wall.c;
  for (const [a, b, c, d] of Object.values(plan.rooms)) ctx.fillRect(X0 + (a - 2) * s, Y0 + (b - 2) * s, (c - a + 4) * s, (d - b + 4) * s);
  ctx.fillStyle = lit ? "#a8845a" : "#4a4060";
  for (const [a, b, c, d] of Object.values(plan.rooms)) ctx.fillRect(X0 + a * s, Y0 + b * s, (c - a) * s, (d - b) * s);
}

// ---------- Claude-generated dwelling art (v1) ----------
// { v:1, viewBox, style?, footprint:[[x,y]…], layers:[{id, svg, optional?}], anim:[{layer,type,…}], spots:{…} }
export function validArt(a) {
  if (!a || typeof a !== "object" || a.v !== 1) return false;
  const vb = String(a.viewBox ?? "").trim().split(/[\s,]+/).map(Number);
  if (vb.length !== 4 || vb.some((n) => !Number.isFinite(n)) || vb[2] <= 0 || vb[3] <= 0) return false;
  if (!Array.isArray(a.layers) || a.layers.length < 2 || a.layers.length > 10) return false;
  return a.layers.every((l) => l && typeof l.svg === "string" && l.svg.length <= 80_000);
}

function planFromArt(homeId, art, style) {
  const vb = String(art.viewBox).trim().split(/[\s,]+/).map(Number);
  const k = Math.min(144 / vb[2], 104 / vb[3]);
  const T = (p) => [(p[0] - vb[0]) * k, (p[1] - vb[1]) * k];
  const W = vb[2] * k, H = vb[3] * k;
  const ok = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
  const pts = (v) => (ok(v) ? [T(v)] : Array.isArray(v) ? v.filter(ok).map(T) : []);
  const sp = art.spots ?? {};
  const center = [W / 2, H * 0.6];
  const door = ok(sp.door) ? T(sp.door) : [W / 2, H - 4];
  const desks = pts(sp.desk); if (!desks.length) desks.push(center);
  const rest = pts(sp.rest); if (!rest.length) rest.push([center[0] - 10, center[1]]);
  const bedPts = pts(sp.bed); if (!bedPts.length) bedPts.push(...rest);
  const one = (v) => { const p = pts(v); return p.length ? p : null; };
  const spot = (pose, list) => (list ? { pose, pts: list } : null);
  const foot = Array.isArray(art.footprint) && art.footprint.filter(ok).length >= 3 ? art.footprint.filter(ok).map(T) : [[0, 0], [W, 0], [W, H], [0, H]];
  const xs = foot.map((p) => p[0]), ys = foot.map((p) => p[1]);
  const ext = { x0: Math.min(0, ...xs) - 2, y0: Math.min(0, ...ys) - 2, x1: Math.max(W, ...xs) + 2, y1: Math.max(H, ...ys) + 2 };
  // every layer carries its own pivot for its animations; only `optional` layers (the roof) are far-zoom only
  const layers = art.layers.map((l, i) => ({ id: String(l.id ?? "l" + i), svg: l.svg, roof: !!l.optional, pivot: ok(l.pivot) ? T(l.pivot) : [W / 2, H / 2] }));
  const pivotOf = new Map(layers.map((l) => [l.id, l.pivot]));
  const anim = (Array.isArray(art.anim) ? art.anim : []).slice(0, 12).map((a) => ({
    layer: String(a.layer ?? ""), type: String(a.type ?? ""), amp: Number.isFinite(a.amp) ? a.amp : 3,
    period: Number.isFinite(a.period) && a.period > 0.05 ? a.period : 2, phase: Number.isFinite(a.phase) ? a.phase : 0,
    pivot: pivotOf.get(String(a.layer ?? "")) ?? [W / 2, H / 2],
  }));
  const h = hash32(homeId);
  const spots = {
    shelf: spot("stand", one(sp.books)), bench: spot("stand", one(sp.terminal)), write: spot("stand", one(sp.write)),
    mcp: spot("stand", one(sp.mcp)), radio: spot("stand", one(sp.web)), agent: spot("stand", one(sp.agent)),
    rest: spot("sit", rest), door: spot("stand", [door, [door[0] - 7, door[1] - 3], [door[0] + 7, door[1] - 3]]),
  };
  for (const kk of Object.keys(spots)) if (!spots[kk]) delete spots[kk];
  return {
    id: homeId, kind: "art", open: true, blob: foot, rstyle: style ?? "flat", seed: h, W, H, mirror: false,
    art: { key: "art:" + hash32(JSON.stringify(art)), vb: vb.join(" "), label: typeof art.style === "string" ? art.style : "", defs: sharedDefs(layers.map((l) => l.svg)), layers, anim },
    charK: (13 * k) / 32, // residents ~13 viewBox units tall, as the art is designed for
    rooms: { O: [0, 0, W, H] }, gaps: [], doors: {}, front: [door[0] - 7, door[1] - 3, 14], frontPt: door,
    desks: desks.map(([x, y]) => [x - 10, y]), beds: bedPts.map(([x, y]) => ({ x: x - 5, y: y - 9 })),
    furn: {}, spots, extras: { windows: [] }, style: { blankets: BLANKETS.slice(0, 4), wall: { c: "#d8c8b0" } },
    ext, foot: [[ext.x0, ext.y0, ext.x1, ext.y1]], roomOf: () => "O", cols: 0,
  };
}

function layerTransform(list, tSec) {
  const x = { tx: 0, ty: 0, rot: 0, sx: 1, sy: 1 };
  for (const a of list) {
    const w = (2 * Math.PI * tSec) / a.period + a.phase;
    if (a.type === "bob") x.ty += a.amp * Math.sin(w);
    else if (a.type === "shake") x.tx += a.amp * Math.sin(w * 3);
    else if (a.type === "sway") x.rot += a.amp * Math.sin(w);
    else if (a.type === "wiggle") x.rot += a.amp * Math.sin(w * 4);
    else if (a.type === "pulse") { const kk = 1 + (a.amp / 100) * Math.sin(w); x.sx *= kk; x.sy *= kk; }
    else if (a.type === "spin") x.rot += (360 * tSec) / a.period;
    else if (a.type === "flap") x.sx *= 1 - (Math.abs(a.amp) / 100) * (0.5 + 0.5 * Math.sin(w));
    else if (a.type === "blink" && (tSec + a.phase) % a.period < 0.13) x.sy *= 0.1;
  }
  return x;
}

// Draw a Claude-generated dwelling. roof: true at far zoom (shows the optional roof layer).
export function drawArtLayers(ctx, plan, X0, Y0, s, t, roof) {
  const a = plan.art;
  const r = svgRaster(a.key, a.vb, a.defs, a.layers.map((l) => l.svg), plan.H * s);
  if (!r) { // still loading: soft footprint
    ctx.fillStyle = "rgba(220, 200, 170, 0.35)";
    ctx.beginPath(); plan.blob.forEach(([x, y], i) => (i ? ctx.lineTo(X0 + x * s, Y0 + y * s) : ctx.moveTo(X0 + x * s, Y0 + y * s))); ctx.closePath(); ctx.fill();
    return false;
  }
  const prev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = true;
  const tSec = t / 1000;
  a.layers.forEach((l, i) => {
    if (l.roof !== roof && l.roof) return;
    const cv = r.canvases[i];
    if (!cv) return;
    const anims = a.anim.filter((q) => q.layer === l.id);
    if (anims.length) {
      const x = layerTransform(anims, tSec);
      const [px, py] = l.pivot;
      ctx.save();
      ctx.translate(X0 + (px + x.tx) * s, Y0 + (py + x.ty) * s);
      ctx.rotate((x.rot * Math.PI) / 180); ctx.scale(x.sx, x.sy);
      ctx.drawImage(cv, -px * s, -py * s, plan.W * s, plan.H * s);
      ctx.restore();
    } else ctx.drawImage(cv, X0, Y0, plan.W * s, plan.H * s);
  });
  ctx.imageSmoothingEnabled = prev;
  return true;
}

// ---------- simulation ----------

export class HomeSim {
  constructor(homeId) {
    this.homeId = homeId;
    this.seed = hash32(homeId);
    this.personas = new Map();
    this.ents = new Map();          // id -> entity (agents and "p:<persona>" sleepers)
    this.claims = new Map();        // spot kind -> Map(slot -> entId)
    this.deskOf = new Map();        // top-level agent id -> desk index
    this.lastStale = 0;
  }

  get plan() { return planFor(this.homeId); }

  // The floor plan changed (new dwelling): put everyone back on valid spots.
  relayout() {
    this.claims.clear();
    for (const e of [...this.ents.values()]) {
      if (e.sleeper) { e.target = null; const g = this.bedGoal(e.a.persona_id, e.id); Object.assign(e, { x: g.x, y: g.y, target: g, path: [] }); }
      else this.replan(e, false);
    }
  }

  // A resident says something (public `say` event): bubble for ~8 s.
  say(personaId, text, ts = Date.now()) {
    const age = Date.now() - ts;
    if (age > 8000) return;
    let best = null;
    for (const e of this.ents.values()) {
      if (e.a.persona_id !== personaId || e.dying) continue;
      if (!best || (best.sleeper && !e.sleeper) || (best.mini && !e.mini)) best = e;
    }
    if (best) best.say = { text: String(text).slice(0, 280), until: performance.now() + 8000 - Math.max(0, age) };
  }

  // ---- data in ----
  setPersonas(list) {
    for (const p of list) this.personas.set(p.id, p);
    this.syncSleepers(false);
  }
  upsertPersona(p) {
    this.personas.set(p.id, p);
    this.syncSleepers(true);
  }
  setAgents(list) {
    const open = new Set(list.map((a) => a.id));
    for (const [id, e] of this.ents) if (!e.sleeper && !open.has(id)) this.removeEnt(id);
    for (const a of list) this.upsertAgent(a, false);
    this.syncSleepers(false);
  }
  upsertAgent(a, animate = true) {
    const now = performance.now();
    let e = this.ents.get(a.id);
    if (a.status === "ended") {
      if (!e || e.ending) return;
      e.a = { ...e.a, ...a };
      e.ending = true;
      this.replan(e, true);
      return;
    }
    if (!e) {
      const pid = a.persona_id;
      const parent = a.parent_id ? this.ents.get(a.parent_id) : null;
      const sleeper = this.ents.get("p:" + pid);
      let [x, y] = this.plan.frontPt;
      if (parent && !parent.sleeper) { x = parent.x; y = parent.y; }
      else if (sleeper) { x = sleeper.x; y = sleeper.y; this.removeEnt(sleeper.id); }
      e = {
        id: a.id, a: { ...a }, x, y, path: [], pose: "walk", facing: 1, born: animate ? now : -1e9, dying: 0,
        mini: !!a.parent_id, seed: hash32(a.id) % 9973, target: null, sleeper: false, ending: false,
      };
      this.ents.set(a.id, e);
      if (!e.mini) this.assignDesk(e);
      this.replan(e, animate);
    } else {
      const prev = e.a;
      e.a = { ...e.a, ...a };
      if (e.ending) { e.ending = false; e.dying = 0; }
      if (prev.status !== a.status || prev.tool !== a.tool || prev.parent_id !== a.parent_id) this.replan(e, animate);
    }
  }
  mergeTasks(sessions) { // owner view in the town: add task_no/task_enc from /homes/:id
    for (const s of sessions) { const e = this.ents.get(s.id); if (e) { e.a.task_no = s.task_no; e.a.task_enc = s.task_enc; } }
  }

  // Personas without any open session sleep in their bed.
  syncSleepers(animate) {
    const awake = new Set();
    for (const e of this.ents.values()) if (!e.sleeper) awake.add(e.a.persona_id);
    for (const p of this.personas.values()) {
      const id = "p:" + p.id;
      if (awake.has(p.id) || this.ents.has(id)) continue;
      const g = this.bedGoal(p.id, id);
      this.ents.set(id, { id, a: { id, persona_id: p.id, status: "asleep" }, x: g.x, y: g.y, path: [], pose: "sleep", facing: 1, born: animate ? performance.now() : -1e9, dying: 0, mini: false, seed: hash32(id) % 9973, sleeper: true, target: g });
    }
    for (const [id, e] of this.ents) if (e.sleeper && (awake.has(e.a.persona_id) || !this.personas.has(e.a.persona_id))) this.removeEnt(id);
  }

  removeEnt(id) {
    this.ents.delete(id);
    this.deskOf.delete(id);
    for (const m of this.claims.values()) for (const [k, v] of m) if (v === id) m.delete(k);
  }

  assignDesk(e) {
    const used = new Set(this.deskOf.values());
    let k = 0;
    while (used.has(k)) k++;
    this.deskOf.set(e.id, k);
  }

  personaIndex(pid) {
    let i = 0;
    for (const id of this.personas.keys()) { if (id === pid) return i; i++; }
    return i;
  }
  bedCount() { return clamp(Math.max(this.personas.size, this.ents.size), 2, this.plan.beds.length); }
  deskCount() {
    let top = 0;
    for (const e of this.ents.values()) if (!e.sleeper && !e.mini) top++;
    return clamp(Math.max(top, this.personas.size, Math.max(-1, ...this.deskOf.values()) + 1), 2, this.plan.desks.length);
  }
  // One bed per resident entity (a persona with several sessions has several residents): keep the bed this entity
  // already has, else take the lowest free one. Only when every bed is taken do two share (slightly offset).
  bedGoal(pid, entId) {
    const beds = this.plan.beds;
    const mine = entId ? this.ents.get(entId)?.target : null;
    if (mine?.kind === "bed" && mine.bedIdx != null && mine.bedIdx < beds.length) return mine;
    const used = new Set();
    for (const o of this.ents.values()) if (o.id !== entId && o.target?.kind === "bed" && o.target.bedIdx != null) used.add(o.target.bedIdx);
    let idx = -1;
    for (let i = 0; i < beds.length; i++) if (!used.has(i)) { idx = i; break; }
    let extra = 0;
    if (idx < 0) { idx = this.personaIndex(pid) % beds.length; extra = 1; }
    const b = beds[idx];
    return { kind: "bed", pose: "sleep", x: b.x + 5 + extra * 2, y: b.y + 9, bed: b, bedIdx: idx };
  }
  deskSpot(e) {
    const d = this.deskOf.get(e.id) ?? 0;
    const n = this.plan.desks.length;
    const [x, top] = this.plan.desks[d % n];
    return [x + 10 + Math.floor(d / n) * 3, top];
  }

  claim(kind, e) {
    let m = this.claims.get(kind);
    if (!m) this.claims.set(kind, (m = new Map()));
    for (const [k, v] of m) if (v === e.id) return k;
    let k = 0;
    while (m.has(k)) k++;
    m.set(k, e.id);
    return k;
  }
  release(e) {
    for (const m of this.claims.values()) for (const [k, v] of m) if (v === e.id) m.delete(k);
  }

  // Where should this resident be, given their status?
  goal(e) {
    const a = e.a, plan = this.plan;
    const [fx, fy] = plan.frontPt;
    if (e.ending) {
      if (e.mini) {
        const p = this.ents.get(a.parent_id);
        if (p && !p.sleeper) return { kind: "parent", pose: "stand", x: p.x + 3, y: p.y, then: "pop" };
        return { kind: "door", pose: "stand", x: fx, y: fy, then: "pop" };
      }
      const others = [...this.ents.values()].some((o) => o !== e && !o.sleeper && !o.ending && o.a.persona_id === a.persona_id);
      if (others) return { kind: "door", pose: "stand", x: fx, y: fy, then: "pop" };
      return { ...this.bedGoal(a.persona_id, e.id), then: "sleep" };
    }
    let kind;
    if (a.status === "tool") kind = TOOL_SPOT[a.tool] ?? "desk";
    if (kind !== "desk" && kind && !["door", "rest", "bed"].includes(kind) && !plan.spots[kind]?.pts?.length) kind = "desk";
    else if (a.status === "thinking" || a.status === "background") kind = "desk"; // background: stays at the desk, watching it run
    else if (a.status === "waiting") kind = plan.art ? "rest" : "door";
    else if (a.status === "idle") kind = a.last_seen && Date.now() - a.last_seen > IDLE_SLEEP_MS ? "bed" : "rest";
    else kind = "desk";
    if (kind === "bed") return this.bedGoal(a.persona_id, e.id);
    if (kind === "desk") {
      if (e.mini) { // subagents stand at the side of the parent's desk
        const p = this.ents.get(a.parent_id);
        const d = p ? this.deskOf.get(p.id) ?? 0 : 0;
        const [x, top] = plan.desks[d % plan.desks.length];
        const n = [...this.ents.values()].filter((o) => o.mini && o.a.parent_id === a.parent_id).indexOf(e);
        return { kind, pose: "stand", x: x + 23, y: top + 2 + Math.max(0, n) * 4 };
      }
      const [x, y] = this.deskSpot(e);
      return { kind, pose: plan.art ? "stand" : "seat", x, y };
    }
    const k = this.claim(kind, e);
    const spot = plan.spots[kind];
    const pt = spot.pts[k % spot.pts.length];
    const lap = Math.floor(k / spot.pts.length);
    const pose = e.mini && spot.pose === "seat" ? "stand" : spot.pose;
    return { kind, pose, x: pt[0] + lap * 4 + (e.mini ? 3 : 0), y: pt[1] + lap * 2 };
  }

  replan(e, animate) {
    this.release(e);
    const g = this.goal(e);
    e.target = g;
    if (!animate) { e.x = g.x; e.y = g.y; e.path = []; e.pose = g.pose; this.arrive(e); return; }
    if (Math.hypot(g.x - e.x, g.y - e.y) < 0.5 && !e.path.length) { e.pose = g.pose; this.arrive(e); return; }
    // step out from behind a desk / out of bed first
    const start = [];
    if (e.pose === "seat") start.push([e.x, e.y + 6]);
    if (e.pose === "sleep" && e.target) start.push([e.x, (e.prevBedY ?? e.y) + 26]);
    const from = start.length ? start[start.length - 1] : [e.x, e.y];
    const seat = g.pose === "seat";
    e.path = [...start, ...routeTo(this.plan, from[0], from[1], g.x, g.y + (seat ? 6 : 0)), ...(seat ? [[g.x, g.y]] : [])];
    e.pose = "walk";
  }

  arrive(e) {
    const t = e.target;
    if (!t) return;
    if (t.bed) e.prevBedY = t.bed.y;
    if (t.then === "pop" && !e.dying) e.dying = performance.now();
    if (t.then === "sleep") { this.removeEnt(e.id); this.syncSleepers(false); }
  }

  update(dt, now) {
    if (now - this.lastStale > 2000) {
      this.lastStale = now;
      for (const e of this.ents.values()) {
        if (e.sleeper || e.ending) continue;
        if (e.a.status === "idle" && e.target?.kind === "rest" && e.a.last_seen && Date.now() - e.a.last_seen > IDLE_SLEEP_MS) this.replan(e, true);
      }
    }
    for (const e of [...this.ents.values()]) {
      if (e.dying && now - e.dying > POP_MS) { this.removeEnt(e.id); this.syncSleepers(true); continue; }
      if (!e.path.length) continue;
      let left = (e.mini ? RUN : WALK) * dt;
      while (left > 0 && e.path.length) {
        const [tx, ty] = e.path[0];
        const dx = tx - e.x, dy = ty - e.y, d = Math.hypot(dx, dy);
        if (Math.abs(dx) > 0.3) e.facing = dx < 0 ? -1 : 1;
        const step = Math.min(d, left);
        e.travel = (e.travel ?? 0) + step;
        if (d <= left) { e.x = tx; e.y = ty; e.path.shift(); left -= d; }
        else { e.x += (dx / d) * left; e.y += (dy / d) * left; left = 0; }
      }
      if (!e.path.length) { e.pose = e.target?.pose ?? "stand"; this.arrive(e); }
    }
  }

  stats() {
    let awake = 0, busy = 0, agents = 0;
    for (const e of this.ents.values()) {
      if (e.sleeper) continue;
      agents++;
      if (e.target?.kind !== "bed") awake++;
      if (BUSY.has(e.a.status)) busy++;
    }
    return { awake, busy, agents };
  }

  // ---------- drawing ----------
  // X0,Y0: device px of the interior origin; s: device px per art px; t: ms.
  // Returns label anchors [{ent, persona, x, y}] in device px (top of head).
  draw(ctx, X0, Y0, s, t, { reduced = false, now = performance.now() } = {}) {
    const plan = this.plan;
    const desks = this.deskCount(), beds = this.bedCount();
    if (plan.art) drawArtLayers(ctx, plan, X0, Y0, s, t, false);
    else {
    artStyle = plan.rstyle; artScale = s;
    const base = houseBase(this.homeId, desks, beds, s);
    const bs = plan.rstyle === "pixel" ? s : s / baseScale(s);
    if (plan.rstyle !== "pixel") ctx.imageSmoothingEnabled = true;
    ctx.drawImage(base, Math.round(X0 - PAD * s), Math.round(Y0 - PAD * s), Math.round(base.width * bs), Math.round(base.height * bs));
    ctx.imageSmoothingEnabled = false;
    }
    const P = Math.round;
    const items = [];
    const deskBusy = new Map();
    for (const e of this.ents.values()) {
      if (!e.sleeper && !e.mini && e.pose === "seat" && e.target?.kind === "desk") deskBusy.set((this.deskOf.get(e.id) ?? 0) % plan.desks.length, e);
    }
    for (let i = 0; i < (plan.art ? 0 : desks); i++) {
      const [x, top] = plan.desks[i];
      const occ = deskBusy.get(i);
      const kind = occ ? this.personas.get(occ.a.persona_id)?.kind : "";
      items.push({ y: top + 0.2, draw: () => {
        ctx.drawImage(deskImg(plan.kind), P(X0 + x * s), P(Y0 + (top - 1) * s), P(20 * s), P(10 * s));
        ctx.drawImage(laptopImg(!!occ && BUSY.has(occ.a.status), kind), P(X0 + (x + 6) * s), P(Y0 + (top - 4) * s), P(8 * s), P(6 * s));
      } });
    }
    if (plan.furn.write) { const [x, y] = plan.furn.write; items.push({ y: y + 0.2, draw: () => ctx.drawImage(writeTableImg(), P(X0 + x * s), P(Y0 + (y - 1) * s), P(20 * s), P(10 * s)) }); }

    const anchors = [];
    for (const e of this.ents.values()) {
      const persona = this.personas.get(e.a.persona_id) ?? { id: e.a.persona_id, kind: "other" };
      const bed = e.pose === "sleep" ? e.target?.bed : null;
      const y = bed ? bed.y + 6.9 : e.pose === "seat" ? e.y - 0.5 : e.y;
      items.push({ y, draw: () => {
        const top = this.drawResident(ctx, e, persona, X0, Y0, s, t, now, reduced, bed);
        if (bed && !plan.art) {
          const bi = plan.beds.indexOf(bed);
          // Tuck in from the chest down so the face stays visible on the pillow.
          ctx.drawImage(blanketImg(plan.style.blankets[bi % 4], plan.kind), P(X0 + (bed.x + 1) * s), P(Y0 + (bed.y + 14) * s), P(9 * s), P(15 * s));
        }
        if (top != null) anchors.push({ ent: e, persona, x: X0 + e.x * s, y: top });
      } });
    }
    items.sort((a, b) => a.y - b.y);
    for (const it of items) it.draw();
    return anchors;
  }

  drawResident(ctx, e, persona, X0, Y0, s, t, now, reduced, bed) {
    let k = (this.plan.charK ?? K) * (e.mini ? MINI : 1);
    // In bed, shrink to the bed's width (11 units) so a big creature doesn't spill onto the next bed.
    if (bed && e.pose === "sleep") k = Math.min(k, 14 / 32);
    let pop = 1;
    if (e.dying) { const p = clamp((now - e.dying) / POP_MS, 0, 1); pop = 1 - p * p; }
    else if (now - e.born < SPAWN_MS) { const p = (now - e.born) / SPAWN_MS; const c1 = 1.70158; pop = 1 + (c1 + 1) * (p - 1) ** 3 + c1 * (p - 1) ** 2; }
    if (pop <= 0.02) return null;
    const look = lookFor(persona);
    if (look) return this.drawCreature(ctx, e, look, X0, Y0, s, t, now, reduced, bed, k, pop);
    const sheet = sheetFor(persona);
    const poses = posesFor(persona);
    const n = sheet.size;
    const h = n * k;
    const status = e.a.status;
    let img, topArt;
    if (e.pose === "walk") {
      const f = Math.floor((t + e.seed) / (e.mini ? 85 : 130)) % 4;
      img = e.facing < 0 ? poses.walkL[f] : poses.walk[f];
      topArt = e.y - h;
    } else if (e.pose === "seat") {
      img = frameFor(sheet, status === "waiting" ? "idle" : status === "background" ? "thinking" : status, t, e.seed);
      topArt = e.y - 24 * k; // desk covers the legs
    } else if (e.pose === "sit") {
      img = poses.sit; topArt = e.y - h;
    } else if (e.pose === "sleep") {
      img = poses.sleep; topArt = (bed ? bed.y : e.y - 9) + 1.5;
    } else {
      img = frameFor(sheet, status === "tool" || status === "thinking" ? status : "idle", t, e.seed);
      topArt = e.y - h;
    }
    const w = n * k * s * pop, hh = n * k * s * pop;
    const cx = X0 + e.x * s, footY = Y0 + (topArt + h) * s;
    if (e.pose === "walk" || e.pose === "stand") {
      ctx.fillStyle = "rgba(10, 6, 20, 0.28)";
      ctx.fillRect(Math.round(cx - 8 * k * s), Math.round(footY - s), Math.round(16 * k * s), Math.max(1, Math.round(1.5 * s)));
    }
    ctx.drawImage(img, Math.round(cx - w / 2), Math.round(footY - hh), Math.round(w), Math.round(hh));
    const age = e.dying ? now - e.dying : now - e.born;
    if (!reduced && age >= 0 && age < 420) {
      const p = age / 420;
      ctx.fillStyle = `rgba(243, 233, 210, ${0.85 * (1 - p)})`;
      for (let i = 0; i < 7; i++) {
        const ang = (i / 7) * Math.PI * 2 + e.seed;
        const rr = (3 + p * 7) * s * (e.mini ? 0.6 : 1);
        const sz = Math.max(1, Math.round((1.5 - p) * s));
        ctx.fillRect(Math.round(cx + Math.cos(ang) * rr), Math.round(footY - (h * s) / 2 + Math.sin(ang) * rr * 0.7), sz, sz);
      }
    }
    return Math.round(footY - hh);
  }

  drawCreature(ctx, e, look, X0, Y0, s, t, now, reduced, bed, k, pop) {
    const h = 32 * k * s * pop;
    const cx = X0 + e.x * s;
    let footArt = e.y;
    if (e.pose === "seat") footArt = e.y + 8 * k;
    else if (e.pose === "sleep") footArt = (bed ? bed.y : e.y - 9) + 1.5 + 32 * k;
    const footY = Y0 + footArt * s;
    const status = e.a.status;
    const state = e.pose === "sleep" ? "sleeping" : e.pose === "sit" ? "idle" : status === "tool" ? "working" : status === "thinking" || status === "background" ? "thinking" : "idle";
    drawV2(ctx, look, cx, footY, h, { state, pose: e.pose, dir: e.facing, mini: e.mini, travel: e.travel ?? 0, t: t + e.seed * 37, shadow: e.pose === "walk" || e.pose === "stand" });
    const age = e.dying ? now - e.dying : now - e.born;
    if (!reduced && age >= 0 && age < 420) {
      const p = age / 420;
      ctx.fillStyle = `rgba(243, 233, 210, ${0.85 * (1 - p)})`;
      for (let i = 0; i < 7; i++) {
        const ang = (i / 7) * Math.PI * 2 + e.seed;
        const rr = (3 + p * 7) * s * (e.mini ? 0.6 : 1);
        const sz = Math.max(1, Math.round((1.5 - p) * s));
        ctx.fillRect(Math.round(cx + Math.cos(ang) * rr), Math.round(footY - h / 2 + Math.sin(ang) * rr * 0.7), sz, sz);
      }
    }
    return Math.round(footY - h * 0.95);
  }

  hitTest(ax, ay) {
    let best = null;
    for (const e of this.ents.values()) {
      const k = (this.plan.charK ?? K) * (e.mini ? MINI : 1), h = 32 * k;
      const bed = e.pose === "sleep" ? e.target?.bed : null;
      const top = e.pose === "seat" ? e.y - 24 * k : bed ? bed.y + 1 : e.y - h;
      const bottom = e.pose === "seat" ? e.y : bed ? bed.y + 13 : e.y;
      if (ax >= e.x - 6 * k * 2 && ax <= e.x + 6 * k * 2 && ay >= top && ay <= bottom) {
        if (!best || e.y > best.y) best = e;
      }
    }
    return best;
  }
}

// Text for a resident's status bubble.
export function statusLine(e) {
  const a = e.a;
  if (e.sleeper || e.pose === "sleep") return tr("st.asleep");
  if (e.ending) return tr("st.bye");
  if (a.status === "tool") return tr("st.tool", { tool: a.tool || tr("st.toolGeneric") });
  if (a.status === "thinking") return tr("st.thinking");
  if (a.status === "background") return tr("st.background");
  if (a.status === "waiting") return tr("st.needsYou");
  return tr("st.resting");
}

export const BASE_PAD = PAD;
