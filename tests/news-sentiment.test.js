/* News sentiment is judged PER TICKER, in both news workers
   (workers/newshub-api = TradeHub, V1/workers/tradeboard-news = TradeBoard).

   2026-11-12: "Nvidia's board explores replacing Jensen Huang; traders rotate
   into AMD" showed as NEUTRAL in the article feed and in the Summary's key
   points. One sentiment per story meant bearish-NVDA + bullish-AMD averaged to
   nothing. Now:
     - each event carries tickerSentiment {TICKER: {label, score}}, and its
       sentiment is the SUBJECT's (primaryTicker)
     - a "neutral" with a clear score, or next to a signed entry for the same
       primary, becomes that sign
     - the digest prompt lists every ticker with its own stance, subject first
     - key points carry tickerStances, and reconcileDigest stops a ticker
       being called neutral when its own news clearly points one way

   Run: node tests/news-sentiment.test.js */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (n, c, extra) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (extra !== undefined ? '  -> ' + JSON.stringify(extra).slice(0, 300) : '')); } };

function load(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n').replace(/export default \{[\s\S]*$/, '');
  return new Function(`${src}\nreturn { cleanSent, aiSentiment, buildDigestPrompt, buildGeminiPrompt, normalizeDigest, reconcileDigest, geminiBody, DIGEST_SCHEMA, mergeAddlTickers };`)();
}
const WL = ['DRAM','SNDK','MU','INTC','WDC','AMD','CRWD','BE','GOOGL','PLTR','NVDA','MRVL','CRDO','TSLA','SPCX','AAPL','MSFT','NET','SCCO','ERO','WMT','AMZN','BABA','TSM','SKHY'];

