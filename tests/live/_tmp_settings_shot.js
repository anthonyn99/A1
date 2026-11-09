process.env.CDP_PORT='9351';
const fs=require('fs');const {connect,evalJs,sleep,shotPath}=require('./cdp.js');const {firebaseMock}=require('./fake-firebase.js');
(async()=>{const c=await connect({mock:firebaseMock({})});await c.send('Page.enable');await c.send('Emulation.setDeviceMetricsOverride',{width:1200,height:900,deviceScaleFactor:1,mobile:false});
const js=e=>evalJs(c,e);await c.send('Page.navigate',{url:'https://anthonyn99.github.io/A1/Shared/tni.js'});await sleep(300);
await js(`localStorage.clear();localStorage.setItem('a1b_disabled','1');`);await c.send('Page.navigate',{url:'https://anthonyn99.github.io/A1/index.html'});
for(let i=0;i<200&&!(await js('!!window._profileGoTony&&!!window._openSettings'));i++)await sleep(100);
for(const p of ['tony','veda']){await js(`window._profileGo${p==='tony'?'Tony':'Veda'}();`);await sleep(1500);await js(`window._openSettings('${p}');`);await sleep(800);
const r=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(shotPath('settings-'+p),Buffer.from(r.result.data,'base64'));await js(`document.querySelector('#thset-box .thset-close').click();`);}
process.exit(0);})();
