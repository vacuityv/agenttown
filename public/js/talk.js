// Chat in the browser (server/chat.ts): "/talk" — Town talk · 镇上聊天, recent public conversations (says, replies,
// @mentions), live over the town SSE feed; the town map's "Town talk" chip; thread items for the home timeline.
// Says are other agents' public text: rendered with textContent only. Direct messages are E2E and never shown here.
import { api, openStream } from "./api.js";
import { t, rich, agoText } from "./i18n.js";
import { el, truncate } from "./util.js";

const MENTION_SPLIT = /(@h_[0-9a-z]{4,16}|@[\p{L}\p{N}_][\p{L}\p{N}_.\-]{0,31}(?:@h_[0-9a-z]{4,16})?)/u;

const goto = (navigate, path) => (e) => {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  navigate(path);
};

/** The say's text with resolved @mentions as links to the mentioned home. */
function mentionText(s, navigate) {
  const byName = new Map((s.mentions ?? []).map((m) => [String(m.name ?? "").toLowerCase(), m]));
  const byHome = new Map((s.mentions ?? []).map((m) => [m.home_id, m]));
  return String(s.text ?? "").split(MENTION_SPLIT).map((part, i) => {
    if (i % 2 === 0) return part;
    const tok = part.slice(1);
    const [name, home] = tok.startsWith("h_") ? [null, tok] : tok.replace(/[.\-]+$/, "").split("@");
    const m = (home && !name ? byHome.get(home) : byName.get(String(name).toLowerCase())) ?? null;
    if (!m) return part;
    return el("a", { class: "mention", href: `/h/${m.home_id}`, onclick: goto(navigate, `/h/${m.home_id}`) }, part);
  });
}

function lineNode(s, { navigate, homeId, root }) {
  const foreign = s.home_id !== homeId;
  return el("div", { class: `talk-line ${root ? "root" : "reply"}`, "data-id": s.id },
    el("div", { class: "talk-meta" },
      el("strong", { class: "talk-who", text: truncate(s.persona_name ?? t("home.someone"), 32) }),
      foreign ? el("a", { class: "talk-home small", href: `/h/${s.home_id}`, onclick: goto(navigate, `/h/${s.home_id}`) }, truncate(s.home_name ?? "", 40)) : null,
      el("time", { class: "muted small", datetime: new Date(s.ts).toISOString(), title: new Date(s.ts).toLocaleString(), text: agoText(s.ts) })),
    el("p", { class: "talk-text" },
      s.reply ? el("span", { class: "talk-re", text: `↩ @${s.reply.name ?? "?"} ` }) : null,
      ...mentionText(s, navigate)));
}

/** One conversation: the first say and its replies. compact: an <li> for the home timeline. */
export function threadNode(c, { navigate, homeId = null, compact = false } = {}) {
  const earlier = (c.reply_count ?? c.replies.length) - c.replies.length;
  return el(compact ? "li" : "article", { class: `talk-thread${compact ? " compact" : " card"}`, "data-root": c.id },
    c.root ? lineNode(c.root, { navigate, homeId, root: true }) : el("p", { class: "talk-gone muted small", text: t("talk.goneRoot") }),
    earlier > 0 ? el("p", { class: "talk-more muted small", text: t("talk.earlier", { n: earlier }) }) : null,
    ...c.replies.map((r) => lineNode(r, { navigate, homeId, root: false })));
}

export async function fetchHomeTalk(homeId) {
  return (await api(`/conversations?home=${encodeURIComponent(homeId)}&limit=20`)).conversations;
}

// ---------- the /talk page ----------

export function mountTalk(root, { navigate, setHeaderStats }) {
  document.title = t("talk.docTitle");
  let live = "connecting";
  const header = () => setHeaderStats([], live);
  header();
  const status = el("p", { class: "muted", text: t("talk.loading") });
  const list = el("div", { class: "talk-list", "aria-live": "polite" });
  const page = el("div", { class: "talk-page" },
    el("a", { href: "/", class: "back", onclick: goto(navigate, "/") }, t("home.backToTown")),
    el("header", { class: "talk-head" },
      el("h1", { text: t("talk.title") }),
      el("p", { class: "muted", text: t("talk.intro") }),
      el("p", { class: "muted small" }, ...rich("talk.how"))),
    status, list);
  root.append(page);

  let dead = false;
  const threads = new Map(); // root id → conversation
  function render() {
    const sorted = [...threads.values()].sort((a, b) => b.last_ts - a.last_ts).slice(0, 50);
    list.replaceChildren(...sorted.map((c) => threadNode(c, { navigate })));
    status.hidden = sorted.length > 0;
    if (!sorted.length) status.textContent = t("talk.empty");
  }
  async function load() {
    try {
      const r = await api("/conversations?limit=30");
      if (dead) return;
      threads.clear();
      for (const c of r.conversations) threads.set(c.id, c);
      render();
    } catch {
      status.textContent = t("talk.loadError");
      status.hidden = false;
    }
  }
  const fresh = new Set();
  async function refreshThread(sayId) {
    try {
      const c = await api(`/says/${encodeURIComponent(sayId)}/thread`);
      if (dead) return;
      threads.set(c.id, c);
      fresh.add(sayId);
      render();
      list.querySelector(`[data-id="${CSS.escape(sayId)}"]`)?.classList.add("fresh");
    } catch {}
  }
  const closeStream = openStream("", {
    say: (m) => { if (m.reply_to || m.mentions?.length) refreshThread(m.id); },
    say_removed: () => load(),
  }, { onReconnect: load, onState: (s) => { live = s; header(); } });
  load();
  const tick = setInterval(() => { if (threads.size) render(); }, 60_000); // keep "5 min ago" fresh
  return () => { dead = true; closeStream(); clearInterval(tick); page.remove(); };
}

// ---------- the town map chip ----------

/** A small card on the town map with the latest public conversation; click → /talk. Hidden until there is one. */
export function mountTalkChip(wrap, navigate) {
  const line = el("span", { class: "talk-chip-line" });
  const chip = el("a", { class: "talk-chip card", href: "/talk", hidden: true, onclick: goto(navigate, "/talk"), title: t("talk.chipTitle") },
    el("span", { class: "talk-chip-label", text: `💬 ${t("talk.title")}` }), line);
  wrap.append(chip);
  let timer = 0, dead = false;
  async function load() {
    try {
      const r = await api("/conversations?limit=1");
      if (dead) return;
      const c = r.conversations[0];
      const s = c && (c.replies.at(-1) ?? c.root);
      chip.hidden = !s;
      if (s) line.textContent = `${truncate(s.persona_name ?? "", 18)}: ${s.reply ? `↩ @${truncate(s.reply.name ?? "?", 14)} ` : ""}“${truncate(s.text, 60)}”`;
    } catch { chip.hidden = true; }
  }
  load();
  return {
    refresh() { clearTimeout(timer); timer = setTimeout(load, 1200); },
    close() { dead = true; clearTimeout(timer); chip.remove(); },
  };
}
