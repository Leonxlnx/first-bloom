// Renders the critique review set: key-moment stills (1080p) + motion strips.
//   node review.mjs --out out/review_01
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const OUT = path.resolve(ROOT, opt('out', 'out/review'));
const Q = opt('q', '');
const STILLS = {
  macro: [1.0, 3.6, 5.6, 6.12, 6.35, 7.0, 7.4],
  fpv: [8.3, 9.9, 10.9, 12.4, 13.6, 14.16, 15.0],
  canopy: [15.7, 16.2],
  reveal: [17.4, 18.8, 20.4],
  falls: [21.0, 22.0, 23.3],
  aerial: [24.3, 25.6, 27.6, 29.0],
};
const STRIPS = { hit: 5.96, wavefront: 10.0, swift: 14.1, whiteout: 16.5, shatter: 20.7 };

function render(times, w, h, spp, out) {
  const r = spawnSync(process.execPath, ['render.mjs', '--q', `world=film${Q ? '&' + Q : ''}`, '--times', times.join(','), '--w', String(w), '--h', String(h), '--spp', String(spp), '--out', out], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (r.status !== 0) { console.log(r.stdout.slice(-2000), r.stderr.slice(-2000)); throw new Error('render failed'); }
}
function sheet(files, cols, sw, out) {
  const inputs = files.flatMap(f => ['-i', f]);
  const sh = Math.round(sw * 9 / 16 / 2) * 2;
  const fil = files.map((f, k) => `[${k}:v]scale=${sw}:${sh},drawtext=text='${path.basename(f, '.png').replace('t0', '').replace('t', '')}s':x=8:y=8:fontsize=${Math.round(sw / 22)}:fontcolor=white:box=1:boxcolor=black@0.45[s${k}]`).join(';');
  const layout = files.map((_, k) => `${(k % cols) * sw}_${Math.floor(k / cols) * sh}`).join('|');
  const stack = files.length > 1 ? `${files.map((_, k) => `[s${k}]`).join('')}xstack=inputs=${files.length}:layout=${layout}:fill=black` : '[s0]null';
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', `${fil};${stack}`, '-q:v', '2', out], { stdio: ['ignore', 'ignore', 'ignore'] });
}

fs.mkdirSync(OUT, { recursive: true });
const all = Object.values(STILLS).flat();
console.log('stills...');
render(all, 1920, 1080, 4, path.join(OUT, 'stills'));
for (const [shot, times] of Object.entries(STILLS)) {
  const files = times.map(t => path.join(OUT, 'stills', `t${t.toFixed(2).padStart(6, '0')}.png`));
  sheet(files, Math.min(4, files.length), 640, path.join(OUT, `sheet_${shot}.jpg`));
}
console.log('strips...');
for (const [name, t0] of Object.entries(STRIPS)) {
  const ts = Array.from({ length: 6 }, (_, k) => +(t0 + k / 30).toFixed(4));
  render(ts, 960, 540, 6, path.join(OUT, 'strip_' + name));
  const files = ts.map(t => path.join(OUT, 'strip_' + name, `t${t.toFixed(2).padStart(6, '0')}.png`)).filter(f => fs.existsSync(f));
  sheet(files, 3, 640, path.join(OUT, `strip_${name}.jpg`));
}
console.log('review set at', OUT);
