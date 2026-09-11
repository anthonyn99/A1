/* ============================================================================
 * StudyOS — pipeline client  (upgrade spec Phase 1, P-3 / P-5 / P-7)
 * ============================================================================
 * The browser half of the pipeline: enqueue a job, watch it, and file the
 * finished note back into the class. The work itself happens in
 * workers/studyos-ai, because a job has to survive the tab closing.
 *
 * ── WHAT THIS FILE DELIBERATELY DOES NOT DO ───────────────────────────────
 * It never sees the Anthropic API key, and it never calls api.anthropic.com.
 * Both live exclusively inside the Worker. This file is served publicly at
 * /studyos/js/modules/pipeline.js, so anything it held would be world-readable.
 *
 * ── POLLING, NOT PUSH ─────────────────────────────────────────────────────
 * Job state is polled rather than streamed. The point of the feature is that
 * she CLOSES the laptop, so a socket held open by the page would be the wrong
 * shape — the Worker is the source of truth and the page is a viewer that may
 * not exist. push.js delivers the "your decks are ready" notification; polling
 * only drives the Jobs panel while it happens to be open.
 * ------------------------------------------------------------------------- */

import { store } from './store.js';

const CFG = () => (window.STUDYOS_CONFIG && window.STUDYOS_CONFIG.cloudflare
  && window.STUDYOS_CONFIG.cloudflare.ai) || {};

/** True when the pipeline is configured and switched on. */
export function enabled() {
  const c = CFG();
  return !!(c.enabled && c.baseUrl);
}

/**
 * Call the Worker with an App Check token attached.
 *
 * Every /api/ai/* route is App Check gated because the Worker sits on a public
 * URL. A missing token is not treated as an error here — the Worker answers
 * 401 and `request` surfaces that like any other failure, which keeps one
 * failure path instead of two.
 */
