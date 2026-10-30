// Sprite format v2: free-form SVG parts with per-part animations and a locomotion style.
//   { v:2, viewBox:"0 0 64 64", style?, parts:[{id, svg, pivot:[x,y]}…] (back-to-front),
//     anim:{ idle:[{part,type,amp,period,phase}], working:[…], thinking:[…], sleeping:[…] },
//     locomotion:"walk|hop|float|roll|slither|scuttle|glide|waddle", ground:60, facing:"left|right|front" }
//
// Each part is rasterized ONCE per size bucket: we build a standalone SVG document string, load it as an
// <img> from a Blob URL (images never run scripts and are never inserted into the DOM), and draw it into an
// offscreen canvas. Per frame we only drawImage those canvases with transforms around each part's pivot.
//
// Personas without a sprite get a deterministic default: some are little pixel office workers (v1), the
// rest are procedural v2 creatures — blobs, robots, sprouts, critters, ghosts, mugs, jellyfish, penguins.
import { hash32, rng } from "./util.js";

const LOCOS = new Set(["walk", "hop", "float", "roll", "slither", "scuttle", "glide", "waddle"]);
const ANIMS = new Set(["bob", "sway", "wiggle", "pulse", "spin", "flap", "blink", "shake"]);
const ESC = (s) => String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]);

// ---------- validation ----------

export function validV2(sp) {
  if (!sp || typeof sp !== "object" || sp.v !== 2) return false;
  const vb = String(sp.viewBox ?? "").trim().split(/[\s,]+/).map(Number);
  if (vb.length !== 4 || vb.some((n) => !Number.isFinite(n)) || vb[2] <= 0 || vb[3] <= 0) return false;
  if (!Array.isArray(sp.parts) || !sp.parts.length || sp.parts.length > 32) return false;
  for (const p of sp.parts) {
    if (!p || typeof p.svg !== "string" || p.svg.length > 40_000) return false;
    if (p.pivot !== undefined && !(Array.isArray(p.pivot) && p.pivot.length === 2 && p.pivot.every(Number.isFinite))) return false;
  }
  if (sp.style !== undefined && (typeof sp.style !== "string" || sp.style.length > 8000)) return false;
  return true;
}

function normalize(sp, key) {
  const vb = String(sp.viewBox).trim().split(/[\s,]+/).map(Number);
  const anim = {};
  for (const st of ["idle", "working", "thinking", "sleeping"]) {
    const list = Array.isArray(sp.anim?.[st]) ? sp.anim[st] : [];
    anim[st] = list.filter((a) => a && ANIMS.has(a.type)).slice(0, 24).map((a) => ({
      part: String(a.part ?? ""), type: a.type,
      amp: Number.isFinite(a.amp) ? Math.max(-90, Math.min(360, a.amp)) : 4,
      period: Number.isFinite(a.period) && a.period > 0.05 ? Math.min(a.period, 30) : 1,
      phase: Number.isFinite(a.phase) ? a.phase : 0,
    }));
  }
  return {
    key, vb,
    style: typeof sp.style === "string" ? sp.style : "",
    parts: sp.parts.map((p, i) => ({ id: String(p.id ?? "p" + i), svg: p.svg, pivot: p.pivot ?? [vb[0] + vb[2] / 2, vb[1] + vb[3] * 0.75] })),
    anim,
    loco: LOCOS.has(sp.locomotion) ? sp.locomotion : "walk",
    ground: Number.isFinite(sp.ground) ? sp.ground : vb[1] + vb[3] * 0.94,
    facing: ["left", "right", "front"].includes(sp.facing) ? sp.facing : "front",
  };
}

// ---------- rasterization ----------

const raster = new Map(); // `${key}|${bucket}` -> { canvases:[], ready, loading }
const RASTER_MAX = 600;

