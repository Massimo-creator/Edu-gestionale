// Approdo: service worker solo per le notifiche push (nessuna cache delle pagine).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Approdo', {
    body: d.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    data: { url: d.url || '/' }
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  const ospite = new URL(url, self.location.origin).searchParams.get('ospite');
  e.waitUntil((async () => {
    const tutte = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of tutte) {
      if (new URL(c.url).origin === self.location.origin) {
        await c.focus();
        if (ospite) c.postMessage({ ospite });
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
