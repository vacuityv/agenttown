// Sprites: procedural default characters (in the protocol's sprite format) + one shared renderer.
//
// Format (docs/protocol.md): { v:1, size, palette:[...≤16], frames:{ idle:[rows[]], working:[...], thinking:[...] } }
// rows are `size` strings of `size` hex chars; "0" = transparent.
//
// Default characters are little office workers sitting behind a laptop: the scene draws the desk over
// sprite rows >= 24, the laptop lid covers x 11..20 / rows 17..24, hands rest on the desk at row 23.
import { hash32, rng, offscreen } from "./util.js";

const S = 32;

const SKINS = ["#ffdcc0", "#f5c6a0", "#e3a97f", "#c98b62", "#a06a45", "#74492f"];
const HAIRS = ["#2b2233", "#4a3226", "#7a4a2a", "#b8743a", "#e8c46a", "#e6dfd3", "#b04a4a", "#5a7bd8", "#e48bc0", "#3f8f6e", "#ff9a3c", "#6b5b95"];
const SHIRTS = ["#e07a5f", "#3d5a80", "#81b29a", "#f2cc8f", "#9d6bd8", "#e5989b", "#5fa8d3", "#d9534f", "#56607a", "#c97b3a", "#2a9d8f", "#f4a259"];
const ACCENTS = ["#ffb454", "#7ec8e3", "#ff7aa2", "#9be37e", "#c9a0ff", "#f7f1e3", "#ff6b5b"];
const HAIR_STYLES = ["short", "bob", "spiky", "long", "bun", "ponytail", "curly", "buzz", "side"];
const ACCESSORIES = ["none", "none", "glasses", "headphones", "cap", "beanie", "bow", "flower", "sprout", "glasses"];
const OUTFITS = ["tee", "tie", "hoodie", "sweater", "collar"];

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v) => Math.max(0, Math.min(255, Math.round(f < 0 ? v * (1 + f) : v + (255 - v) * f)));
  const r = ch(n >> 16), g = ch((n >> 8) & 255), b = ch(n & 255);
  return "#" + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

// Palette slots
const T = 0, OUT = 1, SK = 2, SKS = 3, HR = 4, HRS = 5, SH = 6, SHS = 7, EYE = 8, WH = 9, AC = 10, BL = 11, AC2 = 12, MO = 13, DET = 14, HRH = 15;

function grid() { return Array.from({ length: S }, () => new Array(S).fill(T)); }
function px(g, x, y, c) { if (x >= 0 && y >= 0 && x < S && y < S) g[y][x] = c; }
function rect(g, x0, y0, x1, y1, c) { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) px(g, x, y, c); }

function outline(g) {
  const src = g.map((r) => r.slice());
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    if (src[y][x] !== T) continue;
    const n = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
      const v = src[y + dy]?.[x + dx];
      return v !== undefined && v !== T && v !== OUT;
    });
    if (n) g[y][x] = OUT;
  }
}

function genome(seed, kind) {
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const g = {
    skin: pick(SKINS), hair: pick(HAIRS), shirt: pick(SHIRTS), accent: pick(ACCENTS), accent2: pick(ACCENTS),
    hairStyle: pick(HAIR_STYLES), accessory: pick(ACCESSORIES), outfit: pick(OUTFITS), blush: r() < 0.7,
    mouth: r() < 0.5 ? "smile" : "dot",
    pants: pick(["#3b4a6b", "#4a3f5c", "#5a4a3a", "#2f3a4a", "#6b5a7a", "#3f5a4f"]),
  };
  // A light nod to the agent kind, without making everyone look alike.
  if (kind === "claude-code" && r() < 0.5) g.shirt = pick(["#d97757", "#c96442", "#e8a07a"]);
  if (kind === "codex" && r() < 0.5) g.shirt = pick(["#2a9d8f", "#3d5a80", "#4a4e69"]);
  if (g.accent === g.shirt) g.accent = "#ffb454";
  return g;
}

