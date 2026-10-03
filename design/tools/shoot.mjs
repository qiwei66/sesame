// Screenshot prototype states through the shared debug Chrome (127.0.0.1:9222).
// Opens its own background tab, captures at 2x, closes the tab.
// usage: node shoot.mjs 4 4d 6 ...   (append @16x9 for the 1280×720 promo crop on the graphite backdrop: 4@16x9 4d@16x9)
import { writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';

const NAMES = { 1: '01-listening', 2: '02-intent', 3: '03-success',  5: '05-info-disk',
  6: '06-candidates', 7: '07-confirm', 8: '08-english', 9: '09-menubar', 0: '10-not-found',
  4: '11-first-run', '4s': '11c-first-run-shared', c: '17-share-card-proto', h: '11b-first-run-hotkey-taken', t1: '12a-typing-many', t2: '12b-typing-one', t3: '12c-typing-none', v: '13-hold-to-talk', m: '14-mic-permission', s: '15-settings-login', k: '16a-takeover-spotlight', k3: '16c-takeover-done' };
const OUT = `${homedir()}/.voice-agent-oss/design/png`;
const FILE = `file://${homedir()}/.voice-agent-oss/design/prototype.html`;
mkdirSync(OUT, { recursive: true });

const ver = await (await fetch('http://127.0.0.1:9222/json/version')).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.j(new Error(JSON.stringify(m.error))) : p.r(m.result); } };
const send = (method, params = {}, sessionId) => new Promise((r, j) => { const id = ++seq; pending.set(id, { r, j }); ws.send(JSON.stringify({ id, method, params, sessionId })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { targetId } = await send('Target.createTarget', { url: 'about:blank', background: true, newWindow: false });
try {
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false }, sessionId);
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
  for (const arg of process.argv.slice(2)) {
    const promo = arg.endsWith('@16x9'); const st = promo ? arg.slice(0, -5) : arg;
    const dark = st.endsWith('d') && NAMES[st] === undefined; const base = dark ? st.slice(0, -1) : st;
    const name = NAMES[base] + (dark ? '-dark' : '') + (promo ? '-16x9' : '');
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: promo ? 720 : 800, deviceScaleFactor: 2, mobile: false }, sessionId);
    await send('Page.navigate', { url: `${FILE}?shot=1${promo ? '&promo=1' : ''}&r=${Date.now()}#${st}` }, sessionId);
    await sleep(1200);
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
    const buf = Buffer.from(data, 'base64');
    writeFileSync(`${OUT}/${name}.png`, buf);
    console.log(`${st} -> ${OUT}/${name}.png ${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`);
  }
} finally {
  await send('Target.closeTarget', { targetId });
  ws.close();
}
