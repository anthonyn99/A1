const g = globalThis; g.window = g;
g.addEventListener = function(){}; g.removeEventListener = function(){};
require('./vault-crypto.js');
g.VaultStore = function(){}; g.VaultSession = function(){}; g.VaultSession.localStorageDeviceStore=()=>({});
const noEl = { style:{}, setAttribute(){}, addEventListener(){}, appendChild(){}, removeChild(){}, querySelector(){return null}, querySelectorAll(){return []}, insertBefore(){}, remove(){}, classList:{add(){},remove(){},toggle(){}}, click(){}, focus(){} };
g.document = { readyState:'complete', addEventListener(){}, head:{appendChild(){}}, body:{appendChild(){},removeChild(){}}, getElementById(){return null}, createElement(){return Object.assign({},noEl)}, querySelector(){return null}, querySelectorAll(){return []} };
g.localStorage = { getItem(){return null}, setItem(){}, removeItem(){} };
require('./vault-ui.js');
const V = g.Vault; let pass=0, fail=0;
const ok=(n,c)=>{ c?(pass++,console.log('  ✓',n)):(fail++,console.log('  ✗ FAIL',n)); };

// parseCSV
let r = V.parseCSV('name,url,username,password\r\nGitHub,github.com,me,"pa,ss""1"\r\n');
ok('parses 2 rows', r.length===2);
ok('header row', r[0].join('|')==='name|url|username|password');
ok('handles quoted comma + escaped quote', r[1][3]==='pa,ss"1');
ok('BOM stripped', V.parseCSV('﻿a,b\n1,2')[0][0]==='a');

// toCSV roundtrip
let csv = V.toCSV([['a','b,c'],['d"e','f']]);
ok('toCSV quotes comma', csv.indexOf('"b,c"')>=0);
ok('toCSV escapes quote', csv.indexOf('"d""e"')>=0);
ok('roundtrip', V.parseCSV(csv)[0][1]==='b,c' && V.parseCSV(csv)[1][0]==='d"e');

// importFromCSV with a fake store
(async()=>{
  const saved=[];
  V._setStore({ save: async(o)=>{ saved.push(o); return o; }, byKind:()=>[] });
  // Chrome format
  const n1 = await V.importFromCSV('name,url,username,password\nGoogle,accounts.google.com,me@x.com,secret1\nGitHub,github.com,dev,secret2\n');
  ok('chrome import count 2', n1===2);
  ok('chrome maps fields', saved[0].title==='Google'&&saved[0].url==='accounts.google.com'&&saved[0].username==='me@x.com'&&saved[0].password==='secret1');
  // Bitwarden format
  saved.length=0;
  const bw='folder,favorite,type,name,notes,fields,login_uri,login_username,login_password,login_totp\n,,login,Reddit,my note,,reddit.com,ruser,rpass,JBSWY\n';
  const n2 = await V.importFromCSV(bw);
  ok('bitwarden import count 1', n2===1);
  ok('bitwarden maps uri/user/pass/notes/totp', saved[0].url==='reddit.com'&&saved[0].username==='ruser'&&saved[0].password==='rpass'&&saved[0].notes==='my note'&&saved[0].totp==='JBSWY');
  // skip fully-empty rows
  saved.length=0;
  const n3 = await V.importFromCSV('name,username,password\n,,\nX,u,p\n');
  ok('skips empty rows', n3===1);
  // ── password health ──
  const now = Date.now();
  const YEAR = 365*24*3600*1000;
  const logins = [
    { id:'a', title:'Strong', password:'Xk9$mLp2@qRt7!zW', modifiedAt: now },
    { id:'b', title:'Weak', password:'abc', modifiedAt: now },
    { id:'c', title:'ReuseA', url:'x.com', username:'u1', password:'Repeat1!ng', modifiedAt: now },
    { id:'d', title:'ReuseB', url:'y.com', username:'u2', password:'Repeat1!ng', modifiedAt: now },
    { id:'e', title:'Old', password:'Qw8&nBv3#tYu6!aS', modifiedAt: now - 2*YEAR },
    { id:'f', title:'NoPass', username:'z' },
    { id:'g', title:'Dup', url:'dup.com', username:'same', password:'Zz9$kk22longenough', modifiedAt: now },
    { id:'h', title:'Dup2', url:'dup.com', username:'same', password:'Pp3@mn88differliong', modifiedAt: now },
  ];
  const H = V.analyzeHealth(logins, now);
  ok('weak detected', H.weak.some(l=>l.id==='b') && H.weak.length===1);
  ok('reused detected (2)', H.reusedCount===2 && H.reusedGroups.length===1);
  ok('old detected', H.old.some(l=>l.id==='e') && H.old.length===1);
  ok('missing password detected', H.missing.some(l=>l.id==='f') && H.missing.length===1);
  ok('duplicate accounts detected', H.duplicates.length===1 && H.duplicates[0].length===2);
  ok('score is 0-100', H.score>=0 && H.score<=100);
  ok('all-healthy scores 100', V.analyzeHealth([{id:'x',title:'ok',password:'Xk9$mLp2@qRt7!zW',modifiedAt:now}], now).score===100);
  ok('empty vault does not crash', V.analyzeHealth([], now).score>=0);

  console.log('\n  '+pass+' passed, '+fail+' failed');
  process.exit(fail?1:0);
})();
