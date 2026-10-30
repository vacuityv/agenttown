// "Report" affordance for public text: a small flag button that opens a shared dialog and POSTs /v1/reports.
import { api } from "./api.js";
import { el } from "./util.js";
import { t, onLangChange } from "./i18n.js";

const REASONS = ["spam", "hate", "harassment", "sexual", "personal_info", "other"];
const kindText = (kind) => t(`report.k.${kind}`) === `report.k.${kind}` ? t("report.k.default") : t(`report.k.${kind}`);
onLangChange(() => { if (dlg) { dlg.node.remove(); dlg = null; } }); // rebuilt in the new language next time

let dlg = null;
function dialog() {
  if (dlg) return dlg;
  const what = el("p", { class: "muted small" });
  const reason = el("select", { name: "reason", "aria-label": t("report.reason") }, REASONS.map((v) => el("option", { value: v, text: t(`report.r.${v}`) })));
  const note = el("input", { name: "note", maxlength: "300", autocomplete: "off", placeholder: t("report.placeholder") });
  const msg = el("p", { class: "small", role: "status" });
  const submit = el("button", { type: "submit", class: "btn primary" }, t("report.send"));
  const cancel = el("button", { type: "button", class: "btn ghost", onclick: () => node.close() }, t("report.close"));
  const form = el("form", { method: "dialog", class: "report-form" },
    el("h2", { text: t("report.title") }), what,
    el("label", { class: "small" }, t("report.reason"), " ", reason), note, msg,
    el("div", { class: "dialog-actions" }, cancel, submit));
  const node = el("dialog", { class: "report-dialog", "aria-label": t("report.aria") }, form);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!dlg.target) return;
    submit.disabled = true;
    msg.textContent = t("report.sending");
    try {
      await api("/reports", { body: { kind: dlg.target.kind, id: dlg.target.id, reason: reason.value, note: note.value || undefined } });
      msg.textContent = t("report.thanks");
      submit.hidden = true;
    } catch (err) {
      msg.textContent = err.status === 429 ? t("report.tooMany") : t("report.fail");
    } finally {
      submit.disabled = false;
    }
  });
  document.body.append(node);
  dlg = { node, what, note, msg, submit, reason, target: null };
  return dlg;
}

export function openReport(kind, id) {
  const d = dialog();
  d.target = { kind, id: String(id) };
  d.what.textContent = t("report.what", { what: kindText(kind) });
  d.note.value = "";
  d.msg.textContent = "";
  d.submit.hidden = false;
  d.reason.value = "spam";
  d.node.showModal();
}

/** A small, unobtrusive flag button. */
export function reportButton(kind, id, label = t("report.button")) {
  if (!id) return null;
  return el("button", {
    type: "button", class: "report-btn", title: t("report.of", { what: kindText(kind) }), "aria-label": t("report.of", { what: kindText(kind) }),
    onclick: (e) => { e.preventDefault(); e.stopPropagation(); openReport(kind, id); },
  }, "⚑", label ? el("span", { class: "report-label", text: ` ${label}` }) : null);
}
