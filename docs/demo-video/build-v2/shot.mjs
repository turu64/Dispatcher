import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
const [url, out] = process.argv.slice(2);
const prof = mkdtempSync(tmpdir() + '/chprof-');
const ch = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new','--remote-debugging-port=9333',`--user-data-dir=${prof}`,'--window-size=1920,1080','--hide-scrollbars','--enable-unsafe-swiftshader','--use-angle=swiftshader','--enable-webgl','--ignore-gpu-blocklist','about:blank'], {stdio:'ignore'});
const sleep = ms => new Promise(r => setTimeout(r, ms));
let tabs; for (let i=0;i<50;i++){ try { tabs = await (await fetch('http://127.0.0.1:9333/json')).json(); break } catch { await sleep(200) } }
const ws = new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pend = {};
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id] } };
const send = (method, params={}) => new Promise(r => { const i=++id; pend[i]=r; ws.send(JSON.stringify({id:i,method,params})) });
await send('Emulation.setDeviceMetricsOverride',{width:1920,height:1080,deviceScaleFactor:1,mobile:false});
await send('Page.navigate',{url});
let st='';
for (let i=0;i<150;i++){ await sleep(200); const r = await send('Runtime.evaluate',{expression:'JSON.stringify(document.body&&document.body.dataset)',returnByValue:true}); st=r.result?.result?.value||''; if (st.includes('idle')||st.includes('"e"')) break }
console.log('state', st); const c = await send('Runtime.evaluate',{expression:'(()=>{const c=document.createElement("canvas");return String(!!c.getContext("webgl2"))+" "+String(!!c.getContext("webgl"))})()',returnByValue:true}); console.log('gl', c.result?.result?.value);
await sleep(500);
const s = await send('Page.captureScreenshot',{format:'png'});
writeFileSync(out, Buffer.from(s.result.data,'base64'));
ws.close(); ch.kill();
