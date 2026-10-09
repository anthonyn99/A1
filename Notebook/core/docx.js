/* Notebook — the DOCX editor module (Word-style page editor) shared by every
   journal app. Moved verbatim from index.html (docs/Notebook/plan.md, Phase 1);
   the per-app config is registered through Notebook.registerDocx(). */
(function(){
'use strict';

/* ═══════════ HTML paste sanitizer (kept formatting, stripped junk) ═══════════ */
var KEEPTAGS = {A:1,ABBR:1,B:1,BLOCKQUOTE:1,BR:1,CAPTION:1,CODE:1,DIV:1,DL:1,DT:1,DD:1,DETAILS:1,SUMMARY:1,EM:1,FIGURE:1,FIGCAPTION:1,FONT:1,H1:1,H2:1,H3:1,H4:1,H5:1,H6:1,HR:1,I:1,IMG:1,INPUT:1,INS:1,DEL:1,KBD:1,LI:1,MARK:1,OL:1,P:1,PRE:1,S:1,SMALL:1,SPAN:1,STRIKE:1,STRONG:1,SUB:1,SUP:1,TABLE:1,TBODY:1,TD:1,TFOOT:1,TH:1,THEAD:1,TR:1,U:1,UL:1};
var KEEPATTR = {A:['href','target','rel'],IMG:['src','alt','width','height'],TD:['colspan','rowspan'],TH:['colspan','rowspan'],INPUT:['type','checked','class'],OL:['start'],FONT:['face','color','size'],UL:['class'],LI:['class'],SPAN:['class','data-tex','contenteditable'],DIV:['class','data-tex','contenteditable','align'],DETAILS:['open'],TH2:[]};
var KEEPCSS = ['font-family','font-size','font-weight','font-style','color','background-color','background','text-decoration','text-decoration-line','text-align','line-height','margin-left','text-indent','vertical-align','letter-spacing','width','height','border','border-collapse','padding'];
window._docxCleanHTML = function(html) {
  try {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    (function walk(node) {
      var kids = Array.prototype.slice.call(node.childNodes);
      kids.forEach(function(ch) {
        if (ch.nodeType === 8) { ch.parentNode.removeChild(ch); return; }
        if (ch.nodeType !== 1) return;
        var tag = ch.tagName;
        if (/^(SCRIPT|STYLE|META|LINK|TITLE|IFRAME|OBJECT|EMBED|FORM|SELECT|TEXTAREA|BUTTON|VIDEO|AUDIO)$/.test(tag)) { ch.parentNode.removeChild(ch); return; }
        walk(ch);
        if (!KEEPTAGS[tag]) {
          while (ch.firstChild) ch.parentNode.insertBefore(ch.firstChild, ch);
          ch.parentNode.removeChild(ch);
          return;
        }
        var styleVal = ch.getAttribute('style') || '';
        var allow = KEEPATTR[tag] || [];
        Array.prototype.slice.call(ch.attributes).forEach(function(at) {
          var n = at.name.toLowerCase();
          if (n !== 'style' && allow.indexOf(n) === -1) ch.removeAttribute(at.name);
        });
        if (tag === 'A') {
          var href = ch.getAttribute('href') || '';
          if (/^\s*javascript:/i.test(href)) ch.removeAttribute('href');
        }
        if (tag === 'IMG') {
          var src = ch.getAttribute('src') || '';
          if (!/^(data:image\/|https?:)/i.test(src)) { ch.parentNode.removeChild(ch); return; }
          ch.style.maxWidth = '100%';
        }
        if (styleVal) {
          var out = [];
          styleVal.split(';').forEach(function(d) {
            var ix = d.indexOf(':'); if (ix < 0) return;
            var prop = d.slice(0, ix).trim().toLowerCase();
            var val = d.slice(ix + 1).trim();
            if (KEEPCSS.indexOf(prop) !== -1 && !/url\s*\(|expression|javascript/i.test(val)) out.push(prop + ':' + val);
          });
          if (tag === 'IMG') out.push('max-width:100%');
          if (out.length) ch.setAttribute('style', out.join(';'));
          else ch.removeAttribute('style');
        }
      });
    })(doc.body);
    return doc.body.innerHTML;
  } catch (e) {
    var d = document.createElement('div');
    d.textContent = html.replace(/<[^>]*>/g, '');
    return d.innerHTML;
  }
};

// The browser's "Save as PDF" dialog seeds its filename from the document title, so the
// printed page's <title> is the only lever we have on the saved file's name. Turn an entry
// title into a filename that matches it: spaces become underscores, and anything a file
// system would reject is dropped. If nothing legal survives, fall back to a concise name.
window._pdfFileName = function(title) {
  var t = String(title == null ? '' : title).trim();
  try { t = t.normalize('NFKD').replace(/[\u0300-\u036f]/g, ''); } catch (e) {}   // café → cafe, not caf
  t = t.replace(/[^A-Za-z0-9 ._()&,'+-]/g, ' ');   // illegal / exotic chars → space, so words stay separated
  t = t.replace(/\s+/g, '_').replace(/_+/g, '_');
  t = t.replace(/^[_.\-]+/, '').replace(/[_.\-]+$/, '');
  if (t.length > 100) t = t.slice(0, 100).replace(/[_.\-]+$/, '');
  // Windows refuses these as filenames whatever the extension.
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(t)) t = t + '_';
  return t || 'Untitled_Entry';
};

// For PDF export: text should print black by default. Editor text is light-on-dark, and
// copying within the editor inlines those light colors — which look gray on a white page.
// Strip inline text colors that are light or near-gray; keep clearly-intentional saturated colors.
window._docxPdfBlackText = function(html) {
  try {
    var d = document.createElement('div');
    d.innerHTML = html;
    // Strip editing-only UI (resize/delete handles) so they never appear in the printed PDF.
    d.querySelectorAll('.docx-math-resize, .docx-file-resize, .pg-img-resize-handle, .pg-img-del-handle').forEach(function(x) { x.remove(); });
    d.querySelectorAll('[style]').forEach(function(el) {
      var c = el.style.color;
      if (!c) return;
      var m = c.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
      var rgb;
      if (m) rgb = [+m[1], +m[2], +m[3]];
      else if (/^#([0-9a-f]{6})$/i.test(c)) rgb = [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
      else if (/^#([0-9a-f]{3})$/i.test(c)) rgb = [parseInt(c[1] + c[1], 16), parseInt(c[2] + c[2], 16), parseInt(c[3] + c[3], 16)];
      if (!rgb) return;
      var lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
      var max = Math.max(rgb[0], rgb[1], rgb[2]), min = Math.min(rgb[0], rgb[1], rgb[2]);
      var sat = max === 0 ? 0 : (max - min) / max;
      if (lum > 120 || sat < 0.18) {                    // light or grayish → print black
        el.style.color = '';
        if (!(el.getAttribute('style') || '').trim()) el.removeAttribute('style');
      }
    });
    return d.innerHTML;
  } catch (e) { return html; }
};
// Export/print page CSS that mirrors the on-screen page setup + margins exactly (item 9),
// so an exported PDF matches the preview whether margins are expanded or compressed.
window._docxExportPageCss = function (app) {
  try {
    var ps = psGet(app), m = marginsGet(app);
    var sizeName = ps.size === 'a4' ? 'A4' : (ps.size === 'legal' ? 'legal' : 'letter');
    var toIn = function (px) { return (Math.max(0, px) / 96).toFixed(3) + 'in'; };
    return '@page{ size:' + sizeName + (ps.orient === 'landscape' ? ' landscape' : '') +
           '; margin:' + toIn(m.mt) + ' ' + toIn(m.mr) + ' ' + toIn(m.mb) + ' ' + toIn(m.ml) + '; }' +
           'html,body{ margin:0 !important; padding:0 !important; max-width:none !important; width:auto !important; }' +
           '@media print{ body{ margin:0 !important; padding:0 !important; } }';
  } catch (e) { return ''; }
};
// KaTeX assets + a render pass for the print document, so every rendered math expression
// prints accurately (item 8) — covers both pre-rendered KaTeX HTML and bare data-tex placeholders.
window._docxExportMathHead = function () {
  return '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">' +
         '<script src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"><\/script>';
};
window._docxExportMathScript = function () {
  return '<script>(function(){function R(){if(!window.katex)return;' +
         'document.querySelectorAll(".docx-math[data-tex]").forEach(function(el){if(el.querySelector(".katex"))return;' +
         'var t="";try{t=decodeURIComponent(el.getAttribute("data-tex")||"");}catch(e){t=el.getAttribute("data-tex")||"";}' +
         'try{katex.render(t,el,{displayMode:el.classList.contains("docx-math-block"),throwOnError:false,output:"html"});}catch(e){el.textContent=t;}});}' +
         'if(window.katex)R();else{var n=0,iv=setInterval(function(){if(window.katex||n>60){clearInterval(iv);R();}n++;},50);}})();<\/script>';
};

// When pasting INTO an existing list item, flatten any pasted list wrappers so the
// content merges into the current bullet/number/checklist instead of doubling markers.
window._docxPasteListFix = function(html, edEl) {
  try {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return html;
    var n = sel.anchorNode; if (n && n.nodeType === 3) n = n.parentElement;
    var li = n && n.closest ? n.closest('li') : null;
    if (!li || (edEl && !edEl.contains(li))) return html;   // only when caret is in a list item
    var tmp = document.createElement('div');
    tmp.innerHTML = html;
    if (!tmp.querySelector('li')) return html;               // nothing list-like pasted
    var parts = Array.prototype.slice.call(tmp.querySelectorAll('li')).map(function(x) {
      // drop nested checkbox inputs; keep inline content only
      x.querySelectorAll('input').forEach(function(inp) { inp.remove(); });
      return x.innerHTML.trim();
    }).filter(Boolean);
    return parts.join('<br>');
  } catch (e) { return html; }
};

/* ═══════════ Math rendering (KaTeX, lazy-loaded from CDN) ═══════════ */
function _loadKatex() {
  if (window.katex) return Promise.resolve();
  if (window._docxKatexReady) return window._docxKatexReady;
  window._docxKatexReady = new Promise(function (resolve) {
    var css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css';
    document.head.appendChild(css);
    var s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js';
    s.onload = function () { resolve(); };
    s.onerror = function () { resolve(); };   // resolve anyway → fall back to raw LaTeX
    document.head.appendChild(s);
  });
  return window._docxKatexReady;
}
// Convert $…$ / $$…$$ math delimiters that appear as TEXT in an HTML string
// (e.g. from AI Format output) into .docx-math elements for KaTeX to render.
window._docxMathify = function (html) {
  html = html.replace(/\$\$([\s\S]+?)\$\$/g, function (_, tex) {
    return '<div class="docx-math docx-math-block" data-tex="' + encodeURIComponent(tex.trim()) + '" contenteditable="false"></div>';
  });
  html = html.replace(/\$([^$<>\n]+?)\$/g, function (m, tex) {
    if (/^[\d,.\s$]+$/.test(tex)) return m;   // skip currency like $120,000
    return '<span class="docx-math docx-math-inline" data-tex="' + encodeURIComponent(tex.trim()) + '" contenteditable="false"></span>';
  });
  return html;
};
// Render every .docx-math[data-tex] placeholder; also ensures KaTeX CSS is present
// so previously-saved math displays after an entry reload.
window._docxRenderMath = function (root) {
  var els = (root || document).querySelectorAll('.docx-math[data-tex]');
  if (!els.length) return;
  _loadKatex().then(function () {
    els.forEach(function (el) {
      if (el.getAttribute('data-rendered') === '1' && el.querySelector('.katex')) return;
      var tex = '';
      try { tex = decodeURIComponent(el.getAttribute('data-tex') || ''); } catch (e) { tex = el.getAttribute('data-tex') || ''; }
      try {
        if (window.katex) {
          window.katex.render(tex, el, { displayMode: el.classList.contains('docx-math-block'), throwOnError: false, output: 'html' });
          el.setAttribute('data-rendered', '1');
        } else { el.textContent = tex; }
      } catch (e) { el.textContent = tex; }
    });
  });
};

function _mathTex(el) { try { return decodeURIComponent(el.getAttribute('data-tex') || ''); } catch (e) { return el.getAttribute('data-tex') || ''; } }
function _docxCtxOf(el) { return ALLCTX.find(function (c) { return c.edEl.contains(el); }); }
// Clicking a rendered math element → Copy Raw / Edit / Un-render / Delete (item 15).
function mathCopyPop(mathEl) {
  var tex = _mathTex(mathEl);
  function copy(str) { try { navigator.clipboard.writeText(str); } catch (e) { var ta = document.createElement('textarea'); ta.value = str; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch (x) {} ta.remove(); } }
  showPop(mathEl, function (pop) {
    pop.appendChild(mi('Copy Raw', function () { copy(tex); docxToast('Copied raw LaTeX.'); }));
    pop.appendChild(mi('Edit', function () { mathEditPop(mathEl); }));
    pop.appendChild(mi('Un-render', function () { mathUnrender(mathEl); }));
    pop.appendChild(msep());
    pop.appendChild(mi('Delete', function () { var c = _docxCtxOf(mathEl); mathEl.remove(); if (c) fireInput(c.edEl); }));
  });
}
// Edit the LaTeX in a roomy, elegant modal with a live preview; Save re-renders, Discard cancels.
function mathEditPop(mathEl) {
  closePop();
  var display = mathEl.classList.contains('docx-math-block');
  var overlay = document.createElement('div');
  overlay.className = 'docx-matheditor-overlay';
  overlay.innerHTML =
    '<div class="docx-matheditor" role="dialog" aria-label="Edit math">' +
      '<div class="docx-matheditor-h">Edit math (LaTeX)</div>' +
      '<textarea class="docx-matheditor-ta" spellcheck="false"></textarea>' +
      '<div class="docx-matheditor-prev-label">Preview</div>' +
      '<div class="docx-matheditor-prev"></div>' +
      '<div class="docx-matheditor-row">' +
        '<button class="docx-matheditor-btn docx-matheditor-discard">Discard</button>' +
        '<button class="docx-matheditor-btn docx-matheditor-save">Save changes</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);
  var ta = overlay.querySelector('.docx-matheditor-ta');
  var prev = overlay.querySelector('.docx-matheditor-prev');
  if (window.docxTonyGrip) window.docxTonyGrip(ta, mathEl.closest('#tj-root') ? 'tj' : 'bj', 'mj.math', 'the LaTeX box');
  ta.value = _mathTex(mathEl);
  function renderPreview() {
    var tex = ta.value.trim();
    _loadKatex().then(function () {
      try { if (window.katex) { window.katex.render(tex, prev, { displayMode: display, throwOnError: false, output: 'html' }); } else { prev.textContent = tex; } }
      catch (e) { prev.textContent = tex; }
    });
  }
  function close() { overlay.remove(); document.removeEventListener('keydown', onKey, true); }
  function save() {
    mathEl.setAttribute('data-tex', encodeURIComponent(ta.value.trim()));
    mathEl.removeAttribute('data-rendered'); mathEl.innerHTML = '';
    var c = _docxCtxOf(mathEl);
    if (window._docxRenderMath) window._docxRenderMath(c ? c.edEl : (mathEl.parentNode || document));
    if (c) fireInput(c.edEl);
    close();
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
  }
  ta.addEventListener('input', renderPreview);
  overlay.querySelector('.docx-matheditor-save').addEventListener('click', save);
  overlay.querySelector('.docx-matheditor-discard').addEventListener('click', close);
  overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey, true);
  renderPreview();
  // focus WITHOUT selecting everything — put the caret at the end so typing edits, not replaces
  setTimeout(function () { ta.focus(); var n = ta.value.length; ta.setSelectionRange(n, n); }, 0);
}
// Convert a rendered element back to raw markdown text ($…$ / $$…$$).
function mathUnrender(mathEl) {
  var display = mathEl.classList.contains('docx-math-block');
  var raw = (display ? '$$' : '$') + _mathTex(mathEl) + (display ? '$$' : '$');
  var c = _docxCtxOf(mathEl);
  mathEl.parentNode.replaceChild(document.createTextNode(raw), mathEl);
  if (c) fireInput(c.edEl);
}

/* ═══════════ App / editor context registry ═══════════ */
var FONTS = ['Arial','Aptos','Calibri','Times New Roman','Georgia','Verdana','Tahoma','Trebuchet MS','Garamond','Cambria','Century Gothic','Franklin Gothic Medium','Segoe UI','Helvetica','Courier New','Consolas','Lucida Sans Unicode','Book Antiqua','Baskerville','Palatino Linotype','Brush Script MT','Lucida Handwriting','Segoe Script','Comic Sans MS','Monotype Corsiva'];
var SIZES = { letter: [816, 1056], a4: [794, 1123], legal: [816, 1344] };
var MARGINS = { normal: [96,96,96,96], narrow: [48,48,48,48], moderate: [96,72,96,72], wide: [96,192,96,192] };
var ZOOMS = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

// Each app registers its editor config: Notebook.registerDocx(app, cfg).
var APPS = window.Notebook.docxApps;
var AI_FORMAT_ENDPOINT = 'https://personal-ai.av1.workers.dev/journal/format';   // consolidated worker (one Gemini key per person across all personal AI)

function $(id) { return document.getElementById(id); }
function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function lsGet(k, dflt) { try { var v = localStorage.getItem(k); return v == null ? dflt : JSON.parse(v); } catch (e) { return dflt; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
function fireInput(ed) { try { ed.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {} }

/* ═══════════ Popup helper ═══════════ */
var openPop = null;
function closePop() {
  if (openPop) {
    if (openPop._btn) openPop._btn.classList.remove('open');
    openPop.remove();
    openPop = null;
  }
}
document.addEventListener('pointerdown', function(e) {
  if (openPop && !openPop.contains(e.target) && e.target !== openPop._btn && !(openPop._btn && openPop._btn.contains(e.target))) closePop();
}, true);
document.addEventListener('keydown', function(e) { if (e.key === 'Escape') closePop(); });
function showPop(anchor, build, opts) {
  closePop();
  var pop = document.createElement('div');
  pop.className = 'docx-pop';
  if (opts && opts.cls) pop.className += ' ' + opts.cls;
  build(pop);
  // keep editor selection alive while interacting with the pop (inputs excepted)
  pop.addEventListener('pointerdown', function(e) {
    var t = e.target;
    if (t.tagName !== 'INPUT' && t.tagName !== 'SELECT') e.preventDefault();
  });
  document.body.appendChild(pop);
  var r = anchor.getBoundingClientRect();
  var pw = pop.offsetWidth, ph = pop.offsetHeight;
  var left = Math.max(6, Math.min(r.left, window.innerWidth - pw - 8));
  var top = r.bottom + 4;
  if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 4);
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
  pop._btn = anchor;
  anchor.classList.add('open');
  openPop = pop;
  return pop;
}
function mi(label, fn, key, chk) {
  var b = document.createElement('button');
  b.className = 'docx-mi';
  b.innerHTML = (chk !== undefined ? '<span class="chk">' + (chk ? '✓' : '') + '</span>' : '') + esc(label) + (key ? '<span class="k">' + esc(key) + '</span>' : '');
  b.addEventListener('click', function() { closePop(); fn(); });
  return b;
}
function msep() { var d = document.createElement('div'); d.className = 'docx-msep'; return d; }
function mlabel(t) { var d = document.createElement('div'); d.className = 'docx-mlabel'; d.textContent = t; return d; }

/* ═══════════ Selection helpers ═══════════ */
function savedSelFor(ctx) { return ctx._savedSel || null; }
function saveSel(ctx) {
  var s = window.getSelection();
  if (s && s.rangeCount && ctx.edEl.contains(s.anchorNode)) ctx._savedSel = s.getRangeAt(0).cloneRange();
}
function restoreSel(ctx) {
  // Read the saved range BEFORE focus() — focusing fires the editor's focus listener
  // which calls saveSel and would otherwise overwrite _savedSel with a collapsed range.
  var r = savedSelFor(ctx);
  // Batch 11 #2: pin the scroll position across the edit. focus() + execCommand +
  // DOM insertion all scroll the caret into view (jumping a scrolled-down page to the
  // top). Capture scrollTop now, focus WITHOUT scrolling, and re-pin — synchronously and
  // again next frame — so the follow-up edit that runs after this call can't move the page.
  var wrap = ctx.wrapEl, st = wrap ? wrap.scrollTop : null;
  try { ctx.edEl.focus({ preventScroll: true }); } catch (e) { ctx.edEl.focus(); }
  if (r) {
    var s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }
  if (wrap && st != null) {
    if (wrap.scrollTop !== st) wrap.scrollTop = st;
    requestAnimationFrame(function () { if (wrap && Math.abs(wrap.scrollTop - st) > 1) wrap.scrollTop = st; });
  }
}
function exec(ctx, cmd, val) {
  restoreSel(ctx);
  document.execCommand(cmd, false, val || null);
  saveSel(ctx);
  fireInput(ctx.edEl);
}
function insertHTML(ctx, html) { exec(ctx, 'insertHTML', html); }
function closestInEd(ctx, selector) {
  var s = window.getSelection();
  if (!s || !s.rangeCount) return null;
  var n = s.anchorNode;
  if (!n || !ctx.edEl.contains(n)) return null;
  if (n.nodeType === 3) n = n.parentElement;
  var hit = n && n.closest ? n.closest(selector) : null;
  return (hit && ctx.edEl.contains(hit)) ? hit : null;
}
function selBlocks(ctx) {
  var s = window.getSelection();
  if (!s || !s.rangeCount || !ctx.edEl.contains(s.anchorNode)) return [];
  var range = s.getRangeAt(0);
  var blocks = [];
  ctx.edEl.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,div,blockquote,pre').forEach(function(b) {
    try { if (range.intersectsNode(b)) blocks.push(b); } catch (e) {}
  });
  if (!blocks.length) {
    var n = s.anchorNode;
    if (n && n.nodeType === 3) n = n.parentElement;
    while (n && n !== ctx.edEl && !/^(P|H[1-6]|LI|DIV|BLOCKQUOTE|PRE)$/.test(n.tagName)) n = n.parentElement;
    if (n && n !== ctx.edEl) blocks.push(n);
  }
  // innermost only: drop blocks that contain other collected blocks
  return blocks.filter(function(b) { return !blocks.some(function(o) { return o !== b && b.contains(o); }); });
}
function setBlockStyle(ctx, prop, val, toggle) {
  restoreSel(ctx);
  var blocks = selBlocks(ctx);
  blocks.forEach(function(b) {
    if (toggle && b.style[prop] === val) b.style[prop] = '';
    else b.style[prop] = val;
  });
  fireInput(ctx.edEl);
}

/* ═══════════ Undo / Redo history (self-contained per editor) ═══════════
   document.execCommand('undo') is unreliable once innerHTML is set programmatically
   (entry load, paste, AI format), so each editor keeps its own snapshot stack. */
function caretOffset(ed) {
  var sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  var range = sel.getRangeAt(0);
  if (!ed.contains(range.endContainer)) return null;
  var pre = range.cloneRange();
  pre.selectNodeContents(ed);
  try { pre.setEnd(range.endContainer, range.endOffset); } catch (e) { return null; }
  return pre.toString().length;
}
function setCaret(ed, offset) {
  if (offset == null) return;
  var walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT, null);
  var remaining = offset, node;
  while ((node = walker.nextNode())) {
    if (node.nodeValue.length >= remaining) {
      var r = document.createRange();
      r.setStart(node, remaining); r.collapse(true);
      var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      return;
    }
    remaining -= node.nodeValue.length;
  }
  var r2 = document.createRange();
  r2.selectNodeContents(ed); r2.collapse(false);
  var s2 = window.getSelection(); s2.removeAllRanges(); s2.addRange(r2);
}
/* ── Undo-snapshot image interning (memory) ──────────────────────────────
 * Every undo state is a full copy of the editor's HTML, and a page's images
 * live INSIDE that HTML as base64. So a page holding 3 MB of pictures cost
 * 3 MB per snapshot — up to 400 of them — which is how a long editing session
 * on an illustrated page could climb past a gigabyte and get the tab killed.
 * Snapshots now keep each distinct image ONCE, in a shared table, and carry a
 * short private-use token in its place. Exact round trip; text-only pages are
 * untouched (the fast path returns the string as it came). */
var _HX = { list: [], byKey: new Map() };
function _hxKey(m) {
  var h = 0, step = Math.max(1, Math.floor(m.length / 256));
  for (var i = 0; i < m.length; i += step) h = (Math.imul(31, h) + m.charCodeAt(i)) | 0;
  return m.length + ':' + h;
}
function hcompact(html) {
  if (!html || html.length < 16000 || html.indexOf('data:') < 0 || html.indexOf('\uE001') >= 0) return html;
  return html.replace(/data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+\/=]{4000,}/gi, function (m) {
    var k = _hxKey(m), ids = _HX.byKey.get(k), i;
    if (ids) for (i = 0; i < ids.length; i++) if (_HX.list[ids[i]] === m) return '\uE001' + ids[i] + '\uE002';
    var n = _HX.list.push(m) - 1;
    if (ids) ids.push(n); else _HX.byKey.set(k, [n]);
    return '\uE001' + n + '\uE002';
  });
}
function hexpand(html) {
  if (!html || html.indexOf('\uE001') < 0) return html;
  return html.replace(/\uE001(\d+)\uE002/g, function (m, i) { return _HX.list[+i] || ''; });
}
function makeHistory(ctx) {
  var stack = [], idx = -1, lastT = 0, obs = null, pending = null, persistT = null;
  // Remote patches (OurJournal): each is fn(state)→state carrying the other
  // person's change into an older undo state, so Ctrl+Z walks back YOUR steps
  // and never quietly reverts what the other person just typed. A state holds
  // `rv`, the patch count when it was taken; materialize() replays the rest.
  var patches = [], patchBase = 0;
  function snap() { return { html: hcompact(ctx.edEl.innerHTML), caret: caretOffset(ctx.edEl), rv: patchBase + patches.length }; }
  function materialize(st) {
    var h = st.html;
    for (var i = Math.max(0, (st.rv || 0) - patchBase); i < patches.length; i++) h = patches[i](h);
    return h;
  }
  function seed() { patches = []; patchBase = 0; stack = [snap()]; idx = 0; updateBtns(); }
  // ── Cross-session persistence (item 13): while open we keep the full stack in memory;
  //    we also mirror a small window (current ± 2 states) to localStorage so undo/redo
  //    survives close+reopen. Docs whose snapshots are huge (big embedded images) are skipped.
  function histKey() { return ctx._docId ? ('docx_hist_' + ctx.app + '_' + ctx._docId) : null; }
  // Budgets. There is ONE history key per document and they were never cleaned
  // up, while the only limit was 900KB PER KEY — so six open-and-forgotten
  // documents could claim more than the origin's entire ~5MB localStorage
  // budget by themselves. That budget is shared by every A1 app, so the app
  // that finally overflowed it was usually not the one hoarding: Vault started
  // throwing QuotaExceededError on its own tiny key and its Save button went
  // dead, while the space was actually held by months-old journal undo stacks.
  var HIST_MAX_KEY = 120000;    // one document's slice — 5 states, ample
  var HIST_MAX_TOTAL = 600000;  // all documents combined

  // Drop the least-recently-written histories until the total fits. Losing an
  // old undo stack costs a stale document its cross-session undo; letting it
  // grow costs every app on the origin its ability to write anything.
  function pruneHistories(keepKey) {
    try {
      var rows = [], i, k, v, t;
      for (i = 0; i < localStorage.length; i++) {
        k = localStorage.key(i);
        if (!k || k.indexOf('docx_hist_') !== 0) continue;
        v = localStorage.getItem(k) || '';
        t = 0; try { t = (JSON.parse(v) || {}).t || 0; } catch (e) {}
        rows.push({ k: k, n: v.length, t: t });
      }
      var total = 0;
      for (i = 0; i < rows.length; i++) total += rows[i].n;
      if (total <= HIST_MAX_TOTAL) return;
      rows.sort(function (a, b) { return a.t - b.t; });   // oldest first; no stamp = oldest
      for (i = 0; i < rows.length && total > HIST_MAX_TOTAL; i++) {
        if (rows[i].k === keepKey) continue;
        try { localStorage.removeItem(rows[i].k); total -= rows[i].n; } catch (e) {}
      }
    } catch (e) {}
  }

  // ── Delta encoding (v2) ───────────────────────────────────────────────────
  // The window is five consecutive states of the SAME document, differing by a
  // keystroke or two, and every one used to be stored as a FULL copy of the
  // HTML. So a 150KB journal entry cost ~750KB — which is what a single real
  // key measured at. Embedded images made it worse: the same base64 blob was
  // written five times over.
  //
  // Store the first state whole, then each next one as (shared prefix length,
  // shared suffix length, changed middle). Reconstruction is exact.
  //
  // Surrogate safety: prefix/suffix lengths are code-unit counts, so a boundary
  // could land between the halves of an emoji and slice() would split it. Both
  // ends are nudged off a lone surrogate before use.
  function _histCommon(a, b) {
    var lim = Math.min(a.length, b.length), p = 0, s = 0;
    while (p < lim && a.charCodeAt(p) === b.charCodeAt(p)) p++;
    // don't end the prefix on a high surrogate whose pair is about to differ
    if (p > 0 && p < a.length) { var c = a.charCodeAt(p - 1); if (c >= 0xD800 && c <= 0xDBFF) p--; }
    while (s < lim - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
    // don't start the suffix on a low surrogate
    if (s > 0) { var d = a.charCodeAt(a.length - s); if (d >= 0xDC00 && d <= 0xDFFF) s--; }
    return { p: p, s: s };
  }
  function encodeHist(slice, relIdx) {
    var d = [], i, k;
    for (i = 1; i < slice.length; i++) {
      k = _histCommon(slice[i - 1].html, slice[i].html);
      d.push({ p: k.p, s: k.s, m: slice[i].html.slice(k.p, slice[i].html.length - k.s) });
    }
    return {
      v: 2, t: Date.now(), idx: relIdx,
      base: slice.length ? slice[0].html : '',
      d: d,
      c: slice.map(function (x) { return x.caret; })
    };
  }
  function decodeHist(data) {
    if (!data) return null;
    if (data.v !== 2) return (data.stack && data.stack.length) ? data.stack : null;  // legacy v1
    var htmls = [data.base || ''], i, prev, k;
    for (i = 0; i < (data.d || []).length; i++) {
      prev = htmls[i]; k = data.d[i];
      htmls.push(prev.slice(0, k.p) + k.m + prev.slice(prev.length - k.s));
    }
    return htmls.map(function (h, j) { return { html: h, caret: (data.c || [])[j] }; });
  }

  function persist() {
    var key = histKey(); if (!key) return;
    try {
      var lo = Math.max(0, idx - 2), hi = Math.min(stack.length, idx + 3);
      var slice = stack.slice(lo, hi).map(function (x) { return { html: hexpand(materialize(x)), caret: x.caret }; });
      // `t` (inside the payload) is what pruneHistories() sorts on — without it
      // every key looks equally old and eviction order is arbitrary.
      var payload = JSON.stringify(encodeHist(slice, idx - lo));
      if (payload.length > HIST_MAX_KEY) { localStorage.removeItem(key); return; }
      localStorage.setItem(key, payload);
      pruneHistories(key);
    } catch (e) {
      // Full: drop this document's history, then make room for next time.
      try { localStorage.removeItem(histKey()); } catch (x) {}
      pruneHistories(histKey());
    }
  }
  function schedulePersist() { clearTimeout(persistT); persistT = setTimeout(persist, 600); }
  function loadPersisted(docId) {
    ctx._docId = docId || ctx.edEl.id;
    var key = histKey(); if (!key) return;
    try {
      var data = JSON.parse(localStorage.getItem(key) || 'null');
      // decodeHist rebuilds a v2 delta payload and passes a v1 array straight
      // through, so histories written before this change still load.
      var saved = decodeHist(data);
      if (!saved || !saved.length) return;
      var savedIdx = Math.min(data.idx | 0, saved.length - 1);
      if (savedIdx < 0) savedIdx = 0;
      // Reconcile with what actually loaded. The stack is only usable if the document
      // came back EXACTLY as this history last left it — same lineage, so undo walks
      // the user's own steps.
      //
      // It used to push the loaded content on top of a divergent stack instead, and
      // that quietly destroyed work: content that had changed elsewhere (edited on
      // another device, merged from the server, rehydrated images) sat above states
      // belonging to a different lineage, so ONE Ctrl+Z jumped to a version from a
      // previous session and autoSave immediately published it over the current one.
      // A divergent stack is worth nothing next to that risk — start fresh.
      if (saved[savedIdx].html !== ctx.edEl.innerHTML) { try { localStorage.removeItem(key); } catch (e) {} seed(); return; }
      patches = []; patchBase = 0;
      stack = saved.map(function (x) { return { html: hcompact(x.html), caret: x.caret, rv: 0 }; }); idx = savedIdx;
      updateBtns();
    } catch (e) {}
  }
  function syncBase() {
    if (idx < 0 || !stack[idx] || materialize(stack[idx]) !== hcompact(ctx.edEl.innerHTML)) seed();
  }
  function record(force) {
    if (ctx._histSuppress) return;
    if (idx < 0) { seed(); return; }
    var html = hcompact(ctx.edEl.innerHTML);
    if (stack[idx] && materialize(stack[idx]) === html) { stack[idx] = { html: html, caret: caretOffset(ctx.edEl), rv: patchBase + patches.length }; return; }
    var now = Date.now();
    if (!force && now - lastT < 500) { stack[idx] = snap(); lastT = now; updateBtns(); return; }  // coalesce fast typing
    stack = stack.slice(0, idx + 1);
    stack.push(snap());
    if (stack.length > 400) stack.shift();
    idx = stack.length - 1;
    lastT = now;
    updateBtns();
    schedulePersist();
  }
  function apply(s) {
    ctx._histSuppress = true;
    ctx.edEl.innerHTML = hexpand(materialize(s));
    // The wrappers this just recreated are inert until rebound — see
    // _docxRebindImages. Without this, one Ctrl+Z kills every image control.
    if (window._docxRebindImages) window._docxRebindImages(ctx.edEl, ctx.app);
    ctx.edEl.focus();
    setCaret(ctx.edEl, s.caret);
    fireInput(ctx.edEl);           // triggers autoSave; recording is suppressed
    // release suppression on the next tick so the observer's queued records are dropped
    setTimeout(function () { ctx._histSuppress = false; updateBtns(); }, 0);
    schedulePersist();
  }
  function updateBtns() {
    if (ctx.undoBtn) ctx.undoBtn.classList.toggle('pt-disabled', !(idx > 0));
    if (ctx.redoBtn) ctx.redoBtn.classList.toggle('pt-disabled', !(idx < stack.length - 1));
  }
  // A MutationObserver captures EVERY DOM change (typing, execCommand, surroundContents,
  // paste, drag, AI format) so undo/redo works for any edit, not just 'input' events.
  function start() {
    if (obs) return;
    obs = new MutationObserver(function () {
      if (ctx._histSuppress) return;
      clearTimeout(pending);
      pending = setTimeout(function () { record(false); }, 260);
    });
    obs.observe(ctx.edEl, { childList: true, subtree: true, characterData: true, attributes: true });
  }
  return {
    seed: seed, syncBase: syncBase, record: record, start: start,
    canUndo: function () { return idx > 0; },
    canRedo: function () { return idx < stack.length - 1; },
    undo: function () { clearTimeout(pending); syncBase(); if (idx > 0) { idx--; apply(stack[idx]); } },
    redo: function () { clearTimeout(pending); if (idx < stack.length - 1) { idx++; apply(stack[idx]); } },
    commit: function () { clearTimeout(pending); record(true); },   // force a discrete step (AI format, etc.)
    refresh: updateBtns,
    loadPersisted: loadPersisted, persist: persist,
    // The editor just changed from `before` to `after` because of someone
    // else's edit. Older states get that same change applied lazily.
    remotePatch: function (before, after) {
      var merge = window.OJ && window.OJ.mergeText;
      clearTimeout(pending);
      if (!merge || idx < 0) { seed(); return; }
      var b = hcompact(before), a = hcompact(after);
      patches.push(function (h) { return merge(b, h, a); });
      if (patches.length > 40) {
        // Too far back to replay cheaply: states that would need the dropped
        // patch are dropped with it.
        patches.shift(); patchBase++;
        var cut = 0;
        while (cut < stack.length && (stack[cut].rv || 0) < patchBase) cut++;
        if (cut > idx) { seed(); return; }
        stack = stack.slice(cut); idx -= cut;
      }
      stack[idx] = snap();
      updateBtns();
    }
  };
}

/* ═══════════ Page setup + zoom + view mode ═══════════ */
function psGet(app) { return lsGet('docx_ps_' + app, { size: 'letter', orient: 'portrait', margin: 'normal' }); }
function applyPageSetup(app) {
  var cfg = APPS[app], ps = psGet(app);
  var dim = SIZES[ps.size] || SIZES.letter;
  var pw = ps.orient === 'landscape' ? dim[1] : dim[0];
  var ph = ps.orient === 'landscape' ? dim[0] : dim[1];
  var m = marginsGet(app);
  cfg.ctxs.forEach(function(c) {
    var wrap = $(c.wrap);
    if (!wrap) return;
    wrap.style.setProperty('--docx-pw', pw + 'px');
    wrap.style.setProperty('--docx-ph', ph + 'px');
    wrap.style.setProperty('--docx-mt', m.mt + 'px');
    wrap.style.setProperty('--docx-mr', m.mr + 'px');
    wrap.style.setProperty('--docx-mb', m.mb + 'px');
    wrap.style.setProperty('--docx-ml', m.ml + 'px');
    wrap.style.setProperty('--docx-pi', (ph - m.mt - m.mb) + 'px');
  });
  applyZoom(app);
  updateRulers(app);
}
// Default to fit-width below ~1200px: a letter page (816px) plus the sidebar
// does not fit an iPad Pro portrait, so 100% would open with the page cut off.
function zGet(app) { return lsGet('docx_zoom_' + app, (window.innerWidth < 1200 ? 'fit' : 1)); }
function applyZoom(app) {
  var cfg = APPS[app], z = zGet(app), ps = psGet(app);
  var dim = SIZES[ps.size] || SIZES.letter;
  var pw = ps.orient === 'landscape' ? dim[1] : dim[0];
  cfg.ctxs.forEach(function(c) {
    var wrap = $(c.wrap);
    if (!wrap) return;
    // Reflow sizes the sheet to the container in CSS — zooming on top of that
    // would shrink the text all over again.
    if (wrap.classList.contains('docx-reflow')) { wrap.style.setProperty('--docx-zoom', 1); return; }
    var zi = z;
    if (z === 'fit') {
      var avail = (wrap.clientWidth || window.innerWidth) - 30;
      zi = Math.max(0.4, Math.min(1.5, avail / pw));
    }
    wrap.style.setProperty('--docx-zoom', zi);
  });
  updateRulers(app);
  // sync all zoom selects for this app
  cfg.ctxs.forEach(function(c) {
    var tb = $(c.tb);
    if (!tb) return;
    var sel = tb.querySelector('.docx-zoom-sel');
    if (sel) sel.value = String(z);
  });
}
function setZoom(app, z) { lsSet('docx_zoom_' + app, z); applyZoom(app); }
// View mode: continuous ("web") only — no paginated slits, no Pages/Web switcher.

function applyViewMode(app) {
  var cfg = APPS[app];
  cfg.ctxs.forEach(function(c) { var wrap = $(c.wrap); if (wrap) wrap.classList.remove('docx-pages'); });
}


/* ═══════════ Margins (custom + draggable, default 1 inch) ═══════════ */
// Stored PER-PAGE on the active entry (entry.data.margins), synced via Firebase,
// so dragging a margin only affects THAT page — not every page. Each app exposes
// _<app>GetPageMargins / _<app>SetPageMargins hooks over its own entry state.
function _pageMarginsHook(app, which) {
  return window['_' + app + which];   // e.g. window._tjGetPageMargins
}
function marginsGet(app) {
  var getFn = _pageMarginsHook(app, 'GetPageMargins');
  if (getFn) {
    try { var saved = getFn(); if (saved && typeof saved.ml === 'number') return saved; } catch (e) {}
  }
  var ps = psGet(app);
  var preset = MARGINS[ps.margin] || MARGINS.normal;
  return { mt: preset[0], mr: preset[1], mb: preset[2], ml: preset[3] };
}
function marginsSet(app, m) {
  var setFn = _pageMarginsHook(app, 'SetPageMargins');
  if (setFn) { try { setFn(m); } catch (e) {} }
  applyPageSetup(app);
}

function _pageWidth(app) {
  var ps = psGet(app), dim = SIZES[ps.size] || SIZES.letter;
  return ps.orient === 'landscape' ? dim[1] : dim[0];
}
function _zoomFactor(app, wrap) {
  var z = zGet(app);
  if (z === 'fit' && wrap) return Math.max(0.4, Math.min(1.5, ((wrap.clientWidth || window.innerWidth) - 30) / _pageWidth(app)));
  return z === 'fit' ? 1 : z;
}

/* ═══════════ Ruler (draggable margins) ═══════════ */
function buildRuler(ctx) {
  var tb = ctx.tbEl;
  if (!tb || !tb.parentNode) return;
  var ruler = document.createElement('div');
  ruler.className = 'docx-ruler';
  ruler.innerHTML = '<div class="docx-ruler-in"><div class="docx-ruler-page"></div>' +
    '<div class="docx-ruler-marg left" title="Drag to set the left margin"></div>' +
    '<div class="docx-ruler-marg right" title="Drag to set the right margin"></div></div>';
  tb.parentNode.insertBefore(ruler, tb.nextSibling);
  ctx.rulerEl = ruler;

  var leftH = ruler.querySelector('.docx-ruler-marg.left');
  var rightH = ruler.querySelector('.docx-ruler-marg.right');
  function startDrag(handle, side) {
    // Double-click a margin handle → reset that side to 1 inch (96px)
    handle.addEventListener('dblclick', function(e) {
      e.preventDefault();
      var nm = marginsGet(ctx.app);
      if (side === 'left') nm.ml = 96; else nm.mr = 96;
      marginsSet(ctx.app, nm);
    });
    handle.addEventListener('pointerdown', function(e) {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('drag');
      var wrap = $(ctx.wrap);
      var zi = _zoomFactor(ctx.app, wrap);
      var pw = _pageWidth(ctx.app);
      var startX = e.clientX;
      var m = marginsGet(ctx.app);
      var startVal = side === 'left' ? m.ml : m.mr;
      function onMove(ev) {
        var deltaPx = (ev.clientX - startX) / (zi || 1);
        var next = side === 'left' ? startVal + deltaPx : startVal - deltaPx;
        // clamp: 0.25in .. leave at least 1.5in of writable width
        next = Math.max(24, Math.min(next, pw - (side === 'left' ? m.mr : m.ml) - 144));
        // snap to 1 inch (96px) when within ~10px — the default reset point
        if (Math.abs(next - 96) < 10) next = 96;
        var nm = marginsGet(ctx.app);
        if (side === 'left') nm.ml = Math.round(next); else nm.mr = Math.round(next);
        marginsSet(ctx.app, nm);
      }
      function onUp() {
        handle.classList.remove('drag');
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
      }
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
  }
  startDrag(leftH, 'left');
  startDrag(rightH, 'right');
}
/* Vertical ruler — draggable TOP / BOTTOM margins (Batch 11 #1), mirroring the
   horizontal ruler but along the left edge of the page. Lives inside the scroll
   wrap so it stays glued to the sheet as the page scrolls. */
function buildVRuler(ctx) {
  var wrap = ctx.wrapEl;
  if (!wrap) return;
  var ruler = document.createElement('div');
  ruler.className = 'docx-vruler';
  ruler.innerHTML = '<div class="docx-vruler-page"></div>' +
    '<div class="docx-vruler-marg top" title="Drag to set the top margin"></div>' +
    '<div class="docx-vruler-marg bottom" title="Drag to set the bottom margin"></div>';
  wrap.appendChild(ruler);   // after the editor → CSS sibling selector shows it in edit mode
  ctx.vrulerEl = ruler;

  var topH = ruler.querySelector('.docx-vruler-marg.top');
  var botH = ruler.querySelector('.docx-vruler-marg.bottom');
  function startDrag(handle, side) {
    handle.addEventListener('dblclick', function(e) {
      e.preventDefault();
      var nm = marginsGet(ctx.app);
      if (side === 'top') nm.mt = 96; else nm.mb = 96;
      marginsSet(ctx.app, nm);
    });
    handle.addEventListener('pointerdown', function(e) {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('drag');
      var zi = _zoomFactor(ctx.app, wrap);
      var ph = _pageHeight(ctx.app);
      var startY = e.clientY;
      var m = marginsGet(ctx.app);
      var startVal = side === 'top' ? m.mt : m.mb;
      function onMove(ev) {
        var deltaPx = (ev.clientY - startY) / (zi || 1);
        var next = side === 'top' ? startVal + deltaPx : startVal - deltaPx;
        // clamp: 0 (text can reach the very top) .. leave at least 1.5in writable height
        var other = side === 'top' ? m.mb : m.mt;
        next = Math.max(0, Math.min(next, ph - other - 144));
        if (Math.abs(next - 96) < 10) next = 96;   // snap to the 1-inch default
        var nm = marginsGet(ctx.app);
        if (side === 'top') nm.mt = Math.round(next); else nm.mb = Math.round(next);
        marginsSet(ctx.app, nm);
      }
      function onUp() {
        handle.classList.remove('drag');
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
      }
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
  }
  startDrag(topH, 'top');
  startDrag(botH, 'bottom');

  // Reposition as the sheet grows (typing) or the page scrolls — cheap, rAF-throttled.
  var pending = false;
  function reflow() { if (pending) return; pending = true; requestAnimationFrame(function() { pending = false; updateVRuler(ctx); }); }
  wrap.addEventListener('scroll', reflow, { passive: true });
  ctx.edEl.addEventListener('input', reflow);
}
function _pageHeight(app) {
  var ps = psGet(app), dim = SIZES[ps.size] || SIZES.letter;
  return ps.orient === 'landscape' ? dim[0] : dim[1];
}
// Re-measure the rulers for an app (called when edit mode turns on — the vertical
// ruler is display:none in view mode, so its geometry can only be read once shown).
window._docxRefreshRulers = function(app) {
  if (!APPS[app]) return;
  requestAnimationFrame(function() { try { updateRulers(app); } catch (e) {} });
};
function updateVRuler(ctx) {
  var ruler = ctx.vrulerEl; if (!ruler) return;
  var wrap = ctx.wrapEl, sheet = ctx.edEl;
  if (!wrap || !sheet) return;
  var wr = wrap.getBoundingClientRect(), sr = sheet.getBoundingClientRect();
  if (!sr.height) return;
  var topInWrap = sr.top - wr.top + wrap.scrollTop;
  var leftInWrap = sr.left - wr.left + wrap.scrollLeft;
  var H = sr.height;
  var zi = _zoomFactor(ctx.app, wrap);
  var m = marginsGet(ctx.app);
  ruler.style.top = topInWrap + 'px';
  ruler.style.left = Math.max(2, leftInWrap - ruler.offsetWidth - 5) + 'px';
  ruler.style.height = H + 'px';
  var mtPx = Math.round(m.mt * zi), mbPx = Math.round(m.mb * zi);
  var pageEl = ruler.querySelector('.docx-vruler-page');
  if (pageEl) { pageEl.style.top = mtPx + 'px'; pageEl.style.bottom = mbPx + 'px'; }
  var topH = ruler.querySelector('.docx-vruler-marg.top');
  var botH = ruler.querySelector('.docx-vruler-marg.bottom');
  if (topH) topH.style.top = mtPx + 'px';
  if (botH) botH.style.top = Math.max(mtPx + 24, H - mbPx) + 'px';
}
function updateRulers(app) {
  var cfg = APPS[app];
  var pw = _pageWidth(app);
  var m = marginsGet(app);
  cfg.ctxs.forEach(function(c) {
    if (!c._ctx) return;
    var wrap = $(c.wrap);
    var zi = _zoomFactor(app, wrap);
    if (c._ctx.rulerEl) {
      var inEl = c._ctx.rulerEl.querySelector('.docx-ruler-in');
      if (inEl) {
        var wPx = Math.round(pw * zi);
        inEl.style.width = wPx + 'px';
        var pageEl = inEl.querySelector('.docx-ruler-page');
        var lPx = Math.round(m.ml * zi), rPx = Math.round(m.mr * zi);
        if (pageEl) { pageEl.style.left = lPx + 'px'; pageEl.style.right = rPx + 'px'; }
        var leftH = inEl.querySelector('.docx-ruler-marg.left');
        var rightH = inEl.querySelector('.docx-ruler-marg.right');
        if (leftH) leftH.style.left = lPx + 'px';
        if (rightH) rightH.style.right = rPx + 'px';
      }
    }
    if (c._ctx.vrulerEl) updateVRuler(c._ctx);
  });
}

/* ═══════════ Table tools ═══════════ */
function curCell(ctx) { return closestInEd(ctx, 'td,th'); }
function curTable(ctx) { return closestInEd(ctx, 'table'); }
function cellIndex(cell) { return Array.prototype.indexOf.call(cell.parentNode.cells, cell); }
function tblInsertRow(ctx, below) {
  var cell = curCell(ctx); if (!cell) return;
  var row = cell.parentNode;
  var idx = row.rowIndex + (below ? 1 : 0);
  var table = row.closest('table');
  var nr = table.insertRow(idx);
  for (var i = 0; i < row.cells.length; i++) { var c = nr.insertCell(); c.innerHTML = '<br>'; }
  fireInput(ctx.edEl);
}
function tblInsertCol(ctx, right) {
  var cell = curCell(ctx); if (!cell) return;
  var idx = cellIndex(cell) + (right ? 1 : 0);
  var table = cell.closest('table');
  Array.prototype.forEach.call(table.rows, function(r) {
    var ref = r.cells[Math.min(idx, r.cells.length)] || null;
    var nc = document.createElement(r.cells[0] && r.cells[0].tagName === 'TH' ? 'th' : 'td');
    nc.innerHTML = '<br>';
    r.insertBefore(nc, ref);
  });
  fireInput(ctx.edEl);
}
function tblDeleteRow(ctx) {
  var cell = curCell(ctx); if (!cell) return;
  var row = cell.parentNode, table = row.closest('table');
  if (table.rows.length <= 1) { table.remove(); } else row.remove();
  fireInput(ctx.edEl);
}
function tblDeleteCol(ctx) {
  var cell = curCell(ctx); if (!cell) return;
  var idx = cellIndex(cell), table = cell.closest('table');
  if (table.rows[0] && table.rows[0].cells.length <= 1) { table.remove(); }
  else Array.prototype.forEach.call(table.rows, function(r) { if (r.cells[idx]) r.deleteCell(idx); });
  fireInput(ctx.edEl);
}
function tblDelete(ctx) { var t = curTable(ctx); if (t) { t.remove(); fireInput(ctx.edEl); } }
function tblToggleHeader(ctx) {
  var t = curTable(ctx); if (!t || !t.rows.length) return;
  var first = t.rows[0];
  var isTh = first.cells[0] && first.cells[0].tagName === 'TH';
  Array.prototype.forEach.call(first.cells, function(c) {
    var n = document.createElement(isTh ? 'td' : 'th');
    n.innerHTML = c.innerHTML;
    c.parentNode.replaceChild(n, c);
  });
  fireInput(ctx.edEl);
}
function insertTableHTML(ctx, rows, cols) {
  var html = '<table><tr>';
  for (var c = 0; c < cols; c++) html += '<th><br></th>';
  html += '</tr>';
  for (var r = 1; r < rows; r++) { html += '<tr>'; for (var c2 = 0; c2 < cols; c2++) html += '<td><br></td>'; html += '</tr>'; }
  html += '</table><p><br></p>';
  insertHTML(ctx, html);
}
function tableGridPop(ctx, anchor) {
  showPop(anchor, function(pop) {
    var lbl = document.createElement('div');
    lbl.className = 'docx-grid-lbl';
    lbl.textContent = 'Insert table';
    var grid = document.createElement('div');
    grid.className = 'docx-grid';
    var cells = [];
    for (var r = 1; r <= 8; r++) for (var c = 1; c <= 8; c++) {
      (function(r, c) {
        var sp = document.createElement('span');
        sp.addEventListener('pointerenter', function() {
          cells.forEach(function(o) { o.el.classList.toggle('on', o.r <= r && o.c <= c); });
          lbl.textContent = r + ' × ' + c;
        });
        sp.addEventListener('click', function() { closePop(); insertTableHTML(ctx, r, c); });
        cells.push({ el: sp, r: r, c: c });
        grid.appendChild(sp);
      })(r, c);
    }
    pop.appendChild(lbl);
    pop.appendChild(grid);
  });
}
/* Bubble shown while the caret is inside a table (rebuilt per show so ctx is always current) */
var tblBubble = null;
function hideTblBubble() { if (tblBubble) { tblBubble.remove(); tblBubble = null; } }
function maybeShowTblBubble(ctx) {
  var t = curTable(ctx);
  if (!t || ctx.edEl.contentEditable !== 'true') { hideTblBubble(); return; }
  hideTblBubble();
  tblBubble = document.createElement('div');
  tblBubble.className = 'docx-tbl-bubble';
  var ops = [
    ['+Row', function() { tblInsertRow(ctx, true); }],
    ['+Col', function() { tblInsertCol(ctx, true); }],
    ['−Row', function() { tblDeleteRow(ctx); }],
    ['−Col', function() { tblDeleteCol(ctx); }],
    ['Header', function() { tblToggleHeader(ctx); }],
    ['Delete table', function() { tblDelete(ctx); hideTblBubble(); }]
  ];
  ops.forEach(function(op) {
    var b = document.createElement('button');
    b.textContent = op[0];
    b.addEventListener('mousedown', function(e) { e.preventDefault(); });
    b.addEventListener('click', function() { op[1](); });
    tblBubble.appendChild(b);
  });
  document.body.appendChild(tblBubble);
  var r = t.getBoundingClientRect();
  tblBubble.style.left = Math.max(6, Math.min(r.left, window.innerWidth - tblBubble.offsetWidth - 8)) + 'px';
  tblBubble.style.top = Math.max(6, r.top - tblBubble.offsetHeight - 6) + 'px';
}

/* ═══════════ Find & Replace ═══════════ */
var FR = { panel: null, ctx: null, marks: [], cur: -1 };
function frClearMarks() {
  FR.marks.forEach(function(m) {
    if (!m.parentNode) return;
    var p = m.parentNode;
    while (m.firstChild) p.insertBefore(m.firstChild, m);
    p.removeChild(m);
    p.normalize();
  });
  FR.marks = [];
  FR.cur = -1;
}
function frClose(silent) {
  var hadMarks = FR.marks.length > 0;
  frClearMarks();
  if (FR.panel) { FR.panel.remove(); FR.panel = null; }
  if (hadMarks && FR.ctx && !silent) fireInput(FR.ctx.edEl);
  FR.ctx = null;
}
function frBuildRegex() {
  var q = FR.panel.querySelector('.f-find').value;
  if (!q) return null;
  var escq = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  var ww = FR.panel.querySelector('.f-ww').checked;
  if (ww) {
    if (/^\w/.test(q)) escq = '\\b' + escq;
    if (/\w$/.test(q)) escq = escq + '\\b';
  }
  var mc = FR.panel.querySelector('.f-mc').checked;
  try { return new RegExp(escq, mc ? 'g' : 'gi'); } catch (e) { return null; }
}
function frSearch(jumpTo) {
  if (!FR.panel || !FR.ctx) return;
  frClearMarks();
  var re = frBuildRegex();
  var cntEl = FR.panel.querySelector('.cnt');
  if (!re) { cntEl.textContent = '0 / 0'; return; }
  var walker = document.createTreeWalker(FR.ctx.edEl, NodeFilter.SHOW_TEXT, null);
  var nodes = [];
  var n;
  while ((n = walker.nextNode())) {
    if (n.parentElement && n.parentElement.closest('.pg-img-wrap')) continue;
    nodes.push(n);
  }
  nodes.forEach(function(tn) {
    var text = tn.nodeValue;
    var matches = [];
    var m;
    re.lastIndex = 0;
    while ((m = re.exec(text))) {
      if (!m[0].length) break;
      matches.push([m.index, m[0].length]);
    }
    if (!matches.length) return;
    // split from the end so offsets stay valid
    for (var i = matches.length - 1; i >= 0; i--) {
      var st = matches[i][0], len = matches[i][1];
      var tail = tn.splitText(st + len);
      var mid = tn.splitText(st);
      var mark = document.createElement('mark');
      mark.className = 'docx-find-hit';
      mid.parentNode.insertBefore(mark, mid);
      mark.appendChild(mid);
      FR.marks.unshift(mark);
    }
  });
  cntEl.textContent = FR.marks.length ? '1 / ' + FR.marks.length : '0 / 0';
  if (FR.marks.length) frJump(typeof jumpTo === 'number' ? jumpTo : 0);
}
function frJump(i) {
  if (!FR.marks.length) return;
  if (FR.cur >= 0 && FR.marks[FR.cur]) FR.marks[FR.cur].classList.remove('cur');
  FR.cur = ((i % FR.marks.length) + FR.marks.length) % FR.marks.length;
  var m = FR.marks[FR.cur];
  m.classList.add('cur');
  // Scroll ONLY the editor's own scroll container — never bubble to the window/header,
  // which was pushing the whole UI up and cutting off the top.
  var wrap = FR.ctx && FR.ctx.wrapEl;
  if (wrap && wrap.scrollHeight > wrap.clientHeight) {
    var mr = m.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
    wrap.scrollTop += (mr.top + mr.height / 2) - (wr.top + wr.height / 2);
  } else if (m.scrollIntoView) {
    m.scrollIntoView({ block: 'nearest' });
  }
  FR.panel.querySelector('.cnt').textContent = (FR.cur + 1) + ' / ' + FR.marks.length;
}
function frReplaceCur() {
  if (FR.cur < 0 || !FR.marks[FR.cur]) return;
  var rep = FR.panel.querySelector('.f-rep').value;
  var m = FR.marks[FR.cur];
  m.replaceWith(document.createTextNode(rep));
  fireInput(FR.ctx.edEl);
  var next = FR.cur;
  FR.marks.splice(FR.cur, 1);
  FR.cur = -1;
  FR.marks.forEach(function(x) { x.classList.remove('cur'); });
  if (FR.marks.length) frJump(next);
  else FR.panel.querySelector('.cnt').textContent = '0 / 0';
}
function frReplaceAll() {
  var rep = FR.panel.querySelector('.f-rep').value;
  if (!FR.marks.length) return;
  FR.marks.forEach(function(m) { m.replaceWith(document.createTextNode(rep)); });
  FR.marks = [];
  FR.cur = -1;
  FR.ctx.edEl.normalize();
  FR.panel.querySelector('.cnt').textContent = '0 / 0';
  fireInput(FR.ctx.edEl);
}
function frOpen(ctx, withReplace) {
  var sel = window.getSelection();
  var seed = (sel && !sel.isCollapsed && ctx.edEl.contains(sel.anchorNode)) ? sel.toString().slice(0, 80) : '';
  frClose(true);
  FR.ctx = ctx;
  // Fixed-position overlay on <body> so it never shifts/cuts off the page layout.
  var p = document.createElement('div');
  p.className = 'docx-find';
  p.innerHTML =
    '<div class="docx-find-head"><span class="docx-find-title">' + (withReplace ? 'Find &amp; Replace' : 'Find') + '</span>' +
    '<button class="x" title="Close (Esc)">' + window.TNI.x + '</button></div>' +
    '<div class="row"><span class="docx-find-ico">' + svg(IC.find, 14) + '</span>' +
    '<input type="text" class="f-find" placeholder="Find in document…">' +
    '<button class="f-prev" title="Previous (Shift+Enter)">' + window.TNI.arrowUp + '</button><button class="f-next" title="Next (Enter)">' + window.TNI.arrowDown + '</button>' +
    '<span class="cnt">0 / 0</span></div>' +
    '<div class="row f-reprow"><span class="docx-find-ico">' + svg(IC.redo, 14) + '</span>' +
    '<input type="text" class="f-rep" placeholder="Replace with…">' +
    '<button class="f-rone">Replace</button><button class="f-rall">All</button></div>' +
    '<div class="row docx-find-opts"><label><input type="checkbox" class="f-mc"> Match case</label>' +
    '<label><input type="checkbox" class="f-ww"> Whole word</label></div>';
  document.body.appendChild(p);
  FR.panel = p;
  if (!withReplace) p.querySelector('.f-reprow').style.display = 'none';
  var find = p.querySelector('.f-find');
  find.value = seed;
  var deb = null;
  find.addEventListener('input', function() { clearTimeout(deb); deb = setTimeout(function() { frSearch(); }, 180); });
  find.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? frJump(FR.cur - 1) : frJump(FR.cur + 1); }
    if (e.key === 'Escape') frClose();
  });
  p.querySelector('.f-mc').addEventListener('change', function() { frSearch(); });
  p.querySelector('.f-ww').addEventListener('change', function() { frSearch(); });
  p.querySelector('.f-prev').addEventListener('click', function() { frJump(FR.cur - 1); });
  p.querySelector('.f-next').addEventListener('click', function() { frJump(FR.cur + 1); });
  p.querySelector('.x').addEventListener('click', function() { frClose(); });
  p.querySelector('.f-rone').addEventListener('click', frReplaceCur);
  p.querySelector('.f-rall').addEventListener('click', frReplaceAll);
  find.focus();
  if (seed) frSearch();
}

/* ═══════════ Highlight: robust strip + toggle (shared by both apps) ═══════════ */
function _isHL(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.tagName === 'MARK' || el.hasAttribute('data-tj-hl') || el.hasAttribute('data-bj-hl')) return true;
  var s = el.style;
  return !!(s && (s.backgroundColor || (s.background && !/^none/i.test(s.background))));
}
function _unwrap(el) {
  var p = el.parentNode; if (!p) return;
  while (el.firstChild) p.insertBefore(el.firstChild, el);
  p.removeChild(el);
}
window._docxStripHighlight = function(ed, range) {
  var sel = window.getSelection();
  var r = range || (sel && sel.rangeCount ? sel.getRangeAt(0) : null);
  if (!r || !ed.contains(r.commonAncestorContainer)) return;
  function hlAnc(node) { var c = node; while (c && c !== ed) { if (_isHL(c)) return c; c = c.parentNode; } return null; }
  var sc = hlAnc(r.startContainer), ec = hlAnc(r.endContainer);
  if (sc) { try { r.setStartBefore(sc); } catch (e) {} }
  if (ec) { try { r.setEndAfter(ec); } catch (e) {} }
  Array.prototype.slice.call(ed.querySelectorAll('mark,[data-tj-hl],[data-bj-hl],span[style]')).forEach(function(el) {
    if (!_isHL(el)) return;
    var hit = false;
    try { hit = r.intersectsNode(el); } catch (e) { hit = true; }
    if (!hit && el !== sc && el !== ec) return;
    if (el.tagName === 'MARK') { _unwrap(el); }
    else {
      el.style.background = ''; el.style.backgroundColor = ''; el.style.color = '';
      if (!(el.getAttribute('style') || '').trim()) el.removeAttribute('style');
      if (!el.attributes.length) _unwrap(el);
    }
  });
  ed.normalize();
};
window._docxSelectionHighlighted = function(ed) {
  var sel = window.getSelection();
  if (!sel || !sel.rangeCount) return false;
  var r = sel.getRangeAt(0);
  if (!ed.contains(r.commonAncestorContainer)) return false;
  var n = r.startContainer; if (n.nodeType === 3) n = n.parentElement;
  if (n && n.closest) { var a = n.closest('mark,[data-tj-hl],[data-bj-hl]'); if (a && ed.contains(a)) return true; }
  var els = ed.querySelectorAll('mark,[data-tj-hl],[data-bj-hl]');
  for (var i = 0; i < els.length; i++) { try { if (r.intersectsNode(els[i])) return true; } catch (e) {} }
  return false;
};
window._docxToggleHighlight = function(ed, color) {
  var sel = window.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return;
  var r = sel.getRangeAt(0);
  if (!ed.contains(r.commonAncestorContainer)) return;
  if (window._docxSelectionHighlighted(ed)) {
    window._docxStripHighlight(ed, r.cloneRange());
    sel.removeAllRanges();
  } else {
    var mark = document.createElement('mark');
    mark.style.cssText = 'background:' + color + ';color:#111;border-radius:2px;padding:0 1px;';
    try { r.surroundContents(mark); } catch (e) { document.execCommand('hiliteColor', false, color); }
  }
  fireInput(ed);
};

/* ═══════════ Selection watcher (table bubble + varied-font-size dash) ═══════════
   The floating format popup was removed by request — all tools live in the ribbon. */
var selTimer = null;
document.addEventListener('selectionchange', function() {
  clearTimeout(selTimer);
  selTimer = setTimeout(function() {
    var s = window.getSelection();
    var ctx = (s && s.rangeCount)
      ? ALLCTX.find(function(c) { return c.edEl.contentEditable === 'true' && c.edEl.contains(s.anchorNode); })
      : null;
    // Table bubble: follows the caret while inside a table
    if (ctx && window.innerWidth >= 640) maybeShowTblBubble(ctx);
    else hideTblBubble();
    // Reflect varied / current font size + block type in the toolbar
    if (ctx) { updateFontSizeIndicator(ctx); updateBlockSelect(ctx); }
  }, 140);
});
// Show the font-size box as "—" when the selection spans mixed sizes, else the size.
function updateFontSizeIndicator(ctx) {
  var sel = ctx.tbEl.querySelector('[id$="-pt-fontsize"]');
  if (!sel) return;
  var s = window.getSelection();
  if (!s || !s.rangeCount || !ctx.edEl.contains(s.anchorNode)) return;
  var sizes = {};
  function px(node) {
    var el = node.nodeType === 3 ? node.parentElement : node;
    if (!el) return;
    sizes[Math.round(parseFloat(getComputedStyle(el).fontSize))] = 1;
  }
  if (s.isCollapsed) { px(s.anchorNode); }
  else {
    var walker = document.createTreeWalker(ctx.edEl, NodeFilter.SHOW_TEXT, {
      acceptNode: function(n) { try { return s.getRangeAt(0).intersectsNode(n) && n.nodeValue.trim() ? 1 : 2; } catch (e) { return 2; } }
    });
    var n, count = 0;
    while ((n = walker.nextNode()) && count < 400) { px(n); count++; }
  }
  var keys = Object.keys(sizes);
  sel.value = keys.length === 1 ? (hasOption(sel, keys[0]) ? keys[0] : '') : '';
}
function hasOption(sel, v) { return Array.prototype.some.call(sel.options, function(o) { return o.value === String(v); }); }

/* ═══════════ Modals ═══════════ */
function modal(title, buildBody, buildFooter) {
  var veil = document.createElement('div');
  veil.className = 'docx-veil';
  var box = document.createElement('div');
  box.className = 'docx-modal';
  var h = document.createElement('div');
  h.className = 'docx-modal-h';
  h.innerHTML = esc(title);
  var x = document.createElement('button');
  x.className = 'x'; x.innerHTML = window.TNI.x;
  x.addEventListener('click', function() { veil.remove(); });
  h.appendChild(x);
  var b = document.createElement('div');
  b.className = 'docx-modal-b';
  box.appendChild(h); box.appendChild(b);
  if (buildFooter) {
    var f = document.createElement('div');
    f.className = 'docx-modal-f';
    buildFooter(f, function() { veil.remove(); });
    box.appendChild(f);
  }
  buildBody(b, function() { veil.remove(); });
  veil.appendChild(box);
  veil.addEventListener('pointerdown', function(e) { if (e.target === veil) veil.remove(); });
  document.body.appendChild(veil);
  return veil;
}
function wcCounts(ctx) {
  var text = ctx.edEl.innerText || '';
  return {
    words: (text.trim().match(/\S+/g) || []).length,
    chars: text.replace(/\n/g, '').length,
    charsNS: text.replace(/\s/g, '').length
  };
}
// Live pinned word-count widget (bottom-left), toggled per app.
function wcPinned(app) { return !!lsGet('docx_wcpin_' + app, false); }
function updateWcPin(ctx) {
  var el = $('docx-wcpin-' + ctx.app);
  if (!el) return;
  var c = wcCounts(ctx);
  el.querySelector('.n').textContent = c.words;
}
function mountWcPin(ctx) {
  if ($('docx-wcpin-' + ctx.app)) return;
  var el = document.createElement('div');
  el.id = 'docx-wcpin-' + ctx.app;
  el.className = 'docx-wcpin';
  el.innerHTML = '<span class="n">0</span> words <button title="Unpin">' + window.TNI.x + '</button>';
  el.querySelector('button').addEventListener('click', function() { lsSet('docx_wcpin_' + ctx.app, false); el.remove(); });
  document.body.appendChild(el);
  updateWcPin(ctx);
  if (!ctx._wcHooked) {
    ctx._wcHooked = true;
    ctx.edEl.addEventListener('input', function() { if ($('docx-wcpin-' + ctx.app)) updateWcPin(ctx); });
  }
}
function wordCountModal(ctx) {
  var c = wcCounts(ctx);
  modal('Word count', function(b) {
    b.innerHTML = '<div class="docx-kbd-grid" style="grid-template-columns:1fr auto;">' +
      '<span>Words</span><b>' + c.words + '</b>' +
      '<span>Characters</span><b>' + c.chars + '</b>' +
      '<span>Characters (no spaces)</span><b>' + c.charsNS + '</b></div>';
  }, function(f, close) {
    var pinned = wcPinned(ctx.app);
    var pin = document.createElement('button');
    pin.className = 'docx-btn pri';
    pin.textContent = pinned ? 'Unpin from screen' : 'Pin to screen (bottom-left)';
    pin.addEventListener('click', function() {
      var now = !wcPinned(ctx.app);
      lsSet('docx_wcpin_' + ctx.app, now);
      if (now) mountWcPin(ctx); else { var e = $('docx-wcpin-' + ctx.app); if (e) e.remove(); }
      close();
    });
    var ok = document.createElement('button');
    ok.className = 'docx-btn'; ok.textContent = 'Close';
    ok.addEventListener('click', close);
    f.style.justifyContent = 'flex-end';
    f.appendChild(ok); f.appendChild(pin);
  });
}
function shortcutsModal() {
  var rows = [
    ['Bold / Italic / Underline', 'Ctrl+B / I / U'],
    ['Undo / Redo', 'Ctrl+Z / Ctrl+Y'],
    ['Cut / Copy / Paste', 'Ctrl+X / C / V'],
    ['Select all', 'Ctrl+A'],
    ['Save', 'Ctrl+S'],
    ['Print / Export PDF', 'Ctrl+P'],
    ['Find', 'Ctrl+F'],
    ['Find & Replace', 'Ctrl+H'],
    ['Indent / Outdent', 'Ctrl+] / Ctrl+['],
    ['Line break (no new paragraph)', 'Shift+Enter']
  ];
  modal('Keyboard shortcuts', function(b) {
    b.innerHTML = '<div class="docx-kbd-grid">' + rows.map(function(r) {
      return '<span>' + esc(r[0]) + '</span><span><kbd>' + esc(r[1]) + '</kbd></span>';
    }).join('') + '</div>';
  });
}
function pageSetupModal(app) {
  var ps = psGet(app);
  modal('Page setup', function(b) {
    b.innerHTML =
      '<div class="docx-ps-row"><label>Page size</label><select class="ps-size">' +
      '<option value="letter">Letter (8.5 × 11 in)</option><option value="a4">A4 (210 × 297 mm)</option><option value="legal">Legal (8.5 × 14 in)</option></select></div>' +
      '<div class="docx-ps-row"><label>Orientation</label><select class="ps-orient">' +
      '<option value="portrait">Portrait</option><option value="landscape">Landscape</option></select></div>' +
      '<div class="docx-ps-row"><label>Margins</label><select class="ps-margin">' +
      '<option value="normal">Normal (1&quot;)</option><option value="narrow">Narrow (0.5&quot;)</option><option value="moderate">Moderate (1&quot; × 0.75&quot;)</option><option value="wide">Wide (1&quot; × 2&quot;)</option></select></div>';
    b.querySelector('.ps-size').value = ps.size;
    b.querySelector('.ps-orient').value = ps.orient;
    b.querySelector('.ps-margin').value = ps.margin;
  }, function(f, close) {
    var apply = document.createElement('button');
    apply.className = 'docx-btn pri';
    apply.textContent = 'Apply';
    apply.addEventListener('click', function() {
      var veil = f.closest('.docx-veil');
      var marginKey = veil.querySelector('.ps-margin').value;
      lsSet('docx_ps_' + app, {
        size: veil.querySelector('.ps-size').value,
        orient: veil.querySelector('.ps-orient').value,
        margin: marginKey
      });
      // Reset any custom (ruler-dragged) margins so the chosen preset takes effect.
      var mp = MARGINS[marginKey] || MARGINS.normal;
      lsSet('docx_margins_' + app, { mt: mp[0], mr: mp[1], mb: mp[2], ml: mp[3] });
      applyPageSetup(app);
      close();
    });
    var cancel = document.createElement('button');
    cancel.className = 'docx-btn';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', close);
    f.style.justifyContent = 'flex-end';
    f.appendChild(cancel);
    f.appendChild(apply);
  });
}

/* ═══════════ Trash modal ═══════════ */
window._docxOpenTrash = function(app) {
  var api = window[APPS[app].trashAPI];
  if (!api) return;
  var TMAP = { whiteboard: 'BOARD', notes: 'NOTES', cornell: 'CORNELL', mindmap: 'MAP', page: 'PAGE', 'journal-entries': 'JOURNAL' };
  var selected = {};
  var veil = modal('Trash — items delete permanently after 30 days', function(b) {
    function render() {
      var items = api.list();
      Object.keys(selected).forEach(function(id) { if (!items.some(function(e) { return e.id === id; })) delete selected[id]; });
      if (!items.length) { b.innerHTML = '<div class="docx-empty-note">Trash is empty.</div>'; syncFooter(); return; }
      b.innerHTML = '';
      items.forEach(function(e) {
        var days = Math.max(0, Math.ceil((e.trashed + api.ttlDays * 864e5 - Date.now()) / 864e5));
        var row = document.createElement('div');
        row.className = 'docx-trash-row';
        row.innerHTML =
          '<input type="checkbox" ' + (selected[e.id] ? 'checked' : '') + '>' +
          // The Trash modal is shared by both journals, so the lock badge is
          // swapped for the SVG only for Veda's ('bj') — Tony's list keeps the
          // glyph it already renders.
          '<div class="t"><div class="n">' + esc(e.title || 'Untitled') + (e.lock ? (app === 'bj' ? ' <span class="docx-lock-badge">' + window.TNI.lock + '</span>' : ' 🔒') : '') + '</div>' +
          '<div class="m">' + (TMAP[e.template] || 'NOTE') + ' · deleted ' + new Date(e.trashed).toLocaleDateString() + ' · auto-deletes in ' + days + 'd</div></div>' +
          '<div class="b"><button class="res">Restore</button><button class="del">Delete forever</button></div>';
        row.querySelector('input').addEventListener('change', function() {
          if (this.checked) selected[e.id] = true; else delete selected[e.id];
          syncFooter();
        });
        row.querySelector('.res').addEventListener('click', function() { api.restore([e.id]); render(); });
        row.querySelector('.del').addEventListener('click', async function() {
          if (await window.uiConfirm('Permanently delete "' + (e.title || 'Untitled') + '"? This cannot be undone.', {danger:true, okLabel:'Delete forever'})) { api.purge([e.id]); render(); }
        });
        b.appendChild(row);
      });
      syncFooter();
    }
    b._render = render;
    render();
  }, function(f, close) {
    var selAll = document.createElement('button');
    selAll.className = 'docx-btn';
    selAll.textContent = 'Select all';
    selAll.addEventListener('click', function() {
      var items = api.list();
      var all = items.length && items.every(function(e) { return selected[e.id]; });
      items.forEach(function(e) { if (all) delete selected[e.id]; else selected[e.id] = true; });
      body._render();
    });
    var res = document.createElement('button');
    res.className = 'docx-btn pri';
    res.textContent = 'Restore selected';
    res.addEventListener('click', function() {
      var ids = Object.keys(selected);
      if (!ids.length) return;
      api.restore(ids);
      ids.forEach(function(id) { delete selected[id]; });
      body._render();
    });
    var del = document.createElement('button');
    del.className = 'docx-btn danger';
    del.textContent = 'Delete selected forever';
    del.addEventListener('click', async function() {
      var ids = Object.keys(selected);
      if (!ids.length) return;
      if (!(await window.uiConfirm('Permanently delete ' + ids.length + ' item(s)? This cannot be undone.', {danger:true, okLabel:'Delete forever'}))) return;
      api.purge(ids);
      ids.forEach(function(id) { delete selected[id]; });
      body._render();
    });
    var empty = document.createElement('button');
    empty.className = 'docx-btn danger';
    empty.textContent = 'Empty Trash';
    empty.addEventListener('click', async function() {
      var ids = api.list().map(function(e) { return e.id; });
      if (!ids.length) return;
      if (!(await window.uiConfirm('Permanently delete ALL ' + ids.length + ' item(s) in Trash?', {danger:true, okLabel:'Empty Trash'}))) return;
      api.purge(ids);
      body._render();
    });
    f.appendChild(selAll); f.appendChild(res); f.appendChild(del); f.appendChild(empty);
    f._sync = function() {
      var n = Object.keys(selected).length;
      res.textContent = n ? 'Restore selected (' + n + ')' : 'Restore selected';
      del.textContent = n ? 'Delete selected forever (' + n + ')' : 'Delete selected forever';
    };
  });
  var body = veil.querySelector('.docx-modal-b');
  var footer = veil.querySelector('.docx-modal-f');
  function syncFooter() { if (footer && footer._sync) footer._sync(); }
  syncFooter();
};

/* ═══════════ Per-journal feature locks (reversible) ═══════════
   Add an app key + feature-name list here to disable features on that journal — nothing else
   in the code needs to change. Example (Brainstorm/bj, currently RE-ENABLED per request):
     { bj: ['aiFormat', 'renderMarkdown', 'unrenderMarkdown', 'aiPrompt'] }
   Feature names: 'aiFormat', 'renderMarkdown', 'unrenderMarkdown', 'aiPrompt'. Empty = nothing locked. */
var DOCX_DISABLED_FEATURES = {};
function _docxFeatureLocked(app, feature) {
  return (DOCX_DISABLED_FEATURES[app] || []).indexOf(feature) !== -1;
}
function _docxLockedToast() {
  docxToast('This feature has been disabled on your journal.', true);
}
/* ═══════════ AI Format (Gemini via consolidated personal-ai Worker) ═══════════ */
function docxToast(msg, isErr) {
  var t = document.createElement('div');
  t.className = 'docx-toast' + (isErr ? ' err' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(function() { t.style.opacity = '0'; }, 3400);
  setTimeout(function() { t.remove(); }, 3900);
}
function aiOverlay(tool) {
  var name = (tool && tool.name) || 'AI Format';
  var v = document.createElement('div');
  v.className = 'docx-veil docx-ai-veil';
  v.innerHTML = '<div class="docx-ai-card"><div class="docx-ai-spin"></div>' +
    '<div class="docx-ai-msg">' + esc(name) + '…</div>' +
    '<div class="docx-ai-sub">' + esc('Running ' + name + ' on your document with AI') + '</div></div>';
  document.body.appendChild(v);
  return v;
}

// The user-editable default AI Format prompt (per-journal copies live in localStorage).
var AI_DEFAULT_PROMPT = [
  'You are an expert document formatter.',
  '',
  'Your task is to intelligently reformat the provided document without changing its meaning, tone, facts, wording, or intent in ANY way.',
  '',
  'Rules:',
  '- Preserve ALL content. Never summarize, remove, invent, or rewrite information except for minor grammar, punctuation, spacing, capitalization, and formatting improvements.',
  '- Choose the best presentation automatically:',
  '  - Plain clean paragraphs if the document is primarily narrative.',
  '  - Markdown headings, lists, tables, quotes, code blocks, callouts, etc. only when they genuinely improve readability.',
  '  - Mix paragraphs and Markdown naturally when appropriate.',
  '- Create a logical document structure with clear sections where beneficial.',
  '- Merge broken lines into proper paragraphs.',
  '- Fix spacing, indentation, numbering, bullet consistency, and overall layout.',
  '- Preserve code, URLs, equations, and special formatting.',
  '- Format ALL mathematics as Markdown math: inline math wrapped in single dollar signs like $E = mc^2$, and block/display equations wrapped in double dollar signs on their own lines like $$ ... $$. Convert any plain-text math (e.g. "E = mc^2", "integral from 0 to infinity", "x^2 + y^2 = z^2") into proper LaTeX inside those delimiters. Never leave math unformatted.',
  '- If tables communicate information better, convert suitable content into Markdown tables.',
  '- Do not over-format. Simplicity is preferred.',
  '- Never wrap the entire document in a code block.',
  '',
  'Images:',
  '- Preserve every image.',
  '- Move images only if doing so improves document flow.',
  '- Place each image near the most relevant content.',
  '- Output reasonable display sizes based on importance (large for primary images, medium for supporting images, small for icons or references).',
  '- Do not remove, duplicate, or describe images.',
  '',
  'Output only the fully formatted document.'
].join('\n');
// The built-in AI Refine default prompt. Where AI Format only restructures,
// Refine is allowed to rewrite the prose itself — while the meaning, facts and
// intent stay locked.
var AI_REFINE_DEFAULT_PROMPT = [
  'You are an expert editor and writing assistant.',
  '',
  'Your task is to intelligently rewrite and improve the provided document while fully preserving its meaning, intent, facts, and core message.',
  '',
  'Rules:',
  '- Rewrite for maximum clarity, readability, flow, and professionalism.',
  '- Improve sentence structure, word choice, grammar, punctuation, capitalization, spelling, and overall writing quality.',
  '- Eliminate awkward, repetitive, redundant, or unnecessarily wordy phrasing.',
  '- Reorganize paragraphs, sentences, and sections when doing so improves logical flow.',
  '- Clarify ambiguous wording whenever the intended meaning is reasonably clear.',
  '- Preserve the author\'s original tone whenever practical. If the tone is inconsistent, make it more coherent without changing the intent.',
  '- Preserve ALL factual information. Never invent, hallucinate, exaggerate, omit important information, or change the meaning.',
  '- Keep names, numbers, dates, URLs, code, equations, citations, and technical terminology accurate unless they contain obvious errors.',
  '- Choose the best presentation automatically:',
  '  - Plain, polished paragraphs if the document is primarily narrative.',
  '  - Markdown headings, lists, tables, quotes, code blocks, callouts, etc. only when they genuinely improve readability.',
  '  - Mix paragraphs and Markdown naturally when appropriate.',
  '- Create a logical document structure with clear sections where beneficial.',
  '- Merge broken lines into proper paragraphs.',
  '- Fix spacing, indentation, numbering, bullet consistency, and overall layout.',
  '- Preserve code blocks exactly unless the surrounding text is being improved.',
  '- Preserve URLs exactly.',
  '- Format ALL mathematics as Markdown math: inline math wrapped in single dollar signs like $E = mc^2$, and block/display equations wrapped in double dollar signs on their own lines like $$ ... $$. Convert any plain-text math into proper LaTeX inside those delimiters. Never leave math unformatted.',
  '- If tables communicate information better, convert suitable content into Markdown tables.',
  '- Do not over-edit. Prefer the smallest changes necessary to produce writing that feels polished, natural, and professional.',
  '- Never wrap the entire document in a code block.',
  '',
  'Images:',
  '- Preserve every image.',
  '- Move images only if doing so improves document flow.',
  '- Place each image near the most relevant content.',
  '- Output reasonable display sizes based on importance (large for primary images, medium for supporting images, small for icons or references).',
  '- Do not remove, duplicate, or describe images.',
  '',
  'Output only the fully refined document.'
].join('\n');

// A starter skeleton offered when the user creates their own tool, so a new
// prompt begins from something that already works with the output contract.
var AI_CUSTOM_STARTER_PROMPT = [
  'You are an expert writing assistant.',
  '',
  '[Describe what this tool should do to the document here.]',
  '',
  'Rules:',
  '- Preserve the author\'s meaning, facts, and intent.',
  '- Preserve every image and link exactly as given.',
  '- Improve formatting only where it genuinely helps readability.',
  '',
  'Output only the resulting document.'
].join('\n');

/* ═══════════ AI Tools registry ═══════════
   Two built-in tools plus an unlimited number of user-created ones. Everything
   the user can change lives in ONE object per journal:

     { prompts: { <builtinId>: '<prompt>' },            // only ids the user edited
       custom:  [ { id, name, prompt, def } ] }         // def = prompt at creation

   That object is mirrored to localStorage under docx_aitools_<app> and pushed to
   its own Firestore doc on every change, so adds/renames/edits/deletes/resets all
   sync the moment they happen. A built-in id missing from `prompts` means "still
   on the default", which is also what makes the one-time migration from the old
   single-prompt store work without a flag. */
var AI_BUILTIN_TOOLS = [
  { id: 'format', name: 'AI Format', def: AI_DEFAULT_PROMPT,
    hint: 'Fixes structure and layout only — headings, lists, tables, spacing and math. Your wording is left exactly as you wrote it.' },
  { id: 'refine', name: 'AI Refine', def: AI_REFINE_DEFAULT_PROMPT,
    hint: 'Rewrites the writing itself — clarity, wording, flow, grammar and organization — then formats it. Meaning, facts and your voice are preserved.' }
];
// Shown on hover. Custom tools get the opening line of their own prompt, so a
// user-made tool explains itself the same way the built-ins do.
function aiToolHint(t) {
  if (t.hint) return t.hint;
  var first = String(t.prompt || '').split('\n').filter(function(l) { return l.trim(); })[0] || '';
  if (first.length > 160) first = first.slice(0, 157) + '…';
  return first ? 'Your AI tool — ' + first : 'Your AI tool.';
}

function aiToolsStore(app) {
  var s = lsGet('docx_aitools_' + app, null);
  if (!s || typeof s !== 'object' || Array.isArray(s)) s = {};
  if (!s.prompts || typeof s.prompts !== 'object' || Array.isArray(s.prompts)) s.prompts = {};
  if (!Array.isArray(s.custom)) s.custom = [];
  // Migrate the pre-AI-Tools single prompt: it was the AI Format prompt, and it
  // only counts while the user hasn't set an AI Format prompt in the new store.
  if (typeof s.prompts.format !== 'string') {
    var legacy = lsGet('docx_aiprompt_' + app, null);
    if (typeof legacy === 'string' && legacy.trim()) s.prompts.format = legacy;
  }
  s.custom = s.custom.filter(function(t) { return t && t.id; }).map(function(t) {
    return {
      id: String(t.id),
      name: String(t.name || 'Untitled tool'),
      prompt: String(t.prompt || ''),
      def: String(t.def != null ? t.def : (t.prompt || ''))
    };
  });
  return s;
}

// Single write path for EVERY AI-tool change (add / rename / edit / reset /
// delete). Writes localStorage first so the UI is instant, then pushes the whole
// store to Firebase and drives the header sync pill Saving… → Synced / Sync Failed.
function aiToolsSave(app, store) {
  lsSet('docx_aitools_' + app, store);
  var setSync = app === 'tj' ? window._tjSetSync : window._bjSetSync;
  if (typeof setSync === 'function') setSync('syncing');
  var fn = app === 'tj' ? window._fbSaveTJTools : window._fbSaveBJTools;
  if (typeof fn === 'function') fn(JSON.stringify(store));
  else if (typeof setSync === 'function') setSync('synced');
  // Keep the legacy per-journal prompt doc current too, so a device still running
  // the old build keeps receiving AI Format prompt edits.
  var fmt = store.prompts && store.prompts.format;
  if (typeof fmt === 'string') {
    lsSet('docx_aiprompt_' + app, fmt);
    var legacyFn = app === 'tj' ? window._fbSaveTJPrompt : window._fbSaveBJPrompt;
    if (typeof legacyFn === 'function') legacyFn(fmt);
  }
  window.dispatchEvent(new CustomEvent('docx-aitools-changed', { detail: { app: app } }));
}

// The full ordered tool list: built-ins first, then custom tools in creation order.
function aiToolList(app) {
  var s = aiToolsStore(app);
  var out = AI_BUILTIN_TOOLS.map(function(b) {
    var p = s.prompts[b.id];
    return {
      id: b.id, name: b.name, builtin: true, hint: b.hint, def: b.def,
      prompt: (typeof p === 'string' && p.trim()) ? p : b.def
    };
  });
  s.custom.forEach(function(t) {
    out.push({ id: t.id, name: t.name, builtin: false, hint: '', def: t.def, prompt: t.prompt || t.def });
  });
  return out;
}
function aiToolById(app, id) {
  var list = aiToolList(app);
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return list[0];
}
function aiToolNewId() { return 'tool_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function aiToolAdd(app, name, prompt) {
  var s = aiToolsStore(app);
  var t = { id: aiToolNewId(), name: String(name || 'Untitled tool').trim() || 'Untitled tool',
            prompt: String(prompt || ''), def: String(prompt || '') };
  s.custom.push(t);
  aiToolsSave(app, s);
  return t.id;
}
function aiToolSetPrompt(app, id, prompt) {
  var s = aiToolsStore(app);
  var b = AI_BUILTIN_TOOLS.some(function(x) { return x.id === id; });
  if (b) s.prompts[id] = String(prompt);
  else { var t = s.custom.filter(function(x) { return x.id === id; })[0]; if (!t) return; t.prompt = String(prompt); }
  aiToolsSave(app, s);
}
function aiToolRename(app, id, name) {
  var s = aiToolsStore(app);
  var t = s.custom.filter(function(x) { return x.id === id; })[0];
  if (!t) return;                                  // built-in names are fixed
  t.name = String(name || '').trim() || 'Untitled tool';
  aiToolsSave(app, s);
}
function aiToolDelete(app, id) {
  var s = aiToolsStore(app);
  s.custom = s.custom.filter(function(x) { return x.id !== id; });
  aiToolsSave(app, s);
}
// Restore a tool's original prompt: the shipped default for a built-in, the
// prompt it was created with for a custom tool.
function aiToolReset(app, id) {
  var s = aiToolsStore(app);
  var b = AI_BUILTIN_TOOLS.filter(function(x) { return x.id === id; })[0];
  if (b) s.prompts[id] = b.def;
  else { var t = s.custom.filter(function(x) { return x.id === id; })[0]; if (!t) return null; t.prompt = t.def; }
  aiToolsSave(app, s);
  return b ? b.def : (s.custom.filter(function(x) { return x.id === id; })[0] || {}).prompt;
}

var AI_COOLDOWN_MS = 6000;      // safe spacing between AI runs (protects the free tier)
var _aiBusy = {}, _aiLastRun = {};

// — "Already processed" tracking --------------------------------------------
// Every top-level block an AI tool writes gets tagged data-ai-fmt="1", the id of
// the tool that wrote it (data-ai-tool), and a content hash (data-ai-hash). On
// the next whole-document run of THAT SAME tool, a block whose current markup
// still matches its hash is skipped ENTIRELY — never cloned, never sent to the
// model, never rewritten — so text it already produced can't be churned by a
// repeat run. A block whose markup no longer matches (the user edited it), or
// that was written by a DIFFERENT tool, is treated as new again — that's what
// lets you run AI Refine over a document AI Format already touched.
// Blocks from before per-tool tagging carry no data-ai-tool and count as 'format'.
function _aiHash(s) {
  var h = 5381;
  for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
function _aiNodeHash(node) {
  var c = node.cloneNode(true);
  c.removeAttribute('data-ai-hash');
  return _aiHash(c.outerHTML);
}
function _aiMarkNode(node, toolId) {
  if (node.nodeType !== 1) return;
  node.setAttribute('data-ai-fmt', '1');
  node.setAttribute('data-ai-tool', toolId || 'format');
  node.setAttribute('data-ai-hash', _aiNodeHash(node));
}
function _aiIsUnchanged(node, toolId) {
  if (node.nodeType !== 1 || node.getAttribute('data-ai-fmt') !== '1') return false;
  if ((node.getAttribute('data-ai-tool') || 'format') !== (toolId || 'format')) return false;
  return node.getAttribute('data-ai-hash') === _aiNodeHash(node);
}
// Run-length-encodes the editor's top-level children into alternating
// {isNew, nodes} groups, so a contiguous run of new content can be sent as
// one chunk while contiguous already-processed runs are left untouched.
function _aiSegmentRuns(ed, toolId) {
  var runs = [];
  Array.prototype.slice.call(ed.childNodes).forEach(function(node) {
    var isNew = !_aiIsUnchanged(node, toolId);
    var last = runs[runs.length - 1];
    if (last && last.isNew === isNew) last.nodes.push(node);
    else runs.push({ isNew: isNew, nodes: [node] });
  });
  return runs;
}
function _aiRunHasContent(nodes) {
  return nodes.some(function(n) {
    if (n.nodeType === 3) return /\S/.test(n.textContent || '');
    if (n.nodeType !== 1) return false;
    if (n.querySelector && n.querySelector('.pg-img-wrap, a.tj-file-chip, a[download], img')) return true;
    return /\S/.test(n.textContent || '');
  });
}

// Turn a DOM fragment into plain text with [[IMGn]] tokens standing in for
// images, file chips, AND hyperlinks — so a link's href (which plain
// innerText can't carry) survives the AI round-trip instead of collapsing to
// bare anchor text and losing its destination. `counter` is shared across
// multiple calls so tokens stay unique when several chunks go in one request.
function aiExtractFragment(container, counter) {
  counter = counter || { n: 0 };
  var imgs = [];
  Array.prototype.slice.call(container.querySelectorAll('.pg-img-wrap, a.tj-file-chip, a[download], a[href]')).forEach(function(el) {
    counter.n++;
    imgs.push({ n: counter.n, html: el.outerHTML });
    var ph = document.createElement('p');
    ph.textContent = '[[IMG' + counter.n + ']]';
    if (el.parentNode) el.parentNode.replaceChild(ph, el);
  });
  container.style.cssText = 'position:absolute;left:-99999px;top:0;width:700px;white-space:pre-wrap;';
  document.body.appendChild(container);
  var text = container.innerText;
  document.body.removeChild(container);
  return { text: (text || '').replace(/ /g, ' ').trim(), imgs: imgs };
}
// Restore [[IMGn]] / [[IMGn|size]] tokens in the AI's HTML back into the
// original image/file/link HTML.
function aiRestoreImages(html, imgs) {
  if (!imgs.length) return html;
  var map = {}; imgs.forEach(function(o) { map[o.n] = o; });
  var SIZE = { large: '480px', medium: '320px', small: '160px' };
  return html.replace(/\[\[IMG(\d+)(?:\|(large|medium|small))?\]\]/g, function(m, num, size) {
    var o = map[+num];
    if (!o) return '';
    var frag = o.html;
    if (size && SIZE[size] && /pg-img-wrap/.test(frag)) {
      var d = document.createElement('div'); d.innerHTML = frag;
      var img = d.querySelector('img'); if (img) { img.style.width = SIZE[size]; img.style.height = ''; }
      frag = d.innerHTML;
    }
    delete map[+num];       // consume so a duplicated token can't double an image
    return frag;
  });
}

// Shared network call for both the whole-document and selection paths. Keeps
// a hard client-side timeout: without it, a stalled connection or a hung
// worker leaves the fetch promise pending forever, so the overlay never
// clears and the only way out is a page refresh. Aborting guarantees the UI
// always recovers on its own. Normalizes every failure into a rejection
// carrying { _timedOut }.
function _aiPostFormat(app, text, prompt, tool) {
  var AI_TIMEOUT_MS = 90000;
  var ac = new AbortController();
  var timedOut = false;
  var timer = setTimeout(function() { timedOut = true; ac.abort(); }, AI_TIMEOUT_MS);
  return fetch(AI_FORMAT_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      profile: APPS[app].aiProfile, text: text, prompt: prompt,
      tool: (tool && tool.id) || 'format', toolName: (tool && tool.name) || 'AI Format'
    }),
    signal: ac.signal
  }).then(function(r) {
    return r.json().then(function(d) { d._status = r.status; return d; }).catch(function() { return { ok: false, error: 'bad response', _status: r.status }; });
  }).then(function(data) {
    clearTimeout(timer);
    return data;
  }).catch(function() {
    clearTimeout(timer);
    return Promise.reject({ _timedOut: timedOut });
  });
}
// Ending a run restores contentEditable, which refocuses the editor — and the
// editor's focus handler calls history.syncBase(), which RESEEDS the undo stack
// whenever the content no longer matches history's last snapshot. Mid-run that is
// exactly the case, so the pre-run snapshot was being thrown away and Undo went
// dead (worst on selection runs, where the refocus lands between the two commits).
// _aiSettling holds that reseed off until this run's own commits have landed.
function _aiFinish(ctx, app, ed, overlay, wasEditable) {
  overlay.remove();
  ctx._aiSettling = true;
  ed.contentEditable = wasEditable;
  _aiBusy[app] = false;
  setTimeout(function() {
    ctx._aiSettling = false;
    if (ctx.history && ctx.history.refresh) ctx.history.refresh();
  }, 0);
}

var AI_SECTION_NOTE = '\n\nIMPORTANT — SECTION MARKERS: the document below is split into independent sections, each wrapped exactly like [[SEC0S]] ... [[SEC0E]], [[SEC1S]] ... [[SEC1E]], etc. Treat every section as its own separate document and format it using the rules above. Reproduce EVERY marker EXACTLY ONCE, in the same order, with only that section\'s formatted output between its own start/end marker — nothing outside any marker, nothing between one section\'s end marker and the next section\'s start marker.';
var AI_PARTIAL_NOTE = '\n\nIMPORTANT — PARTIAL DOCUMENT: what follows is ONLY the newly-added or edited content that still needs formatting; everything already formatted has been deliberately left out and is not shown to you. Do not reference, summarize, or recreate anything from the rest of the document — just format exactly what is shown, as it will be reinserted in place.';
var AI_EXCERPT_NOTE = '\n\nIMPORTANT — SELECTION: what follows is only a SELECTED EXCERPT copied out of a larger document, not the whole thing. Format only this excerpt using the rules above; do not add an introduction, summary, or any remark about it being an excerpt.';

/* Single entry point for EVERY AI tool — the two built-ins and every custom
   tool run through here and differ only by the prompt in `tool`. */
function aiRunTool(ctx, tool) {
  var ed = ctx.edEl, app = ctx.app;
  if (!tool) tool = aiToolById(app, 'format');
  if (_docxFeatureLocked(app, 'aiFormat')) { _docxLockedToast(); return; }
  if (_aiBusy[app]) return;
  var since = Date.now() - (_aiLastRun[app] || 0);
  if (since < AI_COOLDOWN_MS) {
    docxToast('Please wait ' + Math.ceil((AI_COOLDOWN_MS - since) / 1000) + 's before running another AI tool.', true);
    return;
  }
  if (!String(tool.prompt || '').trim()) {
    docxToast('“' + tool.name + '” has an empty prompt — edit it from AI Tools ▸ Edit prompts.', true);
    return;
  }
  // A non-collapsed selection inside this editor -> process ONLY the selection.
  // Read the MOUSEDOWN-captured selection (savedSelFor), not a live
  // window.getSelection() -- by the time this click handler runs, clicking
  // the button has already shifted focus and cleared/collapsed the live
  // selection (same reason every other toolbar button uses saveSel/restoreSel).
  var r = savedSelFor(ctx);
  if (r && !r.collapsed && ed.contains(r.commonAncestorContainer) && r.toString().trim()) {
    aiRunSelection(ctx, r, tool);
    return;
  }
  aiRunWholeDoc(ctx, tool);
}
// Back-compat shim: anything still calling aiFormat() gets the AI Format tool.
function aiFormat(ctx) { aiRunTool(ctx, aiToolById(ctx.app, 'format')); }

// No selection: process the whole document, but skip any top-level block this
// same tool already produced and that hasn't changed since (see
// _aiSegmentRuns/_aiIsUnchanged above) — only new/edited runs are sent.
function aiRunWholeDoc(ctx, tool) {
  var ed = ctx.edEl, app = ctx.app;
  var runs = _aiSegmentRuns(ed, tool.id);
  var newRuns = runs.filter(function(r) { return r.isNew && _aiRunHasContent(r.nodes); });
  var hadSkipped = runs.some(function(r) { return !r.isNew && _aiRunHasContent(r.nodes); });

  if (!newRuns.length) {
    docxToast(hadSkipped ? 'Nothing new for ' + tool.name + ' — already up to date.' : 'Nothing to process — the page is empty.');
    return;
  }

  var counter = { n: 0 };
  var chunks = newRuns.map(function(run) {
    var wrap = document.createElement('div');
    run.nodes.forEach(function(n) { wrap.appendChild(n.cloneNode(true)); });
    return aiExtractFragment(wrap, counter);
  });
  var multi = chunks.length > 1;
  var combinedText = multi
    ? chunks.map(function(c, i) { return '[[SEC' + i + 'S]]\n' + c.text + '\n[[SEC' + i + 'E]]'; }).join('\n\n')
    : chunks[0].text;
  var allImgs = [].concat.apply([], chunks.map(function(c) { return c.imgs; }));
  if (!combinedText.trim() && !allImgs.length) { docxToast('Nothing to process — the page is empty.'); return; }

  var prompt = tool.prompt + (hadSkipped ? AI_PARTIAL_NOTE : '') + (multi ? AI_SECTION_NOTE : '');

  _aiBusy[app] = true; _aiLastRun[app] = Date.now();
  var overlay = aiOverlay(tool);
  var wasEditable = ed.contentEditable; ed.contentEditable = 'false';   // freeze edits while the request is in flight
  _aiPostFormat(app, combinedText, prompt, tool).then(function(data) {
    _aiFinish(ctx, app, ed, overlay, wasEditable);
    if (data && (data.exhausted || data._status === 429)) {
      docxToast(tool.name + ' is rate-limited right now (too many requests). Please wait a minute and try again.', true);
      return;
    }
    if (!data || !data.ok || !data.html) { docxToast(tool.name + ' failed: ' + ((data && data.error) || 'try again'), true); return; }
    var restored = aiRestoreImages(data.html, allImgs);

    var pieces;
    if (multi) {
      pieces = [];
      for (var i = 0; i < chunks.length; i++) {
        var re = new RegExp('\\[\\[SEC' + i + 'S\\]\\]([\\s\\S]*?)\\[\\[SEC' + i + 'E\\]\\]');
        var m = restored.match(re);
        if (!m) { docxToast(tool.name + ' couldn\'t process multiple new sections at once — try one section at a time (select it first).', true); return; }
        pieces.push(m[1]);
      }
    } else {
      pieces = [restored];
    }

    ctx.history.commit();          // snapshot the pre-run content (so Undo restores it)
    for (var j = 0; j < newRuns.length; j++) {
      var clean = window._docxCleanHTML(pieces[j]);
      if (window._docxMathify) clean = window._docxMathify(clean);   // $...$ text -> math elements (after sanitize)
      var tmp = document.createElement('div'); tmp.innerHTML = clean;
      var newNodes = Array.prototype.slice.call(tmp.childNodes);
      newNodes.forEach(function(n) { _aiMarkNode(n, tool.id); });
      var run = newRuns[j], anchor = run.nodes[0];
      newNodes.forEach(function(n) { ed.insertBefore(n, anchor); });
      run.nodes.forEach(function(n) { if (n.parentNode === ed) ed.removeChild(n); });
    }
    if (window._docxRenderMath) window._docxRenderMath(ed);   // render any $...$ / $$...$$ math
    ctx.history.commit();          // snapshot the new content (discrete Redo step)
    fireInput(ed);                 // autosave the new content
    docxToast(tool.name + ' done — press Undo to revert.');
  }).catch(function(e) {
    _aiFinish(ctx, app, ed, overlay, wasEditable);
    docxToast((e && e._timedOut) ? tool.name + ' timed out — please try again.' : tool.name + ' failed: network error.', true);
  });
}

// Text is selected: process ONLY the selected range in place, leaving
// everything else in the document completely untouched.
function aiRunSelection(ctx, range, tool) {
  var ed = ctx.edEl, app = ctx.app;
  var wrap = document.createElement('div');
  wrap.appendChild(range.cloneContents());
  var extracted = aiExtractFragment(wrap);
  if (!extracted.text.trim() && !extracted.imgs.length) { docxToast('Nothing selected to process.'); return; }

  var prompt = tool.prompt + AI_EXCERPT_NOTE;
  _aiBusy[app] = true; _aiLastRun[app] = Date.now();
  var overlay = aiOverlay(tool);
  var wasEditable = ed.contentEditable; ed.contentEditable = 'false';   // freeze edits while the request is in flight
  _aiPostFormat(app, extracted.text, prompt, tool).then(function(data) {
    _aiFinish(ctx, app, ed, overlay, wasEditable);
    if (data && (data.exhausted || data._status === 429)) {
      docxToast(tool.name + ' is rate-limited right now (too many requests). Please wait a minute and try again.', true);
      return;
    }
    if (!data || !data.ok || !data.html) { docxToast(tool.name + ' failed: ' + ((data && data.error) || 'try again'), true); return; }
    var restored = aiRestoreImages(data.html, extracted.imgs);
    var clean = window._docxCleanHTML(restored);
    if (window._docxMathify) clean = window._docxMathify(clean);   // $...$ text -> math elements (after sanitize)
    if (!clean || !clean.trim()) { docxToast(tool.name + ' returned nothing — selection unchanged.', true); return; }

    ctx.history.commit();          // snapshot the pre-run content (so Undo restores it)
    var tmp = document.createElement('div'); tmp.innerHTML = clean;
    // If it formatted down to a single paragraph, insert its INLINE contents
    // instead of the <p> itself -- the selection's range start/end usually sit
    // INSIDE an existing block (e.g. a sentence selected within a paragraph),
    // so inserting a block-level <p> there would nest a <p> inside a <p>
    // (invalid markup the browser silently mangles). Mirrors renderMarkdown's
    // identical selection-insert fix above.
    if (tmp.children.length === 1 && tmp.firstElementChild.tagName === 'P' &&
        !tmp.firstElementChild.querySelector('div,p,ul,ol,table,blockquote,pre,h1,h2,h3,h4,h5,h6')) {
      var inner = document.createElement('div'); inner.innerHTML = tmp.firstElementChild.innerHTML; tmp = inner;
    }
    var newNodes = Array.prototype.slice.call(tmp.childNodes);
    newNodes.forEach(function(n) { _aiMarkNode(n, tool.id); });
    range.deleteContents();
    var frag = document.createDocumentFragment();
    var last = newNodes[newNodes.length - 1];
    newNodes.forEach(function(n) { frag.appendChild(n); });
    range.insertNode(frag);
    if (window._docxRenderMath) window._docxRenderMath(ed);   // render any $...$ / $$...$$ math
    if (last) {
      var endRange = document.createRange();
      endRange.setStartAfter(last); endRange.collapse(true);
      var s = window.getSelection(); s.removeAllRanges(); s.addRange(endRange);
    }
    ctx.history.commit();          // snapshot the new content (discrete Redo step)
    fireInput(ed);                 // autosave the new content
    docxToast(tool.name + ' — selection done ✓  press Undo to revert.');
  }).catch(function(e) {
    _aiFinish(ctx, app, ed, overlay, wasEditable);
    docxToast((e && e._timedOut) ? tool.name + ' timed out — please try again.' : tool.name + ' failed: network error.', true);
  });
}

function aiJournalName(app) { return app === 'tj' ? 'MyJournal' : 'Brainstorm Journal'; }
// MyJournal's resizable boxes take MAGI's corner grip (resizegrip.js, theme
// overhaul phase 2); Brainstorm Journal keeps the native corner. The box is
// wrapped so the grip can sit over its bottom-right corner. Call it after the
// box is in its parent.
function docxTonyGrip(ta, app, key, label) {
  if (app !== 'tj' || !window.A1Resize || !ta || !ta.parentNode) return;
  var wrap = document.createElement('div');
  wrap.className = 'docx-ta-wrap';
  ta.parentNode.insertBefore(wrap, ta);
  wrap.appendChild(ta);
  var g = window.A1Resize.grip(label);
  wrap.appendChild(g);
  window.A1Resize.attach(ta, g, key);
}
window.docxTonyGrip = docxTonyGrip;

/* ═══════════ AI Tools manager (prompt editor for every tool) ═══════════
   One modal covers everything the spec asks for: each tool's own prompt, edit
   at any time, Reset to Default per tool, rename/delete for custom tools, and
   create new ones. Every mutation goes through aiToolsSave(), so nothing here
   can end up saved locally but not synced. */
function aiToolsModal(app, focusId) {
  if (_docxFeatureLocked(app, 'aiPrompt')) { _docxLockedToast(); return; }
  var curId = focusId || 'format';
  var saveTimer = null, dirty = false;
  var list, pane, statusEl;

  function setStatus(txt, cls) {
    if (!statusEl) return;
    statusEl.textContent = txt;
    statusEl.className = 'docx-ait-status' + (cls ? ' ' + cls : '');
  }
  // Report what Firebase actually did rather than assuming the write landed:
  // the same events that drive the header sync pill drive this label.
  var savedEvt = app === 'tj' ? 'fb-tj-prompt-saved' : 'fb-bj-prompt-saved';
  var errEvt   = app === 'tj' ? 'fb-tj-error' : 'fb-bj-error';
  var onSaved = function() { if (!dirty) setStatus('Saved & synced', 'ok'); };
  var onErr   = function() { setStatus('Sync failed — saved on this device, will retry', 'err'); };
  window.addEventListener(savedEvt, onSaved);
  window.addEventListener(errEvt, onErr);

  function commit(prompt, name) {
    var t = aiToolById(app, curId);
    var changed = false;
    if (!t.builtin && typeof name === 'string' && name !== t.name) { aiToolRename(app, curId, name); changed = true; }
    if (typeof prompt === 'string' && prompt !== t.prompt) { aiToolSetPrompt(app, curId, prompt); changed = true; }
    dirty = false;
    if (changed) setStatus('Saving…', 'busy');   // the sync events above settle it
    renderList();
  }
  function flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!dirty || !pane) return;
    var ta = pane.querySelector('.docx-prompt-ta');
    var ni = pane.querySelector('.docx-ait-name');
    commit(ta ? ta.value : undefined, ni ? ni.value : undefined);
  }
  function queueSave() {
    dirty = true;
    setStatus('Saving…', 'busy');
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 600);
  }

  function renderList() {
    if (!list) return;
    list.innerHTML = '';
    aiToolList(app).forEach(function(t) {
      var row = document.createElement('button');
      row.className = 'docx-ait-item' + (t.id === curId ? ' on' : '');
      row.innerHTML = '<span class="n"></span>' + (t.builtin ? '<span class="tag">Built-in</span>' : '');
      row.querySelector('.n').textContent = t.name;
      row.addEventListener('click', function() { flush(); curId = t.id; renderList(); renderPane(); });
      list.appendChild(row);
    });
  }

  function renderPane() {
    if (!pane) return;
    var t = aiToolById(app, curId);
    curId = t.id;
    pane.innerHTML = '';

    var head = document.createElement('div');
    head.className = 'docx-ait-head';
    var nameIn = document.createElement('input');
    nameIn.className = 'docx-ait-name';
    nameIn.type = 'text';
    nameIn.value = t.name;
    nameIn.spellcheck = false;
    if (t.builtin) { nameIn.readOnly = true; nameIn.title = 'Built-in tools keep their name; their prompt is fully editable.'; }
    else {
      nameIn.addEventListener('input', queueSave);
      nameIn.addEventListener('blur', flush);
    }
    head.appendChild(nameIn);
    pane.appendChild(head);

    var note = document.createElement('div');
    note.className = 'docx-prompt-note';
    note.innerHTML = (t.hint ? '<b>' + esc(t.hint) + '</b><br>' : '') +
      'This prompt is what the AI is told to do with your text. Highlight something before running the tool and it works on the selection only; with nothing highlighted it works on the whole document. Saved for <b>' + esc(aiJournalName(app)) +
      '</b> and synced to every device the moment you change it.';
    pane.appendChild(note);

    var ta = document.createElement('textarea');
    ta.className = 'docx-prompt-ta';
    ta.spellcheck = false;
    ta.value = t.prompt;
    ta.addEventListener('input', queueSave);
    ta.addEventListener('blur', flush);
    pane.appendChild(ta);
    docxTonyGrip(ta, app, 'mj.ai-prompt', 'the AI prompt');

    var row = document.createElement('div');
    row.className = 'docx-ait-actions';
    statusEl = document.createElement('div');
    statusEl.className = 'docx-ait-status';
    statusEl.textContent = '';
    row.appendChild(statusEl);

    var reset = document.createElement('button');
    reset.className = 'docx-btn';
    reset.textContent = 'Reset to default';
    reset.title = t.builtin ? 'Restore the original built-in prompt.' : 'Restore the prompt this tool was created with.';
    reset.addEventListener('click', function() {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      dirty = false;
      aiToolReset(app, curId);
      renderPane();
      setStatus('Reset to default — saving…', 'busy');
      docxToast('“' + t.name + '” prompt reset to default.');
    });
    row.appendChild(reset);

    if (!t.builtin) {
      var del = document.createElement('button');
      del.className = 'docx-btn danger';
      del.textContent = 'Delete tool';
      del.addEventListener('click', async function() {
        var ok = await window.uiConfirm('Delete the AI tool “' + t.name + '”? This removes it on every device.', { title: 'Delete AI tool', danger: true });
        if (!ok) return;
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
        dirty = false;
        aiToolDelete(app, t.id);
        curId = 'format';
        renderList(); renderPane();
        docxToast('“' + t.name + '” deleted & synced.');
      });
      row.appendChild(del);
    }
    pane.appendChild(row);
  }

  var veil = modal('AI Tools', function(b) {
    b.classList.add('docx-ait-body');
    var wrap = document.createElement('div');
    wrap.className = 'docx-ait-wrap';

    var col = document.createElement('div');
    col.className = 'docx-ait-listcol';
    list = document.createElement('div');
    list.className = 'docx-ait-list';
    col.appendChild(list);
    var add = document.createElement('button');
    add.className = 'docx-ait-add';
    add.textContent = '+  New AI tool';
    add.addEventListener('click', function() {
      flush();
      aiAddToolModal(app, function(id) { curId = id; renderList(); renderPane(); });
    });
    col.appendChild(add);

    pane = document.createElement('div');
    pane.className = 'docx-ait-pane';

    wrap.appendChild(col);
    wrap.appendChild(pane);
    b.appendChild(wrap);
    renderList();
    renderPane();
  }, function(f, close) {
    var done = document.createElement('button');
    done.className = 'docx-btn pri';
    done.textContent = 'Done';
    done.addEventListener('click', function() { flush(); close(); });
    f.style.justifyContent = 'flex-end';
    f.appendChild(done);
  });
  var box = veil.querySelector('.docx-modal');
  if (box) box.style.width = 'min(960px, 100%)';
  // The modal can also be dismissed by the X or the backdrop, which never runs
  // our close handler — watch for its removal so the listeners don't leak.
  var obs = new MutationObserver(function() {
    if (veil.isConnected) return;
    window.removeEventListener(savedEvt, onSaved);
    window.removeEventListener(errEvt, onErr);
    obs.disconnect();
  });
  obs.observe(document.body, { childList: true });
  return veil;
}

