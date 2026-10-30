// Procedural pixel art for the town (houses, lots) and the home interior (room, desks).
// Everything is drawn with fillRect at 1 unit = 1 art pixel into cached offscreen canvases.
import { hash32, rng, offscreen } from "./util.js";

export const PAL = {
  grass: "#1f3b33", grass2: "#24453a", grass3: "#193128", flower: "#e8a0b4", flower2: "#f2d27a",
  road: "#2c2a3d", roadLine: "#4a4662", walk: "#3a3650",
  tree: "#1c4a3a", tree2: "#2a5e48", treeDark: "#123227", trunk: "#4a3328",
  winDark: "#1c2140", winDark2: "#2a3160", winLit: "#ffd27a", winLit2: "#fff1c2", outline: "#140f1c",
  lamp: "#ffcf6e", smoke: "#c9c2d8",
};

const ROOFS = ["#b4513f", "#8f3f5c", "#3f6c8f", "#5b7d4a", "#a8683a", "#6b4f8f", "#2f7f7a", "#9a4a2f"];
const WALLS = ["#e9d8b7", "#d8c3a5", "#c9d4d8", "#d6c7e0", "#e3cfc0", "#c7d6bd"];
const DOORS = ["#6b3f2a", "#3f4f6b", "#7a2f3a", "#2f5a4a"];

function R(ctx, x, y, w, h, c) { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); }

// ---------- town ----------

export const CELL = 56; // lot size in art pixels
export const HOUSE_W = 40, HOUSE_H = 36;

const houseCache = new Map();

// state: 0 dark, 1 lit
export function houseImage(homeId, lit) {
  const key = homeId + "|" + lit;
  let img = houseCache.get(key);
  if (img) return img;
  const h = hash32(homeId);
  const r = rng(h);
  const roof = ROOFS[h % ROOFS.length];
  const wall = WALLS[(h >>> 4) % WALLS.length];
  const door = DOORS[(h >>> 8) % DOORS.length];
  const style = (h >>> 12) % 3; // 0 gable, 1 wide, 2 tower
  const [c, ctx] = offscreen(HOUSE_W, HOUSE_H);
  const roofDark = shade(roof, -0.25), roofLight = shade(roof, 0.18);
  const wallDark = shade(wall, -0.18);
  const O = PAL.outline;

  // chimney (left or right)
  const chimX = r() < 0.5 ? 9 : 27;
  R(ctx, chimX - 1, 1, 6, 10, O);
  R(ctx, chimX, 2, 4, 9, "#7a5a52");
  R(ctx, chimX, 2, 4, 1, "#9a7a6a");

  // walls
  const wy = 16, wx = 4, ww = 32, wh = 18;
  R(ctx, wx - 1, wy - 1, ww + 2, wh + 2, O);
  R(ctx, wx, wy, ww, wh, wall);
  R(ctx, wx, wy + wh - 3, ww, 3, wallDark);
  // roof
  if (style === 2) {
    // tower: taller narrow roof
    for (let i = 0; i < 14; i++) {
      const inset = Math.max(0, 12 - i);
      R(ctx, 2 + inset - 1, 3 + i, 36 - inset * 2 + 2, 1, O);
    }
    for (let i = 0; i < 13; i++) {
      const inset = Math.max(0, 12 - i);
      R(ctx, 2 + inset, 4 + i, 36 - inset * 2, 1, i % 3 === 2 ? roofDark : roof);
    }
  } else {
    const top = style === 1 ? 6 : 4;
    for (let i = 0; i <= 16 - top; i++) {
      const inset = Math.max(0, (16 - top - i) * (style === 1 ? 1 : 1.4)) | 0;
      R(ctx, 1 + inset - 1, top + i - 1, 38 - inset * 2 + 2, 2, O);
    }
    for (let i = 0; i < 16 - top; i++) {
      const inset = Math.max(0, (16 - top - i) * (style === 1 ? 1 : 1.4)) | 0;
      R(ctx, 1 + inset, top + i, 38 - inset * 2, 1, i % 3 === 2 ? roofDark : roof);
    }
    R(ctx, 12, top + 1, 16, 1, roofLight);
  }
  R(ctx, 1, 16, 38, 1, roofDark);

  // windows
  const winCol = lit ? PAL.winLit : PAL.winDark;
  const winHi = lit ? PAL.winLit2 : PAL.winDark2;
  for (const x of [7, 26]) {
    R(ctx, x - 1, 20, 9, 8, O);
    R(ctx, x, 21, 7, 6, winCol);
    R(ctx, x, 21, 3, 2, winHi);
    R(ctx, x + 3, 21, 1, 6, O);
    R(ctx, x, 23, 7, 1, O);
    // flower box
    R(ctx, x - 1, 28, 9, 2, "#5a3a2a");
    if (r() < 0.7) { R(ctx, x, 27, 1, 1, PAL.flower); R(ctx, x + 3, 27, 1, 1, PAL.flower2); R(ctx, x + 6, 27, 1, 1, PAL.flower); }
  }
  // door
  R(ctx, 16, 22, 8, 13, O);
  R(ctx, 17, 23, 6, 12, door);
  R(ctx, 17, 23, 6, 1, shade(door, 0.25));
  R(ctx, 21, 29, 1, 1, "#e8c46a");
  if (lit) { R(ctx, 18, 24, 4, 2, PAL.winLit); }
  // step
  R(ctx, 15, 34, 10, 2, "#6e6680");
  houseCache.set(key, c);
  img = c;
  return img;
}

