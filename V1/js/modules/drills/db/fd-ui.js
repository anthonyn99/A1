/* ============================================================================
 * StudyOS drills — Keys & closures, Normalization trainer  (Kroenke ch. 3)
 * ============================================================================
 * Endless questions: each is generated from a seed by fd.js and graded by the
 * same functions, so there is no answer key that could be wrong.
 *
 * keys:       rotate through  closure X+  ·  all candidate keys  ·  superkey?
 * normalize:  name the highest normal form (and see why), then decompose the
 *             relation into BCNF — graded for coverage, a lossless join and
 *             every part being BCNF; dependency preservation is reported.
 * ------------------------------------------------------------------------- */

import * as F from './fd.js';

const seed = () => Math.floor(Math.random() * 1e9);

function relHtml(esc, q) {
  return `<div class="sp-code" style="white-space:normal">R(${esc(q.R.join(', '))})<br>${q.fds.map((f) => esc(F.fmtFD(f))).join('<br>')}</div>`;
}

/**
 * "AB, CD" / "AB CD" / "{A,B} {C,D}" -> [[A,B],[C,D]]. Generated relations use
 * single-letter attributes, so any comma, semicolon or space separates groups
 * and each group is read letter by letter. (Braces with commas INSIDE a group
 * are read as separate one-letter groups — the placeholder shows the format.)
 */
export function parseGroups(text) {
  return String(text || '').toUpperCase().replace(/[{}()]/g, ' ')
    .split(/[\s,;]+/).filter(Boolean)
    .map((g) => F.set(g.replace(/[^A-Z]/g, '').split(''))).filter((g) => g.length);
}

// ── Keys & closures ─────────────────────────────────────────────────────────
function mountKeys(host, ctx) {
  const { esc } = ctx;
  let n = 0;

  const next = () => {
    const q = F.randomRelation(seed());
    const kind = ['closure', 'keys', 'superkey'][n++ % 3];
    const keys = F.candidateKeys(q.R, q.fds);
    let body = '', check;

    if (kind === 'closure') {
      const size = 1 + Math.floor(Math.random() * 2);
      const X = F.set([...q.R].sort(() => Math.random() - 0.5).slice(0, size));
      const truth = F.closure(X, q.fds);
      body = `<div style="margin:10px 0">Compute the closure <b>{${esc(F.fmt(X))}}<sup>+</sup></b>. Tick every attribute it contains.</div>
        <div class="sp-row">${q.R.map((a) => `<label class="sp-chip" style="display:inline-flex;gap:6px;align-items:center"><input type="checkbox" value="${esc(a)}"${X.includes(a) ? ' checked' : ''}> ${esc(a)}</label>`).join('')}</div>`;
      check = () => {
        const mine = F.set([...host.querySelectorAll('input[type=checkbox]:checked')].map((i) => i.value));
        const ok = F.eq(mine, truth);
        return { ok, topic: 'Attribute closure', msg: ok ? `Right: {${F.fmt(X)}}+ = {${F.fmt(truth)}}.`
          : `{${F.fmt(X)}}+ = {${F.fmt(truth)}}. Start from ${F.fmt(X)} and keep applying any FD whose left side you already have.` };
      };
    } else if (kind === 'keys') {
      body = `<div style="margin:10px 0">List <b>every candidate key</b>, separated by spaces (e.g. <code>AB CD</code>).</div>
        <input class="sp-input" data-ans style="width:100%" placeholder="AB CD">`;
      check = () => {
        const mine = parseGroups(host.querySelector('[data-ans]').value);
        const ok = mine.length === keys.length && keys.every((k) => mine.some((m) => F.eq(m, k)));
        const superkeys = mine.filter((m) => F.isSuperkey(m, q.R, q.fds) && !keys.some((k) => F.eq(k, m)));
        const why = superkeys.length ? ` ${F.fmt(superkeys[0])} is a superkey but not minimal.` : '';
        return { ok, topic: 'Candidate keys', msg: ok ? `Right: ${keys.map(F.fmt).join(', ')}.`
          : `The candidate keys are ${keys.map(F.fmt).join(', ')}.${why} Attributes never on a right-hand side must be in every key.` };
      };
    } else {
      const X = F.set([...q.R].sort(() => Math.random() - 0.5).slice(0, 2));
      const truth = F.isSuperkey(X, q.R, q.fds);
      body = `<div style="margin:10px 0">Is <b>${esc(F.fmt(X))}</b> a superkey of R?</div>
        <div class="sp-row"><button class="sp-btn" data-yn="1">Yes</button><button class="sp-btn" data-yn="0">No</button></div>`;
      check = (yn) => {
        const ok = (yn === '1') === truth;
        return { ok, topic: 'Superkeys', msg: `${F.fmt(X)}+ = {${F.fmt(F.closure(X, q.fds))}} — ${truth ? 'that is all of R, so yes.' : 'not all of R, so no.'}` };
      };
    }

    host.innerHTML = `<div class="sp-panel">${relHtml(esc, q)}${body}
      <div class="sp-row" style="margin-top:10px">${kind === 'superkey' ? '' : '<button class="sp-btn primary" data-check>Check</button>'}
      <button class="sp-btn" data-skip>Skip</button></div>
      <div data-fb style="margin-top:10px;font-size:14px"></div></div>`;
    const fb = host.querySelector('[data-fb]');
    const finish = (r) => {
      ctx.record({ topic: r.topic, correct: r.ok, difficulty: kind === 'keys' ? 2 : 1 });
      fb.innerHTML = `<span class="${r.ok ? 'sp-ok' : 'sp-bad'}">${r.ok ? '✓' : '✗'} ${esc(r.msg)}</span>
        <div style="margin-top:10px"><button class="sp-btn primary" data-next>Next</button></div>`;
      host.querySelectorAll('[data-check],[data-yn]').forEach((b) => { b.disabled = true; });
      fb.querySelector('[data-next]').onclick = next;
    };
    const c = host.querySelector('[data-check]');
    if (c) c.onclick = () => finish(check());
    host.querySelectorAll('[data-yn]').forEach((b) => { b.onclick = () => finish(check(b.dataset.yn)); });
    host.querySelector('[data-skip]').onclick = next;
    const inp = host.querySelector('[data-ans]');
    if (inp) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && c) c.click(); });
  };
  next();
  return null;
}

