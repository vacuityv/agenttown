// Shared top-down home interior: floor plan + furniture + residents who walk between activity spots.
// Used by the town (every lot is a roofless cutaway) and by /h/:id (same renderer, bigger scale).
//
// Coordinates are "interior art px": (0,0) = top-left of the floor inside the outer walls.
// Characters are 32x32 sprites drawn at half size (16 art px) — the classic pixel-RPG look.
import { sheetFor, frameFor, posesFor } from "./sprites.js";
import { hash32, rng, offscreen, clamp, BUSY } from "./util.js";
import { shade } from "./art.js";

export const IW = 136, IH = 96, WALL = 3;
export const HOUSE_W = IW + WALL * 2, HOUSE_H = IH + WALL * 2;
export const IDLE_SLEEP_MS = 3 * 60_000;
const K = 0.5;          // sprite px -> art px
const MINI = 0.6;       // subagent size
const WALK = 26, RUN = 46; // art px / s
const SPAWN_MS = 380, POP_MS = 420;

// ---------- floor plan ----------

const DOORS = { OS: [81, 28], OL: [41, 53], SB: [107, 53], LB: [81, 76] };
const ADJ = { O: { S: "OS", L: "OL" }, S: { O: "OS", B: "SB" }, L: { O: "OL", B: "LB" }, B: { S: "SB", L: "LB" } };
export const FRONT_DOOR = [69, 93];
const roomOf = (x, y) => (x < 81 ? (y < 53 ? "O" : "L") : (y < 53 ? "S" : "B"));

const DESKS = [[4, 20], [30, 20], [56, 20], [4, 44], [30, 44], [56, 44]]; // [x, top] of a 20-wide desk
const BEDS = [85, 98, 111, 124];                                         // x of an 11-wide bed, y 58..86
const SPOTS = {
  shelf: { pose: "stand", pts: [[90, 19], [100, 19], [95, 23]] },
  bench: { pose: "stand", pts: [[116, 19], [127, 19], [121, 23]] },
  write: { pose: "seat", pts: [[92, 40], [102, 40]] },
  mcp: { pose: "stand", pts: [[110, 47], [110, 36], [104, 49]] },
  radio: { pose: "stand", pts: [[15, 84], [22, 88]] },
  rest: { pose: "sit", pts: [[25, 69], [34, 69], [43, 69], [61, 71]] },
  door: { pose: "stand", pts: [[69, 92], [62, 90], [76, 90]] },
};
const TOOL_SPOT = {
  Bash: "bench", Read: "shelf", Grep: "shelf", Glob: "shelf", LS: "shelf",
  Edit: "write", Write: "write", MultiEdit: "write", NotebookEdit: "write", apply_patch: "write",
  WebFetch: "radio", WebSearch: "radio", MCP: "mcp",
};
export const SPOT_LABEL = { desk: "desk", shelf: "bookshelf", bench: "terminal", write: "writing table", mcp: "MCP corner", radio: "radio", rest: "sofa", door: "front door", bed: "bed" };

function routeTo(x0, y0, x1, y1) {
  const a = roomOf(x0, y0), b = roomOf(x1, y1);
  if (a === b) return [[x1, y1]];
  if (ADJ[a][b]) return [DOORS[ADJ[a][b]], [x1, y1]];
  // opposite corners: go through whichever neighbour is shorter
  const via = Object.keys(ADJ[a]).filter((r) => ADJ[r][b]);
  let best = null, bestD = Infinity;
  for (const r of via) {
    const d1 = DOORS[ADJ[a][r]], d2 = DOORS[ADJ[r][b]];
    const d = Math.hypot(d1[0] - x0, d1[1] - y0) + Math.hypot(d2[0] - d1[0], d2[1] - d1[1]) + Math.hypot(x1 - d2[0], y1 - d2[1]);
    if (d < bestD) { bestD = d; best = [d1, d2]; }
  }
  return [...best, [x1, y1]];
}

// ---------- static art (cached per layout) ----------

