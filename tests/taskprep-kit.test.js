#!/usr/bin/env node
/**
 * TaskHub AI task prep (workers/personal-ai/worker.js, POST /taskhub/prep).
 *
 * WHY THIS FILE EXISTS
 * The kit this route returns is acted on without a human reading it first:
 * Shield opens its sites with the OS and launches its apps. So the worker,
 * not the model, decides what may get through — apps only from the id list
 * the client sent, sites http(s) only, and the Gmail compose link built from
 * the draft fields rather than written (and mis-encoded) by the model. These
 * tests pin those rules without calling Gemini.
 *
 * Run: node tests/taskprep-kit.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? '\n      ' + detail : '')); console.log('  ✗ ' + name); }
}
function section(s) { console.log('\n' + s); }

const src = fs.readFileSync(path.join(__dirname, '..', 'workers', 'personal-ai', 'worker.js'), 'utf8')
  .replace(/^export default\s*\{/m, 'const __workerDefault = {');
const ctx = { console, URL, Response: function () {}, fetch: () => Promise.reject(new Error('no network in tests')), setTimeout, clearTimeout, AbortController };
vm.createContext(ctx);
vm.runInContext(src + '\n;globalThis.__T = { cleanPrepKit, prepCleanApps, buildPrepPrompt, prepGmailUrl, handleTaskPrep, PREP_PROMPT_MAX, __workerDefault };', ctx);
const W = ctx.__T;

const APPS = [{ id: 'a1', name: 'Microsoft Word' }, { id: 'a2', name: 'Zoom' }, { id: 'a3', name: 'Spotify' }];

section('apps');
{
  const k = W.cleanPrepKit({ prompt: 'p', apps: ['a1', 'zz', 'a1', 'a2'], sites: [], draft: { kind: 'none' } }, APPS);
  t('keeps only ids the client sent, once each', JSON.stringify(k.apps) === '["a1","a2"]', JSON.stringify(k.apps));
  const k2 = W.cleanPrepKit({ prompt: 'p', apps: ['a1', 'a2', 'a3', 'a1'] }, [...APPS, { id: 'a4', name: 'X' }]);
  t('caps apps at 3', k2.apps.length === 3);
  t('no app list means no apps', W.cleanPrepKit({ prompt: 'p', apps: ['a1'] }, []).apps.length === 0);
  const c = W.prepCleanApps([{ id: 'x', name: 'A' }, { id: 'x', name: 'B' }, { id: '', name: 'C' }, null, 'str', { id: 'y' }]);
  t('prepCleanApps drops dupes, blanks and junk', JSON.stringify(c) === '[{"id":"x","name":"A"}]', JSON.stringify(c));
}

section('sites');
{
  const k = W.cleanPrepKit({
    prompt: 'p', draft: { kind: 'none' },
    sites: [
      { label: 'Portal', url: 'https://portal.example.edu/form' },
      { label: 'Bad', url: 'javascript:alert(1)' },
      { label: 'File', url: 'file:///C:/Windows/system32/cmd.exe' },
      { label: 'Rel', url: '/relative' },
      { label: 'Dup', url: 'https://portal.example.edu/form' },
      { label: 'GmailFromModel', url: 'https://mail.google.com/mail/?view=cm&body=a&b' },
      { label: '', url: 'http://plain.example.com/' },
    ],
  }, APPS);
  const urls = k.sites.map(s => s.url);
  t('only http(s), deduped, model Gmail links dropped',
    JSON.stringify(urls) === '["https://portal.example.edu/form","http://plain.example.com/"]', JSON.stringify(urls));
  t('a blank label falls back to the hostname', k.sites[1].label === 'plain.example.com');
  const many = W.cleanPrepKit({ prompt: 'p', sites: [1, 2, 3, 4, 5, 6].map(i => ({ label: 's' + i, url: 'https://e' + i + '.com/' })) }, APPS);
  t('caps sites at 4', many.sites.length === 4);
}

section('email draft → Gmail compose link');
{
  const body = 'Hi Prof. Kim,\n\nCould I have an extension on A3 & A4? 100% my fault.\n\nVeda';
  const k = W.cleanPrepKit({
    prompt: 'p',
    draft: { kind: 'email', to: 'kim@ksu.edu', subject: 'Extension request: A3 & A4', body },
    sites: [1, 2, 3, 4, 5].map(i => ({ label: 's' + i, url: 'https://e' + i + '.com/' })),
  }, APPS);
  t('Gmail draft comes first', k.sites[0].label === 'Gmail draft');
  t('4 other sites still fit next to it', k.sites.length === 5);
  const u = new URL(k.sites[0].url);
  t('round-trips to, subject and body exactly',
    u.hostname === 'mail.google.com' && u.searchParams.get('view') === 'cm'
    && u.searchParams.get('to') === 'kim@ksu.edu'
    && u.searchParams.get('su') === 'Extension request: A3 & A4'
    && u.searchParams.get('body') === body, k.sites[0].url);
  const bad = W.cleanPrepKit({ prompt: 'p', draft: { kind: 'email', to: 'Prof Kim', subject: 's', body: 'b' } }, APPS);
  t('a "to" that is not an address is cleared', bad.draft.to === '' && !new URL(bad.sites[0].url).searchParams.has('to'));
  const empty = W.cleanPrepKit({ prompt: 'p', draft: { kind: 'email', subject: 's', body: '' } }, APPS);
  t('an email with no body becomes no draft and no Gmail link', empty.draft.kind === 'none' && empty.sites.length === 0);
  const msg = W.cleanPrepKit({ prompt: 'p', draft: { kind: 'message', to: 'a@b.co', subject: 'x', body: 'hey' } }, APPS);
  t('non-email drafts carry no to/subject and no Gmail link', msg.draft.to === '' && msg.draft.subject === '' && msg.sites.length === 0);
  t('unknown draft kind becomes none', W.cleanPrepKit({ prompt: 'p', draft: { kind: 'tweet', body: 'x' } }, APPS).draft.kind === 'none');
}

section('defaults and limits');
{
  const k = W.cleanPrepKit(null, APPS);
  t('null model output still yields a well-formed kit',
    k.helpful === true && k.prompt === '' && k.draft.kind === 'none' && k.sites.length === 0 && k.apps.length === 0);
  t('helpful:false is kept', W.cleanPrepKit({ helpful: false, prompt: 'p' }, APPS).helpful === false);
  t('prompt is capped', W.cleanPrepKit({ prompt: 'x'.repeat(20000) }, APPS).prompt.length === W.PREP_PROMPT_MAX);
}

section('prompt');
{
  const p = W.buildPrepPrompt({
    task: { title: 'Email Prof Kim about extension', date: '2026-10-04', time: '', type: 'task', category: 'study' },
    note: 'kim@ksu.edu, A3 is due Monday', site: 'chatgpt', today: '2026-10-03', weekday: 'Saturday', apps: APPS,
  });
  t('carries the task, the note and the chosen assistant', p.includes('Email Prof Kim about extension') && p.includes('kim@ksu.edu') && p.includes('ChatGPT'));
  t('lists the apps as id: name', p.includes('a2: Zoom'));
  t('says it never acts', /PREPARE only/.test(p));
  const none = W.buildPrepPrompt({ task: { title: 'x', type: 'task' }, note: '', site: 'nope', today: '2026-10-03', apps: [] });
  t('unknown site falls back to Perplexity', none.includes('Perplexity'));
  t('no apps says so', none.includes('return an empty apps list'));
}

section('route');
(async () => {
  // Response is stubbed in the sandbox; capture what json() builds instead.
  vm.runInContext('Response = function (b, o) { this.body = b; this.status = o && o.status; };', ctx);
  const r = await W.handleTaskPrep({ profile: 'veda', task: { title: '' } }, {});
  t('missing title is a 400', r.status === 400);
  const r2 = await W.handleTaskPrep({ profile: 'veda', task: { title: 'Email Kim' } }, {});
  t('missing key is a 500, not a crash', r2.status === 500 && /no Gemini key/.test(JSON.parse(r2.body).error));
  const wsrc = fs.readFileSync(path.join(__dirname, '..', 'workers', 'personal-ai', 'worker.js'), 'utf8');
  t('route is wired', /path === '\/taskhub\/prep'\)\s+return handleTaskPrep\(body, env\)/.test(wsrc));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nFailures:\n  ' + failures.join('\n  ')); process.exit(1); }
})();
