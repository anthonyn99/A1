// Real verification of warden-pay.js (pure logic) PLUS an end-to-end check that
// payment items ride the EXISTING warden-crypto/warden-store pipeline with every
// sensitive field encrypted at rest.
//
//   node warden-pay.test.js
const VP = require('./warden-pay.js');
const VC = require('./warden-crypto.js');
const WardenStore = require('./warden-store.js');

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗ FAIL:', n)); };

// Well-known test numbers (issuer-published, not real accounts).
const VISA = '4111111111111111';
const MC = '5555555555554444';
const AMEX = '378282246310005';
const DISC = '6011111111111117';

(async () => {
  console.log('\n── network detection ──');
  ok('Visa', VP.detectNetwork(VISA).id === 'visa');
  ok('Mastercard', VP.detectNetwork(MC).id === 'mastercard');
  ok('Mastercard 2-series', VP.detectNetwork('2223003122003222').id === 'mastercard');
  ok('Amex', VP.detectNetwork(AMEX).id === 'amex');
  ok('Discover', VP.detectNetwork(DISC).id === 'discover');
  ok('Discover 622126 beats UnionPay 62', VP.detectNetwork('6221261111111111').id === 'discover');
  ok('UnionPay outside Discover range', VP.detectNetwork('6250941006528599').id === 'unionpay');
  ok('Diners', VP.detectNetwork('30569309025904').id === 'diners');
  ok('JCB', VP.detectNetwork('3530111333300000').id === 'jcb');
  ok('unknown never null', VP.detectNetwork('9999').id === 'unknown');
  ok('empty is unknown', VP.detectNetwork('').id === 'unknown');
  ok('detection ignores spaces', VP.detectNetwork('4111 1111 1111 1111').id === 'visa');
  ok('Amex CVV is 4', VP.cvvLength({ number: AMEX }) === 4);
  ok('Visa CVV is 3', VP.cvvLength({ number: VISA }) === 3);

  console.log('\n── luhn ──');
  ok('valid Visa passes', VP.luhn(VISA));
  ok('valid Amex passes', VP.luhn(AMEX));
  ok('typo fails', !VP.luhn('4111111111111112'));
  ok('too short fails', !VP.luhn('4111'));

  console.log('\n── formatting + masking ──');
  ok('Visa groups 4-4-4-4', VP.formatNumber(VISA) === '4111 1111 1111 1111');
  ok('Amex groups 4-6-5', VP.formatNumber(AMEX) === '3782 822463 10005');
  ok('mask keeps last 4', VP.maskNumber(VISA) === '•••• •••• •••• 1111');
  ok('mask hides everything else', VP.maskNumber(VISA).replace(/[•\s]/g, '') === '1111');
  ok('Amex mask keeps grouping', VP.maskNumber(AMEX) === '•••• •••••• •0005');
  ok('last4', VP.last4(VISA) === '1111');
  ok('short number is not over-masked', VP.maskNumber('123') === '123');
  ok('shortMask is safe text', VP.shortMask({ number: VISA }) === 'Visa •• 1111');

  console.log('\n── expiry ──');
  ok('padMonth 4 → 04', VP.padMonth(4) === '04');
  ok('padMonth rejects 13', VP.padMonth(13) === '');
  ok('fullYear 29 → 2029', VP.fullYear('29') === '2029');
  ok('fullYear 2029 stays', VP.fullYear('2029') === '2029');
  ok('shortYear', VP.shortYear('2029') === '29');
  ok('label', VP.expiryLabel(4, '2029') === '04/29');
  ok('parse 04/29', JSON.stringify(VP.parseExpiry('04/29')) === '{"month":"04","year":"2029"}');
  ok('parse 2029-04', JSON.stringify(VP.parseExpiry('2029-04')) === '{"month":"04","year":"2029"}');
  ok('parse 4-2029', JSON.stringify(VP.parseExpiry('4-2029')) === '{"month":"04","year":"2029"}');
  ok('parse 0429', JSON.stringify(VP.parseExpiry('0429')) === '{"month":"04","year":"2029"}');
  ok('parse junk', VP.parseExpiry('nope').month === '');

  // Card is valid through the LAST day of the expiry month.
  const inMonth = new Date(2029, 3, 30).getTime();   // Apr 30 2029
  const nextMonth = new Date(2029, 4, 1).getTime();  // May 1 2029
  ok('valid on the last day of the expiry month', VP.expiryStatus('04', '2029', inMonth).state !== 'expired');
  ok('expired the day after', VP.expiryStatus('04', '2029', nextMonth).state === 'expired');
  ok('expiring soon flagged', VP.expiryStatus('04', '2029', new Date(2029, 2, 15).getTime()).state === 'expiring');
  ok('far future is valid', VP.expiryStatus('04', '2029', new Date(2027, 0, 1).getTime()).state === 'valid');
  ok('missing expiry is unknown', VP.expiryStatus('', '', Date.now()).state === 'unknown');

  console.log('\n── address ──');
  const addr = { line1: '1 Main St', line2: 'Apt 4', city: 'Austin', region: 'TX', postal: '78701', country: 'USA' };
  ok('one-line format', VP.formatAddress(addr) === '1 Main St, Apt 4, Austin, TX 78701, USA');
  ok('hasAddress true', VP.hasAddress(addr));
  ok('hasAddress false on empty', !VP.hasAddress(VP.emptyAddress()));
  ok('partial address formats cleanly', VP.formatAddress({ city: 'Austin', postal: '78701' }) === 'Austin 78701');

  console.log('\n── normalize ──');
  const norm = VP.normalize({ number: '4111 1111-1111 1111', expMonth: '4', expYear: '29', cvv: '12a3', nickname: '  Chase  ', billing: addr });
  ok('kind is payment', norm.kind === 'payment');
  ok('method defaults to card', norm.method === 'card');
  ok('number digits-only', norm.number === VISA);
  ok('network derived', norm.network === 'visa');
  ok('last4 derived', norm.last4 === '1111');
  ok('expiry normalised', norm.expMonth === '04' && norm.expYear === '2029');
  ok('cvv digits-only', norm.cvv === '123');
  ok('nickname trimmed', norm.nickname === 'Chase');
  ok('billing normalised', norm.billing.city === 'Austin');
  ok('explicit network survives a missing number', VP.normalize({ network: 'amex' }).network === 'amex');

  console.log('\n── summarize hides secrets ──');
  const item = VP.normalize({ nickname: 'Travel', cardholder: 'A Nguyen', number: AMEX, expMonth: '11', expYear: '2030', cvv: '1234', billing: addr });
  const s = VP.summarize(item, new Date(2026, 0, 1).getTime());
  const sJson = JSON.stringify(s);
  ok('no full PAN in summary', sJson.indexOf(AMEX) < 0);
  ok('no CVV in summary', sJson.indexOf('1234') < 0 || !/"cvv"/.test(sJson));
  ok('summary has no cvv field at all', s.cvv === undefined);
  ok('last4 present', s.last4 === '0005');
  ok('hasCvv flag without the value', s.hasCvv === true);
  ok('title uses nickname', s.title === 'Travel');
  ok('network label', s.networkLabel === 'American Express');
  ok('masked string exposes only last 4', s.masked.replace(/[•\s]/g, '') === '0005');

  console.log('\n── validate ──');
  ok('good card is ok', VP.validate({ number: VISA, cardholder: 'A', expMonth: '04', expYear: '2099', cvv: '123' }).ok);
  ok('bad checksum errors', !VP.validate({ number: '4111111111111112' }).ok);
  ok('short number errors', !VP.validate({ number: '411111' }).ok);
  ok('month 13 errors', !VP.validate({ number: VISA, expMonth: '13' }).ok);
  ok('wrong CVV length warns (not an error)', (() => { const v = VP.validate({ number: VISA, cardholder: 'A', cvv: '1234' }); return v.ok && v.warnings.length > 0; })());
  ok('no number is a warning, not an error', VP.validate({ cardholder: 'A' }).ok);

  console.log('\n── autofill values ──');
  const noCvv = VP.autofillValues(item);
  ok('CVV withheld by default', noCvv.cvv === '');
  ok('CVV included only when asked', VP.autofillValues(item, { includeCvv: true }).cvv === '1234');
  ok('expMonth padded', noCvv.expMonth === '11');
  ok('expMonthNum unpadded', VP.autofillValues({ expMonth: '04', expYear: '2029' }).expMonthNum === '4');
  ok('expYear full + short', noCvv.expYear === '2030' && noCvv.expYearShort === '30');
  ok('combined exp', noCvv.exp === '11/30' && noCvv.expFull === '11/2030');
  ok('postal split out', noCvv.postal === '78701');
  ok('address one-line available', noCvv.addressOneLine.indexOf('Austin') >= 0);
  ok('number is raw digits for typing', noCvv.number === AMEX);

  console.log('\n── sort + filter ──');
  const now = new Date(2026, 0, 1).getTime();
  const cards = [
    VP.normalize({ nickname: 'Zed', number: VISA, expMonth: '01', expYear: '2030' }),
    VP.normalize({ nickname: 'Fav', number: MC, expMonth: '01', expYear: '2030', favorite: true }),
    VP.normalize({ nickname: 'Dead', number: DISC, expMonth: '01', expYear: '2020' }),
    VP.normalize({ nickname: 'Soon', number: AMEX, expMonth: '02', expYear: '2026' }),
  ];
  const sorted = VP.sortCards(cards, now);
  ok('favorite pinned first', sorted[0].nickname === 'Fav');
  ok('expired surfaced next', sorted[1].nickname === 'Dead');
  ok('expiring after expired', sorted[2].nickname === 'Soon');
  ok('filter by nickname', VP.filterCards(cards, 'zed').length === 1);
  ok('filter by network label', VP.filterCards(cards, 'mastercard').length === 1);
  ok('filter by last 4', VP.filterCards(cards, '1111').length === 1);
  ok('filter does NOT match the full PAN', VP.filterCards(cards, VISA).length === 0);
  ok('empty query returns all', VP.filterCards(cards, '').length === 4);

  console.log('\n── manual ordering ──');
  const ord = [
    VP.normalize({ nickname: 'C', number: VISA, order: 2 }),
    VP.normalize({ nickname: 'A', number: MC, order: 0 }),
    VP.normalize({ nickname: 'B', number: AMEX, order: 1 }),
  ];
  ok('order drives the sort', VP.sortCards(ord, now).map((c) => c.nickname).join('') === 'ABC');
  ok('order beats favourite', VP.sortCards([
    VP.normalize({ nickname: 'plain', number: VISA, order: 0 }),
    VP.normalize({ nickname: 'fav', number: MC, order: 1, favorite: true }),
  ], now)[0].nickname === 'plain');
  ok('order beats expired-first', VP.sortCards([
    VP.normalize({ nickname: 'good', number: VISA, expMonth: '01', expYear: '2030', order: 0 }),
    VP.normalize({ nickname: 'dead', number: MC, expMonth: '01', expYear: '2020', order: 1 }),
  ], now)[0].nickname === 'good');
  ok('normalize round-trips order', VP.normalize({ number: VISA, order: 3 }).order === 3);
  ok('unordered cards carry no order key', VP.normalize({ number: VISA }).order === undefined);
  ok('order survives JSON (what actually gets encrypted)', JSON.parse(JSON.stringify(VP.normalize({ number: VISA, order: 0 }))).order === 0);
  ok('absent order does not appear after JSON', !('order' in JSON.parse(JSON.stringify(VP.normalize({ number: VISA })))));
  ok('hasOrder rejects junk', !VP.hasOrder({ order: 'x' }) && !VP.hasOrder({ order: NaN }) && !VP.hasOrder({}) && VP.hasOrder({ order: 0 }));

  // An untouched wallet must sort exactly as it did before ordering existed.
  const legacy = [
    VP.normalize({ nickname: 'Zed', number: VISA, expMonth: '01', expYear: '2030' }),
    VP.normalize({ nickname: 'Fav', number: MC, expMonth: '01', expYear: '2030', favorite: true }),
    VP.normalize({ nickname: 'Dead', number: DISC, expMonth: '01', expYear: '2020' }),
  ];
  ok('unordered wallet keeps the old heuristic', VP.sortCards(legacy, now).map((c) => c.nickname).join(',') === 'Fav,Dead,Zed');
  // Mixed: ordered cards first, unordered fall in behind on the heuristic.
  const mixed = legacy.concat([VP.normalize({ nickname: 'Pinned', number: AMEX, order: 0 })]);
  ok('ordered cards precede unordered ones', VP.sortCards(mixed, now)[0].nickname === 'Pinned');
  ok('the unordered tail keeps its own order', VP.sortCards(mixed, now).slice(1).map((c) => c.nickname).join(',') === 'Fav,Dead,Zed');

  console.log('\n── moveInList ──');
  ok('move down', VP.moveInList(['a', 'b', 'c', 'd'], 0, 2).join('') === 'bcad');
  ok('move up', VP.moveInList(['a', 'b', 'c', 'd'], 3, 1).join('') === 'adbc');
  ok('no-op move', VP.moveInList(['a', 'b', 'c'], 1, 1).join('') === 'abc');
  ok('clamps past the end', VP.moveInList(['a', 'b', 'c'], 0, 99).join('') === 'bca');
  ok('clamps past the start', VP.moveInList(['a', 'b', 'c'], 2, -5).join('') === 'cab');
  ok('ignores an out-of-range source', VP.moveInList(['a', 'b'], 9, 0).join('') === 'ab');
  ok('does not mutate the input', (() => { const src = ['a', 'b', 'c']; VP.moveInList(src, 0, 2); return src.join('') === 'abc'; })());

  console.log('\n── reorderPlan writes only what moved ──');
  const pc = [{ id: 'a', order: 0 }, { id: 'b', order: 1 }, { id: 'c', order: 2 }, { id: 'd', order: 3 }];
  ok('unchanged order → no writes', VP.reorderPlan(['a', 'b', 'c', 'd'], pc).length === 0);
  const swap = VP.reorderPlan(['b', 'a', 'c', 'd'], pc);
  ok('adjacent swap writes exactly 2', swap.length === 2);
  ok('swap assigns the new indices', JSON.stringify(swap) === '[{"id":"b","order":0},{"id":"a","order":1}]');
  ok('move to front writes only the shifted prefix', VP.reorderPlan(['d', 'a', 'b', 'c'], pc).length === 4);
  ok('first-ever reorder numbers every card', VP.reorderPlan(['a', 'b', 'c'], [{ id: 'a' }, { id: 'b' }, { id: 'c' }]).length === 3);
  ok('unknown ids are skipped', VP.reorderPlan(['zz', 'a'], pc).map((p) => p.id).indexOf('zz') < 0);

  console.log('\n── nextTopOrder ──');
  ok('unordered wallet → undefined', VP.nextTopOrder([{ id: 'a' }]) === undefined);
  ok('ordered wallet → above the minimum', VP.nextTopOrder(pc) === -1);
  ok('empty wallet → undefined', VP.nextTopOrder([]) === undefined);
  ok('a new top card really sorts first', (() => {
    const top = VP.nextTopOrder(ord);
    return VP.sortCards(ord.concat([VP.normalize({ nickname: 'New', number: VISA, order: top })]), now)[0].nickname === 'New';
  })());

  console.log('\n── importers (extensible registry) ──');
  const cRows = [
    ['name', 'expiration_month', 'expiration_year', 'card_number'],
    ['Anthony N', '4', '2029', VISA],
  ];
  const chrome = VP.importPayments(cRows, 'csv');
  ok('chrome CSV detected', chrome.importer.id === 'chrome-csv');
  ok('chrome maps fields', chrome.items[0].cardholder === 'Anthony N' && chrome.items[0].number === VISA && chrome.items[0].expMonth === '04' && chrome.items[0].expYear === '2029');
  ok('chrome derives network', chrome.items[0].network === 'visa');

  const opRows = [
    ['Title', 'Type', 'Number', 'CVV', 'Expiry Date', 'Cardholder Name', 'Notes'],
    ['Amex Gold', 'credit', AMEX, '1234', '11/2030', 'A Nguyen', 'travel card'],
  ];
  const op = VP.importPayments(opRows, 'csv');
  ok('1Password CSV detected', op.importer.id === 'onepassword-csv');
  ok('1Password maps expiry + cvv', op.items[0].expMonth === '11' && op.items[0].expYear === '2030' && op.items[0].cvv === '1234');
  ok('1Password nickname from title', op.items[0].nickname === 'Amex Gold');

  const bw = { items: [
    { name: 'BW Visa', favorite: true, notes: 'n', card: { cardholderName: 'A N', brand: 'Visa', number: VISA, expMonth: '4', expYear: '2029', code: '123' } },
    { name: 'a login', login: { username: 'x' } },
  ] };
  const bwr = VP.importPayments(bw, 'json');
  ok('bitwarden JSON detected', bwr.importer.id === 'bitwarden-json');
  ok('bitwarden skips non-card items', bwr.items.length === 1);
  ok('bitwarden maps brand + favorite', bwr.items[0].network === 'visa' && bwr.items[0].favorite === true);

  const genRows = [
    ['nickname', 'card number', 'cvc', 'expiry', 'zip', 'city'],
    ['Backup', MC, '999', '2029-04', '78701', 'Austin'],
  ];
  const gen = VP.importPayments(genRows, 'csv');
  ok('generic CSV detected', gen.importer.id === 'generic-csv');
  ok('generic maps billing zip', gen.items[0].billing.postal === '78701' && gen.items[0].billing.city === 'Austin');
  ok('generic parses ISO-ish expiry', gen.items[0].expMonth === '04' && gen.items[0].expYear === '2029');

  ok('unrecognised CSV throws', (() => { try { VP.importPayments([['a', 'b'], ['1', '2']], 'csv'); return false; } catch (e) { return true; } })());
  ok('empty CSV throws', (() => { try { VP.importPayments([['a']], 'csv'); return false; } catch (e) { return true; } })());
  ok('blank rows dropped', VP.importPayments([['card number', 'name'], ['', ''], [VISA, 'A']], 'csv').items.length === 1);

  console.log('\n── brand marks are self-contained SVG ──');
  ['visa', 'mastercard', 'amex', 'discover', 'unknown'].forEach((id) => {
    const m = VP.brandMark(id);
    ok(id + ' mark is inline svg', /^<svg /.test(m) && /<\/svg>$/.test(m) && m.indexOf('http://www.w3.org/2000/svg') > 0);
    ok(id + ' mark loads nothing remote', !/https?:\/\/(?!www\.w3\.org)/.test(m));
  });

  // ── The security claim, verified end-to-end against the REAL store ────────
  console.log('\n── payments ride the existing encrypted store ──');
  const { config, dek } = await VC.createWarden('master-pw');
  const backend = WardenStore.memoryBackend();
  await backend.saveConfig(config);
  const store = new WardenStore(backend, dek);
  await store.load();

  const saved = await store.save(VP.normalize({
    nickname: 'Chase Sapphire', cardholder: 'Anthony Nguyen', number: VISA,
    expMonth: '04', expYear: '2029', cvv: '737', billing: addr, notes: 'primary travel card',
  }));
  await store.save({ kind: 'login', title: 'GitHub', url: 'github.com', username: 'me', password: 'hunter2' });

  const raw = JSON.stringify(await backend.listItems());
  ok('NO card number at rest', raw.indexOf(VISA) < 0 && raw.indexOf('4111') < 0);
  ok('NO CVV at rest', raw.indexOf('737') < 0);
  ok('NO cardholder at rest', raw.indexOf('Anthony') < 0);
  ok('NO nickname at rest', raw.indexOf('Sapphire') < 0);
  ok('NO last4 at rest', raw.indexOf('1111') < 0);
  ok('NO billing address at rest', raw.indexOf('78701') < 0 && raw.indexOf('Main St') < 0);
  ok('NO network brand at rest', raw.indexOf('visa') < 0);
  ok('only kind is plaintext (routing)', raw.indexOf('"payment"') > 0);
  ok('existing login encryption still holds', raw.indexOf('hunter2') < 0);

  ok('round-trips through decryption', store.get(saved.id).number === VISA && store.get(saved.id).cvv === '737');
  ok('byKind separates payments from logins', store.byKind('payment').length === 1 && store.byKind('login').length === 1);
  ok('payments searchable by nickname', store.search('sapphire').some((i) => i.id === saved.id));
  ok('payments searchable by cardholder', store.search('nguyen').some((i) => i.id === saved.id));
  ok('payments searchable by last 4', store.search('1111').some((i) => i.id === saved.id));
  ok('login search still finds logins', store.search('github').some((i) => i.kind === 'login'));

  const intruder = new WardenStore(backend, (await VC.createWarden('other')).dek);
  await intruder.load();
  ok('wrong key decrypts no payments', intruder.byKind('payment').length === 0);

  await store.remove(saved.id);
  ok('delete tombstones the payment', !store.get(saved.id));
  const tomb = (await backend.listItems()).find((d) => d.id === saved.id);
  ok('tombstone carries no ciphertext', tomb.deleted === true && !tomb.enc);

  console.log('\n' + '═'.repeat(40) + '\n  ' + pass + ' passed, ' + fail + ' failed\n' + '═'.repeat(40));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
