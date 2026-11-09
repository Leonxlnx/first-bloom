// Fast review: renders a low-res full sequence (or a range) and encodes it with
// the current mix, plus a 1-frame-per-second contact sheet.
//   node preview.mjs [--w 960 --h 540 --spp 2 --step 1 --from 0 --to 900 --out frames/preview]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const W = opt('w', '960'), H = opt('h', '540'), SPP = opt('spp', '2'), STEP = +opt('step', 1);
const FROM = opt('from', '0'), TO = opt('to', '900'), OUT = opt('out', 'frames/preview'), Q = opt('q', '');
const r = spawnSync(process.execPath, ['render.mjs', '--q', `world=film${Q ? '&' + Q : ''}`, '--from', FROM, '--to', TO, '--step', String(STEP), '--w', W, '--h', H, '--spp', SPP, '--out', OUT, '--resume', '--yield', '40'], { cwd: ROOT, stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status);
const dir = path.resolve(ROOT, OUT);
const files = fs.readdirSync(dir).filter(n => /^f\d{5}\.png$/.test(n)).sort();
// contiguous sequence for ffmpeg (holds frames when step > 1)
const list = path.join(dir, '_list.txt');
fs.writeFileSync(list, files.map(n => `file '${path.join(dir, n).replace(/\\/g, '/')}'\nduration ${(STEP / 30).toFixed(5)}`).join('\n'));
const mix = path.resolve(ROOT, opt('mix', 'out/mix.wav'));
const audio = fs.existsSync(mix) ? ['-i', mix, '-c:a', 'aac', '-b:a', '192k'] : [];
const mp4 = path.resolve(ROOT, opt('mp4', 'out/preview.mp4'));
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, ...audio, '-r', '30', '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-threads', '4', '-shortest', mp4], { stdio: 'inherit' });
// contact sheet: one frame per second
const per = files.filter(n => (+n.slice(1, 6)) % 30 === 0);
const sheet = path.resolve(ROOT, opt('sheet', 'out/preview_sheet.jpg'));
const inputs = per.flatMap(n => ['-i', path.join(dir, n)]);
const cols = 6, sw = 320, sh = Math.round(sw * +H / +W / 2) * 2;
const fil = per.map((_, k) => `[${k}:v]scale=${sw}:${sh},drawtext=text='${(+per[k].slice(1, 6) / 30).toFixed(0)}s':x=6:y=6:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.4[s${k}]`).join(';');
const layout = per.map((_, k) => `${(k % cols) * sw}_${Math.floor(k / cols) * sh}`).join('|');
execFileSync('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', `${fil};${per.map((_, k) => `[s${k}]`).join('')}xstack=inputs=${per.length}:layout=${layout}:fill=black`, '-q:v', '3', sheet]);
console.log('preview', mp4, 'sheet', sheet);
