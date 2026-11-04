// personal-ai GET /ig/media: reading Instagram's embed page (igContext + igMedia).
// Synthetic pages in the embed's three shapes (reel/video, carousel, plain
// photo); no network and no real Instagram content.
// Run: node workers/personal-ai/ig.test.mjs
import worker, { igContext, igMedia, igParseSession, igPostOf, igWhy } from './worker.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); } };

const CDN = 'https://scontent-xx1-1.cdninstagram.com/v/';
// The embed carries contextJSON as a JSON string inside a JSON blob.
const pageOf = (ctx) => '<html><script>{"isProfileEmbed":false,"contextJSON":' + JSON.stringify(JSON.stringify(ctx)) + ',"x":1}</script></html>';
const reel = { context: { type: 'GraphVideo', shortcode: 'ABCreel01' }, gql_data: { shortcode_media: {
  __typename: 'GraphVideo', shortcode: 'ABCreel01', is_video: true, display_url: CDN + 'cover.jpg?a=1&b=2', video_url: CDN + 'clip.mp4?oe=1',
  dimensions: { width: 640, height: 1136 }, video_duration: 71.47, owner: { username: 'someone' },
  edge_media_to_caption: { edges: [{ node: { text: 'Hello "world"\nline two' } }] } } } };

ok('contextJSON is read out of the page (a string holding JSON)', igContext(pageOf(reel)).context.shortcode === 'ABCreel01');
ok('no contextJSON, or null, gives null', igContext('<html></html>') === null && igContext('"contextJSON":null') === null && igContext('"contextJSON":"{broken"') === null);
const r = igMedia(pageOf(reel), 'ABCreel01');
ok('a reel: one video with poster, size and length', r.items.length === 1 && r.items[0].type === 'video' && r.items[0].src === CDN + 'clip.mp4?oe=1' && r.items[0].poster === CDN + 'cover.jpg?a=1&b=2' && r.items[0].w === 640 && r.items[0].h === 1136 && r.items[0].dur === 71.47, r);
ok('a reel: owner and caption', r.user === 'someone' && r.caption === 'Hello "world"\nline two');

const side = { gql_data: { shortcode_media: { __typename: 'GraphSidecar', owner: { username: 'a' }, edge_sidecar_to_children: { edges: [
  { node: { is_video: false, display_url: CDN + '1.jpg', dimensions: { width: 1080, height: 1350 } } },
  { node: { is_video: true, video_url: CDN + '2.mp4', display_url: CDN + '2.jpg', video_duration: 9 } },
  { node: { is_video: false, display_url: 'https://evil.example/3.jpg' } },
] } } } };
const s = igMedia(pageOf(side), 'CAR');
ok('a carousel: every child in order', s.items.map((i) => i.type).join() === 'image,video' && s.items[1].dur === 9, s);
ok('a link off Instagram\'s CDN is dropped', !JSON.stringify(s).includes('evil.example'));

const photo = '<html><img class="EmbeddedMediaImage" alt="Instagram post shared by &#064;world.rec_egg" src="' + CDN + 'small.jpg?x=1&amp;y=2" srcset="' + CDN + 'a.jpg?x=1&amp;y=2 640w,' + CDN + 'b.jpg?x=1&amp;y=2 1080w,' + CDN + 'c.jpg 750w"></html>';
const p = igMedia(photo + '<script>"contextJSON":null</script>', 'PHOTO');
ok('a photo: the largest srcset entry, entities decoded', p.items.length === 1 && p.items[0].type === 'image' && p.items[0].src === CDN + 'b.jpg?x=1&y=2' && p.items[0].w === 1080, p);
ok('a photo: the owner from the alt text', p.user === 'world.rec_egg', p.user);
const q = igMedia('<img class="EmbeddedMediaImage" src="' + CDN + 'only.jpg?a=1&amp;b=2">', 'PHOTO2');
ok('a photo without srcset: its src', q.items.length === 1 && q.items[0].src === CDN + 'only.jpg?a=1&b=2', q);
ok('a reel and a carousel with their videos are not flagged', !r.noVideo && !s.noVideo);
// Instagram's embed since ~2026-10: a reel without video_url (only its cover).
const bare = JSON.parse(JSON.stringify(reel)); delete bare.gql_data.shortcode_media.video_url;
const b = igMedia(pageOf(bare), 'ABCreel01');
ok('a reel whose embed left the video out: its cover, flagged noVideo', b.noVideo === true && b.items.length === 1 && b.items[0].type === 'image' && b.items[0].src === CDN + 'cover.jpg?a=1&b=2', b);
ok('a plain photo is not flagged', !p.noVideo);
ok('an empty shell (a login wall, a deleted post) has no items', igMedia('<html><title>Instagram</title></html>', 'X').items.length === 0);

