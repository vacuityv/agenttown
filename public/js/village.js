// The village, without a grid. Homes are placed on a golden-angle (phyllotaxis) spiral by creation index
// with hash jitter, so the village grows outward organically and existing homes never move. Some spiral
// slots are left as meadows / features (plazas, ponds, groves, the cemetery); a winding river crosses the
// valley; curvy footpaths join every home to its nearest older neighbours (with little bridges over the
// river). Terrain (grass tones, flowers, tall grass, rocks, tree clusters) comes from value noise.
//
// Rendering is split into invisible 256 px chunks purely for caching — nothing in the art follows them.
import { planFor, season, onDwellingChange } from "./interior.js";
import { hash32, rng } from "./util.js";

const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const SPACING = 124;
export const CHUNK_PX = 512; // device px per cached terrain tile (tiles are invisible; just a cache)
const BUCKET = 512;

// ---------- deterministic noise ----------
function h2(x, y, s = 0) { return hash32(`${x},${y},${s}`) / 4294967296; }
function vnoise(x, y, scale, s = 0) {
  const gx = x / scale, gy = y / scale, x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
  const sm = (t) => t * t * (3 - 2 * t);
  const a = h2(x0, y0, s), b = h2(x0 + 1, y0, s), c = h2(x0, y0 + 1, s), d = h2(x0 + 1, y0 + 1, s);
  const u = sm(fx), v = sm(fy);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

// ---------- river ----------
export const riverY = (x) => 150 + 170 * Math.sin(x / 610 + 0.4) + 60 * Math.sin(x / 230 + 2.1);
const RIVER_W = 13;           // half width of the water
const RIVER_CLEAR = 120;      // homes keep this far (vertically) from the river

// ---------- slots ----------
function slotPos(s) {
  const r = SPACING * Math.sqrt(s + 0.6);
  const a = s * GOLDEN;
  const j = hash32("slot" + s);
  return [r * Math.cos(a) + ((j & 255) / 255 - 0.5) * 22, r * Math.sin(a) + (((j >>> 8) & 255) / 255 - 0.5) * 22];
}
const isFeatureSlot = (s) => s % 9 === 4;
const nearRiver = (s) => { const [x, y] = slotPos(s); return Math.abs(y - riverY(x)) < RIVER_CLEAR; };

// home index -> slot (memoized; slot decisions depend only on the slot, so it's stable as the town grows)
const homeSlots = [];
let scanSlot = 0;
export function homeSlot(k) {
  while (homeSlots.length <= k) {
    const s = scanSlot++;
    if (!isFeatureSlot(s) && !nearRiver(s)) homeSlots.push(s);
  }
  return homeSlots[k];
}
export const homeCenter = (k) => slotPos(homeSlot(k));

// features: every feature slot that isn't in the river
const FEATURE_KINDS = ["plaza", "cemetery", "pond", "grove", "meadow", "orchard", "plaza", "grove", "pond", "meadow", "well", "grove"];
export function featuresUpTo(maxSlot) {
  const out = [];
  for (let s = 4, o = 0; s <= maxSlot; s += 9, o++) {
    if (nearRiver(s)) continue;
    const [x, y] = slotPos(s);
    out.push({ slot: s, ord: o, kind: FEATURE_KINDS[o % FEATURE_KINDS.length], x, y, r: 70 });
  }
  return out;
}

// ---------- spatial index of homes ----------
const buckets = new Map();
let indexed = 0;
const bkey = (x, y) => `${Math.floor(x / BUCKET)},${Math.floor(y / BUCKET)}`;
function ensureIndex(n) {
  for (; indexed < n; indexed++) {
    const [x, y] = homeCenter(indexed);
    const k = bkey(x, y);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(indexed);
  }
}
export function homesIn(x0, y0, x1, y1, n, pad = 120) {
  ensureIndex(n);
  const out = [];
  for (let bx = Math.floor((x0 - pad) / BUCKET); bx <= Math.floor((x1 + pad) / BUCKET); bx++)
    for (let by = Math.floor((y0 - pad) / BUCKET); by <= Math.floor((y1 + pad) / BUCKET); by++)
      for (const k of buckets.get(`${bx},${by}`) ?? []) if (k < n) out.push(k);
  return out;
}

// ---------- homes: placement of the interior + garden ----------
let idOf = () => null;           // k -> home id (set by the town)
let countHomes = () => 0;
export function bindHomes(getId, getCount) { idOf = getId; countHomes = getCount; }

const layoutCache = new Map();
export function homeLayout(k) {
  const id = idOf(k);
  const key = `${k}|${id}`;
  let l = layoutCache.get(key);
  if (l) return l;
  const plan = planFor(id ?? `slot-${k}`);
  const [cx, cy] = homeCenter(k);
  const ex = plan.ext;
  const ox = Math.round(cx - (ex.x0 + ex.x1) / 2), oy = Math.round(cy - (ex.y0 + ex.y1) / 2);
  const rx = (ex.x1 - ex.x0) / 2 + 18, ry = (ex.y1 - ex.y0) / 2 + 18;
  const [fx, fy, fw] = plan.front;
  const door = [ox + fx + fw / 2, oy + fy + 3 + (plan.extras.porch ? 7 : 0) + 4];
  l = { k, id, plan, ox, oy, cx, cy, rx, ry, door };
  if (layoutCache.size > 6000) layoutCache.delete(layoutCache.keys().next().value);
  layoutCache.set(key, l);
  return l;
}

// ---------- footpaths ----------
// Each home links to its nearest older neighbour (and sometimes a second one).
const edgeCache = new Map();
function edgesOf(k) {
  let e = edgeCache.get(k);
  if (e) return e;
  e = [];
  if (k > 0) {
    const [x, y] = homeCenter(k);
    const cands = homesIn(x - 420, y - 420, x + 420, y + 420, k, 0).filter((j) => j < k)
      .map((j) => { const [a, b] = homeCenter(j); return [Math.hypot(a - x, b - y), j]; }).sort((a, b) => a[0] - b[0]);
    if (!cands.length && k > 0) { // nobody nearby yet: link to the closest of all older homes
      let best = 0, bd = Infinity;
      for (let j = 0; j < k; j++) { const [a, b] = homeCenter(j); const d = Math.hypot(a - x, b - y); if (d < bd) { bd = d; best = j; } }
      cands.push([bd, best]);
    }
    if (cands[0]) e.push(cands[0][1]);
    if (cands[1] && hash32("e2" + k) % 2 === 0 && cands[1][0] < 330) e.push(cands[1][1]);
  }
  edgeCache.set(k, e);
  return e;
}

// Quadratic curve between two doors, bowed sideways by a per-edge amount.
function pathCurve(a, b) {
  const la = homeLayout(a), lb = homeLayout(b);
  const [x0, y0] = la.door, [x1, y1] = lb.door;
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, dx = x1 - x0, dy = y1 - y0, d = Math.hypot(dx, dy) || 1;
  const bend = ((hash32(`bend${a}-${b}`) % 1000) / 1000 - 0.5) * 0.6 * d;
  return [x0, y0, mx - (dy / d) * bend, my + (dx / d) * bend + 10, x1, y1];
}
const qpt = ([x0, y0, cx, cy, x1, y1], t) => [(1 - t) ** 2 * x0 + 2 * (1 - t) * t * cx + t * t * x1, (1 - t) ** 2 * y0 + 2 * (1 - t) * t * cy + t * t * y1];

export function pathsIn(x0, y0, x1, y1, n) {
  const out = [];
  for (const k of homesIn(x0, y0, x1, y1, n, 460)) for (const j of edgesOf(k)) {
    const c = pathCurve(k, j);
    const bx0 = Math.min(c[0], c[2], c[4]), bx1 = Math.max(c[0], c[2], c[4]), by0 = Math.min(c[1], c[3], c[5]), by1 = Math.max(c[1], c[3], c[5]);
    if (bx1 < x0 - 8 || bx0 > x1 + 8 || by1 < y0 - 8 || by0 > y1 + 8) continue;
    out.push({ c, style: hash32(`ps${k}-${j}`) % 3 });
  }
  return out;
}

// ---------- invalidation ----------
const chunkCache = new Map();
const groundCache = new Map();
export function invalidateAll() { chunkCache.clear(); groundCache.clear(); layoutCache.clear(); edgeCache.clear(); }
onDwellingChange(() => invalidateAll());

// ---------- neutral, soft vector environment ----------
// The shared world (ground, river, paths, trees, plazas, cemetery) is drawn as smooth vector shapes in a calm
// warm night palette, rendered at device resolution and cached per (tile, scale). Homes bring their own style.

function palette() {
  const sz = season();
  const base = { ground: "#21312b", ground2: "#26382f", ground3: "#1c2b25", path: "#7d6a52", pathHi: "#93805f", stone: "#8c8794", water: "#2a4864", waterHi: "rgba(170,205,235,0.22)", bank: "#3a3a2e" };
  if (sz === "winter") return { ...base, ground: "#2b3b40", ground2: "#33454a", ground3: "#24333a", leaf: ["#3f5a50", "#5b766a"], fl: ["#e8eef5", "#cfd8e0"] };
  if (sz === "autumn" || sz === "halloween") return { ...base, leaf: ["#a8552c", "#d0803d", "#7a3a22"], fl: ["#e8a050", "#d0603a"] };
  if (sz === "spring") return { ...base, leaf: ["#3a6e52", "#e9b3c4", "#2c5a42"], fl: ["#f0b8c8", "#f7f1e3"] };
  return { ...base, leaf: ["#335f48", "#4a7c5e", "#284c3a"], fl: ["#e8a0b4", "#f2d27a"] };
}

// soft vector tree (x,y = top-left of a ~16 x 18 box in world px)
export function tree(c, x, y, r, pal = palette(), size = 1) {
  const cx = x + 7 * size, cy = y + 7 * size, R0 = 7 * size;
  c.fillStyle = "rgba(0,0,0,0.22)"; c.beginPath(); c.ellipse(cx + 2 * size, y + 16 * size, R0 * 0.9, R0 * 0.35, 0, 0, 7); c.fill();
  if (r() < 0.28) { // conifer
    c.fillStyle = "#4a3a2e"; c.fillRect(cx - 0.8 * size, y + 12 * size, 1.6 * size, 4 * size);
    for (let i = 0; i < 3; i++) {
      c.fillStyle = i % 2 ? pal.leaf[0] : pal.leaf[2] ?? pal.leaf[0];
      c.beginPath(); c.moveTo(cx, y + i * 3.5 * size); c.lineTo(cx + (4 + i * 2) * size, y + (6 + i * 3.5) * size); c.lineTo(cx - (4 + i * 2) * size, y + (6 + i * 3.5) * size); c.closePath(); c.fill();
    }
    return;
  }
  c.fillStyle = "#4a3a2e"; c.fillRect(cx - 1 * size, y + 10 * size, 2 * size, 6 * size);
  const g = c.createRadialGradient(cx - 2 * size, cy - 3 * size, 1, cx, cy, R0 * 1.2);
  g.addColorStop(0, pal.leaf[1]); g.addColorStop(1, pal.leaf[0]);
  c.fillStyle = g;
  for (const [dx, dy, rr] of [[0, 0, 1], [-3.5, 2, 0.7], [3.5, 2, 0.72], [0, -3, 0.7]]) { c.beginPath(); c.arc(cx + dx * size, cy + dy * size, R0 * rr, 0, 7); c.fill(); }
}
function bush(c, x, y, r, pal) {
  c.fillStyle = "rgba(0,0,0,0.18)"; c.beginPath(); c.ellipse(x + 4, y + 5, 4.5, 1.6, 0, 0, 7); c.fill();
  c.fillStyle = pal.leaf[0];
  for (const [dx, dy, rr] of [[2, 3, 2.6], [5, 3, 2.4], [3.5, 1.5, 2.4]]) { c.beginPath(); c.arc(x + dx, y + dy, rr, 0, 7); c.fill(); }
  if (r() < 0.5) { c.fillStyle = pal.fl[0]; c.beginPath(); c.arc(x + 4, y + 2, 0.7, 0, 7); c.fill(); }
}
function rock(c, x, y) {
  const g = c.createLinearGradient(x, y, x, y + 4); g.addColorStop(0, "#9a95a3"); g.addColorStop(1, "#5e5a68");
  c.fillStyle = g; c.beginPath(); c.ellipse(x + 3, y + 2, 3, 2, 0, 0, 7); c.fill();
}
function flowers(c, x, y, r, pal) { for (let i = 0; i < 5; i++) { c.fillStyle = pal.fl[i % 2]; c.beginPath(); c.arc(x + r() * 8, y + r() * 6, 0.6, 0, 7); c.fill(); } }
function grass(c, x, y) { c.strokeStyle = "rgba(90,130,100,0.6)"; c.lineWidth = 0.6; c.beginPath(); for (const dx of [0, 2, 4]) { c.moveTo(x + dx, y + 4); c.quadraticCurveTo(x + dx - 0.5, y + 1, x + dx + 0.8, y - 1); } c.stroke(); }

function blocked(x, y, homes, paths, margin) {
  if (Math.abs(y - riverY(x)) < RIVER_W + 6 + margin) return true;
  for (const l of homes) { const dx = (x - l.cx) / (l.rx + margin), dy = (y - l.cy) / (l.ry + margin); if (dx * dx + dy * dy < 1) return true; }
  for (const f of _features) if (Math.hypot(x - f.x, y - f.y) < f.r + margin) return true;
  for (const p of paths) for (let t = 0; t <= 1; t += 0.05) { const [px, py] = qpt(p.c, t); if (Math.abs(px - x) < 6 + margin && Math.abs(py - y) < 6 + margin) return true; }
  return false;
}
let _features = [];
export function setFeatures(list) { _features = list; chunkCache.clear(); }

const tileWorld = (s) => CHUNK_PX / s;
export const tileSize = tileWorld;

function newCanvas(w, h) { const c = document.createElement("canvas"); c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h)); return [c, c.getContext("2d")]; }

