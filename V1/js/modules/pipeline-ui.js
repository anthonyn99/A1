/* ============================================================================
 * StudyOS — pipeline UI  (upgrade spec P-3, P-4, P-6, P-7)
 * ============================================================================
 * The surfaces that make the pipeline reachable: a Run sheet on a file, a Jobs
 * panel, the per-module default-prompt toggle, and the budget readout.
 *
 * ── WHY THIS BUILDS ITS OWN DOM ───────────────────────────────────────────
 * studyos.html wires the overlay dismiss handler ONCE at load, over the
 * .sos-modal elements that exist at that moment
 * (`document.querySelectorAll('.sos-modal').forEach(...)` in studyos.js). A
 * modal appended later would look identical and silently not close on a
 * backdrop click. So every sheet here attaches its own listeners rather than
 * relying on that pass.
 *
 * ── WHY IT IS ALL OPT-IN ──────────────────────────────────────────────────
 * Nothing here renders unless STUDYOS_CONFIG.cloudflare.ai.enabled is true.
 * The Worker's KV namespace and API-key secret are a manual one-time step, and
 * a Run button that always 503s is worse than no button.
 * ------------------------------------------------------------------------- */

import * as pipeline from './pipeline.js';
import * as prompts from './prompts.js';
import { store } from './store.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// ── A self-contained sheet ────────────────────────────────────────────────
function sheet(title, bodyHtml, { wide } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay sos-modal sos-ai-sheet';
  overlay.innerHTML = `
    <div class="modal"${wide ? ' style="max-width:680px"' : ''}>
      <div class="modal-title">${esc(title)}</div>
      <div class="modal-scroll-body" data-body></div>
      <div class="modal-footer" data-footer></div>
    </div>`;
  overlay.querySelector('[data-body]').innerHTML = bodyHtml;

  const close = () => {
    overlay.classList.remove('open');
    setTimeout(() => overlay.remove(), 200);
  };
  // Own listeners — the load-time pass in studyos.js never sees this element.
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));
  return { overlay, close, body: overlay.querySelector('[data-body]'), footer: overlay.querySelector('[data-footer]') };
}

function toast(icon, title, body) {
  try { if (window.showNotif) return window.showNotif(icon, title, body); } catch (e) {}
  console.log(`[pipeline] ${title}: ${body || ''}`);
  return null;
}

/**
 * "Deck ready" — naming where it landed, and opening it when clicked.
 *
 * The destination is often NOT the module the run was started from (the Run
 * sheet defaults away from the source module, and can create a new one), so a
 * toast that named only the source file left the deck to be hunted for. Saying
 * the module name and making the toast open it closes the loop: generate ->
 * filed -> on screen, in one go.
 */
function deckReadyToast(job, doc) {
  /* NOT FILED AT ALL — the class the job was queued against is gone from this
   * device (deleted, recreated with a new id, or not yet synced here).
   *
   * This must never render as "Deck ready": the deck exists on the bridge but
   * is in no class, and a green tick would send her looking for a file that is
   * not there. Say what happened and that nothing was lost — the job is left
   * unfiled on purpose, so it re-files itself once the class is back. */
  if (doc && doc.unfiled) {
    toast('⚠️', 'Deck could not be filed',
      'Its class is missing on this device. The deck is safe on the bridge and '
      + 'will file itself once the class is back.');
    return;
  }

  const where = doc && doc.moduleName ? ` → ${doc.moduleName}` : '';
  const el = toast('✅', 'Deck ready',
    (job && job.sourceName) || (doc && doc.title) || 'Slide deck');

  /* Filed, but NOT where she chose. Landing somewhere unannounced is what made
   * this whole path feel broken, so name the fallback explicitly. The toast
   * stays clickable below and opens wherever it actually went. */
  if (doc && doc.redirected) {
    try {
      const bodyEl = el && el.querySelector('.notif-body');
      if (bodyEl) {
        bodyEl.textContent = (doc.redirected === 'not-a-documents-module'
          ? 'The module you chose cannot hold a PDF, so it went to '
          : 'The module you chose no longer exists, so it went to ')
          + (doc.moduleName || 'Generated') + '.';
      }
    } catch (e) {}
  }

  if (!el || !doc || !doc.moduleId) return;
  try {
    el.style.cursor = 'pointer';
    el.title = 'Open ' + (doc.moduleName || 'the module');
    // Skipped when redirected: that branch already replaced the body with a
    // fuller sentence that names the destination, and appending " → X" to it
    // would say the same thing twice.
    const bodyEl = el.querySelector('.notif-body');
    if (bodyEl && where && !doc.redirected) bodyEl.textContent = bodyEl.textContent + where;
    el.addEventListener('click', (e) => {
      // The × has its own handler that removes the toast; don't also navigate.
      if (e.target && e.target.classList.contains('notif-close')) return;
      const B = window._sosBridge;
      if (B && typeof B.revealModule === 'function') {
        B.revealModule(doc.classId || (job && job.classId), doc.moduleId);
      }
      el.remove();
    });
  } catch (e) {}
}

