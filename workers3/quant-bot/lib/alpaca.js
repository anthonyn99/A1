// The bot uses a dedicated Alpaca account on the paper host, and IEX equity data.
export const ALPACA_PAPER = 'https://paper-api.alpaca.markets';
export const ALPACA_DATA = 'https://data.alpaca.markets';
export const BROKER_TF = { '5m': '5Min', '15m': '15Min', '1h': '1Hour', '1d': '1Day' };
const SYMBOL = /^[A-Z][A-Z0-9.-]{0,9}$/;

export class AlpacaError extends Error {
  constructor(status, detail) {
    super('Alpaca ' + status + (detail ? ': ' + detail : ''));
    this.status = status;
  }
}

export function paperBroker(env, fetchFn = fetch) {
  if (!env.BOT_ALPACA_KEY || !env.BOT_ALPACA_SECRET) throw new Error('The dedicated Alpaca paper account is not configured');
  const headers = {
    'APCA-API-KEY-ID': env.BOT_ALPACA_KEY,
    'APCA-API-SECRET-KEY': env.BOT_ALPACA_SECRET,
    'content-type': 'application/json',
  };
  async function send(base, path, { method = 'GET', body: input } = {}) {
    const response = await fetchFn(base + path, { method, headers, redirect: 'error', signal: AbortSignal.timeout(8000),
      ...(input ? { body: JSON.stringify(input) } : {}) });
    if (response.status === 204) return [];
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new AlpacaError(response.status, typeof body?.message === 'string' ? body.message.slice(0, 180) : '');
    if (body == null) throw new Error('Alpaca returned no JSON for ' + path.split('?')[0]);
    return body;
  }

  return {
    clock: () => send(ALPACA_PAPER, '/v2/clock'),
    calendar: (day) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Invalid market day');
      return send(ALPACA_PAPER, '/v2/calendar?start=' + day + '&end=' + day);
    },
    account: () => send(ALPACA_PAPER, '/v2/account'),
    positions: () => send(ALPACA_PAPER, '/v2/positions'),
    orders: () => send(ALPACA_PAPER, '/v2/orders?status=open&nested=true&limit=500'),
    cancelAll: () => send(ALPACA_PAPER, '/v2/orders', { method: 'DELETE' }),
    closeAll: () => send(ALPACA_PAPER, '/v2/positions?cancel_orders=true', { method: 'DELETE' }),
    fills: (after) => {
      const q = new URLSearchParams({ after: new Date(after).toISOString(), direction: 'asc', page_size: '100' });
      return send(ALPACA_PAPER, '/v2/account/activities/FILL?' + q);
    },
    asset: (symbol) => {
      if (!SYMBOL.test(symbol)) throw new Error('Invalid asset symbol');
      return send(ALPACA_PAPER, '/v2/assets/' + encodeURIComponent(symbol));
    },
    async bars(symbols, tf, start, end) {
      if (!symbols.length || symbols.length > 40 || symbols.some((symbol) => !SYMBOL.test(symbol)) || !Object.hasOwn(BROKER_TF, tf) || start >= end) throw new Error('Invalid bars request');
      const q = new URLSearchParams({
        symbols: symbols.join(','), timeframe: BROKER_TF[tf], start: new Date(start).toISOString(), end: new Date(end).toISOString(),
        feed: 'iex', adjustment: 'split', limit: '10000',
      });
      const bars = Object.fromEntries(symbols.map((symbol) => [symbol, []]));
      for (let page = 0; page < 16; page++) {
        const body = await send(ALPACA_DATA, '/v2/stocks/bars?' + q);
        for (const symbol of symbols) {
          for (const row of body.bars?.[symbol] || []) {
            const t = Date.parse(row.t);
            if ([t, row.o, row.h, row.l, row.c, row.v].every(Number.isFinite)) bars[symbol].push([t, row.o, row.h, row.l, row.c, row.v]);
          }
        }
        if (!body.next_page_token) return bars;
        q.set('page_token', body.next_page_token);
      }
      throw new Error('Alpaca history exceeded the page limit');
    },
  };
}
