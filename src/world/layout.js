// World layout (pure JS, no three.js — also imported by node bake scripts).
// Units: metres. +x east, +z south, +y up.
//
// A round mountain basin ~3 km across. At its centre a small knoll holds the
// hero bud (E). Six shallow meltwater swales radiate from it along the six
// "petal" axes, each with a creek (the petal midvein) — seen from high above,
// the spring bloom paints the basin into one giant six-petalled flower.
// A river drops in through a frozen 150 m waterfall on the NW rim, meanders
// into a small lake beside the knoll, and leaves through a SSW gorge (the stem).

// ---------- deterministic value noise (CPU only)
function hash2(ix, iz) {
  let h = Math.imul(ix | 0, 374761393) + Math.imul(iz | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function vnoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}
export function fbm(x, z, oct = 5) {
  let a = 0.5, s = 0, n = 0;
  for (let i = 0; i < oct; i++) {
    s += a * vnoise(x, z); n += a;
    const nx = 0.8 * x - 0.6 * z, nz = 0.6 * x + 0.8 * z;
    x = nx * 2.03 + 17.1; z = nz * 2.03 + 5.3; a *= 0.5;
  }
  return s / n;
}
function ridged(x, z, oct = 6) {
  let a = 0.5, s = 0, n = 0;
  for (let i = 0; i < oct; i++) {
    const v = 1 - Math.abs(vnoise(x, z) * 2 - 1);
    s += a * v * v; n += a;
    const nx = 0.8 * x - 0.6 * z, nz = 0.6 * x + 0.8 * z;
    x = nx * 2.1 + 3.1; z = nz * 2.1 + 9.7; a *= 0.5;
  }
  return s / n;
}
export const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

// ---------- basin layout
// Angles in the x/z plane: dir(phi) = (cos phi, sin phi), +z = south.
export const DEG = Math.PI / 180;
export const LOBE0 = 22.5 * DEG;                       // first petal axis points ESE (toward the dawn sun)
export const LOBES = Array.from({ length: 6 }, (_, k) => LOBE0 + k * 60 * DEG);
export const PETAL_R = 1150;                           // petal tip radius
export const HEART_R = 85;                             // gold heart radius
export const BASIN_R = 1500;                           // floor radius (rim beyond)
export const dirv = phi => [Math.cos(phi), Math.sin(phi)];
// the falls sit exactly opposite the outlet: from the high aerial one axis runs
// down the frame — falls, river, lake, gold heart, stem leaving the bottom edge
const WF_PHI = 292.5 * DEG, STEM_PHI = 112.5 * DEG, GROVE_PHI = 55 * DEG;
export const WATERFALL = { phi: WF_PHI, r: 1720, x: Math.cos(WF_PHI) * 1720, z: Math.sin(WF_PHI) * 1720, drop: 150 };
export const LAKE = { x: Math.cos(WF_PHI) * 165, z: Math.sin(WF_PHI) * 165, rx: 78, rz: 58, rot: WF_PHI };
export const GROVE = { x: Math.cos(GROVE_PHI) * 262, z: Math.sin(GROVE_PHI) * 262, r: 46 };
export const E = { x: 0, z: 0 };

function wrapAngle(a) { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI; }
export { wrapAngle };
// angular offset to the nearest petal axis, in [-30deg, 30deg]
export function lobeDelta(phi) { return wrapAngle((phi - LOBE0) * 6) / 6; }
// signed distance (m, approximate) to the petal outline; < 0 inside a petal.
// Petals are lanceolate like the hero pasque-flower tepals: pinched at the
// heart, widest about 40% out, tapering to a pointed tip (length:width ~ 3:1).
export const PETAL_W = 205;                            // max half-width (m)
export function petalSD(x, z) {
  const r = Math.hypot(x, z), phi = Math.atan2(z, x), d = lobeDelta(phi);
  const a = r * Math.cos(d), b = Math.abs(r * Math.sin(d));
  const a0 = HEART_R * 0.55, R = PETAL_R + (fbm(x * 0.004 + 1, z * 0.004, 2) - 0.5) * 60;
  const u = Math.min(1, Math.max(0, (a - a0) / (R - a0)));
  const hw = PETAL_W * Math.pow(Math.sin(Math.PI * Math.pow(u, 0.72)), 0.9);
  const wob = (fbm(x * 0.006 + 3, z * 0.006, 3) - 0.5) * 40;
  return Math.max(b - (hw + wob * (0.3 + u)), a - R, a0 - a);
}

// organic version of petalSD (wandering edges); baked into info2.x — use this for
// anything that must agree with the painted petals (flower placement etc.)
export function petalField(x, z) {
  return petalSD(x, z) + (fbm(x * 0.009 + 4, z * 0.009 - 1, 4) - 0.5) * 40 + (fbm(x * 0.03 + 11, z * 0.03 + 2, 3) - 0.5) * 14;
}

// river: waterfall base -> meanders into the lake -> past the knoll -> leaves SSW as the stem
function polar(r, phiDeg) { return [Math.cos(phiDeg * DEG) * r, Math.sin(phiDeg * DEG) * r]; }
// Catmull-Rom resample so the river reads as a sinuous stem, not a kinked polyline
function smoothPath(pts, sub = 8) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let s = 0; s < sub; s++) {
      const t = s / sub, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}
