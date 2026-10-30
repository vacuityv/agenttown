// Strict allowlist sanitizer for the SVG fragments in v2 sprites (docs/protocol.md "Sprite format v2").
//
// The fragments are written by a model from a stranger's description and rendered inline for everyone,
// so nothing the model wrote is passed through: we tokenize the fragment ourselves, keep only allowlisted
// elements/attributes whose values match a strict grammar, and serialize a fresh string from the parsed
// numbers / keywords. Any syntax we don't fully understand (comments-with-tricks, CDATA, doctype,
// entities, processing instructions, mismatched tags) is rejected outright.
//
// No dependencies; pure functions, so it can be unit-tested (test/svg-sanitize.ts) and imported without a DB.

export class SvgError extends Error {}

export const LIMITS = {
  parts: 12,
  elements: 400, // total over all parts
  bytes: 24 * 1024, // total serialized svg over all parts
  depth: 8,
  inputBytes: 64 * 1024, // per raw fragment, before parsing
  pathNumbers: 4000, // per d attribute
  points: 1000, // numbers per points attribute
  coord: 1000, // |coordinate| bound (viewBox is ~64 units)
} as const;

// ---------------------------------------------------------------- tokenizer

type Tok =
  | { t: "open"; name: string; attrs: [string, string][]; selfClose: boolean }
  | { t: "close"; name: string }
  | { t: "text"; text: string };

const NAME_RE = /^[A-Za-z][A-Za-z0-9_.:-]*/;

function tokenize(src: string): Tok[] {
  if (src.length > LIMITS.inputBytes) throw new SvgError("fragment too large");
  const out: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt === -1) { out.push({ t: "text", text: src.slice(i) }); break; }
    if (lt > i) out.push({ t: "text", text: src.slice(i, lt) });
    i = lt;
    if (src.startsWith("<!--", i)) {
      // Plain comments are dropped. Refuse anything that could confuse a parser ("--" inside, unterminated).
      const end = src.indexOf("-->", i + 4);
      if (end === -1) throw new SvgError("unterminated comment");
      if (src.slice(i + 4, end).includes("--")) throw new SvgError("malformed comment");
      i = end + 3;
      continue;
    }
    if (src[i + 1] === "!" || src[i + 1] === "?") throw new SvgError("markup declaration not allowed");
    if (src[i + 1] === "/") {
      const m = NAME_RE.exec(src.slice(i + 2, i + 2 + 64));
      if (!m) throw new SvgError("bad closing tag");
      let j = i + 2 + m[0].length;
      while (j < n && /\s/.test(src[j])) j++;
      if (src[j] !== ">") throw new SvgError("bad closing tag");
      out.push({ t: "close", name: m[0] });
      i = j + 1;
      continue;
    }
    const m = NAME_RE.exec(src.slice(i + 1, i + 1 + 64));
    if (!m) throw new SvgError("bad tag");
    const name = m[0];
    let j = i + 1 + name.length;
    const attrs: [string, string][] = [];
    let selfClose = false;
    for (;;) {
      const ws = j;
      while (j < n && /\s/.test(src[j])) j++;
      if (j >= n) throw new SvgError("unclosed tag");
      if (src[j] === ">") { j++; break; }
      if (src[j] === "/" && src[j + 1] === ">") { selfClose = true; j += 2; break; }
      if (j === ws && attrs.length) throw new SvgError("missing space between attributes");
      const am = /^[A-Za-z_:][A-Za-z0-9_.:-]*/.exec(src.slice(j, j + 64));
      if (!am) throw new SvgError("bad attribute name");
      const aname = am[0];
      j += aname.length;
      while (j < n && /\s/.test(src[j])) j++;
      let value = "";
      if (src[j] === "=") {
        j++;
        while (j < n && /\s/.test(src[j])) j++;
        const q = src[j];
        if (q === '"' || q === "'") {
          const end = src.indexOf(q, j + 1);
          if (end === -1) throw new SvgError("unterminated attribute value");
          value = src.slice(j + 1, end);
          j = end + 1;
        } else {
          const um = /^[^\s"'=<>`/]+/.exec(src.slice(j, j + 4096));
          if (!um) throw new SvgError("bad attribute value");
          value = um[0];
          j += value.length;
        }
      }
      if (value.includes("<")) throw new SvgError("'<' in attribute value");
      attrs.push([aname, value]);
    }
    out.push({ t: "open", name, attrs, selfClose });
    i = j;
  }
  return out;
}

