// COPY of A1-Priv TradeHub/core/costs.js, made by A1-Priv tools/sync-core.mjs. Edit the original, then run it again.
// What a fill costs beyond the price: slippage and the regulatory fees Webull
// passes on (it charges no commission). Used by the setups backtester and the
// strategy simulator, so both count costs the same way. Pure.
//
// The fee rates are conservative constants (docs/TradeHub/quant-plan.md §0,
// Phase 6): the SEC's Section 31 fee on the value sold and FINRA's trading
// activity fee per share sold, capped per trade. Rates change by notice; when
// they do, change them here.

export const SLIPPAGE_CENTS = 1;          // a cent a share, each way
export const SEC_RATE = 27.80 / 1e6;      // dollars per dollar sold
export const TAF_PER_SHARE = 0.000166;    // dollars per share sold
export const TAF_MAX = 8.30;              // per trade

/** The regulatory fees on one fill: `SEC_RATE·value + min(TAF·shares, TAF_MAX)`
 *  on a sell, nothing on a buy. */
export function feesOf(side, shares, price) {
  if (side !== 'sell' || !(shares > 0) || !(price > 0)) return 0;
  return SEC_RATE * shares * price + Math.min(TAF_PER_SHARE * shares, TAF_MAX);
}

/** A round trip's cost per share, entry and exit together: slippage both ways
 *  plus the sell side's fees at `price` (the cap ignored: it binds only past
 *  50,000 shares). */
export function roundTripPerShare(price, { slippageCents = SLIPPAGE_CENTS, fees = 'webull' } = {}) {
  const slip = 2 * slippageCents / 100;
  return slip + (fees === 'webull' ? SEC_RATE * price + TAF_PER_SHARE : 0);
}

/** A round trip's cost in R: the cost per share over the risk per share. */
export function costInR(price, riskPerShare, costs) {
  return riskPerShare > 0 ? roundTripPerShare(price, costs) / riskPerShare : 0;
}
