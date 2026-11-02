// Discovery & sharing (server/discover.ts) on a freshly emptied test DB (TEST_MYSQL_URL): live status badges (escaping,
// busy/online/asleep, 404 for unknown/removed/hidden homes), /sitemap.xml, robots.txt/llms.txt/agents.md hints, and
// /h/:id with per-home title/meta/Open Graph (escaped, CSP kept, no-cache + ETag, hidden homes leak nothing).
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { resetTestDb } from "./test-db.ts";
import { badgeSvg, esc, homeStatus, withMeta } from "../server/discover.ts";

// ---- unit: escaping and meta replacement ----
{
  assert.equal(esc(`<a href="x">&'</a>`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
  assert.equal(esc("a\u0000b‮c\ud800d"), "abcd", "control, bidi and lone surrogates dropped");
  assert.equal(esc("猫🐈"), "猫🐈");
  const svg = badgeSvg("Agent Town", `<script>alert(1)</script> & "x" · 1 agent busy`, "#3fa34d");
  assert.ok(!svg.includes("<script") && svg.includes("&lt;script&gt;") && svg.includes("&amp; &quot;x&quot;"));
  assert.ok(!/https?:\/\/(?!www\.w3\.org\/2000\/svg)/.test(svg) && !/href/.test(svg), "no external refs");
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="\d+" height="20" role="img"/);
  assert.deepEqual(homeStatus(3, 2), { text: "2 agents busy", color: "#3fa34d" });
  assert.equal(homeStatus(1, 0).text, "1 agent online");
  assert.equal(homeStatus(0, 0).text, "asleep");
  const page = readFileSync("public/index.html", "utf8");
  const m = withMeta(page, { title: `$& $' "<x>" · Agent Town`, description: "d $1 &", url: "http://h/x?a=1&b=2" });
  assert.ok(m.includes(`<title>$&amp; $&#39; &quot;&lt;x&gt;&quot; · Agent Town</title>`), "replacement patterns stay literal");
  assert.ok(m.includes(`<meta property="og:title" content="$&amp; $&#39; &quot;&lt;x&gt;&quot; · Agent Town">`));
  assert.ok(m.includes(`<meta name="description" content="d $1 &amp;">`) && m.includes(`<meta property="og:description" content="d $1 &amp;">`));
  assert.ok(m.includes(`<meta property="og:url" content="http://h/x?a=1&amp;b=2">`) && m.includes(`<link rel="canonical" href="http://h/x?a=1&amp;b=2">`));
  assert.equal(m.split("<title>").length, 2, "one title");
  assert.equal(withMeta(page, {}), page, "nothing to change");
  // JSON-LD: a data block (not executed, so script-src 'self' is fine) with valid JSON; the only inline <script>.
  const ld = /<script type="application\/ld\+json">([^<]*)<\/script>/.exec(page);
  assert.ok(ld, "WebSite JSON-LD present");
  assert.equal(JSON.parse(ld[1])["@type"], "WebSite");
  assert.equal([...page.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)].filter((s) => !s[0].includes("application/ld+json")).length, 0,
    "no executable inline script");
}

// ---- end to end ----
const PORT = 8795;
const BASE = `http://localhost:${PORT}`;
const ADMIN = "d".repeat(8) + randomBytes(24).toString("hex");
const MYSQL_URL = await resetTestDb();
const env = {
  ...process.env, MYSQL_URL, POW_DIFFICULTY: "8", ANTHROPIC_API_KEY: "", TRUST_PROXY: "1", PORT: String(PORT), PUBLIC_URL: BASE,
  ADMIN_TOKEN: ADMIN, NEIGHBOR_CHECK: "0",
};
const server: ChildProcess = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server/index.ts"], { env, stdio: ["ignore", "pipe", "inherit"] });
await new Promise<void>((ok, fail) => {
  server.stdout!.on("data", (d) => String(d).includes("listening") && ok());
  server.on("exit", (code) => fail(new Error(`server exited (${code})`)));
});

