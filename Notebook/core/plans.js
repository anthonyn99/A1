/* Notebook — Plans: shared commitments with a two-sided confirm, kept in
   Notebook's two sides. docs/Notebook/README.md ("Plans"); the feature's spec is
   docs/TaskHub/plans-section-design.md.

   WHERE A PLAN LIVES. Each person writes ONLY their own side's document:
     Tony  T's Notebook  dashboards/tony_journal_plans  (Notebook.profiles.tony.plans)
     Veda  V's Notebook  dashboards/journal_plans       (Notebook.profiles.veda.plans)
   one field per plan, p_<id>, the WHOLE record as its writer last left it. Both
   sides listen to both documents and, per plan, the copy with the later
   updatedAt wins (a save always stamps past the copy it was made from, so a
   slow clock cannot lose a change). A delete is a tombstone in the deleter's
   document, { id, deleted: true, updatedAt }, because the other side's copy is
   still there and would otherwise bring the plan back.
   The old shared document, dashboards/plans, is read and never written: it
   holds the plans from before this move, and a tab still running an older page
   writes there, so those plans keep reaching the new one.

   THE HOST. index.html installs it through Notebook.fb.install / unsubscribe /
   rearm (core/fb.js passes the host's Firestore on), and its TaskHubs draw the
   panel through window.PlansCore and mirror confirmed plans onto their grids
   from the fb-plans-update event (window._plansLatest). Nothing here knows a
   colour or an element. */
(function(){
'use strict';
// ── Plans ───────────────────────────────────────────────────────────────────
// Every shared commitment gets ONE home with an explicit two-sided confirm.
// Nothing counts as a plan unless BOTH profiles pressed confirm in the app.
//
// This is NOT authentication. Profiles are a chooser with an optional local
// password, so "tony confirmed" means "someone using the tony profile pressed
// confirm". That is enough for two people who trust each other and is not
// proof — do not build anything on top of this that assumes otherwise.
const PEOPLE=['veda','tony'];
const NAMES={veda:'Veda',tony:'Tony'};

let plans={};          // id -> plan record
// Ids the server has confirmed it holds. Until an id is acked, its absence from
// a snapshot means "our write has not landed yet", not "it was deleted".
let acked={};
// Ids we deleted locally, so a snapshot still carrying them cannot resurrect it.
// Cleared once the snapshot agrees the plan is gone.
let deleted={};
let booted=false;

// The engine has no DOM. Anything showing plans subscribes and repaints itself
// — which is how one record set feeds Tony's panel, Veda's panel and the
// waiting-count badge in both TaskHubs without any of them knowing about the
// others.
const subs=[];
function emit(){for(let i=subs.length-1;i>=0;i--){try{subs[i]();}catch(e){}}}
function subscribe(fn){
  if(typeof fn!=='function')return function(){};
  subs.push(fn);
  return function(){const i=subs.indexOf(fn);if(i>=0)subs.splice(i,1);};
}

const uid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,8);

// The acting profile. null on the chooser screen — every mutating action checks
// this, so a stray call can never be attributed to the wrong person.
function me(){return window._activeProfile==='veda'?'veda':(window._activeProfile==='tony'?'tony':null);}
function other(w){return w==='veda'?'tony':'veda';}
function isConfirmed(p){return !!(p&&p.confirms&&p.confirms.veda&&p.confirms.tony);}

function fmtDate(d){
  if(!d)return null;
  const parts=String(d).split('-');
  if(parts.length!==3)return d;
  const dt=new Date(+parts[0],+parts[1]-1,+parts[2]);
  if(isNaN(dt))return d;
  return dt.toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'});
}
function fmtWhen(ms){
  if(!ms)return '';
  const dt=new Date(ms);
  if(isNaN(dt))return '';
  return dt.toLocaleDateString(undefined,{month:'short',day:'numeric'})+' '+dt.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});
}
function humanGap(ms){
  const s=Math.round(ms/1000);
  if(s<60)return s+(s===1?' second':' seconds');
  const m=Math.round(s/60);
  if(m<60)return m+(m===1?' minute':' minutes');
  const h=Math.round(m/60);
  return h+(h===1?' hour':' hours');
}
// The zone this device is in. Stored alongside any time a plan is given, because
// "7:30 PM" is only 7:30 PM where it was entered — the two profiles are in
// different zones and a bare wall-clock string would read identically to both,
// which is wrong.
function myTz(){
  try{return Intl.DateTimeFormat().resolvedOptions().timeZone||null;}catch(e){return null;}
}
// Render a plan's time in THIS viewer's zone. Falls back to the raw wall clock
// for older records saved before tz was recorded.
function fmtTime(t,dateKey,tz){
  if(!t)return '';
  if(tz&&dateKey&&typeof fmt12h==='function'){
    try{return fmt12h(t,dateKey,tz);}catch(e){}
  }
  const m=String(t).split(':');
  if(m.length<2)return t;
  let h=+m[0];const ap=h>=12?'PM':'AM';h=h%12||12;
  return h+':'+m[1]+' '+ap;
}
// The wall clock to put in an edit form: the plan's time as it falls in THIS
// viewer's zone, so editing a plan the other person set does not silently
// reinterpret their 7:30 PM as yours.
function toLocalHHMM(t,tz,dateKey){
  if(!t)return '';
  if(typeof thToLocalHHMM==='function'){
    try{return thToLocalHHMM(t,tz,dateKey)||'';}catch(e){}
  }
  return t;
}

// ── Provenance ──────────────────────────────────────────────────────────────
// HONEST LIMIT: profiles are a chooser, not authentication. Anyone at an unlocked
// device can switch to the other profile and press confirm, and no client-side
// check can prevent that — the password is verified locally and the unlock is
// remembered in localStorage, so it is bypassable by design.
//
// What we CAN do is make a forged confirm impossible to hide. Every confirm
// records the device it came from and which profile the app was on immediately
// before it. Two profiles confirming from the same device seconds apart is the
// signature of one person clicking both, and it is surfaced on the card rather
// than left for someone to notice. This is accountability, not prevention.
const DEV_KEY='pl_device_id',DEV_NAME_KEY='pl_device_name';
function deviceId(){
  let v='';
  try{v=localStorage.getItem(DEV_KEY)||'';}catch(e){}
  if(!v){
    v=Math.random().toString(36).slice(2,10)+Date.now().toString(36).slice(-4);
    try{localStorage.setItem(DEV_KEY,v);}catch(e){}
  }
  return v;
}
function deviceName(){
  let n='';
  try{n=localStorage.getItem(DEV_NAME_KEY)||'';}catch(e){}
  if(n)return n;
  const ua=navigator.userAgent||'';
  if(/iPhone/i.test(ua))n='iPhone';
  else if(/iPad/i.test(ua))n='iPad';
  else if(/Android/i.test(ua))n='Android';
  else if(/Mac/i.test(ua))n='Mac';
  else if(/Windows/i.test(ua))n='Windows PC';
  else n='Unknown device';
  return n;
}
// The profile the app was on before the current one, and when it switched. A
// confirm made moments after a profile switch, from the device that just made
// the OTHER person's confirm, is exactly what one-person forgery looks like.
window._plProfileSwitchedAt=window._plProfileSwitchedAt||0;
window._plPrevProfile=window._plPrevProfile||null;
function stamp(verified){
  return {dev:deviceId(),devName:deviceName(),at:Date.now(),
    prev:window._plPrevProfile||null,
    sinceSwitch:window._plProfileSwitchedAt?(Date.now()-window._plProfileSwitchedAt):null,
    // 'bio'  = the OS verified this person's biometric on this device
    // 'none' = no biometric was enrolled here, so the profile chooser is the only
    //          evidence — exactly as forgeable as before, and labelled as such.
    v:verified?'bio':'none'};
}

