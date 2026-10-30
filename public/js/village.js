// The village, without a grid. Homes are placed on a golden-angle (phyllotaxis) spiral by creation index
// with hash jitter, so the village grows outward organically and existing homes never move. Some spiral
// slots are left as meadows / features (plazas, ponds, groves, the cemetery); a winding river crosses the
// valley; curvy footpaths join every home to its nearest older neighbours (with little bridges over the
// river). Terrain (grass tones, flowers, tall grass, rocks, tree clusters) comes from value noise.
//
// Rendering is split into invisible 256 px chunks purely for caching — nothing in the art follows them.
import { PAL } from "./art.js";
import { planFor, season, onDwellingChange } from "./interior.js";
import { hash32, rng, offscreen } from "./util.js";

const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const SPACING = 124;
export const CHUNK = 256;
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

// ---------- terrain chunks ----------
function R(c, x, y, w, h, col) { c.fillStyle = col; c.fillRect(x, y, w, h); }

function palette() {
  const sz = season();
  if (sz === "winter") return { g: ["#2a3f45", "#33494f", "#22363a", "#3a5258"], fl: ["#e8eef5", "#cfd8e0"], leaf: ["#2f4f45", "#e8eef5", "#22392f"] };
  if (sz === "autumn" || sz === "halloween") return { g: ["#2a3a2c", "#324230", "#233226", "#3a4632"], fl: ["#e8913a", "#c9503a"], leaf: ["#c9632a", "#e08a3a", "#8a3f22"] };
  if (sz === "spring") return { g: [PAL.grass, PAL.grass2, PAL.grass3, "#2a4f3f"], fl: [PAL.flower, "#f7f1e3"], leaf: ["#3f8a5a", "#f2b8c8", "#2a5e40"] };
  return { g: [PAL.grass, PAL.grass2, PAL.grass3, "#2a4f3f"], fl: [PAL.flower, PAL.flower2], leaf: ["#2a6a48", "#3f8a5a", "#1c4a34"] };
}

export function tree(c, x, y, r, pal = palette()) {
  const leaf = pal.leaf;
  if (r() < 0.3) { // conifer
    R(c, x + 5, y + 13, 2, 4, PAL.trunk);
    for (let i = 0; i < 4; i++) { const w = 3 + i * 2; R(c, x + 6 - (w >> 1) - 1, y + i * 3, w + 2, 4, PAL.outline); R(c, x + 6 - (w >> 1), y + 1 + i * 3, w, 3, i % 2 ? leaf[2] : leaf[0]); }
    return;
  }
  R(c, x + 5, y + 11, 3, 6, PAL.trunk);
  R(c, x, y + 2, 13, 10, PAL.outline); R(c, x + 2, y, 9, 14, PAL.outline);
  R(c, x + 1, y + 3, 11, 8, leaf[0]); R(c, x + 3, y + 1, 7, 12, leaf[0]);
  R(c, x + 3, y + 2, 4, 3, leaf[1]); R(c, x + 8, y + 9, 2, 2, leaf[2]);
}

function blocked(x, y, homes, paths, margin) {
  if (Math.abs(y - riverY(x)) < RIVER_W + 6 + margin) return true;
  for (const l of homes) { const dx = (x - l.cx) / (l.rx + margin), dy = (y - l.cy) / (l.ry + margin); if (dx * dx + dy * dy < 1) return true; }
  for (const f of _features) if (Math.hypot(x - f.x, y - f.y) < f.r + margin) return true;
  for (const p of paths) for (let t = 0; t <= 1; t += 0.05) { const [px, py] = qpt(p.c, t); if (Math.abs(px - x) < 6 + margin && Math.abs(py - y) < 6 + margin) return true; }
  return false;
}
let _features = [];
export function setFeatures(list) { _features = list; }

