const PORT=9334;
(async()=>{
  const list=await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const t=list.find(x=>x.type==='page');
  const ws=new WebSocket(t.webSocketDebuggerUrl);
  let id=0; const pend=new Map();
  ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){const p=pend.get(m.id);pend.delete(m.id);m.error?p.rej(new Error(JSON.stringify(m.error))):p.res(m.result);}};
  const send=(method,params={})=>new Promise((res,rej)=>{const i=++id;pend.set(i,{res,rej});ws.send(JSON.stringify({id:i,method,params}));});
  await new Promise(r=>ws.onopen=r);
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate',{url:'http://127.0.0.1:8778/studyos/fsprobe.html'});
  await new Promise(r=>setTimeout(r,1500));
  const r=await send('Runtime.evaluate',{expression:'JSON.stringify(window.probe)',returnByValue:true});
  console.log('File System Access support:', r.result.value);
  // Can a directory handle round-trip through IndexedDB (the persistence trick)?
  const rt=await send('Runtime.evaluate',{expression:`
    new Promise(res=>{
      var r=indexedDB.open('probe_db',1);
      r.onupgradeneeded=e=>e.target.result.createObjectStore('h');
      r.onsuccess=e=>{ res('idb-ok'); };
      r.onerror=()=>res('idb-fail');
    })`,returnByValue:true,awaitPromise:true});
  console.log('idb:', rt.result.value);
  ws.close();
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