function R(c, x, y, w, h, col) { c.fillStyle = col; c.fillRect(x, y, w, h); }
const O = "#140f1c";
const baseCache = new Map();

// House floor plan with furniture that never overlaps residents from the front.
export function houseBase(homeId, desks, beds) {
  const key = `${homeId}|${desks}|${beds}`;
  let img = baseCache.get(key);
  if (img) return img;
  if (baseCache.size > 400) baseCache.delete(baseCache.keys().next().value);
  const h = hash32(homeId || "home");
  const r = rng(h);
  const [cv, c] = offscreen(HOUSE_W, HOUSE_H);
  c.translate(WALL, WALL);
  const woods = [["#7a5640", "#6c4b37"], ["#8a6a4a", "#7a5c3f"], ["#6e5a6e", "#625064"], ["#5f6a5a", "#56604f"]];
  const [fa, fb] = woods[h % woods.length];
  // floors: wooden planks in office/study, tiles in living, carpet in bedroom
  for (let y = 0; y < 53; y += 4) { R(c, 0, y, IW, 4, (y / 4) % 2 ? fa : fb); for (let x = ((y / 4) * 11) % 24; x < IW; x += 24) R(c, x, y, 1, 4, shade(fb, -0.2)); }
  for (let y = 53; y < IH; y += 6) for (let x = 0; x < 81; x += 6) R(c, x, y, 6, 6, ((x + y) / 6) % 2 ? "#a89a86" : "#9a8c78");
  const carpet = ["#5a4a78", "#4a6a6a", "#7a4a5a", "#4a5a7a"][(h >>> 5) % 4];
  R(c, 81, 53, IW - 81, IH - 53, carpet);
  for (let y = 55; y < IH; y += 4) for (let x = 83 + (y % 8 ? 2 : 0); x < IW; x += 4) R(c, x, y, 1, 1, shade(carpet, 0.12));

  // ---- study: bookshelf, terminal workbench, MCP crates
  R(c, 85, 0, 20, 9, O); R(c, 86, 0, 18, 8, "#6b4430");
  for (let row = 0; row < 2; row++) for (let i = 0; i < 8; i++) R(c, 87 + i * 2, 1 + row * 4, 1, 3, ["#d9534f", "#5fa8d3", "#f2cc8f", "#81b29a", "#9d6bd8", "#e5989b"][(i + row * 3 + h) % 6]);
  R(c, 109, 0, 26, 10, O); R(c, 110, 0, 24, 9, "#5a5a6a"); R(c, 110, 8, 24, 1, "#3a3a4a");
  R(c, 113, 1, 9, 6, O); R(c, 114, 2, 7, 4, "#0f2a1a");
  R(c, 115, 3, 3, 1, "#7fd36b"); R(c, 115, 4, 5, 1, "#4fa35b");
  R(c, 124, 1, 9, 6, O); R(c, 125, 2, 7, 4, "#0f2a1a"); R(c, 126, 3, 4, 1, "#7fd36b");
  R(c, 113, 34, 22, 17, O); R(c, 114, 35, 10, 8, "#a8783a"); R(c, 124, 35, 10, 8, "#946a32"); R(c, 114, 43, 20, 7, "#a8783a");
  for (const [x, y] of [[114, 38], [124, 38], [114, 46]]) R(c, x, y, 10, 1, "#7a5528");
  R(c, 117, 31, 6, 4, O); R(c, 118, 32, 4, 2, "#d9534f"); R(c, 119, 30, 2, 1, O); // old phone
  // ---- living: sofa, armchair, rug, coffee table, radio, plant, window
  R(c, 16, 72, 40, 18, "#7a3f4f"); R(c, 18, 74, 36, 14, "#8a4a5c"); R(c, 20, 76, 32, 1, "#a8687a"); R(c, 20, 85, 32, 1, "#a8687a");
  R(c, 27, 78, 18, 6, O); R(c, 28, 79, 16, 4, "#9a6a45");
  R(c, 34, 79, 3, 2, "#f3e9d2");
  const sofa = ["#3d5a80", "#81b29a", "#c97b3a", "#6b4f8f"][(h >>> 9) % 4];
  R(c, 18, 56, 34, 12, O); R(c, 19, 57, 32, 6, shade(sofa, -0.2)); R(c, 19, 63, 32, 4, sofa); R(c, 18, 58, 3, 10, shade(sofa, -0.3)); R(c, 49, 58, 3, 10, shade(sofa, -0.3));
  R(c, 56, 58, 12, 11, O); R(c, 57, 59, 10, 5, shade(sofa, -0.25)); R(c, 57, 64, 10, 4, sofa);
  R(c, 2, 74, 10, 7, O); R(c, 3, 75, 8, 5, "#8a5d3f"); R(c, 4, 72, 6, 4, O); R(c, 5, 73, 4, 2, "#c9a86a"); R(c, 6, 73, 1, 1, O);
  R(c, 72, 56, 7, 7, O); R(c, 73, 59, 5, 4, "#a8683a"); R(c, 72, 55, 7, 4, "#4f9a5c"); R(c, 74, 54, 3, 2, "#6ab874");
  // ---- bedroom: beds (frame + pillow; blanket drawn over sleepers later)
  for (let i = 0; i < beds; i++) {
    const x = BEDS[i];
    R(c, x, 57, 11, 30, O); R(c, x + 1, 58, 9, 28, "#d9c9b0");
    R(c, x + 2, 59, 7, 4, "#fff8ec");
    R(c, x + 1, 64, 9, 22, blanketColor(h, i)); R(c, x + 1, 64, 9, 1, shade(blanketColor(h, i), 0.25));
  }
  R(c, 83, 88, 6, 6, O); R(c, 84, 89, 4, 4, "#8a5d3f"); R(c, 85, 90, 2, 1, "#ffcf6e"); // nightstand + lamp
  // ---- office: chairs (desks are drawn later, in front of seated residents)
  for (let i = 0; i < desks; i++) {
    const [x, top] = DESKS[i];
    R(c, x + 5, top - 9, 10, 9, O); R(c, x + 6, top - 8, 8, 7, "#3a4a6b"); R(c, x + 6, top - 8, 8, 1, "#4d5f85");
  }
  if (desks < 6) { // empty corner: a plant and a printer
    R(c, 70, 4, 7, 8, O); R(c, 71, 7, 5, 4, "#a8683a"); R(c, 70, 2, 7, 5, "#4f9a5c");
  }

  // ---- walls (outer + inner with doorways), drawn as thick outlines
  const wall = "#d8c8b0";
  const W = (x, y, w, hh) => { R(c, x, y, w, hh, O); if (w > 2 && hh > 2) R(c, x + 1, y + 1, w - 2, hh - 2, wall); };
  c.translate(-WALL, -WALL);
  W(0, 0, HOUSE_W, WALL); W(0, 0, WALL, HOUSE_H); W(HOUSE_W - WALL, 0, WALL, HOUSE_H);
  // bottom wall with the front door gap
  W(0, HOUSE_H - WALL, WALL + 62, WALL); W(WALL + 76, HOUSE_H - WALL, HOUSE_W - WALL - 76, WALL);
  R(c, WALL + 62, HOUSE_H - 2, 14, 2, "#8a5d3f"); // threshold
  c.translate(WALL, WALL);
  // inner walls: x 80..82 (gaps y 20..36 and 68..84), y 52..54 (gaps x 34..48 and 100..114)
  W(79, 0, 3, 21); W(79, 36, 3, 33); W(79, 84, 3, IH - 84);
  W(0, 52, 35, 3); W(48, 52, 52, 3); W(114, 52, IW - 114, 3);
  // window on the left wall of the living room
  c.translate(-WALL, -WALL);
  R(c, 0, WALL + 60, WALL, 12, "#7fb2e6"); R(c, 0, WALL + 66, WALL, 1, O);
  R(c, 0, WALL + 8, WALL, 10, "#7fb2e6");
  R(c, HOUSE_W - WALL, WALL + 14, WALL, 10, "#7fb2e6");
  c.translate(WALL, WALL);
  baseCache.set(key, cv);
  return cv;
}

