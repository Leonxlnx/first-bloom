// node audio/edit/render_edit.cjs audio/edit/edit_1.spec.json
// Renders a spliced edit with ONE low-priority ffmpeg process (-threads 1) to 48 kHz stereo 24-bit WAV.
// src and out in the spec are relative to the repo root.
// spec: { src, out, total, master_gain_db, limiter_dbfs,
//         end_fade: {start, end, curve},
//         segments: [{src_start, src_end, dst_start, fade_in_ms, fade_out_ms, fin_curve, fout_curve, gain_db}] }
// Segments overlap where crossfades are wanted; they are summed (amix normalize=0).
const fs = require('fs');
const { spawnSync } = require('child_process');
// below-normal priority (inherited by ffmpeg on Windows) so other work such as Blender keeps priority
try { require('os').setPriority(require('os').constants.priority.PRIORITY_BELOW_NORMAL); } catch (e) {}
const E =JSON.parse(fs.readFileSync(process.argv[2]));
const ROOT = require('path').resolve(__dirname, '../..');
E.src = require('path').resolve(ROOT, E.src); E.out = require('path').resolve(ROOT, E.out);
const SR = 48000;
const total = E.total || 30.0;
const N = E.segments.length;
const totalS = Math.round(total * SR);
let fc = `[0:a]aresample=${SR},asplit=${N}` + E.segments.map((_, i) => `[a${i}]`).join('') + ';';
E.segments.forEach((s, i) => {
  const len = s.src_end - s.src_start;
  const p = [`atrim=start=${s.src_start.toFixed(5)}:end=${s.src_end.toFixed(5)}`, 'asetpts=PTS-STARTPTS'];
  if (s.gain_db) p.push(`volume=${s.gain_db}dB`);
  if (s.fade_in_ms > 0) p.push(`afade=t=in:st=0:d=${(s.fade_in_ms / 1000).toFixed(4)}:curve=${s.fin_curve || 'qsin'}`);
  if (s.fade_out_ms > 0) p.push(`afade=t=out:st=${(len - s.fade_out_ms / 1000).toFixed(5)}:d=${(s.fade_out_ms / 1000).toFixed(4)}:curve=${s.fout_curve || 'qsin'}`);
  const dly = Math.round(s.dst_start * SR);
  if (dly > 0) p.push(`adelay=delays=${dly}S:all=1`);
  fc += `[a${i}]${p.join(',')}[m${i}];`;
});
let tail = `amix=inputs=${N}:normalize=0:duration=longest,apad=whole_len=${totalS},atrim=end_sample=${totalS}`;
if (E.end_fade) tail += `,afade=t=out:st=${E.end_fade.start}:d=${(E.end_fade.end - E.end_fade.start).toFixed(3)}:curve=${E.end_fade.curve || 'qsin'}`;
if (E.master_gain_db) tail += `,volume=${E.master_gain_db}dB`;
if (E.limiter_dbfs !== undefined) tail += `,alimiter=limit=${Math.pow(10, E.limiter_dbfs / 20).toFixed(4)}:level=false:latency=1:attack=5:release=80`;
tail += `,apad=whole_len=${totalS},atrim=end_sample=${totalS}`;
fc += E.segments.map((_, i) => `[m${i}]`).join('') + tail + '[out]';
const args = ['-hide_banner', '-loglevel', 'error', '-threads', '1', '-filter_threads', '1', '-filter_complex_threads', '1',
  '-y', '-i', E.src, '-filter_complex', fc, '-map', '[out]', '-ac', '2', '-ar', String(SR), '-c:a', 'pcm_s24le', E.out];
const r = spawnSync('ffmpeg', args, { stdio: 'inherit' });
console.log('ffmpeg exit', r.status, E.out);