// ── Deck sheet memory ─────────────────────────────────────────────────────
/* The last prompt module / prompt / destination used, per class, so the second
 * deck of the week is three clicks, not six. Per device and best-effort: the
 * A1 origin's localStorage is known to fill up, and a failed write here must
 * cost nothing but the convenience. */
const DECK_PREFS_KEY = 'studyos_deck_prefs_v1';
function deckPrefs(classId) {
  try { return (JSON.parse(localStorage.getItem(DECK_PREFS_KEY) || '{}') || {})[classId] || {}; }
  catch (e) { return {}; }
}
function saveDeckPrefs(classId, prefs) {
  try {
    const all = JSON.parse(localStorage.getItem(DECK_PREFS_KEY) || '{}') || {};
    all[classId] = prefs;
    localStorage.setItem(DECK_PREFS_KEY, JSON.stringify(all));
  } catch (e) { /* quota full: remembered for nothing, spent nothing */ }
}

/**
 * The prompt's CONTENT as its version.
 *
 * The bridge caches on fileId|promptId|promptVersion|mode. Class prompts carry
 * no version of their own, so editing one in place (editPrompt) kept the same
 * key and the next run answered "Already done" with the deck from the OLD
 * text. Hashing the text makes an edit a new version by construction.
 */
export function promptVersionOf(text) {
  const str = String(text || '');
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return 'h' + h.toString(36);
}

