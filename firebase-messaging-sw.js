// firebase-messaging-sw.js
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

// Fires for ALL messages (foreground and background).
// tag deduplicates — if somehow called twice for same id, only 1 notification shows.
messaging.onBackgroundMessage(payload => {
  const body = payload.notification?.body || payload.data?.title || 'Task reminder';
  const id   = payload.data?.id || 'taskhub-reminder';

  return self.registration.showNotification('✦ TaskHub', {
    body,
    tag: id,
    renotify: false,
    requireInteraction: false,
    silent: false,
    data: payload.data || {}
  });
});

// Notification click — focus or open app
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url && c.url.includes(self.registration.scope));
      if (existing) return existing.focus();
      return self.clients.openWindow(self.registration.scope);
    })
  );
});
