// Every A1 program with profiles draws its picker with profilepick.js (Tony,
// 2026-10-27: "the same profile screen in every app"), never its own.
//   node tests/profilepick-wiring.test.js
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond) => { console.log((cond ? '  ok   ' : '  FAIL ') + name); cond ? pass++ : fail++; };

const PICK = read('profilepick.js');
ok('the question is "Who goes there?"', /o\.ask \|\| 'Who goes there\?'/.test(PICK));
ok('the title is weight 600', /\.a1-pk \.pk-title\{[^}]*font:600 /.test(PICK));

const HOSTS = [
  { page: 'index.html', js: 'index.html', src: 'profilepick.js', title: 'TaskHub' },
  { page: 'mylist.html', js: 'mylist.html', src: 'profilepick.js', title: 'MyList' },
  { page: 'shield.html', js: 'shield.html', src: 'profilepick.js', title: 'Shield' },
  { page: 'magi.html', js: 'magi.html', src: 'profilepick.js', title: 'MAGI' },
  { page: 'Shruti/shruti.html', js: 'Shruti/app.js', src: '../profilepick.js', title: 'Shruti' },
];
for (const h of HOSTS) {
  const page = read(h.page), js = read(h.js);
  ok(h.page + ' loads ' + h.src, page.indexOf('<script src="' + h.src + '"></script>') >= 0);
  ok(h.page + ' mounts it as ' + h.title, new RegExp('A1Pick\\.mount\\([\\s\\S]{0,120}title: ?["\']' + h.title + '["\']').test(js));
  ok(h.page + ' has its own line under the title', new RegExp('title: ?["\']' + h.title + '["\'], sub: ?["\'][^"\']+ · ').test(js));
  ok(h.page + ' has no "Who\'s here"', !/Who's here/i.test(page + js));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