// ── Server-side collection sync (/ig/connect, /ig/collection, /ig/disconnect) ──
console.log('\nCollection sync');
const SID = '1234567890:AbCdEfGh123456:12:AYfXyZ-_.abc';
ok('a sessionid is read bare, URL-encoded, quoted or out of a whole Cookie header',
  igParseSession(SID).uid === '1234567890' && igParseSession(encodeURIComponent(SID)).sid === SID &&
  igParseSession('"' + encodeURIComponent(SID) + '"').sid === SID && igParseSession('csrftoken=abc; sessionid=' + encodeURIComponent(SID) + '; ds_user_id=1234567890').sid === SID);
ok('anything else is refused', !igParseSession('') && !igParseSession('hello') && !igParseSession('abc:def') && !igParseSession('123:x y z') && !igParseSession('%E0%A4%A'));
const md = { code: 'CAROUSEL1', media_type: 8, video_duration: 0, caption: { text: '  Hello\n\nworld ' }, user: { username: 'acct' }, carousel_media: [
  { image_versions2: { candidates: [{ width: 320, url: CDN + 's.jpg' }, { width: 640, url: CDN + 'm.jpg' }, { width: 1080, url: CDN + 'l.jpg' }, { width: 2000, url: CDN + 'xl.jpg' }] }, original_width: 1080, original_height: 1350 },
  { video_versions: [{ url: CDN + 'v.mp4' }], image_versions2: { candidates: [{ width: 640, url: CDN + 'vp.jpg' }] }, original_width: 720, original_height: 1280 },
  { image_versions2: { candidates: [{ width: 640, url: 'https://evil.example/x.jpg' }] } }] };
const pp = igPostOf(md);
ok('a post becomes {c, k, d, t, u, i, m}: kind, caption, cover ~640, media up to 1440, CDN links only',
  pp.c === 'CAROUSEL1' && pp.k === 's' && pp.t === 'Hello world' && pp.u === 'acct' && pp.i === CDN + 'm.jpg' &&
  pp.m.length === 2 && pp.m[0].u === CDN + 'l.jpg' && pp.m[1].t === 'v' && pp.m[1].u === CDN + 'v.mp4' && pp.m[1].p === CDN + 'vp.jpg', pp);
ok('a reel is k r, a video v, a photo p; a bad code is skipped', igPostOf({ code: 'REEL00001', media_type: 2, product_type: 'clips', video_duration: 12.6 }).k === 'r' &&
  igPostOf({ code: 'REEL00001', media_type: 2, product_type: 'clips', video_duration: 12.6 }).d === 13 && igPostOf({ code: 'VID000001', media_type: 2 }).k === 'v' &&
  igPostOf({ code: 'PHO000001', media_type: 1 }).k === 'p' && igPostOf({ code: 'bad code' }) === null && igPostOf(null) === null);
ok("Instagram's refusals are named", igWhy(302, '') === 'expired' && igWhy(401, '') === 'expired' && igWhy(400, '{"message":"checkpoint_required"}') === 'checkpoint' &&
  igWhy(400, '{"message":"login_required"}') === 'expired' && igWhy(429, '') === 'busy' && igWhy(404, '') === 'gone' && igWhy(500, '') === 'unavailable');

