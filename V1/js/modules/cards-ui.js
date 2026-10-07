/* ============================================================================
 * StudyOS — decks, browse and the card editor  (overhaul §5.3, §5.7)
 * ============================================================================
 * The class page's "Flashcards" section: a deck tree — Class ▸ Document ▸
 * Topic, built from the cards themselves, plus her own decks — with New · Due
 * · mastery per row and Study / Learn / Cram / Browse.
 *
 * Browse is a searchable list of a deck's cards with filters (status, tag,
 * never reviewed, leeches) and bulk Archive / Delete / Move / Tag. The editor
 * is one Markdown box (sides split on a `---` line, {{1::cloze}}), with a
 * live preview of both sides.
 *
 * Everything here goes through deck.js; nothing touches storage directly.
 * ------------------------------------------------------------------------- */

import * as deck from './deck.js';
import * as cards from './cards.js';
import { renderCard, escapeHtml as esc } from './md.js';
import { store } from './store.js';
import { cardSettings } from './card-settings.js';

const LEECH_SYSTEM = 'You rewrite flashcards a student keeps forgetting, so they become easy to remember.';

function styleOnce() {
  if (document.getElementById('sos-cards-css')) return;
  const el = document.createElement('style');
  el.id = 'sos-cards-css';
  el.textContent = `
#class-cards:empty { display:none; }
.sc-sec { background:var(--bg3); border:1px solid var(--border); border-radius:6px; padding:12px 14px; margin-bottom:22px; }
.sc-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:6px; }
.sc-head h2 { font-size:15px; margin:0; flex:1; min-width:120px; }
.sc-btn { background:var(--bg2); border:1px solid var(--border); color:var(--text2); border-radius:6px; padding:6px 11px;
  font:600 12px var(--sans, inherit); cursor:pointer; min-height:32px; }
.sc-btn.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
.sc-btn:disabled { opacity:.4; cursor:default; }
.sc-row { display:flex; align-items:center; gap:8px; padding:7px 4px; border-top:1px solid var(--border); font-size:13px; }
.sc-row:first-of-type { border-top:none; }
.sc-caret { width:18px; color:var(--text3); cursor:pointer; text-align:center; flex-shrink:0; background:none; border:none; font-size:11px; }
.sc-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:pointer; color:var(--text); }
.sc-name:hover { color:var(--accent2, var(--accent)); }
.sc-meta { font-family:var(--mono); font-size:11px; color:var(--text3); white-space:nowrap; }
.sc-meta b { color:var(--text2); font-weight:600; }
.sc-acts { display:flex; gap:2px; }
.sc-acts button { background:none; border:none; color:var(--text3); font-family:var(--mono); font-size:11px; cursor:pointer; padding:4px 6px; border-radius:4px; }
.sc-acts button:hover { color:var(--text2); background:var(--bg2); }
.sc-kids { margin-left:18px; }
.sc-empty { font-size:12.5px; color:var(--text3); padding:6px 4px; }
.sc-banner { display:flex; align-items:center; gap:10px; flex-wrap:wrap; background:rgba(141,118,154,.14); border:1px solid rgba(141,118,154,.35);
  border-radius:6px; padding:10px 12px; margin-bottom:10px; font-size:13px; }
.sc-banner span { flex:1; min-width:180px; }
@media (max-width:600px) { .sc-acts { display:none; } .sc-row.open .sc-acts, .sc-row:focus-within .sc-acts { display:flex; } }

.sc-ov { --bg:#1B1C1E; --bg2:#1f2022; --bg3:#26272A; --bg4:#2e2f33; --border:rgba(255,255,255,0.09);
  --text:#ECECEE; --text2:#AFB0B5; --text3:#76777C; --accent:#8D769A; --mono:'IBM Plex Mono',monospace; --sans:'Nunito',sans-serif;
  position:fixed; inset:0; z-index:10250; background:var(--bg2); color:var(--text); font-family:var(--sans);
  display:flex; flex-direction:column; padding-top:env(safe-area-inset-top,0px); }
.sc-ov-top { display:flex; gap:8px; align-items:center; padding:10px 14px; border-bottom:1px solid var(--border); flex-wrap:wrap; }
.sc-ov-top h3 { margin:0; font-size:15px; flex:1; min-width:140px; }
.sc-ov input[type=search], .sc-ov select, .sc-ov input[type=text] { background:var(--bg3); border:1px solid var(--border); color:var(--text);
  border-radius:6px; padding:7px 9px; font:13px var(--sans); min-height:34px; }
.sc-filters { display:flex; gap:8px; flex-wrap:wrap; padding:8px 14px; align-items:center; font-size:12px; color:var(--text2); }
.sc-filters label { display:flex; gap:5px; align-items:center; cursor:pointer; }
.sc-bulk { display:flex; gap:6px; flex-wrap:wrap; padding:8px 14px; background:var(--bg3); border-bottom:1px solid var(--border); align-items:center; font-size:12px; }
.sc-list { flex:1; overflow:auto; padding:0 6px 20px; }
.sc-item { display:grid; grid-template-columns:26px 1fr auto; gap:8px; align-items:start; padding:9px 8px; border-bottom:1px solid var(--border); cursor:pointer; }
.sc-item:hover { background:var(--bg3); }
.sc-item .f { font-size:14px; line-height:1.45; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
.sc-item .m { font-family:var(--mono); font-size:10.5px; color:var(--text3); text-align:right; white-space:nowrap; line-height:1.6; }
.sc-item .d { font-family:var(--mono); font-size:10.5px; color:var(--text3); margin-top:2px; }
.sc-tag { display:inline-block; font-family:var(--mono); font-size:10px; background:var(--bg4); border-radius:3px; padding:0 5px; margin-right:4px; }
.sc-st-suggested .f { color:var(--text2); } .sc-st-archived .f { color:var(--text3); text-decoration:line-through; }
.sc-ed { position:fixed; inset:0; z-index:10400; background:rgba(0,0,0,.55); display:flex; align-items:center; justify-content:center; padding:16px; }
.sc-ed > div { background:var(--bg2, #1f2022); color:var(--text, #ECECEE); border:1px solid var(--border, rgba(255,255,255,.09)); border-radius:10px;
  width:100%; max-width:720px; max-height:92vh; display:flex; flex-direction:column; gap:10px; padding:16px; overflow:auto;
  --bg:#1B1C1E; --bg3:#26272A; --bg4:#2e2f33; --text2:#AFB0B5; --text3:#76777C; --accent:#8D769A; --mono:'IBM Plex Mono',monospace; font-family:'Nunito',sans-serif; }
.sc-ed textarea { min-height:170px; background:var(--bg3); border:1px solid var(--border, rgba(255,255,255,.09)); color:inherit; border-radius:8px;
  padding:12px; font:14px/1.55 var(--mono); resize:vertical; }
.sc-ed .pv { background:var(--bg); border:1px solid rgba(255,255,255,.09); border-radius:8px; padding:12px 14px; font-size:15px; line-height:1.5; }
.sc-ed .pv code { font-family:var(--mono); font-size:.88em; } .sc-ed .pv pre { overflow-x:auto; }
.sc-ed .lbl { font-family:var(--mono); font-size:10.5px; color:var(--text3); letter-spacing:.05em; }
.sc-ed .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.sc-ed .row .grow { flex:1; }
.sc-ed input, .sc-ed select { background:var(--bg3); border:1px solid rgba(255,255,255,.09); color:inherit; border-radius:6px; padding:7px 9px; font:13px inherit; min-height:34px; }
.cz-hole { color:var(--accent); font-weight:700; } .cz-ans { background:rgba(141,118,154,.28); border-radius:3px; padding:0 3px; color:inherit; }`;
  document.head.appendChild(el);
}

