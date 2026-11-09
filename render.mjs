// Offline frame renderer: drives the film page in Chrome and writes PNG frames.
//
//   node render.mjs --times 1,6.5,12 --w 1920 --h 1080 --spp 4 --out out/stills
//   node render.mjs --from 0 --to 900 --fps 30 --w 3840 --h 2160 --spp 16 --out frames/final
//
// Machine-friendliness: this process drops itself to below-normal priority so
// Chrome and ffmpeg inherit it, waits while free RAM is low, and yields the GPU
// between frames (longer while Blender is busy).
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { startServer } from './server.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const flag = k => argv.includes('--' + k);

const W = +opt('w', 1920), H = +opt('h', 1080);
const FPS = +opt('fps', 30);
const SPP = +opt('spp', 4);
const OUT = path.resolve(ROOT, opt('out', 'out/test'));
const PAGE = opt('page', 'index.html');
const EXTRA = opt('q', '');
const MIN_FREE_GB = +opt('minfree', 6);
const YIELD_MS = +opt('yield', 120);
const SKIP_EXISTING = flag('resume');

let jobs = [];
if (opt('times')) {
  jobs = opt('times').split(',').map(s => +s).map((t, i) => ({ t, name: `t${t.toFixed(2).padStart(6, '0')}` }));
} else {
  const from = +opt('from', 0), to = +opt('to', 30 * FPS), step = +opt('step', 1);
  for (let f = from; f < to; f += step) jobs.push({ t: f / FPS, frame: f, name: `f${String(f).padStart(5, '0')}` });
}

try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
fs.mkdirSync(OUT, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

let blenderCpu = null, blenderBusy = false;
function sampleBlender() {
  return new Promise(resolve => {
    execFile('powershell', ['-NoProfile', '-Command', '(Get-Process blender -ErrorAction SilentlyContinue | Measure-Object CPU -Sum).Sum'], { timeout: 15000 }, (err, out) => {
      const cpu = parseFloat(String(out).trim().replace(',', '.')) || 0;
      const now = Date.now();
      if (blenderCpu) {
        const used = (cpu - blenderCpu.cpu) / ((now - blenderCpu.t) / 1000) / os.cpus().length;
        blenderBusy = used > 0.2;
      }
      blenderCpu = { cpu, t: now };
      resolve();
    });
  });
}

async function guard(i) {
  let warned = false;
  while (os.freemem() / 2 ** 30 < MIN_FREE_GB) {
    if (!warned) { log(`low RAM (${(os.freemem() / 2 ** 30).toFixed(1)} GB free) - waiting`); warned = true; }
    await sleep(5000);
  }
  if (i % 15 === 0) await sampleBlender();
  await sleep(blenderBusy ? YIELD_MS * 6 : YIELD_MS);
}

// Machine-wide semaphore: at most MAX_JOBS render processes hold the GPU at once
// (parallel look-dev agents queue here instead of piling onto the iGPU).
const MAX_JOBS = +opt('maxjobs', 2);
const LOCKDIR = path.join(os.tmpdir(), 'film-render-locks');
fs.mkdirSync(LOCKDIR, { recursive: true });
let lockFile = null;
async function acquireSlot() {
  for (let waited = 0; ; waited++) {
    for (let s = 0; s < MAX_JOBS; s++) {
      const f = path.join(LOCKDIR, `slot${s}.lock`);
      try {
        const fd = fs.openSync(f, 'wx'); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd);
        lockFile = f; return;
      } catch {
        // stale lock (owner gone)?
        try { const pid = +fs.readFileSync(f, 'utf8'); process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') { try { fs.unlinkSync(f); } catch {} } }
      }
    }
    if (waited % 30 === 0) log('waiting for a render slot...');
    await sleep(2000);
  }
}
const releaseSlot = () => { if (lockFile) { try { fs.unlinkSync(lockFile); } catch {} lockFile = null; } };
process.on('exit', releaseSlot);
process.on('SIGINT', () => { releaseSlot(); process.exit(130); });
process.on('SIGTERM', () => { releaseSlot(); process.exit(143); });
await acquireSlot();

const PROFILE = path.join(os.tmpdir(), `film-chrome-${process.pid}`);
process.on('exit', () => { try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {} });
const server = await startServer(0);
const port = server.address().port;
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  userDataDir: PROFILE,
  protocolTimeout: 0,
  args: [
    '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--force-device-scale-factor=1',
    '--js-flags=--max-old-space-size=8192', '--window-size=960,540', '--mute-audio',
  ],
});