export function chunkImage(ix, iy) {
  const n = countHomes();
  const key = `${ix},${iy}|${n}|${season()}`;
  let img = chunkCache.get(key);
  if (img) { chunkCache.delete(key); chunkCache.set(key, img); return img; }
  const [cv, c] = offscreen(CHUNK, CHUNK);
  const X = ix * CHUNK, Y = iy * CHUNK;
  const pal = palette();
  // grass tones from noise
  for (let y = 0; y < CHUNK; y += 4) for (let x = 0; x < CHUNK; x += 4) {
    const v = vnoise(X + x, Y + y, 90) * 0.7 + vnoise(X + x, Y + y, 23, 1) * 0.3;
    R(c, x, y, 4, 4, v < 0.33 ? pal.g[2] : v < 0.55 ? pal.g[0] : v < 0.75 ? pal.g[1] : pal.g[3]);
  }
  const r = rng(hash32(`chunk${ix},${iy}`));
  for (let i = 0; i < 500; i++) R(c, (r() * CHUNK) | 0, (r() * CHUNK) | 0, 1, 1, r() < 0.5 ? pal.g[1] : pal.g[2]);
  // river
  for (let x = 0; x < CHUNK; x++) {
    const yc = riverY(X + x) - Y;
    if (yc < -RIVER_W - 6 || yc > CHUNK + RIVER_W + 6) continue;
    R(c, x, Math.round(yc - RIVER_W - 3), 1, 3, "#5a4a3a");
    R(c, x, Math.round(yc + RIVER_W), 1, 3, "#5a4a3a");
    R(c, x, Math.round(yc - RIVER_W), 1, RIVER_W * 2, "#2f5a86");
    if ((X + x) % 9 < 3) R(c, x, Math.round(yc - 4 + 3 * Math.sin((X + x) / 13)), 1, 1, "#7fb2e6");
    if ((X + x) % 13 === 0) R(c, x, Math.round(yc + 6), 2, 1, "#5f8fc0");
  }
  const homes = homesIn(X, Y, X + CHUNK, Y + CHUNK, n, 160).map(homeLayout);
  const paths = pathsIn(X, Y, X + CHUNK, Y + CHUNK, n);
  // footpaths (with bridges where they cross the river)
  for (const p of paths) {
    const steps = 80;
    for (let i = 0; i <= steps; i++) {
      const [px, py] = qpt(p.c, i / steps);
      const x = Math.round(px - X), y = Math.round(py - Y);
      if (x < -6 || y < -6 || x > CHUNK + 6 || y > CHUNK + 6) continue;
      const onWater = Math.abs(py - riverY(px)) < RIVER_W + 3;
      if (onWater) { R(c, x - 4, y - 3, 8, 6, PAL.outline); R(c, x - 3, y - 2, 6, 4, "#9a6e48"); R(c, x - 3, y, 6, 1, "#7a5035"); continue; }
      if (p.style === 0) R(c, x - 2, y - 2, 5, 5, "#6e5a44");
      else if (p.style === 1) { if (i % 3 === 0) { R(c, x - 2, y - 1, 4, 3, "#8a8494"); R(c, x - 2, y - 1, 4, 1, "#a7a3ad"); } }
      else { R(c, x - 2, y - 2, 5, 4, "#7a6a50"); if (i % 2) R(c, x, y, 1, 1, "#8a7a60"); }
    }
  }
  // flora scattered by noise: tree clusters where the "forest" noise is high, flowers in meadows
  const items = 90;
  for (let i = 0; i < items; i++) {
    const x = (r() * CHUNK) | 0, y = (r() * CHUNK) | 0;
    const wx = X + x, wy = Y + y;
    const forest = vnoise(wx, wy, 300, 7);
    const roll = r();
    if (forest > 0.62 && roll < 0.45) { if (!blocked(wx + 6, wy + 10, homes, paths, 8)) tree(c, x, y, r, pal); }
    else if (roll < 0.62) { if (!blocked(wx, wy, homes, paths, 2)) { for (let k = 0; k < 5; k++) R(c, x + ((r() * 8) | 0), y + ((r() * 6) | 0), 1, 1, pal.fl[k % 2]); } }
    else if (roll < 0.78) { if (!blocked(wx, wy, homes, paths, 2)) { R(c, x, y, 1, 3, pal.g[3]); R(c, x + 2, y - 1, 1, 4, pal.g[3]); R(c, x + 4, y, 1, 3, pal.g[3]); } } // tall grass
    else if (roll < 0.84) { if (!blocked(wx, wy, homes, paths, 3)) { R(c, x, y, 5, 3, "#6e6878"); R(c, x + 1, y, 2, 1, "#8a8494"); } }
    else if (roll < 0.9 && forest > 0.45) { if (!blocked(wx, wy, homes, paths, 4)) { R(c, x, y, 7, 5, PAL.outline); R(c, x + 1, y + 1, 5, 3, "#3f8a5a"); } }
  }
  chunkCache.set(key, cv);
  if (chunkCache.size > 220) chunkCache.delete(chunkCache.keys().next().value);
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

// Garden image around a home: { img, x, y } in world px.
export function homeGround(k) {
  const l = homeLayout(k);
  const key = `${k}|${l.id}|${season()}`;
  let g = groundCache.get(key);
  if (g) return g;
  const pad = 8;
  const W = Math.ceil(l.rx * 2 * 1.15 + pad * 2), H = Math.ceil(l.ry * 2 * 1.15 + pad * 2);
  const [cv, c] = offscreen(W, H);
  const gx = Math.round(l.cx - W / 2), gy = Math.round(l.cy - H / 2);
  const r = rng(hash32(`garden${l.id ?? k}`));
  const pal = palette();
  const seed = (hash32(`g${k}`) % 1000) / 100;
  const poly = blobPoly(W / 2, H / 2, l.rx, l.ry, seed);
  const style = r();
  const plan = l.plan;
  // lawn
  c.beginPath(); poly.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.closePath();
  c.fillStyle = plan.kind === "camp" ? pal.g[2] : pal.g[3];
  c.fill();
  c.save(); c.clip();
  for (let i = 0; i < 220; i++) R(c, (r() * W) | 0, (r() * H) | 0, 1, 1, r() < 0.5 ? pal.g[0] : pal.g[1]);
  c.restore();
  // fence / hedge following the blob (with a gap at the path)
  const doorL = [l.door[0] - gx, l.door[1] - gy];
  const nearDoor = (x, y) => Math.abs(x - doorL[0]) < 8 && y > doorL[1];
  if (plan.kind === "house" || plan.kind === "greenhouse") {
    for (let i = 0; i < poly.length; i++) {
      const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
      const len = Math.hypot(x1 - x0, y1 - y0);
      for (let t = 0; t < len; t += style < 0.4 ? 3 : 4) {
        const x = Math.round(x0 + ((x1 - x0) * t) / len), y = Math.round(y0 + ((y1 - y0) * t) / len);
        if (nearDoor(x, y)) continue;
        if (style < 0.4) R(c, x, y - 2, 1, 3, "#efe6d4");
        else if (style < 0.7) { R(c, x - 1, y - 2, 4, 4, PAL.outline); R(c, x, y - 1, 2, 2, "#3f7a4a"); }
        else if (style < 0.85) R(c, x, y, 3, 2, "#8a8494");
      }
    }
  }
  // garden path from the door to the blob edge
  for (let y = doorL[1]; y < H - 2; y++) { if (!inPoly(poly, doorL[0], y)) break; R(c, Math.round(doorL[0] - 3 + Math.sin(y / 6) * 1.5), y, 6, 1, "#6e5a44"); }
  // garden items in the blob but outside the building
  const ex = plan.ext;
  const bx0 = l.ox + ex.x0 - gx - 3, by0 = l.oy + ex.y0 - gy - 3, bx1 = l.ox + ex.x1 - gx + 3, by1 = l.oy + ex.y1 - gy + 3;
  const taken = [[bx0, by0, bx1, by1], [doorL[0] - 6, doorL[1], doorL[0] + 6, H]];
  const fits = (x, y, w, h) => inPoly(poly, x, y) && inPoly(poly, x + w, y + h) && inPoly(poly, x + w, y) && inPoly(poly, x, y + h) &&
    !taken.some(([a, b, c2, d]) => x < c2 && x + w > a && y < d && y + h > b);
  const sz = season();
  const want = ["tree", "bush", "bush", "bed", "tree", r() < 0.35 ? "pond" : "veg", r() < 0.3 ? "well" : "rock", sz === "halloween" ? "pumpkins" : sz === "winter" ? "snowman" : "bush", "bush", "bed"];
  const size = { tree: [13, 17], bush: [7, 5], bed: [12, 5], pond: [16, 10], veg: [14, 8], well: [9, 10], rock: [5, 3], pumpkins: [10, 4], snowman: [7, 10] };
  for (const it of want) {
    const [w, h] = size[it];
    for (let tries = 0; tries < 30; tries++) {
      const x = (r() * (W - w)) | 0, y = (r() * (H - h)) | 0;
      if (!fits(x, y, w, h)) continue;
      taken.push([x - 1, y - 1, x + w + 1, y + h + 1]);
      if (it === "tree") tree(c, x, y, r, pal);
      else if (it === "bush") { R(c, x, y, 7, 5, PAL.outline); R(c, x + 1, y + 1, 5, 3, r() < 0.5 ? "#3f8a5a" : "#4f9a5c"); if (r() < 0.5) R(c, x + 2, y + 1, 1, 1, pal.fl[0]); }
      else if (it === "bed") { R(c, x, y, w, h, "#5a3a2a"); for (let i = 1; i < w - 1; i += 2) R(c, x + i, y + 1 + (i % 4 ? 0 : 2), 1, 1, [PAL.flower, PAL.flower2, "#9d6bd8", "#f7f1e3"][(i >> 1) % 4]); }
      else if (it === "pond") { c.fillStyle = PAL.outline; c.beginPath(); c.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, 7); c.fill(); c.fillStyle = "#3f6c9a"; c.beginPath(); c.ellipse(x + w / 2, y + h / 2, w / 2 - 1, h / 2 - 1, 0, 0, 7); c.fill(); R(c, x + 4, y + 3, 3, 1, "#7fb2e6"); R(c, x + w - 6, y + h - 4, 3, 2, "#4f9a5c"); }
      else if (it === "veg") { R(c, x, y, w, h, "#5a3a2a"); for (let yy = 1; yy < h; yy += 3) for (let xx = 1; xx < w; xx += 3) R(c, x + xx, y + yy, 2, 1, sz === "autumn" || sz === "halloween" ? "#e8913a" : "#6ab874"); }
      else if (it === "well") { R(c, x, y + 3, 9, 7, PAL.outline); R(c, x + 1, y + 4, 7, 5, "#8a8494"); R(c, x + 2, y + 5, 5, 3, "#1b2350"); R(c, x, y, 9, 2, "#8a4a36"); }
      else if (it === "rock") { R(c, x, y, 5, 3, "#6e6878"); R(c, x + 1, y, 2, 1, "#8a8494"); }
      else if (it === "pumpkins") { for (let i = 0; i < 3; i++) { R(c, x + i * 3, y + 1, 3, 3, "#e8732a"); R(c, x + i * 3 + 1, y, 1, 1, "#4f9a5c"); } }
      else if (it === "snowman") { R(c, x + 1, y + 4, 5, 5, "#f3f6fa"); R(c, x + 2, y, 3, 4, "#f3f6fa"); R(c, x + 4, y + 2, 2, 1, "#e8732a"); }
      break;
    }
  }
  // mailbox at the garden gate
  { const mx = doorL[0] + 6, my = Math.min(H - 8, doorL[1] + 10); R(c, mx, my, 1, 5, PAL.trunk); R(c, mx - 1, my - 2, 4, 3, r() < 0.5 ? "#d9534f" : "#3d5a80"); }
  g = { img: cv, x: gx, y: gy, poly: poly.map(([x, y]) => [x + gx, y + gy]) };
  groundCache.set(key, g);
  if (groundCache.size > 500) groundCache.delete(groundCache.keys().next().value);
  return g;
}

