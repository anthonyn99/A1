// TaskHub Service Worker — background notifications
// Lives at repo root next to index.html

const VERSION = 'th-sw-v2';
const pending = {}; // id -> timeoutId

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// ── Messages from the page ────────────────────────────────────────────────
self.addEventListener('message', e => {
  const msg = e.data;
  if (!msg || !msg.type) return;

  if (msg.type === 'TH_SCHEDULE') {
    const { id, title, notifyAt } = msg;
    if (!id || !title || !notifyAt) return;
    const delay = new Date(notifyAt).getTime() - Date.now();
    if (delay <= 0 || delay > 7 * 86400000) return;

    // Clear any existing timer for this id
    if (pending[id]) clearTimeout(pending[id]);

    pending[id] = setTimeout(async () => {
      delete pending[id];
      // Check if a page is visible — if so, tell it to show the banner instead
      const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const visible = allClients.find(c => c.visibilityState === 'visible');
      if (visible) {
        visible.postMessage({ type: 'TH_FOREGROUND_FIRE', id, title });
        return;
      }
      // No visible page — fire native OS notification
      await self.registration.showNotification('🔔 TaskHub', {
        body: title,
        tag: id,
        renotify: true,
        requireInteraction: false,
        silent: false,
        data: { id, title }
      });
      // Broadcast to any background clients so they can mark fired
      allClients.forEach(c => c.postMessage({ type: 'TH_FIRED', id }));
    }, delay);
  }

  if (msg.type === 'TH_CANCEL') {
    const { id } = msg;
    if (pending[id]) { clearTimeout(pending[id]); delete pending[id]; }
    // Also close any existing notification with this tag
    self.registration.getNotifications({ tag: id }).then(notifs => notifs.forEach(n => n.close()));
  }
});

// ── Notification click → open / focus the app ────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // Focus existing tab if open
      const existing = list.find(c => c.url && (c.url.includes('index') || c.url === self.registration.scope));
      if (existing) return existing.focus();
      // Otherwise open a new tab
      return self.clients.openWindow(self.registration.scope);
    })
  );
});
