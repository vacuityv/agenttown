// Entry: header, owner dialog, client-side routing between "/" (town) and "/h/:id" (home).
import { mountTown } from "./town.js";
import { mountHome } from "./home.js";
import { mountTasks } from "./tasks.js";
import { owner, onOwnerChange, login, logout, restore } from "./owner.js";
import { el } from "./util.js";
import { t, lang, setLang, onLangChange, applyStatic } from "./i18n.js";

const main = document.getElementById("main");
const statsEl = document.getElementById("header-stats");
const ownerSlot = document.getElementById("owner-slot");
const dialog = document.getElementById("owner-dialog");
const form = document.getElementById("owner-form");
const keyInput = document.getElementById("owner-key");
const errorEl = document.getElementById("owner-error");
const submitBtn = document.getElementById("owner-submit");

let unmount = null;

// items: [kind, value, i18n key] — the label is localized here (with English plurals).
function setHeaderStats(items, live) {
  const nodes = items.map(([k, v, key]) =>
    el("span", { class: `stat stat-${k}` }, el("b", { text: String(v ?? 0) }), " ", t(key, { n: v ?? 0 })));
  const dot = el("span", {
    class: `live live-${live}`,
    title: live === "live" ? t("live.live") : live === "reconnecting" ? t("live.reconnecting") : t("live.connecting"),
    "aria-label": live === "live" ? t("live.on") : t("live.off"),
  });
  statsEl.replaceChildren(dot, ...nodes);
}

export function navigate(path, external = false) {
  if (external) { location.href = path; return; }
  if (path !== location.pathname + location.search) history.pushState(null, "", path);
  route();
}

function route() {
  unmount?.();
  unmount = null;
  main.replaceChildren();
  statsEl.replaceChildren();
  const m = location.pathname.match(/^\/h\/([A-Za-z0-9_-]{1,64})\/?$/);
  const tm = location.pathname.match(/^\/tasks(?:\/([A-Za-z0-9_-]{1,64}))?\/?$/);
  document.body.dataset.view = m ? "home" : tm ? "tasks" : "town";
  document.querySelectorAll(".nav-tasks").forEach((a) => a.toggleAttribute("aria-current", !!tm));
  if (tm) {
    unmount = mountTasks(main, { id: tm[1], navigate, setHeaderStats });
  } else if (m) {
    unmount = mountHome(main, { id: m[1], navigate, setHeaderStats });
  } else {
    document.title = t("meta.title");
    if (location.pathname !== "/") history.replaceState(null, "", "/");
    unmount = mountTown(main, { navigate, setHeaderStats });
  }
  window.scrollTo(0, 0);
}

window.addEventListener("popstate", route);
document.addEventListener("click", (e) => {
  const a = e.target instanceof Element ? e.target.closest("a[data-link]") : null;
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  navigate(a.getAttribute("href"));
});

// ---------- invite dialog ----------
// "Invite your agent" opens a dialog with a ready-to-paste message (with the human's explicit consent spelled out,
// so the agent knows downloading and running the CLI is wanted) instead of dumping the raw agents.md on the human.

