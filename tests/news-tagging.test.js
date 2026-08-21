/* TradeHub News: ticker attribution + the AI-phase subrequest budget.

   Two failures from the 2026-08-21 06:00 build, both of which looked from the
   outside like "my API is exhausted" and neither of which was:

   1. "Marvell's deal with Google indicates that custom silicon is 'advantageous,'
      Wedbush says" shipped tagged GOOGL only, with MRVL — a watchlist name the
      headline is half about — missing. candidateTickers came exclusively from
      feed attribution (whose company-news wire the article arrived on), and the
      AI is told primaryTicker must come from that list, so nothing in the whole
      pipeline ever read the word "Marvell".

   2. 16 of 52 events came out RAW while every model reported healthy and 7/7
      batches "succeeded". The first pass spent the entire 12-call subrequest
      ceiling on RPM retries, so the omission-retry pass — the ONLY thing that
      re-asks events a model silently skipped — was gated off and never ran.

   Both are quiet failures: nothing throws, nothing 429s, the build "succeeds".
   That is exactly why they need a test. */
'use strict';
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'workers', 'newshub-api', 'worker.js'), 'utf8');

const results = [];
const check = (n, p, d) => { results.push(p); console.log('  ' + (p ? 'PASS  ' : 'FAIL  ') + n + (d ? '  [' + d + ']' : '')); };