for (const rel of ['workers/newshub-api/worker.js', 'V1/workers/tradeboard-news/worker.js']) {
  console.log('\n' + rel);
  const W = load(rel);

  // cleanSent
  ok('neutral with a clear negative score becomes bear', W.cleanSent('neutral', -0.5).label === 'bear');
  ok('bear with a positive score gets a negative score', W.cleanSent('bear', 0.6).score === -0.6);
  ok('bull with no score gets a positive default', W.cleanSent('bull', 0).score > 0);
  ok('a real neutral stays neutral', W.cleanSent('neutral', 0.1).label === 'neutral');

  // The NVDA case: the model averaged to neutral but judged each ticker.
  const ai = {
    primaryTicker: 'NVDA', sentiment: 'neutral', sentimentScore: 0,
    tickerSentiments: [{ ticker: 'NVDA', sentiment: 'bear', score: -0.8 }, { ticker: 'AMD', sentiment: 'bull', score: 0.4 }, { ticker: 'ZZZ', sentiment: 'bull', score: 1 }],
  };
  const r = W.aiSentiment(ai, 'NVDA', ['AMD']);
  ok('subject verdict wins over an averaged neutral', r.sentiment.label === 'bear' && r.sentiment.score === -0.8, r);
  ok('rival keeps its own opposite verdict', r.tickerSentiment.AMD && r.tickerSentiment.AMD.label === 'bull', r);
  ok('tickers not on the event are dropped', !('ZZZ' in r.tickerSentiment), r);

  // Primary swapped by the hallucination fallback: the overall verdict was for another ticker.
  const r2 = W.aiSentiment({ primaryTicker: 'TSLA', sentiment: 'bull', sentimentScore: 0.7, tickerSentiments: [] }, 'LCID', []);
  ok('swapped primary does not inherit another ticker\'s verdict', r2.sentiment.label === 'neutral', r2);

  // Prompt + schema
  ok('analysis prompt carries the sentiment rules', /Rivals often move OPPOSITE/.test(W.buildGeminiPrompt([], ['NVDA'], {})));
  const props = W.geminiBody('gemini-2.5-flash', 'x').generationConfig.responseSchema.items.properties;
  ok('analysis schema asks for tickerSentiments', !!props.tickerSentiments);
  ok('digest schema asks for tickerStances', !!W.DIGEST_SCHEMA.properties.keyPoints.items.properties.tickerStances);

  const events = [
    { primaryTicker: 'NVDA', additionalTickers: ['AMD'], impact: { tier: 'critical', score: 85 }, eventType: 'personnel', ts: Date.now() - 3 * 3600e3,
      sentiment: { label: 'bear', score: -0.8 }, tickerSentiment: { NVDA: { label: 'bear', score: -0.8 }, AMD: { label: 'bull', score: 0.4 } }, summary: 'Nvidia board explores replacing CEO.' },
    { primaryTicker: 'MU', additionalTickers: ['WDC'], impact: { tier: 'major', score: 70 }, eventType: 'macro', sentiment: { label: 'bull', score: 0.5 }, summary: 'Old build, no per-ticker map.' },
  ];
  const p = W.buildDigestPrompt(events, ['NVDA', 'AMD', 'MU', 'WDC']);
  ok('digest rows list each ticker with its own stance, subject first', p.includes('[NVDA bear-0.80 | AMD bull+0.40]'), p.split('\n').find(l => l.includes('NVDA')));
  ok('old builds: subject gets the event sentiment, others bare', p.includes('[MU bull+0.50 | WDC]'));
  ok('digest rows carry the age', /personnel 3h ::/.test(p));

  // normalize + reconcile
  const d = W.normalizeDigest({
    headline: 'h', tone: 'mixed', toneScore: 0, overview: 'o',
    keyPoints: [
      { text: 'Nvidia CEO replacement explored', stance: 'neutral', tickerStances: [{ ticker: 'NVDA', stance: 'bear' }, { ticker: 'amd', stance: 'bull' }] },
      { text: 'legacy point', stance: 'neutral', tickers: ['NVDA'] },
    ],
    tickers: [{ ticker: 'NVDA', stance: 'neutral', note: 'n' }, { ticker: 'AMD', stance: 'bull', note: 'n' }],
    themes: [],
  });
  ok('tickers are filled from tickerStances for older clients', d.keyPoints[0].tickers.join() === 'NVDA,AMD', d.keyPoints[0]);
  ok('legacy tickers become tickerStances', d.keyPoints[1].tickerStances[0].ticker === 'NVDA');
  W.reconcileDigest(d, events);
  ok('key point takes its subject\'s stance', d.keyPoints[0].stance === 'bear', d.keyPoints[0]);
  ok('a neutral ticker with clearly bearish news becomes bear', d.tickers[0].stance === 'bear', d.tickers);
  ok('legacy point with a neutral subject picks up the ticker\'s own net', d.keyPoints[1].stance === 'bear', d.keyPoints[1]);
  ok('a bull call that agrees with its news is left alone', d.tickers[1].stance === 'bull');

  // The live 2026-11-12 card: the CEO story carried 17 additional tickers
  // because the article body ran through the whole market.
  const wlSet = new Set(WL);
  const ceoEv = { candidateTickers: ['NVDA','AAPL','AMD','MRVL','CRDO','TSLA','SPCX','GOOGL','MSFT','AMZN','SKHY','INTC','MU','BABA','SNDK','WDC','WMT','TSM'],
    sources: [{ headline: "Nvidia's board explores replacing CEO Jensen Huang, report says" }] };
  const addl = W.mergeAddlTickers([], ceoEv, 'NVDA', wlSet, "Nvidia's board is exploring a replacement for CEO Jensen Huang; traders rotate into AMD.");
  ok('a story keeps only the names it states', addl.join() === 'AMD', addl);
  const addl2 = W.mergeAddlTickers(['TSM', 'MU', 'WDC', 'SNDK'], ceoEv, 'NVDA', wlSet, "Nvidia's board explores replacing its CEO; AMD gains.");
  ok('model-only names are capped while the list is short', addl2[0] === 'AMD' && addl2.length === 3, addl2);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
