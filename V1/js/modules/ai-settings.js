/* ============================================================================
 * StudyOS — AI settings view
 * ============================================================================
 * Which model writes topic breakdowns, and the keys for it. Keys are kept in
 * THIS browser only (see ai.js) — the view says so, because "I added my key
 * on the laptop, why doesn't my phone have it" is the obvious next question.
 * ------------------------------------------------------------------------- */

import * as ai from './ai.js';
import { ensureStyle } from './study-style.js';
import { escapeHtml as esc } from './md.js';
import { cardSettings, saveCardSettings } from './card-settings.js';

const BLURB = {
  bridge: 'Your Claude Pro plan, through the bridge on this PC. No key.',
  anthropic: 'Claude with your own API key. Billed per use.',
  openai: 'OpenAI, OpenRouter, Groq or any compatible API.',
  gemini: 'Google Gemini with your API key.',
  orca: 'Your ORCA router: Claude, ChatGPT, DeepSeek, Gemini, Perplexity… with an orca_sk_ key.',
};

const KEY_HINT = {
  anthropic: 'sk-ant-…  (console.anthropic.com → API keys)',
  openai: 'sk-…  (your provider’s API keys page)',
  gemini: 'AIza…  (aistudio.google.com → Get API key)',
  orca: 'orca_sk_…  (ORCA → Keys, in your profile)',
};

const MODEL_HINT = {
  anthropic: 'claude-opus-5-5',
  openai: 'the model id your provider lists, e.g. for OpenRouter "provider/model"',
  gemini: 'a Gemini model id from Google AI Studio',
};

let draft = null;
let _autoDetected = false;      // one automatic model listing per visit

/* Each provider's mark in the picker: line icons in the app's own set. */
const PROV_ICON = {
  bridge:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/></svg>',
  anthropic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/></svg>',
  openai:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18Z"/></svg>',
  gemini:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2c.6 5.4 4.6 9.4 10 10-5.4.6-9.4 4.6-10 10-.6-5.4-4.6-9.4-10-10 5.4-.6 9.4-4.6 10-10Z"/></svg>',
  orca:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M8 7.5 11 16"/><path d="m16 7.5-3 8.5"/><path d="M8.5 6h7"/></svg>',
};
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
const LOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

