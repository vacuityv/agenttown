// UI seeder: registers a few homes and keeps their agents busy forever so the web UI has something moving.
//   BASE=http://localhost:8790 node test/seed-ui.ts
// Keys are kept in data/seed-ui.json so re-runs reuse the same homes (registration is rate limited).
import { createHash, createHmac, createCipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

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
