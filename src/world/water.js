// WATER — six creeks (the petal midveins), the lake, the river, the NW waterfall
// (frozen ice curtain -> shatter -> thundering sheet), its sunlit mist plume and
// the physically placed double rainbow.
//
// Winter -> spring:
//  * creeks: milky ice that cracks AHEAD of the bloom wave (arrival(xz) with a lead),
//    plates part into dark-blue water that reflects an analytic SUMMER sky
//    (deep cyan + bold cumulus + sun glitter) while the real sky is still overcast;
//    meltwater drip rings come from an analytic ring buffer of impacts.
//  * lake: explicit break-up clock during the reveal (drifting sparkling plates ->
//    turquoise), river: ice breaks up in a chain running upstream to the falls.
//  * falls: ice curtain made of slab pieces that crack top->bottom and shatter at
//    TIMES.cut5; a curved ballistic water sheet with scrolling streak noise + lip foam;
//    an overlay mist plume (soft sprites, scene-depth occluded) that also carries the
//    rainbow (42/51 deg bands around -sunDir, Alexander's dark band) from TIMES.rainbow.
// All geometry is derived at runtime from the loaded height data (main grid + falls patch),
// so the module follows terrain re-bakes automatically.
import * as THREE from 'three';
import * as L from './layout.js';
import { worldMaterial, castShadow, rng } from './common.js';
import { PALETTE_GLSL } from './terrain.js';
import { key, smoothstep, clamp01, lerp } from './keys.js';

// ------------------------------------------------------------------ tuning knobs
export const WATER_TUNE = {
  // creek ice crack lead over the bloom wave (arrival units) outside the FPV beat; during the
  // beat the lead is solved every subframe from crackRun (the creek is the wave's fast lane).
  iceLead: T => [[0, 2], [T.creek, 2], [T.sunBreak + 0.1, 4], [T.sunBreak + 0.6, 9], [T.cut3, 18], [T.cut4, 25], [T.end + 1, 25]],
  // metres the opening crack tip runs ahead of the lens during the creek beat (never behind the
  // wave's own opening): it overtakes the wave ~creek+0.5 and zips to the vanishing point by ~creek+1.0
  crackRun: T => [[T.creek, 0.8], [T.creek + 0.3, 20], [T.creek + 0.55, 45], [T.creek + 0.8, 90], [T.creek + 1.0, 160], [T.catchUp, 320], [T.cut3, 600]],
  hairLeadS: 0.17,          // the white hairline fracture runs this many seconds (~5 frames) ahead of the opening
  springGain: 1.0,          // brightness of the analytic summer sky seen in the creeks
  rippleK: 0.4,             // creek ripple distortion (1 = old look); low so the summer reflection reads
  lakeDelay: 0.2,           // lake starts to break up this long after TIMES.cut4 (shore first, centre ~1.7 s later)
  chainDelay: 0.3, chainV: 620, // river chain: starts at the lake, runs up/down-stream at chainV m/s (reaches the falls base before cut5)
  shatterDelay: 0.0,        // crack flash starts at TIMES.cut5 + this
  crackDur: 0.05,           // crack lines race top -> bottom over this
  burstDelay: 0.03,         // chunks burst this long after the crack starts (~1 frame; never before cut5, see ICE_VERT)
  waterDelay: 0.24,         // the water sheet starts pouring this long after the crack starts
  frontV: 5.5,              // water front speed (fall-time seconds per second)
  curtainScale: 1.45,       // ice column width multiplier
  sheetHW: [24, 3.0],       // water sheet half width at the lip + growth per second of fall
  sheetG: 9.81,             // gravity used for the sheet trajectory
  mist: { billow: 210, haze: 120, veil: 70, dust: 190, shard: 380, bow: 34 },
  bowGain: 1.2,             // rainbow intensity on mist
  bowFrac: 0.32,            // primary bow radius as a fraction of the falls-shot horizontal fov
  bowLift: 0.0,             // bow centre raised above the plume base (fraction of the radius)
  plumeScale: 1.7,          // overall size of the spray plume
};

// ------------------------------------------------------------------ GLSL
const WATER_GLSL = /* glsl */`
${PALETTE_GLSL}
uniform sampler2D tHeight; uniform vec4 uGrid; uniform vec3 uGridK;
uniform sampler2D tPatch; uniform vec4 uPatch; uniform vec4 uPatchHole; uniform float uHasPatch;
uniform float uSpringGain;

// ---- terrain height exactly as the terrain mesh is triangulated (warped grid + falls patch)
float _tri(sampler2D T, vec2 f) {
  vec2 i0 = floor(f); vec2 uv = f - i0; ivec2 a = ivec2(i0);
  float h00 = texelFetch(T, a, 0).r, h10 = texelFetch(T, a + ivec2(1, 0), 0).r;
  float h01 = texelFetch(T, a + ivec2(0, 1), 0).r, h11 = texelFetch(T, a + ivec2(1, 1), 0).r;
  return uv.x > uv.y ? h00 + (h10 - h00) * uv.x + (h11 - h10) * uv.y : h00 + (h11 - h01) * uv.x + (h01 - h00) * uv.y;
}
float terrainH(vec2 xz) {
  if (uHasPatch > 0.5 && xz.x > uPatchHole.x && xz.x < uPatchHole.z && xz.y > uPatchHole.y && xz.y < uPatchHole.w) {
    return _tri(tPatch, clamp((xz - uPatch.xy) / uPatch.z * uPatch.w, vec2(0.0), vec2(uPatch.w - 1.001)));
  }
  vec2 f = vec2(asinh((xz.x - uGrid.x) / (uGrid.z * uGridK.y)), asinh((xz.y - uGrid.y) / (uGrid.w * uGridK.y)));
  f = (f / uGridK.x + 1.0) * 0.5 * uGridK.z;
  return _tri(tHeight, clamp(f, vec2(0.0), vec2(uGridK.z - 1.001)));
}

// ---- the analytic SUMMER sky (deep cyan, bold sunlit cumulus) used by creek reflections.
// Cumulus are unions of circles in (azimuth, elevation) space: clean anime silhouettes with
// flat bases, a crisp light/shadow split from each billow's normal, lavender undersides.
// returns x: coverage (signed distance, >0 inside, radians), y: light 0..1
vec2 cumulus(vec2 p, vec2 base, float w, float h, float seed, vec2 L2) {
  float ks = w * 0.045;                    // soft-union radius
  float sum = 0.0; vec2 nsum = vec2(0.0);
  for (int i = 0; i < 7; i++) {
    float fi = float(i);
    vec3 hh = hash33(vec3(seed, fi * 1.37, 7.1));
    float k = fi / 6.0;
    vec2 c = base + vec2((hh.x - 0.5) * w * (1.0 - 0.55 * k), h * (0.16 + 0.66 * k) + (hh.y - 0.5) * h * 0.15);
    float r = w * (0.22 + 0.14 * hh.z) * (1.0 - 0.36 * k);
    vec2 dp = (p - c) * vec2(1.0, 1.15);
    float l = length(dp);
    float wgt = exp(clamp((r - l) / ks, -40.0, 40.0));
    sum += wgt; nsum += dp / max(l, 1e-5) * wgt;
  }
  float best = ks * log(max(sum, 1e-30));
  best = min(best, (p.y - base.y) * 1.5);                    // flat base
  float crease = length(nsum) / max(sum, 1e-30);             // <1 where billows meet
  vec2 nn = nsum / max(length(nsum), 1e-6);
  float lit = dot(nn, L2) * 0.5 + 0.5;
  lit *= mix(0.72, 1.0, smoothstep(0.55, 0.95, crease));
  lit *= mix(0.6, 1.0, smoothstep(0.0, 0.3 * h + 0.01, p.y - base.y));   // lavender undersides
  return vec2(best, lit);
}
vec3 springSky(vec3 d) {
  d = normalize(d);
  float el = asin(clamp(d.y, -1.0, 1.0));
  float az = atan(d.z, d.x);
  // summer blue: #9CCBF2 horizon -> #2D74D8 zenith (no electric azure)
  vec3 ZEN = s2l(vec3(0.176, 0.455, 0.847));
  vec3 HOR = s2l(vec3(0.612, 0.796, 0.949));
  vec3 sky = mix(HOR, ZEN, smoothstep(-0.01, 0.6, el)) * 1.12;
  float sunAz = atan(uSunDir.z, uSunDir.x);
  float side = sin(sunAz - az) > 0.0 ? 1.0 : -1.0;
  vec2 L2 = normalize(vec2(-side * 0.55, 1.0));
  vec2 p = vec2(az, el);
  float cov = -1.0, lit = 0.5;
  // 1) a few towering sunlit cumulus on the horizon (gap of blue sky around the sun)
  float cw = 0.42; float ci = floor(az / cw);
  for (int j = -1; j <= 1; j++) {
    float c = ci + float(j);
    vec3 hc = hash33(vec3(c, 3.3, 1.9));
    float cAz = (c + 0.2 + 0.6 * hc.x) * cw;
    float dSun = abs(atan(sin(cAz - sunAz), cos(cAz - sunAz)));
    if (hc.y < 0.42 || dSun < 0.22) continue;
    float w = cw * (0.70 + 0.6 * hc.z), h = 0.10 + 0.30 * hc.y * hc.y;
    vec2 q = cumulus(vec2(az - cAz, el), vec2(0.0, -0.004), w, h, c, L2);
    if (q.x > cov) { cov = q.x; lit = q.y; }
  }
  // 2) scattered fair-weather cumulus higher up
  vec2 g = vec2(az / 0.55, (el - 0.10) / 0.24);
  vec2 gi = floor(g);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 c = gi + vec2(float(i), float(j));
    if (c.y < 0.0 || c.y > 3.0) continue;
    vec3 hc = hash33(vec3(c, 8.8));
    if (hc.z < 0.62) continue;
    vec2 ctr = vec2((c.x + 0.2 + 0.6 * hc.x) * 0.55, 0.10 + (c.y + 0.15 + 0.5 * hc.y) * 0.24);
    float w = (0.16 + 0.16 * hc.z) * (1.0 - 0.18 * c.y), h = w * 0.5;
    vec2 q = cumulus(p, ctr, w, h, c.x * 7.0 + c.y * 3.0, L2);
    if (q.x > cov) { cov = q.x; lit = q.y; }
  }
  // painterly edge: a little noise on the silhouette, crisp transition
  cov += (vnoise(p * vec2(60.0, 80.0)) - 0.5) * 0.006;
  float cm = smoothstep(0.0, 0.004, cov) * step(-0.01, el);
  vec3 cLit = s2l(vec3(1.0, 0.975, 0.93)) * 2.1;
  vec3 cSh = s2l(vec3(0.725, 0.70, 0.88)) * 1.15;
  float lt = smoothstep(0.40, 0.58, lit + 0.08 * smoothstep(0.0, 0.03, cov));
  vec3 cloud = mix(cSh, cLit, lt);
  cloud = mix(cloud, cLit * 1.12, (1.0 - smoothstep(0.0, 0.006, cov)) * lt * 0.6);   // bright sunlit rim
  sky = mix(sky, cloud, cm);
  // the summer sun: a compact disc + tight glow (ripples break it into a glitter path)
  float cs = dot(d, uSunDir);
  sky += s2l(vec3(1.0, 0.96, 0.84)) * (smoothstep(0.99982, 0.99992, cs) * 7.0 + pow(max(cs, 0.0), 1500.0) * 1.2 + pow(max(cs, 0.0), 80.0) * 0.2);
  return sky * uSpringGain;
}

// ---- moving Voronoi ice plates. returns x: distance to plate border (cell units), y: cell hash, zw: cell id
vec4 plateField(vec2 p, float drift) {
  vec2 ip = floor(p), fp = fract(p);
  float md = 9.0; vec2 mr = vec2(0.0), mc = vec2(0.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 o = 0.15 + 0.7 * hash22(ip + g) + (hash22(ip + g + 19.1) - 0.5) * drift;
    vec2 r = g + o - fp; float d = dot(r, r);
    if (d < md) { md = d; mr = r; mc = g; }
  }
  float ed = 9.0;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    vec2 g = mc + vec2(float(i), float(j));
    vec2 o = 0.15 + 0.7 * hash22(ip + g) + (hash22(ip + g + 19.1) - 0.5) * drift;
    vec2 r = g + o - fp; vec2 dd = r - mr;
    if (dot(dd, dd) > 1e-5) ed = min(ed, dot(0.5 * (mr + r), normalize(dd)));
  }
  return vec4(ed, hash12(ip + mc + 7.7), ip + mc);
}

// ---- small-wave slope field (dh/dx, dh/dz)
vec2 waveGrad(vec2 p, float t) {
  vec2 g = vec2(0.0);
  const vec2 D0 = vec2(0.80, 0.60), D1 = vec2(-0.45, 0.89), D2 = vec2(0.97, -0.24), D3 = vec2(-0.70, -0.71);
  g += D0 * cos(dot(p, D0) * 1.3 + t * 1.9) * 0.45;
  g += D1 * cos(dot(p, D1) * 2.3 + t * 2.6) * 0.30;
  g += D2 * cos(dot(p, D2) * 3.9 + t * 3.4) * 0.18;
  g += D3 * cos(dot(p, D3) * 6.7 + t * 4.4) * 0.11;
  float e = 0.12; vec2 pn = p * 1.9 + vec2(t * 0.35, -t * 0.2);
  float n0 = vnoise(pn), nx = vnoise(pn + vec2(e, 0.0)), nz = vnoise(pn + vec2(0.0, e));
  g += vec2(nx - n0, nz - n0) / e * 0.30;
  return g;
}

// ---- meltwater drip rings (analytic ring buffer of impacts on a jittered grid)
vec2 dripRings(vec2 xz, float t, float density) {
  vec2 g = vec2(0.0);
  const float cs = 1.15;
  vec2 c0 = floor(xz / cs);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 c = c0 + vec2(float(i), float(j));
    vec3 h = hash33(vec3(c, 3.3));
    if (h.z > density) continue;
    vec2 src = (c + 0.15 + 0.7 * h.xy) * cs;
    float period = 0.75 + 0.9 * hash12(c + 11.0);
    float age = fract(t / period + h.x * 3.7) * period;
    vec2 d = xz - src; float r = length(d) + 1e-4;
    float R = 0.08 + age * 0.85;
    float x = r - R;
    float env = exp(-x * x / 0.010) * exp(-age * 2.4) * smoothstep(0.0, 0.05, age);
    g += (d / r) * cos(x * 30.0) * env * 0.55;
  }
  return g;
}

float fresnelW(float c) { return 0.02 + 0.98 * pow(1.0 - clamp(c, 0.0, 1.0), 5.0); }
`;

