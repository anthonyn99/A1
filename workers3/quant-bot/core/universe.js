// COPY of A1-Priv TradeHub/core/universe.js, made by A1-Priv tools/sync-core.mjs. Edit the original, then run it again.
// The symbols the market snapshot is built from: the indexes, the sector
// funds, the breadth members and each stock's sector. One list for the
// scheduled runner and the page, so both build the same snapshot.

export const INDEX = 'SPY', VIX = '^VIX';
export const INDEXES = ['SPY', 'QQQ', 'IWM', 'DIA'];

// The 11 SPDR sector funds plus SOXX (semiconductors), in the order shown.
export const SECTORS = [
  { sym: 'XLK', name: 'Technology' },
  { sym: 'SOXX', name: 'Semiconductors' },
  { sym: 'XLC', name: 'Communication' },
  { sym: 'XLY', name: 'Consumer Discretionary' },
  { sym: 'XLF', name: 'Financials' },
  { sym: 'XLI', name: 'Industrials' },
  { sym: 'XLV', name: 'Health Care' },
  { sym: 'XLE', name: 'Energy' },
  { sym: 'XLB', name: 'Materials' },
  { sym: 'XLP', name: 'Consumer Staples' },
  { sym: 'XLU', name: 'Utilities' },
  { sym: 'XLRE', name: 'Real Estate' },
];

// Each stock's sector fund. The first 100 or so are the S&P 100, which is
// also the breadth list; the rest are names often on a watchlist. A stock
// that is not here has no sector until the ticker dossier (Phase 7) knows it.
const BY_SECTOR = {
  XLK: 'AAPL MSFT ORCL CRM ADBE CSCO ACN IBM INTU NOW PLTR PANW CRWD SNOW SHOP NET DDOG MSTR APP DELL HPQ ANET SMCI ZS OKTA TEAM WDAY U PATH IONQ RGTI QBTS SNDK WDC STX',
  SOXX: 'NVDA AVGO AMD QCOM TXN INTC MU AMAT LRCX KLAC ADI MRVL TSM ASML ARM ON NXPI MCHP MPWR CRDO ALAB',
  XLC: 'GOOGL GOOG META NFLX DIS CMCSA T VZ TMUS CHTR EA TTWO RBLX SPOT PINS SNAP RDDT WBD',
  XLY: 'AMZN TSLA HD MCD NKE LOW SBUX BKNG GM F ABNB UBER LYFT DASH CMG LULU RIVN LCID NIO ROKU ETSY EBAY MAR DKNG CVNA BABA PDD',
  XLF: 'BRK.B JPM V MA BAC WFC GS MS C AXP BLK SCHW USB PYPL COF BNY MET AIG SPGI COIN HOOD SOFI XYZ AFRM',
  XLI: 'GE CAT RTX HON UNP BA UPS DE LMT GD FDX EMR MMM NOC ETN WM CSX DAL UAL AAL RKLB BE GEV',
  XLV: 'LLY UNH JNJ ABBV MRK TMO ABT AMGN PFE DHR GILD BMY MDT CVS ISRG VRTX REGN MRNA HIMS',
  XLE: 'XOM CVX COP SLB EOG OXY MPC PSX VLO KMI',
  XLB: 'LIN SHW FCX NEM APD DOW DD NUE SCCO ERO',
  XLP: 'WMT PG COST KO PEP PM MO MDLZ CL KHC TGT',
  XLU: 'NEE SO DUK CEG VST AEP D',
  XLRE: 'AMT PLD EQIX SPG O CCI',
};
/** Each stock's sector fund: symbol → ETF (the first list a symbol is in wins). */
export const SECTOR_OF = (() => {
  const out = {};
  for (const [etf, list] of Object.entries(BY_SECTOR)) for (const s of list.split(' ')) if (!out[s]) out[s] = etf;
  return out;
})();

// Breadth is measured on the S&P 100: large enough to say whether the market
// is taking part, small enough to rebuild in the browser when the runner has
// not run. The Market tab names it, so the number is never read as "the S&P 500".
export const BREADTH_NAME = 'S&P 100';
/** The S&P 100 members (BK is now BNY). */
export const BREADTH = ('AAPL ABBV ABT ACN ADBE AIG AMD AMGN AMT AMZN AVGO AXP BA BAC BNY BKNG BLK BMY BRK.B C CAT CHTR CL CMCSA COF COP COST CRM CSCO CVS CVX '
  + 'DE DHR DIS DUK EMR FDX GD GE GILD GM GOOG GOOGL GS HD HON IBM INTC INTU ISRG JNJ JPM KO LIN LLY LMT LOW MA MCD MDLZ MDT MET META MMM MO MRK MS MSFT '
  + 'NEE NFLX NKE NOW NVDA ORCL PEP PFE PG PLTR PM PYPL QCOM RTX SBUX SCHW SO SPG T TGT TMO TMUS TSLA TXN UNH UNP UPS USB V VZ WFC WMT XOM').split(' ');

// Calendar days of daily history a snapshot is built from: enough for the
// 200-day average, the 252-day highs and a few hundred days to compare today with.
export const HISTORY_DAYS = 1100;

/** Every symbol a snapshot needs for `watchlist`, without repeats. */
export function universe(watchlist = []) {
  return [...new Set([INDEX, VIX, ...INDEXES, ...SECTORS.map((s) => s.sym), ...BREADTH, ...watchlist.map((s) => String(s).toUpperCase())])];
}

/** The lists buildSnapshot takes, for `watchlist`. */
export function snapshotLists(watchlist = []) {
  return { index: INDEX, vix: VIX, indexes: INDEXES, sectors: SECTORS, breadth: BREADTH, watchlist: watchlist.map((s) => String(s).toUpperCase()) };
}
