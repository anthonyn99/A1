// Writes books/<book>/study.json from books/<book>/study/chNN.json: the
// Study badge and the Study tab read it to know which chapters ship a set.
//   node Shruti/tools/study-index.js [book]      (default: gita)
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const book = process.argv[2] || 'gita';
  const dir = path.join(__dirname, '..', 'books', book);
  global.window = {};
  const P = await import(pathToFileURL(path.join(__dirname, '..', 'study', 'parse.js')).href);
  const out = {};
  for (const f of fs.readdirSync(path.join(dir, 'study')).filter((x) => /^ch\d\d\.json$/.test(x)).sort()) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'study', f), 'utf8'));
    const it = Object.fromEntries(P.KINDS.map((k) => [k, P.items(k, raw[k])]));
    out[String(Number(f.slice(2, 4)))] = { flashcards: it.flashcards.length, quiz: it.quiz.length, mindmap: it.mindmap ? it.mindmap.branches.length : 0, slides: it.slides.length };
  }
  fs.writeFileSync(path.join(dir, 'study.json'), JSON.stringify(out, null, 1) + '\n');
  console.log('study.json: ' + Object.keys(out).length + ' chapters');
})();
