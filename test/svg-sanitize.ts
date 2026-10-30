// Unit tests for the v2 sprite SVG sanitizer and sprite builder (no DB, no network).
//   node --disable-warning=ExperimentalWarning test/svg-sanitize.ts
import assert from "node:assert/strict";
import { sanitizeFragment, sanitizeParts, SvgError, LIMITS } from "../server/svg-sanitize.ts";
import { buildSprite, SpriteError, PRESETS, idPrefixFor } from "../server/avatar-gen.ts";

let passed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; } catch (e) { console.error(`FAIL ${name}`); throw e; }
};
const s = (svg: string, prefix = "") => sanitizeFragment(svg, prefix);
const throwsSvg = (svg: string) => assert.throws(() => s(svg), SvgError, svg.slice(0, 60));

// Whatever comes out must only ever contain allowlisted tags and attributes.
const OK_TAGS = new Set(["g", "path", "circle", "ellipse", "rect", "polygon", "polyline", "line", "linearGradient",
  "radialGradient", "stop", "defs"]);
const OK_ATTRS = new Set(["d", "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "y1", "x2", "y2", "fx", "fy", "width", "height",
  "points", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "fill-rule", "opacity", "fill-opacity",
  "stroke-opacity", "transform", "id", "offset", "stop-color", "stop-opacity", "gradientUnits", "gradientTransform", "spreadMethod"]);
