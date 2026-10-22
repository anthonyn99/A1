// What Make with AI asks a unit for, and how its reply is read.
//
// Every kind is asked for MAGI Studio's kind of labelled plain text (PART: /
// A: / B:, SCENE n / LAYOUT: / NARRATION:, LESSON n / TITLE: / BODY:), not
// JSON (Tony, 2026-10-22: Perplexity and Gemini could not make a video or
// lessons). A web chat shows JSON in a code block, and what Orca reads back
// from a long code block came back cut or garbled ('{ "lessons { "lessons');
// labelled text reads back whole, and these parsers still read it when a
// unit bolds its labels, loses its newlines, adds citations ([1]) or chatter.
// A reply that is JSON anyway is still read (the older format).
//
// Long replies: every format ends with a line "END". A reply that stops before
// it (a web unit's own output limit) is continued by the same unit
// (continuePrompt) and joined, so no unit has to fit a whole episode in one
// answer. A lesson the script misses is written on its own (missingPrompt)
// and put in its place, instead of asking for the whole script again.
//
// Lessons (Tony, 2026-10-22): every lesson the chapter teaches, whatever the
// length; the length says how much each one explains. A second look
// (completePrompt) asks the same unit for any it missed.
//
// No DOM here: tested in Node (Shruti/tests/generate.test.js).

/** Length: how long a podcast or video runs, how much a lesson explains.
 *  Podcasts aim at about 10 minutes and videos stop at 10 (Tony, 2026-10-22). */
export const LENGTHS = {
  concise: { label: 'Concise', podcastMin: 7, videoScenes: 12, videoWords: 600, lesson: { title: 12, body: 25, say: 'one sentence' } },
  standard: { label: 'Standard', podcastMin: 10, videoScenes: 18, videoWords: 950, lesson: { title: 14, body: 60, say: 'two or three sentences' } },
  deep: { label: 'Deep', podcastMin: 13, videoScenes: 24, videoWords: 1250, lesson: { title: 16, body: 120, say: 'four to six sentences, with the verse numbers it rests on and how to live it' } },
};
export const WORDS_PER_MINUTE = 150;
export const LAYOUTS = ['title', 'verse', 'story', 'lesson', 'compare', 'steps', 'closing'];
/** What a story scene can show, drawn and animated by video.js (Phase 6 of the
 *  2026-10-22 refinements): the unit names one to three per scene. */
export const ART = ['battlefield', 'chariot', 'conch', 'bow', 'warrior', 'krishna', 'arjuna', 'elders', 'king', 'seer', 'family',
  'lotus', 'sun', 'moon', 'stars', 'flame', 'lamp', 'river', 'ocean', 'mountain', 'tree', 'seed', 'wheel', 'path', 'scales',
  'heart', 'mind', 'meditation', 'light', 'storm', 'garden', 'scroll', 'temple', 'om', 'feather', 'garment', 'door', 'steps',
  'people', 'crown', 'sword', 'clock', 'key', 'bridge', 'city', 'home', 'globe', 'idea', 'book'];

const RULES = [
  'Write for the ear: natural spoken English, warm and clear, varied sentence lengths, contractions where they sound natural. No markdown, no headings, no lists, no emojis, no stage directions, no sound effects, no citations or reference numbers like [1].',
  'Write numbers as words where they are spoken ("chapter two", "verse forty-seven").',
  'Stay faithful to the source text. When you quote it, quote it exactly. When you add anything that is not in this text (background, the wider tradition, other translations), say so in the words themselves ("this part is not in our book").',
  'Do not search the web: everything you need is in the source below.',
];
const FORMAT_RULE = 'Reply in exactly this format, as plain text: no JSON, no code block, no markdown, nothing before or after it. Finish with a line that says only END.';

const what = (o) => (o.book === 'gita' ? 'the Bhagavad-Gita (the IGS rendition by Ramananda Prasad)' : 'the book "' + (o.bookTitle || o.book) + '"');
/** The chapter as the model reads it: headings, [verse] numbers, asides. */
export function sourceText(ch) {
  return (ch && ch.blocks || []).map((b) => {
    if (b.k === 'h') return '## ' + b.t;
    if (b.k === 'a') return '(' + b.t + ')';
    return (b.s || []).map((s) => (s.v ? '[' + s.v + '] ' : '') + s.t).join('\n');
  }).join('\n\n');
}
export const lessonsText = (L) => ((L && L.lessons) || []).map((l) => l.id + ': ' + (l.title || '') + (l.body ? ' — ' + l.body : '')).join('\n');