// creek / lake / river share one shader (defines CREEK / LAKE / RIVER)
const SURF_VERT = /* glsl */`
attribute vec4 aCS; attribute vec2 aTan;
varying vec3 vWorld; varying vec4 vCS; varying vec2 vTan;
#ifdef CREEK
attribute float aTaper;
#endif
void main() {
  vec3 pos = position;
  vCS = aCS; vTan = aTan;
#ifdef CREEK
  // far shots: side creeks taper to a point before the river / lake instead of a square cap
  float tk = mix(1.0, aTaper, uFarK);
  pos.xz -= vec2(-aTan.y, aTan.x) * aCS.y * (1.0 - tk);
  vCS.y = aCS.y * tk; vCS.z = aCS.z * tk;
#endif
  vWorld = pos;
  gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
}`;

const SURF_FRAG = /* glsl */`
${WATER_GLSL}
uniform float uIceLead; uniform float uSpringRefl; uniform float uHairLead; uniform float uRippleK; uniform float uVeinK;
uniform float uLakeT0; uniform vec4 uLake; uniform float uLakeRot;
uniform vec4 uChain; uniform vec3 uFallsBase; uniform float uShatterT; uniform float uFoamT;
varying vec3 vWorld; varying vec4 vCS; varying vec2 vTan;

float lakeSD(vec2 xz) {
  vec2 d = xz - uLake.xy; float c = cos(-uLakeRot), s = sin(-uLakeRot);
  vec2 l = vec2(d.x * c - d.y * s, d.x * s + d.y * c);
  vec2 n = l / uLake.zw; float ang = atan(n.y, n.x);
  float wob = 1.0 + 0.09 * sin(ang * 3.0 + 1.3) + 0.05 * sin(ang * 5.0 + 0.2);
  return (length(n) - wob) * min(uLake.z, uLake.w);
}

void main() {
  vec3 wp = vWorld; vec2 xz = wp.xz;
  vec3 toCam = cameraPosition - wp; float dist = length(toCam); vec3 V = toCam / dist;
#ifdef RIVER
  if (lakeSD(xz) < 2.0) discard;
#endif
  float depth = wp.y - terrainH(xz);
  float t = uTime;

  // ------------------------------------------------ ice state
  float ice = 0.0;        // plate coverage
  float crackDark = 0.0;  // open hairline cracks (dark)
  float fracture = 0.0;   // frozen-in white fracture planes
  float rimHi = 0.0;      // plate rim highlight
  float edgeSh = 0.0;     // water shade next to plates
  float glow = 0.0;       // light leaking through a fresh crack
  float frost = 0.0;      // snow dusting on the ice
  float melt = 0.0;
  float plateH = 0.0;     // plate random
  float floaterThin = 0.0; // thin glassy pans
  float halo = 0.0;        // submerged ice skirt around floes
  float hair = 0.0;        // white hairline fracture running ahead of the opening
  float wetRim = 0.0;      // dark wet rim on the shelf edge
  vec2 edgeTilt = vec2(0.0); // rounded shelf edge: normal tilts toward the open water
  float floeTilt = 0.0;
  vec2 flowDir = vec2(1.0, 0.0);
  vec2 rp;                // ripple coordinates

#ifdef CREEK
  float s = vCS.x, u = vCS.y, hw = vCS.z;
  vec2 T2 = normalize(vTan); vec2 N2 = vec2(-T2.y, T2.x);
  flowDir = -T2;
  float e = uBloomD + uIceLead - arrival(xz);
  float cracked = step(0.0, e);
  float open = smoothstep(0.0, 2.8, e);
  melt = smoothstep(7.0, 48.0, e);
  // the zipper crack: one jagged line down the creek
  float uc = (vnoise(vec2(s * 0.31, vCS.w * 3.1)) - 0.5) * 0.7 + (vnoise(vec2(s * 1.9, 7.0 + vCS.w)) - 0.5) * 0.22;
  float dc = u - uc; float sd = dc >= 0.0 ? 1.0 : -1.0;
  // the two shelves part: an open lane with ragged edges that widens behind the tip
  float edgeN = (vnoise(vec2(s * 1.1, sd * 5.0 + vCS.w)) - 0.5) * 0.42 + (vnoise(vec2(s * 3.7, sd * 9.0)) - 0.5) * 0.14;
  float laneW = open * (0.75 + 0.55 * vnoise(vec2(s * 0.15, sd * 3.0 + vCS.w))) + melt * 3.0;
  float lane = abs(dc) - laneW - edgeN * open;            // < 0: open water
  // shelves only break into plates along the lane edge
  vec2 pc = vec2(s * 0.62, (u - sd * laneW) * 0.7 + sd * 0.41 + vCS.w * 5.0);
  vec4 vp = plateField(pc, 0.0);
  plateH = vp.y;
  // only the band along the lane breaks into loose plates; the shelf interior stays sealed
  float nearLane = 1.0 - smoothstep(0.15, 0.75, lane);
  float gap = nearLane * open * (0.04 + 0.12 * vp.y) + melt * 0.4;
  float shelf = mix(1.0, smoothstep(gap, gap + 0.025, vp.x), smoothstep(0.0, 0.012, gap)) * smoothstep(-0.01, 0.01, lane);
  // a few loose plates float down the open lane
  // small rounded ice pans (edge distance blended with distance to the pan centre)
  vec2 fq = vec2((s + t * 0.5) * 2.1, u * 2.4 + 13.0 + vCS.w * 3.0);
  vec4 fp = plateField(fq, 0.0);
  float fh = hash12(fp.zw + 2.0);
  float fgap = mix(0.12, 0.24, fh) + melt * 0.3;
  vec2 fcell = fq - fp.zw - (0.15 + 0.7 * hash22(fp.zw));
  float round_ = min(fp.x, 0.42 - length(fcell) * 0.62);
  // pans tilt, then sink/melt away a few metres behind the opening
  float sinkE = e * (0.55 + 0.9 * fh);
  float floater = step(hash12(fp.zw + 3.1), 0.34) * smoothstep(fgap, fgap + 0.025, round_) * open * (1.0 - smoothstep(-0.05, 0.0, lane)) * (1.0 - smoothstep(3.0, 10.0, sinkE));
  floaterThin = floater * max(0.55 + 0.45 * step(0.6, fh), smoothstep(1.5, 6.0, sinkE));
  floeTilt = floater;
  ice = max(shelf, floater);
  if (e < 0.0) { ice = 1.0; lane = 1.0; }
  rimHi = max(smoothstep(gap + 0.07, gap + 0.01, vp.x) * shelf * smoothstep(0.0, 0.012, gap) * 0.7, smoothstep(fgap + 0.05, fgap + 0.01, round_) * floater);
  // rounded shelf edge: a 5-10 cm wet dark rim at the waterline, the lip rolls toward the water
  float onShelf = shelf * cracked * (1.0 - floater);
  wetRim = (1.0 - smoothstep(0.0, 0.09, lane)) * onShelf * (1.0 - melt * 0.5);
  edgeTilt = -sd * N2 * (1.0 - smoothstep(0.04, 0.32, lane)) * onShelf * 0.85;
  fracture = max(fracture, (1.0 - smoothstep(0.0, 0.016, vp.x)) * (1.0 - smoothstep(0.0, 0.012, gap)) * 0.55);
  edgeSh = (1.0 - smoothstep(0.0, 0.35, -lane)) * (1.0 - ice) * (1.0 - melt) * cracked;
  // fresh crack (thin, dark, light leaking) right behind the zipping tip
  float tip = cracked * (1.0 - smoothstep(0.0, 1.4, e));
  crackDark = (1.0 - smoothstep(0.01, 0.025 + 0.045 * smoothstep(0.0, 0.6, e), abs(dc))) * cracked * (1.0 - open);
  glow = (1.0 - smoothstep(0.0, 0.22, abs(dc))) * tip;
  // frozen-in white fracture planes + frost on the intact ice
  vec4 vf = plateField(vec2(s * 0.22, u * 0.35 + vCS.w * 7.0), 0.0);
  fracture = max(fracture, (1.0 - smoothstep(0.0, 0.02, vf.x)) * step(0.45, hash12(vf.zw)) * 0.9);
  // the white hairline: a jagged fracture that zips ahead of the opening (with short side branches)
  float pre = (1.0 - cracked) * smoothstep(-uHairLead - 0.01, -uHairLead * 0.55, e);
  float jag = (vnoise(vec2(s * 3.3, vCS.w * 9.0)) - 0.5) * 0.12 + (vnoise(vec2(s * 11.0, 3.0 + vCS.w)) - 0.5) * 0.05;
  float fw = fwidth(dc) * 1.6 + 0.006;
  hair = (1.0 - smoothstep(fw * 0.6, fw * 1.6, abs(dc - jag))) * pre;
  vec4 vb = plateField(vec2(s * 0.9, u * 1.6 + vCS.w * 4.0), 0.0);
  float fwb = fwidth(vb.x) * 1.5 + 1e-4;
  hair = max(hair, (1.0 - smoothstep(fwb * 0.6, fwb * 1.6, vb.x)) * (1.0 - smoothstep(0.15, 0.7, abs(dc))) * step(0.5, hash12(vb.zw)) * pre * 0.8);
  frost = smoothstep(0.5, 0.78, fbm(vec2(s * 0.7, u * 1.1) + 3.0));
  rp = vec2(s, u);
#endif

#ifdef LAKE
  vec2 lc = vCS.xy;
  float sdl = lakeSD(xz);
  float inward = clamp(-sdl / 42.0, 0.0, 1.0);
  float tStart = uLakeT0 + 1.6 * inward + 0.6 * (fbm(lc * 0.025 + 4.0) - 0.5);
  float p = (t - tStart) / 1.9;
  float open = smoothstep(0.02, 0.4, p);
  melt = smoothstep(0.3, 1.25, p);
  vec2 drift = vec2(1.0, 0.35) * max(p, 0.0) * 2.6;
  // big floes first, which later split into smaller pans; every floe has its own gap.
  // domain-warped so the floes are irregular shards, never a tiled grid
  vec2 lw = lc - drift;
  lw += (vec2(vnoise(lw * 0.045 + 1.7), vnoise(lw * 0.045 + 8.3)) - 0.5) * 18.0 + (vec2(vnoise(lw * 0.16 + 4.1), vnoise(lw * 0.16 + 9.2)) - 0.5) * 4.0;
  vec4 vb = plateField(lw / 16.0, 0.2 * open);
  vec4 vp = plateField(lw / 6.5 + vb.zw * 3.7, 0.22 * open);
  plateH = vp.y;
  float hb = hash12(vb.zw + 1.3);
  float gapB = 0.006 + open * (0.05 + 0.07 * hb) + melt * 0.22;
  float split = smoothstep(0.25, 0.8, p + 0.3 * (hb - 0.5)) * step(0.45, hb);
  float gapS = split * (0.04 + 0.07 * vp.y) + melt * 0.2;
  float gone = max(step(vp.y, melt * 1.3 - 0.1), step(hb, melt * 1.2 - 0.25));
  float iceB = smoothstep(gapB, gapB + 0.012, vb.x);
  float iceS = mix(1.0, smoothstep(gapS, gapS + 0.02, vp.x), smoothstep(0.0, 0.01, gapS));
  ice = iceB * iceS * (1.0 - gone);
  if (p < 0.0) ice = 1.0;
  float gap = gapS;
  crackDark = max(1.0 - smoothstep(0.0, 0.02, vb.x), (1.0 - smoothstep(0.0, 0.03, vp.x)) * 0.5) * smoothstep(-0.3, 0.0, p) * (1.0 - open);
  glow = crackDark * (1.0 - smoothstep(-0.05, 0.25, p));
  fracture = (1.0 - smoothstep(0.0, 0.016, vp.x)) * (1.0 - smoothstep(-0.4, -0.2, p)) * 0.5;
  rimHi = max(smoothstep(gapB + 0.04, gapB + 0.008, vb.x), smoothstep(gapS + 0.06, gapS + 0.01, vp.x) * smoothstep(0.0, 0.01, gapS)) * ice * step(0.0, p);
  // submerged ice skirt: a bright cyan halo around each floe
  halo = (1.0 - ice) * (1.0 - gone) * max(smoothstep(gapB - 0.03, gapB, vb.x), smoothstep(gapS - 0.035, gapS, vp.x) * smoothstep(0.0, 0.01, gapS)) * (1.0 - melt * 0.6) * step(0.0, p);
  frost = smoothstep(0.35, 0.7, fbm(lc * 0.05 + 2.0)) * (1.0 - open);
  rp = lc * 0.55;
  flowDir = vec2(cos(uLakeRot), sin(uLakeRot));
#endif

#ifdef RIVER
  float s = vCS.x, u = vCS.y, hw = vCS.z;
  vec2 T2 = normalize(vTan);
  flowDir = T2;
  float seg = floor((s + 13.0 * sin(u * 0.15)) / 52.0);
  float sj = seg * 52.0 + 26.0;
  float dUp = uChain.z - sj, dDn = sj - uChain.w;
  float tB = uChain.x + max(max(dUp, dDn), 0.0) / uChain.y + 0.22 * hash11(seg * 1.7);
  float p = (t - tB) / 1.1;
  float open = smoothstep(0.0, 0.3, p);
  melt = smoothstep(0.15, 1.0, p);
  vec2 rq0 = vec2(s - 3.0 * max(p, 0.0) * 1.1, u);
  rq0 += (vec2(vnoise(rq0 * 0.05 + 2.3), vnoise(rq0 * 0.05 + 7.9)) - 0.5) * 14.0 + (vec2(vnoise(rq0 * 0.19 + 1.1), vnoise(rq0 * 0.19 + 5.4)) - 0.5) * 3.5;
  vec4 vp = plateField(vec2(rq0.x / 12.0, rq0.y / 8.5), 0.3 * open);
  plateH = vp.y;
  float gone = step(vp.y, melt * 1.35 - 0.1);
  float gap = 0.008 + open * (0.08 + 0.10 * hash12(vp.zw + 4.0)) + melt * 0.32;
  ice = smoothstep(gap, gap + 0.02, vp.x) * (1.0 - gone);
  if (p < 0.0) ice = 1.0;
  crackDark = (1.0 - smoothstep(0.0, 0.035, vp.x)) * smoothstep(-0.35, 0.0, p) * (1.0 - open);
  glow = crackDark * (1.0 - smoothstep(-0.05, 0.25, p));
  fracture = (1.0 - smoothstep(0.0, 0.016, vp.x)) * (1.0 - smoothstep(-0.4, -0.2, p)) * 0.5;
  rimHi = smoothstep(gap + 0.07, gap + 0.015, vp.x) * ice * step(0.0, p);
  edgeSh = (1.0 - smoothstep(gap - 0.01, gap - 0.10, vp.x)) * (1.0 - ice) * (1.0 - melt);
  frost = smoothstep(0.35, 0.7, fbm(vec2(s, u) * 0.06 + 2.0)) * (1.0 - open);
  rp = vec2(s, u) * 0.6;
#endif

  // ------------------------------------------------ water surface
  float sh = sunShadow(wp + vec3(0.0, 0.08, 0.0), 1.0);
  float farFade = 1.0 - smoothstep(60.0, 900.0, dist);
#ifdef CREEK
  vec2 slope = waveGrad(rp * vec2(1.0, 1.6) + vec2(t * 0.9, 0.0), t) * (0.016 + 0.02 * farFade) * uRippleK;
  slope = T2 * slope.x + N2 * slope.y;                      // creek-local -> world
  slope += dripRings(xz, t, 0.5) * 0.9 * uRippleK * (1.0 - ice) * (1.0 - smoothstep(6.0, 40.0, dist));
#else
  // wide water: value-noise ripples only (regular sines tile at distance), fading with range
  #ifdef RIVER
  vec2 rq = rp * vec2(0.55, 1.3) - vec2(t * 1.6, 0.0);
  #else
  vec2 rq = rp * 0.9 + vec2(t * 0.25, -t * 0.1);
  #endif
  float e0 = 0.18;
  float n0 = vnoise(rq) + 0.5 * vnoise(rq * 2.7 + 3.1);
  float nx = vnoise(rq + vec2(e0, 0.0)) + 0.5 * vnoise((rq + vec2(e0, 0.0)) * 2.7 + 3.1);
  float nz = vnoise(rq + vec2(0.0, e0)) + 0.5 * vnoise((rq + vec2(0.0, e0)) * 2.7 + 3.1);
  vec2 slope = vec2(nx - n0, nz - n0) / e0 * 0.10 * mix(0.12, 1.0, 1.0 - smoothstep(60.0, 450.0, dist));
  #ifdef RIVER
  slope = T2 * slope.x + vec2(-T2.y, T2.x) * slope.y;
  #endif
#endif
  vec3 Nw = normalize(vec3(-slope.x, 1.0, -slope.y));
  vec3 R = reflect(-V, Nw); R.y = abs(R.y) + 0.004;
#ifdef CREEK
  R = normalize(vec3(R.x, R.y * 1.8 + 0.03, R.z));
#endif
  float F = fresnelW(dot(Nw, V));      // F0 0.02
#ifndef CREEK
  F = 0.02 + 0.70 * (F - 0.02);
#else
  F = max(F, 0.25 * uCreekFix);        // creek ride: the body mirrors the summer sky, not flat navy
#endif
  vec3 skyR = mix(skyGradient(R), springSky(R), uSpringRefl);
#ifndef CREEK
  skyR *= mix(vec3(1.0), s2l(vec3(0.70, 0.92, 0.93)), 0.3);   // a hint of glacial turquoise in the reflection
#endif
  // water body: deep teal-navy (#0C3B66 .. #0F3E5A); shallow shows a little turquoise bed
  vec3 deepC = s2l(vec3(0.10, 0.30, 0.33));
#ifdef CREEK
  vec3 shalC = s2l(vec3(0.13, 0.31, 0.30));
#else
  vec3 shalC = s2l(vec3(0.10, 0.38, 0.42));
#endif
  float shallow = 1.0 - smoothstep(0.15, 2.2, depth);
  vec3 bodyAlb = mix(deepC, shalC, shallow * 0.8);
  vec3 body = bodyAlb * (uSunColor * max(uSunDir.y, 0.05) * 0.55 * sh + vec3(dot(uSkyAmbient, vec3(0.2126, 0.7152, 0.0722))) * 0.8);
  vec3 water = body * (1.0 - F) + skyR * F;
  // contact shade next to plates + soft shore line
  water *= 1.0 - 0.45 * edgeSh;
  water = mix(water, s2l(vec3(0.62, 0.93, 0.92)) * (uSkyAmbient * 0.9 + uSunColor * 0.2 * sh), halo * 0.55);
#ifndef CREEK
  float shore = (1.0 - smoothstep(0.03, 0.22, depth)) * (1.0 - ice);
  water = mix(water, s2l(vec3(0.85, 0.95, 0.95)) * (uSunColor * 0.25 + uSkyAmbient * 0.8), shore * 0.55);
#else
  water = mix(water, water * 0.55, (1.0 - smoothstep(0.02, 0.18, depth)) * (1.0 - ice));
#endif
  // sun glitter (crisp sparkle shapes) on the reflected sky
  vec2 gcell = floor(xz * 7.0);
  vec2 gs = gcell;
#ifdef CREEK
  // creek ride: re-seed the sparkles every subframe so motion blur scatters them into dots, not dashes
  gs += step(0.5, uCreekFix) * vec2(17.0, 31.0) * floor(fract(uFrame * 0.618034) * 64.0);
#endif
  vec3 gN = normalize(Nw + vec3(hash22(gs) - 0.5, 0.0).xzy * 0.30);
  vec2 gq = fract(xz * 7.0) - 0.5 - (hash22(gs + 1.3) - 0.5) * 0.5;
  float glit = pow(max(dot(reflect(-V, gN), uSunDir), 0.0), 300.0) * step(0.4, hash12(gs + 5.0)) * (1.0 - smoothstep(0.03, 0.12 + 0.08 * hash12(gs + 2.0), length(gq)));
  float glow2 = pow(max(dot(R, uSunDir), 0.0), 60.0);
  vec3 glitter = s2l(vec3(1.0, 0.945, 0.76)) * (glit * mix(9.0, 4.0, uCreekFix) + glow2 * 0.18) * sh;
#ifdef CREEK
  glitter *= 1.0 + mix(0.8, 0.3, uCreekFix) * uSpringRefl;      // the summer sun is brighter than the real one
#endif
  water += glitter * (1.0 - ice);

  // ------------------------------------------------ ice plates
  vec2 tn = vec2(vnoise(xz * 2.1 + plateH * 9.0), vnoise(xz * 2.1 + 5.0 + plateH * 9.0)) - 0.5;
  vec3 Ni = normalize(vec3(tn.x * 0.25 + (plateH - 0.5) * 0.12, 1.0, tn.y * 0.25));
  // tilting pans + the rounded shelf lip
  vec2 tiltR = (hash22(vec2(plateH * 91.0, plateH * 37.0 + 1.0)) - 0.5) * 0.9 * floeTilt;
  Ni = normalize(Ni + vec3(edgeTilt.x + tiltR.x, 0.0, edgeTilt.y + tiltR.y));
  vec3 iceA = mix(s2l(vec3(0.76, 0.84, 0.94)), s2l(vec3(0.90, 0.94, 0.99)), 0.35 + 0.4 * vnoise(xz * 0.7 + 3.0));
  iceA = mix(iceA, C_SNOW, frost * 0.75);
  iceA = mix(iceA, s2l(vec3(0.62, 0.82, 0.90)), melt * 0.55);   // thin, wet, melting plates go glassy
  vec3 iceC = shadeSurface(iceA, Ni, wp, 0.35, 1.0, 0.3, sh);
  vec3 Ri = reflect(-V, Ni);
  float Fi = 0.03 + 0.55 * pow(1.0 - max(dot(Ni, V), 0.0), 5.0);
  iceC += min(skyGradient(Ri), vec3(2.5)) * Fi * 0.7;  // ice reflects the REAL sky (overcast)
  iceC = mix(iceC, iceC * s2l(vec3(0.72, 0.80, 0.92)), fracture * 0.8);          // blue-grey fracture lines
  iceC = mix(iceC, water * 0.6 + iceC * 0.45, floaterThin * 0.6);                    // thin pans: water shows through
  // fresh fracture rims: thick ice shows a cold cyan translucency, with a dark waterline under it
  iceC = mix(iceC, s2l(vec3(0.62, 0.86, 0.95)) * (uSkyAmbient * 1.1 + uSunColor * 0.18 * sh), rimHi * 0.75);
  iceC *= 1.0 - 0.35 * smoothstep(0.75, 1.0, rimHi);
  // wet dark waterline on the shelf edge
  iceC = mix(iceC, s2l(vec3(0.20, 0.30, 0.42)) * (uSkyAmbient * 0.9 + uSunColor * 0.12 * sh), wetRim * 0.85);
  // sparkles on plates
  float sc = dist < 60.0 ? 5.0 : (dist < 400.0 ? 1.2 : 0.35);
  vec2 pcell = floor(xz * sc);
  vec3 fN = normalize(vec3(hash22(pcell + 3.3) - 0.5, 0.35).xzy);
  fN = normalize(vec3(fN.x, abs(fN.y) + 0.2, fN.z));
  float spk = pow(max(dot(reflect(-V, fN), uSunDir), 0.0), 220.0) * step(0.7, hash12(pcell + 1.7));
  iceC += s2l(vec3(1.0, 0.96, 0.85)) * spk * uSunColor * 1.6 * sh;

  vec3 col = mix(water, iceC, ice);
  // fresh cracks: dark hairline with cold light leaking out
  col = mix(col, s2l(vec3(0.10, 0.20, 0.32)) * (uSkyAmbient + 0.2), crackDark * 0.85);
  col += s2l(vec3(0.55, 0.85, 1.0)) * glow * (0.8 + uSunColor * 0.12);
  // white hairline fracture racing ahead of the opening
  col = mix(col, s2l(vec3(0.97, 0.99, 1.0)) * (uSkyAmbient * 1.3 + uSunColor * 0.3 + 0.35), hair);
#ifdef CREEK
  // from the air the creeks read as the petals' dark blue-violet midveins (tapering lines)
  float veinF = smoothstep(110.0, 420.0, dist) * uVeinK;
  col = mix(col, s2l(vec3(0.17, 0.15, 0.40)) * (uSkyAmbient * 0.9 + uSunColor * 0.16 * sh), veinF * 0.7);
#endif

#ifdef RIVER
  // plunge-pool foam at the waterfall base once the water arrives
  float fd = length(xz - uFallsBase.xz);
  float run = smoothstep(uFoamT, uFoamT + 0.5, t);
  float foamN = fbm(xz * 0.12 + vec2(t * 0.6, -t * 0.4));
  float foam = (1.0 - smoothstep(25.0, 95.0, fd + (foamN - 0.5) * 50.0)) * run;
  col = mix(col, shadeSurface(C_SNOW * 0.95, vec3(0.0, 1.0, 0.0), wp, 0.4, 1.0, 0.0, sh), foam * smoothstep(0.35, 0.55, foamN + 0.3 * (1.0 - fd / 95.0)));
#endif
  col = applyFog(col, wp);
  float outA = 1.0;
#ifdef RIVER
  // far shots: the bank is the smooth ribbon spline (fade at rw-2.5..rw+0.5), not the terrain triangle contour
  float edgeA = smoothstep(0.0, 0.4, depth) * (1.0 - smoothstep(hw - 7.5, hw - 4.5, abs(u)));
  outA = mix(1.0, edgeA, uFarK);
#endif
  gl_FragColor = vec4(col, outA);
}`;

