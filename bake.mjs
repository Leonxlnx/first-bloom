// Bakes world data once (node): warped terrain heights, the bloom-wave arrival
// fields (Dijkstra cost-distance from the bud, faster along water, slower
// uphill, noisy for organic lobes) and a terrain info texture.
//   node bake.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as L from './src/world/layout.js';

try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, 'data');
const writeAtomic = (p, buf) => { fs.writeFileSync(p + '.tmp', buf); for (let i = 0; ; i++) { try { fs.renameSync(p + '.tmp', p); return; } catch (e) { if (i > 40) throw e; const u = Date.now() + 250; while (Date.now() < u); } } };
fs.mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1) + 's', ...a);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ---------------- terrain heights on the warped grid
const N = L.GRID.N;
const H = new Float32Array(N * N);
const xs = Array.from({ length: N }, (_, i) => L.gridX(i)), zs = Array.from({ length: N }, (_, j) => L.gridZ(j));
for (let j = 0; j < N; j++) {
  for (let i = 0; i < N; i++) H[j * N + i] = L.height(xs[i], zs[j]);
  if (j % 256 === 0) log('heights row', j);
}
writeAtomic(path.join(OUT, 'terrain_h.f32'), Buffer.from(H.buffer));
log('terrain heights written');
const hAt = L.makeSampler(H);

// ---------------- high-res terrain patch around the waterfall (telephoto shot)
const PATCH = { cx: L.WATERFALL.x, cz: L.WATERFALL.z, size: 760, n: 1024 };
{
  const P = new Float32Array(PATCH.n * PATCH.n), step = PATCH.size / (PATCH.n - 1);
  for (let j = 0; j < PATCH.n; j++) for (let i = 0; i < PATCH.n; i++)
    P[j * PATCH.n + i] = L.height(PATCH.cx - PATCH.size / 2 + i * step, PATCH.cz - PATCH.size / 2 + j * step);
  writeAtomic(path.join(OUT, 'patch_falls.f32'), Buffer.from(P.buffer));
  log('falls patch written');
}

// ---------------- arrival field via Dijkstra on a regular grid
function costAt(x, z) {
  let c = 0.75 + 0.5 * L.fbm(x * 0.012 + 40, z * 0.012 - 7, 4);
  const r = Math.hypot(x, z);
  { const ps = L.petalSD(x, z); c *= 0.6 + 0.8 * smooth(-40, 40, ps); }  // petals carry spring faster
  c *= 0.4 + 0.6 * smooth(2, 25, L.creekDist(x, z).d);       // creeks fastest (midveins)
  c *= 0.45 + 0.55 * smooth(10, 60, L.riverDist(x, z).d);
  if (L.lakeDist(x, z) < 0) c *= 0.5;
  if (r < L.HEART_R) c *= 0.7;
  return c;
}

class Heap {
  constructor(cap) { this.k = new Float64Array(cap); this.v = new Int32Array(cap); this.n = 0; }
  push(key, val) {
    let i = this.n++; const k = this.k, v = this.v;
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v; const rk = k[0], rv = v[0]; const lk = k[--this.n], lv = v[this.n];
    let i = 0;
    for (;;) { let c = 2 * i + 1; if (c >= this.n) break; if (c + 1 < this.n && k[c + 1] < k[c]) c++; if (k[c] >= lk) break; k[i] = k[c]; v[i] = v[c]; i = c; }
    k[i] = lk; v[i] = lv; this.popKey = rk; return rv;
  }
}

