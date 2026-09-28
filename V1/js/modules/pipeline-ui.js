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
import { MODULE_NAME as PRESET_MODULE, PRESETS } from './presets.js';

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

/**
 * "Study kit ready" — says what landed (cards, questions) and opens the
 * Study Kit module when clicked. Warnings (a short count, a missing rewrite)
 * are shown rather than swallowed: a kit that quietly has 9 cards instead of
 * 20 should say so.
 */
function kitReadyToast(job, res) {
  if (res && res.unfiled) {
    toast('⚠️', 'Study kit could not be filed',
      'Its class is missing on this device. The kit is safe on the bridge and '
      + 'will file itself once the class is back.');
    return;
  }
  if (!res) return;
  const bits = [`${res.cards} cards`, `${res.questions} quiz questions`];
  if (res.note) bits.push('cheat sheet');
  if (res.deck && !res.deck.unfiled) bits.push('rewritten deck');
  // Escaped: showNotif writes its body with innerHTML, and a lecture file
  // name is user text ("A&B <v2>.pdf").
  const el = toast('🧠', 'Study kit ready', esc(`${(job && job.sourceName) || 'Lecture'}: ${bits.join(' · ')}`
    + (res.warnings && res.warnings.length ? ` — note: ${res.warnings.join('; ')}` : '')));
  if (!el || !res.moduleId) return;
  try {
    el.style.cursor = 'pointer';
    el.title = 'Open ' + (res.moduleName || 'the Study Kit');
    el.addEventListener('click', (e) => {
      if (e.target && e.target.classList.contains('notif-close')) return;
      const B = window._sosBridge;
      if (B && typeof B.revealModule === 'function') B.revealModule(res.classId, res.moduleId);
      el.remove();
    });
  } catch (e) {}
}

/** The right "ready" toast for whatever kind of job just finished. */
function readyToast(job, res) {
  if (job && job.mode === 'kit') kitReadyToast(job, res);
  else deckReadyToast(job, res);
}

/** Last prompt used in a class, so the sheet opens on her choice. */
const LAST_PROMPT_KEY = (classId) => 'studyos_kit_prompt_' + classId;

/**
 * Where a prompt comes from, as a short suffix for its <option>.
 *
 * A prompt pinned to several classes is ONE entry (see prompts.all()), so
 * "(this class)" can no longer be inferred from `source` alone — it has to be
 * checked against classIds, or a prompt borrowed from another class would
 * claim to be local.
 */
function promptOrigin(p, classId) {
  const ids = p.classIds || [];
  if (ids.includes(classId)) return p.source === 'class' ? ' (this class)' : '';
  if (!ids.length) return '';
  const from = p._from && p._from.className;
  return from ? ` (from ${from})` : ' (another class)';
}

// ── P-3: run a prompt on one or more files ────────────────────────────────
/**
 * Generate from one or more source files: a STUDY KIT (Claude — flashcards,
 * quiz, cheat sheet, optionally a rewritten deck) or a SLIDE DECK (NotebookLM).
 *
 * Both run on the local bridge. The kit is the default because it is what
 * turns a lecture into something to practise with; the deck stays one click
 * away for when a new set of slides is the goal.
 *
 * @param {object} cls      the class the files belong to
 * @param {Array}  files    one or more file entries
 * @param {string} destModuleId  where a generated deck should land
 */