function blanketColor(h, i) { return ["#e07a5f", "#5fa8d3", "#81b29a", "#f2cc8f", "#9d6bd8", "#e5989b"][(h + i * 3) % 6]; }

const overlayCache = new Map();
function deskImg(kind) {
  const key = "desk|" + kind;
  let img = overlayCache.get(key);
  if (img) return img;
  const [cv, c] = offscreen(20, 10);
  R(c, 0, 0, 20, 9, O); R(c, 1, 1, 18, 3, "#c9966a"); R(c, 1, 4, 18, 4, "#8a5d3f"); R(c, 1, 1, 18, 1, "#dcae84");
  R(c, 2, 9, 2, 1, O); R(c, 16, 9, 2, 1, O);
  img = cv; overlayCache.set(key, img);
  return img;
}
function laptopImg(on, kind) {
  const key = `lap|${on}|${kind}`;
  let img = overlayCache.get(key);
  if (img) return img;
  const [cv, c] = offscreen(8, 6);
  R(c, 0, 0, 8, 5, O); R(c, 1, 1, 6, 3, "#c9cbd6");
  const logo = kind === "claude-code" ? "#d97757" : kind === "codex" ? "#2a9d8f" : "#9d6bd8";
  R(c, 3, 2, 2, 1, on ? logo : shade(logo, -0.45));
  R(c, 0, 5, 8, 1, "#8e90a0");
  img = cv; overlayCache.set(key, img);
  return img;
}
function writeTableImg() {
  let img = overlayCache.get("write");
  if (img) return img;
  const [cv, c] = offscreen(22, 10);
  R(c, 0, 0, 22, 9, O); R(c, 1, 1, 20, 3, "#b98a5a"); R(c, 1, 4, 20, 4, "#7a5035");
  R(c, 4, 1, 5, 2, "#fff8ec"); R(c, 13, 1, 5, 2, "#fff8ec"); R(c, 10, 1, 1, 2, "#241a2b");
  img = cv; overlayCache.set("write", img);
  return img;
}
function blanketImg(h, i) {
  const key = `bl|${blanketColor(h, i)}`;
  let img = overlayCache.get(key);
  if (img) return img;
  const [cv, c] = offscreen(9, 22);
  const col = blanketColor(h, i);
  R(c, 0, 0, 9, 22, col); R(c, 0, 0, 9, 1, shade(col, 0.3)); R(c, 0, 3, 9, 1, shade(col, -0.15));
  img = cv; overlayCache.set(key, img);
  return img;
}