function drawCharacter(G, pose) {
  // pose: { hands: "rest"|"typeA"|"typeB"|"chin", eyes: "open"|"blink"|"up"|"upRight" }
  const g = grid();
  const style = G.hairStyle;

  // Back hair (behind everything)
  if (style === "long") rect(g, 8, 6, 23, 23, HRS);
  if (style === "ponytail") { rect(g, 23, 7, 25, 15, HR); rect(g, 24, 15, 25, 18, HRS); }

  // Body / shirt
  rect(g, 10, 19, 21, 26, SH);
  px(g, 10, 19, T); px(g, 21, 19, T);
  rect(g, 20, 21, 20, 26, SHS);
  // Legs (hidden behind desks, shown when walking): pants + shoes
  rect(g, 11, 27, 20, 27, EYE);
  rect(g, 11, 28, 14, 29, EYE); rect(g, 17, 28, 20, 29, EYE);
  rect(g, 10, 30, 14, 31, OUT); rect(g, 17, 30, 21, 31, OUT);
  // Neck
  rect(g, 14, 18, 17, 18, SKS);
  // Outfit details
  if (G.outfit === "tee") { px(g, 14, 19, SKS); px(g, 15, 19, SKS); px(g, 16, 19, SKS); px(g, 17, 19, SKS); px(g, 15, 20, SKS); px(g, 16, 20, SKS); }
  if (G.outfit === "tie") { px(g, 13, 19, WH); px(g, 14, 19, WH); px(g, 17, 19, WH); px(g, 18, 19, WH); rect(g, 15, 19, 16, 19, DET); rect(g, 15, 20, 16, 23, DET); }
  if (G.outfit === "hoodie") { rect(g, 11, 18, 20, 19, SHS); rect(g, 14, 19, 17, 19, SKS); px(g, 14, 20, WH); px(g, 17, 20, WH); px(g, 14, 21, WH); px(g, 17, 21, WH); }
  if (G.outfit === "sweater") { rect(g, 13, 19, 18, 19, DET); rect(g, 11, 22, 19, 22, DET); }
  if (G.outfit === "collar") { px(g, 13, 19, WH); px(g, 14, 20, WH); px(g, 18, 19, WH); px(g, 17, 20, WH); rect(g, 15, 19, 16, 19, SKS); }

  // Arms + hands (sleeves in the shadow tone so they read against the body)
  const arm = (side, handY) => {
    const sx = side < 0 ? 9 : 21;
    rect(g, sx, 20, sx + 1, Math.max(20, handY - 1), SHS);
    px(g, side < 0 ? sx : sx + 1, 19, SHS);
    rect(g, sx, handY, sx + 1, handY, SK);
  };
  if (pose.hands === "chin") {
    // left hand resting, right hand scratching the side of the head
    arm(-1, 23);
    rect(g, 22, 15, 23, 20, SHS);
    rect(g, 23, 12, 24, 14, SK);
    px(g, 24, 12, SKS);
  } else {
    arm(-1, pose.hands === "typeA" ? 22 : 23);
    arm(1, pose.hands === "typeB" ? 22 : 23);
  }

  // Head
  rect(g, 9, 5, 22, 17, SK);
  for (const [x, y] of [[9, 5], [22, 5], [9, 17], [22, 17], [9, 6], [22, 6]]) px(g, x, y, T);
  rect(g, 10, 17, 21, 17, SKS);
  px(g, 8, 11, SK); px(g, 8, 12, SK); px(g, 23, 11, SK); px(g, 23, 12, SK);

  // Hair (front)
  const cap = () => { rect(g, 9, 3, 22, 7, HR); px(g, 9, 3, T); px(g, 22, 3, T); rect(g, 10, 2, 21, 2, HR); px(g, 10, 2, T); px(g, 21, 2, T); };
  if (style === "buzz") { rect(g, 9, 4, 22, 6, HRS); px(g, 9, 4, T); px(g, 22, 4, T); }
  else cap();
  if (style === "short" || style === "spiky" || style === "curly") { rect(g, 9, 7, 9, 10, HR); rect(g, 22, 7, 22, 10, HR); rect(g, 10, 8, 21, 8, HR); px(g, 13, 8, SK); px(g, 18, 8, SK); }
  if (style === "bob" || style === "long") { rect(g, 8, 6, 9, 16, HR); rect(g, 22, 6, 23, 16, HR); rect(g, 10, 8, 21, 8, HR); rect(g, 10, 9, 12, 9, HR); rect(g, 19, 9, 21, 9, HR); }
  if (style === "side" || style === "ponytail") { rect(g, 9, 7, 9, 11, HR); rect(g, 22, 7, 22, 9, HR); rect(g, 10, 8, 17, 8, HR); rect(g, 10, 9, 14, 9, HR); px(g, 10, 10, HR); }
  if (style === "bun") { rect(g, 13, 0, 18, 2, HR); px(g, 13, 0, T); px(g, 18, 0, T); rect(g, 9, 7, 9, 10, HR); rect(g, 22, 7, 22, 10, HR); rect(g, 10, 8, 21, 8, HR); }
  if (style === "spiky") { for (const x of [10, 13, 16, 19]) { px(g, x, 1, HR); px(g, x + 1, 1, HR); px(g, x + 1, 0, HR); } }
  if (style === "curly") { for (let x = 9; x <= 22; x += 2) px(g, x, 2, HR); px(g, 8, 5, HR); px(g, 23, 5, HR); px(g, 8, 8, HR); px(g, 23, 8, HR); }
  if (style !== "buzz") { px(g, 12, 3, HRH); px(g, 13, 3, HRH); px(g, 14, 4, HRH); }

  // Face
  const ey = pose.eyes === "up" || pose.eyes === "upRight" ? 10 : 11;
  const ex = pose.eyes === "upRight" ? 1 : 0;
  if (pose.eyes === "blink") { rect(g, 12, 12, 13, 12, OUT); rect(g, 18, 12, 19, 12, OUT); }
  else {
    rect(g, 12 + ex, ey, 13 + ex, ey + 1, OUT); rect(g, 18 + ex, ey, 19 + ex, ey + 1, OUT);
    px(g, 13 + ex, ey, WH); px(g, 19 + ex, ey, WH);
  }
  if (G.blush) { px(g, 10, 14, BL); px(g, 11, 14, BL); px(g, 20, 14, BL); px(g, 21, 14, BL); }
  if (G.mouth === "smile") { px(g, 15, 15, MO); px(g, 16, 15, MO); px(g, 14, 14, MO); px(g, 17, 14, MO); }
  else { px(g, 15, 15, MO); px(g, 16, 15, MO); }

  // Accessories
  const a = G.accessory;
  if (a === "glasses") {
    for (const ox of [11, 17]) {
      rect(g, ox, 10, ox + 3, 10, OUT); rect(g, ox, 13, ox + 3, 13, OUT); px(g, ox, 11, OUT); px(g, ox, 12, OUT); px(g, ox + 3, 11, OUT); px(g, ox + 3, 12, OUT);
    }
    px(g, 15, 11, OUT); px(g, 16, 11, OUT);
  }
  if (a === "headphones") { rect(g, 9, 1, 22, 1, AC); px(g, 8, 2, AC); px(g, 23, 2, AC); rect(g, 7, 3, 8, 8, AC); rect(g, 23, 3, 24, 8, AC); rect(g, 6, 9, 8, 13, AC); rect(g, 23, 9, 25, 13, AC); px(g, 7, 11, AC2); px(g, 24, 11, AC2); }
  if (a === "cap") { rect(g, 9, 1, 22, 6, AC); px(g, 9, 1, T); px(g, 22, 1, T); rect(g, 8, 7, 17, 7, AC2); px(g, 15, 2, WH); }
  if (a === "beanie") { rect(g, 9, 1, 22, 6, AC); px(g, 9, 1, T); px(g, 22, 1, T); rect(g, 9, 6, 22, 7, AC2); rect(g, 15, 0, 16, 0, WH); }
  if (a === "bow") { rect(g, 18, 1, 19, 3, AC); rect(g, 22, 1, 23, 3, AC); rect(g, 20, 2, 21, 2, AC2); }
  if (a === "flower") { px(g, 20, 1, AC); px(g, 19, 2, AC); px(g, 21, 2, AC); px(g, 20, 3, AC); px(g, 20, 2, AC2); }
  if (a === "sprout") { px(g, 16, 0, "sprout"); px(g, 16, 1, "sprout"); px(g, 15, 0, "sprout"); px(g, 17, 0, "sprout"); }
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (g[y][x] === "sprout") g[y][x] = DET; // reuse slot; set below

  outline(g);
  return g;
}