/* Create a custom tool. Name + prompt only — everything else about it behaves
   exactly like a built-in. */
function aiAddToolModal(app, onCreated) {
  if (_docxFeatureLocked(app, 'aiPrompt')) { _docxLockedToast(); return; }
  var veil = modal('Add AI Tool', function(b) {
    b.classList.add('docx-prompt-body');
    var note = document.createElement('div');
    note.className = 'docx-prompt-note';
    note.innerHTML = 'Give the tool a name and tell the AI what to do with your document. It appears in the <b>AI Tools</b> menu right away and syncs to all your devices.';
    b.appendChild(note);

    var lbl = document.createElement('div');
    lbl.className = 'docx-ait-lbl';
    lbl.textContent = 'Tool name';
    b.appendChild(lbl);
    var nameIn = document.createElement('input');
    nameIn.className = 'docx-ait-name docx-ait-newname';
    nameIn.type = 'text';
    nameIn.placeholder = 'e.g. Summarize, Make Concise, Translate to Spanish';
    nameIn.spellcheck = false;
    b.appendChild(nameIn);

    var lbl2 = document.createElement('div');
    lbl2.className = 'docx-ait-lbl';
    lbl2.textContent = 'AI prompt';
    b.appendChild(lbl2);
    var ta = document.createElement('textarea');
    ta.className = 'docx-prompt-ta';
    ta.spellcheck = false;
    ta.value = AI_CUSTOM_STARTER_PROMPT;
    b.appendChild(ta);
    docxTonyGrip(ta, app, 'mj.ai-newtool', 'the AI prompt');
    setTimeout(function() { nameIn.focus(); }, 40);
  }, function(f, close) {
    var create = document.createElement('button');
    create.className = 'docx-btn pri';
    create.textContent = 'Create tool';
    create.addEventListener('click', function() {
      var box = f.closest('.docx-modal');
      var name = box.querySelector('.docx-ait-newname').value.trim();
      var prompt = box.querySelector('.docx-prompt-ta').value;
      if (!name) { docxToast('Give the tool a name first.', true); return; }
      if (!prompt.trim()) { docxToast('Give the tool a prompt first.', true); return; }
      var id = aiToolAdd(app, name, prompt);
      docxToast('“' + name + '” added & synced.');
      close();
      if (typeof onCreated === 'function') onCreated(id);
    });
    f.style.justifyContent = 'flex-end';
    f.appendChild(create);
  });
  var box = veil.querySelector('.docx-modal');
  if (box) box.style.width = 'min(760px, 100%)';
}

