/* ============================================================================
 * StudyOS — card extraction  (upgrade spec R-1)
 * ============================================================================
 * Turns notes into flashcards. Deterministic and offline: no model call, so it
 * works on every note she already has, costs nothing, and gives the same answer
 * twice.
 *
 * ── TWO NOTE SYSTEMS, NOT ONE ─────────────────────────────────────────────
 * StudyOS stores notes in two places with different formats, and a generator
 * that handles only one strands half her material:
 *
 *   1. MODULE NOTES — cls.modules[].notes[] = {id, title, body, updated}.
 *      `body` is PLAIN TEXT straight from a <textarea> (studyos.js:3079).
 *      No markup at all. Structure has to be inferred from conventions the
 *      writer happened to use, so every regex here is best-effort by nature.
 *
 *   2. PAGE-EDITOR ENTRIES — localStorage['studyos_notes_' + moduleId],
 *      {…, data:{html}}, where `html` is real contentEditable HTML
 *      (notes-sync.js:338). Here <h2>/<strong>/<li> are RELIABLE structural
 *      signals, so extraction is much better. Pipeline output lands here too.
 *
 * ── A BAD CARD IS WORSE THAN NO CARD ──────────────────────────────────────
 * Every candidate passes a quality gate before it is kept. A card whose answer
 * is one word, or whose question is a whole paragraph, teaches nothing and
 * costs a review — and enough of them make the whole deck feel like noise, at
 * which point she stops using it. Rejecting aggressively is the point.
 *
 * ── RE-EXTRACTION MUST NOT DUPLICATE ──────────────────────────────────────
 * Notes get edited; extraction gets re-run. Each card carries a `fp`
 * fingerprint derived from its content, so merging a fresh extraction against
 * existing cards keeps scheduling state for unchanged cards, adds genuinely new
 * ones, and never stacks near-identical copies. See mergeCards().
 * ------------------------------------------------------------------------- */

/** Card kinds. */
export const KIND = { CLOZE: 'cloze', QA: 'qa', LIST: 'list' };

// ── Quality gate ────────────────────────────────────────────────────────────
const MIN_Q = 8;        // "What is X?" is about the shortest legitimate question
const MAX_Q = 220;      // longer than this is a paragraph, not a prompt
const MIN_A = 2;
const MAX_A = 600;

/** Noise a heading-derived question should never be built from. */
const STOP_HEADINGS = /^(overview|introduction|intro|agenda|outline|summary|conclusion|references|contents|objectives|questions|thank you|q\s*&\s*a)$/i;

function acceptable(q, a) {
  if (!q || !a) return false;
  const qs = q.trim(), as = a.trim();
  if (qs.length < MIN_Q || qs.length > MAX_Q) return false;
  if (as.length < MIN_A || as.length > MAX_A) return false;
  // An answer that merely repeats the question tests nothing.
  if (as.toLowerCase() === qs.toLowerCase()) return false;
  // A "definition" that is one bare word is almost always a parsing artifact.
  if (as.split(/\s+/).length < 2 && as.length < 4) return false;
  return true;
}

// ── Fingerprint ─────────────────────────────────────────────────────────────
/**
 * Stable id for a card's CONTENT. Two extractions of the same material produce
 * the same fp, so merging can tell "already have this" from "this is new"
 * without depending on array order or generated ids.
 *
 * FNV-1a: tiny, dependency-free, and collisions do not matter here — a clash
 * would merely merge two cards, not corrupt anything.
 */
