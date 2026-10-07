/* ============================================================================
 * StudyOS — module boot  (upgrade spec Phase 1 wiring)
 * ============================================================================
 * The single entry point for everything under js/modules/. studyos.html loads
 * exactly one module script; this file decides what actually starts.
 *
 * ── WHY A SINGLE ENTRY POINT ──────────────────────────────────────────────
 * Every <script type="module"> is deferred and runs after js/studyos.js, so
 * load ORDER between modules is the one thing a plain list of script tags
 * would leave to chance. One entry point makes that order explicit and gives
 * the feature flag a single place to be honoured — with the pipeline off,
 * nothing below is even imported.
 *
 * ── FEATURE FLAG ──────────────────────────────────────────────────────────
 * STUDYOS_CONFIG.cloudflare.ai.enabled gates the whole pipeline. It ships
 * false: the Worker needs a KV namespace and an API-key secret that must be
 * created by hand, and a Run button that always 503s is worse than no button.
 * Everything else in the app is untouched either way.
 * ------------------------------------------------------------------------- */

import { store } from './store.js';

const aiCfg = () => (window.STUDYOS_CONFIG && window.STUDYOS_CONFIG.cloudflare
  && window.STUDYOS_CONFIG.cloudflare.ai) || {};

// Always exposed, so the console can inspect state even with the pipeline off.
window.SOS = window.SOS || {};
window.SOS.store = store;

/* ── Active recall (Phase 2) ───────────────────────────────────────────────
 * Independent of the pipeline: cards are extracted from notes she ALREADY has,
 * with no model call and no network, so this loads whether or not a backend is
 * configured. That is the point — it is the half of the app that works today.
 */
(async function recall() {
  const [deck, reviewUi, sessions] = await Promise.all([
    import('./deck.js'),
    import('./review-ui.js'),
    import('./sessions.js'),
  ]);
  window.SOS.deck = deck;
  window.SOS.review = reviewUi;
  window.SOS.sessions = sessions;

  // Sessions sync as one document, unioned by id (append-only, so nothing is
  // ever lost). Loaded once at boot and kept current by the listener.
  if (window._fbLoadSessions) {
    window._fbLoadSessions()
      .then(list => { if (Array.isArray(list) && list.length) sessions.applyRemote(list); })
      .catch(() => {});
  }
  window.addEventListener('fb-sessions-remote', (e) => {
    const d = (e && e.detail) || {};
    if (Array.isArray(d.sessions)) sessions.applyRemote(d.sessions);
  });

  // Called from inline onclick= in markup studyos.js renders; that file is a
  // classic script and cannot import these.
  window.sosStudy = (classId, extra) => reviewUi.startReview({ classId, ...(extra || {}) });
  window.sosStudyAll = () => reviewUi.startReview({});
  window.sosLearnNew = (scope, extra) => reviewUi.startReview(scope || {}, { mode: 'learn', ...(extra || {}) });
  window.sosCram = (scope, extra) => reviewUi.startReview(scope || {}, { mode: 'cram', ...(extra || {}) });
  window.sosMakeCards = (classId, moduleId, noteId, isHtml) => {
    const cls = store.getClass(classId);
    const mod = cls && (cls.modules || []).find(m => m.id === moduleId);
    const note = mod && (mod.notes || []).find(n => n.id === noteId);
    if (!note) return;
    const r = deck.generateFromNote(classId, moduleId, note, { html: !!isHtml });
    try {
      window.showNotif && window.showNotif(
        r.added.length ? '🃏' : 'ℹ️',
        r.added.length ? `${r.added.length} card${r.added.length === 1 ? '' : 's'} added` : 'No new cards',
        r.added.length
          ? `${deck.countsFor(classId).total} in ${cls ? cls.name : 'this class'}`
          : 'Nothing new to extract from this note.');
    } catch (e) {}
    return r;
  };

  // Load each class's deck from the cloud once, and keep it current. Without
  // this a second device starts from an empty local deck.
  //
  // ONCE per class. store.onReady runs its callback on EVERY change, not only
  // at start, so this used to re-read every class's deck from the server (3
  // tries, 5 s timers each) on every save, sync and render event. On Veda's
  // tab that piled up ~1 GB of pending reads and choked the connection her
  // saves needed (2026-09-30). The deck's live listener (started by the first
  // load) keeps it current after that; a class added later is loaded then.
  const _deckLoaded = new Set();
  store.onReady(() => {
    for (const cls of store.getClasses()) {
      if (!cls || !cls.id || _deckLoaded.has(cls.id)) continue;
      if (!window._fbLoadCards) break;
      _deckLoaded.add(cls.id);
      window._fbLoadCards(cls.id)
        .then(list => { if (Array.isArray(list) && (list.length || list.meta)) deck.applyRemote(cls.id, list, list.meta); })
        .catch(() => {});
    }
  });
  window.addEventListener('fb-cards-remote', (e) => {
    const d = (e && e.detail) || {};
    if (d.classId && Array.isArray(d.cards)) deck.applyRemote(d.classId, d.cards, d.meta);
  });

  console.info('[StudyOS] active recall ready.');
})().catch(e => console.warn('[StudyOS] recall failed to start:', e));