const NEW_MODULE = '__new__';
const firstLineOf = (t) => String(t || '').split('\n').map(x => x.replace(/^#+\s*/, '').trim()).find(Boolean) || 'Untitled';

// ── P-3: make slides from one or more files ───────────────────────────────
/**
 * Generate a NotebookLM slide deck from one or more source files.
 *
 * Three choices, in the order she thinks about them: which prompt MODULE
 * (a class keeps its deck prompts together), which prompt in it, and which
 * documents module the deck lands in (or a new one, named here).
 *
 * ── WHY THERE IS NO ENGINE PICKER ─────────────────────────────────────────
 * Decks come from NotebookLM, full stop — it has no API, so this always runs
 * through the local bridge, whatever the AI settings say.
 *
 * @param {object} cls      the class the files belong to
 * @param {Array}  files    one or more file entries
 * @param {string} sourceModuleId  the module the files live in
 */
export function openRunSheet(cls, files, sourceModuleId) {
  if (!pipeline.enabled()) {
    toast('⚠️', 'Pipeline is off', 'Turn on cloudflare.ai in config and start the bridge first.');
    return;
  }
  // NotebookLM needs a browser on this machine, which is what the local bridge
  // is. The Cloudflare Worker cannot drive one and never will.
  if (!pipeline.isLocalBridge()) {
    toast('⚠️', 'Needs the local bridge',
      'Deck generation drives NotebookLM in a browser on this PC. Point config.cloudflare.ai.baseUrl at http://127.0.0.1:8781.');
    return;
  }
  const list = (Array.isArray(files) ? files : [files]).filter(Boolean);
  if (!list.length) return;

  const B = window._sosBridge;
  const promptMods = (cls.modules || []).filter(m => m.type === 'prompts');
  const reopen = () => openRunSheet(store.getClass(cls.id) || cls, list, sourceModuleId);

  // ── Empty state: this class has no prompt module yet ─────────────────────
  if (!promptMods.length) {
    const s = sheet('Make slides', `
      <div style="font-size:13px;color:var(--text2);line-height:1.5;margin-bottom:12px">
        Deck prompts live in a prompts module in this class. Create one with your
        first prompt — you can add and edit more in the module later.
      </div>
      <div class="field"><label>Module name</label>
        <input id="sos-deck-newpm" value="Deck prompts"></div>
      <div class="field"><label>First prompt</label>
        <textarea id="sos-deck-firstprompt" rows="5" placeholder="e.g. Make a deck that explains every concept in plain language, one idea per slide, with a worked example for each formula."></textarea></div>`,
      { wide: true });
    const cancel = document.createElement('button');
    cancel.className = 'btn'; cancel.textContent = 'Cancel'; cancel.onclick = s.close;
    const create = document.createElement('button');
    create.className = 'btn primary'; create.textContent = 'Create';
    create.onclick = () => {
      const name = s.overlay.querySelector('#sos-deck-newpm').value.trim() || 'Deck prompts';
      const ta = s.overlay.querySelector('#sos-deck-firstprompt');
      const text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      const modId = B && B.addModule && B.addModule(cls.id, name, 'prompts');
      if (!modId) { toast('⚠️', 'Could not create the module', name); return; }
      const promptId = B.addPromptTo(cls.id, modId, text);
      saveDeckPrefs(cls.id, { ...deckPrefs(cls.id), promptModuleId: modId, promptId });
      s.close();
      setTimeout(reopen, 220);
    };
    s.footer.append(cancel, create);
    return;
  }

  const remembered = deckPrefs(cls.id);
  const docMods = (cls.modules || []).filter(m => m.type === 'documents');
  const pmOf = (id) => promptMods.find(m => m.id === id);

  const s = sheet(
    list.length === 1 ? 'Make slides' : `Make slides from ${list.length} files`,
    `
    <div style="font-size:12px;color:var(--text3);font-family:var(--mono);margin-bottom:10px">
      ${list.length === 1 ? esc(list[0].name || 'file') : esc(list.map(f => f.name).filter(Boolean).slice(0, 3).join(', ')) + (list.length > 3 ? ` +${list.length - 3} more` : '')}
    </div>
    <div class="field">
      <label>1 · Prompt module</label>
      <select id="sos-deck-pmod">
        ${promptMods.map(m => `<option value="${esc(m.id)}">${esc(m.name || 'Untitled')} (${(m.prompts || []).length})</option>`).join('')}
      </select>
    </div>
    <div class="field">
      <label>2 · Prompt</label>
      <select id="sos-deck-prompt"></select>
      <div id="sos-deck-preview" style="margin-top:6px;max-height:150px;overflow:auto;white-space:pre-wrap;font-size:12px;line-height:1.5;color:var(--text2);background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:8px 10px"></div>
      <div id="sos-ai-vars"></div>
    </div>
    <div class="field">
      <label>3 · File the deck into</label>
      <select id="sos-deck-dest"></select>
      <input id="sos-deck-newdest" placeholder="New module name" value="Slides" style="display:none;margin-top:6px">
    </div>
    <div style="font-size:11px;color:var(--text3);font-family:var(--mono);margin-top:10px;line-height:1.5">
      NotebookLM builds the deck from this source under your prompt. It takes a
      while — you can close the tab; it files itself when done.
    </div>
    `, { wide: true });

  const pmodSel = s.overlay.querySelector('#sos-deck-pmod');
  const promptSel = s.overlay.querySelector('#sos-deck-prompt');
  const preview = s.overlay.querySelector('#sos-deck-preview');
  const varsEl = s.overlay.querySelector('#sos-ai-vars');
  const destSel = s.overlay.querySelector('#sos-deck-dest');
  const newDest = s.overlay.querySelector('#sos-deck-newdest');

  const currentPrompt = () => {
    const m = pmOf(pmodSel.value);
    return m && (m.prompts || []).find(p => p.id === promptSel.value);
  };

  // Show which {{variables}} will be filled, and which will not. An unfilled
  // one stays literal at run time on purpose, so surface it before spending.
  const showPrompt = () => {
    const p = currentPrompt();
    preview.textContent = p ? p.text : 'This module has no prompts yet — add one in the module first.';
    const used = p ? prompts.variablesIn(p.text) : [];
    if (!used.length) { varsEl.innerHTML = ''; return; }
    const unresolved = prompts.variablesIn(prompts.interpolate(p.text, { cls }));
    varsEl.innerHTML = `
      <div style="font-size:11px;font-family:var(--mono);color:var(--text3);margin-top:4px">
        Variables: ${used.map(v => {
          const bad = unresolved.includes(v);
          return `<span style="color:${bad ? '#f0bd86' : 'var(--text2)'}">{{${esc(v)}}}${bad ? ' — no value' : ''}</span>`;
        }).join(' · ')}
      </div>`;
  };

  const fillPrompts = (preferId) => {
    const m = pmOf(pmodSel.value);
    const ps = (m && m.prompts) || [];
    promptSel.innerHTML = ps.map(p =>
      `<option value="${esc(p.id)}">${esc(firstLineOf(p.text).slice(0, 90))}</option>`).join('');
    promptSel.disabled = !ps.length;
    if (preferId && ps.some(p => p.id === preferId)) promptSel.value = preferId;
    showPrompt();
  };

  if (pmOf(remembered.promptModuleId)) pmodSel.value = remembered.promptModuleId;
  fillPrompts(remembered.promptId);
  pmodSel.addEventListener('change', () => fillPrompts());
  promptSel.addEventListener('change', showPrompt);

  // Destination: documents modules only. A notes module renders from the
  // editor's own store, so a PDF filed there would display nowhere. The
  // default is NOT the source module — that would file a deck back beside the
  // lecture it was made from — unless she chose it last time.
  const preferred = docMods.find(m => m.id === remembered.destModuleId)
    || docMods.find(m => /slides|generated|deck/i.test(m.name || ''))
    || docMods.find(m => m.id !== sourceModuleId)
    || null;
  destSel.innerHTML = docMods
    .map(m => `<option value="${esc(m.id)}"${m === preferred ? ' selected' : ''}>${esc(m.name || 'Untitled')}</option>`)
    .join('') + `<option value="${NEW_MODULE}"${preferred ? '' : ' selected'}>New module…</option>`;
  const syncNewDest = () => {
    newDest.style.display = destSel.value === NEW_MODULE ? '' : 'none';
  };
  destSel.addEventListener('change', () => { syncNewDest(); if (destSel.value === NEW_MODULE) newDest.focus(); });
  syncNewDest();

  const run = document.createElement('button');
  run.className = 'btn primary';
  run.id = 'sos-deck-run';
  run.textContent = list.length === 1 ? 'Make slides' : `Make ${list.length} decks`;
  const cancel = document.createElement('button');
  cancel.className = 'btn';
  cancel.textContent = 'Cancel';
  cancel.onclick = s.close;

  run.onclick = async () => {
    const p = currentPrompt();
    if (!p) { toast('⚠️', 'Pick a prompt', 'This prompt module is empty — add a prompt to it first.'); return; }
    let destId = destSel.value;
    if (destId === NEW_MODULE) {
      const name = newDest.value.trim();
      if (!name) { newDest.focus(); return; }
      destId = B && B.addModule ? B.addModule(cls.id, name, 'documents') : '';
      if (!destId) { toast('⚠️', 'Could not create the module', name); return; }
    }
    saveDeckPrefs(cls.id, { promptModuleId: pmodSel.value, promptId: p.id, destModuleId: destId });

    run.disabled = true;
    run.textContent = 'Queueing…';
    try {
      const results = await pipeline.runBatch(list, {
        prompt: prompts.interpolate(p.text, { cls }),
        promptId: p.id,
        promptVersion: promptVersionOf(p.text),
        classId: cls.id,
        outputModuleId: destId,
        mode: 'notebooklm',
      });
      const ok = results.filter(r => r.ok).length;
      const cached = results.filter(r => r.cached).length;
      const failed = results.filter(r => !r.ok);
      s.close();

      if (failed.length) {
        toast('⚠️', `${ok} queued, ${failed.length} failed`, failed[0].error);
      } else if (cached === results.length) {
        toast('✅', 'Already done', 'Re-filing the deck that was generated before — nothing was spent.');
      } else {
        toast('⚡', `${ok} queued`, 'NotebookLM is building them. They keep running if you close the tab.');
      }
      results.filter(r => r.ok && r.job && !r.cached).forEach(r => trackJob(r.job.id));

      // A CACHED hit still has to be filed: the cache answers "this was
      // generated before", not "the deck is still in the app" (a deleted
      // module leaves the result stranded on the bridge). Re-filing is
      // idempotent — addGeneratedDoc replaces by (sourceFileId, mode).
      for (const r of results.filter(r => r.ok && r.job && r.cached)) {
        try {
          const job = r.job.result ? r.job : await pipeline.getJob(r.job.id);
          if (job) await pipeline.fileResult(job);
        } catch (e) {
          console.warn('[pipeline] could not re-file a cached job:', e);
        }
      }
    } catch (e) {
      run.disabled = false;
      run.textContent = 'Make slides';
      // A dead local bridge surfaces as a bare "Failed to fetch", which says
      // nothing about what to do. Name the actual cause and the one-time fix.
      const dead = /failed to fetch|networkerror|load failed/i.test(String(e.message || e));
      if (dead) {
        toast('🔌', 'Bridge not running',
          'Start it once with:  python server.py autostart');
      } else {
        toast('⚠️', 'Could not queue', String(e.message || e));
      }
    }
  };
  s.footer.append(cancel, run);
}

// ── Watching jobs so the result gets filed ────────────────────────────────
const watching = new Map();

/**
 * Follow a job to completion and file its note.
 *
 * Kept OUTSIDE the Jobs panel on purpose: the note must land whether or not
 * she has the panel open, and re-opening the panel must not start a second
 * watch for the same job.
 */
export function trackJob(id) {
  if (!id || watching.has(id)) return;
  const cancel = pipeline.watchJob(id, async (job) => {
    if (job.status === 'done') {
      watching.delete(id);
      // Async now: the deck's bytes are fetched from the bridge and filed as a
      // real document before this resolves.
      const doc = await pipeline.fileResult(job);
      // Mark it filed, or the next boot's resumeWatches sweep files it AGAIN:
      // a second blob, a second cloud upload, the first copy's bytes deleted,
      // and a second "Deck ready" toast. `unfiled` (class missing here) stays
      // claimable on purpose — see resumeWatches.
      if (doc && !doc.unfiled) pipeline.markFiled(job.id).catch(() => {});
      if (doc) deckReadyToast(job, doc);
      else if (job.pdfError) toast('⚠️', 'Deck not built', job.pdfError);
    } else if (job.status === 'error') {
      watching.delete(id);
      toast('⚠️', 'Job failed', job.error || 'unknown');
    }
  });
  watching.set(id, cancel);
}

/** Re-attach to anything still running — call at boot after a reload. */
export async function resumeWatches() {
  if (!pipeline.enabled()) return;
  try {
    const jobs = await pipeline.listJobs();

    // Still moving — follow them to completion.
    jobs.filter(j => j.status === 'queued' || j.status === 'running')
        .forEach(j => trackJob(j.id));

    // ALREADY FINISHED while the tab was closed. This is the case the whole
    // feature is built around — "drop a deck and walk away" — and the first
    // version skipped it: only queued/running jobs were resumed, so a job that
    // completed in the background had its result sit on the bridge forever
    // while the app showed nothing. The job said done, the note never existed,
    // and there was no error anywhere to explain the gap.
    //
    // Filing is idempotent: addGeneratedDoc replaces the deck for a given
    // sourceFileId rather than stacking copies, and serialises concurrent
    // filings of the same source, so re-filing on every boot is harmless.
    // `filed` marks them so a later reload is a no-op.
    const finished = jobs.filter(j => j.status === 'done' && j.hasResult && !j.filed);
    for (const stub of finished) {
      try {
        const job = await pipeline.getJob(stub.id);
        if (!job || !job.result) continue;
        const doc = await pipeline.fileResult(job);
        // `unfiled` means the deck was NOT stored — its class is missing here.
        // Marking it filed would be a lie that sticks: `filed` is what stops
        // this sweep reconsidering the job, so the deck would never be filed
        // again even once the class came back. Toast it and leave it claimable.
        if (doc && doc.unfiled) {
          deckReadyToast(job, doc);
        } else if (doc) {
          await pipeline.markFiled(job.id);
          deckReadyToast(job, doc);
        }
      } catch (e) {
        console.warn('[pipeline] could not file a finished job:', stub.id, e);
      }
    }
  } catch (e) { /* offline, or not set up yet */ }
}

// ── P-3: the Jobs panel ───────────────────────────────────────────────────
export async function openJobsPanel() {
  if (!pipeline.enabled()) {
    toast('⚠️', 'Pipeline is off', 'Set up the studyos-ai Worker first.');
    return;
  }
  const s = sheet('Jobs', '<div id="sos-ai-jobs" style="font-family:var(--mono);font-size:12px">Loading…</div>', { wide: true });

  const close = document.createElement('button');
  close.className = 'btn';
  close.textContent = 'Close';
  close.onclick = () => { s.close(); clearInterval(timer); };
  s.footer.append(close);

  const paint = async () => {
    const host = s.overlay.querySelector('#sos-ai-jobs');
    if (!host) return;
    let jobs = [];
    try { jobs = await pipeline.listJobs(); }
    catch (e) { host.textContent = 'Could not load jobs: ' + (e.message || e); return; }

    if (!jobs.length) { host.textContent = 'No jobs yet.'; return; }

    host.innerHTML = jobs.map(j => {
      const color = j.status === 'done' ? '#8fd6ad'
        : j.status === 'error' ? '#ef9f9f'
        : j.status === 'running' ? '#9dc0ee' : 'var(--text3)';
      const elapsed = j.startedAt
        ? Math.round(((j.finishedAt || Date.now()) - j.startedAt) / 1000) + 's'
        : '';
      return `
      <div style="display:flex;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
        <div style="width:8px;height:8px;border-radius:2px;background:${color};flex-shrink:0"></div>
        <div style="flex:1;min-width:0">
          <div style="color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(j.sourceName || j.fileId)}</div>
          <div style="color:var(--text3);font-size:10px">
            ${esc(j.status)}${j.progress ? ' · ' + j.progress + '%' : ''}${elapsed ? ' · ' + elapsed : ''}${j.costUsd ? ' · $' + j.costUsd.toFixed(3) : ''}
            ${j.error ? '<br>' + esc(j.error) : ''}
          </div>
        </div>
        ${j.status === 'error' ? `<button class="btn" data-retry="${esc(j.id)}" style="font-size:10px;padding:3px 8px">Retry</button>` : ''}
        <button class="btn" data-del="${esc(j.id)}" style="font-size:10px;padding:3px 8px">✕</button>
      </div>`;
    }).join('');

    host.querySelectorAll('[data-retry]').forEach(b => {
      b.onclick = async () => {
        b.disabled = true;
        try { await pipeline.retryJob(b.dataset.retry); trackJob(b.dataset.retry); paint(); }
        catch (e) { toast('⚠️', 'Retry failed', String(e.message || e)); b.disabled = false; }
      };
    });
    host.querySelectorAll('[data-del]').forEach(b => {
      b.onclick = async () => {
        b.disabled = true;
        try { await pipeline.deleteJob(b.dataset.del); paint(); }
        catch (e) { toast('⚠️', 'Delete failed', String(e.message || e)); b.disabled = false; }
      };
    });
  };

  await paint();
  // Refresh while the panel is open; cleared on close so it cannot outlive it.
  const timer = setInterval(paint, 5000);
  s.overlay.addEventListener('click', (e) => { if (e.target === s.overlay) clearInterval(timer); });
}

// ── P-4: per-module default prompt ────────────────────────────────────────
/**
 * Setting a default makes every file added to that module enqueue itself.
 * Confirmed once per module, because it is the one setting here that spends
 * money without another click.
 */
export function openAutoRunSheet(cls, mod) {
  if (!pipeline.enabled()) return;
  const choices = prompts.forClass(cls.id);
  const current = mod.defaultPromptId || '';

  const s = sheet('Auto-run on new files', `
    <div style="font-size:12px;color:var(--text3);font-family:var(--mono);margin-bottom:10px">
      ${esc(cls.name)} · ${esc(mod.name)}
    </div>
    <div class="field">
      <label>Default prompt</label>
      <select id="sos-ai-default">
        <option value="">Off — don't run anything automatically</option>
        ${choices.map(p => `<option value="${esc(p.id)}"${p.id === current ? ' selected' : ''}>${esc(p.name || 'Untitled')}</option>`).join('')}
      </select>
    </div>
    <div style="font-size:11px;color:var(--text3);font-family:var(--mono);margin-top:8px;line-height:1.5">
      Anything dropped into this module runs automatically and files the result
      as a rewritten PDF deck.
    </div>`);

  const cancel = document.createElement('button');
  cancel.className = 'btn'; cancel.textContent = 'Cancel'; cancel.onclick = s.close;
  const save = document.createElement('button');
  save.className = 'btn primary'; save.textContent = 'Save';
  save.onclick = () => {
    const v = s.overlay.querySelector('#sos-ai-default').value;
    const B = window._sosBridge;
    if (B && typeof B.setModuleDefaultPrompt === 'function') {
      B.setModuleDefaultPrompt(cls.id, mod.id, v || null);
      toast('✅', v ? 'Auto-run on' : 'Auto-run off', mod.name);
    }
    s.close();
  };
  s.footer.append(cancel, save);
}

export default { openRunSheet, openJobsPanel, openAutoRunSheet, trackJob, resumeWatches, promptVersionOf };