// One terrain tile at scale s (device px per world px). Returns a CHUNK_PX² canvas.
export function chunkImage(ix, iy, s) {
  const n = countHomes();
  const key = `${ix},${iy}|${s}|${n}|${season()}`;
  let img = chunkCache.get(key);
  if (img) { chunkCache.delete(key); chunkCache.set(key, img); return img; }
  const TW = tileWorld(s);
  const X = ix * TW, Y = iy * TW;
  const [cv, c] = newCanvas(CHUNK_PX, CHUNK_PX);
  c.setTransform(s, 0, 0, s, -X * s, -Y * s);
  const pal = palette();
  c.fillStyle = pal.ground; c.fillRect(X, Y, TW, TW);
  // soft tonal patches (fixed world cells, so tiles at any scale agree)
  const G = 96;
  for (let gy = Math.floor((Y - G) / G); gy <= Math.floor((Y + TW + G) / G); gy++) for (let gx = Math.floor((X - G) / G); gx <= Math.floor((X + TW + G) / G); gx++) {
    const v = vnoise(gx * G, gy * G, 300, 3);
    const px = gx * G + h2(gx, gy, 9) * G, py = gy * G + h2(gx, gy, 10) * G, rr = 50 + h2(gx, gy, 11) * 60;
    const col = v > 0.55 ? "rgba(52,74,60,0.35)" : v < 0.4 ? "rgba(16,26,22,0.35)" : "rgba(40,58,48,0.25)";
    const g = c.createRadialGradient(px, py, 0, px, py, rr); g.addColorStop(0, col); g.addColorStop(1, "rgba(0,0,0,0)");
    c.fillStyle = g; c.fillRect(px - rr, py - rr, rr * 2, rr * 2);
  }
  // river
  c.lineCap = "round"; c.lineJoin = "round";
  const riv = () => { c.beginPath(); for (let x = X - 40; x <= X + TW + 40; x += 6) { const y = riverY(x); x === X - 40 ? c.moveTo(x, y) : c.lineTo(x, y); } };
  riv(); c.strokeStyle = pal.bank; c.lineWidth = RIVER_W * 2 + 8; c.stroke();
  riv(); c.strokeStyle = pal.water; c.lineWidth = RIVER_W * 2; c.stroke();
  riv(); c.strokeStyle = "rgba(60,100,140,0.5)"; c.lineWidth = RIVER_W; c.stroke();
  c.strokeStyle = pal.waterHi; c.lineWidth = 0.8;
  for (let x = Math.floor((X - 20) / 23) * 23; x <= X + TW; x += 23) { const y = riverY(x) + ((hash32("w" + x) % 15) - 7); c.beginPath(); c.moveTo(x, y); c.quadraticCurveTo(x + 4, y - 1.5, x + 8, y); c.stroke(); }
  const homes = homesIn(X, Y, X + TW, Y + TW, n, 160).map(homeLayout);
  const paths = pathsIn(X, Y, X + TW, Y + TW, n);
  // footpaths
  for (const p of paths) {
    const [x0, y0, cx, cy, x1, y1] = p.c;
    const curve = () => { c.beginPath(); c.moveTo(x0, y0); c.quadraticCurveTo(cx, cy, x1, y1); };
    if (p.style === 1) { // stepping stones
      for (let i = 0; i <= 40; i++) { const [px, py] = qpt(p.c, i / 40); if (i % 2) continue; c.fillStyle = pal.stone; c.beginPath(); c.ellipse(px, py, 2.2, 1.6, i, 0, 7); c.fill(); }
    } else {
      curve(); c.strokeStyle = "rgba(0,0,0,0.18)"; c.lineWidth = 7; c.stroke();
      curve(); c.strokeStyle = p.style === 0 ? pal.path : "#857a68"; c.lineWidth = 5.5; c.stroke();
      curve(); c.strokeStyle = p.style === 0 ? "rgba(160,140,105,0.35)" : "rgba(170,160,140,0.3)"; c.lineWidth = 2; c.stroke();
    }
    // bridges where the path crosses water
    for (let i = 1; i < 60; i++) {
      const [px, py] = qpt(p.c, i / 60);
      if (Math.abs(py - riverY(px)) < 3) {
        const [ax, ay] = qpt(p.c, (i - 1) / 60), [bx, by] = qpt(p.c, (i + 1) / 60);
        const ang = Math.atan2(by - ay, bx - ax);
        c.save(); c.translate(px, py); c.rotate(ang);
        c.fillStyle = "rgba(0,0,0,0.25)"; c.fillRect(-RIVER_W - 6, -4, RIVER_W * 2 + 12, 9);
        c.fillStyle = "#8a6a4a"; c.fillRect(-RIVER_W - 5, -4.5, RIVER_W * 2 + 10, 8);
        c.strokeStyle = "rgba(60,40,30,0.6)"; c.lineWidth = 0.5;
        for (let k = -RIVER_W - 4; k < RIVER_W + 5; k += 2.5) { c.beginPath(); c.moveTo(k, -4.5); c.lineTo(k, 3.5); c.stroke(); }
        c.fillStyle = "#5a4232"; c.fillRect(-RIVER_W - 5, -5.5, RIVER_W * 2 + 10, 1); c.fillRect(-RIVER_W - 5, 3.5, RIVER_W * 2 + 10, 1);
        c.restore();
        break;
      }
    }
  }
  // flora in fixed world cells
  const C = 48;
  for (let gy = Math.floor((Y - 20) / C); gy <= Math.floor((Y + TW) / C); gy++) for (let gx = Math.floor((X - 20) / C); gx <= Math.floor((X + TW) / C); gx++) {
    const r = rng(hash32(`flora${gx},${gy}`));
    const count = 2;
    for (let i = 0; i < count; i++) {
      const x = gx * C + r() * C, y = gy * C + r() * C;
      const forest = vnoise(x, y, 300, 7), roll = r();
      if (forest > 0.62 && roll < 0.55) { if (!blocked(x + 7, y + 12, homes, paths, 8)) tree(c, x, y, r, pal, 0.9 + r() * 0.5); }
      else if (roll < 0.5) { if (!blocked(x, y, homes, paths, 2)) flowers(c, x, y, r, pal); }
      else if (roll < 0.72) { if (!blocked(x, y, homes, paths, 2)) grass(c, x, y); }
      else if (roll < 0.8) { if (!blocked(x, y, homes, paths, 3)) rock(c, x, y); }
      else if (roll < 0.9 && forest > 0.45) { if (!blocked(x, y, homes, paths, 4)) bush(c, x, y, r, pal); }
    }
  }
  chunkCache.set(key, cv);
  if (chunkCache.size > 70) chunkCache.delete(chunkCache.keys().next().value);
  return cv;
}