function rasterize(look, bucket) {
  const id = `${look.key}|${bucket}`;
  let r = raster.get(id);
  if (r) return r;
  r = { canvases: new Array(look.parts.length).fill(null), ready: 0 };
  raster.set(id, r);
  if (raster.size > RASTER_MAX) raster.delete(raster.keys().next().value);
  const [vx, vy, vw, vh] = look.vb;
  const pw = Math.max(1, Math.round((bucket * vw) / vh)), ph = bucket;
  look.parts.forEach((p, i) => {
    const doc = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vx} ${vy} ${vw} ${vh}" width="${pw}" height="${ph}">` +
      (look.style ? `<style>${look.style.replace(/<\/?style/gi, "")}</style>` : "") + p.svg + "</svg>";
    const url = URL.createObjectURL(new Blob([doc], { type: "image/svg+xml" }));
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = pw; c.height = ph;
      try { c.getContext("2d").drawImage(img, 0, 0, pw, ph); } catch {}
      r.canvases[i] = c.width && c.height ? c : false;
      r.ready++;
      URL.revokeObjectURL(url);
    };
    img.onerror = () => { r.canvases[i] = false; r.ready++; URL.revokeObjectURL(url); };
    img.src = url;
  });
  return r;
}

// Generic: rasterize a list of SVG fragments (sharing one viewBox) at a given pixel height.
const generic = new Map();
export function svgRaster(key, vb, style, svgs, px) {
  const bucket = [64, 128, 256, 512, 1024].find((b) => b >= px) ?? 1024;
  const id = `${key}|${bucket}`;
  let r = generic.get(id);
  if (!r) {
    const vbn = Array.isArray(vb) ? vb : String(vb).trim().split(/[\s,]+/).map(Number);
    r = rasterize({ key: `g:${key}`, vb: vbn, style, parts: svgs.map((svg, i) => ({ id: "l" + i, svg })) }, bucket);
    generic.set(id, r);
    if (generic.size > 200) generic.delete(generic.keys().next().value);
  }
  if (r.ready >= svgs.length) return r;
  for (const b of [64, 128, 256, 512, 1024]) { const o = generic.get(`${key}|${b}`); if (o && o.ready >= svgs.length) return o; }
  return null;
}

const BUCKETS = [24, 48, 96, 192, 320];
function bestRaster(look, px) {
  const want = BUCKETS.find((b) => b >= px) ?? BUCKETS[BUCKETS.length - 1];
  const r = rasterize(look, want);
  if (r.ready >= look.parts.length) return r;
  for (const b of BUCKETS) { // something already loaded meanwhile?
    const o = raster.get(`${look.key}|${b}`);
    if (o && o.ready >= look.parts.length) return o;
  }
  return null;
}

// ---------- animation ----------

function partTransforms(look, state, tSec) {
  const list = look.anim[state]?.length ? look.anim[state] : state === "sleeping" ? [] : look.anim.idle;
  const tf = new Map();
  const get = (id) => { let x = tf.get(id); if (!x) tf.set(id, (x = { tx: 0, ty: 0, rot: 0, sx: 1, sy: 1 })); return x; };
  for (const a of list) {
    const w = (2 * Math.PI * tSec) / a.period + a.phase;
    const x = get(a.part);
    switch (a.type) {
      case "bob": x.ty += a.amp * Math.sin(w); break;
      case "shake": x.tx += a.amp * Math.sin(w * 3); break;
      case "sway": x.rot += a.amp * Math.sin(w); break;
      case "wiggle": x.rot += a.amp * Math.sin(w * 4); break;
      case "pulse": { const k = 1 + (a.amp / 100) * Math.sin(w); x.sx *= k; x.sy *= k; break; }
      case "spin": x.rot += (360 * tSec) / a.period + a.phase; break;
      case "flap": x.sx *= 1 - (Math.abs(a.amp) / 100) * (0.5 + 0.5 * Math.sin(w)); break;
      case "blink": if ((tSec + a.phase) % a.period < 0.13) x.sy *= 0.1; break;
    }
  }
  return tf;
}

