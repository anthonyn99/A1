/* ============================================================================
 * StudyOS — SINGLE SOURCE OF CONFIGURATION
 * ============================================================================
 *
 * This is the ONLY file that should ever contain account-specific values.
 * Nothing else in the project hardcodes a project id, a worker URL, an email
 * address, or a form id. (The one unavoidable exception is
 * firebase/firebase-messaging-sw.js — a service worker runs in its own global
 * scope and cannot read this file, so the Firebase values are duplicated there.
 * They are already correct and match §1.)
 *
 * ── WHAT STILL NEEDS FILLING IN ──────────────────────────────────────────
 * Only values marked  ‹REPLACE›  — the two Cloudflare Worker URLs (§2) and
 * Formspree (§3). Everything else is finished.
 *
 * §1 FIREBASE IS ALREADY CORRECT and points at the INDEX project on purpose.
 * That is a requirement, not a leftover: the TaskHub task mirror (§7) needs
 * both apps in one Firestore database, and StudyOS's existing data already
 * lives there. Do not repoint it at a new project.
 *
 * Until the remaining values are filled in, StudyOS still boots and works
 * fully offline (localStorage + IndexedDB); those cloud features simply stay
 * dormant and announce themselves as "not configured" instead of throwing.
 *
 * Load order matters: this file must be the FIRST script in studyos.html so
 * every later module can read window.STUDYOS_CONFIG synchronously.
 * ------------------------------------------------------------------------- */