// ── Names of documents and topics (from the breakdowns) ──────────────────
const _loading = new Set();
function namesFor(fileId) {
  const bd = window.SOS && window.SOS.breakdown;
  const doc = bd && bd.peek(fileId);
  if (!doc) {
    if (bd && !_loading.has(fileId)) {
      _loading.add(fileId);
      bd.load(fileId).then(() => rerenderOpen()).catch(() => {});
    }
    return null;
  }
  const topics = {};
  for (const t of doc.topics || []) topics[t.id] = t.title;
  return { doc: String(doc.sourceName || '').replace(/\.\w+$/, ''), topics, order: (doc.topics || []).map((t) => t.id) };
}

// ── The class page section ────────────────────────────────────────────────
let _cls = null;
const _expanded = new Set();

function rerenderOpen() {
  if (!_cls) return;
  const view = document.getElementById('view-class');
  if (!view || !view.classList.contains('active')) return;
  const cls = store.getClass(_cls);
  if (cls) decorateClass(cls);
}

/** Paint the Flashcards section of a class page. */
export function decorateClass(cls) {
  styleOnce();
  const mount = document.getElementById('class-cards');
  if (!mount || !cls) return;
  _cls = cls.id;
  const tree = deck.deckTree(cls.id, namesFor);
  const total = deck.deckCounts(tree.cards);
  const banner = examBanner(cls, tree);
  if (!tree.cards.length && !deck.userDecks(cls.id).length) {
    mount.innerHTML = `<div class="sc-sec"><div class="sc-head"><h2>Flashcards</h2>
      <button class="sc-btn" data-new>+ Card</button></div>
      <div class="sc-empty">No cards yet. Break down a document below, or add a card yourself.</div></div>`;
    wire(mount, cls, tree);
    return;
  }
  mount.innerHTML = `
    <div class="sc-sec">
      ${banner}
      <div class="sc-head">
        <h2>Flashcards</h2>
        <button class="sc-btn" data-new title="Make a card">+ Card</button>
        <button class="sc-btn" data-newdeck title="Make a deck of your own">+ Deck</button>
        <button class="sc-btn" data-browse="${esc(JSON.stringify({ classId: cls.id }))}">Browse</button>
        <button class="sc-btn primary" data-study="${esc(JSON.stringify({ classId: cls.id }))}" ${total.due + total.new ? '' : 'disabled'}>
          Study${total.due + Math.min(total.new, deck.newRemaining(Date.now(), cls.id)) ? ` · ${total.due + Math.min(total.new, deck.newRemaining(Date.now(), cls.id))}` : ''}</button>
      </div>
      <div class="sc-meta" style="margin:0 0 6px 4px">${countsText(total)}</div>
      ${tree.children.map((n) => rowHtml(n, cls.id, 0)).join('')}
    </div>`;
  wire(mount, cls, tree);
}

function countsText(c) {
  const bits = [`<b>${c.new}</b> new`, `<b>${c.due}</b> due`, `${c.mastery}% mastered`];
  if (c.waiting) bits.push(`${c.waiting} waiting for their lesson`);
  if (c.suggested) bits.push(`${c.suggested} suggested`);
  if (c.archived) bits.push(`${c.archived} archived`);
  return bits.join(' · ');
}

