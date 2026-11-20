// Crypto in the worker (Refinements Batch 2, B1; A1-Priv docs/TradeHub/quant/r2-01.md).
// The twin of A1-Priv TradeHub/core/crypto.js: keep the two BASES lists the same.
//
// A crypto symbol is Webull's form, base + USD (BTCUSD), for a known coin. Hand-typed
// BTC-USD or BTC/USD mean the same coin. A crypto day runs on the UTC clock, all week.
import { nyMidnight } from './time.js';

export const BASES = new Set(['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'LINK', 'AVAX', 'SUI', 'USDC', 'USDT', 'ADA', 'DOT', 'LTC', 'BCH', 'SHIB', 'PEPE', 'UNI', 'AAVE', 'XLM', 'HBAR', 'TRX', 'TON', 'NEAR', 'APT', 'ARB', 'OP', 'POL', 'MATIC', 'ATOM', 'ETC', 'FIL', 'ICP', 'INJ', 'RENDER', 'SEI', 'TIA', 'WIF', 'BONK', 'XTZ', 'ALGO', 'GRT', 'CRV', 'LDO', 'SAND', 'MANA', 'AXS', 'FET', 'ONDO', 'JUP', 'PYTH', 'ENA', 'HYPE', 'KAS', 'XMR', 'MKR', 'COMP', 'SNX', 'YFI', 'BAT', 'ZEC', 'DASH', 'EOS', 'FLOW', 'IMX', 'STX', 'QNT', 'EGLD', 'CHZ', 'TRUMP']);
const H4 = 4 * 3600_000;

/** The coin of a crypto symbol ('BTCUSD', 'BTC-USD', 'BTC/USD' → 'BTC'), or null for anything else. */
export function baseOf(sym) {
  const s = String(sym || '').toUpperCase().trim();
  const m = /^([A-Z0-9]{2,10})[-/]?USD$/.exec(s);
  return m && BASES.has(m[1]) ? m[1] : null;
}
export const isCrypto = (sym) => !!baseOf(sym);
/** Webull's form: BTCUSD. */
export const canonical = (sym) => { const b = baseOf(sym); return b ? b + 'USD' : String(sym || '').toUpperCase(); };
export const coinbasePair = (sym) => baseOf(sym) + '-USD';
export const alpacaPair = (sym) => baseOf(sym) + '/USD';
/** A crypto daily bar's stamp: New York midnight of its UTC date (the stamp every daily bar here wears). */
export const cryptoDayStamp = (t) => nyMidnight(new Date(t).toISOString().slice(0, 10));
/** A crypto 4-hour bucket: 00, 04, 08, 12, 16, 20 UTC. */
export const cryptoFourHourKey = (t) => Math.floor(t / H4) * H4;
