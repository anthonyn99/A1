/* ============================================================================
 * StudyOS — a small code highlighter  (v2 lessons: Java, Python, SQL, C, pseudo)
 * ============================================================================
 * highlightLines(source, language) -> one escaped HTML string per line, with
 * <span class="hl-*"> for keywords, types, strings, comments and numbers.
 * Comments and strings that span lines are closed and reopened per line, so
 * a line can be shown (and annotated) on its own. No library: the lessons
 * show a few short snippets, and the app has no bundler.
 * ------------------------------------------------------------------------- */

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const words = (s) => new Set(s.split(/\s+/).filter(Boolean));

const JAVA = words('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new null package private protected public return short static super switch synchronized this throw throws try void volatile while true false var record');
const C = words('auto break case char const continue default do double else enum extern float for goto if inline int long register return short signed sizeof static struct switch typedef union unsigned void volatile while NULL bool true false include define');
const PY = words('and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self');
const SQL = words('select from where insert into values update set delete create table primary key foreign references join inner left right outer full cross on group by order having as and or not null is in exists distinct union all limit offset drop alter add index view count sum avg min max between like case when then else end default unique check constraint int integer varchar char date text decimal numeric boolean asc desc with');
const PSEUDO = words('if then else elif while for each do return end function procedure algorithm to in not and or null nil true false repeat until break continue let set print input output begin');

const LANG = {
  java: { kw: JAVA, line: ['//'], block: true, types: true },
  c: { kw: C, line: ['//'], block: true, types: false },
  'c++': { kw: C, line: ['//'], block: true, types: true },
  cpp: { kw: C, line: ['//'], block: true, types: true },
  javascript: { kw: words('const let var function return if else for while do break continue new class extends this null undefined true false typeof instanceof import export from async await try catch finally throw switch case default of in'), line: ['//'], block: true, types: true },
  python: { kw: PY, line: ['#'], block: false, triple: true, types: true },
  sql: { kw: SQL, line: ['--'], block: true, ci: true },
  pseudo: { kw: PSEUDO, line: ['//', '#'], block: false, ci: true },
};
LANG.js = LANG.javascript;
LANG.py = LANG.python;
LANG.pseudocode = LANG.pseudo;

/** Tokens: [{cls, text}] — cls '' for plain text. */
export function tokenize(source, language = 'pseudo') {
  const L = LANG[String(language || '').toLowerCase()] || LANG.pseudo;
  const src = String(source || '');
  const out = [];
  const push = (cls, text) => { if (text) out.push({ cls, text }); };
  let i = 0, plain = '';
  const flush = () => { push('', plain); plain = ''; };
  while (i < src.length) {
    const rest = src.slice(i);
    const lc = L.line.find((p) => rest.startsWith(p));
    if (lc) { flush(); const end = src.indexOf('\n', i); const j = end < 0 ? src.length : end; push('hl-com', src.slice(i, j)); i = j; continue; }
    if (L.block && rest.startsWith('/*')) { flush(); const end = src.indexOf('*/', i + 2); const j = end < 0 ? src.length : end + 2; push('hl-com', src.slice(i, j)); i = j; continue; }
    if (L.triple && (rest.startsWith('"""') || rest.startsWith("'''"))) {
      flush(); const q = rest.slice(0, 3); const end = src.indexOf(q, i + 3); const j = end < 0 ? src.length : end + 3; push('hl-str', src.slice(i, j)); i = j; continue;
    }
    const ch = src[i];
    if (ch === '"' || ch === "'" || (ch === '`' && L === LANG.javascript)) {
      flush();
      let j = i + 1;
      while (j < src.length && src[j] !== ch && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      push('hl-str', src.slice(i, Math.min(src.length, j + 1))); i = j + 1; continue;
    }
    const num = /^\d+(?:\.\d+)?[fFlLdD]?\b/.exec(rest);
    if (num && !/[\w$]/.test(src[i - 1] || '')) { flush(); push('hl-num', num[0]); i += num[0].length; continue; }
    const id = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (id) {
      const w = id[0];
      const key = L.ci ? w.toLowerCase() : w;
      if (L.kw.has(key)) { flush(); push('hl-kw', w); }
      else if (L.types && /^[A-Z][a-z0-9]\w*$/.test(w)) { flush(); push('hl-type', w); }
      else plain += w;
      i += w.length; continue;
    }
    plain += ch; i++;
  }
  flush();
  return out;
}

/** One HTML string per source line. */
export function highlightLines(source, language) {
  const lines = [''];
  for (const tok of tokenize(source, language)) {
    tok.text.split('\n').forEach((part, k) => {
      if (k) lines.push('');
      if (part) lines[lines.length - 1] += tok.cls ? `<span class="${tok.cls}">${esc(part)}</span>` : esc(part);
    });
  }
  return lines;
}

export default { tokenize, highlightLines };