// ---------------------------------------------------------------- tree

type Node = { name: string; attrs: [string, string][]; children: Node[] };

function buildTree(toks: Tok[]): Node[] {
  const root: Node = { name: "#root", attrs: [], children: [] };
  const stack: Node[] = [root];
  for (const tk of toks) {
    if (tk.t === "text") {
      // No text-bearing elements are allowed, so text is dropped; but entity/CDATA-ish text is a red flag.
      if (tk.text.includes("&")) throw new SvgError("entities not allowed");
      continue;
    }
    if (tk.t === "open") {
      const node: Node = { name: tk.name, attrs: tk.attrs, children: [] };
      stack[stack.length - 1].children.push(node);
      if (!tk.selfClose) {
        if (stack.length > 32) throw new SvgError("nesting too deep");
        stack.push(node);
      }
      continue;
    }
    if (stack.length === 1 || stack[stack.length - 1].name !== tk.name) throw new SvgError(`mismatched </${tk.name}>`);
    stack.pop();
  }
  // Unclosed elements at the end are closed implicitly; we re-serialize anyway.
  return root.children;
}

// ---------------------------------------------------------------- value grammars

const NUM_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d{1,3})?/;

export function fmt(v: number): string {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
}

function num(s: string, lo: number = -LIMITS.coord, hi: number = LIMITS.coord): number | null {
  const t = s.trim();
  const m = NUM_RE.exec(t);
  if (!m || m[0].length !== t.length) return null;
  const v = Number(m[0]);
  if (!Number.isFinite(v) || v < lo || v > hi) return null;
  return v;
}

/** Number list separated by whitespace and/or commas. */
function numList(s: string, max: number): number[] | null {
  const out: number[] = [];
  let i = 0;
  const src = s.trim();
  while (i < src.length) {
    while (i < src.length && /[\s,]/.test(src[i])) i++;
    if (i >= src.length) break;
    const m = NUM_RE.exec(src.slice(i, i + 40));
    if (!m) return null;
    const v = Number(m[0]);
    if (!Number.isFinite(v) || Math.abs(v) > LIMITS.coord) return null;
    out.push(v);
    if (out.length > max) return null;
    i += m[0].length;
  }
  return out;
}

const PATH_ARGS: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };

function pathData(s: string): string | null {
  const src = s.trim();
  let i = 0;
  const out: string[] = [];
  let count = 0;
  let first = true;
  const skip = () => { while (i < src.length && /[\s,]/.test(src[i])) i++; };
  const readNum = (): number | null => {
    skip();
    const m = NUM_RE.exec(src.slice(i, i + 40));
    if (!m) return null;
    const v = Number(m[0]);
    if (!Number.isFinite(v) || Math.abs(v) > LIMITS.coord) return null;
    i += m[0].length;
    return v;
  };
  const readFlag = (): number | null => {
    skip();
    if (src[i] === "0" || src[i] === "1") return Number(src[i++]);
    return null;
  };
  skip();
  while (i < src.length) {
    const cmd = src[i];
    const lc = cmd.toLowerCase();
    if (!(lc in PATH_ARGS)) return null;
    if (first && lc !== "m") return null;
    first = false;
    i++;
    const k = PATH_ARGS[lc];
    out.push(cmd);
    if (k === 0) { skip(); continue; }
    let groups = 0;
    for (;;) {
      skip();
      if (i >= src.length || /[A-Za-z]/.test(src[i])) break;
      const args: number[] = [];
      for (let a = 0; a < k; a++) {
        const v = lc === "a" && (a === 3 || a === 4) ? readFlag() : readNum();
        if (v === null) return null;
        args.push(v);
      }
      if (lc === "a" && (args[0] < 0 || args[1] < 0)) return null;
      out.push(args.map(fmt).join(" "));
      count += k;
      groups++;
      if (count > LIMITS.pathNumbers) return null;
    }
    if (groups === 0) return null;
  }
  return out.length ? out.join(" ") : null;
}

const TRANSFORM_ARGS: Record<string, number[]> = {
  matrix: [6], translate: [1, 2], scale: [1, 2], rotate: [1, 3], skewX: [1], skewY: [1],
};