// ── Biometric consent ───────────────────────────────────────────────────────
// This is the part that actually closes the forgery hole. The profile chooser
// cannot tell two people apart; the device's secure enclave can. Each profile
// enrols its OWN credential — a Guardian bio-only lock 'plans:<profile>'
// (Guardian/guardian.js) — and Guardian only ever allows that one credential id
// — so Tony's fingerprint cannot satisfy a check registered to Veda, even on a
// device they share.
//
// The app never sees biometric data. WebAuthn returns a public-key handle only.
const GD=window.Guardian;
function plansBio(who){
  return GD.define('plans:'+who,{journal:'plans',entryId:who,owner:who,label:'Plans confirmation',bioOnly:true,
    // the credential the old shared helper enrolled (bio_cred_plans_<who>) carries over
    legacy:{bio:()=>GD.legacy.bioRec('plans',who,0)}});
}
function bioEnrolled(who){return !!(GD&&who&&GD.bio.isRegistered(plansBio(who)));}
function bioLabel(){return (GD&&GD.bio.label())||'biometrics';}
// The panel renders synchronously but availability is a promise, so it is
// resolved once at boot and cached. Defaults to false: never advertise a
// capability we have not actually confirmed the device has.
let bioOK=false;
let bioChecked=false;
function refreshBioOK(){
  if(bioChecked)return Promise.resolve(bioOK);
  bioChecked=true;
  if(!GD)return Promise.resolve(false);
  return GD.bio.available().catch(()=>false).then(v=>{bioOK=v;window._plBioOK=v;emit();return v;});
}
// Checked when the store is installed (a host with Plans), not on load: every
// host that loads Notebook loads this file, and only index.html has Plans.
// Resolves true only when the OS positively verified this profile's own
// credential. A cancelled prompt or a failure resolves false — never throws, so
// a confirm can still proceed as unverified rather than dead-ending.
function bioVerify(who){
  if(!bioEnrolled(who))return Promise.resolve(false);
  return GD.bio.authenticate(plansBio(who)).then(r=>!!(r&&r.ok)).catch(()=>false);
}
function bioEnrol(who){
  if(!GD||!who)return Promise.resolve({ok:false,error:'unsupported'});
  return GD.bio.register(plansBio(who)).catch(e=>({ok:false,error:(e&&e.name)||'error'}));
}

// Two confirmations from the SAME device are not proof of forgery — a couple may
// genuinely share one laptop — but they are never proof of independent consent
// either, which is the entire point of this feature. Say so on the card.
const SAME_DEV_WINDOW=10*60*1000;   // 10 minutes
function confirmFlags(p){
  const m=p&&p.confirmMeta;
  if(!m||!m.veda||!m.tony)return null;
  // Both biometrically verified means the OS proved two different people, even on
  // one shared device — that is real evidence, so there is nothing to warn about.
  if(m.veda.v==='bio'&&m.tony.v==='bio')return null;
  const sameDev=m.veda.dev&&m.tony.dev&&m.veda.dev===m.tony.dev;
  if(!sameDev)return null;
  const gap=Math.abs((m.veda.at||0)-(m.tony.at||0));
  return {sameDev:true,gap:gap,rapid:gap<SAME_DEV_WINDOW,
    devName:m.tony.devName||m.veda.devName||'the same device'};
}

// Normalise anything we read, so a legacy or half-written record renders instead
// of throwing. Mirrors _planCoerce in the Firebase layer.
function coerce(p){
  const c=(p&&p.confirms&&typeof p.confirms==='object')?p.confirms:{};
  const d=(p&&p.dones&&typeof p.dones==='object')?p.dones:{};
  const out=Object.assign({},p,{confirms:{veda:c.veda||null,tony:c.tony||null},
                                dones:{veda:d.veda||null,tony:d.tony||null}});
  // A pending edit is only meaningful if we know WHO proposed it — without an
  // author there is nobody to approve it and nobody to withdraw it, so it would
  // be an un-clearable block on the plan. Drop a malformed one.
  const pe=out.pendingEdit;
  if(!(pe&&typeof pe==='object'&&(pe.by==='veda'||pe.by==='tony')))out.pendingEdit=null;
  if(out.stage==='confirmed'&&!isConfirmed(out)){
    console.warn('[Plans] corrupt record '+out.id+': confirmed without two confirms — showing as proposed');
    out.stage='proposed';
  }
  // Records finished under the EARLIER one-sided rule carry stage==='done' with
  // no marks at all. They were legitimately done at the time, so migrate them
  // into the new shape rather than resurrecting them as unfinished: stamp both
  // marks with when the record was last written.
  if(out.stage==='done'&&!isDone(out)){
    const t=out.updatedAt||out.createdAt||Date.now();
    out.dones={veda:out.dones.veda||t,tony:out.dones.tony||t};
  }
  return out;
}