// ---------- simulation ----------

export class HomeSim {
  constructor(homeId) {
    this.homeId = homeId;
    this.seed = hash32(homeId);
    this.personas = new Map();
    this.ents = new Map();          // id -> entity (agents and "p:<persona>" sleepers)
    this.claims = new Map();        // spot kind -> Map(slot -> entId)
    this.deskOf = new Map();        // top-level agent id -> desk index
    this.lastStale = 0;
  }

  // ---- data in ----
  setPersonas(list) {
    for (const p of list) this.personas.set(p.id, p);
    this.syncSleepers(false);
  }
  upsertPersona(p) {
    this.personas.set(p.id, p);
    this.syncSleepers(true);
  }
  setAgents(list) {
    const open = new Set(list.map((a) => a.id));
    for (const [id, e] of this.ents) if (!e.sleeper && !open.has(id)) this.removeEnt(id);
    for (const a of list) this.upsertAgent(a, false);
    this.syncSleepers(false);
  }
  upsertAgent(a, animate = true) {
    const now = performance.now();
    let e = this.ents.get(a.id);
    if (a.status === "ended") {
      if (!e || e.ending) return;
      e.a = { ...e.a, ...a };
      e.ending = true;
      this.replan(e, true);
      return;
    }
    if (!e) {
      const pid = a.persona_id;
      const parent = a.parent_id ? this.ents.get(a.parent_id) : null;
      const sleeper = this.ents.get("p:" + pid);
      let x = FRONT_DOOR[0], y = FRONT_DOOR[1];
      if (parent && !parent.sleeper) { x = parent.x; y = parent.y; }
      else if (sleeper) { x = sleeper.x; y = sleeper.y; this.removeEnt(sleeper.id); }
      e = {
        id: a.id, a: { ...a }, x, y, path: [], pose: "walk", facing: 1, born: animate ? now : -1e9, dying: 0,
        mini: !!a.parent_id, seed: hash32(a.id) % 9973, target: null, sleeper: false, ending: false,
      };
      this.ents.set(a.id, e);
      if (!e.mini) this.assignDesk(e);
      this.replan(e, animate);
    } else {
      const prev = e.a;
      e.a = { ...e.a, ...a };
      if (e.ending) { e.ending = false; e.dying = 0; }
      if (prev.status !== a.status || prev.tool !== a.tool || prev.parent_id !== a.parent_id) this.replan(e, animate);
    }
  }
  mergeTasks(sessions) { // owner view in the town: add task_no/task_enc from /homes/:id
    for (const s of sessions) { const e = this.ents.get(s.id); if (e) { e.a.task_no = s.task_no; e.a.task_enc = s.task_enc; } }
  }