export function render() {
  ensureStyle();
  const root = document.getElementById('sos-ai-root');
  if (!root) return;
  if (!draft) draft = ai.settings();
  const p = draft.provider;
  const def = ai.PROVIDERS[p];
  const active = ai.active();

  root.innerHTML = `
    <header class="ais-top">
      <div class="ais-eyebrow">AI &amp; flashcards</div>
      <h1 class="ais-h">Study settings</h1>
      <p class="ais-lead">Which model turns a document into topics, lessons and flashcards, and how your daily reviews feel.
        Slide decks always come from NotebookLM through the bridge on this PC.</p>
    </header>

    <section class="ais-sec">
      <div class="ais-sec-hd">
        <div><h2>Breakdown model</h2><p>Writes the lessons and cards for “Break down”.</p></div>
        <span class="ais-now" title="What breakdowns use right now">${esc(active.label || '')}</span>
      </div>
      <div class="ais-prov" role="radiogroup" aria-label="Model provider">
        ${Object.entries(ai.PROVIDERS).map(([id, v]) => `
          <button type="button" data-prov="${id}" class="${id === p ? 'on' : ''}" role="radio" aria-checked="${id === p}">
            <span class="ais-prov-ic">${PROV_ICON[id] || PROV_ICON.anthropic}</span>
            <span class="ais-prov-t">${esc(v.label)}</span>
            <small>${esc(BLURB[id])}</small>
            <span class="ais-prov-tick">${CHECK}</span>
          </button>`).join('')}
      </div>

      <div class="ais-panel">
        ${p === 'bridge' ? `
          <div class="ais-note"><span>Uses the Claude Pro account signed in on the bridge's browser. Each topic is one
            Claude message (plus one to list the topics). The bridge must be running on this PC:
            <code>python server.py autostart</code> once, in <code>V1/tools/sos-browser</code>.</span></div>` : `
          ${p === 'openai' || p === 'orca' ? `
            <div class="ais-field"><label for="ais-base">API base URL</label>
              <input id="ais-base" value="${esc(draft.baseUrl[p] || def.defaultBase)}" spellcheck="false" autocomplete="off"></div>` : ''}
          ${p === 'orca' ? orcaHtml() : `
          <div class="ais-grid">
            <div class="ais-field"><label for="ais-key">${esc(def.label)} key</label>
              <div class="ais-keyrow">
                <input id="ais-key" type="password" value="${esc(draft.keys[p] || '')}" placeholder="${esc(KEY_HINT[p] || '')}" spellcheck="false" autocomplete="off">
                <button class="btn ghost" data-show type="button">Show</button>
              </div></div>
            <div class="ais-field"><label for="ais-model">Model</label>
              <input id="ais-model" value="${esc(draft.models[p] || def.defaultModel || '')}" placeholder="${esc(MODEL_HINT[p] || '')}" spellcheck="false" autocomplete="off"></div>
          </div>`}
          <div class="ais-note"><span class="ais-note-ic">${LOCK}</span><span>Your key is kept <b>in this browser only</b>: it is never synced or saved to the cloud,
            so add it on each device you break documents down from.
            ${p === 'orca' ? 'ORCA gets the document as text (long text as an attached file), plus the PDF and its figures for models that read them; scanned PDFs are read with OCR first (slower).' : 'The model has to read PDFs.'}</span></div>`}

        <div class="ais-actions">
          <button class="btn primary" data-save>Save</button>
          <button class="btn ghost" data-test title="Sends one tiny request">Test connection</button>
          <div class="ais-msg" id="ais-msg"></div>
        </div>
      </div>
    </section>
    ${cardsHtml()}`;
  wireCards(root);
  const msg = (text, ok) => {
    const el = root.querySelector('#ais-msg');
    el.textContent = text;
    el.className = 'ais-msg ' + (ok === true ? 'ok' : ok === false ? 'err' : '');
  };
  const collect = () => {
    const k = root.querySelector('#ais-key'), m = root.querySelector('#ais-model'), b = root.querySelector('#ais-base');
    const busy = root.querySelector('#ais-busy');
    if (p === 'orca') {
      const pk = root.querySelector('#ais-pick');
      if (k) draft.keys = { ...draft.keys, orca: k.value.trim() };
      if (pk) draft.orcaPick = pk.value || 'auto';
      if (busy) draft.orcaBusy = busy.value === 'auto' ? 'auto' : 'wait';
    } else {
      if (k) draft.keys = { ...draft.keys, [p]: k.value.trim() };
      if (m) draft.models = { ...draft.models, [p]: m.value.trim() };
    }
    if (b) draft.baseUrl = { ...draft.baseUrl, [p]: b.value.trim() };
  };
  const save = () => {
    collect();
    const r = ai.saveSettings(draft);
    if (!r.ok) { msg('Not saved — ' + r.error + '.', false); return false; }
    return true;
  };

  root.querySelectorAll('[data-prov]').forEach((b) => b.addEventListener('click', () => {
    collect();
    draft.provider = b.dataset.prov;
    render();
  }));
  const pick = root.querySelector('#ais-pick');
  if (pick) pick.addEventListener('change', () => { collect(); render(); });
  // A press saves what is on screen first (like Test); the automatic listing
  // uses the key already saved and never saves a half-edited form.
  const detect = async (quiet) => {
    if (!quiet && !save()) return;
    const btn = root.querySelector('[data-detect]');
    if (btn) btn.disabled = true;
    if (!quiet) msg('Asking ORCA for its models…');
    try {
      await ai.detectOrcaModels();
      if (!root.isConnected || draft.provider !== 'orca') return;
      collect();                       // keep whatever she typed meanwhile
      draft = { ...draft, orcaModels: ai.settings().orcaModels };
      render();
      if (!quiet) {
        const list = draft.orcaModels.list;
        root.querySelector('#ais-msg').textContent = `Found ${list.filter((m) => m.routable).length} usable model${list.length === 1 ? '' : 's'}.`;
        root.querySelector('#ais-msg').className = 'ais-msg ok';
      }
    } catch (err) {
      if (!quiet) msg((err && err.message) || String(err), false);
    } finally {
      const b = root.querySelector('[data-detect]');
      if (b) b.disabled = false;
    }
  };
  const det = root.querySelector('[data-detect]');
  if (det) det.addEventListener('click', () => detect(false));
  // Opening ORCA with a key and no list (or a day-old one) lists them by itself.
  if (p === 'orca' && ai.settings().keys.orca && !_autoDetected
      && (!(draft.orcaModels.list || []).length || Date.now() - (draft.orcaModels.detectedAt || 0) > 864e5)) {
    _autoDetected = true;
    detect(true);
  }
  const show = root.querySelector('[data-show]');
  if (show) show.addEventListener('click', () => {
    const k = root.querySelector('#ais-key');
    k.type = k.type === 'password' ? 'text' : 'password';
    show.textContent = k.type === 'password' ? 'Show' : 'Hide';
  });
  root.querySelector('[data-save]').addEventListener('click', () => {
    if (save()) {
      const a = ai.active();
      msg(a.problem ? 'Saved. ' + a.problem : `Saved — breakdowns will use ${a.label}${a.id === 'bridge' ? '' : ' · ' + a.model}.`, !a.problem);
    }
  });
  root.querySelector('[data-test]').addEventListener('click', async (e) => {
    if (!save()) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    msg('Testing…');
    try { msg(await ai.testConnection(), true); }
    catch (err) { msg((err && err.message) || String(err), false); }
    finally { btn.disabled = false; }
  });
}