let failed = false;
try {
  const page = await browser.newPage();
  page.on('console', m => { const s = m.text(); if (!s.startsWith('[v]')) log('page:', s); });
  page.on('pageerror', e => { log('PAGE ERROR:', e.message); failed = true; });
  await page.setViewport({ width: 960, height: 540 });
  const url = `http://127.0.0.1:${port}/${PAGE}?w=${W}&h=${H}&spp=${SPP}&fps=${FPS}${EXTRA ? '&' + EXTRA : ''}`;
  log('open', url);
  await page.goto(url, { waitUntil: 'load', timeout: 0 });
  await page.waitForFunction('window.__film && window.__film.ready === true || window.__film?.error', { timeout: 0, polling: 250 });
  const err = await page.evaluate('window.__film.error || null');
  if (err) throw new Error('init failed: ' + err);
  log('ready:', await page.evaluate('window.__film.info'));

  const t0 = Date.now();
  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i];
    const file = path.join(OUT, j.name + '.png');
    if (SKIP_EXISTING && fs.existsSync(file) && fs.statSync(file).size > 0) continue;
    await guard(i);
    const ts = Date.now();
    const b64 = await page.evaluate(t => window.__film.renderFrame(t), j.t);
    if (!b64 || failed) throw new Error('render failed at t=' + j.t);
    fs.writeFileSync(file + '.tmp', Buffer.from(b64, 'base64'));
    fs.renameSync(file + '.tmp', file);
    const dt = (Date.now() - ts) / 1000;
    const done = i + 1, eta = ((Date.now() - t0) / done) * (jobs.length - done) / 1000;
    log(`${j.name} t=${j.t.toFixed(3)} ${dt.toFixed(2)}s  [${done}/${jobs.length}] eta ${(eta / 60).toFixed(1)}m  freeRAM ${(os.freemem() / 2 ** 30).toFixed(1)}G${blenderBusy ? ' (blender busy)' : ''}`);
    const stats = await page.evaluate('window.__film.stats || null');
    if (stats && (i === 0 || flag('stats'))) log('stats:', JSON.stringify(stats));
  }
  if (flag('sheet') && opt('times')) {
    const cols = Math.min(jobs.length, +opt('cols', 3));
    const files = jobs.map(j => path.join(OUT, j.name + '.png'));
    const inputs = files.flatMap(f => ['-i', f]);
    const sw = Math.round(+opt('sheetw', 1920) / cols / 2) * 2, sh = Math.round(sw * H / W / 2) * 2;
    const filters = files.map((_, k) => `[${k}:v]scale=${sw}:${sh}[s${k}]`).join(';');
    const rows = Math.ceil(files.length / cols);
    const layout = files.map((_, k) => `${(k % cols) * sw}_${Math.floor(k / cols) * sh}`).join('|');
    const stack = files.length > 1 ? `${files.map((_, k) => `[s${k}]`).join('')}xstack=inputs=${files.length}:layout=${layout}:fill=black` : '[s0]null';
    execFileSync('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', `${filters};${stack}`, '-q:v', '2', path.join(OUT, '_sheet.jpg')]);
    log('sheet', path.join(OUT, '_sheet.jpg'), `${cols}x${rows}`);
  }
  log(`done ${jobs.length} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} catch (e) {
  log('FAILED', e.message);
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  server.close();
}
