/* Notebook — markdown helpers shared by every journal app and the DOCX editor:
   window._mdToHtml(md) and window._renderMdTables(editor). They lived in
   Brainstorm's app although MyJournal uses them too. */
(function () {
// ── Markdown → HTML (shared, global) — full-featured ──────────────────────
// Handles: headings, bold/italic/strike, inline+fenced code (with lang), links
// (inline/reference/auto/email), images, ordered/unordered/nested/task lists,
// definition lists, tables (with alignment), blockquotes (nested), horizontal
// rules, highlight (==x==), sub (~x~) / sup (^x^), footnotes, emoji shortcodes,
// backslash escaping, safe inline+block HTML passthrough, and math ($…$, $$…$$)
// via KaTeX placeholders that _docxRenderMath() fills in after insertion.
var DOCX_EMOJI = { smile:'😄', smiley:'😃', grin:'😁', laughing:'😆', wink:'😉', blush:'😊', heart:'❤️', hearts:'💕', fire:'🔥', rocket:'🚀', tada:'🎉', star:'⭐', star2:'🌟', sparkles:'✨', zap:'⚡', boom:'💥', sunny:'☀️', bulb:'💡', check:'✔️', white_check_mark:'✅', x:'❌', warning:'⚠️', question:'❓', exclamation:'❗', thumbsup:'👍', '+1':'👍', thumbsdown:'👎', '-1':'👎', eyes:'👀', wave:'👋', clap:'👏', pray:'🙏', muscle:'💪', ok_hand:'👌', point_right:'👉', point_left:'👈', rainbow:'🌈', hourglass:'⏳', alarm_clock:'⏰', calendar:'📅', memo:'📝', pencil:'✏️', book:'📖', books:'📚', computer:'💻', iphone:'📱', email:'📧', mag:'🔍', lock:'🔒', key:'🔑', bell:'🔔', chart_with_upwards_trend:'📈', chart_with_downwards_trend:'📉', bar_chart:'📊', moneybag:'💰', gift:'🎁', trophy:'🏆', medal:'🏅', dart:'🎯', hammer:'🔨', wrench:'🔧', gear:'⚙️', package:'📦', pushpin:'📌', paperclip:'📎', coffee:'☕', pizza:'🍕', beer:'🍺', cake:'🎂', sun:'☀️', cloud:'☁️', snowflake:'❄️', umbrella:'☔', earth_americas:'🌎', globe:'🌐', bug:'🐛', ghost:'👻', robot:'🤖', alien:'👽', skull:'💀', poop:'💩', '100':'💯', ok:'🆗', new:'🆕', up:'🔼', cool:'🆒', thinking:'🤔', sob:'😭', joy:'😂', sunglasses:'😎', heart_eyes:'😍', angry:'😠', scream:'😱' };

if (!window._mdToHtml) {
window._mdToHtml = function(md) {
  var esc = function(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); };
  md = String(md == null ? '' : md).replace(/\r\n?/g, '\n');

  var codeBlocks = [], mathBlocks = [], refs = {}, footnotes = {}, footnoteOrder = [];

  // 1) Reference-link definitions:  [id]: url "title"
  md = md.replace(/^[ \t]{0,3}\[([^\^\]][^\]]*)\]:\s*(\S+).*$/gm, function(_, id, url){ refs[id.toLowerCase().trim()] = url; return 'K'; });
  // 2) Footnote definitions:  [^id]: text
  md = md.replace(/^[ \t]{0,3}\[\^([^\]]+)\]:[ \t]*(.*)$/gm, function(_, id, text){ footnotes[id.trim()] = text; return 'K'; });
  // 3) Fenced code blocks  ```lang \n … ```
  md = md.replace(/```([a-zA-Z0-9_+-]*)[ \t]*\n?([\s\S]*?)```/g, function(_, lang, c){
    codeBlocks.push('<pre class="docx-code"' + (lang ? ' data-lang="' + esc(lang) + '"' : '') + '><code>' + esc(c.replace(/\n$/, '')) + '</code></pre>');
    return 'C' + (codeBlocks.length - 1) + '';
  });
  // 4) Block math  $$ … $$  (multi-line) → its own placeholder line
  md = md.replace(/\$\$([\s\S]*?)\$\$/g, function(_, tex){
    mathBlocks.push({ tex: tex.replace(/^\n+|\n+$/g, ''), display: true });
    return '\nM' + (mathBlocks.length - 1) + '\n';
  });

  var SAFE_HTML = 'u|sub|sup|br|mark|kbd|small|b|i|em|strong|code|span|a|abbr|del|ins';
  var inline = function(t){
    // backslash escapes FIRST (so \` \* etc. become literal and never trigger code/format)
    var escd = [];
    t = t.replace(/\\([\\`*_{}\[\]()#+.!~^=|<>&-])/g, function(_, ch){ escd.push(ch); return 'e' + (escd.length - 1) + ''; });
    // protect inline math  $ math $
    t = t.replace(/\$([^$\n]+?)\$/g, function(_, tex){ mathBlocks.push({ tex: tex.trim(), display: false }); return 'M' + (mathBlocks.length - 1) + ''; });
    // protect inline code  ` code `  (escaped backticks are already placeholders now)
    var codes = [];
    t = t.replace(/`([^`]+)`/g, function(_, c){ codes.push(esc(c)); return 'c' + (codes.length - 1) + ''; });
    t = esc(t);
    // images
    t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, '<img src="$2" alt="$1" style="max-width:100%;">');
    // inline links
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    // reference links  [text][id]  and  [text][]
    t = t.replace(/\[([^\]]+)\]\[([^\]]*)\]/g, function(m, txt, id){ var u = refs[(id || txt).toLowerCase().trim()]; return u ? '<a href="' + u + '" target="_blank" rel="noopener">' + txt + '</a>' : m; });
    // emails  <a@b.c>
    t = t.replace(/&lt;([^@\s]+@[^@\s]+\.[^@\s]+)&gt;/g, '<a href="mailto:$1">$1</a>');
    // bare URLs
    t = t.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
    // bold / italic
    t = t.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    t = t.replace(/___([^_]+)___/g, '<strong><em>$1</em></strong>');
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>');
    t = t.replace(/(^|[^_\w])_([^_\s][^_]*?)_(?!\w)/g, '$1<em>$2</em>');
    // strikethrough
    t = t.replace(/~~([^~]+)~~/g, '<s>$1</s>');
    // highlight
    t = t.replace(/==([^=]+)==/g, '<mark class="docx-hl">$1</mark>');
    // subscript ~x~  and superscript ^x^  (after ~~ strike so it doesn't clash)
    t = t.replace(/~([^~\s][^~]*?)~/g, '<sub>$1</sub>');
    t = t.replace(/\^([^\^\s]+?)\^/g, '<sup>$1</sup>');
    // footnote references [^id]
    t = t.replace(/\[\^([^\]]+)\]/g, function(m, id){ id = id.trim(); if (!(id in footnotes)) return m; if (footnoteOrder.indexOf(id) < 0) footnoteOrder.push(id); var n = footnoteOrder.indexOf(id) + 1; return '<sup class="docx-fnref">[<a href="#docx-fn-' + encodeURIComponent(id) + '">' + n + '</a>]</sup>'; });
    // emoji shortcodes
    t = t.replace(/:([a-z0-9_+-]+):/g, function(m, name){ return DOCX_EMOJI[name] || m; });
    // restore whitelisted inline HTML tags the author wrote
    t = t.replace(new RegExp('&lt;(/?)(' + SAFE_HTML + ')((?:\\s[^&]*?)?)\\s*(/?)&gt;', 'gi'), function(m, slash, tag, attrs, sc){ attrs = attrs.replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&'); return '<' + slash + tag + attrs + sc + '>'; });
    // restore escapes / inline code
    t = t.replace(/e(\d+)/g, function(_, n){ return esc(escd[+n]); });
    t = t.replace(/c(\d+)/g, function(_, n){ return '<code>' + codes[+n] + '</code>'; });
    return t;
  };

  var lines = md.split('\n'), out = [], j = 0;
  var isSepLine = function(s){ return /^\s*\|?[\s:|-]+\|?\s*$/.test(s) && /-/.test(s) && /\|/.test(s); };
  // A line that BEGINS with a block-level HTML tag passes through raw (content after the tag is fine,
  // so `<summary>Click</summary>` / `<li>item</li>` inside a <details> render as HTML, not literal text).
  var htmlBlockRe = /^\s*<\/?(details|summary|div|section|article|aside|nav|header|footer|figure|figcaption|table|thead|tbody|tfoot|tr|td|th|ul|ol|li|dl|dt|dd|blockquote|pre|hr|p|h[1-6]|iframe|video|audio|img|br)\b/i;

  while (j < lines.length) {
    var ln = lines[j];
    if (ln === 'K') { j++; continue; }
    var phC = ln.match(/^C(\d+)$/); if (phC) { out.push(codeBlocks[+phC[1]]); j++; continue; }
    var phM = ln.match(/^M(\d+)$/); if (phM) { out.push('M' + phM[1] + ''); j++; continue; }
    if (/^\s*$/.test(ln)) { j++; continue; }

    // raw HTML block line → pass through untouched
    if (htmlBlockRe.test(ln)) { out.push(ln); j++; continue; }

    // ATX heading
    var h = ln.match(/^(#{1,6})\s+(.*?)\s*#*$/);
    if (h) { var lv = h[1].length; out.push('<h' + lv + '>' + inline(h[2]) + '</h' + lv + '>'); j++; continue; }

    // horizontal rule
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(ln)) { out.push('<hr>'); j++; continue; }

    // blockquote (supports nesting via >>)
    if (/^\s*>/.test(ln)) {
      var qlines = [];
      while (j < lines.length && /^\s*>/.test(lines[j])) { qlines.push(lines[j].replace(/^\s*>\s?/, '')); j++; }
      out.push('<blockquote>' + window._mdToHtml(qlines.join('\n')).replace(/<p><br><\/p>\s*$/, '') + '</blockquote>');
      continue;
    }

    // table
    if (/\|/.test(ln) && !isSepLine(ln)) {
      var sIdx = j + 1;
      while (sIdx < lines.length && /^\s*$/.test(lines[sIdx])) sIdx++;
      if (sIdx < lines.length && isSepLine(lines[sIdx])) {
        var cell = function(r){ return r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(function(c){ return c.trim(); }); };
        var aligns = cell(lines[sIdx]).map(function(s){ var l = /^:/.test(s), r = /:$/.test(s); return l && r ? 'center' : r ? 'right' : l ? 'left' : ''; });
        var head = cell(ln);
        var al = function(i){ return aligns[i] ? ' style="text-align:' + aligns[i] + '"' : ''; };
        var t = '<table><thead><tr>' + head.map(function(c, i){ return '<th' + al(i) + '>' + inline(c) + '</th>'; }).join('') + '</tr></thead><tbody>';
        j = sIdx + 1;
        while (j < lines.length) {
          if (/^\s*$/.test(lines[j])) { var p = j + 1; while (p < lines.length && /^\s*$/.test(lines[p])) p++; if (p < lines.length && /\|/.test(lines[p]) && !isSepLine(lines[p])) { j = p; continue; } break; }
          if (!/\|/.test(lines[j])) break;
          if (isSepLine(lines[j])) { j++; continue; }
          t += '<tr>' + cell(lines[j]).map(function(c, i){ return '<td' + al(i) + '>' + inline(c) + '</td>'; }).join('') + '</tr>'; j++;
        }
        out.push(t + '</tbody></table>'); continue;
      }
    }

    // definition list:  Term \n : def \n : def
    if (j + 1 < lines.length && /^:\s+/.test(lines[j + 1]) && !/^\s*([-*+]|\d+\.)\s/.test(ln)) {
      var dl = '<dl>';
      while (j < lines.length && lines[j].trim() && !/^:\s+/.test(lines[j])) { dl += '<dt>' + inline(lines[j].trim()) + '</dt>'; j++;
        while (j < lines.length && /^:\s+/.test(lines[j])) { dl += '<dd>' + inline(lines[j].replace(/^:\s+/, '')) + '</dd>'; j++; }
      }
      out.push(dl + '</dl>'); continue;
    }

    // lists (nested + task lists)
    if (/^\s*([-*+]|\d+[.)])\s+/.test(ln)) {
      var items = [];
      while (j < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[j])) {
        var lm = lines[j].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        items.push({ depth: Math.floor(lm[1].replace(/\t/g, '  ').length / 2), ordered: /\d/.test(lm[2]), text: lm[3] });
        j++;
      }
      var renderList = function(arr){
        var depth = arr[0].depth, k = 0, ordered = arr[0].ordered;
        var hasCheck = arr.some(function(it){ return it.depth === depth && /^\[[ xX]\]\s/.test(it.text); });
        var html = ordered ? '<ol>' : (hasCheck ? '<ul class="docx-checklist">' : '<ul>');
        while (k < arr.length) {
          var it = arr[k], kids = [], k2 = k + 1;
          while (k2 < arr.length && arr[k2].depth > depth) { kids.push(arr[k2]); k2++; }
          var cm = it.text.match(/^\[([ xX])\]\s+(.*)$/);
          var body = cm ? '<input type="checkbox" class="docx-cl-box"' + (cm[1] !== ' ' ? ' checked' : '') + '><span class="docx-cl-text">' + inline(cm[2]) + '</span>' : inline(it.text);
          html += '<li' + (cm ? ' class="docx-cl-item' + (cm[1] !== ' ' ? ' done' : '') + '"' : '') + '>' + body + (kids.length ? renderList(kids) : '') + '</li>';
          k = k2;
        }
        return html + (ordered ? '</ol>' : '</ul>');
      };
      out.push(renderList(items)); continue;
    }

    // paragraph
    var para = [];
    while (j < lines.length && lines[j].trim() && !/^(#{1,6})\s/.test(lines[j]) && !/^\s*>/.test(lines[j]) &&
           !/^\s*([-*+]|\d+[.)])\s+/.test(lines[j]) && !/^[CM]\d+$/.test(lines[j]) &&
           !/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(lines[j]) && !htmlBlockRe.test(lines[j]) &&
           !(lines[j].indexOf('|') >= 0 && j + 1 < lines.length && isSepLine(lines[j + 1]))) {
      para.push(inline(lines[j])); j++;
    }
    if (para.length) out.push('<p>' + para.join('<br>') + '</p>');
  }

  var html = out.join('');
  // math placeholders → KaTeX target elements (rendered by _docxRenderMath after insert)
  html = html.replace(/M(\d+)/g, function(_, n){ var m = mathBlocks[+n]; if (!m) return ''; var enc = encodeURIComponent(m.tex); return m.display ? '<div class="docx-math docx-math-block" data-tex="' + enc + '" contenteditable="false"></div>' : '<span class="docx-math docx-math-inline" data-tex="' + enc + '" contenteditable="false"></span>'; });
  html = html.replace(/C(\d+)/g, function(_, n){ return codeBlocks[+n] || ''; });
  // footnotes section
  if (footnoteOrder.length) {
    html += '<hr><ol class="docx-footnotes">';
    footnoteOrder.forEach(function(id){ html += '<li id="docx-fn-' + encodeURIComponent(id) + '">' + inline(footnotes[id] || '') + '</li>'; });
    html += '</ol>';
  }
  return html + '<p><br></p>';
};
}
// ── Convert raw markdown tables left inside an already-rendered editor ─────
if (!window._renderMdTables) {
window._renderMdTables = function(ed) {
  var isSepLine = function(s){ return /^\s*\|?[\s:|-]+\|?\s*$/.test(s) && /-/.test(s) && /\|/.test(s); };
  var splitCells = function(htmlLine){ return htmlLine.replace(/^\s*\|/,'').replace(/\|\s*$/,'').split('|').map(function(c){return c.trim();}); };
  var lineText = function(el){ return (el.textContent || '').trim(); };

  // Pass 0: a single block may hold the whole table as <br>-separated lines — split it.
  Array.prototype.slice.call(ed.children).forEach(function(el){
    var inner = el.innerHTML;
    if (!/<br\s*\/?>/i.test(inner)) return;
    var segs = inner.split(/<br\s*\/?>/i);
    var anySep = segs.some(function(s){ var d=document.createElement('div'); d.innerHTML=s; return isSepLine(d.textContent.trim()); });
    if (!anySep) return;
    var frag = document.createDocumentFragment();
    segs.forEach(function(s){ var p=document.createElement('p'); p.innerHTML = (s && s.trim()) ? s : '<br>'; frag.appendChild(p); });
    el.parentNode.replaceChild(frag, el);
  });

  // Pass 1: scan top-level <p>/<div> blocks for header + separator + rows (blank lines tolerated).
  var children = Array.prototype.slice.call(ed.children);
  var i = 0;
  while (i < children.length) {
    var el = children[i];
    var line = lineText(el);
    if (line && /\|/.test(line) && !isSepLine(line) && el.tagName && /^(P|DIV)$/i.test(el.tagName)) {
      var k = i + 1;
      while (k < children.length && lineText(children[k]) === '') k++;
      if (k < children.length && isSepLine(lineText(children[k]))) {
        var rows = [], lastIdx = k, m = k + 1;
        while (m < children.length) {
          var ml = lineText(children[m]);
          if (ml === '') { m++; continue; }
          if (/\|/.test(ml) && !isSepLine(ml) && children[m].tagName && /^(P|DIV)$/i.test(children[m].tagName)) {
            rows.push(children[m]); lastIdx = m; m++;
          } else break;
        }
        var head = splitCells(el.innerHTML);
        var t = '<table><tr>' + head.map(function(c){return '<th>'+c+'</th>';}).join('') + '</tr>';
        rows.forEach(function(r){ t += '<tr>' + splitCells(r.innerHTML).map(function(c){return '<td>'+c+'</td>';}).join('') + '</tr>'; });
        t += '</table>';
        var holder = document.createElement('div'); holder.innerHTML = t;
        var tableEl = holder.firstChild;
        ed.insertBefore(tableEl, el);
        for (var d = i; d <= lastIdx; d++) { if (children[d].parentNode) children[d].parentNode.removeChild(children[d]); }
        children = Array.prototype.slice.call(ed.children);
        i = Array.prototype.indexOf.call(children, tableEl) + 1;
        continue;
      }
    }
    i++;
  }
};
}
})();
