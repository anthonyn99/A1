// personal-ai GET /yt/playlist: the page parsing (ytInitialData + ytWalk).
// Synthetic pages in both of YouTube's shapes; no network.
// Run: node workers/personal-ai/yt.test.mjs
import { ytInitialData, ytWalk } from './worker.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); } };

const lockup = (id, title) => ({ lockupViewModel: { contentType: 'LOCKUP_CONTENT_TYPE_VIDEO', contentId: id, metadata: { lockupMetadataViewModel: { title: { content: title } } } } });
const data = { contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { items: [
  lockup('aaaaaaaaaaa', 'First'), lockup('bbbbbbbbbbb', 'Second'),
  { lockupViewModel: { contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST', contentId: 'PLnotavideo0' } },
  { playlistVideoRenderer: { videoId: 'ccccccccccc', title: { runs: [{ text: 'Old ' }, { text: 'shape' }] } } },
  { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'TOKEN1' } } } },
] } } }] } }, metadata: { playlistMetadataRenderer: { title: 'My list' } } };
const page = '<html><script>var ytInitialData = ' + JSON.stringify(data) + ';</script></html>';

const d = ytInitialData(page);
ok('ytInitialData is read out of the page', d && d.metadata.playlistMetadataRenderer.title === 'My list');
ok('a page without it gives null', ytInitialData('<html></html>') === null && ytInitialData('var ytInitialData = {broken;</script>') === null);
const out = ytWalk(d.contents, { videos: [], next: null });
ok('videos in both shapes, in order, playlists skipped', out.videos.map((v) => v.id).join() === 'aaaaaaaaaaa,bbbbbbbbbbb,ccccccccccc', out.videos);
ok('titles read (runs joined)', out.videos[0].title === 'First' && out.videos[2].title === 'Old shape');
ok('the continuation token is found', out.next === 'TOKEN1');
ok('a bad video id is ignored', ytWalk([lockup('short', 'x'), lockup('<script>xxx', 'y')], { videos: [], next: null }).videos.length === 0);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