export function chimneyOf(homeId) {
  const r = rng(hash32(homeId));
  return { x: (r() < 0.5 ? 9 : 27) + 2, y: 1 };
}

export function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v) => Math.max(0, Math.min(255, Math.round(f < 0 ? v * (1 + f) : v + (255 - v) * f)));
  return "#" + ((1 << 24) | (ch(n >> 16) << 16) | (ch((n >> 8) & 255) << 8) | ch(n & 255)).toString(16).slice(1);
}

// Lot ground tile: grass, a garden path to the street, a street along the bottom.
// variant: 0 lot with house, 1 empty lot, 2 forest.
const lotCache = new Map();
export function lotImage(cx, cy, variant) {
  const seed = hash32(`${cx},${cy}`);
  const v = seed % 4;
  const key = variant + "|" + v + "|" + (cx % 4 === 0 ? 1 : 0);
  let img = lotCache.get(key);
  if (img) return img;
  const [c, ctx] = offscreen(CELL, CELL);
  const r = rng(hash32(key));
  R(ctx, 0, 0, CELL, CELL, PAL.grass);
  for (let i = 0; i < 40; i++) R(ctx, (r() * CELL) | 0, (r() * (CELL - 8)) | 0, 1, 1, r() < 0.5 ? PAL.grass2 : PAL.grass3);
  for (let i = 0; i < 6; i++) R(ctx, (r() * CELL) | 0, (r() * (CELL - 10)) | 0, 1, 1, r() < 0.5 ? PAL.flower : PAL.flower2);
  // street along the bottom, sidewalk
  R(ctx, 0, CELL - 9, CELL, 2, PAL.walk);
  R(ctx, 0, CELL - 7, CELL, 7, PAL.road);
  for (let x = (v * 3) % 8; x < CELL; x += 8) R(ctx, x, CELL - 4, 4, 1, PAL.roadLine);
  // vertical street every 4 columns (left edge)
  if (cx % 4 === 0) {
    R(ctx, 0, 0, 7, CELL, PAL.road);
    R(ctx, 7, 0, 2, CELL - 9, PAL.walk);
    for (let y = 2; y < CELL - 9; y += 8) R(ctx, 3, y, 1, 4, PAL.roadLine);
  }
  if (variant === 0) {
    // garden path from door to sidewalk
    R(ctx, 25, 44, 6, CELL - 9 - 44, "#4d4660");
  }
  lotCache.set(key, c);
  return c;
}

export function drawTree(ctx, x, y, s) {
  // x,y = top-left in art px; s = scale (device px per art px); ctx in device px
  const P = (dx, dy, w, h, col) => { ctx.fillStyle = col; ctx.fillRect(x + dx * s, y + dy * s, w * s, h * s); };
  P(5, 12, 3, 5, PAL.trunk);
  P(1, 2, 11, 11, PAL.outline);
  P(2, 1, 9, 13, PAL.outline);
  P(2, 3, 9, 9, PAL.tree);
  P(3, 2, 7, 11, PAL.tree);
  P(3, 3, 4, 3, PAL.tree2);
  P(8, 9, 2, 2, PAL.treeDark);
}

// ---------- home interior ----------

export const STATION_W = 96, STATION_H = 84, WALL_H = 40, ROOM_PAD = 12;