  // Personas without any open session sleep in their bed.
  syncSleepers(animate) {
    const awake = new Set();
    for (const e of this.ents.values()) if (!e.sleeper) awake.add(e.a.persona_id);
    for (const p of this.personas.values()) {
      const id = "p:" + p.id;
      if (awake.has(p.id)) continue;
      if (!this.ents.has(id)) {
        const [x, y] = this.bedSpot(p.id);
        this.ents.set(id, { id, a: { id, persona_id: p.id, status: "asleep" }, x, y, path: [], pose: "sleep", facing: 1, born: animate ? performance.now() : -1e9, dying: 0, mini: false, seed: hash32(id) % 9973, sleeper: true, target: { kind: "bed", pose: "sleep", x, y } });
      }
    }
    for (const [id, e] of this.ents) if (e.sleeper && (awake.has(e.a.persona_id) || !this.personas.has(e.a.persona_id))) this.removeEnt(id);
  }

  removeEnt(id) {
    this.ents.delete(id);
    this.deskOf.delete(id);
    for (const m of this.claims.values()) for (const [k, v] of m) if (v === id) m.delete(k);
  }

  assignDesk(e) {
    const used = new Set(this.deskOf.values());
    let k = 0;
    while (used.has(k)) k++;
    this.deskOf.set(e.id, k);
  }

  personaIndex(pid) {
    let i = 0;
    for (const id of this.personas.keys()) { if (id === pid) return i; i++; }
    return i;
  }
  bedCount() { return clamp(this.personas.size, 2, 4); }
  deskCount() {
    let top = 0;
    for (const e of this.ents.values()) if (!e.sleeper && !e.mini) top++;
    return clamp(Math.max(top, this.personas.size, Math.max(-1, ...this.deskOf.values()) + 1), 2, 6);
  }
  bedSpot(pid) {
    const i = this.personaIndex(pid) % 4;
    const extra = Math.floor(this.personaIndex(pid) / 4);
    return [BEDS[i] + 5 + extra * 2, 66];
  }
  deskSpot(e) {
    const d = (this.deskOf.get(e.id) ?? 0);
    const [x, top] = DESKS[d % 6];
    return [x + 10 + Math.floor(d / 6) * 3, top];
  }

  claim(kind, e) {
    const spot = SPOTS[kind];
    let m = this.claims.get(kind);
    if (!m) this.claims.set(kind, (m = new Map()));
    for (const [k, v] of m) if (v === e.id) return k;
    let k = 0;
    while (m.has(k)) k++;
    m.set(k, e.id);
    return k;
  }
  release(e) {
    for (const m of this.claims.values()) for (const [k, v] of m) if (v === e.id) m.delete(k);
  }