// ---------- features ----------
const featCache = new Map();
export function featureImage(f, graves = 0) {
  const key = `${f.slot}|${f.kind}|${season()}|${f.kind === "cemetery" ? Math.ceil(graves / 8) : 0}`;
  let img = featCache.get(key);
  if (img) return img;
  const S = 168;
  const [cv, c] = offscreen(S, S);
  const m = S / 2;
  const r = rng(hash32("feat" + f.slot));
  const pal = palette();
  const poly = blobPoly(m, m, 66, 58, f.slot % 7, 26, 0.1);
  const fillPoly = (pts, col) => { c.fillStyle = col; c.beginPath(); pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.closePath(); c.fill(); };
  if (f.kind === "plaza") {
    fillPoly(blobPoly(m, m, 52, 44, f.slot, 22, 0.08), "#5a5468");
    for (let y = m - 44; y < m + 44; y += 3) for (let x = m - 54; x < m + 54; x += 4) {
      if (((x - m) / 52) ** 2 + ((y - m) / 44) ** 2 > 0.92) continue;
      R(c, x + ((y / 3) % 2 ? 2 : 0), y, 3, 2, r() < 0.5 ? "#7a7484" : "#86808f");
    }
    c.fillStyle = PAL.outline; c.beginPath(); c.ellipse(m, m, 13, 10, 0, 0, 7); c.fill();
    c.fillStyle = "#a7a3ad"; c.beginPath(); c.ellipse(m, m, 12, 9, 0, 0, 7); c.fill();
    c.fillStyle = "#3f6c9a"; c.beginPath(); c.ellipse(m, m, 9, 6.5, 0, 0, 7); c.fill();
    R(c, m - 1, m - 4, 2, 5, "#cfe6ff");
    for (const [x, y] of [[m - 36, m - 4], [m + 26, m - 2]]) { R(c, x, y, 10, 4, PAL.outline); R(c, x + 1, y + 1, 8, 2, "#9a6e48"); }
    for (const [x, y] of [[m - 40, m - 28], [m + 38, m - 26], [m - 34, m + 28]]) { R(c, x, y, 2, 8, PAL.outline); R(c, x - 1, y - 2, 4, 3, PAL.lamp); }
    R(c, m - 6, m + 26, 12, 8, PAL.outline); R(c, m - 5, m + 27, 10, 6, "#9a6e48"); R(c, m - 4, m + 28, 3, 2, "#f3e9d2"); R(c, m + 1, m + 29, 3, 2, "#f2cc8f");
  } else if (f.kind === "pond") {
    const p = blobPoly(m, m, 50, 36, f.slot, 24, 0.16);
    fillPoly(blobPoly(m, m, 54, 40, f.slot, 24, 0.16), "#5a4a3a");
    fillPoly(p, "#2f5a86");
    for (let i = 0; i < 14; i++) { const x = m - 40 + r() * 80, y = m - 28 + r() * 56; if (inPoly(p, x, y)) R(c, x | 0, y | 0, 3, 1, "#5f8fc0"); }
    for (let i = 0; i < 5; i++) { const x = m - 30 + r() * 60, y = m - 20 + r() * 40; if (inPoly(p, x, y)) { R(c, x | 0, y | 0, 4, 3, "#4f9a5c"); if (r() < 0.5) R(c, (x | 0) + 1, (y | 0), 1, 1, "#f2b8c8"); } }
    R(c, m + 40, m + 10, 14, 4, PAL.outline); R(c, m + 41, m + 11, 12, 2, "#9a6e48"); // little jetty
    tree(c, m - 66, m - 40, r, pal); tree(c, m + 46, m - 46, r, pal);
  } else if (f.kind === "grove" || f.kind === "orchard") {
    const n = f.kind === "grove" ? 12 : 9;
    for (let i = 0; i < n; i++) {
      const a = i * GOLDEN * 3 + f.slot, rr = 14 + 50 * Math.sqrt(i / n);
      const x = m + Math.cos(a) * rr - 6, y = m + Math.sin(a) * rr * 0.8 - 8;
      tree(c, x | 0, y | 0, r, f.kind === "orchard" ? { ...pal, leaf: [pal.leaf[0], "#e07a5f", pal.leaf[2]] } : pal);
    }
  } else if (f.kind === "meadow") {
    for (let i = 0; i < 160; i++) { const x = m - 60 + r() * 120, y = m - 50 + r() * 100; if (inPoly(poly, x, y)) R(c, x | 0, y | 0, 1, 1, [pal.fl[0], pal.fl[1], "#f7f1e3", "#9d6bd8"][i % 4]); }
    for (let i = 0; i < 6; i++) { const x = m - 40 + r() * 80, y = m - 30 + r() * 60; R(c, x | 0, y | 0, 1, 3, pal.g[3]); R(c, (x | 0) + 2, (y | 0) - 1, 1, 4, pal.g[3]); }
    R(c, m - 5, m + 4, 10, 4, PAL.outline); R(c, m - 4, m + 5, 8, 2, "#9a6e48"); // a lone bench
  } else if (f.kind === "well") {
    R(c, m - 6, m - 3, 13, 11, PAL.outline); R(c, m - 5, m - 2, 11, 9, "#8a8494"); R(c, m - 3, m, 7, 5, "#1b2350");
    R(c, m - 7, m - 9, 15, 3, "#8a4a36"); R(c, m - 6, m - 6, 1, 3, PAL.trunk); R(c, m + 6, m - 6, 1, 3, PAL.trunk);
    tree(c, m - 40, m - 30, r, pal); tree(c, m + 28, m + 6, r, pal);
  } else if (f.kind === "cemetery") {
    // free-form graveyard: mown grass inside a wobbly iron fence, a gate, lanterns, two old trees
    const rr = Math.min(70, 34 + Math.sqrt(Math.max(1, graves)) * 7);
    const p = blobPoly(m, m, rr, rr * 0.82, f.slot, 30, 0.08);
    fillPoly(p, "#22362c");
    for (let i = 0; i < 120; i++) { const x = m - rr + r() * rr * 2, y = m - rr + r() * rr * 2; if (inPoly(p, x, y)) R(c, x | 0, y | 0, 1, 1, "#2a4234"); }
    for (let i = 0; i < p.length; i++) {
      const [x0, y0] = p[i], [x1, y1] = p[(i + 1) % p.length];
      const len = Math.hypot(x1 - x0, y1 - y0);
      for (let t = 0; t < len; t += 3) {
        const x = Math.round(x0 + ((x1 - x0) * t) / len), y = Math.round(y0 + ((y1 - y0) * t) / len);
        if (y > m && Math.abs(x - m) < 7) continue; // gate gap
        R(c, x, y - 3, 1, 4, "#3a3448"); if (t % 6 === 0) R(c, x, y - 4, 1, 1, "#6e6878");
      }
    }
    R(c, m - 8, m + rr * 0.82 - 6, 1, 8, "#3a3448"); R(c, m + 7, m + rr * 0.82 - 6, 1, 8, "#3a3448"); R(c, m - 8, m + rr * 0.82 - 7, 16, 1, "#3a3448");
    for (const [x, y] of [[m - rr + 6, m + 8], [m + rr - 8, m - 6]]) { R(c, x, y, 2, 7, PAL.outline); R(c, x - 1, y - 3, 4, 3, PAL.lamp); }
    tree(c, m - rr - 6, m - rr * 0.6, r, { ...pal, leaf: ["#3a4a3a", "#4a5a4a", "#2a3a2a"] });
    tree(c, m + rr - 8, m - rr * 0.8, r, { ...pal, leaf: ["#3a4a3a", "#4a5a4a", "#2a3a2a"] });
  }
  img = { img: cv, size: S, poly: poly.map(([x, y]) => [x - m, y - m]) };
  featCache.set(key, img);
  if (featCache.size > 120) featCache.delete(featCache.keys().next().value);
  return img;
}