window.STUDYOS_CONFIG = {

  /* ── 1. FIREBASE — the INDEX project ─────────────────────────────────────
   * StudyOS deliberately uses the SAME Firebase project as Index. This is not
   * a placeholder to replace: these are the real, correct values.
   *
   * WHY THE INDEX PROJECT AND NOT A NEW ONE:
   *   1. The task mirror (§7) needs both apps in one Firestore database. That
   *      is a hard requirement, not a preference — Firestore cannot read across
   *      projects.
   *   2. StudyOS's data already lives here, at dashboards/studyos. Pointing
   *      somewhere else would strand every class, task, note and file that
   *      exists today. Keeping this config means the move is seamless: open
   *      StudyOS in V1 and the existing data is simply there.
   *
   * These keys are NOT secrets. A Firebase web apiKey is a public project
   * identifier — it already ships in Index's own HTML. Access is controlled by
   * Firestore security rules, not by hiding this value.
   *
   * The project is already fully set up (Firestore on, Anonymous auth enabled,
   * rules published). Nothing in §1 needs doing.
   * ------------------------------------------------------------------------ */
  firebase: {
    enabled: true,
    apiKey:            'AIzaSyC2aKunOKj5WS8NpgZhpyMzOYecBr5t2_4',
    authDomain:        'task-dashboard-d2b53.firebaseapp.com',
    projectId:         'task-dashboard-d2b53',
    storageBucket:     'task-dashboard-d2b53.firebasestorage.app',
    messagingSenderId: '982539604706',
    appId:             '1:982539604706:web:e93da1aef499fcee2044bb',

    /* Firestore paths.
     *
     * studyos / applock keep the documents StudyOS already owns — do NOT
     * rename them or the existing data disappears from the app's point of view.
     *
     * reminders / fcmTokens are DELIBERATELY namespaced away from Index's own
     * `reminders` and `fcm_tokens` collections. Index runs its own reminder
     * cron over those; if StudyOS wrote there too, both crons would sweep the
     * same documents — duplicate notifications and a race on the delete. The
     * studyos_ prefix keeps the two systems from ever touching. */
    paths: {
      studyos:   'dashboards/studyos',        // classes / events / tasks / notes / ksu (existing)
      applock:   'dashboards/studyos_lock',   // App Lock state, synced across devices
      reminders: 'studyos_reminders',         // swept by studyos-api's cron ONLY
      fcmTokens: 'studyos_fcm_tokens',        // StudyOS's own device tokens
    },

    /* Firestore refuses any single document over 1 MiB. StudyOS refuses to
     * write past this soft ceiling first, so you get a clear warning instead
     * of a hard rejection that would wedge the whole sync queue. */
    maxDocBytes: 900 * 1024,

    /* ⚠️ APP CHECK — ON, and there is a REQUIRED manual step. Read this.
     *
     * The Index project enforces App Check on Firestore. Index's own page
     * registers reCAPTCHA v3 with the site key below, unconditionally; StudyOS
     * now does the same, because it talks to the same database and would
     * otherwise be rejected outright.
     *
     * REQUIRED: reCAPTCHA site keys are DOMAIN-RESTRICTED. V1's domain must be
     * added to this key's allowed-domain list or every read and write fails
     * with permission-denied:
     *
     *   Google Cloud console → Security → reCAPTCHA → this key → Domains
     *   → add V1's host (and 'localhost' / '127.0.0.1' for local testing)
     *
     * This was verified, not assumed: served from an un-allowlisted origin,
     * StudyOS and Index's own index.html fail identically —
     * `appCheck/recaptcha-error` followed by permission-denied on every
     * operation — while index.html works normally in production.
     *
     * HOW TO RECOGNISE IT: the console logs `appCheck/recaptcha-error`
     * alongside the denials. A plain auth problem denies without that line.
     *
     * Setting enabled:false does NOT work around it — with enforcement on, a
     * request carrying no App Check token at all is refused just the same. The
     * domain has to be allowlisted. */
    /* Site key is public — it ships in the page by design. The matching secret
     * lives only in Firebase App Check.
     *
     * ⛔ DO NOT CHANGE THIS KEY. It is Index's ORIGINAL key, shared by all
     * seven apps on the task-dashboard-d2b53 Firebase project.
     *
     * 2026-08-04: a new key was created here and its secret saved into Firebase
     * App Check. App Check allows only ONE reCAPTCHA key per app, so that
     * silently evicted this key and took ALL SEVEN apps offline the next
     * morning — permission-denied on every read and write, project-wide.
     * 2026-08-05: the original secret was restored in Firebase and this config
     * pointed back at the original key.
     *
     * This Worker's domain is already allowlisted on this key. If App Check
     * ever fails from here, fix the allowlist — never swap the key. */
    appCheck: { enabled: true, recaptchaSiteKey: '6LeUyAstAAAAAEciRypd1i4Akq6ueFUYfXLaLaUX' },
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
      baseUrl: 'https://studyos-files.vedapatel05.workers.dev',
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
      baseUrl: 'https://studyos-api.vedapatel05.workers.dev',
      /* KV namespace prefix for lock records. Anything stable works. */
      lockNamespace: 'studyos_applock',
    },

    /* studyos-d2l — Brightspace calendar import.
     *
     * SCOPE, AND WHY IT IS THIS SMALL: the only Brightspace data a student can
     * reach without an admin-registered OAuth client is the CALENDAR ICS FEED.
     * Grades, announcements and course files all require the D2L Valence API,
     * which an institution must approve. Those are a later phase gated on that
     * approval — see ARCHITECTURE.md section 8. Do NOT add them by scraping
     * HTML with a session cookie: that breaks on every Brightspace release and
     * violates most institutional acceptable-use policies.
     *
     * The feed URL is deliberately NOT in this file. It is a bearer capability
     * — anyone holding it can read the whole calendar — and this file is served
     * publicly at /studyos/config/config.js. It lives only in the worker's KV,
     * set at runtime through POST /feed/set. */
    d2l: {
      enabled: true,
      baseUrl: 'https://studyos-d2l.vedapatel05.workers.dev',
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
    /* Shared with TradeBoard's App Lock (see TradeBoard/tradeboard.html,
     * TB_SECURITY) rather than a second form: one Formspree inbox for the whole
     * V1 suite, and the free tier's 50 submissions/month covers both apps many
     * times over. Reusing it also means the address is already confirmed — a new
     * form would sit silent until someone clicked Formspree's activation email. */
    endpoint:   'https://formspree.io/f/xrenqnrp',
    ownerEmail: 'vedapatel05@gmail.com',
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
    /* Web Push certificate for the Index project. Same project → same key, so
     * this is already correct and needs no change. */
    vapidKey: 'BFCxQOzVGu7pcftOtBrRY3IN9OuAWoiuYYO6lULbwzlF3hDTRVzNrW_uDvGDX1F4jZfVLXKxxsIj20sH8UZwmN8',
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
    /* Deliberately EMPTY: StudyOS is used as its own app, so the header carries
     * nothing but the title and the App Lock button. The sibling apps are still
     * served by the same Worker (TradeBoard at /, Finance at /finance/) — they
     * just aren't advertised from here. Re-add entries to bring the links back:
     *   { label: 'TradeBoard', href: '/' }
     * Absolute paths, because StudyOS is served from /studyos/ and a relative
     * href would resolve inside it. */
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
   * REQUIREMENT — ALREADY SATISFIED: both apps must reach the same Firestore
   * database, and §1 points StudyOS at the Index project, so they do. Nothing
   * to configure here. Leave `firebase` null.
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

    /* Native-app paths for per-class resources, read by the Shield desktop
     * agent so a TaskHub launch button can open them. Deliberately a THIRD
     * document rather than a field on mirrorDoc: absolute local paths would
     * otherwise be published into a document that phones read, leaking the
     * filesystem layout for no benefit — TaskHub only needs to know that apps
     * exist, never where they live. StudyOS writes, Shield reads. */
    classAppsDoc: 'dashboards/studyos_class_apps',

    /* null = use the §1 connection, which is what you want: §1 already points
     * at the Index project, so the mirror is reachable over the same socket.
     *
     * This exists only as an escape hatch. If StudyOS were ever moved onto a
     * separate Firebase project, paste the INDEX project's web config here and
     * StudyOS opens a second named connection ('studyos-mirror') purely for
     * these two documents. Anonymous auth would then be needed on both. */
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
