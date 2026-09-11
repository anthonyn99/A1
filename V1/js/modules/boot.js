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

(async function boot() {
  const cfg = aiCfg();
  if (!cfg.enabled || !cfg.baseUrl) {
    console.info('[StudyOS] pipeline disabled — set cloudflare.ai.enabled once the Worker is set up.');
    return;
  }

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
