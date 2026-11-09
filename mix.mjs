// Cue-based audio mixer (ffmpeg). Levels are set by measurement, not by ear:
// every cue names a target RMS level (dBFS) for its trimmed segment, and an
// anchor ('start' | 'peak' | seconds-into-segment) that lands exactly on `at`.
//   node mix.mjs audio/cues.mjs out/mix.wav
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const [cueFile = 'audio/cues.mjs', outFile = 'out/mix.wav'] = process.argv.slice(2);
const { CUES, MUSIC, DURATION = 30, TARGET_LUFS = -14 } = await import(pathToFileURL(path.resolve(ROOT, cueFile)).href);
const SR = 48000;

// decode a segment to mono f32 and measure RMS / peak position
const cache = new Map();
function analyse(file, from = 0, dur = null) {
  const key = `${file}|${from}|${dur}`;
  if (cache.has(key)) return cache.get(key);
  const args = ['-v', 'error', '-threads', '1', '-ss', String(from), ...(dur ? ['-t', String(dur)] : []), '-i', file, '-ac', '1', '-ar', '12000', '-f', 'f32le', '-'];
  const buf = execFileSync('ffmpeg', args, { maxBuffer: 1 << 28 });
  const x = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength >> 2);
  let sum = 0, pk = 0, pkI = 0;
  // peak of a 20 ms smoothed envelope (finds the transient body, not one stray sample)
  const win = 240; let acc = 0;
  for (let i = 0; i < x.length; i++) {
    sum += x[i] * x[i];
    acc += x[i] * x[i]; if (i >= win) acc -= x[i - win] * x[i - win];
    if (acc > pk) { pk = acc; pkI = i - win / 2; }
  }
  const rms = Math.sqrt(sum / Math.max(1, x.length));
  // onset: first point where a 5 ms envelope reaches -15 dB below the smoothed peak
  const thr = (pk / win) * Math.pow(10, -15 / 10); let onI = 0, e = 0;
  for (let i = 0; i < x.length; i++) { e += x[i] * x[i]; if (i >= 60) e -= x[i - 60] * x[i - 60]; if (e / 60 > thr) { onI = Math.max(0, i - 60); break; } }
  const res = { rmsDb: 20 * Math.log10(rms + 1e-9), peakT: Math.max(0, pkI) / 12000, onsetT: onI / 12000, len: x.length / 12000 };
  cache.set(key, res);
  return res;
}

const inputs = [], filters = [], labels = [];
let n = 0;
function addSource(c, isMusic = false) {
  const file = path.resolve(ROOT, c.file);
  if (!fs.existsSync(file)) { console.warn('missing', c.file); return; }
  const from = c.from ?? 0, dur = c.dur ?? null;
  const a = analyse(file, from, dur);
  const segLen = dur ?? a.len;
  const anchor = c.anchor === 'peak' ? a.peakT : c.anchor === 'onset' ? a.onsetT : c.anchor === 'end' ? segLen : (typeof c.anchor === 'number' ? c.anchor : 0);
  let delay = (c.at ?? 0) - anchor;            // where the segment's start lands
  let trimHead = 0;
  if (delay < 0) { trimHead = -delay; delay = 0; }
  const gain = Math.min(c.maxGain ?? 12, (c.level ?? -24) - a.rmsDb);
  inputs.push('-ss', String(from + trimHead), ...(dur ? ['-t', String(Math.max(0.05, dur - trimHead))] : []), '-i', file);
  const len = segLen - trimHead;
  const ch = [`aresample=${SR}`, 'aformat=channel_layouts=stereo'];
  if (c.rate) ch.push(`asetrate=${Math.round(SR * c.rate)}`, `aresample=${SR}`);
  if (c.highpass) ch.push(`highpass=f=${c.highpass}`);
  if (c.lowpass) ch.push(`lowpass=f=${c.lowpass}`);
  ch.push(`volume=${gain.toFixed(2)}dB`);
  if (c.pan) { const p = c.pan; ch.push(`pan=stereo|c0=${(1 - Math.max(0, p)).toFixed(3)}*c0|c1=${(1 + Math.min(0, p)).toFixed(3)}*c1`); }
  if (c.fadeIn) ch.push(`afade=t=in:st=0:d=${c.fadeIn}`);
  if (c.fadeOut) ch.push(`afade=t=out:st=${Math.max(0, len / (c.rate || 1) - c.fadeOut).toFixed(3)}:d=${c.fadeOut}`);
  ch.push(`adelay=${Math.round(delay * 1000)}|${Math.round(delay * 1000)}`);
  filters.push(`[${n}:a]${ch.join(',')}[s${n}]`);
  labels.push(`[s${n}]`);
  console.log(`${isMusic ? 'MUSIC' : 'cue  '} ${path.basename(c.file).padEnd(52)} at ${String(c.at ?? 0).padEnd(6)} anchor ${anchor.toFixed(2)} gain ${gain.toFixed(1)} dB (seg rms ${a.rmsDb.toFixed(1)})`);
  n++;
}

if (MUSIC) addSource(MUSIC, true);
for (const c of CUES) addSource(c);

const mixFilter = `${filters.join(';')};${labels.join('')}amix=inputs=${labels.length}:normalize=0:dropout_transition=0,atrim=0:${DURATION},afade=t=out:st=${DURATION - 0.6}:d=0.6[pre]`;
fs.mkdirSync(path.dirname(path.resolve(ROOT, outFile)), { recursive: true });
const pre = path.resolve(ROOT, outFile.replace(/\.wav$/, '_pre.wav'));
execFileSync('ffmpeg', ['-v', 'error', '-y', '-threads', '1', ...inputs, '-filter_complex', mixFilter, '-map', '[pre]', '-ar', String(SR), '-c:a', 'pcm_s24le', pre]);
// two-pass loudness normalisation + true-peak limit
let m;
try {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('ffmpeg', ['-hide_banner', '-threads', '1', '-i', pre, '-af', `loudnorm=I=${TARGET_LUFS}:TP=-1.0:LRA=11:print_format=json`, '-f', 'null', '-'], { encoding: 'utf8' });
  m = JSON.parse(r.stderr.match(/\{[\s\S]*\}/)[0]);
} catch {}
const ln = m ? `loudnorm=I=${TARGET_LUFS}:TP=-1.0:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true` : `loudnorm=I=${TARGET_LUFS}:TP=-1.0`;
execFileSync('ffmpeg', ['-v', 'error', '-y', '-threads', '1', '-i', pre, '-af', `${ln},aresample=${SR}`, '-c:a', 'pcm_s24le', path.resolve(ROOT, outFile)]);
console.log('mix written', outFile, m ? `(input ${m.input_i} LUFS -> ${TARGET_LUFS})` : '');
