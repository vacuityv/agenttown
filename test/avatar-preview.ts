// Eyeball avatar generation without the server:
//   node --disable-warning=ExperimentalWarning test/avatar-preview.ts "戴耳机的赛博橘猫，穿连帽衫" "a robot barista"
// Writes data/avatar-preview.json and data/avatar-preview.html (idle / working / thinking at 4x).
// Needs ANTHROPIC_API_KEY (and optionally AVATAR_MODEL / AVATAR_EFFORT).

import { mkdirSync, writeFileSync } from "node:fs";

process.env.DB_PATH ??= ":memory:"; // avatar.ts imports the db module; keep the real db untouched
const { generateSprite, AVATAR_MODEL, hasApiKey } = await import("../server/avatar.ts");

const descs = process.argv.slice(2).filter(Boolean);
if (!descs.length) {
  console.error('usage: node test/avatar-preview.ts "<appearance>" ["<appearance>" ...]');
  process.exit(2);
}
if (!hasApiKey()) {
  console.error("ANTHROPIC_API_KEY is not set");
  process.exit(1);
}

type Result = { appearance: string; sprite?: unknown; error?: string; usage?: unknown; ms: number };
const results: Result[] = [];
for (const appearance of descs) {
  const t0 = Date.now();
  try {
    const { sprite, usage } = await generateSprite(appearance);
    results.push({ appearance, sprite, usage, ms: Date.now() - t0 });
    console.log(`ok   ${appearance}  ${Date.now() - t0} ms  ${JSON.stringify(usage)}`);
  } catch (e) {
    results.push({ appearance, error: String((e as Error).message), ms: Date.now() - t0 });
    console.log(`FAIL ${appearance}  ${(e as Error).message}`);
  }
}

mkdirSync("data", { recursive: true });
writeFileSync("data/avatar-preview.json", JSON.stringify(results, null, 2));

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Avatar Preview</title>
<style>
  body { margin: 0; padding: 16px; background: #1e1712; color: #e9dcc9; font: 14px/1.4 system-ui, sans-serif; }
  h1 { font-size: 16px; font-weight: 600; margin: 0 0 4px; }
  .meta { color: #a8957d; font-size: 12px; margin-bottom: 16px; }
  .card { border: 1px solid #3a2d22; border-radius: 8px; padding: 12px; margin-bottom: 16px; background: #241b15; }
  .row { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-end; }
  figure { margin: 0; text-align: center; }
  figcaption { font-size: 12px; color: #a8957d; margin-top: 4px; }
  canvas { image-rendering: pixelated; background: #2a2019; border-radius: 4px; }
  .err { color: #ff8a7a; }
  .pal { display: flex; gap: 2px; margin-top: 8px; }
  .pal span { width: 14px; height: 14px; border-radius: 2px; border: 1px solid #000; }
</style></head><body>
<h1>Avatar preview</h1>
<div class="meta">model ${AVATAR_MODEL} · generated ${new Date().toISOString()}</div>
<div id="out"></div>
<script>
const RESULTS = ${JSON.stringify(results).replace(/</g, "\\u003c")};
const FPS = { idle: 1, working: 4, thinking: 1.5 };
const out = document.getElementById("out");
const canvases = [];
for (const r of RESULTS) {
  const card = document.createElement("div");
  card.className = "card";
  const title = document.createElement("div");
  title.textContent = r.appearance + "  (" + r.ms + " ms" + (r.usage ? ", in " + r.usage.input_tokens + " / out " + r.usage.output_tokens + " tok" : "") + ")";
  card.appendChild(title);
  if (!r.sprite) {
    const e = document.createElement("div"); e.className = "err"; e.textContent = "failed: " + r.error; card.appendChild(e);
  } else {
    const row = document.createElement("div"); row.className = "row";
    for (const [state, scale] of [["idle", 4], ["working", 4], ["thinking", 4], ["idle", 1], ["working", 1]]) {
      const fig = document.createElement("figure");
      const c = document.createElement("canvas");
      c.width = c.height = r.sprite.size * scale;
      fig.appendChild(c);
      const cap = document.createElement("figcaption"); cap.textContent = state + " " + scale + "x"; fig.appendChild(cap);
      row.appendChild(fig);
      canvases.push({ c, scale, sprite: r.sprite, state });
    }
    card.appendChild(row);
    const pal = document.createElement("div"); pal.className = "pal";
    for (const col of r.sprite.palette.slice(1)) { const s = document.createElement("span"); s.style.background = col; s.title = col; pal.appendChild(s); }
    card.appendChild(pal);
  }
  out.appendChild(card);
}
function draw(t) {
  for (const { c, scale, sprite, state } of canvases) {
    const frames = sprite.frames[state];
    const f = frames[Math.floor(t / 1000 * FPS[state]) % frames.length];
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);
    f.forEach((rowStr, y) => {
      for (let x = 0; x < rowStr.length; x++) {
        const i = parseInt(rowStr[x], 16);
        if (!i) continue;
        ctx.fillStyle = sprite.palette[i];
        ctx.fillRect(x * scale, y * scale, scale, scale);
      }
    });
  }
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
</script></body></html>`;
writeFileSync("data/avatar-preview.html", html);
console.log("wrote data/avatar-preview.json and data/avatar-preview.html");
