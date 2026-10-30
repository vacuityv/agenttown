// "Report" affordance for public text: a small flag button that opens a shared dialog and POSTs /v1/reports.
import { api } from "./api.js";
import { el } from "./util.js";

const REASONS = [
  ["spam", "Spam or links · 垃圾信息"],
  ["hate", "Hate or slurs · 仇恨言论"],
  ["harassment", "Harassment · 骚扰"],
  ["sexual", "Sexual content · 色情"],
  ["personal_info", "Personal info · 个人信息"],
  ["other", "Something else · 其他"],
];
const KIND_LABEL = { home: "this home", persona: "this resident", say: "this message", tombstone: "this grave" };

let dlg = null;
function dialog() {
  if (dlg) return dlg;
  const what = el("p", { class: "muted small" });
  const reason = el("select", { name: "reason", "aria-label": "Reason" }, REASONS.map(([v, t]) => el("option", { value: v, text: t })));
  const note = el("input", { name: "note", maxlength: "300", autocomplete: "off", placeholder: "Details (optional, only moderators see this)" });
  const msg = el("p", { class: "small", role: "status" });
  const submit = el("button", { type: "submit", class: "btn primary" }, "Send report");
  const cancel = el("button", { type: "button", class: "btn ghost", onclick: () => node.close() }, "Close");
  const form = el("form", { method: "dialog", class: "report-form" },
    el("h2", { text: "Report · 举报" }), what,
    el("label", { class: "small" }, "Reason ", reason), note, msg,
    el("div", { class: "dialog-actions" }, cancel, submit));
  const node = el("dialog", { class: "report-dialog", "aria-label": "Report content" }, form);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!dlg.target) return;
    submit.disabled = true;
    msg.textContent = "Sending…";
    try {
      await api("/reports", { body: { kind: dlg.target.kind, id: dlg.target.id, reason: reason.value, note: note.value || undefined } });
      msg.textContent = "Thanks — a moderator will take a look. · 谢谢，我们会尽快处理。";
      submit.hidden = true;
    } catch (err) {
      msg.textContent = err.status === 429 ? "Too many reports from here; try again later." : "Couldn't send the report. Try again later.";
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
  d.what.textContent = `Tell the moderators what's wrong with ${KIND_LABEL[kind] ?? "this"}. Reports are anonymous.`;
  d.note.value = "";
  d.msg.textContent = "";
  d.submit.hidden = false;
  d.reason.value = "spam";
  d.node.showModal();
}

/** A small, unobtrusive flag button. */
export function reportButton(kind, id, label = "Report") {
  if (!id) return null;
  return el("button", {
    type: "button", class: "report-btn", title: `Report ${KIND_LABEL[kind] ?? ""}`.trim(), "aria-label": `Report ${KIND_LABEL[kind] ?? ""}`.trim(),
    onclick: (e) => { e.preventDefault(); e.stopPropagation(); openReport(kind, id); },
  }, "⚑", label ? el("span", { class: "report-label", text: ` ${label}` }) : null);
}
