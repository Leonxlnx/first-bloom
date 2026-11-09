// Final-round re-render: only the frame ranges the fixes touch. The v1 frames of
// each range are moved to frames/v1 first (restore them from there if needed).
//   node rerender_v2.mjs [--only aerial,falls]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const ONLY = opt('only', '');
const OUT = path.join(ROOT, 'frames/final'), BAK = path.join(ROOT, 'frames/v1');
fs.mkdirSync(BAK, { recursive: true });

// [name, first, endExclusive, spp] in priority order (highest value first)
const RANGES = [
  ['aerial', 711, 900, 10],
  ['shatter', 622, 638, 28],
  ['falls', 638, 711, 12],
  ['fpvCreek', 281, 366, 16],
  ['reveal', 504, 622, 12],
  ['pull', 201, 226, 16],
  ['canopy', 462, 504, 20],
];

const run = args => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  p.on('exit', code => (code === 0 ? resolve() : reject(new Error('render exit ' + code))));
});
const name = f => `f${String(f).padStart(5, '0')}.png`;

for (const [seg, a, b, spp] of RANGES) {
  if (ONLY && !ONLY.split(',').includes(seg)) continue;
  // move v1 frames aside once (a v1 copy already in BAK means this range was started before)
  for (let f = a; f < b; f++) {
    const src = path.join(OUT, name(f)), dst = path.join(BAK, name(f));
    if (fs.existsSync(src) && !fs.existsSync(dst)) fs.renameSync(src, dst);
  }
  console.log(`=== ${seg}: frames ${a}-${b - 1} spp ${spp}  ${new Date().toLocaleTimeString()}`);
  await run(['render.mjs', '--q', 'world=film', '--from', String(a), '--to', String(b), '--fps', '30', '--w', '3840', '--h', '2160',
    '--spp', String(spp), '--out', 'frames/final', '--resume', '--maxjobs', '1', '--yield', '150']);
}
console.log('rerender done', new Date().toLocaleTimeString());