// Whole-body motion for moving/resting characters.
function bodyMotion(look, opts, tSec) {
  const m = { tx: 0, ty: 0, rot: 0, sx: 1, sy: 1, shadowLift: 0 };
  const loco = look.loco;
  if (opts.pose === "sleep") {
    if (!look.anim.sleeping.length) { const k = 1 + 0.035 * Math.sin(tSec * 2.4); m.sx = k; m.sy = 2 - k; }
    return m;
  }
  if (opts.pose === "sit") { m.sy = 0.9; m.sx = 1.05; return m; }
  if (loco === "float" || loco === "glide") { m.ty -= 3 + Math.sin(tSec * 2.2) * 1.5; m.shadowLift = 1; }
  if (opts.pose !== "walk") return m;
  const sp = opts.mini ? 1.7 : 1;
  const ph = tSec * Math.PI * 2 * 1.8 * sp;
  switch (loco) {
    case "walk": m.rot = 4 * Math.sin(ph); m.ty -= Math.abs(Math.sin(ph)) * 2; break;
    case "waddle": m.rot = 9 * Math.sin(ph * 0.8); m.ty -= Math.abs(Math.sin(ph * 0.8)) * 1.5; break;
    case "hop": {
      const p = (tSec * 1.6 * sp) % 1;
      const air = Math.sin(p * Math.PI);
      m.ty -= air * 10;
      if (p < 0.12 || p > 0.88) { m.sy = 0.82; m.sx = 1.15; } else { m.sy = 1 + air * 0.1; m.sx = 1 - air * 0.06; }
      m.shadowLift = air;
      break;
    }
    case "float": m.rot = 3 * Math.sin(ph * 0.5); break;
    case "glide": m.rot = 6 * opts.dir; break;
    case "roll": m.rot = ((opts.travel ?? 0) * 18 * opts.dir) % 360; break;
    case "slither": m.sx = 1 + 0.08 * Math.sin(ph * 1.2); m.rot = 3 * Math.sin(ph * 0.6); m.tx = 1.5 * Math.sin(ph * 0.6); break;
    case "scuttle": m.tx = 1.2 * Math.sin(ph * 3); m.ty -= Math.abs(Math.sin(ph * 3)) * 1; break;
  }
  return m;
}

// Draw a v2 character. cx,footY: device px; h: device px height of the full viewBox.
// opts: { state: idle|working|thinking|sleeping, pose, dir: -1|1, mini, travel, t (ms), shadow }
export function drawV2(ctx, look, cx, footY, h, opts) {
  const r = bestRaster(look, h);
  const tSec = opts.t / 1000;
  const [vx, vy, vw, vh] = look.vb;
  const k = h / vh;
  const m = bodyMotion(look, opts, tSec);
  if (opts.shadow) {
    ctx.fillStyle = `rgba(10, 6, 20, ${0.28 - 0.12 * m.shadowLift})`;
    const sw = vw * 0.5 * k * (1 - 0.25 * m.shadowLift);
    ctx.beginPath(); ctx.ellipse(cx, footY - 0.5 * k, sw / 2, Math.max(1, 2.2 * k), 0, 0, Math.PI * 2); ctx.fill();
  }
  if (!r) return false;
  const flip = (look.facing === "left" && opts.dir > 0) || (look.facing === "right" && opts.dir < 0) ? -1 : 1;
  const tf = partTransforms(look, opts.state, tSec);
  const prevSmooth = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = true;
  ctx.save();
  // body frame: origin at the ground point under the viewBox centre, in viewBox units
  const gx = vx + vw / 2;
  ctx.translate(cx + m.tx * k, footY + m.ty * k);
  ctx.rotate((m.rot * Math.PI) / 180);
  ctx.scale(k * m.sx * flip, k * m.sy);
  ctx.translate(-gx, -look.ground);
  for (let i = 0; i < look.parts.length; i++) {
    const c = r.canvases[i];
    if (!c) continue;
    const p = look.parts[i];
    const x = tf.get(p.id);
    if (x) {
      ctx.save();
      const [px, py] = p.pivot;
      ctx.translate(px + x.tx, py + x.ty);
      if (x.rot) ctx.rotate((x.rot * Math.PI) / 180);
      if (x.sx !== 1 || x.sy !== 1) ctx.scale(x.sx, x.sy);
      ctx.translate(-px, -py);
      ctx.drawImage(c, vx, vy, vw, vh);
      ctx.restore();
    } else ctx.drawImage(c, vx, vy, vw, vh);
  }
  ctx.restore();
  ctx.imageSmoothingEnabled = prevSmooth;
  return true;
}