// ---------- gardens (blob-shaped, per home) ----------
export function blobPoly(cx, cy, rx, ry, seed, n = 30, wob = 0.12) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const w = 1 + wob * (Math.sin(a * 3 + seed) * 0.6 + Math.sin(a * 5 + seed * 1.7) * 0.4);
    pts.push([cx + Math.cos(a) * rx * w, cy + Math.sin(a) * ry * w]);
  }
  return pts;
}
export function inPoly(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const polyPath = (c, pts) => { c.beginPath(); pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.closePath(); };

// Garden around a home, drawn at scale s: { img, x, y (world), poly }.
export function homeGround(k, s) {
  const l = homeLayout(k);
  const key = `${k}|${l.id}|${season()}|${s}`;
  let g = groundCache.get(key);
  if (g) { groundCache.delete(key); groundCache.set(key, g); return g; }
  const pad = 8;
  const W = l.rx * 2 * 1.15 + pad * 2, H = l.ry * 2 * 1.15 + pad * 2;
  const gx = Math.round(l.cx - W / 2), gy = Math.round(l.cy - H / 2);
  const [cv, c] = newCanvas(W * s, H * s);
  c.scale(s, s);
  c.lineCap = "round"; c.lineJoin = "round";
  const r = rng(hash32(`garden${l.id ?? k}`));
  const pal = palette();
  const seed = (hash32(`g${k}`) % 1000) / 100;
  const poly = blobPoly(W / 2, H / 2, l.rx, l.ry, seed);
  const plan = l.plan;
  // lawn with a soft edge
  polyPath(c, poly);
  const lg = c.createRadialGradient(W / 2, H / 2, 10, W / 2, H / 2, Math.max(l.rx, l.ry) * 1.1);
  lg.addColorStop(0, "#2f4a3c"); lg.addColorStop(1, "#273e32");
  c.fillStyle = lg; c.fill();
  c.strokeStyle = "rgba(20,30,25,0.5)"; c.lineWidth = 1.2; c.stroke();
  const doorL = [l.door[0] - gx, l.door[1] - gy];
  const nearDoor = (x, y) => Math.abs(x - doorL[0]) < 8 && y > doorL[1];
  const fence = r();
  if (fence < 0.75) {
    for (let i = 0; i < poly.length; i++) {
      const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
      const len = Math.hypot(x1 - x0, y1 - y0);
      for (let t = 0; t < len; t += fence < 0.35 ? 3 : 4.5) {
        const x = x0 + ((x1 - x0) * t) / len, y = y0 + ((y1 - y0) * t) / len;
        if (nearDoor(x, y)) continue;
        if (fence < 0.35) { c.strokeStyle = "rgba(236,226,206,0.85)"; c.lineWidth = 0.8; c.beginPath(); c.moveTo(x, y + 1); c.lineTo(x, y - 2.2); c.stroke(); }
        else if (fence < 0.6) { c.fillStyle = "#2f5a40"; c.beginPath(); c.arc(x, y, 2.4, 0, 7); c.fill(); }
        else { c.fillStyle = "#7f7a88"; c.beginPath(); c.ellipse(x, y, 1.8, 1.2, 0, 0, 7); c.fill(); }
      }
    }
    if (fence < 0.35) { polyPath(c, poly); c.strokeStyle = "rgba(220,210,190,0.45)"; c.lineWidth = 0.5; c.stroke(); }
  }
  // garden path from the door to the edge of the garden
  c.beginPath(); c.moveTo(doorL[0], doorL[1]);
  let ey = doorL[1]; while (ey < H && inPoly(poly, doorL[0], ey)) ey += 1;
  c.quadraticCurveTo(doorL[0] + (r() - 0.5) * 10, (doorL[1] + ey) / 2, doorL[0] + (r() - 0.5) * 4, ey + 2);
  c.strokeStyle = pal.path; c.lineWidth = 5; c.stroke();
  // items placed in the garden, outside the building
  const ex = plan.ext;
  const taken = [[l.ox + ex.x0 - gx - 3, l.oy + ex.y0 - gy - 3, l.ox + ex.x1 - gx + 3, l.oy + ex.y1 - gy + 3], [doorL[0] - 6, doorL[1], doorL[0] + 6, H]];
  const fits = (x, y, w, h) => inPoly(poly, x, y) && inPoly(poly, x + w, y + h) && inPoly(poly, x + w, y) && inPoly(poly, x, y + h) &&
    !taken.some(([a, b, c2, d]) => x < c2 && x + w > a && y < d && y + h > b);
  const sz = season();
  const want = ["tree", "bush", "bush", "bed", "tree", r() < 0.35 ? "pond" : "veg", r() < 0.3 ? "well" : "rock", sz === "halloween" ? "pumpkins" : sz === "winter" ? "snowman" : "bush", "bush", "bed"];
  const size = { tree: [14, 17], bush: [8, 6], bed: [12, 5], pond: [16, 10], veg: [14, 8], well: [9, 9], rock: [6, 4], pumpkins: [10, 4], snowman: [7, 10] };
  for (const it of want) {
    const [w, h] = size[it];
    for (let tries = 0; tries < 30; tries++) {
      const x = r() * (W - w), y = r() * (H - h);
      if (!fits(x, y, w, h)) continue;
      taken.push([x - 1, y - 1, x + w + 1, y + h + 1]);
      if (it === "tree") tree(c, x, y, r, pal);
      else if (it === "bush") bush(c, x, y, r, pal);
      else if (it === "rock") rock(c, x, y);
      else if (it === "bed") { c.fillStyle = "#4a3426"; c.beginPath(); c.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, 7); c.fill(); for (let i = 0; i < 6; i++) { c.fillStyle = [pal.fl[0], pal.fl[1], "#b89ae8", "#f7f1e3"][i % 4]; c.beginPath(); c.arc(x + 2 + i * 1.6, y + 1.5 + (i % 2) * 2, 0.9, 0, 7); c.fill(); } }
      else if (it === "pond") { c.fillStyle = "#3a3a2e"; c.beginPath(); c.ellipse(x + w / 2, y + h / 2, w / 2 + 1, h / 2 + 1, 0, 0, 7); c.fill(); const pg = c.createRadialGradient(x + w / 2 - 2, y + h / 2 - 2, 1, x + w / 2, y + h / 2, w / 2); pg.addColorStop(0, "#4f7aa0"); pg.addColorStop(1, "#2a4864"); c.fillStyle = pg; c.beginPath(); c.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, 7); c.fill(); c.fillStyle = "#4f8a5c"; c.beginPath(); c.arc(x + w - 5, y + h - 4, 1.6, 0, 7); c.fill(); }
      else if (it === "veg") { c.fillStyle = "#4a3426"; c.fillRect(x, y, w, h); for (let yy = 1.5; yy < h; yy += 3) for (let xx = 1.5; xx < w; xx += 3) { c.fillStyle = sz === "autumn" || sz === "halloween" ? "#d0803d" : "#6aa874"; c.beginPath(); c.arc(x + xx, y + yy, 0.9, 0, 7); c.fill(); } }
      else if (it === "well") { c.fillStyle = "#7f7a88"; c.beginPath(); c.arc(x + 4.5, y + 5, 4.2, 0, 7); c.fill(); c.fillStyle = "#1b2840"; c.beginPath(); c.arc(x + 4.5, y + 5, 2.6, 0, 7); c.fill(); }
      else if (it === "pumpkins") { for (let i = 0; i < 3; i++) { c.fillStyle = "#d9702a"; c.beginPath(); c.ellipse(x + 2 + i * 3.2, y + 2.5, 1.7, 1.4, 0, 0, 7); c.fill(); c.fillStyle = "#4f8a5c"; c.fillRect(x + 1.7 + i * 3.2, y + 0.4, 0.6, 0.9); } }
      else if (it === "snowman") { c.fillStyle = "#f3f6fa"; c.beginPath(); c.arc(x + 3.5, y + 7, 3, 0, 7); c.fill(); c.beginPath(); c.arc(x + 3.5, y + 2.5, 2, 0, 7); c.fill(); }
      break;
    }
  }
  // mailbox at the gate
  { const mx = doorL[0] + 7, my = Math.min(H - 8, doorL[1] + 10); c.fillStyle = "#4a3a2e"; c.fillRect(mx, my, 0.8, 4); c.fillStyle = r() < 0.5 ? "#c85a4a" : "#4a6a9a"; c.fillRect(mx - 1.2, my - 2, 3.2, 2.2); }
  g = { img: cv, x: gx, y: gy, w: W, h: H, poly: poly.map(([x, y]) => [x + gx, y + gy]) };
  groundCache.set(key, g);
  if (groundCache.size > 90) groundCache.delete(groundCache.keys().next().value);
  return g;
}