// ── Notifying the other person ──────────────────────────────────────────────
// The whole point of Plans is that neither person has to remember to go and
// look. So every action that changes what the OTHER person is on the hook for
// notifies them: in-app if their TaskHub is open, and by push if it is closed.
//
// Notifications are addressed to the OTHER profile — never to yourself, since
// you already know what you just did. The `dashboard` field is what the Worker
// routes on ('tony' | 'veda'), so a device registered to that profile is the
// one that rings.
// The message text, built from the record rather than captured at send time.
// Split out of notifyOther because the RECEIVING device renders it too (see the
// arrival banner in ingest): a plan's dates and times must read in the zone of
// whoever is looking at them, so the sender cannot bake the string.
// `actor` is the profile that did the thing; the reader is always the other one.
function planMsg(kind,actor,p,extra){
  if(!kind||!p)return '';
  const who=NAMES[actor]||actor||'They';
  const title=p.title||'a plan';
  // A move is only meaningful as "from → to". For a request the plan still holds
  // the old slot and the pending record holds the new one; once it is approved
  // or refused the old slot is gone from the record, so the actor passes it in.
  const slot=(d,t,tz)=>d?(fmtDate(d)+(t?' at '+fmtTime(t,d,tz):'')):'no date';
  const pe=p.pendingEdit;
  const moveTo=pe?slot(pe.date,pe.time,pe.tz):'';
  const moveFrom=slot(p.date,p.time,p.tz);
  let msg='';
  switch(kind){
    // ── Reschedule ──────────────────────────────────────────────────────────
    // Its own set of words, not the generic "change" ones: a move is the thing
    // people actually need to read at a glance, and burying it in "wants to
    // change X" makes them open the app to find out what moved.
    case 'moveReq': msg=who+' wants to move “'+title+'” from '+moveFrom+' to '+moveTo
      +(extra?' — '+extra:'')+'. Approve it to move the plan.'; break;
    case 'moveOK':  msg=who+' approved the new time for “'+title+'”'
      +(extra?' — it is now '+extra:'')+'.'; break;
    case 'moveNo':  msg=who+' declined the new time for “'+title+'” — it stays '
      +moveFrom+'.'; break;
    case 'moveGone':msg=who+' withdrew their request to move “'+title+'”.'; break;
    case 'proposed': msg=who+' proposed “'+title+'” — needs your confirmation.'; break;
    case 'confirmed':msg=who+' confirmed “'+title+'”. It is now a plan.'; break;
    case 'declined': msg=who+' declined “'+title+'”'+(extra?': '+extra:'.'); break;
    case 'cancelReq':msg=who+' asked to cancel “'+title+'”'+(extra?': '+extra:'.'); break;
    case 'cancelled':msg=who+' agreed to cancel “'+title+'”. It is dropped.'; break;
    case 'withdrawn':msg=who+' withdrew the cancel request on “'+title+'”.'; break;
    case 'edited':   msg=who+' changed “'+title+'” — your confirmation was reset.'; break;
    // A change to a plan you BOTH agreed to is a request, not a fact. The plan
    // stays exactly as it was until the other person approves, so the wording
    // has to say that plainly — "changed" would be a lie.
    case 'editReq':  msg=who+' wants to change “'+title+'”'+(extra?': '+extra:'.')+' Approve it to make it official.'; break;
    case 'editOK':   msg=who+' approved your change to “'+title+'”. It is now part of the plan.'; break;
    case 'editNo':   msg=who+' declined your change to “'+title+'” — the plan stands as agreed.'; break;
    case 'editGone': msg=who+' withdrew their proposed change to “'+title+'”.'; break;
    case 'doneReq':  msg=who+' marked “'+title+'” done — mark it too to finish it.'; break;
    case 'done':     msg=who+' marked “'+title+'” done. You have both finished it.'; break;
    case 'undone':   msg=who+' took back their done mark on “'+title+'”.'; break;
    case 'notDone':  msg=who+' says “'+title+'” is not finished yet.'; break;
    case 'idea':     msg=who+' added an idea: “'+title+'”.'; break;
    case 'restored': msg=who+' restored “'+title+'” back to ideas.'; break;
    case 'tweaked':  msg=who+' updated “'+title+'”.'; break;
    case 'kept':     msg=who+' declined to cancel “'+title+'” — it stands.'; break;
    case 'deleted':  msg=who+' deleted “'+title+'”.'; break;
    default: return '';
  }
  return msg;
}

// `actor` is who did it. The push goes out once the save lands, by which time
// this device may be on the other profile, so the caller names the actor
// rather than this reading the profile at send time.
function notifyOther(kind,p,extra,actor){
  const w=(actor==='veda'||actor==='tony')?actor:me();if(!w||!p)return;
  const to=other(w);
  const msg=planMsg(kind,w,p,extra);
  if(!msg)return;
  // Push, so it lands even with TaskHub closed. Fire-and-forget: a plan must
  // never fail to save because a notification could not be queued.
  //
  // NOT an in-app banner as well. This runs on the ACTING device, where the
  // reader is by definition the other person — the banner it used to raise here
  // could never pass its own "am I that profile?" gate, so Plans had exactly one
  // delivery surface (push) pretending to be two. The receiving device raises
  // its own banner off the Firestore snapshot instead (see ingest), which is the
  // only path that still works when push is broken or switched off.
  //
  // The key carries a minute stamp. The doc id must stay stable across a retry
  // of ONE event (a re-send would otherwise stack a second card), but it must
  // NOT be stable across two genuine events of the same kind on the same plan —
  // marked done, taken back, marked done again is three real notifications, and
  // a fixed id made the second and third silently overwrite the first.
  const key='plan_'+p.id+'_'+kind+'_'+Math.floor(Date.now()/60000).toString(36);
  try{
    if(window._fcmSendToProfile)window._fcmSendToProfile(to,'Plans',msg,key);
    else{
      // The FCM layer is a <script type="module"> and loads async, so a plan
      // acted on in the first seconds after a cold open found it undefined and
      // the notification was dropped on the floor with no error anywhere. Queue
      // it exactly as the reminders path does; the module drains this on ready.
      window._plansPushQueue=window._plansPushQueue||[];
      window._plansPushQueue.push({to:to,body:msg,key:key});
    }
  }catch(e){}
}

// A save must sort AFTER the copy it was made from, on every device. The two
// sides write two documents and the later updatedAt wins, so a device whose
// clock runs behind the other's would otherwise write a change that loses to
// the very version it was changing. One past the old stamp, at least.
function nextStamp(prev){return Math.max(Date.now(),(prev||0)+1);}

function save(p,kind,extra){
  const w=me();
  // Every save is somebody's: it goes into THAT person's Notebook. On the
  // profile chooser there is nobody, so nothing is written (every action
  // already checks this; this is the backstop).
  if(!w){planSaveFailed();return;}
  p.updatedAt=nextStamp(p.updatedAt);
  // Provenance of THIS write, carried on the record so the other device can
  // announce it from the snapshot alone. Cleared to null on a silent save so a
  // later unrelated write can never replay an old event as if it just happened.
  p.lastBy=w;
  p.lastKind=kind||null;
  p.lastExtra=extra||'';
  plans[p.id]=p;
  emit();
  // The push waits for the save. A notification sent for a write that never
  // landed sends the other person to a plan that does not exist — tapping it
  // opened TaskHub on nothing. A copy is taken now so a later edit in this tab
  // cannot change what this notification says.
  const snap=JSON.parse(JSON.stringify(p));
  store.save(w,snap).then(ok=>{
    if(!ok){planSaveFailed();return;}
    if(kind)notifyOther(kind,snap,extra,w);
  });
}
// Say it out loud: a plan the other person will never see is the one failure
// this feature cannot afford to have happen quietly.
function planSaveFailed(){
  try{if(window._planReadOnlyNudge)window._planReadOnlyNudge('Plan not saved — check your connection and try again.');}catch(e){}
}
function removePlan(id){
  // Deleting bypasses save(), so it must notify on its own — otherwise a plan
  // could vanish from the other person's list with no explanation at all.
  const w=me();if(!w)return;
  const gone=plans[id];if(!gone)return;
  // A tombstone, not a field delete: the other side's document still holds its
  // copy, and only a NEWER record can outrank it. It keeps the title so the
  // other device can say what went.
  const tomb={id:id,deleted:true,title:gone.title||'',updatedAt:nextStamp(gone.updatedAt),
    lastBy:w,lastKind:'deleted',lastExtra:''};
  delete plans[id];
  // Remember the deletion: a snapshot already in flight still carries this plan,
  // and without this the merge in ingest() would bring it straight back.
  deleted[id]=tomb.updatedAt;
  delete acked[id];
  emit();
  const snap=JSON.parse(JSON.stringify(gone));
  store.save(w,tomb).then(ok=>{
    if(!ok){planSaveFailed();return;}
    notifyOther('deleted',snap,'',w);
  });
}