/* The AI Tools dropdown: every tool, then create/manage. Shared by the ribbon
   button and the Tools menu so both stay in lockstep. */
function aiToolsMenuInto(p, ctx) {
  var app = ctx.app;
  // Whether a run is selection-only is decided at click time by aiRunTool, but
  // say so up front so the hover text matches what pressing it will do.
  var r = savedSelFor(ctx);
  var hasSel = !!(r && !r.collapsed && ctx.edEl.contains(r.commonAncestorContainer) && r.toString().trim());
  var scope = hasSel ? '\n\nRuns on your highlighted text only.' : '\n\nNothing highlighted — runs on the whole document.';
  p.appendChild(mlabel('AI Tools' + (hasSel ? ' · selection' : '')));
  aiToolList(app).forEach(function(t) {
    var item = mi(t.name, function() { aiRunTool(ctx, aiToolById(app, t.id)); });
    item.title = aiToolHint(t) + scope;
    if (_docxFeatureLocked(app, 'aiFormat')) item.classList.add('docx-feature-locked');
    p.appendChild(item);
  });
  p.appendChild(msep());
  var add = mi('Add AI Tool…', function() { aiAddToolModal(app); });
  add.title = 'Create your own AI tool: give it a name and a prompt. It appears in this menu and syncs to all your devices.';
  var edit = mi('Edit prompts…', function() { aiToolsModal(app); });
  edit.title = 'Edit any tool\'s prompt, rename or delete your own tools, or reset a prompt back to its default.';
  if (_docxFeatureLocked(app, 'aiPrompt')) { add.classList.add('docx-feature-locked'); edit.classList.add('docx-feature-locked'); }
  p.appendChild(add);
  p.appendChild(edit);
}
// NOTE: the selection was already captured on the anchor's mousedown — don't
// call saveSel() here or the (now collapsed) post-click selection overwrites it.
function aiToolsPop(ctx, anchor) {
  showPop(anchor, function(p) { aiToolsMenuInto(p, ctx); });
}

