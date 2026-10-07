/* ============================================================================
 * StudyOS — topic breakdown UI  (the document row, and the topics under it)
 * ============================================================================
 * studyos.js's refreshDocList calls window.sosDecorateDocRow(item, cls, mod, f)
 * for every file row. For a PDF, a Word document or a slide deck this adds ONE button — "Break down" before a
 * breakdown exists, "Topics · 12" after — and, under the row, the document's
 * topics: click one to open its lesson.
 * ------------------------------------------------------------------------- */

import * as bd from './breakdown.js';
import * as ai from './ai.js';
import { sheet, toast } from './pipeline-ui.js';
import { ensureStyle } from './study-style.js';
import { escapeHtml as esc } from './md.js';
import { isBreakable, isSlidesFile, isWordFile } from './pipeline.js';
import * as prompts from './prompts.js';
const _open = new Set();              // fileIds whose topic list is expanded

/** A row's label, from the freshest thing known: the loaded doc, else the
 *  summary persisted on the file. */
function label(f) {
  const doc = bd.peek(f.id);
  const st = doc && doc.status !== 'removed'
    ? { status: doc.status, total: doc.topics.length, done: doc.topics.filter(t => t.status === 'ready').length }
    : (doc ? null : f.study);
  if (bd.isRunning(f.id) || (st && st.status === 'running')) {
    return st && st.total ? `Writing ${st.done}/${st.total}` : 'Listing topics…';
  }
  if (!st || !st.total) return st && st.status === 'failed' ? 'Break down ⚠' : 'Break down';
  if (st.done < st.total) return `Topics · ${st.done}/${st.total} ⚠`;
  return `Topics · ${st.total}`;
}

const hasBreakdown = (f) => {
  const doc = bd.peek(f.id);
  if (doc) return doc.status !== 'removed' && (doc.topics.length > 0 || doc.status === 'running');
  return !!(f.study && (f.study.total || f.study.status === 'running')) || bd.isRunning(f.id);
};

export function decorate(item, cls, mod, f) {
  if (!isBreakable(f) || !window._sosRowActionBtn) return;
  ensureStyle();
  const btn = window._sosRowActionBtn(label(f), 'Break this document into topics, each with a lesson and flashcards');
  btn.dataset.act = 'breakdown';
  btn.dataset.bdFile = f.id;
  const before = item.querySelector('[data-act="copy"]');
  if (before) item.insertBefore(btn, before); else item.appendChild(btn);

  // Edit mode reorders rows by dragging; a sibling panel between rows would
  // be dragged as if it were a file. The list comes back when editing ends.
  const editing = !!item.querySelector('.row-drag-handle');
  let panel = null;
  if (!editing) {
    panel = document.createElement('div');
    panel.className = 'sos-topics';
    panel.dataset.bdPanel = f.id;
    panel.hidden = !_open.has(f.id);
    item.after(panel);
    if (!panel.hidden) renderPanel(panel, cls, mod, f);
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!hasBreakdown(f)) { openStart(cls, mod, f); return; }
    if (!panel) return;
    panel.hidden = !panel.hidden;
    if (panel.hidden) _open.delete(f.id);
    else { _open.add(f.id); renderPanel(panel, cls, mod, f); }
  });
}

// ── Her prompt ───────────────────────────────────────────────────────────
/* Breakdown prompts live in a prompts module she makes in the class, like the
 * deck sheet's. What she picks is ADDED to the built-in prompt (breakdown.js
 * instructionsBlock), and she can edit it for this one document first. */
const PREFS_KEY = 'studyos_bd_prefs_v1';
const NEW_MODULE = '__new__';
function prefsOf(classId) {
  try { return (JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {})[classId] || {}; }
  catch (e) { return {}; }
}
function savePrefs(classId, prefs) {
  try {
    const all = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {};
    all[classId] = prefs;
    localStorage.setItem(PREFS_KEY, JSON.stringify(all));
  } catch (e) { /* quota full: remembered for nothing, nothing lost */ }
}
const firstLine = (text) => {
  const l = String(text || '').trim().split('\n')[0] || 'Untitled prompt';
  return l.length > 70 ? l.slice(0, 67) + '…' : l;
};