// Static icon (side panel). Redraws itself once the parts have loaded.
export function drawV2Icon(canvas, look) {
  const ctx = canvas.getContext("2d");
  const paint = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const h = canvas.height * 0.92;
    return drawV2(ctx, look, canvas.width / 2, canvas.height - canvas.height * 0.04 - (1 - (look.ground - look.vb[1]) / look.vb[3]) * h, h, { state: "idle", pose: "stand", dir: 1, t: 0 });
  };
  let tries = 0;
  const tick = () => { if (!paint() && tries++ < 40) setTimeout(tick, 100); };
  tick();
}

// ---------- which look does a persona have? ----------

const lookCache = new Map();
// Returns a normalized v2 look, or null if the persona should use the v1 pixel renderer.
export function lookFor(persona) {
  const sp = persona?.sprite;
  if (sp && sp.v === 2) {
    if (!validV2(sp)) return null;
    const key = "s" + hash32(JSON.stringify(sp));
    let l = lookCache.get(key);
    if (!l) { l = normalize(sp, key); lookCache.set(key, l); }
    return l;
  }
  if (sp) return null; // a v1 sprite: pixel renderer
  const id = persona?.id ?? "unknown";
  const key = "d" + id;
  let l = lookCache.get(key);
  if (l === undefined) {
    const def = defaultCreature(id, persona?.kind);
    l = def ? normalize(def, key) : null;
    lookCache.set(key, l);
  }
  return l;
}

// ---------- procedural default creatures ----------

const PALETTES = [
  ["#7fd36b", "#4f9a5c"], ["#ff9bb3", "#d96a8a"], ["#7ec8e3", "#4a8ab0"], ["#ffcf6e", "#d9a03a"],
  ["#c9a0ff", "#9a6ad8"], ["#ff8a5b", "#d9603a"], ["#9be3d0", "#5ab09a"], ["#f3e9d2", "#c9b896"],
];
const INK = "#241a2b";

function eyes(cx, cy, gap, r = 2.6, extra = "") {
  return `<g>${[-1, 1].map((s) => `<circle cx="${cx + s * gap}" cy="${cy}" r="${r}" fill="${INK}"/><circle cx="${cx + s * gap + r * 0.35}" cy="${cy - r * 0.4}" r="${r * 0.35}" fill="#fff"/>`).join("")}${extra}</g>`;
}
const cheeks = (cx, cy, gap) => [-1, 1].map((s) => `<ellipse cx="${cx + s * gap}" cy="${cy}" rx="2.6" ry="1.6" fill="#ff7a9a" opacity=".55"/>`).join("");