async function request(path, init = {}) {
  const c = CFG();
  if (!c.baseUrl) throw new Error('pipeline not configured');

  const headers = { 'Content-Type': 'application/json', ...(init.headers || {}) };
  try {
    const tok = window._fbAppCheckToken ? await window._fbAppCheckToken() : null;
    if (tok) headers['X-Firebase-AppCheck'] = tok;
  } catch (e) { /* fall through — the Worker will answer 401 */ }

  const res = await fetch(c.baseUrl.replace(/\/$/, '') + path, { ...init, headers });
  let body = null;
  try { body = await res.json(); } catch (e) { /* non-JSON error page */ }

  if (!res.ok || (body && body.ok === false)) {
    const err = new Error((body && body.error) || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

/**
 * Queue one file through one prompt.
 *
 * `prompt` is sent as text rather than by id because the prompt library lives
 * in the user's own synced data, not in the Worker — the Worker has no way to
 * resolve a promptId on its own, and giving it one would mean duplicating the
 * library server-side and keeping the two in step.
 *
 * Returns `{ job, cached }`. `cached: true` means the identical file+prompt
 * already produced a result and nothing was spent.
 */
export async function runPrompt({ file, prompt, promptId, promptVersion, classId, outputModuleId, slideCount }) {
  if (!enabled()) throw new Error('pipeline disabled');
  if (!file || !file.id) throw new Error('file required');
  if (!prompt || !String(prompt).trim()) throw new Error('prompt required');

  // The Cloudflare Worker fetches the source itself from studyos-files, so it
  // only needs an id. The LOCAL bridge (tools/sos-browser) has no access to
  // that store — it drives a browser on this machine — so it needs the actual
  // bytes. Read them from IndexedDB and send base64 alongside.
  //
  // Only for the local bridge: attaching a megabyte of base64 to every Worker
  // request would be pure waste, and the Worker ignores the field anyway.
  let fileB64 = null;
  if (isLocalBridge()) {
    fileB64 = await readFileB64(file);
    if (!fileB64) throw new Error('could not read the file to attach');
  }

  const out = await request('/api/ai/jobs', {
    method: 'POST',
    body: JSON.stringify({
      fileId: file.id,
      sourceName: file.name || '',
      promptId: promptId || 'inline',
      promptVersion: promptVersion || 1,
      prompt: String(prompt),
      classId: classId || '',
      outputModuleId: outputModuleId || '',
      // Slide count drives the chunker. An over-estimate costs nothing (the
      // loop stops at the real end); an under-estimate would truncate the
      // deck, so when it is unknown the caller should pass nothing and let
      // the Worker use its own default rather than guess low.
      ...(slideCount ? { slideCount } : {}),
      ...(fileB64 ? { fileB64 } : {}),
      // Which chat site the local bridge should drive. Ignored by the Worker,
      // which has exactly one provider.
      ...(CFG().site ? { site: CFG().site } : {}),
    }),
  });
  return { job: out.job, cached: !!out.cached };
}

/** True when baseUrl points at the local browser bridge rather than the Worker. */
export function isLocalBridge() {
  const u = CFG().baseUrl || '';
  return /^https?:\/\/(127\.0\.0\.1|localhost)\b/i.test(u);
}

/**
 * The file's bytes as base64, read from the same IndexedDB store the app uses.
 *
 * Falls back to the cloud copy when the blob isn't local — a file uploaded on
 * her phone and synced here has metadata but no local bytes, and that case is
 * common enough that failing on it would make the feature look broken.
 */
async function readFileB64(file) {
  // Reuses studyos.js's own sosResolveBlob via the bridge rather than
  // reimplementing it: that function already tries local IndexedDB, falls back
  // to the cloud copy, and caches the result back for offline use. A second
  // copy here would drift from it and miss the caching.
  const B = window._sosBridge;
  if (!B || typeof B.resolveBlob !== 'function') return null;

  let blob = null;
  try { blob = await B.resolveBlob(file); } catch (e) { return null; }
  if (!blob) return null;

  return await new Promise((resolve) => {
    const fr = new FileReader();
    // readAsDataURL gives "data:<mime>;base64,<payload>" — the bridge wants
    // only the payload.
    fr.onload = () => resolve(String(fr.result).split(',')[1] || null);
    fr.onerror = () => resolve(null);
    fr.readAsDataURL(blob);
  });
}

/** Queue several files through one prompt. Failures are reported per file. */
export async function runBatch(files, opts) {
  const results = [];
  for (const file of files || []) {
    try {
      const r = await runPrompt({ ...opts, file });
      results.push({ file, ok: true, ...r });
    } catch (e) {
      results.push({ file, ok: false, error: String(e.message || e) });
    }
  }
  return results;
}

export const getJob = (id) => request('/api/ai/jobs/' + encodeURIComponent(id)).then(r => r.job);
export const listJobs = () => request('/api/ai/jobs').then(r => r.jobs || []);
export const retryJob = (id) => request('/api/ai/jobs/' + encodeURIComponent(id) + '/retry', { method: 'POST' }).then(r => r.job);
export const deleteJob = (id) => request('/api/ai/jobs/' + encodeURIComponent(id), { method: 'DELETE' });

/** Month-to-date spend against the server-enforced cap (P-7). */
export const budget = () => request('/api/ai/budget');

/**
 * Mark a job's result as filed into the app.
 *
 * Without this, every reload would re-file every finished job. Harmless in
 * effect (addGeneratedNote replaces rather than stacks) but it would re-toast
 * "Note ready" on every boot forever, which reads as a bug.
 */
export const markFiled = (id) =>
  request('/api/ai/jobs/' + encodeURIComponent(id) + '/filed', { method: 'POST' })
    .catch(() => null);        // a bridge without this route must not break boot

/**
 * Watch a job until it finishes.
 *
 * Backs off from 2s to 30s: a deck takes minutes, and a fixed 2s poll would
 * make hundreds of pointless requests while she is not even looking. Returns
 * a cancel function — call it when the panel closes, or the timer outlives
 * the view that wanted it.
 */
export function watchJob(id, onUpdate) {
  let delay = 2000, stopped = false, timer = null;

  const tick = async () => {
    if (stopped) return;
    try {
      const job = await getJob(id);
      if (stopped) return;
      try { onUpdate && onUpdate(job); } catch (e) { console.warn('[pipeline] onUpdate threw:', e); }
      if (job.status === 'done' || job.status === 'error' || job.status === 'canceled') return;
      delay = Math.min(Math.round(delay * 1.5), 30000);
    } catch (e) {
      // A transient failure must not kill the watch; slow down and retry.
      delay = Math.min(Math.round(delay * 2), 30000);
    }
    timer = setTimeout(tick, delay);
  };

  timer = setTimeout(tick, 0);
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}

/**
 * File a finished job's output into the class as a note (P-5).
 *
 * The result is written as a NOTE rather than a flat file so she can edit,
 * highlight and annotate it in the existing docx editor immediately — the
 * spec's whole argument for why generated output must not be a dead artifact.
 *
 * Provenance (sourceFileId / promptId / promptVersion / model / generatedAt)
 * rides along on the note so "why is this one worse than that one" stays
 * answerable after the fact.
 *
 * Returns the created note, or null when the bridge is not up.
 */
/**
 * Drop everything before the first slide heading.
 *
 * When a file is attached, Claude narrates its tool use above the answer
 * ("Reading the file-reading router skill…", "Read 15 files, ran 2 commands").
 * That renders inside the same response node, so the scraper picks it up and it
 * lands at the top of the generated note.
 *
 * The bridge trims this too, but it must ALSO happen here: a job that finished
 * before the trim shipped still has the chrome baked into its stored result,
 * and re-filing it would carry the mess into the note. Trimming at the point of
 * use makes old and new jobs behave the same.
 *
 * A no-op when no slide heading exists, rather than returning empty — a note
 * with no headings is a coverage problem, and blanking it would hide that.
 */
function trimToFirstSlide(text) {
  const s = String(text || '');
  const m = /^#{1,6}\s*Slide\s*[:#-]?\s*\d+/im.exec(s);
  if (!m) return s;
  const start = s.lastIndexOf('\n', m.index) + 1;
  return s.slice(start).trim();
}

export function fileResult(job) {
  if (!job || job.status !== 'done' || !job.result) return null;
  const B = window._sosBridge;
  if (!B || typeof B.addGeneratedNote !== 'function') {
    console.warn('[pipeline] bridge cannot file notes yet');
    return null;
  }
  return B.addGeneratedNote({
    classId: job.classId,
    moduleId: job.outputModuleId,
    title: job.sourceName ? ('Rewritten — ' + job.sourceName) : 'Generated note',
    body: trimToFirstSlide(job.result),
    meta: {
      sourceFileId: job.fileId,
      promptId: job.promptId,
      promptVersion: job.promptVersion,
      model: (job.sections && job.sections[0] && job.sections[0].model) || '',
      generatedAt: job.finishedAt || Date.now(),
      costUsd: job.costUsd || 0,
      slideRanges: (job.sections || []).map(s => ({ from: s.from, to: s.to })),
    },
  });
}

export default { enabled, runPrompt, runBatch, getJob, listJobs, retryJob, deleteJob, budget, watchJob, fileResult };
