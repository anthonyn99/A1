/* ============================================================================
 * StudyOS — one-time card cleanup  (overhaul §8, 2026-10)
 * ============================================================================
 * Before the overhaul, a breakdown asked for "one card for every fact" and
 * every card went straight into reviews: 2,077 cards, 1,976 never seen, a
 * copyright slide with 34 cards of its own. This brings the existing deck in
 * line with what a breakdown now produces:
 *
 *   - cards she has REVIEWED are never touched — not their status, not a byte
 *     of their schedule;
 *   - unseen breakdown cards from a garbage breakdown (the economics lesson
 *     written for a computer-architecture chapter), from boilerplate topics
 *     (objectives, copyright…), meta cards ("What is the heading on page 3?")
 *     and near-duplicates across the class are deleted (as tombstones, so no
 *     device brings them back);
 *   - per topic, the best cards within the topic's budget stay active and the
 *     rest become SUGGESTIONS — nothing she might want is thrown away;
 *   - stored lessons lose their [n] citation markers and meta sentences.
 *
 * Cards from her own notes are left alone: they were never the noise.
 *
 * planMigration() is pure, and apply writes EXACTLY its plan — what the
 * dry-run modal shows is what happens. A class is marked v2 in its synced
 * meta, so the cleanup never runs twice on it, from any device.
 * ------------------------------------------------------------------------- */

import * as bd from './breakdown.js';
import * as deck from './deck.js';
import * as cards from './cards.js';
import { store } from './store.js';

export const VERSION = 2;

/* The breakdown the audit found saved from a repair ask's filler:
 * Chapter1-Introduction.pdf, economics topics for computer architecture. */
const GARBAGE_FILES = new Set(['sf_1788105252897_ymyw9h']);
const BOILER_TOPIC = /objectives|copyright|acknowledg|agenda|outline|learning goals|references|thank you/i;

// ── Near-duplicates, with each card's token sets computed once ────────────
const plainFront = (q) => String(q || '').replace(/\{\{(?:\d+::)?([\s\S]+?)(?:::[\s\S]*?)?\}\}/g, '$1');
function sig(c) {
  return { f: bd.tokensOf(plainFront(c.q)).words, all: bd.tokensOf(`${plainFront(c.q)} ${c.a || ''}`).words };
}
const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  let n = 0;
  a.forEach((w) => { if (b.has(w)) n++; });
  return n / (a.size + b.size - n);
};
const dup = (x, y) => jaccard(x.f, y.f) >= 0.7 || jaccard(x.all, y.all) >= 0.75;