const WFD = WF_PHI / DEG;
export const RIVER = smoothPath([
  polar(1745, WFD), polar(1640, WFD - 3.5), polar(1500, WFD + 3.5), polar(1330, WFD - 2.5), polar(1150, WFD + 3), polar(960, WFD - 3),
  polar(760, WFD + 2), polar(560, WFD - 2.5), polar(380, WFD + 1), polar(240, WFD),
  // lake (r~165), then around the knoll's west side and away SSW as the stem
  polar(108, 247), polar(122, 186), polar(205, 139), polar(380, 119), polar(560, 121.5), polar(820, 110.5), polar(1100, 115),
  polar(1400, 110), polar(1750, 113.5), polar(2300, 111), polar(3200, 115),
]);
// six creeks: one along each petal axis (the petal midveins), with S-curves
export const CREEKS = LOBES.map((phi, k) => {
  const pts = [];
  for (let r = 1050; r >= 70; r -= 20) {
    const w = Math.sin(r * 0.011 + k * 1.7) * 9 + Math.sin(r * 0.031 + k) * 3.5 + Math.sin(r * 0.05 + k * 2.3) * 6 * Math.min(1, r / 120);
    const a = phi + w / Math.max(r, 1);
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return pts;
});

// per-polyline precomputation (segment vectors, cumulative lengths, bounding boxes)
const _polyCache = new WeakMap();
function prep(pts) {
  let P = _polyCache.get(pts);
  if (P) return P;
  const n = pts.length - 1, seg = new Float64Array(n * 9);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1], dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz);
    seg.set([ax, az, dx, dz, dx * dx + dz * dz || 1e-9, acc, l, Math.min(ax, bx), Math.min(az, bz)], i * 9);
    acc += l;
  }
  const bb = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) { bb[i * 2] = Math.max(pts[i][0], pts[i + 1][0]); bb[i * 2 + 1] = Math.max(pts[i][1], pts[i + 1][1]); }
  P = { n, seg, bb, total: acc };
  _polyCache.set(pts, P);
  return P;
}
export function distToPolyline(px, pz, pts) {
  const { n, seg, bb, total } = prep(pts);
  let best2 = Infinity, bestT = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 9;
    // reject segments whose bounding box is farther than the current best
    const ex = Math.max(seg[o + 7] - px, 0, px - bb[i * 2]), ez = Math.max(seg[o + 8] - pz, 0, pz - bb[i * 2 + 1]);
    if (ex * ex + ez * ez >= best2) continue;
    const ax = seg[o], az = seg[o + 1], dx = seg[o + 2], dz = seg[o + 3];
    let t = ((px - ax) * dx + (pz - az) * dz) / seg[o + 4]; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = px - (ax + dx * t), qz = pz - (az + dz * t), d2 = qx * qx + qz * qz;
    if (d2 < best2) { best2 = d2; bestT = (seg[o + 5] + t * seg[o + 6]) / total; }
  }
  return { d: Math.sqrt(best2), t: bestT };
}
export const riverDist = (x, z) => distToPolyline(x, z, RIVER);
export function creekDist(x, z) {
  const r = Math.hypot(x, z);
  if (r < 50 || r > 1100) return { d: 1e9, t: 0, k: -1 };
  const k = ((Math.round(wrapAngle(Math.atan2(z, x) - LOBE0) / (60 * DEG)) % 6) + 6) % 6;
  return { ...distToPolyline(x, z, CREEKS[k]), k };
}
export function lakeDist(x, z) { // signed: <0 inside
  const c = Math.cos(-LAKE.rot), s = Math.sin(-LAKE.rot);
  const lx = (x - LAKE.x) * c - (z - LAKE.z) * s, lz = (x - LAKE.x) * s + (z - LAKE.z) * c;
  const nx = lx / LAKE.rx, nz = lz / LAKE.rz;
  const ang = Math.atan2(nz, nx);
  const wob = 1 + 0.09 * Math.sin(ang * 3 + 1.3) + 0.05 * Math.sin(ang * 5 + 0.2);
  return (Math.hypot(nx, nz) - wob) * Math.min(LAKE.rx, LAKE.rz);
}

