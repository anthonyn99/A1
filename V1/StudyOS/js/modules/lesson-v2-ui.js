/* ============================================================================
 * StudyOS — v2 lesson steps  (rendering + interaction for one step)
 * ============================================================================
 * lesson-ui.js owns the shell (title, progress, Back/Next, topic nav, saving)
 * and calls stepHtml() for the step on screen, then wireStep(). Everything
 * here is per step:
 *   hook / concept / diagram / code / walkthrough / compare / check / trap /
 *   practice / recap / figure  — see the table in the lesson upgrade spec §4.
 * Model text reaches the page only through renderMarkdown / esc / the
 * diagram renderer, all of which escape.
 *
 * A check never blocks Next. Answering (or Reveal) records the result through
 * actions.record(), which also makes a card from a wrong answer.
 * ------------------------------------------------------------------------- */

import { renderMarkdown, escapeHtml, inline, closeEnough } from './md.js';
import { renderDiagram, atFrame } from './diagram.js';
import { highlightLines } from './highlight.js';
import { idsOf, STEP_LABEL } from './lesson-v2.js';
import { styleCss } from './study-style.js';

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const md = (t) => renderMarkdown(String(t || ''));
const short = (t) => inline(escapeHtml(String(t || '')));

export const ICON = { key: '💡', trap: '⚠️', analogy: '🧠', exam: '🎯', tip: '✦' };
export const labelOf = (step) => STEP_LABEL[step && step.type] || '';

// ── Small parts ──────────────────────────────────────────────────────────
function calloutsHtml(list) {
  return (list || []).map((c) => `<div class="v2-callout v2-${esc(c.kind)}"><span class="v2-ci" aria-hidden="true">${ICON[c.kind] || ''}</span><div>${short(c.text)}</div></div>`).join('');
}

/** A code block. Line numbers and gutter dots only when it is annotated. */
export function codeHtml(code, { selected = 0, interactive = true } = {}) {
  if (!code) return '';
  const lines = highlightLines(code.source, code.language);
  const ann = new Map((code.annotations || []).map((a) => [a.line, a]));
  const numbered = ann.size > 0;
  const rows = lines.map((h, k) => {
    const n = k + 1, a = ann.get(n);
    return `<div class="v2-line${a ? ' ann' : ''}${selected === n ? ' sel' : ''}"${a && interactive ? ` data-v2line="${n}" tabindex="0" role="button" aria-label="Line ${n}: what it does"` : ''}>` +
      (numbered ? `<span class="v2-ln">${n}</span><span class="v2-dot">${a ? '●' : ''}</span>` : '') + `<code>${h || ' '}</code></div>`;
  }).join('');
  const lang = code.language && code.language !== 'pseudo' ? `<div class="v2-lang">${esc(code.language)}</div>` : '';
  return `<div class="v2-code${numbered ? ' numbered' : ''}">${lang}<div class="v2-lines">${rows}</div></div>`;
}

/** The diagram a code step's annotations light up: its own, else the lesson
 *  diagram holding most of the ids they name. */
export function linkedDiagram(lesson, step) {
  if (step.diagram) return step.diagram;
  const want = new Set((step.code && step.code.annotations || []).flatMap((a) => a.highlight || []));
  if (!want.size) return null;
  const pool = [lesson.runningExample, ...(lesson.steps || []).flatMap((s) => [s.diagram, s.check && s.check.diagram])].filter(Boolean);
  let best = null, score = 0;
  for (const d of pool) {
    const ids = idsOf(d);
    let k = 0;
    want.forEach((x) => { if (ids.has(x)) k++; });
    if (k > score) { score = k; best = d; }
  }
  return best;
}

// ── Checks ───────────────────────────────────────────────────────────────
const BLANK = /_{3,}|\{\{blank\}\}/;
const squash = (x) => String(x || '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Is `value` right? Short answers are matched forgivingly (case, spacing,
 *  a typo); an order must match exactly. */