// ---- waterfall water sheet
const SHEET_VERT = /* glsl */`
attribute vec4 aSh;  // lateral m, fall time tau, half width, lateral -1..1
varying vec3 vWorld; varying vec4 vSh; varying vec3 vN;
void main() {
  vWorld = position; vSh = aSh; vN = normal;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}`;
const SHEET_FRAG = /* glsl */`
${WATER_GLSL}
uniform float uWaterT; uniform float uFrontV; uniform float uTauEnd;
varying vec3 vWorld; varying vec4 vSh; varying vec3 vN;
void main() {
  float lat = vSh.x, tau = vSh.y, x = vSh.w;
  float t = uTime;
  // the water only pours once the ice chunks have burst clear; its front races down from the lip
  float flow = smoothstep(uWaterT, uWaterT + 0.3, t);
  float front = 1.0 - smoothstep(-0.25, 0.05, tau - (t - uWaterT) * uFrontV);
  float birth = t - tau;
  float n1 = vnoise(vec2(lat * 0.42, birth * 1.15));
  float n2 = vnoise(vec2(lat * 1.25 + 11.0, birth * 2.6));
  float n3 = vnoise(vec2(lat * 3.6 + 5.0, birth * 5.5));
  float n = n1 * 0.55 + n2 * 0.30 + n3 * 0.15;
  float ax = abs(x);
  // ragged sides: streamers peel off the edges and thin out as they fall
  float edge = 1.0 - smoothstep(0.5 + 0.4 * n2 - 0.12 * smoothstep(1.0, 5.0, tau), 0.97, ax);
  float body = smoothstep(0.16, 0.36, n + 0.42 * (1.0 - ax * ax) + 0.2 * (1.0 - smoothstep(0.0, 1.2, tau)));
  float bottom = 1.0 - smoothstep(uTauEnd - 1.8, uTauEnd - 0.1, tau);
  float a = edge * body * flow * front * mix(0.35, 1.0, bottom);
  a = min(1.0, a * 1.15);
  if (a < 0.02) discard;
  vec3 wp = vWorld;
  vec3 V = normalize(cameraPosition - wp);
  vec3 N = normalize(vN); if (dot(N, V) < 0.0) N = -N;
  // aeration grows as it falls; the lip is a glassy green-blue tongue, then a white foam roll
  float aer = smoothstep(0.1, 1.1, tau);
  float lipFoam = smoothstep(0.04, 0.16, tau) * (1.0 - smoothstep(0.3, 0.75, tau));
  float white = clamp(smoothstep(0.30, 0.58, n) * (0.45 + 0.55 * aer) + lipFoam + (1.0 - bottom) * 0.7 + aer * 0.25, 0.0, 1.0);
  vec3 glassy = s2l(vec3(0.24, 0.62, 0.66));
  vec3 alb = mix(glassy, s2l(vec3(0.96, 0.975, 1.0)), white);
  // vertical striations: lavender-blue shade streaks between the white ropes
  float stri = smoothstep(0.25, 0.75, vnoise(vec2(lat * 1.6, birth * 0.5 + 7.0)) * 0.7 + n3 * 0.3);
  alb = mix(alb * s2l(vec3(0.80, 0.82, 0.95)), alb, stri);
  // the bulging centre catches more light than the sides
  N = normalize(N + vec3(0.0, 0.0, 0.0));
  float sh = sunShadow(wp + N * 0.4, 1.5);
  vec3 col = shadeSurface(alb, N, wp, 0.7, 1.0, 0.35, sh) * (0.86 + 0.22 * (1.0 - ax * ax));
  vec3 R = reflect(-V, N);
  col += skyGradient(R) * fresnelW(dot(N, V)) * (1.0 - white) * 0.8;
  // sun-catching spray flecks on the face
  float fl = step(0.82, vnoise(vec2(lat * 5.0, birth * 8.0))) * white;
  col += uSunColor * 0.22 * fl * sh;
  col = applyFog(col, wp);
  gl_FragColor = vec4(col * a, a);
}`;