// Graves spiral outward from the middle of the cemetery (oldest in the middle).
export function gravePos(i) {
  const a = (i + 3) * GOLDEN, rr = 9 * Math.sqrt(i + 2);
  return [Math.cos(a) * rr, Math.sin(a) * rr * 0.8];
}
export const CEMETERY_CAP = 52;

// Low-detail drawing (far zoom): river + paths as strokes.
export function drawLowLod(ctx, x0, y0, x1, y1, n, toScreen, s) {
  ctx.strokeStyle = "#2f5a86";
  ctx.lineWidth = Math.max(2, RIVER_W * 2 * s);
  ctx.beginPath();
  for (let x = x0 - 20; x <= x1 + 20; x += 16) { const [sx, sy] = toScreen(x, riverY(x)); x === x0 - 20 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy); }
  ctx.stroke();
  ctx.strokeStyle = "#6e5a44";
  ctx.lineWidth = Math.max(1, 4 * s);
  ctx.beginPath();
  for (const p of pathsIn(x0, y0, x1, y1, n)) {
    const [a, b] = toScreen(p.c[0], p.c[1]), [c2, d] = toScreen(p.c[2], p.c[3]), [e, f] = toScreen(p.c[4], p.c[5]);
    ctx.moveTo(a, b); ctx.quadraticCurveTo(c2, d, e, f);
  }
  ctx.stroke();
}
