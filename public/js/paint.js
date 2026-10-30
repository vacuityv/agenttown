// Style painter: a tiny canvas-like object that the dwelling art code draws through. The same drawing
// calls (fillRect, paths, clip…) come out as pixel art, flat shapes, ink sketch, watercolor, low-poly,
// blueprint, neon or storybook illustration. Everything except "pixel" is rendered at device resolution.
import { rng } from "./util.js";

export const RENDER_STYLES = ["pixel", "flat", "sketch", "watercolor", "lowpoly", "blueprint", "neon", "storybook"];
export const isRenderStyle = (s) => RENDER_STYLES.includes(s);

const OUTLINE = "#140f1c";

function rgb(col) {
  if (typeof col !== "string") return null;
  let m = col.match(/^#([0-9a-f]{6})$/i);
  if (m) { const n = parseInt(m[1], 16); return [n >> 16, (n >> 8) & 255, n & 255, 1]; }
  m = col.match(/^#([0-9a-f]{3})$/i);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16)).concat(1);
  m = col.match(/^rgba?\(([^)]+)\)$/);
  if (m) { const p = m[1].split(",").map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; }
  return null;
}
const css = ([r, g, b, a = 1]) => `rgba(${r | 0},${g | 0},${b | 0},${a})`;
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] ?? 1];
const lum = (c) => (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;

export const STYLE_BACKDROP = {
  sketch: "#efe6d2", watercolor: "#f3ecdf", blueprint: "#1d4f8a", neon: "#0d0b18", storybook: "#f6e7c8",
};

export class Painter {
  constructor(ctx, style, seed = 1) {
    this.c = ctx;
    this.st = style;
    this.r = rng(seed);
    this._fill = "#000";
    this.unit = 1; // art px per device px is handled by the ctx transform
  }
  set fillStyle(v) { this._fill = v; }
  get fillStyle() { return this._fill; }
  set strokeStyle(v) { this.c.strokeStyle = v; }
  set lineWidth(v) { this.c.lineWidth = v; }
  beginPath() { this.c.beginPath(); }
  moveTo(x, y) { this.c.moveTo(x, y); }
  lineTo(x, y) { this.c.lineTo(x, y); }
  closePath() { this.c.closePath(); }
  ellipse(...a) { this.c.ellipse(...a); }
  rect(...a) { this.c.rect(...a); }
  save() { this.c.save(); }
  restore() { this.c.restore(); }
  clip() { this.c.clip(); }
  translate(x, y) { this.c.translate(x, y); }
  clearRect(x, y, w, h) { if (this.st === "pixel") this.c.clearRect(x, y, w, h); }
  strokeRect(x, y, w, h) {
    if (this.st === "blueprint") this.c.strokeStyle = "rgba(220,235,255,0.5)";
    else if (this.st === "neon") this.c.strokeStyle = "rgba(255,120,220,0.5)";
    this.c.strokeRect(x, y, w, h);
  }

  // Backdrop under a room's floor for styles that redraw floors as lines.
  backdrop(x, y, w, h) {
    const c = this.c, st = this.st;
    if (!STYLE_BACKDROP[st]) return;
    c.fillStyle = STYLE_BACKDROP[st];
    c.fillRect(x, y, w, h);
    if (st === "blueprint") {
      c.strokeStyle = "rgba(200,225,255,0.18)"; c.lineWidth = 0.2;
      c.beginPath();
      for (let gx = Math.ceil(x / 4) * 4; gx < x + w; gx += 4) { c.moveTo(gx, y); c.lineTo(gx, y + h); }
      for (let gy = Math.ceil(y / 4) * 4; gy < y + h; gy += 4) { c.moveTo(x, gy); c.lineTo(x + w, gy); }
      c.stroke();
    }
    if (st === "neon") {
      c.strokeStyle = "rgba(120,80,255,0.12)"; c.lineWidth = 0.2;
      c.beginPath();
      for (let gy = Math.ceil(y / 6) * 6; gy < y + h; gy += 6) { c.moveTo(x, gy); c.lineTo(x + w, gy); }
      c.stroke();
    }
  }

  fillRect(x, y, w, h) {
    const c = this.c, st = this.st, col = this._fill;
    if (st === "pixel") { c.fillStyle = col; c.fillRect(x, y, w, h); return; }
    const k = rgb(col);
    if (!k) { c.fillStyle = col; c.fillRect(x, y, w, h); return; }
    const isOutline = col === OUTLINE;
    const tiny = w * h <= 2;
    const r = this.r;
    switch (st) {
      case "flat": {
        if (tiny && !isOutline) return;
        c.fillStyle = isOutline ? "#2a2236" : css(k);
        c.fillRect(x, y, w, h);
        return;
      }
      case "sketch": {
        if (tiny) { if (r() < 0.5) return; }
        if (isOutline) {
          c.strokeStyle = "rgba(48,40,32,0.9)"; c.lineWidth = 0.32;
          const j = () => (r() - 0.5) * 0.5;
          c.beginPath(); c.moveTo(x + j(), y + j()); c.lineTo(x + w + j(), y + j()); c.lineTo(x + w + j(), y + h + j()); c.lineTo(x + j(), y + h + j()); c.closePath(); c.stroke();
          return;
        }
        const pale = mix(k, [239, 230, 210], 0.55);
        c.fillStyle = css(pale); c.fillRect(x, y, w, h);
        if (w >= 3 && h >= 3) {
          c.save(); c.beginPath(); c.rect(x, y, w, h); c.clip();
          c.strokeStyle = css([...mix(k, [40, 32, 26], 0.4).slice(0, 3), 0.35]); c.lineWidth = 0.18;
          c.beginPath();
          for (let t = 0; t < w + h; t += 1.6) { c.moveTo(x + t, y); c.lineTo(x + t - h, y + h); }
          c.stroke(); c.restore();
        }
        return;
      }
      case "watercolor": {
        if (tiny) return;
        if (isOutline) { c.fillStyle = "rgba(70,50,60,0.18)"; c.fillRect(x, y, w, h); return; }
        const wash = mix(k, [255, 245, 230], 0.2);
        for (let p = 0; p < 2; p++) {
          const ox = (r() - 0.5) * 0.8, oy = (r() - 0.5) * 0.8, rad = Math.min(w, h) * (0.25 + r() * 0.25);
          c.fillStyle = css([...wash.slice(0, 3), p ? 0.28 : 0.5]);
          roundRect(c, x + ox, y + oy, w, h, rad); c.fill();
        }
        return;
      }
      case "lowpoly": {
        if (tiny && !isOutline) return;
        if (isOutline || w < 3 || h < 3) { c.fillStyle = isOutline ? "#1c1828" : css(k); c.fillRect(x, y, w, h); return; }
        const a = mix(k, [255, 255, 255], 0.1), b = mix(k, [0, 0, 0], 0.14);
        c.fillStyle = css(a); c.beginPath(); c.moveTo(x, y); c.lineTo(x + w, y); c.lineTo(x, y + h); c.closePath(); c.fill();
        c.fillStyle = css(b); c.beginPath(); c.moveTo(x + w, y); c.lineTo(x + w, y + h); c.lineTo(x, y + h); c.closePath(); c.fill();
        return;
      }
      case "blueprint": {
        if (isOutline || tiny) return;
        c.fillStyle = "rgba(255,255,255,0.05)"; c.fillRect(x, y, w, h);
        c.strokeStyle = lum(k) > 0.55 ? "rgba(235,245,255,0.95)" : "rgba(200,225,255,0.7)"; c.lineWidth = 0.22;
        c.strokeRect(x + 0.1, y + 0.1, w - 0.2, h - 0.2);
        return;
      }
      case "neon": {
        if (isOutline || tiny) return;
        const glow = mix(k, [255, 255, 255], 0.25);
        c.fillStyle = "rgba(18,14,36,0.92)"; c.fillRect(x, y, w, h);
        c.save();
        c.shadowColor = css(glow); c.shadowBlur = 6;
        c.strokeStyle = css(glow); c.lineWidth = 0.3;
        c.strokeRect(x + 0.15, y + 0.15, w - 0.3, h - 0.3);
        c.restore();
        return;
      }
      case "storybook": {
        if (tiny && !isOutline) return;
        if (isOutline) { c.fillStyle = "#3a2418"; roundRect(c, x, y, w, h, Math.min(w, h) * 0.3); c.fill(); return; }
        const warm = mix(k, [255, 176, 112], 0.16);
        c.fillStyle = css(warm); roundRect(c, x, y, w, h, Math.min(w, h) * 0.3); c.fill();
        if (w >= 4 && h >= 3) { c.fillStyle = "rgba(255,240,210,0.25)"; c.fillRect(x + 0.6, y + 0.4, w - 1.2, Math.min(1, h * 0.25)); }
        return;
      }
    }
    c.fillStyle = col; c.fillRect(x, y, w, h);
  }

  // Fill the current path in style.
  fill() {
    const c = this.c, st = this.st, col = this._fill;
    const k = rgb(col);
    if (st === "pixel" || !k) { c.fillStyle = col; c.fill(); return; }
    const isOutline = col === OUTLINE;
    switch (st) {
      case "sketch": c.fillStyle = css(mix(k, [239, 230, 210], 0.55)); c.fill(); c.strokeStyle = "rgba(48,40,32,0.85)"; c.lineWidth = 0.3; c.stroke(); return;
      case "watercolor": c.fillStyle = css([...mix(k, [255, 245, 230], 0.2).slice(0, 3), isOutline ? 0.18 : 0.55]); c.fill(); return;
      case "blueprint": if (!isOutline) { c.fillStyle = "rgba(255,255,255,0.05)"; c.fill(); c.strokeStyle = "rgba(225,240,255,0.9)"; c.lineWidth = 0.25; c.stroke(); } return;
      case "neon": if (!isOutline) { c.fillStyle = "rgba(18,14,36,0.9)"; c.fill(); c.save(); c.shadowColor = css(mix(k, [255, 255, 255], 0.25)); c.shadowBlur = 6; c.strokeStyle = css(mix(k, [255, 255, 255], 0.25)); c.lineWidth = 0.35; c.stroke(); c.restore(); } return;
      case "storybook": c.fillStyle = isOutline ? "#3a2418" : css(mix(k, [255, 176, 112], 0.16)); c.fill(); if (!isOutline) { c.strokeStyle = "#3a2418"; c.lineWidth = 0.45; c.stroke(); } return;
      case "lowpoly": c.fillStyle = isOutline ? "#1c1828" : css(k); c.fill(); return;
      default: c.fillStyle = isOutline ? "#2a2236" : css(k); c.fill();
    }
  }
}

export function roundRect(c, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  c.beginPath();
  c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r);
  c.lineTo(x + w, y + h - r); c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  c.lineTo(x + r, y + h); c.quadraticCurveTo(x, y + h, x, y + h - r);
  c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y);
  c.closePath();
}

// Make a canvas of w×h art px at scale s and hand back a Painter for it.
export function styledCanvas(w, h, s, style, seed) {
  const cv = document.createElement("canvas");
  const S = style === "pixel" ? 1 : s;
  cv.width = Math.max(1, Math.ceil(w * S));
  cv.height = Math.max(1, Math.ceil(h * S));
  const ctx = cv.getContext("2d");
  ctx.imageSmoothingEnabled = style !== "pixel";
  if (S !== 1) ctx.scale(S, S);
  return [cv, new Painter(ctx, style, seed)];
}