// ── Lifecycle ───────────────────────────────────────────────────────────────
function addIdea(title,notes,date,time){
  const w=me();if(!w)return;
  const now=Date.now();
  save({id:uid(),title:title,notes:notes||'',author:w,stage:'idea',
    date:date||null,time:time||null,tz:time?myTz():null,proposedBy:null,proposedAt:null,
    confirms:{veda:null,tony:null},cancelReq:null,declined:null,
    createdAt:now,updatedAt:now},'idea');
}

// Either person may promote any idea, including one the other wrote. There is no
// gate here on purpose — the confirm step IS the gate. Proposing implies your own
// consent, so it sets your confirm and only yours.
// Promoting records YOUR consent, so it is verified exactly like a confirm.
function promote(id){
  const w=me();if(!w)return Promise.resolve('noop');
  const p=plans[id];if(!p)return Promise.resolve('noop');
  return bioVerify(w).then(ok=>{
    const q=plans[id];if(!q)return 'noop';
    q.stage='proposed';q.proposedBy=w;q.proposedAt=Date.now();
    q.confirms={veda:null,tony:null};q.confirms[w]=Date.now();
    q.confirmMeta={};q.confirmMeta[w]=stamp(ok);
    q.declined=null;clearProgress(q);
    save(q,'proposed');
    return 'ok';
  });
}

// The other person agrees. stage becomes 'confirmed' ONLY when both keys are set
// — never from a single action. That structural two-sidedness is what makes a
// one-sided "confirmed" plan impossible to manufacture.
//
// Resolves 'bioFailed' when this profile is enrolled here and the OS check did
// NOT pass: that is the case this whole feature exists for — someone on the
// wrong profile who cannot produce the other person's face or fingerprint — so
// nothing is recorded and the caller shows the refusal.
function confirmPlan(id){
  const w=me();if(!w)return Promise.resolve('noop');
  const p=plans[id];if(!p)return Promise.resolve('noop');
  const enrolled=bioEnrolled(w);
  return bioVerify(w).then(ok=>{
    if(enrolled&&!ok)return 'bioFailed';
    const q=plans[id];if(!q)return 'noop';
    q.confirms=q.confirms||{veda:null,tony:null};
    q.confirms[w]=Date.now();
    q.confirmMeta=q.confirmMeta||{};
    q.confirmMeta[w]=stamp(ok);
    const became=isConfirmed(q);
    if(became)q.stage='confirmed';
    save(q,became?'confirmed':null);
    return 'ok';
  });
}

function declinePlan(id,reason){
  const w=me();if(!w)return;
  const p=plans[id];if(!p)return;
  p.stage='declined';
  p.declined={by:w,reason:reason||'',at:Date.now()};
  p.confirms={veda:null,tony:null};p.confirmMeta={};
  p.cancelReq=null;clearProgress(p);
  save(p,'declined',reason||'');
}

function restorePlan(id){
  const p=plans[id];if(!p)return;
  p.stage='idea';p.declined=null;p.cancelReq=null;
  p.confirms={veda:null,tony:null};p.confirmMeta={};
  p.proposedBy=null;p.proposedAt=null;clearProgress(p);
  save(p,'restored');
}

// Cancelling a confirmed plan is symmetric with confirming it: one person files
// a request, the plan STAYS confirmed (and its TaskHub items stay put) until the
// other agrees. A second request from the other party IS that agreement.
function requestCancel(id,reason){
  const w=me();if(!w)return;
  const p=plans[id];if(!p)return;
  if(p.cancelReq&&p.cancelReq.by&&p.cancelReq.by!==w){agreeCancel(id);return;}
  p.cancelReq={by:w,reason:reason||'',at:Date.now()};
  save(p,'cancelReq',reason||'');
}
function withdrawCancel(id){
  const w=me();if(!w)return;
  const p=plans[id];if(!p)return;
  if(!p.cancelReq||p.cancelReq.by!==w)return;   // only the requester withdraws
  p.cancelReq=null;save(p,'withdrawn');
}
function agreeCancel(id){
  const p=plans[id];if(!p)return;
  // A dropped plan cannot still be carrying a change waiting to be approved.
  p.pendingEdit=null;
  p.stage='dropped';save(p,'cancelled');
}
// "Keep the plan" on a cancel request I did not file: clear it. Either party may
// clear a request they are the counterparty to by declining to agree.
function withdrawOther(id){const p=plans[id];if(!p)return;p.cancelReq=null;save(p,'kept');}

// ── Finishing ───────────────────────────────────────────────────────────────
// Done is two-sided for the same reason confirming is: a plan is something you
// BOTH agreed to, so one person cannot declare it settled on the other's behalf.
// Each side records its own mark and the stage only becomes 'done' when both
// are in — the identical structural rule as isConfirmed(), so a one-sided "done"
// is impossible to manufacture rather than merely discouraged.
//
// Until then the plan stays Confirmed and its TaskHub items stay on the grid.
function isDone(p){return !!(p&&p.dones&&p.dones.veda&&p.dones.tony);}
function markDone(id){
  const w=me();if(!w)return;
  const p=plans[id];if(!p)return;
  p.dones=p.dones||{veda:null,tony:null};
  if(p.dones[w])return;                          // already marked by me
  p.dones[w]=Date.now();
  const both=isDone(p);
  // A finished plan cannot still be carrying a change waiting to be approved —
  // approving it afterwards would silently rewrite something already settled.
  if(both){p.stage='done';p.pendingEdit=null;}
  save(p,both?'done':'doneReq');
}
// Take back MY OWN mark while the other side has not matched it yet.
function unmarkDone(id){
  const w=me();if(!w)return;
  const p=plans[id];if(!p)return;
  if(!p.dones||!p.dones[w])return;
  p.dones[w]=null;
  save(p,'undone');
}
// "Not yet" against a mark I am the counterparty to — the same shape as clearing
// a cancel request you did not file. Disagreeing is how the two-sidedness earns
// its keep, so it has to be one press.
function rejectDone(id){
  const w=me();if(!w)return;
  const p=plans[id];if(!p)return;
  const o=other(w);
  if(!p.dones||!p.dones[o])return;
  p.dones[o]=null;
  save(p,'notDone');
}
// Every reset that clears confirms must clear the done marks too. A stale mark
// surviving a decline / restore / material edit would silently re-complete the
// plan the moment it was confirmed again. A pending edit goes with them: it is a
// change proposed against a version of the plan that no longer exists, so
// approving it later would resurrect stale wording nobody agreed to.
function clearProgress(p){p.dones={veda:null,tony:null};p.pendingEdit=null;}