/* ── Topic breakdown (topics → lessons → flashcards) ───────────────────────
 * NOT behind the pipeline flag: with an API key in AI settings it needs no
 * bridge at all. Only the "Claude Pro" provider does, and ai.js says so when
 * it is picked without one. */
(async function study() {
  if (window.SOS.__studyBooted) return;       // see the duplicate-boot note below
  window.SOS.__studyBooted = true;
  const [ai, aiSettings, breakdown, breakdownUi, lessonUi] = await Promise.all([
    import('./ai.js'),
    import('./ai-settings.js'),
    import('./breakdown.js'),
    import('./breakdown-ui.js'),
    import('./lesson-ui.js'),
  ]);
  window.SOS.ai = ai;
  window.SOS.aiSettings = aiSettings;
  window.SOS.breakdown = breakdown;
  window.SOS.lessonUi = lessonUi;
  // Called by studyos.js's refreshDocList for every file row.
  window.sosDecorateDocRow = (item, cls, mod, f) => breakdownUi.decorate(item, cls, mod, f);
  // A breakdown this device left running when the tab closed picks up where
  // it stopped — once the classes (and their file summaries) are loaded.
  // At start, then at most once a minute and never two at once: store.onReady
  // fires on every change, and each resume reads topic documents.
  let _resumeAt = 0, _resuming = false;
  store.onReady(() => {
    if (_resuming || Date.now() - _resumeAt < 60000) return;
    _resuming = true; _resumeAt = Date.now();
    breakdown.resume().catch(() => {}).finally(() => { _resuming = false; });
  });
  // A lesson she opened before cards were gated on it still counts as read:
  // whenever a breakdown loads, its opened topics release their cards.
  window.addEventListener('sos-breakdown', (e) => {
    const id = e && e.detail && e.detail.fileId;
    const doc = id && breakdown.peek(id);
    const D = window.SOS.deck;
    if (!doc || !doc.classId || !D) return;
    for (const t of doc.topics || []) {
      if (t.progress) D.markLessonRead(doc.classId, breakdown.noteIdFor(doc.fileId, t.id));
    }
  });
  // The one-time card cleanup (overhaul §8). Late, so the server's copy of
  // every class's cards and breakdowns has arrived first: a plan made from a
  // stale local copy would miss the other device's cards.
  let _migrateQueued = false;
  store.onReady(() => {
    if (_migrateQueued || window.__sosNoCardMigration) return;
    _migrateQueued = true;
    setTimeout(async () => {
      try {
        const [mig, pui] = await Promise.all([import('./migrate-cards-v2.js'), import('./pipeline-ui.js')]);
        window.SOS.migrateCards = mig;
        await mig.maybeRun({ sheet: pui.sheet });
      } catch (e) { console.warn('[StudyOS] card cleanup skipped:', e && e.message); }
    }, 8000);
  });
  console.info('[StudyOS] topic breakdown ready.');
})().catch(e => console.warn('[StudyOS] topic breakdown failed to start:', e));

