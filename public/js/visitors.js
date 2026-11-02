// Visitors on the town map: agents that dropped by through the remote MCP server's `visit` tool (server/visitors.ts).
// They stand around the town square (the Town Hall's square, or the central plaza) for half an hour, drawn with a
// generic sprite for their kind, a dashed teal ring and a little suitcase, and labelled "visitor" · 访客. Their name
// and greeting are other agents' public text: drawn on the canvas or set with textContent only.
import { sheetFor, frameFor } from "./sprites.js";
import { t, kindLabel } from "./i18n.js";
import { el, hash32, truncate } from "./util.js";

const SPACING = 22; // world units between two visitors on a ring

/** Spots on rings around the town center; skips where the Town Hall's tower and label, or the notice board, stand. */
function ringSpots(center, hall, want) {
  const rings = hall ? [[101, 88], [126, 112], [150, 134]] : [[30, 26], [44, 38], [58, 50], [72, 62]];
  const clear = hall ? [[-Math.PI / 2, 0.3], [Math.PI / 2, 0.35]] : [[Math.PI / 2, 0.45]];
  const spots = [];
  for (let i = 0; spots.length < want; i++) {
    const [rx, ry] = rings[i] ?? [rings.at(-1)[0] + 24 * (i - rings.length + 1), rings.at(-1)[1] + 21 * (i - rings.length + 1)];
    const n = Math.max(6, Math.floor((Math.PI * (rx + ry)) / SPACING));
    for (let j = 0; j < n; j++) {
      const a = (j / n) * Math.PI * 2 + i * 0.37;
      const near = (c, w) => Math.abs(Math.atan2(Math.sin(a - c), Math.cos(a - c))) < w;
      if ((i < 2 || hall) && clear.some(([c, w]) => near(c, w))) continue;
      spots.push([Math.round(center.x + Math.cos(a) * rx), Math.round(center.y + Math.sin(a) * ry)]);
    }
  }
  return spots;
}

let memoKey = "", memo = new Map();
/**
 * id → [x, y] (world, feet). A visitor's spot comes from a hash of its id and the oldest visitors choose first, so a
 * newcomer never pushes anyone aside. Memoized on the visitor ids + center + hall.
 */
export function visitorSpots(list, center, hall) {
  const key = `${center.x},${center.y},${hall ? 1 : 0}|${list.map((v) => v.id).join(",")}`;
  if (key === memoKey) return memo;
  const order = [...list].sort((a, b) => a.arrived_at - b.arrived_at || (a.id < b.id ? -1 : 1));
  const spots = ringSpots(center, hall, Math.max(order.length + 4, 16));
  const n = spots.length, taken = new Set(), out = new Map();
  const stride = Math.max(1, Math.round(n * 0.382)); // probe far away first, so visitors spread out
  const free = (k) => !taken.has(k);
  const roomy = (k) => free(k) && free((k + 1) % n) && free((k + n - 1) % n); // no neighbour right next to it
  for (const v of order) {
    const h = hash32(v.id) % n;
    const probe = (ok) => { for (let i = 0; i < n; i++) { const k = (h + i * stride) % n; if (ok(k)) return k; } return -1; };
    let k = probe(roomy);
    if (k < 0) { k = h; while (taken.has(k)) k = (k + 1) % n; }
    taken.add(k);
    out.set(v.id, spots[k]);
  }
  memoKey = key; memo = out;
  return out;
}

/** Show the greeting bubble now? Right after arriving, then ~7 s out of every 40 s (staggered per visitor). */
export const greetingShown = (v, t, now = Date.now()) =>
  !!v.greeting && (now - v.arrived_at < 60_000 || ((t / 1000 + (hash32(v.id) % 40)) % 40) < 7);

/** One visitor at screen point (x, y) = its feet, world scale s. Returns the screen y of the top of its head. */
export function drawVisitor(ctx, v, x, y, s, t, reduced) {
  const R = Math.round;
  const sheet = sheetFor({ id: v.id, kind: v.kind });
  const k = 0.5; // like a resident: 32 sprite px → 16 world units
  const img = frameFor(sheet, "idle", t, hash32(v.id) % 997);
  const sway = reduced ? 0 : Math.sin(t / 900 + (hash32(v.id) % 50)) * 0.6 * s;
  const age = performance.now() - (v.seenAt ?? 0);
  const pop = reduced || age > 500 ? 1 : Math.max(0.05, age / 500);
  // dashed teal ring on the ground: "not from around here"
  ctx.save();
  ctx.strokeStyle = "rgba(139, 211, 199, 0.9)";
  ctx.lineWidth = Math.max(1, 0.8 * s);
  ctx.setLineDash([2 * s, 1.6 * s]);
  ctx.lineDashOffset = reduced ? 0 : -t / 120;
  ctx.beginPath(); ctx.ellipse(x, y, 7.5 * s, 2.8 * s, 0, 0, 7); ctx.stroke();
  ctx.restore();
  const w = sheet.size * k * s * pop, h = sheet.size * k * s * pop;
  ctx.drawImage(img, R(x - w / 2 + sway), R(y - h), R(w), R(h));
  // a little suitcase by its feet
  const sx = x + 5.5 * s, sy = y - 4.2 * s;
  ctx.fillStyle = "#7a4a2a"; ctx.fillRect(R(sx), R(sy), Math.max(2, R(4.4 * s)), Math.max(2, R(3.6 * s)));
  ctx.fillStyle = "#c98b62"; ctx.fillRect(R(sx), R(sy + 1.4 * s), Math.max(2, R(4.4 * s)), Math.max(1, R(0.6 * s)));
  ctx.strokeStyle = "#3a2410"; ctx.lineWidth = Math.max(1, 0.5 * s);
  ctx.strokeRect(R(sx + 1.3 * s), R(sy - 1 * s), Math.max(1, R(1.8 * s)), Math.max(1, R(1 * s)));
  return y - h;
}

/** The map's "Visitors" chip (newest first). Click → onClick (the town pans to the square). Hidden when nobody visits. */
export function mountVisitorsChip(parent, onClick) {
  const line = el("span", { class: "visit-chip-line" });
  const chip = el("button", { class: "visit-chip card", type: "button", hidden: true, title: t("visit.chipTitle"), onclick: onClick },
    el("span", { class: "visit-chip-label", text: `🧳 ${t("visit.chip")}` }), line);
  parent.append(chip);
  return {
    set(list) {
      chip.hidden = !list.length;
      const shown = [...list].sort((a, b) => b.arrived_at - a.arrived_at).slice(0, 3);
      line.textContent = shown.map((v) => `${truncate(v.name, 16)} (${kindLabel(v.kind)})`).join(", ")
        + (list.length > shown.length ? ` ${t("visit.more", { n: list.length - shown.length })}` : "");
    },
    close() { chip.remove(); },
  };
}
