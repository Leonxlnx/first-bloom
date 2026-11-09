// The meadow: instanced grass tufts + five stylised wildflower species.
//
// Placement is baked once on the CPU from the film's own camera paths: every
// camera sample (macro pull-back, FPV, canopy, reveal) marks the ground it can
// see, giving a per-cell "closest in-view distance". Instance density follows
// rho(d) = rho0 * min(1, (d0/d)^p), so the FPV corridor is dense and density
// falls away from every camera path. Each instance stores a rank q (density
// units); the vertex shader keeps it only while q < rho(current distance), so
// the same buffers give a smooth, world-stable distance LOD for every shot.
//
// Season: everything is driven by the same noisy arrival as the terrain's
// bloomAmt(). Winter = buried grass with a few frosted blades and frozen buds
// poking through; at the wavefront grass erupts with a damped-spring overshoot
// and flowers pop open in staggered clustered bursts.
import * as THREE from 'three';
import * as L from './layout.js';
import { worldMaterial, rng } from './common.js';
import { PALETTE_GLSL } from './terrain.js';

const DEG = Math.PI / 180;
const TAN_REF = Math.tan(31 * DEG); // FPV half-fov: distances are normalised to this lens

// ------------------------------------------------------------------ tuning
export const VEG = {
  grass: { rho0: 80, d0: 4.0, p: 1.4, dmax: 105 },   // tufts / m^2 near the lens, falloff
  flower: { rho0: 9, d0: 3.6, p: 1.3, dmax: 130 },   // flowers / m^2 (x regional weight)
  cell: 1.0,                 // bake grid (m)
  budClear: 0.6,             // hero zone radius around the bud (m)
  creekClear: 1.25,          // no instances this close to a creek centreline (m)
  reedBand: 3.2,             // reeds between creekClear and this (m)
  reedFrac: 0.1,             // fraction of bank tufts that are reeds (winter: they stand above the snow)
  bladeW: 0.016,             // base blade width (m)
  minPx: 3.0,                // minimum blade/stem width in 4K pixels
  widen: 1.0,                // extra blade width far away (painterly clumps)
  farGrow: 1.6,              // flower heads grow by (1+farGrow) at ~90 m (readability)
  winterFrac: 0.16,          // fraction of tufts with frosted blades poking through the snow
  wind: 1.0,
  trans: 1.0,                // grass back-light translucency
  carpet: [55, 95, 1.0],     // ground cover fade start/end (effective m), flower-dab amount
  far: [50, 90, 9],          // far flower carpet: fade-in start/end (effective m), stroke size (1080p px)
  farK: [0.72, 0.26, 0.2, 1.0],  // far carpet: head opacity (unused: per region), gap darkening, cast shadow, strength
  farStride: 2,              // far carpet mesh: every n-th terrain grid vertex
  leafFrac: 0.07,            // fraction of tufts that are broadleaf weed rosettes
  flowerScale: 1.6,          // stylised: heads larger than life so they read on screen
  lodSwitch: [11, 13],       // near->far geometry switch (effective m) for grass, flowers
};
// debug/tuning overrides from the URL: &veg=grho:80,gp:1.2,fr:10,bw:0.02
function applyOverrides(q) {
  const s = q && q.get && q.get('veg'); if (!s) return;
  const map = { grho: ['grass', 'rho0'], gd0: ['grass', 'd0'], gp: ['grass', 'p'], gmax: ['grass', 'dmax'], fr: ['flower', 'rho0'], fd0: ['flower', 'd0'], fp: ['flower', 'p'], fmax: ['flower', 'dmax'] };
  for (const kv of s.split(',')) {
    const [k, v] = kv.split(':'); const n = +v; if (!isFinite(n)) continue;
    if (map[k]) VEG[map[k][0]][map[k][1]] = n;
    else if (k === 'bw') VEG.bladeW = n; else if (k === 'px') VEG.minPx = n; else if (k === 'wid') VEG.widen = n;
    else if (k === 'fg') VEG.farGrow = n; else if (k === 'tr') VEG.trans = n; else if (k === 'wf') VEG.winterFrac = n;
  }
}
// per-shot switches: visibility + lens clearance sphere (m)
// (gmax/fmax: draw distance of grass/flowers in effective metres; default = bake range)
// (far: the basin-wide far flower carpet)
const SHOTS = {
  macro: { vis: true, lens: 0.28 },
  fpv: { vis: true, lens: 0.42 },
  canopy: { vis: true, lens: 0.5 },
  reveal: { vis: true, far: true, lens: 0.0, gmax: 60, fmax: 100 },
  falls: { vis: false, far: true, lens: 0 },
  aerial: { vis: false, far: true, lens: 0 },
};

// five species: petal count, petal length L (m), receptacle radius, open / bud
// angle from the head axis, curl (rad per petal length), cross cup, centre dome
const FLOWERS = [
  { id: 'pasque', n: 6, nu: 3, nv: 4, L: 0.036, rc: 0.003, openA: 0.50, budA: 0.06, curlO: 0.42, curlB: -1.1, cup: 0.32, cR: 0.0085, cH: 0.009, budS: 0.6,
    shape: v => 0.40 * Math.pow(Math.max(0, Math.sin(Math.PI * (0.12 + 0.86 * v))), 0.8), stemW: 0.0034, scale: [0.85, 1.2],
    c0: '#3F27A8', c1: '#7450E4', cc: '#FFC42E', ct: '#9A78FF', neutral: 0.55, gloss: 0.08, blotch: 0, trans: 0.65 },
  { id: 'cobalt', n: 5, nu: 3, nv: 4, L: 0.027, rc: 0.002, openA: 1.12, budA: 0.08, curlO: 0.45, curlB: -1.0, cup: 0.16, cR: 0.0055, cH: 0.004, budS: 0.6,
    shape: v => 0.42 * Math.pow(Math.max(0, Math.sin(Math.PI * (0.10 + 0.80 * v))), 0.7), stemW: 0.003, scale: [0.85, 1.2],
    c0: '#1F3FB0', c1: '#3A6CEC', cc: '#F4EFD8', ct: '#86A8FF', neutral: 0.75, gloss: 0.12, blotch: 0, trans: 0.8 },
  { id: 'daisy', n: 13, nu: 2, nv: 3, L: 0.022, rc: 0.0065, openA: 1.45, budA: 0.12, curlO: 0.22, curlB: -1.3, cup: 0.0, cR: 0.0075, cH: 0.0055, budS: 0.55,
    shape: v => 0.115 * (v < 0.8 ? 1 : 1 - (v - 0.8) * 2.4), stemW: 0.0028, scale: [0.85, 1.2],
    c0: '#E4E2D6', c1: '#F7F5EE', cc: '#FFC21E', ct: '#FFF4D6', neutral: 0.3, gloss: 0.05, blotch: 0, trans: 0.6 },
  { id: 'buttercup', n: 5, nu: 3, nv: 3, L: 0.016, rc: 0.002, openA: 0.95, budA: 0.1, curlO: 0.65, curlB: -1.2, cup: 0.34, cR: 0.0045, cH: 0.004, budS: 0.65,
    shape: v => 0.56 * Math.pow(Math.max(0, Math.sin(Math.PI * (0.12 + 0.62 * v))), 0.5), stemW: 0.0026, scale: [0.9, 1.25],
    c0: '#F0B414', c1: '#FFD23A', cc: '#C9C23A', ct: '#FFE27A', neutral: 0.2, gloss: 0.9, blotch: 0, trans: 0.7 },
  { id: 'poppy', n: 4, nu: 3, nv: 4, L: 0.040, rc: 0.004, openA: 0.86, budA: 0.05, curlO: 0.6, curlB: -1.3, cup: 0.3, cR: 0.008, cH: 0.012, budS: 0.6,
    shape: v => 0.80 * Math.pow(Math.max(0, Math.sin(Math.PI * (0.10 + 0.62 * v))), 0.55), stemW: 0.0034, scale: [0.85, 1.2],
    c0: '#D93A1E', c1: '#F2552C', cc: '#2B2A1C', ct: '#FF7A3C', neutral: 0.15, gloss: 0.1, blotch: 1, trans: 1.0 },
];
const FI = Object.fromEntries(FLOWERS.map((f, i) => [f.id, i]));