const memoDefaults = new Map();

// Deterministic default sprite in protocol format.
export function defaultSprite(personaId, kind = "") {
  const key = personaId + "|" + kind;
  if (memoDefaults.has(key)) return memoDefaults.get(key);
  const G = genome(hash32(personaId), kind);
  const detail = G.accessory === "sprout" ? "#7fd36b" : G.outfit === "tie" ? G.accent : G.outfit === "sweater" ? shade(G.shirt, 0.35) : WHITE;
  const palette = [
    "transparent", "#241a2b", G.skin, shade(G.skin, -0.16), G.hair, shade(G.hair, -0.28), G.shirt, shade(G.shirt, -0.22),
    G.pants, "#fff8ec", G.accent, "#ff9b9b", shade(G.accent, -0.3), "#8a3b46", detail, shade(G.hair, 0.3),
  ];
  const toRows = (g) => g.map((r) => r.map((c) => c.toString(16)).join(""));
  const f = (hands, eyes) => toRows(drawCharacter(G, { hands, eyes }));
  const sprite = {
    v: 1, size: S, palette,
    frames: {
      idle: [f("rest", "open"), f("rest", "blink")],
      working: [f("typeA", "open"), f("typeB", "open"), f("typeA", "open"), f("typeB", "blink")],
      thinking: [f("chin", "up"), f("chin", "upRight")],
    },
  };
  memoDefaults.set(key, sprite);
  return sprite;
}
const WHITE = "#fff8ec";