  // Where should this resident be, given their status?
  goal(e) {
    const a = e.a;
    if (e.ending) {
      if (e.mini) {
        const p = this.ents.get(a.parent_id);
        if (p && !p.sleeper) return { kind: "parent", pose: "stand", x: p.x + 3, y: p.y, then: "pop" };
        return { kind: "door", pose: "stand", x: FRONT_DOOR[0], y: FRONT_DOOR[1], then: "pop" };
      }
      const others = [...this.ents.values()].some((o) => o !== e && !o.sleeper && !o.ending && o.a.persona_id === a.persona_id);
      if (others) return { kind: "door", pose: "stand", x: FRONT_DOOR[0], y: FRONT_DOOR[1], then: "pop" };
      const [x, y] = this.bedSpot(a.persona_id);
      return { kind: "bed", pose: "sleep", x, y, then: "sleep" };
    }
    let kind;
    if (a.status === "tool") kind = TOOL_SPOT[a.tool] ?? "desk";
    else if (a.status === "thinking") kind = "desk";
    else if (a.status === "waiting") kind = "door";
    else if (a.status === "idle") kind = a.last_seen && Date.now() - a.last_seen > IDLE_SLEEP_MS ? "bed" : "rest";
    else kind = "desk";
    if (kind === "bed") { const [x, y] = this.bedSpot(a.persona_id); return { kind, pose: "sleep", x, y }; }
    if (kind === "desk") {
      if (e.mini) { // subagents stand at the parent's desk side
        const p = this.ents.get(a.parent_id);
        const d = p ? this.deskOf.get(p.id) ?? 0 : 0;
        const [x, top] = DESKS[d % 6];
        const n = [...this.ents.values()].filter((o) => o.mini && o.a.parent_id === a.parent_id).indexOf(e);
        return { kind, pose: "stand", x: x + 23 + (n % 2) * 0, y: top + 2 + Math.max(0, n) * 4 };
      }
      const [x, y] = this.deskSpot(e);
      return { kind, pose: "seat", x, y };
    }
    const k = this.claim(kind, e);
    const spot = SPOTS[kind];
    const pt = spot.pts[k % spot.pts.length];
    const lap = Math.floor(k / spot.pts.length);
    const pose = e.mini && spot.pose === "seat" ? "stand" : spot.pose;
    return { kind, pose, x: pt[0] + lap * 4 + (e.mini ? 3 : 0), y: pt[1] + lap * 2 };
  }

  replan(e, animate) {
    this.release(e);
    const g = this.goal(e);
    e.target = g;
    if (!animate) { e.x = g.x; e.y = g.y; e.path = []; e.pose = g.pose; this.arrive(e); return; }
    if (Math.hypot(g.x - e.x, g.y - e.y) < 0.5 && !e.path.length) { e.pose = g.pose; this.arrive(e); return; }
    // step out from behind a desk/bed first
    const start = [];
    if (e.pose === "seat") start.push([e.x, e.y + 6]);
    if (e.pose === "sleep") start.push([e.x, 88]);
    const from = start.length ? start[start.length - 1] : [e.x, e.y];
    e.path = [...start, ...routeTo(from[0], from[1], g.x, g.y + (g.pose === "seat" ? 6 : 0)), ...(g.pose === "seat" ? [[g.x, g.y]] : [])];
    e.pose = "walk";
  }

  arrive(e) {
    const t = e.target;
    if (!t) return;
    if (t.then === "pop" && !e.dying) e.dying = performance.now();
    if (t.then === "sleep") { this.removeEnt(e.id); this.syncSleepers(false); }
  }