/* ── the asks ────────────────────────────────────────────────────────────── */
/** The messages for one kind. o: {kind, book, bookTitle, title, n, ch, lessons, length, hosts, narrator, extra}. */
export function buildPrompt(o) {
  const L = (o.lessons && o.lessons.lessons) || [], len = LENGTHS[o.length] || LENGTHS.standard;
  const head = (o.n ? 'This is chapter ' + o.n + ' ("' + o.title + '")' : 'This is "' + o.title + '"') + ' of ' + what(o) + '.';
  const teach = L.length
    ? 'Teach EVERY one of these ' + L.length + ' lessons, in order, each in its own part, tagged with its id: ' + L.map((l) => l.id).join(', ') + '. They are in <lessons> below.'
    : 'Teach every lesson this chapter holds, in order.';
  let task, format;
  if (o.kind === 'podcast') {
    const [a, b] = o.hosts, words = len.podcastMin * WORDS_PER_MINUTE;
    task = [
      'Write a two-host podcast episode about this chapter. Host A is ' + a.name + ', host B is ' + b.name + '. They are warm, curious and precise, they react to each other and build on each other\'s points, and they talk with each other, not at the listener.',
      'Start with a short welcome, then tell the chapter\'s story in order with its key passages quoted exactly, then the lessons, then a short wrap-up that points to what comes next.',
      teach + ' A lesson part is titled "Lesson N · a short title [L<number>]".',
      'Length: about ' + words + ' words in all (about ' + len.podcastMin + ' minutes spoken). Each line is one to four sentences.',
    ];
    format = 'PART: Welcome\nA: what ' + a.name + ' says\nB: what ' + b.name + ' says\n\nPART: The story\nA: …\nB: …\n\nPART: Lesson 1 · a short title [L1]\nB: …\nA: …\n\nPART: Wrap-up\nA: …\nB: …\n\nEND';
  } else if (o.kind === 'video') {
    task = [
      'Write a narrated video about this chapter as a list of scenes. One narrator speaks every scene while the picture shows animated artwork and short on-screen text.',
      'Layouts: "title" (the first scene: HEADLINE is the chapter title, VISUAL one subtitle line), "story" (what happens: HEADLINE plus two to four short VISUAL lines, and ART), "verse" (VERSE is a verse number from the [brackets] in the source, e.g. 2.47; NARRATION contains {verse} exactly where the verse is read, and the app fills in the book\'s own words), "lesson" (LESSON is its id; two or three short VISUAL lines), "compare" (VISUAL rows "left | right", the first row the two column titles), "steps" (three to six very short VISUAL steps), "closing" (the last scene: HEADLINE plus three short takeaways).',
      'ART (story, title and closing scenes): one to three things the artwork shows, chosen only from: ' + ART.join(', ') + '.',
      teach + ' A lesson\'s own scene has layout lesson, compare or steps, its LESSON id, and its NARRATION starts "Lesson N."',
      'Tell the chapter\'s story first, with its most important verses as verse scenes, then the lessons, then the closing. Add BEYOND: yes on a story scene that tells something not in this text.',
      'On-screen text is short: a HEADLINE up to eight words, each VISUAL line up to ten words. NARRATION is two to five spoken sentences. About ' + len.videoScenes + ' scenes and ' + len.videoWords + ' words of narration in all (the video stays under ten minutes).',
    ];
    format = 'SCENE 1\nLAYOUT: title\nHEADLINE: …\nVISUAL:\n- …\nART: battlefield, conch\nNARRATION: …\n\nSCENE 2\nLAYOUT: story\nHEADLINE: …\nVISUAL:\n- …\n- …\nART: chariot\nNARRATION: …\n\nSCENE 3\nLAYOUT: verse\nVERSE: 2.47\nNARRATION: … {verse} …\n\nSCENE 4\nLAYOUT: lesson\nLESSON: L1\nHEADLINE: …\nVISUAL:\n- …\nNARRATION: Lesson one. …\n\nSCENE 5\nLAYOUT: closing\nHEADLINE: …\nVISUAL:\n- …\n- …\n- …\nART: lotus\nNARRATION: …\n\nEND';
  } else {
    const d = len.lesson;
    task = [
      'List EVERY lesson this chapter teaches, in the order it teaches them: every distinct teaching, from the first section to the last. Do not merge two teachings into one and do not skip any, however small. How many there are depends only on the chapter.',
      'Each lesson has a TITLE (one plain sentence that states it, at most ' + d.title + ' words) and a BODY of ' + d.say + ', at most ' + d.body + ' words: what the chapter teaches there and how to live it.',
      'Be true and to the point: say only what this chapter says, no filler, no flourishes, and do not repeat the title in the body.',
      'Then a SUMMARY of the chapter in two or three sentences.',
    ];
    format = 'LESSON 1\nTITLE: …\nBODY: …\n\nLESSON 2\nTITLE: …\nBODY: …\n\nSUMMARY: …\n\nEND';
  }
  const sys = 'You write study media for Shruti, a reading app. ' + RULES.join(' ') + ' ' + FORMAT_RULE;
  const user = head + '\n\n' + task.join('\n') + (o.extra ? '\n\nThe reader also asks: ' + o.extra : '') +
    '\n\n' + FORMAT_RULE + '\n\n' + format +
    '\n\n<source>\n' + sourceText(o.ch) + '\n</source>' +
    (L.length && o.kind !== 'lessons' ? '\n\n<lessons>\n' + lessonsText(o.lessons) + '\n</lessons>' : '');
  return [{ role: 'system', content: sys }, { role: 'user', content: spill(user) }];
}