// A plan confirmed for Saturday that silently becomes a plan for Tuesday is the
// original problem wearing a disguise — so a change to the title, date or time of
// an AGREED plan is not applied by the person making it. Editing notes alone is
// never material and applies straight away.
// The wall clock a FORM shows for this plan, in the zone of whoever is looking.
// Every "has it actually changed?" test has to go through this. The stored time
// is in the zone it was ENTERED in (p.tz), while a date/time input always shows
// and returns local wall clock — so comparing the raw strings reports a change
// on a plan nobody touched, the moment the two of you are in different zones.
// Concretely: Veda's 7:00 PM New York plan opens as 5:00 PM on Tony's Denver
// screen, and pressing Save without typing anything asked her to approve a
// "move" to the very same instant.
function localSlot(p){return (p&&p.time)?(toLocalHHMM(p.time,p.tz,p.date)||''):'';}
function sameSlot(p,d,tm){
  return (p.date||null)===(d||null)&&(localSlot(p)||null)===(tm||null);
}
function isMaterialEdit(p,t,d,tm){
  return p.title!==t||!sameSlot(p,d,tm);
}
// Is there a change sitting on this plan waiting for someone to say yes?
function pendingEdit(p){return (p&&p.pendingEdit&&p.pendingEdit.by)?p.pendingEdit:null;}
// Whose call is it? null when there is no pending edit.
function pendingEditFor(p){const pe=pendingEdit(p);return pe?other(pe.by):null;}
// What the plan would become. Used for the before/after the approver is shown and
// by the approve path, so the two can never describe different outcomes.
function pendingEditFields(p){
  const pe=pendingEdit(p);if(!pe)return null;
  return {title:pe.title||'',notes:pe.notes||'',date:pe.date||null,time:pe.time||null,tz:pe.tz||null};
}
function applyEdit(id,t,notes,d,tm){
  const w=me();if(!w)return Promise.resolve('noop');
  const p=plans[id];if(!p)return Promise.resolve('noop');
  const agreed=(p.stage==='confirmed'||isConfirmed(p));
  const material=isMaterialEdit(p,t,d,tm);
  if(!(material&&agreed)){
    // Not a change to an agreed commitment: no consent is being asserted from
    // anyone, so it applies immediately with nothing to verify.
    p.title=t;p.notes=notes||'';p.date=d||null;p.time=tm||null;p.tz=tm?myTz():null;
    save(p,'tweaked');return Promise.resolve('ok');
  }
  // ── Pending edit ──────────────────────────────────────────────────────────
  // The plan itself is NOT touched. It stays confirmed, stays on both TaskHubs
  // and stays exactly as the two of you agreed it, until the other person
  // approves the change. One person cannot rewrite a shared commitment alone —
  // that is the same rule as confirming, cancelling and finishing one.
  //
  // Proposing the change re-asserts the editor's own consent to the NEW version,
  // so it is verified exactly like a confirm and the stamp is carried on the
  // pending record. On approval it becomes that person's confirm signature, so
  // the finished plan still shows two real, separately-made confirmations.
  //
  // Notes travel with the pending edit rather than applying immediately: half of
  // a change landing and half waiting would be its own kind of surprise.
  return park(id,'edit',{title:t,notes:notes||'',date:d||null,time:tm||null},
    'editReq',t!==p.title?('“'+t+'”'):'');
}

// ── Reschedule ──────────────────────────────────────────────────────────────
// Moving an agreed plan to another day or time is the change people actually
// make, and it is the one with real consequences for someone else's day — so it
// gets its own action rather than hiding inside Edit, and it moves ONLY the
// slot: title and notes are carried through untouched, which is what makes
// "approve the new time" a question the other person can answer at a glance.
//
// The approval machinery is deliberately the SAME one Edit uses. A second,
// parallel two-sided flow would be a second place for the two of you to get out
// of step; `kind` on the parked record is all that differs, and it only chooses
// which words are used.
function proposeReschedule(id,d,tm,reason){
  const w=me();if(!w)return Promise.resolve('noop');
  const p=plans[id];if(!p)return Promise.resolve('noop');
  const nd=d||null,ntm=tm||null;
  // Nothing actually moved — refuse rather than send the other person a
  // notification about a change that is not a change. Compared through
  // sameSlot, so re-submitting the form untouched is a no-op even when the plan
  // was set in the other person's time zone.
  if(sameSlot(p,nd,ntm))return Promise.resolve('nochange');
  if(!(p.stage==='confirmed'||isConfirmed(p))){
    // Not yet a shared commitment, so there is nobody whose day this disrupts:
    // moving an idea or an unconfirmed proposal just moves it.
    p.date=nd;p.time=ntm;p.tz=ntm?myTz():null;
    save(p,'tweaked');return Promise.resolve('ok');
  }
  return park(id,'move',{title:p.title,notes:p.notes||'',date:nd,time:ntm,why:reason||''},
    'moveReq',reason||'');
}

// Park a proposed change on the record and tell the other person. Shared by
// applyEdit and proposeReschedule so there is exactly one way a change can be
// waiting, and exactly one way it can be answered.
function park(id,kind,fields,notifKind,extra){
  const w=me();if(!w)return Promise.resolve('noop');
  return bioVerify(w).then(ok=>{
    const q=plans[id];if(!q)return 'noop';
    q.pendingEdit={by:w,at:Date.now(),kind:kind,
      title:fields.title,notes:fields.notes||'',
      date:fields.date||null,time:fields.time||null,
      why:fields.why||'',
      tz:fields.time?myTz():null,meta:stamp(ok)};
    save(q,notifKind,extra||'');
    return 'pending';
  });
}