export function fingerprint(kind, question, answer) {
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const str = `${kind}|${norm(question)}|${norm(answer)}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

function mkCard(kind, question, answer, src, extra = {}) {
  return {
    id: 'cd_' + fingerprint(kind, question, answer),
    fp: fingerprint(kind, question, answer),
    kind,
    q: question.trim(),
    a: answer.trim(),
    classId: src.classId || '',
    moduleId: src.moduleId || '',
    sourceNoteId: src.noteId || '',
    sourceTitle: src.title || '',
    topic: extra.topic || src.title || '',
    // Tapping a card jumps back to the slide it came from (R-1).
    sourceSlide: extra.slide ?? null,
    createdAt: Date.now(),
    sched: null,            // filled by fsrs.newCard() on first schedule
  };
}

// ── Shared helpers ──────────────────────────────────────────────────────────
const tidy = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** "## Slide 7" / "### Slide 7:" -> 7, else null. Pipeline notes carry these. */
function slideOf(heading) {
  const m = /^#{0,6}\s*slide\s*[:#-]?\s*(\d+)/i.exec(String(heading || '').trim());
  return m ? parseInt(m[1], 10) : null;
}

/** A heading becomes a question. "Normalization" -> "What is Normalization?" */
function headingQuestion(heading) {
  const h = tidy(heading).replace(/[:.]+$/, '');
  if (!h || STOP_HEADINGS.test(h)) return null;
  if (slideOf(h) !== null) return null;              // "Slide 7" is not a topic
  if (/\?$/.test(h)) return h;                       // already a question
  if (/^(what|why|how|when|where|who|which)\b/i.test(h)) return h + '?';
  return `What is ${h}?`;
}

/**
 * Build a cloze from a sentence containing an emphasised term.
 * "**3NF** eliminates transitive dependencies" ->
 *   Q: "[...] eliminates transitive dependencies"  A: "3NF"
 */
function clozeFrom(sentence, term) {
  const s = tidy(sentence);
  const t = tidy(term);
  if (!s || !t || t.length < 2) return null;
  // Only cloze a term that is a real part of the sentence, not the whole thing.
  if (t.length >= s.length * 0.7) return null;
  const idx = s.toLowerCase().indexOf(t.toLowerCase());
  if (idx < 0) return null;
  const blanked = (s.slice(0, idx) + '[...]' + s.slice(idx + t.length)).replace(/\s+/g, ' ').trim();
  return { q: blanked, a: t };
}

/** Split prose into sentences. Deliberately simple; over-splitting is harmless. */
function sentences(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+(?=[A-Z(])/)
    .map(tidy)
    .filter(Boolean);
}

// ── Plain-text extraction (module notes) ───────────────────────────────────
/**
 * Conventions recognised, and where each fails:
 *
 *   "# Heading" / "## Heading"   → Q/A with the text beneath.
 *        Fails when she writes headings without hashes — indistinguishable
 *        from a short paragraph, so those are simply not found.
 *   "Term: definition"           → Q/A.
 *        Fails on a sentence that merely contains a colon ("Note: see p.3"),
 *        which the quality gate mostly filters by length.
 *   "Term — definition"          → Q/A (em dash or " - ").
 *   "**bold**" inside a sentence → cloze.
 *   "- bullet" runs under a heading → one enumeration card.
 */
export function fromPlainText(text, src = {}) {
  const out = [];
  const lines = String(text || '').split('\n');

  let heading = null, slide = null, buf = [], bullets = [];

  const flush = () => {
    const body = tidy(buf.join(' '));
    const topic = heading ? tidy(heading).replace(/^#+\s*/, '') : (src.title || '');

    if (heading) {
      const q = headingQuestion(heading.replace(/^#+\s*/, ''));
      if (q && body && acceptable(q, body)) {
        out.push(mkCard(KIND.QA, q, body, src, { topic, slide }));
      }
    }

    // Bullets under a heading are an enumeration worth recalling as a set.
    if (bullets.length >= 2 && heading) {
      const q = `List: ${tidy(heading).replace(/^#+\s*/, '').replace(/[:.]+$/, '')}`;
      const a = bullets.map((b) => '• ' + b).join('\n');
      if (acceptable(q, a)) out.push(mkCard(KIND.LIST, q, a, src, { topic, slide }));
    }

    // Definitions and clozes from the prose.
    for (const s of sentences(body)) {
      const def = /^(.{2,60}?)\s*(?::|—|–|\s-\s)\s*(.{4,})$/.exec(s);
      if (def) {
        const q = headingQuestion(def[1]);
        if (q && acceptable(q, def[2])) {
          out.push(mkCard(KIND.QA, q, def[2], src, { topic, slide }));
          continue;
        }
      }
      const bold = /\*\*(.+?)\*\*/.exec(s);
      if (bold) {
        const c = clozeFrom(s.replace(/\*\*/g, ''), bold[1]);
        if (c && acceptable(c.q, c.a)) {
          out.push(mkCard(KIND.CLOZE, c.q, c.a, src, { topic, slide }));
        }
      }
    }
    buf = []; bullets = [];
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      heading = h[2];
      slide = slideOf(h[2]);
      continue;
    }
    const b = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (b) { bullets.push(tidy(b[1])); continue; }
    if (line.trim()) buf.push(line.trim());
  }
  flush();
  return out;
}

// ── HTML extraction (page-editor entries, pipeline output) ─────────────────
/**
 * Far more reliable than the plain-text path: <h2>, <strong> and <li> are
 * unambiguous structure rather than inferred convention.
 *
 * Parsed with DOMParser so malformed HTML cannot break the caller, and so no
 * script in stored content ever executes — a parsed document is inert.
 */
