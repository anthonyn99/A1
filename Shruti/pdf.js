// Lessons as a PDF (Tony, 2026-10-20: "whatever lessons we generate, allow us
// to export them as pdf"). The readers' notes and any AI-made set both go
// through here. jsPDF loads only when someone presses Save as PDF.

import * as C from './core.js';

export const JSPDF_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
let loading = null;
function loadJsPDF() {
  if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
  if (!loading) loading = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = JSPDF_URL; s.async = true;
    s.onload = () => (window.jspdf && window.jspdf.jsPDF ? res(window.jspdf.jsPDF) : rej(new Error('The PDF maker did not load.')));
    s.onerror = () => { loading = null; rej(new Error('The PDF maker could not be loaded. Check the connection and try again.')); };
    document.head.appendChild(s);
  });
  return loading;
}

/** The built-in PDF fonts speak Windows-1252: diacritics (ā, ṣ) lose their
 *  marks, anything else outside it becomes a plain stand-in. */
const CP1252_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
export function pdfText(t) {
  return String(t == null ? '' : t).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\n\x20-\x7e\xa0-\xff]/g, (c) => (CP1252_EXTRA.includes(c) ? c : c === '‑' || c === '‐' ? '-' : c === ' ' || c === ' ' ? ' ' : ''))
    .replace(/[ \t]+/g, ' ').trim();
}

/** The file name a set is saved under. */
export function fileName(o) {
  const who = o.L && o.L.by ? ' (' + o.byName + ')' : '';
  return pdfText((o.bookShort || 'Shruti') + ' - ' + (o.n === 0 ? 'Introduction' : 'Chapter ' + o.n) + ' lessons' + who).replace(/[\\/:*?"<>|]+/g, '') + '.pdf';
}

/** Build the PDF. o: {bookTitle, bookShort, n, title, L:{lessons, summary, by}, byName}.
 *  Resolves the jsPDF document (saved unless o.save === false). */
export async function lessonsPDF(o) {
  const JsPDF = await loadJsPDF();
  const doc = new JsPDF({ unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
  const M = 56, TW = W - 2 * M, veda = C.P === 'veda';
  const AC = veda ? [122, 95, 134] : [104, 82, 176], TX = [28, 28, 32], MU = [96, 96, 104], LN = [222, 220, 228], BODY = [62, 62, 70];
  let y = M;
  const room = (h) => { if (y + h > H - M) { doc.addPage(); y = M; } };
  const lines = (text, size, style, width) => { doc.setFont('helvetica', style); doc.setFontSize(size); return doc.splitTextToSize(pdfText(text), width); };
  const put = (ls, size, style, color, x, lead) => {
    doc.setFont('helvetica', style); doc.setFontSize(size); doc.setTextColor(...color);
    ls.forEach((l) => { room(lead); doc.text(l, x, y + size); y += lead; });
  };

  const L = o.L || {}, items = L.lessons || [];
  put(lines((o.bookTitle || '') + ' · ' + (o.n === 0 ? 'Introduction' : 'Chapter ' + o.n), 9.5, 'bold', TW).map((s) => s.toUpperCase()), 9.5, 'bold', AC, M, 14);
  y += 4;
  put(lines(o.title || '', 22, 'bold', TW), 22, 'bold', TX, M, 27);
  y += 2;
  put(lines(items.length + (L.by ? ' lessons drawn by ' + (o.byName || 'AI') + ' (Make with AI)' : ' lessons from Tony and Veda’s notes'), 10.5, 'normal', TW), 10.5, 'normal', MU, M, 15);
  y += 14;
  doc.setDrawColor(...LN); doc.setLineWidth(0.8); doc.line(M, y, W - M, y); y += 18;

  const IDW = 30;
  for (const l of items) {
    const tl = lines(l.title || '', 12.5, 'bold', TW - IDW), bl = l.body ? lines(l.body, 11, 'normal', TW - IDW) : [];
    room(tl.length * 16 + Math.min(bl.length, 2) * 15 + 6);   // keep a title with its first lines
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(...AC); doc.text(pdfText(l.id || ''), M, y + 12);
    put(tl, 12.5, 'bold', TX, M + IDW, 16);
    if (bl.length) { y += 3; put(bl, 11, 'normal', BODY, M + IDW, 15.5); }
    y += 16;
  }
  if (L.summary) {
    const sl = lines(L.summary, 11, 'normal', TW - 28), h = 22 + sl.length * 15.5 + 18;
    room(Math.min(h, H - 2 * M));
    const top = y;
    doc.setFillColor(...(veda ? [244, 239, 246] : [241, 238, 251])); doc.roundedRect(M, top, TW, h, 8, 8, 'F');
    y += 14;
    put(['CHAPTER SUMMARY'], 9, 'bold', AC, M + 14, 16);
    put(sl, 11, 'normal', TX, M + 14, 15.5);
    y = top + h + 10;
  }
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i); doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...MU);
    doc.text('Shruti', M, H - 30);
    doc.text(i + ' / ' + pages, W - M, H - 30, { align: 'right' });
  }
  if (o.save !== false) doc.save(fileName(o));
  return doc;
}
