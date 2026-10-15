#!/usr/bin/env node
/*
 * MyList links: a pasted product link becomes a clean item with
 * link:{url,title,image,price,site}. The worker reads each page
 * (extractLinkMeta), the model names the item and sets "link": n on its op,
 * and applyListOps attaches the page — adding any link the model skipped.
 *
 *   node tests/mylist-links.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? '\n      ' + detail : '')); console.log('  ✗ ' + name); }
}
function section(s) { console.log('\n' + s); }

const file = process.env.WORKER_FILE || path.join(__dirname, '..', 'workers', 'personal-ai', 'worker.js');
const src = fs.readFileSync(file, 'utf8')
  .replace(/^export default\s*\{/m, 'const __workerDefault = {')
  .replace(/^export (?=(?:async )?function |const |let )/gm, '');
const ctx = { console, URL, Response: function () {}, fetch: () => Promise.reject(new Error('no network in tests')), setTimeout, clearTimeout, AbortController };
vm.createContext(ctx);
vm.runInContext(src + '\n;globalThis.__T = { applyListOps, buildListPrompt, sanitizeItems, extractLinkMeta, listUrls, slugTitle, siteName, cleanTitle, linkItemName, linkMeta };', ctx);
const W = ctx.__T;

const SAMS = 'https://www.samsclub.com/ip/members-mark-italian-herb-grilled-chicken-breast-5-count/13590050893';
const samsHtml = `<html><head><title>Member&#x27;s Mark Italian Herb Grilled Chicken Breasts, priced per pound - Samsclub.com</title>
<meta property="og:title" content="Member&#x27;s Mark Italian Herb Grilled Chicken Breasts, priced per pound - Samsclub.com"/>
<meta property="og:image" content="https://i5.samsclubimages.com/asr/5cfbe04b.jpeg"/>
<meta property="og:site_name" content="Samsclub.com"/>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","image":"https://i5.samsclubimages.com/asr/5cfbe04b.jpeg","name":"Member's Mark Italian Herb Grilled Chicken Breasts, priced per pound","offers":{"@type":"Offer","price":12.94,"priceCurrency":"USD"}}</script>
</head></html>`;

section('reading a page');
const m = W.extractLinkMeta(samsHtml, SAMS);
t('JSON-LD name, store branding stripped', m.title === "Member's Mark Italian Herb Grilled Chicken Breasts, priced per pound", m.title);
t('photo from the page', m.image === 'https://i5.samsclubimages.com/asr/5cfbe04b.jpeg', m.image);
t('price formatted', m.price === '$12.94', m.price);
t('store name is friendly', m.site === "Sam's Club", m.site);
t('page counts as read', m.read === true);
const og = W.extractLinkMeta('<title>x</title><meta content="Cool Lamp | Shop Wayfair" property="og:title"><meta name="twitter:image" content="/img/lamp.jpg"><meta property="product:price:amount" content="49.5">', 'https://www.wayfair.com/lighting/pdp/cool-lamp-w1.html');
t('Open Graph fallback, attribute order free', og.title === 'Cool Lamp', og.title);
t('relative image made absolute', og.image === 'https://www.wayfair.com/img/lamp.jpg', og.image);
t('meta price', og.price === '$49.50', og.price);
t('Amazon title prefix/suffix stripped', W.cleanTitle('Amazon.com: Orgain Plant Based Protein Powder, Chocolate : Grocery &amp; Gourmet Food', 'Amazon') === 'Orgain Plant Based Protein Powder, Chocolate');
const amz = W.extractLinkMeta('<title>Amazon.com: Instant Pot Duo 6 Qt, Stainless Steel</title><img id="landingImage" data-old-hires="https://m.media-amazon.com/images/I/71ML.jpg"> {"priceAmount":79.00}', 'https://www.amazon.com/dp/B00FLYWNYQ');
t('Amazon: photo and price from the page body', amz.image === 'https://m.media-amazon.com/images/I/71ML.jpg' && amz.price === '$79.00' && amz.title === 'Instant Pot Duo 6 Qt, Stainless Steel', JSON.stringify(amz));
const bot = W.extractLinkMeta('<title>Robot or human?</title>', SAMS);
t('bot wall → slug name, no photo', bot.read === false && bot.image === '' && /Italian Herb Grilled Chicken Breast 5 Count/.test(bot.title), JSON.stringify(bot));
t('slug name from an Amazon path', W.slugTitle('https://www.amazon.com/Premier-Protein-Powder-Vanilla-Milkshake/dp/B07H9JVJ1Q') === 'Premier Protein Powder Vanilla Milkshake');
t('unknown site → domain name', W.siteName('https://shop.example-foods.com/x') === 'Example-foods');
t('short item name for a skipped link', W.linkItemName(m) === "Member's Mark Italian Herb Grilled Chicken Breasts", W.linkItemName(m));

section('finding links in input');
const urls = W.listUrls('get this ' + SAMS + ', and https://a.co/d/abc123. Also ' + SAMS);
t('urls found, trailing punctuation dropped, deduped', urls.length === 2 && urls[0] === SAMS && urls[1] === 'https://a.co/d/abc123', JSON.stringify(urls));
t('no links → none', W.listUrls('milk and eggs').length === 0);

section('attaching links to items');
const links = [m, { url: 'https://www.samsclub.com/ip/bacon/1', title: 'Hickory Smoked Bacon, 3 lbs', image: '', price: '', site: "Sam's Club", read: true }];
let r = W.applyListOps([], [], [{ op: 'add', link: 1, name: 'Italian Herb Grilled Chicken Breasts', store: "Sam's Club" }], 'shopping', links);
t('add with link n carries the page', r.items[0].link && r.items[0].link.url === SAMS && r.items[0].link.image && r.items[0].link.price === '$12.94', JSON.stringify(r.items[0]));
t('the skipped link is still added, under its store', r.items.length === 2 && r.items[1].name === 'Hickory Smoked Bacon' && r.items[1].store === "Sam's Club" && r.items[1].link.url === links[1].url, JSON.stringify(r.items[1]));
t('internal "read" flag never stored', !('read' in r.items[0].link));
r = W.applyListOps([{ id: 'x', name: 'Bacon', qty: '', when: '', store: '', desc: '', done: false }], [], [{ op: 'update', index: 1, match: 'Bacon', link: 2 }], 'shopping', [links[0], links[1]]);
t('update with link attaches to the existing item', r.items.find(i => i.id === 'x').link.url === links[1].url, JSON.stringify(r.items));
r = W.applyListOps([], [], [{ op: 'add', link: 1, name: 'Chicken' }, { op: 'add', link: 1, name: 'Chicken again' }], 'shopping', [links[0]]);
t('one link attaches to one item only', r.items.filter(i => i.link).length === 1);
r = W.applyListOps([], [], [], 'todo', [links[1]]);
t('non-shopping list: skipped link added without a group', r.items.length === 1 && r.items[0].store === '', JSON.stringify(r.items));
r = W.applyListOps([], [], [{ op: 'add', link: 7, name: 'Ghost' }], 'shopping', []);
t('a bad link number is ignored', r.items.length === 1 && !r.items[0].link);

r = W.applyListOps([], [], [{ op: 'add', name: 'Hickory Bacon', store: 'Meat' }, { op: 'add', name: 'Tofu' }], 'shopping', links);
t('no link number: the link goes to the item its title matches, nothing duplicated', r.items.length === 3 && r.items[0].link && r.items[0].link.url === links[1].url && !r.items[1].link && r.items[2].link.url === SAMS, JSON.stringify(r.items.map(i => [i.name, i.link && i.link.url])));

section('existing links survive edits');
const kept = W.sanitizeItems([{ id: 'a', name: 'Chicken', link: { url: SAMS, image: 'https://i5.samsclubimages.com/x.jpeg', price: '$12.94', site: "Sam's Club", junk: 1 } }]);
t('sanitizeItems keeps the link (and only its fields)', kept[0].link && kept[0].link.url === SAMS && !('junk' in kept[0].link));
r = W.applyListOps(kept, [], [{ op: 'update', index: 1, match: 'Chicken', set: { qty: '2' } }], 'shopping');
t('an unrelated edit keeps the link', r.items[0].link && r.items[0].link.url === SAMS && r.items[0].qty === '2');

section('prompt');
const p = W.buildListPrompt('Proteins:\n[LINK 1]', [], [], false, 'shopping', 'Sams', 'Thu', links);
t('prompt lists each page as one line', /\[LINK 1\] page title: "Member's Mark Italian Herb/.test(p) && /\[LINK 2\]/.test(p) && /price: \$12\.94/.test(p));
t('prompt never contains the raw URL', p.indexOf('13590050893') < 0);
t('no links → no link section', !/LINK RULES/.test(W.buildListPrompt('milk', [], [], false, 'shopping', '', 'Thu')));

(async () => {
  section('reading with no network');
  const off = await W.linkMeta(SAMS, 500);
  t('fetch failure still returns a slug name and the store', off.read === false && off.site === "Sam's Club" && /Italian Herb/.test(off.title), JSON.stringify(off));
  const local = await W.linkMeta('http://127.0.0.1/admin', 500);
  t('private address is never fetched', local.read === false);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) { console.log('\nFAILURES:\n  ' + failures.join('\n  ')); process.exit(1); }
})();