export function defaultCreature(personaId, kind = "") {
  const h = hash32(personaId + "|creature");
  const r = rng(h);
  // ~40% stay little pixel office workers (the v1 default)
  if (r() < 0.4) return null;
  const [c1, c2] = PALETTES[Math.floor(r() * PALETTES.length)];
  const acc = PALETTES[Math.floor(r() * PALETTES.length)][0];
  const types = ["blob", "robot", "sprout", "critter", "ghost", "mug", "jelly", "penguin"];
  const type = types[Math.floor(r() * types.length)];
  const S = (o) => ({ v: 2, viewBox: "0 0 64 64", ground: 60, facing: "front", ...o });
  const st = `stroke="${INK}" stroke-width="2.2" stroke-linejoin="round"`;
  switch (type) {
    case "blob": return S({
      locomotion: "hop",
      parts: [
        { id: "body", pivot: [32, 60], svg: `<path d="M10 58 C8 34 20 18 32 18 C44 18 56 34 54 58 Z" fill="${c1}" ${st}/><ellipse cx="24" cy="30" rx="5" ry="3" fill="#fff" opacity=".5"/>` },
        { id: "face", pivot: [32, 42], svg: eyes(32, 40, 7) + cheeks(32, 46, 12) + `<path d="M29 47 Q32 50 35 47" fill="none" stroke="${INK}" stroke-width="1.8" stroke-linecap="round"/>` },
      ],
      anim: { idle: [{ part: "body", type: "pulse", amp: 3, period: 1.8 }, { part: "face", type: "blink", amp: 1, period: 3.3 }],
        working: [{ part: "body", type: "pulse", amp: 5, period: 0.4 }, { part: "face", type: "shake", amp: 1, period: 0.5 }],
        thinking: [{ part: "body", type: "sway", amp: 5, period: 2.2 }, { part: "face", type: "bob", amp: -1.5, period: 2.2 }] },
    });
    case "robot": return S({
      locomotion: r() < 0.5 ? "roll" : "scuttle",
      parts: [
        { id: "wheel", pivot: [32, 55], svg: `<circle cx="32" cy="55" r="5" fill="#5a5a6a" ${st}/><rect x="31" y="51" width="2" height="8" fill="#c9cbd6"/>` },
        { id: "body", pivot: [32, 50], svg: `<rect x="18" y="32" width="28" height="20" rx="4" fill="${c1}" ${st}/><rect x="25" y="38" width="14" height="8" rx="2" fill="${c2}"/><circle cx="29" cy="42" r="1.4" fill="#7fd36b"/><circle cx="35" cy="42" r="1.4" fill="#ff6b5b"/>` },
        { id: "armL", pivot: [18, 36], svg: `<rect x="10" y="35" width="9" height="4" rx="2" fill="${c2}" ${st}/>` },
        { id: "armR", pivot: [46, 36], svg: `<rect x="45" y="35" width="9" height="4" rx="2" fill="${c2}" ${st}/>` },
        { id: "head", pivot: [32, 30], svg: `<rect x="17" y="12" width="30" height="20" rx="6" fill="#e1e3ec" ${st}/><rect x="21" y="16" width="22" height="11" rx="3" fill="${INK}"/><rect x="24" y="19" width="5" height="4" rx="1" fill="${acc}"/><rect x="35" y="19" width="5" height="4" rx="1" fill="${acc}"/>` },
        { id: "antenna", pivot: [32, 12], svg: `<line x1="32" y1="12" x2="32" y2="5" stroke="${INK}" stroke-width="2"/><circle cx="32" cy="4" r="2.6" fill="${acc}" ${st}/>` },
      ],
      anim: { idle: [{ part: "antenna", type: "sway", amp: 12, period: 2 }, { part: "head", type: "bob", amp: 0.8, period: 2 }],
        working: [{ part: "armL", type: "wiggle", amp: 20, period: 0.6 }, { part: "armR", type: "wiggle", amp: -20, period: 0.6, phase: 1 }, { part: "antenna", type: "spin", amp: 0, period: 0.8 }],
        thinking: [{ part: "head", type: "sway", amp: 8, period: 2.5 }, { part: "antenna", type: "sway", amp: 25, period: 1.2 }] },
    });
    case "sprout": return S({
      locomotion: "waddle",
      parts: [
        { id: "pot", pivot: [32, 60], svg: `<path d="M18 40 H46 L42 60 H22 Z" fill="#c97b3a" ${st}/><rect x="16" y="36" width="32" height="6" rx="2" fill="#d98c4a" ${st}/>` + eyes(32, 49, 6, 2.2) + cheeks(32, 53, 10) },
        { id: "stem", pivot: [32, 37], svg: `<path d="M32 37 C32 28 31 22 32 16" fill="none" stroke="#3f8a5a" stroke-width="3" stroke-linecap="round"/>` },
        { id: "leafL", pivot: [32, 24], svg: `<path d="M32 24 C24 16 14 20 14 22 C18 28 28 28 32 24 Z" fill="${c1 === "#f3e9d2" ? "#7fd36b" : "#7fd36b"}" ${st}/>` },
        { id: "leafR", pivot: [32, 20], svg: `<path d="M32 20 C40 10 50 14 50 16 C46 23 36 24 32 20 Z" fill="#6ab874" ${st}/>` },
        { id: "bud", pivot: [32, 14], svg: `<circle cx="32" cy="12" r="4.5" fill="${acc}" ${st}/>` },
      ],
      anim: { idle: [{ part: "leafL", type: "sway", amp: 8, period: 2.4 }, { part: "leafR", type: "sway", amp: -8, period: 2.4 }, { part: "bud", type: "pulse", amp: 6, period: 2.4 }],
        working: [{ part: "leafL", type: "flap", amp: 40, period: 0.35 }, { part: "leafR", type: "flap", amp: 40, period: 0.35, phase: 1.5 }, { part: "stem", type: "wiggle", amp: 3, period: 1 }],
        thinking: [{ part: "stem", type: "sway", amp: 6, period: 3 }, { part: "bud", type: "spin", amp: 0, period: 4 }] },
    });
    case "critter": {
      const ears = r() < 0.5 ? `<path d="M20 22 L18 6 L28 18 Z M44 22 L46 6 L36 18 Z" fill="${c1}" ${st}/>` : `<ellipse cx="24" cy="10" rx="4" ry="11" fill="${c1}" ${st}/><ellipse cx="40" cy="10" rx="4" ry="11" fill="${c1}" ${st}/>`;
      return S({
        locomotion: r() < 0.5 ? "walk" : "scuttle", facing: "right",
        parts: [
          { id: "tail", pivot: [46, 50], svg: `<path d="M46 50 C58 48 60 36 56 30" fill="none" stroke="${c2}" stroke-width="5" stroke-linecap="round"/>` },
          { id: "body", pivot: [32, 60], svg: `<ellipse cx="32" cy="48" rx="15" ry="12" fill="${c1}" ${st}/><ellipse cx="32" cy="51" rx="8" ry="6" fill="#fff8ec" opacity=".8"/><rect x="21" y="56" width="6" height="5" rx="2" fill="${c2}" ${st}/><rect x="37" y="56" width="6" height="5" rx="2" fill="${c2}" ${st}/>` },
          { id: "ears", pivot: [32, 22], svg: ears },
          { id: "head", pivot: [32, 36], svg: `<circle cx="32" cy="26" r="13" fill="${c1}" ${st}/>` + eyes(32, 25, 5.5, 2.3) + `<ellipse cx="32" cy="30" rx="2" ry="1.4" fill="${INK}"/>` + cheeks(32, 31, 9) },
        ],
        anim: { idle: [{ part: "tail", type: "sway", amp: 14, period: 1.6 }, { part: "ears", type: "wiggle", amp: 3, period: 3 }, { part: "head", type: "blink", amp: 1, period: 3.7 }],
          working: [{ part: "tail", type: "sway", amp: 22, period: 0.5 }, { part: "head", type: "bob", amp: 1, period: 0.35 }],
          thinking: [{ part: "head", type: "sway", amp: 10, period: 2.6 }, { part: "tail", type: "sway", amp: 8, period: 2.6 }] },
      });
    }
    case "ghost": return S({
      locomotion: "float",
      parts: [
        { id: "body", pivot: [32, 40], svg: `<path d="M14 56 L14 30 C14 16 22 10 32 10 C42 10 50 16 50 30 L50 56 L45 51 L40 56 L35 51 L30 56 L25 51 L20 56 Z" fill="#f3f6fa" ${st} opacity=".95"/>` + cheeks(32, 34, 10) },
        { id: "face", pivot: [32, 28], svg: eyes(32, 27, 6, 3) + `<ellipse cx="32" cy="36" rx="3" ry="2.4" fill="${INK}"/>` },
        { id: "hat", pivot: [32, 10], svg: r() < 0.5 ? `<path d="M22 12 L32 -2 L42 12 Z" fill="${acc}" ${st}/>` : `<circle cx="44" cy="14" r="4" fill="${acc}" ${st}/>` },
      ],
      anim: { idle: [{ part: "body", type: "sway", amp: 4, period: 3 }, { part: "face", type: "blink", amp: 1, period: 4 }, { part: "hat", type: "sway", amp: 6, period: 3 }],
        working: [{ part: "body", type: "shake", amp: 0.8, period: 0.4 }, { part: "face", type: "bob", amp: 1, period: 0.4 }],
        thinking: [{ part: "body", type: "sway", amp: 8, period: 2 }, { part: "face", type: "bob", amp: -2, period: 2 }] },
    });
    case "mug": return S({
      locomotion: "waddle",
      parts: [
        { id: "steam", pivot: [32, 14], svg: `<path d="M26 16 C22 10 30 8 26 2 M36 16 C32 10 40 8 36 2" fill="none" stroke="#e8eef5" stroke-width="2.4" stroke-linecap="round" opacity=".8"/>` },
        { id: "handle", pivot: [48, 38], svg: `<path d="M46 28 C58 28 58 46 46 46" fill="none" stroke="${INK}" stroke-width="6"/><path d="M46 28 C58 28 58 46 46 46" fill="none" stroke="${c1}" stroke-width="3"/>` },
        { id: "body", pivot: [32, 60], svg: `<rect x="16" y="18" width="32" height="40" rx="5" fill="${c1}" ${st}/><rect x="16" y="18" width="32" height="6" rx="3" fill="#6b4430" ${st}/>` + eyes(32, 36, 6) + cheeks(32, 42, 11) + `<path d="M29 43 Q32 46 35 43" fill="none" stroke="${INK}" stroke-width="1.8" stroke-linecap="round"/>` },
      ],
      anim: { idle: [{ part: "steam", type: "bob", amp: 2, period: 1.5 }, { part: "steam", type: "sway", amp: 6, period: 2 }],
        working: [{ part: "steam", type: "wiggle", amp: 10, period: 0.6 }, { part: "body", type: "shake", amp: 0.7, period: 0.3 }],
        thinking: [{ part: "steam", type: "spin", amp: 0, period: 3 }, { part: "body", type: "sway", amp: 4, period: 2.4 }] },
    });
    case "jelly": return S({
      locomotion: "float",
      parts: [
        { id: "tentacles", pivot: [32, 34], svg: [20, 27, 34, 41].map((x, i) => `<path d="M${x + 2} 34 C${x - 2} 42 ${x + 6} 48 ${x + 1} 58" fill="none" stroke="${c2}" stroke-width="3" stroke-linecap="round"/>`).join("") },
        { id: "bell", pivot: [32, 30], svg: `<path d="M12 36 C12 14 52 14 52 36 Z" fill="${c1}" ${st} opacity=".92"/><ellipse cx="24" cy="24" rx="5" ry="3" fill="#fff" opacity=".5"/>` + eyes(32, 30, 6, 2.2) },
      ],
      anim: { idle: [{ part: "bell", type: "pulse", amp: 5, period: 2 }, { part: "tentacles", type: "sway", amp: 6, period: 2, phase: 1 }],
        working: [{ part: "bell", type: "pulse", amp: 8, period: 0.6 }, { part: "tentacles", type: "wiggle", amp: 6, period: 0.8 }],
        thinking: [{ part: "bell", type: "sway", amp: 6, period: 2.8 }, { part: "tentacles", type: "sway", amp: 10, period: 2.8 }] },
    });
    default: return S({ // penguin
      locomotion: "waddle",
      parts: [
        { id: "flipL", pivot: [18, 34], svg: `<path d="M18 32 C10 38 10 46 13 48 C16 44 19 40 20 36 Z" fill="${INK}"/>` },
        { id: "flipR", pivot: [46, 34], svg: `<path d="M46 32 C54 38 54 46 51 48 C48 44 45 40 44 36 Z" fill="${INK}"/>` },
        { id: "body", pivot: [32, 60], svg: `<ellipse cx="32" cy="38" rx="15" ry="20" fill="#2f3a4a" ${st}/><ellipse cx="32" cy="42" rx="10" ry="14" fill="#fff8ec"/><path d="M24 58 h6 v2 h-6z M34 58 h6 v2 h-6z" fill="#ff9a3c"/>` + eyes(32, 28, 5, 2.2) + `<path d="M29 32 L35 32 L32 36 Z" fill="#ff9a3c"/>` + `<rect x="22" y="18" width="20" height="4" rx="2" fill="${acc}" ${st}/>` },
      ],
      anim: { idle: [{ part: "flipL", type: "sway", amp: 6, period: 2 }, { part: "flipR", type: "sway", amp: -6, period: 2 }, { part: "body", type: "blink", amp: 1, period: 99 }],
        working: [{ part: "flipL", type: "sway", amp: 25, period: 0.35 }, { part: "flipR", type: "sway", amp: -25, period: 0.35, phase: 1.5 }],
        thinking: [{ part: "body", type: "sway", amp: 4, period: 2.5 }, { part: "flipR", type: "sway", amp: -30, period: 2.5 }] },
    });
  }
}

export const escAttr = ESC;
