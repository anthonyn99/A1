// Tests for js/d2l-sync.js's reconcile logic, run against a fake DOM.
//
// The parser has its own suite (test-d2l-ics.mjs); this covers the half that
// decides what actually lands in the user's data. Two cases here are the
// reason the file exists, and both caught real bugs during development:
//
//   "DONE RESTORED from the module-scope Map"
//       studyos.js replaces `tasks` wholesale on every remote update. A first
//       cut re-read `done` from that array on each reconcile, which meant the
//       replace overwrote the very value the Map was holding for it. The fix is
//       the learnDone / learnNewKeysOnly split: learn everything after a LOCAL
//       save, learn only unseen keys after a REMOTE one.
//
//   "zero-guard blocks"
//       An expired Brightspace link returns an HTML login page, which parses to
//       zero events, which without the guard reconciles to "delete everything".
//
// Run with:  npm run test:d2l:client
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(resolve(root, 'js/d2l-sync.js'), 'utf8');
const listeners={};
let classes=[{id:'c1',name:'Calculus II',code:'MATH 2202'}], events=[], tasks=[], d2lMap=null;
const el=()=>({style:{},querySelector:()=>el(),querySelectorAll:()=>[],appendChild(){},addEventListener(){},setAttribute(){},getAttribute:()=>'',remove(){},focus(){}});
const sb={console,Map,Set,JSON,Math,String,Number,Boolean,Array,Object,RegExp,Error,Promise,isNaN,parseInt,setTimeout,Date,
 localStorage:{_d:{},getItem(k){return this._d[k]??null},setItem(k,v){this._d[k]=v},removeItem(k){delete this._d[k]}},
 Blob:class{constructor(a){this.size=Buffer.byteLength(a[0])}},
 document:{readyState:'complete',getElementById:()=>null,createElement:()=>el(),head:{appendChild(){}},body:{appendChild(){}},addEventListener(){}}};
sb.window=sb; sb.window.addEventListener=(n,f)=>{(listeners[n]||=[]).push(f)};
sb.STUDYOS_CONFIG={cloudflare:{d2l:{enabled:true,baseUrl:'https://x.workers.dev'}}};
sb.STUDYOS_CONFIG_READY=()=>true; sb.fetch=async()=>({status:200,json:async()=>({ok:true})});
sb.uiAlert=async()=>true; sb.uiConfirm=async()=>true; sb.uiPrompt=async()=>'pw';
sb._sosBridge={getClasses:()=>classes,getEvents:()=>events,getTasks:()=>tasks,
 getD2LMap:()=>(d2lMap?JSON.parse(JSON.stringify(d2lMap)):null),
 applyD2L:(p)=>{if(p.events)events=p.events;if(p.tasks)tasks=p.tasks;if(p.map)d2lMap=p.map;return true}};
vm.createContext(sb); vm.runInContext(src,sb);
const I=sb._d2lInternals;

const iso=d=>{const x=new Date();x.setDate(x.getDate()+d);
 return x.getFullYear()+'-'+String(x.getMonth()+1).padStart(2,'0')+'-'+String(x.getDate()).padStart(2,'0')};
const feed=(items)=>({ok:true,courses:[],items});
const it=(k,o={})=>({key:k,uid:k+'@d2l',courseKey:'MATH2202',title:'HW '+k,type:'hw',
 date:iso(5),time:'',allDay:true,isUtc:false,tzid:'',dtRaw:'',description:'',rrule:'',...o});
d2lMap={version:1,lastSyncAt:0,horizonDays:210,lookbackDays:30,
 courses:{MATH2202:{classId:'c1',label:'MATH 2202',importAs:'auto',enabled:true}}};

let pass=0,fail=0;
const chk=(n,c,x='')=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+'  '+x))};

// 1. First import.
let rep=I.reconcile(feed([it('k1'),it('k2')]),d2lMap);
chk('2 added',rep.added===2);
sb._sosBridge.applyD2L({events:rep.events,tasks:rep.tasks,map:d2lMap});
chk('both landed as tasks (all-day hw)',tasks.length===2&&events.length===0);
const origId=tasks[0].id;