function promptPickerHtml() {
  return `
    <div class="field" style="margin-top:14px">
      <label>Your prompt <span style="color:var(--text3);font-weight:400">— optional, added to the built-in one</span></label>
      <select id="sos-bd-pmod"></select>
      <input id="sos-bd-newpm" placeholder="New module name" value="Breakdown prompts" style="display:none;margin-top:6px">
      <select id="sos-bd-prompt" style="margin-top:6px"></select>
      <textarea id="sos-bd-text" rows="5" style="margin-top:6px;width:100%;font-size:12.5px;line-height:1.5"
        placeholder="e.g. My exam is multiple choice — stress the distinctions between similar terms, and give a worked example for every formula."></textarea>
      <div id="sos-bd-vars"></div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:6px">
        <button class="btn" id="sos-bd-save" style="padding:3px 10px;font-size:11px">Save as a new prompt</button>
        <span id="sos-bd-edited" style="font-size:11px;color:var(--text3);font-family:var(--mono)"></span>
      </div>
      <div style="font-size:11px;color:var(--text3);font-family:var(--mono);margin-top:6px;line-height:1.5">
        Edits here apply to this document only, unless you save them. Your prompt steers what to
        emphasise and how to explain; covering the whole document and the checks against it stay on.
      </div>
    </div>`;
}