/* ═══════════ Ribbon / menubar construction ═══════════ */
function ptBtn(html, title) {
  var b = document.createElement('button');
  b.className = 'pt-btn';
  b.innerHTML = html;
  b.title = title || '';
  return b;
}
function ptSep() { var d = document.createElement('div'); d.className = 'pt-sep'; return d; }

function fontPop(ctx, anchor) {
  saveSel(ctx);
  showPop(anchor, function(pop) {
    var search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'Search fonts…';
    search.style.marginBottom = '5px';
    pop.appendChild(search);
    var holder = document.createElement('div');
    pop.appendChild(holder);
    function renderList(q) {
      holder.innerHTML = '';
      FONTS.filter(function(f) { return !q || f.toLowerCase().includes(q.toLowerCase()); }).forEach(function(f) {
        var b = document.createElement('button');
        b.className = 'docx-mi docx-fontitem';
        b.textContent = f;
        b.style.fontFamily = "'" + f + "', sans-serif";
        b.addEventListener('click', function() {
          closePop();
          restoreSel(ctx);
          document.execCommand('styleWithCSS', false, true);
          document.execCommand('fontName', false, f);
          document.execCommand('styleWithCSS', false, false);
          saveSel(ctx);
          fireInput(ctx.edEl);
          if (ctx.fontLbl) ctx.fontLbl.textContent = f;
        });
        holder.appendChild(b);
      });
      if (!holder.children.length) holder.innerHTML = '<div class="docx-empty-note" style="padding:12px 0;">No fonts match.</div>';
    }
    renderList('');
    search.addEventListener('input', function() { renderList(search.value); });
    setTimeout(function() { search.focus(); }, 30);
  });
}