// ---------- features ----------
const featCache = new Map();
const FEAT = 168;
export function featureImage(f, graves, s) {
  const key = `${f.slot}|${f.kind}|${season()}|${f.kind === "cemetery" ? Math.ceil(graves / 8) : 0}|${s}`;
  let img = featCache.get(key);
  if (img) return img;
  const [cv, c] = newCanvas(FEAT * s, FEAT * s);
  c.scale(s, s);
  c.lineCap = "round"; c.lineJoin = "round";
  const m = FEAT / 2;
  const r = rng(hash32("feat" + f.slot));
  const pal = palette();
  if (f.kind === "plaza") {
    const p = blobPoly(m, m, 52, 44, f.slot, 28, 0.06);
    polyPath(c, p); const g = c.createRadialGradient(m, m, 6, m, m, 56); g.addColorStop(0, "#6f6878"); g.addColorStop(1, "#4f4a5a"); c.fillStyle = g; c.fill();
    c.strokeStyle = "rgba(255,255,255,0.06)"; c.lineWidth = 0.6;
    for (let rr = 14; rr < 50; rr += 6) { c.beginPath(); c.ellipse(m, m, rr, rr * 0.85, 0, 0, 7); c.stroke(); }
    c.fillStyle = "#8a8494"; c.beginPath(); c.ellipse(m, m, 13, 10, 0, 0, 7); c.fill();
    const wg = c.createRadialGradient(m - 3, m - 2, 1, m, m, 10); wg.addColorStop(0, "#6f9cc4"); wg.addColorStop(1, "#2a4864");
    c.fillStyle = wg; c.beginPath(); c.ellipse(m, m, 10, 7.5, 0, 0, 7); c.fill();
    c.fillStyle = "rgba(220,235,255,0.7)"; c.beginPath(); c.arc(m, m - 1, 1.6, 0, 7); c.fill();
    for (const [x, y] of [[m - 36, m - 2], [m + 26, m - 1]]) { c.fillStyle = "#7a5a40"; c.beginPath(); c.roundRect?.(x, y, 10, 3.5, 1.2); c.fill(); }
    for (const [x, y] of [[m - 40, m - 28], [m + 38, m - 26], [m - 34, m + 28]]) lamp(c, x, y);
  } else if (f.kind === "pond") {
    const p = blobPoly(m, m, 50, 36, f.slot, 30, 0.16);
    polyPath(c, blobPoly(m, m, 54, 40, f.slot, 30, 0.16)); c.fillStyle = "#3a3a2e"; c.fill();
    polyPath(c, p); const g = c.createRadialGradient(m - 10, m - 8, 4, m, m, 52); g.addColorStop(0, "#4a7298"); g.addColorStop(1, "#24405c"); c.fillStyle = g; c.fill();
    for (let i = 0; i < 6; i++) { const x = m - 30 + r() * 60, y = m - 20 + r() * 40; if (inPoly(p, x, y)) { c.fillStyle = "#4f8a5c"; c.beginPath(); c.arc(x, y, 2.4, 0.3, 6.1); c.lineTo(x, y); c.fill(); if (r() < 0.5) { c.fillStyle = "#f2b8c8"; c.beginPath(); c.arc(x + 0.6, y - 0.6, 0.8, 0, 7); c.fill(); } } }
    c.fillStyle = "#7a5a40"; c.fillRect(m + 38, m + 9, 15, 3.5);
    tree(c, m - 66, m - 40, r, pal); tree(c, m + 46, m - 46, r, pal);
  } else if (f.kind === "grove" || f.kind === "orchard") {
    const n = f.kind === "grove" ? 12 : 9;
    const pl = f.kind === "orchard" ? { ...pal, leaf: [pal.leaf[0], "#c86a52", pal.leaf[2]] } : pal;
    for (let i = 0; i < n; i++) { const a = i * GOLDEN * 3 + f.slot, rr = 14 + 50 * Math.sqrt(i / n); tree(c, m + Math.cos(a) * rr - 7, m + Math.sin(a) * rr * 0.8 - 9, r, pl, 1 + r() * 0.4); }
  } else if (f.kind === "meadow") {
    const p = blobPoly(m, m, 62, 52, f.slot, 26, 0.1);
    for (let i = 0; i < 220; i++) { const x = m - 60 + r() * 120, y = m - 50 + r() * 100; if (inPoly(p, x, y)) { c.fillStyle = [pal.fl[0], pal.fl[1], "#f7f1e3", "#b89ae8"][i % 4]; c.beginPath(); c.arc(x, y, 0.7, 0, 7); c.fill(); } }
    for (let i = 0; i < 10; i++) grass(c, m - 40 + r() * 80, m - 30 + r() * 60);
    c.fillStyle = "#7a5a40"; c.fillRect(m - 5, m + 4, 10, 3.5);
  } else if (f.kind === "well") {
    c.fillStyle = "#7f7a88"; c.beginPath(); c.arc(m, m, 7, 0, 7); c.fill();
    c.fillStyle = "#1b2840"; c.beginPath(); c.arc(m, m, 4.5, 0, 7); c.fill();
    c.strokeStyle = "#7a5a40"; c.lineWidth = 1.5; c.beginPath(); c.moveTo(m - 8, m - 8); c.lineTo(m + 8, m - 8); c.stroke();
    tree(c, m - 40, m - 30, r, pal); tree(c, m + 28, m + 6, r, pal);
  } else if (f.kind === "cemetery") {
    const rr = Math.min(70, 34 + Math.sqrt(Math.max(1, graves)) * 7);
    const p = blobPoly(m, m, rr, rr * 0.82, f.slot, 34, 0.08);
    polyPath(c, p); const g = c.createRadialGradient(m, m, 6, m, m, rr); g.addColorStop(0, "#2b3f35"); g.addColorStop(1, "#22342b"); c.fillStyle = g; c.fill();
    // wrought-iron fence: thin rail + posts, a gate at the bottom
    c.strokeStyle = "rgba(30,26,40,0.9)"; c.lineWidth = 0.5; polyPath(c, p); c.stroke();
    for (let i = 0; i < p.length; i++) {
      const [x0, y0] = p[i], [x1, y1] = p[(i + 1) % p.length], len = Math.hypot(x1 - x0, y1 - y0);
      for (let t = 0; t < len; t += 2.6) {
        const x = x0 + ((x1 - x0) * t) / len, y = y0 + ((y1 - y0) * t) / len;
        if (y > m && Math.abs(x - m) < 7) continue;
        c.strokeStyle = "rgba(30,26,40,0.9)"; c.lineWidth = 0.45; c.beginPath(); c.moveTo(x, y + 0.6); c.lineTo(x, y - 3); c.stroke();
      }
    }
    c.strokeStyle = "rgba(30,26,40,0.9)"; c.lineWidth = 0.7; c.beginPath(); c.arc(m, m + rr * 0.82 - 3, 7, Math.PI, 0); c.stroke();
    lamp(c, m - rr + 6, m + 8); lamp(c, m + rr - 8, m - 6);
    const dim = { ...pal, leaf: ["#34463c", "#44584c", "#2a3a32"] };
    tree(c, m - rr - 6, m - rr * 0.6, r, dim, 1.2); tree(c, m + rr - 8, m - rr * 0.8, r, dim, 1.1);
  }
  img = { img: cv, size: FEAT };
  featCache.set(key, img);
  if (featCache.size > 60) featCache.delete(featCache.keys().next().value);
  return img;
}
function lamp(c, x, y) {
  const g = c.createRadialGradient(x + 1, y - 1, 0, x + 1, y - 1, 10); g.addColorStop(0, "rgba(255,200,120,0.35)"); g.addColorStop(1, "rgba(255,200,120,0)");
  c.fillStyle = g; c.fillRect(x - 10, y - 11, 22, 22);
  c.fillStyle = "#2a2436"; c.fillRect(x + 0.4, y, 1.2, 7);
  c.fillStyle = "#ffd28a"; c.beginPath(); c.arc(x + 1, y - 1, 1.6, 0, 7); c.fill();
}

