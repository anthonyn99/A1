// Exact KV usage history, straight from Cloudflare's GraphQL Analytics API.
//
// The dashboard only shows the CURRENT day, and sampling key expiries can only
// see short windows. This asks Cloudflare directly and gets per-day, per-
// operation-type, per-namespace counts — which is what actually settles "which
// limit am I hitting, and what is spending it".
//
// The token is read from the environment and is never printed, never written to
// a file, and must never be committed — this repo auto-commits every turn.
//
// Usage:
//   Git Bash:    CF_ANALYTICS_TOKEN=xxxx node workers/kv-usage.mjs [days]
//   PowerShell:  $env:CF_ANALYTICS_TOKEN="xxxx"; node workers/kv-usage.mjs 7
//
// Needs an API token with:  Account -> Account Analytics -> Read

const ACCOUNT = 'b9a33dd573c14d5f446516ea8b46285f';
const TOKEN = process.env.CF_ANALYTICS_TOKEN;
const DAYS = Number(process.argv[2] || 7);

if (!TOKEN) {
  console.error('CF_ANALYTICS_TOKEN is not set. See the header of this file.');
  process.exit(1);
}

// Free-tier daily caps, for the % column.
const CAPS = { read: 100000, write: 1000, delete: 1000, list: 1000 };

const end = new Date();
const start = new Date(end.getTime() - DAYS * 86400000);
const iso = (d) => d.toISOString().slice(0, 10);

const query = `
query KVUsage($acct: String!, $start: Date!, $end: Date!) {
  viewer {
    accounts(filter: { accountTag: $acct }) {
      kvOperationsAdaptiveGroups(
        filter: { date_geq: $start, date_leq: $end }
        limit: 10000
        orderBy: [date_ASC]
      ) {
        sum { requests }
        dimensions { date actionType namespaceId }
      }
    }
  }
}`;

const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query, variables: { acct: ACCOUNT, start: iso(start), end: iso(end) } }),
});

const body = await res.json().catch(() => null);
if (!body) { console.error('No JSON back (HTTP ' + res.status + ')'); process.exit(1); }
if (body.errors && body.errors.length) {
  console.error('GraphQL error:');
  body.errors.forEach(e => console.error('  ' + (e.message || JSON.stringify(e))));
  process.exit(1);
}

const groups = body?.data?.viewer?.accounts?.[0]?.kvOperationsAdaptiveGroups;
if (!groups) { console.error('Unexpected shape:\n' + JSON.stringify(body).slice(0, 600)); process.exit(1); }
if (!groups.length) { console.log('No KV activity in that range.'); process.exit(0); }

// name the namespaces we know, so the output is readable
const NS = {
  db15ea4183e84982baabf95bf974d933: 'FILES',
  dbfdf972572440bcaea7b53a34253921: 'INSIGHT_KV',
  '368086aa79d34d8383ef85bd1e4f597b': 'KEYCHAIN',
  '43e7af9882894b5b82f34bb9b6f88719': 'LINKS',
  dc67fb750dcc4858a8fcff9367b549e9: 'NEWSHUB_CACHE',
  '512ff8d9f3144c16966179105586768d': 'PV_CACHE',
  '74a9866ac7e944178287f647d76aaf26': 'TB_KV',
  '70fc5785592749d0ba5f49b9fe0f05b9': 'TB_KV_preview',
  '897dc1bcd93d4a55ab67836639d3866b': 'TD_KV',
  '66ed99d28b9541bd81c8d98c9a483e8c': 'TESLA_KV',
  b51e916cf3bf4f37ad146af5ca031575: 'TOKEN_CACHE',
  b70722a46ddb40d49906e2e4aedc7b4a: 'WX_CACHE',
};

// ── per day, per action ────────────────────────────────────────────────────
const byDay = {};
const byNs = {};
for (const g of groups) {
  const { date, actionType, namespaceId } = g.dimensions;
  const n = g.sum.requests;
  (byDay[date] ||= {})[actionType] = (byDay[date]?.[actionType] || 0) + n;
  const key = (NS[namespaceId] || namespaceId) + '|' + actionType;
  byNs[key] = (byNs[key] || 0) + n;
}

const ACTIONS = ['read', 'write', 'delete', 'list'];
console.log('KV operations per day  (free-tier caps: read 100k, write/delete/list 1k)\n');
console.log('date         ' + ACTIONS.map(a => a.padStart(9)).join('') + '     worst');
console.log('─'.repeat(66));
for (const date of Object.keys(byDay).sort()) {
  const row = byDay[date];
  let worst = '', worstPct = -1;
  for (const a of ACTIONS) {
    const pct = (row[a] || 0) / CAPS[a] * 100;
    if (pct > worstPct) { worstPct = pct; worst = a; }
  }
  const flag = worstPct >= 50 ? '  <-- ALERT' : '';
  console.log(date + '  ' + ACTIONS.map(a => String(row[a] || 0).padStart(9)).join('') +
    '   ' + worst + ' ' + worstPct.toFixed(0) + '%' + flag);
}

console.log('\nWhere it goes (whole range, top 15):');
console.log('─'.repeat(66));
Object.entries(byNs).sort((a, b) => b[1] - a[1]).slice(0, 15)
  .forEach(([k, v]) => {
    const [ns, act] = k.split('|');
    console.log('  ' + ns.padEnd(16) + act.padEnd(8) + String(v).padStart(10));
  });