function scopeOf(node, classId) {
  if (node.kind === 'user') return { classId, userDeck: node.userDeck };
  return { classId, deck: node.path };
}

function rowHtml(node, classId, depth) {
  const c = deck.deckCounts(node.cards);
  const key = node.kind + ':' + node.id;
  const open = _expanded.has(key);
  const kids = node.children || [];
  const scope = esc(JSON.stringify(scopeOf(node, classId)));
  const label = node.kind === 'user' ? `▣ ${esc(node.name)}` : esc(node.name);
  return `
    <div class="sc-row" data-key="${esc(key)}">
      ${kids.length ? `<button class="sc-caret" data-toggle="${esc(key)}" aria-label="Expand">${open ? '▾' : '▸'}</button>` : '<span class="sc-caret"></span>'}
      <span class="sc-name" data-study="${scope}" title="Study this deck">${label}</span>
      <span class="sc-meta"><b>${c.new}</b> new · <b>${c.due}</b> due · ${c.mastery}%${
        c.waiting ? ` · <span title="New cards wait until you open their lesson">${c.waiting} waiting</span>` : ''}${c.suggested ? ` · ${c.suggested} sugg.` : ''}</span>
      <span class="sc-acts">
        ${c.new ? `<button data-learn="${scope}" title="Learn new cards">learn</button>` : ''}
        <button data-cram="${scope}" title="Review everything, schedule ignored">cram</button>
        <button data-browse="${scope}">browse</button>
        ${node.kind === 'user' ? `<button data-rename="${esc(node.id)}">rename</button><button data-deldeck="${esc(node.id)}">delete</button>` : ''}
      </span>
    </div>
    ${kids.length && open ? `<div class="sc-kids">${kids.map((k) => rowHtml(k, classId, depth + 1)).join('')}</div>` : ''}`;
}

function wire(mount, cls, tree) {
  const parse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };
  const R = () => window.SOS && window.SOS.review;
  mount.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.toggle;
    if (_expanded.has(k)) _expanded.delete(k); else _expanded.add(k);
    decorateClass(cls);
  }));
  mount.querySelectorAll('[data-study]').forEach((b) => b.addEventListener('click', () => R() && R().startReview(parse(b.dataset.study))));
  mount.querySelectorAll('[data-learn]').forEach((b) => b.addEventListener('click', () => R() && R().startReview(parse(b.dataset.learn), { mode: 'learn' })));
  mount.querySelectorAll('[data-cram]').forEach((b) => b.addEventListener('click', () => R() && R().startReview(parse(b.dataset.cram), { mode: 'cram' })));
  mount.querySelectorAll('[data-browse]').forEach((b) => b.addEventListener('click', () => openBrowse(parse(b.dataset.browse))));
  mount.querySelectorAll('[data-new]').forEach((b) => b.addEventListener('click', () => openEditor({ classId: cls.id, onSave: () => decorateClass(cls) })));
  const nd = mount.querySelector('[data-newdeck]');
  if (nd) nd.addEventListener('click', () => {
    const name = prompt('Name of the new deck:');
    if (name && deck.createDeck(cls.id, name)) decorateClass(cls);
  });
  mount.querySelectorAll('[data-rename]').forEach((b) => b.addEventListener('click', () => {
    const d = deck.userDecks(cls.id).find((x) => x.id === b.dataset.rename);
    const name = d && prompt('Rename the deck:', d.name);
    if (name && deck.renameDeck(cls.id, d.id, name)) decorateClass(cls);
  }));
  mount.querySelectorAll('[data-deldeck]').forEach((b) => b.addEventListener('click', () => {
    if (!confirm('Delete this deck? Its cards are kept — they just leave the deck.')) return;
    deck.deleteDeck(cls.id, b.dataset.deldeck);
    decorateClass(cls);
  }));
  mount.querySelectorAll('[data-exam]').forEach((b) => b.addEventListener('click', () => examAction(cls, b.dataset.exam)));
}

// ── Exam mode (overhaul §7.6) ─────────────────────────────────────────────
const DAY = 86400000;
const EXAM_WINDOW_DAYS = 30;

/** The next exam or quiz of a class: { name, type, at, days }, or null. */
export function nextExam(classId, now = Date.now()) {
  const today = new Date(now).toISOString().slice(0, 10);
  let best = null;
  for (const e of store.getEvents() || []) {
    if (!e || e.classId !== classId || (e.type !== 'exam' && e.type !== 'quiz') || !e.date || e.date < today) continue;
    const at = new Date(e.date + 'T09:00:00').getTime();
    if (!best || at < best.at) best = { name: e.name || e.title || (e.type === 'quiz' ? 'Quiz' : 'Exam'), type: e.type, at };
  }
  if (!best) return null;
  best.days = Math.max(0, Math.ceil((best.at - now) / DAY));
  return best;
}

/** Check questions she got wrong in a lesson, due for a retry (the day after). */
export function retriesOf(cls, now = Date.now()) {
  const bd = window.SOS && window.SOS.breakdown;
  if (!bd) return [];
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const out = [];
  for (const mod of cls.modules || []) {
    for (const f of mod.files || []) {
      const doc = f && f.study && bd.peek(f.id);
      if (!doc) continue;
      for (const t of doc.topics || []) {
        const p = t.progress || {};
        if ((p.wrong || []).length && (p.wrongAt || 0) < today.getTime()) out.push({ fileId: f.id, topicId: t.id, title: t.title, n: p.wrong.length });
      }
    }
  }
  return out;
}

