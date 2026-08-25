// Undo-history delta encoding (index.html, docx_hist_*).
//
// The persisted undo window used to store five FULL copies of the document —
// one real journal entry measured 759KB, and six such keys filled the origin's
// whole ~5MB localStorage budget, which is what made Vault's Save button die
// with a QuotaExceededError naming a key it wasn't responsible for.
//
// v2 stores the first state whole and the rest as prefix/suffix deltas. That is
// only safe if reconstruction is EXACT, so this test hammers the round-trip.

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// Pull the three functions out of the page and evaluate them in isolation.
function grab(name, startMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) throw new Error('could not find ' + name + ' in index.html');
  // walk braces from the first { after the marker
  let j = src.indexOf('{', i), depth = 0, k = j;
  for (; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (!depth) break; }
  }
  return src.slice(i, k + 1);
}

const code = [
  grab('_histCommon', 'function _histCommon('),
  grab('encodeHist', 'function encodeHist('),
  grab('decodeHist', 'function decodeHist('),
  'module.exports = { _histCommon, encodeHist, decodeHist };'
].join('\n');

const mod = { exports: {} };
new Function('module', code)(mod);
const { encodeHist, decodeHist } = mod.exports;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra).slice(0, 200) : '')); }
};
const mk = (htmls) => htmls.map((h, i) => ({ html: h, caret: i * 3 }));
const roundTrip = (htmls, idx = 0) => decodeHist(JSON.parse(JSON.stringify(encodeHist(mk(htmls), idx))));
const same = (htmls) => {
  const out = roundTrip(htmls);
  if (!out || out.length !== htmls.length) return false;
  return htmls.every((h, i) => out[i].html === h);
};

console.log('\n-- exact reconstruction --');
ok('single state', same(['<p>hello</p>']));
ok('typing at the end', same(['<p>a</p>', '<p>ab</p>', '<p>abc</p>', '<p>abcd</p>', '<p>abcde</p>']));
ok('typing at the start', same(['<p>e</p>', '<p>de</p>', '<p>cde</p>', '<p>bcde</p>']));
ok('editing the middle', same(['<p>aaaXbbb</p>', '<p>aaaYbbb</p>', '<p>aaaZZbbb</p>']));
ok('deletion', same(['<p>abcdefgh</p>', '<p>abcgh</p>', '<p>ah</p>']));
ok('total replacement', same(['<p>completely one</p>', '<h1>utterly different</h1>']));
ok('empty then content', same(['', '<p>x</p>', '<p>xy</p>']));
ok('content then empty', same(['<p>xy</p>', '']));
ok('identical consecutive states', same(['<p>same</p>', '<p>same</p>', '<p>same</p>']));

console.log('\n-- unicode / surrogate safety --');
ok('emoji appended', same(['<p>hi</p>', '<p>hi🎉</p>', '<p>hi🎉🎉</p>']));
ok('emoji removed from middle', same(['<p>a🎉b🎉c</p>', '<p>a🎉bc</p>', '<p>abc</p>']));
ok('emoji swapped (same length)', same(['<p>🎉</p>', '<p>🚀</p>']));
ok('accents and CJK', same(['<p>café 日本</p>', '<p>café 日本語</p>', '<p>cafés 日本語</p>']));
ok('astral plane run', same(['<p>𝔘𝔫𝔦</p>', '<p>𝔘𝔫𝔦𝔠</p>']));

console.log('\n-- randomised property test (2000 random edit sequences) --');
let bad = null;
const alphabet = 'abcXY <>/p🎉日\n"&';
function randStr(n) { let s = ''; for (let i = 0; i < n; i++) s += alphabet[(Math.random() * alphabet.length) | 0]; return s; }
for (let t = 0; t < 2000 && !bad; t++) {
  const states = [randStr(1 + ((Math.random() * 60) | 0))];
  const steps = 1 + ((Math.random() * 4) | 0);
  for (let s = 0; s < steps; s++) {
    const prev = states[states.length - 1];
    const at = (Math.random() * (prev.length + 1)) | 0;
    const del = (Math.random() * Math.max(1, prev.length - at)) | 0;
    states.push(prev.slice(0, at) + randStr((Math.random() * 6) | 0) + prev.slice(at + del));
  }
  const out = roundTrip(states);
  if (!out || out.length !== states.length || !states.every((h, i) => out[i].html === h)) bad = states;
}
ok('every random sequence round-trips exactly', !bad, bad);

console.log('\n-- caret positions survive --');
{
  const out = roundTrip(['<p>a</p>', '<p>ab</p>', '<p>abc</p>']);
  ok('carets preserved', out.every((s, i) => s.caret === i * 3), out.map(s => s.caret));
}

console.log('\n-- legacy v1 payloads still load --');
{
  const v1 = { stack: [{ html: '<p>old</p>', caret: 4 }, { html: '<p>older</p>', caret: 5 }], idx: 1 };
  const out = decodeHist(v1);
  ok('v1 array passes through untouched', out && out.length === 2 && out[1].html === '<p>older</p>', out);
  ok('null is handled', decodeHist(null) === null);
  ok('empty v1 stack is handled', decodeHist({ stack: [] }) === null);
}

console.log('\n-- the actual point: size --');
{
  // A realistic entry: a chunk of prose plus one embedded image, edited 4 times.
  const img = 'data:image/png;base64,' + 'A'.repeat(120000);
  const body = '<p>' + 'lorem ipsum dolor sit amet '.repeat(400) + '</p><img src="' + img + '">';
  const states = [body];
  for (let i = 1; i < 5; i++) states.push(body.replace('</p>', ' edit' + i + '</p>'));

  const v1Size = JSON.stringify({ stack: mk(states), idx: 0, t: Date.now() }).length;
  const v2Size = JSON.stringify(encodeHist(mk(states), 0)).length;
  const savedPct = Math.round((1 - v2Size / v1Size) * 100);
  console.log('  v1 (five full copies): ' + (v1Size / 1024).toFixed(0) + 'KB');
  console.log('  v2 (base + deltas)   : ' + (v2Size / 1024).toFixed(0) + 'KB');
  console.log('  saved                : ' + savedPct + '%');
  ok('at least 70% smaller on a realistic document', savedPct >= 70, savedPct + '%');
  ok('and it still reconstructs exactly', same(states));
}

console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' : 'ALL PASSED — ') + (pass + fail) + ' assertions');
process.exit(fail ? 1 : 0);