// The other person says yes. Only now does the plan actually change — and it
// stays confirmed throughout, so it never blinks off either TaskHub.
// Approving is consent to the new version, so it is verified like a confirm.
function approveEdit(id){
  const w=me();if(!w)return Promise.resolve('noop');
  const p=plans[id];if(!p)return Promise.resolve('noop');
  const pe=pendingEdit(p);
  if(!pe||pe.by===w)return Promise.resolve('noop');   // never approve your own
  const enrolled=bioEnrolled(w);
  return bioVerify(w).then(ok=>{
    if(enrolled&&!ok)return 'bioFailed';
    const q=plans[id];if(!q)return 'noop';
    const cur=pendingEdit(q);
    if(!cur||cur.by===w)return 'noop';                // withdrawn while we asked
    q.title=cur.title||'';q.notes=cur.notes||'';
    q.date=cur.date||null;q.time=cur.time||null;q.tz=cur.time?(cur.tz||null):null;
    // Both signatures are re-stamped against the version that now exists: the
    // proposer's from when they made the change, mine from right now. Anything
    // less would leave a confirmed plan whose signatures were given for wording
    // that is no longer on it.
    q.confirms={veda:null,tony:null};
    q.confirms[cur.by]=cur.at||Date.now();
    q.confirms[w]=Date.now();
    q.confirmMeta={};
    q.confirmMeta[cur.by]=cur.meta||stamp(false);
    q.confirmMeta[w]=stamp(ok);
    q.stage='confirmed';
    const wasMove=(cur.kind==='move');
    q.pendingEdit=null;
    // A move's "from" is gone from the record by now, so the new slot travels as
    // the extra — otherwise the approval notice could not say what was agreed.
    save(q,wasMove?'moveOK':'editOK',
      wasMove?(q.date?(fmtDate(q.date)+(q.time?' at '+fmtTime(q.time,q.date,q.tz):'')):'undated'):'');
    return 'ok';
  });
}
// "No" to a change I am the counterparty to. The plan is untouched — that is the
// whole point — so this only clears the request. The refusal notice is built
// BEFORE the record is cleared: it names the slot the plan keeps, which
// planMsg reads off the plan itself.
function rejectEdit(id){
  const w=me();if(!w)return;
  const p=plans[id];if(!p)return;
  const pe=pendingEdit(p);
  if(!pe||pe.by===w)return;
  const kind=(pe.kind==='move')?'moveNo':'editNo';
  p.pendingEdit=null;save(p,kind);
}
// Taking back my own proposed change before it is answered.
function withdrawEdit(id){
  const w=me();if(!w)return;
  const p=plans[id];if(!p)return;
  const pe=pendingEdit(p);
  if(!pe||pe.by!==w)return;
  const kind=(pe.kind==='move')?'moveGone':'editGone';
  p.pendingEdit=null;save(p,kind);
}

// Deleting a CONFIRMED plan needs the same two-sided flow as cancelling — one
// person cannot unilaterally erase something both agreed to. Everything else
// (ideas, proposed, archived) either person may delete outright.
function needsTwoSidedDelete(id){
  const p=plans[id];
  return !!(p&&p.stage==='confirmed'&&isConfirmed(p));
}

// ── Overdue ─────────────────────────────────────────────────────────────────
// A confirmed plan whose day has been and gone without both of you finishing it.
// It is deliberately NOT an archive state: nothing has been decided, the plan is
// still live and still on both TaskHubs — it has simply stopped being upcoming.
function planTodayKey(){
  const n=new Date(),p=x=>String(x).padStart(2,'0');
  return n.getFullYear()+'-'+p(n.getMonth()+1)+'-'+p(n.getDate());
}
// Dates are plain YYYY-MM-DD, so a string compare against today IS the date
// compare — and it is done in the reader's own local day, which is what "the day
// has passed" means to the person looking at it.
function isOverdue(p){
  return !!(p&&p.date&&p.stage==='confirmed'&&isConfirmed(p)&&!isDone(p)
    &&p.date<planTodayKey());
}

// ── Buckets ─────────────────────────────────────────────────────────────────
function bucket(){
  const w=me();
  const all=Object.keys(plans).map(k=>plans[k]).filter(Boolean);
  const byDate=(a,b)=>{
    const ad=a.date||'9999-99-99',bd=b.date||'9999-99-99';
    if(ad!==bd)return ad<bd?-1:1;
    return (a.createdAt||0)-(b.createdAt||0);
  };
  const newest=(a,b)=>(b.updatedAt||0)-(a.updatedAt||0);
  const conf=all.filter(p=>p.stage==='confirmed'&&isConfirmed(p));
  // Awaiting MY confirm, plus confirmed plans where the OTHER person proposed a
  // change, asked to cancel, or marked it done, and it is now my call.
  // Written as one predicate rather than concatenated filters so a plan carrying
  // two of those at once can only ever appear in this list once.
  const needsMe=(p)=>{
    if(!w)return false;
    if(p.stage==='proposed')return !!(p.confirms&&!p.confirms[w]);
    if(!(p.stage==='confirmed'&&isConfirmed(p)))return false;
    if(p.pendingEdit&&p.pendingEdit.by&&p.pendingEdit.by!==w)return true;
    if(p.cancelReq&&p.cancelReq.by&&p.cancelReq.by!==w)return true;
    if(p.dones&&p.dones[other(w)]&&!p.dones[w])return true;
    return false;
  };
  return {
    mine:all.filter(needsMe).sort(byDate),
    // Overdue plans leave Confirmed entirely — a section that lists a plan twice
    // makes neither entry mean anything. Newest first: the day you just missed
    // matters more than one from a month ago.
    overdue:conf.filter(isOverdue).sort((a,b)=>a.date<b.date?1:(a.date>b.date?-1:0)),
    confirmed:conf.filter(p=>!isOverdue(p)).sort(byDate),
    proposed:all.filter(p=>w&&p.stage==='proposed'&&p.confirms&&p.confirms[w]).sort(byDate),
    ideas:all.filter(p=>p.stage==='idea').sort(newest),
    archive:all.filter(p=>p.stage==='declined'||p.stage==='dropped'||p.stage==='done').sort(newest)
  };
}

// How many things are genuinely waiting on the active profile. Both TaskHubs
// show this on the Weekly header so a plan needing you is visible without
// opening anything.
function waitingCount(){try{return bucket().mine.length;}catch(e){return 0;}}
window._plansWaitingCount=waitingCount;
// "Needs your response" is per-PROFILE, and a profile switch changes no record
// at all — so nothing would otherwise tell the two TaskHubs to re-derive their
// counts. The profile switcher calls this.
// A switch is also when a profile picked AFTER the plans loaded gets its old
// plans copied into its own Notebook (migrateLegacy needs to know who is here).
window._plansRefreshBadges=function(){emit();if(published)migrateLegacy();};