function lineSpacingPop(ctx, anchor) {
  saveSel(ctx);
  // Collect the ratio for EVERY selected block, so mixed selections check-mark all present spacings.
  var ratios = [];
  selBlocks(ctx).forEach(function(b) {
    var r;
    if (b.style.lineHeight) r = parseFloat(b.style.lineHeight);
    else {
      var fs = parseFloat(getComputedStyle(b).fontSize) || 16;
      var lh = parseFloat(getComputedStyle(b).lineHeight);
      r = lh ? lh / fs : null;
    }
    if (r != null) ratios.push(r);
  });
  var near = function(a, b) { return Math.abs(parseFloat(a) - parseFloat(b)) < 0.09; };
  var anyMatches = function(vals) { return ratios.some(function(r) { return vals.some(function(v) { return near(r, v); }); }); };
  showPop(anchor, function(pop) {
    pop.appendChild(mlabel('Line spacing'));
    [['1.0', '1.15'], ['1.15', '1.38'], ['1.5', '1.8'], ['2.0', '2.4']].forEach(function(o) {
      var active = anyMatches([o[1], o[0]]);
      pop.appendChild(mi(o[0], function() { setBlockStyle(ctx, 'lineHeight', o[1]); }, null, active));
    });
    pop.appendChild(msep());
    pop.appendChild(mlabel('Paragraph spacing'));
    pop.appendChild(mi('Add space before paragraph', function() { setBlockStyle(ctx, 'marginTop', '12px', true); }));
    pop.appendChild(mi('Add space after paragraph', function() { setBlockStyle(ctx, 'marginBottom', '12px', true); }));
    pop.appendChild(msep());
    pop.appendChild(mlabel('Indentation'));
    pop.appendChild(mi('First-line indent', function() { setBlockStyle(ctx, 'textIndent', '48px', true); }));
    pop.appendChild(mi('Hanging indent', function() {
      restoreSel(ctx);
      selBlocks(ctx).forEach(function(b) {
        var on = b.style.textIndent === '-48px';
        b.style.textIndent = on ? '' : '-48px';
        b.style.paddingLeft = on ? '' : '48px';
      });
      fireInput(ctx.edEl);
    }));
  });
}

/* -- Bulk list conversion (checklist / bullets / numbers) --------------------
   Highlighting a block of text and hitting a list button must give ONE item per line
   with every line's text intact. Two things used to break that: the checklist button
   ran insertHTML, which REPLACES the selection with a single empty item (the text was
   simply gone); and <br>-separated lines inside one block are a single block as far as
   execCommand is concerned, so bullets/numbers collapsed them into one item. Both now
   go through the same line-splitting front end below. */

function _isClItem(b) { return !!(b && b.classList && b.classList.contains('docx-cl-item')); }

// A line's markup, with any checklist chrome (the box + text span) stripped off.
// An "empty" line (nothing but a <br>) comes back as ''.
function _blockLineHTML(b) {
  var t = _isClItem(b) ? b.querySelector('.docx-cl-text') : null;
  var html = t ? t.innerHTML : b.innerHTML;
  return /^\s*(<br\s*\/?>)?\s*$/i.test(html) ? '' : html;
}

function _clLi(html) {
  var li = document.createElement('li');
  li.className = 'docx-cl-item';
  li.innerHTML = '<input type="checkbox" class="docx-cl-box" contenteditable="false">' +
                 '<span class="docx-cl-text">' + (html || '&nbsp;') + '</span>';
  return li;
}

// Editors routinely keep the FIRST line as a bare text / inline run directly under the
// editor, with only the later lines wrapped in <div>s -- that is just what contenteditable
// produces. A bare run is not a block, so selBlocks never sees it and that line was the one
// line a "select everything" conversion silently skipped.
var _DOCX_BLOCK_TAG = /^(P|H[1-6]|DIV|UL|OL|LI|TABLE|BLOCKQUOTE|PRE|HR|FIGURE|SECTION)$/;

function _hasBareRoot(ed) {
  return Array.prototype.some.call(ed.childNodes, function(n) {
    if (n.nodeType === 1) return !_DOCX_BLOCK_TAG.test(n.tagName);
    return n.nodeType === 3 && !!n.nodeValue.replace(/\s/g, '');
  });
}

// The selection as character offsets within the editor -- node offsets stop being valid the
// moment the wrapping below moves nodes into new parents, character offsets survive it.
function _selOffsets(ed) {
  var s = window.getSelection();
  if (!s || !s.rangeCount) return null;
  var r = s.getRangeAt(0);
  if (!ed.contains(r.startContainer) || !ed.contains(r.endContainer)) return null;
  try {
    var a = r.cloneRange(); a.selectNodeContents(ed); a.setEnd(r.startContainer, r.startOffset);
    var b = r.cloneRange(); b.selectNodeContents(ed); b.setEnd(r.endContainer, r.endOffset);
    return [a.toString().length, b.toString().length];
  } catch (e) { return null; }
}

function _restoreSelOffsets(ed, off) {
  if (!off) return false;
  var walk = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT, null);
  var pos = 0, a = null, b = null, n;
  while ((n = walk.nextNode())) {
    var len = n.nodeValue.length;
    if (!a && off[0] <= pos + len) a = [n, off[0] - pos];
    if (!b && off[1] <= pos + len) b = [n, off[1] - pos];
    pos += len;
    if (a && b) break;
  }
  if (!a || !b) return false;
  try {
    var r = document.createRange();
    r.setStart(a[0], Math.max(0, Math.min(a[1], a[0].nodeValue.length)));
    r.setEnd(b[0], Math.max(0, Math.min(b[1], b[0].nodeValue.length)));
    var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  } catch (e) { return false; }
  return true;
}

// Wrap every bare run in a <div> so it is a real block and converts like everything else.
// Renders identically either way.
function _normalizeBareLines(ed) {
  var BLOCK = _DOCX_BLOCK_TAG;
  var kids = Array.prototype.slice.call(ed.childNodes), run = [], changed = false;
  function flush() {
    if (!run.length) return;
    var d = document.createElement('div');
    run[0].parentNode.insertBefore(d, run[0]);
    run.forEach(function(n) { d.appendChild(n); });
    run = []; changed = true;
  }
  kids.forEach(function(n) {
    if (n.nodeType === 1 && BLOCK.test(n.tagName)) { flush(); return; }
    if (n.nodeType === 3 && !n.nodeValue.replace(/\s/g, '') && !run.length) return;   // stray whitespace
    run.push(n);
  });
  flush();
  return changed;
}

// Split a block holding <br>-separated lines into one sibling block per line, so every
// visible line is a real block. Returns the blocks that replaced it, or [b] if untouched.
function _splitBlockLines(b) {
  if (!b || !b.parentNode || b.tagName === 'PRE') return [b];        // <pre> line breaks are content
  var kids = Array.prototype.slice.call(b.childNodes);
  if (!kids.some(function(n) { return n.nodeType === 1 && n.tagName === 'BR'; })) return [b];
  var segs = [[]];
  kids.forEach(function(n) {
    if (n.nodeType === 1 && n.tagName === 'BR') segs.push([]);
    else segs[segs.length - 1].push(n);
  });
  var filled = function(seg) {
    return seg.some(function(n) {
      if ((n.textContent || '').replace(/[\u200b\s]/g, '')) return true;
      return n.nodeType === 1 && (/^(IMG|INPUT|HR)$/.test(n.tagName) || !!n.querySelector('img,input,hr'));
    });
  };
  // A trailing <br> is the block's own line-break padding, not an extra line.
  while (segs.length > 1 && !filled(segs[segs.length - 1])) segs.pop();
  if (segs.length < 2) return [b];
  var frag = document.createDocumentFragment(), out = [];
  segs.forEach(function(seg) {
    var c = b.cloneNode(false);                                       // same tag, same block styling
    seg.forEach(function(n) { c.appendChild(n); });
    if (!c.childNodes.length) c.appendChild(document.createElement('br'));
    frag.appendChild(c); out.push(c);
  });
  b.parentNode.replaceChild(frag, b);
  return out;
}

// Character offsets of `range` inside block `b`, clamped to b's own text.
function _rangeOffsetsIn(range, b) {
  var full = (b.textContent || '').length, start = 0, end = full;
  try {
    if (b === range.startContainer || b.contains(range.startContainer)) {
      var a = range.cloneRange(); a.selectNodeContents(b); a.setEnd(range.startContainer, range.startOffset);
      start = a.toString().length;
    }
    if (b === range.endContainer || b.contains(range.endContainer)) {
      var z = range.cloneRange(); z.selectNodeContents(b); z.setEnd(range.endContainer, range.endOffset);
      end = z.toString().length;
    }
  } catch (e) { return [0, full]; }
  return start <= end ? [start, end] : [end, start];
}

function _selectBlocks(blocks) {
  if (!blocks.length) return;
  try {
    var last = blocks[blocks.length - 1], r = document.createRange();
    r.setStart(blocks[0], 0);
    r.setEnd(last, last.childNodes.length);
    var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  } catch (e) {}
}

// Put the selection across a freshly built run of items (inside the text span for
// checklist items), so the converted lines stay highlighted and can be toggled again.
function _selectItems(items) {
  if (!items.length) return;
  try {
    var a = items[0], z = items[items.length - 1];
    var an = (a.querySelector && a.querySelector('.docx-cl-text')) || a;
    var zn = (z.querySelector && z.querySelector('.docx-cl-text')) || z;
    var r = document.createRange();
    r.setStart(an, 0);
    r.setEnd(zn, zn.childNodes.length);
    var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  } catch (e) {}
}

// Every LINE the selection touches, as a real block: blocks holding <br> lines are exploded
// first and only the lines actually inside the selection come back. `reselect` re-anchors
// the selection across the result -- execCommand needs that after the DOM moved under it.
function selLineBlocks(ctx, reselect) {
  var ed = ctx.edEl;
  var s = window.getSelection();
  if (!s || !s.rangeCount || !ed.contains(s.anchorNode)) return [];
  // Bare runs first, holding the selection by character offset across the move -- otherwise
  // whichever lines are not wrapped in a block (typically the first one) are simply invisible
  // here and get skipped.
  if (_hasBareRoot(ed)) {
    var off = _selOffsets(ed);
    if (_normalizeBareLines(ed) && off) _restoreSelOffsets(ed, off);
  }
  var blocks = selBlocks(ctx);
  if (!blocks.length) return [];
  var range = window.getSelection().getRangeAt(0);
  var out = [], split = false;
  blocks.forEach(function(b) {
    if (!b.parentNode) return;
    // Work out which of b's lines the selection covers BEFORE the split, while the live
    // range still points into b. Offsets survive the split: it only moves nodes around.
    var off = _rangeOffsetsIn(range, b);
    var parts = _splitBlockLines(b);
    if (parts.length < 2) { out.push(b); return; }
    split = true;
    var pos = 0, picked = [];
    for (var i = 0; i < parts.length; i++) {
      var len = (parts[i].textContent || '').length, a = pos, z = pos + len;
      pos = z;
      if (off[0] === off[1]) { if (off[0] <= z) { picked = [parts[i]]; break; } }   // collapsed caret
      else if (a < off[1] && z > off[0]) picked.push(parts[i]);
      else if (len === 0 && a > off[0] && a < off[1]) picked.push(parts[i]);        // blank line inside the span
    }
    out = out.concat(picked.length ? picked : [parts[0]]);
  });
  if (split && reselect) _selectBlocks(out);
  return out;
}

// True for a bullet / numbered list item (a checklist item is not one).
function _isPlainLi(b) {
  if (!b || b.tagName !== 'LI' || _isClItem(b)) return false;
  var par = b.parentNode;
  return !!par && (par.tagName === 'UL' || par.tagName === 'OL');
}

// Lift list items out of their list and back into plain <p> blocks, keeping their text.
// Items that were NOT passed in stay listed in a list of their own, so a partial selection
// splits the list rather than flattening it. Returns the new blocks, aligned with `items`.
// Done by hand rather than through execCommand so the caller keeps live references to the
// resulting blocks — re-reading the selection after the DOM moved is what used to lose them.
function _unwrapItems(ctx, items, quiet) {
  var made = new Array(items.length), groups = [];
  items.forEach(function(li) {
    if (!li.parentNode) return;
    var g = groups.filter(function(x) { return x.list === li.parentNode; })[0];
    if (!g) { g = { list: li.parentNode, items: [] }; groups.push(g); }
    g.items.push(li);
  });
  groups.forEach(function(g) {
    var frag = document.createDocumentFragment(), chunk = null;
    Array.prototype.slice.call(g.list.children).forEach(function(li) {
      if (g.items.indexOf(li) >= 0) {
        chunk = null;
        var b = document.createElement('p');
        b.innerHTML = _blockLineHTML(li) || '<br>';
        var sz = li.style.fontSize || _blockTextSize(li);
        if (sz) b.style.fontSize = sz;
        if (li.style.textAlign) b.style.textAlign = li.style.textAlign;
        frag.appendChild(b);
        made[items.indexOf(li)] = b;
      } else {
        if (!chunk) {
          chunk = document.createElement(g.list.tagName);
          if (g.list.className) chunk.className = g.list.className;
          frag.appendChild(chunk);
        }
        chunk.appendChild(li);
      }
    });
    if (g.list.parentNode) g.list.parentNode.replaceChild(frag, g.list);
  });
  if (!quiet) {
    _selectItems(made.filter(Boolean));
    saveSel(ctx);
    fireInput(ctx.edEl);
  }
  return made;
}

// Adjacent single-item checklists (one per converted line) become one list.
function _mergeChecklists(ed) {
  ed.querySelectorAll('ul.docx-checklist').forEach(function(ul) {
    var prev = ul.previousSibling;
    while (prev && prev.nodeType === 3 && !prev.nodeValue.replace(/\s/g, '')) prev = prev.previousSibling;
    if (prev && prev.nodeType === 1 && prev.tagName === 'UL' && prev.classList.contains('docx-checklist')) {
      while (ul.firstChild) prev.appendChild(ul.firstChild);
      ul.parentNode.removeChild(ul);
    }
  });
}

// Replace every list item in `blocks` that matches `pick` with the plain block it unwraps to,
// so the caller's line list stays valid across the un-listing.
function _unwrapInPlace(ctx, blocks, pick) {
  var items = [], at = [];
  blocks.forEach(function(b, i) { if (pick(b)) { items.push(b); at.push(i); } });
  if (!items.length) return false;
  var made = _unwrapItems(ctx, items, true);
  at.forEach(function(bi, k) { if (made[k]) blocks[bi] = made[k]; });
  return true;
}

// Checklist button / Insert > Checklist. Converts EVERY selected line into its own item
// (text intact); toggles back to paragraphs when the selection is already all checklist.
function insertChecklist(ctx) {
  restoreSel(ctx);
  var ed = ctx.edEl, sel = window.getSelection();
  var blocks = (sel && sel.rangeCount && ed.contains(sel.anchorNode)) ? selLineBlocks(ctx, true) : [];
  if (!blocks.length) {   // nothing to convert (empty doc / lost selection) -- drop a fresh item in
    insertHTML(ctx, '<ul class="docx-checklist">' + _clLi('').outerHTML + '</ul>');
    return;
  }
  if (blocks.every(_isClItem)) { _unwrapItems(ctx, blocks); return; }   // toggle the checklist off
  _unwrapInPlace(ctx, blocks, _isPlainLi);                              // bullets/numbers -> plain lines
  var made = [];
  blocks.forEach(function(b) {
    if (!b.parentNode || !ed.contains(b)) return;
    if (_isClItem(b)) { made.push(b); return; }        // already an item -- leave it alone
    var size = _blockTextSize(b);
    var li = _clLi(_blockLineHTML(b));
    if (size) li.style.fontSize = size;
    if (b.style.textAlign) li.style.textAlign = b.style.textAlign;
    var ul = document.createElement('ul');
    ul.className = 'docx-checklist';
    ul.appendChild(li);
    b.parentNode.replaceChild(ul, b);
    made.push(li);
  });
  _mergeChecklists(ed);
  _selectItems(made);
  saveSel(ctx);
  fireInput(ed);
}

function buildMenubar(ctx) {
  var app = ctx.app, cfg = APPS[app];
  var bar = document.createElement('div');
  bar.className = 'docx-menubar';
  function menu(name, build) {
    var b = document.createElement('button');
    b.className = 'docx-menu-btn';
    b.textContent = name;
    b.addEventListener('mousedown', function(e) { e.preventDefault(); saveSel(ctx); });
    b.addEventListener('click', function() {
      if (openPop && openPop._btn === b) { closePop(); return; }
      showPop(b, build);
    });
    bar.appendChild(b);
  }
  menu('File', function(p) {
    p.appendChild(mi('New entry', function() { var nb = $(cfg.newBtn); if (nb) nb.click(); }));
    p.appendChild(mi('Rename document', function() { var t = $(app === 'tj' ? 'tj-entry-title-input' : 'bj-entry-title-input'); if (t) { t.focus(); t.select(); } }));
    p.appendChild(msep());
    p.appendChild(mi('Print / Export PDF', function() { var eb = $(cfg.exportBtn); if (eb) eb.click(); }, 'Ctrl+P'));
    p.appendChild(msep());
    // The ribbon's trash button is desktop-only; keep the action reachable on touch.
    p.appendChild(mi('Clear all content', function() {
      var cb = ctx.tbEl.querySelector('[id$="-pt-clear"]'); if (cb) cb.click();
    }));
  });
  menu('Edit', function(p) {
    p.appendChild(mi('Undo', function() { ctx.history.undo(); }, 'Ctrl+Z'));
    p.appendChild(mi('Redo', function() { ctx.history.redo(); }, 'Ctrl+Y'));
    p.appendChild(msep());
    p.appendChild(mi('Select all', function() { restoreSel(ctx); document.execCommand('selectAll'); }, 'Ctrl+A'));
    p.appendChild(msep());
    p.appendChild(mi('Find…', function() { frOpen(ctx, false); }, 'Ctrl+F'));
    p.appendChild(mi('Find & replace…', function() { frOpen(ctx, true); }, 'Ctrl+H'));
  });
  menu('View', function(p) {
    p.appendChild(mlabel('Layout'));
    p.appendChild(mi('Fit text to screen', function() { setReflow(app, !rfGet(app)); }, null, rfGet(app)));
    p.appendChild(mi('Page layout', function() { setReflow(app, false); }, null, !rfGet(app)));
    p.appendChild(msep());
    p.appendChild(mlabel('Zoom'));
    ZOOMS.forEach(function(z) {
      p.appendChild(mi(Math.round(z * 100) + '%', function() { setZoom(app, z); }, null, zGet(app) === z));
    });
    p.appendChild(mi('Fit width', function() { setZoom(app, 'fit'); }, null, zGet(app) === 'fit'));
    p.appendChild(msep());
    p.appendChild(mi('Toggle sidebar', function() { var sb = $(cfg.sidebarBtn); if (sb) sb.click(); }));
  });
  menu('Insert', function(p) {
    if (ctx.imgEl) p.appendChild(mi('Image/File…', function() { ctx.imgEl.click(); }));
    p.appendChild(mi('Table…', function() { tableGridPop(ctx, ctx.tbEl); }));
    p.appendChild(mi('Link…', async function() { var url = await window.uiPrompt('Link URL:', {title:'Insert link', placeholder:'https://…'}); if (url) exec(ctx, 'createLink', url); }));
    p.appendChild(mi('Horizontal divider', function() { exec(ctx, 'insertHorizontalRule'); }));
    p.appendChild(mi('Page break', function() { insertHTML(ctx, '<hr class="docx-pagebreak"><p><br></p>'); }));
    p.appendChild(mi('Code block', function() { exec(ctx, 'formatBlock', 'pre'); }));
    p.appendChild(mi('Checklist', function() { insertChecklist(ctx); }));
    p.appendChild(msep());
    p.appendChild(mi('Date', function() { exec(ctx, 'insertText', new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })); }));
    p.appendChild(mi('Time', function() { exec(ctx, 'insertText', new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })); }));
  });
  menu('Format', function(p) {
    // Font family lives only in the ribbon, which is trimmed on phones — expose it here too.
    p.appendChild(mi('Font…', function() { fontPop(ctx, ctx.tbEl); }));
    p.appendChild(msep());
    p.appendChild(mi('Bold', function() { exec(ctx, 'bold'); }, 'Ctrl+B'));
    p.appendChild(mi('Italic', function() { exec(ctx, 'italic'); }, 'Ctrl+I'));
    p.appendChild(mi('Underline', function() { exec(ctx, 'underline'); }, 'Ctrl+U'));
    p.appendChild(mi('Strikethrough', function() { exec(ctx, 'strikeThrough'); }));
    p.appendChild(mi('Inline code', function() { var cb = ctx.tbEl.querySelector('[id$="-pt-code"]'); if (cb) cb.click(); }));
    p.appendChild(msep());
    p.appendChild(mi('Align left', function() { exec(ctx, 'justifyLeft'); }));
    p.appendChild(mi('Align center', function() { exec(ctx, 'justifyCenter'); }));
    p.appendChild(mi('Align right', function() { exec(ctx, 'justifyRight'); }));
    p.appendChild(mi('Justify', function() { exec(ctx, 'justifyFull'); }));
    p.appendChild(msep());
    p.appendChild(mi('Increase indent', function() { exec(ctx, 'indent'); }));
    p.appendChild(mi('Decrease indent', function() { exec(ctx, 'outdent'); }));
    p.appendChild(mi('Line & paragraph spacing…', function() { lineSpacingPop(ctx, ctx.tbEl); }));
    p.appendChild(msep());
    p.appendChild(mi('Clear formatting', function() { exec(ctx, 'removeFormat'); }));
    p.appendChild(msep());
    p.appendChild(mi('Page setup…', function() { pageSetupModal(app); }));
  });
  menu('Tools', function(p) {
    aiToolsMenuInto(p, ctx);
    p.appendChild(msep());
    if (ctx.mdEl) {
      var mdMi = mi('Render Markdown', function() { ctx.mdEl.click(); });
      if (_docxFeatureLocked(app, 'renderMarkdown')) mdMi.classList.add('docx-feature-locked');
      p.appendChild(mdMi);
    }
    var unMi = mi('Unrender Markdown', function() { unrenderMarkdown(ctx); });
    if (_docxFeatureLocked(app, 'unrenderMarkdown')) unMi.classList.add('docx-feature-locked');
    p.appendChild(unMi);
    p.appendChild(msep());
    p.appendChild(mi('Word count', function() { wordCountModal(ctx); }));
    p.appendChild(mi('Keyboard shortcuts', shortcutsModal));
  });
  menu('Table', function(p) {
    p.appendChild(mi('Insert table…', function() { tableGridPop(ctx, ctx.tbEl); }));
    p.appendChild(msep());
    p.appendChild(mi('Insert row above', function() { restoreSel(ctx); tblInsertRow(ctx, false); }));
    p.appendChild(mi('Insert row below', function() { restoreSel(ctx); tblInsertRow(ctx, true); }));
    p.appendChild(mi('Insert column left', function() { restoreSel(ctx); tblInsertCol(ctx, false); }));
    p.appendChild(mi('Insert column right', function() { restoreSel(ctx); tblInsertCol(ctx, true); }));
    p.appendChild(msep());
    p.appendChild(mi('Delete row', function() { restoreSel(ctx); tblDeleteRow(ctx); }));
    p.appendChild(mi('Delete column', function() { restoreSel(ctx); tblDeleteCol(ctx); }));
    p.appendChild(mi('Delete table', function() { restoreSel(ctx); tblDelete(ctx); }));
    p.appendChild(msep());
    p.appendChild(mi('Toggle header row', function() { restoreSel(ctx); tblToggleHeader(ctx); }));
  });
  // The AI prompt editor moved out of Help and into the AI Tools menu.
  menu('Help', function(p) {
    p.appendChild(mi('Keyboard shortcuts', shortcutsModal));
  });
  ctx.tbEl.insertBefore(bar, ctx.tbEl.firstChild);
}

// ── Clean stroke-icon set (16px, currentColor) for a consistent Word-like ribbon ──
var IC = {
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>',
  print: '<path d="M6 9V3h12v6"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8" rx="1"/>',
  justify: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="3" y1="14" x2="21" y2="14"/><line x1="3" y1="18" x2="21" y2="18"/>',
  indentInc: '<polyline points="4 8 8 12 4 16"/><line x1="12" y1="6" x2="21" y2="6"/><line x1="12" y1="12" x2="21" y2="12"/><line x1="12" y1="18" x2="21" y2="18"/>',
  indentDec: '<polyline points="8 8 4 12 8 16"/><line x1="12" y1="6" x2="21" y2="6"/><line x1="12" y1="12" x2="21" y2="12"/><line x1="12" y1="18" x2="21" y2="18"/>',
  spacing: '<line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><polyline points="4 8 6 6 8 8"/><polyline points="4 16 6 18 8 16"/><line x1="6" y1="6" x2="6" y2="18"/>',
  checklist: '<polyline points="3 6 4.5 7.5 7 5"/><polyline points="3 17 4.5 18.5 7 16"/><line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/>',
  find: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  clearFmt: '<path d="M5 5h14"/><path d="M11 5 8 19"/><line x1="6" y1="19" x2="12" y2="19"/><line x1="15.5" y1="10.5" x2="21" y2="16"/><line x1="21" y1="10.5" x2="15.5" y2="16"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="4" x2="9" y2="20"/><line x1="15" y1="4" x2="15" y2="20"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m21 16-5-5L5 20"/>',
  ai: '<path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z"/><path d="M18 14l.8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8z"/>',
  eraser: '<path d="M20 20H7L3 16a2 2 0 0 1 0-3l8-8a2 2 0 0 1 3 0l6 6a2 2 0 0 1 0 3l-7 6"/><line x1="9" y1="10" x2="15" y2="16"/>',
  highlight: '<path d="M4 20h6"/><path d="m14 4 6 6-9 9-6 1 1-6z"/>',
  fullscreen: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  fullscreenExit: '<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>',
};
function svg(paths, size) {
  return '<svg width="' + (size || 15) + '" height="' + (size || 15) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + paths + '</svg>';
}
// Replace a button's leading emoji/text glyph with an SVG, preserving element children (e.g. a nested file <input>).
function setBtnIcon(btn, paths) {
  if (!btn) return;
  Array.prototype.slice.call(btn.childNodes).forEach(function(n) {
    if (n.nodeType === 3 || (n.nodeType === 1 && n.tagName !== 'INPUT')) btn.removeChild(n);
  });
  var span = document.createElement('span');
  span.style.cssText = 'display:inline-flex;align-items:center;';
  span.innerHTML = svg(paths);
  btn.insertBefore(span, btn.firstChild);
}