// Graves spiral outward from the middle of the cemetery (oldest in the middle).
export function gravePos(i) {
  const a = (i + 3) * GOLDEN, rr = 9 * Math.sqrt(i + 2);
  return [Math.cos(a) * rr, Math.sin(a) * rr * 0.8];
}
export const CEMETERY_CAP = 52;

// Far zoom: river + paths as strokes straight onto the screen.
export function drawLowLod(ctx, x0, y0, x1, y1, n, toScreen, s) {
  const pal = palette();
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.strokeStyle = pal.water;
  ctx.lineWidth = Math.max(2, RIVER_W * 2 * s);
  ctx.beginPath();
  for (let x = x0 - 20; x <= x1 + 20; x += 16) { const [sx, sy] = toScreen(x, riverY(x)); x === x0 - 20 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy); }
  ctx.stroke();
  ctx.strokeStyle = pal.path;
  ctx.lineWidth = Math.max(1, 4 * s);
  ctx.beginPath();
  for (const p of pathsIn(x0, y0, x1, y1, n)) {
    const [a, b] = toScreen(p.c[0], p.c[1]), [c2, d] = toScreen(p.c[2], p.c[3]), [e, f] = toScreen(p.c[4], p.c[5]);
    ctx.moveTo(a, b); ctx.quadraticCurveTo(c2, d, e, f);
  }
  ctx.stroke();
}