export function openRunSheet(cls, files, destModuleId) {
  if (!pipeline.enabled()) {
    toast('⚠️', 'Pipeline is off', 'Set up the local bridge first, then enable it in config.');
    return;
  }
  // Both engines drive a browser on this machine, which is what the local
  // bridge is. The Cloudflare Worker cannot, so against a Worker baseUrl this
  // says so rather than silently producing something else.
  if (!pipeline.isLocalBridge()) {
    toast('⚠️', 'Needs the local bridge',
      'Study kits and decks drive a browser on this PC. Point config.cloudflare.ai.baseUrl at http://127.0.0.1:8781.');
    return;
  }
  const list = (Array.isArray(files) ? files : [files]).filter(Boolean);
  if (!list.length) return;

  // Give the class its style presets the first time a kit is possible. They
  // are ordinary prompts in a "Study Kit Presets" module from then on.
  try {
    const B = window._sosBridge;
    if (B && typeof B.ensurePromptModule === 'function') B.ensurePromptModule(cls.id, PRESET_MODULE, PRESETS);
  } catch (e) { console.warn('[pipeline] could not seed presets:', e); }

  const choices = prompts.forClass(cls.id);
  if (!choices.length) {
    toast('⚠️', 'No prompts yet',
      'Add a prompt to a prompts module in any class first.');
    return;
  }
  let lastPrompt = '';
  try { lastPrompt = localStorage.getItem(LAST_PROMPT_KEY(cls.id)) || ''; } catch (e) {}
  const presetMod = (cls.modules || []).find(m => m.type === 'prompts' && m.name === PRESET_MODULE);
  const firstPreset = presetMod && choices.find(p => p._from && p._from.moduleId === presetMod.id);
  const initial = choices.find(p => p.id === lastPrompt) || firstPreset || choices[0];
  const anyPdf = list.some(f => /\.pdf$/i.test(f.name || ''));

  const s = sheet(
    list.length === 1 ? 'Generate' : `Generate from ${list.length} files`,
    `
    <div style="font-size:12px;color:var(--text3);font-family:var(--mono);margin-bottom:10px">
      ${list.length === 1 ? esc(list[0].name || 'file') : esc(list.map(f => f.name).filter(Boolean).slice(0, 3).join(', ')) + (list.length > 3 ? ` +${list.length - 3} more` : '')}
    </div>
    <div class="field">
      <label>Make</label>
      <div style="display:flex;gap:14px;flex-wrap:wrap">
        <label style="display:flex;gap:6px;align-items:center;font-size:13px;cursor:pointer;text-transform:none">
          <input type="radio" name="sos-ai-mode" value="kit" checked> Study kit
          <span style="color:var(--text3);font-size:11px">cards · quiz · cheat sheet</span></label>
        <label style="display:flex;gap:6px;align-items:center;font-size:13px;cursor:pointer;text-transform:none">
          <input type="radio" name="sos-ai-mode" value="notebooklm"> Slide deck
          <span style="color:var(--text3);font-size:11px">NotebookLM</span></label>
      </div>
    </div>
    <div class="field">
      <label>Style</label>
      <select id="sos-ai-prompt">
        ${choices.map(p => `<option value="${esc(p.id)}"${p === initial ? ' selected' : ''}>${esc(p.name || 'Untitled')}${esc(promptOrigin(p, cls.id))}</option>`).join('')}
      </select>
    </div>
    <div class="field" id="sos-ai-kitopts">
      <label style="display:flex;gap:8px;align-items:center;cursor:pointer;text-transform:none">
        <input type="checkbox" id="sos-ai-rewrite" ${anyPdf ? 'checked' : 'disabled'}>
        Also rewrite the deck${anyPdf ? '' : ' (PDFs only)'}
      </label>
    </div>
    <div class="field" id="sos-ai-destfield">
      <label>File the deck into</label>
      <select id="sos-ai-dest"></select>
    </div>
    <div id="sos-ai-vars"></div>
    <div id="sos-ai-cost" style="font-size:11px;color:var(--text3);font-family:var(--mono);margin-top:10px;line-height:1.5"></div>
    <div id="sos-ai-budget" style="font-size:11px;color:var(--text3);font-family:var(--mono);margin-top:8px"></div>
    `, { wide: true });

  const sel = s.overlay.querySelector('#sos-ai-prompt');
  const varsEl = s.overlay.querySelector('#sos-ai-vars');
  const rewriteBox = s.overlay.querySelector('#sos-ai-rewrite');
  const modeOf = () => (s.overlay.querySelector('input[name="sos-ai-mode"]:checked') || {}).value || 'kit';

  // Destination: documents modules only. A notes module renders from the
  // editor's own store, so a PDF filed there would display nowhere.
  //
  // The default is deliberately NOT destModuleId — that is the module the
  // SOURCE file lives in, so accepting it would file a generated deck back
  // into "Lecture Notes" alongside the lecture it was made from. Prefer a
  // module that already looks like a home for generated output, then the
  // caller's hint, then anything.
  const destSel = s.overlay.querySelector('#sos-ai-dest');
  const docMods = (cls.modules || []).filter(m => m.type === 'documents');
  const looksGenerated = (m) => /generated|gemini|ai\b/i.test(m.name || '');
  const preferred = docMods.find(looksGenerated)
    || docMods.find(m => m.id === destModuleId)
    || docMods[0];
  destSel.innerHTML = docMods
    .map(m => `<option value="${esc(m.id)}"${m === preferred ? ' selected' : ''}>${esc(m.name || 'Untitled')}</option>`)
    .join('') + '<option value="">New "Generated" module</option>';

  // Say what a run costs BEFORE it is spent: both engines draw on her own
  // account limits, not on a budget this app controls.
  const costEl = s.overlay.querySelector('#sos-ai-cost');
  const paintMode = () => {
    const kitOn = modeOf() === 'kit';
    s.overlay.querySelector('#sos-ai-kitopts').style.display = kitOn ? '' : 'none';
    const wantsDeck = !kitOn || (rewriteBox && rewriteBox.checked);
    s.overlay.querySelector('#sos-ai-destfield').style.display = wantsDeck ? '' : 'none';
    const n = list.length;
    costEl.textContent = kitOn
      ? `Uses about ${2 * n}–${3 * n} Claude messages${rewriteBox && rewriteBox.checked ? ', plus 1 per 15 slides for the rewrite' : ''}. Cards and questions land in this class; the cheat sheet goes to a "Study Kit" notes module. You can close the tab.`
      : `Uses ${n} NotebookLM slide-deck generation${n === 1 ? '' : 's'} from your daily quota. It takes a while — you can close the tab.`;
  };
  s.overlay.querySelectorAll('input[name="sos-ai-mode"]').forEach(r => r.addEventListener('change', paintMode));
  if (rewriteBox) rewriteBox.addEventListener('change', paintMode);
  paintMode();

  // Show which {{variables}} will be filled, and which will not. An unfilled
  // one stays literal at run time on purpose, so surface it before spending.
  const showVars = () => {
    const p = choices.find(x => x.id === sel.value);
    const used = p ? prompts.variablesIn(p.text) : [];
    if (!used.length) { varsEl.innerHTML = ''; return; }
    const resolved = prompts.interpolate(p.text, { cls });
    const unresolved = prompts.variablesIn(resolved);
    varsEl.innerHTML = `
      <div style="font-size:11px;font-family:var(--mono);color:var(--text3);margin-top:4px">
        Variables: ${used.map(v => {
          const bad = unresolved.includes(v);
          return `<span style="color:${bad ? '#f0bd86' : 'var(--text2)'}">{{${esc(v)}}}${bad ? ' — no value' : ''}</span>`;
        }).join(' · ')}
      </div>`;
  };
  sel.addEventListener('change', showVars);
  showVars();

  // P-7: show month-to-date spend before a batch, not after.
  pipeline.budget().then(b => {
    const el = s.overlay.querySelector('#sos-ai-budget');
    if (el) el.textContent = `This month: $${(b.spend || 0).toFixed(2)} of $${(b.cap || 0).toFixed(2)}`;
  }).catch(() => {});

  const run = document.createElement('button');
  run.className = 'btn primary';
  run.textContent = list.length === 1 ? 'Generate' : `Generate all ${list.length}`;
  const cancel = document.createElement('button');
  cancel.className = 'btn';
  cancel.textContent = 'Cancel';
  cancel.onclick = s.close;

  run.onclick = async () => {
    run.disabled = true;
    run.textContent = 'Queueing…';
    const p = choices.find(x => x.id === sel.value);
    const mode = modeOf();
    try { localStorage.setItem(LAST_PROMPT_KEY(cls.id), p.id); } catch (e) {}
    try {
      const results = await pipeline.runBatch(list, {
        prompt: prompts.interpolate(p.text, { cls }),
        promptId: p.id,
        promptVersion: p.version || 1,
        classId: cls.id,
        outputModuleId: destSel.value || '',
        // No slideCount: NotebookLM generates the whole deck in one pass, and
        // for a kit's rewrite the bridge counts the PDF's pages itself.
        mode,
        kitRewrite: mode === 'kit' && !!(rewriteBox && rewriteBox.checked),
      });
      const ok = results.filter(r => r.ok).length;
      const cached = results.filter(r => r.cached).length;
      const failed = results.filter(r => !r.ok);
      s.close();

      if (failed.length) {
        toast('⚠️', `${ok} queued, ${failed.length} failed`, failed[0].error);
      } else if (cached === results.length) {
        toast('✅', 'Already done', 'Re-filing what was generated before — nothing was spent.');
      } else {
        toast('⚡', `${ok} queued`, (mode === 'kit' ? 'Claude is building the study kit' : 'NotebookLM is building them')
          + '. They keep running if you close the tab.');
      }
      results.filter(r => r.ok && r.job && !r.cached).forEach(r => trackJob(r.job.id));

      // A CACHED hit still has to be filed.
      //
      // The cache answers "this was generated before", which is not the same as
      // "the deck is still in the app". Deleting the Generated module (or the
      // file inside it) leaves the result sitting on the bridge with no way to
      // ask for it again: re-running reported "Already done" and produced
      // nothing, with the source file's only copy of its output unreachable.
      // Re-filing is idempotent — addGeneratedDoc replaces by sourceFileId — so
      // this restores a deleted deck and is a no-op when one is already there.
      for (const r of results.filter(r => r.ok && r.job && r.cached)) {
        try {
          const job = (r.job.result && (r.job.mode !== 'kit' || r.job.kit)) ? r.job : await pipeline.getJob(r.job.id);
          if (job) readyToast(job, await pipeline.fileResult(job));
        } catch (e) {
          console.warn('[pipeline] could not re-file a cached job:', e);
        }
      }
    } catch (e) {
      run.disabled = false;
      run.textContent = 'Generate';
      // A dead local bridge surfaces as a bare "Failed to fetch", which says
      // nothing about what to do. Name the actual cause and the one-time fix.
      const dead = pipeline.isLocalBridge()
        && /failed to fetch|networkerror|load failed/i.test(String(e.message || e));
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
      if (doc) readyToast(job, doc);
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
          readyToast(job, doc);
        } else if (doc) {
          await pipeline.markFiled(job.id);
          readyToast(job, doc);
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
            ${esc(j.mode === 'kit' ? 'study kit' : j.mode === 'notebooklm' ? 'deck' : (j.mode || 'rewrite'))}
            · ${esc(j.status)}${j.mode === 'kit' && j.status === 'running' && j.kitStage ? ' (' + esc(j.kitStage) + ')' : ''}${j.progress ? ' · ' + j.progress + '%' : ''}${elapsed ? ' · ' + elapsed : ''}${j.costUsd ? ' · $' + j.costUsd.toFixed(3) : ''}
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

export default { openRunSheet, openJobsPanel, openAutoRunSheet, trackJob, resumeWatches };