export const LAKE_Y = -7.2;
// river water level: monotone along the flow (t in [0,1]); lake at t ~ 0.40
export function riverWaterY(t) {
  if (t < 0.40) return 18 + (LAKE_Y + 0.05 - 18) * Math.pow(t / 0.40, 0.8);
  return LAKE_Y - (t - 0.40) / 0.60 * 9;
}

// ---------- height
export function height(x, z) {
  const r = Math.hypot(x, z), phi = Math.atan2(z, x);
  // floor rises gently toward the rim, except along the outlet (SSW) where it stays low
  const dOut = Math.abs(wrapAngle(phi - STEM_PHI));
  const outlet = Math.exp(-Math.pow(dOut / (24 * DEG), 2));
  let h = -5 + 0.017 * r * (1 - 0.92 * outlet);
  h += (fbm(x * 0.0035, z * 0.0035, 4) - 0.5) * 16 * smooth(60, 400, r);
  h += (fbm(x * 0.03 + 7, z * 0.03, 3) - 0.5) * 1.6;
  // knoll (the stage for the bud)
  h += 5.2 * Math.exp(-(r * r) / (2 * 22 * 22)) + 1.2 * Math.exp(-(r * r) / (2 * 70 * 70));
  // swales along each petal axis + creek channels (midveins)
  const d = lobeDelta(phi), lat = r * Math.sin(d);
  const along = smooth(30, 140, r) * (1 - smooth(1000, 1250, r));
  h -= along * (2.6 * Math.exp(-(lat * lat) / (2 * 48 * 48)));
  h += along * 1.2 * smooth(0.5, 0.95, Math.abs(d) / (30 * DEG));
  const cd = creekDist(x, z);
  if (cd.d < 30) h -= 0.85 * Math.exp(-(cd.d * cd.d) / (2 * 1.5 * 1.5)) + 0.35 * Math.exp(-(cd.d * cd.d) / (2 * 4 * 4));
  // the grove rise
  const gd2 = (x - GROVE.x) ** 2 + (z - GROVE.z) ** 2;
  h += 6.5 * Math.exp(-gd2 / (2 * 45 * 45));
  // rim: a ring of sharp snowy peaks (with an outlet gorge to the SSW)
  // in the waterfall sector the mountains start right behind the cliff
  const dw = wrapAngle(phi - WF_PHI);
  const wfSector = Math.exp(-Math.pow(dw / (14 * DEG), 2));
  const rim0 = 1480 + 210 * wfSector, rim1 = 2500 - 560 * wfSector;
  const rimT = smooth(rim0, rim1, r);
  // domain-warped ridged noise: big clean masses with sharp ridgelines
  const wx = x + 380 * (fbm(x * 0.0006 + 1, z * 0.0006, 3) - 0.5), wz = z + 380 * (fbm(x * 0.0006, z * 0.0006 + 5, 3) - 0.5);
  const peaks = ridged(wx * 0.0010 + 4, wz * 0.0010 - 2, 4);
  const farPeaks = ridged(wx * 0.00042, wz * 0.00042 + 7, 4);
  // a broad saddle in the ESE rim: the dawn sun rises through this pass behind the bud
  const saddle = Math.exp(-Math.pow(wrapAngle(phi - 25 * DEG) / (15 * DEG), 2));
  const rimH = (Math.pow(rimT, 1.45) * (300 + 600 * peaks) * (1 + 0.25 * wfSector) + smooth(2300, 7000, r) * (260 + 820 * farPeaks)) * (1 - 0.85 * outlet) * (1 - 0.6 * saddle);
  h += rimH;
  // a far, hazy ridge behind the falls notch (fills the gap in the skyline)
  h += Math.exp(-Math.pow(dw / (13 * DEG), 2)) * smooth(2800, 4300, r) * (700 + 400 * farPeaks);
  // the waterfall: a narrow cliff headwall at the foot of the mountains, with a
  // hanging valley notched into the range behind the lip
  if (Math.abs(dw) < 0.7) {
    // amphitheatre cirque: a cliff band whose top RISES away from the falls, so
    // the water pours from the lowest notch of a curved wall
    const wls = r * Math.sin(dw), wl = Math.abs(wls);
    const rC = WATERFALL.r + 0.00045 * wls * wls + 10 * (fbm(wls * 0.012 + 3, 1.7, 3) - 0.5);
    const face = smooth(rC - 10, rC + 24, r);
    const band = Math.exp(-Math.pow(wl / 520, 4));
    const crest = (fbm(wls * 0.006 + 9, 2.3, 4) - 0.5) * 50;          // ragged skyline along the wall
    const lipY = 236 + 0.0007 * wl * wl * (wls > 0 ? 1.4 : 0.72) + crest * smooth(40, 160, wl) + Math.max(0, r - rC) * (0.12 + 0.22 * smooth(80, 360, wl));
    const ledge = (ridged(wls * 0.02, r * 0.05 + h * 0.03, 4) - 0.5) * 9;
    h = h + Math.max(0, lipY - h) * band * face + band * face * (1 - face) * ledge * 4;
    // hanging valley: a U-notch behind the lip (the range rises on both sides)
    const notch = Math.exp(-Math.pow(wl / 280, 2)) * smooth(rC, rC + 160, r);
    h = h + (Math.min(h, 236 + Math.max(0, r - rC) * 0.42 + wl * wl * 0.0012) - h) * notch;
    // notch at the lip and the feeder stream
    h -= 3 * Math.exp(-Math.pow(wl / 9, 2)) * smooth(WATERFALL.r - 10, WATERFALL.r + 6, r) * smooth(WATERFALL.r + 200, WATERFALL.r + 20, r);
    h -= 1.4 * Math.exp(-Math.pow(wl / 5, 2)) * smooth(WATERFALL.r + 2, WATERFALL.r + 30, r);
  }
  const aboveFalls = Math.abs(dw) < 0.3 && r > WATERFALL.r - 4;
  // river + lake carving (below the river's own water level)
  const rd = riverDist(x, z);
  if (rd.d < 160 && !aboveFalls) {
    const wy = riverWaterY(rd.t), rw = 14 + 6 * Math.sin(rd.t * 40);
    const bed = wy - 2.2 * smooth(rw, 0, rd.d);
    const bank = smooth(rw + 70, rw, rd.d);
    h = h * (1 - bank) + Math.min(h, wy + 0.6 + (rd.d - rw) * 0.05) * bank;
    if (rd.d < rw + 2) h = Math.min(h, bed);
  }
  const ld = lakeDist(x, z);
  if (ld < 80) h = lerp(h, Math.min(h, LAKE_Y - 3 + Math.max(0, ld) * 0.12), smooth(50, -6, ld));
  return h;
}