// ── Boot ────────────────────────────────────────────────────────────────────
// Merge, never replace. `map` is the merged cloud view (every live plan, the
// newest copy of each across both Notebooks and the old shared document) and
// `gone` the ids a tombstone has deleted, with its stamp. A plan can still be
// missing from `map` without being deleted: our own write may not have
// round-tripped yet. Replacing local state wholesale would delete a plan the
// moment after it was created — so a local record newer than the cloud's wins
// until the echo lands.
function ingest(map,gone){
  map=map||{};gone=gone||{};
  const next={};
  Object.keys(map).forEach(k=>{
    const p=map[k];if(!p||!p.id)return;
    // We deleted it here; ignore a copy older than our tombstone.
    if(deleted[p.id]&&(p.updatedAt||0)<=deleted[p.id])return;
    next[p.id]=coerce(p);
  });
  // Once the cloud agrees a deletion happened, stop suppressing that id.
  Object.keys(deleted).forEach(id=>{if(!map[id]||gone[id])delete deleted[id];});
  const removed={};
  Object.keys(plans).forEach(id=>{
    const mine=plans[id],theirs=next[id];
    if(!theirs){
      // Deleted by a tombstone at least as new as our copy: really gone.
      if(gone[id]&&gone[id]>=(mine.updatedAt||0)){removed[id]=mine;return;}
      // Absent remotely with no tombstone. Keep ours only while the write is
      // still in flight; once the cloud has held this id, absence means a
      // field delete (an older page deleting in the old shared document).
      if(!acked[id])next[id]=mine;else removed[id]=mine;
      return;
    }
    if((mine.updatedAt||0)>(theirs.updatedAt||0))next[id]=mine;
  });
  Object.keys(next).forEach(id=>{if(map[id])acked[id]=true;});
  const before=plans;
  plans=next;
  announceArrivals(before,next,removed);
  emit();
}

// ── Arrival banner ──────────────────────────────────────────────────────────
// The other person just did something, and this device is watching the same
// document — so it can say so itself, with no push involved at all.
//
// This exists because push is the one part of the chain nobody controls: a
// browser with notifications switched off, a revoked permission, a dead token,
// a phone that never registered — every one of them ends with a plan quietly
// changing under you. The snapshot listener is already running for the mirror,
// so the news is on this device either way; it just was not being said.
//
// Rules, all of them about not crying wolf:
//   • only what the OTHER person did (lastBy), and only if the record is
//     genuinely newer than the copy we held;
//   • nothing on the first snapshot — a page opening is not an event, and
//     replaying a week of history at boot is worse than saying nothing;
//   • nothing older than FRESH_MS, so a reconnect after a long sleep does not
//     announce yesterday;
//   • once per (id, updatedAt), so repeated snapshots of one write say it once.
const ANNOUNCE_FRESH_MS=15*60*1000;
let announcedFirst=false;
const announced={};
function announceArrivals(before,after,removed){
  if(!announcedFirst){announcedFirst=true;return;}
  const w=me();if(!w)return;
  const now=Date.now();
  Object.keys(after).forEach(id=>{
    const p=after[id];if(!p||!p.lastKind||!p.lastBy)return;
    if(p.lastBy===w)return;                       // my own write echoing back
    const prev=before[id];
    // "Newer than what we held" cannot be a bare timestamp compare. updatedAt
    // comes off the WRITER's clock in whole milliseconds, so two events on one
    // plan can legitimately carry the same stamp — and with `>=` the second one
    // is silently swallowed. Skip only what is genuinely older, or the exact
    // version we already had.
    if(prev&&(prev.updatedAt||0)>(p.updatedAt||0))return;
    if(prev&&(prev.updatedAt||0)===(p.updatedAt||0)
      &&prev.lastKind===p.lastKind&&prev.lastBy===p.lastBy)return;
    if(!p.updatedAt||now-p.updatedAt>ANNOUNCE_FRESH_MS)return;
    const key=id+':'+p.updatedAt+':'+p.lastKind;
    if(announced[key])return;
    announced[key]=now;
    const msg=planMsg(p.lastKind,p.lastBy,p,p.lastExtra||'');
    if(!msg)return;
    try{if(window._thPlanBanner)window._thPlanBanner(msg,w);}catch(e){}
  });
  // A plan the other person deleted is gone from `after`, so it is said from the
  // copy we held (the tombstone carries no more than the title).
  Object.keys(removed||{}).forEach(id=>{
    const t=lastGone[id];if(!t||t.lastBy===w||t.lastBy!==other(w))return;
    if(!t.updatedAt||now-t.updatedAt>ANNOUNCE_FRESH_MS)return;
    const key=id+':'+t.updatedAt+':deleted';
    if(announced[key])return;
    announced[key]=now;
    const msg=planMsg('deleted',t.lastBy,removed[id],'');
    try{if(msg&&window._thPlanBanner)window._thPlanBanner(msg,w);}catch(e){}
  });
  // Keep the seen-set from growing for the life of the tab.
  const ks=Object.keys(announced);
  if(ks.length>200)ks.forEach(k=>{if(now-announced[k]>ANNOUNCE_FRESH_MS)delete announced[k];});
}

// ── The store: both Notebooks, and the old shared document ─────────────────
// See the header. Three listeners, one merged view:
//   legacy   dashboards/plans                read only
//   tony     dashboards/tony_journal_plans   written only on Tony's profile
//   veda     dashboards/journal_plans        written only on Veda's profile
// Nothing is published until all three have answered from the SERVER once: a
// cached copy alone could be days old, and both TaskHubs reconcile their grids
// from what is published here (the phantom reverts the other listeners guard
// against). After that every snapshot counts, cached ones included, so an
// offline edit still shows.
const LEGACY_PATH='dashboards/plans';
const SOURCES=['legacy','tony','veda'];
function planPath(src){
  if(src==='legacy')return LEGACY_PATH;
  const pr=window.Notebook&&window.Notebook.profiles&&window.Notebook.profiles[src];
  return 'dashboards/'+((pr&&pr.plans)||(src==='tony'?'tony_journal_plans':'journal_plans'));
}
let F=null;                 // the host's Firestore helpers, as of the last install
let unsubs=[];
const srcData={legacy:{},tony:{},veda:{}};
const srcSeen={legacy:false,tony:false,veda:false};
let published=false;
let lastGone={};            // id -> the tombstone that deleted it
// A save made while there is no Firestore (before the host's init, or between a
// teardown and the re-init that follows a hidden tab) waits for the next
// install instead of failing: it is a real change and the connection is coming.
let fReady=null,fResolve=null;
function resetReady(){fReady=new Promise(r=>{fResolve=r;});}
resetReady();

// Firestore rejects undefined; null is dropped too, as every reader treats a
// missing field and a null one alike.
function sanitize(v){
  if(Array.isArray(v))return v.map(sanitize);
  if(v&&typeof v==='object'){
    const o={};
    Object.keys(v).forEach(k=>{const x=v[k];if(x!==undefined&&x!==null)o[k]=sanitize(x);});
    return o;
  }
  return v;
}

