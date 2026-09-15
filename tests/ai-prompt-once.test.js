// The AI prompt is typed ONCE, sent, and never left behind.
//
// WHAT WENT WRONG (2026-09-15, reported from a real morning run)
// The Daily Macro prompt reached ChatGPT, ran, and was answered — and a second
// full copy of it was sitting in the composer afterwards.
//
// The auto-submit script confirms a send with two NEGATIVE signals: the
// composer went empty, or the url changed. Neither can tell "the send I just
// fired worked" from "a send worked half a minute ago". When a round sent
// successfully but the page took longer to clear its box than fireSend spends
// confirming, the retry loop did the destructive thing — cleared the composer
// and typed all 5,000-odd characters in again. By then the site was streaming,
// its send control was a STOP button (correctly refused), so no later round
// could send; the last round typed it and left it there, and the url from the
// FIRST round's success then made the whole thing report as a win.
//
// Reproduced in a real browser against a chat page that settles slower than the
// confirmation window: BEFORE the fix, `sent: 1, leftInBox: 3031`. After it,
// `sent: 1, leftInBox: 0`.
//
// The fix is one positive signal — is the prompt IN THE TRANSCRIPT — so this
// pins that signal's behaviour, and that every path which retypes consults it.
//
// Run: node tests/ai-prompt-once.test.js
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'Vault', 'vault-ai-prompt.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};

/** Lift one function out of the shipping file, braces balanced. */
function lift(name) {
  const at = SRC.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('not found: ' + name);
  let depth = 0;
  for (let j = SRC.indexOf('{', SRC.indexOf(')', at)); j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}' && --depth === 0) return SRC.slice(at, j + 1);
  }
  throw new Error('unbalanced: ' + name);
}

// ── the real helper, in a real DOM ──────────────────────────────────────────
const { JSDOM } = require('jsdom');

function posted({ inTranscript, inBox, text, strict }) {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="transcript">${inTranscript ? `<div class="msg">${inTranscript}</div>` : ''}</div>
    <div id="composer" contenteditable="true">${inBox || ''}</div>
  </body>`);
  const { document } = dom.window;
  // The probe length comes from the file too, so the test cannot drift from it.
  const PROBE = /var POSTED_PROBE = (\d+);/.exec(SRC)[1];
  const fn = new Function('document', 'findComposer', 'composerText', 'norm',
    'var POSTED_PROBE = ' + PROBE + ';\n'
    + lift('countOf') + '\n' + lift('alreadyPosted') + '\nreturn alreadyPosted;')(
    document,
    () => document.getElementById('composer'),
    (el) => (el ? (el.textContent || '') : '').trim(),
    (s) => String(s || '').replace(/\s+/g, ' ').trim(),
  );
  const out = fn({ input: [], send: [] }, document.getElementById('composer'), text, strict);
  dom.window.close();
  return out;
}

const PROMPT = 'Daily Macro & Long-Only Trading Report. Give me a full premarket, market and '
  + 'after-market macro update for today, including the latest information for all of the following.';

console.log('\nThe prompt is recognised in the conversation');
{
  ok('sent, and the box is empty', posted({ inTranscript: PROMPT, inBox: '', text: PROMPT }) === true);
  ok('  and the strict form agrees', posted({ inTranscript: PROMPT, inBox: '', text: PROMPT, strict: true }) === true);
  ok('sent, with a duplicate still in the box',
    posted({ inTranscript: PROMPT, inBox: PROMPT, text: PROMPT }) === true);
  ok('a collapsed bubble still counts (only the start is shown)',
    posted({ inTranscript: PROMPT.slice(0, 160) + ' …', inBox: '', text: PROMPT }) === true);
}

console.log('\nAnd never mistaken for one that was only typed');
{
  // The dangerous direction: a false positive here means never sending at all.
  ok('typed but NOT sent is not "posted"',
    posted({ inTranscript: '', inBox: PROMPT, text: PROMPT }) === false);
  ok('  nor under the strict form used before any typing',
    posted({ inTranscript: '', inBox: PROMPT, text: PROMPT, strict: true }) === false);
  ok('an empty page is not "posted"', posted({ inTranscript: '', inBox: '', text: PROMPT }) === false);
  ok('a different conversation is not "posted"',
    posted({ inTranscript: 'something else entirely', inBox: '', text: PROMPT }) === false);
  // A short prompt could collide with ordinary page furniture.
  ok('a too-short prompt never matches',
    posted({ inTranscript: 'hi there', inBox: '', text: 'hi there' }) === false);
}

console.log('\nEvery path that would retype consults it first');
{
  const deliver = lift('deliver');
  ok('before typing anything at all', /alreadyPosted\(profile, el, text, true\)/.test(deliver));
  ok('  and that first check is the STRICT one, needing an empty box',
    /strict\) return box\.length === 0;/.test(lift('alreadyPosted')));
  ok('at the top of every retry round',
    /round > 0 && alreadyPosted\(profile, el, text\)/.test(deliver));
  ok('after a send that reported failure', /send landed after all/.test(deliver));
  ok('and once more before giving up', /clearing the duplicate left in the box/.test(deliver));
  // Four consult points, four clears: no path may end with a duplicate.
  ok('each of those clears the box', (deliver.match(/clearComposer\(/g) || []).length >= 4,
    (deliver.match(/clearComposer\(/g) || []).length);
}

console.log('\nThe send is confirmed by arrival, not just by an empty box');
{
  const looks = lift('looksSent');
  ok('looksSent takes the prompt text', /function looksSent\(profile, el, text\)/.test(looks));
  ok('  and treats it as the strongest signal',
    looks.indexOf('alreadyPosted') < looks.indexOf('composerEmpty'), looks);
  ok('fireSend passes it through', /async function fireSend\(profile, el, text\)/.test(SRC));
  // Both of fireSend's confirmations -- the one at the top of each try and the
  // one it returns -- or a slow page is still read as a failure on one of them.
  const fire = lift('fireSend');
  ok('  on both of its checks', (fire.match(/looksSent\(profile, el, text\)/g) || []).length === 2,
    (fire.match(/looksSent\(profile, el, text\)/g) || []).length);
}

console.log('\nA prompt that genuinely never sent is still left to hand');
{
  const deliver = lift('deliver');
  const giveUp = deliver.slice(deliver.indexOf('Genuinely never sent'));
  ok('the text stays in the composer for one keypress', /press Enter yourself/.test(giveUp));
  ok('  and it stays pending so a reload can retry', /return false/.test(giveUp));
  ok('that branch is only reached when it was NOT posted',
    deliver.indexOf('clearing the duplicate left in the box') < deliver.indexOf('Genuinely never sent'));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