function assertClean(out: string) {
  assert.ok(!/[&\\]|javascript|script|on[a-z]+=|href|style|data:|<!|<\?/i.test(out), `suspicious output: ${out}`);
  for (const m of out.matchAll(/<\/?([A-Za-z]+)([^>]*)>/g)) {
    assert.ok(OK_TAGS.has(m[1]), `tag ${m[1]}`);
    for (const a of m[2].matchAll(/([A-Za-z-]+)="([^"]*)"/g)) {
      assert.ok(OK_ATTRS.has(a[1]), `attr ${a[1]}`);
      const u = /url\(#([^)]*)\)/.exec(a[2]);
      if (a[2].includes("url(")) assert.ok(u, `url form ${a[2]}`);
    }
    // Every attribute must be of the form name="value" (nothing else inside the tag).
    assert.match(m[2], /^(\s[A-Za-z-]+="[^"<>&]*")*\/?$/, `tag body ${m[2]}`);
  }
}

test("keeps a normal drawing, re-serialized", () => {
  const out = s(`<g fill="#FFAA00" stroke="#1a1420" stroke-width="2"><circle cx="32" cy="30.123" r="12"/>
    <path d="M10,20 L 30 40 h5 v-5 C1 2 3 4 5 6 z" stroke-linecap="round"/><rect x="1" y="2" width="3" height="4" rx="1"/></g>`);
  assert.equal(out, `<g fill="#ffaa00" stroke="#1a1420" stroke-width="2"><circle cx="32" cy="30.12" r="12"/>` +
    `<path d="M 10 20 L 30 40 h 5 v -5 C 1 2 3 4 5 6 z" stroke-linecap="round"/><rect x="1" y="2" width="3" height="4" rx="1"/></g>`);
  assertClean(out);
});

test("drops script/style/foreignObject/image/use/text/a with their subtrees", () => {
  for (const bad of [
    `<script>alert(1)</script>`, `<script src="https://evil.example/x.js"/>`, `<style>*{background:url(https://x)}</style>`,
    `<foreignObject><div onclick="x">hi</div></foreignObject>`, `<image href="https://evil.example/a.png" width="9" height="9"/>`,
    `<use href="#a"/>`, `<text x="1" y="2">pwned</text>`, `<a href="javascript:alert(1)"><circle r="5"/></a>`,
    `<animate attributeName="fill" to="red"/>`, `<set attributeName="onload" to="alert(1)"/>`, `<filter id="f"/>`,
    `<SCRIPT>alert(1)</SCRIPT>`, `<svg:script>alert(1)</svg:script>`, `<iframe src="x"></iframe>`,
  ]) {
    const out = s(`<g>${bad}<circle cx="1" cy="1" r="1"/></g>`);
    assert.equal(out, `<g><circle cx="1" cy="1" r="1"/></g>`, bad);
  }
});

test("drops event handlers, href, style, class, xmlns and unknown attributes", () => {
  const out = s(`<circle r="3" onload="alert(1)" onclick='x' ONMOUSEOVER=y href="javascript:alert(1)" xlink:href="#x"
    style="fill:red" class="c" xmlns="http://www.w3.org/2000/svg" filter="url(#f)" mask="url(#m)" data-x="1"/>`);
  assert.equal(out, `<circle r="3"/>`);
});

test("rejects javascript:/external/data url() paints and keeps own gradient refs", () => {
  const out = s(`<defs><linearGradient id="glow"><stop offset="0" stop-color="#fff"/><stop offset="100%" stop-color="red"/></linearGradient></defs>
    <circle r="3" fill="url(#glow)" stroke="url(https://evil.example/x.svg#a)"/>
    <circle r="4" fill="url(javascript:alert(1))" stroke="url(#missing)"/>
    <circle r="5" fill="url( data:image/png;base64,AAAA )"/>
    <circle r="6" fill="url(#GLOW)"/>`, "p-1-");
  assert.equal(out, `<defs><linearGradient id="p-1-glow"><stop offset="0" stop-color="#fff"/><stop offset="100%" stop-color="red"/>` +
    `</linearGradient></defs><circle r="3" fill="url(#p-1-glow)"/><circle r="4"/><circle r="5"/><circle r="6"/>`);
  assertClean(out);
});

test("gradient ids: strict charset, namespaced, first wins, refs across parts", () => {
  const r = sanitizeParts([
    { id: "a", svg: `<defs><radialGradient id="g1" cx="50%" cy="50%" r="50%"><stop offset=".5" stop-color="gold"/></radialGradient>` +
      `<linearGradient id="bad id"><stop offset="0" stop-color="red"/></linearGradient>` +
      `<linearGradient id="g1"><stop offset="0" stop-color="blue"/></linearGradient></defs>`, pivot: [0, 0] },
    { id: "b", svg: `<rect width="4" height="4" fill="url(#g1)" id="notallowed"/>`, pivot: [1, 1] },
  ], "p-xy-");
  assert.equal(r.parts.length, 2);
  assert.equal(r.parts[0].svg, `<defs><radialGradient id="p-xy-g1" cx="50%" cy="50%" r="50%"><stop offset="0.5" stop-color="gold"/></radialGradient></defs>`);
  assert.equal(r.parts[1].svg, `<rect width="4" height="4" fill="url(#p-xy-g1)"/>`);
  assert.throws(() => sanitizeParts([], "Bad Prefix"), SvgError);
});

test("entities, CDATA, doctype, PI and comment tricks are rejected", () => {
  throwsSvg(`<!DOCTYPE svg [<!ENTITY x "<script>alert(1)</script>">]><g>&x;</g>`);
  throwsSvg(`<![CDATA[<script>alert(1)</script>]]>`);
  throwsSvg(`<?xml-stylesheet href="x"?><circle r="1"/>`);
  throwsSvg(`<g>&lt;script&gt;</g>`);
  throwsSvg(`<!-- unterminated <script>alert(1)</script>`);
  throwsSvg(`<!-- a -- b --><circle r="1"/>`);
  // Entities inside attribute values: attribute dropped, never decoded.
  assert.equal(s(`<circle r="1" fill="&#x6A;avascript:alert(1)" stroke="&#35;fff"/>`), `<circle r="1"/>`);
  // A plain comment is just dropped.
  assert.equal(s(`<!-- hi --><circle r="1"/>`), `<circle r="1"/>`);
});

test("malformed markup is rejected; unclosed elements are closed", () => {
  throwsSvg(`<circle r="1"`);
  throwsSvg(`<circle r="1 />`);
  throwsSvg(`<g><circle r="1"/></path>`);
  throwsSvg(`</g>`);
  throwsSvg(`<circle r="1"fill="red"/>`);
  throwsSvg(`<circle r="<script>"/>`);
  throwsSvg(`< script>alert(1)</script>`);
  throwsSvg(`<circle =x/>`);
  assert.equal(s(`<g><circle r="1"/>`), `<g><circle r="1"/></g>`);
  // Stray text is dropped.
  assert.equal(s(`hello <circle r="1"/> world`), `<circle r="1"/>`);
});

test("numbers are bounded and canonicalized", () => {
  assert.equal(s(`<circle r="1e308"/>`), "");
  assert.equal(s(`<circle cx="99999999" r="2"/>`), `<circle r="2"/>`);
  assert.equal(s(`<circle cx="NaN" cy="Infinity" r="2"/>`), `<circle r="2"/>`);
  assert.equal(s(`<circle cx="0x10" cy="1px" r="-2"/>`), "");
  assert.equal(s(`<circle cx="+1.23456" cy=".5" r="2e1"/>`), `<circle cx="1.23" cy="0.5" r="20"/>`);
  assert.equal(s(`<rect width="5" height="5" opacity="2" stroke-width="1000"/>`), `<rect width="5" height="5"/>`);
  assert.equal(s(`<path d="M0 0 L1e9 0"/>`), "");
  assert.equal(s(`<path d="M0 0 L ${"1 ".repeat(LIMITS.pathNumbers + 10)}"/>`), "");
});

test("path data grammar", () => {
  assert.equal(s(`<path d="m1-2l3.5.5zM0,0 A5 5 0 1 0 10 10a3,3,0,0,1,1,1"/>`),
    `<path d="m 1 -2 l 3.5 0.5 z M 0 0 A 5 5 0 1 0 10 10 a 3 3 0 0 1 1 1"/>`);
  assert.equal(s(`<path d="M0 0 a5 5 0 1110 10"/>`), `<path d="M 0 0 a 5 5 0 1 1 10 10"/>`);
  for (const bad of ["L0 0", "M0 0 X1 1", "M0 0 L1", "M0 0 L1 1 url(#x)", "M0 0 A5 5 0 2 0 1 1", "M0 0 A-5 5 0 1 0 1 1", "M"]) {
    assert.equal(s(`<path d="${bad}"/>`), "", bad);
  }
});

test("transforms: only numeric matrix/translate/scale/rotate/skewX/skewY", () => {
  assert.equal(s(`<g transform="translate(3,4) rotate(45 32 32) scale(2)  skewX(10)"><circle r="1"/></g>`),
    `<g transform="translate(3 4) rotate(45 32 32) scale(2) skewX(10)"><circle r="1"/></g>`);
  for (const bad of ["translate(url(#x))", "perspective(2)", "rotate(1 2)", "matrix(1,2,3)", "translate(1) ;x", "expression(alert(1))",
    "translate(1)garbage", "constructor(1)", "__proto__(1)"]) {
    assert.equal(s(`<g transform="${bad}"><circle r="1"/></g>`), `<g><circle r="1"/></g>`, bad);
  }
});

test("colors", () => {
  assert.equal(s(`<circle r="1" fill="RGB(10, 20 ,300)" stroke="rgba(1,2,3,0.5)"/>`), `<circle r="1" stroke="rgba(1,2,3,0.5)"/>`);
  assert.equal(s(`<circle r="1" fill="CurrentColor" stroke="None"/>`), `<circle r="1" fill="currentColor" stroke="none"/>`);
  assert.equal(s(`<circle r="1" fill="#abcg" stroke="hsl(1,2%,3%)"/>`), `<circle r="1"/>`);
  assert.equal(s(`<circle r="1" fill="rebeccapurple" stroke="expression(alert(1))"/>`), `<circle r="1"/>`);
  assert.equal(s(`<circle r="1" fill="rgb(50%,0%,100%)"/>`), `<circle r="1" fill="rgb(128,0,255)"/>`);
});

test("content model: stops only in gradients, shapes have no children, empty g dropped", () => {
  assert.equal(s(`<stop offset="0" stop-color="red"/><circle r="1"><script/><rect width="1" height="1"/></circle><g></g>`),
    `<circle r="1"/>`);
  assert.equal(s(`<linearGradient id="a"><circle r="1"/><stop offset="0" stop-color="red"/></linearGradient>`),
    `<linearGradient id="a"><stop offset="0" stop-color="red"/></linearGradient>`);
  assert.equal(s(`<linearGradient><stop offset="0" stop-color="red"/></linearGradient>`), ""); // no id: useless
  // An <svg> wrapper is unwrapped (its attributes ignored).
  assert.equal(s(`<svg onload="alert(1)" viewBox="0 0 64 64"><circle r="1"/></svg>`), `<circle r="1"/>`);
});

test("caps: parts, elements, bytes, depth", () => {
  assert.throws(() => sanitizeParts(Array.from({ length: LIMITS.parts + 1 }, (_, k) => ({ id: `p${k}`, svg: `<circle r="1"/>`, pivot: [0, 0] as [number, number] }))), SvgError);
  assert.throws(() => s(`<circle r="1"/>`.repeat(LIMITS.elements + 1)), /elements/);
  const big = `<path d="M0 0 ${"L 123.45 678.9 ".repeat(250)}"/>`; // ~4 KB each after serialization
  assert.throws(() => s(big.repeat(7)), /bytes/);
  assert.throws(() => s("x".repeat(LIMITS.inputBytes + 1)), /too large/);
  let deep = `<circle r="1"/>`;
  for (let k = 0; k < 12; k++) deep = `<g>${deep}</g>`;
  assert.equal(s(deep), ""); // beyond max depth everything collapses into empty groups, which are dropped
});

test("fuzz: random tag soup never yields anything outside the allowlist", () => {
  const bits = ["<", ">", "/", "=", '"', "'", " ", "g", "circle", "script", "r", "1", "on", "load", "href", "&", "#", "url(", ")",
    "<!--", "-->", "<![CDATA[", "javascript:", "fill", "path", "d", "M0 0", "style", "\n", "</g>", "<g>", '<circle r="2"/>'];
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let k = 0; k < 4000; k++) {
    let src = "";
    const len = 1 + Math.floor(rnd() * 40);
    for (let j = 0; j < len; j++) src += bits[Math.floor(rnd() * bits.length)];
    let out: string;
    try { out = s(src); } catch (e) { assert.ok(e instanceof SvgError, String(e)); continue; }
    assertClean(out);
    // Output must be a fixed point.
    assert.equal(s(out), out);
  }
});

