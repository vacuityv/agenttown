// Eyeball avatar generation without the server or a DB:
//   node --disable-warning=ExperimentalWarning test/avatar-preview.ts "戴耳机的赛博橘猫，穿连帽衫" "a jellyfish that glows when it thinks"
// Writes data/avatar-preview.json and data/avatar-preview.html (v2 sprites: idle / working / thinking / sleeping at
// several sizes, plus a locomotion demo). Needs ANTHROPIC_API_KEY (optionally AVATAR_MODEL / AVATAR_EFFORT).
//   node --disable-warning=ExperimentalWarning test/avatar-preview.ts --html [data/avatar-preview.json]
// re-renders the HTML from an existing JSON file (no API calls).
//
// Only imports server/avatar-gen.ts (no DB / mysql2), so it runs from a bare copy of server/ + node_modules.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

type Result = { appearance: string; sprite?: unknown; error?: string; usage?: unknown; ms: number };

const args = process.argv.slice(2).filter(Boolean);
let results: Result[] = [];
let model = "";

if (args[0] === "--html") {
  const file = args[1] || "data/avatar-preview.json";
  const j = JSON.parse(readFileSync(file, "utf8"));
  results = Array.isArray(j) ? j : j.results;
  model = Array.isArray(j) ? "?" : j.model;
} else {
  const { generateSprite, AVATAR_MODEL, hasApiKey } = await import("../server/avatar-gen.ts");
  model = AVATAR_MODEL;
  if (!args.length) {
    console.error('usage: node test/avatar-preview.ts "<appearance>" ["<appearance>" ...]   |   --html [file.json]');
    process.exit(2);
  }
  if (!hasApiKey()) {
    console.error("ANTHROPIC_API_KEY is not set");
    process.exit(1);
  }
  // Run in parallel (each call is independent); keeps total wall time near the slowest one.
  results = await Promise.all(args.map(async (appearance, k): Promise<Result> => {
    const t0 = Date.now();
    try {
      const { sprite, usage } = await generateSprite(appearance, { idPrefix: `pv${k}-` });
      console.log(`ok   ${appearance}  ${Date.now() - t0} ms  ${JSON.stringify(usage)}`);
      return { appearance, sprite, usage, ms: Date.now() - t0 };
    } catch (e) {
      console.log(`FAIL ${appearance}  ${(e as Error).message}`);
      return { appearance, error: String((e as Error).message), ms: Date.now() - t0 };
    }
  }));
  mkdirSync("data", { recursive: true });
  writeFileSync("data/avatar-preview.json", JSON.stringify({ model, generated: new Date().toISOString(), results }, null, 2));
}

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Avatar Preview</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 16px; background: #1e1712; color: #e9dcc9; font: 14px/1.4 system-ui, sans-serif; }
  h1 { font-size: 16px; font-weight: 600; margin: 0 0 4px; }
  .meta { color: #a8957d; font-size: 12px; margin-bottom: 16px; }
  .card { border: 1px solid #3a2d22; border-radius: 8px; padding: 12px; margin-bottom: 16px; background: #241b15; }
  .title { font-weight: 600; }
  .sub { color: #a8957d; font-size: 12px; margin: 2px 0 10px; }
  .row { display: flex; flex-wrap: wrap; gap: 14px; align-items: flex-end; }
  figure { margin: 0; text-align: center; }
  figcaption { font-size: 12px; color: #a8957d; margin-top: 4px; }
  svg.spr { display: block; background: #1e1712; border-radius: 6px; overflow: visible; }
  .lane { position: relative; height: 92px; margin-top: 12px; background: #1b140f; border-radius: 6px; overflow: hidden; max-width: 100%; }
  .lane svg { position: absolute; top: 10px; left: 0; background: transparent; }
  .err { color: #ff8a7a; }
  details { margin-top: 8px; font-size: 12px; color: #a8957d; }
  pre { white-space: pre-wrap; word-break: break-all; max-height: 240px; overflow: auto; background: #1b140f; padding: 8px; border-radius: 6px; }
</style></head><body>
<h1>Avatar preview (sprite v2)</h1>
<div class="meta">model ${model} · rendered ${new Date().toISOString()}</div>
<div id="out"></div>
<script>
const RESULTS = ${JSON.stringify(results).replace(/</g, "\\u003c")};
const NS = "http://www.w3.org/2000/svg";
const STATES = ["idle", "working", "thinking", "sleeping"];
const out = document.getElementById("out");
const views = []; // { root, partEls: Map, sprite, state, loco? }

// The part svg strings are already sanitized server-side (server/svg-sanitize.ts); we still parse them
// as SVG via DOMParser rather than innerHTML-on-HTML so the namespace is right.
function partNode(svgFrag) {
  const doc = new DOMParser().parseFromString('<svg xmlns="' + NS + '">' + svgFrag + "</svg>", "image/svg+xml");
  const g = document.createElementNS(NS, "g");
  for (const c of [...doc.documentElement.childNodes]) g.appendChild(document.importNode(c, true));
  return g;
}

function makeSvg(sprite, px) {
  const [vx, vy, vw, vh] = sprite.viewBox.split(/\\s+/).map(Number);
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", sprite.viewBox);
  svg.setAttribute("width", px); svg.setAttribute("height", px * vh / vw);
  svg.classList.add("spr");
  const flip = document.createElementNS(NS, "g"); // locomotion mirror + offsets
  const all = document.createElementNS(NS, "g");  // "*" animations
  flip.appendChild(all); svg.appendChild(flip);
  const partEls = new Map();
  for (const p of sprite.parts) {
    const g = partNode(p.svg);
    all.appendChild(g);
    partEls.set(p.id, { g, pivot: p.pivot });
  }
  return { svg, flip, all, partEls, center: [vx + vw / 2, sprite.ground] };
}

// Per-part transform for one state at time t (seconds). See docs/protocol.md "Sprite format v2".
function partTransform(anims, pivot, t) {
  let tx = 0, ty = 0, rot = 0, sx = 1, sy = 1;
  for (const a of anims) {
    const u = t / a.period + (a.phase || 0);
    const w = Math.sin(2 * Math.PI * u);
    switch (a.type) {
      case "bob": ty += a.amp * w; break;
      case "shake": tx += a.amp * w; break;
      case "sway": case "wiggle": rot += a.amp * w; break;
      case "spin": rot += (a.amp || 360) * (u % 1); break;
      case "pulse": { const k = 1 + (a.amp / 100) * w; sx *= k; sy *= k; break; }
      case "flap": sx *= 1 - (a.amp / 100) * (0.5 + 0.5 * w); break;
      case "blink": { const f = u - Math.floor(u); if (f < Math.min(0.15, 0.3 * a.period) / a.period) sy *= 0.1; break; }
    }
  }
  const [px, py] = pivot;
  return "translate(" + (px + tx) + " " + (py + ty) + ") rotate(" + rot + ") scale(" + sx + " " + sy + ") translate(" + (-px) + " " + (-py) + ")";
}

// Whole-character motion while moving (the client owns this; these are just reasonable defaults).
function locomotion(kind, t, dist) {
  const s = (p) => Math.sin(2 * Math.PI * t / p);
  switch (kind) {
    case "walk": return { ty: -Math.abs(s(0.7)) * 1.5, rot: s(0.7) * 3, sx: 1, sy: 1 };
    case "hop": { const h = Math.abs(s(1.2)); return { ty: -h * 9, rot: 0, sx: h < 0.15 ? 1.08 : 1, sy: h < 0.15 ? 0.92 : 1 }; }
    case "float": return { ty: -4 + s(2.4) * 2, rot: s(3.1) * 3, sx: 1, sy: 1 };
    case "roll": return { ty: 0, rot: dist * 180 / Math.PI / 24, sx: 1, sy: 1 };
    case "slither": return { ty: 0, rot: 0, sx: 1 + s(0.9) * 0.08, sy: 1 - s(0.9) * 0.04 };
    case "scuttle": return { ty: -Math.abs(s(0.24)) * 1, rot: s(0.24) * 2, sx: 1, sy: 1 };
    case "glide": return { ty: s(3) * 1, rot: 6, sx: 1, sy: 1 };
    case "waddle": return { ty: -Math.abs(s(0.5)) * 1, rot: s(0.5) * 9, sx: 1, sy: 1 };
  }
  return { ty: 0, rot: 0, sx: 1, sy: 1 };
}

for (const r of RESULTS) {
  const card = document.createElement("div"); card.className = "card";
  const title = document.createElement("div"); title.className = "title"; title.textContent = r.appearance; card.appendChild(title);
  const sub = document.createElement("div"); sub.className = "sub";
  const u = r.usage;
  sub.textContent = (r.ms / 1000).toFixed(1) + " s" + (u ? " · in " + u.input_tokens + " / out " + u.output_tokens + " tok · " + u.attempts + " call(s)" : "") +
    (r.sprite ? " · style: " + r.sprite.style + " · locomotion: " + r.sprite.locomotion + " · facing: " + r.sprite.facing +
      " · parts: " + r.sprite.parts.map((p) => p.id).join(", ") + " · " + r.sprite.parts.reduce((n, p) => n + p.svg.length, 0) + " B svg" : "");
  card.appendChild(sub);
  if (!r.sprite) {
    const e = document.createElement("div"); e.className = "err"; e.textContent = "failed: " + r.error; card.appendChild(e);
    out.appendChild(card); continue;
  }
  const sp = r.sprite;
  const row = document.createElement("div"); row.className = "row";
  const add = (state, px, label) => {
    const v = makeSvg(sp, px);
    const fig = document.createElement("figure"); fig.appendChild(v.svg);
    const cap = document.createElement("figcaption"); cap.textContent = label; fig.appendChild(cap);
    row.appendChild(fig);
    views.push({ ...v, sprite: sp, state });
  };
  for (const st of STATES) add(st, 150, st);
  add("idle", 64, "idle 64px"); add("working", 64, "working 64px"); add("thinking", 40, "thinking 40px");
  card.appendChild(row);
  const lane = document.createElement("div"); lane.className = "lane";
  const v = makeSvg(sp, 72); lane.appendChild(v.svg); card.appendChild(lane);
  views.push({ ...v, sprite: sp, state: "idle", lane });
  const det = document.createElement("details");
  const sum = document.createElement("summary"); sum.textContent = "anim JSON"; det.appendChild(sum);
  const pre = document.createElement("pre"); pre.textContent = JSON.stringify(sp.anim, null, 1); det.appendChild(pre);
  card.appendChild(det);
  out.appendChild(card);
}

function frame(ms) {
  const t = ms / 1000;
  for (const v of views) {
    const sp = v.sprite;
    const anims = sp.anim[v.state] || [];
    for (const [id, pe] of v.partEls) pe.g.setAttribute("transform", partTransform(anims.filter((a) => a.part === id), pe.pivot, t));
    v.all.setAttribute("transform", partTransform(anims.filter((a) => a.part === "*"), v.center, t));
    if (v.lane) {
      const W = v.lane.clientWidth - 72, speed = 40; // px/s
      const span = Math.max(W, 1), cyc = (t * speed) % (2 * span);
      const x = cyc < span ? cyc : 2 * span - cyc, dir = cyc < span ? 1 : -1;
      v.svg.style.left = x + "px";
      const L = locomotion(sp.locomotion, t, t * speed * 64 / 72);
      const mirror = (sp.facing === "right" && dir < 0) || (sp.facing === "left" && dir > 0) ? -1 : 1;
      const [cx, gy] = v.center;
      const rot = sp.locomotion === "roll" ? L.rot * dir : L.rot * (sp.locomotion === "glide" ? dir : 1);
      v.flip.setAttribute("transform", "translate(" + cx + " " + (gy + L.ty) + ") rotate(" + rot + ") scale(" + (mirror * L.sx) + " " + L.sy + ") translate(" + (-cx) + " " + (-gy) + ")");
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
</script></body></html>`;
mkdirSync("data", { recursive: true });
writeFileSync("data/avatar-preview.html", html);
console.log("wrote data/avatar-preview.html" + (args[0] === "--html" ? "" : " and data/avatar-preview.json"));