const FLOOR_A = "#6a4a3c", FLOOR_B = "#5e4134", FLOOR_LINE = "#4a3229";
const WALL = "#3e3150", WALL_DARK = "#2f253e", TRIM = "#7a5a48";

export function roomBackground(cols, rows, homeId) {
  const w = cols * STATION_W + ROOM_PAD * 2;
  const h = WALL_H + rows * STATION_H + ROOM_PAD;
  const [c, ctx] = offscreen(w, h);
  const r = rng(hash32(homeId || "room"));
  // floor planks
  for (let y = WALL_H; y < h; y += 6) {
    R(ctx, 0, y, w, 6, ((y / 6) | 0) % 2 ? FLOOR_A : FLOOR_B);
    R(ctx, 0, y + 5, w, 1, FLOOR_LINE);
    const off = ((y / 6) | 0) * 13 % 40;
    for (let x = off; x < w; x += 40) R(ctx, x, y, 1, 5, FLOOR_LINE);
  }
  // rug in the middle of the desks
  const rugX = ROOM_PAD + 6, rugY = WALL_H + 10, rugW = w - ROOM_PAD * 2 - 12, rugH = h - WALL_H - 22;
  if (rugW > 20 && rugH > 20) {
    R(ctx, rugX, rugY, rugW, rugH, "#5a3448");
    R(ctx, rugX + 2, rugY + 2, rugW - 4, rugH - 4, "#6e3f57");
    R(ctx, rugX + 4, rugY + 4, rugW - 8, 1, "#8a5a6e");
    R(ctx, rugX + 4, rugY + rugH - 5, rugW - 8, 1, "#8a5a6e");
  }
  // wall
  R(ctx, 0, 0, w, WALL_H, WALL);
  for (let x = 0; x < w; x += 8) R(ctx, x, 0, 1, WALL_H - 8, WALL_DARK);
  R(ctx, 0, WALL_H - 8, w, 6, TRIM);
  R(ctx, 0, WALL_H - 8, w, 1, shade(TRIM, 0.2));
  R(ctx, 0, WALL_H - 2, w, 2, "#2a1e22");
  // windows with night sky, posters, clock, shelves
  const slots = Math.floor((w - 16) / 48);
  for (let i = 0; i < slots; i++) {
    const x = 12 + i * 48 + ((w - 16 - slots * 48) >> 1);
    const kind = i % 3 === 1 ? "poster" : i === slots - 1 && slots > 2 ? "clock" : "window";
    if (kind === "window") {
      R(ctx, x, 6, 28, 22, "#241a2b");
      R(ctx, x + 2, 8, 24, 18, "#1b2350");
      R(ctx, x + 2, 8, 24, 6, "#232d63");
      for (let k = 0; k < 5; k++) R(ctx, x + 3 + ((r() * 22) | 0), 9 + ((r() * 15) | 0), 1, 1, "#f5eecf");
      if (i === 0) { R(ctx, x + 18, 10, 4, 4, "#f7e7a8"); R(ctx, x + 19, 10, 3, 3, "#1b2350"); }
      R(ctx, x + 13, 8, 2, 18, "#241a2b");
      R(ctx, x + 2, 16, 24, 1, "#241a2b");
      R(ctx, x - 2, 27, 32, 3, TRIM);
      // plant on the sill
      if (r() < 0.6) { R(ctx, x + 2, 23, 5, 4, "#a8683a"); R(ctx, x + 1, 19, 7, 4, "#4f9a5c"); R(ctx, x + 3, 17, 3, 2, "#6ab874"); }
    } else if (kind === "poster") {
      const col = ["#e07a5f", "#5fa8d3", "#f2cc8f", "#9d6bd8"][(r() * 4) | 0];
      R(ctx, x + 4, 7, 20, 22, "#241a2b");
      R(ctx, x + 5, 8, 18, 20, col);
      R(ctx, x + 8, 12, 12, 8, shade(col, 0.4));
      R(ctx, x + 8, 22, 8, 1, shade(col, -0.4));
      R(ctx, x + 8, 24, 12, 1, shade(col, -0.4));
    } else {
      R(ctx, x + 8, 9, 14, 14, "#241a2b");
      R(ctx, x + 9, 10, 12, 12, "#f3e9d2");
      R(ctx, x + 14, 12, 1, 5, "#241a2b");
      R(ctx, x + 15, 16, 3, 1, "#241a2b");
    }
  }
  // side walls
  R(ctx, 0, WALL_H, 3, h - WALL_H, WALL_DARK);
  R(ctx, w - 3, WALL_H, 3, h - WALL_H, WALL_DARK);
  R(ctx, 0, h - 3, w, 3, WALL_DARK);
  return c;
}