/** "Go on from where you stopped": the reply so far goes back as the unit's own. */
export function continuePrompt(messages, sofar) {
  const tail = String(sofar).trim().slice(-240);
  return messages.concat([{ role: 'assistant', content: sofar }, { role: 'user',
    content: 'Your reply stopped before the end. It ended with:\n"…' + tail + '"\nContinue exactly from there, in the same format, without repeating anything already written, and finish with the line END.' }]);
}
/** Write only the lessons a podcast or video missed. */
export function missingPrompt(kind, messages, sofar, missing, L) {
  const list = missing.map((id) => { const l = L.find((x) => x.id === id); return id + ' (' + (l && l.title || '') + ')'; }).join('; ');
  const fmt = kind === 'podcast' ? 'PART: Lesson N · a short title [L<number>]\nA: …\nB: …' : 'SCENE 1\nLAYOUT: lesson\nLESSON: L<number>\nHEADLINE: …\nVISUAL:\n- …\nNARRATION: Lesson N. …';
  return messages.concat([{ role: 'assistant', content: sofar }, { role: 'user',
    content: 'This script does not teach these lessons yet: ' + list + '. Write ONLY the missing ' + (kind === 'podcast' ? 'parts, one per lesson,' : 'scenes, one per lesson (numbered from 1),') + ' in the same format, and nothing else. Finish with the line END.\n\n' + fmt + '\n\nEND' }]);
}
/** A second look for lessons: any teaching the list missed, with where it goes. */
export function completePrompt(messages, sofar) {
  return messages.concat([{ role: 'assistant', content: sofar }, { role: 'user',
    content: 'Now read the chapter again from its first line to its last, section by section, and compare it with your list. If any teaching is missing, write ONLY the missing lessons in the same format, each with a line AFTER: <the number of the lesson it comes after> (0 for the very start). If nothing is missing, reply with only the word NONE. Finish with the line END.' }]);
}
/** Shorten the lessons that run long (their numbers), keeping the rest. */
export function shortenPrompt(messages, sofar, long, length) {
  const d = (LENGTHS[length] || LENGTHS.standard).lesson;
  return messages.concat([{ role: 'assistant', content: sofar }, { role: 'user',
    content: 'These lessons are too long: ' + long.join(', ') + '. A TITLE is at most ' + d.title + ' words and a BODY at most ' + d.body + ' words (' + d.say + '). Rewrite ONLY those lessons, with their own numbers, in the same format, and finish with the line END.' }]);
}

