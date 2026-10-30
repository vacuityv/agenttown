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
  { name: "Night Owl Lab", activity: 0.35, agents: [{ name: "Hoot", kind: "claude-code" }, { name: "Ember", kind: "other" }, { name: "Pixel", kind: "codex" }] },
  { name: "Sleepy Cottage", activity: 0, agents: [] },
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

type Agent = { persona: { name: string; kind: string }; session: string; open: boolean; subs: { key: string; ttl: number }[]; gen: number };

async function main() {
  const homes = await loadHomes();
  console.log(`\nSeeding ${BASE}\n`);
  for (const h of homes) console.log(`  ${h.name.padEnd(24)} ${BASE}/h/${h.home_id}\n    owner_key: ${h.owner_key}`);
  console.log("");

  const sims = homes.map((h, i) => {
    const plan = PLAN[i];
    const token = authToken(h.owner_key);
    const agents: Agent[] = plan.agents.map((a, j) => ({ persona: a, session: `seed-${i}-${j}`, open: false, subs: [], gen: 0 }));
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
    for (const s of sims) {
      for (const a of s.agents) {
        if (!chance(0.5)) continue;
        if (!a.open) {
          if (chance(s.plan.activity * 0.6)) {
            a.open = true;
            a.gen++;
            await report(s, { persona: a.persona, session: `${a.session}-${a.gen}`, status: "thinking",
              task: { title_enc: encryptTitle(s.h.owner_key, pick(TITLES)) } });
          }
          continue;
        }
        const sess = `${a.session}-${a.gen}`;
        // Subagents: tick down, end when done; occasionally spawn.
        for (const sub of a.subs) {
          sub.ttl--;
          await report(s, { persona: a.persona, session: sub.key, parent: sess,
            status: sub.ttl <= 0 ? "ended" : chance(0.3) ? "thinking" : "tool", tool: pick(TOOLS) });
        }
        a.subs = a.subs.filter((x) => x.ttl > 0);
        if (a.subs.length < 3 && chance(0.12 * s.plan.activity)) {
          const key = `${sess}-sub-${Math.random().toString(36).slice(2, 8)}`;
          a.subs.push({ key, ttl: 3 + Math.floor(Math.random() * 8) });
          await report(s, { persona: a.persona, session: key, parent: sess, status: "thinking",
            task: { title_enc: encryptTitle(s.h.owner_key, "Sub: " + pick(TITLES)) } });
        }
        const r = Math.random();
        let body: any;
        if (r < 0.03 * (1.2 - s.plan.activity)) { body = { status: "ended" }; a.open = false; a.subs = []; }
        else if (r < 0.1) body = { status: "waiting" };
        else if (r < 0.25 * (1.3 - s.plan.activity)) body = { status: "idle" };
        else if (r < 0.45) body = { status: "thinking" };
        else body = { status: "tool", tool: pick(TOOLS) };
        if (chance(0.05)) body.task = { title_enc: encryptTitle(s.h.owner_key, pick(TITLES)) };
        await report(s, { persona: a.persona, session: sess, ...body });
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