// ---- validation of server-provided sprites ----

const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
const ROW_RE = /^[0-9a-fA-F]+$/;

export function validSprite(sp) {
  if (!sp || typeof sp !== "object" || sp.v !== 1) return false;
  const size = sp.size;
  if (!Number.isInteger(size) || size < 8 || size > 64) return false;
  if (!Array.isArray(sp.palette) || sp.palette.length < 2 || sp.palette.length > 16) return false;
  if (!sp.frames || !Array.isArray(sp.frames.idle) || !sp.frames.idle.length) return false;
  for (const state of ["idle", "working", "thinking"]) {
    const fr = sp.frames[state];
    if (fr === undefined && state !== "idle") continue;
    if (!Array.isArray(fr) || fr.length < 1 || fr.length > 4) return false;
    for (const frame of fr) {
      if (!Array.isArray(frame) || frame.length !== size) return false;
      for (const row of frame) if (typeof row !== "string" || row.length !== size || !ROW_RE.test(row)) return false;
    }
  }
  return true;
}

// ---- shared renderer: sprite JSON -> cached offscreen canvases ----

const sheetCache = new Map();

function rasterize(sp) {
  const colors = sp.palette.map((c, i) => (i === 0 || typeof c !== "string" || !COLOR_RE.test(c) ? null : c));
  const toCanvas = (frame) => {
    const [cv, ctx] = offscreen(sp.size, sp.size);
    for (let y = 0; y < sp.size; y++) {
      const row = frame[y];
      for (let x = 0; x < sp.size; x++) {
        const c = colors[parseInt(row[x], 16)];
        if (!c) continue;
        ctx.fillStyle = c;
        ctx.fillRect(x, y, 1, 1);
      }
    }
    return cv;
  };
  const idle = sp.frames.idle.map(toCanvas);
  return {
    size: sp.size,
    idle,
    working: sp.frames.working ? sp.frames.working.map(toCanvas) : idle,
    thinking: sp.frames.thinking ? sp.frames.thinking.map(toCanvas) : idle,
  };
}

export function spriteVersion(persona) {
  return persona?.sprite && validSprite(persona.sprite) ? "c" + hash32(JSON.stringify(persona.sprite)) : "d";
}