// ------------------------------------------------------------------ helpers
const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function hashI(ix, iz) {
  let h = Math.imul(ix | 0, 374761393) + Math.imul(iz | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const rhoAt = (P, d) => P.rho0 * Math.min(1, Math.pow(P.d0 / Math.max(d, 1e-3), P.p)) * (1 - sm(P.dmax * 0.75, P.dmax, d));

// ------------------------------------------------------------------ GLSL
const VEG_COMMON = /* glsl */`
${PALETTE_GLSL}
uniform vec3 uCamPos; uniform float uPxScale; uniform float uFovK; uniform float uBloomRate;
uniform vec4 uLodG; uniform vec4 uLodF; uniform float uLensR; uniform float uWindAmt;
uniform vec4 uVegK; // bladeW, minPx, widen, farGrow
uniform float uWinterFrac; uniform float uTransAmt;
uniform vec3 uBand; // LOD band of this mesh: switch distance (effective m), 1 = far mesh, dither width
float vegSpring(float t, float f, float d) { return t <= 0.0 ? 0.0 : 1.0 - exp(-d * t) * cos(f * t); }
float vegRho(vec4 P, float d) { return P.x * min(1.0, pow(P.y / max(d, 1e-3), P.w)) * (1.0 - smoothstep(P.z * 0.75, P.z, d)); }
// identical to the noisy arrival inside bloomAmt(), so the meadow erupts exactly where the snow melts
float vegArrival(vec2 xz) { return arrival(xz) + (fbm(xz * 0.11) - 0.5) * uBloomNoise * 2.0 + (vnoise(xz * 0.9) - 0.5) * 0.6; }
// true when this instance belongs to the other LOD mesh (dithered switch, no double draw)
bool vegOtherBand(float de, float seed) {
  float sw = uBand.x + (fract(seed * 7.77) - 0.5) * uBand.z;
  return (uBand.y > 0.5) != (de > sw);
}
#ifdef IS_VERTEX
bool vegCulled(vec3 c, float R) {
  vec4 cb = projectionMatrix * viewMatrix * vec4(c, 1.0);
  if (cb.w < -R) return true;
  float rx = R * abs(projectionMatrix[0][0]), ry = R * abs(projectionMatrix[1][1]);
  return abs(cb.x) > cb.w + rx || abs(cb.y) > cb.w + ry;
}
vec3 vegLensPush(vec3 p) {
  if (uLensR <= 0.0) return p;
  vec3 dv = p - uCamPos; float dl = length(dv);
  if (dl >= uLensR || dl < 1e-5) return p;
  return uCamPos + dv / dl * uLensR;
}
#endif
`;

const GRASS_VERT = /* glsl */`
${VEG_COMMON}
attribute vec4 aB0;  // root offset xz, azimuth, lean
attribute vec4 aB1;  // height f, width f, bend, rank (winter selection)
attribute vec2 aV;   // side (-1/0/1), v along blade
attribute vec4 iPos; // x y z rot
attribute vec4 iPar; // spring height (m), q, seed, kind (0 grass, 1 reed, 2 broadleaf weed, 3 tall stalks)
attribute vec4 iExt; // region tint (0 meadow, 1 petal, 2 heart), creek proximity, -, -
varying vec3 vWorld; varying vec3 vN; varying vec4 vA; varying vec4 vB; varying float vFresh;
void killVert() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vWorld = vec3(0.0); vN = vec3(0.0, 1.0, 0.0); vA = vec4(0.0); vB = vec4(0.0); vFresh = 0.0; }
void main() {
  vec3 base = iPos.xyz;
  float dist = distance(base, uCamPos);
  float de = dist * uFovK;
  float rho = vegRho(uLodG, de);
  float lod = 1.0 - smoothstep(rho * 0.72, rho, iPar.y);
  float hS = iPar.x, kind = iPar.w, seed = iPar.z;
  float reed = step(0.5, kind) * step(kind, 1.5), leaf = step(1.5, kind) * step(kind, 2.5), tall = step(2.5, kind);
  if (lod <= 0.0 || vegOtherBand(de, seed) || vegCulled(base + vec3(0.0, hS * 0.5, 0.0), hS * 0.9 + 0.3)) { killVert(); return; }
  if (reed > 0.5 && aB1.w > 0.5) { killVert(); return; }   // reeds: a few tall separate stems
  if (tall > 0.5 && aB1.w > 0.72) { killVert(); return; }  // tall stalks: 5 seed-head stems
  // blade-count variety: many tufts carry only 4-6 of their 7 blades (never the frosted winter ones)
  if (reed + tall < 0.5 && aB1.w > mix(0.6, 1.0, fract(seed * 5.13))) { killVert(); return; }
  float s = uBloomD - vegArrival(base.xz);
  float winterTuft = reed > 0.5 ? 1.0 : step(seed, uWinterFrac) * (1.0 - leaf);
  float bladeOn = step(aB1.w, reed > 0.5 ? 0.8 : 0.45);
  float hW = winterTuft * bladeOn * (reed > 0.5 ? mix(0.22, 0.5, fract(seed * 13.7)) : mix(0.05, 0.16, fract(seed * 7.31)));
  if (s < 0.0 && hW <= 0.0) { killVert(); return; }
  // eruption behind the front: rises over ~0.3 s, overshoots ~16 % at ~0.5 s, settles
  float tau = s / uBloomRate - fract(seed * 3.17) * 0.12;
  float g = vegSpring(tau, 6.0, 3.5);
  float bladeH = aB1.x * (0.8 + 0.4 * fract(seed * 13.1 + aB1.w * 7.31)) * mix(1.0, 0.3, leaf);
  float hb = mix(hW, hS, g) * bladeH * lod;
  float grow = clamp(hb / max(hS * bladeH, 1e-3), 0.0, 1.0);
  float far = smoothstep(6.0, 60.0, de);
  float w0 = uVegK.x * aB1.y * mix(0.55, 1.0, sqrt(grow)) * (1.0 + uVegK.z * far) * (reed > 0.5 ? 0.8 : 1.0) * (1.0 + 0.35 * uBand.y);
  w0 *= mix(1.0, 5.5, leaf) * mix(1.0, 0.85, tall);
  w0 = max(w0, uVegK.y * dist / uPxScale);
  float spread = 1.0 + 1.4 * far;

  float c = cos(iPos.w), sn = sin(iPos.w);
  vec2 ro = mat2(c, sn, -sn, c) * aB0.xy * spread;
  vec3 root = base + vec3(ro.x, 0.0, ro.y);
  float ang = aB0.z + iPos.w;
  vec2 ld = vec2(cos(ang), sin(ang));
  vec2 wind = windAt(base.xz, uTime) * uWindAmt;
  float gust = length(wind);
  float flick = sin(uTime * (4.0 + 3.0 * aB1.w) + aB1.w * 37.0 + base.x * 1.7 + base.z * 1.3);
  float springy = clamp(g, 0.0, 1.0);
  vec2 lb = vec2(cos(seed * 61.0), sin(seed * 61.0)) * 0.22;     // per-tuft lean bias (~ +-12 deg)
  vec2 lean = mix(ld * aB0.w * (reed > 0.5 ? 0.5 : 1.0) + lb, ld * 0.9, leaf)
            + (wind * (0.30 + 0.25 * aB1.z) + ld * flick * 0.05 * (0.4 + gust)) * springy * (1.0 - 0.75 * leaf);
  vec2 off = lean * hb;
  float ol = length(off), maxo = 0.88 * hb;
  if (ol > maxo) { off *= maxo / ol; ol = maxo; }
  float tipY = sqrt(max(hb * hb - ol * ol, 0.0));
  float bz = aB1.z;
  vec3 P1 = vec3(off.x * 0.15 * (1.0 - bz), tipY * (0.55 + 0.3 * bz), off.y * 0.15 * (1.0 - bz));
  vec3 P2 = vec3(off.x, tipY, off.y);
  float v = aV.y;
  vec3 p = 2.0 * (1.0 - v) * v * P1 + v * v * P2;
  vec3 tg = normalize(2.0 * (1.0 - v) * P1 + 2.0 * v * (P2 - P1) + vec3(0.0, 1e-4, 0.0));
  float tw = (aB1.w - 0.5) * 1.4 * v;
  vec3 sd0 = vec3(-ld.y, 0.0, ld.x), fw0 = vec3(ld.x, 0.0, ld.y);
  vec3 sd = sd0 * cos(tw) + fw0 * sin(tw);
  sd = normalize(sd - tg * dot(sd, tg));
  float wprof = leaf > 0.5 ? pow(max(sin(3.14159 * min(v * 0.94 + 0.06, 1.0)), 0.0), 0.75)   // ovate weed leaf
                           : (1.0 - pow(v, 1.6)) * (0.8 + 0.2 * (1.0 - v));
  vec3 pos = root + p + sd * (aV.x * 0.5 * w0 * wprof);
  vec3 nrm = normalize(cross(sd, tg));
  nrm = normalize(nrm + sd * aV.x * 0.4);
  pos = vegLensPush(pos);
  vWorld = pos; vN = nrm;
  // frost melts off right at the front, so the snow -> green edge stays crisp
  vA = vec4(v, aV.x, 1.0 - smoothstep(0.0, uBloomWidth * 0.22, s), fract(seed * 23.17));
  vB = vec4(smoothstep(0.0, uBloomWidth, s), gust, kind, iExt.x);
  vFresh = s > 0.0 ? 1.0 - smoothstep(0.0, 0.9, tau) : 0.0;
  gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
}`;

const GRASS_FRAG = /* glsl */`
${VEG_COMMON}
varying vec3 vWorld; varying vec3 vN; varying vec4 vA; varying vec4 vB; varying float vFresh;
void main() {
  float v = vA.x, frost = vA.z, hue = vA.w;
  float kindF = vB.z, tint = vB.w, gust = vB.y;
  float kind = step(0.5, kindF) * step(kindF, 1.5);              // reeds
  float leaf = step(1.5, kindF) * step(kindF, 2.5), tall = step(2.5, kindF);
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 N = normalize(vN);
  if (dot(N, V) < 0.0) N = -N;
  vec3 Ns = normalize(mix(N, vec3(0.0, 1.0, 0.0), 0.45));
  vec2 xz = vWorld.xz;
  float patchN = vnoise(xz * 0.07) * 0.6 + vnoise(xz * 0.23 + 4.0) * 0.4;

  // ---- spring albedo: dark viridian roots -> emerald body -> lighter tips
  float warm = smoothstep(0.3, 0.75, patchN);            // painterly colour masses
  float deF = length(vWorld - uCamPos) * uFovK;
  vec3 rootC = mix(C_VIRIDIAN * 0.18, C_EMERALD * 0.32, smoothstep(5.0, 40.0, deF));
  vec3 midC = mix(C_VIRIDIAN * 0.95, C_EMERALD * 0.85, 0.35 + 0.5 * warm);
  vec3 tipC = mix(C_EMERALD * 1.0, C_CHARTREUSE * 0.9, 0.2 + 0.45 * warm + 0.2 * hue);
  // regional tint: petals a touch cooler, heart warmer, reeds darker
  float pet = step(0.5, tint) * step(tint, 1.5);
  midC = mix(midC, midC * vec3(0.8, 0.95, 1.15), pet * 0.6);
  tipC = mix(tipC, tipC * vec3(0.85, 0.97, 1.1), pet * 0.5);
  tipC = mix(tipC, C_CHARTREUSE * vec3(1.05, 1.0, 0.7), step(1.5, tint) * 0.45);
  midC = mix(midC, C_VIRIDIAN * 0.7, kind * 0.5);
  tipC = mix(tipC, C_EMERALD * 0.75, kind * 0.5);
  // tall stalks: warm straw-gold seed heads; fresh growth: bright young chartreuse
  tipC = mix(tipC, s2l(vec3(0.80, 0.78, 0.40)), tall * 0.55);
  tipC = mix(tipC, C_CHARTREUSE * 1.1, vFresh * 0.55);
  vec3 alb = mix(rootC, midC, smoothstep(0.0, 0.5, v));
  alb = mix(alb, tipC, smoothstep(0.45, 1.0, v));
  // broadleaf weeds: darker, glossier rosettes with a lighter midrib
  vec3 leafC = mix(C_VIRIDIAN * 0.5, C_EMERALD * 0.75, 0.3 + 0.5 * hue) * (0.85 + 0.3 * smoothstep(0.7, 0.0, abs(vA.y)));
  alb = mix(alb, mix(rootC, leafC, smoothstep(0.0, 0.35, v)), leaf);
  alb *= 0.8 + 0.4 * patchN;
  alb *= 1.0 + 0.3 * gust * gust * smoothstep(0.3, 1.0, v);

  // ---- winter: straw blade under white rime
  vec3 straw = s2l(vec3(0.55, 0.56, 0.50)) * 0.55;
  vec3 rime = s2l(vec3(0.91, 0.945, 1.0));
  vec3 winterC = mix(straw, rime * 1.05, smoothstep(0.1, 0.65, v) * 0.85 + 0.12);
  alb = mix(alb, winterC, frost);

  float sh = sunShadow(vWorld, 1.5) * cloudShadow(vWorld);
  vec3 sunC = uSunColor * sh;
  float ndl = dot(Ns, uSunDir);
  float diff = clamp((ndl + 0.5) / 1.5, 0.0, 1.0);
  diff = diff * diff * (3.0 - 2.0 * diff);
  float ao = mix(mix(0.28, 0.55, frost), 1.0, smoothstep(0.0, 0.85, v));
  vec3 hemi = mix(uGroundBounce, uSkyAmbient, Ns.y * 0.5 + 0.5);
  // back-light translucency (sun behind the blade) + forward scattering toward the lens
  float back = max(-dot(N, uSunDir), 0.0);
  float fwd = pow(max(dot(-V, uSunDir), 0.0), 4.0);
  float thin = smoothstep(0.15, 1.0, v);
  thin *= thin;
  vec3 transC = mix(C_CHARTREUSE, s2l(vec3(1.0, 0.9, 0.42)), 0.25) * mix(0.8, 1.15, warm);
  vec3 trans = transC * (back * 0.45 + fwd * 0.9) * thin * uTransAmt * (1.0 - frost) * (1.0 + 0.8 * vFresh) * (1.0 - 0.6 * leaf);
  vec3 Hh = normalize(uSunDir + V);
  float spec = pow(max(dot(N, Hh), 0.0), 28.0) * (mix(0.10, 0.5, frost) + 0.25 * leaf);
  vec3 col = alb * (sunC * diff * ao + hemi * ao) + sunC * trans * ao + sunC * spec * ao;
  // rime scatters the low dawn light: frosted tips glow pale gold when backlit, and
  // carry a soft lavender sky sheen so they never go to dark silhouettes
  col += frost * smoothstep(0.25, 1.0, v) * (sunC * s2l(vec3(1.0, 0.93, 0.8)) * (fwd * 0.5 + back * 0.15) + uSkyAmbient * C_SNOW_SH * 0.35);
  // winter rime glints at the blade tips
  float gl = step(0.78, hash12(floor(vWorld.xz * 60.0) + floor(v * 4.0)));
  col += frost * gl * smoothstep(0.5, 1.0, v) * pow(max(dot(reflect(-uSunDir, N), V), 0.0), 12.0) * (uSunColor + uSkyAmbient * 2.0) * 0.6;
  col = applyFog(col, vWorld);
  gl_FragColor = vec4(col, 1.0);
}`;

const FLOWER_VERT = /* glsl */`
${VEG_COMMON}
attribute vec4 aF0;  // part (0 stem, 1 petal, 2 centre), petal angle, petal rnd, -
attribute vec4 aF1;  // petal across (L units) / dome x, along 0..1 / dome y, side, -
attribute vec4 iPos; // x y z rot
attribute vec4 iPar; // stem height, q, seed, head scale
attribute vec4 iDir; // tilt x, tilt z, winter-visible bud, pop distance behind the front (m)
uniform vec4 uFP0;   // L, receptacle r, open angle, bud angle
uniform vec4 uFP1;   // curl open, curl bud, cup, centre radius
uniform vec4 uFP2;   // centre height, stem width, bud scale, -
varying vec3 vWorld; varying vec3 vN; varying vec4 vA; varying vec4 vB;
void killVert() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vWorld = vec3(0.0); vN = vec3(0.0, 1.0, 0.0); vA = vec4(0.0); vB = vec4(0.0); }
void main() {
  vec3 base = iPos.xyz;
  float dist = distance(base, uCamPos);
  float de = dist * uFovK;
  float rho = vegRho(uLodF, de);
  float lod = 1.0 - smoothstep(rho * 0.72, rho, iPar.y);
  float stemFull = iPar.x, seed = iPar.z;
  if (lod <= 0.0 || vegOtherBand(de, seed) || vegCulled(base + vec3(0.0, stemFull * 0.6, 0.0), stemFull * 0.7 + 0.2)) { killVert(); return; }
  float s = uBloomD - vegArrival(base.xz);
  float wv = iDir.z;
  if (s < 0.0 && wv < 0.5) { killVert(); return; }
  float tau = s / uBloomRate;
  // stems spring up right behind the front; heads pop open 0.5-2 m behind it (whole clusters together)
  float gs = vegSpring(tau - 0.02, 8.0, 4.0);
  float op = max(vegSpring((s - iDir.w) / uBloomRate, 11.0, 4.5), 0.0);
  float o1 = clamp(op, 0.0, 1.0);
  float stemW = wv * mix(0.05, 0.11, fract(seed * 5.3));
  float sh = mix(stemW, stemFull, gs) * lod;
  float far = smoothstep(12.0, 90.0, de);
  float hsc = iPar.w * mix(uFP2.z, 1.0, clamp(gs, 0.0, 1.2)) * (1.0 + uVegK.w * far) * lod;
  vec2 wind = windAt(base.xz, uTime) * uWindAmt * clamp(gs, 0.0, 1.0);
  float ph = seed * 40.0;
  vec2 sway = wind * 0.2 + vec2(sin(uTime * (2.6 + 2.0 * fract(seed * 9.1)) + ph), cos(uTime * 2.3 + ph * 1.3)) * 0.025;
  vec2 hoff = sway * sh;
  float hl = length(hoff);
  vec3 C = base + vec3(hoff.x, sqrt(max(sh * sh - hl * hl, 0.0)), hoff.y);
  vec2 tilt = iDir.xy + sway * 1.6;
  vec3 A = normalize(vec3(tilt.x, 1.0, tilt.y));
  vec3 B1 = normalize(cross(A, vec3(0.0, 0.0, 1.0)));
  vec3 B2 = cross(A, B1);
  float part = aF0.x;
  float px = aF1.x, py = aF1.y;
  vec3 pos, nrm;
  if (part < 0.5) {
    vec3 P0 = base, P2 = C - A * 0.003 * hsc;
    vec3 P1 = base + vec3(0.0, sh * 0.6, 0.0) + vec3(hoff.x, 0.0, hoff.y) * 0.25;
    vec3 p = mix(mix(P0, P1, py), mix(P1, P2, py), py);
    vec3 tg = normalize(mix(P1 - P0, P2 - P1, py) + vec3(0.0, 1e-4, 0.0));
    vec3 vd = normalize(uCamPos - p);
    vec3 sdv = normalize(cross(tg, vd) + vec3(1e-5, 0.0, 0.0));
    float w = max(uFP2.y * (1.0 + far), uVegK.y * distance(p, uCamPos) / uPxScale) * (1.0 - 0.25 * py);
    pos = p + sdv * aF1.z * 0.5 * w;
    nrm = normalize(cross(sdv, tg) + sdv * aF1.z * 0.5);
  } else if (part < 1.5) {
    float th = aF0.y + iPos.w;
    vec3 R = cos(th) * B1 + sin(th) * B2;
    vec3 T = cross(A, R);
    float pr = aF0.z;
    float alpha = mix(uFP0.w, uFP0.z + (pr - 0.5) * 0.2, clamp(op, 0.0, 1.3));
    float kap = mix(uFP1.y, uFP1.x, o1);
    float Lp = uFP0.x * hsc * mix(0.62, 1.0, o1) * (0.9 + 0.2 * pr);
    float ph1 = alpha + kap * py;
    float upA, radA;
    if (abs(kap) < 1e-3) { upA = py * cos(alpha); radA = py * sin(alpha); }
    else { upA = (sin(ph1) - sin(alpha)) / kap; radA = (cos(alpha) - cos(ph1)) / kap; }
    vec3 nIn = sin(ph1) * A - cos(ph1) * R;
    float cup = uFP1.z * mix(1.8, 1.0, o1);
    float pxw = px * mix(0.8, 1.0, o1);
    pos = C + R * uFP0.y * hsc + (A * upA + R * radA) * Lp + T * pxw * Lp + nIn * cup * pxw * pxw * Lp;
    nrm = normalize(nIn - T * 2.0 * cup * pxw);
  } else {
    float rr = length(aF1.xy);
    pos = C + A * uFP2.x * hsc * (1.0 - rr * rr) * clamp(op * 1.2, 0.0, 1.0) + (B1 * aF1.x + B2 * aF1.y) * uFP1.w * hsc * mix(0.5, 1.0, o1);
    nrm = normalize(A + (B1 * aF1.x + B2 * aF1.y) * 1.2);
  }
  pos = vegLensPush(pos);
  vWorld = pos; vN = nrm;
  vA = vec4(part, px, py, 1.0 - smoothstep(0.0, uBloomWidth * 0.6, s));
  vB = vec4(o1, smoothstep(0.0, uBloomWidth, s), fract(seed * 17.3), far);
  gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
}`;

const FLOWER_FRAG = /* glsl */`
${VEG_COMMON}
uniform vec3 uC0; uniform vec3 uC1; uniform vec3 uCC; uniform vec3 uCT;
uniform vec4 uFP3; // neutral sun, gloss, blotch, translucency
varying vec3 vWorld; varying vec3 vN; varying vec4 vA; varying vec4 vB;
void main() {
  float part = vA.x, frost = vA.w;
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 N = normalize(vN);
  if (dot(N, V) < 0.0) N = -N;
  vec3 alb; float trans, gloss;
  if (part < 0.5) {
    alb = mix(C_VIRIDIAN * 0.45, C_EMERALD * 0.55, vA.z);
    trans = 0.35; gloss = 0.05;
  } else if (part < 1.5) {
    float py = vA.z;
    alb = mix(uC0, uC1, smoothstep(0.0, 0.85, py));
    alb *= 0.92 + 0.16 * vB.z;
    alb = mix(alb, s2l(vec3(0.09, 0.06, 0.08)), uFP3.z * (1.0 - smoothstep(0.10, 0.24, py)));
    trans = uFP3.w; gloss = uFP3.y;
  } else {
    alb = uCC; trans = 0.15; gloss = 0.25;
  }
  vec3 rime = s2l(vec3(0.91, 0.945, 1.0));
  alb = mix(alb, mix(alb * 0.5 + rime * 0.3, rime * 0.88, 0.7), frost);

  float sh = sunShadow(vWorld, 1.5) * cloudShadow(vWorld);
  vec3 sunC = mix(uSunColor, vec3(dot(uSunColor, vec3(0.2126, 0.7152, 0.0722))), uFP3.x) * sh;
  float ndl = dot(N, uSunDir);
  float diff = clamp((ndl + 0.35) / 1.35, 0.0, 1.0);
  vec3 hemi = mix(uGroundBounce, uSkyAmbient, N.y * 0.5 + 0.5);
  float back = max(-ndl, 0.0) * 0.8 + pow(max(dot(-V, uSunDir), 0.0), 3.0) * 0.6;
  vec3 tc = part < 0.5 ? C_CHARTREUSE * 0.6 : (part < 1.5 ? uCT : uCC);
  vec3 col = alb * (sunC * diff + hemi * 0.95) + tc * sunC * back * trans * (1.0 - frost) * 0.6;
  vec3 Hh = normalize(uSunDir + V);
  col += sunC * pow(max(dot(N, Hh), 0.0), 36.0) * gloss * (1.0 - frost * 0.5);
  col += frost * step(0.8, hash12(floor(vWorld.xz * 300.0))) * pow(max(dot(reflect(-uSunDir, N), V), 0.0), 10.0) * (uSunColor + uSkyAmbient * 2.0) * 0.5;
  col = applyFog(col, vWorld);
  gl_FragColor = vec4(col, 1.0);
}`;

// Ground cover: the terrain's own grid cells (identical vertex heights) drawn
// with a polygon offset as a transparent layer. It turns the ground between
// blades into a deep grass floor near the lens and paints painterly flower
// dabs at mid range (where instances thin out), fading into the terrain's
// colour wash far away. Winter (bloom 0) is fully transparent.
const CARPET_VERT = /* glsl */`
uniform sampler2D tHeight; uniform vec4 uGrid; uniform vec3 uGridK; uniform vec2 uPull;
attribute vec2 aIJ;
varying vec3 vWorld; varying vec3 vNormal;
float gx(float i) { return uGrid.x + uGrid.z * sinh(uGridK.x * (i / uGridK.z * 2.0 - 1.0)) * uGridK.y; }
float gz(float j) { return uGrid.y + uGrid.w * sinh(uGridK.x * (j / uGridK.z * 2.0 - 1.0)) * uGridK.y; }
void main() {
  ivec2 ij = ivec2(aIJ);
  int NM = int(uGridK.z);
  float h = texelFetch(tHeight, ij, 0).r;
  vec3 wp = vec3(gx(aIJ.x), h, gz(aIJ.y));
  ivec2 ia = ivec2(max(ij.x - 1, 0), ij.y), ib = ivec2(min(ij.x + 1, NM), ij.y);
  ivec2 ja = ivec2(ij.x, max(ij.y - 1, 0)), jb = ivec2(ij.x, min(ij.y + 1, NM));
  float dhx = (texelFetch(tHeight, ib, 0).r - texelFetch(tHeight, ia, 0).r) / (gx(float(ib.x)) - gx(float(ia.x)));
  float dhz = (texelFetch(tHeight, jb, 0).r - texelFetch(tHeight, ja, 0).r) / (gz(float(jb.y)) - gz(float(ja.y)));
  vNormal = normalize(vec3(-dhx, 1.0, -dhz));
  vWorld = wp;
  // (far carpet: coarser cells than the terrain -> pull toward the lens along the view ray,
  // which keeps the screen position and only lifts the depth over the terrain's curvature)
  vec3 tv = cameraPosition - wp;
  wp += tv / max(length(tv), 1e-3) * (uPull.x + uPull.y * length(tv));
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

const CARPET_FRAG = /* glsl */`
${VEG_COMMON}
uniform vec4 uCarpet; // fade start, fade end (effective m), dab amount, -
varying vec3 vWorld; varying vec3 vNormal;
// distance to the nearest petal-axis creek (analytic twin of layout.CREEKS)
float vegCreekDist(vec2 xz) {
  float r = length(xz);
  if (r < 50.0 || r > 1100.0) return 1e4;
  float phi = atan(xz.y, xz.x);
  float L0 = 0.39269908, S = 1.04719755;
  float rel = mod(phi - L0 + 3.14159265, 6.28318531) - 3.14159265;
  float k = mod(floor(rel / S + 0.5) + 6.0, 6.0);
  float ax = L0 + k * S;
  float rr = max(r, 90.0);
  float w = sin(rr * 0.011 + k * 1.7) * 9.0 + sin(rr * 0.031 + k) * 3.5;
  float a = ax + w / rr;
  vec2 cp = vec2(cos(a), sin(a)) * rr;
  if (r < 90.0) return length(xz - cp);
  float dp = mod(phi - a + 3.14159265, 6.28318531) - 3.14159265;
  return abs(r * sin(dp));
}
float dabMask(vec2 xz, float cov, float freq, float seed, float de) {
  float n = vnoise(xz * freq + seed) * 0.65 + vnoise(xz * freq * 2.3 + seed * 1.7) * 0.35;
  float nearM = smoothstep(1.0 - cov - 0.07, 1.0 - cov + 0.07, n);
  return mix(nearM, cov, smoothstep(35.0, 90.0, de));
}
void main() {
  vec3 wp = vWorld; vec2 xz = wp.xz;
  float de = length(wp - uCamPos) * uFovK;
  float bloom = bloomAmt(xz);
  float a = smoothstep(0.06, 0.45, bloom) * (1.0 - smoothstep(uCarpet.x, uCarpet.y, de)) * smoothstep(0.6, 1.4, length(xz));   // hero zone keeps the terrain
  vec4 inf = infoAt(xz);
  a *= smoothstep(18.0, 26.0, inf.x) * smoothstep(1.0, 4.0, inf.z);
  if (a < 0.004) discard;
  a *= smoothstep(0.9, 2.0, vegCreekDist(xz));
  if (a < 0.004) discard;
  vec4 inf2 = info2At(xz);
  float r = inf2.y;
  vec3 N = normalize(vNormal);
  // grass floor: deep near the lens, the blades' average colour further away
  float patchN = vnoise(xz * 0.07) * 0.6 + vnoise(xz * 0.23 + 4.0) * 0.4;
  float warm = smoothstep(0.3, 0.75, patchN);
  vec3 deep = mix(C_VIRIDIAN * 0.26, C_EMERALD * 0.26, warm);
  vec3 avg = mix(C_VIRIDIAN * 0.8, C_EMERALD * 0.62, 0.3 + 0.4 * warm);
  avg = mix(avg, C_CHARTREUSE * 0.62, 0.18 + 0.3 * warm);
  // (short grass around the hero bud: no deep floor there)
  vec3 alb = mix(deep, avg, max(smoothstep(3.0, 35.0, de), 1.0 - smoothstep(2.0, 6.0, r)));
  float drift2 = fbm(xz * 0.03 + 11.0);
  float petalIn = 1.0 - smoothstep(-16.0, 16.0, inf2.x);
  float heart = 1.0 - smoothstep(67.0, 95.0, r + (drift2 - 0.5) * 30.0);
  alb = mix(alb, alb * vec3(0.82, 0.95, 1.18), petalIn * 0.6 * (1.0 - heart));
  alb = mix(alb, alb * mix(vec3(1.12, 1.06, 0.72), vec3(1.06, 1.04, 0.85), uFarK), heart * 0.5);
  // painterly mottling: clumps (0.4 m), drifts (2 m), light/dark sweeps (8 m)
  float m1 = vnoise(xz * 2.4 + 2.0), m2 = vnoise(xz * 0.55 - 5.0), m3 = vnoise(xz * 0.12 + 9.0);
  alb *= 0.62 + 0.38 * smoothstep(0.2, 0.8, m1) * (1.0 - smoothstep(25.0, 60.0, de)) + 0.38 * smoothstep(25.0, 60.0, de);
  alb *= 0.8 + 0.4 * m2;
  alb = mix(alb, alb * vec3(1.15, 1.1, 0.75), smoothstep(0.55, 0.85, m3) * 0.5);
  // flower dabs, taking over as instances thin out with distance
  float cs = smoothstep(5.0, 45.0, de) * uCarpet.z;
  float daisy = (1.0 - smoothstep(4.0, 14.0, abs(inf2.x + 9.0))) * (1.0 - heart) * smoothstep(0.25, 0.55, drift2 + 0.15);
  vec3 petalCol = mix(C_VIOLET, C_COBALT, 0.35 * smoothstep(0.5, 0.8, inf2.w));
  alb = mix(alb, petalCol * 0.85, dabMask(xz, 0.38 * petalIn * (1.0 - daisy) * (1.0 - heart) * cs, 2.0, 1.0, de));
  // meadow wildflowers only in clusters (no uniform confetti)
  float wcl = smoothstep(0.58, 0.76, vnoise(xz * 0.16 + 3.0));
  alb = mix(alb, C_POPPY * 0.9, dabMask(xz, 0.16 * wcl * step(0.45, vnoise(xz * 0.05 - 8.0)) * (1.0 - petalIn) * (1.0 - heart) * cs, 2.6, 7.0, de));
  alb = mix(alb, C_GOLD * 0.9, dabMask(xz, (0.12 * wcl * (1.0 - heart) + 0.45 * heart) * cs, 2.4, 13.0, de));
  alb = mix(alb, C_DAISY * 0.85, dabMask(xz, 0.42 * daisy * cs, 2.8, 3.0, de));
  // travelling wind gusts read as brighter bands rolling over the meadow
  float gust = length(windAt(xz, uTime));
  alb *= 1.0 + 0.22 * gust * gust * smoothstep(3.0, 25.0, de);
  float sh = sunShadow(wp + N * 0.15, 1.0);
  vec3 col = shadeSurface(alb, N, wp, 0.4, mix(0.7, 1.0, smoothstep(4.0, 30.0, de)), 0.5, sh);
  col = applyFog(col, wp);
  gl_FragColor = vec4(col, a);
}`;

// Far flower carpet (reveal / falls / aerial): the whole bloomed basin floor gets
// a layer of painterly flower strokes on top of the terrain's colour washes.
// Strokes live on jittered world-space grids whose cell size follows the pixel
// footprint (two octaves cross-faded), so they read as individual flower clumps
// at 100-300 m and as drifts with relief at 1-3 km. Each stroke is a small dome:
// lit by sun / sky with sun + cloud shadows, casting a short shadow into the gaps,
// and the gaps darken the terrain beneath (premultiplied: rgb added, alpha =
// how much of the terrain is kept dark), so core's colour wash shows through.
// The gold heart is a raised boss (dome-shaded). Fog is split exactly as in
// applyFog so the overlay never darkens the haze.
const FAR_FRAG = /* glsl */`
${VEG_COMMON}
uniform vec4 uFar;   // fade-in start, end (effective m), H/1080, stroke size (1080p px)
uniform vec4 uFarStk;  // head opacity, gap darkening, cast-shadow darkening, strength
uniform float uHeartR; uniform vec4 uHole;
varying vec3 vWorld; varying vec3 vNormal;
vec4 vegFogSplit(vec3 wp) {
  vec3 v = wp - cameraPosition; float dist = length(v); vec3 rd = v / max(dist, 1e-4);
  float b = uFogFalloff;
  float ry = (abs(rd.y) < 1e-4) ? 1e-4 : rd.y;
  float h0 = cameraPosition.y - uFogBase;
  float amt = (uFogDensity / b) * exp(-h0 * b) * (1.0 - exp(-dist * ry * b)) / ry;
  amt = 1.0 - exp(-max(amt, 0.0));
  vec3 fd = normalize(vec3(rd.x, max(rd.y, 0.03), rd.z));
  vec3 fogc = skyGradient(fd) * uFogTint + uSunColor * 0.18 * pow(max(dot(rd, uSunDir), 0.0), 5.0);
  return vec4(fogc, amt);
}
// top stroke of a jittered grid (q in cell units): x dome height (>0 inside), yz dome slope
vec3 vegStroke(vec2 q, vec2 dir, float dens, float grow, float seed, out vec2 cid) {
  vec2 i0 = floor(q - 0.5), perp = vec2(-dir.y, dir.x);
  vec3 best = vec3(-1.0, 0.0, 0.0); cid = i0;
  for (int a = 0; a < 2; a++) for (int b = 0; b < 2; b++) {
    vec2 ci = i0 + vec2(float(a), float(b));
    vec2 h0 = hash22(ci + seed);
    if (h0.x >= dens) continue;
    vec2 h1 = hash22(ci.yx * 1.37 + seed * 0.71 + 19.1);
    vec2 d = q - (ci + 0.5 + (h1 - 0.5) * 0.4);
    float rad = max((0.24 + 0.32 * h0.y * h0.y) * grow, 1e-3);
    vec2 uv = vec2(dot(d, dir) / (rad * 1.45), dot(d, perp) / rad);
    float hh = 1.0 - dot(uv, uv);
    if (hh > best.x) { best = vec3(hh, -2.0 * (uv.x / 1.45 * dir + uv.y * perp)); cid = ci; }
  }
  return best;
}
// stroke paint by region (w: heart, daisy band, petal, meadow): rgb albedo, a head opacity
vec4 vegStrokePaint(vec2 cid, float lvl, vec4 w, float along, float rH, float S) {
  vec3 hs = hash33(vec3(cid, lvl * 7.3 + 1.7));
  // value drifts: neighbouring strokes share light/dark masses (painterly, not salt-and-pepper)
  float drift = vnoise(cid * 0.21 + lvl * 5.3) * 0.7 + hs.y * 0.3;
  float u = hs.x * (w.x + w.y + w.z + w.w);
  if (u < w.x) {
    // (far shots: lemon-gold like the hero's stamens, a slightly darker centre)
    vec3 c = mix(mix(s2l(vec3(0.93, 0.45, 0.10)), s2l(vec3(1.0, 0.72, 0.16)), uFarK), C_GOLD, smoothstep(0.25, 0.75, drift) * smoothstep(0.05, 0.6, rH));
    return vec4(c * (0.7 + 0.45 * drift) * mix(mix(0.6, 0.8, uFarK), 1.0, smoothstep(0.0, 0.45, rH)), 0.9);
  }
  u -= w.x;
  if (u < w.y) return vec4(C_DAISY * (0.72 + 0.2 * drift), 0.8);
  u -= w.y;
  if (u < w.z) {
    vec3 vDeep = s2l(vec3(0.294, 0.137, 0.565)), vMidC = s2l(vec3(0.478, 0.333, 0.784)), vLight = s2l(vec3(0.612, 0.486, 0.941));
    vec3 c = mix(vDeep, vMidC, smoothstep(0.0, 0.45, along));
    c = mix(c, vLight, smoothstep(0.45, 1.0, along) * 0.8);
    c *= 0.68 + 0.62 * drift;
    c = mix(c, C_COBALT * 0.8, step(hs.z, 0.09) * 0.6);
    c = mix(c, s2l(vec3(0.80, 0.78, 0.92)), step(0.985, hs.z) * 0.8);      // rare silver heads
    return vec4(c, 0.72);
  }
  // meadow: grass tufts; wildflowers only inside clusters, toned down once a stroke is a whole patch
  float fk = 1.0 - smoothstep(3.0, 16.0, S);
  float cl = smoothstep(0.64, 0.8, vnoise(cid * 0.23 + lvl * 3.1));
  vec3 grassC = mix(C_EMERALD * 0.7, C_CHARTREUSE * 0.62, hs.z) * (0.75 + 0.5 * drift);
  if (hs.y < cl * 0.8) {
    float sp = vnoise(cid * 0.09 + 40.0 + lvl);
    vec3 c = sp < 0.2 ? C_POPPY * 0.92 : (sp < 0.5 ? C_GOLD * 0.9 : (sp < 0.76 ? C_DAISY * 0.85 : C_COBALT * 0.9));
    return vec4(mix(grassC, c, mix(0.35, 1.0, fk)), mix(0.35, 0.9, fk));
  }
  return vec4(grassC, 0.3);
}
vec4 vegFarOct(vec2 xz, float S, float lvl, vec2 dir, float dens, float grow, vec4 w, float along, float rH, float aaF,
               vec3 N, vec3 Nb, vec3 wp, float sh, float sunVis, vec2 sunXZ, float shift, vec4 fog) {
  vec2 cid, cid2;
  float seed = lvl * 13.7;
  // domain-warped lattice: breaks the rows of the jittered grid into organic drifts
  vec2 q = xz / S;
  q += (vec2(vnoise(q * 0.37 + seed), vnoise(q * 0.37 + seed + 9.1)) - 0.5) * 1.3;
  vec3 st = vegStroke(q, dir, dens, grow, seed, cid);
  float aa = clamp(aaF / S, 0.18, 0.9);
  float cov = smoothstep(-aa, aa, st.x);
  vec3 st2 = vegStroke(q + sunXZ * shift, dir, dens, grow, seed, cid2);
  float castS = smoothstep(-aa, aa, st2.x) * (1.0 - cov);
  vec4 pnt = vegStrokePaint(cid, lvl, w, along, rH, S);
  vec3 Ns = normalize(N + Nb + vec3(-st.y, 0.0, -st.z) * 0.4);
  // (= shadeSurface without its back term; sun visibility incl. cloud shadow computed once)
  float diff = smoothstep(0.0, 1.0, clamp((dot(Ns, uSunDir) + 0.25) / 1.25, 0.0, 1.0));
  vec3 hemi = mix(uGroundBounce, uSkyAmbient, Ns.y * 0.5 + 0.5);
  vec3 lit = pnt.rgb * (uSunColor * sh * diff + hemi * mix(0.6, 1.0, clamp(st.x, 0.0, 1.0)));
  vec3 headF = mix(lit, fog.rgb, fog.a);
  float c = cov * pnt.a;
  float g = (uFarStk.y + uFarStk.z * castS * sunVis) * (1.0 - cov);
  return vec4(c * headF + g * fog.rgb * fog.a, c + g);
}
void main() {
  vec3 wp = vWorld; vec2 xz = wp.xz;
  vec2 fdx = dFdx(xz), fdy = dFdy(xz);
  if (xz.x > uHole.x && xz.x < uHole.z && xz.y > uHole.y && xz.y < uHole.w) discard;
  float dist = length(wp - uCamPos);
  float r = length(xz);
  float a = smoothstep(uFar.x, uFar.y, dist * uFovK) * uFarStk.w * (1.0 - smoothstep(1330.0, 1450.0, r));
  if (a < 0.004) discard;
  float sF = uBloomD - vegArrival(xz);
  a *= smoothstep(0.03, 0.4, sF / max(uBloomWidth, 1e-3));
  if (a < 0.004) discard;
  vec4 inf = infoAt(xz);
  vec3 N = normalize(vNormal);
  float rockM = smoothstep(0.26, 0.42, 1.0 - N.y);
  a *= smoothstep(18.0, 30.0, inf.x) * smoothstep(0.0, 8.0, inf.z) * smoothstep(0.8, 2.5, inf.y) * (1.0 - inf.w) * (1.0 - rockM);
  if (a < 0.004) discard;
  vec4 inf2 = info2At(xz);
  float sd = inf2.x;
  float drift2 = fbm(xz * 0.03 + 11.0);
  float petalIn = 1.0 - smoothstep(-30.0, 10.0, sd);
  float heart = 1.0 - smoothstep(uHeartR - 18.0, uHeartR + 10.0, r + (drift2 - 0.5) * 30.0);
  float daisy = (1.0 - smoothstep(0.0, 30.0, abs(sd + 6.0))) * step(uHeartR, r) * smoothstep(0.35, 0.7, drift2);
  float dW = daisy * (1.0 - heart) * 0.18;     // sparse: never an outline rim around the petals
  vec4 w = vec4(heart, dW, petalIn * (1.0 - heart) * (1.0 - dW), (1.0 - petalIn) * (1.0 - heart) * (1.0 - dW));
  // keep core's dark petal veins readable
  float vein = (1.0 - smoothstep(5.0, 26.0, inf.y)) * smoothstep(80.0, 160.0, r);
  a *= 1.0 - 0.7 * vein * w.z;
  float dens = w.x * 0.97 + w.y * 0.8 + w.z * 0.93 + w.w * 0.88;
  // stroke direction: radial in the flower (strokes follow the tepals), wandering in the meadow
  vec2 radial = r > 1.0 ? xz / r : vec2(1.0, 0.0);
  float ang = vnoise(xz * 0.004 + 7.0) * 9.42;
  vec2 dir = normalize(mix(vec2(cos(ang), sin(ang)), radial, clamp(w.x + w.y + w.z, 0.0, 1.0)) + 1e-4);
  // strokes pop up behind the wavefront
  float grow = mix(0.3, 1.0, smoothstep(0.0, 1.6, sF / max(uBloomWidth, 1e-3)));
  // stroke scale from the pixel footprint (1080p px), two octaves cross-faded
  float fa = length(fdx) * uFar.z, fb = length(fdy) * uFar.z;
  float fMax = max(max(fa, fb), 1e-4), fMin = max(min(fa, fb), 1e-4);
  float Sw = uFar.w * mix(fMin, fMax, 0.3) / 0.8;
  float lv = max(log2(Sw / 0.5) / log2(2.2), 0.0);
  float l0 = floor(lv), wl = smoothstep(0.0, 1.0, lv - l0);
  float S0 = 0.5 * pow(2.2, l0);
  float aaF = 3.5 * sqrt(fMax * fMin) / uFar.z;
  // light
  vec2 sunXZ = normalize(uSunDir.xz + 1e-5);
  float shift = clamp(0.16 / max(uSunDir.y, 0.12), 0.12, 0.5);
  float sh = sunShadow(wp + N * 0.15 * (1.0 + dist * 0.01), 1.0) * cloudShadow(wp);
  float sunVis = sh * smoothstep(-0.05, 0.25, dot(N, uSunDir));
  // the heart: a raised boss of dense gold-orange flowers (dome normal, darker lee side)
  float rH = r / max(uHeartR, 1.0);
  vec3 Nb = vec3(xz.x, 0.0, xz.y) / max(uHeartR, 1.0) * 1.5 * w.x;
  float bossL = max(dot(normalize(N + Nb), uSunDir), 0.0) / max(dot(N, uSunDir), 0.08);
  float bossDark = w.x * clamp(1.0 - bossL, 0.0, 0.6);
  vec4 fog = vegFogSplit(wp);
  float along = clamp(r / 1150.0, 0.0, 1.0);
  vec4 o0 = vegFarOct(xz, S0, l0, dir, dens, grow, w, along, rH, aaF, N, Nb, wp, sh, sunVis, sunXZ, shift, fog);
  vec4 o1 = vegFarOct(xz, S0 * 2.2, l0 + 1.0, dir, dens, grow, w, along, rH, aaF, N, Nb, wp, sh, sunVis, sunXZ, shift, fog);
  vec4 o = mix(o0, o1, wl);
  o += vec4(fog.rgb * fog.a, 1.0) * bossDark * (1.0 - o.a);
  gl_FragColor = o * a;
}`;

// ------------------------------------------------------------------ geometry
function tuftGeometry(nBlades, segs, seed) {
  const R = rng(seed);
  const pos = [], b0 = [], b1 = [], av = [], idx = [];
  for (let b = 0; b < nBlades; b++) {
    const rr = 0.075 * Math.sqrt(R()), th = R() * Math.PI * 2;
    const ox = Math.cos(th) * rr, oz = Math.sin(th) * rr;
    const az = th + (R() - 0.5) * 1.8;
    const lean = 0.10 + R() * 0.42;
    const hf = b === 0 ? 1.0 : 0.6 + R() * 0.45;
    const wf = 0.75 + R() * 0.55, bend = R(), rank = (b + R() * 0.999) / nBlades;
    const base = pos.length / 3;
    for (let k = 0; k < segs; k++) {
      const v = k / segs;
      for (const side of [-1, 1]) { pos.push(ox, v, oz); b0.push(ox, oz, az, lean); b1.push(hf, wf, bend, rank); av.push(side, v); }
    }
    pos.push(ox, 1, oz); b0.push(ox, oz, az, lean); b1.push(hf, wf, bend, rank); av.push(0, 1);
    for (let k = 0; k < segs - 1; k++) { const a = base + 2 * k; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    const a = base + 2 * (segs - 1); idx.push(a, a + 1, base + 2 * segs);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aB0', new THREE.Float32BufferAttribute(b0, 4));
  g.setAttribute('aB1', new THREE.Float32BufferAttribute(b1, 4));
  g.setAttribute('aV', new THREE.Float32BufferAttribute(av, 2));
  g.setIndex(idx);
  return g;
}

function flowerGeometry(T, seed, far = false) {
  const R = rng(seed);
  const pos = [], f0 = [], f1 = [], idx = [];
  const vert = (part, th, prnd, px, py, side) => { pos.push(px, py, side); f0.push(part, th, prnd, 0); f1.push(px, py, side, 0); return pos.length / 3 - 1; };
  const NS = far ? 2 : 5, s0 = pos.length / 3;
  for (let k = 0; k < NS; k++) { const v = k / (NS - 1); vert(0, 0, 0, 0, v, -1); vert(0, 0, 0, 0, v, 1); }
  for (let k = 0; k < NS - 1; k++) { const a = s0 + 2 * k; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  // far LOD: at most 7 petals (wider to keep coverage), 2x2 vertex petals
  const n = far ? Math.min(T.n, 7) : T.n, nu = far ? 2 : T.nu, nv = far ? 2 : T.nv, wk = T.n / n;
  for (let p = 0; p < n; p++) {
    const th = (p + (R() - 0.5) * 0.22) / n * Math.PI * 2, prnd = R();
    const p0 = pos.length / 3;
    for (let b = 0; b < nv; b++) {
      const py = b / (nv - 1), hw = T.shape(far ? Math.min(py, 0.7) * 0.6 + py * 0.4 : py) * wk;
      for (let a = 0; a < nu; a++) { const u = a / (nu - 1) * 2 - 1; vert(1, th, prnd, u * hw, py, u); }
    }
    for (let b = 0; b < nv - 1; b++) for (let a = 0; a < nu - 1; a++) {
      const i0 = p0 + b * nu + a; idx.push(i0, i0 + 1, i0 + nu, i0 + 1, i0 + nu + 1, i0 + nu);
    }
  }
  const NR = far ? 5 : 8, c0 = vert(2, 0, 0, 0, 0, 0);
  const rings = far ? [[1.0, 0]] : [[0.6, 0], [1.0, 0.5]];
  for (const [ring, off] of rings) for (let k = 0; k < NR; k++) { const ps = (k + off) / NR * Math.PI * 2; vert(2, 0, 0, Math.cos(ps) * ring, Math.sin(ps) * ring, 0); }
  for (let k = 0; k < NR; k++) idx.push(c0, c0 + 1 + (k + 1) % NR, c0 + 1 + k);
  if (!far) for (let k = 0; k < NR; k++) {
    const a0 = c0 + 1 + k, a1 = c0 + 1 + (k + 1) % NR, q0 = c0 + 1 + NR + k, q1 = c0 + 1 + NR + (k + 1) % NR;
    idx.push(a0, a1, q0, a1, q1, q0);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aF0', new THREE.Float32BufferAttribute(f0, 4));
  g.setAttribute('aF1', new THREE.Float32BufferAttribute(f1, 4));
  g.setIndex(idx);
  return g;
}

// Spatial tiles: instances are bucketed into TILE x TILE m tiles, each tile gets
// its own instance buffers and one mesh per LOD geometry (sharing the base
// geometry's vertex buffers and the LOD material). three's frustum culling plus
// a per-tile distance band in update() keep the vertex work to what is visible.
const TILE_NEAR = 24, TILE_FAR = 64;
function buildTiles(arrays, H0, TILE) {
  const pos = arrays.iPos, n = pos.length / 4;
  const buckets = new Map();
  for (let i = 0; i < n; i++) {
    const key = Math.floor(pos[i * 4] / TILE) + ',' + Math.floor(pos[i * 4 + 2] / TILE);
    let b = buckets.get(key); if (!b) { b = []; buckets.set(key, b); }
    b.push(i);
  }
  const tiles = [];
  for (const [key, ids] of buckets) {
    const [tx, tz] = key.split(',').map(Number);
    const attrs = {};
    let ymin = 1e9, ymax = -1e9;
    for (const [name, arr] of Object.entries(arrays)) {
      const sub = new Float32Array(ids.length * 4);
      ids.forEach((id, k) => { for (let c = 0; c < 4; c++) sub[k * 4 + c] = arr[id * 4 + c]; });
      attrs[name] = new THREE.InstancedBufferAttribute(sub, 4);
    }
    for (const id of ids) { const y = pos[id * 4 + 1]; ymin = Math.min(ymin, y); ymax = Math.max(ymax, y); }
    const box = new THREE.Box3(new THREE.Vector3(tx * TILE - 0.5, ymin - 0.1, tz * TILE - 0.5), new THREE.Vector3((tx + 1) * TILE + 0.5, ymax + H0, (tz + 1) * TILE + 0.5));
    tiles.push({ attrs, n: ids.length, box, sphere: box.getBoundingSphere(new THREE.Sphere()) });
  }
  return tiles;
}
function tileMesh(tile, baseGeo, material, name, far) {
  const g = new THREE.InstancedBufferGeometry();
  for (const [k, a] of Object.entries(baseGeo.attributes)) g.setAttribute(k, a);
  g.setIndex(baseGeo.index);
  for (const [k, a] of Object.entries(tile.attrs)) g.setAttribute(k, a);
  g.instanceCount = tile.n;
  g.boundingSphere = tile.sphere.clone(); g.boundingBox = tile.box.clone();
  const m = new THREE.Mesh(g, material);
  m.name = name; m.userData.far = far; m.userData.box = tile.box; m.frustumCulled = true;
  return m;
}

// ------------------------------------------------------------------ module
export async function create(ctx) {
  const { data, rig, W, H } = ctx;
  applyOverrides(ctx.q);
  const t0 = performance.now();
  const aspect = W / H;
  const P_G = VEG.grass, P_F = VEG.flower;
  const DMAX = Math.max(P_G.dmax, P_F.dmax);

  // ---- 1. camera samples of every shot the meadow appears in
  const cams = [];
  const addRange = (ta, tb, dt, range = 1e9) => {
    for (let t = ta; t <= tb + 1e-6; t += dt) {
      const c = rig.at(t);
      const fx = c.target.x - c.pos.x, fy = c.target.y - c.pos.y, fz = c.target.z - c.pos.z, fl = Math.hypot(fx, fy, fz);
      const th = Math.tan(c.fov * DEG / 2);
      const half = Math.atan(th * Math.sqrt(1 + aspect * aspect)) + 10 * DEG;
      cams.push({ x: c.pos.x, y: c.pos.y, z: c.pos.z, fx: fx / fl, fy: fy / fl, fz: fz / fl, cosA: Math.cos(Math.min(half, 88 * DEG)), k: th / TAN_REF, t, range });
    }
  };
  const T = ctx.TIMES;
  addRange(0, T.pullStart, 0.5, 18);   // macro: only the near (DOF-blurred) background matters
  addRange(T.pullStart, T.cut2 - 1e-3, 1 / 60);
  addRange(T.cut2, T.cut3 - 1e-3, 1 / 30);
  addRange(T.cut3, T.cut4 - 1e-3, 1 / 30);
  addRange(T.cut4, T.cut5 - 1e-3, 1 / 15);

  // ---- 1b. low-flying lens track: nothing may stand up into the lens where the camera skims the ground
  const lowCams = [], LC = 2.0, lowGrid = new Map();
  for (let t = T.cut2; t < T.cut3 + 0.6; t += 1 / 120) {   // (macro pull-back: dynamic lens push only)
    const c = rig.at(t), alt = c.pos.y - data.heightAt(c.pos.x, c.pos.z);
    if (alt > 2.2) continue;
    const e = { x: c.pos.x, z: c.pos.z, y: c.pos.y };
    const key = Math.floor(e.x / LC) + ',' + Math.floor(e.z / LC);
    if (!lowGrid.has(key)) lowGrid.set(key, []);
    lowGrid.get(key).push(e); lowCams.push(e);
  }
  // max allowed top height (m above the instance's ground) under the lens track
  function lensCap(x, z, y) {
    let cap = 99;
    const ci = Math.floor(x / LC), cj = Math.floor(z / LC);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const L_ = lowGrid.get((ci + a) + ',' + (cj + b)); if (!L_) continue;
      for (const e of L_) {
        const hd = Math.hypot(e.x - x, e.z - z); if (hd > 1.8) continue;
        cap = Math.min(cap, e.y - y - 0.28 + 0.65 * Math.max(0, hd - 0.3));
      }
    }
    return cap;
  }

  // ---- 2. closest effective (lens-normalised) in-view distance per ground cell
  const CELL = VEG.cell;
  let minX = 1e9, minZ = 1e9, maxX = -1e9, maxZ = -1e9;
  for (const c of cams) {
    const alt = c.y - data.heightAt(c.x, c.z);
    const reach = Math.sqrt(Math.max(0, Math.min(DMAX / c.k, c.range) ** 2 - alt * alt));
    if (reach <= 0) continue;
    minX = Math.min(minX, c.x - reach); maxX = Math.max(maxX, c.x + reach);
    minZ = Math.min(minZ, c.z - reach); maxZ = Math.max(maxZ, c.z + reach);
  }
  minX = Math.max(minX, -600); minZ = Math.max(minZ, -600); maxX = Math.min(maxX, 700); maxZ = Math.min(maxZ, 700);
  minX = Math.floor(minX / CELL) * CELL; minZ = Math.floor(minZ / CELL) * CELL;
  const nx = Math.ceil((maxX - minX) / CELL) + 1, nz = Math.ceil((maxZ - minZ) / CELL) + 1;
  const gy = new Float32Array(nx * nz), dmin = new Float32Array(nx * nz).fill(1e9);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) gy[j * nx + i] = data.heightAt(minX + (i + 0.5) * CELL, minZ + (j + 0.5) * CELL);
  for (const c of cams) {
    const rw = Math.min(DMAX / c.k, c.range);
    const i0 = Math.max(0, Math.floor((c.x - rw - minX) / CELL)), i1 = Math.min(nx - 1, Math.ceil((c.x + rw - minX) / CELL));
    const j0 = Math.max(0, Math.floor((c.z - rw - minZ) / CELL)), j1 = Math.min(nz - 1, Math.ceil((c.z + rw - minZ) / CELL));
    const rw2 = rw * rw;
    for (let j = j0; j <= j1; j++) {
      const dz = minZ + (j + 0.5) * CELL - c.z;
      for (let i = i0; i <= i1; i++) {
        const k = j * nx + i;
        const dx = minX + (i + 0.5) * CELL - c.x, dy = gy[k] + 0.25 - c.y;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > rw2) continue;
        const d = Math.sqrt(d2);
        if (d > 2.5 && dx * c.fx + dy * c.fy + dz * c.fz < c.cosA * d) continue;
        const de = d * c.k;
        if (de < dmin[k]) dmin[k] = de;
      }
    }
  }
  const dAt = (x, z) => {
    const fx = (x - minX) / CELL - 0.5, fz = (z - minZ) / CELL - 0.5;
    const i = Math.max(0, Math.min(nx - 2, Math.floor(fx))), j = Math.max(0, Math.min(nz - 2, Math.floor(fz)));
    const u = Math.min(1, Math.max(0, fx - i)), v = Math.min(1, Math.max(0, fz - j));
    const a = dmin[j * nx + i], b = dmin[j * nx + i + 1], c = dmin[(j + 1) * nx + i], d = dmin[(j + 1) * nx + i + 1];
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  };

  // ---- 3. site classification
  const SUN2 = [Math.cos(30 * DEG), Math.sin(30 * DEG)];
  // the baked petal map exactly as the GPU sees it (bilinear, texel centres): near the
  // knoll the analytic field jumps across the inter-lobe wedges within ~1 m, the 8 m
  // texels smooth that into the several-metre daisy band the terrain paints
  const I2 = ctx.U.tInfo2.value && ctx.U.tInfo2.value.image && ctx.U.tInfo2.value.image.data, FARG = data.FAR;
  function info2(x, z, ch) {
    if (!I2) return ch === 0 ? (L.petalField || L.petalSD)(x, z) : L.fbm(x * 0.01 + 31, z * 0.01 - 3, 4);
    const fx = (x - FARG.minX) / FARG.sizeX * FARG.nx - 0.5, fz = (z - FARG.minZ) / FARG.sizeZ * FARG.nz - 0.5;
    const i = Math.max(0, Math.min(FARG.nx - 2, Math.floor(fx))), j = Math.max(0, Math.min(FARG.nz - 2, Math.floor(fz)));
    const u = fx - i, v = fz - j, o = (j * FARG.nx + i) * 4 + ch, oz = FARG.nx * 4;
    return (I2[o] * (1 - u) + I2[o + 4] * u) * (1 - v) + (I2[o + oz] * (1 - u) + I2[o + oz + 4] * u) * v;
  }
  function site(x, z) {
    const r = Math.hypot(x, z);
    if (r < VEG.budClear) return null;
    if (data.sampleInfo(x, z, 0) < 45) {
      const rd = L.riverDist(x, z); const rw = 14 + 6 * Math.sin(rd.t * 40);
      if (rd.d < rw + 1.5) return null;
    }
    if (data.sampleInfo(x, z, 2) < 30 && L.lakeDist(x, z) < 1.5) return null;
    const cd = L.creekDist(x, z).d;
    if (cd < VEG.creekClear) return null;
    const sd = info2(x, z, 0);   // organic petal field (baked info2.x)
    // metric distance to the daisy contour (sd = -9): the field is steep near the knoll
    const e = 0.75, gx = info2(x + e, z, 0) - info2(x - e, z, 0), gz = info2(x, z + e, 0) - info2(x, z - e, 0);
    const edge = (sd + 9) / Math.max(1, Math.hypot(gx, gz) / (2 * e));
    return { r, sd, cd, edge };
  }
  // spring grass height (m): knee-high meadow, lower in the petals and heart, low near the bud
  function grassH(x, z, s, R) {
    const heart = 1 - sm(70, 95, s.r);
    const inPetal = 1 - sm(-6, 6, s.sd);
    let h = 0.46 + 0.16 * R();                                 // inter-lobe meadow
    h = h * (1 - inPetal * 0.3) * (1 - heart * 0.25);
    h *= 0.78 + 0.44 * L.fbm(x * 0.05 + 3, z * 0.05 - 7, 3);
    // a low ring around the hero bud so it stays visible through the pull-back
    h *= 0.55 + 0.45 * sm(VEG.budClear, 4.0, s.r);
    return h;
  }

  // ---- 4. grass tufts
  // clumping: local density 0.3-1.0 from 0.5-3 m noise (dense clumps, dark root gaps between)
  const clumpG = (x, z) => 0.3 + 0.7 * sm(0.36, 0.64, 0.62 * L.fbm(x * 0.42 + 13, z * 0.42 - 5, 2) + 0.38 * L.fbm(x * 1.25 - 7, z * 1.25 + 3, 2));
  const R = rng(0xC0FFEE);
  const G = { iPos: [], iPar: [], iExt: [] };
  let nReed = 0, nLeaf = 0, nTall = 0;
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const dm = dmin[j * nx + i];
    if (dm > P_G.dmax) continue;
    const rmax = rhoAt(P_G, Math.max(0.05, dm - 1.0)) * CELL * CELL;
    const n = Math.ceil(rmax);
    for (let c = 0; c < n; c++) {
      const x = minX + (i + R()) * CELL, z = minZ + (j + R()) * CELL, q0 = R() * n / (CELL * CELL);
      const rr1 = R(), rr2 = R(), rr3 = R(), rr4 = R();
      const cl = clumpG(x, z), q = q0 / cl;      // sparse spots thin out first
      if (q >= rhoAt(P_G, dAt(x, z))) continue;
      const s = site(x, z); if (!s) continue;
      const reed = s.cd < VEG.reedBand && rr1 < VEG.reedFrac * (1 - sm(VEG.creekClear + 0.5, VEG.reedBand, s.cd));
      const leaf = !reed && s.r > 2.5 && rr4 < VEG.leafFrac;
      let h = grassH(x, z, s, () => rr2) * (0.62 + 0.62 * ((rr3 * 7.31) % 1)) * (0.8 + 0.35 * cl);   // +-40 %, clumps taller
      if (reed) { h = 0.45 + 0.3 * rr2; nReed++; }
      if (leaf) nLeaf++;
      const y = data.heightAt(x, z);
      h = Math.max(0.03, Math.min(h, lensCap(x, z, y) / 1.2));
      const tint = s.r < 85 ? 2 : (s.sd < 0 ? 1 : 0);
      G.iPos.push(x, y, z, rr3 * Math.PI * 2);
      G.iPar.push(h, q, R(), reed ? 1 : (leaf ? 2 : 0));
      G.iExt.push(tint, s.cd, 0, 0);
    }
  }
  // tall seed-head stalks skimming past the low FPV lens (0.35-1.5 m off its track): foreground parallax
  {
    const RT = rng(0x7A11);
    let acc = 0, prev = null;
    for (let t = T.cut2; t < T.cut3; t += 1 / 240) {
      const c = rig.at(t), px = c.pos.x, pz = c.pos.z;
      const alt = c.pos.y - data.heightAt(px, pz);
      const dx = prev ? px - prev[0] : 0, dz = prev ? pz - prev[1] : 0;
      prev = [px, pz]; acc += Math.hypot(dx, dz);
      if (acc < 0.6 || alt > 1.7) continue;
      acc = 0;
      const fl = Math.hypot(dx, dz) || 1, ux = dx / fl, uz = dz / fl;
      for (const side of [-1, 1]) {
        if (RT() > 0.55) continue;
        const off = 0.35 + 1.15 * Math.pow(RT(), 1.2), along = (RT() - 0.5) * 0.5;
        const x = px - uz * side * off + ux * along, z = pz + ux * side * off + uz * along;
        const s = site(x, z); if (!s || s.cd < VEG.creekClear + 0.4) continue;
        const y = data.heightAt(x, z);
        const h = Math.min(0.55 + 0.55 * RT(), lensCap(x, z, y) / 1.05);
        if (h < 0.3) continue;
        G.iPos.push(x, y, z, RT() * Math.PI * 2);
        G.iPar.push(h, 0, RT(), 3);
        G.iExt.push(s.r < 85 ? 2 : (s.sd < 0 ? 1 : 0), s.cd, 0, 0);
        nTall++;
      }
    }
  }

  // ---- 5. flowers
  function flowerPick(x, z, s, u) {
    // matches the terrain washes: petal (sd<0), daisy band around sd=-9, gold heart r<85
    const hr = s.r + (L.fbm(x * 0.03 + 11, z * 0.03, 3) - 0.5) * 30;
    const heart = 1 - sm(67, 95, hr);
    const band = Math.max(1 - sm(4, 13, Math.abs(s.sd + 9)), 1 - sm(1.2, 3.2, Math.abs(s.edge))) * (1 - heart);
    const inside = (1 - sm(-16, -3, s.sd)) * (1 - heart);
    const outside = sm(-3, 12, s.sd) * (1 - heart);
    const vari = info2(x, z, 3);
    const cob = sm(0.4, 0.75, vari) * 0.5;
    const w = [
      inside * (1 - cob) * 2.4 * (1 - band),   // pasque violet
      inside * cob * 2.4 * (1 - band),         // cobalt
      band * 3.0 + 0.04,                       // daisy
      heart * 2.4 + 0.10 + outside * 0.35,     // buttercup
      outside * 1.2 * (1 - band),              // poppy
    ];
    const tot = w.reduce((a, b) => a + b, 0);
    let acc = 0; const pick = u * tot;
    for (let k = 0; k < w.length; k++) { acc += w[k]; if (pick <= acc) return { type: k, mul: tot }; }
    return { type: 4, mul: tot };
  }
  // flower clusters: a hashed 2.4 m grid of cluster centres (radius 0.4-1.1 m, more and
  // bigger inside the petals); every flower of a cluster shares its species and pops together
  const CLG = 2.4;
  function clusterAt(x, z, inP) {
    const ci = Math.floor(x / CLG), cj = Math.floor(z / CLG);
    let best = 0, cx = x, cz = z, u = 0;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const I = ci + a, J = cj + b;
      if (hashI(I * 3 + 1, J * 7 - 2) > 0.55 + 0.3 * inP) continue;
      const kx = (I + 0.15 + 0.7 * hashI(I + 101, J - 57)) * CLG, kz = (J + 0.15 + 0.7 * hashI(I - 33, J + 91)) * CLG;
      const rad = (0.4 + 0.7 * hashI(I + 7, J + 13)) * (1 + 0.3 * inP);
      const d2 = ((x - kx) ** 2 + (z - kz) ** 2) / (rad * rad);
      if (d2 >= 1) continue;
      if (1 - d2 > best) { best = 1 - d2; cx = kx; cz = kz; u = hashI(I - 11, J + 29); }
    }
    return { w: best, cx, cz, u };
  }
  const F = FLOWERS.map(() => ({ iPos: [], iPar: [], iDir: [] }));
  const MULMAX = 3.6;
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const dm = dmin[j * nx + i];
    if (dm > P_F.dmax) continue;
    const rmax = rhoAt(P_F, Math.max(0.05, dm - 1.0)) * CELL * CELL * MULMAX;
    const n = Math.ceil(rmax);
    for (let c = 0; c < n; c++) {
      const x = minX + (i + R()) * CELL, z = minZ + (j + R()) * CELL, qu = R();
      const u1 = R(), u2 = R(), u3 = R(), u4 = R(), u5 = R();
      const qd = qu * n / (CELL * CELL);          // rank in weighted density units
      const d = dAt(x, z);
      if (qd >= rhoAt(P_F, d) * MULMAX) continue;  // cheap early reject
      const s = site(x, z); if (!s) continue;
      if (s.cd < VEG.creekClear + 0.5) continue;
      const inP = 1 - sm(-8, 4, s.sd);
      const cl = clusterAt(x, z, inP);
      const sc = cl.w > 0 ? site(cl.cx, cl.cz) : null;
      const pk = sc ? flowerPick(cl.cx, cl.cz, sc, cl.u) : flowerPick(x, z, s, u1);
      const wgt = Math.min(MULMAX, pk.mul * (0.07 + (1.25 + 0.9 * inP) * cl.w));
      if (qd >= rhoAt(P_F, d) * wgt) continue;
      const q = qd / wgt;                           // shader keeps it while q < rhoF(d)
      const T_ = FLOWERS[pk.type];
      const gh = grassH(x, z, s, () => u2);
      const fy = data.heightAt(x, z);
      let stem = Math.max(0.12, gh * (0.95 + 0.35 * u3)) * (pk.type === FI.poppy ? 1.15 : 1.0);
      stem = Math.min(stem, lensCap(x, z, fy) / 1.15 - 0.03);
      if (stem < 0.06) continue;
      const scale = (T_.scale[0] + (T_.scale[1] - T_.scale[0]) * u4) * VEG.flowerScale;
      // heads lean back toward the incoming FPV lens (away from the low sun): we see
      // their faces, with the sun shining through the petals from behind
      const ta = u5 * Math.PI * 2, tm = 0.06 + 0.2 * R();
      const tx = Math.cos(ta) * tm - SUN2[0] * 0.3, tz = Math.sin(ta) * tm - SUN2[1] * 0.3;
      // pop distance behind the front (m): clusters open together, 0.5-2 m behind it
      const cpop = sc ? cl.u * 7.13 % 1 : hashI(Math.floor(x / 1.7), Math.floor(z / 1.7));
      const dOpen = 0.5 + 1.5 * (0.75 * cpop + 0.25 * R());
      const winterVis = R() < 0.3 ? 1 : 0;
      const A = F[pk.type];
      A.iPos.push(x, fy, z, R() * Math.PI * 2);
      A.iPar.push(stem, q, R(), scale);
      A.iDir.push(tx, tz, winterVis, dOpen);
    }
  }

  // ---- 6. materials + meshes
  const shared = {
    uCamPos: { value: new THREE.Vector3() }, uPxScale: { value: 1000 }, uFovK: { value: 1 }, uBloomRate: { value: 10 },
    uLodG: { value: new THREE.Vector4(P_G.rho0, P_G.d0, P_G.dmax, P_G.p) },
    uLodF: { value: new THREE.Vector4(P_F.rho0, P_F.d0, P_F.dmax, P_F.p) },
    uLensR: { value: 0.4 }, uWindAmt: { value: VEG.wind },
    uVegK: { value: new THREE.Vector4(VEG.bladeW, VEG.minPx, VEG.widen, VEG.farGrow) },
    uWinterFrac: { value: VEG.winterFrac }, uTransAmt: { value: VEG.trans },
  };
  const objects = [], tileMeshes = [];
  const band = (sw, far) => ({ uBand: { value: new THREE.Vector3(sw, far ? 1 : 0, sw * 0.35) } });
  const addSet = (arrays, H0, geoNear, geoFar, uni, vs, fs, name, kind) => {
    let nt = 0;
    for (const far of [false, true]) {
      const tiles = buildTiles(arrays, H0, far ? TILE_FAR : TILE_NEAR);
      nt += tiles.length;
      const { material } = worldMaterial({ vertexShader: vs, fragmentShader: fs, uniforms: { ...uni, ...band(VEG.lodSwitch[kind], far) }, side: THREE.DoubleSide });
      for (const tile of tiles) {
        const m = tileMesh(tile, far ? geoFar : geoNear, material, name, far);
        m.userData.kind = kind; tileMeshes.push(m); objects.push(m);
      }
    }
    return nt;
  };
  const nTilesG = addSet({ iPos: new Float32Array(G.iPos), iPar: new Float32Array(G.iPar), iExt: new Float32Array(G.iExt) }, 1.4,
    tuftGeometry(7, 4, 4242), tuftGeometry(4, 2, 4243), shared, GRASS_VERT, GRASS_FRAG, 'veg-grass', 0);
  const counts = { grass: G.iPos.length / 4, reeds: nReed, grassTiles: nTilesG };
  const col = h => new THREE.Color(h);
  FLOWERS.forEach((T_, k) => {
    const A = F[k];
    counts[T_.id] = A.iPos.length / 4;
    if (!A.iPos.length) return;
    const u = {
      ...shared,
      uFP0: { value: new THREE.Vector4(T_.L, T_.rc, T_.openA, T_.budA) },
      uFP1: { value: new THREE.Vector4(T_.curlO, T_.curlB, T_.cup, T_.cR) },
      uFP2: { value: new THREE.Vector4(T_.cH, T_.stemW, T_.budS, 0) },
      uFP3: { value: new THREE.Vector4(T_.neutral, T_.gloss, T_.blotch, T_.trans) },
      uC0: { value: col(T_.c0) }, uC1: { value: col(T_.c1) }, uCC: { value: col(T_.cc) }, uCT: { value: col(T_.ct) },
    };
    addSet({ iPos: new Float32Array(A.iPos), iPar: new Float32Array(A.iPar), iDir: new Float32Array(A.iDir) }, 1.0,
      flowerGeometry(T_, 777 + k * 31, false), flowerGeometry(T_, 777 + k * 31, true), u, FLOWER_VERT, FLOWER_FRAG, 'veg-' + T_.id, 1);
  });
  counts.meshes = tileMeshes.length;
  // ---- 7. ground cover on the terrain's own grid cells
  {
    const GR = L.GRID, N = GR.N, SK = Math.sinh(GR.k);
    const invX = x => (Math.asinh((x - GR.cx) * SK / GR.Lx) / GR.k + 1) * 0.5 * (N - 1);
    const invZ = z => (Math.asinh((z - GR.cz) * SK / GR.Lz) / GR.k + 1) * 0.5 * (N - 1);
    const i0 = Math.max(0, Math.floor(invX(minX))), i1 = Math.min(N - 2, Math.ceil(invX(minX + nx * CELL)));
    const j0 = Math.max(0, Math.floor(invZ(minZ))), j1 = Math.min(N - 2, Math.ceil(invZ(minZ + nz * CELL)));
    const W_ = i1 - i0 + 2;
    const ij = new Uint16Array(W_ * (j1 - j0 + 2) * 2);
    for (let j = j0; j <= j1 + 1; j++) for (let i = i0; i <= i1 + 1; i++) { const o = ((j - j0) * W_ + (i - i0)) * 2; ij[o] = i; ij[o + 1] = j; }
    const idx = [];
    const CMAX = VEG.carpet[1] + 6;
    for (let j = j0; j <= j1; j++) {
      const zc = (L.gridZ(j) + L.gridZ(j + 1)) * 0.5;
      for (let i = i0; i <= i1; i++) {
        const xc = (L.gridX(i) + L.gridX(i + 1)) * 0.5;
        if (dAt(xc, zc) > CMAX) continue;
        const a = (j - j0) * W_ + (i - i0), b = a + 1, c = a + W_, d = c + 1;
        idx.push(a, c, d, a, d, b);
      }
    }
    if (idx.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('aIJ', new THREE.Uint16BufferAttribute(ij, 2));
      geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(ij.length / 2 * 3), 3));
      geo.setIndex(idx);
      const cu = {
        ...shared,
        tHeight: { value: data.heightTex },
        uGrid: { value: new THREE.Vector4(GR.cx, GR.cz, GR.Lx, GR.Lz) },
        uGridK: { value: new THREE.Vector3(GR.k, 1 / SK, N - 1) },
        uCarpet: { value: new THREE.Vector4(VEG.carpet[0], VEG.carpet[1], VEG.carpet[2], 0) },
        uPull: { value: new THREE.Vector2(0, 0) },
      };
      const cm = worldMaterial({ vertexShader: CARPET_VERT, fragmentShader: CARPET_FRAG, uniforms: cu, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8 });
      const carpet = new THREE.Mesh(geo, cm.material);
      carpet.frustumCulled = false; carpet.name = 'veg-carpet'; carpet.renderOrder = -1;
      objects.push(carpet);
      counts.carpetTris = idx.length / 3;
    }
  }
  // ---- 8. far flower carpet over the whole basin floor (terrain grid cells, r < 1450 m)
  let farMesh = null;
  {
    const GR = L.GRID, N = GR.N, SK = Math.sinh(GR.k), RB = 1450;
    const invX = x => (Math.asinh((x - GR.cx) * SK / GR.Lx) / GR.k + 1) * 0.5 * (N - 1);
    const invZ = z => (Math.asinh((z - GR.cz) * SK / GR.Lz) / GR.k + 1) * 0.5 * (N - 1);
    const i0 = Math.max(0, Math.floor(invX(-RB))), i1 = Math.min(N - 2, Math.ceil(invX(RB)));
    const j0 = Math.max(0, Math.floor(invZ(-RB))), j1 = Math.min(N - 2, Math.ceil(invZ(RB)));
    const W_ = i1 - i0 + 2, H_ = j1 - j0 + 2;
    const ij = new Uint16Array(W_ * H_ * 2);
    for (let j = 0; j < H_; j++) for (let i = 0; i < W_; i++) { const o = (j * W_ + i) * 2; ij[o] = i0 + i; ij[o + 1] = j0 + j; }
    const P = data.PATCH, hole = [P.cx - P.size / 2, P.cz - P.size / 2, P.cx + P.size / 2, P.cz + P.size / 2];
    const xs = new Float64Array(W_), zs = new Float64Array(H_);
    for (let i = 0; i < W_; i++) xs[i] = L.gridX(i0 + i);
    for (let j = 0; j < H_; j++) zs[j] = L.gridZ(j0 + j);
    // every 2nd terrain vertex: ~0.8M tris instead of 3.3M (mostly sub-pixel from the air)
    const ST = VEG.farStride;
    const idx = new Uint32Array(Math.ceil(W_ / ST) * Math.ceil(H_ / ST) * 6);
    let k = 0;
    for (let j = 0; j + ST < H_; j += ST) {
      const zc = (zs[j] + zs[j + ST]) * 0.5;
      for (let i = 0; i + ST < W_; i += ST) {
        const xc = (xs[i] + xs[i + ST]) * 0.5;
        if (xc * xc + zc * zc > RB * RB) continue;
        if (xs[i + ST] > hole[0] && xs[i] < hole[2] && zs[j + ST] > hole[1] && zs[j] < hole[3]) continue;
        const a = j * W_ + i, b = a + ST, c = a + W_ * ST, d = c + ST;
        idx[k++] = a; idx[k++] = c; idx[k++] = d; idx[k++] = a; idx[k++] = d; idx[k++] = b;
      }
    }
    const geo = new THREE.BufferGeometry();
    const ijA = new THREE.Uint16BufferAttribute(ij, 2);
    geo.setAttribute('aIJ', ijA);
    geo.setAttribute('position', ijA);      // (unused by the shader; keeps three's attribute setup happy)
    geo.setIndex(new THREE.BufferAttribute(idx.slice(0, k), 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const terr = ctx.scene.children.find(o => o.material && o.material.uniforms && o.material.uniforms.uHeartR);
    const fu = {
      ...shared,
      tHeight: { value: data.heightTex },
      uGrid: { value: new THREE.Vector4(GR.cx, GR.cz, GR.Lx, GR.Lz) },
      uGridK: { value: new THREE.Vector3(GR.k, 1 / SK, N - 1) },
      uFar: { value: new THREE.Vector4(VEG.far[0], VEG.far[1], H / 1080, VEG.far[2]) },
      uFarStk: { value: new THREE.Vector4(...VEG.farK) },
      uHeartR: terr ? terr.material.uniforms.uHeartR : { value: L.HEART_R },   // follow core's heart size
      uHole: { value: new THREE.Vector4(...hole) },
      uPull: { value: new THREE.Vector2(0.03, 0.0004) },
    };
    const fm = worldMaterial({
      vertexShader: CARPET_VERT, fragmentShader: FAR_FRAG, uniforms: fu, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
    farMesh = new THREE.Mesh(geo, fm.material);
    farMesh.frustumCulled = false; farMesh.name = 'veg-far'; farMesh.renderOrder = -2;
    objects.push(farMesh);
    counts.farTris = k / 3;
  }
  counts.leaf = nLeaf; counts.tall = nTall;
  console.log(`[vegetation] grid ${nx}x${nz}, cams ${cams.length}, instances ${JSON.stringify(counts)}, ${(performance.now() - t0).toFixed(0)} ms`);

  const bloomD = ctx.bloomD;
  const hide = (ctx.q && ctx.q.get && ctx.q.get('veghide') || '').split(',').filter(Boolean); // debug: grass,pasque,...,carpet,flowers
  const hidden = o => hide.some(h => o.name === 'veg-' + h || (h === 'flowers' && FLOWERS.some(f => o.name === 'veg-' + f.id)));
  return {
    objects,
    update(t, c) {
      const cfg = SHOTS[c.shot.id] || SHOTS.aerial;
      for (const o of objects) o.visible = (o === farMesh ? !!cfg.far : cfg.vis) && !hidden(o);
      if (!cfg.vis && !cfg.far) return;
      const cam = c.camera;
      shared.uCamPos.value.copy(cam.position);
      const th = Math.tan(cam.fov * DEG / 2);
      shared.uPxScale.value = 2160 / (2 * th);
      shared.uFovK.value = th / TAN_REF;
      shared.uBloomRate.value = Math.max(2, (bloomD(t + 0.02) - bloomD(t - 0.02)) / 0.04);
      shared.uLensR.value = cfg.lens;
      shared.uLodG.value.z = Math.min(P_G.dmax, cfg.gmax ?? 1e9);
      shared.uLodF.value.z = Math.min(P_F.dmax, cfg.fmax ?? 1e9);
      if (!cfg.vis) return;
      // per-tile distance bands (frustum culling is done by three on the bounding spheres)
      const k = shared.uFovK.value, cp = cam.position;
      const dmaxK = [shared.uLodG.value.z, shared.uLodF.value.z];
      for (const m of tileMeshes) {
        if (!m.visible) continue;
        const box = m.userData.box, kind = m.userData.kind, sw = VEG.lodSwitch[kind], dz = sw * 0.2;
        const dn = box.distanceToPoint(cp) * k;
        const cx = Math.max(Math.abs(cp.x - box.min.x), Math.abs(cp.x - box.max.x)), cz = Math.max(Math.abs(cp.z - box.min.z), Math.abs(cp.z - box.max.z));
        const df = Math.hypot(cx, cz, Math.max(Math.abs(cp.y - box.min.y), Math.abs(cp.y - box.max.y))) * k;
        m.visible = dn < dmaxK[kind] && (m.userData.far ? df > sw - dz : dn < sw + dz);
      }
    },
  };
}
