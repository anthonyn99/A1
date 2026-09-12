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
}

// ── P-3: run a prompt on one or more files ────────────────────────────────
/**
 * @param {object} cls      the class the files belong to
 * @param {Array}  files    one or more file entries
 * @param {string} destModuleId  where the generated note should land
 */
export function openRunSheet(cls, files, destModuleId) {
  if (!pipeline.enabled()) {
    toast('⚠️', 'Pipeline is off', 'Set up the studyos-ai Worker first, then enable it in config.');
    return;
  }
  const list = (Array.isArray(files) ? files : [files]).filter(Boolean);
  if (!list.length) return;

  const choices = prompts.forClass(cls.id);
  if (!choices.length) {
    toast('⚠️', 'No prompts yet', 'Add a prompt to this class first.');
    return;
  }

  const s = sheet(
    list.length === 1 ? 'Run a prompt' : `Run on ${list.length} files`,
    `
    <div style="font-size:12px;color:var(--text3);font-family:var(--mono);margin-bottom:10px">
      ${list.length === 1 ? esc(list[0].name || 'file') : esc(list.map(f => f.name).filter(Boolean).slice(0, 3).join(', ')) + (list.length > 3 ? ` +${list.length - 3} more` : '')}
    </div>
    <div class="field">
      <label>Prompt</label>
      <select id="sos-ai-prompt">
        ${choices.map(p => `<option value="${esc(p.id)}">${esc(p.name || 'Untitled')}${p.source === 'class' ? ' (this class)' : ''}</option>`).join('')}
      </select>
    </div>
    <div class="field">
      <label>Slides in the deck <span style="color:var(--text3);font-weight:400">— leave blank if unsure</span></label>
      <input type="number" id="sos-ai-slides" min="1" max="600" placeholder="e.g. 42">
    </div>
    <div id="sos-ai-vars"></div>
    <div id="sos-ai-budget" style="font-size:11px;color:var(--text3);font-family:var(--mono);margin-top:8px"></div>
    `, { wide: true });

  const sel = s.overlay.querySelector('#sos-ai-prompt');
  const varsEl = s.overlay.querySelector('#sos-ai-vars');

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
  run.textContent = list.length === 1 ? 'Run' : `Run on all ${list.length}`;
  const cancel = document.createElement('button');
  cancel.className = 'btn';
  cancel.textContent = 'Cancel';
  cancel.onclick = s.close;

  run.onclick = async () => {
    run.disabled = true;
    run.textContent = 'Queueing…';
    const p = choices.find(x => x.id === sel.value);
    const slides = parseInt(s.overlay.querySelector('#sos-ai-slides').value, 10);
    try {
      const results = await pipeline.runBatch(list, {
        prompt: prompts.interpolate(p.text, { cls }),
        promptId: p.id,
        promptVersion: p.version || 1,
        classId: cls.id,
        outputModuleId: destModuleId || '',
        ...(Number.isFinite(slides) && slides > 0 ? { slideCount: slides } : {}),
      });
      const ok = results.filter(r => r.ok).length;
      const cached = results.filter(r => r.cached).length;
      const failed = results.filter(r => !r.ok);
      s.close();

      if (failed.length) {
        toast('⚠️', `${ok} queued, ${failed.length} failed`, failed[0].error);
      } else if (cached === results.length) {
        toast('✅', 'Already done', 'These were generated before — nothing was spent.');
      } else {
        toast('⚡', `${ok} queued`, 'They keep running if you close the tab.');
      }
      results.filter(r => r.ok && r.job && !r.cached).forEach(r => trackJob(r.job.id));
    } catch (e) {
      run.disabled = false;
      run.textContent = 'Run';
      toast('⚠️', 'Could not queue', String(e.message || e));
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
      if (doc) toast('✅', 'Deck ready', job.sourceName || doc.title);
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
        if (doc) {
          await pipeline.markFiled(job.id);
          toast('✅', 'Deck ready', job.sourceName || doc.title);
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
      as a note. Spending still stops at the monthly cap.
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
