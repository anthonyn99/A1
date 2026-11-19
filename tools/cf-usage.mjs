// Cloudflare Workers requests per worker, per day and per hour, for one account
// (GraphQL analytics). Written 2026-11-19, when account 2 ran out of its
// 100,000 free requests a day: this says which worker took them.
//
// Run: CF_TOKEN=… CF_ACCOUNT=… node tools/cf-usage.mjs [days]
//      (the "Cloudflare usage (account 2)" workflow runs it with the stored secrets)
const token = process.env.CF_TOKEN, acct = process.env.CF_ACCOUNT, days = Number(process.argv[2]) || 3;
if (!token || !acct) { console.error('CF_TOKEN and CF_ACCOUNT are needed'); process.exit(2); }
const q = (start, end, dims) => `{ viewer { accounts(filter:{accountTag:"${acct}"}) { workersInvocationsAdaptive(limit:2000, filter:{datetime_geq:"${start}", datetime_lt:"${end}"}) { sum { requests subrequests errors } dimensions { ${dims} } } } } }`;
async function run(query) {
  const r = await fetch('https://api.cloudflare.com/client/v4/graphql', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
  const j = await r.json();
  if (j.errors) { console.log('GraphQL refused:', JSON.stringify(j.errors).slice(0, 400)); process.exit(1); }
  return j.data.viewer.accounts[0].workersInvocationsAdaptive;
}
const now = new Date(), day = (d) => d.toISOString().slice(0, 10);
const rows = await run(q(day(new Date(now - days * 86400000)) + 'T00:00:00Z', now.toISOString(), 'scriptName date'));
const by = {};
for (const r of rows) { (by[r.dimensions.date] ||= {})[r.dimensions.scriptName] = (by[r.dimensions.date][r.dimensions.scriptName] || 0) + r.sum.requests; }
console.log('Requests per day (UTC), per worker:');
for (const d of Object.keys(by).sort()) {
  const t = Object.values(by[d]).reduce((a, b) => a + b, 0);
  console.log(`  ${d}  total ${t}  ` + Object.entries(by[d]).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '));
}
// Where the requests came in (Cloudflare's location: DEN = the Denver area, Tony's devices; IAD / ORD / … =
// cloud machines such as GitHub's runners) and how they ended, per worker, over the last two days.
{
  const rows2 = await run(q(day(new Date(now - 2 * 86400000)) + 'T00:00:00Z', now.toISOString(), 'scriptName coloCode status'));
  const g = {};
  for (const r of rows2) { const k = r.dimensions.scriptName; (g[k] ||= []).push([`${r.dimensions.coloCode}/${r.dimensions.status}`, r.sum.requests]); }
  console.log('\nBy location and outcome (last 2 days):');
  for (const [s, list] of Object.entries(g)) console.log(`  ${s}: ` + list.sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k} ${v}`).join(', '));
  const rows3 = await run(q(day(new Date(now - 86400000)) + 'T20:00:00Z', now.toISOString(), 'scriptName coloCode datetimeHour'));
  console.log('\nquant-api by hour and location:');
  const hh = {};
  for (const r of rows3) if (r.dimensions.scriptName === 'quant-api') (hh[r.dimensions.datetimeHour] ||= []).push(`${r.dimensions.coloCode} ${r.sum.requests}`);
  for (const k of Object.keys(hh).sort()) console.log('  ' + k.slice(5, 16) + '  ' + hh[k].join(', '));
}

// quant-api's own ledger (D1, read only): outside calls per provider per day, which says which routes ran.
if (process.env.D1_ID) {
  const sql = async (q) => {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/d1/database/${process.env.D1_ID}/query`, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ sql: q }) });
    const j = await r.json();
    return j.success ? j.result[0].results : 'refused: ' + JSON.stringify(j.errors).slice(0, 300);
  };
  const since = day(new Date(now - days * 86400000));
  const u = await sql(`SELECT day, service, n FROM usage WHERE day >= '${since}' ORDER BY day, n DESC`);
  console.log('\nquant-api ledger (outside calls per provider per day):');
  if (typeof u === 'string') console.log('  ' + u);
  else { const g = {}; for (const r of u) (g[r.day] ||= []).push(`${r.service} ${r.n}`); for (const d of Object.keys(g)) console.log(`  ${d}  ${g[d].join(', ')}`); }
  const h = await sql('SELECT provider, ok, status, fails, detail, at FROM provider_health ORDER BY at DESC LIMIT 25');
  console.log('\nquant-api provider health (last answers):');
  if (typeof h === 'string') console.log('  ' + h); else for (const r of h) console.log(`  ${r.provider} ok=${r.ok} status=${r.status} fails=${r.fails} at=${new Date(r.at).toISOString()} ${r.detail || ''}`);
  for (const t of ['history_turns', 'alert_fires', 'signals', 'wanted', 'memory_cards']) {
    const c = await sql(`SELECT COUNT(*) AS n FROM ${t}`);
    if (typeof c !== 'string') console.log(`  rows in ${t}: ${c[0].n}`);
  }
}

for (const d of [day(new Date(now - 86400000)), day(now)]) {
  const hrs = await run(q(d + 'T00:00:00Z', d === day(now) ? now.toISOString() : d + 'T23:59:59Z', 'scriptName datetimeHour'));
  const h = {};
  for (const r of hrs) { (h[r.dimensions.datetimeHour] ||= {})[r.dimensions.scriptName] = r.sum.requests; }
  console.log(`\nPer hour, ${d} (UTC):`);
  for (const k of Object.keys(h).sort()) console.log('  ' + k.slice(11, 16) + '  ' + Object.entries(h[k]).sort((a, b) => b[1] - a[1]).map(([s, v]) => `${s} ${v}`).join(', '));
}