test("fuzz: well-formed elements with hostile attributes", () => {
  const tags = ["g", "circle", "path", "rect", "script", "image", "use", "linearGradient", "stop", "defs", "a", "svg", "text"];
  const names = ["r", "cx", "d", "fill", "stroke", "onload", "href", "xlink:href", "style", "transform", "id", "offset", "points", "width", "height"];
  const vals = ["1", "-3.5", "1e999", "#fff", "red", "url(#a)", "url(#A)", "url(http://x/#a)", "javascript:alert(1)", "M0 0L5 5z",
    "translate(1 2)", "rotate(x)", "a", "&quot;", "expression(1)", "0 0 5 5", "50%", "&#106;", "rgb(1,2,3)"];
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
  const el = (depth: number): string => {
    const t = pick(tags);
    let attrs = "";
    for (let k = Math.floor(rnd() * 4); k > 0; k--) attrs += ` ${pick(names)}="${pick(vals)}"`;
    if (depth > 3 || rnd() < 0.5) return `<${t}${attrs}/>`;
    let kids = "";
    for (let k = Math.floor(rnd() * 3); k > 0; k--) kids += el(depth + 1);
    return `<${t}${attrs}>${kids}</${t}>`;
  };
  let nonEmpty = 0;
  for (let k = 0; k < 3000; k++) {
    let out: string;
    try { out = s(el(0) + el(0), "p-q-"); } catch (e) { assert.ok(e instanceof SvgError, String(e)); continue; }
    if (out) nonEmpty++;
    assertClean(out);
    for (const m of out.matchAll(/url\(#([^)]*)\)/g)) assert.ok(m[1].startsWith("p-q-"), out);
    for (const m of out.matchAll(/ id="([^"]*)"/g)) assert.ok(m[1].startsWith("p-q-"), out);
  }
  assert.ok(nonEmpty > 500, `fuzz produced only ${nonEmpty} non-empty outputs`);
});

// ---------------------------------------------------------------- buildSprite

const goodRaw = () => ({
  style: "flat vector",
  parts: [
    { id: "Body", svg: `<ellipse cx="32" cy="44" rx="16" ry="14" fill="#7bd389" stroke="#1a1420" stroke-width="2"/>`, pivot: [32, 58] },
    { id: "arm", svg: `<path d="M16 40 L8 30" stroke="#7bd389" stroke-width="4"/>`, pivot: [16, 40] },
    { id: "eyes", svg: `<circle cx="27" cy="40" r="2" fill="#fff"/><circle cx="37" cy="40" r="2" fill="#fff"/>`, pivot: [32, 40] },
  ],
  anim: {
    idle: [{ part: "*", type: "bob", amp: 0.8, period: 2, phase: 0 }, { part: "eyes", type: "blink", amp: 1, period: 4, phase: 0 }],
    working: [{ part: "Body", type: "bob", amp: 2, period: 0.4, phase: 0 }, { part: "arm", type: "wiggle", amp: 20, period: 0.3, phase: 0.5 }],
    thinking: [{ part: "*", type: "sway", amp: 8, period: 2.5, phase: 0 }],
    sleeping: [],
  },
  locomotion: "hop",
  ground: 59,
  facing: "front",
});

test("buildSprite: valid sprite passes through cleaned", () => {
  const sp = buildSprite(goodRaw(), { idPrefix: idPrefixFor("p_ab12cd"), allowFallback: false });
  assert.equal(sp.v, 2);
  assert.equal(sp.viewBox, "0 0 64 64");
  assert.deepEqual(sp.parts.map((p) => p.id), ["body", "arm", "eyes"]);
  assert.equal(sp.anim.working[0].part, "body"); // mapped from "Body"
  assert.equal(sp.anim.working[1].phase, 0.5);
  assert.equal(sp.anim.idle[1].amp, 0); // blink amp is ignored
  assert.deepEqual(sp.anim.sleeping, PRESETS.sleeping); // empty sleeping gets the breathing preset
  assert.equal(sp.locomotion, "hop");
  assert.equal(sp.ground, 59);
  assert.equal(idPrefixFor("p_ab12cd"), "p-ab12cd-");
});

test("buildSprite: clamps and filters animations", () => {
  const raw: any = goodRaw();
  raw.anim.working = [
    { part: "ghost", type: "bob", amp: 3, period: 0.4 }, // unknown part
    { part: "arm", type: "explode", amp: 3, period: 0.4 }, // unknown type
    { part: "arm", type: "sway", amp: 9999, period: -5, phase: 7 }, // clamped
  ];
  const sp = buildSprite(raw, { allowFallback: false });
  assert.deepEqual(sp.anim.working, [{ part: "arm", type: "sway", amp: 45, period: 0.2 }]);
  raw.locomotion = "teleport"; raw.facing = "up"; raw.ground = 1e9; raw.style = `<script>"x"</script>`;
  const sp2 = buildSprite(raw);
  assert.equal(sp2.locomotion, "walk");
  assert.equal(sp2.facing, "front");
  assert.equal(sp2.ground, 64);
  assert.ok(!/[<>"]/.test(sp2.style));
});

test("buildSprite: invisible working/thinking -> reject on first try, presets on retry", () => {
  const raw: any = goodRaw();
  raw.anim.working = [{ part: "eyes", type: "blink", amp: 1, period: 3 }];
  raw.anim.thinking = raw.anim.idle; // same as idle
  assert.throws(() => buildSprite(raw, { allowFallback: false }), SpriteError);
  const sp = buildSprite(raw, { allowFallback: true });
  assert.deepEqual(sp.anim.working, PRESETS.working);
  assert.deepEqual(sp.anim.thinking, PRESETS.thinking);
});

test("buildSprite: structural failures", () => {
  assert.throws(() => buildSprite(null), SpriteError);
  assert.throws(() => buildSprite({ ...goodRaw(), parts: [] }), SpriteError);
  assert.throws(() => buildSprite({ ...goodRaw(), parts: [{ id: "a", svg: "<script>alert(1)</script>", pivot: [0, 0] }] }), SpriteError);
  assert.throws(() => buildSprite({ ...goodRaw(), parts: [{ id: "a", svg: "<circle r='1'", pivot: [0, 0] }] }), /svg:/);
  // Duplicate / weird part ids get unique safe ids.
  const raw: any = goodRaw();
  raw.parts[1].id = "Body"; raw.parts[2].id = "<x>";
  const sp = buildSprite(raw);
  assert.deepEqual(sp.parts.map((p) => p.id), ["body", "body-2", "x"]);
});

console.log(`svg-sanitize: ${passed} tests passed`);