function injectRibbonExtras(ctx) {
  var tb = ctx.tbEl;
  // ── AI Tools + Undo / Redo / Print at the very start (after menubar) ──
  var startFrag = document.createDocumentFragment();
  var aiB = ptBtn(svg(IC.ai) + '<span class="docx-ai-lbl" style="margin-left:4px;font-weight:600;">AI Tools</span>' +
                  '<span class="docx-ai-caret">▾</span>',
                  'AI Tools — AI Format, AI Refine, or your own tools.\nHighlight text to run on the selection only; highlight nothing to run on the whole document.');
  aiB.className = 'pt-btn docx-ai-btn docx-r1';
  if (_docxFeatureLocked(ctx.app, 'aiFormat')) { aiB.classList.add('docx-feature-locked'); aiB.title = 'This feature has been disabled on your journal.'; }
  // Clicking the button steals focus from the editor, which clears/collapses
  // window.getSelection() before the click handler runs -- so a text
  // selection must be captured on mousedown (same pattern as every other
  // toolbar button) or aiRunTool(ctx) always sees "no selection".
  aiB.addEventListener('mousedown', function(e) { e.preventDefault(); saveSel(ctx); });
  aiB.addEventListener('click', function() {
    if (openPop && openPop._btn === aiB) { closePop(); return; }
    aiToolsPop(ctx, aiB);
  });
  var undoB = ptBtn(svg(IC.undo), 'Undo (Ctrl+Z)');
  undoB.classList.add('pt-disabled', 'docx-r1');
  undoB.addEventListener('click', function() { if (!undoB.classList.contains('pt-disabled')) ctx.history.undo(); });
  var redoB = ptBtn(svg(IC.redo), 'Redo (Ctrl+Y)');
  redoB.classList.add('pt-disabled', 'docx-r1');
  redoB.addEventListener('click', function() { if (!redoB.classList.contains('pt-disabled')) ctx.history.redo(); });
  ctx.undoBtn = undoB; ctx.redoBtn = redoB;
  // Desktop-only in the ribbon: File ▸ Print / Export PDF covers touch, and the
  // main toolbar already carries an Export PDF button.
  var printB = ptBtn(svg(IC.print), 'Print / Export PDF (Ctrl+P)');
  printB.addEventListener('click', function() { var eb = $(APPS[ctx.app].exportBtn); if (eb) eb.click(); });
  startFrag.appendChild(aiB);
  startFrag.appendChild(ptSep());
  startFrag.appendChild(undoB);
  startFrag.appendChild(redoB);
  startFrag.appendChild(printB);
  startFrag.appendChild(ptSep());
  var menubar = tb.querySelector('.docx-menubar');
  tb.insertBefore(startFrag, menubar ? menubar.nextSibling : tb.firstChild);

  // ── Font family dropdown before the font-size select ──
  var fsSel = tb.querySelector('[id$="-fontsize"]');
  var fontB = ptBtn('', 'Font family');
  fontB.className = 'pt-btn docx-fontfam-btn docx-r2';
  fontB.style.minWidth = '104px';
  fontB.style.justifyContent = 'space-between';
  var fontLbl = document.createElement('span');
  fontLbl.textContent = 'Arial';
  fontLbl.style.cssText = 'max-width:92px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  fontB.appendChild(fontLbl);
  var caret = document.createElement('span');
  caret.textContent = '▾';
  caret.style.cssText = 'font-size:9px;opacity:.7;margin-left:3px;';
  fontB.appendChild(caret);
  fontB.addEventListener('mousedown', function(e) { e.preventDefault(); saveSel(ctx); });
  fontB.addEventListener('click', function() { fontPop(ctx, fontB); });
  ctx.fontLbl = fontLbl;
  if (fsSel) tb.insertBefore(fontB, fsSel);
  else tb.appendChild(fontB);

  // ── Justify + indent + spacing + checklist after align-right ──
  var alignR = tb.querySelector('[id$="-alignR"]');
  var midFrag = document.createDocumentFragment();
  var justB = ptBtn(svg(IC.justify), 'Justify');
  justB.addEventListener('click', function() { exec(ctx, 'justifyFull'); });
  var outB = ptBtn(svg(IC.indentDec), 'Decrease indent');
  outB.classList.add('docx-r2');
  outB.addEventListener('mousedown', function(e) { e.preventDefault(); saveSel(ctx); });
  outB.addEventListener('click', function() { indentBlocks(ctx, -1); });
  var inB = ptBtn(svg(IC.indentInc), 'Increase indent');
  inB.classList.add('docx-r2');
  inB.addEventListener('mousedown', function(e) { e.preventDefault(); saveSel(ctx); });
  inB.addEventListener('click', function() { indentBlocks(ctx, 1); });
  var lsB = ptBtn(svg(IC.spacing), 'Line & paragraph spacing');
  lsB.addEventListener('mousedown', function(e) { e.preventDefault(); saveSel(ctx); });
  lsB.addEventListener('click', function() { lineSpacingPop(ctx, lsB); });
  midFrag.appendChild(justB);
  midFrag.appendChild(ptSep());
  midFrag.appendChild(outB);
  midFrag.appendChild(inB);
  midFrag.appendChild(lsB);
  if (alignR && alignR.parentNode === tb) tb.insertBefore(midFrag, alignR.nextSibling);
  else tb.appendChild(midFrag);

  // ── Checklist button after the ordered-list button ──
  var olB = tb.querySelector('[id$="-ol"]');
  var clB = ptBtn(svg(IC.checklist), 'Checklist');
  clB.classList.add('docx-r2');
  // Same as every other toolbar button: keep the editor's selection alive across the click,
  // or a multi-line highlight is gone by the time the handler runs.
  clB.addEventListener('mousedown', function(e) { e.preventDefault(); saveSel(ctx); });
  clB.addEventListener('click', function() { insertChecklist(ctx); });
  if (olB && olB.parentNode === tb) tb.insertBefore(clB, olB.nextSibling);
  else tb.appendChild(clB);

  // ── Refresh the existing app buttons' glyphs to match the SVG ribbon ──
  setBtnIcon(tb.querySelector('[id$="-table"]'), IC.table);
  setBtnIcon(tb.querySelector('[id$="-page-img-btn"], [id$="-je-img-btn"]'), IC.image);
  var clearAllB = tb.querySelector('[id$="-pt-clear"]');
  if (clearAllB) { setBtnIcon(clearAllB, IC.eraser); if (!clearAllB.title) clearAllB.title = 'Clear all content'; }
  var hlIcon = tb.querySelector('[id$="-hl-icon"]');   // keep the color swatch, leave as-is

  // ── Table grid picker replaces the old fixed 3×3 insert on the table button. ──
  var tblB = tb.querySelector('[id$="-table"]');
  if (tblB) {
    var tblB2 = tblB.cloneNode(true);
    tblB.parentNode.replaceChild(tblB2, tblB);
    tblB2.addEventListener('mousedown', function(e) { e.preventDefault(); saveSel(ctx); });
    tblB2.addEventListener('click', function() { tableGridPop(ctx, tblB2); });
  }

  // ── Find + Zoom + Clear-formatting before the trailing flex spacer ──
  var spacer = null;
  Array.prototype.forEach.call(tb.children, function(chEl) {
    if (!spacer && chEl.tagName === 'DIV' && /flex:\s*1/.test(chEl.getAttribute('style') || '')) spacer = chEl;
  });
  var endFrag = document.createDocumentFragment();
  endFrag.appendChild(ptSep());
  var findB = ptBtn(svg(IC.find), 'Find & replace (Ctrl+F)');
  findB.classList.add('docx-r2');
  findB.addEventListener('click', function() { frOpen(ctx, true); });
  endFrag.appendChild(findB);
  // Desktop-only: touch defaults to reflow, where zoom is a no-op. View ▸ Zoom
  // still covers the case where someone switches back to page layout.
  var zoomSel = document.createElement('select');
  zoomSel.className = 'pt-select docx-zoom-sel';
  zoomSel.title = 'Zoom';
  ZOOMS.forEach(function(z) {
    var o = document.createElement('option');
    o.value = String(z);
    o.textContent = Math.round(z * 100) + '%';
    zoomSel.appendChild(o);
  });
  var fitO = document.createElement('option');
  fitO.value = 'fit';
  fitO.textContent = 'Fit';
  zoomSel.appendChild(fitO);
  zoomSel.value = String(zGet(ctx.app));
  zoomSel.addEventListener('change', function() {
    var v = this.value === 'fit' ? 'fit' : parseFloat(this.value);
    setZoom(ctx.app, v);
  });
  endFrag.appendChild(zoomSel);
  var clearFB = ptBtn(svg(IC.clearFmt), 'Clear ALL formatting');
  clearFB.addEventListener('mousedown', function(e) { e.preventDefault(); saveSel(ctx); });
  clearFB.addEventListener('click', function() { clearAllFormatting(ctx); });
  endFrag.appendChild(clearFB);
  endFrag.appendChild(ptSep());
  // ── Page fullscreen (Batch 10 #4): fill the whole browser window, hiding the
  // sidebar + app header. Esc or the button (icon flips) exits. ──
  var fsB = ptBtn(svg(IC.fullscreen), 'Fullscreen page (Esc to exit)');
  fsB.className += ' docx-pagefs-btn docx-r1';
  fsB.addEventListener('click', function() { togglePageFullscreen(ctx); });
  ctx._pagefsBtn = fsB;
  endFrag.appendChild(fsB);
  if (spacer) tb.insertBefore(endFrag, spacer);
  else tb.appendChild(endFrag);
}

/* ═══════════ Responsive ribbon ═══════════
   The toolbar is two logical rows: the menu bar (File/Edit/View/…) and the
   ribbon. Left as one flat flex container they fight each other on narrow
   screens — the menu bar's width:100% collapses to nothing once the container
   is forced nowrap, which is why the menus were unreachable on phones. Wrapping
   the ribbon controls in their own row lets each row size independently, and
   lets the .docx-r1/.docx-r2 priority classes hide desktop-only controls on
   small screens (every one of them is still reachable from the menu bar). */
function groupRibbon(ctx) {
  var tb = ctx.tbEl;
  if (!tb || tb.querySelector(':scope > .docx-ribbonrow')) return;
  var row = document.createElement('div');
  row.className = 'docx-ribbonrow';
  Array.prototype.slice.call(tb.children).forEach(function(k) {
    if (!k.classList || !k.classList.contains('docx-menubar')) row.appendChild(k);
  });
  tb.appendChild(row);
  ctx.ribbonRow = row;
}

/* ═══════════ Reflow (fit text to screen) ═══════════
   A letter-width page sheet zoomed down to fit a phone renders 12pt body text
   at ~5pt — legible on paper, useless on glass. Reflow drops the fixed page
   width and paper margins so text wraps to the device at full size (what Word
   and Docs call "mobile/web layout"). Default: on at ≤900px, off above; the
   View menu toggles it and the choice is remembered per app. */
function _reflowAuto() { return window.innerWidth <= 900; }
function rfGet(app) {
  var v = lsGet('docx_reflow_' + app, 'auto');
  return v === 'auto' ? _reflowAuto() : !!v;
}
function applyReflow(app) {
  var cfg = APPS[app]; if (!cfg) return;
  var on = rfGet(app);
  cfg.ctxs.forEach(function(c) {
    var w = $(c.wrap); if (w) w.classList.toggle('docx-reflow', on);
    // The horizontal ruler is a sibling of the toolbar, above the wrap, so it
    // can't be reached by a descendant/sibling selector from the wrap.
    var a = c.area ? $(c.area) : null; if (a) a.classList.toggle('docx-reflow-on', on);
  });
  applyZoom(app);
}
function setReflow(app, on) { lsSet('docx_reflow_' + app, !!on); applyReflow(app); }
window._docxSetReflow = setReflow;

/* ═══════════ Page fullscreen (overtake the browser window) ═══════════ */
function _pageFsClass(app) { return app + '-page-fs'; }
function _setPageFsBtn(ctx, on) {
  if (!ctx._pagefsBtn) return;
  ctx._pagefsBtn.innerHTML = svg(on ? IC.fullscreenExit : IC.fullscreen);
  ctx._pagefsBtn.title = on ? 'Exit fullscreen (Esc)' : 'Fullscreen page (Esc to exit)';
}
// Icons for the floating fullscreen controls.
var _IC_BARHIDE = '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/><path d="m2 2 20 20" stroke-width="2.4"/>';
var _IC_BARSHOW = '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>';
var _IC_SIDEBAR = '<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="9" y1="4" x2="9" y2="20"/>';
// Build (once) the floating top-right control cluster for an app's fullscreen mode.
function _ensureFsFloat(ctx) {
  if (ctx._fsFloat) return ctx._fsFloat;
  var main = document.getElementById(ctx.app + '-main') || document.body;
  var box = document.createElement('div');
  box.className = 'docx-fs-float for-' + ctx.app;
  // Toggle the sidebar (see / swap between other documents while in fullscreen).
  var sideBtn = document.createElement('button');
  sideBtn.title = 'Show documents sidebar';
  sideBtn.innerHTML = svg(_IC_SIDEBAR);
  sideBtn.addEventListener('click', function () {
    var root = document.getElementById(ctx.app + '-root');
    var shown = root.classList.toggle(ctx.app + '-fs-sidebar');
    sideBtn.title = shown ? 'Hide documents sidebar' : 'Show documents sidebar';
    sideBtn.classList.toggle('on', shown);
    requestAnimationFrame(function () { try { applyZoom(ctx.app); updateRulers(ctx.app); } catch (e) {} });
  });
  var barBtn = document.createElement('button');
  barBtn.title = 'Hide document bar';
  barBtn.innerHTML = svg(_IC_BARHIDE);
  barBtn.addEventListener('click', function () {
    var root = document.getElementById(ctx.app + '-root');
    var hidden = root.classList.toggle(ctx.app + '-fs-nobar');
    barBtn.innerHTML = svg(hidden ? _IC_BARSHOW : _IC_BARHIDE);
    barBtn.title = hidden ? 'Show document bar' : 'Hide document bar';
    requestAnimationFrame(function () { try { applyZoom(ctx.app); updateRulers(ctx.app); } catch (e) {} });
  });
  var exitBtn = document.createElement('button');
  exitBtn.title = 'Exit fullscreen (Esc)';
  exitBtn.innerHTML = svg(IC.fullscreenExit);
  exitBtn.addEventListener('click', function () { setPageFullscreen(ctx, false); });
  box.appendChild(sideBtn);
  box.appendChild(barBtn);
  box.appendChild(exitBtn);
  main.appendChild(box);
  ctx._fsFloat = box; ctx._fsBarBtn = barBtn; ctx._fsSideBtn = sideBtn;
  return box;
}
function setPageFullscreen(ctx, on) {
  var root = document.getElementById(ctx.app + '-root');
  if (!root) return;
  root.classList.toggle(_pageFsClass(ctx.app), !!on);
  // Also hide the body-level shared app nav (Tony's #tony-app-nav sits OUTSIDE the
  // root, in a higher stacking context, so the fixed overlay can't cover it).
  var anyFs = ALLCTX.some(function (c) { var r = document.getElementById(c.app + '-root'); return r && r.classList.contains(_pageFsClass(c.app)); });
  document.body.classList.toggle('docx-page-fs', anyFs);
  if (on) _ensureFsFloat(ctx);
  if (!on) {   // leaving fullscreen: restore the document bar + sidebar toggle state
    root.classList.remove(ctx.app + '-fs-nobar');
    root.classList.remove(ctx.app + '-fs-sidebar');
    if (ctx._fsBarBtn) { ctx._fsBarBtn.innerHTML = svg(_IC_BARHIDE); ctx._fsBarBtn.title = 'Hide document bar'; }
    if (ctx._fsSideBtn) { ctx._fsSideBtn.classList.remove('on'); ctx._fsSideBtn.title = 'Show documents sidebar'; }
  }
  _setPageFsBtn(ctx, !!on);
  // recompute the "fit" zoom for the new (wider) available width
  requestAnimationFrame(function() { try { applyZoom(ctx.app); updateRulers(ctx.app); } catch (e) {} });
}
function togglePageFullscreen(ctx) {
  var root = document.getElementById(ctx.app + '-root');
  if (!root) return;
  setPageFullscreen(ctx, !root.classList.contains(_pageFsClass(ctx.app)));
}
// Global Esc handler — leave fullscreen for whichever page is currently maximized.
if (!window._docxPageFsEscBound) {
  window._docxPageFsEscBound = true;
  document.addEventListener('keydown', function(e) {
    if (e.key !== 'Escape') return;
    ALLCTX.forEach(function(ctx) {
      var root = document.getElementById(ctx.app + '-root');
      if (root && root.classList.contains(_pageFsClass(ctx.app))) setPageFullscreen(ctx, false);
    });
  });
}

/* ═══════════ Robust block / inline-code / link / indent / clear operations ═══════════ */
function changeBlockTag(el, tag) {
  var n = document.createElement(tag);
  // carry over inline block styles (indent margin, text-align, line spacing)
  if (el.style.cssText) n.style.cssText = el.style.cssText;
  while (el.firstChild) n.appendChild(el.firstChild);
  // When becoming a heading, drop any inline font-size on the block AND its inner
  // spans so the heading renders at its proper size (not a leftover body size).
  if (/^H[1-6]$/i.test(tag)) {
    n.style.fontSize = '';
    n.querySelectorAll('[style*="font-size"]').forEach(function (s) {
      s.style.fontSize = '';
      if (!(s.getAttribute('style') || '').trim() && s.tagName === 'SPAN') { var p = s.parentNode; while (s.firstChild) p.insertBefore(s.firstChild, s); p.removeChild(s); }
    });
  }
  el.parentNode.replaceChild(n, el);
  return n;
}
// True if the range covers essentially all of the block's content.

// Split a block so ONLY the selected text takes the new tag: before / [selected→tag] / after.

