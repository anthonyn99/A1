/* ============================================================================
 * StudyOS — topic breakdown UI  (the document row, and the topics under it)
 * ============================================================================
 * studyos.js's refreshDocList calls window.sosDecorateDocRow(item, cls, mod, f)
 * for every file row. For a PDF or a slide deck this adds ONE button — "Break down" before a
 * breakdown exists, "Topics · 12" after — and, under the row, the document's
 * topics: click one to open its lesson.
 * ------------------------------------------------------------------------- */

import * as bd from './breakdown.js';
import * as ai from './ai.js';
import { sheet, toast } from './pipeline-ui.js';
import { ensureStyle } from './study-style.js';
import { escapeHtml as esc } from './md.js';
import { isBreakable, isSlidesFile } from './pipeline.js';
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

// ── Start ────────────────────────────────────────────────────────────────
function openStart(cls, mod, f) {
  const a = ai.active();
  const bridge = a.id === 'bridge';
  const s = sheet('Break down into topics', `
    <div style="font-size:12px;color:var(--text3);font-family:var(--mono);margin-bottom:12px">${esc(f.name)}</div>
    <div style="font-size:13.5px;color:var(--text2);line-height:1.6">
      Lists every topic in this document, then writes each one a lesson — explained
      simply, nothing left out — followed by its flashcards. The cards join your
      reviews automatically.
    </div>
    <div class="ais-note" style="font-size:12px;color:var(--text3);line-height:1.55;background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:10px 12px;margin:14px 0 0">
      ${a.problem
        ? `<span style="color:#f0bd86">${esc(a.problem)}</span>`
        : `Uses <b style="color:var(--text2)">${esc(a.label)}</b>${bridge ? '' : ` · ${esc(a.model)}`}.
           ${isSlidesFile(f) ? 'PowerPoint on this PC turns the slides into a PDF first (the bridge must be running). ' : ''}Every topic and lesson is checked against the document's own text; anything a lesson leaves out
           is asked for once more. About <b style="color:var(--text2)">1 + one per topic</b> requests (usually 6–13),
           plus a follow-up for a lesson that missed something${bridge
             ? ' — Claude Pro messages, a few minutes per topic'
             : ' — billed to your API key'}. It runs in the background; keep studying.`}
      <div style="margin-top:6px"><a href="#" data-ai-settings style="color:var(--accent2);font-size:11px;font-family:var(--mono)">Change the AI model →</a></div>
    </div>`, { wide: true });
  s.overlay.querySelector('[data-ai-settings]').addEventListener('click', (e) => {
    e.preventDefault(); s.close(); window.switchView && window.switchView('ai');
  });
  const cancel = document.createElement('button');
  cancel.className = 'btn'; cancel.textContent = 'Cancel'; cancel.onclick = s.close;
  s.footer.append(cancel);
  if (a.problem) return;
  const go = document.createElement('button');
  go.className = 'btn primary'; go.textContent = 'Break it down'; go.id = 'sos-bd-go';
  go.onclick = () => {
    s.close();
    _open.add(f.id);
    start(cls, mod, f);
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
  if (!doc || doc.status === 'removed') {
    panel.innerHTML = `<div class="bd-status">${running ? 'Listing topics…' : 'No breakdown yet.'}</div>`;
    return;
  }
  const topics = doc.topics || [];
  const ready = topics.filter(t => t.status === 'ready');
  const cards = topics.reduce((n, t) => n + (t.status === 'ready' ? (t.cardCount || 0) : 0), 0);
  const html = [];
  if (!topics.length) {
    html.push(`<div class="bd-status${doc.status === 'failed' ? ' err' : ''}">${
      doc.status === 'failed' ? esc(doc.error || 'Could not list the topics.')
        : `Listing topics with ${esc(doc.provider === 'bridge' ? 'Claude Pro' : doc.model || 'the AI')}…`}</div>`);
  } else {
    const status = running
      ? `Writing lessons — ${ready.length} of ${topics.length} done.`
      : doc.error ? doc.error : `${topics.length} topics · ${cards} flashcards${checksNote(doc.checks)}`;
    html.push(`<div class="bd-status${doc.error && !running ? ' err' : ''}">${esc(status)}${doc.syncError ? ` · ${esc(doc.syncError)}` : ''}</div>`);
    topics.forEach((t, i) => {
      const ok = t.status === 'ready';
      const done = ok && t.progress && t.progress.done;
      const gaps = ok && t.gaps ? t.gaps.length : 0;
      const badge = ok ? `${t.cardCount || 0} cards${gaps ? ` · ⚠ ${gaps}` : ''}`
        : t.status === 'writing' ? 'writing…'
        : t.status === 'failed' ? 'failed'
        : running ? 'queued' : 'not written';
      html.push(`
        <div class="bd-row${ok ? '' : ' off'}" data-topic="${esc(t.id)}" ${ok ? 'role="button" tabindex="0"' : ''}>
          <div class="bd-num${done ? ' done' : ''}">${done ? '✓' : i + 1}</div>
          <div class="bd-main">
            <div class="bd-title">${esc(t.title)}</div>
            <div class="bd-sum">${esc(t.status === 'failed' ? (t.error || 'failed') : t.summary || '')}</div>
          </div>
          <div class="bd-badge${t.status === 'failed' ? ' fail' : ''}"${gaps ? ` title="${gaps} line${gaps === 1 ? '' : 's'} of the document not fully taught — shown at the end of the lesson"` : ''}>${esc(badge)}</div>
          ${t.status === 'failed' && !running ? `<button data-retry="${esc(t.id)}">Retry</button>` : ''}
        </div>`);
    });
  }
  const unfinished = topics.some(t => t.status !== 'ready');
  html.push(`<div class="bd-actions">
    ${cards ? `<button data-review>Review this document’s cards</button>` : ''}
    ${!running && (unfinished || (!topics.length && doc.status === 'failed')) ? `<button data-continue>${topics.length ? 'Write the rest' : 'Try again'}</button>` : ''}
    ${!running ? `<button class="quiet" data-remove>Remove breakdown</button>` : ''}
  </div>`);
  panel.innerHTML = html.join('');

  panel.querySelectorAll('.bd-row:not(.off)').forEach((row) => {
    const open = () => window.SOS && window.SOS.lessonUi && window.SOS.lessonUi.open(f.id, row.dataset.topic);
    row.addEventListener('click', (e) => { if (!e.target.closest('button')) open(); });
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  });
  panel.querySelectorAll('[data-retry]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    b.disabled = true;
    bd.regenerate(f.id, b.dataset.retry, f).catch((err) => toast('⚠️', 'Retry failed', err.message || String(err)));
    refresh(f.id);
  }));
  const rv = panel.querySelector('[data-review]');
  if (rv) rv.addEventListener('click', () => {
    window.SOS && window.SOS.review && window.SOS.review.startReview({ classId: doc.classId, notePrefix: bd.notePrefixFor(f.id) });
  });
  const cont = panel.querySelector('[data-continue]');
  if (cont) cont.addEventListener('click', () => start(cls, mod, f));
  const rm = panel.querySelector('[data-remove]');
  if (rm) rm.addEventListener('click', async () => {
    if (!confirm(`Remove the topics and lessons for "${f.name}"?\n\nFlashcards you have already reviewed are kept; the rest are removed.`)) return;
    await bd.remove(f.id);
    _open.delete(f.id);
    refresh(f.id);
  });
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

export default { decorate, findFile };