// Desk pieces, drawn in art px into a ctx already scaled to art px.
// Station origin (ox, oy). Character sprite top-left sits at (ox+12, oy+6).
export const CHAR_DX = 12, CHAR_DY = 6;

export function drawChair(ctx, ox, oy) {
  R(ctx, ox + 15, oy + 18, 26, 18, PAL.outline);
  R(ctx, ox + 16, oy + 19, 24, 16, "#3a4a6b");
  R(ctx, ox + 16, oy + 19, 24, 2, "#4d5f85");
}

export function drawDesk(ctx, ox, oy, { screenOn, kind, seed, empty }) {
  const x = ox + CHAR_DX, y = oy + CHAR_DY; // sprite space origin
  const r = rng(seed);
  // desk top + front (top edge sits just under the resting hands at sprite row 23)
  const d = y + 1;
  R(ctx, ox + 4, d + 23, 48, 1, PAL.outline);
  R(ctx, ox + 4, d + 24, 48, 4, "#b5835a");
  R(ctx, ox + 4, d + 24, 48, 1, "#cf9d70");
  R(ctx, ox + 4, d + 28, 48, 12, "#8a5d3f");
  R(ctx, ox + 4, d + 28, 48, 1, PAL.outline);
  R(ctx, ox + 3, d + 23, 1, 18, PAL.outline);
  R(ctx, ox + 52, d + 23, 1, 18, PAL.outline);
  R(ctx, ox + 4, d + 40, 48, 1, PAL.outline);
  R(ctx, ox + 8, d + 31, 16, 6, "#7a5035");
  R(ctx, ox + 15, d + 33, 3, 1, "#e8c46a");
  R(ctx, ox + 32, d + 31, 16, 6, "#7a5035");
  R(ctx, ox + 39, d + 33, 3, 1, "#e8c46a");
  if (empty) return;
  // laptop: lid back (narrow, so shoulders and typing hands stay visible) + base
  R(ctx, x + 11, y + 18, 10, 8, PAL.outline);
  R(ctx, x + 12, y + 19, 8, 6, "#c9cbd6");
  R(ctx, x + 12, y + 19, 8, 1, "#e1e3ec");
  const logo = kind === "claude-code" ? "#d97757" : kind === "codex" ? "#2a9d8f" : "#9d6bd8";
  R(ctx, x + 15, y + 21, 2, 2, screenOn ? logo : shade(logo, -0.4));
  R(ctx, x + 10, y + 25, 12, 1, "#8e90a0");
  // mug or plant
  const deco = (seed >>> 3) % 3;
  if (deco === 0) { R(ctx, ox + 44, d + 20, 5, 5, PAL.outline); R(ctx, ox + 45, d + 21, 3, 4, ["#e07a5f", "#f3e9d2", "#5fa8d3"][(r() * 3) | 0]); R(ctx, ox + 48, d + 22, 2, 2, PAL.outline); }
  else if (deco === 1) { R(ctx, ox + 43, d + 20, 6, 5, "#a8683a"); R(ctx, ox + 42, d + 15, 8, 5, "#4f9a5c"); R(ctx, ox + 44, d + 13, 3, 2, "#6ab874"); }
  else { R(ctx, ox + 6, d + 21, 8, 3, "#f3e9d2"); R(ctx, ox + 6, d + 21, 8, 1, "#e07a5f"); R(ctx, ox + 7, d + 19, 6, 2, "#5fa8d3"); }
}

// Mini side table for a subagent; (x, y) = top-left of the mini sprite slot (20 x 26 art px).
export function drawMiniTable(ctx, x, y) {
  R(ctx, x, y + 14, 20, 1, PAL.outline);
  R(ctx, x, y + 15, 20, 3, "#b5835a");
  R(ctx, x, y + 18, 20, 5, "#8a5d3f");
  R(ctx, x, y + 18, 20, 1, PAL.outline);
  R(ctx, x + 1, y + 23, 2, 2, PAL.outline);
  R(ctx, x + 17, y + 23, 2, 2, PAL.outline);
}

export function drawMiniLaptop(ctx, x, y) {
  R(ctx, x + 6, y + 10, 8, 6, PAL.outline);
  R(ctx, x + 7, y + 11, 6, 4, "#c9cbd6");
}
