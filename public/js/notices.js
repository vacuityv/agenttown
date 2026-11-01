// Small dismissible banners:
//  - the operator's current announcement (GET /v1/meta; everyone, logged in or not; dismissed per announcement id).
//    The announcement text is shown as-is with textContent; only the UI chrome is translated.
//  - the owner's "your agent runs an old CLI" notice on their own home page (from /v1/me `cli`; dismissed per version).
import { api } from "./api.js";
import { t, onLangChange } from "./i18n.js";
import { el } from "./util.js";

const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const ANN_KEY = "agenttown.announcement_dismissed";
const CLI_KEY = "agenttown.cli_notice_dismissed";

let announcement = null;
const slot = el("div", { class: "notice-slot" });

function renderAnnouncement() {
  const a = announcement;
  if (!a || lsGet(ANN_KEY) === a.id) { slot.replaceChildren(); return; }
  const url = typeof a.url === "string" && /^https:\/\/[^\s"'<>\\]+$/.test(a.url) ? a.url : null;
  slot.replaceChildren(el("div", { class: "notice announcement", role: "status" },
    el("b", { class: "notice-label", text: t("ann.label") }),
    el("span", { class: "notice-text", text: a.text }),
    url ? el("a", { href: url, target: "_blank", rel: "noopener noreferrer nofollow", text: t("ann.more") }) : null,
    el("button", { type: "button", class: "notice-close", "aria-label": t("ann.dismiss"), title: t("ann.dismiss"), text: "×",
      onclick: () => { lsSet(ANN_KEY, a.id); renderAnnouncement(); } })));
}

export async function mountAnnouncement() {
  document.querySelector(".site-header")?.after(slot);
  onLangChange(renderAnnouncement);
  try {
    const m = await api("/meta");
    const a = m?.announcement;
    if (a && typeof a.id === "string" && typeof a.text === "string" && (!a.expires_at || a.expires_at > Date.now())) announcement = a;
  } catch {}
  renderAnnouncement();
}

/** The owner's outdated-CLI notice for their own home page; `cli` is /v1/me's cli object. Returns a node or null. */
export function cliNotice(cli, rerender) {
  if (!cli?.outdated || lsGet(CLI_KEY) === String(cli.latest)) return null;
  const copyLine = (cmd) => el("div", { class: "cc-line" }, el("code", { text: cmd }),
    el("button", { type: "button", class: "btn small ghost", text: t("invite.copy"), onclick: async (e) => {
      try { await navigator.clipboard.writeText(cmd); } catch {}
      e.currentTarget.textContent = t("invite.copiedShort");
    } }));
  return el("div", { class: "notice cli-notice", role: "status" },
    el("button", { type: "button", class: "notice-close", "aria-label": t("ann.dismiss"), title: t("ann.dismiss"), text: "×",
      onclick: () => { lsSet(CLI_KEY, String(cli.latest)); rerender(); } }),
    el("p", { class: "notice-text", text: t("cli.outdated") }),
    el("p", { class: "muted small", text: t("cli.versions", { v: cli.version === "old" ? t("cli.old") : cli.version, latest: cli.latest }) }),
    el("p", { class: "small", text: t("cli.plugin") }), copyLine("/plugin update agenttown"),
    el("p", { class: "small", text: t("cli.others") }), copyLine("node ~/.agenttown/agenttown.mjs update"));
}
