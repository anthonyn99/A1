// Node verification for vault-apikey.js (and its integration with the store's
// search + the shared crypto). Run: node Vault/vault-apikey.test.js
'use strict';
const assert = require('assert');
const AK = require('./vault-apikey.js');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + (e && e.message)); }
}

(async () => {
  console.log('\nvault-apikey.js');

  // ── provider detection ──
  await t('detects Anthropic before OpenAI (both start with sk-)', () => {
    assert.strictEqual(AK.detectProvider('sk-ant-api03-' + 'x'.repeat(40)).id, 'anthropic');
    assert.strictEqual(AK.detectProvider('sk-proj-' + 'A'.repeat(40)).id, 'openai');
    assert.strictEqual(AK.detectProvider('sk-or-v1-' + 'a'.repeat(40)).id, 'openrouter');
  });
  await t('detects common formats', () => {
    const cases = {
      github: 'ghp_' + 'a'.repeat(36), gitlab: 'glpat-' + 'a'.repeat(20), google: 'AIza' + 'B'.repeat(35),
      aws: 'AKIAIOSFODNN7EXAMPLE', stripe: 'sk_live_' + 'a'.repeat(24), slack: 'xoxb-123-456-abc',
      huggingface: 'hf_' + 'a'.repeat(30), brevo: 'xkeysib-' + 'a'.repeat(40), riot: 'RGAPI-1234-5678',
      groq: 'gsk_' + 'a'.repeat(40), xai: 'xai-' + 'a'.repeat(40),
    };
    Object.keys(cases).forEach((id) => assert.strictEqual((AK.detectProvider(cases[id]) || {}).id, id, id));
  });
  await t('unknown / empty keys detect nothing', () => {
    assert.strictEqual(AK.detectProvider(''), null);
    assert.strictEqual(AK.detectProvider('just-some-token'), null);
  });
  await t('typed provider name wins over detection, and matches loosely', () => {
    assert.strictEqual(AK.providerOf({ provider: 'gemini', key: 'sk-proj-' + 'a'.repeat(30) }).id, 'google');
    assert.strictEqual(AK.providerOf({ provider: 'Cloudflare' }).id, 'cloudflare');
    const c = AK.providerOf({ provider: 'My Internal API' });
    assert.strictEqual(c.id, 'custom'); assert.strictEqual(c.label, 'My Internal API');
    assert.ok(/^#[0-9a-f]{6}$/i.test(c.color));
  });
  await t('providerMark escapes the label', () => {
    const svg = AK.providerMark({ label: '<img onerror=x>', color: '"red' });
    assert.ok(!/<img/.test(svg)); assert.ok(!/fill=""red/.test(svg));
  });

  // ── masking ──
  await t('mask keeps a recognisable prefix and last 4', () => {
    const k = 'sk-ant-api03-' + 'x'.repeat(30) + 'WXYZ';
    const m = AK.maskKey(k);
    assert.ok(m.startsWith('sk-ant-'), m); assert.ok(m.endsWith('WXYZ'), m);
    assert.ok(m.indexOf('xxx') < 0, 'body leaked: ' + m);
  });
  await t('mask never reveals more than a third of a key', () => {
    ['AKIAIOSFODNN7EXAMPLE', 'abcdefghijkl', 'ghp_' + 'a'.repeat(36), 'short1'].forEach((k) => {
      const shown = AK.maskKey(k).replace(/•/g, '').length;
      assert.ok(shown <= Math.floor(k.length / 3), k + ' → ' + AK.maskKey(k));
    });
    assert.strictEqual(AK.maskKey('tiny'), '••••••••');
    assert.strictEqual(AK.maskKey(''), '');
  });

  // ── dates / expiry ──
  const NOW = new Date(2026, 8, 24, 12).getTime(); // 2026-09-24 noon local
  await t('expiry states', () => {
    assert.strictEqual(AK.expiryStatus('', NOW).state, 'none');
    assert.strictEqual(AK.expiryStatus('2026-09-23', NOW).state, 'expired');
    assert.strictEqual(AK.expiryStatus('2026-09-24', NOW).state, 'expiring'); // works until end of today
    assert.strictEqual(AK.expiryStatus('2026-09-24', NOW).label, 'Expires today');
    assert.strictEqual(AK.expiryStatus('2026-10-10', NOW).state, 'expiring');
    assert.strictEqual(AK.expiryStatus('2027-06-01', NOW).state, 'valid');
  });
  await t('normalizeDate', () => {
    assert.strictEqual(AK.normalizeDate('2026-3-7'), '2026-03-07');
    assert.strictEqual(AK.normalizeDate('nonsense'), '');
  });

  // ── env ──
  await t('env names: explicit, provider default, derived', () => {
    assert.strictEqual(AK.envName({ envVar: 'my key' }), 'MY_KEY');
    assert.strictEqual(AK.envName({ key: 'sk-ant-' + 'a'.repeat(30) }), 'ANTHROPIC_API_KEY');
    assert.strictEqual(AK.envName({ provider: 'Acme Billing' }), 'ACME_BILLING_API_KEY');
    assert.strictEqual(AK.envName({ title: '9lives token' }), '_9LIVES_TOKEN');
  });
  await t('env line quotes only when needed', () => {
    assert.strictEqual(AK.envLine({ envVar: 'A', key: 'abc-123' }), 'A=abc-123');
    assert.strictEqual(AK.envLine({ envVar: 'A', key: 'a b"c' }), 'A="a b\\"c"');
  });
  await t('env block includes secret with the provider secret name', () => {
    const b = AK.envBlock({ provider: 'AWS', key: 'AKIAIOSFODNN7EXAMPLE', secret: 'wJalr/XUtnFEMI' });
    assert.ok(/^AWS_ACCESS_KEY_ID=AKIA/m.test(b), b);
    assert.ok(/^AWS_SECRET_ACCESS_KEY=wJalr\/XUtnFEMI$/m.test(b), b);
  });
  await t('parseDotEnv handles export, comments and quotes', () => {
    const r = AK.parseDotEnv('# c\nexport A=1\nB="x y\\n" # trailing\nC=\'lit #\'\nD=plain # note\n\nbad line');
    assert.deepStrictEqual(r, [
      { name: 'A', value: '1' }, { name: 'B', value: 'x y\n' }, { name: 'C', value: 'lit #' }, { name: 'D', value: 'plain' },
    ]);
  });
  await t('fromDotEnv keeps credentials only', () => {
    const items = AK.fromDotEnv('PORT=3000\nOPENAI_API_KEY=sk-proj-' + 'a'.repeat(30) + '\nDEBUG=true\nSTRIPE_SECRET=abc\nMYSTERY=ghp_' + 'z'.repeat(36));
    assert.strictEqual(items.length, 3);
    assert.strictEqual(items[0].provider, 'OpenAI');
    assert.strictEqual(items[0].envVar, 'OPENAI_API_KEY');
    assert.strictEqual(items[1].keyType, 'secret_key');
    assert.strictEqual(items[2].provider, 'GitHub');
    items.forEach((i) => assert.strictEqual(i.kind, 'apikey'));
  });

  // ── normalize / validate / rotation ──
  await t('normalize trims secrets, keeps notes, fills title', () => {
    const n = AK.normalize({ key: '  sk-ant-' + 'a'.repeat(30) + '\n', notes: '  line1\n  line2\n\n', tags: 'a, b,,', endpoint: 'api.example.com/v1', envVar: 'x-y' });
    assert.strictEqual(n.key, 'sk-ant-' + 'a'.repeat(30));
    assert.strictEqual(n.notes, '  line1\n  line2');
    assert.strictEqual(n.title, 'Anthropic');
    assert.deepStrictEqual(n.tags, ['a', 'b']);
    assert.strictEqual(n.endpoint, 'https://api.example.com/v1');
    assert.strictEqual(n.envVar, 'X_Y');
    assert.strictEqual(n.kind, 'apikey');
  });
  await t('normalize keeps hidden custom fields and drops empties', () => {
    const n = AK.normalize({ title: 'x', customFields: [{ label: 'Pin', value: '1234', hidden: true }, { label: '', value: ' ' }, { label: 'Org', value: 'acme' }] });
    assert.deepStrictEqual(n.customFields, [{ label: 'Pin', value: '1234', hidden: true }, { label: 'Org', value: 'acme' }]);
  });
  await t('validate: needs name or key; flags bad dates', () => {
    assert.strictEqual(AK.validate({}).ok, false);
    assert.strictEqual(AK.validate({ key: 'abc' }).ok, true);
    assert.strictEqual(AK.validate({ title: 'x', expiresAt: 'soon' }).ok, false);
    assert.ok(AK.validate({ title: 'x', expiresAt: '2020-01-01' }).warnings.length);
    assert.ok(AK.validate({ title: 'x', key: 'ab cd' }).warnings.length);
  });
  await t('rotation keeps the old key, newest first, capped', () => {
    let prev = { key: 'k0', createdAt: 1 };
    for (let i = 1; i <= 7; i++) prev = AK.withRotation(prev, { key: 'k' + i }, 1000 + i);
    assert.strictEqual(prev.key, 'k7');
    assert.strictEqual(prev.keyHistory.length, AK.HISTORY_MAX);
    assert.strictEqual(prev.keyHistory[0].key, 'k6');
    assert.strictEqual(prev.rotatedAt, 1007);
  });
  await t('rotation: unchanged key carries history + rotatedAt forward', () => {
    const prev = { key: 'k1', keyHistory: [{ key: 'k0', at: 5 }], rotatedAt: 9 };
    const next = AK.withRotation(prev, { key: 'k1', notes: 'edited' });
    assert.deepStrictEqual(next.keyHistory, prev.keyHistory);
    assert.strictEqual(next.rotatedAt, 9);
    assert.strictEqual(AK.withRotation(null, { key: 'new' }).keyHistory, undefined);
  });

  // ── summarize / sort / filter / match ──
  await t('summarize never exposes the raw key', () => {
    const it = { id: 'a', title: 'Prod', provider: 'OpenAI', environment: 'production', key: 'sk-proj-SECRETSECRETSECRETSECRET', secret: 'hush-hush-hush-hush' };
    const s = AK.summarize(it);
    assert.ok(JSON.stringify(s).indexOf('SECRETSECRETSECRET') < 0);
    assert.ok(JSON.stringify(s).indexOf('hush-hush-hush') < 0);
    assert.strictEqual(s.subtitle, 'OpenAI · Production');
    assert.strictEqual(s.hasSecret, true);
  });
  await t('sortKeys: manual order, then pinned, expired, alphabetical', () => {
    const list = [
      { id: 'z', title: 'Zed' }, { id: 'p', title: 'Pinned', favorite: true },
      { id: 'e', title: 'Old', expiresAt: '2020-01-01' }, { id: 'm1', title: 'M', order: 1 }, { id: 'm0', title: 'N', order: 0 },
    ];
    assert.deepStrictEqual(AK.sortKeys(list, NOW).map((i) => i.id), ['m0', 'm1', 'p', 'e', 'z']);
  });
  await t('reorderPlan writes only moved items; nextTopOrder', () => {
    const items = [{ id: 'a', order: 0 }, { id: 'b', order: 1 }, { id: 'c' }];
    assert.deepStrictEqual(AK.reorderPlan(['b', 'a', 'c'], items), [{ id: 'b', order: 0 }, { id: 'a', order: 1 }, { id: 'c', order: 2 }]);
    assert.strictEqual(AK.nextTopOrder(items), -1);
    assert.strictEqual(AK.nextTopOrder([{ id: 'x' }]), undefined);
  });
  await t('filterKeys never matches on the key or secret', () => {
    const items = [{ title: 'Billing', provider: 'Stripe', key: 'sk_live_TOPSECRET', secret: 'whsec_HIDDEN', environment: 'production' }];
    assert.strictEqual(AK.filterKeys(items, 'stripe').length, 1);
    assert.strictEqual(AK.filterKeys(items, 'production').length, 1);
    assert.strictEqual(AK.filterKeys(items, 'TOPSECRET').length, 0);
    assert.strictEqual(AK.filterKeys(items, 'HIDDEN').length, 0);
  });
  await t('matchHost uses console/endpoint URLs and provider domains', () => {
    const items = [
      { id: 1, provider: 'Anthropic' }, { id: 2, title: 'x', consoleUrl: 'https://dash.example.com/keys' }, { id: 3, title: 'y' },
    ];
    assert.deepStrictEqual(AK.matchHost(items, 'console.anthropic.com').map((i) => i.id), [1]);
    assert.deepStrictEqual(AK.matchHost(items, 'dash.example.com').map((i) => i.id), [2]);
    assert.deepStrictEqual(AK.matchHost(items, ''), []);
  });
  await t('safeHref refuses non-web schemes', () => {
    assert.strictEqual(AK.safeHref('javascript:alert(1)'), '');
    assert.strictEqual(AK.safeHref('example.com'), 'https://example.com');
  });

  // ── integration: store search + encryption round-trip ──
  await t('store search finds API keys by provider / env var, never by key or hidden field', async () => {
    const VC = require('./vault-crypto.js');
    const VaultStore = require('./vault-store.js');
    const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const backend = VaultStore.memoryBackend();
    const store = new VaultStore(backend, dek);
    const saved = await store.save(AK.normalize({ provider: 'Anthropic', key: 'sk-ant-SUPERSECRETVALUE123', envVar: 'CLAUDE_KEY', customFields: [{ label: 'Recovery', value: 'HIDDENVALUE', hidden: true }] }));
    assert.strictEqual(saved.kind, 'apikey');
    const raw = JSON.stringify([...backend._raw.values()]);
    assert.ok(raw.indexOf('SUPERSECRET') < 0 && raw.indexOf('Anthropic') < 0, 'plaintext reached the backend');
    assert.strictEqual(store.search('anthropic').length, 1);
    assert.strictEqual(store.search('claude_key').length, 1);
    assert.strictEqual(store.search('SUPERSECRET').length, 0);
    assert.strictEqual(store.search('HIDDENVALUE').length, 0);
    assert.ok(VC);
  });

  console.log('\n  ' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})();