export function grade(check, value) {
  if (!check) return false;
  if (check.format === 'mcq') return value === check.answer;
  if (check.format === 'order') return Array.isArray(value) && value.length === check.answer.length && value.every((x, i) => x === check.answer[i]);
  const want = Array.isArray(check.answer) ? check.answer : [check.answer];
  const v = String(value || '').trim();
  if (!v) return false;
  // A typo is forgiven only in a word answer: "55" is not "57", and
  // "root.left" is not "root.right".
  const fuzzy = (a) => !/\d/.test(a) && !/[.()[\]=<>]/.test(a) && squash(a).length >= 5;
  return want.some((a) => squash(a) === squash(v) || (fuzzy(String(a)) && closeEnough(v, a)) || (/^-?\d+(\.\d+)?$/.test(v) && Number(v) === Number(a)));
}

/** The order puzzle's starting order: the items, never already solved. */
export function startOrder(check) {
  const items = [...(check.options || check.answer)];
  if (items.length < 2) return items;
  const same = () => items.every((x, i) => x === check.answer[i]);
  if (same()) { items.push(items.shift()); if (same()) items.reverse(); }
  return items;
}

const answerText = (c) => (Array.isArray(c.answer) ? (c.format === 'order' ? c.answer.join(' → ') : c.answer[0]) : c.answer);

function checkHtml(check, i, V, ctx) {
  const res = V.done[i];
  const val = V.ans[i];
  const parts = [];
  let promptHtml;
  if (check.format === 'fill-blank' && BLANK.test(check.prompt)) {
    const [a, ...b] = check.prompt.split(BLANK);
    promptHtml = `<div class="v2-prompt">${short(a)}<input class="v2-blank" data-v2in="${i}" value="${esc(val || '')}" ${res ? 'disabled' : ''} aria-label="the blank" autocomplete="off" spellcheck="false">${short(b.join('___'))}</div>`;
  } else promptHtml = `<div class="v2-prompt">${check.format === 'predict-output' ? md(check.prompt) : short(check.prompt)}</div>`;
  parts.push(promptHtml);
  if (check.diagram) parts.push(renderDiagram(check.diagram));
  if (check.format === 'mcq') {
    parts.push('<div class="v2-opts">' + check.options.map((o, k) => {
      let cls = '';
      if (res) cls = o === check.answer ? 'right' : (val === o ? 'wrong' : '');
      return `<button class="sl-choice ${cls}" data-v2opt="${k}" ${res ? 'disabled' : ''}>${k < 9 ? `<span class="v2-key">${k + 1}</span>` : ''}${short(o)}</button>`;
    }).join('') + '</div>');
  } else if (check.format === 'order') {
    const list = Array.isArray(val) ? val : startOrder(check);
    parts.push('<ol class="v2-order">' + list.map((o, k) => `<li class="${res ? (o === check.answer[k] ? 'right' : 'wrong') : ''}"><span>${short(o)}</span>${res ? '' :
      `<span class="v2-mv"><button data-v2mv="${k}:-1" ${k ? '' : 'disabled'} aria-label="Move up">↑</button><button data-v2mv="${k}:1" ${k < list.length - 1 ? '' : 'disabled'} aria-label="Move down">↓</button></span>`}</li>`).join('') + '</ol>');
  } else if (check.format !== 'fill-blank' || !BLANK.test(check.prompt)) {
    parts.push(`<input class="v2-input" data-v2in="${i}" value="${esc(val || '')}" ${res ? 'disabled' : ''} placeholder="${check.format === 'predict-output' ? 'What does it print?' : 'Your answer'}" autocomplete="off" spellcheck="false">`);
  }
  if (!res) {
    parts.push(`<div class="sl-row v2-checkrow">${check.format === 'mcq' ? '' : `<button class="sl-inline-btn primary" data-v2check>Check</button>`}
      <button class="sl-link" data-v2reveal title="Space">Reveal</button></div>`);
  } else {
    const ok = res === 'right';
    parts.push(`<div class="v2-result ${ok ? 'ok' : 'no'}"><b>${ok ? '✓ Right' : res === 'revealed' ? 'Answer' : '✗ Not quite'}</b>${ok ? '' : ` — ${short(answerText(check))}`}` +
      `${check.explanation ? `<div class="v2-expl">${short(check.explanation)}</div>` : ''}` +
      `${!ok && (V.carded || {})[i] ? '<div class="sl-muted">Added to your cards, so it comes back.</div>' : ''}` +
      `<button class="sl-link" data-v2again>try again</button></div>`);
  }
  return parts.join('');
}