/* Long asks: the big blocks go as attached .txt files (StudyOS's spillText). */
export const SPILL_CHARS = 12000;
function b64utf8(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
export function spill(text) {
  if (text.length <= SPILL_CHARS) return text;
  const files = [];
  let out = text;
  for (const tag of ['source', 'lessons']) {
    const m = out.match(new RegExp('<' + tag + '>\\n?([\\s\\S]*?)\\n?</' + tag + '>'));
    if (!m || m[1].length < 2000) continue;
    files.push({ type: 'file', file: { filename: tag + '.txt', file_data: 'data:text/plain;base64,' + b64utf8(m[1]) } });
    out = out.replace(m[0], '<' + tag + '>\n(in the attached file ' + tag + '.txt; read ALL of it)\n</' + tag + '>');
  }
  if (out.length > SPILL_CHARS) {
    files.push({ type: 'file', file: { filename: 'request.txt', file_data: 'data:text/plain;base64,' + b64utf8(out) } });
    out = 'Your complete task is in the attached file request.txt. Read ALL of it, then do exactly what it says, including its reply format.';
  }
  return [{ type: 'text', text: out }, ...files];
}

/* ── reading a reply ─────────────────────────────────────────────────────── */
const LABELS = 'PART|SEGMENT|SCENE|LAYOUT|HEADLINE|VISUAL|ART|VERSE|REF|LESSON|BEYOND|NARRATION|SAY|TITLE|BODY|SUMMARY|AFTER';
/** A reply as plain lines: fences, bold, heading marks and citations gone;
 *  "**LAYOUT:**" and "**LAYOUT**:" read as "LAYOUT:". */
export function clean(raw) {
  return String(raw || '').replace(/\r/g, '')
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/(\*\*|__)\s*([A-Za-z][A-Za-z ]{0,16}?\s*\d{0,3})\s*(:?)\s*\1\s*(:?)/g, (m, _w, label, c1, c2) => label.trim() + (c1 || c2))
    .replace(/\*\*|__/g, '')
    .replace(/^[ \t]*#{1,6}[ \t]*/gm, '')
    .replace(/[ \t]*\[(?:\d{1,3}(?:\s*[,–-]\s*\d{1,3})*)\]/g, '')   // Perplexity's citations: [1], [2, 3]
    .replace(/^[ \t]*[>][ \t]?/gm, '');
}
/** Whether a reply reached its END (or, without one, its natural last part). */
export function finished(kind, raw) {
  const t = clean(raw).trim();
  if (/(?:^|\n)\s*END\s*\.?\s*$/i.test(t) || /(?<![A-Za-z])END\s*\.?$/.test(t)) return true;
  if (kind === 'lessons') return /(?:(?:^|\n)\s*summary|SUMMARY)\s*[:：]\s*\S[\s\S]*[.!?]["'’”)]*\s*$/i.test(t);
  return false;
}
const toWordsEnd = (t) => String(t || '').replace(/(?:^|\n)\s*END\s*\.?\s*$/i, '').replace(/(?<![A-Za-z])END\s*\.?$/, '').trim();
const str = (x, max) => { const s = String(x == null ? '' : x).replace(/\s+/g, ' ').trim(); return max && s.length > max ? s.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : s; };
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** "SCENE 3", "LESSON 2": in capitals anywhere (even glued on, as when a
 *  newline was lost), any other casing only at the start of a line, so prose
 *  that mentions "lesson 2" never splits a reply (MAGI's numberedBlocks rule). */
function markers(t, word) {
  const any = word.replace(/[A-Z]/g, (c) => '[' + c + c.toLowerCase() + ']');
  return [...t.matchAll(new RegExp('(?<![A-Za-z0-9])' + word + '\\s*(\\d{1,3})\\s*[:.)\\-–—]?[ \\t]*|(?<=^|\\n)[ \\t]*' + any + '\\s*(\\d{1,3})\\s*(?:[:.)\\-–—]|(?=\\n)|$)[ \\t]*', 'g'))]
    .map((m) => Object.assign(m, { num: Number(m[1] || m[2]) }));
}
/** The last unbroken 1, 2, 3… run of markers (a capture can hold a draft, then the final). */
function lastRun(hits) {
  let run = [];
  for (const m of hits) {
    if (m.num === 1) run = [m];
    else if (run.length && m.num === run[run.length - 1].num + 1) run.push(m);
  }
  return run;
}
/** Lesson ids in a title or tag: "[L3]", "(L3)", "L3", or "Lesson 3". */
function idsIn(text, known) {
  const out = [];
  for (const m of String(text || '').matchAll(/\bL\s?(\d{1,2})\b/gi)) out.push('L' + Number(m[1]));
  if (!out.length) { const m = /\blesson\s+(\d{1,2})\b/i.exec(String(text || '')); if (m) out.push('L' + Number(m[1])); }
  return [...new Set(out)].filter((id) => !known || known.has(id));
}

/** A podcast script: {segments:[{title, turns:[{s:'A'|'B', t, L}]}]}. */
export function parsePodcast(raw, hosts, lessonIds = []) {
  const known = new Set(lessonIds);
  let t = toWordsEnd(clean(raw));
  const names = [hosts && hosts[0] && hosts[0].name, hosts && hosts[1] && hosts[1].name].filter(Boolean);
  const speaker = '(?:host\\s*)?(?:A|B' + names.map((n) => '|' + escRe(n)).join('') + ')';
  const lineRe = new RegExp('^\\s*[-*•]?\\s*(' + speaker + ')\\s*(?:\\([^)]{0,30}\\))?\\s*[:：]\\s*(.*)$', 'i');
  const partRe = /^\s*(?:PART|SEGMENT|SECTION)\s*\d{0,2}\s*[:：.\-–—]\s*(.+)$/i;
  const read = (text) => {
    const segs = [];
    let cur = null, last = null;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let m = partRe.exec(line);
      if (m) { cur = { title: m[1].trim(), turns: [], L: idsIn(m[1], known) }; segs.push(cur); last = null; continue; }
      m = lineRe.exec(line);
      if (m) {
        if (!cur) { cur = { title: 'Welcome', turns: [], L: [] }; segs.push(cur); }
        const w = m[1].replace(/^host\s*/i, '').trim();
        const s = /^b$/i.test(w) || (names[1] && w.toLowerCase() === names[1].toLowerCase()) ? 'B' : 'A';
        last = { s, t: m[2].trim(), L: [] };
        cur.turns.push(last);
      } else if (last) last.t += ' ' + line.trim();   // a line that runs on
    }
    return segs;
  };
  let segs = read(t);
  // Newlines lost on the way back: put them in front of every label and read again.
  if (segs.reduce((n, s) => n + s.turns.length, 0) < 4) {
    const lab = new RegExp('\\s+(?=(?:PART|SEGMENT)\\s*\\d{0,2}\\s*[:：]|(?:' + speaker + ')\\s*[:：]\\s)', 'gi');
    segs = read(t.replace(lab, '\n'));
  }
  const out = segs.map((sg, i) => {
    const title = str(sg.title.replace(/\s*[[(]\s*L\s?\d{1,2}\s*[\])]\s*/gi, ' '), 80) || (i ? 'Part ' + (i + 1) : 'Welcome');
    const turns = sg.turns.map((x) => ({ s: x.s, t: str(x.t), L: [] })).filter((x) => x.t.length > 1);
    if (turns.length && sg.L.length) turns[0].L = sg.L;   // a lesson part: its first turn carries the tag
    return { title, turns };
  }).filter((sg) => sg.turns.length);
  if (!out.length) throw new Error('The reply had no podcast lines in it.');
  return { segments: out };
}

const LAYOUT_OF = { title: 'title', intro: 'title', opening: 'title', verse: 'verse', quote: 'verse', story: 'story', points: 'story', scene: 'story', stat: 'story',
  lesson: 'lesson', teaching: 'lesson', compare: 'compare', contrast: 'compare', steps: 'steps', process: 'steps', closing: 'closing', summary: 'closing', outro: 'closing', end: 'closing' };
/** A video script: {scenes:[{layout, headline, visual, art, say, L, ref, beyond}]}. */
export function parseVideo(raw, lessonIds = []) {
  const known = new Set(lessonIds);
  const t = toWordsEnd(clean(raw));
  const run = lastRun(markers(t, 'SCENE'));
  const fieldRe = /(?<![A-Za-z])(LAYOUT|HEADLINE|VISUAL|ART|VERSE|REF|LESSON|BEYOND|NARRATION|SAY)\s*[:：]\s*/gi;
  const scenes = [];
  run.forEach((m, i) => {
    const block = t.slice(m.index + m[0].length, i + 1 < run.length ? run[i + 1].index : t.length);
    const f = {};
    const marks = [...block.matchAll(fieldRe)];
    marks.forEach((fm, k) => { const key = fm[1].toLowerCase(); if (!(key in f)) f[key] = block.slice(fm.index + fm[0].length, k + 1 < marks.length ? marks[k + 1].index : block.length).trim(); });
    const word = String(f.layout || '').toLowerCase().match(/[a-z]+/);
    let layout = LAYOUT_OF[word && word[0]] || 'story';
    const vis = String(f.visual || '');
    let items = /\n/.test(vis.trim()) ? vis.split('\n').map((ln) => ln.replace(/^\s*(?:[-•*]|\d+[.)])\s*/, '').trim()) : vis.split(/(?:^|\s)[-•*]\s+/).map((x) => x.trim());
    items = items.filter(Boolean).map((x) => str(x, layout === 'compare' ? 100 : 72));
    const say = str(f.narration || f.say || '');
    const ref = (String(f.verse || f.ref || '').match(/\d{1,2}\s*\.\s*\d{1,3}(?:\s*[-–]\s*\d{1,3})?/) || [''])[0].replace(/\s+/g, '').replace('–', '-');
    if (layout === 'verse' && !ref) layout = 'story';
    const sc = { layout, headline: str(f.headline, 72), visual: items.slice(0, layout === 'steps' ? 6 : layout === 'compare' ? 5 : 4), say, L: idsIn(f.lesson, known) };
    const art = String(f.art || '').toLowerCase().split(/[,;/]|\band\b/).map((x) => x.trim().replace(/[^a-z]/g, '')).filter((x) => ART.includes(x));
    if (art.length) sc.art = [...new Set(art)].slice(0, 3);
    if (layout === 'verse') sc.ref = ref;
    if (/^\s*(yes|true|y)\b/i.test(String(f.beyond || ''))) sc.beyond = true;
    if (layout === 'lesson' && !sc.L.length) sc.L = idsIn(sc.headline + ' ' + say.slice(0, 40), known);
    if (sc.say) scenes.push(sc);
  });
  if (!scenes.length) throw new Error('The reply had no video scenes in it.');
  return { scenes };
}

/** Lessons: {lessons:[{id, title, body, after?}], summary}. */
export function parseLessons(raw) {
  let t = toWordsEnd(clean(raw));
  if (/^\s*NONE\b/i.test(t)) return { lessons: [], summary: '' };
  const sm = /(?:^|\n)[ \t]*summary\s*[:：]\s*([\s\S]*)$/i.exec(t) || /SUMMARY\s*[:：]\s*([\s\S]*)$/.exec(t);
  const summary = sm ? str(sm[1]) : '';
  if (sm) t = t.slice(0, sm.index);
  // Numbered as written (a second look's lessons start at its own 1); in order.
  const all = markers(t, 'LESSON'), run = lastRun(all);
  const hits = run.length ? run : all;
  const lessons = [];
  if (hits.length) {
    hits.forEach((m, i) => {
      const block = t.slice(m.index + m[0].length, i + 1 < hits.length ? hits[i + 1].index : t.length);
      const ti = /TITLE\s*[:：]\s*([\s\S]*?)(?=\s*(?:BODY|AFTER)\s*[:：]|$)/i.exec(block);
      const bo = /BODY\s*[:：]\s*([\s\S]*?)(?=\s*AFTER\s*[:：]|$)/i.exec(block);
      const af = /AFTER\s*[:：]\s*(\d{1,3})/i.exec(block);
      const title = str(ti ? ti[1] : block.split('\n')[0]), body = str(bo ? bo[1] : '');
      if (title) lessons.push(Object.assign({ n: m.num, title, body }, af ? { after: Number(af[1]) } : {}));
    });
  } else {
    // "1. Title: body" lines, when a unit numbered them its own way.
    for (const m of t.matchAll(/(?:^|\n)\s*(\d{1,3})[.)]\s+([^\n]+)/g)) {
      const [title, ...rest] = m[2].split(/\s+[—–-]\s+|:\s+/);
      if (title.trim()) lessons.push({ n: Number(m[1]), title: str(title, 200), body: str(rest.join(' ')) });
    }
  }
  if (!lessons.length) throw new Error('The reply had no lessons in it.');
  return { lessons: lessons.map((l, i) => Object.assign({ id: 'L' + (i + 1) }, l)), summary };
}

