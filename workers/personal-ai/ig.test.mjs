// personal-ai GET /ig/media: reading Instagram's embed page (igContext + igMedia).
// Synthetic pages in the embed's three shapes (reel/video, carousel, plain
// photo); no network and no real Instagram content.
// Run: node workers/personal-ai/ig.test.mjs
import { igContext, igMedia } from './worker.js';

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
ok('an empty shell (a login wall, a deleted post) has no items', igMedia('<html><title>Instagram</title></html>', 'X').items.length === 0);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
