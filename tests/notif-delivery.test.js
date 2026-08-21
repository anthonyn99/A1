#!/usr/bin/env node
/**
 * Plans notifications: does an event push actually reach the other person?
 *
 * A proposed plan notifies the other profile over the SAME cloud pipeline the
 * scheduled reminders use — one doc in `reminders`, swept by the cron in
 * workers/taskhub-reminders. Three properties of that pipeline are load-bearing
 * for Plans and for nothing else, which is why they broke silently: a plan was
 * proposed, the record saved perfectly, and the other person was simply never
 * told. Nothing errored anywhere.
 *
 *   1. LATENESS MUST NOT DESTROY AN EVENT. A scheduled reminder more than 90s
 *      late is marked fired and never sent, which is right for an alarm. An
 *      event push has no minute of its own — its notifyAt is "as soon as
 *      possible" written in the sweep's language, taken from the PROPOSING
 *      BROWSER's clock. A lagging clock, one skipped cron tick or a lost wake
 *      poke pushed it outside the due window, and the pipeline then deleted the
 *      notification rather than delivering it late.
 *
 *   2. THE QUERY MUST SEE IT. The cron may skip its Firestore query for up to
 *      LOOKAHEAD_MAX_AGE_MS while its lookahead says nothing is due. An event
 *      written during that quiet stretch is already minutes old by the time any
 *      tick runs, so the query's lower bound has to reach back at least that far
 *      or the doc is never returned at all.
 *
 *   3. IT MUST BE ROUTED TO A DEVICE THE PERSON ACTUALLY USES. Reminder scoping
 *      is strict on the device's MAIN dashboard. The first profile opened on a
 *      device claims main permanently, so the other person can use that device
 *      daily and match nothing — no push, and no in-app banner either, since
 *      that gate keyed on main as well. An event is addressed to a person.
 *
 * Both pure routing helpers are extracted from the shipped worker and executed,
 * so this cannot pass against a worker that no longer contains them.
 *
 * Run: node tests/notif-delivery.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const worker = fs.readFileSync(path.join(ROOT, 'workers', 'taskhub-reminders', 'worker.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(ROOT, 'firebase-messaging-sw.js'), 'utf8');

const fail = [];
const pass = [];
function check(name, ok, detail) {
  (ok ? pass : fail).push(name + (detail ? '  — ' + detail : ''));
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (detail ? '  [' + detail + ']' : ''));
}

// Pull a top-level function out of the shipped worker and make it callable, so
// the behaviour checked below is the behaviour that ships.
function extract(src, name) {
  let start = src.indexOf('function ' + name + '(');
  if (start < 0) return null;
  if (src.slice(start - 6, start) === 'async ') start -= 6;   // keep the async keyword
  let i = src.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  return null;
}

console.log('\nEvent pushes survive being late (the proposal that never arrived)');

// The classification is inline in runReminders, so pin it by its text and then
// exercise the same rule against the real constants.
const evtPredicate = /deliverNow\?\.booleanValue === true \|\| f\.source\?\.stringValue === 'plans'/;
check('the cron recognises an event push', evtPredicate.test(worker));
check(
  'an event push is due on lateness alone, never stale',
  /if \(isEventPush\(r\.document\)\) \{[\s\S]{0,400}?due\.push\(r\)/.test(worker) &&
    /else if \(at <= now - 90000\) stale\.push\(r\)/.test(worker),
  'event branch returns before the stale branch'
);
check(
  'a scheduled reminder is still dropped when it is very late',
  /stale\.push\(r\)/.test(worker) && /for \(const r of stale\) \{\s*await markFired/.test(worker),
  'alarm semantics unchanged'
);
check(
  'the client marks its Plans push as deliver-now',
  /deliverNow:true,/.test(html) && /source:'plans',/.test(html)
);

console.log('\nThe query window reaches back far enough to see one');

const lowerBound = worker.match(/const startAtIso = new Date\(now - (\d+) \* 60 \* 1000\)/);
const maxAge = worker.match(/LOOKAHEAD_MAX_AGE_MS = (\d+) \* 60 \* 1000/);
check('the normal-tick lower bound is expressed in minutes', !!lowerBound, lowerBound && lowerBound[1] + 'min');
check(
  'it reaches past the longest the cron may skip its query',
  !!lowerBound && !!maxAge && Number(lowerBound[1]) > Number(maxAge[1]),
  lowerBound && maxAge ? lowerBound[1] + 'min lookback > ' + maxAge[1] + 'min max skip' : 'n/a'
);
check(
  'the upper bound is still bounded (the 6K-reads/hr regression)',
  /const endAtIso   = new Date\(now \+ 10 \* 60 \* 1000\)/.test(worker)
);

console.log('\nRouting: an event reaches the person, a reminder reaches the device');

const deviceMatchesSrc = extract(worker, 'deviceMatches');
check('deviceMatches was found in the worker', !!deviceMatchesSrc);
if (deviceMatchesSrc) {
  const deviceMatches = new Function(deviceMatchesSrc + '; return deviceMatches;')();
  const dev = (mainDash, lastDash) => ({
    fields: {
      token: { stringValue: 'tok' },
      mainDash: { stringValue: mainDash },
      ...(lastDash ? { lastDash: { stringValue: lastDash } } : {})
    }
  });

  // The reported failure: a device Veda uses every day, whose main is Tony's
  // because his profile happened to be opened on it first.
  check(
    "(the reported failure) Veda's plan reaches a device whose main is Tony's",
    deviceMatches(dev('tony', 'veda'), 'veda', true) === true
  );
  check(
    "but Tony's REMINDERS still do not ring on it for Veda",
    deviceMatches(dev('tony', 'veda'), 'veda', false) === false,
    'reminder scoping untouched'
  );
  check(
    'a device that is main for the profile gets both',
    deviceMatches(dev('veda', 'veda'), 'veda', true) === true &&
      deviceMatches(dev('veda', 'veda'), 'veda', false) === true
  );
  check(
    "a device that is neither main nor last-used for Veda gets nothing of hers",
    deviceMatches(dev('tony', 'tony'), 'veda', true) === false &&
      deviceMatches(dev('tony', 'tony'), 'veda', false) === false,
    'an event push must not broadcast'
  );
  check(
    'a device with no last-used profile recorded is not guessed at',
    deviceMatches(dev('tony', null), 'veda', true) === false
  );
  check("an 'all'-tagged diagnostic still broadcasts", deviceMatches(dev('tony', 'tony'), 'all', false) === true);
}

console.log('\nEvery registered device is considered, not just the first page');

const listTokenDocsSrc = extract(worker, 'listTokenDocs');
check('listTokenDocs was found in the worker', !!listTokenDocsSrc);
if (listTokenDocsSrc) {
  const listTokenDocs = new Function(
    'fetch',
    'console',
    'URL',
    listTokenDocsSrc + '; return listTokenDocs;'
  );
  (async () => {
    // Two pages, the way Firestore's REST list actually answers: the device we
    // care about is on page two. Before pagination it was invisible forever.
    const pages = {
      null: {
        documents: [{ fields: { token: { stringValue: 'page1-device' } } }],
        nextPageToken: 'p2'
      },
      p2: { documents: [{ fields: { token: { stringValue: 'page2-device' } } }] }
    };
    const stub = async (u) => {
      const t = new URL(u).searchParams.get('pageToken');
      return { ok: true, json: async () => pages[t === null ? 'null' : t] };
    };
    const fn = listTokenDocs(stub, console, URL);
    const docs = await fn('https://example/base', {});
    check(
      "(the reported failure) a device on the second page is reachable",
      docs.length === 2 && docs.some((d) => d.fields.token.stringValue === 'page2-device'),
      docs.length + ' device(s)'
    );

    const dupPages = {
      null: {
        documents: [
          { fields: { token: { stringValue: 'same' } } },
          { fields: { token: { stringValue: 'same' } } },
          { fields: {} }
        ]
      }
    };
    const dupStub = async () => ({ ok: true, json: async () => dupPages.null });
    const dupDocs = await listTokenDocs(dupStub, console, URL)('https://example/base', {});
    check('one device is still one push', dupDocs.length === 1, 'de-dup + token-less docs skipped');

    const failStub = async () => ({ ok: false, text: async () => 'nope' });
    const failed = await listTokenDocs(failStub, { error() {} }, URL)('https://example/base', {});
    check('a failed read is reported, not treated as "no devices"', failed === null);

    check(
      'the cron aborts rather than marking everything fired on a failed read',
      /const tokenDocs = await listTokenDocs\(baseUrl, authHdr\);\s*\n\s*if \(tokenDocs === null\) return;/.test(worker)
    );

    finish();
  })();
} else {
  finish();
}

function finish() {
  console.log('\nThe receiving device shows it (both surfaces)');

  check(
    'the worker labels every push event or reminder',
    /kind: String\(kind \|\| 'reminder'\)/.test(worker) &&
      /sendFCM\(projectId, token, title, id, accessToken, dash, evt \? 'event' : 'reminder'\)/.test(worker)
  );
  check(
    'the page gate accepts the profile currently open, for events only',
    /function _dashAllowedHere\(dash,kind\)\{/.test(html) &&
      /if\(kind!=='event'\)return false;/.test(html) &&
      /const here=window\._activeProfile\|\|localStorage\.getItem\('td6_lastDash'\)\|\|'';/.test(html)
  );
  check(
    'both page surfaces use that one gate',
    (html.match(/if\(!_dashAllowedHere\(/g) || []).length === 2,
    'foreground onMessage + SW banner bridge'
  );
  check(
    'the closed-app OS card uses the same rule',
    /async function shouldShowForDash\(dash, kind\)\{/.test(sw) && /if\(kind !== 'event'\) return false;/.test(sw)
  );
  check(
    'the page tells the service worker which profile is open',
    /type:'th-set-lastdash'/.test(html) && /msg\.type === 'th-set-lastdash'/.test(sw)
  );
  check(
    'and tells the cloud, so the send side can target this device',
    /window\._fcmNoteActiveDash=async function/.test(html) &&
      (html.match(/window\._fcmNoteActiveDash\("(tony|veda)"\)/g) || []).length === 2,
    'called from both profile switches'
  );
  check(
    'a push from an older worker still gets the strict reminder gate',
    /const kind  = d\.kind \|\| 'reminder';/.test(sw)
  );
  check(
    'the service worker version was bumped so devices pick this up',
    /const SW_VERSION = '2026-08-20-event-scope';/.test(sw)
  );

  console.log('\n' + '─'.repeat(64));
  if (fail.length) {
    console.error('\n' + fail.length + ' notification-delivery check(s) FAILED:\n');
    fail.forEach((f) => console.error('  • ' + f));
    console.error('\nA proposed plan can go undelivered. Fix before shipping.');
    process.exit(1);
  }
  console.log('All ' + pass.length + ' notification-delivery checks passed.');
}
