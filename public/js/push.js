// Owner only, on their own home page: "Notify me on this device" (Web Push, server/push.ts). The browser subscribes
// with the server's VAPID key; the server pings it when an agent is waiting for the human or finished a turn.
// Notifications carry names and status only (never task titles: the server can't read those). /sw.js shows them.
// iOS delivers Web Push only to web apps added to the home screen, so Safari tabs on iOS get a hint instead.
import { api } from "./api.js";
import { t, lang, agoText } from "./i18n.js";
import { el } from "./util.js";
import { owner } from "./owner.js";

// homeId -> device id of this browser's subscription (one browser can notify for several homes)
const LS_KEY = "agenttown.push";
const lsMap = () => { try { return JSON.parse(localStorage.getItem(LS_KEY) || "{}") || {}; } catch { return {}; } };
const lsPut = (m) => { try { localStorage.setItem(LS_KEY, JSON.stringify(m)); } catch {} };

const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = () => window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;

function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? "iPhone" : isIos() ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac"
    : /Windows/.test(ua) ? "Windows" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "";
  const br = /Edg\//.test(ua) ? "Edge" : /Firefox\/|FxiOS/.test(ua) ? "Firefox" : /OPR\//.test(ua) ? "Opera"
    : /Chrome\/|CriOS/.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  return [os, br].filter(Boolean).join(" · ") || t("push.thisBrowser");
}

function keyBytes(b64) {
  const s = atob(b64.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64.length + 3) % 4));
  return Uint8Array.from(s, (ch) => ch.charCodeAt(0));
}
const sameKey = (buf, bytes) => {
  if (!buf) return false;
  const a = new Uint8Array(buf);
  return a.length === bytes.length && a.every((x, i) => x === bytes[i]);
};

async function registration() {
  if (!supported()) return null;
  return (await navigator.serviceWorker.getRegistration("/")) ?? null;
}
async function currentSub() {
  const reg = await registration();
  return reg ? reg.pushManager.getSubscription() : null;
}

/** The owner's notification card. setMine(bool) shows/loads it; destroy() on unmount. */
export function notifyCard(homeId) {
  const node = el("section", { class: "card notify-card", hidden: true });
  let info = null;      // GET /v1/push
  let thisId = null;    // this browser's device id for this home, if subscribed
  let mine = false, dead = false, busy = false, note = "", noteKind = "";
  const token = () => owner()?.authToken;

  async function load() {
    try { info = await api("/push", { token: token() }); } catch { info = null; }
    thisId = null;
    if (info?.enabled && supported()) {
      // Register the worker up front, so the click only has to subscribe (Safari wants that inside the gesture).
      await navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
      const sub = await currentSub().catch(() => null);
      const id = lsMap()[homeId];
      if (sub && id && info.devices.some((d) => d.id === id)) thisId = id;
    }
    if (!dead) render();
  }

  const act = (fn) => async () => {
    if (busy) return;
    busy = true; note = ""; render();
    try { await fn(); } catch (e) { note = e?.message ? t("push.error", { msg: e.message }) : t("push.errorGeneric"); noteKind = "error"; }
    busy = false;
    await load();
  };

  // Called straight from the click: subscribe() must run inside the user gesture (it asks for permission).
  const enable = act(async () => {
    // Normally registered (and active) since load(); registering here throws if the browser refuses service workers.
    let reg = (await registration()) ?? (await navigator.serviceWorker.register("/sw.js", { scope: "/" }));
    if (!reg.active) reg = await navigator.serviceWorker.ready;
    const key = keyBytes(info.public_key);
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub.options?.applicationServerKey, key)) { await sub.unsubscribe(); sub = null; } // server key changed
    try {
      sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    } catch (e) {
      if (Notification.permission === "denied" || e?.name === "NotAllowedError") { note = t("push.denied"); noteKind = "error"; return; }
      throw e;
    }
    const r = await api("/push/subscriptions", { token: token(), body: { subscription: sub.toJSON(), label: deviceLabel(), lang: lang() } });
    lsPut({ ...lsMap(), [homeId]: r.device.id });
    note = t("push.onNote"); noteKind = "ok";
  });

  const disable = act(async () => {
    const m = lsMap();
    const id = m[homeId];
    if (id) await api(`/push/subscriptions/${encodeURIComponent(id)}`, { token: token(), method: "DELETE" }).catch((e) => { if (e?.status !== 404) throw e; });
    delete m[homeId];
    lsPut(m);
    const sub = await currentSub();
    if (sub && !Object.keys(m).length) await sub.unsubscribe(); // no other home on this browser uses it
  });

  const remove = (id) => act(async () => {
    await api(`/push/subscriptions/${encodeURIComponent(id)}`, { token: token(), method: "DELETE" });
  });

  const setPref = (k, v) => act(async () => {
    const r = await api("/push/prefs", { token: token(), method: "PUT", body: { [k]: v } });
    info.prefs = r.prefs;
  });

  const test = act(async () => {
    const r = await api("/push/test", { token: token(), body: {} });
    note = r.sent ? t("push.testSent", { n: r.sent }) : t("push.testNone");
    noteKind = r.sent ? "ok" : "error";
  });

  function render() {
    node.hidden = !mine || !info?.enabled;
    if (node.hidden) { node.replaceChildren(); return; }
    let action;
    if (!supported()) {
      action = el("p", { class: "muted small", text: isIos() && !standalone() ? t("push.iosHint") : t("push.unsupported") });
    } else if (thisId) {
      action = el("div", { class: "notify-row" },
        el("span", { class: "notify-on", text: t("push.on") }),
        el("button", { type: "button", class: "btn small ghost", disabled: busy, onclick: disable, text: t("push.turnOff") }));
    } else {
      action = el("button", { type: "button", class: "btn primary", disabled: busy, onclick: enable, text: t("push.enable") });
    }
    const box = (k, label) => el("label", { class: "notify-pref" },
      el("input", { type: "checkbox", checked: info.prefs[k], disabled: busy, onchange: (e) => setPref(k, e.currentTarget.checked)() }),
      el("span", { text: label }));
    const devices = info.devices.map((d) => el("li", {},
      el("span", { class: "notify-dev", text: d.label || t("push.thisBrowser") }),
      d.id === thisId ? el("span", { class: "muted small", text: t("push.thisDevice") }) : null,
      el("span", { class: "muted small", text: d.last_ok_at ? t("push.lastOk", { t: agoText(d.last_ok_at) }) : t("push.added", { t: agoText(d.created_at) }) }),
      el("button", { type: "button", class: "notice-close", disabled: busy, title: t("push.remove"), "aria-label": t("push.remove"), text: "×", onclick: remove(d.id) })));
    node.replaceChildren(
      el("h2", { text: t("push.title") }),
      el("p", { class: "muted small", text: t("push.intro") }),
      action,
      note ? el("p", { class: `small ${noteKind}`, role: "status", text: note }) : null,
      el("div", { class: "notify-prefs" }, box("waiting", t("push.prefWaiting")), box("done", t("push.prefDone"))),
      info.devices.length ? el("h3", { text: t("push.devices") }) : null,
      info.devices.length ? el("ul", { class: "notify-devices" }, ...devices) : null,
      info.devices.length ? el("button", { type: "button", class: "btn small ghost", disabled: busy, onclick: test, text: t("push.test") }) : null,
      el("p", { class: "muted small", text: t("push.privacy") }));
  }

  return {
    node,
    setMine(v) {
      if (v === mine) return;
      mine = v;
      note = "";
      if (mine) load(); else { info = null; render(); }
    },
    destroy() { dead = true; },
  };
}
