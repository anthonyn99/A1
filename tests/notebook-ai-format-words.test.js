// AI Format keeps the author's words (2026-11-26).
//
// WHAT WENT WRONG: Tony ran AI Format on "Scholarship Essay for V" and it
// changed his wording. Its prompt allowed "minor grammar, punctuation, spacing,
// capitalization" fixes and nothing checked the answer, so the model reworded
// freely. AI Format may only change layout.
//
// The fix has three layers: the prompt locks the words, the worker prefers the
// model answer that kept them (formatWordDrift, workers/personal-ai/refine.test.mjs),
// and the editor puts back any word that still changed (aiKeepWording, in
// Notebook/core/docx.js). This pins the editor's layer, lifted straight out of
// the shipping file and run in jsdom. It also pins that old saved default
// prompts move to the new one, and that inline bold/italic reach the model.
//
// Run: node tests/notebook-ai-format-words.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'Notebook', 'core', 'docx.js'), 'utf8');
const between = (a, b) => {
  const i = SRC.indexOf(a), j = SRC.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error('docx.js no longer has ' + a + ' ... ' + b);
  return SRC.slice(i, j);
};

const dom = new JSDOM('<!doctype html><body></body>');
const win = dom.window;
const code =
  between('var AI_DEFAULT_PROMPT = [', '// The built-in AI Refine default prompt.') +
  between('function aiExtractFragment(', '// Restore [[IMGn]]') +
  between('var _AI_INLINE_TAGS', 'window._docxAiKeepWording') +
  '\nreturn { aiKeepWording: aiKeepWording, aiExtractFragment: aiExtractFragment, _aiIsOldFormatDefault: _aiIsOldFormatDefault, AI_DEFAULT_PROMPT: AI_DEFAULT_PROMPT };';
const F = new win.Function('window', 'document', code)(win, win.document);

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};
const text = (html) => { const d = win.document.createElement('div'); d.innerHTML = html; return d.textContent.replace(/\s+/g, ' ').trim(); };

console.log('\nAI Format keeps your words');
{
  const sent = 'my essay\ni has always wanted to studdy medicine, becuase my mom is a nurse.\nshe works nights';
  const answer = '<h2>My Essay</h2><p>I have always wanted to study medicine because my mother is a nurse. She works nights.</p>';
  const r = F.aiKeepWording(sent, answer);
  ok('every reworded word is put back as written', r && text(r.html) === 'my essay i has always wanted to studdy medicine, becuase my mom is a nurse. she works nights', r && r.html);
  ok('the structure the model chose stays (heading + paragraph)', r && /<h2>my essay<\/h2>/.test(r.html) && /<p>/.test(r.html), r && r.html);
  ok('the run reports how many places it fixed', r && r.fixes > 0);
}
{
  const sent = 'Shopping\n- eggs\n- milk\n1. call mom';
  const answer = '<h2>Shopping</h2><ul><li>eggs</li><li>milk</li></ul><ol><li>call mom</li></ol>';
  const r = F.aiKeepWording(sent, answer);
  ok('pure layout (heading, lists, dropped list markers) is untouched', r && r.fixes === 0 && r.html === answer, r && r.html);
}
{
  const sent = 'Morning\nwoke up early';
  const answer = '<h1>Daily Summary</h1><h2>Morning</h2><p>woke up early</p>';
  const r = F.aiKeepWording(sent, answer);
  ok('a heading the model invented is removed, not left empty', r && !/Daily|Summary|<h1>/.test(r.html) && text(r.html) === 'Morning woke up early', r && r.html);
}
{
  const sent = 'first line\nsecond line has words\nthird';
  const answer = '<p>first line</p><p>third</p>';
  const r = F.aiKeepWording(sent, answer);
  ok('words the model dropped come back in place', r && text(r.html) === 'first line second line has words third', r && r.html);
}
{
  const sent = 'see the photo\n[[IMG1]]\nE=mc^2 is the rule';
  const answer = '<p>See the photo</p>[[IMG1|large]]<p>$E=mc^2$ is the rule</p>';
  const r = F.aiKeepWording(sent, answer);
  ok('image tokens and math delimiters survive the repair', r && /\[\[IMG1\|large\]\]/.test(r.html) && /\$E=mc\^2\$/.test(r.html) && /see the photo/.test(r.html), r && r.html);
}
{
  const sent = 'a <strong>bold</strong> claim stays';
  const answer = '<p>a <strong>bold</strong> claim stays</p>';
  const r = F.aiKeepWording(sent, answer);
  ok('inline tags carried to the model are not counted as words', r && r.fixes === 0, r && r.html);
}
{
  const sent = Array.from({ length: 40 }, (_, i) => 'word' + i).join(' ');
  const answer = '<p>' + Array.from({ length: 40 }, (_, i) => 'other' + i).join(' ') + '</p>';
  const r = F.aiKeepWording(sent, answer);
  ok('a fully rewritten answer is still restored to the author\'s words', r && text(r.html) === sent, r && r.html);
}

console.log('\nThe text sent to the model');
{
  const box = win.document.createElement('div');
  box.innerHTML = '<p>I <b>really</b> mean <em>this</em>.</p><pre><code>x = 1</code></pre>';
  const out = F.aiExtractFragment(box);
  ok('bold and italic reach the model as inline tags', /<strong>really<\/strong>/.test(out.text) && /<em>this<\/em>/.test(out.text), out.text);
  ok('a code block is left as it is', !/<code>x = 1<\/code>/.test(out.text), out.text);
}

console.log('\nSaved prompts');
{
  const OLD = 'You are an expert document formatter.\n\nYour task is to intelligently reformat the provided document without changing its meaning, tone, facts, wording, or intent in ANY way.\n\nRules:\n- Preserve ALL content. Never summarize, remove, invent, or rewrite information except for minor grammar, punctuation, spacing, capitalization, and formatting improvements.\n- Choose the best presentation automatically:\n  - Plain clean paragraphs if the document is primarily narrative.\n  - Markdown headings, lists, tables, quotes, code blocks, callouts, etc. only when they genuinely improve readability.\n  - Mix paragraphs and Markdown naturally when appropriate.\n- Create a logical document structure with clear sections where beneficial.\n- Merge broken lines into proper paragraphs.\n- Fix spacing, indentation, numbering, bullet consistency, and overall layout.\n- Preserve code, URLs, equations, and special formatting.\n- If tables communicate information better, convert suitable content into Markdown tables.\n- Do not over-format. Simplicity is preferred.\n- Never wrap the entire document in a code block.\n\nImages:\n- Preserve every image.\n- Move images only if doing so improves document flow.\n- Place each image near the most relevant content.\n- Output reasonable display sizes based on importance (large for primary images, medium for supporting images, small for icons or references).\n- Do not remove, duplicate, or describe images.\n\nOutput only the fully formatted document.';
  ok('a saved copy of an old default counts as the default', F._aiIsOldFormatDefault(OLD));
  ok('an edited prompt is kept', !F._aiIsOldFormatDefault(OLD + '\nAlso use British spelling.'));
  ok('the new default no longer allows grammar or capitalization fixes', /Do not fix spelling, grammar, punctuation or capitalization/.test(F.AI_DEFAULT_PROMPT) && !/minor grammar/.test(F.AI_DEFAULT_PROMPT));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