// ---- frozen ice curtain, made of slab pieces that crack and shatter
const ICE_VERT = /* glsl */`
attribute vec3 aPiv; attribute vec4 aSeed; attribute vec4 aVel; attribute vec4 aSpin; attribute vec4 aIce;
uniform float uShatterT; uniform float uBurstT; uniform float uBaseY; uniform vec3 uOutDir;
varying vec3 vWorld; varying vec3 vN; varying vec4 vIce; varying float vAge;
mat3 rotAxis(vec3 a, float ang) {
  float s = sin(ang), c = cos(ang), oc = 1.0 - c;
  return mat3(oc * a.x * a.x + c, oc * a.x * a.y + a.z * s, oc * a.z * a.x - a.y * s,
              oc * a.x * a.y - a.z * s, oc * a.y * a.y + c, oc * a.y * a.z + a.x * s,
              oc * a.z * a.x + a.y * s, oc * a.y * a.z - a.x * s, oc * a.z * a.z + c);
}
void main() {
  // a chunk never lets go before the shatter itself (keeps every pre-cut5 frame unchanged)
  float tLet = max(uBurstT + aSeed.x, uShatterT + 0.005);
  float age = uTime - tLet;
  vec3 p = position; vec3 n = normal;
  // while the cracks run the column bulges a hair outward, then it lets go
  vec3 bulge = uOutDir * smoothstep(uShatterT, tLet, uTime) * (0.3 + 0.6 * aSeed.z);
  p += bulge;
  if (age > 0.0) {
#ifdef DEPTH_PASS
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return;     // flying chunks cast no shadow
#endif
    // explosive pop (drag), then they hang, tumble and fall
    float g = 30.0, kd = 5.0;
    vec3 disp = aVel.xyz * (1.0 - exp(-kd * age)) / kd + vec3(0.0, -0.5 * g * age * age, 0.0) + bulge;
    mat3 R = rotAxis(normalize(aSpin.xyz), aSpin.w * age);
    // chunks break down into ice dust (the overlay burst hides the hand-off)
    float sc = (1.0 - smoothstep(0.35 + 0.3 * aSeed.y, 0.95 + 0.6 * aSeed.y, age)) * smoothstep(-6.0, 8.0, aPiv.y + disp.y - uBaseY);
    p = aPiv + disp + R * ((position - aPiv) * sc);
    n = R * normal;
  }
  vWorld = p; vN = n; vIce = aIce; vAge = age;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const ICE_FRAG = /* glsl */`