function setBlock(ctx, tag) {
  restoreSel(ctx);
  var sel = window.getSelection();
  var blocks = selBlocks(ctx);
  if (!blocks.length) { document.execCommand('formatBlock', false, tag); fireInput(ctx.edEl); return; }
  // Whole-block conversion (like Word / Google Docs): the type applies to every
  // paragraph the selection touches — no splitting, so nothing gets pushed to a new
  // line, backspace behaves normally, reverting rejoins cleanly, and inline font-size
  // spans are carried over (changeBlockTag moves the children), so sizes never change.
  var changed = [];
  blocks.forEach(function(b) {
    if (b.tagName === 'LI') return; // don't retag list items
    // toggle: choosing the tag it already is → back to paragraph
    var target = (b.tagName.toLowerCase() === tag.toLowerCase()) ? 'p' : tag;
    if (b.tagName.toLowerCase() === target.toLowerCase()) { changed.push(b); return; }
    changed.push(changeBlockTag(b, target));
  });
  // Re-select across all converted blocks so the selection (and the toolbar) stay put.
  if (changed.length) {
    var r = document.createRange();
    r.setStart(changed[0], 0);
    r.setEnd(changed[changed.length - 1], changed[changed.length - 1].childNodes.length);
    var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    saveSel(ctx);
  }
  fireInput(ctx.edEl);
  updateBlockSelect(ctx);
}
function updateBlockSelect(ctx) {
  var sel = ctx.tbEl.querySelector('[id$="-pt-block"]');
  if (!sel) return;
  var b = selBlocks(ctx)[0];
  var tag = b ? b.tagName.toLowerCase() : 'p';
  sel.value = ({ h1: 'h1', h2: 'h2', h3: 'h3', pre: 'pre', blockquote: 'blockquote' })[tag] || 'p';
}
function codeAncestor(ctx) { return closestInEd(ctx, 'code'); }
function toggleInlineCode(ctx) {
  restoreSel(ctx);
  var existing = codeAncestor(ctx);
  if (existing) { _unwrap(existing); ctx.edEl.normalize(); fireInput(ctx.edEl); return; }
  var sel = window.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return;
  var range = sel.getRangeAt(0);
  // strip any <code> fully inside the selection first (avoid nesting)
  var frag = range.cloneContents();
  var tmp = document.createElement('div'); tmp.appendChild(frag);
  var text = tmp.textContent;
  var code = document.createElement('code');
  code.textContent = text;
  range.deleteContents();
  range.insertNode(code);
  var r2 = document.createRange(); r2.selectNodeContents(code); r2.collapse(false);
  sel.removeAllRanges(); sel.addRange(r2);
  fireInput(ctx.edEl);
}
function linkAncestor(ctx) { return closestInEd(ctx, 'a'); }
async function toggleLink(ctx) {
  restoreSel(ctx);
  var a = linkAncestor(ctx);
  if (a) {
    // already a link → offer edit / remove via a small popup
    linkPopup(ctx, a);
    return;
  }
  var sel = window.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) { docxToast('Select text first to add a link.'); return; }
  var url = await window.uiPrompt('Link URL:', {title:'Insert link', placeholder:'https://…'});
  if (!url) return;
  restoreSel(ctx); // modal input stole focus/selection — put the saved range back before createLink
  if (!/^(https?:|mailto:|tel:|#|\/)/i.test(url)) url = 'https://' + url;
  document.execCommand('createLink', false, url);
  // mark new links to open in a new tab
  ctx.edEl.querySelectorAll('a[href="' + url + '"]').forEach(function(x) { x.setAttribute('target', '_blank'); x.setAttribute('rel', 'noopener'); });
  fireInput(ctx.edEl);
}
function linkPopup(ctx, a) {
  showPop(ctx.tbEl.querySelector('[id$="-pt-link"]') || ctx.tbEl, function(p) {
    p.appendChild(mi('Open link', function() { window.open(a.href, '_blank', 'noopener'); }));
    p.appendChild(mi('Edit link…', async function() {
      var url = await window.uiPrompt('Link URL:', {title:'Edit link', default:a.href});
      if (url) { if (!/^(https?:|mailto:|tel:|#|\/)/i.test(url)) url = 'https://' + url; a.href = url; fireInput(ctx.edEl); }
    }));
    p.appendChild(mi('Remove link', function() { _unwrap(a); ctx.edEl.normalize(); fireInput(ctx.edEl); }));
  });
}
function indentBlocks(ctx, dir) {
  restoreSel(ctx);
  var blocks = selBlocks(ctx);
  if (!blocks.length) return;
  blocks.forEach(function(b) {
    var cur = parseInt(b.style.marginLeft, 10) || 0;
    var next = Math.max(0, cur + dir * 40);
    b.style.marginLeft = next ? next + 'px' : '';
  });
  fireInput(ctx.edEl);
}
// Clear CHARACTER formatting only (bold/italic/underline/strike, font family/size,
// color/highlight, super/subscript, letter-spacing, text effects). KEEPS the text,
// paragraph breaks, lists, and document structure (headings, blockquotes, links).
function clearAllFormatting(ctx) {
  restoreSel(ctx);
  var sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  var range = sel.getRangeAt(0);
  if (!ctx.edEl.contains(range.commonAncestorContainer)) return;
  var CHARPROPS = ['fontFamily','fontSize','fontWeight','fontStyle','color','background','backgroundColor','backgroundImage','backgroundClip','WebkitBackgroundClip','textDecoration','textDecorationLine','textDecorationColor','letterSpacing','wordSpacing','textShadow','verticalAlign','textTransform','fontVariant','WebkitTextStroke','boxShadow','WebkitTextFillColor'];
  // Containers a paste can hang a background on. The old list stopped at the
  // block that holds the text, so a background painted on the <ol>/<table>/
  // wrapper around it survived every clear — the reported "I can't get rid of
  // the black box behind pasted text".
  var STRIPPABLE = /^(P|H[1-6]|LI|OL|UL|BLOCKQUOTE|PRE|DIV|SPAN|SECTION|ARTICLE|MAIN|HEADER|FOOTER|ASIDE|FIGURE|FIGCAPTION|DL|DT|DD|TABLE|THEAD|TBODY|TFOOT|TR|TD|TH|CAPTION|COLGROUP|COL|A|CODE|LABEL|SMALL|ADDRESS|CENTER|FONT)$/;
  // KaTeX renders math with inline font styling of its own — stripping that
  // turns a rendered equation into garbage, so math subtrees are left alone.
  function inMath(el) { return !!(el.closest && el.closest('.docx-math')); }
  function intersects(el) { try { return range.intersectsNode(el); } catch (e) { return true; } }
  function stripEl(el) {
    if (inMath(el)) return;
    CHARPROPS.forEach(function(p) { el.style[p] = ''; });
    el.removeAttribute('bgcolor');
    if (!(el.getAttribute('style') || '').trim()) el.removeAttribute('style');
  }
  // 1) Browser-native inline strip (bold/italic/underline/strike/color/bg/font/size/sub/sup).
  document.execCommand('styleWithCSS', false, true);
  document.execCommand('removeFormat');
  document.execCommand('styleWithCSS', false, false);
  // 2) Remove our custom <mark> highlights intersecting the selection.
  if (window._docxStripHighlight) window._docxStripHighlight(ctx.edEl, range.cloneRange());
  // 3) Unwrap any inline formatting ELEMENTS the browser left behind (b/i/u/s/strike/…).
  Array.prototype.slice.call(ctx.edEl.querySelectorAll('b,strong,i,em,u,s,strike,del,ins,sub,sup,font,mark,big,tt')).forEach(function(el) {
    if (intersects(el) && !inMath(el)) _unwrap(el);
  });
  // 4) Strip character styles left on spans, on the block elements themselves
  //    (block-level strikethrough/colour on a <p>/<blockquote>/<li>), and on the
  //    list/table/section containers a paste may have painted.
  Array.prototype.slice.call(ctx.edEl.querySelectorAll('[style],[bgcolor]')).forEach(function(el) {
    if (!intersects(el)) return;
    if (!STRIPPABLE.test(el.tagName)) return;
    stripEl(el);
    if (el.tagName === 'SPAN' && !el.getAttribute('style')) _unwrap(el);
  });
  // 5) Walk the ancestors of the selection up to the editor. A wrapper that
  //    CONTAINS the whole selection is what usually carries a pasted page's
  //    background, and it is the one thing a selection-based sweep can miss.
  var anc = range.commonAncestorContainer;
  if (anc.nodeType === 3) anc = anc.parentNode;
  while (anc && anc !== ctx.edEl) {
    if (anc.nodeType === 1 && STRIPPABLE.test(anc.tagName)) stripEl(anc);
    anc = anc.parentNode;
  }
  // The editor itself can be handed a background by a whole-document paste.
  ctx.edEl.style.background = '';
  ctx.edEl.style.backgroundColor = '';
  ctx.edEl.removeAttribute('bgcolor');
  ctx.edEl.normalize();
  fireInput(ctx.edEl);
}

// Re-bind the existing app toolbar buttons to the robust module implementations (Pages only).
function rebindPageButtons(ctx) {
  var tb = ctx.tbEl;
  function replaceBtn(sel) {
    var b = tb.querySelector(sel);
    if (!b) return null;
    var n = b.cloneNode(true);
    b.parentNode.replaceChild(n, b);
    n.addEventListener('mousedown', function(e) { e.preventDefault(); saveSel(ctx); });
    return n;
  }
  // inline code toggle
  var codeB = replaceBtn('[id$="-pt-code"]');
  if (codeB) codeB.addEventListener('click', function() { toggleInlineCode(ctx); });
  // link add / edit / remove
  var linkB = replaceBtn('[id$="-pt-link"]');
  if (linkB) linkB.addEventListener('click', function() { toggleLink(ctx); });
  // block-type <select> — robust tag toggle
  var blkSel = tb.querySelector('[id$="-pt-block"]');
  if (blkSel) {
    var nb = blkSel.cloneNode(true);
    blkSel.parentNode.replaceChild(nb, blkSel);
    nb.addEventListener('mousedown', function() { saveSel(ctx); });
    nb.addEventListener('change', function() { setBlock(ctx, this.value); });
  }
  // font-size <select> — robust apply that works on an EMPTY doc / collapsed caret too
  var fsSel = tb.querySelector('[id$="-pt-fontsize"]');
  if (fsSel) {
    var nf = fsSel.cloneNode(true);
    fsSel.parentNode.replaceChild(nf, fsSel);
    // Reset to blank as the dropdown opens so picking the SAME value still fires 'change'
    // (native selects don't fire change on an unchanged value) → item 6.
    nf.addEventListener('mousedown', function() { saveSel(ctx); this._disp = this.value; this.value = ''; });
    nf.addEventListener('change', function() { var px = this.value; if (px) applyFontSize(ctx, px); else this.value = this._disp || ''; });
    nf.addEventListener('blur', function() { if (this.value === '') this.value = this._disp || ''; });
    // Increase / Decrease font-size buttons — step every selected size run by a uniform delta,
    // preserving the relative differences within the selection.
    if (!tb.querySelector('.docx-fs-step')) {
      var decB = document.createElement('button');
      decB.className = 'pt-btn docx-fs-step docx-r2'; decB.title = 'Decrease font size';
      decB.innerHTML = '<span style="font-size:10px;font-weight:800;line-height:1;">A</span><span style="font-size:8px;margin-left:1px;">▼</span>';
      var incB = document.createElement('button');
      incB.className = 'pt-btn docx-fs-step docx-r2'; incB.title = 'Increase font size';
      incB.innerHTML = '<span style="font-size:14px;font-weight:800;line-height:1;">A</span><span style="font-size:8px;margin-left:1px;">▲</span>';
      [decB, incB].forEach(function(b) { b.addEventListener('mousedown', function(e) { e.preventDefault(); saveSel(ctx); }); });
      decB.addEventListener('click', function() { stepFontSize(ctx, -1); });
      incB.addEventListener('click', function() { stepFontSize(ctx, 1); });
      var frag = document.createDocumentFragment();
      frag.appendChild(decB); frag.appendChild(incB);
      if (nf.nextSibling) nf.parentNode.insertBefore(frag, nf.nextSibling); else nf.parentNode.appendChild(frag);
    }
  }
  // list toggles — preserve the font size when un-listing (item 8)
  var ulB = replaceBtn('[id$="-pt-ul"]');
  if (ulB) ulB.addEventListener('click', function() { toggleListPreserve(ctx, 'insertUnorderedList'); });
  var olB = replaceBtn('[id$="-pt-ol"]');
  if (olB) olB.addEventListener('click', function() { toggleListPreserve(ctx, 'insertOrderedList'); });
  // Render Markdown — selective (highlighted) or whole-doc; always re-renderable (item 6)
  var mdB = replaceBtn('[id$="-pt-md"]');
  if (mdB) {
    if (_docxFeatureLocked(ctx.app, 'renderMarkdown')) { mdB.classList.add('docx-feature-locked'); mdB.title = 'This feature has been disabled on your journal.'; }
    mdB.addEventListener('click', function() { renderMarkdown(ctx); });
    // Unrender Markdown — the exact reverse of Render (whole doc, or only the selection).
    if (!tb.querySelector('.docx-unmd-btn')) {
      var unmdB = document.createElement('button');
      unmdB.className = 'pt-btn docx-unmd-btn';
      unmdB.style.cssText = 'font-weight:700;font-size:11px;';
      unmdB.textContent = 'Unrender';
      unmdB.title = 'Unrender Markdown — convert formatted content back to raw Markdown';
      if (_docxFeatureLocked(ctx.app, 'unrenderMarkdown')) { unmdB.classList.add('docx-feature-locked'); unmdB.title = 'This feature has been disabled on your journal.'; }
      unmdB.addEventListener('mousedown', function(e) { e.preventDefault(); saveSel(ctx); });
      unmdB.addEventListener('click', function() { unrenderMarkdown(ctx); });
      if (mdB.nextSibling) mdB.parentNode.insertBefore(unmdB, mdB.nextSibling); else mdB.parentNode.appendChild(unmdB);
    }
  }
}

// Render Markdown. With a selection → render ONLY the selected text. With no selection →
// render the whole document (and convert any leftover $…$ text to math), so you can
// unrender/re-render math freely at any time (item 6).
function renderMarkdown(ctx) {
  if (_docxFeatureLocked(ctx.app, 'renderMarkdown')) { _docxLockedToast(); return; }
  var ed = ctx.edEl;
  restoreSel(ctx);
  var sel = window.getSelection();
  if (sel && sel.rangeCount && !sel.isCollapsed && ed.contains(sel.anchorNode) && ed.contains(sel.focusNode)) {
    var range = sel.getRangeAt(0);
    // Work off a clone: parking media mutates the DOM, and the live range has to
    // stay valid until deleteContents() below.
    var holder = document.createElement('div');
    holder.appendChild(range.cloneContents());
    var keptSel = _docxParkMedia(holder);
    var src = keptSel.length ? _docxOffscreenText(holder) : sel.toString();
    if (!src) src = _docxOffscreenText(holder);   // robust fallback
    var rendered = (window._mdToHtml(src) || '').replace(/<p><br><\/p>\s*$/, '').trim();
    if (window._docxMathify) rendered = window._docxMathify(rendered);
    var tmp = document.createElement('div'); tmp.innerHTML = rendered;
    // If it rendered to a single paragraph, insert its INLINE contents so we don't nest a
    // <p> inside the selection's block (invalid → the browser would drop it).
    if (tmp.children.length === 1 && tmp.firstElementChild.tagName === 'P' && !tmp.firstElementChild.querySelector('div,p,ul,ol,table,blockquote,pre,h1,h2,h3,h4,h5,h6')) {
      var inner = document.createElement('div'); inner.innerHTML = tmp.firstElementChild.innerHTML; tmp = inner;
    }
    // NOTHING to render in the selection (no markdown produced any elements) → do nothing (item 3).
    if (tmp.children.length === 0) return;
    _docxRestoreKept(tmp, keptSel);
    var frag = document.createDocumentFragment();
    while (tmp.firstChild) frag.appendChild(tmp.firstChild);
    range.deleteContents(); range.insertNode(frag);
  } else {
    // "Rendered" = ANY rendered structure: block tags OR rendered math OR inline formatting/links.
    // (The old check missed rendered math, so a math-only doc got a destructive FULL re-render.)
    // An attachment chip is media, not rendered markdown — counting it as "rendered"
    // left an unrendered document that Render then refused to touch.
    var hasRendered = /<(h[1-6]|ul|ol|blockquote|table|pre)\b/i.test(ed.innerHTML) ||
                      !!ed.querySelector('.docx-math, .katex, strong, b, em, i, u, s, code, mark, sub, sup, a[href]:not([download])');
    if (!hasRendered) {
      // Park images/chips first: the full render rebuilds from text, and media has none.
      var keptAll = _docxParkMedia(ed);
      var raw = ed.innerText.trim();
      if (raw.length > 0) {
        ed.innerHTML = window._mdToHtml(raw);   // entirely raw → full render
        _docxRestoreKept(ed, keptAll);
      } else {
        _docxRestoreKept(ed, keptAll);          // nothing to render — put the media straight back
        return;
      }
    } else {
      // Partially/fully rendered: convert ONLY leftover raw $…$ math / raw tables IN PLACE, never
      // reparse innerHTML (that broke existing formatting). Nothing raw left → do NOTHING (item 2).
      var changed = _docxConvertRawMath(ed);
      if (window._renderMdTables && /\|[^\n]*\n[ \t]*\|?[\s:|-]*-[\s:|-]*\|/.test(ed.innerText)) {
        var before = ed.innerHTML; window._renderMdTables(ed);
        if (ed.innerHTML !== before) changed = true;
      }
      if (!changed) return;   // everything already rendered → no-op
    }
  }
  if (window._docxRenderMath) window._docxRenderMath(ed);
  fireInput(ed);
}
// Convert leftover $…$ / $$…$$ math that appears as TEXT into .docx-math elements, IN PLACE
// (walks text nodes only — never reparses the document, so existing formatting is untouched).
function _docxConvertRawMath(root) {
  if (!window._docxMathify) return false;
  var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: function(n) {
      if (n.parentElement && n.parentElement.closest('.docx-math, code, pre')) return NodeFilter.FILTER_REJECT;
      return /\$[^$\n]+?\$/.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    }
  });
  var nodes = [], n; while ((n = walker.nextNode())) nodes.push(n);
  var changed = false;
  nodes.forEach(function(tn) {
    var safe = tn.nodeValue.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    var conv = window._docxMathify(safe);
    if (conv === safe) return;
    var span = document.createElement('span'); span.innerHTML = conv;
    var frag = document.createDocumentFragment(); while (span.firstChild) frag.appendChild(span.firstChild);
    tn.parentNode.replaceChild(frag, tn);
    changed = true;
  });
  return changed;
}

// Serialize rendered HTML back into raw Markdown text (the reverse of _mdToHtml) — used by Unrender.
var DOCX_KEEP_OPEN = '\uE000', DOCX_KEEP_CLOSE = '\uE001';
// A src/href we must never inline into the text: base64 payloads and the
// journals' Firebase image placeholders, both of which are enormous.
function _docxIsEmbeddedUrl(u) {
  u = String(u || '');
  return /^data:/i.test(u) || /fbimg:\/\//i.test(u) || u.length > 512;
}
function _docxHtmlToMd(root, opts) {
  opts = opts || {};
  // Set aside a node that must survive the round trip verbatim, and stand a
  // sentinel in its place; _docxRestoreKept swaps the real node back in.
  function keepNode(el, placeholder) {
    if (!opts.keep) return placeholder;
    opts.keep.push(el.cloneNode(true));
    return DOCX_KEEP_OPEN + (opts.keep.length - 1) + DOCX_KEEP_CLOSE;
  }
  function kids(node) { var s = ''; Array.prototype.slice.call(node.childNodes).forEach(function (c) { s += ser(c); }); return s; }
  function listMd(listEl, ordered, depth) {
    var lines = [], idx = 1;
    Array.prototype.slice.call(listEl.children).forEach(function (li) {
      if (li.tagName.toLowerCase() !== 'li') return;
      var box = li.querySelector('input[type=checkbox], .docx-cl-box');
      var checked = null;
      if (box || li.classList.contains('docx-cl-item') || li.classList.contains('docx-cl')) checked = box ? (box.checked || box.hasAttribute('checked')) : li.classList.contains('done');
      var marker = checked !== null ? ('- [' + (checked ? 'x' : ' ') + '] ') : (ordered ? (idx + '. ') : '- ');
      var inline = '', nested = [];
      Array.prototype.slice.call(li.childNodes).forEach(function (ch) {
        if (ch.nodeType === 1 && /^(ul|ol)$/i.test(ch.tagName)) nested.push(ch);
        else if (ch.nodeType === 1 && ch.matches && ch.matches('input, .docx-cl-box')) { /* skip checkbox */ }
        else inline += ser(ch);
      });
      lines.push(new Array((depth || 0) + 1).join('  ') + marker + inline.replace(/\s+/g, ' ').trim());
      nested.forEach(function (nl) { lines.push(listMd(nl, nl.tagName.toLowerCase() === 'ol', (depth || 0) + 1)); });
      idx++;
    });
    return lines.join('\n');
  }
  function tableMd(tableEl) {
    var rows = Array.prototype.slice.call(tableEl.querySelectorAll('tr')), lines = [];
    rows.forEach(function (tr, ri) {
      var cells = Array.prototype.slice.call(tr.querySelectorAll('th,td')).map(function (c) { return kids(c).replace(/\s+/g, ' ').trim() || ' '; });
      lines.push('| ' + cells.join(' | ') + ' |');
      if (ri === 0) lines.push('| ' + cells.map(function () { return '---'; }).join(' | ') + ' |');
    });
    return lines.join('\n');
  }
  // Escape characters that _mdToHtml treats as markdown syntax, so literal text that merely
  // CONTAINS them (e.g. from a doc where they were originally backslash-escaped, or from typed
  // symbols like "50% * 2") round-trips back to identical literal text instead of being
  // reinterpreted as emphasis/heading/code/quote/table syntax on the next Render.
  function mdEscText(s) { return String(s).replace(/​/g, '').replace(/[\\`*_~^=#>|[\]]/g, '\\$&'); }
  function ser(node) {
    if (node.nodeType === 3) return mdEscText(node.nodeValue);
    if (node.nodeType !== 1) return '';
    var el = node, tag = el.tagName.toLowerCase();
    if (el.classList) {
      if (el.classList.contains('docx-math')) { var tex = _mathTex(el); return el.classList.contains('docx-math-block') ? ('\n$$' + tex + '$$\n') : ('$' + tex + '$'); }
      if (el.classList.contains('docx-math-resize') || el.classList.contains('docx-file-resize') || el.classList.contains('pg-img-resize-handle') || el.classList.contains('pg-img-del-handle')) return '';
      // Keep a resizable image as one piece rather than serializing its src.
      if (el.classList.contains('pg-img-wrap')) {
        var wImg = el.querySelector('img');
        var wSrc = wImg ? (wImg.getAttribute('src') || '') : '';
        var wAlt = wImg ? (wImg.getAttribute('alt') || '') : '';
        if (_docxIsEmbeddedUrl(wSrc)) return keepNode(el, '![' + wAlt + '](embedded-image)');
        return keepNode(el, '![' + wAlt + '](' + wSrc + ')');
      }
    }
    switch (tag) {
      case 'br': return '\n';
      case 'strong': case 'b': return '**' + kids(el) + '**';
      case 'em': case 'i': return '*' + kids(el) + '*';
      case 's': case 'strike': case 'del': return '~~' + kids(el) + '~~';
      case 'mark': return '==' + kids(el) + '==';
      case 'sub': return '~' + kids(el) + '~';
      case 'sup': return '^' + kids(el) + '^';
      case 'u': return '<u>' + kids(el) + '</u>';
      case 'code': return '`' + el.textContent.replace(/​/g, '') + '`';
      case 'pre': return '\n```\n' + el.textContent.replace(/​/g, '').replace(/\n$/, '') + '\n```\n';
      case 'a': {
        var href = el.getAttribute('href') || '';
        // Attached-file chips carry the whole file in the href.
        if (el.hasAttribute('download') || /-file-chip/.test(el.className || '') || _docxIsEmbeddedUrl(href)) {
          return keepNode(el, '[' + el.textContent.replace(/\u200b/g, '').trim() + '](attached-file)');
        }
        return '[' + kids(el) + '](' + href + ')';
      }
      case 'img': {
        var isrc = el.getAttribute('src') || '', ialt = el.getAttribute('alt') || '';
        if (_docxIsEmbeddedUrl(isrc)) return keepNode(el, '![' + ialt + '](embedded-image)');
        return '![' + ialt + '](' + isrc + ')';
      }
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
        return '\n\n' + new Array(+tag[1] + 1).join('#') + ' ' + kids(el).replace(/\s+/g, ' ').trim() + '\n\n';
      case 'blockquote': { var inr = kids(el).trim(); return '\n\n' + inr.split('\n').map(function (l) { return '> ' + l; }).join('\n') + '\n\n'; }
      case 'hr': return '\n\n---\n\n';
      case 'ul': return '\n\n' + listMd(el, false, 0) + '\n\n';
      case 'ol': return '\n\n' + listMd(el, true, 0) + '\n\n';
      case 'li': {
        // Inside a real list, listMd() has already emitted the marker. Orphaned —
        // which is what a partial selection clone produces — the item has to carry
        // its own, or copying half a list yields run-together words.
        var lip = el.parentNode;
        if (lip && lip.nodeType === 1 && /^(ul|ol)$/i.test(lip.tagName)) return kids(el);
        return '- ' + kids(el).replace(/\s+/g, ' ').trim() + '\n';
      }
      case 'table': return '\n\n' + tableMd(el) + '\n\n';
      case 'p': case 'div': return kids(el) + '\n\n';
      case 'input': return '';
      default: return kids(el);   // span, font, etc. — just their text/markup
    }
  }
  return kids(root).replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();
}
// Replace embedded media in `root` with sentinels and hand back the originals.
// A full re-render rebuilds the document from its TEXT, and an <img>/file chip has
// no text — which is how Render used to delete every screenshot in the document.
function _docxParkMedia(root) {
  var kept = [];
  Array.prototype.slice.call(root.querySelectorAll('.pg-img-wrap, a[download], img')).forEach(function (el) {
    if (!el.parentNode) return;
    if (el.closest('.docx-math')) return;                       // math serializes as $…$
    if (el.tagName === 'IMG' && el.closest('.pg-img-wrap')) return;   // its wrapper covers it
    kept.push(el.cloneNode(true));
    el.parentNode.replaceChild(document.createTextNode(DOCX_KEEP_OPEN + (kept.length - 1) + DOCX_KEEP_CLOSE), el);
  });
  return kept;
}
// Read an element's rendered text, sentinels and all (innerText needs layout).
function _docxOffscreenText(el) {
  var box = document.createElement('div');
  box.style.cssText = 'position:fixed;left:-99999px;top:0;white-space:pre-wrap;';
  box.innerHTML = el.innerHTML;
  document.body.appendChild(box);
  var t = box.innerText || box.textContent || '';
  box.remove();
  return t;
}
// Put the set-aside nodes back where their sentinels landed.
function _docxRestoreKept(container, kept) {
  if (!kept || !kept.length) return;
  var re = /\uE000(\d+)\uE001/;
  var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  var hits = [], n;
  while ((n = walker.nextNode())) { if (re.test(n.nodeValue)) hits.push(n); }
  hits.forEach(function (tn) {
    var parts = tn.nodeValue.split(/\uE000(\d+)\uE001/);   // [text, idx, text, idx, …]
    var frag = document.createDocumentFragment();
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 1) { var el = kept[+parts[i]]; if (el) frag.appendChild(el.cloneNode(true)); }
      else if (parts[i]) frag.appendChild(document.createTextNode(parts[i]));
    }
    if (tn.parentNode) tn.parentNode.replaceChild(frag, tn);
  });
}
// Unrender Markdown — reverse of renderMarkdown. Selection → unrender only it; else → whole doc.
function unrenderMarkdown(ctx) {
  if (_docxFeatureLocked(ctx.app, 'unrenderMarkdown')) { _docxLockedToast(); return; }
  var ed = ctx.edEl;
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  restoreSel(ctx);
  var kept = [];
  var sel = window.getSelection();
  if (sel && sel.rangeCount && !sel.isCollapsed && ed.contains(sel.anchorNode) && ed.contains(sel.focusNode)) {
    var range = sel.getRangeAt(0);
    var holder = document.createElement('div'); holder.appendChild(range.cloneContents());
    var md = _docxHtmlToMd(holder, { keep: kept });
    range.deleteContents();
    var tmp = document.createElement('div'); tmp.innerHTML = esc(md).replace(/\n/g, '<br>');
    _docxRestoreKept(tmp, kept);
    var out = document.createDocumentFragment(); while (tmp.firstChild) out.appendChild(tmp.firstChild);
    range.insertNode(out);
  } else {
    var mdAll = _docxHtmlToMd(ed, { keep: kept });
    var box = document.createElement('div');
    box.innerHTML = mdAll.split(/\n{2,}/).map(function (p) { return '<p>' + esc(p).replace(/\n/g, '<br>') + '</p>'; }).join('') || '<p><br></p>';
    _docxRestoreKept(box, kept);
    ed.innerHTML = box.innerHTML;
  }
  fireInput(ed);
}

// The effective font size of a block's actual TEXT (not the block's own default) — reads the
// computed size at the block's first non-empty text node, so an inline size span is respected.
function _blockTextSize(b) {
  if (!b) return '';
  try {
    var w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT, null);
    var tn = w.nextNode();
    while (tn && !tn.textContent.replace(/[​\s]/g, '')) tn = w.nextNode();
    var el = tn ? (tn.parentElement || b) : b;
    return getComputedStyle(el).fontSize;
  } catch (e) { return getComputedStyle(b).fontSize; }
}
// Toggle a bullet/numbered list while keeping each block's font size (execCommand's
// list→paragraph conversion otherwise drops the size back to the editor default). We pin the
// size onto the resulting block explicitly, so it survives even if the inline span is lost.
function toggleListPreserve(ctx, cmd) {
  restoreSel(ctx);
  // execCommand already gives one item per line for a multi-line selection, <br> lines
  // included -- but not for CHECKLIST lines: toggling those leaves the stray checkbox and
  // text span sitting inside the new bullet. Unwrap them to plain blocks first (and wrap
  // any bare root run, so no line is invisible to the block scan).
  if (_hasBareRoot(ctx.edEl)) {
    var off0 = _selOffsets(ctx.edEl);
    if (_normalizeBareLines(ctx.edEl) && off0) _restoreSelOffsets(ctx.edEl, off0);
  }
  var before = selBlocks(ctx);
  if (_unwrapInPlace(ctx, before, _isClItem)) {
    _selectBlocks(before);
    before = selBlocks(ctx);
  }
  var sizes = before.map(_blockTextSize);
  document.execCommand(cmd, false, null);
  var after = selBlocks(ctx);
  // Always PIN the pre-toggle text size onto the resulting block, locking it so it can never
  // drift back to the editor default (inner size spans, if any, still win over this block size).
  after.forEach(function(b, i) {
    var sz = sizes.length ? sizes[Math.min(i, sizes.length - 1)] : '';
    if (b && sz) b.style.fontSize = sz;
  });
  saveSel(ctx);
  fireInput(ctx.edEl);
}

// Apply a font size to the selection, or set the caret's typing size on an empty/collapsed
// selection. For a collapsed caret we insert a zero-width span at the size and SELECT the ZWSP,
// so the next typed character REPLACES it inside the styled span — the browser's pending
// typing-style can never override it (fixes "types in the old size" for good).
var ZWSP = '​';
function applyFontSize(ctx, px) {
  restoreSel(ctx);
  var sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  var range = sel.getRangeAt(0);
  if (!ctx.edEl.contains(range.commonAncestorContainer)) return;
  // Treat "only a ZWSP selected" (re-picking a size before typing) as collapsed.
  var collapsedLike = sel.isCollapsed || sel.toString() === ZWSP;
  if (collapsedLike) {
    if (!sel.isCollapsed) { range.deleteContents(); range.collapse(true); }
    var span = document.createElement('span');
    span.style.fontSize = px + 'px';
    span.appendChild(document.createTextNode(ZWSP));
    // If the caret's block is effectively empty (all text was just deleted), REPLACE its
    // contents so no leftover old-size span survives to capture the next keystrokes.
    var blk = range.startContainer;
    blk = blk.nodeType === 1 ? blk : blk.parentNode;
    blk = blk && blk.closest ? blk.closest('p,h1,h2,h3,h4,h5,h6,li,div,blockquote,pre') : null;
    if (blk && blk !== ctx.edEl && !blk.textContent.replace(/[​\s]/g, '')) {
      blk.innerHTML = ''; blk.appendChild(span);
    } else {
      range.insertNode(span);
    }
    var r = document.createRange();
    r.setStart(span.firstChild, 0); r.setEnd(span.firstChild, 1);   // SELECT the ZWSP
    sel.removeAllRanges(); sel.addRange(r);
  } else {
    document.execCommand('fontSize', false, '7');
    ctx.edEl.querySelectorAll('font[size="7"]').forEach(function (f) {
      var span = document.createElement('span');
      span.style.fontSize = px + 'px';
      while (f.firstChild) span.appendChild(f.firstChild);
      f.parentNode.replaceChild(span, f);
      var li = span.closest('li'); if (li) li.style.fontSize = px + 'px';
    });
  }
  setFontSizeUI(ctx, px);
  saveSel(ctx);
  fireInput(ctx.edEl);
}
// Clamp a stepped size to a sane range.
function _stepSize(px, dir) { return Math.max(6, Math.min(200, Math.round(px) + dir)); }
// All non-empty text nodes intersecting a range.
function _textNodesInRange(range) {
  var root = range.commonAncestorContainer;
  if (root.nodeType === 3) return [root];
  var nodes = [], w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: function (n) {
      if (!n.nodeValue.length) return NodeFilter.FILTER_REJECT;
      return range.intersectsNode(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    }
  });
  var n; while ((n = w.nextNode())) nodes.push(n);
  return nodes;
}
// Set a single text node's font size to (current ± dir), reusing a wrapping size-only span if possible.
function _adjustNodeSize(tn, dir) {
  var parent = tn.parentElement; if (!parent) return;
  var cur = Math.round(parseFloat(getComputedStyle(parent).fontSize) || 16);
  var next = _stepSize(cur, dir);
  if (next === cur) return;
  var onlyFontSizeSpan = parent.tagName === 'SPAN' && parent.childNodes.length === 1 &&
    parent.style.fontSize && !(parent.getAttribute('style') || '').replace(/font-size\s*:[^;]+;?/i, '').trim();
  if (onlyFontSizeSpan) {
    parent.style.fontSize = next + 'px';
  } else {
    var span = document.createElement('span'); span.style.fontSize = next + 'px';
    tn.parentNode.insertBefore(span, tn); span.appendChild(tn);
  }
}
// Increase (dir=+1) / Decrease (dir=-1) the font size of the selection. Each size run is shifted
// by the SAME uniform delta, so relative size differences within the selection are preserved
// (e.g. 12/16/20 → 13/17/21 on increase). Collapsed caret adjusts the active typing size.
function stepFontSize(ctx, dir) {
  restoreSel(ctx);
  var sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  var range = sel.getRangeAt(0);
  if (!ctx.edEl.contains(range.commonAncestorContainer)) return;
  if (sel.isCollapsed || sel.toString() === ZWSP) {
    var curActive = ctx._activeFontSize || 16;
    applyFontSize(ctx, _stepSize(curActive, dir));
    return;
  }
  // Align range boundaries to node edges so we only affect the selected portion.
  var nodes = _textNodesInRange(range);
  if (!nodes.length) return;
  var last = nodes[nodes.length - 1];
  if (last === range.endContainer && last.nodeType === 3 && range.endOffset > 0 && range.endOffset < last.length) {
    last.splitText(range.endOffset);   // keep the in-range first half (still `last`)
  }
  var first = nodes[0];
  if (first === range.startContainer && first.nodeType === 3 && range.startOffset > 0 && range.startOffset < first.length) {
    nodes[0] = first.splitText(range.startOffset);   // in-range second half
  }
  nodes.forEach(function (tn) { _adjustNodeSize(tn, dir); });
  // Re-select the same text so the buttons can be clicked repeatedly.
  try {
    var nr = document.createRange();
    nr.setStart(nodes[0], 0);
    var ln = nodes[nodes.length - 1];
    nr.setEnd(ln, ln.length);
    sel.removeAllRanges(); sel.addRange(nr);
  } catch (e) {}
  saveSel(ctx);
  syncFontSizeUI(ctx);
  fireInput(ctx.edEl);
}
// Just set what the <select> DISPLAYS (px string, or '' for the "—" dash). Does not change
// the tracked active size.
function _setFontSizeDisplay(ctx, v) {
  var fs = ctx.tbEl.querySelector('[id$="-pt-fontsize"]');
  if (!fs) return;
  var s = v === '' ? '' : String(parseInt(v, 10));
  var has = s === '' || Array.prototype.some.call(fs.options, function (o) { return o.value === s; });
  fs.value = has ? s : '';
}
// Record the size the user is actively working in AND show it (item 3 "make it say the new one").
function setFontSizeUI(ctx, px) {
  var v = parseInt(px, 10);
  if (v) ctx._activeFontSize = v;
  _setFontSizeDisplay(ctx, v || '');
}
// Distinct font sizes (rounded px) across the current selection's text.
function _selectionFontSizes(ctx, range) {
  var sizes = {};
  var root = range.commonAncestorContainer;
  root = root.nodeType === 1 ? root : root.parentNode;
  if (!root) return [];
  var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: function (n) {
      if (!n.nodeValue.replace(/[​\s]/g, '')) return NodeFilter.FILTER_REJECT;
      return range.intersectsNode(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    }
  });
  var tn;
  while ((tn = w.nextNode())) { var el = tn.parentElement; if (el) sizes[Math.round(parseFloat(getComputedStyle(el).fontSize) || 0)] = 1; }
  return Object.keys(sizes);
}
// Sync the font-size <select> to the caret/selection whenever it moves:
//  • multi-size selection → "—" dash (item 8)
//  • empty editor (all text deleted) → keep showing the LAST active size (item 5)
//  • otherwise → the size at the caret
function syncFontSizeUI(ctx) {
  var sel = window.getSelection();
  if (!sel || !sel.rangeCount || !ctx.edEl.contains(sel.anchorNode)) return;
  if (!sel.isCollapsed) {
    var sizes = _selectionFontSizes(ctx, sel.getRangeAt(0));
    if (sizes.length > 1) { _setFontSizeDisplay(ctx, ''); return; }          // mixed → dash
    if (sizes.length === 1) { setFontSizeUI(ctx, sizes[0]); return; }
    return;
  }
  // Collapsed caret. If the editor has no real text left, hold the last active size.
  if (!ctx.edEl.textContent.replace(/[​\s]/g, '').length) { _setFontSizeDisplay(ctx, ctx._activeFontSize || ''); return; }
  var n = sel.anchorNode; n = n.nodeType === 1 ? n : n.parentNode;
  if (!n) return;
  setFontSizeUI(ctx, Math.round(parseFloat(getComputedStyle(n).fontSize) || 0));
}

var DOCX_ATOM_SEL = '.docx-math, .pg-img-wrap, a.tj-file-chip, a[download]';
// Insert zero-width text nodes between an atom and any adjacent atom siblings, so the caret
// CAN be placed between two touching math/image boxes (item 5 — "hit space to create space").
function _ensureCaretGap(node) {
  if (!node || !node.parentNode) return;
  function isAtom(n) { return n && n.nodeType === 1 && n.matches && n.matches(DOCX_ATOM_SEL); }
  if (isAtom(node.previousSibling)) node.parentNode.insertBefore(document.createTextNode('​'), node);
  if (isAtom(node.nextSibling)) node.parentNode.insertBefore(document.createTextNode('​'), node.nextSibling);
}
// Drop a node (image / file chip / math box) at the exact (x,y) caret position, so content
// wraps around it naturally (items 10, 12). Never drops INSIDE another atomic box — math/image
// boxes stay independent and are placed beside the target instead (item 7 "never merge").
function _docxDropAtPoint(ed, node, x, y) {
  var range = null;
  if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(x, y);
  else if (document.caretPositionFromPoint) { var cp = document.caretPositionFromPoint(x, y); if (cp) { range = document.createRange(); range.setStart(cp.offsetNode, cp.offset); range.collapse(true); } }
  // Detect a target atom under the drop point (so dropping directly ON a box lands beside it).
  var atom = null;
  if (range && ed.contains(range.startContainer)) {
    var host = range.startContainer; host = host.nodeType === 1 ? host : host.parentNode;
    atom = host && host.closest ? host.closest(DOCX_ATOM_SEL) : null;
  }
  if (!atom) { var elAt = document.elementFromPoint(x, y); if (elAt && elAt.closest) atom = elAt.closest(DOCX_ATOM_SEL); }
  if (node.parentNode) node.parentNode.removeChild(node);   // moving → detach from old spot (after resolving the drop point)
  if (atom && atom !== node && ed.contains(atom) && !node.contains(atom)) {
    var r = atom.getBoundingClientRect();
    // Above the target's vertical midpoint → before it; below → after it (item 5 drop above/below).
    var after = y > r.top + r.height / 2 || (Math.abs(y - (r.top + r.height / 2)) < 1 && x > r.left + r.width / 2);
    atom.parentNode.insertBefore(node, after ? atom.nextSibling : atom);   // beside, never inside
  } else if (range && ed.contains(range.startContainer) && !node.contains(range.startContainer)) {
    range.insertNode(node);
  } else {
    ed.appendChild(node);
  }
  _ensureCaretGap(node);
}

// Ensure every image wrapper stays interactive (resize/delete/copy) no matter how the DOM
// is rebuilt, plus float-wrap (double-click) + drag-to-place. Uses the app's own binder.
function wireImageDelegation(ctx) {
  var ed = ctx.edEl;
  var binder = ctx.app === 'tj' ? window._tjBindImg : window._bjBindImg;
  function setImgFloat(w, dir) {
    w.style.float = dir === 'none' ? '' : dir;
    w.style.margin = dir === 'left' ? '4px 16px 8px 0' : (dir === 'right' ? '4px 0 8px 16px' : '8px 0');
    w.style.display = dir === 'none' ? 'block' : 'inline-block';
  }
  ctx.setImgFloat = setImgFloat;
  function addExtras(w) {
    w._docxImgExtra = true;
    w.setAttribute('draggable', 'true');
    var img = w.querySelector('img');
    w.addEventListener('dragstart', function(e) {
      ctx._imgDrag = w;
      var src = img ? img.src : '';
      try {
        e.dataTransfer.effectAllowed = 'copyMove';
        if (src) {
          var mime = (src.match(/^data:([^;]+)/) || [])[1] || 'image/png';
          var name = 'image.' + ((mime.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png');
          // DownloadURL → drag the ACTUAL image file onto the desktop / a folder (Chrome/Edge)
          e.dataTransfer.setData('DownloadURL', mime + ':' + name + ':' + src);
          e.dataTransfer.setData('text/uri-list', src);
          e.dataTransfer.setData('text/html', '<img src="' + src + '">');
          e.dataTransfer.setData('text/plain', src);
        }
      } catch (x) {}
    });
    w.addEventListener('dblclick', function(e) {
      e.preventDefault();
      var f = (w.style.float || 'none');
      setImgFloat(w, f === 'none' || !f ? 'left' : (f === 'left' ? 'right' : 'none'));
      fireInput(ed);
    });
  }
  // Attached (non-image) file chips: drag within the doc AND out to the desktop / other apps.
  function addChipDrag(c) {
    c._docxDragExtra = true;
    c.setAttribute('draggable', 'true');
    c.classList.add('tj-file-chip');
    // Migrate old chips that used the flat 📎 emoji → clean SVG paperclip (item 6).
    if (window._docxPaperclipSVG && !c.querySelector('.docx-clip') && /📎/.test(c.innerHTML)) {
      c.innerHTML = c.innerHTML.replace(/📎\s*/, window._docxPaperclipSVG);
    }
    c.addEventListener('dragstart', function(e) {
      ctx._imgDrag = c;
      var href = c.getAttribute('href') || '';
      var name = c.getAttribute('download') || 'file';
      try {
        e.dataTransfer.effectAllowed = 'copyMove';
        if (href) {
          var mime = (href.match(/^data:([^;]+)/) || [])[1] || 'application/octet-stream';
          e.dataTransfer.setData('DownloadURL', mime + ':' + name + ':' + href);
          e.dataTransfer.setData('text/uri-list', href);
          e.dataTransfer.setData('text/plain', href);
        }
      } catch (x) {}
    });
    // Resize handle → scale the chip like an image (drag the corner to grow/shrink).
    // Remove any stale handle from saved HTML first (it has no listeners) to avoid duplicates.
    var oldH = c.querySelector(':scope > .docx-file-resize'); if (oldH) oldH.remove();
    var h = document.createElement('span');
    h.className = 'docx-file-resize';
    h.setAttribute('contenteditable', 'false');
    c.appendChild(h);
    h.addEventListener('pointerdown', function(e) {
      e.preventDefault(); e.stopPropagation();
      c.setAttribute('draggable', 'false');   // stop the chip's native drag from hijacking the resize
      try { h.setPointerCapture(e.pointerId); } catch (x) {}
      var startX = e.clientX, startFs = parseFloat(getComputedStyle(c).fontSize) || 14;
      c.style.display = 'inline-flex';
      function mv(ev) {
        var fs = Math.max(10, Math.min(48, startFs + (ev.clientX - startX) * 0.14));
        c.style.fontSize = fs + 'px';
      }
      function up() { document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up); c.setAttribute('draggable', 'true'); c._justResized = Date.now(); fireInput(ed); }
      document.addEventListener('pointermove', mv);
      document.addEventListener('pointerup', up);
    });
    // Swallow the click the browser fires after releasing the handle — otherwise it reaches
    // the <a download> and prompts a download (item 1).
    h.addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); });
    h.addEventListener('dragstart', function(e) { e.preventDefault(); e.stopPropagation(); });
  }
  // Attach the resize handle (item 7). Separated because katex.render() replaces the math
  // element's innerHTML and wipes the handle — so rebindAll re-ensures it after every render.
  function addMathResizeHandle(m) {
    var rh = document.createElement('span');
    rh.className = 'docx-math-resize'; rh.setAttribute('contenteditable', 'false');
    rh._docxBound = true;   // marks a handle that actually has listeners (survives nothing → detects stale reloaded handles)
    m.appendChild(rh);
    rh.addEventListener('pointerdown', function(e) {
      e.preventDefault(); e.stopPropagation();
      m.setAttribute('draggable', 'false');   // stop the parent's native drag from hijacking the resize (item 3)
      try { rh.setPointerCapture(e.pointerId); } catch (x) {}
      var startX = e.clientX, startFs = parseFloat(m.style.fontSize) || parseFloat(getComputedStyle(m).fontSize) || 18;
      function mv(ev) { m.style.fontSize = Math.max(10, Math.min(72, startFs + (ev.clientX - startX) * 0.16)) + 'px'; }
      function up() { document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up); m.setAttribute('draggable', 'true'); m._justResized = Date.now(); fireInput(ed); }
      document.addEventListener('pointermove', mv);
      document.addEventListener('pointerup', up);
    });
    rh.addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); });
    rh.addEventListener('dragstart', function(e) { e.preventDefault(); e.stopPropagation(); });
  }
  // Rendered math: independent draggable + resizable boxes (item 7). Double-click floats so text wraps.
  function ensureMathBox(m) {
    if (!m._docxMathDrag) {
      m._docxMathDrag = true;
      m.setAttribute('draggable', 'true');
      m.setAttribute('contenteditable', 'false');
      m.addEventListener('dragstart', function(e) {
        if (ed.getAttribute('contenteditable') !== 'true') { e.preventDefault(); return; }
        ctx._imgDrag = m;
        try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', ''); } catch (x) {}
      });
      m.addEventListener('dblclick', function(e) {
        e.preventDefault();
        var f = m.style.float || 'none';
        m.style.float = f === 'none' ? 'left' : (f === 'left' ? 'right' : '');
        m.style.margin = m.style.float ? (m.style.float === 'left' ? '4px 16px 6px 0' : '4px 0 6px 16px') : '';
        fireInput(ed);
      });
    }
    // (Re)attach the resize handle if a render wiped it OR if it's a STALE handle that came back
    // from saved HTML on document reload (persisted markup has no event listeners → can't drag).
    var rh = m.querySelector(':scope > .docx-math-resize');
    if (!rh || !rh._docxBound) { if (rh) rh.remove(); addMathResizeHandle(m); }
  }
  function rebindAll() {
    ed.querySelectorAll('.pg-img-wrap').forEach(function(w) {
      if (!w._pgBound && typeof binder === 'function') binder(w);
      if (!w._docxImgExtra) addExtras(w);
    });
    ed.querySelectorAll('a.tj-file-chip, a[download]').forEach(function(c) {
      if (!c._docxDragExtra) addChipDrag(c);
    });
    ed.querySelectorAll('.docx-math').forEach(function(m) { ensureMathBox(m); });
    // Guarantee a caret-accessible gap between any two touching atoms (math/image/chip) so you
    // can click/arrow between two adjacent math boxes and type a space (item 4).
    ed.querySelectorAll(DOCX_ATOM_SEL).forEach(function(a) { _ensureCaretGap(a); });
  }
  ed.addEventListener('dragover', function(e) { if (ctx._imgDrag) e.preventDefault(); });
  ed.addEventListener('drop', function(e) {
    if (!ctx._imgDrag) return;
    e.preventDefault();
    var w = ctx._imgDrag; ctx._imgDrag = null;
    _docxDropAtPoint(ed, w, e.clientX, e.clientY);
    fireInput(ed);
  });
  new MutationObserver(rebindAll).observe(ed, { childList: true, subtree: true });
  rebindAll();
}

/* ═══════════ Keyboard shortcuts + checklist toggling + undo history per editor ═══════════ */
function wireEditor(ctx) {
  var ed = ctx.edEl;
  ctx.history = makeHistory(ctx);
  ctx.history.seed();
  ctx.history.start();
  ed.addEventListener('keydown', function(e) {
    var mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey) {
      var k = e.key.toLowerCase();
      if (!e.shiftKey && k === 's') { e.preventDefault(); fireInput(ed); return; }
      if (!e.shiftKey && k === 'p') { e.preventDefault(); var eb = $(APPS[ctx.app].exportBtn); if (eb) eb.click(); return; }
      if (!e.shiftKey && k === 'f') { e.preventDefault(); frOpen(ctx, false); return; }
      if (!e.shiftKey && k === 'h') { e.preventDefault(); frOpen(ctx, true); return; }
      if (!e.shiftKey && k === 'z') { e.preventDefault(); ctx.history.undo(); return; }
      if (k === 'y' || (e.shiftKey && k === 'z')) { e.preventDefault(); ctx.history.redo(); return; }
      if (e.key === ']') { e.preventDefault(); saveSel(ctx); indentBlocks(ctx, 1); return; }
      if (e.key === '[') { e.preventDefault(); saveSel(ctx); indentBlocks(ctx, -1); return; }
    }
    // Tab inserts spaces (never indents/outdents — that's Ctrl+] / Ctrl+[ only). Shift+Tab does nothing.
    if (e.key === 'Tab') {
      e.preventDefault();
      if (!e.shiftKey) { document.execCommand('insertHTML', false, '&nbsp;&nbsp;&nbsp;&nbsp;'); fireInput(ed); }
      return;
    }
    // File chips are only removable via the Delete button — never by Backspace/Delete keys.
    if (e.key === 'Backspace' || e.key === 'Delete') {
      var s = window.getSelection();
      if (s && s.isCollapsed && s.rangeCount && _docxAdjacentChip(s.getRangeAt(0), e.key === 'Backspace' ? 'back' : 'fwd')) { e.preventDefault(); return; }
    }
    // (Blockquote Enter-escape is handled in each app's own page-editor keydown handler,
    //  which runs first and calls preventDefault — handling it here too would double-insert.)
  });
  // Is the caret sitting immediately before (fwd) / after (back) a file chip?
  function _docxAdjacentChip(range, dir) {
    function isChip(n) { return n && n.nodeType === 1 && n.matches && n.matches('a.tj-file-chip, a[download]'); }
    var node = range.startContainer, off = range.startOffset, sib;
    if (dir === 'back') {
      if (node.nodeType === 3) { if (off > 0) return null; sib = node.previousSibling; }
      else { sib = node.childNodes[off - 1]; }
    } else {
      if (node.nodeType === 3) { if (off < node.textContent.length) return null; sib = node.nextSibling; }
      else { sib = node.childNodes[off]; }
    }
    while (sib && sib.nodeType === 3 && !sib.textContent) sib = (dir === 'back' ? sib.previousSibling : sib.nextSibling);
    return isChip(sib) ? sib : null;
  }
  // (History is captured by the MutationObserver in makeHistory — no 'input' hook needed.)
  // Checklist toggling + opening links (Ctrl/Cmd+click, or plain click when not editing)
  ed.addEventListener('click', function(e) {
    var t = e.target;
    if (t && t.classList && t.classList.contains('docx-cl-box')) {
      if (t.checked) t.setAttribute('checked', '');
      else t.removeAttribute('checked');
      var li = t.closest('li');
      if (li) li.classList.toggle('done', t.checked);
      fireInput(ed);
      return;
    }
    // Math element → Copy Raw / Copy Formatted bubble
    var m = t && t.closest ? t.closest('.docx-math') : null;
    if (m && ed.contains(m)) {
      e.preventDefault();
      mathCopyPop(m);
      return;
    }
    // Open links in the browser — VIEW mode only (in edit mode a click just places the caret).
    // File chips are NOT links: they must show the View/Download menu (handled by wireFileMenu),
    // never navigate/open-blank — so skip them here (item 1).
    var a = t && t.closest ? t.closest('a[href]') : null;
    if (a && (a.hasAttribute('download') || a.classList.contains('tj-file-chip'))) return;
    if (a && ed.contains(a) && ed.contentEditable !== 'true') {
      e.preventDefault();
      window.open(a.href, '_blank', 'noopener');
    }
  });
  // Delegated image handling so images stay resizable/deletable/copyable no matter how the DOM moves
  wireImageDelegation(ctx);
  // ── Copy / cut as Markdown ──
  // The rendered document is a view of Markdown, so that is what the clipboard's
  // plain-text flavour should carry; text/html keeps the rich markup for targets
  // that want it (Word, Docs, another editor here).
  function copyAsMarkdown(e, isCut) {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return;
    if (!ed.contains(sel.anchorNode) || !ed.contains(sel.focusNode)) return;
    var range = sel.getRangeAt(0);
    var holder = document.createElement('div');
    holder.appendChild(range.cloneContents());
    var md;
    try { md = _docxHtmlToMd(holder); } catch (err) { return; }   // fall back to the default copy
    if (!md) return;
    var cd = e.clipboardData || window.clipboardData;
    if (!cd) return;
    e.preventDefault();
    try {
      cd.setData('text/plain', md);
      cd.setData('text/html', holder.innerHTML);
    } catch (err) { return; }
    if (isCut) {
      range.deleteContents();
      fireInput(ed);
    }
  }
  ed.addEventListener('copy', function(e) { copyAsMarkdown(e, false); });
  ed.addEventListener('cut', function(e) { copyAsMarkdown(e, true); });

  // Keep selection bookmarked for toolbar/menu actions; reseed history on entry switch
  ed.addEventListener('keyup', function() { saveSel(ctx); syncFontSizeUI(ctx); });
  ed.addEventListener('mouseup', function() { saveSel(ctx); syncFontSizeUI(ctx); });
  // _aiSettling: an AI run restores contentEditable (refocusing the editor) while
  // its own undo snapshots are still being committed — reseeding here would wipe them.
  ed.addEventListener('focus', function() { saveSel(ctx); if (!ctx._aiSettling) ctx.history.syncBase(); });
}

/* ═══════════ View mode toggle in the main toolbar ═══════════ */


/* ═══════════ Init ═══════════ */
var ALLCTX = [];
// ── Highlight palette: clamp fully on-screen no matter the screen size (item 7) ──
function wireHighlightClamp(ctx) {
  var palette = ctx.tbEl.querySelector('.pt-hl-palette');
  var trigger = ctx.tbEl.querySelector('[id$="-pt-hl-trigger"]');
  if (!palette || !trigger) return;
  function clamp() {
    if (!palette.classList.contains('open')) return;
    palette.style.position = 'fixed';
    palette.style.top = ''; palette.style.left = ''; palette.style.right = '';
    var tr = trigger.getBoundingClientRect();
    var pw = palette.offsetWidth || 130, ph = palette.offsetHeight || 40;
    var left = Math.max(8, Math.min(tr.right - pw, window.innerWidth - pw - 8));   // right-align, keep on-screen
    var top = tr.bottom + 4;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, tr.top - ph - 4);      // flip above if no room below
    palette.style.left = left + 'px';
    palette.style.top = top + 'px';
  }
  new MutationObserver(function (muts) { muts.forEach(function (m) { if (m.attributeName === 'class') clamp(); }); }).observe(palette, { attributes: true });
  window.addEventListener('resize', clamp);
  window.addEventListener('scroll', clamp, true);
}
// ── Subtle auto-hiding scrollbar on the page (fades out when idle) ──
function addFadingScrollbar(ctx) {
  var wrap = ctx.wrapEl;
  if (getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';
  var bar = document.createElement('div');
  bar.className = 'docx-scrollbar';
  wrap.appendChild(bar);
  var hideT = null, dragging = false, raf = null;
  function geom() {
    var sh = wrap.scrollHeight, ch = wrap.clientHeight;
    if (sh <= ch + 4) { bar.style.display = 'none'; return null; }
    bar.style.display = '';
    var thumbH = Math.max(36, ch * ch / sh);
    var maxTop = ch - thumbH;
    var top = (sh - ch) ? (wrap.scrollTop / (sh - ch)) * maxTop : 0;
    return { thumbH: thumbH, top: top, sh: sh, ch: ch, maxTop: maxTop };
  }
  function place() { var g = geom(); if (!g) return; bar.style.height = g.thumbH + 'px'; bar.style.top = (wrap.scrollTop + g.top) + 'px'; }
  function flash() { place(); bar.classList.add('on'); if (!dragging) { clearTimeout(hideT); hideT = setTimeout(function () { bar.classList.remove('on'); }, 1100); } }
  // Persist scroll position per open doc (item 12).
  var saveT = null;
  function saveScroll() { if (!ctx._docId) return; clearTimeout(saveT); saveT = setTimeout(function () { try { localStorage.setItem('docx_scroll_' + ctx.app + '_' + ctx._docId, String(wrap.scrollTop)); } catch (e) {} }, 350); }
  // Show ONLY on scroll or drag (rAF-throttled → no jitter); typing never flashes it.
  wrap.addEventListener('scroll', function () { saveScroll(); if (raf) return; raf = requestAnimationFrame(function () { raf = null; flash(); }); }, { passive: true });
  window.addEventListener('resize', place);
  try { new MutationObserver(function () { if (bar.classList.contains('on') || dragging) place(); }).observe(ctx.edEl, { childList: true, subtree: true, characterData: true }); } catch (e) {}
  // Grab-and-drag the bar to scroll.
  bar.addEventListener('pointerdown', function (e) {
    var g = geom(); if (!g) return;
    e.preventDefault(); dragging = true; bar.classList.add('on');
    try { bar.setPointerCapture(e.pointerId); } catch (x) {}
    var startY = e.clientY, startScroll = wrap.scrollTop;
    function onMove(ev) { var g2 = geom(); if (!g2 || !g2.maxTop) return; wrap.scrollTop = startScroll + (ev.clientY - startY) * ((g2.sh - g2.ch) / g2.maxTop); place(); }
    function onUp() { dragging = false; document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', onUp); clearTimeout(hideT); hideT = setTimeout(function () { bar.classList.remove('on'); }, 1100); }
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });
  place();
}

// ── Text-color shortcuts: replace the bare color <input> with a swatch popup ──
var DOCX_COLORS = [
  ['#FFFFFF', 'White'], ['#D9D9DE', 'Light gray'], ['#9A9AA5', 'Gray'], ['#5C5C66', 'Dark gray'], ['#000000', 'Black'],
  ['#e0b874', 'Pink'], ['#d68a7c', 'Red'], ['#e0b57c', 'Orange'], ['#E5C84A', 'Yellow'],
  ['#5DAF6D', 'Green'], ['#22D3EE', 'Cyan'], ['#6DA8F5', 'Blue'], ['#A78BDA', 'Purple']
];
function wireColorShortcuts(ctx) {
  // Any editor's colour input, not just the Page one (the Journal editor's is
  // tj-je-color-pick); the lookup is already scoped to this context's toolbar.
  var input = ctx.tbEl.querySelector('[id$="-color-pick"]');
  if (!input) return;
  var btn = document.createElement('button');
  btn.className = 'pt-btn docx-color-btn';
  btn.title = 'Text color';
  btn.innerHTML = '<span class="docx-color-dot" style="background:#EDEEF0"></span><span style="font-size:9px;opacity:.7;margin-left:2px;">▾</span>';
  input.parentNode.insertBefore(btn, input);
  // keep the native input in the DOM (its position anchors the OS picker) but invisible
  input.style.cssText = 'position:absolute;width:22px;height:10px;opacity:0;border:none;padding:0;margin:0;pointer-events:none;';
  var dot = btn.querySelector('.docx-color-dot');
  // Apply a colour to the current selection (swatch clicks + collapsed-caret typing colour).
  function applyColor(c) {
    restoreSel(ctx);
    document.execCommand('styleWithCSS', false, true);
    document.execCommand('foreColor', false, c);
    document.execCommand('styleWithCSS', false, false);
    dot.style.background = c;
    saveSel(ctx);
    fireInput(ctx.edEl);
  }
  // For the OS picker we wrap the selection in a marker span ONCE, then recolour that same
  // span on every 'input' — giving true real-time updates as the cursor moves in the picker
  // (no execCommand/refocus juggling while the modal dialog is open).
  function beginLive() {
    restoreSel(ctx);
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed || !ctx.edEl.contains(sel.anchorNode)) { ctx._liveSpan = null; return; }
    var range = sel.getRangeAt(0);
    var span = document.createElement('span'); span.className = 'docx-livecolor';
    try { range.surroundContents(span); } catch (e) { try { span.appendChild(range.extractContents()); range.insertNode(span); } catch (x) { ctx._liveSpan = null; return; } }
    ctx._liveSpan = span;
  }
  function endLive() {
    var span = ctx._liveSpan; ctx._liveSpan = null;
    if (span) { span.classList.remove('docx-livecolor'); fireInput(ctx.edEl); }
  }
  btn.addEventListener('mousedown', function (e) { e.preventDefault(); saveSel(ctx); });
  btn.addEventListener('click', function () {
    showPop(btn, function (pop) {
      pop.classList.add('docx-colorpop');
      var grid = document.createElement('div'); grid.className = 'docx-color-grid';
      DOCX_COLORS.forEach(function (c) {
        var s = document.createElement('button'); s.className = 'docx-color-sw'; s.title = c[1];
        s.style.background = c[0]; if (c[0] === '#FFFFFF') s.style.border = '1px solid #888';
        s.addEventListener('click', function () { closePop(); applyColor(c[0]); });
        grid.appendChild(s);
      });
      pop.appendChild(grid);
      var custom = document.createElement('button'); custom.className = 'docx-mi'; custom.textContent = 'Custom colour…';
      custom.addEventListener('click', function () {
        closePop();
        beginLive();   // wrap the selection so live 'input' recolours it in real time
        // move the hidden input under the swatch button so the OS picker opens there (not top-left)
        var r = btn.getBoundingClientRect();
        input.style.pointerEvents = 'auto';
        input.style.left = (r.left + window.scrollX) + 'px';
        input.style.top = (r.bottom + window.scrollY) + 'px';
        input.value = '#ffffff';
        input.click();   // keep it inside the click gesture so the OS picker actually opens
        input.style.pointerEvents = 'none';
      });
      pop.appendChild(custom);
    });
  });
  // live drag: recolour the marker span directly; final commit resolves it
  input.addEventListener('input', function () { dot.style.background = this.value; if (ctx._liveSpan) ctx._liveSpan.style.color = this.value; else applyColor(this.value); });
  input.addEventListener('change', function () { if (ctx._liveSpan) { ctx._liveSpan.style.color = this.value; endLive(); } else applyColor(this.value); dot.style.background = this.value; });
}

// Clean, modern paperclip icon (SVG) for file chips — replaces the flat 📎 emoji (item 6).
window._docxPaperclipSVG = '<svg class="docx-clip" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';
// Open any file reliably (large data: URLs fail with window.open → use a Blob URL).
function docxViewFile(href) {
  try {
    if (/^data:/.test(href)) {
      fetch(href).then(function (r) { return r.blob(); }).then(function (blob) {
        var url = URL.createObjectURL(blob);
        window.open(url, '_blank', 'noopener');
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
      }).catch(function () { window.open(href, '_blank', 'noopener'); });
    } else { window.open(href, '_blank', 'noopener'); }
  } catch (e) {}
}
// ── Click an attached file chip → View / Download (+ Delete only in edit mode) menu ──
function wireFileMenu(ctx) {
  ctx.edEl.addEventListener('click', function (e) {
    if (e.target.classList && e.target.classList.contains('docx-file-resize')) { e.preventDefault(); return; } // resize handle, not a download
    var chip = e.target.closest ? e.target.closest('a.tj-file-chip, a[download]') : null;
    if (!chip || !ctx.edEl.contains(chip)) return;
    e.preventDefault(); e.stopPropagation();
    if (chip._justResized && Date.now() - chip._justResized < 400) return;   // ignore the click right after a resize drag
    var href = chip.getAttribute('href') || '';
    var name = chip.getAttribute('download') || 'file';
    var editMode = ctx.edEl.getAttribute('contenteditable') === 'true';
    showPop(chip, function (pop) {
      pop.appendChild(mi('View', function () { docxViewFile(href); }));
      pop.appendChild(mi('Download', function () {
        var a = document.createElement('a'); a.href = href; a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
      }));
      if (editMode) {   // Delete only while editing — never in View mode (item 13)
        pop.appendChild(msep());
        pop.appendChild(mi('Delete', function () { chip.remove(); fireInput(ctx.edEl); }));
      }
    });
  });
}

function initApp(app) {
  var cfg = APPS[app];
  if (!$(cfg.root)) return;
  cfg.ctxs.forEach(function(c) {
    var edEl = $(c.ed), tbEl = $(c.tb), wrapEl = $(c.wrap);
    if (!edEl || !tbEl || !wrapEl) return;
    var ctx = {
      app: app, edEl: edEl, tbEl: tbEl, wrapEl: wrapEl, area: c.area,
      imgEl: c.img ? $(c.img) : null, mdEl: c.md ? $(c.md) : null
    };
    c._ctx = ctx;
    ALLCTX.push(ctx);
    wrapEl.classList.add('docx-wrap');
    edEl.classList.add('docx-sheet');
    var areaEl = $(c.area);
    if (areaEl) areaEl.classList.add('docx-find-host');
    buildMenubar(ctx);
    injectRibbonExtras(ctx);
    rebindPageButtons(ctx);
    groupRibbon(ctx);
    buildRuler(ctx);
    buildVRuler(ctx);
    wireEditor(ctx);
    addFadingScrollbar(ctx);
    wireColorShortcuts(ctx);
    wireFileMenu(ctx);
    wireHighlightClamp(ctx);
    if (wcPinned(app)) mountWcPin(ctx);
    // Re-fit zoom when the wrap resizes (sidebar toggles, orientation change)
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(function() {
        if (zGet(app) === 'fit') applyZoom(app);
        else updateRulers(app);
      });
      ro.observe(wrapEl);
    }
  });
  applyPageSetup(app);
  applyViewMode(app);
  applyReflow(app);
}
// OurJournal: apply someone else's edit to a page editor without it becoming
// an undo step of ours. `run` patches the DOM; the history re-bases around it.
window._docxRemoteApply = function(edId, before, after, run) {
  var ctx = ALLCTX.find(function(c) { return c.edEl.id === edId; });
  if (!ctx || !ctx.history) { run(); return; }
  ctx._histSuppress = true;
  try { run(); }
  finally {
    try { ctx.history.remotePatch(before, after); } catch (e) { try { ctx.history.seed(); } catch (x) {} }
    setTimeout(function() { ctx._histSuppress = false; }, 0);
  }
};
// Re-apply a page's margins after they changed underneath it (OurJournal).
window._docxApplyPageSetup = function(app) {
  try { applyPageSetup(app); } catch (e) {}
  try { updateRulers(app); } catch (e) {}
};
// Called by the apps' loadActiveEntry after they set the page editor's innerHTML,
// so undo/redo history resets to the freshly-loaded entry (no cross-entry undo).
window._docxOnLoad = function(edId, docId) {
  var ctx = ALLCTX.find(function(c) { return c.edEl.id === edId; });
  if (ctx) {
    ctx._docId = docId || edId;
    if (ctx.history) {
      ctx._histSuppress = false;
      ctx.history.seed();
      ctx.history.loadPersisted(ctx._docId);   // restore last undo/redo states from a previous session
    }
    try { applyPageSetup(ctx.app); } catch (e) {}   // apply THIS page's own saved margins
    _docxRestoreScroll(ctx);                    // reopen at the last scroll position
  }
  // Re-render any saved math (and ensure the KaTeX stylesheet is loaded).
  if (window._docxRenderMath) { var el = $(edId); if (el && el.querySelector('.docx-math')) window._docxRenderMath(el); }
};
// Restore the saved scroll position for the doc now loaded into ctx (item 12).
// A brand-new page (or one that was never scrolled) has no saved value → open at
// the TOP, not wherever the previously-viewed page happened to be scrolled to.
function _docxRestoreScroll(ctx) {
  if (!ctx._docId) return;
  var key = 'docx_scroll_' + ctx.app + '_' + ctx._docId;
  var v = parseInt(localStorage.getItem(key) || '', 10);
  if (isNaN(v)) v = 0;
  var set = function() { if (ctx.wrapEl) ctx.wrapEl.scrollTop = v; };
  set();
  requestAnimationFrame(function() { requestAnimationFrame(set); });
  setTimeout(set, 250);   // again after async image rehydration reflows the page
}
/* Re-attach image handlers after anything replaces the editor's innerHTML.
 *
 * Setting innerHTML destroys every .pg-img-wrap and builds fresh ones from the
 * markup. The handlers are not in the markup — they are listeners bound in JS,
 * plus a _pgBound expando that does not survive serialisation — so the new
 * wrappers come back inert: no resize grip, no delete, and no right-click
 * "Copy Image". That is the whole of the "images stop being resizable or
 * copyable" report, and it only ever showed up AFTER an undo, which is why it
 * felt random.
 *
 * Each journal binds through its own closure, named by its config's bindImg. Binding is
 * idempotent (_pgBound), making this safe to call on any path that might have
 * replaced content, whether or not it actually did. */
window._docxRebindImages = function (edEl, app) {
  if (!edEl) return;
  var bind = APPS[app] && window[APPS[app].bindImg];
  if (typeof bind !== 'function') return;
  edEl.querySelectorAll('.pg-img-wrap').forEach(function (w) { try { bind(w); } catch (e) {} });
};

// Snap a page editor's scroll container back to the top (used after "clear all content").
window._docxScrollToTop = function(edId) {
  var ctx = ALLCTX.find(function(c) { return c.edEl.id === edId; });
  if (ctx && ctx.wrapEl) ctx.wrapEl.scrollTop = 0;
};
function initAll() {
  Object.keys(APPS).forEach(function(app) {
    try { initApp(app); } catch (e) { console.warn('docx init failed for', app, e); }
  });
  // An app registered after this point (a host that mounts late) initialises on arrival.
  window.Notebook._docxInitApp = function(app) {
    try { initApp(app); } catch (e) { console.warn('docx init failed for', app, e); }
  };
  window.addEventListener('resize', function() {
    Object.keys(APPS).forEach(function(app) {
      // Rotating a tablet can cross the reflow breakpoint, so re-evaluate first.
      applyReflow(app);
      if (zGet(app) === 'fit') applyZoom(app);
      else updateRulers(app);
    });
  });
  // Flush undo/redo history to localStorage on leave so it survives close+reopen (item 13).
  window.addEventListener('beforeunload', function() {
    ALLCTX.forEach(function(c) { if (c.history && c.history.persist) c.history.persist(); });
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initAll);
else initAll();
})();
