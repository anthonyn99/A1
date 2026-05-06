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

// onBackgroundMessage fires when app is NOT focused.
// When app IS focused, onMessage in the page fires instead and calls
// reg.showNotification directly — so we never get double OS notifications.
messaging.onBackgroundMessage(payload => {
  const body = payload.notification?.body || payload.data?.title || 'Task reminder';
  const id   = payload.data?.id || 'taskhub-reminder';

  // Extra guard: skip if a visible client exists (page already handled it)
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
    if (clients.some(c => c.visibilityState === 'visible')) return;
    return self.registration.showNotification('✦ TaskHub', {
      body,
      tag: id,
      renotify: false,
      requireInteraction: false,
      silent: false,
      data: payload.data || {}
    });
  });
});

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