// ── Normalization trainer ───────────────────────────────────────────────────
function mountNormalize(host, ctx) {
  const { esc } = ctx;
  const next = () => {
    const q = F.randomRelation(seed());
    const truth = F.normalForm(q.R, q.fds);
    host.innerHTML = `<div class="sp-panel">${relHtml(esc, q)}
      <div style="margin:10px 0"><b>Step 1.</b> What is the highest normal form R is in?</div>
      <div class="sp-row">${['1NF', '2NF', '3NF', 'BCNF'].map((nf) => `<button class="sp-btn" data-nf="${nf}">${nf}</button>`).join('')}</div>
      <div data-fb1 style="margin-top:10px;font-size:14px"></div>
      <div data-step2></div></div>`;
    const fb1 = host.querySelector('[data-fb1]');
    host.querySelectorAll('[data-nf]').forEach((b) => {
      b.onclick = () => {
        const ok = b.dataset.nf === truth.nf;
        ctx.record({ topic: 'Normal forms', correct: ok, difficulty: 2 });
        host.querySelectorAll('[data-nf]').forEach((x) => { x.disabled = true; if (x.dataset.nf === truth.nf) x.classList.add('primary'); });
        const v = truth.violations[0];
        fb1.innerHTML = `<span class="${ok ? 'sp-ok' : 'sp-bad'}">${ok ? '✓' : '✗'} It is in ${truth.nf}.</span>
          <div class="sp-muted" style="margin-top:4px">Candidate key${truth.keys.length > 1 ? 's' : ''}: ${esc(truth.keys.map(F.fmt).join(', '))}.
          ${v ? `Not ${({ '1NF': '2NF', '2NF': '3NF', '3NF': 'BCNF' })[truth.nf]} because ${esc(F.fmtFD(v.fd))}: ${esc(v.why)}.` : ''}</div>`;
        step2(q);
      };
    });
  };
  const step2 = (q) => {
    const el = host.querySelector('[data-step2]');
    el.innerHTML = `<div style="margin:14px 0 6px"><b>Step 2.</b> Decompose R into BCNF. Write each relation's attributes, separated by spaces or commas (e.g. <code>AB, BC</code>).</div>
      <input class="sp-input" data-parts style="width:100%" placeholder="AB, BCD">
      <div class="sp-row" style="margin-top:8px"><button class="sp-btn primary" data-check>Check</button><button class="sp-btn" data-show>Show a solution</button><button class="sp-btn" data-next>New relation</button></div>
      <div data-fb2 style="margin-top:10px;font-size:14px"></div>`;
    const fb2 = el.querySelector('[data-fb2]');
    let recorded = false;
    el.querySelector('[data-check]').onclick = () => {
      const parts = parseGroups(el.querySelector('[data-parts]').value);
      const r = F.checkDecomposition(q.R, q.fds, parts);
      if (!recorded) { recorded = true; ctx.record({ topic: 'BCNF decomposition', correct: r.ok, difficulty: 3 }); }
      fb2.innerHTML = r.ok
        ? `<span class="sp-ok">✓ Lossless, and every relation is in BCNF.</span>${r.preserves ? '<div class="sp-muted">It also preserves every dependency.</div>'
          : `<div class="sp-muted">Note: it does not preserve ${esc(r.lost.map(F.fmtFD).join(', '))} — a BCNF split sometimes cannot.</div>`}`
        : `<span class="sp-bad">✗ ${r.problems.map(esc).join('<br>')}</span>`;
    };
    el.querySelector('[data-show]').onclick = () => {
      const d = F.bcnfDecompose(q.R, q.fds);
      fb2.innerHTML = `<div class="sp-muted">One BCNF decomposition:</div><div class="sp-code">${esc(d.map(F.fmt).join(', '))}</div>`;
    };
    el.querySelector('[data-next]').onclick = next;
    el.querySelector('[data-parts]').addEventListener('keydown', (e) => { if (e.key === 'Enter') el.querySelector('[data-check]').click(); });
  };
  next();
  return null;
}

export function mount(host, ctx) {
  return ctx.mode === 'normalize' ? mountNormalize(host, ctx) : mountKeys(host, ctx);
}

export default { mount };