/** Wire the picker. Returns () => the instructions to run with (null = none). */
function wirePicker(root, cls, preset) {
  const B = window._sosBridge;
  const live = () => (window.SOS && window.SOS.store && window.SOS.store.getClass(cls.id)) || cls;
  const promptMods = () => (live().modules || []).filter((m) => m.type === 'prompts');
  const $ = (sel) => root.querySelector(sel);
  const pmodSel = $('#sos-bd-pmod'), promptSel = $('#sos-bd-prompt'), newPm = $('#sos-bd-newpm');
  const ta = $('#sos-bd-text'), varsEl = $('#sos-bd-vars'), saveBtn = $('#sos-bd-save'), editedEl = $('#sos-bd-edited');

  const pmOf = (id) => promptMods().find((m) => m.id === id);
  const current = () => {
    const m = pmOf(pmodSel.value);
    return (m && (m.prompts || []).find((p) => p.id === promptSel.value)) || null;
  };
  const showVars = () => {
    const used = prompts.variablesIn(ta.value);
    if (!used.length) { varsEl.innerHTML = ''; return; }
    const unresolved = prompts.variablesIn(prompts.interpolate(ta.value, { cls: live() }));
    varsEl.innerHTML = `<div style="font-size:11px;font-family:var(--mono);color:var(--text3);margin-top:4px">Variables: ${
      used.map((v) => {
        const bad = unresolved.includes(v);
        return `<span style="color:${bad ? '#f0bd86' : 'var(--text2)'}">{{${esc(v)}}}${bad ? ' — no value' : ''}</span>`;
      }).join(' · ')}</div>`;
  };
  const sync = () => {
    const p = current();
    const text = ta.value.trim();
    const edited = !!p && text !== String(p.text || '').trim();
    editedEl.textContent = edited ? 'edited for this document' : '';
    saveBtn.style.display = text && (!p || edited) ? '' : 'none';
    showVars();
  };
  const fillModules = (preferId) => {
    const mods = promptMods();
    pmodSel.innerHTML = `<option value="">None — built-in prompt only</option>` +
      mods.map((m) => `<option value="${esc(m.id)}">${esc(m.name || 'Untitled')} (${(m.prompts || []).length})</option>`).join('') +
      `<option value="${NEW_MODULE}">New prompts module…</option>`;
    pmodSel.value = preferId && (preferId === NEW_MODULE || pmOf(preferId)) ? preferId : '';
  };
  const fillPrompts = (preferId, keepText) => {
    const isNew = pmodSel.value === NEW_MODULE;
    newPm.style.display = isNew ? '' : 'none';
    const m = pmOf(pmodSel.value);
    const ps = (m && m.prompts) || [];
    promptSel.innerHTML = ps.map((p) => `<option value="${esc(p.id)}">${esc(p.name || firstLine(p.text))}</option>`).join('');
    promptSel.style.display = ps.length ? '' : 'none';
    if (preferId && ps.some((p) => p.id === preferId)) promptSel.value = preferId;
    if (!keepText) { const p = current(); ta.value = p ? p.text : ''; }
    sync();
  };

  const remembered = preset || prefsOf(cls.id);
  fillModules(remembered.moduleId);
  fillPrompts(remembered.promptId, false);
  if (preset && preset.text != null) { ta.value = preset.text; sync(); }

  pmodSel.addEventListener('change', () => { fillPrompts(null, false); if (pmodSel.value === NEW_MODULE) newPm.focus(); });
  promptSel.addEventListener('change', () => fillPrompts(promptSel.value, false));
  ta.addEventListener('input', sync);

  saveBtn.addEventListener('click', (e) => {
    e.preventDefault();
    const text = ta.value.trim();
    if (!text || !B || !B.addPromptTo) return;
    let modId = pmodSel.value;
    if (!modId) {
      // "None" has nowhere to save to: point at a module (or a new one) first.
      const first = promptMods()[0];
      pmodSel.value = first ? first.id : NEW_MODULE;
      fillPrompts(null, true);
      if (!first) { newPm.focus(); newPm.select(); }
      toast('ℹ️', first ? `Save it to “${first.name}”?` : 'Name the new prompts module', 'Then press Save again.');
      return;
    }
    if (modId === NEW_MODULE) {
      const name = newPm.value.trim();
      if (!name) { newPm.focus(); return; }
      modId = B.addModule && B.addModule(cls.id, name, 'prompts');
      if (!modId) { toast('⚠️', 'Could not create the module', name); return; }
    }
    const id = B.addPromptTo(cls.id, modId, text);
    if (!id) { toast('⚠️', 'Could not save the prompt', ''); return; }
    fillModules(modId);
    fillPrompts(id, true);
    toast('✅', 'Prompt saved', (pmOf(modId) || {}).name || '');
  });

  return () => {
    const raw = ta.value.trim();
    const p = current();
    const modId = pmodSel.value === NEW_MODULE ? '' : pmodSel.value;
    savePrefs(cls.id, { moduleId: modId, promptId: p ? p.id : '' });
    if (!raw) return null;
    const edited = !p || raw !== String(p.text || '').trim();
    const base = p ? (p.name || firstLine(p.text)) : 'Custom prompt';
    return {
      text: prompts.interpolate(raw, { cls: live() }),
      promptId: p ? p.id : '', moduleId: modId,
      name: p && edited ? base + ' (edited)' : base,
    };
  };
}

// ── Start ────────────────────────────────────────────────────────────────
/** @param {{redo?: object}} opts  redo: re-run a finished breakdown from
 *  scratch, the picker preset to the prompt it last used. */