// The routes, with a fake KV and a fake Instagram.
const kv = new Map();
const env = { TOKEN_CACHE: { get: async (k, t) => (kv.has(k) ? (t === 'json' ? JSON.parse(kv.get(k)) : kv.get(k)) : null), put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); } } };
const calls = []; let igMode = 'ok';
const item = (n) => ({ media: { code: 'POST' + String(n).padStart(5, '0'), media_type: 1, image_versions2: { candidates: [{ width: 640, url: CDN + n + '.jpg' }] } } });
globalThis.fetch = async (u, o) => {
  calls.push({ u: String(u), cookie: o && o.headers && o.headers.Cookie, app: o && o.headers && o.headers['X-IG-App-ID'] });
  if (igMode === 'expired') return new Response('', { status: 302, headers: { Location: 'https://www.instagram.com/accounts/login/' } });
  if (igMode === 'html') return new Response('<html>login</html>', { status: 200 });
  const page = Number((String(u).match(/max_id=(\d+)/) || [])[1] || 0);
  return new Response(JSON.stringify({ items: [item(page * 2), item(page * 2 + 1)], more_available: page < 2, next_max_id: page < 2 ? String(page + 1) : null }), { status: 200 });
};
const post = (path, body) => worker.fetch(new Request('https://personal-ai.av1.workers.dev' + path, { method: 'POST', body: JSON.stringify(body) }), env, { waitUntil() {} }).then(async (r) => ({ status: r.status, j: await r.json() }));
let res = await post('/ig/collection', { key: 'x', cid: '17912345678901234' });
ok('no session yet: not-connected', res.j.ok === false && res.j.error === 'not-connected', res);
res = await post('/ig/connect', { sessionid: 'nonsense' });
ok('a bad sessionid is refused before Instagram is asked', res.status === 400 && res.j.error === 'bad-session' && calls.length === 0);
igMode = 'expired'; res = await post('/ig/connect', { sessionid: encodeURIComponent(SID) });
ok('a session Instagram refuses is not stored', res.j.ok === false && res.j.error === 'expired' && !kv.has('ig_sess'), res);
igMode = 'ok'; calls.length = 0; res = await post('/ig/connect', { sessionid: encodeURIComponent(SID) });
const key = res.j.key, stored = JSON.parse(kv.get('ig_sess') || '{}');
ok('connect checks the session against Instagram, stores it, and answers a key (never the session)', res.j.ok && /^[A-Za-z0-9_-]{30,}$/.test(key) &&
  stored.sid === SID && stored.uid === '1234567890' && stored.kh && stored.kh !== key && !JSON.stringify(res.j).includes('AbCdEfGh') &&
  calls[0].u === 'https://www.instagram.com/api/v1/feed/saved/posts/' && calls[0].cookie === 'sessionid=' + encodeURIComponent(SID) + '; ds_user_id=1234567890' && calls[0].app === '936619743392459', { res, stored, calls });
res = await post('/ig/collection', { key: 'wrong', cid: '17912345678901234' });
ok('a wrong key is refused (403)', res.status === 403 && res.j.error === 'bad-key');
res = await post('/ig/collection', { key, cid: '../../accounts' });
ok('only a numeric collection id (or all) is read', res.status === 400);
calls.length = 0; res = await post('/ig/collection', { key, cid: '17912345678901234' });
ok('a full sync reads every page, in order', res.j.ok && res.j.posts.length === 6 && res.j.posts[0].c === 'POST00000' && res.j.posts[5].c === 'POST00005' && res.j.more === false &&
  calls.length === 3 && calls[0].u.endsWith('/feed/collection/17912345678901234/posts/') && calls[1].u.endsWith('?max_id=1'), { res, calls });
calls.length = 0; res = await post('/ig/collection', { key, cid: 'all', quick: true });
ok('a quick check reads one page only (and says more are there)', res.j.ok && res.j.posts.length === 2 && res.j.more === true && calls.length === 1 && calls[0].u.endsWith('/feed/saved/posts/'), { res, calls });
igMode = 'html'; res = await post('/ig/collection', { key, cid: 'all' });
ok("Instagram's login page instead of JSON reads as an expired session", res.j.ok === false && res.j.error === 'expired', res);
igMode = 'ok';
res = await post('/ig/connect', { sessionid: '999999:OtherAcct123:1:x' });
ok("another account's session cannot replace Tony's without his key", res.status === 403 && res.j.error === 'other-account' && JSON.parse(kv.get('ig_sess')).uid === '1234567890');
res = await post('/ig/connect', { sessionid: SID });
ok('the same account reconnects without the key (a fresh key)', res.j.ok && res.j.key !== key);
const key2 = res.j.key;
res = await post('/ig/disconnect', { key });
ok('the old key no longer works after a reconnect', res.status === 403);
res = await post('/ig/disconnect', { key: key2 });
ok('disconnect forgets the session', res.j.ok && !kv.has('ig_sess'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
