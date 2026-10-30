// Eyeball dwelling generation without the server or a DB:
//   node --disable-warning=ExperimentalWarning test/dwelling-preview.ts "a cozy spaceship cabin with blinking consoles" "一个用书堆成的城堡"
// Writes data/dwelling-preview.json and data/dwelling-preview.html: each dwelling large with its footprint and spots
// marked, at town sizes (200 / 120 px), zoomed-out with the roof, and with sample residents (test/fixtures) placed at
// spots (working at a desk, thinking at the terminal, idle on a rest spot, asleep in a bed, arriving at the door).
//   node --disable-warning=ExperimentalWarning test/dwelling-preview.ts --html [data/dwelling-preview.json]
// re-renders the HTML from an existing JSON file (no API calls). Needs ANTHROPIC_API_KEY to generate.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

type Result = { look: string; art?: unknown; error?: string; usage?: unknown; ms: number };

const args = process.argv.slice(2).filter(Boolean);
let results: Result[] = [];
let model = "";

if (args[0] === "--html") {
  const j = JSON.parse(readFileSync(args[1] || "data/dwelling-preview.json", "utf8"));
  results = j.results;
  model = j.model;
} else {
  const { generateDwelling } = await import("../server/dwelling-gen.ts");
  const { AVATAR_MODEL, hasApiKey } = await import("../server/avatar-gen.ts");
  model = AVATAR_MODEL;
  if (!args.length) {
    console.error('usage: node test/dwelling-preview.ts "<look>" ["<look>" ...]   |   --html [file.json]');
    process.exit(2);
  }
  if (!hasApiKey()) {
    console.error("ANTHROPIC_API_KEY is not set");
    process.exit(1);
  }
  results = await Promise.all(args.map(async (look, k): Promise<Result> => {
    const t0 = Date.now();
    try {
      const { art, usage } = await generateDwelling(look, { idPrefix: `h-pv${k}-` });
      console.log(`ok   ${look}  ${Date.now() - t0} ms  ${JSON.stringify(usage)}`);
      return { look, art, usage, ms: Date.now() - t0 };
    } catch (e) {
      console.log(`FAIL ${look}  ${(e as Error).message}`);
      return { look, error: String((e as Error).message), ms: Date.now() - t0 };
    }
  }));
  mkdirSync("data", { recursive: true });
  writeFileSync("data/dwelling-preview.json", JSON.stringify({ model, generated: new Date().toISOString(), results }, null, 2));
}

