// Shared palette and small pixel-art helpers for the town and the home interiors.

export const PAL = {
  grass: "#1f3b33", grass2: "#24453a", grass3: "#193128", flower: "#e8a0b4", flower2: "#f2d27a",
  road: "#2c2a3d", roadLine: "#4a4662", walk: "#3a3650",
  tree: "#1c4a3a", tree2: "#2a5e48", treeDark: "#123227", trunk: "#4a3328",
  winDark: "#1c2140", winDark2: "#2a3160", winLit: "#ffd27a", winLit2: "#fff1c2", outline: "#140f1c",
  lamp: "#ffcf6e", smoke: "#c9c2d8",
};

export function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v) => Math.max(0, Math.min(255, Math.round(f < 0 ? v * (1 + f) : v + (255 - v) * f)));
  return "#" + ((1 << 24) | (ch(n >> 16) << 16) | (ch((n >> 8) & 255) << 8) | ch(n & 255)).toString(16).slice(1);
}

export function drawTree(ctx, x, y, s) {
  // x,y = top-left in art px; s = scale (device px per art px); ctx in device px
  const P = (dx, dy, w, h, col) => { ctx.fillStyle = col; ctx.fillRect(x + dx * s, y + dy * s, w * s, h * s); };
  P(5, 12, 3, 5, PAL.trunk);
  P(1, 2, 11, 11, PAL.outline);
  P(2, 1, 9, 13, PAL.outline);
  P(2, 3, 9, 9, PAL.tree);
  P(3, 2, 7, 11, PAL.tree);
  P(3, 3, 4, 3, PAL.tree2);
  P(8, 9, 2, 2, PAL.treeDark);
}