// Returns { size, idle:[canvas], working:[canvas], thinking:[canvas] } for a persona.
export function sheetFor(persona) {
  const id = persona?.id ?? "unknown";
  const key = id + "|" + spriteVersion(persona) + "|" + (persona?.kind ?? "");
  let sheet = sheetCache.get(key);
  if (!sheet) {
    const sp = persona?.sprite && validSprite(persona.sprite) ? persona.sprite : defaultSprite(id, persona?.kind);
    sheet = rasterize(sp);
    sheetCache.set(key, sheet);
  }
  return sheet;
}

// Pick the frame for a status at time t (ms). seed de-syncs characters from each other.
export function frameFor(sheet, status, t, seed = 0) {
  if (status === "tool") {
    const fr = sheet.working;
    return fr[Math.floor((t + seed) / 170) % fr.length];
  }
  if (status === "thinking") {
    const fr = sheet.thinking;
    return fr[Math.floor((t + seed) / 650) % fr.length];
  }
  const fr = sheet.idle;
  if (fr.length === 1) return fr[0];
  // Mostly frame 0, with a brief blink (frame 1) every few seconds.
  const p = (t + seed) % 3700;
  return p < 140 ? fr[1] : fr[0];
}

// Little canvas element showing a persona's idle frame (for lists).
export function spriteIcon(persona, scale = 2) {
  const sheet = sheetFor(persona);
  const c = document.createElement("canvas");
  const dpr = window.devicePixelRatio || 1;
  const px = Math.max(1, Math.round(scale * dpr));
  c.width = sheet.size * px;
  c.height = sheet.size * px;
  c.style.width = (sheet.size * px) / dpr + "px";
  c.style.height = (sheet.size * px) / dpr + "px";
  c.className = "sprite-icon";
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(sheet.idle[0], 0, 0, c.width, c.height);
  return c;
}


// ---- derived poses (work for any sprite): walk cycle, sitting, sleeping ----

const poseCache = new Map();

function blank(size) { return offscreen(size, size); }

function flipped(src) {
  const [c, x] = offscreen(src.width, src.height);
  x.translate(src.width, 0);
  x.scale(-1, 1);
  x.drawImage(src, 0, 0);
  return c;
}

// Returns { walk:[4], walkL:[4] (mirrored), sit, sleep } canvases for a persona.
export function posesFor(persona) {
  const sheet = sheetFor(persona);
  let p = poseCache.get(sheet);
  if (p) return p;
  const n = sheet.size;
  const base = sheet.idle[0];
  const legTop = Math.round(n * 0.8);       // rows below this are legs/feet
  const half = n / 2;
  const walk = [0, 1, 2, 3].map((f) => {
    const [c, x] = blank(n);
    const bob = f === 1 || f === 3 ? -1 : 0;
    const liftL = f === 1 ? 2 : 0, liftR = f === 3 ? 2 : 0;
    const strideL = f === 1 ? -1 : f === 3 ? 1 : 0, strideR = -strideL;
    // legs first so the body covers the top of a lifted leg
    x.drawImage(base, 0, legTop, half, n - legTop, strideL, legTop - liftL + bob + 1, half, n - legTop);
    x.drawImage(base, half, legTop, half, n - legTop, half + strideR, legTop - liftR + bob + 1, half, n - legTop);
    x.drawImage(base, 0, 0, n, legTop, 0, bob + 1, n, legTop);
    return c;
  });
  // sitting: upper body lowered, legs tucked (only the top of the legs shows)
  const [sit, sx] = blank(n);
  sx.drawImage(base, 0, 0, n, legTop + 2, 0, 3, n, legTop + 2);
  // sleeping: eyes closed if the sprite has a blink frame; only head & shoulders (blanket covers the rest)
  const [sleep, zx] = blank(n);
  const closed = sheet.idle[1] ?? base;
  zx.drawImage(closed, 0, 0, n, Math.round(n * 0.66), 0, 0, n, Math.round(n * 0.66));
  p = { size: n, walk, walkL: walk.map(flipped), sit, sleep };
  poseCache.set(sheet, p);
  return p;
}