function openStart(cls, mod, f, { redo } = {}) {
  const a = ai.active();
  const bridge = a.id === 'bridge';
  const s = sheet(redo ? 'Redo the breakdown' : 'Break down into topics', `
    <div style="font-size:12px;color:var(--text3);font-family:var(--mono);margin-bottom:12px">${esc(f.name)}</div>
    ${redo ? `<div style="font-size:12.5px;color:#f0bd86;line-height:1.5;margin-bottom:10px">
      Re-lists the topics and rewrites every lesson under the prompt below. Cards you have
      already reviewed keep their scheduling.</div>` : ''}
    <div style="font-size:13.5px;color:var(--text2);line-height:1.6">
      Lists every topic in this document, then writes each one a lesson — explained
      simply, nothing left out — with a few key flashcards. Only the cards worth
      remembering join your reviews (${(() => { const e = bd.estimateCards(8); return `about ${e.min}–${e.max} for a typical lecture`; })()});
      the next best wait as suggestions you can add.
    </div>
    <div class="ais-note" style="font-size:12px;color:var(--text3);line-height:1.55;background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:10px 12px;margin:14px 0 0">
      ${a.problem
        ? `<span style="color:#f0bd86">${esc(a.problem)}</span>`
        : `Uses <b style="color:var(--text2)">${esc(a.label)}</b>${bridge ? '' : ` · ${esc(a.model)}`}.
           ${isSlidesFile(f) ? 'PowerPoint on this PC turns the slides into a PDF first (the bridge must be running). ' : ''}${
             isWordFile(f) ? 'Word on this PC turns the document into a PDF first (the bridge must be running). ' : ''}Every topic and lesson is checked against the document's own text; anything a lesson leaves out
           is asked for once more. About <b style="color:var(--text2)">1 + one per topic</b> requests (usually 6–13),
           plus a follow-up for a lesson that missed something${bridge
             ? ' — Claude Pro messages, a few minutes per topic'
             : a.id === 'orca'
               ? ' — messages from your ORCA chat accounts, a few minutes per topic; a busy model is waited for, not skipped'
               : ' — billed to your API key'}. It runs in the background; keep studying.`}
      <div style="margin-top:6px"><a href="#" data-ai-settings style="color:var(--accent2);font-size:11px;font-family:var(--mono)">Change the AI model →</a></div>
    </div>
    ${promptPickerHtml()}`, { wide: true });
  s.overlay.querySelector('[data-ai-settings]').addEventListener('click', (e) => {
    e.preventDefault(); s.close(); window.switchView && window.switchView('ai');
  });
  const instructions = wirePicker(s.overlay, cls, redo || null);
  const cancel = document.createElement('button');
  cancel.className = 'btn'; cancel.textContent = 'Cancel'; cancel.onclick = s.close;
  s.footer.append(cancel);
  if (a.problem) return;
  const go = document.createElement('button');
  go.className = 'btn primary'; go.textContent = redo ? 'Redo it' : 'Break it down'; go.id = 'sos-bd-go';
  go.onclick = async () => {
    const chosen = instructions();
    s.close();
    _open.add(f.id);
    // A redo clears the old run the way "Remove breakdown" does (unreviewed
    // cards go, reviewed ones keep their scheduling), so topics the new list
    // no longer has don't leave orphan cards behind.
    if (redo) await bd.remove(f.id);
    start(cls, mod, f, { instructions: chosen });
  };
  s.footer.append(go);
}

function start(cls, mod, f, opts) {
  const p = bd.run(cls.id, mod.id, f, opts);
  refresh(f.id);
  p.then((doc) => {
    if (!doc) return;
    const n = doc.topics.filter(t => t.status === 'ready').length;
    if (doc.status === 'ready') toast('✅', 'Topics ready', `${f.name} — ${n} lesson${n === 1 ? '' : 's'} with flashcards.`);
    else if (doc.status === 'partial') toast('⚠️', `${n} of ${doc.topics.length} topics written`, doc.error || 'Retry the rest from the list.');
    else if (doc.status === 'failed') toast('⚠️', 'Breakdown stopped', doc.error || 'unknown error');
  }).catch((e) => toast('⚠️', 'Breakdown failed', (e && e.message) || String(e)));
}

