// Service worker: shows Agent Town's Web Push notifications (server/push.ts) and opens the home page on tap.
// Nothing is cached and no requests are intercepted. Payloads are {title, body, url, tag, ts}: names and status only.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch {}
  const title = typeof d.title === "string" && d.title ? d.title : "Agent Town";
  e.waitUntil(self.registration.showNotification(title, {
    body: typeof d.body === "string" ? d.body : "",
    tag: typeof d.tag === "string" ? d.tag : undefined,
    renotify: typeof d.tag === "string",
    timestamp: typeof d.ts === "number" ? d.ts : Date.now(),
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { url: typeof d.url === "string" ? d.url : "/" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  // Same-origin paths only: a payload can never send the tap anywhere else.
  let url = new URL("/", self.location.origin);
  try {
    const u = new URL(e.notification.data?.url ?? "/", self.location.origin);
    if (u.origin === self.location.origin) url = u;
  } catch {}
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).pathname === url.pathname && "focus" in w) return w.focus();
    }
    return self.clients.openWindow(url.href);
  })());
});
// pushsubscriptionchange: re-subscribing needs the owner key, which only the page has; the home page re-checks its
// subscription on every visit and offers "Notify me" again if it is gone.