function examBanner(cls) {
  const ex = nextExam(cls.id);
  const retries = retriesOf(cls);
  const bits = [];
  if (ex && ex.days <= EXAM_WINDOW_DAYS) {
    const m = deck.mastery(cls.id);
    const plan = deck.planOf(cls.id);
    const when = ex.days === 0 ? 'today' : ex.days === 1 ? 'tomorrow' : `in ${ex.days} days`;
    bits.push(`<div class="sc-banner" data-exam-banner>
      <span><b>${esc(ex.name)}</b> ${when}: ${m.total} card${m.total === 1 ? '' : 's'}, ${m.pct}% mastered${
        plan ? ` · plan: ${plan.perDay} new a day until ${new Date(plan.until).toLocaleDateString([], { month: 'short', day: 'numeric' })}` : ''}</span>
      <button class="sc-btn" data-exam="cram" title="Review your 30 weakest cards, schedule ignored">Cram weakest 30</button>
      <button class="sc-btn" data-exam="${plan ? 'unplan' : 'plan'}" title="Spread the remaining new cards over the days left">${plan ? 'Stop the plan' : 'Plan'}</button>
    </div>`);
  }
  if (retries.length) {
    const n = retries.reduce((k, r) => k + r.n, 0);
    bits.push(`<div class="sc-banner"><span>${n} check question${n === 1 ? '' : 's'} you missed — try ${n === 1 ? 'it' : 'them'} again.</span>
      <button class="sc-btn" data-exam="retry">Retry</button></div>`);
  }
  return bits.join('');
}

function examAction(cls, act) {
  const R = window.SOS && window.SOS.review;
  if (act === 'cram') { if (R) R.startReview({ classId: cls.id }, { mode: 'cram', limit: 30 }); return; }
  if (act === 'retry') {
    const r = retriesOf(cls)[0];
    const L = window.SOS && window.SOS.lessonUi;
    if (r && L) L.open(r.fileId, r.topicId);
    return;
  }
  if (act === 'unplan') { deck.setPlan(cls.id, null); decorateClass(cls); return; }
  if (act === 'plan') {
    const ex = nextExam(cls.id);
    if (!ex) return;
    const c = deck.countsFor(cls.id);
    const unseen = c.unseen;
    // Two days of margin before the exam, like the scheduler's compression.
    const days = Math.max(1, ex.days - 2);
    const perDay = Math.ceil(unseen / days);
    const global = cardSettings().newPerDay;
    if (!unseen) { toast('Nothing to plan', 'Every card of this class is already in your reviews.'); return; }
    if (perDay <= global) {
      toast('Already on track', `Your ${global} new cards a day cover the ${unseen} left before ${ex.name}.`);
      return;
    }
    deck.setPlan(cls.id, { perDay, until: ex.at - 2 * DAY, examAt: ex.at });
    toast('Plan set', `${perDay} new cards a day for ${cls.name} until ${new Date(ex.at - 2 * DAY).toLocaleDateString([], { month: 'short', day: 'numeric' })}.`);
    decorateClass(cls);
  }
}

function toast(title, body) {
  try { if (window.showNotif) window.showNotif('🗓️', title, body); } catch (e) {}
}

// ── Suggested cards: triage, one at a time (overhaul §7.3) ────────────────
/** Add (A) / Skip (S) / Edit (E) each suggestion of a scope. */
export function openTriage(scope = {}) {
  styleOnce();
  const ids = scopeIds(scope);
  const list = (scope.classId ? deck.forClass(scope.classId) : deck.all())
    .filter((c) => (ids === null || ids.has(c.id)) && deck.statusOf(c) === 'suggested');
  if (!list.length) { toast('No suggestions', 'This topic has no suggested cards left.'); return null; }
  let i = 0, added = 0;
  const el = document.createElement('div');
  el.className = 'sc-ov';
  document.body.appendChild(el);
  const close = () => { document.removeEventListener('keydown', onKey, true); el.remove(); rerenderOpen(); if (scope.onClose) scope.onClose(added); };
  const paint = () => {
    if (i >= list.length) {
      el.innerHTML = `<div style="margin:auto;text-align:center;padding:30px">
        <div style="font-size:22px;font-family:Lora,serif;color:var(--accent);margin-bottom:10px">All sorted</div>
        <div style="color:var(--text2);font-size:14px;margin-bottom:18px">${added} added to your reviews.</div>
        <button class="sc-btn primary" data-close>Close</button></div>`;
      el.querySelector('[data-close]').onclick = close;
      return;
    }
    const c = deck.get(list[i].id) || list[i];
    const front = cards.isClozeCard(c) ? cards.clozeText(c.q, 0, false, { marks: true }) : c.q;
    const back = cards.isClozeCard(c) ? cards.clozeText(c.q, 0, true, { marks: true }) : c.a;
    el.innerHTML = `
      <div class="sc-ov-top"><h3>Suggested cards · ${i + 1} of ${list.length}</h3>
        <button class="sc-btn" data-close title="Close (Esc)">✕</button></div>
      <div style="flex:1;overflow:auto;display:flex;justify-content:center;padding:28px 20px">
        <div style="width:100%;max-width:640px">
          <div style="font-size:20px;line-height:1.5">${renderCard(front)}</div>
          <div style="font-size:16px;line-height:1.6;border-top:1px solid var(--border);margin-top:18px;padding-top:18px;color:var(--text2)">${renderCard(back || '')}</div>
          ${c.extra ? `<div style="font-size:14px;color:var(--text3);margin-top:12px">${renderCard(c.extra)}</div>` : ''}
        </div></div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;padding:12px 14px calc(12px + env(safe-area-inset-bottom,0px));max-width:680px;width:100%;margin:0 auto">
        <button class="sc-btn" data-skip style="min-height:52px">Skip <small style="color:var(--text3)">S</small></button>
        <button class="sc-btn" data-edit style="min-height:52px">Edit <small style="color:var(--text3)">E</small></button>
        <button class="sc-btn primary" data-add style="min-height:52px">Add <small>A</small></button>
      </div>`;
    el.querySelector('[data-close]').onclick = close;
    el.querySelector('[data-skip]').onclick = () => { i++; paint(); };
    el.querySelector('[data-add]').onclick = () => { deck.setStatus(c.id, 'active'); added++; i++; paint(); };
    el.querySelector('[data-edit]').onclick = () => openEditor({ card: c, onSave: () => paint() });
  };
  const onKey = (e) => {
    if (document.querySelector('.sc-ed')) return;
    const k = e.key.toLowerCase();
    if (k === 'escape') { e.preventDefault(); return close(); }
    if (i >= list.length) return;
    if (k === 'a') { e.preventDefault(); el.querySelector('[data-add]').click(); }
    if (k === 's') { e.preventDefault(); el.querySelector('[data-skip]').click(); }
    if (k === 'e') { e.preventDefault(); el.querySelector('[data-edit]').click(); }
  };
  document.addEventListener('keydown', onKey, true);
  paint();
  return { close, el };
}