// ── The topics under a document ──────────────────────────────────────────
async function renderPanel(panel, cls, mod, f) {
  const doc = await bd.load(f.id);
  if (!panel.isConnected) return;
  const running = bd.isRunning(f.id);
  const stale = !running && bd.isStale(doc);
  if (!doc || doc.status === 'removed') {
    panel.innerHTML = `<div class="bd-status">${running ? 'Listing topics…' : 'No breakdown yet.'}</div>`;
    return;
  }
  const topics = doc.topics || [];
  const ready = topics.filter(t => t.status === 'ready');
  const cards = topics.reduce((n, t) => n + (t.status === 'ready' ? (t.cardCount || 0) : 0), 0);
  const html = [];
  if (!topics.length) {
    const w = running && bd.waitingOf(f.id);
    html.push(`<div class="bd-status${doc.status === 'failed' ? ' err' : ''}">${
      doc.status === 'failed' ? esc(doc.error || 'Could not list the topics.')
        : w ? esc(`Waiting for a free model until ${clock(w.until)}${w.why ? ` — ${w.why}` : ''}…`)
        : `Listing topics with ${esc(providerName(doc))}…`}</div>`);
  } else {
    const status = running
      ? `Writing lessons — ${ready.length} of ${topics.length} done.`
      : stale ? `Interrupted at ${ready.length} of ${topics.length}. Continue to finish it.`
      : doc.error ? doc.error : `${topics.length} topics`;
    // The detail — who wrote it, what was checked — is one tap away, not a
    // wall of text on every document (overhaul §3.4).
    const detail = [writtenBy(topics).replace(/^ · /, ''), checksNote(doc.checks).replace(/^ · /, ''), doc.syncError || '']
      .filter(Boolean).join(' · ');
    const ins = doc.instructions && doc.instructions.text ? doc.instructions : null;
    const infoOpen = _info.has(f.id);
    html.push(`<div class="bd-status${doc.error && !running ? ' err' : ''}">${esc(status)}${
      ins ? ` · <span title="${esc(ins.text)}" style="cursor:help;border-bottom:1px dotted currentColor">prompt: ${esc(ins.name || 'custom')}</span>` : ''}${
      detail && !running ? ` <button class="bd-info" data-info title="How it was written and checked" aria-expanded="${infoOpen}">ⓘ</button>` : ''}</div>${
      detail && infoOpen && !running ? `<div class="bd-detail">${esc(detail)}</div>` : ''}`);
    topics.forEach((t, i) => {
      const ok = t.status === 'ready';
      const done = ok && t.progress && t.progress.done;
      const gaps = ok && t.gaps ? t.gaps.length : 0;
      const w = running && t.status === 'writing' && bd.waitingOf(f.id, t.id);
      const tc = ok ? topicCounts(doc, t) : null;
      const badge = ok ? ''
        : w ? `waiting · until ${clock(w.until)}`
        : t.status === 'writing' && !running ? 'interrupted'
        : t.status === 'writing' ? `writing…${running && t.startedAt ? ' ' + minutes(t.startedAt) : ''}`
        : t.status === 'failed' ? (running && t.retryable ? 'retrying later' : 'failed')
        : running ? 'queued' : 'not written';
      html.push(`
        <div class="bd-row${ok ? '' : ' off'}" data-topic="${esc(t.id)}" ${ok ? 'role="button" tabindex="0"' : ''}>
          <div class="bd-num${done ? ' done' : ''}">${done ? '✓' : i + 1}</div>
          <div class="bd-main">
            <div class="bd-title">${esc(t.title)}</div>
            <div class="bd-sum">${esc(t.status === 'failed' ? (t.error || 'failed') : t.summary || '')}</div>
          </div>
          ${ok ? `<div class="bd-boxes">
            <button class="bd-box" data-lesson="${esc(t.id)}" title="${gaps ? `${gaps} line${gaps === 1 ? '' : 's'} of the document not fully taught — shown at the end of the lesson` : 'Open the lesson'}">Lesson</button>
            <button class="bd-box" data-cards="${esc(t.id)}" ${tc.active ? '' : 'disabled'} title="${tc.active ? `Study this topic’s cards · ${tc.mastery}% mastered` : 'No cards in your reviews yet'}">${ring(tc.mastery)}Flashcards${tc.due ? '<span class="bd-dot" aria-label="cards due"></span>' : ''}</button>
            ${tc.suggested ? `<button class="bd-box bd-sugg" data-triage="${esc(t.id)}" title="${tc.suggested} suggested card${tc.suggested === 1 ? '' : 's'} held back — add the ones you want">+</button>` : ''}
          </div>` : `<div class="bd-badge${t.status === 'failed' ? ' fail' : ''}">${esc(badge)}</div>`}
          ${t.status === 'failed' && !running ? `<button data-retry="${esc(t.id)}">Retry</button>` : ''}
        </div>`);
    });
  }
  const unfinished = topics.some(t => t.status !== 'ready');
  html.push(`<div class="bd-actions">
    ${cards ? `<button data-review>Review this document’s cards</button>` : ''}
    ${!running && (unfinished || (!topics.length && doc.status === 'failed')) ? `<button data-continue>${topics.length ? 'Write the rest' : 'Try again'}</button>` : ''}
    ${!running && topics.length ? `<button data-redo>Redo with another prompt</button>` : ''}
    ${!running ? `<button class="quiet" data-remove>Remove breakdown</button>` : ''}
  </div>`);
  panel.innerHTML = html.join('');

  panel.querySelectorAll('.bd-row:not(.off)').forEach((row) => {
    const open = () => window.SOS && window.SOS.lessonUi && window.SOS.lessonUi.open(f.id, row.dataset.topic);
    row.addEventListener('click', (e) => { if (!e.target.closest('button')) open(); });
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  });
  panel.querySelectorAll('[data-lesson]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    window.SOS && window.SOS.lessonUi && window.SOS.lessonUi.open(f.id, b.dataset.lesson);
  }));
  panel.querySelectorAll('[data-cards]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const D = window.SOS && window.SOS.deck, R = window.SOS && window.SOS.review;
    if (!D || !R) return;
    const scope = { classId: doc.classId, noteId: bd.noteIdFor(f.id, b.dataset.cards) };
    // Something to learn or review today → a normal session (it schedules),
    // even before the lesson is opened: she picked this topic on purpose.
    // Otherwise go through every card anyway as practice — cram leaves the
    // schedule alone, so it never "Nothing to study"s her.
    if (D.studyQueue(scope, {}).length) R.startReview(scope, { anyNew: true });
    else R.startReview(scope, { mode: 'cram' });
  }));
  panel.querySelectorAll('[data-retry]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    b.disabled = true;
    bd.regenerate(f.id, b.dataset.retry, f).catch((err) => toast('⚠️', 'Retry failed', err.message || String(err)));
    refresh(f.id);
  }));
  const info = panel.querySelector('[data-info]');
  if (info) info.addEventListener('click', (e) => {
    e.stopPropagation();
    if (_info.has(f.id)) _info.delete(f.id); else _info.add(f.id);
    refresh(f.id);
  });
  panel.querySelectorAll('[data-triage]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const C = window.SOS && window.SOS.cardsUi;
    if (C) C.openTriage({ classId: doc.classId, noteId: bd.noteIdFor(f.id, b.dataset.triage), onClose: () => refresh(f.id) });
  }));
  const rv = panel.querySelector('[data-review]');
  if (rv) rv.addEventListener('click', () => {
    window.SOS && window.SOS.review && window.SOS.review.startReview({ classId: doc.classId, notePrefix: bd.notePrefixFor(f.id) });
  });
  const cont = panel.querySelector('[data-continue]');
  if (cont) cont.addEventListener('click', () => start(cls, mod, f));
  const redo = panel.querySelector('[data-redo]');
  if (redo) redo.addEventListener('click', () => {
    const ins = doc.instructions || {};
    openStart(cls, mod, f, { redo: { moduleId: ins.moduleId || '', promptId: ins.promptId || '', text: ins.text || '' } });
  });
  const rm = panel.querySelector('[data-remove]');
  if (rm) rm.addEventListener('click', async () => {
    if (!confirm(`Remove the topics and lessons for "${f.name}"?\n\nFlashcards you have already reviewed are kept; the rest are removed.`)) return;
    await bd.remove(f.id);
    _open.delete(f.id);
    refresh(f.id);
  });
}

