// Service worker de la app de pedidos: recibe las notificaciones y abre el panel al tocarlas.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data.json(); } catch { d = { title: "Importcap", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Nuevo pedido", {
    body: d.body || "", icon: "/admin/icon-192.png", badge: "/admin/icon-192.png",
    tag: d.tag || undefined, renotify: !d.silent, silent: !!d.silent, vibrate: d.silent ? undefined : [200, 100, 200], data: { url: d.url || "/admin" }
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = e.notification.data && e.notification.data.url || "/admin";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(cs => {
    for (const c of cs) if (c.url.includes("/admin")) { c.navigate(url); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
