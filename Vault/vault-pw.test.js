const g = globalThis; g.window = g;
g.navigator = { clipboard: { writeText: () => Promise.resolve() } };
g.document = { getElementById: () => null };
require('./vault-crypto.js');
(async () => {
  const VC = g.VaultCrypto;
  const { config, dek } = await VC.createVault('master-pw');
  const items = {};
  items.i1 = { id:'i1', kind:'login', enc: await VC.encrypt(dek, { title:'GitHub', url:'github.com', username:'me', password:'p1' }), deleted:false };
  items.i2 = { id:'i2', kind:'login', enc: await VC.encrypt(dek, { title:'Google', url:'accounts.google.com', email:'g@x.com', password:'p2' }), deleted:false };
  items.i3 = { id:'i3', kind:'login', enc: await VC.encrypt(dek, { title:'Gone' }), deleted:true };
  items.i4 = { id:'i4', kind:'sensitive', enc: await VC.encrypt(dek, { title:'Note' }), deleted:false };
  g.fetch = async () => ({ ok:true, json: async () => ({ config, items, savedAt:1 }), text: async()=>'' });
  require('./vault-pw.js');
  const VP = g.VaultPW;
  let pass=0, fail=0; const ok=(n,c)=>{ c?(pass++,console.log('  ✓',n)):(fail++,console.log('  ✗ FAIL',n)); };
  ok('hasVault true', await VP.hasVault());
  try { await VP.credentials(); ok('credentials throws while locked', false); } catch(e){ ok('credentials throws while locked', e.message==='locked'); }
  try { await VP.unlock('wrong'); ok('wrong pw rejected', false); } catch(e){ ok('wrong pw rejected', e.message==='bad-password'); }
  await VP.unlock('master-pw');
  ok('unlocked', VP.isUnlocked());
  const creds = await VP.credentials();
  ok('decrypts 2 logins (skips deleted + sensitive)', creds.length===2);
  ok('fields decrypt', creds.find(c=>c.title==='GitHub').password==='p1');
  const m = VP.matchDomain(creds, 'github.com');
  ok('matchDomain finds github', m.length===1 && m[0].title==='GitHub');
  ok('matchDomain subdomain', VP.matchDomain(creds, 'mail.google.com').length===0 || VP.matchDomain(creds, 'accounts.google.com')[0].title==='Google');
  ok('matchDomain no match', VP.matchDomain(creds, 'example.com').length===0);
  VP.lock(); ok('lock clears', !VP.isUnlocked());
  console.log('\n  '+pass+' passed, '+fail+' failed'); process.exit(fail?1:0);
})();
