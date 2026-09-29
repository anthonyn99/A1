/* ============================================================================
 * StudyOS — safe markdown  (lesson text)
 * ============================================================================
 * A deliberately small renderer rather than a library, ported from
 * SOLO-LEVELING's lesson player: the text is written by a model we prompt, so
 * the subset of markdown that appears is one we choose.
 *
 * EVERYTHING IS ESCAPED BEFORE ANY TAG IS INTRODUCED, so no generated string
 * can inject markup — a lesson about HTML that says `<script>` shows the word,
 * it never runs it. This is the ONLY way AI text reaches the page.
 *
 * Supported: ## / ### headings, paragraphs, - and 1. lists, > quotes,
 * ```fenced code```, | tables |, `code`, **bold**, *italic*.
 * ------------------------------------------------------------------------- */

export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Inline spans on ALREADY-ESCAPED text. Code spans are lifted out first so
 *  an asterisk inside backticks is never read as emphasis. */
export function inline(text) {
  const codes = [];
  let s = String(text).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
}

const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
const isDivider = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());

export function renderMarkdown(source) {
  const lines = escapeHtml(source || '').split('\n');
  const html = [];
  let listType = null;
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length) { html.push(`<p>${inline(paragraph.join(' '))}</p>`); paragraph = []; }
  };
  const flushList = () => { if (listType) { html.push(`</${listType}>`); listType = null; } };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, '');

    // Fenced code: taken verbatim (already escaped) up to the closing fence.
    if (/^\s*```/.test(line)) {
      flushParagraph(); flushList();
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      html.push(`<pre><code>${body.join('\n')}</code></pre>`);
      continue;
    }

    if (!line.trim()) { flushParagraph(); flushList(); continue; }

    // A table needs a header row AND a divider row right under it; one stray
    // pipe line stays a paragraph.
    if (isTableRow(line) && i + 1 < lines.length && isDivider(lines[i + 1])) {
      flushParagraph(); flushList();
      const head = cells(line);
      const rows = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) rows.push(cells(lines[i++]));
      i--;
      html.push('<div class="md-table"><table><thead><tr>'
        + head.map(c => `<th>${inline(c)}</th>`).join('')
        + '</tr></thead><tbody>'
        + rows.map(r => '<tr>' + head.map((_, k) => `<td>${inline(r[k] || '')}</td>`).join('') + '</tr>').join('')
        + '</tbody></table></div>');
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushParagraph(); flushList();
      const level = Math.min(4, Math.max(3, heading[1].length + 1));
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^&gt;\s?/.test(line)) {
      flushParagraph(); flushList();
      html.push(`<blockquote>${inline(line.replace(/^&gt;\s?/, ''))}</blockquote>`);
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushParagraph();
      const wanted = bullet ? 'ul' : 'ol';
      if (listType !== wanted) { flushList(); html.push(`<${wanted}>`); listType = wanted; }
      html.push(`<li>${inline((bullet || numbered)[1])}</li>`);
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  return html.join('');
}

export default { renderMarkdown, escapeHtml, inline };
