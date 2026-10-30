// "Feedback" dialog: suggestions, bug reports and ideas for the person running Agent Town. POSTs /v1/feedback
// (private: only the operator reads it). Opened by any [data-feedback] element (header button, footer link).
import { api } from "./api.js";
import { el } from "./util.js";
import { t, lang, onLangChange } from "./i18n.js";

const MAX = 4000;
const CATEGORIES = ["idea", "bug", "other"];
let dlg = null;
let draft = { message: "", contact: "", category: "idea" }; // survives closing and a language switch

onLangChange(() => {
  if (!dlg) return;
  const wasOpen = dlg.node.open;
  saveDraft();
  dlg.node.remove();
  dlg = null;
  if (wasOpen) openFeedback(); // rebuilt in the new language
});

function saveDraft() {
  if (!dlg || dlg.sent) return;
  draft = { message: dlg.message.value, contact: dlg.contact.value, category: dlg.category() };
}

function dialog() {
  if (dlg) return dlg;
  const uid = "fb";
  const chips = el("div", { class: "fb-chips", role: "radiogroup", "aria-labelledby": `${uid}-cat-label` },
    CATEGORIES.map((c) => el("label", { class: "fb-chip" },
      el("input", { type: "radio", name: "category", value: c }), el("span", { text: t(`fb.cat.${c}`) }))));
  const message = el("textarea", {
    id: `${uid}-message`, name: "message", rows: "6", maxlength: String(MAX), required: true,
    placeholder: t("fb.placeholder"), "aria-describedby": `${uid}-count`,
  });
  const count = el("span", { id: `${uid}-count`, class: "fb-count muted small", "aria-live": "polite" });
  const contact = el("input", {
    id: `${uid}-contact`, name: "contact", type: "text", maxlength: "200", autocomplete: "email", spellcheck: "false",
    placeholder: t("fb.contactPlaceholder"), "aria-describedby": `${uid}-contact-note`,
  });
  // Honeypot: off-screen, unfocusable, unlabeled for humans. Bots that fill every field get a fake success.
  const website = el("input", { type: "text", name: "website", tabindex: "-1", autocomplete: "off" });
  const error = el("p", { class: "error", role: "alert" });
  const submit = el("button", { type: "submit", class: "btn primary" }, t("fb.send"));
  const cancel = el("button", { type: "button", class: "btn ghost", onclick: () => node.close() }, t("fb.cancel"));

  const form = el("form", { method: "dialog", class: "fb-form", novalidate: true },
    el("h2", { id: `${uid}-title`, text: t("fb.title") }),
    el("p", { class: "fb-intro", text: t("fb.intro") }),
    el("p", { id: `${uid}-cat-label`, class: "fb-label", text: t("fb.category") }), chips,
    el("label", { class: "fb-label", for: `${uid}-message`, text: t("fb.message") }), message,
    el("div", { class: "fb-meta" }, count),
    el("label", { class: "fb-label", for: `${uid}-contact`, text: t("fb.contact") }), contact,
    el("p", { id: `${uid}-contact-note`, class: "muted small fb-note", text: t("fb.contactNote") }),
    el("div", { class: "fb-hp", "aria-hidden": "true" }, website),
    error,
    el("div", { class: "dialog-actions" }, cancel, submit));
  const okClose = el("button", { type: "button", class: "btn primary", onclick: () => node.close() }, t("fb.close"));
  const done = el("div", { class: "fb-done", hidden: true },
    el("h2", { text: t("fb.thanksTitle") }), el("p", { text: t("fb.thanks") }),
    el("div", { class: "dialog-actions" }, okClose));
  const node = el("dialog", { class: "fb-dialog", "aria-labelledby": `${uid}-title` }, form, done);

  const updateCount = () => {
    const n = [...message.value].length;
    count.textContent = t("fb.count", { n, max: MAX });
    count.classList.toggle("over", n > MAX);
  };
  message.addEventListener("input", () => { updateCount(); error.textContent = ""; });
  node.addEventListener("close", saveDraft);
  node.addEventListener("click", (e) => { if (e.target === node) node.close(); }); // backdrop click

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = message.value.trim();
    if (!text) { error.textContent = t("fb.empty"); message.focus(); return; }
    if ([...text].length > MAX) { error.textContent = t("fb.tooLong", { max: MAX }); message.focus(); return; }
    error.textContent = "";
    submit.disabled = true;
    submit.textContent = t("fb.sending");
    try {
      await api("/feedback", { body: {
        message: text, category: d.category(), contact: contact.value.trim() || undefined,
        page: location.pathname.slice(0, 200), lang: lang(), website: website.value || undefined,
      } });
      d.sent = true;
      draft = { message: "", contact: "", category: "idea" };
      form.hidden = true;
      done.hidden = false;
      okClose.focus();
    } catch (err) {
      error.textContent = err.status === 429 ? t("fb.tooMany")
        : err.code === "bad_message" ? t("fb.tooLong", { max: MAX })
        : err.code === "bad_contact" ? t("fb.badContact")
        : err.status === 413 ? t("fb.tooLong", { max: MAX })
        : err.status ? t("fb.failServer", { code: err.code }) : t("fb.failNetwork");
    } finally {
      submit.disabled = false;
      submit.textContent = t("fb.send");
    }
  });

  document.body.append(node);
  const d = {
    node, form, done, message, contact, website, error, sent: false, updateCount,
    category: () => form.querySelector("input[name=category]:checked")?.value ?? "other",
    setCategory: (c) => { for (const r of form.querySelectorAll("input[name=category]")) r.checked = r.value === c; },
  };
  dlg = d;
  return d;
}

export function openFeedback() {
  const d = dialog();
  if (d.sent) { // a fresh form after a successful send
    d.sent = false;
    d.form.hidden = false;
    d.done.hidden = true;
  }
  d.message.value = draft.message;
  d.contact.value = draft.contact;
  d.website.value = "";
  d.setCategory(draft.category);
  d.error.textContent = "";
  d.updateCount();
  if (typeof d.node.showModal === "function") d.node.showModal();
  else d.node.setAttribute("open", "");
  d.message.focus();
}

document.addEventListener("click", (e) => {
  const a = e.target instanceof Element ? e.target.closest("[data-feedback]") : null;
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  openFeedback();
});
