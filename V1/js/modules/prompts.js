/* ============================================================================
 * StudyOS — prompt library  (upgrade spec P-6)
 * ============================================================================
 * One library of prompts instead of a copy per class. Today the same prompt is
 * duplicated as PROMPTS in Art, PROMPTS in Intro to Database Systems and
 * GEMINI NOTEBOOK PROMPTS in Comp Org, so improving it means editing it three
 * times and remembering which classes were missed.
 *
 * ── NOTHING IS MIGRATED AWAY ──────────────────────────────────────────────
 * The per-module `prompts` arrays stay exactly where they are and keep
 * working. This library READS them (see `all()`) so every existing prompt is
 * runnable from day one without a migration that could lose her best-tuned
 * text. A library prompt is simply one that also lives in the global list.
 *
 * That matters because the spec is explicit that her existing prompt is
 * already well-engineered and must be used verbatim as the seed. The safest
 * way to honour that is to never rewrite or relocate it.
 *
 * ── VERSIONING ────────────────────────────────────────────────────────────
 * Editing a prompt appends to `versions` rather than overwriting. Generated
 * notes record the version that made them (see pipeline.js -> addGeneratedNote),
 * which is what makes "why is this one worse than last week's" answerable.
 * ------------------------------------------------------------------------- */

import { store } from './store.js';

const LS_KEY = 'studyos_prompts_v1';

function loadLib() {
  // Defensive parse: this is read at boot, and a corrupt value must not take
  // the app down the way the unguarded JSON.parse calls in studyos.js would.
  try {
    const raw = localStorage.getItem(LS_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return Array.isArray(v) ? v : [];
  } catch (e) {
    console.warn('[prompts] library unreadable, starting empty:', e);
    return [];
  }
}

function saveLib(list) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(list)); }
  catch (e) { console.warn('[prompts] save failed:', e); }
  try { window.dispatchEvent(new CustomEvent('sos-changed', { detail: { entity: 'prompts' } })); }
  catch (e) {}
  return list;
}

/** Every library prompt. */
export function library() { return loadLib(); }

/**
 * Every runnable prompt: the global library PLUS the ones still living in
 * class modules, tagged with where they came from so the UI can group them.
 *
 * De-duplicated by text, because the same prompt genuinely is pasted into
 * several classes today and showing it three times in the Run sheet would
 * make the list useless.
 */
export function all() {
  const out = [];
  const seen = new Set();

  for (const p of loadLib()) {
    const key = (p.text || '').trim();
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push({ ...p, source: 'library' });
  }

  for (const cls of store.getClasses()) {
    for (const mod of (cls.modules || [])) {
      if (mod.type !== 'prompts') continue;
      for (const p of (mod.prompts || [])) {
        const key = (p.text || '').trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push({
          id: p.id,
          name: p.name || firstLine(p.text),
          text: p.text,
          version: 1,
          classIds: [cls.id],
          source: 'class',
          _from: { classId: cls.id, className: cls.name, moduleId: mod.id },
        });
      }
    }
  }
  return out;
}

/** Prompts worth offering for a class: its own first, then unpinned globals. */
export function forClass(classId) {
  const list = all();
  const mine = list.filter(p => (p.classIds || []).includes(classId));
  const global = list.filter(p => !(p.classIds || []).length);
  return [...mine, ...global];
}

function firstLine(text) {
  const l = String(text || '').trim().split('\n')[0] || 'Untitled prompt';
  return l.length > 60 ? l.slice(0, 57) + '…' : l;
}

/** Add a prompt to the library. */
export function add({ name, text, classIds }) {
  if (!text || !String(text).trim()) throw new Error('prompt text required');
  const list = loadLib();
  const p = {
    id: 'pr_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    name: String(name || firstLine(text)),
    text: String(text),
    version: 1,
    classIds: Array.isArray(classIds) ? classIds.slice() : [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    versions: [],
  };
  list.push(p);
  saveLib(list);
  return p;
}

/**
 * Edit a prompt. The previous text is pushed onto `versions` and `version` is
 * bumped, so a note generated last week still names the text that made it.
 */
export function update(id, { name, text, classIds }) {
  const list = loadLib();
  const i = list.findIndex(p => p.id === id);
  if (i < 0) return null;
  const prev = list[i];

  const textChanged = text != null && String(text) !== prev.text;
  const next = {
    ...prev,
    name: name != null ? String(name) : prev.name,
    text: text != null ? String(text) : prev.text,
    classIds: classIds != null ? classIds.slice() : prev.classIds,
    updatedAt: Date.now(),
  };
  if (textChanged) {
    next.version = (prev.version || 1) + 1;
    next.versions = [...(prev.versions || []), { version: prev.version || 1, text: prev.text, at: prev.updatedAt || prev.createdAt }];
  }
  list[i] = next;
  saveLib(list);
  return next;
}

export function remove(id) {
  const list = loadLib();
  const next = list.filter(p => p.id !== id);
  if (next.length === list.length) return false;
  saveLib(next);
  return true;
}

/** One prompt by id, from the library or from a class module. */
export function get(id) {
  return all().find(p => p.id === id) || null;
}

/**
 * Interpolate {{variables}} against a class and an optional event.
 *
 * An UNKNOWN variable is left verbatim rather than replaced with an empty
 * string. A prompt that silently reads "the exam on  covering " is worse than
 * one that visibly still says {{exam_date}} — the first looks like a model
 * failure, the second like the missing data it actually is.
 */
export function interpolate(text, { cls, topic, event } = {}) {
  const vars = {
    class: (cls && cls.name) || '',
    course_code: (cls && cls.code) || '',
    instructor: (cls && cls.instructor) || '',
    topic: topic || '',
    exam_date: (event && event.date) || '',
  };
  return String(text || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (whole, key) => {
    const v = vars[String(key).toLowerCase()];
    return (v === undefined || v === '') ? whole : v;
  });
}

/** Which {{variables}} a prompt uses, for the Run sheet to show before running. */
export function variablesIn(text) {
  const out = new Set();
  const re = /\{\{\s*([a-z_]+)\s*\}\}/gi;
  let m;
  while ((m = re.exec(String(text || '')))) out.add(m[1].toLowerCase());
  return [...out];
}

/**
 * Per-module default prompt (P-4). Stored on the module itself so it syncs
 * with everything else rather than becoming a second thing to keep in step.
 */
export function getDefaultFor(classId, moduleId) {
  const cls = store.getClass(classId);
  const mod = cls && (cls.modules || []).find(m => m.id === moduleId);
  return (mod && mod.defaultPromptId) || null;
}

export default {
  library, all, forClass, add, update, remove, get,
  interpolate, variablesIn, getDefaultFor,
};
