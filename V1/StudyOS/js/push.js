/* ============================================================================
 * StudyOS — reminders & push notifications
 * ============================================================================
 * Publishes the two globals the app already calls:
 *
 *   window.thScheduleNotif({ id, title, notifyAt, ... })
 *   window.thCancelNotif(id)
 *
 * The original implementation lived in the host page and was wired into
 * TaskHub's own data model (it scanned td6_data / td6_habits). This is a
 * self-contained rewrite with the same call signature, so js/studyos.js calls
 * it unchanged.
 *
 * TWO DELIVERY PATHS, deliberately both:
 *
 *   1. LOCAL POLL  — a timer in this tab. Fires an in-app banner while StudyOS
 *      is OPEN. Always active; needs no config, no service worker, no network.
 *
 *   2. FCM PUSH    — a document written to Firestore /reminders. The
 *      studyos-api Worker's cron sweeps documents whose notifyAt has passed,
 *      sends them through FCM, and deletes them. This is what fires when
 *      StudyOS is CLOSED. Requires config.push.enabled + a VAPID key + the
 *      service worker at the site root + the deployed cron worker.
 *
 * Path 2 degrades to nothing if unconfigured — path 1 keeps working, so
 * reminders are never silently lost while the app is open.
 *
 * KNOWN BROWSER GOTCHA: Brave on desktop ships with
 * Settings → Privacy and security → "Use Google services for push messaging"
 * turned OFF. In-app banners still appear; closed-app push silently will not
 * arrive until that toggle is on. This is a browser setting, not a bug.
 * ------------------------------------------------------------------------- */