function transformList(s: string): string | null {
  const src = s.trim();
  if (!src) return null;
  const out: string[] = [];
  const re = /\s*,?\s*([A-Za-z]+)\s*\(([^()]*)\)/y;
  let i = 0;
  while (i < src.length) {
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) return null;
    const fn = m[1];
    const allowed = Object.hasOwn(TRANSFORM_ARGS, fn) ? TRANSFORM_ARGS[fn] : null;
    if (!allowed) return null;
    const args = numList(m[2], 6);
    if (!args || !allowed.includes(args.length)) return null;
    out.push(`${fn}(${args.map(fmt).join(" ")})`);
    if (out.length > 8) return null;
    i = re.lastIndex;
    while (i < src.length && /\s/.test(src[i])) i++;
  }
  return out.join(" ");
}

const NAMED_COLORS = new Set([
  "black", "white", "red", "green", "blue", "yellow", "orange", "purple", "pink", "brown", "gray", "grey",
  "cyan", "magenta", "gold", "silver", "navy", "teal", "maroon", "olive", "lime", "aqua", "fuchsia",
  "indigo", "violet", "coral", "salmon", "crimson", "khaki", "beige", "ivory", "tan", "turquoise",
  "skyblue", "orchid", "plum", "tomato", "chocolate", "transparent",
]);

const GRAD_ID_RE = /^[a-z0-9-]{1,24}$/;

/** Returns the canonical color, or {ref} for url(#id) (resolved later), or null if not allowed. */
function color(s: string): string | { ref: string } | null {
  const v = s.trim();
  const lower = v.toLowerCase();
  if (lower === "none") return "none";
  if (lower === "currentcolor") return "currentColor";
  if (NAMED_COLORS.has(lower)) return lower;
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(lower)) return lower;
  let m = /^rgba?\(\s*([^()]*)\)$/.exec(lower);
  if (m) {
    const parts = m[1].split(/\s*,\s*|\s+/).filter(Boolean);
    if (parts.length !== 3 && parts.length !== 4) return null;
    const ch: string[] = [];
    for (let k = 0; k < 3; k++) {
      const p = parts[k];
      const pct = p.endsWith("%");
      const x = num(pct ? p.slice(0, -1) : p, 0, pct ? 100 : 255);
      if (x === null) return null;
      ch.push(String(Math.round(pct ? (x * 255) / 100 : x)));
    }
    if (parts.length === 4) {
      const p = parts[3];
      const pct = p.endsWith("%");
      const a = num(pct ? p.slice(0, -1) : p, 0, pct ? 100 : 1);
      if (a === null) return null;
      return `rgba(${ch.join(",")},${fmt(pct ? a / 100 : a)})`;
    }
    return `rgb(${ch.join(",")})`;
  }
  m = /^url\(\s*#([a-z0-9-]{1,24})\s*\)$/.exec(v);
  if (m) return { ref: m[1] };
  return null;
}

// ---------------------------------------------------------------- allowlist

type Kind = "coord" | "len" | "opacity" | "width" | "offset" | "path" | "points" | "transform" | "paint"
  | "linecap" | "linejoin" | "fillrule" | "units" | "spread" | "id";

const ATTR_KIND: Record<string, Kind> = {
  d: "path", cx: "coord", cy: "coord", r: "len", rx: "len", ry: "len", x: "coord", y: "coord",
  x1: "coord", y1: "coord", x2: "coord", y2: "coord", fx: "coord", fy: "coord", width: "len", height: "len",
  points: "points", fill: "paint", stroke: "paint", "stroke-width": "width", "stroke-linecap": "linecap",
  "stroke-linejoin": "linejoin", "fill-rule": "fillrule", opacity: "opacity", "fill-opacity": "opacity",
  "stroke-opacity": "opacity", transform: "transform", id: "id", offset: "offset", "stop-color": "paint",
  "stop-opacity": "opacity", gradientUnits: "units", gradientTransform: "transform", spreadMethod: "spread",
};

const SHAPE_ATTRS = ["fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "fill-rule",
  "opacity", "fill-opacity", "stroke-opacity", "transform"];