// Which copy of one plan is the plan. Later updatedAt wins; an exact tie goes to
// the copy that is a tombstone, then to the larger lastBy, so every device picks
// the same one.
function newer(a,b){
  const ta=a.updatedAt||0,tb=b.updatedAt||0;
  if(ta!==tb)return ta>tb;
  if(!!a.deleted!==!!b.deleted)return !!a.deleted;
  return String(a.lastBy||'')>String(b.lastBy||'');
}
function mergedView(){
  const win={};
  SOURCES.forEach(s=>{
    const m=srcData[s];
    Object.keys(m).forEach(id=>{const p=m[id];if(!win[id]||newer(p,win[id]))win[id]=p;});
  });
  const live={},gone={},tombs={};
  Object.keys(win).forEach(id=>{
    const p=win[id];
    if(p.deleted){gone[id]=p.updatedAt||0;tombs[id]=p;}
    else live[id]=coerce(p);
  });
  return {live:live,gone:gone,tombs:tombs};
}
function publish(){
  if(!published){
    if(!SOURCES.every(s=>srcSeen[s]))return;
    published=true;
  }
  const v=mergedView();
  lastGone=v.tombs;
  window._plansLatest=v.live;
  booted=true;
  ingest(v.live,v.gone);
  // Both TaskHubs mirror confirmed plans onto their grids from this event.
  try{window.dispatchEvent(new CustomEvent('fb-plans-update',{detail:v.live}));}catch(e){}
  migrateLegacy();
}
function readDoc(d){
  const m={};
  Object.keys(d||{}).forEach(k=>{
    if(k.indexOf('p_')!==0)return;
    const p=d[k];
    if(p&&typeof p==='object'&&p.id&&('p_'+p.id)===k)m[p.id]=p;
  });
  return m;
}
function listen(src){
  const path=planPath(src);
  const ref=F.doc(F.db(),path);
  const un=F.onSnapshot(ref,{includeMetadataChanges:true},snap=>{
    const md=snap.metadata||{};
    const exists=snap.exists();
    const d=exists?(snap.data()||{}):{};
    if(exists&&!md.fromCache&&!md.hasPendingWrites){try{F.a1b(path,d);}catch(e){}}
    srcData[src]=readDoc(d);
    if(!md.fromCache)srcSeen[src]=true;
    publish();
  },err=>{
    // A document that cannot be read must not hold the other two back: Plans
    // would otherwise show nothing at all. What it held stays as last seen.
    console.warn('[Plans] '+path+' listener failed:',err&&err.code);
    srcSeen[src]=true;
    publish();
  });
  unsubs.push(un);
}
function unsubscribe(){
  unsubs.forEach(u=>{try{u();}catch(e){}});
  unsubs=[];
  if(F){F=null;resetReady();}
}
function install(f){
  unsubscribe();
  F=f;
  SOURCES.forEach(listen);
  fResolve(f);
  refreshBioOK();
}
// Write one record (a plan, or a tombstone) into `who`'s own Notebook. Resolves
// true once the server has it, false on failure; never rejects.
function storeSave(who,rec){
  if(who!=='tony'&&who!=='veda')return Promise.resolve(false);
  let payload;
  try{payload={['p_'+rec.id]:sanitize(rec),savedAt:Date.now(),by:who};}
  catch(e){console.error('[Plans] could not prepare save:',e);return Promise.resolve(false);}
  // A write still in flight when the host tears its Firestore down (the tab hid,
  // the phone froze it) fails with the client it was sent on. It is still a real
  // change, so it is sent once more on the client the re-init brings up.
  const attempt=(retried)=>fReady.then(f=>f.upsert(f.doc(f.db(),planPath(who)),payload,'Plan save')
    .catch(e=>{if(!retried&&F!==f)return attempt(true);throw e;}));
  return attempt(false).then(()=>{
    try{window.dispatchEvent(new CustomEvent('fb-plans-saved'));}catch(e){}
    return true;
  },e=>{
    console.error('[Plans] save failed:',e&&e.code,e&&e.message);
    try{window.dispatchEvent(new CustomEvent('fb-plans-error'));}catch(e2){}
    return false;
  });
}
const store={save:storeSave};

// Plans from before the move live in dashboards/plans. Each side copies the
// ones it authored into its own Notebook, once, unchanged (same updatedAt, so
// the merge does not move). The old document is left as it is: it is the
// backup, and older pages still read it.
let migrating=false;
function migrateLegacy(){
  const w=me();
  if(migrating||!w||!F)return;
  const own=srcData[w];
  const todo=Object.keys(srcData.legacy).filter(id=>{
    const p=srcData.legacy[id];
    if(!p||p.author!==w)return false;
    const mine=own[id];
    return !mine||(mine.updatedAt||0)<(p.updatedAt||0);
  });
  if(!todo.length)return;
  migrating=true;
  const payload={savedAt:Date.now(),by:w};
  todo.forEach(id=>{payload['p_'+id]=sanitize(srcData.legacy[id]);});
  fReady.then(f=>f.upsert(f.doc(f.db(),planPath(w)),payload,'Plans move'))
    .catch(e=>console.warn('[Plans] moving the old plans failed:',e&&e.code))
    .then(()=>{migrating=false;});
}

// The waiting-count badge on both Weekly headers reads the engine as soon as a
// TaskHub mounts; it fills in when the store publishes.
function ensureLoaded(){}

// Notebook's Firestore layer (core/fb.js) hands the host's helpers on.
window.Notebook=window.Notebook||{};
window.Notebook.plansStore={install:install,unsubscribe:unsubscribe,path:planPath};

// ── Public API ──────────────────────────────────────────────────────────────
// Everything a panel needs and nothing about how it looks.
window.PlansCore={
  PEOPLE:PEOPLE, NAMES:NAMES,
  subscribe:subscribe,
  ensureLoaded:ensureLoaded,
  me:me, other:other,
  get:function(id){return plans[id]||null;},
  bucket:bucket, waitingCount:waitingCount,
  isConfirmed:isConfirmed, isDone:isDone, isOverdue:isOverdue,
  isMaterialEdit:isMaterialEdit, sameSlot:sameSlot, confirmFlags:confirmFlags,
  pendingEdit:pendingEdit, pendingEditFor:pendingEditFor,
  pendingEditFields:pendingEditFields,
  needsTwoSidedDelete:needsTwoSidedDelete,
  fmtDate:fmtDate, fmtTime:fmtTime, fmtWhen:fmtWhen, humanGap:humanGap,
  toLocalHHMM:toLocalHHMM,
  deviceId:deviceId,
  bioEnrolled:bioEnrolled, bioLabel:bioLabel, bioEnrol:bioEnrol,
  bioReady:function(){return bioOK;}, refreshBio:refreshBioOK,
  addIdea:addIdea, promote:promote, confirmPlan:confirmPlan, declinePlan:declinePlan,
  restorePlan:restorePlan, requestCancel:requestCancel, withdrawCancel:withdrawCancel,
  agreeCancel:agreeCancel, withdrawOther:withdrawOther,
  markDone:markDone, unmarkDone:unmarkDone, rejectDone:rejectDone,
  applyEdit:applyEdit, approveEdit:approveEdit, rejectEdit:rejectEdit,
  withdrawEdit:withdrawEdit, proposeReschedule:proposeReschedule,
  planMsg:planMsg, removePlan:removePlan
};
// The same API under Notebook, where Plans now lives.
window.Notebook.plans=window.PlansCore;
// Both TaskHubs render before this file runs; their hooks wait for this.
try{window.dispatchEvent(new Event('plans-core-ready'));}catch(e){}
})();