function dijkstra({ minX, minZ, sizeX, sizeZ, nx, nz, seeds }) {
  const dx = sizeX / nx, dz = sizeZ / nz, n = nx * nz;
  const hh = new Float32Array(n), cc = new Float32Array(n);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const x = minX + (i + 0.5) * dx, z = minZ + (j + 0.5) * dz;
    hh[j * nx + i] = hAt(x, z); cc[j * nx + i] = costAt(x, z);
  }
  log('cost grid ready', nx, nz);
  const dist = new Float32Array(n).fill(Infinity);
  const heap = new Heap(n * 4);
  for (const s of seeds) {
    const i = Math.round((s.x - minX) / dx - 0.5), j = Math.round((s.z - minZ) / dz - 0.5);
    if (i < 0 || j < 0 || i >= nx || j >= nz) continue;
    dist[j * nx + i] = s.d; heap.push(s.d, j * nx + i);
  }
  const nb = [];
  for (let oj = -2; oj <= 2; oj++) for (let oi = -2; oi <= 2; oi++) {
    if (!oi && !oj) continue;
    if (Math.abs(oi) === 2 && Math.abs(oj) === 2) continue; if ((Math.abs(oi) === 2 && oj === 0) || (Math.abs(oj) === 2 && oi === 0)) continue;
    nb.push([oi, oj, Math.hypot(oi * dx, oj * dz)]);
  }
  while (heap.n) {
    const u = heap.pop(), du = heap.popKey;
    if (du > dist[u]) continue;
    const ui = u % nx, uj = (u - ui) / nx;
    for (const [oi, oj, len] of nb) {
      const vi = ui + oi, vj = uj + oj;
      if (vi < 0 || vj < 0 || vi >= nx || vj >= nz) continue;
      const v = vj * nx + vi;
      const dh = hh[v] - hh[u];
      const slope = dh / len;
      const k = 1 + 2.6 * Math.max(0, slope) - 0.35 * Math.min(1, Math.max(0, -slope));
      const nd = du + len * 0.5 * (cc[u] + cc[v]) * k;
      if (nd < dist[v]) { dist[v] = nd; heap.push(nd, v); }
    }
  }
  return dist;
}

const FAR = { minX: -4096, minZ: -4096, sizeX: 8192, sizeZ: 8192, nx: 1024, nz: 1024 };
const farD = dijkstra({ ...FAR, seeds: [{ x: 0, z: 0, d: 0 }] });
writeAtomic(path.join(OUT, 'arrival_far.f32'), Buffer.from(farD.buffer));
log('far arrival written');

const NEAR = { minX: -128, minZ: -128, sizeX: 512, sizeZ: 512, nx: 1024, nz: 1024 };
const nearD = dijkstra({ ...NEAR, seeds: [{ x: 0, z: 0, d: 0 }] });
writeAtomic(path.join(OUT, 'arrival_near.f32'), Buffer.from(nearD.buffer));
log('near arrival written');

// info texture on the far grid: R riverDist, G streamDist, B lakeDist(signed), A forest
const info = new Float32Array(FAR.nx * FAR.nz * 4);
for (let j = 0; j < FAR.nz; j++) for (let i = 0; i < FAR.nx; i++) {
  const x = FAR.minX + (i + 0.5) * FAR.sizeX / FAR.nx, z = FAR.minZ + (j + 0.5) * FAR.sizeZ / FAR.nz;
  const o = (j * FAR.nx + i) * 4;
  info[o] = Math.min(2000, L.riverDist(x, z).d);
  info[o + 1] = Math.min(2000, L.creekDist(x, z).d);
  info[o + 2] = Math.max(-2000, Math.min(2000, L.lakeDist(x, z)));
  info[o + 3] = L.forestMask(x, z);
}
writeAtomic(path.join(OUT, 'info_far.f32'), Buffer.from(info.buffer));
log('info written');

// report arrival at key points (for timeline tuning)
const sampleField = (D, G, x, z) => { const i = Math.floor((x - G.minX) / (G.sizeX / G.nx)), j = Math.floor((z - G.minZ) / (G.sizeZ / G.nz)); return D[j * G.nx + i]; };
const P = (r, d) => [Math.cos(d * L.DEG) * r, Math.sin(d * L.DEG) * r];
const pts = { knoll5: P(5, 22.5), chase20: P(20, 22.5), chase60: P(60, 25), chase100: P(100, 30), chase160: P(160, 40), chase220: P(220, 50), grove: [L.GROVE.x, L.GROVE.z], lake: [L.LAKE.x, L.LAKE.z], petalTip: P(1100, 262.5), interLobe600: P(600, 292.5), wfBase: P(1700, 232.5), wfTop: P(1760, 232.5), rimN2000: P(2000, 270), rimE2200: P(2200, 0), rim2800: P(2800, 180), outlet1800: P(1800, 112.5) };
const report = {};
for (const [k, [x, z]] of Object.entries(pts)) {
  const inNear = x > NEAR.minX && x < NEAR.minX + NEAR.sizeX && z > NEAR.minZ && z < NEAR.minZ + NEAR.sizeZ;
  report[k] = { far: +sampleField(farD, FAR, x, z).toFixed(1), near: inNear ? +sampleField(nearD, NEAR, x, z).toFixed(1) : null, h: +hAt(x, z).toFixed(1) };
}
writeAtomic(path.join(OUT, 'meta.json'), JSON.stringify({ GRID: L.GRID, FAR, NEAR, PATCH, report }, null, 1));
console.log(report);
log('done');