  update(dt, now) {
    if (now - this.lastStale > 2000) {
      this.lastStale = now;
      for (const e of this.ents.values()) {
        if (e.sleeper || e.ending) continue;
        if (e.a.status === "idle" && e.target?.kind === "rest" && e.a.last_seen && Date.now() - e.a.last_seen > IDLE_SLEEP_MS) this.replan(e, true);
      }
    }
    for (const e of [...this.ents.values()]) {
      if (e.dying && now - e.dying > POP_MS) { this.removeEnt(e.id); this.syncSleepers(true); continue; }
      if (!e.path.length) continue;
      const speed = (e.mini ? RUN : WALK) * dt;
      let left = speed;
      while (left > 0 && e.path.length) {
        const [tx, ty] = e.path[0];
        const dx = tx - e.x, dy = ty - e.y, d = Math.hypot(dx, dy);
        if (Math.abs(dx) > 0.3) e.facing = dx < 0 ? -1 : 1;
        if (d <= left) { e.x = tx; e.y = ty; e.path.shift(); left -= d; }
        else { e.x += (dx / d) * left; e.y += (dy / d) * left; left = 0; }
      }
      if (!e.path.length) { e.pose = e.target?.pose ?? "stand"; this.arrive(e); }
    }
  }

  stats() {
    let awake = 0, busy = 0, agents = 0;
    for (const e of this.ents.values()) {
      if (e.sleeper) continue;
      agents++;
      if (e.target?.kind !== "bed") awake++;
      if (BUSY.has(e.a.status)) busy++;
    }
    return { awake, busy, agents };
  }

  // ---------- drawing ----------
  // X0,Y0: device px of the interior origin; s: device px per art px; t: ms.
  // Returns label anchors [{ent, x, y}] in device px (top of head).
  draw(ctx, X0, Y0, s, t, { reduced = false, now = performance.now() } = {}) {
    const desks = this.deskCount(), beds = this.bedCount();
    const base = houseBase(this.homeId, desks, beds);
    ctx.drawImage(base, Math.round(X0 - WALL * s), Math.round(Y0 - WALL * s), Math.round(HOUSE_W * s), Math.round(HOUSE_H * s));
    const P = (v) => Math.round(v);
    const items = [];
    const deskBusy = new Map();
    for (const e of this.ents.values()) {
      if (!e.sleeper && !e.mini && e.pose === "seat" && e.target?.kind === "desk") deskBusy.set(this.deskOf.get(e.id) % 6, e);
    }
    for (let i = 0; i < desks; i++) {
      const [x, top] = DESKS[i];
      const occ = deskBusy.get(i);
      const kind = occ ? this.personas.get(occ.a.persona_id)?.kind : "";
      items.push({ y: top + 0.2, draw: () => {
        ctx.drawImage(deskImg(), P(X0 + x * s), P(Y0 + (top - 1) * s), P(20 * s), P(10 * s));
        ctx.drawImage(laptopImg(!!occ && BUSY.has(occ.a.status), kind), P(X0 + (x + 6) * s), P(Y0 + (top - 4) * s), P(8 * s), P(6 * s));
      } });
    }
    items.push({ y: 40.2, draw: () => ctx.drawImage(writeTableImg(), P(X0 + 86 * s), P(Y0 + 39 * s), P(22 * s), P(10 * s)) });

    const anchors = [];
    for (const e of this.ents.values()) {
      const persona = this.personas.get(e.a.persona_id) ?? { id: e.a.persona_id, kind: "other" };
      const sleeping = e.pose === "sleep";
      const y = sleeping ? 63.9 : e.pose === "seat" ? e.y - 0.5 : e.y;
      items.push({ y, draw: () => {
        const top = this.drawResident(ctx, e, persona, X0, Y0, s, t, now, reduced);
        if (sleeping) {
          const bi = BEDS.findIndex((bx) => e.x >= bx && e.x <= bx + 11);
          if (bi >= 0) ctx.drawImage(blanketImg(this.seed, bi), P(X0 + (BEDS[bi] + 1) * s), P(Y0 + 64 * s), P(9 * s), P(22 * s));
        }
        if (top != null) anchors.push({ ent: e, persona, x: X0 + e.x * s, y: top });
      } });
    }
    items.sort((a, b) => a.y - b.y);
    for (const it of items) it.draw();
    return anchors;
  }