${WATER_GLSL}
uniform float uShatterT; uniform float uCrackDur; uniform float uLipY; uniform float uBaseY;
varying vec3 vWorld; varying vec3 vN; varying vec4 vIce; varying float vAge;
void main() {
  vec3 wp = vWorld; vec3 V = normalize(cameraPosition - wp);
  vec3 N = normalize(vN); if (dot(N, V) < 0.0) N = -N;
  float lat = vIce.y, yy = vIce.z;
  // blue-white frozen column: frosted white bulges, a translucent teal-cyan core in the grooves
  float facing = clamp(dot(N, V), 0.0, 1.0);
  float lowN = vnoise(vec2(lat * 0.16, yy * 0.045)) - 0.5;
  float crest = smoothstep(0.58, 0.92, facing * 0.6 + max(N.y, 0.0) * 0.55 + lowN * 0.45);
  float groove = 1.0 - smoothstep(0.3, 0.72, facing + lowN * 0.25);
  float under = smoothstep(0.1, 0.6, -N.y);
  vec3 alb = mix(s2l(vec3(0.55, 0.80, 0.92)), s2l(vec3(0.90, 0.95, 1.0)), crest * 0.85);
  alb = mix(alb, s2l(vec3(0.24, 0.52, 0.74)), max(groove * 0.75, under * 0.7));
  float sh = sunShadow(wp + N * 0.5, 1.5);
  vec3 col = shadeSurface(alb, N, wp, 0.45, 1.0, 0.55, sh);
  // cold light glowing through the ice core
  col += s2l(vec3(0.45, 0.82, 0.95)) * (uSkyAmbient * 0.16 + uSunColor * 0.03 * sh) * (1.0 - crest) * groove;
  // glassy: sky reflection + crisp faceted sun speculars
  vec3 R = reflect(-V, N);
  col += skyGradient(R) * (0.05 + 0.4 * pow(1.0 - facing, 4.0));
  vec2 cell = floor(vec2(lat, yy) * 0.55);
  vec3 gN = normalize(N + vec3(hash22(cell) - 0.5, hash12(cell + 3.0) - 0.5) * 0.6);
  float spec = pow(max(dot(reflect(-V, gN), uSunDir), 0.0), 70.0) * step(0.6, hash12(cell + 9.0)) + pow(max(dot(R, uSunDir), 0.0), 24.0) * 0.15;
  // tumbling chunks flash as their faces sweep through the sun
  spec += pow(max(dot(R, uSunDir), 0.0), 30.0) * 1.4 * smoothstep(0.0, 0.08, vAge);
  col += uSunColor * spec * 0.9 * sh;
  // the crack: races top -> bottom, glows along every chunk border until it lets go
  float fy = clamp((uLipY - yy) / max(uLipY - uBaseY, 1.0), 0.0, 1.0);
  float tc = uShatterT + uCrackDur * fy * (1.0 + 0.3 * min(abs(vIce.w), 1.5));
  float cr = smoothstep(tc, tc + 0.02, uTime) * (1.0 - smoothstep(0.0, 0.3, vAge));
  float line = 1.0 - smoothstep(0.0, 0.2, vIce.x);
  col = mix(col, s2l(vec3(0.85, 0.98, 1.0)) * (mix(2.8, 5.0, uFarK) + uSunColor * 0.4), line * cr);
  col = applyFog(col, wp);
  gl_FragColor = vec4(col, 1.0);
}`;

// ---- overlay mist plume + shatter burst + rainbow (premultiplied, scene-depth occluded)
const MIST_VERT = /* glsl */`
attribute vec2 aQ; attribute vec4 aSeed; attribute vec4 aSeed2; attribute vec4 aPos;
uniform float uBurstT; uniform float uRainbowT; uniform vec2 uRes;
uniform vec3 uBase; uniform vec3 uOut; uniform vec3 uSide; uniform float uHalfW; uniform vec2 uColW; uniform float uLipY; uniform float uFaceSlope; uniform float uPlumeScale;
varying vec2 vQ; varying vec4 vS; varying vec3 vWorld; varying float vSize; varying float vOp; varying float vAge;
void main() {
  // kind: 0 plume billow, 1 wide thin outer spray, 2 spray veil rising along the falls,
  //       3 shatter ice-dust burst, 4 glinting ice shards, 5 thin spray veil the bows show on
  float kind = aSeed2.w;
  float life = kind < 0.5 ? mix(2.4, 4.6, aSeed.y) : (kind < 1.5 ? mix(5.0, 8.0, aSeed.y) : (kind < 2.5 ? mix(1.6, 3.0, aSeed.y) : (kind < 3.5 ? mix(1.4, 2.6, aSeed.y) : (kind < 4.5 ? mix(0.45, 1.25, aSeed.y) : 1e4))));
  // the plume builds as the lower column crashes into the pool; burst + shards fire top-first with the chunks
  float t0 = kind < 2.5 ? uBurstT + 0.06 + 0.6 * aSeed.x * aSeed.x : (kind < 4.5 ? uBurstT + 0.085 * (1.0 - aSeed2.y) + 0.02 * aSeed.x : uRainbowT - 0.5);
  float since = uTime - t0;
  float gen = kind > 2.5 ? 0.0 : max(floor(since / life), 0.0);
  float age = since - gen * life;
  float burst = gen < 0.5 ? 1.0 : 0.0;
  vec3 h = fract(aSeed2.xyz + gen * vec3(0.618, 0.414, 0.732));
  // bell-shaped lateral spawn (no hard plume sides) that keeps spreading as the spray rises
  float lx = (h.x + fract(h.x * 7.31 + h.z * 3.7) - 1.0);
  vec3 c = uBase + uSide * lx * 1.2 * uHalfW * (kind > 1.5 ? 0.7 : 1.0) + uOut * (h.y * 8.0 - 2.0);
  c += uSide * lx * uHalfW * 0.55 * age * (kind > 1.5 ? 0.3 : 1.0) * uPlumeScale;
  float damp = 1.1;
  float k = (1.0 - exp(-age * damp)) / damp;
  vec3 vel;
  float size, op, fadeIn = 0.18;
  float H0 = uLipY - uBase.y;
  if (kind < 0.5) {
    vel = uOut * mix(10.0, 30.0, h.z) * (1.0 + 0.5 * burst) + uSide * (h.x - 0.5) * 34.0 + vec3(0.0, mix(14.0, 44.0, h.y) * (1.0 + 0.5 * burst), 0.0);
    c += (vel * k + vec3(0.0, 10.0 * age, 0.0) + uOut * 3.0 * age) * uPlumeScale;
    size = (mix(9.0, 17.0, h.y) + mix(9.0, 22.0, h.z) * pow(age, 0.7)) * uPlumeScale;
    op = mix(0.07, 0.15, aSeed.z);
  } else if (kind < 1.5) {
    // the wide, thin outer spray cloud
    vel = uOut * mix(16.0, 40.0, h.z) + uSide * lx * 80.0 + vec3(0.0, mix(6.0, 22.0, h.y), 0.0);
    c += (vel * k + uOut * 5.0 * age + vec3(0.0, 4.5 * age, 0.0)) * uPlumeScale;
    size = (mix(40.0, 75.0, h.y) + 20.0 * age) * uPlumeScale;
    op = mix(0.03, 0.065, aSeed.z);
  } else if (kind < 2.5) {
    // veil: rides up the lower face in front of the sheet
    c += vec3(0.0, mix(4.0, 30.0, h.y), 0.0) - uOut * 2.0;
    vel = vec3(0.0, mix(12.0, 30.0, h.z), 0.0) + uOut * mix(1.0, 6.0, h.x);
    c += vel * k - uOut * uFaceSlope * (vel.y * k);
    size = mix(7.0, 14.0, h.y) + 9.0 * age;
    op = mix(0.10, 0.20, aSeed.z);
  } else if (kind < 4.5) {
    // released along the whole column as it shatters
    float yy = mix(0.03, 0.98, h.y) * H0;
    float cw = mix(uColW.x, uColW.y, pow(yy / H0, 0.6));
    c = uBase + vec3(0.0, yy, 0.0) - uOut * (yy * uFaceSlope + 3.0) + uSide * (h.x - 0.5) * cw;
    if (kind < 3.5) {
      // ice-dust burst: punches out fast, expands over ~0.5 s, then sinks and drifts
      vec2 rd = vec2((h.x - 0.5) * 2.6, (h.y - 0.45) * 2.0); rd /= max(length(rd), 0.25);
      vel = uOut * mix(8.0, 30.0, h.z) + (uSide * rd.x + vec3(0.0, rd.y * 0.8 + 0.25, 0.0)) * mix(30.0, 85.0, fract(h.z * 5.1));
      float kk = (1.0 - exp(-age * 2.8)) / 2.8;
      c += vel * kk - vec3(0.0, 3.0 * age * age, 0.0);
      size = mix(10.0, 20.0, fract(h.z * 3.7)) + 60.0 * (1.0 - exp(-age * 2.6));
      op = mix(0.13, 0.26, aSeed.z);
      fadeIn = 0.05;
    } else {
      // shards: tiny, fast, ballistic, glinting
      vec2 rd = vec2((h.x - 0.5) * 2.6, (h.y - 0.45) * 2.0); rd /= max(length(rd), 0.2);
      vel = uOut * mix(15.0, 50.0, h.z) + (uSide * rd.x + vec3(0.0, rd.y * 0.8 + 0.3, 0.0)) * mix(60.0, 150.0, fract(h.z * 7.3));
      c += vel * (1.0 - exp(-age * 1.8)) / 1.8 - vec3(0.0, 15.0 * age * age, 0.0);
      float dist = length(c - cameraPosition);
      float wpp = dist * 2.0 / (projectionMatrix[1][1] * uRes.y);
      size = wpp * (uRes.y / 1080.0) * mix(6.0, 13.0, aSeed.z);
      op = 1.0;
      fadeIn = 0.02;
    }
  } else {
    // bow veil: thin spray laid along the arcs (placed on the CPU from the falls camera)
    c = aPos.xyz;
    size = aPos.w;
    op = mix(0.08, 0.13, aSeed.z) * smoothstep(uRainbowT - 0.4, uRainbowT + 0.7, uTime);
    age = 1.0;
  }
  float alive = step(0.0, since);
  op *= alive * (kind > 4.5 ? 1.0 : smoothstep(0.0, fadeIn, age) * (1.0 - smoothstep(0.5, 1.0, age / life)));
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  float rot = aSeed.w * 6.2831 + age * (aSeed.w - 0.5) * (kind > 3.5 && kind < 4.5 ? 3.0 : 0.5);
  vec2 q = mat2(cos(rot), -sin(rot), sin(rot), cos(rot)) * aQ;
  vec3 wp = c + (right * q.x + up * q.y) * size * 0.5;
  vQ = kind > 3.5 && kind < 4.5 ? q : aQ; vS = vec4(aSeed.xyz, kind); vWorld = wp; vSize = size; vOp = op; vAge = age;
  gl_Position = op > 0.001 ? projectionMatrix * viewMatrix * vec4(wp, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
}`;
const MIST_FRAG = /* glsl */`
${WATER_GLSL}
uniform sampler2D tDepth; uniform vec2 uRes; uniform vec2 uNearFar;
uniform float uRainbowT; uniform float uBowGain; uniform vec3 uBowC; uniform float uBowR; uniform float uBowOn;
varying vec2 vQ; varying vec4 vS; varying vec3 vWorld; varying float vSize; varying float vOp; varying float vAge;

// wavelength (nm) -> linear sRGB (approximate)
vec3 wl2rgb(float w) {
  vec3 c;
  if (w < 440.0) c = vec3(-(w - 440.0) / 60.0, 0.0, 1.0);
  else if (w < 490.0) c = vec3(0.0, (w - 440.0) / 50.0, 1.0);
  else if (w < 510.0) c = vec3(0.0, 1.0, -(w - 510.0) / 20.0);
  else if (w < 580.0) c = vec3((w - 510.0) / 70.0, 1.0, 0.0);
  else if (w < 645.0) c = vec3(1.0, -(w - 645.0) / 65.0, 0.0);
  else c = vec3(1.0, 0.0, 0.0);
  float f = w < 420.0 ? 0.3 + 0.7 * (w - 380.0) / 40.0 : (w > 680.0 ? 0.3 + 0.7 * (720.0 - w) / 40.0 : 1.0);
  return pow(c * f, vec3(2.2));
}
// primary (40.6 violet .. 42.4 red) and secondary (50.4 red .. 53.6 violet) bows, in physical degrees
vec3 bow(float th, float pAmt, float sAmt) {
  vec3 c = vec3(0.0);
  for (int i = 0; i < 10; i++) {
    float f = (float(i) + 0.5) / 10.0;
    float w = mix(400.0, 700.0, f);
    vec3 rgb = wl2rgb(w);
    float t1 = mix(40.6, 42.4, f), t2 = mix(53.6, 50.4, f);
    float d1 = th - t1, d2 = th - t2;
    float p1 = exp(-d1 * d1 / (2.0 * 0.22 * 0.22)) + 0.10 * exp(-pow(d1 + 1.6, 2.0) / 1.2) * step(d1, 0.0);
    float p2 = exp(-d2 * d2 / (2.0 * 0.45 * 0.45));
    c += rgb * (p1 * pAmt + 0.42 * p2 * sAmt);
  }
  c = c / 10.0 * 2.2;
  // push the chroma (overlapping wavelengths wash out to pastel otherwise)
  float m = min(c.r, min(c.g, c.b));
  return max(c - m * 0.75, vec3(0.0)) * 1.5;
}

float linD(vec2 uv) {
  float z = texture2D(tDepth, uv).x * 2.0 - 1.0;
  return 2.0 * uNearFar.x * uNearFar.y / (uNearFar.y + uNearFar.x - z * (uNearFar.y - uNearFar.x));
}

void main() {
  float r = length(vQ);
  if (r > 1.0) discard;
  float kind = vS.w;
  vec2 suv = gl_FragCoord.xy / uRes;
  float sceneD = linD(suv);
  float fragD0 = -(viewMatrix * vec4(vWorld, 1.0)).z;
  if (kind > 3.5 && kind < 4.5) {
    // glinting ice shard: hot core + a 4-point star that flickers as it tumbles
    if (sceneD < fragD0 - 2.0) discard;
    float core = exp(-r * r * 10.0);
    float star = exp(-abs(vQ.x) * 16.0) * exp(-vQ.y * vQ.y * 3.0) + exp(-abs(vQ.y) * 16.0) * exp(-vQ.x * vQ.x * 3.0);
    float fl = pow(0.5 + 0.5 * sin(vAge * mix(18.0, 46.0, vS.y) + vS.z * 40.0), 5.0);
    float a = clamp(core * 0.9 + star * 0.6 * fl, 0.0, 1.0) * vOp;
    if (a < 0.004) discard;
    vec3 c = mix(s2l(vec3(0.72, 0.90, 1.0)), s2l(vec3(1.0, 0.95, 0.84)), fl) * (uSkyAmbient * 0.9 + uSunColor * (0.3 + 1.4 * fl));
    gl_FragColor = vec4(c * a, a * 0.85);
    return;
  }
  float n = fbm(vQ * 1.35 + vS.xy * 37.0) - 0.5;
  float n2 = vnoise(vQ * 4.0 + vS.yz * 21.0) - 0.5;
  float d = r + n * 0.62 + n2 * 0.12;
  float e0 = kind < 0.5 ? 0.52 : (kind < 1.5 ? 0.2 : (kind > 4.5 ? 0.05 : (kind > 2.5 ? 0.22 : 0.4)));   // billows keep painterly edges, haze stays soft
  float a = (1.0 - smoothstep(e0, 0.97, d)) * vOp;
  a *= 0.75 + 0.25 * smoothstep(0.0, 0.5, 1.0 - r);
  // soft intersection with the scene (cliff, pool, trees)
  vec3 back = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  float nz = sqrt(max(1.0 - r * r, 0.0));
  float fragD = fragD0 - nz * vSize * 0.3;
  a *= clamp((sceneD - fragD) / (vSize * 0.35), 0.0, 1.0);
  if (a < 0.003) discard;
  // no hard ground line: the spray thins out just above any closer silhouette (meadow ridge, treeline)
  float px = uRes.y / 1080.0;
  float o1 = clamp((fragD - linD(suv - vec2(0.0, 10.0 * px / uRes.y))) / 30.0, 0.0, 1.0);
  float o2 = clamp((fragD - linD(suv - vec2(0.0, 24.0 * px / uRes.y))) / 30.0, 0.0, 1.0);
  float o3 = clamp((fragD - linD(suv - vec2(0.0, 44.0 * px / uRes.y))) / 30.0, 0.0, 1.0);
  a *= 1.0 - (0.42 * o1 + 0.3 * o2 + 0.2 * o3);
  // impostor lighting: crisp sunlit billows with cool lavender shadow sides, warm on the sun side
  vec3 Nw = normalize(right * vQ.x + up * vQ.y + back * (nz + 0.2));
  float sunT = dot(Nw, uSunDir) * 0.5 + 0.5;
  float topT = Nw.y * 0.5 + 0.5;
  float lit = smoothstep(0.44, 0.68, 0.38 * sunT + 0.62 * topT + n * 0.3);
  vec3 sunW = vec3(dot(uSunColor, vec3(0.2126, 0.7152, 0.0722))) * vec3(1.0, 0.975, 0.93);
  vec3 cLit = vec3(0.95) * (sunW * 0.55 + uSkyAmbient * 0.7);
  cLit *= mix(vec3(1.0), mix(s2l(vec3(1.0, 0.95, 0.86)), s2l(vec3(1.0, 0.98, 0.95)), uFarK), smoothstep(0.55, 0.9, sunT));
  vec3 cSh = s2l(vec3(0.60, 0.64, 0.86)) * (uSkyAmbient * 1.05 + sunW * 0.06);
  vec3 col = mix(cSh, cLit, lit);
  col *= 0.94 + 0.12 * vnoise(vQ * 3.0 + vS.xz * 13.0);
  col *= mix(0.74, 1.0, smoothstep(-0.7, 0.5, vQ.y + n * 0.9));     // each puff carries a cool underside
  // rainbow: a virtual anti-solar centre framed on the plume (uBowC), radius uBowR -> physical 42 deg
  vec3 dirV = normalize(vWorld - cameraPosition);
  float th = degrees(acos(clamp(dot(dirV, uBowC), -1.0, 1.0))) * (42.0 / uBowR);
  float bowOn = smoothstep(uRainbowT, uRainbowT + 0.5, uTime) * uBowOn;
  // brighter inside the primary, Alexander's dark band between the bows, mist dimmed behind the arcs
  float inner = 1.0;
  float alex = 1.0 - 0.45 * smoothstep(42.6, 43.6, th) * (1.0 - smoothstep(49.2, 50.4, th));
  float behind = (1.0 - 0.26 * (1.0 - smoothstep(54.5, 58.0, th))) * (1.0 - 0.18 * smoothstep(34.0, 39.5, th) * (1.0 - smoothstep(54.5, 58.0, th)));
  col *= mix(1.0, inner * alex * behind, bowOn);
  // draw-on: each bow grows from the ground up along its arc while it fades in
  vec3 A = uBowC;
  vec3 ref = normalize(vec3(0.0, 1.0, 0.0) - A * A.y);
  vec3 pr = normalize(dirV - A * dot(dirV, A));
  float psi = acos(clamp(dot(pr, ref), -1.0, 1.0));   // 0 at the top of the bow
  float prog1 = clamp((uTime - uRainbowT) / 0.7, 0.0, 1.0);
  float prog2 = clamp((uTime - uRainbowT - 0.7) / 0.5, 0.0, 1.0);
  float front1 = mix(2.4, -0.2, prog1 * prog1 * (3.0 - 2.0 * prog1));
  float front2 = mix(2.4, -0.2, prog2 * prog2 * (3.0 - 2.0 * prog2));
  float pAmt = smoothstep(front1 - 0.35, front1 + 0.02, psi) * smoothstep(0.0, 0.6, prog1);
  float sAmt = smoothstep(front2 - 0.35, front2 + 0.02, psi) * smoothstep(0.0, 0.6, prog2);
  float sunVis = mix(0.45, 1.0, sunShadow(vWorld, 2.0));
  vec3 rb = bow(th, pAmt, sAmt) * uBowGain * (uSunColor * 0.32) * sunVis * (0.75 + 0.5 * lit) * uBowOn;
  col = applyFog(col, vWorld);
  float body = kind > 4.5 ? 0.45 : 1.0;      // the bow veil is barely-there spray
  // the bow is light scattered toward the eye: it reads strongly even in thin spray
  gl_FragColor = vec4(col * a * body + rb * pow(a, 0.45), a * body);
}`;

// ------------------------------------------------------------------ helpers
function polyInfo(pts) {
  const S = [0];
  for (let i = 1; i < pts.length; i++) S.push(S[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = S[S.length - 1];
  const at = s => {
    s = Math.max(0, Math.min(total, s));
    let i = 0; while (i < pts.length - 2 && S[i + 1] < s) i++;
    const u = (s - S[i]) / Math.max(S[i + 1] - S[i], 1e-6);
    return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * u, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * u];
  };
  return { S, total, at };
}

function ribbon(stations, nLat, makeVertex) {
  // stations: array of arrays (consecutive runs). makeVertex(st, j) -> {p:[x,y,z], cs:[..4], tan:[..2]}
  const pos = [], cs = [], tan = [], idx = [];
  for (const run of stations) {
    if (run.length < 2) continue;
    const base = pos.length / 3;
    for (const st of run) for (let j = 0; j < nLat; j++) {
      const v = makeVertex(st, j);
      pos.push(...v.p); cs.push(...v.cs); tan.push(...v.tan);
    }
    for (let i = 0; i < run.length - 1; i++) for (let j = 0; j < nLat - 1; j++) {
      const a = base + i * nLat + j, b = a + 1, c = a + nLat, d = c + 1;
      idx.push(a, b, c, b, d, c);   // counter-clockwise seen from above (lateral = left normal)
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aCS', new THREE.Float32BufferAttribute(cs, 4));
  g.setAttribute('aTan', new THREE.Float32BufferAttribute(tan, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

// ------------------------------------------------------------------ module
export async function create(ctx) {
  const { data, engine, W, H, q, TIMES } = ctx;
  const T = TIMES;
  const tune = WATER_TUNE;
  const leadKeys = tune.iceLead(T);
  const runKeys = tune.crackRun(T);
  // falls event clock (all from TIMES.cut5): crack flash -> burst -> water pours
  const shatterT = T.cut5 + tune.shatterDelay;
  const burstT = shatterT + tune.burstDelay;
  const waterT = shatterT + tune.waterDelay;

  // ---------------------------------------------------------------- debug camera (look-dev only)
  // ?wcam=creek:1;h:0.5;lat:0.7;yaw:6  -> proposed FPV creek-follow (see report)
  // ?wcam=side:22  -> falls rig rotated around the basin by 'side' degrees (rainbow placement test)
  // ?wsun=az:88    -> override the sun azimuth (degrees) during the falls shot
  const wcam = q?.get?.('wcam'), wsun = q?.get?.('wsun');
  const parseKV = s => Object.fromEntries((s || '').split(';').filter(Boolean).map(kv => { const [k, v] = kv.split(':'); return [k, +v]; }));
  const camOv = parseKV(wcam), sunOv = parseKV(wsun);

  // ---------- height sampler identical to the rendered terrain (main grid + falls patch)
  const P = data.PATCH, PD = data.patchTex?.image?.data;
  const hasPatch = !!(P && PD);
  let pMinX = 0, pMinZ = 0, pStep = 1, hole = [1e9, 1e9, -1e9, -1e9];
  if (hasPatch) {
    pMinX = P.cx - P.size / 2; pMinZ = P.cz - P.size / 2; pStep = P.size / (P.n - 1);
    const inset = pStep * 2.5;
    hole = [pMinX + inset, pMinZ + inset, pMinX + P.size - inset, pMinZ + P.size - inset];
  }
  const hAt = (x, z) => {
    if (hasPatch && x > hole[0] && x < hole[2] && z > hole[1] && z < hole[3]) {
      const fi = (x - pMinX) / pStep, fj = (z - pMinZ) / pStep;
      const i = Math.min(P.n - 2, Math.floor(fi)), j = Math.min(P.n - 2, Math.floor(fj)), u = fi - i, v = fj - j, N = P.n;
      const h00 = PD[j * N + i], h10 = PD[j * N + i + 1], h01 = PD[(j + 1) * N + i], h11 = PD[(j + 1) * N + i + 1];
      return u > v ? h00 + (h10 - h00) * u + (h11 - h10) * v : h00 + (h11 - h01) * u + (h01 - h00) * v;
    }
    return data.heightAt(x, z);
  };

  const SK = Math.sinh(L.GRID.k);
  const common = {
    tHeight: { value: data.heightTex },
    uGrid: { value: new THREE.Vector4(L.GRID.cx, L.GRID.cz, L.GRID.Lx, L.GRID.Lz) },
    uGridK: { value: new THREE.Vector3(L.GRID.k, 1 / SK, L.GRID.N - 1) },
    tPatch: { value: hasPatch ? data.patchTex : data.heightTex },
    uPatch: { value: new THREE.Vector4(pMinX, pMinZ, hasPatch ? P.size : 1, hasPatch ? P.n - 1 : 1) },
    uPatchHole: { value: new THREE.Vector4(...hole) },
    uHasPatch: { value: hasPatch ? 1 : 0 },
    uSpringGain: { value: tune.springGain },
    uShatterT: { value: shatterT },
  };
  const uVeinK = { value: 0 };
  const surfU = { uHairLead: { value: 0 }, uRippleK: { value: tune.rippleK }, uVeinK, uFoamT: { value: 1e4 } };

  const objects = [], overlay = [];

  // ================================================================= creeks
  // low rig camera samples (fpv / macro pull-back) so the water never ends up above the lens
  const camPath = [];
  if (ctx.rig) for (let tt = T.pullStart; tt < T.cut3; tt += 0.02) {
    const c = ctx.rig.at(tt);
    if (Math.hypot(c.pos.x, c.pos.z) > 60) camPath.push([c.pos.x, c.pos.y, c.pos.z]);
  }
  let heroCreek = null;
  const creekRuns = [];
  L.CREEKS.forEach((poly, k) => {
    const pts = poly.slice().reverse();         // inner end -> petal tip
    const pi = polyInfo(pts);
    const sts = [];
    for (let s = 0; s <= pi.total; s += s < 320 ? 1.0 : (s < 640 ? 3.0 : 6.0)) sts.push(s);
    const raw = sts.map(s => {
      const p = pi.at(s), pa = pi.at(s - 2.0), pb = pi.at(s + 2.0);
      let tx = pb[0] - pa[0], tz = pb[1] - pa[1]; const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
      const nx = -tz, nz = tx;
      const r = Math.hypot(p[0], p[1]);
      const far = smoothstep(200, 360, r);
      const hc = hAt(p[0], p[1]);
      let hm = hc; for (const o of [-1.6, -0.8, 0.8, 1.6]) hm = Math.max(hm, hAt(p[0] + nx * o, p[1] + nz * o));
      const lvl = lerp(hc + 0.5, Math.max(hc + 0.5, hm + 0.2), far);
      // midveins taper from the heart toward the petal tip
      let hw = lerp(4.4, (2.4 + 0.3 * Math.sin(s * 0.05 + k)) * lerp(1.0, 0.4, smoothstep(250, pi.total, s)), far);
      hw *= smoothstep(0, 9, s) * (1 - smoothstep(pi.total - 60, pi.total, s));
      const ldC = L.lakeDist(p[0], p[1]), rdC = L.riverDist(p[0], p[1]).d;
      const blocked = ldC < 20 || rdC < 30;
      // far shots only (aTaper, mixed by uFarK in SURF_VERT): side creeks taper to a point at the blocked zone
      const taper = k !== 0 ? smoothstep(30, 45, rdC) * smoothstep(20, 35, ldC) : 1;
      return { s, p, tx, tz, nx, nz, lvl, hw: Math.max(hw, 0.05), hc, far, blocked, taper };
    });
    // smooth the level along the creek, never below the bed + margin
    const lv = raw.map(o => o.lvl);
    raw.forEach((o, i) => {
      let a = 0, n = 0; for (let j = Math.max(0, i - 3); j <= Math.min(raw.length - 1, i + 3); j++) { a += lv[j]; n++; }
      o.lvl = Math.max(a / n, o.hc + lerp(0.38, 0.3, o.far));
      o.k = k;
    });
    // safety: keep the water at least 0.3 m under any rig camera that skims the creek
    if (camPath.length && !camOv.creek) for (const o of raw) {
      if (o.far > 0.5) continue;
      for (const cp of camPath) {
        if (Math.abs(cp[0] - o.p[0]) > 5 || Math.abs(cp[2] - o.p[1]) > 5) continue;
        if (Math.hypot(cp[0] - o.p[0], cp[2] - o.p[1]) < o.hw + 1.0) o.lvl = Math.min(o.lvl, Math.max(cp[1] - 0.3, o.hc + 0.06));
      }
    }
    if (k === 0) heroCreek = raw;
    let run = [];
    for (const o of raw) { if (o.blocked) { if (run.length) creekRuns.push(run); run = []; } else run.push(o); }
    if (run.length) creekRuns.push(run);
  });
  const LAT5 = [-1, -0.5, 0, 0.5, 1];
  const creekGeo = ribbon(creekRuns, 5, (o, j) => {
    const u = LAT5[j] * o.hw;
    return { p: [o.p[0] + o.nx * u, o.lvl, o.p[1] + o.nz * u], cs: [o.s, u, o.hw, o.k], tan: [o.tx, o.tz] };
  });
  {
    // same vertex order as ribbon(): runs of >= 2 stations, 5 lateral vertices each
    const tp = [];
    for (const run of creekRuns) { if (run.length < 2) continue; for (const o of run) for (let j = 0; j < 5; j++) tp.push(o.taper); }
    creekGeo.setAttribute('aTaper', new THREE.Float32BufferAttribute(tp, 1));
  }
  const uIceLead = { value: 0 };
  const creekMat = worldMaterial({
    vertexShader: SURF_VERT, fragmentShader: SURF_FRAG, defines: { CREEK: 1 },
    uniforms: { ...common, ...surfU, uIceLead, uSpringRefl: { value: 1.0 }, uLakeT0: { value: 0 }, uLake: { value: new THREE.Vector4() }, uLakeRot: { value: 0 }, uChain: { value: new THREE.Vector4() }, uFallsBase: { value: new THREE.Vector3() } },
  }).material;
  const uHairLead = creekMat.uniforms.uHairLead;
  const creeks = new THREE.Mesh(creekGeo, creekMat);
  creeks.name = 'water.creeks';
  objects.push(creeks);
  if (q?.get?.('wdbg') === 'nocreek') creeks.visible = false;   // look-dev only

  // ================================================================= falls profile (from the rendered terrain)
  const PHI = L.WATERFALL.phi, AX = [Math.cos(PHI), Math.sin(PHI)], LX = [-Math.sin(PHI), Math.cos(PHI)];
  const wpt = (r, lat) => [AX[0] * r + LX[0] * lat, AX[1] * r + LX[1] * lat];
  const R0 = L.WATERFALL.r - 40, R1 = L.WATERFALL.r + 90, DR = 0.5;
  const profCache = new Map();
  function profile(lat) {
    const keyL = Math.round(lat * 2) / 2;
    if (profCache.has(keyL)) return profCache.get(keyL);
    const rs = [], hs = [];
    for (let r = R0; r <= R1; r += DR) { const [x, z] = wpt(r, keyL); rs.push(r); hs.push(hAt(x, z)); }
    // lip: outermost steep sample, scanning inward from the hanging valley
    let iLip = hs.length - 2;
    for (let i = hs.length - 2; i > 0; i--) { if ((hs[i + 1] - hs[i]) / DR > 1.6) { iLip = i + 1; break; } }
    // base: lowest point in front of the cliff
    let iBase = 0; for (let i = 0; i < iLip; i++) if (hs[i] < hs[iBase] + 0.01) iBase = i;
    // cumulative max inward of the lip -> monotone face r(y)
    const cm = hs.slice(); for (let i = 1; i <= iLip; i++) cm[i] = Math.max(cm[i], cm[i - 1]);
    const faceR = y => {
      for (let i = iBase; i < iLip; i++) if (cm[i + 1] >= y) { const f = (y - cm[i]) / Math.max(cm[i + 1] - cm[i], 1e-4); return rs[i] + clamp01(f) * DR; }
      return rs[iLip];
    };
    const pr = { lipR: rs[iLip], lipY: hs[iLip], baseR: rs[iBase], baseY: hs[iBase], faceR };
    profCache.set(keyL, pr);
    return pr;
  }
  const pc0 = profile(0);
  const lipY = pc0.lipY, baseY = Math.min(pc0.baseY, profile(-8).baseY, profile(8).baseY);
  const drop = lipY - baseY;
  const G = tune.sheetG;
  const tauEnd = Math.sqrt(2 * (drop + 2) / G);
  // launch speed: smallest that keeps the sheet >= 2.5 m off the face over its whole fall
  const SHEET_COLS = 29, SHEET_ROWS = 96;
  const hwAt = tau => tune.sheetHW[0] + tune.sheetHW[1] * tau;
  let v0 = 3;
  for (; v0 < 25; v0 += 0.25) {
    let ok = true;
    for (const xl of [-1, -0.5, 0, 0.5, 1]) {
      for (let i = 1; i <= 40 && ok; i++) {
        const tau = tauEnd * i / 40, lat = xl * hwAt(tau), pr = profile(lat);
        const y = pr.lipY + 0.3 - 0.5 * G * tau * tau; if (y < baseY + 4) break;
        const dropped = pr.lipY - y; if (dropped < 3) continue;
        const r = pr.lipR + 0.6 - v0 * tau - 1.4 * (1 - xl * xl);
        if (r > pr.faceR(y) - Math.min(2.5, 0.3 * dropped)) ok = false;
      }
    }
    if (ok) break;
  }
  const sheetPos = [], sheetSh = [], sheetIdx = [];
  for (let i = 0; i <= SHEET_ROWS; i++) {
    const f = i / SHEET_ROWS, tau = tauEnd * f * f * 0.35 + tauEnd * f * 0.65;
    for (let j = 0; j < SHEET_COLS; j++) {
      const xl = j / (SHEET_COLS - 1) * 2 - 1;
      const hw = hwAt(tau), lat = xl * hw, pr = profile(lat);
      const y = pr.lipY + 0.3 - 0.5 * G * tau * tau;
      const r = pr.lipR + 0.6 - v0 * tau - 1.4 * (1 - xl * xl);
      const [x, z] = wpt(r, lat);
      sheetPos.push(x, y, z); sheetSh.push(lat, tau, hw, xl);
    }
  }
  for (let i = 0; i < SHEET_ROWS; i++) for (let j = 0; j < SHEET_COLS - 1; j++) {
    const a = i * SHEET_COLS + j, b = a + 1, c = a + SHEET_COLS, d = c + 1;
    sheetIdx.push(a, c, b, b, c, d);
  }
  const sheetGeo = new THREE.BufferGeometry();
  sheetGeo.setAttribute('position', new THREE.Float32BufferAttribute(sheetPos, 3));
  sheetGeo.setAttribute('aSh', new THREE.Float32BufferAttribute(sheetSh, 4));
  sheetGeo.setIndex(sheetIdx); sheetGeo.computeVertexNormals(); sheetGeo.computeBoundingSphere();
  const sheetMat = worldMaterial({
    vertexShader: SHEET_VERT, fragmentShader: SHEET_FRAG,
    uniforms: { ...common, uTauEnd: { value: tauEnd }, uWaterT: { value: waterT }, uFrontV: { value: tune.frontV } },
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  }).material;
  const sheet = new THREE.Mesh(sheetGeo, sheetMat);
  sheet.name = 'water.fallsSheet';
  sheet.renderOrder = 2;
  objects.push(sheet);
  const baseTau = tauEnd;
  const baseR = pc0.lipR + 0.6 - v0 * baseTau;
  const fallsBase = new THREE.Vector3(...(() => { const [x, z] = wpt(Math.min(baseR, pc0.baseR) - 4, 0); return [x, baseY, z]; })());

  // ================================================================= ice column (hero chunks + lip icicle fringe)
  const outV = [-AX[0], 0, -AX[1]];
  const colW = y => { const f = clamp01((y - baseY) / drop); return lerp(96, 50, Math.pow(f, 0.6)) * tune.curtainScale * (1 + 0.10 * Math.sin(y * 0.19) + 0.07 * Math.sin(y * 0.53 + 1.0)); };
  {
    const rnd = rng(9172);
    const ROWS = 11, COLS = 7, S = 6;   // 77 hero chunks (~20 m), each a bulging slab with side walls
    const yTop = lipY + 1.2, yBot = baseY - 2;
    // jittered lattice in (xl in -1..1, y)
    const lat = [];
    for (let r = 0; r <= ROWS; r++) {
      const row = [];
      for (let c = 0; c <= COLS; c++) {
        const fy = r / ROWS, fx = c / COLS;
        const jy = (r > 0 && r < ROWS) ? (rnd() - 0.5) * 0.7 / ROWS : 0;
        const jx = (c > 0 && c < COLS) ? (rnd() - 0.5) * 0.7 / COLS : 0;
        row.push([fx * 2 - 1 + jx * 2, lerp(yTop, yBot, fy + jy)]);
      }
      lat.push(row);
    }
    // broad bulbous frozen columns with horizontal growth ribs (no fine vertical 'flow streaks')
    const flute = (latM, y) => 0.5 + 0.5 * Math.sin(latM * 0.42 + Math.sin(y * 0.031) * 1.4) * (0.6 + 0.4 * Math.sin(latM * 0.19 + 1.2));
    const thick = (latM, y, xl) => {
      const cone = Math.pow(1 - clamp01((y - baseY) / 70), 1.6) * (1 - xl * xl) * 14;
      const top = smoothstep(lipY - 30, lipY, y) * 2.0;
      const rib = Math.sin(y * 0.42 + latM * 0.25 + Math.sin(latM * 0.11) * 2.0) * (0.6 + 0.6 * flute(latM, y));
      const bulge = (L.fbm(latM * 0.06 + 7.3, y * 0.028 + 1.1, 3) - 0.45) * 8.0;
      return Math.max(0.8, 1.6 + 3.4 * flute(latM, y) + rib + cone + top + 2.2 * (1 - xl * xl) + bulge);
    };
    const pos3 = (xl, y, back) => {
      const w = colW(y), latM = xl * w * 0.5, pr = profile(latM);
      const yy = Math.min(y, pr.lipY + 1.0);
      const rf = y > pr.lipY ? pr.lipR + 1.5 : pr.faceR(yy);
      const r = back ? rf + 0.8 : rf - thick(latM, y, xl);
      const [x, z] = wpt(r, latM);
      return [x, y, z, latM];
    };
    const P3 = [], PIV = [], SEED = [], VEL = [], SPIN = [], ICE = [], IDX = [];
    let vcount = 0;
    const pushPiece = (verts, fIdx, piv, seed, vel, spin) => {
      for (const vx of verts) { P3.push(...vx.p); ICE.push(...vx.ice); PIV.push(...piv); SEED.push(...seed); VEL.push(...vel); SPIN.push(...spin); }
      for (const i of fIdx) IDX.push(vcount + i);
      vcount += verts.length;
    };
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      const A = lat[r][c], B = lat[r][c + 1], C = lat[r + 1][c + 1], D = lat[r + 1][c];
      const bil = (u, v) => [lerp(lerp(A[0], B[0], u), lerp(D[0], C[0], u), v), lerp(lerp(A[1], B[1], u), lerp(D[1], C[1], u), v)];
      const ctr = bil(0.5, 0.5);
      const pivF = pos3(ctr[0], ctr[1], false), pivB = pos3(ctr[0], ctr[1], true);
      const piv = [(pivF[0] + pivB[0]) / 2, ctr[1], (pivF[2] + pivB[2]) / 2];
      const yF = clamp01((lipY - ctr[1]) / drop);
      // release: top first (0 .. ~0.1 s after the burst)
      const seed = [0.075 * yF + 0.035 * Math.abs(ctr[0]) + 0.03 * rnd(), rnd(), rnd(), rnd()];
      // burst outward (toward the basin), fanning sideways, tumbling
      const yMid = baseY + drop * 0.45, ry = (ctr[1] - yMid) / (drop * 0.5), rl = ctr[0] * 1.3 + (rnd() - 0.5) * 0.5;
      const rn = Math.hypot(rl, ry) || 1, spR = lerp(120, 260, rnd()), spO = lerp(20, 60, rnd());
      const lv = rl / rn * spR, vv = ry / rn * spR * 0.8 + lerp(5, 25, rnd());
      const vel = [outV[0] * spO + LX[0] * lv, vv, outV[2] * spO + LX[1] * lv, 0];
      const spin = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, lerp(2.0, 6.5, rnd())];
      const verts = [], fIdx = [];
      for (let v = 0; v <= S; v++) for (let u = 0; u <= S; u++) {
        const [xl, y] = bil(u / S, v / S);
        const p = pos3(xl, y, false);
        const ed = Math.min(u, S - u, v, S - v) / S * 2; // 0 at the piece border
        verts.push({ p: [p[0], p[1], p[2]], ice: [ed, p[3], y, xl] });
      }
      for (let v = 0; v < S; v++) for (let u = 0; u < S; u++) {
        const a = v * (S + 1) + u, b = a + 1, c2 = a + (S + 1), d = c2 + 1;
        fIdx.push(a, c2, b, b, c2, d);
      }
      // side walls (front + back copy of the border loop) and a back cap
      const loop = [];
      for (let u = 0; u < S; u++) loop.push([u, 0]);
      for (let v = 0; v < S; v++) loop.push([S, v]);
      for (let u = S; u > 0; u--) loop.push([u, S]);
      for (let v = S; v > 0; v--) loop.push([0, v]);
      const sideStart = verts.length;
      for (const [u, v] of loop) {
        const [xl, y] = bil(u / S, v / S);
        const pf = pos3(xl, y, false), pb = pos3(xl, y, true);
        verts.push({ p: [pf[0], pf[1], pf[2]], ice: [0.6, pf[3], y, xl] });
        verts.push({ p: [pb[0], pb[1], pb[2]], ice: [0.6, pb[3], y, xl] });
      }
      const nL = loop.length;
      for (let i = 0; i < nL; i++) {
        const a = sideStart + i * 2, b = sideStart + ((i + 1) % nL) * 2;
        fIdx.push(a, a + 1, b, b, a + 1, b + 1);
      }
      const bc = verts.length;
      verts.push({ p: pivB.slice(0, 3), ice: [1, pivB[3], ctr[1], ctr[0]] });
      for (let i = 0; i < nL; i++) {
        const a = sideStart + i * 2 + 1, b = sideStart + ((i + 1) % nL) * 2 + 1;
        fIdx.push(bc, b, a);
      }
      pushPiece(verts, fIdx, piv, seed, vel, spin);
    }
    // icicle fringe hanging off the lip on both sides of the column (they drop with the burst)
    const halfTop = colW(lipY) * 0.5, NS = 7;
    for (const side of [-1, 1]) {
      let off = 1.5 + rnd() * 2;
      while (off < 58) {
        const latM = side * (halfTop + off);
        const pr = profile(latM);
        const fall = 1 - off / 62;
        const len = lerp(5, 24, Math.pow(rnd(), 0.8)) * (0.45 + 0.55 * fall);
        const rad = len * lerp(0.07, 0.12, rnd()) + 0.4;
        const yR = pr.lipY + 0.4, yT = yR - len;
        const rAx = Math.min(pr.faceR(Math.max(yT, baseY + 1)) - rad - 0.4, pr.lipR - rad * 0.6);
        const [ax, az] = wpt(rAx, latM);
        const piv = [ax, yR - len * 0.4, az];
        const ring = (y, rr) => { const o = []; for (let i = 0; i < NS; i++) { const a = i / NS * Math.PI * 2; o.push([ax + Math.cos(a) * rr, y, az + Math.sin(a) * rr]); } return o; };
        const verts = [];
        const yM = yR - len * 0.45;
        for (const p of ring(yR, rad)) verts.push({ p, ice: [1, latM, yR, side * 1.4] });
        for (const p of ring(yM, rad * 0.62)) verts.push({ p, ice: [1, latM, yM, side * 1.4] });
        verts.push({ p: [ax, yT, az], ice: [1, latM, yT, side * 1.4] });
        const fIdx = [];
        for (let i = 0; i < NS; i++) {
          const a = i, b = (i + 1) % NS;
          fIdx.push(a, b, NS + a, b, NS + b, NS + a);
          fIdx.push(NS + a, NS + b, 2 * NS);
        }
        const seed = [-0.03 + 0.12 * rnd() + 0.02 * off / 58, 0.9 + 0.8 * rnd(), rnd(), rnd()];
        const sp = lerp(2, 9, rnd());
        const vel = [outV[0] * sp + LX[0] * side * lerp(0, 4, rnd()), lerp(-2, 3, rnd()), outV[2] * sp + LX[1] * side * lerp(0, 4, rnd()), 0];
        const spin = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, lerp(0.8, 3.0, rnd())];
        pushPiece(verts, fIdx, piv, seed, vel, spin);
        off += lerp(1.6, 4.2, rnd()) + rad;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P3, 3));
    g.setAttribute('aPiv', new THREE.Float32BufferAttribute(PIV, 3));
    g.setAttribute('aSeed', new THREE.Float32BufferAttribute(SEED, 4));
    g.setAttribute('aVel', new THREE.Float32BufferAttribute(VEL, 4));
    g.setAttribute('aSpin', new THREE.Float32BufferAttribute(SPIN, 4));
    g.setAttribute('aIce', new THREE.Float32BufferAttribute(ICE, 4));
    g.setIndex(IDX);
    g.computeVertexNormals();
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(fallsBase.x, (lipY + baseY) / 2, fallsBase.z), drop * 0.5 + 300);
    var curtainGeo = g;
  }
  const iceM = worldMaterial({
    vertexShader: ICE_VERT, fragmentShader: ICE_FRAG, side: THREE.DoubleSide,
    uniforms: { ...common, uLipY: { value: lipY }, uBaseY: { value: baseY }, uBurstT: { value: burstT }, uCrackDur: { value: tune.crackDur }, uOutDir: { value: new THREE.Vector3(...outV) } },
  });
  const curtain = new THREE.Mesh(curtainGeo, iceM.material);
  curtain.name = 'water.iceCurtain';
  castShadow(curtain, iceM.depthMaterial);
  objects.push(curtain);

  // ================================================================= lake
  const lakeU = { uLake: { value: new THREE.Vector4(L.LAKE.x, L.LAKE.z, L.LAKE.rx, L.LAKE.rz) }, uLakeRot: { value: L.LAKE.rot } };
  {
    const NR = 34, NA = 128, margin = 14 / Math.min(L.LAKE.rx, L.LAKE.rz);
    const c = Math.cos(L.LAKE.rot), s = Math.sin(L.LAKE.rot);
    const pos = [], cs = [], tan = [], idx = [];
    for (let i = 0; i <= NR; i++) for (let a = 0; a < NA; a++) {
      const th = a / NA * Math.PI * 2;
      const wob = 1 + 0.09 * Math.sin(th * 3 + 1.3) + 0.05 * Math.sin(th * 5 + 0.2);
      const rho = Math.pow(i / NR, 0.8) * (wob + margin);
      const lx = Math.cos(th) * rho * L.LAKE.rx, lz = Math.sin(th) * rho * L.LAKE.rz;
      const x = L.LAKE.x + lx * c - lz * s, z = L.LAKE.z + lx * s + lz * c;
      pos.push(x, L.LAKE_Y + 0.18, z); cs.push(lx, lz, rho, 0); tan.push(1, 0);
    }
    for (let i = 0; i < NR; i++) for (let a = 0; a < NA; a++) {
      const a0 = i * NA + a, a1 = i * NA + (a + 1) % NA, b0 = a0 + NA, b1 = a1 + NA;
      idx.push(a0, b0, a1, a1, b0, b1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aCS', new THREE.Float32BufferAttribute(cs, 4));
    g.setAttribute('aTan', new THREE.Float32BufferAttribute(tan, 2));
    g.setIndex(idx); g.computeBoundingSphere();
    var lakeGeo = g;
  }
  const lakeMat = worldMaterial({
    vertexShader: SURF_VERT, fragmentShader: SURF_FRAG, defines: { LAKE: 1 }, side: THREE.DoubleSide,
    uniforms: { ...common, ...surfU, ...lakeU, uIceLead: { value: 0 }, uSpringRefl: { value: 0.7 }, uLakeT0: { value: T.cut4 + tune.lakeDelay }, uChain: { value: new THREE.Vector4() }, uFallsBase: { value: new THREE.Vector3() } },
  }).material;
  const lake = new THREE.Mesh(lakeGeo, lakeMat);
  lake.name = 'water.lake';
  objects.push(lake);

  // ================================================================= river
  const riv = polyInfo(L.RIVER);
  let sIn = null, sOut = null;
  const rivRuns = [];
  {
    let run = [];
    for (let s = 0; s <= riv.total; s += 4) {
      const p = riv.at(s), pa = riv.at(s - 6), pb = riv.at(s + 6);
      let tx = pb[0] - pa[0], tz = pb[1] - pa[1]; const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
      const r = Math.hypot(p[0], p[1]);
      const dw = Math.abs(L.wrapAngle(Math.atan2(p[1], p[0]) - PHI));
      const above = dw < 0.3 && r > L.WATERFALL.r - 9;
      const ld = L.lakeDist(p[0], p[1]);
      if (ld < 0) { if (sIn === null) sIn = s; sOut = s; }
      const tt = s / riv.total;
      const rw = 14 + 6 * Math.sin(tt * 40);
      let lvl = L.riverWaterY(tt) + 0.3;
      lvl = lerp(lvl, L.LAKE_Y + 0.3, smoothstep(40, 6, ld));
      const st = { s, p, tx, tz, nx: -tz, nz: tx, lvl, hw: rw + 5, t: tt };
      if (above || ld < -30) { if (run.length) rivRuns.push(run); run = []; } else run.push(st);
    }
    if (run.length) rivRuns.push(run);
  }
  const riverGeo = ribbon(rivRuns, 5, (o, j) => {
    const u = LAT5[j] * o.hw;
    return { p: [o.p[0] + o.nx * u, o.lvl, o.p[1] + o.nz * u], cs: [o.s, u, o.hw, o.t], tan: [o.tx, o.tz] };
  });
  const riverMat = worldMaterial({
    vertexShader: SURF_VERT, fragmentShader: SURF_FRAG, defines: { RIVER: 1 }, side: THREE.DoubleSide,
    uniforms: { ...common, ...surfU, ...lakeU, uIceLead: { value: 0 }, uSpringRefl: { value: 0.7 }, uLakeT0: { value: 0 },
      uChain: { value: new THREE.Vector4(T.cut4 + tune.chainDelay, tune.chainV, sIn ?? 1500, sOut ?? 1700) }, uFallsBase: { value: fallsBase } },
  }).material;
  // plunge-pool foam once the freed water front reaches the base
  surfU.uFoamT.value = waterT + tauEnd / tune.frontV - 0.25;
  // the river is only visible in the far shots (uFarK = 1): its banks fade out (SURF_FRAG alpha).
  // Drawn first among the transparents and still writing depth, so the opaque-era order is kept.
  riverMat.transparent = true;
  const river = new THREE.Mesh(riverGeo, riverMat);
  river.name = 'water.river';
  river.renderOrder = -5;
  objects.push(river);

  // ================================================================= mist plume + shatter burst + rainbow (overlay)
  const outDir = new THREE.Vector3(-AX[0], 0, -AX[1]);   // away from the cliff, toward the basin
  const sideDir = new THREE.Vector3(LX[0], 0, LX[1]);
  // The bows are framed on the plume from the falls camera: a 42-deg bow is far wider than the
  // telephoto frame, so the anti-solar centre is virtual (just below the plume base) and the
  // radius is a fraction of the shot's horizontal fov; the physical band profile is kept.
  const DEGR = Math.PI / 180;
  let camP = new THREE.Vector3(fallsBase.x * 0.48, baseY + 70, fallsBase.z * 0.48), vfov = 34;
  if (ctx.rig) { const c = ctx.rig.at(Math.min(T.rainbow + 1.5, T.cut6 - 0.1)); camP = c.pos.clone(); vfov = c.fov; }
  const hfov = 2 * Math.atan(Math.tan(vfov * DEGR / 2) * W / H) / DEGR;
  const bowR = Math.min(42, Math.max(4, tune.bowFrac * hfov));
  const bowAnchor = fallsBase.clone().addScaledVector(outDir, 30);
  const bowCFrom = (eye, out) => {
    const aim = out.copy(bowAnchor).sub(eye).normalize();
    const rt = new THREE.Vector3().crossVectors(aim, new THREE.Vector3(0, 1, 0)).normalize();
    return aim.applyAxisAngle(rt, tune.bowLift * bowR * DEGR);
  };
  const bowD = bowAnchor.distanceTo(camP);
  const bowC = bowCFrom(camP, new THREE.Vector3());
  const mistUniforms = {
    ...common,
    tDepth: { value: engine.sceneRT.depthTexture },
    uRes: { value: new THREE.Vector2(W, H) },
    uNearFar: { value: new THREE.Vector2(1, 60000) },
    uRainbowT: { value: T.rainbow }, uBurstT: { value: burstT },
    uBowGain: { value: tune.bowGain }, uBowC: { value: bowC }, uBowR: { value: bowR }, uBowOn: { value: 1 },
    uBase: { value: fallsBase.clone().add(new THREE.Vector3(0, 6, 0)) },
    uOut: { value: outDir }, uSide: { value: sideDir }, uHalfW: { value: hwAt(tauEnd) },
    uColW: { value: new THREE.Vector2(colW(baseY), colW(lipY)) },
    uPlumeScale: { value: tune.plumeScale }, uLipY: { value: lipY }, uFaceSlope: { value: Math.max(0.05, (pc0.lipR - pc0.faceR(baseY + 25)) / Math.max(drop - 25, 1)) },
  };
  {
    const M = tune.mist, rnd = rng(4411);
    const kinds = [];
    [M.billow, M.haze, M.veil, M.dust, M.shard, M.bow].forEach((n, k) => { for (let i = 0; i < n; i++) kinds.push(k); });
    const N = kinds.length;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('aQ', new THREE.Float32BufferAttribute([-1, -1, 1, -1, 1, 1, -1, 1], 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const s1 = new Float32Array(N * 4), s2 = new Float32Array(N * 4), sp = new Float32Array(N * 4);
    // bow veil: sprites laid along both arcs (psi -100..100 deg from the top)
    const upP = new THREE.Vector3(0, 1, 0).addScaledVector(bowC, -bowC.y).normalize();
    const rtP = new THREE.Vector3().crossVectors(bowC, upP).normalize();
    let bi = 0;
    for (let i = 0; i < N; i++) {
      s1.set([rnd(), rnd(), rnd(), rnd()], i * 4);
      s2.set([rnd(), rnd(), rnd(), kinds[i]], i * 4);
      if (kinds[i] === 5) {
        const row = bi % 2, j = Math.floor(bi / 2), nJ = Math.ceil(M.bow / 2);
        const psi = lerp(-100, 100, (j + 0.5 * row) / Math.max(nJ - 1, 1)) * DEGR;
        const rho = bowR * (row ? 1.22 : 0.99) * DEGR;
        const dir = bowC.clone().multiplyScalar(Math.cos(rho)).addScaledVector(upP, Math.sin(rho) * Math.cos(psi)).addScaledVector(rtP, Math.sin(rho) * Math.sin(psi));
        const p = camP.clone().addScaledVector(dir, bowD * 0.95);
        sp.set([p.x, p.y, p.z, 2 * Math.tan(0.24 * bowR * DEGR) * bowD * 1.15], i * 4);
        bi++;
      }
    }
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(s1, 4));
    g.setAttribute('aSeed2', new THREE.InstancedBufferAttribute(s2, 4));
    g.setAttribute('aPos', new THREE.InstancedBufferAttribute(sp, 4));
    g.instanceCount = N;
    var mistGeo = g;
  }
  const mistMat = worldMaterial({
    vertexShader: MIST_VERT, fragmentShader: MIST_FRAG, uniforms: mistUniforms,
    transparent: true, depthTest: false, depthWrite: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  }).material;
  const mist = new THREE.Mesh(mistGeo, mistMat);
  mist.frustumCulled = false; mist.name = 'water.mist';
  overlay.push(mist);

  // ?wdbg=sky -> show the analytic summer sky as the sky dome (look-dev of the creek reflection)
  if (q?.get?.('wdbg') === 'sky') {
    const dm = worldMaterial({
      vertexShader: `varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * viewMatrix * vec4(cameraPosition + position * 40000.0, 1.0); }`,
      fragmentShader: `${WATER_GLSL}\nvarying vec3 vDir; void main(){ gl_FragColor = vec4(springSky(normalize(vDir)), 1.0); }`,
      uniforms: { ...common }, side: THREE.BackSide, depthWrite: false,
    }).material;
    const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 48), dm);
    dome.frustumCulled = false; dome.renderOrder = -9;
    objects.push(dome);
  }

  // hero creek lookup (arclength s from the inner end; s < 0 extrapolates back along the axis)
  const creekAt = s => {
    const st = heroCreek; const n = st.length;
    if (s <= 0) { const o = st[0]; return { x: o.p[0] + o.tx * s, z: o.p[1] + o.tz * s, tx: o.tx, tz: o.tz, nx: o.nx, nz: o.nz, lvl: o.lvl }; }
    let lo = 0, hi = n - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (st[m].s <= s) lo = m; else hi = m; }
    const a = st[lo], b = st[hi], f = clamp01((s - a.s) / Math.max(b.s - a.s, 1e-6));
    return { x: lerp(a.p[0], b.p[0], f), z: lerp(a.p[1], b.p[1], f), tx: lerp(a.tx, b.tx, f), tz: lerp(a.tz, b.tz, f), nx: lerp(a.nx, b.nx, f), nz: lerp(a.nz, b.nz, f), lvl: lerp(a.lvl, b.lvl, f) };
  };
  const r0Creek = Math.hypot(heroCreek[0].p[0], heroCreek[0].p[1]);
  // the crack tip's arrival value over the creek beat: lens arclength along the hero creek (from the rig,
  // precomputed so update() never re-evaluates the shared rig output) + crackRun metres ahead
  const sCamTab = [], TAB0 = T.creek - 0.7, TABDT = 0.01;
  if (ctx.rig) for (let tt = TAB0; tt <= T.cut3 + 0.2; tt += TABDT) { const cp = ctx.rig.at(tt).pos; sCamTab.push(Math.hypot(cp.x, cp.z) - r0Creek); }
  const sCamAt = tt => { if (!sCamTab.length) return 0; const f = clamp01((tt - TAB0) / TABDT / (sCamTab.length - 1)) * (sCamTab.length - 1), i = Math.min(sCamTab.length - 2, Math.floor(f)); return lerp(sCamTab[i], sCamTab[i + 1], f - i); };
  const leadAt = tt => { const tip = creekAt(sCamAt(tt) + key(runKeys, tt)); return data.arrivalAt(tip.x, tip.z); };
  const leadEnd = Math.max(0, leadAt(T.cut3) - ctx.bloomD(T.cut3));
  const dbgLead = q?.get?.('wdbg') === 'lead';

  const info = { v0, lipY, baseY, drop, tauEnd, sIn, sOut, creekVerts: creekGeo.attributes.position.count };
  console.log('[water]', JSON.stringify(info));

  return {
    objects, overlay, info,
    update(t, c) {
      const shot = c.shot.id;
      // crack lead: solved from the lens position during the FPV creek beat (the opening tip rides
      // crackRun metres ahead of the lens; the white hairline runs hairLeadS seconds ahead of it)
      {
        const lk = key(leadKeys, t);
        const w0 = shot === 'fpv' ? smoothstep(T.creek - 0.6, T.creek - 0.2, t) : 0;
        if (w0 > 0) {
          const lead = Math.max(-3, leadAt(t) - c.U.uBloomD.value);
          const hairArr = leadAt(t + tune.hairLeadS) - c.U.uBloomD.value;
          uIceLead.value = Math.max(lk, lerp(lk, lead, w0));
          uHairLead.value = Math.max(2.0, lerp(3.0, hairArr - uIceLead.value, w0));
        } else {
          uIceLead.value = t >= T.cut3 ? Math.max(lk, leadEnd * (1 - smoothstep(T.cut3, T.cut4, t))) : lk;
          uHairLead.value = 3.0;
        }
      }
      if (dbgLead && shot === 'fpv' && !(c.sub?.sub)) console.log('[water lead]', t.toFixed(2), 'sCam', sCamAt(t).toFixed(1), 'run', key(runKeys, t).toFixed(1), 'lead', uIceLead.value.toFixed(1), 'hair', uHairLead.value.toFixed(1), 'D', c.U.uBloomD.value.toFixed(1));
      uVeinK.value = (shot === 'macro' || shot === 'fpv') ? 0 : 1;
      mistUniforms.uBowOn.value = shot === 'falls' ? 1 : 0;
      if (shot === 'falls') bowCFrom(c.camera.position, bowC);
      const wide = shot === 'reveal' || shot === 'falls' || shot === 'aerial';
      lake.visible = wide; river.visible = wide;
      curtain.visible = (shot === 'reveal' || shot === 'falls');
      sheet.visible = (shot === 'falls' || shot === 'aerial') && t > T.cut5 - 0.01;
      mist.visible = sheet.visible;
      // proposed FPV creek-follow (mirrors the timeline snippet in the report): the rig keeps its
      // timing (radius along the lobe), the lens is pulled onto the hero creek 0.5 m above the water
      if (shot === 'fpv' && camOv.creek) {
        const w = smoothstep(9.3, 9.8, t) * (1 - smoothstep(11.75, 12.25, t));
        if (w > 0) {
          const cam = c.camera, rc = c.cam;
          const sC = Math.hypot(rc.pos.x, rc.pos.z) - r0Creek + (camOv.ds || 0);
          const a = creekAt(sC), lat = camOv.lat ?? 0.7;
          const px = a.x + a.nx * lat, pz = a.z + a.nz * lat;
          const py = Math.max(data.heightAt(px, pz) + 0.3, a.lvl + (camOv.h ?? 0.5));
          const pos = new THREE.Vector3(lerp(rc.pos.x, px, w), lerp(rc.pos.y, py, w), lerp(rc.pos.z, pz, w));
          const b = creekAt(sC + 10);
          const yaw = (camOv.yaw ?? 6) * Math.PI / 180;
          let dx = b.x - px, dz = b.z - pz; const dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
          const ddx = dx * Math.cos(yaw) - dz * Math.sin(yaw), ddz = dx * Math.sin(yaw) + dz * Math.cos(yaw);
          const pitch = (camOv.pitch ?? -6) * Math.PI / 180;
          const tgtC = new THREE.Vector3(pos.x + ddx * 10, pos.y + Math.tan(pitch) * 10, pos.z + ddz * 10);
          const rigDir = rc.target.clone().sub(rc.pos).normalize();
          const tgt = pos.clone().add(rigDir.multiplyScalar(10).lerp(tgtC.clone().sub(pos), w));
          cam.position.copy(pos); cam.up.set(0, 1, 0); cam.lookAt(tgt); cam.rotateZ((rc.roll || 0) * (1 - w * 0.6));
          cam.updateMatrixWorld(true);
        }
      }
      if (shot === 'falls' && (camOv.side !== undefined || camOv.dist !== undefined)) {
        const wr = L.WATERFALL.r, s = clamp01((t - T.cut5) / (T.cut6 - T.cut5));
        const side = (camOv.side || 0) * Math.PI / 180;
        const camR = wr - (camOv.dist ?? lerp(660, 640, s));
        const cam = c.camera;
        const px = Math.cos(PHI + side) * camR, pz = Math.sin(PHI + side) * camR;
        cam.position.set(px, data.heightAt(px, pz) + (camOv.h ?? 46), pz);
        const tg = new THREE.Vector3(Math.cos(PHI) * (wr - 6), hAt(Math.cos(PHI) * (wr - 30), Math.sin(PHI) * (wr - 30)) + lerp(70, 78, s) + (camOv.ty || 0), Math.sin(PHI) * (wr - 6));
        cam.up.set(0, 1, 0); cam.lookAt(tg);
        if (camOv.fov) cam.fov = camOv.fov;
        cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
      }
      if (shot === 'falls' && (sunOv.az !== undefined || sunOv.el !== undefined)) {
        const sd = c.U.uSunDir.value;
        const el = sunOv.el !== undefined ? sunOv.el * Math.PI / 180 : Math.asin(sd.y);
        const a = sunOv.az !== undefined ? sunOv.az * Math.PI / 180 : Math.atan2(sd.z, sd.x);
        sd.set(Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el));
      }
      mistUniforms.uNearFar.value.set(c.camera.near, c.camera.far);
    },
  };
}
