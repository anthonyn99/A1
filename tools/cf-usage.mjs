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
for (const d of [day(new Date(now - 86400000)), day(now)]) {
  const hrs = await run(q(d + 'T00:00:00Z', d === day(now) ? now.toISOString() : d + 'T23:59:59Z', 'scriptName datetimeHour'));
  const h = {};
  for (const r of hrs) { (h[r.dimensions.datetimeHour] ||= {})[r.dimensions.scriptName] = r.sum.requests; }
  console.log(`\nPer hour, ${d} (UTC):`);
  for (const k of Object.keys(h).sort()) console.log('  ' + k.slice(11, 16) + '  ' + Object.entries(h[k]).sort((a, b) => b[1] - a[1]).map(([s, v]) => `${s} ${v}`).join(', '));
}
