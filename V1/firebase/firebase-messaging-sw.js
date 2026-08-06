/* ============================================================================
 * StudyOS — Firebase Cloud Messaging service worker
 * ============================================================================
 * DEPLOYMENT: this file MUST be served from your site's ROOT, at
 *   https://your-site/firebase-messaging-sw.js
 * A service worker can only control pages at or below its own path, and the
 * FCM SDK looks for it at the root by default. Copy it out of firebase/ and
 * into the web root when you deploy — do not leave it in a subfolder.
 *
 * IMPORTANT: a service worker runs in its own global scope and CANNOT read
 * config/config.js. The Firebase values below are duplicated on purpose —
 * unavoidable, not an oversight. They are already correct (the Index project,
 * matching config §1) and need no editing.
 *
 * ⚠️ If V1 already has its own firebase-messaging-sw.js at the root for another
 * app, do NOT overwrite it. Two service workers cannot both own the root scope.
 * Merge instead: keep the existing file and add this file's
 * onBackgroundMessage / notificationclick handling to it, branching on
 * payload.data.app === 'studyos'. The StudyOS worker tags every message it
 * sends with that field precisely so the two can share one service worker.
 * ------------------------------------------------------------------------- */

importScripts('https://www.gstatic.com/firebasejs/12.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.12.0/firebase-messaging-compat.js');

/* The Index project — same values as config/config.js §1. Already correct. */
firebase.initializeApp({
  apiKey:            'AIzaSyC2aKunOKj5WS8NpgZhpyMzOYecBr5t2_4',
  authDomain:        'task-dashboard-d2b53.firebaseapp.com',
  projectId:         'task-dashboard-d2b53',
  storageBucket:     'task-dashboard-d2b53.firebasestorage.app',
  messagingSenderId: '982539604706',
  appId:             '1:982539604706:web:e93da1aef499fcee2044bb',
});

const messaging = firebase.messaging();

/* The worker sends DATA-ONLY messages (no `notification` block) precisely so
 * this handler runs for EVERY message. If the payload carried a `notification`
 * block, the browser would auto-display it and could silently collapse two
 * reminders that fired in the same minute. Drawing it ourselves with a unique
 * tag guarantees each one appears. */
messaging.onBackgroundMessage(function (payload) {
  const d = (payload && payload.data) || {};
  const title = d.title || 'StudyOS reminder';
  const body  = d.body || 'StudyOS';

  return self.registration.showNotification(title, {
    body: body,
    icon: '/assets/icon-192.png',
    badge: '/assets/icon-192.png',
    // Unique tag per reminder id + timestamp: same-minute reminders must not
    // replace one another in the notification tray.
    tag: 'studyos_' + (d.id || Date.now()),
    renotify: true,
    requireInteraction: false,
    data: { id: d.id || '', url: '/studyos.html' },
  });
});

/* Focus an existing StudyOS tab if one is open; otherwise open a new one. */
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/studyos.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (const client of list) {
        if (client.url.indexOf('studyos') !== -1 && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

/* Take over immediately on update rather than waiting for every tab to close —
 * otherwise a fixed service worker sits idle behind an old one for days. */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });
