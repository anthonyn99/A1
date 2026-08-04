/* ============================================================================
 * StudyOS — SINGLE SOURCE OF CONFIGURATION
 * ============================================================================
 *
 * This is the ONLY file that should ever contain account-specific values.
 * Nothing else in the project hardcodes a project id, a worker URL, an email
 * address, or a form id. If you find one elsewhere, that is a bug.
 *
 * Fill every value marked  ‹REPLACE›  with your own. Until you do, StudyOS
 * still boots and works fully offline (localStorage + IndexedDB); the cloud
 * features simply stay dormant and announce themselves as "not configured"
 * instead of throwing.
 *
 * Load order matters: this file must be the FIRST script in studyos.html so
 * every later module can read window.STUDYOS_CONFIG synchronously.
 * ------------------------------------------------------------------------- */

window.STUDYOS_CONFIG = {

  /* ── 1. FIREBASE ─────────────────────────────────────────────────────────
   * Firebase console → Project settings → General → Your apps → Web app.
   * Copy the firebaseConfig object it shows you and paste the values here.
   *
   * These keys are NOT secrets. A Firebase web apiKey is a public project
   * identifier; access is controlled by Firestore security rules (see
   * firebase/firestore.rules), not by hiding this value.
   *
   * Required Firebase setup:
   *   - Firestore Database enabled (production mode)
   *   - Authentication → Sign-in method → Anonymous → ENABLED
   *   - firestore.rules deployed
   * ------------------------------------------------------------------------ */
  firebase: {
    enabled: true,
    apiKey:            '‹REPLACE:firebase-api-key›',
    authDomain:        '‹REPLACE›.firebaseapp.com',
    projectId:         '‹REPLACE:firebase-project-id›',
    storageBucket:     '‹REPLACE›.firebasestorage.app',
    messagingSenderId: '‹REPLACE:sender-id›',
    appId:             '‹REPLACE:app-id›',

    /* Firestore document paths. Safe defaults — change only if you want
     * StudyOS to share a database with other apps and need to avoid a clash. */
    paths: {
      studyos:   'dashboards/studyos',    // all StudyOS data (classes/events/tasks/notes/ksu)
      applock:   'dashboards/studyos_lock', // App Lock state, synced across devices
      reminders: 'reminders',             // scheduled push reminders (read by the cron worker)
      fcmTokens: 'fcm_tokens',            // per-device push tokens
    },

    /* Firestore refuses any single document over 1 MiB. StudyOS refuses to
     * write past this soft ceiling first, so you get a clear warning instead
     * of a hard rejection that would wedge the whole sync queue. */
    maxDocBytes: 900 * 1024,

    /* OPTIONAL hardening. App Check proves requests come from your real site,
     * so a copied apiKey can't be used from someone else's page. Leave
     * disabled until StudyOS is working end-to-end — a misconfigured App Check
     * blocks every read and write, and looks exactly like broken rules.
     * Setup: Firebase console → App Check → register the web app with
     * reCAPTCHA v3, then paste the site key here and flip enabled to true. */
    appCheck: { enabled: false, recaptchaSiteKey: '' },
  },

  /* ── 2. CLOUDFLARE WORKERS ───────────────────────────────────────────────
   * Two workers. Both run on the FREE Workers plan — no credit card, no R2,
   * no Firebase Blaze upgrade. Deploy both from workers/ (see README step 5).
   * ------------------------------------------------------------------------ */
  cloudflare: {

    /* studyos-files — cross-device file storage on Workers KV.
     * File BLOBS live here, not in Firebase Storage (which needs the paid
     * Blaze plan). Firestore only ever stores the metadata + the URL.
     * After `wrangler deploy`, paste the URL it prints. */
    filesWorker: {
      enabled: true,
      baseUrl: 'https://‹REPLACE:studyos-files›.‹REPLACE:your-subdomain›.workers.dev',
      /* Free-plan KV ceilings, used by the storage indicator in the UI.
       * A single KV value caps at 25 MB, so larger files are split
       * client-side into parts; the worker reassembles them on GET. */
      maxValueBytes: 24 * 1024 * 1024,
      capacityBytes: 1024 * 1024 * 1024,
    },

    /* studyos-api — App Lock password hashing (KV) + the reminder cron that
     * delivers push notifications through FCM. */
    apiWorker: {
      enabled: true,
      baseUrl: 'https://‹REPLACE:studyos-api›.‹REPLACE:your-subdomain›.workers.dev',
      /* KV namespace prefix for lock records. Anything stable works. */
      lockNamespace: 'studyos_applock',
    },
  },

  /* ── 3. FORMSPREE ────────────────────────────────────────────────────────
   * Used ONLY to email a password hint / reset code to the owner when the
   * App Lock password is forgotten. formspree.io → New Form → copy the
   * endpoint. The free tier (50 submissions/month) is far more than enough.
   *
   * ownerEmail must be the address you want hints delivered to. Formspree
   * sends a one-time confirmation to it on the first submission.
   * ------------------------------------------------------------------------ */
  formspree: {
    enabled: true,
    endpoint:   'https://formspree.io/f/‹REPLACE:form-id›',
    ownerEmail: '‹REPLACE:your-email@example.com›',
  },

  /* ── 4. PUSH NOTIFICATIONS (FCM) ─────────────────────────────────────────
   * Powers reminders that fire when StudyOS is CLOSED. Requires:
   *   a) Firebase console → Project settings → Cloud Messaging → Web Push
   *      certificates → Generate key pair. Paste the public key as vapidKey.
   *   b) firebase/firebase-messaging-sw.js served from your site ROOT, with
   *      its own copy of the firebase values (a service worker cannot read
   *      this file).
   *   c) The studyos-api worker deployed with a service-account secret so its
   *      cron can send messages. See README step 6.
   *
   * Set enabled:false to run reminders as in-app banners only — StudyOS then
   * needs no service worker, no VAPID key, and no cron worker.
   *
   * NOTE: push requires HTTPS (or localhost). It will not work over file://.
   * ------------------------------------------------------------------------ */
  push: {
    enabled: true,
    vapidKey: '‹REPLACE:vapid-public-key›',
    swPath: '/firebase-messaging-sw.js',
    /* Brave on desktop ships with push OFF by default under
     * Settings → Privacy and security → "Use Google services for push
     * messaging". In-app banners still work; closed-app push silently will
     * not until that toggle is on. This is a browser setting, not a bug. */
  },

  /* ── 5. APP LOCK ─────────────────────────────────────────────────────────
   * Gates the ENTIRE app behind a password before any data is shown.
   * ------------------------------------------------------------------------ */
  appLock: {
    enabled: true,
    id: 'studyos',              // KV record key; only matters if you host several locks
    label: 'StudyOS',           // shown in the overlay + hint email subject
    accent: '#8D769A',
    /* Offer the device biometric (Face ID / Touch ID / Windows Hello /
     * Android fingerprint) as a faster unlock once the password is set.
     * Uses WebAuthn — the app never sees or stores biometric data. */
    biometrics: true,
  },

  /* ── 6. APP SHELL ────────────────────────────────────────────────────────
   * Header buttons linking StudyOS to the rest of your V1 project. Leave the
   * array empty for a pure standalone app; add entries once V1 has siblings.
   *   { label: 'Journal', href: '/journal.html' }
   * ------------------------------------------------------------------------ */
  shell: {
    title: 'StudyOS',
    accent: '#8D769A',
    nav: [],
  },

  /* ── 7. TASK MIRROR → TaskHub in the Index project ───────────────────────
   * StudyOS pushes its dated tasks and events into Veda's weekly TaskHub,
   * which lives in a DIFFERENT deployment (the Index project).
   *
   * HOW IT WORKS. Originally both apps shared one page, so the mirror was
   * plain in-page function calls. Across two separately-hosted pages that is
   * impossible, so the transport is now shared Firestore, using two documents
   * with EXACTLY ONE WRITER EACH — neither side can ever clobber the other:
   *
   *   mirrorDoc   StudyOS WRITES, TaskHub READS
   *               the full set of StudyOS-derived items, rebuilt from source
   *               on every change (so it is self-healing and can't drift)
   *
   *   ackDoc      TaskHub WRITES, StudyOS READS
   *               done-state flips, so ticking a StudyOS task inside TaskHub
   *               checks it off in StudyOS too
   *
   * REQUIREMENT: both apps must reach the SAME Firestore database. Two ways:
   *
   *   a) Simplest — point §1 `firebase` at the Index project. StudyOS's own
   *      data and the mirror then share one project and one connection, and
   *      you can leave `firebase: null` below.
   *
   *   b) Keep StudyOS's data in your OWN Firebase project and reach the Index
   *      project only for the mirror. Fill in the `firebase` block below with
   *      the Index project's web config; StudyOS opens a second, separate
   *      Firebase connection just for these two documents.
   *
   * Set enabled:false to run StudyOS completely standalone — it then keeps
   * every feature except this one-way push into TaskHub.
   * ------------------------------------------------------------------------ */
  taskMirror: {
    enabled: true,

    /* Document paths in whichever project serves the mirror. These must match
     * what the Index side listens on — do not change one without the other. */
    mirrorDoc: 'dashboards/studyos_mirror',
    ackDoc:    'dashboards/studyos_mirror_ack',

    /* Leave null to use the §1 Firebase project (option a above). To reach a
     * DIFFERENT project (option b), paste that project's web config here:
     *   firebase: { apiKey:'…', authDomain:'…', projectId:'…',
     *               storageBucket:'…', messagingSenderId:'…', appId:'…' }
     * Anonymous auth must be enabled on that project too. */
    firebase: null,

    /* Items are tagged so TaskHub can tell them apart from its own tasks and
     * reconcile them safely:
     *   _sosId          stable per StudyOS task/event  ('t_<taskId>' | '<eventId>')
     *   _sosRepeatId    groups occurrences of one repeating series
     *   _sosClassName   class label shown as a badge in TaskHub
     *   _sosClassColor  badge color (mapped through sosPastel on the TaskHub side)
     *
     * dateKey format is 'YYYY-MM-DD', zero-padded, month 1-based — the same
     * key TaskHub's own dkey() produces. */
  },
};

/* ── Config sanity check ────────────────────────────────────────────────────
 * Any value still containing ‹REPLACE› means that feature is unconfigured.
 * Modules call STUDYOS_CONFIG_READY(section) to decide whether to activate,
 * so a half-migrated project degrades cleanly instead of throwing. */
window.STUDYOS_CONFIG_READY = function (section) {
  var c = window.STUDYOS_CONFIG || {};
  var node = section ? c[section] : c;
  if (!node) return false;
  if (node.enabled === false) return false;
  var unresolved = false;
  (function walk(o, depth) {
    if (!o || depth > 4) return;
    Object.keys(o).forEach(function (k) {
      var v = o[k];
      if (typeof v === 'string' && v.indexOf('‹REPLACE') !== -1) unresolved = true;
      else if (v && typeof v === 'object') walk(v, depth + 1);
    });
  })(node, 0);
  return !unresolved;
};