const _info = new Set();            // files whose ⓘ detail is open

/** A topic's cards as the row shows them: in reviews, due, suggested, mastery. */
function topicCounts(doc, t) {
  const D = window.SOS && window.SOS.deck;
  if (!D) return { active: t.cardCount || 0, due: 0, suggested: t.suggested || 0, mastery: 0 };
  const list = D.forClass(doc.classId).filter((c) => c.sourceNoteId === bd.noteIdFor(doc.fileId, t.id));
  const c = D.deckCounts(list);
  return { active: list.filter(D.isActive).length, due: c.due, suggested: c.suggested, mastery: c.mastery };
}

/** A small mastery ring (mean retrievability of the topic's cards). */
function ring(pct) {
  const r = 7, len = 2 * Math.PI * r, on = Math.max(0, Math.min(100, pct)) / 100 * len;
  return `<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="${r}" fill="none" stroke="var(--border)" stroke-width="2.5"/>` +
    `<circle cx="9" cy="9" r="${r}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="${on.toFixed(2)} ${len.toFixed(2)}" transform="rotate(-90 9 9)"/></svg>`;
}

const providerName = (doc) => (doc.provider === 'bridge' ? 'Claude Pro'
  : doc.provider === 'orca' ? `ORCA${doc.model && doc.model !== 'Auto' ? ' · ' + doc.model : ''}` : doc.model || 'the AI');
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const minutes = (since) => {
  const m = Math.floor((Date.now() - since) / 60000);
  return m < 1 ? '' : `${m} min`;
};