// ── Steps ────────────────────────────────────────────────────────────────
/** Prerequisite labels, linked to the document's topic that teaches them. */
function prereqHtml(lesson, ctx) {
  const list = lesson.prerequisites || [];
  if (!list.length) return '';
  const words = (s) => new Set(String(s).toLowerCase().match(/[a-z0-9]{3,}/g) || []);
  return `<div class="v2-chips"><span class="sl-muted">Builds on</span>${list.map((p) => {
    const w = words(p);
    let best = null, score = 0;
    for (const t of ctx.topics || []) {
      if (t.id === ctx.topicId || t.status !== 'ready') continue;
      const tw = words(t.title);
      let k = 0;
      w.forEach((x) => { if (tw.has(x)) k++; });
      const sc = w.size ? k / w.size : 0;
      if (sc > score) { score = sc; best = t; }
    }
    return best && score >= 0.5 ? `<button class="v2-chip" data-topic="${esc(best.id)}">${esc(p)}</button>` : `<span class="v2-chip">${esc(p)}</span>`;
  }).join('')}</div>`;
}

function walkHtml(step, i, V) {
  const d = step.diagram;
  const N = d.frames.length;
  const f = Math.max(0, Math.min(N - 1, V.frame[i] || 0));
  return `<div class="v2-walk" data-v2walk="${i}">${renderDiagram(d, { frame: f, className: 'v2-big' })}
    <div class="v2-note">${short(d.frames[f].note || '')}</div>
    <div class="v2-frames">
      <button data-v2frame="-1" ${f ? '' : 'disabled'} aria-label="Previous frame">◀</button>
      <span class="v2-fc">${f + 1} / ${N}</span>
      <button data-v2frame="1" ${f < N - 1 ? '' : 'disabled'} aria-label="Next frame">▶</button>
      <button class="sl-link" data-v2play>${V.playing === i ? 'pause' : f === N - 1 ? 'replay' : 'play'}</button>
    </div></div>`;
}

function codeStepHtml(step, i, V, ctx) {
  const sel = V.line[i] || 0;
  const a = (step.code.annotations || []).find((x) => x.line === sel);
  const d = linkedDiagram(ctx.lesson, step);
  const note = (step.code.annotations || []).length
    ? `<div class="v2-annote">${a ? `<b>Line ${a.line}</b> ${short(a.note)}` : '<span class="sl-muted">Tap a ● line to see what it does.</span>'}</div>` : '';
  return codeHtml(step.code, { selected: sel }) + note + (d ? renderDiagram(d, { extraHighlight: a && a.highlight ? a.highlight : [], className: 'v2-linked' }) : '');
}

function panelHtml(p) {
  return `<div class="v2-panel"><div class="v2-plabel">${esc(p.label)}</div>${p.body ? `<div class="sl-prose">${md(p.body)}</div>` : ''}${
    p.diagram ? renderDiagram(p.diagram) : ''}${p.code ? codeHtml(p.code, { interactive: false }) : ''}</div>`;
}

