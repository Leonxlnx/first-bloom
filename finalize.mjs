// QA + delivery: checks the frame sequence, encodes the 4K master and a 1080p
// share version with the mix, extracts the poster, builds a contact sheet.
//   node finalize.mjs --frames frames/final --mix out/mix.wav
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const FR = path.resolve(ROOT, opt('frames', 'frames/final'));
const MIX = path.resolve(ROOT, opt('mix', 'out/mix.wav'));
const OUT = path.resolve(ROOT, 'out');
const N = 900, FPS = 30;
const threads = String(Math.max(2, Math.min(6, os.cpus().length - 6)));

// ---- 1. sequence check
const missing = [], tiny = [];
for (let f = 0; f < N; f++) {
  const p = path.join(FR, `f${String(f).padStart(5, '0')}.png`);
  if (!fs.existsSync(p)) missing.push(f); else if (fs.statSync(p).size < 200000) tiny.push(f);
}
console.log(`frames: ${N - missing.length}/${N} present; missing ${missing.length ? missing.slice(0, 20).join(',') : 'none'}; suspiciously small ${tiny.length ? tiny.slice(0, 20).join(',') : 'none'}`);
if (missing.length) process.exit(1);

// ---- 2. black / blown frame scan (1 in 3 frames, downscaled)
const bad = [];
for (let f = 0; f < N; f += 3) {
  const p = path.join(FR, `f${String(f).padStart(5, '0')}.png`);
  const b = execFileSync('ffmpeg', ['-v', 'error', '-i', p, '-vf', 'scale=64:-2', '-pix_fmt', 'gray', '-f', 'rawvideo', '-']);
  const mean = b.reduce((s, v) => s + v, 0) / b.length;
  const t = f / FPS;
  const fadeZone = t < 1.0 || t > 28.9 || (t > 16.6 && t < 16.95);
  if (!fadeZone && (mean < 25 || mean > 245)) bad.push(`${f}(${mean.toFixed(0)})`);
}
console.log('luma outliers outside fades:', bad.length ? bad.join(' ') : 'none');

// ---- 3. encodes
const vf709 = 'scale=in_range=full:out_range=tv:out_color_matrix=bt709:flags=lanczos+accurate_rnd+full_chroma_int';
const tags = ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv'];
const audio = fs.existsSync(MIX) ? ['-i', MIX] : [];
const amap = audio.length ? ['-map', '1:a', '-c:a', 'aac', '-b:a', '320k', '-ar', '48000'] : [];
const master = path.join(OUT, 'first_bloom_3840x2160.mp4');
execFileSync('ffmpeg', ['-v', 'error', '-stats', '-y', '-framerate', String(FPS), '-i', path.join(FR, 'f%05d.png'), ...audio, '-map', '0:v', ...amap,
  '-c:v', 'libx264', '-preset', 'fast', '-crf', '16', '-maxrate', '120M', '-bufsize', '240M', '-profile:v', 'high', '-level', '5.2', '-pix_fmt', 'yuv420p', '-threads', threads,
  '-vf', vf709, ...tags, '-movflags', '+faststart', '-shortest', master], { stdio: 'inherit' });
const hd = path.join(OUT, 'first_bloom_1920x1080.mp4');
execFileSync('ffmpeg', ['-v', 'error', '-stats', '-y', '-framerate', String(FPS), '-i', path.join(FR, 'f%05d.png'), ...audio, '-map', '0:v', ...amap,
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-maxrate', '40M', '-bufsize', '80M', '-profile:v', 'high', '-level', '4.2', '-pix_fmt', 'yuv420p', '-threads', threads,
  '-vf', `scale=1920:1080:flags=lanczos,${vf709}`, ...tags, '-movflags', '+faststart', '-shortest', hd], { stdio: 'inherit' });

// ---- 4. poster + contact sheet
fs.copyFileSync(path.join(FR, `f${String(Math.round(27.2 * FPS)).padStart(5, '0')}.png`), path.join(OUT, 'poster_flower.png'));
fs.copyFileSync(path.join(FR, `f${String(Math.round(6.35 * FPS)).padStart(5, '0')}.png`), path.join(OUT, 'poster_bloom.png'));
const per = Array.from({ length: 30 }, (_, s) => path.join(FR, `f${String(s * FPS + 15).padStart(5, '0')}.png`));
const inputs = per.flatMap(p => ['-i', p]);
const fil = per.map((_, k) => `[${k}:v]scale=384:216[s${k}]`).join(';');
const layout = per.map((_, k) => `${(k % 6) * 384}_${Math.floor(k / 6) * 216}`).join('|');
execFileSync('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', `${fil};${per.map((_, k) => `[s${k}]`).join('')}xstack=inputs=30:layout=${layout}`, '-q:v', '2', path.join(OUT, 'first_bloom_contact.jpg')]);
for (const f of [master, hd]) console.log(path.basename(f), (fs.statSync(f).size / 1e6).toFixed(1), 'MB',
  execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,width,height,r_frame_rate', '-of', 'compact', f], { encoding: 'utf8' }).replace(/\n/g, ' | '));