/* ORCA: one key, and the model it should use. The list is ORCA's own
 * (ai.detectOrcaModels → /admin/models), so a model added to ORCA shows up
 * here by itself. Auto = ORCA picks whichever is free. */
function orcaHtml() {
  const pick = draft.orcaPick;
  const list = (draft.orcaModels && draft.orcaModels.list) || [];
  const row = list.find((m) => m.backend_key === pick);
  const label = row ? row.display_name : pick;
  const opt = (m) => `<option value="${esc(m.backend_key)}"${m.backend_key === pick ? ' selected' : ''}${m.routable ? '' : ' disabled'}>${
    esc(m.display_name)}${m.routable ? '' : ` — ${esc(m.why)}`}</option>`;
  const usable = list.filter((m) => m.routable).length;
  return `
      <div class="ais-field"><label for="ais-key">ORCA key</label>
        <div class="ais-keyrow">
          <input id="ais-key" type="password" value="${esc(draft.keys.orca || '')}" placeholder="${esc(KEY_HINT.orca)}" spellcheck="false" autocomplete="off">
          <button class="btn ghost" data-show type="button">Show</button>
        </div></div>
      <div class="ais-field"><label for="ais-pick">Model</label>
        <div class="ais-keyrow">
          <select id="ais-pick">
            <option value="auto"${pick === 'auto' ? ' selected' : ''}>Auto — whichever model is free</option>
            ${list.map(opt).join('')}
            ${pick !== 'auto' && !row ? `<option value="${esc(pick)}" selected>${esc(pick)} — not in ORCA's list</option>` : ''}
          </select>
          <button class="btn ghost" data-detect type="button" title="Ask ORCA which models this key can use">Detect models</button>
        </div>
        <div class="ais-note" id="ais-detected" style="margin-top:6px">${list.length
          ? `${usable} of ${list.length} models usable now${draft.orcaModels.detectedAt ? ` · checked ${esc(new Date(draft.orcaModels.detectedAt).toLocaleString())}` : ''}.`
          : 'Press <b>Detect models</b> to list the models your ORCA key can use.'}</div></div>
      ${pick !== 'auto' ? `
      <div class="ais-field"><label for="ais-busy">If ${esc(label)} is busy or rate-limited</label>
        <select id="ais-busy">
          <option value="wait"${draft.orcaBusy !== 'auto' ? ' selected' : ''}>Wait for it (up to 10 minutes per step)</option>
          <option value="auto"${draft.orcaBusy === 'auto' ? ' selected' : ''}>Use whichever model is free instead</option>
        </select></div>` : ''}`;
}

/* Flashcards: how many new cards a day, and how reviews feel. Saved on
 * change — there is nothing to test. Per device, like the AI keys. */
function cardsHtml() {
  const s = cardSettings();
  const sw = (id, on, label, note) => `
    <label class="ais-switch-row" for="${id}">
      <span class="ais-switch-txt"><b>${label}</b><small>${note}</small></span>
      <input type="checkbox" class="ais-switch" id="${id}" ${on ? 'checked' : ''} data-native>
      <span class="ais-switch-ui" aria-hidden="true"></span>
    </label>`;
  return `
    <section class="ais-sec">
      <div class="ais-sec-hd">
        <div><h2>Flashcards</h2><p>How many new cards you meet each day, and how reviewing feels. Saved on this device.</p></div>
      </div>
      <div class="ais-panel">
        <div class="ais-grid three">
          <div class="ais-field"><label for="cs-new">New cards a day</label>
            <input id="cs-new" type="number" min="0" max="500" value="${s.newPerDay}">
            <div class="ais-hint">15 a day is about 450 a month.</div></div>
          <div class="ais-field"><label for="cs-rev">Reviews a day, at most</label>
            <input id="cs-rev" type="number" min="10" max="5000" step="10" value="${s.reviewsPerDay}"></div>
          <div class="ais-field"><label for="cs-ret">Target retention</label>
            <select id="cs-ret">
              ${[0.8, 0.85, 0.9, 0.93, 0.95].map((r) => `<option value="${r}"${Math.abs(r - s.retention) < 0.001 ? ' selected' : ''}>${Math.round(r * 100)}%${r === 0.9 ? ' (default)' : ''}</option>`).join('')}
            </select>
            <div class="ais-hint">Higher remembers more, for more reviews.</div></div>
        </div>
        <div class="ais-switches">
          ${sw('cs-read', s.onlyReadLessons, 'Only cards from lessons I’ve read', 'A breakdown’s cards wait until you open their lesson.')}
          ${sw('cs-adv', s.advancedGrading, 'Advanced grading', 'Again, Hard, Good and Easy instead of Forgot and Remembered.')}
          ${sw('cs-type', s.typeCloze, 'Type the answer on cloze cards', 'Type the hidden text before it is revealed.')}
        </div>
        <div class="ais-msg" id="cs-msg"></div>
      </div>
    </section>`;
}

function wireCards(root) {
  const val = (id) => root.querySelector('#' + id);
  const save = () => {
    const r = saveCardSettings({
      newPerDay: Number(val('cs-new').value), reviewsPerDay: Number(val('cs-rev').value),
      retention: Number(val('cs-ret').value), onlyReadLessons: val('cs-read').checked,
      advancedGrading: val('cs-adv').checked, typeCloze: val('cs-type').checked,
    });
    const m = val('cs-msg');
    m.textContent = r.ok ? 'Saved.' : 'Not saved — the browser did not keep it.';
    m.className = 'ais-msg ' + (r.ok ? 'ok' : 'err');
  };
  ['cs-new', 'cs-rev', 'cs-ret', 'cs-read', 'cs-adv', 'cs-type'].forEach((id) => {
    const el = val(id);
    if (el) el.addEventListener('change', save);
  });
}

/** Forget unsaved edits, so the next visit shows what is actually stored. */
export function reset() { draft = null; _autoDetected = false; }

export default { render, reset };