(function () {
  'use strict';

  var CFG      = window.STUDYOS_CONFIG || {};
  var PUSH_CFG = CFG.push || {};
  var PUSH_OK  = !!(window.STUDYOS_CONFIG_READY && window.STUDYOS_CONFIG_READY('push'));

  var REG_KEY  = 'studyos_reminders';   // local registry
  var POLL_MS  = 30 * 1000;
  // Fire anything due within the last 5 minutes. A tab that was asleep (laptop
  // lid, backgrounded phone) wakes up past the mark; without this window every
  // reminder it slept through would be silently skipped.
  var GRACE_MS = 5 * 60 * 1000;

  /* ── Local registry ─────────────────────────────────────────────────────── */
  function readReg() {
    try { return JSON.parse(localStorage.getItem(REG_KEY) || '{}') || {}; }
    catch (e) { return {}; }
  }
  function writeReg(r) {
    try { localStorage.setItem(REG_KEY, JSON.stringify(r)); } catch (e) {}
  }

  /* ── Permission ─────────────────────────────────────────────────────────── */
  var _askedPerm = false;
  function askPerm() {
    if (_askedPerm) return;
    _askedPerm = true;
    try {
      if (!('Notification' in window)) return;
      if (Notification.permission === 'default') Notification.requestPermission().catch(function () {});
    } catch (e) {}
  }

  /* ── Delivery while the app is open ─────────────────────────────────────── */
  function deliverLocal(entry) {
    // Prefer StudyOS's own in-app toast so the styling matches the app.
    if (typeof window.showNotif === 'function') {
      try { window.showNotif('<svg class="soi" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 9a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>', 'Reminder', entry.title || 'StudyOS reminder'); } catch (e) {}
    }
    // And a real OS notification if the user granted permission, so it's
    // visible even when StudyOS is in a background tab.
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        var n = new Notification(entry.title || 'StudyOS reminder', {
          body: 'StudyOS', tag: entry.id, icon: PUSH_CFG.icon || undefined,
        });
        n.onclick = function () { try { window.focus(); n.close(); } catch (e) {} };
      }
    } catch (e) {}
  }

  function poll() {
    var reg = readReg();
    var now = Date.now();
    var changed = false;
    Object.keys(reg).forEach(function (id) {
      var e = reg[id];
      if (!e || e.fired) return;
      var at = new Date(e.notifyAt).getTime();
      if (isNaN(at) || at > now) return;
      if (now - at > GRACE_MS) { e.fired = true; changed = true; return; }  // too stale to shout about
      deliverLocal(e);
      e.fired = true;
      changed = true;
    });
    // Garbage-collect fired entries after a day so the registry can't grow
    // without bound across a school year.
    Object.keys(reg).forEach(function (id) {
      var e = reg[id];
      if (e && e.fired && (now - new Date(e.notifyAt).getTime()) > 24 * 60 * 60 * 1000) {
        delete reg[id]; changed = true;
      }
    });
    if (changed) writeReg(reg);
  }

  /* ── FCM registration ───────────────────────────────────────────────────── */
  var _fcmReady = false;
  async function initFcm() {
    if (!PUSH_OK || PUSH_CFG.enabled === false) return;
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    if (!window.isSecureContext) {
      console.info('[StudyOS] Push needs HTTPS (or localhost) — in-app reminders still work.');
      return;
    }
    try {
      if (!('Notification' in window) || Notification.permission !== 'granted') return;

      var swReg = await navigator.serviceWorker.register(PUSH_CFG.swPath || '/firebase-messaging-sw.js');
      var appMod = await import('https://www.gstatic.com/firebasejs/12.12.0/firebase-app.js');
      var msgMod = await import('https://www.gstatic.com/firebasejs/12.12.0/firebase-messaging.js');

      var FB = CFG.firebase || {};
      // getApps() avoids a duplicate-app error: firebase-sync.js already
      // initialized the default app on this page.
      var apps = appMod.getApps ? appMod.getApps() : [];
      var app = apps.length ? apps[0] : appMod.initializeApp({
        apiKey: FB.apiKey, authDomain: FB.authDomain, projectId: FB.projectId,
        storageBucket: FB.storageBucket, messagingSenderId: FB.messagingSenderId, appId: FB.appId,
      });

      var messaging = msgMod.getMessaging(app);
      var token = await msgMod.getToken(messaging, {
        vapidKey: PUSH_CFG.vapidKey,
        serviceWorkerRegistration: swReg,
      });
      if (token && window._fbSaveFcmToken) {
        await window._fbSaveFcmToken(token);
        _fcmReady = true;
      }
      // Foreground messages don't auto-display — show them ourselves.
      msgMod.onMessage(messaging, function (payload) {
        var n = (payload && payload.notification) || {};
        if (typeof window.showNotif === 'function') {
          try { window.showNotif('<svg class="soi" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 9a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>', n.title || 'Reminder', n.body || ''); } catch (e) {}
        }
      });
    } catch (e) {
      console.warn('[StudyOS] Push setup failed (in-app reminders unaffected):', e && e.message);
    }
  }

  /* ── Public API ─────────────────────────────────────────────────────────── */

  /* Scheduling is AUTHORITATIVE: re-scheduling an id always overwrites whatever
   * was there, including a previously-cancelled entry. Otherwise a reminder the
   * user removed and then re-added would be silently refused. */
  /* WRITE FLOOD (2026-09-30): studyos.js calls these for EVERY event and task
   * on every render (scheduleNotifications runs on each sync update). Each call
   * used to hit Firestore: a setDoc per future reminder and a deleteDoc per item
   * WITHOUT one, whether or not a reminder document had ever existed. Veda's
   * queue held 2,857 unsent writes, 2,852 of them reminder deletes, and one boot
   * queued 800+ more. Firestore sends writes in order, so every real save
   * (classes, the TaskHub mirror) waited behind them and timed out: "sync
   * failed", and work never reaching TaskHub. Now an unchanged reminder is not
   * rewritten, and the render sweep deletes only reminders this device made. */
  window.thScheduleNotif = async function (item) {
    if (!item || !item.id || !item.notifyAt) return;
    var at = new Date(item.notifyAt).getTime();
    if (isNaN(at)) return;

    askPerm();

    var reg = readReg();
    var prev = reg[item.id];
    var title = item.title || 'StudyOS reminder';
    var same = !!(prev && prev.notifyAt === item.notifyAt && prev.title === title);
    reg[item.id] = {
      id: item.id,
      title: title,
      notifyAt: item.notifyAt,
      fired: same ? !!prev.fired : false,
      saved: same ? !!prev.saved : false,
    };
    writeReg(reg);
    if (same && prev.saved) return;          // already in Firestore, unchanged

    // Server-side leg: only meaningful in the future, and only if push is set up.
    if (PUSH_OK && PUSH_CFG.enabled !== false && window._fbSaveReminder && at > Date.now()) {
      // Marked as soon as the write is queued: the persistent cache keeps it
      // until it lands, and awaiting the server here would re-queue it on every
      // render while the network is slow.
      reg[item.id].saved = true; writeReg(reg);
      try {
        await window._fbSaveReminder({
          id: item.id,
          title: item.title || 'StudyOS reminder',
          body: item.body || 'StudyOS',
          notifyAt: at,               // epoch ms — what the cron compares against
          app: 'studyos',
          createdAt: Date.now(),
        });
      } catch (e) {}
    }
  };

  // An explicit cancel (the user edited or deleted the item): always delete,
  // since another device may have written the reminder.
  window.thCancelNotif = async function (id) {
    if (!id) return;
    var reg = readReg();
    if (reg[id]) { delete reg[id]; writeReg(reg); }
    if (window._fbDeleteReminder) { try { await window._fbDeleteReminder(id); } catch (e) {} }
  };
  // The render sweep's cancel: only a reminder this device scheduled can need
  // deleting. Every device runs the same sweep over the same data, so the one
  // that wrote a reminder is the one that removes it.
  window.thCancelNotifIfKnown = function (id) {
    if (!id) return;
    var reg = readReg();
    if (!reg[id]) return;
    return window.thCancelNotif(id);
  };

  /* Exposed so the app (or a settings button) can prompt for permission and
   * bring up push on demand rather than only at boot. */
  window.sosEnablePush = async function () {
    try {
      if (!('Notification' in window)) return false;
      var p = Notification.permission;
      if (p === 'default') p = await Notification.requestPermission();
      if (p !== 'granted') return false;
      await initFcm();
      return _fcmReady;
    } catch (e) { return false; }
  };

  /* ── Start ──────────────────────────────────────────────────────────────── */
  function start() {
    poll();
    setInterval(poll, POLL_MS);
    // A tab that was backgrounded doesn't get reliable timers; sweep on return.
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') poll();
    });
    initFcm();
  }

  // Delayed so it never competes with first paint or the App Lock overlay.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(start, 2000); });
  } else {
    setTimeout(start, 2000);
  }
})();