const ELEMENTS: Record<string, string[]> = {
  g: SHAPE_ATTRS,
  defs: [],
  path: ["d", ...SHAPE_ATTRS],
  circle: ["cx", "cy", "r", ...SHAPE_ATTRS],
  ellipse: ["cx", "cy", "rx", "ry", ...SHAPE_ATTRS],
  rect: ["x", "y", "width", "height", "rx", "ry", ...SHAPE_ATTRS],
  polygon: ["points", ...SHAPE_ATTRS],
  polyline: ["points", ...SHAPE_ATTRS],
  line: ["x1", "y1", "x2", "y2", ...SHAPE_ATTRS],
  linearGradient: ["id", "x1", "y1", "x2", "y2", "gradientUnits", "gradientTransform", "spreadMethod"],
  radialGradient: ["id", "cx", "cy", "r", "fx", "fy", "gradientUnits", "gradientTransform", "spreadMethod"],
  stop: ["offset", "stop-color", "stop-opacity"],
};
const CONTAINERS = new Set(["g", "defs"]);
const GRADIENTS = new Set(["linearGradient", "radialGradient"]);

// Elements whose subtree must vanish entirely (also anything not in ELEMENTS: dropped with its subtree).
// Listed only for documentation; the allowlist is what matters.
// script, style, foreignObject, image, use, text, a, animate*, set, filter, mask, clipPath, pattern, symbol, svg ...

type Val = string | { ref: string };

function attrValue(kind: Kind, raw: string, gradient: boolean): Val | null {
  // Coordinates on gradients may be percentages (objectBoundingBox defaults).
  const pctOk = gradient || kind === "offset";
  const n = (lo: number, hi: number, allowPct = false): string | null => {
    const s = raw.trim();
    if (allowPct && s.endsWith("%")) {
      const v = num(s.slice(0, -1), -1000, 1000);
      return v === null ? null : fmt(v) + "%";
    }
    const v = num(s, lo, hi);
    return v === null ? null : fmt(v);
  };
  switch (kind) {
    case "coord": return n(-LIMITS.coord, LIMITS.coord, pctOk);
    case "len": return n(0, LIMITS.coord, pctOk);
    case "width": return n(0, 64);
    case "opacity": return n(0, 1);
    case "offset": return n(0, 1, true);
    case "path": return pathData(raw);
    case "points": {
      const l = numList(raw, LIMITS.points);
      return l && l.length >= 4 && l.length % 2 === 0 ? l.map(fmt).join(" ") : null;
    }
    case "transform": return transformList(raw);
    case "paint": return color(raw);
    case "linecap": return ["butt", "round", "square"].includes(raw.trim()) ? raw.trim() : null;
    case "linejoin": return ["miter", "round", "bevel"].includes(raw.trim()) ? raw.trim() : null;
    case "fillrule": return ["nonzero", "evenodd"].includes(raw.trim()) ? raw.trim() : null;
    case "units": return ["userSpaceOnUse", "objectBoundingBox"].includes(raw.trim()) ? raw.trim() : null;
    case "spread": return ["pad", "reflect", "repeat"].includes(raw.trim()) ? raw.trim() : null;
    case "id": return GRAD_ID_RE.test(raw) ? raw : null;
  }
}

type Clean = { name: string; attrs: [string, Val][]; children: Clean[] };

type Ctx = { elements: number; gradIds: Set<string> };

