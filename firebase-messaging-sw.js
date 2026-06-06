/* firebase-messaging-sw.js
 * MUST live at the SITE ROOT (same folder as index.html) so the scope './'
 * registration in index.html resolves to it. Without this file, getToken()
 * fails and NO background FCM push is ever delivered to the device.
 */
importScripts('https://www.gstatic.com/firebasejs/12.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyC2aKunOKj5WS8NpgZhpyMzOYecBr5t2_4",
  authDomain: "task-dashboard-d2b53.firebaseapp.com",
  projectId: "task-dashboard-d2b53",
  storageBucket: "task-dashboard-d2b53.firebasestorage.app",
  messagingSenderId: "982539604706",
  appId: "1:982539604706:web:e93da1aef499fcee2044bb"
});

// SW_VERSION — bump to force phones to discard any stale cached service worker.
// A pre-fix SW that drew every reminder with a FIXED tag caused push #2 (e.g. a
// task) to REPLACE push #1 (e.g. an event) fired at the same minute, so only one
// showed on mobile. Changing these bytes makes the browser install this build,
// and skipWaiting + clients.claim below swap it in immediately.
const SW_VERSION = '2026-06-06-multinotif';

const messaging = firebase.messaging();

// Take over promptly when this file changes, so the data-only handler below
// replaces any older cached service worker without needing a manual unregister.
self.addEventListener('install', function(){ self.skipWaiting(); });
self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); });

// Messages are DATA-ONLY, so this runs for EVERY message (no SDK auto-display
// race) and we draw each with a UNIQUE tag → multiple same-minute reminders
// never collapse into one and none get dropped.
messaging.onBackgroundMessage(function(payload){
  const d = payload.data || {};
  const body  = d.body || d.title || 'Task reminder';
  const tag   = (d.id || 'th') + '_' + Date.now() + '_' + Math.random().toString(36).slice(2,7);
  self.registration.showNotification('\u2726 TaskHub', {
    body: body,
    tag: tag,
    renotify: true,
    requireInteraction: true,
    icon: 'data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A//www.w3.org/2000/svg%27%20viewBox%3D%270%200%2096%2096%27%3E%3Crect%20width%3D%2796%27%20height%3D%2796%27%20rx%3D%2722%27%20fill%3D%27%234a7c59%27/%3E%3Ctext%20x%3D%2750%25%27%20y%3D%2765%25%27%20text-anchor%3D%27middle%27%20font-size%3D%2756%27%3E%E2%9C%93%3C/text%3E%3C/svg%3E'
  });
});

// Focus / open the app when a notification is tapped.
self.addEventListener('notificationclick', function(event){
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list){
      for (const c of list) { if ('focus' in c) return c.focus(); }
      if (clients.openWindow) return clients.openWindow('./');
    })
  );
});
