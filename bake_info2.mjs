// Second bake: petal-map info texture + a debug image of the arrival field.
//   node bake_info2.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as L from './src/world/layout.js';

try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, 'data');
const writeAtomic = (p, buf) => { fs.writeFileSync(p + '.tmp', buf); for (let i = 0; ; i++) { try { fs.renameSync(p + '.tmp', p); return; } catch (e) { if (i > 40) throw e; const u = Date.now() + 250; while (Date.now() < u); } } };
const meta = JSON.parse(fs.readFileSync(path.join(OUT, 'meta.json'), 'utf8'));
const { FAR } = meta;

const info2 = new Float32Array(FAR.nx * FAR.nz * 4);
for (let j = 0; j < FAR.nz; j++) for (let i = 0; i < FAR.nx; i++) {
  const x = FAR.minX + (i + 0.5) * FAR.sizeX / FAR.nx, z = FAR.minZ + (j + 0.5) * FAR.sizeZ / FAR.nz;
  const o = (j * FAR.nx + i) * 4;
  info2[o] = Math.max(-3000, Math.min(3000, L.petalField(x, z)));
  info2[o + 1] = Math.hypot(x, z);
  info2[o + 2] = L.lobeDelta(Math.atan2(z, x));
  info2[o + 3] = L.fbm(x * 0.01 + 31, z * 0.01 - 3, 4);
}
writeAtomic(path.join(OUT, 'info2_far.f32'), Buffer.from(info2.buffer));
console.log('info2 written');

// debug image: arrival contours over petal map, central 4 km
const far = new Float32Array(fs.readFileSync(path.join(OUT, 'arrival_far.f32')).buffer.slice(0));
const S = 800, half = 2000, ppm = Buffer.alloc(S * S * 3);
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  const wx = -half + (x + 0.5) / S * 2 * half, wz = -half + (y + 0.5) / S * 2 * half;
  const i = Math.floor((wx - FAR.minX) / FAR.sizeX * FAR.nx), j = Math.floor((wz - FAR.minZ) / FAR.sizeZ * FAR.nz);
  const D = far[j * FAR.nx + i];
  const ps = L.petalSD(wx, wz);
  let r = 40, g = 120, b = 60;                         // meadow
  if (ps < 0) { r = 110; g = 70; b = 200; }            // petal
  if (Math.abs(ps) < 20) { r = 240; g = 240; b = 235; }// daisy outline
  if (Math.hypot(wx, wz) < L.HEART_R) { r = 250; g = 200; b = 40; }
  if (L.riverDist(wx, wz).d < 18 || L.lakeDist(wx, wz) < 0) { r = 40; g = 190; b = 200; }
  const fr = (D / 150) % 1;
  if (fr < 0.04) { r = 255; g = 60; b = 20; }          // arrival contour every 150 units
  const o = (y * S + x) * 3; ppm[o] = r; ppm[o + 1] = g; ppm[o + 2] = b;
}
const ppmPath = path.join(OUT, '_arrival.ppm');
fs.writeFileSync(ppmPath, Buffer.concat([Buffer.from(`P6 ${S} ${S} 255\n`), ppm]));
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', ppmPath, path.join(OUT, '_arrival.png')]);
fs.unlinkSync(ppmPath);
console.log('debug image written');