function score(c) {
  let s = 0;
  if (/\b(is|are|means|refers to|defined as|=|equals)\b|`/.test(c.a || '') || cards.isClozeCard(c)) s += 1;
  if (/^(why|how)\b/i.test(c.q || '')) s += 1;
  s -= (String(c.q || '').length + String(c.a || '').length) / 400;
  return s;
}

/** Is this whole breakdown filler? */
function garbageDoc(doc) {
  if (!doc) return false;
  if (GARBAGE_FILES.has(doc.fileId)) return true;
  return (doc.topics || []).some((t) => t.lesson && /filler/.test(bd.sanityProblem(t.lesson.blocks)));
}

/**
 * The plan for some classes. Pure.
 * @param {{ classes: {id,name}[], cardsByClass: Object<string, card[]>, docs: object[], now?: number }} input
 * @returns {{ perClass: Object, lists: Object<string, card[]>, docOps: object[], changed: boolean }}
 */
export function planMigration({ classes, cardsByClass, docs = [], now = Date.now() }) {
  const docByFile = new Map(docs.filter(Boolean).map((d) => [d.fileId, d]));
  const perClass = {}, lists = {};
  let changed = false;

  for (const cls of classes) {
    const raw = cardsByClass[cls.id] || [];
    const out = raw.slice();
    const idx = new Map(raw.map((c, i) => [c.id, i]));
    const stat = { name: cls.name || cls.id, before: 0, active: 0, suggested: 0, deleted: 0, reviewedKept: 0,
      reasons: { garbage: 0, boilerplate: 0, meta: 0, dup: 0 } };
    const kill = (c, why) => { out[idx.get(c.id)] = deck.tombstone(c, now); stat.deleted++; stat.reasons[why]++; };
    const setStatus = (c, status) => {
      if (deck.statusOf(c) === status) return;
      out[idx.get(c.id)] = { ...c, status, updatedAt: now };
    };

    const live = raw.filter(deck.isLive);
    stat.before = live.length;
    // Cards she has reviewed are the anchors: a candidate that duplicates
    // one of them goes, never the reviewed one.
    const seenSigs = live.filter(deck.isReviewed).map(sig);
    stat.reviewedKept = seenSigs.length;

    // Unseen breakdown cards, grouped by topic, in document order.
    const byTopic = new Map();
    for (const c of live) {
      if (deck.isReviewed(c)) continue;
      const m = /^topic_(.+)_(t[0-9a-z]+)$/.exec(String(c.sourceNoteId || ''));
      if (!m) continue;                                 // her own notes' cards: untouched
      if (!byTopic.has(c.sourceNoteId)) byTopic.set(c.sourceNoteId, { fileId: m[1], topicId: m[2], list: [] });
      byTopic.get(c.sourceNoteId).list.push(c);
    }

    const keptSigs = [];
    for (const [noteId, g] of byTopic) {
      const doc = docByFile.get(g.fileId);
      const topic = doc && (doc.topics || []).find((t) => t.id === g.topicId);
      if (garbageDoc(doc)) { g.list.forEach((c) => kill(c, 'garbage')); continue; }
      if (topic && topic.lesson && /filler/.test(bd.sanityProblem(topic.lesson.blocks))) { g.list.forEach((c) => kill(c, 'garbage')); continue; }
      const title = (topic && topic.title) || (g.list[0] && g.list[0].topic) || '';
      if (BOILER_TOPIC.test(title)) { g.list.forEach((c) => kill(c, 'boilerplate')); continue; }

      const survivors = [];
      for (const c of g.list) {
        if (bd.isMetaCard(c.q)) { kill(c, 'meta'); continue; }
        const s = sig(c);
        if (seenSigs.some((x) => dup(x, s)) || keptSigs.some((x) => dup(x, s))) { kill(c, 'dup'); continue; }
        keptSigs.push(s);
        survivors.push(c);
      }

      // The topic's budget, less the reviewed cards it already has in reviews.
      const budget = topic ? bd.cardBudget(topic) : { max: 8 };
      const reviewedHere = live.filter((c) => c.sourceNoteId === noteId && deck.isReviewed(c) && deck.statusOf(c) === 'active').length;
      const slots = Math.max(0, budget.max - reviewedHere);
      const ranked = survivors.map((c, i) => ({ c, i, p: c.priority === 1 ? 1 : 2, s: score(c) }))
        .sort((a, b) => a.p - b.p || b.s - a.s || a.i - b.i);
      ranked.forEach((x, k) => setStatus(x.c, k < slots ? 'active' : 'suggested'));
    }

    for (let i = 0; i < out.length; i++) if (out[i] !== raw[i]) { changed = true; break; }
    for (const c of out.filter(deck.isLive)) {
      const st = deck.statusOf(c);
      if (st === 'active') stat.active++;
      else if (st === 'suggested') stat.suggested++;
    }
    perClass[cls.id] = stat;
    lists[cls.id] = out;
  }

  // Breakdown docs: the garbage ones go; the rest get their lessons cleaned.
  const classIds = new Set(classes.map((c) => c.id));
  const docOps = [];
  for (const doc of docByFile.values()) {
    if (!classIds.has(doc.classId) || doc.status === 'removed') continue;
    if (garbageDoc(doc)) { docOps.push({ fileId: doc.fileId, action: 'remove', name: doc.sourceName || doc.fileId }); continue; }
    const topics = {};
    let stripped = 0;
    for (const t of doc.topics || []) {
      if (!t.lesson || !Array.isArray(t.lesson.blocks)) continue;
      const r = bd.cleanLesson(t.lesson.blocks);
      if (JSON.stringify(r.blocks) !== JSON.stringify(t.lesson.blocks)) { topics[t.id] = r.blocks; stripped += r.stripped; }
    }
    // Counts on the topic rows follow the new statuses.
    const list = lists[doc.classId] || [];
    const counts = {};
    for (const t of doc.topics || []) {
      const mine = list.filter((c) => deck.isLive(c) && c.sourceNoteId === bd.noteIdFor(doc.fileId, t.id));
      const cardCount = mine.filter((c) => deck.statusOf(c) === 'active').length;
      const suggested = mine.filter((c) => deck.statusOf(c) === 'suggested').length;
      if (cardCount !== (t.cardCount || 0) || suggested !== (t.suggested || 0)) counts[t.id] = { cardCount, suggested };
    }
    if (Object.keys(topics).length || Object.keys(counts).length) {
      docOps.push({ fileId: doc.fileId, action: 'clean', name: doc.sourceName || doc.fileId, topics, counts, stripped });
    }
  }
  if (docOps.length) changed = true;
  return { perClass, lists, docOps, changed };
}

/** Write a plan. Exactly the plan: the modal showed this. */
export async function applyMigration(plan, classIds) {
  for (const id of classIds) {
    if (plan.lists[id]) deck.replaceClass(id, plan.lists[id]);
    deck.setMeta(id, { v: VERSION });
  }
  for (const op of plan.docOps) {
    if (op.action === 'remove') { await bd.remove(op.fileId); continue; }
    const doc = await bd.load(op.fileId);
    if (!doc) continue;
    for (const t of doc.topics || []) {
      if (op.topics[t.id]) { t.lesson = { ...t.lesson, blocks: op.topics[t.id] }; t.updatedAt = Date.now(); }
      if (op.counts[t.id]) { Object.assign(t, op.counts[t.id]); t.updatedAt = Date.now(); }
    }
    bd.saveDoc(doc);
  }
}

// ── The runner: once per class, with a dry run she approves ───────────────
const SKIP_KEY = 'studyos_cards_v2_skip';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Every breakdown doc of these classes (loads them, local or remote). */
async function docsOf(classes) {
  const out = [];
  for (const cls of classes) {
    for (const mod of cls.modules || []) {
      for (const f of mod.files || []) {
        if (!f || !f.id || !f.study) continue;
        try { const d = await bd.load(f.id); if (d) out.push(d); } catch (e) {}
      }
    }
  }
  return out;
}

export async function maybeRun({ sheet } = {}) {
  try { if (sessionStorage.getItem(SKIP_KEY)) return null; } catch (e) {}
  const pending = (store.getClasses() || []).filter((c) => c && c.id && deck.metaOf(c.id).v < VERSION);
  if (!pending.length) return null;
  const docs = await docsOf(pending);
  const cardsByClass = Object.fromEntries(pending.map((c) => [c.id, deck.rawForClass(c.id)]));
  const plan = planMigration({ classes: pending, cardsByClass, docs });
  const ids = pending.map((c) => c.id);
  if (!plan.changed) {
    // Nothing to clean: just remember it, so a later breakdown's
    // suggestions are never re-ranked by this.
    ids.forEach((id) => deck.setMeta(id, { v: VERSION }));
    return { plan, applied: true, silent: true };
  }
  if (!sheet) return { plan, applied: false };
  return new Promise((resolve) => {
    const rows = ids.map((id) => plan.perClass[id]).filter((s) => s && (s.deleted || s.before !== s.active));
    const removed = plan.docOps.filter((o) => o.action === 'remove');
    const cleaned = plan.docOps.filter((o) => o.action === 'clean' && Object.keys(o.topics).length);
    const s = sheet('Tidy up your flashcards', `
      <div style="font-size:13.5px;color:var(--text2);line-height:1.6">
        Breakdowns used to add a card for every line of a document. They now add only the cards worth
        remembering. This brings your existing cards in line. <b>Cards you have already reviewed are not touched.</b>
      </div>
      <table style="width:100%;border-collapse:collapse;margin:14px 0;font-size:12.5px;font-family:var(--mono)">
        <tr style="color:var(--text3);text-align:left"><th style="padding:4px 6px">Class</th><th>Now</th><th>In reviews</th><th>Suggested</th><th>Deleted</th></tr>
        ${rows.map((r) => `<tr style="border-top:1px solid var(--border)"><td style="padding:6px">${esc(r.name)}</td>
          <td>${r.before}</td><td>${r.active}</td><td>${r.suggested}</td><td>${r.deleted}</td></tr>`).join('')}
      </table>
      <div style="font-size:12px;color:var(--text3);line-height:1.6">
        Deleted: cards about pages, slides or copyright, cards from objectives or copyright topics, and
        near-duplicates. Suggested cards stay out of reviews until you add them.
        ${removed.length ? `<br>Removed breakdown${removed.length === 1 ? '' : 's'} with invented content (break ${removed.length === 1 ? 'it' : 'them'} down again for a fresh one): ${removed.map((o) => esc(o.name)).join(', ')}.` : ''}
        ${cleaned.length ? `<br>${cleaned.length} breakdown${cleaned.length === 1 ? '' : 's'} lose${cleaned.length === 1 ? 's' : ''} citation markers like [1] and sentences about "the supplied page".` : ''}
      </div>`, { wide: true });
    s.footer.innerHTML = '<button class="btn btn-ghost" data-later>Not now</button><button class="btn btn-primary" data-apply>Tidy up</button>';
    s.footer.querySelector('[data-later]').onclick = () => {
      try { sessionStorage.setItem(SKIP_KEY, '1'); } catch (e) {}
      s.close(); resolve({ plan, applied: false });
    };
    s.footer.querySelector('[data-apply]').onclick = async (e) => {
      e.currentTarget.disabled = true;
      await applyMigration(plan, ids);
      s.close();
      try { window.showNotif && window.showNotif('✅', 'Flashcards tidied', `${rows.reduce((n, r) => n + r.active, 0)} cards in reviews, the rest kept as suggestions.`); } catch (err) {}
      resolve({ plan, applied: true });
    };
  });
}

export default { VERSION, planMigration, applyMigration, maybeRun };