/* ── the older JSON replies (still read) ─────────────────────────────────── */
/** The JSON object in a reply: fences, chatter and trailing commas forgiven. */
export function parseJSON(text) {
  let s = String(text || '').replace(/```(?:json)?/gi, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('The reply had no JSON in it.');
  s = s.slice(a, b + 1);
  try { return JSON.parse(s); } catch (e) {}
  const fixed = s.replace(/[“”]/g, '"').replace(/,\s*([\]}])/g, '$1');
  try { return JSON.parse(fixed); } catch (e) { throw new Error('The reply\'s JSON could not be read (' + e.message + ').'); }
}
const idsOf = (x, known) => (Array.isArray(x) ? x : x ? [x] : []).map((v) => String(v).toUpperCase().replace(/^(\d+)$/, 'L$1')).filter((v) => known.has(v));
export function normPodcast(obj, hosts, lessonIds) {
  const known = new Set(lessonIds);
  const segs = (Array.isArray(obj && obj.segments) ? obj.segments : []).map((sg, i) => ({
    title: str(sg.title, 80) || (i ? 'Part ' + (i + 1) : 'Welcome'),
    turns: (Array.isArray(sg.turns) ? sg.turns : []).map((t, k) => {
      const who = String(t.s || t.speaker || '').trim();
      const s = /^b$/i.test(who) || (hosts[1] && who === hosts[1].name) ? 'B' : /^a$/i.test(who) || (hosts[0] && who === hosts[0].name) ? 'A' : (k % 2 ? 'B' : 'A');
      return { s, t: str(t.t || t.text), L: idsOf(t.L || t.lessons, known) };
    }).filter((t) => t.t.length > 1),
  })).filter((sg) => sg.turns.length);
  if (!segs.length) throw new Error('The reply had no podcast turns.');
  return { segments: segs };
}
export function normVideo(obj, lessonIds) {
  const known = new Set(lessonIds);
  const scenes = (Array.isArray(obj && obj.scenes) ? obj.scenes : []).map((sc) => {
    const layout = LAYOUTS.includes(String(sc.layout || '').toLowerCase()) ? String(sc.layout).toLowerCase() : 'story';
    const vis = (Array.isArray(sc.visual) ? sc.visual : sc.visual ? [sc.visual] : []).map((v) => str(v, layout === 'compare' ? 100 : 64)).filter(Boolean);
    const out = { layout, headline: str(sc.headline, 64), visual: vis.slice(0, layout === 'steps' ? 6 : layout === 'compare' ? 5 : 4), say: str(sc.say || sc.narration), L: idsOf(sc.L || sc.lessons, known) };
    if (layout === 'verse') out.ref = str(sc.ref);
    if (sc.beyond) out.beyond = true;
    return out;
  }).filter((s) => s.say);
  if (!scenes.length) throw new Error('The reply had no video scenes.');
  return { scenes };
}
export function normLessons(obj) {
  const lessons = (Array.isArray(obj && obj.lessons) ? obj.lessons : []).map((l) => ({ title: str(l.title, 160), body: str(l.body) })).filter((l) => l.title)
    .map((l, i) => Object.assign({ id: 'L' + (i + 1) }, l));
  if (!lessons.length) throw new Error('The reply had no lessons.');
  return { lessons, summary: str(obj.summary) };
}

/** Read a reply of any kind: the labelled format, else JSON. ctx: {hosts, lessonIds}. */
export function parseReply(kind, raw, ctx = {}) {
  const ids = ctx.lessonIds || [];
  try {
    return kind === 'podcast' ? parsePodcast(raw, ctx.hosts, ids) : kind === 'video' ? parseVideo(raw, ids) : parseLessons(raw);
  } catch (e) {
    if (!/[{[]/.test(String(raw || ''))) throw e;
    let obj;
    try { obj = parseJSON(raw); } catch (e2) { throw e; }
    return kind === 'podcast' ? normPodcast(obj, ctx.hosts, ids) : kind === 'video' ? normVideo(obj, ids) : normLessons(obj);
  }
}

/* ── putting pieces together ─────────────────────────────────────────────── */
/** Which lessons a script teaches. */
export function coverage(kind, script, lessonIds) {
  const have = new Set(kind === 'podcast' ? script.segments.flatMap((s) => s.turns.flatMap((t) => t.L)) : kind === 'video' ? script.scenes.flatMap((s) => s.L) : lessonIds);
  return { covered: lessonIds.filter((id) => have.has(id)), missing: lessonIds.filter((id) => !have.has(id)) };
}
const firstL = (xs) => xs.map((x) => Number(String(x).slice(1))).filter((n) => n > 0)[0];
/** Missing lesson parts or scenes, each put after the last one that teaches an
 *  earlier lesson (else before the wrap-up / closing). */
export function mergeLessons(kind, script, extra) {
  const list = kind === 'podcast' ? script.segments.slice() : script.scenes.slice();
  const more = kind === 'podcast' ? extra.segments : extra.scenes;
  const lOf = (x) => firstL(kind === 'podcast' ? x.turns.flatMap((t) => t.L) : x.L || []);
  for (const piece of more) {
    const n = lOf(piece);
    if (!n) continue;
    let at = -1;
    list.forEach((x, i) => { const m = lOf(x); if (m && m < n) at = i; });
    if (at < 0) {
      const end = list.findIndex((x) => (kind === 'podcast' ? /wrap|clos|goodbye|farewell|next/i.test(x.title) : x.layout === 'closing'));
      at = (end < 0 ? list.length : end) - 1;
      // Keep a lesson after the story: never before the first lesson-free part.
      if (at < 0) at = 0;
    }
    list.splice(at + 1, 0, piece);
  }
  return kind === 'podcast' ? { segments: list } : { scenes: list };
}
/** Lessons a second look found, put after the lesson each names, then renumbered. */
export function mergeFound(script, found) {
  const list = script.lessons.map((l) => Object.assign({}, l));
  const add = found.lessons.slice().sort((a, b) => (b.after || 0) - (a.after || 0));
  for (const l of add) {
    const after = Math.max(0, Math.min(list.length, Number(l.after) || 0));
    const at = after ? list.findIndex((x) => x.n === after) + 1 || list.length : 0;
    list.splice(at, 0, { title: l.title, body: l.body, n: -1 });
  }
  return { lessons: list.map((l, i) => ({ id: 'L' + (i + 1), title: l.title, body: l.body })), summary: script.summary };
}
/** Lessons rewritten shorter replace theirs by number. */
export function mergeShort(script, short) {
  const by = new Map(short.lessons.map((l) => [l.n, l]));
  return { lessons: script.lessons.map((l, i) => { const s = by.get(l.n || i + 1); return s ? Object.assign({}, l, { title: s.title, body: s.body || l.body }) : l; }), summary: script.summary };
}
const wordCount = (t) => String(t || '').split(/\s+/).filter(Boolean).length;
/** The lessons over the length's limits (a little slack). */
export function longLessons(script, length) {
  const d = (LENGTHS[length] || LENGTHS.standard).lesson;
  return ((script && script.lessons) || []).filter((l) => wordCount(l.body) > d.body * 1.3 + 5 || wordCount(l.title) > d.title + 4).map((l) => l.n || Number(l.id.slice(1)));
}