/** " · written by DeepSeek ×5, ChatGPT ×3" — which ORCA models wrote it. */
function writtenBy(topics) {
  const n = new Map();
  for (const t of topics) {
    if (t.status !== 'ready' || !t.servedBy) continue;
    const who = ai.servedName(t.servedBy);
    n.set(who, (n.get(who) || 0) + 1);
  }
  if (!n.size) return '';
  return ' · written by ' + [...n].sort((a, b) => b[1] - a[1]).map(([who, c]) => `${who} ×${c}`).join(', ');
}

/** What the breakdown was checked against, for the status line. */
function checksNote(c) {
  if (!c) return '';
  if (c.skipped) return ` · not checked against the PDF (${c.skipped})`;
  if (!c.pages) return '';
  return ` · checked against all ${c.pages} pages${c.gaps ? ` · ${c.gaps} line${c.gaps === 1 ? '' : 's'} not fully taught` : ''}${
    c.figures ? ` · ${c.figures} figure${c.figures === 1 ? '' : 's'} from the document` : ''}${
    c.drawn ? ` · ${c.drawn} drawn` : ''}${
    c.figuresSkipped ? ` · ${c.figuresSkipped} figure${c.figuresSkipped === 1 ? '' : 's'} not seen (no image-capable model was free)` : ''}${
    c.pdfMissed ? ` · ${c.pdfMissed} lesson${c.pdfMissed === 1 ? '' : 's'} written from the text alone (no model that reads files was free)` : ''}`;
}

/** Repaint one document's button and topic list in place. */
function refresh(fileId) {
  document.querySelectorAll(`[data-bd-file="${CSS.escape(fileId)}"]`).forEach((btn) => {
    const f = findFile(fileId);
    if (f) btn.textContent = label(f.file);
  });
  document.querySelectorAll(`[data-bd-panel="${CSS.escape(fileId)}"]`).forEach((panel) => {
    const f = findFile(fileId);
    if (!f) return;
    if (_open.has(fileId)) { panel.hidden = false; renderPanel(panel, f.cls, f.mod, f.file); }
  });
}

/** A file anywhere in the live app state (the store's snapshot). */
export function findFile(fileId) {
  const store = window.SOS && window.SOS.store;
  for (const cls of (store && store.getClasses()) || []) {
    for (const mod of cls.modules || []) {
      const file = (mod.files || []).find((x) => x && x.id === fileId);
      if (file) return { cls, mod, file };
    }
  }
  return null;
}

window.addEventListener('sos-breakdown', (e) => {
  const id = e && e.detail && e.detail.fileId;
  if (id) refresh(id);
});

// A browser model takes minutes per topic: keep "writing… 3 min" moving
// on the open lists of running breakdowns.
setInterval(() => { for (const id of _open) if (bd.isRunning(id)) refresh(id); }, 30000);

export default { decorate, findFile };
