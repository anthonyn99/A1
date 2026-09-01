/* OneInbox → TaskHub cards: the commitment gate.

   Two cards on the week of 2026-09-01 that should never have existed:

   1. "RDSolutions - Come Work for Us!" — a recruiter saying they are hiring in
      Broomfield and linking a Calendly to book a chat — was filed as an
      APPOINTMENT, on Tue Sep 1, in "Broomfield area". Nothing was scheduled;
      the day came from the email's own send date.

   2. "Upgrade within seven days to keep going with Azure" — a free-trial
      conversion ad — was filed as a SUBSCRIPTION renewing Sun Sep 6. There is
      no Azure subscription; "next week" became a renewal date.

   Both are the same mistake: classifying an email by its TOPIC rather than by
   whether anything is actually COMMITTED, and then inventing the date that puts
   it on the calendar. The prompt now says so, but a prompt is not a guarantee —
   these checks are, and they have to hold without demoting the real thing. */
'use strict';
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'workers', 'oneinbox-api', 'worker.js'), 'utf8');

const results = [];
const check = (n, p, d) => { results.push(p); console.log('  ' + (p ? 'PASS  ' : 'FAIL  ') + n + (d ? '  [' + d + ']' : '')); };

/* Module scope only — never the fetch/scheduled handlers. */
function loadWorker(names) {
  const body = SRC.replace(/export default \{[\s\S]*$/, '');
  return new Function(body + '\nreturn { ' + names.join(', ') + ' };')();
}
const W = loadWorker(['commitmentGate', 'dateIsStated', 'cardFor', 'DATED']);

const sent = (iso) => new Date(iso + 'T12:00:00Z');

/* The two emails, as the classifier sees them (subject + body text). */
const RECRUITER = [
  'Subject: RDSolutions - Come Work for Us!',
  'Good afternoon! You previously applied for one of our field positions in the past, and we are hiring in the Broomfield area.',
  "If you are still in the Broomfield area we'd love to talk to you more about our current positions. Below is a link that has a",
  "video explaining more about what we do, and it's a link to schedule to speak to someone on the team.",
  'Link to view video and schedule with the team: https://calendly.com/d/cvqw-mvq-75t/rdsolutions-virtual-interview',
  'If you are no longer in the Broomfield area, but still interested, let me know where you are and I can check to see if we are hiring in your area.',
  'Corey Hendrickson, Operations Recruiting Manager'
].join('\n');

const AZURE = [
  'Subject: Upgrade within seven days to keep going with Azure',
  'Keep going with Azure for free. Before your trial ends next week, upgrade your Azure account to continue building with',
  'popular services free for 12 months, plus more than 55 services that are always free. After you upgrade, only pay for the',
  'resources you use beyond the free monthly amounts.',
  'Upgrade now. Manage Azure resources from your mobile device.'
].join('\n');

/* ── the two reported failures ───────────────────────────────────────────── */
{
  const was = { category: 'appointment', confidence: 0.7, summary: 'Invitation to schedule a virtual interview with RDSolutions.',
                merchant: 'RDSolutions', date: '2026-09-01', location: 'Broomfield area' };
  const got = W.commitmentGate(was, RECRUITER, sent('2026-09-01'));
  check('a Calendly invite is not an appointment', got.category === 'important', 'got ' + got.category);
  check('and it loses the day it never had', !got.date, 'date ' + JSON.stringify(got.date));
  check('cardFor draws nothing for it',
    W.cardFor({ id: 'm1', threadId: 't1', from: 'Corey <c@rdsolutions.io>', subject: 'RDSolutions - Come Work for Us!' }, got) === null);
}
{
  const was = { category: 'subscription', confidence: 0.8, summary: 'Upgrade your Azure account before your trial ends next week.',
                merchant: 'Microsoft Azure', date: '2026-09-06' };
  const got = W.commitmentGate(was, AZURE, sent('2026-08-30'));
  check('a trial-conversion ad is not a subscription', got.category === 'general', 'got ' + got.category);
  check('and no renewal date survives it', !got.date, 'date ' + JSON.stringify(got.date));
  check('cardFor draws nothing for it',
    W.cardFor({ id: 'm2', threadId: 't2', from: 'Azure <azure@infoemails.microsoft.com>', subject: 'Upgrade within seven days' }, got) === null);
}

/* ── the real thing must still get through ───────────────────────────────── */
{
  const t = 'Subject: Your appointment is confirmed\n'
    + 'Your appointment with Dr. Okafor is confirmed for Tuesday, September 8 at 9:30 AM at Boulder Family Medicine.\n'
    + 'Need a different time? Schedule a new time here.';
  const got = W.commitmentGate({ category: 'appointment', confidence: 0.9, date: '2026-09-08',
                                 merchant: 'Boulder Family Medicine', location: 'Boulder Family Medicine' }, t, sent('2026-09-01'));
  check('a confirmed appointment survives its own reschedule link',
    got.category === 'appointment' && got.date === '2026-09-08', got.category + ' / ' + got.date);
}
{
  const t = 'Subject: Your Netflix membership renews soon\n'
    + 'Your plan renews on September 12, 2026 and your card ending 4412 will be charged $17.99.\n'
    + 'Sign up for extra members any time.';
  const got = W.commitmentGate({ category: 'subscription', confidence: 0.9, date: '2026-09-12',
                                 merchant: 'Netflix', amount: '$17.99' }, t, sent('2026-09-05'));
  check('a real renewal survives the words "sign up"',
    got.category === 'subscription' && got.date === '2026-09-12' && got.amount === '$17.99',
    got.category + ' / ' + got.date);
}
{
  const t = 'Subject: Your Xcel Energy bill is ready\n'
    + 'Amount due $184.32. Due date 09/20/2026. Paperless billing: sign up now.';
  const got = W.commitmentGate({ category: 'bill', confidence: 0.9, date: '2026-09-20', amount: '$184.32', merchant: 'Xcel Energy' },
                               t, sent('2026-09-02'));
  check('a real bill survives a marketing footer', got.category === 'bill' && got.date === '2026-09-20', got.category + ' / ' + got.date);
}
{
  const t = 'Subject: Your flight to Denver\n'
    + 'Your itinerary: UA 2231 departs Sep 14 at 6:05 AM. Confirmation number K8JQ2M.';
  const got = W.commitmentGate({ category: 'travel', confidence: 0.9, date: '2026-09-14', code: 'K8JQ2M', location: 'DEN' },
                               t, sent('2026-09-01'));
  check('a booked flight is untouched', got.category === 'travel' && got.date === '2026-09-14', got.category + ' / ' + got.date);
}
{
  /* Packages are the one category ALLOWED to infer their day. */
  const t = 'Subject: Your package is out for delivery\nYour Amazon package is out for delivery and will arrive today.';
  const got = W.commitmentGate({ category: 'package', confidence: 0.9, date: '2026-09-03', carrier: 'Amazon', tracking: 'TBA123' },
                               t, sent('2026-09-03'));
  check('the gate never touches a package', got.category === 'package' && got.date === '2026-09-03' && !got.gate);
}

/* ── date provenance ─────────────────────────────────────────────────────── */
{
  const s = sent('2026-09-01');
  const cases = [
    ['September 6, 2026', '2026-09-06', true],
    ['Sep 6',             '2026-09-06', true],
    ['6 September',       '2026-09-06', true],
    ['9/6/26',            '2026-09-06', true],
    ['2026-09-06',        '2026-09-06', true],
    ['due tomorrow',      '2026-09-02', true],
    ['at 3pm today',      '2026-09-01', true],
    ['on Sunday',         '2026-09-06', true],
    ['ends next week',    '2026-09-06', false],
    ['within seven days', '2026-09-08', false],
    ['act soon',          '2026-09-04', false],
    ['',                  '2026-09-01', false]   // the send date, out of thin air
  ];
  let bad = null;
  for (const [text, iso, want] of cases) {
    if (W.dateIsStated('Subject: x\n' + text, iso, s) !== want) { bad = JSON.stringify(text) + ' -> ' + iso; break; }
  }
  check('a date counts only when the email says it', bad === null, bad ? 'wrong: ' + bad : cases.length + ' forms');
  check('a bare weekday only reaches two weeks out', W.dateIsStated('see you Sunday', '2026-09-20', s) === false);
}

/* ── the gate's blast radius ─────────────────────────────────────────────── */
{
  check('only the four calendar categories are date-gated',
    W.DATED.has('bill') && W.DATED.has('subscription') && W.DATED.has('travel') && W.DATED.has('appointment')
    && !W.DATED.has('package') && !W.DATED.has('coupon'), [...W.DATED].join(','));
  const untouched = { category: 'coupon', confidence: 0.8, code: 'NIKE25', amount: '25% OFF', date: '2026-09-30' };
  const got = W.commitmentGate(untouched, 'Subject: 25% off\nUse code NIKE25. Sign up now. Limited time.', sent('2026-09-01'));
  check('a coupon is returned exactly as it came in', JSON.stringify(got) === JSON.stringify(untouched));
}

/* ── report ──────────────────────────────────────────────────────────────── */
const failed = results.filter(r => !r).length;
console.log('\n' + '─'.repeat(64));
console.log(failed ? failed + ' of ' + results.length + ' checks FAILED'
                   : 'All ' + results.length + ' commitment-gate checks passed.');
process.exit(failed ? 1 : 0);
