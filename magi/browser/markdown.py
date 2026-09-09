"""Recovering markdown from a rendered chat answer.

`inner_text()` returns what the answer LOOKS like, not what it IS. The chat UIs
have already turned the model's markdown into real elements -- `<h3>`, `<ul>`,
`<strong>`, `<table>` -- and flattening those back to plain text throws away
every structural marker downstream code depends on. A heading arrives as a bare
line, bullets lose their `-`, and the frontend's verdict parser -- which keys on
exactly those markers -- files the whole answer as undifferentiated paragraphs.

So walk the DOM instead and re-emit markdown from the element structure. The
tags are unambiguous: an `<li>` was a bullet, an `<h3>` was a heading. This is
strictly more faithful than reading the text, because it recovers intent the
rendered text has already discarded.

The serializer runs in the page as one JS expression rather than over a tree
marshalled into Python: the DOM can be swapped mid-read by React, and doing the
whole walk in a single evaluate call means it either sees one coherent snapshot
or throws -- never a half-updated tree stitched together across round trips.
"""

from __future__ import annotations

# Elements that are chrome rather than answer content. Copy buttons and language
# labels sit INSIDE the markdown container on several sites, so they cannot be
# handled by the anchored strip_patterns in extract.py.
_SKIP = """
  const SKIP = new Set(['BUTTON','SVG','PATH','SCRIPT','STYLE','NOSCRIPT']);
  // Structural markers whose loss actually changes the meaning of an answer.
  // Used to decide whether a container must be RECURSED into rather than
  // flattened -- see the custom-element note in block().
  //
  // Deliberately excludes P and DIV: almost every wrapper contains one, so
  // including them would recurse into everything and split single paragraphs
  // apart at arbitrary boundaries.
  const BLOCK_SEL = 'table,ul,ol,pre,blockquote,h1,h2,h3,h4,h5,h6';
  const hasBlockInside = (n) => !!(n.querySelector && n.querySelector(BLOCK_SEL));
"""

