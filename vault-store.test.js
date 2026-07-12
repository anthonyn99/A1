// Real verification of vault-store.js (uses vault-crypto.js + in-memory backend).
const VC = require('./vault-crypto.js');
const VaultStore = require('./vault-store.js');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ FAIL:', name); } }

(async () => {
  const { config, dek } = await VC.createVault('master-pw');

  console.log('\n── CRUD + encryption-at-rest ──');
  const backend = VaultStore.memoryBackend();
  await backend.saveConfig(config);
  const store = new VaultStore(backend, dek);
  await store.load();
  ok('starts empty', store.all().length === 0);

  const g1 = await store.save({ kind: 'login', title: 'GitHub', url: 'github.com', username: 'anthony', password: 'hunter2', category: 'Development', tags: ['work'] });
  await store.save({ kind: 'login', title: 'GitHub', url: 'github.com', username: 'work@corp.com', password: 'S3cret!', category: 'Development' });
  await store.save({ kind: 'login', title: 'Amazon', url: 'amazon.com', username: 'personal', password: 'a', category: 'Shopping' });
  await store.save({ kind: 'sensitive', title: 'Home safe code', notes: '12-34-56', category: 'Codes' });
  ok('4 items stored', store.all().length === 4);

  // Confirm what's actually persisted is ciphertext, not plaintext.
  const rawDocs = await backend.listItems();
  const rawStr = JSON.stringify(rawDocs);
  ok('backend stores NO plaintext password', !rawStr.includes('hunter2') && !rawStr.includes('S3cret!'));
  ok('backend stores NO plaintext username/notes', !rawStr.includes('anthony') && !rawStr.includes('12-34-56'));
  ok('backend keeps kind in plaintext (routing only)', rawStr.includes('login') && rawStr.includes('sensitive'));

  console.log('\n── kind filter + multiple logins per site ──');
  ok('2 sensitive/login split', store.byKind('login').length === 3 && store.byKind('sensitive').length === 1);
  const githubs = store.all().filter((i) => i.url === 'github.com');
  ok('two GitHub accounts under one site', githubs.length === 2);

  console.log('\n── fuzzy search ──');
  ok('"gh" fuzzy-matches GitHub', store.search('gh').some((i) => i.title === 'GitHub'));
  ok('search by username', store.search('work@corp').some((i) => i.username === 'work@corp.com'));
  ok('search by category', store.search('shopping').some((i) => i.title === 'Amazon'));
  ok('search by tag', store.search('work').some((i) => i.title === 'GitHub'));
  ok('nonsense returns nothing', store.search('zzzqqq').length === 0);

  console.log('\n── edit preserves createdAt, updates modifiedAt ──');
  const createdAt = store.get(g1.id).createdAt;
  await new Promise((r) => setTimeout(r, 5));
  const edited = await store.save({ ...store.get(g1.id), password: 'newpass' });
  ok('createdAt preserved on edit', edited.createdAt === createdAt);
  ok('modifiedAt advanced', edited.modifiedAt > createdAt);
  ok('password updated', edited.password === 'newpass');

  console.log('\n── delete tombstones + propagate ──');
  await store.remove(g1.id);
  ok('item gone from list', !store.get(g1.id));
  const tomb = (await backend.listItems()).find((d) => d.id === g1.id);
  ok('tombstone persisted (deleted:true, no ciphertext)', tomb.deleted === true && !tomb.enc);

  console.log('\n── second device sees the same encrypted data ──');
  const store2 = new VaultStore(backend, dek);
  await store2.load();
  ok('device 2 decrypts 3 live items', store2.all().length === 3);
  ok('device 2 does NOT see deleted item', !store2.get(g1.id));

  console.log('\n── live sync + last-write-wins conflict ──');
  let liveCount = -1;
  const s3backend = VaultStore.memoryBackend();
  const A = new VaultStore(s3backend, dek); await A.load();
  const B = new VaultStore(s3backend, dek); await B.load();
  A.startLive((list) => { liveCount = list.length; });
  const made = await B.save({ kind: 'login', title: 'Live', username: 'x', password: 'y' });
  await new Promise((r) => setTimeout(r, 30)); // let A's async decrypt-on-ingest settle
  ok('device A got live push from device B', liveCount === 1 && A.get(made.id));

  // Concurrent edit: newer updatedAt must win regardless of ingest order.
  // (Timestamps must be newer than the just-saved item's real Date.now().)
  const base = made.updatedAt + 1000;
  const older = { id: made.id, kind: 'login', enc: await VC.encrypt(dek, { title: 'OLD', modifiedAt: 1 }), updatedAt: base + 100, deleted: false };
  const newer = { id: made.id, kind: 'login', enc: await VC.encrypt(dek, { title: 'NEW', modifiedAt: 2 }), updatedAt: base + 200, deleted: false };
  await A._ingest(newer); await A._ingest(older); // deliver out of order
  ok('last-write-wins: newer update kept despite out-of-order delivery', A.get(made.id).title === 'NEW');

  console.log('\n── wrong key cannot decrypt (graceful) ──');
  const { dek: otherDek } = await VC.createVault('someone-else');
  const intruder = new VaultStore(backend, otherDek);
  await intruder.load();
  ok('intruder with wrong DEK decrypts nothing', intruder.all().length === 0);

  console.log(`\n${'═'.repeat(40)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(40)}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
