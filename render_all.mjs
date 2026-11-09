// Renders the whole film shot by shot (per-shot subframe counts), resumable,
// then encodes the master MP4 with the mixed soundtrack.
//   node render_all.mjs --w 3840 --h 2160 --out frames/final [--mix out/mix.wav] [--only fpv,reveal] [--encode-only]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TIMES } from './src/world/timeline.js';

try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const flag = k => argv.includes('--' + k);
const W = +opt('w', 3840), H = +opt('h', 2160), FPS = 30;
const OUT = opt('out', 'frames/final');
const MIX = opt('mix', 'out/mix.wav');
const ONLY = opt('only', '');
const SPP_SCALE = +opt('sppscale', 1);
const EXTRA = opt('q', '');

const f = t => Math.round(t * FPS);
// [name, firstFrame, endFrame(exclusive), spp]
// subframes per frame: dense where motion is fastest (burst, swift, shatter)
const SEGMENTS = [
  ['macro', 0, f(TIMES.hit - 0.1), 12],
  ['burst', f(TIMES.hit - 0.1), f(TIMES.pullStart), 32],
  ['pull', f(TIMES.pullStart), f(TIMES.cut2), 16],
  ['fpv', f(TIMES.cut2), f(TIMES.swift - 0.16), 16],
  ['swift', f(TIMES.swift - 0.16), f(TIMES.swift + 0.24), 32],
  ['fpv2', f(TIMES.swift + 0.24), f(TIMES.cut3), 16],
  ['canopy', f(TIMES.cut3), f(TIMES.cut4), 20],
  ['reveal', f(TIMES.cut4), f(TIMES.cut5), 12],
  ['shatter', f(TIMES.cut5), f(TIMES.cut5 + 0.55), 28],
  ['falls', f(TIMES.cut5 + 0.55), f(TIMES.cut6), 12],
  ['aerial', f(TIMES.cut6), f(TIMES.end), 10],
];

function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
    p.on('exit', code => (code === 0 ? resolve() : reject(new Error('render exit ' + code))));
  });
}

if (!flag('encode-only')) {
  for (const [name, a, b, spp] of SEGMENTS) {
    if (ONLY && !ONLY.split(',').includes(name)) continue;
    const s = Math.max(1, Math.round(spp * SPP_SCALE));
    console.log(`=== ${name}: frames ${a}-${b - 1} spp ${s}`);
    await run(['render.mjs', '--q', `world=film${EXTRA ? '&' + EXTRA : ''}`, '--from', String(a), '--to', String(b), '--fps', String(FPS), '--w', String(W), '--h', String(H), '--spp', String(s), '--out', OUT, '--resume', '--maxjobs', '1', '--yield', '150']);
  }
}

// ---- encode (skip with --no-encode when finalize.mjs makes the deliverables)
if (flag('no-encode')) process.exit(0);
const frames = path.resolve(ROOT, OUT);
const have = fs.readdirSync(frames).filter(n => /^f\d{5}\.png$/.test(n)).length;
console.log('frames present:', have);
const mp4 = path.resolve(ROOT, opt('mp4', `out/first_bloom_${W}x${H}.mp4`));
const mix = path.resolve(ROOT, MIX);
const audio = fs.existsSync(mix) ? ['-i', mix] : [];
const threads = String(Math.max(2, Math.min(6, os.cpus().length - 6)));
execFileSync('ffmpeg', [
  '-v', 'error', '-stats', '-y', '-framerate', String(FPS), '-i', path.join(frames, 'f%05d.png'), ...audio,
  '-map', '0:v', ...(audio.length ? ['-map', '1:a'] : []),
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '13', '-tune', 'grain', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-threads', threads,
  '-vf', 'scale=in_range=full:out_range=tv:out_color_matrix=bt709:flags=lanczos+accurate_rnd+full_chroma_int',
  '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
  ...(audio.length ? ['-c:a', 'aac', '-b:a', '320k', '-ar', '48000'] : []),
  '-movflags', '+faststart', '-shortest', mp4,
], { stdio: 'inherit' });
console.log('encoded', mp4);