// 2. Tick one, and set a grade weight on nothing (tasks have priority instead).
tasks[0].done=true; tasks[0].priority='high'; tasks[0].notes='my note';
rep=I.reconcile(feed([it('k1'),it('k2')]),d2lMap);
const k1=rep.tasks.find(t=>t._d2l.k==='k1');
chk('DONE preserved through re-sync',k1.done===true,'done='+k1.done);
chk('priority preserved (local wins)',k1.priority==='high','priority='+k1.priority);
chk('notes preserved (local wins)',k1.notes==='my note');
chk('id is stable (TaskHub mirror key)',k1.id===origId,k1.id+' vs '+origId);
sb._sosBridge.applyD2L({events:rep.events,tasks:rep.tasks,map:d2lMap});

// 3. THE HAZARD: wholesale replace wipes the tick from the array.
listeners['fb-sos-saved'].forEach(f=>f({}));await new Promise(r=>setTimeout(r,5));listeners['fb-sos-remote'].forEach(f=>f({detail:{}}));
await new Promise(r=>setTimeout(r,10));
tasks=tasks.map(t=>({...t,done:false,priority:'medium'}));
chk('array no longer has the tick',tasks[0].done===false);
rep=I.reconcile(feed([it('k1'),it('k2')]),d2lMap);
const k1b=rep.tasks.find(t=>t._d2l.k==='k1');
chk('DONE RESTORED from the module-scope Map',k1b.done===true,'done='+k1b.done);

// 4. D2L wins on its own fields.
rep=I.reconcile(feed([it('k1',{title:'HW 1 (revised)',date:iso(9)}),it('k2')]),d2lMap);
const k1c=rep.tasks.find(t=>t._d2l.k==='k1');
chk('title updated from D2L',k1c.title===undefined&&k1c.name==='HW 1 (revised)',k1c.name);
chk('date updated from D2L',k1c.dueDate===iso(9),k1c.dueDate);
chk('still ticked after a D2L-side edit',k1c.done===true);
chk('counted as updated',rep.updated===1&&rep.added===0,JSON.stringify({a:rep.added,u:rep.updated}));

// 5. Manual items are never touched.
events=[{id:'mine',name:'My event',date:iso(3),classId:'c1'}];
tasks=tasks.concat([{id:'minet',name:'My task',dueDate:iso(3),classId:'c1',done:false}]);
rep=I.reconcile(feed([it('k1')]),d2lMap);
chk('manual event survives',rep.events.some(e=>e.id==='mine'));
chk('manual task survives',rep.tasks.some(t=>t.id==='minet'));
chk('removed counts the dropped import',rep.removed===1,'removed='+rep.removed);

// 6. Timed non-hw item becomes an event, not a task.
rep=I.reconcile(feed([it('e1',{type:'exam',allDay:false,time:'09:30'})]),d2lMap);
chk('timed exam becomes an event',rep.events.some(e=>e._d2l&&e._d2l.k==='e1'));
chk('and not a task',!rep.tasks.some(t=>t._d2l&&t._d2l.k==='e1'));

// 7. UTC localization.
const lt=I.localizeTime({allDay:false,time:'14:30',isUtc:true,dtRaw:'20260114T143000Z',date:'2026-01-14'});
chk('UTC converted to local',/^\d{2}:\d{2}$/.test(lt.time),JSON.stringify(lt));
const lt2=I.localizeTime({allDay:false,time:'09:30',isUtc:false,tzid:'America/New_York',date:'2026-01-14'});
chk('floating TZID left alone',lt2.time==='09:30'&&lt2.date==='2026-01-14',JSON.stringify(lt2));

// 8. Zero guard.
rep=I.reconcile(feed([]),d2lMap);
chk('zero-guard blocks',!!I.guard(rep),String(I.guard(rep)).slice(0,60));

// 9. Course auto-match.
chk('MATH 2202 matches code math-2202',
  I.guessClassId({key:'MATH2202',label:'MATH 2202'},[{id:'z',name:'Calc',code:'math-2202'}])==='z');
chk('no match returns empty',I.guessClassId({key:'ZZZ999',label:'ZZZ'},[{id:'z',name:'Calc',code:'math-2202'}])==='');

console.log('\n'+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