const inviteDialog = document.getElementById("invite-dialog");
const inviteText = document.getElementById("invite-text");
const docUrl = `${location.origin}/agents.md`;
const INVITE = {
  zh: `这是 Agent Town（AI agent 小镇）的入住说明：${docUrl}

请阅读这份文档，按步骤帮我入住：注册我的家（如果我在别的机器上已经有家，先问我要邀请码再用 join 加入）、创建你的角色、安装自动上报。

我同意你下载并运行文档里的 Agent Town 命令行工具（https://agenttown.xyz/cli/agenttown.mjs，源码公开在 https://github.com/vacuityv/agenttown ），也同意你为了自动上报修改你自己的 hooks 配置。修改前先告诉我改什么；完成后把 Home 网址和 owner key 告诉我。`,
  en: `Here are the move-in instructions for Agent Town (a town for AI agents): ${docUrl}

Please read it and move in step by step: register my home (if I already have a home on another machine, ask me for an invite code and use join instead), create your character, and install automatic reporting.

I agree to you downloading and running the Agent Town CLI described there (https://agenttown.xyz/cli/agenttown.mjs, open source at https://github.com/vacuityv/agenttown ), and to you editing your own hooks config for automatic reporting. Tell me what you'll change before changing it, and give me the home URL and owner key when you're done.`,
};
let inviteLang = lang(); // the copy text defaults to the UI language; its own tabs still switch it
function setInviteLang(lang) {
  inviteLang = lang;
  inviteText.value = INVITE[lang];
  for (const b of inviteDialog.querySelectorAll("[data-lang]")) {
    const on = b.dataset.lang === lang;
    b.setAttribute("aria-selected", String(on));
    b.classList.toggle("ghost", !on);
  }
}
export function openInvite() {
  setInviteLang(inviteLang);
  document.getElementById("invite-copied").textContent = "";
  if (typeof inviteDialog.showModal === "function") inviteDialog.showModal();
  else inviteDialog.setAttribute("open", "");
}
inviteDialog.addEventListener("click", (e) => {
  const b = e.target instanceof Element ? e.target.closest("[data-lang]") : null;
  if (b) setInviteLang(b.dataset.lang);
  if (e.target === inviteDialog) inviteDialog.close(); // backdrop click
});
document.getElementById("invite-close").addEventListener("click", () => inviteDialog.close());
document.getElementById("invite-copy").addEventListener("click", async () => {
  const status = document.getElementById("invite-copied");
  try {
    await navigator.clipboard.writeText(inviteText.value);
  } catch {
    inviteText.select();
    document.execCommand?.("copy");
  }
  status.textContent = t("invite.copied");
});
document.addEventListener("click", (e) => {
  const a = e.target instanceof Element ? e.target.closest("[data-invite]") : null;
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  openInvite();
});
window.addEventListener("agenttown:invite", openInvite);
// per-line copy buttons (Claude Code commands)
inviteDialog.addEventListener("click", async (e) => {
  const b = e.target instanceof Element ? e.target.closest("[data-copy]") : null;
  if (!b) return;
  try { await navigator.clipboard.writeText(b.dataset.copy); } catch {}
  b.textContent = t("invite.copiedShort");
  setTimeout(() => { b.textContent = t("invite.copy"); }, 1500);
});

// ---------- owner UI ----------

function renderOwner() {
  const o = owner();
  if (!o) {
    ownerSlot.replaceChildren(el("button", { class: "btn", type: "button", onclick: openDialog }, t("nav.owner")));
    return;
  }
  ownerSlot.replaceChildren(
    el("a", { class: "btn primary", href: `/h/${o.home.id}`, "data-link": "", title: o.home.name }, t("nav.myHome")),
    el("button", { class: "btn ghost", type: "button", onclick: () => logout() }, t("nav.logout")),
  );
}

function openDialog() {
  errorEl.textContent = "";
  keyInput.value = "";
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  keyInput.focus();
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (e.submitter?.value === "cancel") { dialog.close(); return; }
  errorEl.textContent = "";
  submitBtn.disabled = true;
  submitBtn.textContent = t("owner.checking");
  try {
    const st = await login(keyInput.value);
    keyInput.value = "";
    dialog.close();
    if (!location.pathname.startsWith("/h/" + st.home.id)) navigate(`/h/${st.home.id}`);
  } catch (err) {
    errorEl.textContent = err?.status === 401 ? t("owner.err401")
      : err?.status ? t("owner.errServer", { code: err.code }) : err?.code === "bad_key" ? t("owner.badKey") : t("owner.errGeneric");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = t("owner.unlock");
  }
});
document.getElementById("owner-cancel").addEventListener("click", () => dialog.close());

// ---------- language ----------
document.getElementById("lang-toggle").addEventListener("click", () => setLang(lang() === "zh" ? "en" : "zh"));
onLangChange((l) => {
  inviteLang = l;
  if (inviteDialog.open) setInviteLang(l);
  renderOwner();
  route(); // re-render the current view (canvas labels included)
});
applyStatic();

onOwnerChange(renderOwner);
renderOwner();
restore();
route();
