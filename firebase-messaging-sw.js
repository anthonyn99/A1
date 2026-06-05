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

const messaging = firebase.messaging();

// The Worker sends BOTH a `notification` and a `webpush.notification` payload.
// For notification-type messages the FCM SW auto-displays, and on most browsers
// onBackgroundMessage is NOT invoked — so we keep this handler minimal and
// guard against showing a duplicate. It mainly covers data-only edge cases.
messaging.onBackgroundMessage(function(payload){
  const n = payload.notification || {};
  const d = payload.data || {};
  const title = n.title || '\u2726 TaskHub';
  const body  = n.body  || d.title || 'Task reminder';
  const tag   = d.id || ('th_' + Date.now());
  self.registration.showNotification(title, {
    body: body,
    tag: tag,
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