// ── Browse ────────────────────────────────────────────────────────────────
let _browse = null;

/** A deck's cards: search, filter, select, act. */
export function openBrowse(scope = {}) {
  styleOnce();
  if (_browse) _browse.close();
  const classId = scope.classId || null;
  const state = { q: '', status: 'all', tag: '', never: false, leech: !!scope.leech, sel: new Set(), shown: 200 };
  const el = document.createElement('div');
  el.className = 'sc-ov';
  document.body.appendChild(el);
  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    el.remove(); _browse = null;
    rerenderOpen();
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && !document.querySelector('.sc-ed')) { e.preventDefault(); close(); }
  };
  document.addEventListener('keydown', onKey, true);

  const pool = () => {
    const ids = scopeIds(scope);
    let list = (classId ? deck.forClass(classId) : deck.all()).filter((c) => ids === null || ids.has(c.id));
    if (state.status !== 'all') list = list.filter((c) => deck.statusOf(c) === state.status);
    if (state.tag) list = list.filter((c) => (c.tags || []).includes(state.tag));
    if (state.never) list = list.filter(deck.isUnseen);
    if (state.leech) list = list.filter((c) => (c.sched && c.sched.lapses >= 4) || (c.tags || []).includes('leech'));
    if (state.q) {
      const q = state.q.toLowerCase();
      list = list.filter((c) => `${c.q} ${c.a} ${c.extra || ''} ${(c.tags || []).join(' ')}`.toLowerCase().includes(q));
    }
    return list;
  };

  const paint = () => {
    const list = pool();
    const tags = classId ? deck.tagsOf(classId) : [];
    const decks = classId ? deck.userDecks(classId) : [];
    const sel = [...state.sel].filter((id) => list.some((c) => c.id === id));
    state.sel = new Set(sel);
    el.innerHTML = `
      <div class="sc-ov-top">
        <h3>${esc(scopeName(scope))} · ${list.length} card${list.length === 1 ? '' : 's'}</h3>
        <input type="search" data-q placeholder="Search cards" value="${esc(state.q)}" style="min-width:180px;flex:1;max-width:340px">
        ${classId ? '<button class="sc-btn" data-new>+ Card</button>' : ''}
        <button class="sc-btn" data-close title="Close (Esc)">✕</button>
      </div>
      <div class="sc-filters">
        <select data-status>
          ${['all', 'active', 'suggested', 'archived'].map((s) => `<option value="${s}"${state.status === s ? ' selected' : ''}>${s === 'all' ? 'Any status' : s === 'active' ? 'In reviews' : s[0].toUpperCase() + s.slice(1)}</option>`).join('')}
        </select>
        ${tags.length ? `<select data-tag><option value="">Any tag</option>${tags.map((t) => `<option${state.tag === t ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>` : ''}
        <label><input type="checkbox" data-never ${state.never ? 'checked' : ''}> never reviewed</label>
        <label><input type="checkbox" data-leech ${state.leech ? 'checked' : ''}> leeches (4+ lapses)</label>
        <label style="margin-left:auto"><input type="checkbox" data-all ${sel.length && sel.length === Math.min(list.length, state.shown) ? 'checked' : ''}> select all</label>
      </div>
      ${sel.length ? `<div class="sc-bulk"><b>${sel.length} selected</b>
        <button class="sc-btn" data-bulk="active">Add to reviews</button>
        <button class="sc-btn" data-bulk="archived">Archive</button>
        <button class="sc-btn" data-bulk="delete">Delete</button>
        ${classId ? `<select data-move><option value="">Move to deck…</option><option value=":none">(no deck)</option>${decks.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')}</select>` : ''}
        <input type="text" data-tagto placeholder="add tag" style="width:110px">
        <button class="sc-btn" data-tagbtn>Tag</button>
      </div>` : ''}
      <div class="sc-list">
        ${list.slice(0, state.shown).map((c) => itemHtml(c, state.sel.has(c.id))).join('') || '<div class="sc-empty" style="padding:20px">No cards match.</div>'}
        ${list.length > state.shown ? `<div style="text-align:center;padding:14px"><button class="sc-btn" data-more>Show ${Math.min(200, list.length - state.shown)} more</button></div>` : ''}
      </div>`;
    const q = el.querySelector('[data-q]');
    q.addEventListener('input', () => { state.q = q.value; const pos = q.selectionStart; paint(); const nq = el.querySelector('[data-q]'); nq.focus(); nq.setSelectionRange(pos, pos); });
    el.querySelector('[data-close]').onclick = close;
    const nb = el.querySelector('[data-new]');
    if (nb) nb.onclick = () => openEditor({ classId, deckId: scope.userDeck || null, onSave: paint });
    el.querySelector('[data-status]').onchange = (e) => { state.status = e.target.value; paint(); };
    const tg = el.querySelector('[data-tag]');
    if (tg) tg.onchange = (e) => { state.tag = e.target.value; paint(); };
    el.querySelector('[data-never]').onchange = (e) => { state.never = e.target.checked; paint(); };
    el.querySelector('[data-leech]').onchange = (e) => { state.leech = e.target.checked; paint(); };
    el.querySelector('[data-all]').onchange = (e) => {
      state.sel = e.target.checked ? new Set(list.slice(0, state.shown).map((c) => c.id)) : new Set();
      paint();
    };
    const more = el.querySelector('[data-more]');
    if (more) more.onclick = () => { state.shown += 200; paint(); };
    el.querySelectorAll('.sc-item').forEach((row) => {
      const id = row.dataset.id;
      row.querySelector('input').addEventListener('click', (e) => {
        e.stopPropagation();
        if (e.target.checked) state.sel.add(id); else state.sel.delete(id);
        paint();
      });
      row.addEventListener('click', () => {
        const c = deck.get(id);
        if (c) openEditor({ card: c, onSave: paint });
      });
    });
    el.querySelectorAll('[data-bulk]').forEach((b) => b.addEventListener('click', () => {
      const ids = [...state.sel];
      if (b.dataset.bulk === 'delete') {
        if (!confirm(`Delete ${ids.length} card${ids.length === 1 ? '' : 's'}? Reviewed cards lose their schedule.`)) return;
        const byClass = new Map();
        ids.forEach((id) => { const c = deck.get(id); if (c) (byClass.get(c.classId) || byClass.set(c.classId, []).get(c.classId)).push(id); });
        byClass.forEach((v, k) => deck.remove(k, v));
      } else deck.setStatus(ids, b.dataset.bulk);
      state.sel.clear();
      paint();
    }));
    const mv = el.querySelector('[data-move]');
    if (mv) mv.onchange = () => {
      if (!mv.value) return;
      deck.moveCards([...state.sel], mv.value === ':none' ? null : mv.value);
      state.sel.clear(); paint();
    };
    const tb = el.querySelector('[data-tagbtn]');
    if (tb) tb.onclick = () => {
      const v = el.querySelector('[data-tagto]').value.trim();
      if (!v) return;
      deck.tagCards([...state.sel], v);
      paint();
    };
  };
  paint();
  _browse = { close, el, paint };
  return _browse;
}

function itemHtml(c, selected) {
  const st = deck.statusOf(c);
  const s = c.sched;
  const due = s && s.state !== 'new' ? (s.due <= Date.now() ? 'due now' : `due ${new Date(s.due).toLocaleDateString([], { month: 'short', day: 'numeric' })}`) : 'new';
  const r = s && s.lastReview ? Math.round(deck.retrievabilityOf(c) * 100) + '%' : '—';
  const front = cards.isClozeCard(c) ? cards.clozeText(c.q, 0) : c.q;
  return `
    <div class="sc-item sc-st-${st}" data-id="${esc(c.id)}">
      <input type="checkbox" aria-label="Select" ${selected ? 'checked' : ''}>
      <div>
        <div class="f">${esc(front)}</div>
        <div class="d">${esc(c.topic || c.sourceTitle || '')}${(c.tags || []).map((t) => ` <span class="sc-tag">#${esc(t)}</span>`).join('')}</div>
      </div>
      <div class="m">${st === 'active' ? due : st}<br>${s && s.lapses ? `${s.lapses} lapse${s.lapses === 1 ? '' : 's'} · ` : ''}${r}</div>
    </div>`;
}

/** The ids a scope covers, every status (null: everything of the class). */
function scopeIds(scope) {
  if (!scope.deck && !scope.userDeck && !scope.ids && !scope.noteId && !scope.notePrefix) return null;
  return new Set(scopedAll(scope));
}

function scopedAll(scope) {
  const all = scope.classId ? deck.forClass(scope.classId) : deck.all();
  return all.filter((c) => {
    if (scope.ids && !scope.ids.includes(c.id)) return false;
    if (scope.noteId && c.sourceNoteId !== scope.noteId) return false;
    if (scope.notePrefix && !String(c.sourceNoteId || '').startsWith(scope.notePrefix)) return false;
    if (scope.deck) {
      const p = cards.deckPathOf(c);
      if (scope.deck[1] === ':notes') { if (p.length === 3) return false; }
      else if (!scope.deck.every((x, i) => p[i] === x)) return false;
    }
    if (scope.userDeck && !(c.deckId && deck.deckFamily(scope.classId, scope.userDeck).has(c.deckId))) return false;
    return true;
  }).map((c) => c.id);
}

function scopeName(scope) {
  const cls = scope.classId && store.getClass(scope.classId);
  if (scope.userDeck) {
    const d = deck.userDecks(scope.classId).find((x) => x.id === scope.userDeck);
    return d ? d.name : 'Deck';
  }
  if (scope.deck && scope.deck.length >= 2) {
    if (scope.deck[1] === ':notes') return 'From your notes';
    const n = namesFor(scope.deck[1]);
    if (scope.deck[2]) return (n && n.topics[scope.deck[2]]) || 'Topic';
    return (n && n.doc) || 'Document';
  }
  if (scope.title) return scope.title;
  return cls ? cls.name : 'All cards';
}

// ── The card editor ───────────────────────────────────────────────────────
/**
 * Edit a card, or make one.
 * @param o { card } to edit, or { classId, noteId?, title?, prefill?, deckId? } to make one
 *          onSave(card) after a save
 */
export function openEditor(o = {}) {
  styleOnce();
  const editing = !!o.card;
  const card = o.card || null;
  const classId = editing ? card.classId : o.classId;
  if (!classId) return null;
  const decks = deck.userDecks(classId);
  const content = editing ? cards.contentOf(card) : (o.prefill || '');
  const el = document.createElement('div');
  el.className = 'sc-ed';
  el.innerHTML = `<div role="dialog" aria-label="${editing ? 'Edit card' : 'New card'}">
    <div class="row"><b class="grow">${editing ? 'Edit card' : 'New card'}</b>
      <span class="lbl">Ctrl+Enter save · Esc close</span></div>
    <div class="lbl">MARKDOWN · a line with --- separates front and back (a third side is a "why") · select text + Ctrl+Shift+C makes a cloze</div>
    <textarea data-ed spellcheck="true" placeholder="What does 3NF forbid?&#10;---&#10;Transitive dependencies on the key.">${esc(content)}</textarea>
    <div class="row">
      <input data-tags class="grow" placeholder="tags, comma separated" value="${esc(editing ? (card.tags || []).join(', ') : '')}">
      ${decks.length ? `<select data-deck><option value="">No deck</option>${decks.map((d) => `<option value="${esc(d.id)}"${(editing ? card.deckId : o.deckId) === d.id ? ' selected' : ''}>${esc(d.name)}</option>`).join('')}</select>` : ''}
      ${editing && cards.isClozeCard(card) ? '' : `<label style="font-size:12px;display:flex;gap:6px;align-items:center"><input type="checkbox" data-rev ${editing && card.kind === 'reverse-pair' ? 'checked' : ''}> also back→front</label>`}
    </div>
    <div class="lbl">PREVIEW</div>
    <div class="pv" data-pv></div>
    <div class="row">
      ${editing ? `<button class="sc-btn" data-status>${deck.statusOf(card) === 'active' ? 'Archive' : 'Add to reviews'}</button><button class="sc-btn" data-del>Delete</button>` : ''}
      <span class="grow"></span>
      <button class="sc-btn" data-cancel>Cancel</button>
      <button class="sc-btn primary" data-save>Save</button>
    </div></div>`;
  document.body.appendChild(el);
  const ta = el.querySelector('[data-ed]'), pv = el.querySelector('[data-pv]');
  const close = () => { document.removeEventListener('keydown', onKey, true); el.remove(); };
  const preview = () => {
    const tmp = cards.withContent(card || { q: '', a: '' }, { content: ta.value });
    if (cards.isClozeCard(tmp)) {
      const n = cards.clozeNumbers(tmp.q)[0] || 1;
      pv.innerHTML = `<div class="lbl">FRONT</div>${renderCard(cards.clozeText(tmp.q, n, false, { marks: true }))}
        <div class="lbl" style="margin-top:10px">BACK</div>${renderCard(cards.clozeText(tmp.q, n, true, { marks: true }))}${
        cards.clozeNumbers(tmp.q).length > 1 ? `<div class="lbl" style="margin-top:6px">${cards.clozeNumbers(tmp.q).length} blanks — each is reviewed on its own</div>` : ''}`;
    } else {
      pv.innerHTML = `<div class="lbl">FRONT</div>${renderCard(tmp.q || '')}<div class="lbl" style="margin-top:10px">BACK</div>${renderCard(tmp.a || '')}${
        tmp.extra ? `<div class="lbl" style="margin-top:10px">WHY</div>${renderCard(tmp.extra)}` : ''}`;
    }
  };
  const save = () => {
    const text = ta.value.trim();
    if (!text) return;
    const tags = el.querySelector('[data-tags]').value.split(',').map((t) => t.trim()).filter(Boolean);
    const dk = el.querySelector('[data-deck]');
    const rev = el.querySelector('[data-rev]');
    let saved;
    if (editing) {
      saved = deck.edit(card.id, { content: text, tags, deckId: dk ? (dk.value || null) : undefined,
        kind: rev && rev.checked ? 'reverse-pair' : (card.kind === 'reverse-pair' ? 'qa' : undefined) });
    } else {
      const [q = '', a = '', ...rest] = cards.sidesOf(text);
      const added = deck.addCards(classId, [{ front: q, back: a, extra: rest.join('\n\n'), kind: cards.hasCloze(q) ? 'cloze' : 'basic',
        priority: 1, tags, deckId: dk ? dk.value : null }],
        { noteId: o.noteId || 'manual', title: o.title || '', readAt: Date.now(), kind: 'manual' });
      saved = added[0] || null;
      if (saved && rev && rev.checked) saved = deck.edit(saved.id, { kind: 'reverse-pair' });
      if (!saved) { pv.insertAdjacentHTML('afterbegin', '<div style="color:#e39a9a;margin-bottom:8px">This card is incomplete (a front and a back, or a {{cloze}}), or it already exists.</div>'); return; }
    }
    close();
    if (o.onSave) o.onSave(saved);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); save(); }
    if (e.target === ta && e.key.toLowerCase() === 'c' && e.ctrlKey && e.shiftKey) {
      e.preventDefault(); e.stopPropagation();
      const R = window.SOS && window.SOS.review;
      if (R) { R.wrapCloze(ta); preview(); }
    }
  };
  document.addEventListener('keydown', onKey, true);
  ta.addEventListener('input', preview);
  el.querySelector('[data-save]').onclick = save;
  el.querySelector('[data-cancel]').onclick = close;
  el.addEventListener('click', (e) => { if (e.target === el) close(); });
  const st = el.querySelector('[data-status]');
  if (st) st.onclick = () => { deck.setStatus(card.id, deck.statusOf(card) === 'active' ? 'archived' : 'active'); close(); if (o.onSave) o.onSave(deck.get(card.id)); };
  const del = el.querySelector('[data-del]');
  if (del) del.onclick = () => { if (!confirm('Delete this card?')) return; deck.remove(card.classId, card.id); close(); if (o.onSave) o.onSave(null); };
  preview();
  ta.focus();
  return { close, el };
}

// ── Leeches: "this card keeps slipping — rewrite it?" ─────────────────────
/**
 * One AI ask: rewrite a card she keeps forgetting — split it, or make it a
 * cloze — under the same quality filter as a breakdown's cards. The first
 * rewrite REPLACES the card (its id and schedule stay); any others are added.
 * @returns {Promise<{replaced: object, added: object[]}>}
 */
export async function rewriteLeech(card) {
  const ai = window.SOS && window.SOS.ai;
  const bd = window.SOS && window.SOS.breakdown;
  if (!ai || !bd) throw new Error('The AI is not loaded yet.');
  const prompt = `A student keeps forgetting this flashcard (${(card.sched && card.sched.lapses) || 0} lapses). Rewrite it so it is easy to remember.

<card>
${cards.contentOf(card)}
</card>

- Usually the card asks too much at once: split it into 2-3 cards that each test ONE idea, or turn it into a cloze card with numbered blanks.
- Keep the same facts. Add nothing the card does not say, except a one-line "why" in "extra" if it helps.
- front: a specific question or cloze sentence (at most 200 characters); back: at most two sentences ("" for a cloze).
- Use Markdown code formatting for code, SQL and formulas.

Reply with ONE JSON object and nothing else:
{"flashcards": [{"kind": "basic", "front": "...", "back": "...", "extra": "", "priority": 1}]}`;
  const schema = { type: 'object', additionalProperties: false, required: ['flashcards'],
    properties: { flashcards: bd.LESSON_SCHEMA.properties.flashcards } };
  const validate = (o) => {
    const v = bd.validateLesson({ blocks: [{ kind: 'read', title: 'x', markdown: 'x' }], flashcards: o && o.flashcards });
    return v.error ? { error: v.error } : { value: { flashcards: v.value.flashcards } };
  };
  const { data } = await ai.generateJSON({ system: LEECH_SYSTEM, prompt, schema, validate, maxTokens: 4000,
    key: `leech:${card.id}:${(card.sched && card.sched.lapses) || 0}`, pdf: null, docText: '' });
  const others = deck.forClass(card.classId).filter((c) => c.id !== card.id);
  const picked = bd.filterCards(data.flashcards, { budget: { max: 3 }, existing: others });
  const list = picked.active.length ? picked.active : data.flashcards.slice(0, 1);
  if (!list.length) throw new Error('The rewrite came back empty.');
  const [first, ...rest] = list;
  const content = first.kind === 'cloze' ? [first.front, ...(first.extra ? ['', first.extra] : [])].join('\n---\n')
    : [first.front, first.back, ...(first.extra ? [first.extra] : [])].join('\n---\n');
  const replaced = deck.edit(card.id, { content, tags: (card.tags || []).filter((t) => t !== 'leech') });
  const added = rest.length ? deck.addCards(card.classId, rest.map((c) => ({ ...c, status: 'active' })),
    { noteId: card.sourceNoteId, title: card.topic || card.sourceTitle || '', readAt: Date.now(), kind: 'rewrite' }) : [];
  return { replaced, added };
}

window.addEventListener('sos-changed', (e) => {
  if (e && e.detail && e.detail.entity === 'cards' && !_browse) {
    clearTimeout(rerenderOpen._t);
    rerenderOpen._t = setTimeout(rerenderOpen, 300);
  }
});

export default { decorateClass, openBrowse, openEditor, openTriage, rewriteLeech, nextExam, retriesOf };
