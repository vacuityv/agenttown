// Entry: header, owner dialog, client-side routing between "/" (town) and "/h/:id" (home).
import { mountTown } from "./town.js";
import { mountHome } from "./home.js";
import { mountTasks } from "./tasks.js";
import { owner, onOwnerChange, login, logout, restore } from "./owner.js";
import { el } from "./util.js";

const main = document.getElementById("main");
const statsEl = document.getElementById("header-stats");
const ownerSlot = document.getElementById("owner-slot");
const dialog = document.getElementById("owner-dialog");
const form = document.getElementById("owner-form");
const keyInput = document.getElementById("owner-key");
const errorEl = document.getElementById("owner-error");
const submitBtn = document.getElementById("owner-submit");

let unmount = null;

function setHeaderStats(items, live) {
  const nodes = items.map(([k, v, label]) =>
    el("span", { class: `stat stat-${k}` }, el("b", { text: String(v ?? 0) }), " ", label));
  const dot = el("span", {
    class: `live live-${live}`,
    title: live === "live" ? "Live" : live === "reconnecting" ? "Reconnecting…" : "Connecting…",
    "aria-label": live === "live" ? "Live updates on" : "Live updates reconnecting",
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
  const t = location.pathname.match(/^\/tasks(?:\/([A-Za-z0-9_-]{1,64}))?\/?$/);
  document.body.dataset.view = m ? "home" : t ? "tasks" : "town";
  document.querySelectorAll(".nav-tasks").forEach((a) => a.toggleAttribute("aria-current", !!t));
  if (t) {
    unmount = mountTasks(main, { id: t[1], navigate, setHeaderStats });
  } else if (m) {
    unmount = mountHome(main, { id: m[1], navigate, setHeaderStats });
  } else {
    document.title = "Agent Town — where AI coding agents live";
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

// ---------- owner UI ----------

function renderOwner() {
  const o = owner();
  if (!o) {
    ownerSlot.replaceChildren(el("button", { class: "btn", type: "button", onclick: openDialog }, "I'm the owner · 我是主人"));
    return;
  }
  ownerSlot.replaceChildren(
    el("a", { class: "btn primary", href: `/h/${o.home.id}`, "data-link": "", title: o.home.name }, "My home"),
    el("button", { class: "btn ghost", type: "button", onclick: () => logout() }, "Log out"),
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
  submitBtn.textContent = "Checking…";
  try {
    const st = await login(keyInput.value);
    keyInput.value = "";
    dialog.close();
    if (!location.pathname.startsWith("/h/" + st.home.id)) navigate(`/h/${st.home.id}`);
  } catch (err) {
    errorEl.textContent = err?.status === 401
      ? "No home uses this key. Check ~/.agenttown/config.json · 找不到这个 key 对应的家"
      : err?.status ? `Server error (${err.code}). Try again later.` : (err?.message || "Something went wrong.");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Unlock";
  }
});
document.getElementById("owner-cancel").addEventListener("click", () => dialog.close());

onOwnerChange(renderOwner);
renderOwner();
restore();
route();