/** Recap takeaways as cloze cards: the key term is the blank. */
export function clozeOf(text) {
  const t = String(text || '');
  const code = /`([^`]+)`/.exec(t);
  if (code) return t.replace(code[0], `{{1::${code[1]}}}`);
  const bold = /\*\*([^*]+)\*\*/.exec(t);
  if (bold) return t.replace(bold[0], `{{1::${bold[1]}}}`);
  const STOP = /^(about|after|always|before|because|being|every|their|there|these|those|which|while|where|would|should|could|other|first|means)$/i;
  const cand = (t.match(/[A-Za-z][\w.()<>=-]{4,}/g) || []).filter((w) => !STOP.test(w)).sort((a, b) => b.length - a.length)[0];
  return cand ? t.replace(cand, `{{1::${cand}}}`) : `{{1::${t}}}`;
}

function recapHtml(step, i, V, ctx) {
  const tk = step.takeaways || [];
  const ex = V.explain || {};
  return `${step.body ? `<div class="sl-prose">${md(step.body)}</div>` : ''}
    <ul class="v2-takeaways">${tk.map((x) => `<li><span>${short(x)}</span><button class="sl-link sl-add" data-addcard="${esc(x)}" title="Make a flashcard from this">＋ card</button></li>`).join('')}</ul>
    <div class="sl-row" style="gap:10px;flex-wrap:wrap">
      ${tk.length ? `<button class="sl-inline-btn" data-v2addall ${V.addedAll ? 'disabled' : ''}>${V.addedAll ? 'Added' : 'Add all as cards'}</button>` : ''}
      <button class="sl-inline-btn" data-v2sheet>Cheat sheet</button>
    </div>
    <div class="v2-explain">
      <label for="v2-explain-in">Explain it back <span class="sl-muted">— optional</span></label>
      <textarea id="v2-explain-in" data-v2explain rows="2" placeholder="Explain this topic in 1–2 sentences.">${esc(V.explainText || '')}</textarea>
      <div class="sl-row"><button class="sl-inline-btn" data-v2explaingo ${ex.status === 'busy' ? 'disabled' : ''}>${ex.status === 'busy' ? 'Checking…' : 'Check my explanation'}</button></div>
      ${ex.status === 'done' ? `<div class="v2-result ${ex.ok ? 'ok' : 'no'}"><b>${short(ex.verdict)}</b>${(ex.missing || []).length ? `<div class="v2-expl">Missing: ${ex.missing.map(short).join('; ')}</div>` : ''}</div>`
        : ex.status === 'error' ? `<div class="sl-muted">${esc(ex.error)}</div>` : ''}
    </div>`;
}

/** The step on screen. ctx: { lesson, topics, topicId, V, carded } */
export function stepHtml(step, i, ctx) {
  const V = ctx.V;
  const head = step.heading ? `<h2>${step.type === 'trap' ? `<span class="v2-ci" aria-hidden="true">${ICON.trap}</span> ` : ''}${short(step.heading)}</h2>` : '';
  const body = step.body ? `<div class="sl-prose">${md(step.body)}</div>` : '';
  const call = calloutsHtml(step.callouts);
  const dia = step.diagram ? renderDiagram(step.diagram) : '';
  const code = step.code ? codeHtml(step.code, { selected: V.line[i] || 0 }) : '';
  switch (step.type) {
    case 'hook':
      return `${head}<div class="v2-hook">${body}</div>${ctx.lesson.whyItMatters ? `<div class="v2-why"><span>Why it matters</span>${short(ctx.lesson.whyItMatters)}</div>` : ''}${
        dia}${code}${call}${prereqHtml(ctx.lesson, ctx)}`;
    case 'diagram':
      return `${head}${step.diagram ? renderDiagram(step.diagram, { className: 'v2-big' }) : ''}${body}${code}${call}`;
    case 'code':
      return `${head}${body}${codeStepHtml(step, i, V, ctx)}${call}`;
    case 'walkthrough':
      return `${head}${body}${walkHtml(step, i, V)}${call}`;
    case 'compare':
      return `${head}${body}<div class="v2-compare">${panelHtml(step.compare.left)}${panelHtml(step.compare.right)}</div>${call}`;
    case 'check':
      return `${head}${body}${dia}${code}${checkHtml(step.check, i, V, ctx)}${call}`;
    case 'practice':
      return `${head}${body}${dia}${code}${checkHtml(step.check, i, V, ctx)}${call}`;
    case 'recap':
      return `${head || '<h2>Key takeaways</h2>'}${recapHtml(step, i, V, ctx)}`;
    case 'figure':
      return `${head}<figure class="sl-fig" data-fig-screen="${i}"><div class="sl-fig-slot sl-muted">Loading the figure…</div>
        <figcaption class="sl-muted">From page ${Number(step.page) || 0} of ${esc(ctx.sourceName || 'the document')}</figcaption></figure>${body}`;
    case 'trap':
    case 'concept':
    default:
      return `${head}${body}${dia}${code}${call}`;
  }
}

// ── Cheat sheet ──────────────────────────────────────────────────────────
/** A topic's one-screen summary: v2's cheatSheet, or a v1 lesson's recap. */
export function sheetOf(topic) {
  const L = topic && topic.lesson;
  if (!L) return null;
  if (L.version === 2) return L.cheatSheet || { bullets: [] };
  const recap = (L.blocks || []).find((b) => b.kind === 'recap');
  return { bullets: ((recap && recap.points) || []).slice(0, 6) };
}

export function cheatSheetHtml(topic, { interactive = true } = {}) {
  const cs = sheetOf(topic) || { bullets: [] };
  const cx = cs.complexities || [];
  return `<div class="v2-sheet">
    ${cs.diagram ? renderDiagram(cs.diagram) : ''}
    ${(cs.bullets || []).length ? `<ul class="v2-sheet-b">${cs.bullets.map((b) => `<li>${short(b)}</li>`).join('')}</ul>` : '<div class="sl-muted">No summary for this topic.</div>'}
    ${cs.code ? codeHtml(cs.code, { interactive: false }) : ''}
    ${cx.length ? `<table class="dg-table v2-bigo"><thead><tr><th>Operation</th><th>Best</th><th>Average</th><th>Worst</th></tr></thead><tbody>${
      cx.map((r) => `<tr><td>${esc(r.op)}</td><td>${esc(r.best || '—')}</td><td>${esc(r.avg || '—')}</td><td>${esc(r.worst)}</td></tr>`).join('')}</tbody></table>` : ''}
    ${interactive ? '' : ''}
  </div>`;
}

/** The print window's styles: the lesson's diagram and code rules on a light page. */
export function printCss() {
  const v2css = (styleCss().split('/* ── v2 lessons')[1] || '').split('/* ── AI settings')[0].replace(/^[^\n]*\n/, '');
  return `body{font:14px/1.55 system-ui,sans-serif;color:#1d1b20;background:#fff;margin:28px;max-width:820px}
    :root{--text:#1d1b20;--text2:#3c3842;--text3:#6b6572;--bg:#fff;--bg2:#fff;--bg3:#f3f1f5;--bg4:#ece9ef;--border:#d9d4de;--border2:#c9c3cf;--accent:#7a5f8a;--accent2:#7a5f8a;--mono:ui-monospace,Consolas,monospace}
    h1{font-size:22px;margin:0 0 18px}h2{font-size:17px;margin:26px 0 10px;break-after:avoid}section{break-inside:avoid;border-top:1px solid #ddd;padding-top:6px}
    ${v2css}.hl-kw{color:#7b3fa0}.hl-type{color:#1f5f8f}.hl-str{color:#2d7a4f}.hl-num{color:#a35a12}.v2-sheet .dg-svg{max-height:260px}@media print{body{margin:0}}`;
}

/** Every ready topic's cheat sheet, in a new window, for print / save as PDF. */
export function printCheatSheets(doc, css = printCss()) {
  const topics = (doc.topics || []).filter((t) => t.status === 'ready' && t.lesson);
  const w = window.open('', '_blank');
  if (!w) return false;
  const body = topics.map((t, k) => `<section><h2>${k + 1}. ${esc(t.title)}</h2>${cheatSheetHtml(t, { interactive: false })}</section>`).join('');
  w.document.open();
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(doc.sourceName || 'Cheat sheets')} — cheat sheets</title>
    <style>${css}</style></head><body class="v2-print"><h1>${esc(doc.sourceName || 'Cheat sheets')}</h1>${body}
    <script>window.onload = () => setTimeout(() => window.print(), 200);<\/script></body></html>`);
  w.document.close();
  return true;
}

// ── Interaction ──────────────────────────────────────────────────────────
/**
 * Wire the step on screen. `actions`: { rerender(), record(i, ok), addCard(text),
 * addAll(texts), openSheet(), explain(text) -> Promise<{verdict, ok, missing}> }.
 */
export function wireStep(root, step, i, ctx, actions) {
  const V = ctx.V;
  const card = root.querySelector('.sl-card');
  if (!card) return;
  const check = step.check;
  const finish = (res) => {
    V.done[i] = res;
    actions.record(i, res === 'right');
    actions.rerender();
  };
  const submit = () => {
    if (!check || V.done[i]) return;
    const inp = card.querySelector('[data-v2in]');
    if (inp) V.ans[i] = inp.value;
    let val = V.ans[i];
    if (check.format === 'order' && !Array.isArray(val)) val = V.ans[i] = startOrder(check);
    if (check.format !== 'order' && check.format !== 'mcq' && !String(val || '').trim()) { inp && inp.focus(); return; }
    finish(grade(check, val) ? 'right' : 'wrong');
  };
  card.addEventListener('click', (e) => {
    const t = e.target.closest('button,[data-v2line]');
    if (!t || !card.contains(t)) return;
    if (t.dataset.v2opt != null && check) { V.ans[i] = check.options[+t.dataset.v2opt]; finish(grade(check, V.ans[i]) ? 'right' : 'wrong'); return; }
    if (t.hasAttribute('data-v2check')) return submit();
    if (t.hasAttribute('data-v2reveal')) return reveal(V, i, actions);
    if (t.hasAttribute('data-v2again')) { delete V.done[i]; delete V.ans[i]; actions.rerender(); return; }
    if (t.dataset.v2mv) {
      const [k, dir] = t.dataset.v2mv.split(':').map(Number);
      const list = Array.isArray(V.ans[i]) ? V.ans[i] : (V.ans[i] = startOrder(check));
      const j = k + dir;
      if (j >= 0 && j < list.length) [list[k], list[j]] = [list[j], list[k]];
      actions.rerender();
      return;
    }
    if (t.dataset.v2frame) { stopPlay(V); setFrame(V, i, step, (V.frame[i] || 0) + Number(t.dataset.v2frame), card); return; }
    if (t.hasAttribute('data-v2play')) { togglePlay(V, i, step, card); return; }
    if (t.dataset.v2line) { const n = Number(t.dataset.v2line); V.line[i] = n; paintCode(card, step, i, ctx); return; }
    if (t.hasAttribute('data-v2addall')) { actions.addAll(step.takeaways || []); V.addedAll = true; actions.rerender(); return; }
    if (t.hasAttribute('data-v2sheet')) { actions.openSheet(); return; }
    if (t.hasAttribute('data-v2explaingo')) {
      const ta = card.querySelector('[data-v2explain]');
      const text = ta ? ta.value.trim() : '';
      if (!text) { ta && ta.focus(); return; }
      V.explainText = text;
      V.explain = { status: 'busy' };
      actions.rerender();
      Promise.resolve(actions.explain(text)).then((r) => { V.explain = { status: 'done', ...r }; actions.rerender(); },
        (err) => { V.explain = { status: 'error', error: (err && err.message) || String(err) }; actions.rerender(); });
    }
  });
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('[data-v2in]')) { e.preventDefault(); submit(); }
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-v2line]')) { e.preventDefault(); e.target.click(); }
  });
  card.addEventListener('input', (e) => {
    if (e.target.matches('[data-v2in]')) V.ans[i] = e.target.value;
    if (e.target.matches('[data-v2explain]')) V.explainText = e.target.value;
  });
  card.addEventListener('mouseover', (e) => {
    const l = e.target.closest('[data-v2line]');
    if (!l || V.line[i] === Number(l.dataset.v2line)) return;
    V.line[i] = Number(l.dataset.v2line);
    paintCode(card, step, i, ctx);
  });
}

function reveal(V, i, actions) {
  if (V.done[i]) return;
  V.done[i] = 'revealed';
  actions.record(i, false);
  actions.rerender();
}

/** Keyboard (lesson-ui): Space reveals, 1-9 pick an option. True if handled. */
export function onKey(e, step, i, ctx, actions, root) {
  const V = ctx.V;
  if (!step || !step.check || V.done[i]) return false;
  if (e.key === ' ') { e.preventDefault(); reveal(V, i, actions); return true; }
  if (step.check.format === 'mcq' && /^[1-9]$/.test(e.key)) {
    const b = root.querySelector(`[data-v2opt="${Number(e.key) - 1}"]`);
    if (b) { e.preventDefault(); b.click(); return true; }
  }
  return false;
}

/** Repaint just a code step's highlights and note (no fade, no scroll jump). */
function paintCode(card, step, i, ctx) {
  const wrap = document.createElement('div');
  wrap.innerHTML = codeStepHtml(step, i, ctx.V, ctx);
  const old = card.querySelectorAll('.v2-code, .v2-annote, .v2-linked');
  if (!old.length) return;
  old[0].before(...wrap.childNodes);
  old.forEach((el) => el.remove());
}

function setFrame(V, i, step, f, card) {
  const N = step.diagram.frames.length;
  V.frame[i] = Math.max(0, Math.min(N - 1, f));
  const el = card.querySelector(`[data-v2walk="${i}"]`);
  if (!el) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = walkHtml(step, i, V);
  el.replaceWith(tmp.firstElementChild);
}

export function stopPlay(V) {
  if (V.timer) clearInterval(V.timer);
  V.timer = null;
  V.playing = null;
}

function togglePlay(V, i, step, card) {
  if (V.playing === i) { stopPlay(V); setFrame(V, i, step, V.frame[i] || 0, card); return; }
  stopPlay(V);
  const N = step.diagram.frames.length;
  if ((V.frame[i] || 0) >= N - 1) V.frame[i] = 0;
  V.playing = i;
  setFrame(V, i, step, V.frame[i] || 0, card);
  // The step may be redrawn while it plays (a progress save repaints the
  // reader): always draw into the walkthrough that is on screen now.
  const onScreen = () => { const w = document.querySelector(`#sos-lesson-root [data-v2walk="${i}"]`); return w && w.closest('.sl-card'); };
  V.timer = setInterval(() => {
    const live = onScreen();
    const f = (V.frame[i] || 0) + 1;
    if (!live || f >= N) { stopPlay(V); if (live) setFrame(V, i, step, V.frame[i] || 0, live); return; }
    setFrame(V, i, step, f, live);
  }, 1200);
}

/** Fresh per-sitting state for a v2 lesson. */
export const newState = () => ({ ans: {}, done: {}, frame: {}, line: {}, playing: null, timer: null, explain: null, explainText: '', addedAll: false });

export default { stepHtml, wireStep, onKey, labelOf, grade, startOrder, clozeOf, cheatSheetHtml, printCheatSheets, sheetOf, newState, stopPlay, linkedDiagram, codeHtml, ICON };