  drawResident(ctx, e, persona, X0, Y0, s, t, now, reduced) {
    const k = K * (e.mini ? MINI : 1);
    let pop = 1;
    if (e.dying) { const p = clamp((now - e.dying) / POP_MS, 0, 1); pop = 1 - p * p; }
    else if (now - e.born < SPAWN_MS) { const p = (now - e.born) / SPAWN_MS; const c1 = 1.70158; pop = 1 + (c1 + 1) * (p - 1) ** 3 + c1 * (p - 1) ** 2; }
    if (pop <= 0.02) return null;
    const sheet = sheetFor(persona);
    const poses = posesFor(persona);
    const n = sheet.size;
    let img, topArt, h = n * k;
    const status = e.a.status;
    if (e.pose === "walk") {
      const f = Math.floor((t + e.seed) / (e.mini ? 85 : 130)) % 4;
      img = e.facing < 0 ? poses.walkL[f] : poses.walk[f];
      topArt = e.y - h;
    } else if (e.pose === "seat") {
      img = frameFor(sheet, status === "waiting" ? "idle" : status, t, e.seed);
      topArt = e.y - 24 * k; // desk covers the legs
    } else if (e.pose === "sit") {
      img = poses.sit; topArt = e.y - h;
    } else if (e.pose === "sleep") {
      img = poses.sleep; topArt = 58.5;
    } else {
      img = frameFor(sheet, status === "tool" || status === "thinking" ? status : "idle", t, e.seed);
      topArt = e.y - h;
    }
    const w = n * k * s * pop, hh = n * k * s * pop;
    const cx = X0 + e.x * s, footY = Y0 + (topArt + h) * s;
    // shadow
    if (e.pose === "walk" || e.pose === "stand") {
      ctx.fillStyle = "rgba(10, 6, 20, 0.28)";
      ctx.fillRect(Math.round(cx - 4 * k * 2 * s), Math.round(footY - 1 * s), Math.round(8 * k * 2 * s), Math.max(1, Math.round(1.5 * s)));
    }
    ctx.drawImage(img, Math.round(cx - w / 2), Math.round(footY - hh), Math.round(w), Math.round(hh));
    // poof
    const age = e.dying ? now - e.dying : now - e.born;
    if (!reduced && age >= 0 && age < 420) {
      const p = age / 420;
      ctx.fillStyle = `rgba(243, 233, 210, ${0.85 * (1 - p)})`;
      for (let i = 0; i < 7; i++) {
        const ang = (i / 7) * Math.PI * 2 + e.seed;
        const r = (3 + p * 7) * s * (e.mini ? 0.6 : 1);
        const sz = Math.max(1, Math.round((1.5 - p) * s));
        ctx.fillRect(Math.round(cx + Math.cos(ang) * r), Math.round(footY - h * s / 2 + Math.sin(ang) * r * 0.7), sz, sz);
      }
    }
    return Math.round(footY - hh);
  }

  hitTest(ax, ay) {
    let best = null;
    for (const e of this.ents.values()) {
      const k = K * (e.mini ? MINI : 1), h = 32 * k;
      const top = e.pose === "seat" ? e.y - 24 * k : e.pose === "sleep" ? 58 : e.y - h;
      const bottom = e.pose === "seat" ? e.y : e.pose === "sleep" ? 70 : e.y;
      if (ax >= e.x - 6 * k * 2 && ax <= e.x + 6 * k * 2 && ay >= top && ay <= bottom) {
        if (!best || e.y > best.y) best = e;
      }
    }
    return best;
  }
}

// Text for a resident's status bubble.
export function statusLine(e) {
  const a = e.a;
  if (e.sleeper || e.pose === "sleep") return "z z z";
  if (e.ending) return "bye!";
  if (a.status === "tool") return `⚙ ${a.tool || "tool"}`;
  if (a.status === "thinking") return "thinking…";
  if (a.status === "waiting") return "? needs you";
  return "resting";
}