const residents = JSON.parse(readFileSync(new URL("./fixtures/sample-sprites.json", import.meta.url), "utf8"));
const json = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dwelling Preview</title>
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
  svg.dw { display: block; background: #1e1712; border-radius: 6px; max-width: 100%; height: auto; }
  .err { color: #ff8a7a; }
</style></head><body>
<h1>Dwelling preview (dwelling art v1)</h1>
<div class="meta">model ${model} · rendered ${new Date().toISOString()} · dashed line = footprint, dots = spots</div>
<div id="out"></div>
<script>
const RESULTS = ${json(results)};
const RESIDENTS = ${json(residents)};
const NS = "http://www.w3.org/2000/svg";
const out = document.getElementById("out");
const animated = []; // { el, anims, pivot }

function frag(svgFrag) {
  const doc = new DOMParser().parseFromString('<svg xmlns="' + NS + '">' + svgFrag + "</svg>", "image/svg+xml");
  const g = document.createElementNS(NS, "g");
  for (const c of [...doc.documentElement.childNodes]) g.appendChild(document.importNode(c, true));
  return g;
}
function el(name, attrs, parent) {
  const e = document.createElementNS(NS, name);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}
// Same animation maths as sprite v2 (docs/protocol.md).
function xf(anims, pivot, t) {
  let tx = 0, ty = 0, rot = 0, sx = 1, sy = 1;
  for (const a of anims) {
    const u = t / a.period + (a.phase || 0), w = Math.sin(2 * Math.PI * u);
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

// A resident sprite (v2) standing with its ground line on spot p, ~13 units tall.
function resident(sprite, state, p, parent) {
  const [vx, vy, vw, vh] = sprite.viewBox.split(/\\s+/).map(Number);
  const size = 13, k = size / vh;
  const g = el("g", { transform: "translate(" + (p[0] - (vw / 2) * k) + " " + (p[1] - sprite.ground * k) + ") scale(" + k + ")" }, parent);
  const all = el("g", {}, g);
  for (const part of sprite.parts) {
    const pg = frag(part.svg);
    all.appendChild(pg);
    animated.push({ el: pg, anims: sprite.anim[state].filter((a) => a.part === part.id), pivot: part.pivot });
  }
  animated.push({ el: all, anims: sprite.anim[state].filter((a) => a.part === "*"), pivot: [vx + vw / 2, sprite.ground] });
}

function dwelling(art, px, { roof = false, spots = false, people = false } = {}) {
  const svg = el("svg", { viewBox: art.viewBox, width: px, height: px * 120 / 160, class: "dw" });
  for (const layer of art.layers) {
    if (layer.optional && !roof) continue;
    const g = frag(layer.svg);
    svg.appendChild(g);
    const anims = art.anim.filter((a) => a.layer === layer.id);
    if (anims.length) animated.push({ el: g, anims, pivot: layer.pivot });
  }
  if (spots) {
    el("polygon", { points: art.footprint.map((p) => p.join(",")).join(" "), fill: "none", stroke: "#ffe28a", "stroke-width": 0.6, "stroke-dasharray": "2 2", opacity: 0.9 }, svg);
    const mark = (name, p, color) => {
      el("circle", { cx: p[0], cy: p[1], r: 1.6, fill: color, stroke: "#000", "stroke-width": 0.4 }, svg);
      const t = el("text", { x: p[0] + 2.2, y: p[1] + 1.2, "font-size": 3.2, fill: "#fff", stroke: "#000", "stroke-width": 0.6, "paint-order": "stroke", "font-family": "system-ui" }, svg);
      t.textContent = name;
    };
    const colors = { door: "#ff6b6b", desk: "#4dd4ff", terminal: "#7cff6b", books: "#ffd166", write: "#f78cff", web: "#8ab4ff", mcp: "#ffa94d", agent: "#c4a1ff", rest: "#9ef0c8", bed: "#ffffff" };
    for (const [k, v] of Object.entries(art.spots)) {
      if (Array.isArray(v[0])) v.forEach((p, i) => mark(k + (v.length > 1 ? i + 1 : ""), p, colors[k]));
      else mark(k, v, colors[k]);
    }
  }
  if (people) {
    const s = art.spots;
    const cast = [[s.desk[0], "working"], [s.terminal, "thinking"], [s.rest[0], "idle"], [s.bed[0], "sleeping"], [s.door, "idle"]];
    if (s.desk[1]) cast.push([s.desk[1], "working"]);
    cast.forEach(([p, state], i) => resident(RESIDENTS[i % RESIDENTS.length].sprite, state, p, svg));
  }
  return svg;
}

for (const r of RESULTS) {
  const card = document.createElement("div"); card.className = "card";
  const title = document.createElement("div"); title.className = "title"; title.textContent = r.look; card.appendChild(title);
  const sub = document.createElement("div"); sub.className = "sub";
  const u = r.usage, a = r.art;
  sub.textContent = (r.ms / 1000).toFixed(1) + " s" + (u ? " · in " + u.input_tokens + " / out " + u.output_tokens + " tok · " + u.attempts + " call(s)" : "") +
    (a ? " · style: " + a.style + " · layers: " + a.layers.map((l) => l.id + (l.optional ? "(opt)" : "")).join(", ") +
      " · " + a.layers.reduce((n, l) => n + l.svg.length, 0) + " B svg · anims: " + a.anim.map((x) => x.layer + "." + x.type).join(", ") +
      " · desks " + a.spots.desk.length + ", rest " + a.spots.rest.length + ", beds " + a.spots.bed.length : "");
  card.appendChild(sub);
  if (!a) {
    const e = document.createElement("div"); e.className = "err"; e.textContent = "failed: " + r.error; card.appendChild(e);
    out.appendChild(card); continue;
  }
  const row = document.createElement("div"); row.className = "row";
  const add = (svg, label) => {
    const f = document.createElement("figure"); f.appendChild(svg);
    const c = document.createElement("figcaption"); c.textContent = label; f.appendChild(c); row.appendChild(f);
  };
  add(dwelling(a, 480, { spots: true }), "spots + footprint (480 px)");
  add(dwelling(a, 480, { people: true }), "with residents (480 px)");
  add(dwelling(a, 200, { people: true }), "200 px");
  add(dwelling(a, 120, {}), "120 px");
  add(dwelling(a, 120, { roof: true }), "zoomed out (roof)");
  card.appendChild(row);
  out.appendChild(card);
}

function frame(ms) {
  const t = ms / 1000;
  for (const x of animated) if (x.anims.length) x.el.setAttribute("transform", xf(x.anims, x.pivot, t));
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
</script></body></html>`;
mkdirSync("data", { recursive: true });
writeFileSync("data/dwelling-preview.html", html);
console.log("wrote data/dwelling-preview.html" + (args[0] === "--html" ? "" : " and data/dwelling-preview.json"));