(async function boot() {
  const cfg = aiCfg();
  if (!cfg.enabled || !cfg.baseUrl) {
    console.info('[StudyOS] pipeline disabled — set cloudflare.ai.enabled once a backend is set up.');
    return;
  }

  /* Run ONCE per page, even if this module is evaluated more than once.
   *
   * A module is normally a singleton, but the cache key is the URL: importing
   * './boot.js?x=1' creates a SECOND instance that re-registers every listener.
   * The auto-run handler below is the one that matters — two registrations mean
   * one dropped deck queues two jobs, doing (and, on the Worker backend,
   * charging for) the same work twice.
   *
   * Caught by scripts/verify-autorun.mjs, which re-imports boot.js with a query
   * string to enable the pipeline mid-test and got exactly that double POST. */
  if (window.SOS.__booted) {
    console.info('[StudyOS] pipeline already started; skipping duplicate boot.');
    return;
  }
  window.SOS.__booted = true;

  // Imported lazily so a disabled pipeline costs nothing on a cold load.
  const [pipeline, prompts, ui] = await Promise.all([
    import('./pipeline.js'),
    import('./prompts.js'),
    import('./pipeline-ui.js'),
  ]);

  window.SOS.pipeline = pipeline;
  window.SOS.prompts = prompts;
  window.SOS.ui = ui;

  // Called from inline onclick= in studyos.js's rendered markup, which is a
  // classic script and cannot import these.
  window.sosRunPrompt = (classId, fileId, moduleId) => {
    const cls = store.getClass(classId);
    if (!cls) return;
    const mod = (cls.modules || []).find(m => m.id === moduleId);
    const file = mod && (mod.files || []).find(f => f.id === fileId);
    if (file) ui.openRunSheet(cls, [file], moduleId);
  };
  window.sosOpenJobs = () => ui.openJobsPanel();
  window.sosAutoRun = (classId, moduleId) => {
    const cls = store.getClass(classId);
    const mod = cls && (cls.modules || []).find(m => m.id === moduleId);
    if (cls && mod) ui.openAutoRunSheet(cls, mod);
  };

  /* P-4 auto-run. studyos.js fires this after a file finishes uploading to the
   * cloud — not after the local save — because the Worker fetches the source
   * from studyos-files and a job queued any earlier would 404. */
  window.addEventListener('sos-file-added', async (e) => {
    const d = (e && e.detail) || {};
    if (!d.promptId || !d.file) return;
    const cls = store.getClass(d.classId);
    const p = prompts.get(d.promptId);
    if (!cls || !p) return;
    try {
      const { job, cached } = await pipeline.runPrompt({
        file: d.file,
        prompt: prompts.interpolate(p.text, { cls }),
        promptId: p.id,
        promptVersion: p.version || 1,
        classId: cls.id,
        outputModuleId: d.moduleId,
      });
      if (!cached && job) ui.trackJob(job.id);
    } catch (err) {
      // Never block an upload on the pipeline: the file is already safely
      // stored, and a failed auto-run is a notification, not a lost file.
      console.warn('[StudyOS] auto-run failed:', err);
      try { window.showNotif && window.showNotif('⚠️', 'Auto-run failed', String(err.message || err)); } catch (_) {}
    }
  });

  // Re-attach to jobs still running from before this page load, so a note
  // finished while the tab was closed still gets filed.
  ui.resumeWatches();

  console.info('[StudyOS] pipeline ready.');
})();
