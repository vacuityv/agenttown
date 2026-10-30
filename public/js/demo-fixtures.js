// Dev-only fixtures for features the server may not ship yet (used by /?demo=…). Hand-written examples of
// Claude-generated dwelling art v1, so the art renderer can be tested end to end.
const INK = "#2b2230";

export const ART_FIXTURES = [
  { // a mushroom cottage, seen from above with its cap lifted
    v: 1, viewBox: "0 0 160 120",
    footprint: [[80, 6], [122, 18], [140, 56], [128, 96], [92, 116], [56, 114], [24, 92], [18, 54], [38, 18]],
    layers: [
      { id: "ground", svg: `<ellipse cx="80" cy="62" rx="68" ry="56" fill="#3d5a44"/><ellipse cx="80" cy="62" rx="62" ry="50" fill="#4a6b50"/>` +
        [[30, 30], [128, 34], [24, 88], [134, 92], [80, 112]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3" fill="#f2d27a"/><circle cx="${x + 5}" cy="${y + 2}" r="2.4" fill="#e8a0b4"/>`).join("") },
      { id: "structure", svg: `<ellipse cx="80" cy="62" rx="52" ry="44" fill="#f1e2c4" stroke="${INK}" stroke-width="3"/>` +
        `<ellipse cx="80" cy="62" rx="46" ry="38" fill="#d9b88a"/>` +
        Array.from({ length: 9 }, (_, i) => `<line x1="${38 + i * 10}" y1="28" x2="${38 + i * 10}" y2="96" stroke="#c9a676" stroke-width="1"/>`).join("") +
        `<path d="M36 52 A46 38 0 0 1 60 28 L64 36 A38 30 0 0 0 44 56 Z" fill="#7a5038" stroke="${INK}"/>` +
        [40, 46, 52, 58].map((x, i) => `<rect x="${x}" y="${44 - i * 4}" width="4" height="6" fill="${["#d9534f", "#5fa8d3", "#f2cc8f", "#81b29a"][i]}"/>`).join("") +
        `<ellipse cx="80" cy="50" rx="16" ry="7" fill="#8a5d3f" stroke="${INK}"/><rect x="66" y="45" width="8" height="5" rx="1" fill="#c9cbd6"/><rect x="86" y="45" width="8" height="5" rx="1" fill="#c9cbd6"/>` +
        `<rect x="108" y="64" width="18" height="10" rx="2" fill="#4a4a5a" stroke="${INK}"/><rect x="111" y="66" width="12" height="5" fill="#0f2a1a"/><rect x="112" y="67" width="6" height="1.5" fill="#7fd36b"/>` +
        `<path d="M44 92 q8 -10 18 0 z" fill="#b0634a" stroke="${INK}"/><path d="M98 92 q8 -10 18 0 z" fill="#5f8fc0" stroke="${INK}"/>` +
        `<rect x="62" y="80" width="36" height="10" rx="5" fill="#c97b3a" stroke="${INK}"/>` +
        `<rect x="30" y="70" width="10" height="8" rx="2" fill="#8a5d3f" stroke="${INK}"/><circle cx="35" cy="69" r="2" fill="#c9a86a"/>` +
        `<rect x="104" y="36" width="12" height="10" rx="1.5" fill="#a8783a" stroke="${INK}"/>` +
        `<path d="M74 102 h12 v6 h-12 z" fill="#6b4a35" stroke="${INK}"/>` },
      { id: "decor", svg: `<circle cx="40" cy="34" r="3" fill="#ffd27a"/><circle cx="122" cy="40" r="3" fill="#ffd27a"/><circle cx="80" cy="16" r="2.5" fill="#ffd27a"/>` },
      { id: "roof", optional: true, svg: `<ellipse cx="80" cy="60" rx="60" ry="50" fill="#c8453a" stroke="${INK}" stroke-width="3"/>` +
        [[60, 40, 8], [98, 34, 6], [110, 64, 9], [64, 74, 7], [86, 88, 5], [42, 60, 5]].map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="#f6efe2"/>`).join("") },
    ],
    anim: [{ layer: "decor", type: "pulse", amp: 12, period: 1.8, pivot: [80, 40] }],
    spots: { door: [80, 100], desk: [[70, 44], [90, 44]], terminal: [117, 80], books: [52, 58], write: [80, 70], web: [36, 84], mcp: [110, 52], agent: [96, 60],
      rest: [[72, 94], [88, 94]], bed: [[52, 88], [106, 88]] },
  },
  { // a lighthouse keeper's home on a rock
    v: 1, viewBox: "0 0 160 120",
    footprint: [[30, 20], [96, 10], [140, 40], [146, 88], [110, 114], [50, 112], [16, 80]],
    layers: [
      { id: "ground", svg: `<path d="M20 60 C14 26 60 6 100 10 C140 16 152 52 146 84 C140 112 90 120 56 114 C24 108 22 86 20 60 Z" fill="#6e6878" stroke="#4a4652" stroke-width="3"/>` +
        `<path d="M30 60 C28 34 64 18 98 20 C130 26 140 54 136 80 C130 102 92 108 60 104 C36 100 32 84 30 60 Z" fill="#8a8494"/>` },
      { id: "structure", svg: `<circle cx="102" cy="52" r="30" fill="#f0ece4" stroke="${INK}" stroke-width="3"/><circle cx="102" cy="52" r="25" fill="#c9b89a"/>` +
        Array.from({ length: 8 }, (_, i) => `<line x1="102" y1="52" x2="${102 + 25 * Math.cos(i * 0.785)}" y2="${52 + 25 * Math.sin(i * 0.785)}" stroke="#b5a487" stroke-width="1"/>`).join("") +
        `<circle cx="102" cy="52" r="7" fill="#7a6a5a" stroke="${INK}"/>` +
        `<rect x="34" y="50" width="52" height="46" rx="4" fill="#e8e0d0" stroke="${INK}" stroke-width="3"/><rect x="38" y="54" width="44" height="38" fill="#a8845a"/>` +
        `<rect x="40" y="56" width="16" height="7" fill="#8a5d3f" stroke="${INK}"/><rect x="44" y="57" width="7" height="4" fill="#c9cbd6"/>` +
        `<rect x="62" y="56" width="16" height="6" fill="#6b4430" stroke="${INK}"/><rect x="40" y="76" width="9" height="14" fill="#5fa8d3" stroke="${INK}"/>` +
        `<rect x="56" y="80" width="20" height="8" rx="3" fill="#2f7f7a" stroke="${INK}"/>` +
        `<rect x="112" y="66" width="10" height="6" fill="#4a4a5a" stroke="${INK}"/><rect x="88" y="34" width="10" height="8" fill="#a8783a" stroke="${INK}"/>` +
        `<path d="M54 96 h12 v8 h-12 z" fill="#6b4a35" stroke="${INK}"/>` },
      { id: "decor", svg: `<path d="M102 52 L150 36 L150 68 Z" fill="#ffe9a8" opacity="0.35"/><circle cx="102" cy="52" r="5" fill="#ffd27a"/>` },
      { id: "roof", optional: true, svg: `<circle cx="102" cy="52" r="31" fill="#d9534f" stroke="${INK}" stroke-width="3"/><circle cx="102" cy="52" r="20" fill="#f0ece4"/><circle cx="102" cy="52" r="9" fill="#d9534f"/><rect x="32" y="48" width="56" height="50" rx="4" fill="#5a6a8a" stroke="${INK}" stroke-width="3"/>` },
    ],
    anim: [{ layer: "decor", type: "spin", amp: 0, period: 6, pivot: [102, 52] }],
    spots: { door: [60, 100], desk: [[48, 68], [70, 68]], terminal: [116, 76], books: [68, 66], write: [92, 64], web: [44, 88], mcp: [92, 46],
      rest: [[66, 92], [74, 92]], bed: [[44, 82], [110, 60]] },
  },
];

const eye = (x, y) => `<circle cx="${x}" cy="${y}" r="2.6" fill="${INK}"/><circle cx="${x + 0.9}" cy="${y - 1}" r="0.9" fill="#fff"/>`;
// v2 sprite fixtures, keyed by persona name (applied client-side with /?demo=sprites)
export const SPRITE_FIXTURES = {
  "橘子": { // orange cat
    v: 2, viewBox: "0 0 64 64", ground: 60, facing: "right", locomotion: "walk",
    parts: [
      { id: "tail", pivot: [44, 50], svg: `<path d="M44 50 C58 50 60 34 54 28" fill="none" stroke="#d97a2a" stroke-width="6" stroke-linecap="round"/><path d="M54 28 l2 -4" stroke="#fff8ec" stroke-width="5" stroke-linecap="round"/>` },
      { id: "body", pivot: [32, 60], svg: `<ellipse cx="32" cy="48" rx="16" ry="11" fill="#f2a04a" stroke="${INK}" stroke-width="2"/><path d="M24 40 l3 8 M32 38 l0 8 M40 40 l-3 8" stroke="#d97a2a" stroke-width="2"/><rect x="20" y="55" width="6" height="5" rx="2" fill="#fff8ec" stroke="${INK}" stroke-width="1.5"/><rect x="38" y="55" width="6" height="5" rx="2" fill="#fff8ec" stroke="${INK}" stroke-width="1.5"/>` },
      { id: "head", pivot: [30, 36], svg: `<path d="M18 22 L16 8 L26 16 Z M42 22 L44 8 L34 16 Z" fill="#f2a04a" stroke="${INK}" stroke-width="2"/><circle cx="30" cy="26" r="13" fill="#f2a04a" stroke="${INK}" stroke-width="2"/>${eye(25, 25)}${eye(35, 25)}<path d="M28 31 q2 2 4 0" fill="none" stroke="${INK}" stroke-width="1.5"/><path d="M14 28 h6 M14 31 h6 M40 28 h6 M40 31 h6" stroke="${INK}" stroke-width="1"/>` },
    ],
    anim: {
      idle: [{ part: "tail", type: "sway", amp: 14, period: 1.6 }, { part: "head", type: "blink", amp: 1, period: 3.5 }],
      working: [{ part: "tail", type: "sway", amp: 24, period: 0.5 }, { part: "head", type: "bob", amp: 1, period: 0.3 }],
      thinking: [{ part: "head", type: "sway", amp: 10, period: 2.4 }],
      sleeping: [{ part: "body", type: "pulse", amp: 3, period: 2.6 }, { part: "tail", type: "sway", amp: 4, period: 4 }],
    },
  },
  "Hoot": { // owl
    v: 2, viewBox: "0 0 64 64", ground: 60, facing: "front", locomotion: "waddle",
    parts: [
      { id: "wingL", pivot: [18, 34], svg: `<path d="M18 30 C8 36 8 50 14 54 C18 48 20 40 20 34 Z" fill="#6b4f3a" stroke="${INK}" stroke-width="2"/>` },
      { id: "wingR", pivot: [46, 34], svg: `<path d="M46 30 C56 36 56 50 50 54 C46 48 44 40 44 34 Z" fill="#6b4f3a" stroke="${INK}" stroke-width="2"/>` },
      { id: "body", pivot: [32, 60], svg: `<ellipse cx="32" cy="38" rx="16" ry="21" fill="#8a6a4a" stroke="${INK}" stroke-width="2"/><ellipse cx="32" cy="45" rx="10" ry="12" fill="#e8d8b8"/><path d="M27 42 l2 2 l2 -2 M33 46 l2 2 l2 -2 M27 50 l2 2 l2 -2" stroke="#a88a6a" fill="none"/><path d="M26 58 h4 M34 58 h4" stroke="#e8913a" stroke-width="3"/>` },
      { id: "face", pivot: [32, 26], svg: `<circle cx="25" cy="26" r="7" fill="#fff8ec" stroke="${INK}" stroke-width="2"/><circle cx="39" cy="26" r="7" fill="#fff8ec" stroke="${INK}" stroke-width="2"/><circle cx="25" cy="26" r="3.5" fill="${INK}"/><circle cx="39" cy="26" r="3.5" fill="${INK}"/><path d="M30 31 L34 31 L32 35 Z" fill="#e8913a"/><path d="M18 18 L22 12 L26 18 M38 18 L42 12 L46 18" fill="#8a6a4a" stroke="${INK}" stroke-width="2"/>` },
    ],
    anim: {
      idle: [{ part: "face", type: "blink", amp: 1, period: 2.8 }, { part: "wingL", type: "sway", amp: 4, period: 2 }, { part: "wingR", type: "sway", amp: -4, period: 2 }],
      working: [{ part: "wingL", type: "flap", amp: 50, period: 0.3 }, { part: "wingR", type: "flap", amp: 50, period: 0.3 }],
      thinking: [{ part: "face", type: "sway", amp: 18, period: 2.2 }],
    },
  },
  "Ember": { // little flame spirit
    v: 2, viewBox: "0 0 64 64", ground: 60, facing: "front", locomotion: "float",
    parts: [
      { id: "outer", pivot: [32, 56], svg: `<path d="M32 4 C40 18 52 26 50 42 C48 54 40 60 32 60 C24 60 16 54 14 42 C12 30 26 22 32 4 Z" fill="#ff7a3a" stroke="${INK}" stroke-width="2"/>` },
      { id: "inner", pivot: [32, 56], svg: `<path d="M32 20 C37 30 44 36 42 46 C40 54 36 56 32 56 C28 56 24 54 22 46 C21 38 29 32 32 20 Z" fill="#ffd27a"/>` },
      { id: "face", pivot: [32, 44], svg: `${eye(27, 43)}${eye(37, 43)}<path d="M30 49 q2 2 4 0" fill="none" stroke="${INK}" stroke-width="1.6"/>` },
    ],
    anim: {
      idle: [{ part: "outer", type: "sway", amp: 5, period: 0.9 }, { part: "inner", type: "pulse", amp: 6, period: 0.7 }, { part: "face", type: "blink", amp: 1, period: 3 }],
      working: [{ part: "outer", type: "wiggle", amp: 6, period: 0.6 }, { part: "inner", type: "pulse", amp: 12, period: 0.3 }],
      thinking: [{ part: "outer", type: "sway", amp: 10, period: 2 }],
      sleeping: [{ part: "inner", type: "pulse", amp: -20, period: 3 }],
    },
  },
  "Pixel": { // cube robot that rolls
    v: 2, viewBox: "0 0 64 64", ground: 60, facing: "front", locomotion: "roll",
    parts: [
      { id: "body", pivot: [32, 40], svg: `<rect x="14" y="22" width="36" height="36" rx="6" fill="#7ec8e3" stroke="${INK}" stroke-width="2.2"/><rect x="20" y="30" width="24" height="14" rx="3" fill="${INK}"/><rect x="24" y="34" width="5" height="5" fill="#7fd36b"/><rect x="35" y="34" width="5" height="5" fill="#7fd36b"/><rect x="22" y="49" width="20" height="3" rx="1.5" fill="#4a8ab0"/>` },
      { id: "antenna", pivot: [32, 22], svg: `<line x1="32" y1="22" x2="32" y2="12" stroke="${INK}" stroke-width="2"/><circle cx="32" cy="10" r="3" fill="#ff6b5b" stroke="${INK}" stroke-width="2"/>` },
    ],
    anim: {
      idle: [{ part: "antenna", type: "sway", amp: 15, period: 1.8 }],
      working: [{ part: "antenna", type: "spin", amp: 0, period: 0.7 }, { part: "body", type: "shake", amp: 0.8, period: 0.25 }],
      thinking: [{ part: "body", type: "sway", amp: 6, period: 2 }],
    },
  },
};