# One expression, so the page is walked atomically. Returns a markdown string.
DOM_TO_MARKDOWN_JS = """
(el) => {
%s
  // Zero-width and private-use characters: chat UIs use them for icon glyphs
  // and layout hints. They carry no meaning in an answer and corrupt the text.
  const clean = (s) => s.replace(/[\\u200b-\\u200f\\u2060\\ufeff\\ue000-\\uf8ff]/g, '');

  // Inline content: recurse for text, but wrap the emphasis tags back into
  // their markdown form so **bold** and `code` survive.
  const inline = (node) => {
    let out = '';
    for (const c of node.childNodes) {
      if (c.nodeType === 3) { out += clean(c.nodeValue); continue; }
      if (c.nodeType !== 1) continue;
      const tag = c.tagName;
      if (SKIP.has(tag)) continue;
      // A real <br> is intent; a newline in the source is formatting. Once
      // both are '\\n' they are indistinguishable, so <br> gets a sentinel that
      // para() converts back after collapsing the source whitespace.
      if (tag === 'BR') { out += '\\u0000'; continue; }
      const inner = inline(c);
      if (!inner.trim()) { out += inner; continue; }
      if (tag === 'STRONG' || tag === 'B') out += '**' + inner.trim() + '**';
      else if (tag === 'EM' || tag === 'I') out += '*' + inner.trim() + '*';
      else if (tag === 'CODE') out += '`' + inner.trim() + '`';
      else out += inner;
    }
    return out;
  };

  // A cell or list item is one line by definition, so a <br> inside it becomes
  // a space rather than breaking the row apart.
  const cell = (c) => inline(c)
    .replace(/\\u0000/g, ' ').replace(/\\s+/g, ' ').replace(/\\|/g, '\\\\|').trim();

  // A paragraph's source newlines and indentation are HTML formatting, not
  // content -- collapse them, or the answer arrives pre-wrapped at whatever
  // width the page source happened to use. An explicit <br> is preserved by
  // inline() as a newline and survives, since it is real intent.
  const para = (node) => inline(node)
    .split('\\u0000')
    .map((l) => l.replace(/\\s+/g, ' ').trim())
    .join('\\n')
    .replace(/\\n{3,}/g, '\\n\\n')
    .trim();

  // Block content. `depth` drives list indentation; two spaces per level is
  // what the verdict parser treats as one nesting step.
  const block = (node, depth) => {
    const out = [];
    for (const c of node.childNodes) {
      if (c.nodeType === 3) {
        const t = clean(c.nodeValue).trim();
        if (t) out.push(t);
        continue;
      }
      if (c.nodeType !== 1) continue;
      const tag = c.tagName;
      if (SKIP.has(tag)) continue;

      if (/^H[1-6]$/.test(tag)) {
        const t = inline(c).trim();
        // Normalised to ### regardless of the level the UI chose to render:
        // chat UIs map heading levels inconsistently, and the verdict parser
        // treats any depth the same way.
        if (t) out.push('### ' + t);
      } else if (tag === 'UL' || tag === 'OL') {
        const ordered = tag === 'OL';
        let n = 1;
        // A list is emitted as ONE entry: blocks are joined with a blank line,
        // and a blank line between every bullet would read as separate
        // paragraphs rather than one list.
        const lines = [];
        for (const li of c.children) {
          if (li.tagName !== 'LI') continue;
          // Split the item's own content from any list nested inside it, so the
          // child list keeps its own lines rather than being inlined.
          const sub = [];
          const own = document.createElement('div');
          for (const k of li.childNodes) {
            if (k.nodeType === 1 && (k.tagName === 'UL' || k.tagName === 'OL')) sub.push(k);
            else own.appendChild(k.cloneNode(true));
          }
          const marker = ordered ? (n++) + '. ' : '- ';
          // inline() when the item is just text and emphasis -- routing that
          // through block() would drop the **bold** lead-in that the frontend
          // styles as a label. Only recurse when there is a real block inside.
          const hasBlock = [...own.children].some((k) =>
            /^(P|DIV|UL|OL|TABLE|PRE|BLOCKQUOTE|H[1-6])$/.test(k.tagName));
          const text = (hasBlock ? block(own, depth).join(' ') : inline(own))
            .replace(/\\u0000/g, ' ').replace(/\\s+/g, ' ').trim();
          if (text) lines.push('  '.repeat(depth) + marker + text);
          for (const s of sub) lines.push(...block({ childNodes: [s] }, depth + 1));
        }
        if (lines.length) out.push(lines.join('\\n'));
      } else if (tag === 'TABLE') {
        const rows = [...c.querySelectorAll('tr')];
        if (rows.length) {
          // Also one entry: a pipe table is only a table if its rows are on
          // consecutive lines.
          const lines = [];
          const head = [...rows[0].children].map(cell);
          lines.push('| ' + head.join(' | ') + ' |');
          lines.push('| ' + head.map(() => '---').join(' | ') + ' |');
          for (const r of rows.slice(1)) {
            const cs = [...r.children].map(cell);
            if (cs.length) lines.push('| ' + cs.join(' | ') + ' |');
          }
          out.push(lines.join('\\n'));
        }
      } else if (tag === 'PRE') {
        const t = (c.innerText || '').replace(/\\s+$/, '');
        // Fenced code is dropped by the verdict parser, but keeping the fence
        // means it is dropped as a unit instead of leaking as loose lines.
        if (t.trim()) out.push('```\\n' + t + '\\n```');
      } else if (tag === 'BLOCKQUOTE') {
        for (const l of block(c, depth)) out.push('> ' + l);
      } else if (tag === 'HR') {
        out.push('---');
      } else if (tag === 'P' || tag === 'DIV' || tag === 'SECTION' || tag === 'ARTICLE') {
        // A container may hold either inline content or further blocks. If it
        // has any block-level child, recurse; otherwise treat it as one
        // paragraph. Guessing wrong either way merges or splits paragraphs.
        // The DESCENDANT check matters as much as the child one: Gemini is an
        // Angular app and wraps its table in custom elements, so the immediate
        // children are <some-custom-tag> and the tag test below finds nothing.
        const hasBlock = [...c.children].some((k) =>
          /^(P|DIV|UL|OL|TABLE|PRE|BLOCKQUOTE|H[1-6]|HR|SECTION|ARTICLE)$/.test(k.tagName))
          || hasBlockInside(c);
        if (hasBlock) out.push(...block(c, depth));
        else { const t = para(c); if (t) out.push(t); }
      } else {
        // An unrecognised tag is usually a framework custom element
        // (<model-response>, <message-content>, <response-element>). Flattening
        // one with para() discards every block inside it -- which is exactly
        // how Gemini's comparison table arrived as
        // "Metric / FeatureFirebase FirestoreCloudflare KV..." with no cell
        // boundaries at all, and then went into the synthesis prompt that way.
        // Recurse when there is real structure in there; flatten when there is
        // not, so an ordinary inline wrapper still reads as one paragraph.
        if (hasBlockInside(c)) out.push(...block(c, depth));
        else { const t = para(c); if (t) out.push(t); }
      }
    }
    return out;
  };

  // Backstop: no path should leak the <br> sentinel, but a stray NUL in the
  // answer text would be far worse than a lost line break.
  return block(el, 0).join('\\n\\n').replace(/\\u0000/g, '\\n');
}
""" % _SKIP