export function normal(x, z, e = 0.5) {
  const hx = height(x + e, z) - height(x - e, z);
  const hz = height(x, z + e) - height(x, z - e);
  const nx = -hx, ny = 2 * e, nz = -hz;
  const l = Math.hypot(nx, ny, nz);
  return [nx / l, ny / l, nz / l];
}

// forest density: belts on the lower rim slopes + groves on the floor + the hero grove
export function forestMask(x, z) {
  const r = Math.hypot(x, z);
  let m = smooth(1250, 1500, r) * (1 - smooth(2300, 2900, r));
  m *= smooth(0.38, 0.6, fbm(x * 0.0022 + 11, z * 0.0022, 4));
  const floorGroves = smooth(0.66, 0.78, fbm(x * 0.004 - 5, z * 0.004 + 2, 4)) * smooth(500, 800, r) * (petalSD(x, z) > 30 ? 1 : 0);
  m = Math.max(m, floorGroves);
  const gd = Math.hypot(x - GROVE.x, z - GROVE.z);
  m = Math.max(m, smooth(GROVE.r + 10, GROVE.r - 15, gd));
  const rd = riverDist(x, z).d, ld = lakeDist(x, z);
  m *= smooth(25, 60, rd) * smooth(10, 40, ld);
  return m;
}

// ---------- warped terrain grid (dense near the knoll, sparse far away)
// world = C + L * sinh(k*u)/sinh(k), u in [-1,1]
export const GRID = { N: 2048, cx: 60, cz: 40, Lx: 16000, Lz: 16000, k: 6.6 };
const SK = Math.sinh(GRID.k);
export const gridX = i => GRID.cx + GRID.Lx * Math.sinh(GRID.k * (i / (GRID.N - 1) * 2 - 1)) / SK;
export const gridZ = j => GRID.cz + GRID.Lz * Math.sinh(GRID.k * (j / (GRID.N - 1) * 2 - 1)) / SK;
const invX = x => (Math.asinh((x - GRID.cx) * SK / GRID.Lx) / GRID.k + 1) * 0.5 * (GRID.N - 1);
const invZ = z => (Math.asinh((z - GRID.cz) * SK / GRID.Lz) / GRID.k + 1) * 0.5 * (GRID.N - 1);

// Sample a baked height grid (Float32Array N*N, row-major j*N+i) matching the mesh triangulation.
export function makeSampler(H) {
  const N = GRID.N;
  return (x, z) => {
    let fi = invX(x), fj = invZ(z);
    fi = Math.max(0, Math.min(N - 1.001, fi)); fj = Math.max(0, Math.min(N - 1.001, fj));
    const i = Math.floor(fi), j = Math.floor(fj), u = fi - i, v = fj - j;
    const h00 = H[j * N + i], h10 = H[j * N + i + 1], h01 = H[(j + 1) * N + i], h11 = H[(j + 1) * N + i + 1];
    return u > v ? h00 + (h10 - h00) * u + (h11 - h10) * v : h00 + (h11 - h01) * u + (h01 - h00) * v;
  };
}
