// UI seeder: registers a few homes and keeps their agents busy forever so the web UI has something moving.
//   BASE=http://localhost:8790 node test/seed-ui.ts
// Keys are kept in data/seed-ui.json so re-runs reuse the same homes (registration is rate limited).
import { createHash, createHmac, createCipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const BASE = (process.env.BASE ?? "http://localhost:8790").replace(/\/$/, "");
const STATE = process.env.SEED_STATE ?? "data/seed-ui.json";

type Home = { name: string; owner_key: string; home_id?: string };
const PLAN: { name: string; agents: { name: string; kind: string; appearance?: string }[]; activity: number }[] = [
  { name: "Maple Lane Studio", activity: 0.9, agents: [
    { name: "Claude", kind: "claude-code" }, { name: "Codex", kind: "codex" },
    { name: "Ada", kind: "claude-code" }, { name: "Linus", kind: "codex" }, { name: "Grace", kind: "claude-code" },
  ] },
  { name: "小橘的家", activity: 0.6, agents: [{ name: "橘子", kind: "claude-code" }, { name: "Mochi", kind: "codex" }] },
  { name: "Night Owl Lab", activity: 0.5, agents: [{ name: "Hoot", kind: "claude-code" }, { name: "Ember", kind: "other" }, { name: "Pixel", kind: "codex" }] },
  { name: "Sleepy Cottage", activity: 0, agents: [{ name: "Dozy", kind: "claude-code" }, { name: "Snooze", kind: "codex" }] },
  { name: "<b>Tiny</b> & \"Quoted\"", activity: 0.2, agents: [{ name: "<img src=x>", kind: "claude-code" }] },
];

const TITLES = [
  "Fix flaky login test", "Refactor billing webhooks", "Add dark mode to settings", "Write migration for orders table",
  "Investigate memory leak in worker", "Port CLI to Node 22", "Review PR #418", "重构用户权限模块", "给首页加骨架屏",
  "Upgrade React to 19", "Draft release notes v2.3", "Speed up CI cache", "Tune SQLite indexes", "Polish pixel sprites",
];
const TOOLS = ["Bash", "Read", "Edit", "Write", "Grep", "Glob", "WebFetch", "Task", "TodoWrite", "mcp__github__search", "apply_patch"];

const b64url = (b: Buffer) => b.toString("base64url");
const authToken = (k: string) => createHmac("sha256", k).update("agenttown/auth/v1").digest("hex");
const encKey = (k: string) => createHmac("sha256", k).update("agenttown/enc/v1").digest();

function encryptTitle(ownerKey: string, title: string): string {
  let bytes = Buffer.from(title, "utf8");
  if (bytes.length > 480) {
    let cut = 480;
    while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut--;
    bytes = bytes.subarray(0, cut);
  }
  const padded = Buffer.alloc(Math.ceil((bytes.length + 1) / 32) * 32);
  bytes.copy(padded);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", encKey(ownerKey), iv);
  const ct = Buffer.concat([c.update(padded), c.final(), c.getAuthTag()]);
  return `v1.${b64url(iv)}.${b64url(ct)}`;
}

async function api(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(BASE + "/v1" + path, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: { "content-type": "application/json", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} ${res.status} ${json.error ?? ""} ${json.message ?? ""}`);
  return json;
}

function zeroBits(buf: Buffer) {
  let n = 0;
  for (const b of buf) { if (b === 0) { n += 8; continue; } return n + Math.clz32(b) - 24; }
  return n;
}

async function register(name: string): Promise<Home> {
  const owner_key = "atk_" + b64url(randomBytes(32));
  const { challenge, difficulty } = await api("/register/challenge");
  let nonce = 0;
  while (zeroBits(createHash("sha256").update(`${challenge}:${nonce}`).digest()) < difficulty) nonce++;
  const r = await api("/register", { body: { challenge, nonce: String(nonce), auth_token: authToken(owner_key), home_name: name } });
  return { name, owner_key, home_id: r.home.id };
}

async function loadHomes(): Promise<Home[]> {
  let saved: Home[] = [];
  if (existsSync(STATE)) saved = JSON.parse(readFileSync(STATE, "utf8"));
  const out: Home[] = [];
  for (const p of PLAN) {
    let h = saved.find((s) => s.name === p.name);
    if (h) {
      try { h.home_id = (await api("/me", { token: authToken(h.owner_key) })).home.id; }
      catch { h = undefined; } // db was wiped
    }
    if (!h) h = await register(p.name);
    out.push(h);
  }
  mkdirSync(STATE.replace(/\/[^/]*$/, "") || ".", { recursive: true });
  writeFileSync(STATE, JSON.stringify(out, null, 2), { mode: 0o600 });
  return out;
}


// ---- v2 sprite fixtures (dev only) ----
// There is no public endpoint to set a sprite (the server generates them from `appearance`), so for UI testing
// the seeder writes these straight into the dev database. Disable with SEED_SPRITES=0.
const INK = "#241a2b";
const eye = (x: number, y: number) => `<circle cx="${x}" cy="${y}" r="2.6" fill="${INK}"/><circle cx="${x + 0.9}" cy="${y - 1}" r="0.9" fill="#fff"/>`;
const V2_FIXTURES: Record<string, unknown> = {
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

function seedSprites(homes: Home[]) {
  if (process.env.SEED_SPRITES === "0") return;
  const dbPath = process.env.DB_PATH ?? "data/dev.db";
  if (!existsSync(dbPath)) return;
  try {
    const db = new DatabaseSync(dbPath);
    const st = db.prepare("UPDATE personas SET sprite = ?, sprite_status = 'ready' WHERE home_id = ? AND name = ?");
    for (const h of homes) for (const [name, sprite] of Object.entries(V2_FIXTURES)) st.run(JSON.stringify(sprite), h.home_id!, name);
    db.close();
    console.log(`  (dev) wrote ${Object.keys(V2_FIXTURES).length} v2 fixture sprites into ${dbPath}`);
  } catch (e) { console.warn("  (dev) could not write fixture sprites:", String(e)); }
}

const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const chance = (p: number) => Math.random() < p;
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const sec = (a: number, b: number) => Date.now() + rand(a, b) * 1000;

// Weighted tool mix: every activity spot in the home gets visitors.
const TOOL_MIX = ["Bash", "Bash", "Read", "Read", "Grep", "Glob", "Edit", "Edit", "Write", "MultiEdit",
  "WebSearch", "WebFetch", "mcp__github__search", "mcp__linear__issues", "Task", "TodoWrite", "apply_patch"];

type Sub = { key: string; until: number; next: number };
type Agent = {
  persona: { name: string; kind: string }; base: string; gen: number;
  open: boolean; next: number; napper: boolean; subs: Sub[];
};

async function main() {
  const homes = await loadHomes();
  console.log(`\nSeeding ${BASE}\n`);
  for (const h of homes) console.log(`  ${h.name.padEnd(24)} ${BASE}/h/${h.home_id}\n    owner_key: ${h.owner_key}`);
  console.log("");

  const sims = homes.map((h, i) => {
    const plan = PLAN[i];
    const token = authToken(h.owner_key);
    const agents: Agent[] = plan.agents.map((a, j) => ({
      persona: a, base: `seed-${i}-${j}`, gen: Math.floor(Date.now() / 1000), open: false,
      next: sec(0, 8), napper: j % 3 === 1, subs: [],
    }));
    return { h, plan, token, agents };
  });

  for (const s of sims) {
    for (const a of s.plan.agents) {
      try { await api("/personas", { token: s.token, body: { name: a.name, kind: a.kind } }); } catch (e) { console.warn(String(e)); }
    }
  }

  seedSprites(homes);

  const report = (s: (typeof sims)[number], body: any) =>
    api("/report", { token: s.token, body }).catch((e) => console.warn(s.h.name, String(e)));

  for (;;) {
    const now = Date.now();
    for (const s of sims) {
      if (s.plan.activity <= 0) continue; // residents who never wake up
      for (const a of s.agents) {
        const sess = `${a.base}-${a.gen}`;
        // subagents: busy for a while, then they finish
        for (const sub of a.subs) {
          if (now >= sub.until) { await report(s, { persona: a.persona, session: sub.key, parent: sess, status: "ended" }); sub.until = 0; continue; }
          if (now >= sub.next) {
            sub.next = sec(3, 7);
            await report(s, { persona: a.persona, session: sub.key, parent: sess, ...(chance(0.3) ? { status: "thinking" } : { status: "tool", tool: pick(TOOL_MIX.filter((t) => t !== "Task")) }) });
          }
        }
        a.subs = a.subs.filter((x) => x.until > 0);
        if (now < a.next) continue;

        if (!a.open) {
          if (chance(s.plan.activity)) {
            a.open = true; a.gen++;
            await report(s, { persona: a.persona, session: `${a.base}-${a.gen}`, status: "thinking",
              task: { title_enc: encryptTitle(s.h.owner_key, pick(TITLES)) } });
            a.next = sec(3, 7);
          } else a.next = sec(20, 60);
          continue;
        }
        const r = Math.random();
        if (r < 0.025) {                       // done for now
          for (const sub of a.subs) await report(s, { persona: a.persona, session: sub.key, parent: sess, status: "ended" });
          a.subs = [];
          await report(s, { persona: a.persona, session: sess, status: "ended" });
          a.open = false; a.next = sec(30, 120);
        } else if (r < 0.06 && a.napper) {      // long nap: idle, then silent > 3 min (shows up in bed)
          await report(s, { persona: a.persona, session: sess, status: "idle" });
          a.next = sec(200, 280);
        } else if (r < 0.12) {                 // needs the human
          await report(s, { persona: a.persona, session: sess, status: "waiting" });
          a.next = sec(12, 30);
        } else if (r < 0.2) {                  // short rest on the sofa
          await report(s, { persona: a.persona, session: sess, status: "idle" });
          a.next = sec(15, 45);
        } else if (r < 0.42) {
          const body: any = { status: "thinking" };
          if (chance(0.15)) body.task = { title_enc: encryptTitle(s.h.owner_key, pick(TITLES)) };
          await report(s, { persona: a.persona, session: sess, ...body });
          a.next = sec(3, 9);
        } else {
          const tool = pick(TOOL_MIX);
          await report(s, { persona: a.persona, session: sess, status: "tool", tool });
          if (tool === "Task" && a.subs.length < 3) {
            for (let k = 0, n = 1 + Math.floor(Math.random() * 2); k < n; k++) {
              const key = `${sess}-sub-${Math.random().toString(36).slice(2, 8)}`;
              a.subs.push({ key, until: sec(15, 40), next: sec(2, 4) });
              await report(s, { persona: a.persona, session: key, parent: sess, status: "thinking",
                task: { title_enc: encryptTitle(s.h.owner_key, "Sub: " + pick(TITLES)) } });
            }
          }
          a.next = sec(4, 12);
        }
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
