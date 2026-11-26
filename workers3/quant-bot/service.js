// Cloudflare entrypoint. The HTTP API remains independently testable with Node.
import { WorkerEntrypoint } from 'cloudflare:workers';
import api from './worker.js';
import { inspectShard, runShadow } from './lib/shadow.js';
import { paperBroker } from './lib/alpaca.js';
import { loadVolume } from './lib/market.js';

export class CortexShard extends WorkerEntrypoint {
  inspect(symbols, strategies, now, session) {
    return inspectShard(this.env, symbols, strategies, now, session, {
      volumeOf: (symbol, date) => this.ctx.exports.CortexShard.volume(symbol, date),
    });
  }

  volume(symbol, date) {
    return loadVolume(paperBroker(this.env), [symbol], date, caches.default);
  }
}

export default {
  ...api,
  async scheduled(controller, env, ctx) {
    const outcome = await runShadow(env, controller.scheduledTime,
      (symbols, strategies, now, session) => ctx.exports.CortexShard.inspect(symbols, strategies, now, session));
    if (outcome.reason) console.warn('Neo Cortex:', outcome.reason);
  },
};