let ipSeq = 0;
const freshIp = () => `10.9.${Math.floor(++ipSeq / 250)}.${ipSeq % 250 + 1}`;
async function call(method: string, p: string, { token, body }: { token?: string; body?: unknown } = {}) {
  const r = await fetch(BASE + "/v1" + p, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json", "x-real-ip": freshIp(), ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  return { status: r.status, body: await r.json().catch(() => ({})) as any };
}
const page = async (p: string, headers: Record<string, string> = {}) => {
  const r = await fetch(BASE + p, { headers: { "x-real-ip": freshIp(), ...headers } });
  return { status: r.status, headers: r.headers, text: await r.text() };
};
const admin = (method: string, p: string, body?: unknown) => call(method, "/admin" + p, { token: ADMIN, body });

async function register(name: string, ref?: string) {
  const token = randomBytes(32).toString("hex");
  const { challenge, difficulty } = (await call("GET", "/register/challenge")).body;
  let nonce = 0;
  for (;; nonce++) {
    const h = createHash("sha256").update(`${challenge}:${nonce}`).digest();
    let bits = 0;
    for (const b of h) { if (b === 0) { bits += 8; continue; } bits += Math.clz32(b) - 24; break; }
    if (bits >= difficulty) break;
  }
  const r = await call("POST", "/register", { body: { challenge, nonce: String(nonce), auth_token: token, home_name: name, ...(ref ? { ref } : {}) } });
  assert.equal(r.status, 201, `register ${name}: ${JSON.stringify(r.body)}`);
  return { token, id: r.body.home.id as string };
}

try {
  const NAME = `Tom & "Jerry" <b>$&`;
  const A = await register(NAME);
  const B = await register("Sleepy Hollow");
  const H = await register("Secret Garden");
  const C = await register("Gone Soon");
  await call("PATCH", "/home", { token: A.token, body: { description: `cats <i>&</i> "dogs"` } });
  const rep = await call("POST", "/report", { token: A.token, body: { persona: { name: "Neko", kind: "cat" }, session: "s1", status: "tool", tool: "Bash" } });
  assert.equal(rep.status, 200, JSON.stringify(rep.body));

  // ---- badges ----
  const ba = await page(`/badge/${A.id}.svg`);
  assert.equal(ba.status, 200);
  assert.equal(ba.headers.get("content-type"), "image/svg+xml; charset=utf-8");
  assert.equal(ba.headers.get("cache-control"), "public, max-age=60");
  assert.equal(ba.headers.get("content-security-policy"), "default-src 'none'");
  assert.equal(ba.headers.get("x-content-type-options"), "nosniff");
  assert.ok(ba.text.includes("Tom &amp; &quot;Jerry&quot; &lt;b&gt;$&amp; · 1 agent busy"), ba.text);
  assert.ok(!ba.text.includes("<b>") && !ba.text.includes(`"Jerry"`), "name escaped");
  assert.ok(ba.text.includes("Agent Town"));
  const bb = await page(`/badge/${B.id}.svg`);
  assert.equal(bb.status, 200);
  assert.ok(bb.text.includes("Sleepy Hollow · asleep"));

  const town = await page("/badge/town.svg");
  assert.equal(town.status, 200);
  assert.ok(town.text.includes("4 homes · 1 online"), town.text);

  for (const p of ["/badge/h_nosuch1.svg", "/badge/nope.svg", "/badge/h_x.svg", `/badge/${A.id}.png`, `/badge/${A.id}`, "/badge/%3Cscript%3E.svg"]) {
    const r = await page(p);
    assert.equal(r.status, 404, p);
    assert.ok(r.text.includes("no such home") && r.text.startsWith("<svg"), p);
  }

  // removed home: 404, and nothing of its name
  await page(`/badge/${C.id}.svg`); // cached while it existed…
  const del = await call("DELETE", "/home", { token: C.token, body: { confirm: C.id } });
  assert.equal(del.status, 200, JSON.stringify(del.body));

  // hidden home: the same 404 badge as an unknown one, even right after it was cached
  assert.ok((await page(`/badge/${H.id}.svg`)).text.includes("Secret Garden"));
  assert.equal((await admin("POST", "/hide", { kind: "home", id: H.id, reason: "test" })).status, 200);
  const bh = await page(`/badge/${H.id}.svg`);
  assert.equal(bh.status, 404);
  assert.ok(!bh.text.includes("Secret") && bh.text.includes("no such home"));
  assert.equal(bh.text, (await page("/badge/h_nosuch1.svg")).text, "hidden looks like unknown");

  // ---- sitemap & robots & llms & agents.md ----
  const sm = await page("/sitemap.xml");
  assert.equal(sm.status, 200);
  assert.match(sm.headers.get("content-type") ?? "", /^application\/xml/);
  assert.ok(sm.text.startsWith(`<?xml version="1.0" encoding="UTF-8"?>`) && sm.text.includes(`xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"`));
  for (const p of ["/", "/talk", "/tasks", "/neighbors", "/cemetery", "/agents.md", "/changelog.md", `/h/${A.id}`, `/h/${B.id}`]) {
    assert.ok(sm.text.includes(`<loc>${BASE}${p}</loc>`), `sitemap lists ${p}`);
  }
  assert.ok(!sm.text.includes(H.id), "hidden home not in the sitemap");
  assert.equal((sm.text.match(/<loc>/g) ?? []).length, 9, "7 pages + 2 visible homes");

  const robots = await page("/robots.txt");
  assert.ok(robots.text.includes(`Sitemap: ${BASE}/sitemap.xml`) && !robots.text.includes("{{"), robots.text);
  assert.ok(robots.text.includes("Allow: /.well-known/") && robots.text.includes("Disallow: /v1/"));
  assert.match(robots.headers.get("content-type") ?? "", /^text\/plain/);
  const llms = await page("/llms.txt");
  assert.ok(llms.text.includes(`${BASE}/badge/<home_id>.svg`) && llms.text.includes(`${BASE}/h/<home_id>`) && !llms.text.includes("{{"));
  assert.match(llms.text, /only if your human/i);
  assert.ok(llms.text.includes("(/a2a)"), "existing links kept");
  const agents = await page("/agents.md");
  assert.ok(agents.text.includes("### Show off your home") && agents.text.includes(`[![Agent Town](${BASE}/badge/<home_id>.svg)](${BASE}/h/<home_id>)`));
  assert.match(agents.text, /Ask your human first/);

  // ---- /h/:id meta ----
  const ha = await page(`/h/${A.id}`);
  assert.equal(ha.status, 200);
  assert.match(ha.headers.get("content-type") ?? "", /^text\/html/);
  assert.equal(ha.headers.get("cache-control"), "no-cache");
  assert.match(ha.headers.get("content-security-policy") ?? "", /script-src 'self'/, "CSP kept");
  const nameEsc = "Tom &amp; &quot;Jerry&quot; &lt;b&gt;$&amp;";
  assert.ok(ha.text.includes(`<title>${nameEsc} · Agent Town</title>`), "per-home title");
  assert.ok(ha.text.includes(`<meta property="og:title" content="${nameEsc} · Agent Town">`));
  assert.ok(ha.text.includes(`<meta property="og:url" content="${BASE}/h/${A.id}">`) && ha.text.includes(`<link rel="canonical" href="${BASE}/h/${A.id}">`));
  const descr = /<meta name="description" content="([^"]*)">/.exec(ha.text)![1];
  assert.ok(descr.startsWith(`${nameEsc}: a home in Agent Town`) && descr.includes("cats &lt;i&gt;&amp;&lt;/i&gt; &quot;dogs&quot;"), descr);
  assert.ok(ha.text.includes(`<meta property="og:description" content="${descr}">`));
  assert.ok(!ha.text.includes("<b>$") && !ha.text.includes("<i>&"), "no raw user markup");
  assert.ok(ha.text.includes('<main id="main">') && ha.text.includes('<script type="module" src="/js/main.js">'), "still the app");
  assert.ok(!ha.text.includes('name="robots"'));
  const etag = ha.headers.get("etag")!;
  assert.match(etag, /^W\/"/);
  const again = await page(`/h/${A.id}`, { "if-none-match": etag });
  assert.equal(again.status, 304, "revalidates");
  assert.equal(again.text, "");

  const hh = await page(`/h/${H.id}`);
  assert.equal(hh.status, 200);
  assert.ok(!hh.text.includes("Secret"), "hidden home name never in the page");
  assert.ok(hh.text.includes("<title>Agent Town</title>") && hh.text.includes(`<meta name="robots" content="noindex">`));
  for (const id of ["h_nosuch1", C.id, "not-a-home"]) {
    const r = await page(`/h/${id}`);
    assert.equal(r.status, 404, id);
    assert.ok(r.text.includes('<main id="main">') && r.text.includes("<title>Agent Town</title>") && r.text.includes('content="noindex"'), id);
    assert.ok(!r.text.includes("Gone Soon"));
  }
  const root = await page("/");
  assert.ok(root.text.includes('<meta property="og:title" content="Agent Town">') && root.text.includes("application/ld+json"));

  // ---- referrals: a home invited by another (agents.md?ref=) → both get the bonus, the referrer gets an inbox item ----
  const coins = async (t: string) => (await call("GET", "/wallet", { token: t })).body.coins as number;
  const before = await coins(B.token);
  const R = await register("Invited Home", B.id);
  assert.equal(await coins(R.token), 150, "100 start + 50 referral");
  assert.equal(await coins(B.token), before + 50, "the referrer gets 50");
  assert.ok((await call("GET", "/inbox", { token: B.token })).body.items.some((i: any) => i.kind === "referral" && i.from_home === R.id));
  assert.equal(await coins((await register("Unknown Ref", "h_nosuch1")).token), 100, "unknown ref: no bonus, no error");
  assert.equal(await coins((await register("Hidden Ref", H.id)).token), 100, "hidden home: no bonus");
  const md = await page(`/agents.md?ref=${B.id}`);
  assert.ok(md.text.includes(`register --home "<home name>" --ref ${B.id}`) && md.text.includes("50 bonus coins"));
  const bad = await page("/agents.md?ref=<script>");
  assert.ok(!bad.text.includes("--ref h_") && !bad.text.includes("{{REF"), "bad ref ignored, placeholders gone");

  console.log("discover: all checks passed");
} finally {
  server.kill();
}
process.exit(0);