function clean(node: Node, parent: string, depth: number, ctx: Ctx): Clean | null {
  const allowed = Object.hasOwn(ELEMENTS, node.name) ? ELEMENTS[node.name] : null;
  if (!allowed) return null; // unknown / dangerous element: drop with its whole subtree
  if (depth > LIMITS.depth) return null;
  // Content model: stops only inside gradients; gradients contain only stops.
  if (node.name === "stop" && !GRADIENTS.has(parent)) return null;
  if (GRADIENTS.has(parent) && node.name !== "stop") return null;
  ctx.elements++;
  if (ctx.elements > LIMITS.elements) throw new SvgError(`more than ${LIMITS.elements} elements`);

  const gradient = GRADIENTS.has(node.name);
  const attrs: [string, Val][] = [];
  const seen = new Set<string>();
  for (const [name, raw] of node.attrs) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (!allowed.includes(name)) continue; // on*, href, style, class, xmlns:*, ... are all dropped
    if (raw.includes("&") || raw.includes("\\")) continue; // no entities / escapes, ever
    const v = attrValue(ATTR_KIND[name], raw, gradient);
    if (v === null) continue;
    attrs.push([name, v]);
  }
  if (gradient) {
    const id = attrs.find(([k]) => k === "id")?.[1];
    if (typeof id !== "string") return null; // a gradient nobody can reference is useless
    if (ctx.gradIds.has(id)) return null; // first definition wins
    ctx.gradIds.add(id);
  }
  const children: Clean[] = [];
  if (CONTAINERS.has(node.name) || gradient) {
    for (const c of node.children) {
      const cc = clean(c, node.name, depth + 1, ctx);
      if (cc) children.push(cc);
    }
  }
  // Required geometry: drop shapes that would not render anyway.
  const has = (k: string) => attrs.some(([a]) => a === k);
  if (node.name === "path" && !has("d")) return dropped(ctx);
  if ((node.name === "polygon" || node.name === "polyline") && !has("points")) return dropped(ctx);
  if (node.name === "circle" && !has("r")) return dropped(ctx);
  if (node.name === "ellipse" && !(has("rx") || has("ry"))) return dropped(ctx);
  if (node.name === "rect" && !(has("width") && has("height"))) return dropped(ctx);
  if (node.name === "g" && children.length === 0) return dropped(ctx);
  return { name: node.name, attrs, children };
}
function dropped(ctx: Ctx): null { ctx.elements--; return null; }

// ---------------------------------------------------------------- serialize

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function serialize(n: Clean, idPrefix: string, defined: Set<string>): string {
  let s = "<" + n.name;
  for (const [k, v] of n.attrs) {
    let out: string;
    if (typeof v === "string") out = k === "id" ? idPrefix + v : v;
    else if (defined.has(v.ref)) out = `url(#${idPrefix}${v.ref})`;
    else continue; // reference to something that is not one of our own gradients
    s += ` ${k}="${esc(out)}"`;
  }
  if (!n.children.length) return s + "/>";
  return s + ">" + n.children.map((c) => serialize(c, idPrefix, defined)).join("") + `</${n.name}>`;
}

// ---------------------------------------------------------------- public API

export type CleanPart = { id: string; svg: string; pivot: [number, number] };

/**
 * Sanitizes all parts of one sprite together (gradients defined in one part may be used by another).
 * `idPrefix` namespaces gradient ids (e.g. "p-ab12cd-") so ids never collide across characters on one page;
 * it must match /^[a-z0-9-]{0,32}$/. Throws SvgError when a limit is exceeded or the markup is malformed.
 */
export function sanitizeParts(
  parts: { id: string; svg: string; pivot: [number, number] }[],
  idPrefix = "",
): { parts: CleanPart[]; elements: number; bytes: number } {
  if (!/^[a-z0-9-]{0,32}$/.test(idPrefix)) throw new SvgError("bad id prefix");
  if (parts.length > LIMITS.parts) throw new SvgError(`more than ${LIMITS.parts} parts`);
  const ctx: Ctx = { elements: 0, gradIds: new Set() };
  const trees = parts.map((p) => {
    let nodes = buildTree(tokenize(String(p.svg ?? "")));
    // Tolerate a stray <svg> wrapper: keep its children, ignore its attributes.
    nodes = nodes.flatMap((nd) => (nd.name === "svg" ? nd.children : [nd]));
    return nodes.map((nd) => clean(nd, "#root", 1, ctx)).filter((x): x is Clean => !!x);
  });
  let bytes = 0;
  const out: CleanPart[] = [];
  trees.forEach((nodes, k) => {
    const svg = nodes.map((nd) => serialize(nd, idPrefix, ctx.gradIds)).join("");
    if (!svg) return; // a part with nothing drawable left is dropped
    bytes += Buffer.byteLength(svg);
    out.push({ id: parts[k].id, svg, pivot: parts[k].pivot });
  });
  if (bytes > LIMITS.bytes) throw new SvgError(`serialized svg is ${bytes} bytes (max ${LIMITS.bytes})`);
  return { parts: out, elements: ctx.elements, bytes };
}

/** Convenience for tests: sanitize one fragment. */
export function sanitizeFragment(svg: string, idPrefix = ""): string {
  return sanitizeParts([{ id: "x", svg, pivot: [0, 0] }], idPrefix).parts[0]?.svg ?? "";
}