export function fromHtml(html, src = {}) {
  if (typeof DOMParser === 'undefined') return [];
  let doc;
  try {
    doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  } catch (e) { return []; }

  const out = [];
  const blocks = [];
  let cur = { heading: null, slide: null, nodes: [] };
  // Carried across blocks: a "## Slide 9" heading labels everything under it,
  // including the NEXT topic heading if the deck nests them that way.
  let lastSlide = null;

  // Non-content elements survive parsing as real children — a <script>'s text
  // would otherwise be folded into the block body and end up inside a card.
  const NOISE = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|IFRAME|SVG|BUTTON)$/;

  for (const el of Array.from(doc.body.children)) {
    if (NOISE.test(el.tagName)) continue;
    if (/^H[1-6]$/.test(el.tagName)) {
      const n = slideOf(el.textContent);
      if (n !== null) {
        // A slide heading is a POSITION MARKER, not a topic. It labels what
        // follows rather than starting a question of its own — dropping the
        // block entirely (the first cut) threw away the slide's content AND
        // the number needed to jump back to it.
        lastSlide = n;
        cur.slide = cur.slide ?? n;
        continue;
      }
      if (cur.heading || cur.nodes.length) blocks.push(cur);
      cur = { heading: el.textContent, slide: lastSlide, nodes: [] };
    } else {
      cur.nodes.push(el);
    }
  }
  if (cur.heading || cur.nodes.length) blocks.push(cur);

  for (const b of blocks) {
    const topic = b.heading ? tidy(b.heading) : (src.title || '');
    const proseEls = b.nodes.filter((n) => !/^(UL|OL)$/.test(n.tagName));
    const body = tidy(proseEls.map((n) => n.textContent).join(' '));

    if (b.heading) {
      const q = headingQuestion(b.heading);
      if (q && body && acceptable(q, body)) {
        out.push(mkCard(KIND.QA, q, body, src, { topic, slide: b.slide }));
      }
    }

    // Prose under a bare slide marker still has clozes worth extracting, and
    // it carries the slide number — which is what makes "jump to source" work
    // on pipeline-generated notes, where "## Slide N" IS the only heading.

    for (const list of b.nodes.filter((n) => /^(UL|OL)$/.test(n.tagName))) {
      const items = Array.from(list.querySelectorAll(':scope > li')).map((li) => tidy(li.textContent));
      if (items.length >= 2 && b.heading) {
        const q = `List: ${tidy(b.heading).replace(/[:.]+$/, '')}`;
        const a = items.map((i) => '• ' + i).join('\n');
        if (acceptable(q, a)) out.push(mkCard(KIND.LIST, q, a, src, { topic, slide: b.slide }));
      }
    }

    // <strong>/<b>/<mark> inside a sentence is an explicit "this matters".
    for (const el of proseEls) {
      for (const em of Array.from(el.querySelectorAll('strong,b,mark'))) {
        const term = tidy(em.textContent);
        const host = tidy(el.textContent);
        const c = clozeFrom(host, term);
        if (c && acceptable(c.q, c.a)) {
          out.push(mkCard(KIND.CLOZE, c.q, c.a, src, { topic, slide: b.slide }));
        }
      }
    }
  }
  return out;
}

/** "Make cards from this" on a selection (R-1). Sniffs which parser to use. */
export function fromSelection(fragment, src = {}) {
  const s = String(fragment || '');
  return /<[a-z][\s\S]*>/i.test(s) ? fromHtml(s, src) : fromPlainText(s, src);
}

/** De-duplicate within one extraction, keeping first occurrence. */
export function dedupe(cards) {
  const seen = new Set();
  return (cards || []).filter((c) => {
    if (seen.has(c.fp)) return false;
    seen.add(c.fp);
    return true;
  });
}

/**
 * Merge a fresh extraction into the cards already held for a note.
 *
 * The whole point is that re-extracting an EDITED note is safe:
 *   - a card whose content is unchanged keeps its scheduling state
 *   - genuinely new content is added as new cards
 *   - cards whose source text is gone are reported, never silently deleted —
 *     she may have reviewed them for weeks, and throwing that away without
 *     asking would be the worst possible behaviour here.
 *
 * @returns { merged, added, kept, orphaned }
 */
export function mergeCards(existing, fresh) {
  const byFp = new Map((existing || []).map((c) => [c.fp, c]));
  const freshFps = new Set((fresh || []).map((c) => c.fp));

  const kept = [], added = [];
  for (const f of dedupe(fresh || [])) {
    const prior = byFp.get(f.fp);
    if (prior) kept.push(prior);                    // keeps `sched`
    else added.push(f);
  }
  const orphaned = (existing || []).filter((c) => !freshFps.has(c.fp));

  return { merged: [...kept, ...added, ...orphaned], added, kept, orphaned };
}

export default {
  KIND, fromPlainText, fromHtml, fromSelection,
  dedupe, mergeCards, fingerprint,
};