/* Load the worker's module scope without running its fetch/scheduled handlers. */
function loadWorker(extraExports) {
  const body = SRC.replace(/export default \{[\s\S]*$/, '');
  return new Function(`${body}\nreturn { ${extraExports.join(', ')} };`)();
}

const W = loadWorker([
  'mentionedTickers', 'clusterArticles', 'mergeAddlTickers',
  'aiCallBudgetLeft', 'countAICall', 'BATCH_SIZE', 'MAX_EVENTS',
  'AI_SUBREQUEST_CEILING', 'AI_SUBREQUEST_FLOOR', 'AI_OMISSION_RESERVE',
  'aiSubBudgetFor', 'FINNHUB_PER_TICKER_CAP', 'FETCH_WIRE_SUBREQUESTS', 'BUILD_SUBREQUEST_CAP',
  '_setBudgetState: (n, reserve, wl) => { _aiSubrequests = n; _aiUseReserve = reserve; _aiSubBudget = aiSubBudgetFor(wl); }',
]);

const WL = ['AAPL','AMD','AMZN','BE','CRDO','CRWD','DRAM','GOOGL','INTC','MRVL',
            'MSFT','MU','NET','NVDA','PLTR','SCCO','SNDK','SPCX','TSLA','WDC','WMT'];

/* ── 1. Cross-ticker attribution ─────────────────────────────────────────── */
console.log('\nThe reported failure: a story about two watchlist names');
{
  const h = "Marvell's deal with Google indicates that custom silicon is 'advantageous,' Wedbush says";
  const got = W.mentionedTickers(h, WL);
  check('both MRVL and GOOGL are found', got.includes('MRVL') && got.includes('GOOGL'), got.join(','));
}
{
  // The curly apostrophe is what the wires actually send.
  const h = 'Marvell’s Google AI Deal Could Unlock a Staggering $120 Billion Opportunity';
  const got = W.mentionedTickers(h, WL);
  check('a curly apostrophe does not hide the company name', got.includes('MRVL'), got.join(','));
}
{
  // The end-to-end path: an article that arrived on GOOGL's wire only.
  const evs = W.clusterArticles([{
    feed: 'fh', ticker: 'GOOGL', ts: Date.now(), url: 'https://seekingalpha.com/news/1',
    source: 'seekingalpha.com',
    headline: "Marvell's deal with Google indicates that custom silicon is 'advantageous,' Wedbush says",
    summary: '',
  }], WL);
  const cands = evs[0].candidateTickers;
  check('clustering carries MRVL through to candidateTickers', cands.includes('MRVL'), cands.join(','));
  check('and the feed ticker still leads', cands[0] === 'GOOGL',
    'candidateTickers[0] is the per-ticker cap key in selectTopEvents');
}

console.log('\nPrecision: a wrong ticker is worse than a missing one');
const noise = [
  ['Apple Intelligence rolls out to more devices',        'INTC', 'substring "intel" inside "Intelligence"'],
  ['TSMC foundry revenue climbs',                         'INTC', 'a generic industry word'],
  ['DRAM prices surge as memory demand accelerates',      'DRAM', 'the commodity, not the ticker'],
  ['A fuel cell startup raised $40M',                     'BE',   'a generic industry word'],
  ['It has to be all about the net gain, so go big',      'NET',  'an ordinary English word'],
  ['It has to be all about the net gain, so go big',      'BE',   'an ordinary English word'],
];
for (const [text, bad, why] of noise) {
  check('"' + text.slice(0, 42) + '" is not ' + bad, !W.mentionedTickers(text, WL).includes(bad), why);
}

console.log('\nRecall: the signals that should fire, do');
const wanted = [
  ['Micron Technology (NASDAQ:MU) Flags All Eight Growth Screens', 'MU',   'exchange-prefixed symbol'],
  ['14,925 Shares in Marvell Technology $MRVL Acquired',           'MRVL', '$-prefixed symbol'],
  ["AMD's EPYC wins a cloud deal from Microsoft Azure",            'MSFT', 'product alias'],
  ['Bloom Energy Calls Its Fuel Cells "Lego Blocks"',              'BE',   'company name, not the bare symbol'],
  ['Southern Copper (NYSE:SCCO) upgraded',                         'SCCO', 'exchange-prefixed symbol'],
];
for (const [text, want, why] of wanted) {
  check('"' + text.slice(0, 42) + '" finds ' + want, W.mentionedTickers(text, WL).includes(want), why);
}

console.log('\nThe scanner backstops the model, it does not replace it');
{
  const wlSet = new Set(WL);
  const ev = { candidateTickers: ['GOOGL', 'MRVL'] };
  // The exact 2026-08-21 shape: the AI named one side and returned addl: [].
  const got = W.mergeAddlTickers([], ev, 'GOOGL', wlSet);
  check('an empty additionalTickers still yields MRVL', got.includes('MRVL'), got.join(','));
  check('the primary is never duplicated into it', !got.includes('GOOGL'));
}
{
  const wlSet = new Set(WL);
  // The AI may legitimately see a ticker the scanner missed — keep it.
  const got = W.mergeAddlTickers(['NVDA'], { candidateTickers: ['MRVL'] }, 'GOOGL', wlSet);
  check("the model's own find survives the union", got.includes('NVDA') && got.includes('MRVL'), got.join(','));
  check('off-watchlist tickers are dropped',
    !W.mergeAddlTickers(['ZZZZ'], { candidateTickers: [] }, 'GOOGL', wlSet).includes('ZZZZ'));
}

/* ── 2. The AI-phase subrequest budget ───────────────────────────────────── */
const MAX_BATCHES = Math.ceil(W.MAX_EVENTS / W.BATCH_SIZE);

console.log('\nThe omission-retry pass can never be starved (the RAW bug)');
{
  const budget = W.aiSubBudgetFor(WL);           // 21 tickers, this watchlist
  const firstPassCeiling = budget - W.AI_OMISSION_RESERVE;
  console.log('  (budget ' + budget + ' for ' + WL.length + ' tickers, reserve ' +
              W.AI_OMISSION_RESERVE + ', max batches ' + MAX_BATCHES + ')');
  check('a full first pass fits under the un-reserved ceiling',
    MAX_BATCHES <= firstPassCeiling, MAX_BATCHES + ' batches vs ' + firstPassCeiling + ' calls');

  // Replay 2026-08-21: 7 batches, then RPM retries until the pass is cut off.
  W._setBudgetState(0, false, WL);
  let firstPass = 0;
  for (let i = 0; i < MAX_BATCHES; i++) { if (!W.aiCallBudgetLeft()) break; W.countAICall(); firstPass++; }
  check('every batch got its first-pass call', firstPass === MAX_BATCHES, firstPass + '/' + MAX_BATCHES);
  let retries = 0;
  while (W.aiCallBudgetLeft()) { W.countAICall(); retries++; }   // the retry storm
  check('the retry storm is capped short of the full budget',
    firstPass + retries < budget, 'spent ' + (firstPass + retries) + ' of ' + budget);

  // ...and now the pass that actually rescues RAW events runs anyway.
  W._setBudgetState(firstPass + retries, true, WL);
  let omission = 0;
  while (W.aiCallBudgetLeft()) { W.countAICall(); omission++; }
  check('the omission pass still has calls left', omission > 0, omission + ' call(s)');
  check('enough to re-ask the 16 events that went RAW that morning',
    omission * W.BATCH_SIZE >= 16, omission * W.BATCH_SIZE + ' event slots');
}

console.log('\nThe budget holds at every watchlist length');
{
  // The whole build is ONE invocation (staging is off), so fetch + AI must fit
  // under Cloudflare's 50 for ANY list the user might type into the Control tab.
  let worstTotal = 0, worstAt = 0, floorBroken = null;
  for (let n = 1; n <= 60; n++) {
    const budget = W.aiSubBudgetFor(new Array(n).fill('X'));
    const fetchEst = Math.min(n, W.FINNHUB_PER_TICKER_CAP) + W.FETCH_WIRE_SUBREQUESTS;
    const total = fetchEst + budget;
    if (total > worstTotal) { worstTotal = total; worstAt = n; }
    if (budget < MAX_BATCHES + W.AI_OMISSION_RESERVE) floorBroken = floorBroken || n;
  }
  check('fetch + AI never exceeds the 50-subrequest cap', worstTotal < 50,
    'worst is ' + worstTotal + ' at ' + worstAt + ' tickers');
  check('and stays under our own build cap', worstTotal <= W.BUILD_SUBREQUEST_CAP,
    'cap ' + W.BUILD_SUBREQUEST_CAP);
  check('the AI phase always keeps a full first pass + its reserve',
    floorBroken === null, floorBroken ? 'breaks at ' + floorBroken + ' tickers' : 'all lengths 1-60');
  check('the floor is derived from the batch count, not guessed',
    W.AI_SUBREQUEST_FLOOR === MAX_BATCHES + W.AI_OMISSION_RESERVE,
    'floor ' + W.AI_SUBREQUEST_FLOOR);
}

/* ── report ──────────────────────────────────────────────────────────────── */
const failed = results.filter(r => !r).length;
console.log('\n' + '─'.repeat(64));
console.log(failed ? failed + ' of ' + results.length + ' checks FAILED'
                   : 'All ' + results.length + ' news-pipeline checks passed.');
process.exit(failed ? 1 : 0);
