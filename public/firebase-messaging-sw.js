/* Aqua service worker: offline cache + Firebase Cloud Messaging background pushes. */
const CACHE = "aqua-202611241625";
const ASSETS = [
  "./", "./index.html", "./styles.css", "./app.js", "./firebase-config.js", "./manifest.json",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/badge-96.png", "./icons/favicon-64.png",
  "./fonts/bricolage.woff2", "./fonts/figtree.woff2",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first for our own files (so updates land), cache fallback when offline.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: "no-cache" })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("./index.html")))
  );
});

// ── Firebase Messaging ───────────────────────────────────────
try {
  importScripts("./firebase-config.js");
  const configured = self.FIREBASE_CONFIG && !String(self.FIREBASE_CONFIG.apiKey).startsWith("PASTE");
  if (configured) {
    importScripts(
      "https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js",
      "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js"
    );
    firebase.initializeApp(self.FIREBASE_CONFIG);
    const messaging = firebase.messaging();

    // The Cloud Function sends data-only messages so we control how they look here.
    messaging.onBackgroundMessage((payload) => {
      const d = payload.data || {};
      return self.registration.showNotification(d.title || "Time for some water 💧", {
        body: d.body || "A few sips keeps you on track.",
        icon: "./icons/icon-192.png",
        badge: "./icons/badge-96.png",
        tag: "aqua-reminder",
        renotify: true,
        vibrate: [80, 40, 80],
        data: { url: self.registration.scope },
        actions: [
          { action: "add-glass", title: "I drank a glass" },
          { action: "snooze", title: "Later" },
        ],
      });
    });
  }
} catch (err) {
  console.warn("[sw] messaging not initialised", err);
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  if (event.action === "snooze") return;
  const base = self.registration.scope;
  const target = event.action === "add-glass" ? base + "?add=glass" : base;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (new URL(w.url).origin === self.location.origin) {
          w.focus();
          return w.navigate(target);
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
