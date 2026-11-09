// Sky, overcast deck, dawn slot, sun, painterly cumulus, cloud shadows, god rays.
//
//  - Sky dome (drawn after the opaques at the far plane, depth-tested, so only
//    sky pixels shade): fog-consistent base gradient + a perspective-correct
//    overcast deck (2.5D thickness field on a plane at uDeck.x) that tears open
//    around the sun at TIMES.sunBreak and dissolves into remnant patches during
//    the reveal; a dawn slot under the deck's edge on the ESE horizon; sun disc.
//  - Macro backdrop: a cyclorama inside the rim (macro shot only) that paints
//    the same sky, so the dawn slot sits on a low snowfield horizon (the real
//    rim mountains rise to ~26 deg there and would hide the sunrise).
//  - Cumulus: instanced, noise-displaced sphere puffs generated hierarchically
//    (envelope-shaped bodies -> lobes -> cauliflower detail), real depth in the
//    main scene, stylised lighting (per-body ellipsoid self shadow, crisp
//    terminator, lavender shadow side, silver lining when backlit), growth.
//  - Cloud shadows: per frame a coverage map (deck field + low-layer puff
//    footprints projected along the sun) -> U.tCloudCov / uCloudShadow.
//  - God rays: overlay quad; in its onBeforeRender a quarter-res sky-light mask
//    is built from the scene depth and radially blurred toward the sun.
//
// Debug query params (look-dev only): skycam=x,y,z,tx,ty,tz,fov  skynodof=1  skyraydbg=1
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { U, worldMaterial, rng } from './common.js';
import { TIMES, sunAt, envAt } from './timeline.js';
import { key, smoothstep, clamp01, lerp, easeInOut } from './keys.js';

const DEG = Math.PI / 180;
const LC = hex => new THREE.Color(hex); // linear working colour from sRGB hex
const LA = hex => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };

// ------------------------------------------------------------------ shared sky uniforms
const SU = {
  uDeck: { value: new THREE.Vector4(2600, -1, 1.4, 0.3) },       // alt, thrGlobal, thrInsideTear, mottling
  uTear: { value: new THREE.Vector4(0, 1, 0, 0) },               // centre dir xyz, angular radius
  uTearFx: { value: new THREE.Vector4(1, 0.8, 0.05, 0) },        // edge glow, edge noise (rad), softness (rad), -
  uSlot: { value: new THREE.Vector4(0, 4 * DEG, 38 * DEG, 0) },  // strength, top elev, az half width, -
  uSlotDir: { value: new THREE.Vector2(1, 0) },
  uDeckDrift: { value: new THREE.Vector2() },
  uDeckZen: { value: new THREE.Color() }, uDeckHor: { value: new THREE.Color() },
  uDeckLit: { value: 0 },                                        // 0 overcast underside .. 1 sunlit remnant patches
  uClrZen: { value: LC('#2E7BD6') }, uClrHor: { value: LC('#9CCBF0') },  // saturated summer gradient
  uDawn: { value: 1 },
  uSunDisc: { value: new THREE.Vector4(Math.cos(0.55 * DEG), 40, 0, 0) }, // cos radius, intensity, glow, -
  uPixAng: { value: 0.001 },
  uSkyGlow: { value: 1 },
  uSkyK: { value: new THREE.Vector4(0, 0, 1, 0) },               // -, warm horizon light, deck gradient reach (sin elev), -
};

export const SKY_GLSL = /* glsl */`
uniform vec4 uDeck; uniform vec4 uTear; uniform vec4 uTearFx; uniform vec4 uSlot; uniform vec2 uSlotDir;
uniform vec2 uDeckDrift; uniform vec3 uDeckZen; uniform vec3 uDeckHor; uniform float uDeckLit;
uniform vec3 uClrZen; uniform vec3 uClrHor; uniform float uDawn; uniform vec4 uSunDisc; uniform float uPixAng; uniform float uSkyGlow;
uniform vec4 uSkyK;

float sat(float x) { return clamp(x, 0.0, 1.0); }
// band-limited fbm: octaves finer than the footprint fade to their mean (no shimmer at grazing angles)
float fbmL(vec2 p, float fp) {
  float a = 0.5, s = 0.0, f = 1.0; mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 5; i++) {
    float att = 1.0 - smoothstep(0.2, 0.6, fp * f);
    s += a * mix(0.5, vnoise(p), att);
    p = r * p * 2.03 + 17.1; f *= 2.03; a *= 0.5;
  }
  return s;
}
// thickness field of the cloud deck, p in metres on the deck plane
float deckField(vec2 p, float fp) {
  vec2 q = (p + uDeckDrift) * 0.00026; float f = fp * 0.00026;
  vec2 w = vec2(fbmL(q * 0.55 + vec2(3.1, 1.7), f * 0.55), fbmL(q * 0.55 + vec2(8.3, 4.2), f * 0.55)) - 0.48;
  return fbmL(q + w * 1.5, f);
}
// coverage of the deck at deck point p seen along view dir d. x cov, y field, z tear-edge band
vec3 deckCover(vec2 p, vec3 d, float fp) {
  float n = deckField(p, fp);
  float nd = fbmL((p + uDeckDrift) * 0.0021 + 5.3, fp * 0.0021);
  float ang = acos(clamp(dot(d, uTear.xyz), -1.0, 1.0));
  float e = ang + (n - 0.48) * uTearFx.y + (nd - 0.48) * uTearFx.y * 0.22;
  float outT = smoothstep(uTear.w - uTearFx.z, uTear.w + uTearFx.z, e);
  float thr = mix(uDeck.z, uDeck.y, outT);
  float sw = 0.055 + 0.10 * smoothstep(0.25, 0.04, d.y) * uDeckLit;
  float nn = n + (nd - 0.48) * 0.12;
  float cov = smoothstep(thr - sw, thr + sw, nn);
  // thin-edge measure (1 at a torn edge, decaying into thicker cloud): drives the soft silver lining
  float band = exp(-max(nn - thr, 0.0) / 0.13) * step(0.0005, uTear.w) * cov;
  return vec3(cov, n, band);
}

vec3 clearSky(vec3 d) {
  float h = sat(d.y);
  vec3 c = mix(uClrHor, uClrZen, pow(h, 0.5));
  c = mix(c, uClrHor * 1.05, exp(-h * 30.0) * 0.45);
  float sd = max(dot(d, uSunDir), 0.0);
  c += uSunColor * (0.010 * pow(sd, 3.0) + (0.035 * pow(sd, 24.0) + 0.3 * pow(sd, 260.0)) * uSkyGlow);
  // warm horizon light (summer / aerial): a low golden band, strongest toward the sun's azimuth
  vec2 hz = normalize(d.xz + vec2(1e-6)); float saz = dot(hz, normalize(uSunDir.xz + vec2(1e-6)));
  c += vec3(1.0, 0.70, 0.40) * uSkyK.y * exp(-h * 16.0) * (0.3 + 0.7 * (saz * 0.5 + 0.5));
  return c;
}
// the dawn sky that shows through the slot under the deck's edge: a thin warm sunrise sliver
vec3 dawnSky(vec3 d, float daz) {
  float u = sat((asin(clamp(d.y, -1.0, 1.0)) - uSlot.w) / max(uSlot.y - uSlot.w, 1e-3));
  vec3 warm = vec3(1.0, 0.539, 0.195);          // #FFC27A
  vec3 pale = vec3(1.0, 0.80, 0.60);
  vec3 c = mix(warm * 1.45, pale * 0.85, smoothstep(0.2, 1.0, u));
  c *= 0.18 + 0.82 * exp(-pow(daz / (uSlot.z * 0.75), 2.0));
  return c * uSlot.x;
}

// full sky radiance along d seen from cp
vec3 skyColor(vec3 cp, vec3 d) {
  vec3 base = skyGradient(d);
  float dy = max(d.y, 0.0);
  float th = (uDeck.x - cp.y) / max(dy, 0.012);
  vec2 p = cp.xz + d.xz * th;
  float fp = th * uPixAng / max(dy, 0.06);
  vec3 dk = deckCover(p, d, fp);
  float hf = smoothstep(-0.005, 0.11, d.y);          // deck fades into the horizon haze
  float sd = max(dot(d, uSunDir), 0.0);

  // ---- what is behind the deck
  vec2 hz = normalize(d.xz + vec2(1e-6));
  float daz = acos(clamp(dot(hz, uSlotDir), -1.0, 1.0));
  vec3 behind = mix(clearSky(d), dawnSky(d, daz) + base * 0.35, uDawn);
  float disc = smoothstep(uSunDisc.x - 0.00003, uSunDisc.x + 0.00002, dot(d, uSunDir));
  behind += uSunColor * (disc * uSunDisc.y + (pow(sd, 2500.0) * 0.9 + pow(sd, 350.0) * 0.22) * uSunDisc.z);

  // ---- deck underside
  float h = sat(d.y);
  vec3 deck = mix(uDeckHor, uDeckZen, pow(smoothstep(0.0, uSkyK.z, h), 0.8));
  float thick = dk.y - 0.48;
  deck *= 1.0 - thick * uDeck.w * 2.2;
  // sun below the deck: warm wash on the underside toward the sun, soft disc through thin parts
  float thin = 1.0 - smoothstep(0.38, 0.62, dk.y);
  vec3 sunW = uSunColor * vec3(0.92, 1.0, 1.05);
  deck += sunW * (0.02 * pow(sd, 3.0) + 0.05 * pow(sd, 14.0)) * (0.6 + 0.8 * thin) * (1.0 - uDeckLit);
  deck += sunW * (smoothstep(0.9985, 0.99996, sd) * 0.35 + pow(sd, 400.0) * 0.25) * (0.3 + thin) * (1.0 - uDeckLit);
  // remnant patches lit by the sun once the overcast breaks (2.5D: thin edges lit, thick cores lavender)
  float edgeLit = 1.0 - smoothstep(0.0, 0.2, dk.y - max(uDeck.y, 0.0));
  vec3 litPatch = mix(vec3(0.50, 0.52, 0.80), vec3(1.0, 0.97, 0.92) * 1.35, 0.3 + 0.7 * edgeLit);
  litPatch *= 0.6 + 0.4 * sat(uSunColor.r / 4.5);
  deck = mix(deck, litPatch, uDeckLit);
  // soft silver lining: thin cloud near the torn edge glows, falling off into the thicker deck
  deck += uSunColor * vec3(1.0, 0.95, 0.86) * dk.z * uTearFx.x * (0.025 + 0.30 * pow(sd, 6.0)) * (0.4 + thin);
  deck = mix(base, deck, hf);

  // ---- dawn slot: deck edge lifted off the horizon around the sun azimuth
  float slot = 0.0;
  if (uSlot.x > 0.0) {
    float el = asin(clamp(d.y, -1.0, 1.0));
    float az = atan(d.z, d.x);
    float rag = (vnoise(vec2(az * 26.0, 3.0)) - 0.5) * 0.012 + (vnoise(vec2(az * 90.0, 7.0)) - 0.5) * 0.004;
    float top = uSlot.y * exp(-pow(daz / uSlot.z, 2.0)) + rag;
    slot = (1.0 - smoothstep(top - 0.003, top + 0.002, el)) * step(0.0, top);
    // underside of the deck just above the slot glows gold
    float above = exp(-max(el - top, 0.0) / 0.03) * exp(-pow(daz / (uSlot.z * 1.1), 2.0));
    deck += vec3(1.0, 0.82, 0.46) * above * uSlot.x * 0.38;
  }
  float cov = dk.x * (1.0 - slot);
  vec3 col = mix(behind, deck, cov);
  // below the horizon the dome is the haze colour (seamless with the terrain's aerial perspective)
  vec3 fd = normalize(vec3(d.x, 0.03, d.z));
  vec3 fogc = skyGradient(fd) * uFogTint + uSunColor * 0.18 * pow(max(dot(fd, uSunDir), 0.0), 5.0);
  return mix(col, fogc, smoothstep(0.004, -0.03, d.y));
}

// light that the sky contributes to god rays along d (glow near the sun x openness)
float skyRayLight(vec3 cp, vec3 d) {
  float sd = max(dot(d, uSunDir), 0.0);
  float glow = 0.30 * pow(sd, 10.0) + 0.5 * pow(sd, 60.0) + 2.5 * pow(sd, 700.0) + uSkyK.w * (0.4 + 0.6 * pow(sd, 3.0));
  float dy = max(d.y, 0.0);
  float th = (uDeck.x - cp.y) / max(dy, 0.012);
  vec2 p = cp.xz + d.xz * th;
  vec3 dk = deckCover(p, d, 300.0);
  float hf = smoothstep(-0.005, 0.11, d.y);
  // thin parts of the deck leak light: broken cloud near the sun makes the shafts
  float open = 1.0 - dk.x * mix(1.0 - 0.45 * sat(uTearFx.x), 1.0, smoothstep(0.36, 0.6, dk.y));
  if (uSlot.x > 0.0) {
    float el = asin(clamp(d.y, -1.0, 1.0));
    vec2 hz = normalize(d.xz + vec2(1e-6));
    float daz = acos(clamp(dot(hz, uSlotDir), -1.0, 1.0));
    float top = uSlot.y * exp(-pow(daz / uSlot.z, 2.0));
    open = max(open, (1.0 - smoothstep(top - 0.004, top + 0.003, el)) * sat(uSlot.x));
  }
  return glow * open;
}
`;

// ------------------------------------------------------------------ dome + backdrop shaders
const DOME_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;
const DOME_FRAG = /* glsl */`
${SKY_GLSL}
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  gl_FragColor = vec4(skyColor(cameraPosition, d), 1.0);
}`;
const BACKDROP_VERT = /* glsl */`
varying vec3 vWorld;
void main() {
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}`;
const BACKDROP_FRAG = /* glsl */`
${SKY_GLSL}
varying vec3 vWorld;
void main() {
  vec3 d = normalize(vWorld - cameraPosition);
  gl_FragColor = vec4(skyColor(cameraPosition, d), 1.0);
}`;

// ------------------------------------------------------------------ cumulus puffs
const NC = 48; // max clouds per group
const PUFF_COMMON = /* glsl */`
attribute vec4 aPR;   // puff centre (relative to cloud origin) + radius
attribute vec4 aCI;   // cloud index, growth order, seed, ao
attribute vec4 aEc;   // body ellipsoid centre (rel. cloud origin), body top y
attribute vec4 aEr;   // body ellipsoid radii, -
uniform vec4 uCO[${NC}];   // cloud origin xyz (animated, y = flat base), growth 0..1+
uniform vec4 uCS[${NC}];   // x shadow weight, y scale, z dissolve (0 solid .. 1.4 gone), w 1 / cloud half width
uniform float uBoil;
float puffDisp(vec3 n, float sd) { return (vnoise3(n * 1.7 + sd) - 0.5) * 0.30 + (vnoise3(n * 4.3 + sd * 1.3) - 0.5) * 0.10; }
float puffScale(out float g) {
  int ci = int(aCI.x + 0.5);
  float gw = uCO[ci].w;
  g = clamp((gw * 1.35 - aCI.y) / 0.35, 0.0, 1.0);
  float gm = g - 1.0;
  return g >= 1.0 ? 1.0 : max(0.0, 1.0 + 2.7 * gm * gm * gm + 1.7 * gm * gm);  // ease-out-back
}
vec3 puffWorld(vec3 n, float s, out float baseY) {
  int ci = int(aCI.x + 0.5);
  vec4 co = uCO[ci];
  float boil = 1.0 + uBoil * 0.03 * sin(uTime * 0.9 + aCI.z * 6.283);
  float r = aPR.w * s * boil * uCS[ci].y;
  vec3 c = co.xyz + aPR.xyz * uCS[ci].y;
  baseY = co.y;
  r *= step(baseY - 0.5 * aPR.w, c.y + r);          // never draw puffs that are entirely below the base
  return c + n * r * (1.0 + puffDisp(n, aCI.z * 37.0));
}
`;
const PUFF_VERT = /* glsl */`
${PUFF_COMMON}
varying vec3 vWorld; varying vec3 vNp; varying vec3 vEc; varying vec3 vEr; varying vec3 vInfo; varying vec2 vPx;
varying vec4 vLoc;
void main() {
  float g; float s = puffScale(g);
  vec3 n = normalize(position);
  float baseY;
  vec3 wp = puffWorld(n, s, baseY);
  {
    int cj = int(aCI.x + 0.5);
    // cloud-local erosion coordinates (move with the cloud, scale with its size), dissolve amount
    vLoc = vec4((wp - uCO[cj].xyz) * uCS[cj].w / max(uCS[cj].y, 0.05) + vec3(aCI.x * 7.31, 0.0, aCI.x * 3.17), uCS[cj].z);
  }
  // displaced normal from two tangent neighbours
  vec3 t1 = normalize(cross(n, abs(n.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 t2 = cross(n, t1);
  float sd = aCI.z * 37.0;
  vec3 n1 = normalize(n + t1 * 0.05), n2 = normalize(n + t2 * 0.05);
  vec3 p0 = n * (1.0 + puffDisp(n, sd)), p1 = n1 * (1.0 + puffDisp(n1, sd)), p2 = n2 * (1.0 + puffDisp(n2, sd));
  vec3 nd = normalize(cross(p1 - p0, p2 - p0));
  nd = dot(nd, n) < 0.0 ? -nd : nd;
  // flat base
  float fl = smoothstep(baseY + aPR.w * 0.06, baseY - aPR.w * 0.02, wp.y);
  wp.y = max(wp.y, baseY);
  int ci = int(aCI.x + 0.5);
  float sc = uCS[ci].y;
  vEc = uCO[ci].xyz + aEc.xyz * sc; vEr = aEr.xyz * sc;
  vInfo = vec3(baseY, uCO[ci].y + aEc.w * sc, aCI.w);
  vNp = normalize(mix(nd, vec3(0.0, -1.0, 0.0), fl));
  // small puffs follow the cloud-scale normal more (big masses light as one), concave dips get crevice shade
  float rel = aPR.w / max(max(aEr.x, aEr.z), 1.0);
  vPx = vec2(mix(0.78, 0.38, smoothstep(0.06, 0.3, rel)), smoothstep(-0.16, 0.08, puffDisp(n, sd)));
  vWorld = wp;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const PUFF_FRAG = /* glsl */`
${SKY_GLSL}
uniform vec3 uCuLit; uniform vec3 uCuShade; uniform vec3 uCuBase; uniform vec4 uCuK; uniform vec4 uCuK2; uniform float uCuDbg; uniform float uCuHideAll;
uniform vec4 uCuEro;   // x erosion strength, y erosion noise freq (per cloud half width), z vertical squash (flat wisps), w haze per metre
uniform vec4 uCuK3;    // x lit intensity, y warm sun tint, z max haze, w -
uniform float uRimBody; // 0: silver lining per puff; 1: only on the body's outer silhouette (canopy gSE)
varying vec3 vWorld; varying vec3 vNp; varying vec3 vEc; varying vec3 vEr; varying vec3 vInfo; varying vec2 vPx;
varying vec4 vLoc;
void main() {
  vec3 wp = vWorld;
  vec3 V = normalize(cameraPosition - wp);
  vec3 L = uSunDir;
  vec3 q = (wp - vEc) / vEr;
  vec3 Nc = normalize(q / vEr);
  vec3 Np = normalize(vNp);
  // ---- eroded, wispy silhouette: stochastic coverage that the subframe accumulation resolves into soft fringes
  // projected radial position (0 at the centre of the disc a sphere covers on screen, 1 at its outline),
  // per puff and for the whole body: only puff outlines on the body's silhouette erode deeply
  float NV = abs(dot(Np, V)), NVc = abs(dot(Nc, V));
  float sP = sqrt(max(1.0 - NV * NV, 0.0));
  float sB = sqrt(max(1.0 - NVc * NVc, 0.0)) * smoothstep(0.45, 0.95, length(q));
  float rim = smoothstep(0.3, 1.0, sP) * (0.22 + 0.78 * smoothstep(0.25, 0.85, sB));
  vec3 lp = vLoc.xyz * vec3(1.0, uCuEro.z, 1.0) * uCuEro.y + vec3(uTime * 0.02, 0.0, uTime * 0.012);
  float en = vnoise3(lp) * 0.55 + vnoise3(lp * 2.31 + 4.1) * 0.30 + vnoise3(lp * 5.13 + 9.7) * 0.15;
  float dis = vLoc.w;
  float dens = 1.0 - rim * 1.15 - (en - 0.4) * uCuEro.x * (0.3 + 1.2 * rim) - dis * (0.7 + en * 0.8);
  float cov = smoothstep(0.0, 0.3, dens);
  float ign = fract(52.9829189 * fract(dot(floor(gl_FragCoord.xy), vec2(0.06711056, 0.00583715))));
  if (cov <= fract(ign + uFrame * 0.6180339)) discard;
  float fringe = 1.0 - smoothstep(0.05, 0.6, dens);

  vec3 N = normalize(mix(Np, Nc, vPx.x * uCuK2.w / 0.3));
  // body self shadow: chord through the body ellipsoid toward the sun
  vec3 dq = L / vEr;
  float a = dot(dq, dq), b = dot(q, dq), c = dot(q, q) - 1.0;
  float disc = b * b - a * c, od = 0.0;
  if (disc > 0.0) { float sq = sqrt(disc); od = max((-b + sq) / a, 0.0) - max((-b - sq) / a, 0.0); }
  float rAvg = (vEr.x + vEr.y + vEr.z) / 3.0;
  float selfSh = exp(-od / (rAvg * uCuK.w));
  float ndl = dot(N, L);
  float diff = sat((ndl + 0.3) / 1.3);
  float lit = smoothstep(uCuK2.x, uCuK2.y, diff * selfSh);
  // height gradient: darker, cooler bases
  float hg = smoothstep(vInfo.x, mix(vInfo.x, vInfo.y, 0.55), wp.y);
  float ao = mix(vInfo.z, 0.5 + 0.5 * vInfo.z, uRimBody) * mix(0.78, 1.0, smoothstep(-0.7, 0.4, mix(Np.y, N.y, uRimBody))) * mix(0.82, 1.0, vPx.y);
  vec3 shade = mix(uCuBase, uCuShade, hg) * uCuK.x * ao;
  shade *= 0.8 + 0.3 * sat(N.y * 0.5 + 0.5);                       // sky fill from above
  shade += uSkyZenith * 0.10 * sat(N.y) * uCuK.x;
  float sunI = max(uSunColor.r, 1e-3);
  vec3 tint = mix(vec3(1.0), uSunColor / sunI, uCuK3.y);
  vec3 litC = uCuLit * tint * sunI * uCuK3.x * mix(0.9, 1.0, ao) * (0.8 + 0.2 * diff);
  vec3 col = mix(shade, litC, lit);
  // warm terminator band
  col += vec3(1.0, 0.76, 0.46) * sunI * uCuK2.z * exp(-pow((lit - 0.42) / 0.16, 2.0)) * sat(selfSh * 1.5);
  // silver lining / backlit translucency, strongest on the thin eroded fringe
  vec3 Nf = uRimBody > 0.0 ? normalize(mix(N, Nc, uRimBody)) : N;
  float fres = pow(1.0 - sat(dot(Nf, V)), 4.0) * mix(1.0, smoothstep(0.7, 1.0, length(q)), uRimBody);
  float back = pow(sat(dot(-V, L)), 4.0);
  float notBase = smoothstep(-0.97, -0.55, mix(Np.y, Nc.y, uRimBody));
  float fringeRim = fringe * mix(1.0, smoothstep(0.6, 0.95, sB), uRimBody);
  col += uSunColor * vec3(1.0, 0.95, 0.85) * (fres * back * uCuK.y * notBase * 0.6 + back * 0.10 * (1.0 - lit) * hg + back * fringeRim * uCuK.y * 0.22);
  // thin fringes are translucent: they take on some of the sky light
  col = mix(col, col * 0.7 + uSkyAmbient * 0.45, fringeRim * 0.4 * (1.0 - back));
  vec3 fogged = applyFog(col, wp);
  col = mix(col, fogged, uCuK.z);
  vec3 dv = wp - cameraPosition; float dist = length(dv); vec3 dd = dv / dist;
  // aerial perspective: distant clouds sink into the horizon sky
  vec3 hd = normalize(vec3(dd.x, max(dd.y, 0.0) * 0.6 + 0.015, dd.z));
  vec3 farC = mix(skyGradient(hd), clearSky(hd), 1.0 - uDawn);
  col = mix(col, farC, (1.0 - exp(-dist * uCuEro.w)) * uCuK3.z);
  // parts of the cloud beyond the overcast plane are hidden by the deck where it still covers
  if (dd.y > 0.0 && cameraPosition.y < uDeck.x && uDeck.y < 1.2) {
    float th = (uDeck.x - cameraPosition.y) / dd.y;
    // canopy: test the body centre's distance, not each puff's, so the deck cut does not trace puff outlines
    float behind = max(smoothstep(th * 0.92, th * 1.05, mix(dist, length(vEc - cameraPosition), uRimBody)), uCuHideAll);
    if (behind > 0.0) {
      vec2 pp = cameraPosition.xz + dd.xz * th;
      vec3 dk = deckCover(pp, dd, th * uPixAng / max(dd.y, 0.06));
      float hide = dk.x * behind;
      if (hide > 0.002) col = mix(col, skyColor(cameraPosition, dd), hide);
    }
  }
  if (uCuDbg > 0.5) col = vec3(lit, selfSh, hg);
  gl_FragColor = vec4(col, 1.0);
}`;
const FOOT_VERT = /* glsl */`
${PUFF_COMMON}
varying float vW;
void main() {
  float g; float s = puffScale(g);
  vec3 n = normalize(position);
  float baseY;
  vec3 wp = puffWorld(n, s, baseY);
  wp.y = max(wp.y, baseY);
  vec2 p = wp.xz + uSunDir.xz / max(uSunDir.y, 0.08) * (uCloudAlt - wp.y);
  vec2 uv = p * uCloudShadow.x + uCloudShadow.yz;
  vec4 cs = uCS[int(aCI.x + 0.5)];
  vW = cs.x * (1.0 - smoothstep(0.15, 1.0, cs.z));
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}`;
const FOOT_FRAG = /* glsl */`varying float vW; void main() { gl_FragColor = vec4(vW); }`;

// ------------------------------------------------------------------ fullscreen passes
const FS_VERT = /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const COV_FRAG = /* glsl */`
${SKY_GLSL}
uniform vec3 uCovCam; uniform float uCovTexel;
varying vec2 vUv;
void main() {
  vec2 p = (vUv - uCloudShadow.yz) / uCloudShadow.x;
  vec3 d = normalize(vec3(p.x, uDeck.x, p.y) - uCovCam);
  vec3 dk = deckCover(p, d, uCovTexel * 2.0);
  gl_FragColor = vec4(dk.x, 0.0, 0.0, 1.0);
}`;
const BLUR_FRAG = /* glsl */`
uniform sampler2D tSrc; uniform vec2 uDir; uniform vec2 uRemap; varying vec2 vUv;
void main() {
  float w[5]; w[0] = 0.227; w[1] = 0.1945; w[2] = 0.1216; w[3] = 0.054; w[4] = 0.0162;
  float s = texture2D(tSrc, vUv).r * w[0];
  for (int i = 1; i < 5; i++) { s += (texture2D(tSrc, vUv + uDir * float(i)).r + texture2D(tSrc, vUv - uDir * float(i)).r) * w[i]; }
  gl_FragColor = vec4(s * uRemap.x + uRemap.y, 0.0, 0.0, 1.0);
}`;
const MASK_FRAG = /* glsl */`
${SKY_GLSL}
uniform sampler2D tDepth; uniform vec2 uFullTexel; uniform mat4 uInvVP; uniform vec3 uCam;
uniform float uNear; uniform float uFar; uniform float uSkyDepth;
varying vec2 vUv;
float linD(float z) { z = z * 2.0 - 1.0; return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear)); }
// true sky lets all the light through; far, hazy terrain and clouds beyond uSkyDepth let some through (shafts reach the meadow)
float skyTap(vec2 uv) { float z = texture2D(tDepth, uv).x; return z >= 0.9999999 ? 1.0 : (linD(z) > uSkyDepth ? 0.5 : 0.0); }
void main() {
  float s = 0.25 * (skyTap(vUv + uFullTexel * vec2(-1.0, -1.0)) + skyTap(vUv + uFullTexel * vec2(1.0, -1.0)) + skyTap(vUv + uFullTexel * vec2(-1.0, 1.0)) + skyTap(vUv + uFullTexel * vec2(1.0, 1.0)));
  float m = 0.0;
  if (s > 0.0) {
    vec4 w = uInvVP * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
    vec3 d = normalize(w.xyz / w.w - uCam);
    m = s * skyRayLight(uCam, d);
  }
  gl_FragColor = vec4(m, 0.0, 0.0, 1.0);
}`;
const RAYS_FRAG = /* glsl */`
uniform sampler2D tMask; uniform vec2 uSunUV; uniform float uLen; uniform float uDecay; uniform float uJit;
varying vec2 vUv;
float h12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
void main() {
  const int NS = 72;
  vec2 dlt = (uSunUV - vUv) * uLen / float(NS);
  vec2 uv = vUv + dlt * h12(gl_FragCoord.xy + uJit);
  float acc = 0.0, w = 1.0;
  for (int i = 0; i < NS; i++) {
    vec2 inb = step(vec2(0.0), uv) * step(uv, vec2(1.0));
    acc += texture2D(tMask, uv).r * w * inb.x * inb.y;
    w *= uDecay; uv += dlt;
  }
  gl_FragColor = vec4(acc / float(NS), 0.0, 0.0, 1.0);
}`;
const RAYCOMP_FRAG = /* glsl */`
uniform sampler2D tRays; uniform vec3 uRayCol; uniform float uRayAmt; uniform vec2 uSunUV; uniform float uAspect; uniform vec2 uStripe;
varying vec2 vUv;
float h11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
// periodic value noise over N cells per turn (no seam behind the sun)
float pn(float x, float N) { float i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(h11(mod(i, N)), h11(mod(i + 1.0, N)), f); }
void main() {
  float r = texture2D(tRays, vUv).r;
  // a fan of distinct shafts around the sun (works with the sun off screen): angular stripes, slowly sweeping
  vec2 dv = (vUv - uSunUV) * vec2(uAspect, 1.0);
  float u = atan(dv.y, dv.x) / 6.2831853 + 0.5;
  float st = pn(u * 64.0 + uStripe.y, 64.0) * 0.6 + pn(u * 160.0 + uStripe.y * 1.7 + 7.0, 160.0) * 0.4;
  st = smoothstep(0.32, 0.78, st);
  float k = mix(1.0, 0.2 + 1.6 * st, uStripe.x);
  gl_FragColor = vec4(uRayCol * r * uRayAmt * k, 0.0);
}`;

// ------------------------------------------------------------------ cumulus generator (CPU, deterministic)
// o: { kind: 'tower' | 'hum', w (half width), h (height), lean: [lx, lz], extra (# side towers), skirt }
function genCloud(R, o) {
  const P = [];
  const rnd = (a, b) => a + (b - a) * R();
  const add = (x, y, z, r, lvl, b) => { const p = { x, y, z, r, lvl, b }; P.push(p); return p; };
  const bodies = [];
  if (o.kind === 'tower') {
    bodies.push({ x: 0, z: 0, w: o.w, h: o.h, lean: o.lean || [0, 0], prof: 'tower' });
    const nx = o.extra ?? (1 + Math.floor(R() * 2.5));
    for (let i = 0; i < nx; i++) {
      const a = R() * 6.283, d = o.w * rnd(0.8, 1.35);
      bodies.push({ x: Math.cos(a) * d, z: Math.sin(a) * d, w: o.w * rnd(0.45, 0.72), h: o.h * rnd(0.3, 0.66), lean: [(R() - 0.5) * 0.2, (R() - 0.5) * 0.2], prof: 'tower' });
    }
    if (o.skirt !== false) bodies.push({ x: rnd(-0.2, 0.2) * o.w, z: rnd(-0.2, 0.2) * o.w, w: o.w * rnd(1.45, 1.8), h: o.w * rnd(0.5, 0.7), lean: [0, 0], prof: 'dome' });
  } else {
    bodies.push({ x: 0, z: 0, w: o.w, h: o.h, lean: [0, 0], prof: 'dome' });
    const nx = o.extra ?? (R() < 0.65 ? 1 : 0);
    for (let i = 0; i < nx; i++) { const a = R() * 6.283, d = o.w * rnd(0.6, 1.0); bodies.push({ x: Math.cos(a) * d, z: Math.sin(a) * d * 0.75, w: o.w * rnd(0.5, 0.75), h: o.h * rnd(0.45, 0.8), lean: [0, 0], prof: 'dome' }); }
  }
  for (const b of bodies) {
    const env = b.prof === 'tower'
      ? u => b.w * (1.0 + 0.16 * Math.sin(u * Math.PI)) * (1 - 0.36 * u)
      : u => b.w * (0.32 + 0.72 * Math.sqrt(Math.max(0, 1 - u * u)));
    const ph = R() * 6.283;
    const ax = u => [b.x + b.lean[0] * u * b.h + Math.sin(u * 3.1 + ph) * 0.07 * b.w, b.z + b.lean[1] * u * b.h + Math.cos(u * 2.7 + ph) * 0.07 * b.w];
    // core column (fills the interior)
    const nCore = Math.max(1, Math.round(b.h / (b.w * 0.95)));
    for (let i = 0; i < nCore; i++) {
      const u = (i + 0.5) / nCore * 0.88;
      const [cx, cz] = ax(u);
      add(cx, Math.max(u * b.h, env(u) * 0.3), cz, env(u) * 0.8, 0, b);
    }
    // shell lobes on the envelope
    const nShell = b.prof === 'tower' ? Math.round(12 + 8 * b.h / b.w) : Math.round(24 + 10 * R());
    for (let i = 0; i < nShell; i++) {
      const u = b.prof === 'tower' ? Math.pow(R(), 0.75) * 0.96 : Math.pow(R(), 0.8) * 0.8;
      // lobe sizes skewed small with a few big masses (no rows of identical balls)
      const Re = env(u), rho = Re * (b.prof === 'tower' ? 0.26 + 0.34 * Math.pow(R(), 1.4) : 0.13 + 0.31 * Math.pow(R(), 1.6));
      const a = R() * 6.283, off = Math.max(0, Re - rho * rnd(0.8, 1.0));
      const [cx, cz] = ax(u);
      const y = Math.max(Math.min(u * b.h, b.h - rho * 0.95), rho * 0.3);
      add(cx + Math.cos(a) * off, y, cz + Math.sin(a) * off * (b.prof === 'dome' ? 0.85 : 1), rho, 0, b);
    }
    // crown
    const Rt = env(1.0);
    const nc = 2 + Math.floor(R() * 3);
    const [tx, tz] = ax(1);
    for (let i = 0; i < nc; i++) {
      const a = R() * 6.283, rho = Rt * rnd(0.55, 0.85), off = Rt * rnd(0.0, 0.55);
      add(tx + Math.cos(a) * off, b.h - rho * rnd(0.9, 1.02), tz + Math.sin(a) * off, rho, 0, b);
    }
  }
  // hierarchical cauliflower detail on exposed, upward/outward surfaces
  const exposed = (x, y, z, self) => {
    for (const s of P) { if (s === self) continue; const dx = x - s.x, dy = y - s.y, dz = z - s.z; if (dx * dx + dy * dy + dz * dz < s.r * s.r * 0.86) return false; }
    return true;
  };
  const levels = o.detail ?? 2;
  const spec = [{ tries: 14, keep: 5, rf: [0.28, 0.44], up: 0.45 }, { tries: 9, keep: 3, rf: [0.38, 0.56], up: 0.75 }];
  for (let Lv = 0; Lv < levels; Lv++) {
    const parents = P.filter(s => s.lvl === Lv);
    const sp = spec[Lv];
    for (const s of parents) {
      const b = s.b;
      if (Lv > 0 && s.y < b.h * (b.prof === 'dome' ? 0.12 : 0.3)) continue;
      let kept = 0;
      for (let tI = 0; tI < sp.tries && kept < sp.keep; tI++) {
        const [axx, axz] = [b.x, b.z];
        const ox = s.x - axx, oz = s.z - axz, ol = Math.hypot(ox, oz) || 1;
        let dx = rnd(-1, 1) + ox / ol * 0.55, dy = rnd(-0.45, 1) + sp.up, dz = rnd(-1, 1) + oz / ol * 0.55;
        const dl = Math.hypot(dx, dy, dz); dx /= dl; dy /= dl; dz /= dl;
        const px = s.x + dx * s.r, py = s.y + dy * s.r, pz = s.z + dz * s.r;
        if (py < Math.max(s.r * 0.2, o.w * 0.12)) continue;
        if (!exposed(px, py, pz, s)) continue;
        const rr = s.r * rnd(sp.rf[0], sp.rf[1]);
        add(s.x + dx * s.r * 0.86, s.y + dy * s.r * 0.86, s.z + dz * s.r * 0.86, rr, Lv + 1, b).parent = s;
        kept++;
      }
    }
  }
  // drop puffs fully buried inside another
  const out = P.filter(s => !P.some(o2 => o2 !== s && o2.r > s.r && Math.hypot(s.x - o2.x, s.y - o2.y, s.z - o2.z) + s.r < o2.r * 0.97));
  // per-body ellipsoid hull (self shadow) + per-puff ao + growth order
  let top = 0;
  for (const b of bodies) {
    const ps = out.filter(s => s.b === b);
    let mnx = 1e9, mny = 1e9, mnz = 1e9, mxx = -1e9, mxy = -1e9, mxz = -1e9;
    for (const s of ps) { mnx = Math.min(mnx, s.x - s.r); mxx = Math.max(mxx, s.x + s.r); mny = Math.min(mny, s.y - s.r); mxy = Math.max(mxy, s.y + s.r); mnz = Math.min(mnz, s.z - s.r); mxz = Math.max(mxz, s.z + s.r); }
    mny = Math.max(mny, 0);
    b.ec = [(mnx + mxx) / 2, (mny + mxy) / 2, (mnz + mxz) / 2];
    b.er = [(mxx - mnx) / 2 * 0.9, (mxy - mny) / 2 * 0.95, (mxz - mnz) / 2 * 0.9];
    b.top = mxy; top = Math.max(top, mxy);
  }
  for (const s of out) {
    const b = s.b;
    const qx = (s.x - b.ec[0]) / b.er[0], qy = (s.y - b.ec[1]) / b.er[1], qz = (s.z - b.ec[2]) / b.er[2];
    const qq = Math.hypot(qx, qy, qz) + s.r / Math.min(b.er[0], b.er[1], b.er[2]);
    s.ao = 0.6 + 0.4 * smoothstep(0.35, 1.05, qq);
    s.seed = R();
  }
  // growth order: bodies rise bottom-up; detail always pops after its parent (no floating bubbles)
  const ord = s => s._o ?? (s._o = s.parent ? Math.min(1, ord(s.parent) + 0.05 + R() * 0.12) : clamp01(s.y / Math.max(top, 1)) * 0.7 + R() * 0.2);
  for (const s of out) s.order = ord(s);
  return { puffs: out, top };
}

function icosphere(detail) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute('normal'); g.deleteAttribute('uv');
  return mergeVertices(g, 1e-5);
}

// ------------------------------------------------------------------ cloud layouts
// Angles: dir(phi) = (cos, sin) in x/z, +z south. Heights in metres (basin floor ~0).
const P2 = (r, deg) => [Math.cos(deg * DEG) * r, Math.sin(deg * DEG) * r];
function layoutSE(R) { // backlit congestus over the ESE/SE rim for the sun break (fpv + canopy)
  const L = [];
  const spots = [ // r, az, scale, base
    [8200, -14, 1.15, 1150], [7000, 4, 0.9, 1100], [9000, 17, 1.35, 1250], [7400, 33, 1.05, 1150], [9800, 47, 1.4, 1300],
    [7200, 60, 0.95, 1100], [8600, 74, 1.2, 1200], [10500, 92, 1.3, 1400], [9000, 110, 1.1, 1300], [11500, 128, 1.25, 1500],
  ];
  const vary = [1.0, 0.65, 1.2, 0.8, 1.3, 0.6, 1.1, 1.35, 0.7, 1.15];   // 0.5-2x scale variation
  spots.forEach(([r, a, s, y], i) => {
    const [x, z] = P2(r + (R() - 0.5) * 500, a + (R() - 0.5) * 3);
    const v = vary[i % vary.length];
    L.push({ x, z, y: a >= 85 ? y - 550 : y, w: (1000 + R() * 350) * s * v, h: (1900 + R() * 800) * s * Math.sqrt(v), kind: 'tower', lean: [(R() - 0.5) * 0.14, (R() - 0.5) * 0.14] });
  });
  return L;
}
function layoutNW(R) { // front-lit congestus behind the N/NW rim (reveal, falls, aerial): fewer, varied, blue gaps between
  const L = [];
  const spots = [ // r, az, scale, base
    [9000, 203, 0.8, 1850], [12500, 221, 1.3, 2100], [8000, 240, 0.6, 1800], [14500, 257, 1.5, 2250],
    [10500, 276, 0.9, 2000], [16000, 295, 1.35, 2300], [11000, 314, 0.75, 2050],
  ];
  for (const [r, a, s, y] of spots) {
    const [x, z] = P2(r + (R() - 0.5) * 700, a + (R() - 0.5) * 3);
    L.push({ x, z, y, w: (850 + R() * 300) * s, h: (1800 + R() * 900) * s, kind: 'tower', lean: [(R() - 0.5) * 0.12, (R() - 0.5) * 0.12] });
  }
  return L;
}
// Aerial cloud wipe. Placed from the aerial rig itself so it holds for any framing:
//  layer 0: a thin veil ~300 m under the lens at the cut, burning off as the camera rises;
//  layer 1: fair-weather cumulus over the flower at the cut, dissolving/drifting apart by TIMES.resolve;
//  layer 2: a low framing ring whose clouds appear (from the camera of the hold) outside the petals.
// Offsets of layers 0/1 are in the camera's ground frame (a: screen right, b: away from the camera)
// around the point where the sightline to the flower heart crosses the layer.
function layoutLow(R, cam0, camRef) {
  const L = [];
  const C = cam0.pos;
  const F = new THREE.Vector2(cam0.target.x - C.x, cam0.target.z - C.z).normalize();
  const Rv = [-F.y, F.x], Fv = [F.x, F.y];
  const cross = y => { const k = (C.y - y) / (C.y - 1.2); return [C.x * (1 - k), C.z * (1 - k)]; };
  const add = (S, a, b, y, w, h, layer) => {
    const x = S[0] + Rv[0] * a + Fv[0] * b + (R() - 0.5) * 40, z = S[1] + Rv[1] * a + Fv[1] * b + (R() - 0.5) * 40;
    L.push({ x, z, a, b, y, w, h, layer, kind: 'hum', detail: 2, extra: 1 + Math.floor(R() * 2) });
  };
  const yA = C.y - 300, SA = cross(yA);
  for (const [a, b, s] of [[0, 10, 1.3], [215, 95, 0.8], [-225, 60, 1.0], [95, 265, 0.7], [-125, 285, 0.9], [265, -150, 0.9], [-255, -175, 1.1], [35, -245, 1.4], [390, 225, 0.6], [-410, 215, 0.6]]) {
    const w = 105 * s * (0.85 + R() * 0.3);
    add(SA, a, b, yA + (R() - 0.5) * 40, w, w * (0.4 + R() * 0.2), 0);
  }
  const yB = 700, SB = cross(yB);
  for (const [a, b, s] of [[0, 0, 1.4], [-280, 120, 1.0], [270, 90, 1.15], [-130, -270, 1.2], [190, -240, 0.9], [60, 340, 0.9]]) {
    const w = 110 * s * (0.85 + R() * 0.3);
    add(SB, a, b, yB + (R() - 0.5) * 60, w, w * (0.6 + R() * 0.3), 1);
  }
  // framing ring: [azimuth of the apparent ground point (deg, dir() convention), apparent radius, size]
  const Cr = camRef.pos;
  // grouped, 0.5-2x sizes, bigger toward the near corners; the falls axis (~232 deg) and the river stem stay clear
  const ring = [[150, 1500, 1.8], [172, 1780, 0.8], [70, 1520, 1.6], [48, 1820, 0.65], [86, 1720, 0.9],
    [198, 1700, 1.3], [15, 1650, 1.4], [33, 2050, 0.6], [335, 1780, 1.1]];
  for (const [deg, rr, s] of ring) {
    const y = 470 + R() * 140;
    const px = Math.cos(deg * DEG) * rr, pz = Math.sin(deg * DEG) * rr;
    const k = (Cr.y - y) / Cr.y;
    const w = 110 * s * (0.85 + R() * 0.3);
    L.push({ x: Cr.x + (px - Cr.x) * k, z: Cr.z + (pz - Cr.z) * k, a: 0, b: 0, y, w, h: w * (0.5 + R() * 0.25), layer: 2, kind: 'hum', detail: 2, extra: 1 + Math.floor(R() * 2) });
  }
  L.Rv = Rv; L.Fv = Fv; L.SA = SA; L.SB = SB;
  return L;
}

// ------------------------------------------------------------------ time choreography
function skyState(t) {
  const T = TIMES;
  const s = {};
  s.slot = key([[0, 0.45], [T.firstLight - 0.6, 0.65], [T.firstLight + 0.8, 0.95], [T.hit, 1.05], [T.cut2, 0.9], [T.creek, 0.55], [T.sunBreak - 0.4, 0.25], [T.sunBreak + 0.2, 0.0]], t);
  // a thin sliver just above the ESE saddle (~7.9 deg): the sun rises into it, then slides behind the deck in the fpv
  s.slotTop = key([[0, 8.9], [T.firstLight, 9.6], [T.hit, 10.3], [T.cut2, 10.6], [T.cut2 + 1.6, 10.2], [T.creek + 0.6, 9.0], [T.sunBreak, 8.6]], t) * DEG;
  s.dawn = 1 - smoothstep(T.sunBreak - 0.25, T.sunBreak + 0.25, t);
  const tb = t - T.sunBreak;
  s.tearR = tb <= -0.05 ? 0 : key([[-0.05, 0], [0.12, 17], [0.4, 38], [0.9, 62], [1.9, 92], [T.cut3 - T.sunBreak, 122], [T.cut4 - T.sunBreak, 150], [T.cut5 - T.sunBreak, 180]], tb) * DEG;
  s.thrG = key([[0, -0.6], [T.cut4 - 0.3, -0.6], [T.cut4 + 0.5, 0.32], [T.cut4 + 1.4, 0.62], [T.cut5, 0.70], [T.cut6 - 0.5, 0.9], [T.cut6, 1.5]], t);
  s.thrT = key([[0, 0.7], [T.cut4, 0.72], [T.cut4 + 2.2, 0.71], [T.cut5, 0.74], [T.cut6 - 0.5, 0.9], [T.cut6, 1.5]], t);
  s.deckLit = smoothstep(T.sunBreak + 0.5, T.cut4 + 1.5, t);
  s.flare = t > T.sunBreak - 0.2 ? Math.exp(-Math.pow((t - T.sunBreak - 0.5) / 0.7, 2)) : 0;
  s.edgeGlow = smoothstep(T.sunBreak, T.sunBreak + 0.3, t) * (1.0 + 1.5 * s.flare);
  // god rays: macro (sun in the slot) + fpv/canopy after the break
  // sun-break shafts peak 12.1-12.8 (the beat), then settle to a gentle level until the white-out
  s.rays = Math.max(
    smoothstep(T.firstLight - 0.3, T.firstLight + 0.8, t) * (1 - smoothstep(T.pullStart, T.cut2, t)) * 0.3,
    smoothstep(T.cut2, T.cut2 + 0.3, t) * (1 - smoothstep(T.whiteout, T.cut4, t)) * 0.12,
    smoothstep(T.sunBreak - 0.05, T.sunBreak + 0.2, t) * (1 - 0.65 * smoothstep(T.sunBreak + 0.45, T.sunBreak + 1.2, t)) * (1 - smoothstep(T.whiteout, T.cut4, t)) * 0.95);
  // cloud growth
  s.growSE = smoothstep(T.sunBreak - 1.6, T.cut3 + 0.2, t);
  s.growNW = smoothstep(T.cut4 - 0.8, T.cut4 + 2.6, t);
  // aerial low layer parting
  s.part = easeInOut(clamp01((t - T.cut6 - 0.1) / (T.resolve - T.cut6 - 0.25)));
  return s;
}
// blue-hour/overcast deck colours (bluer than the timeline's lavender so warm light never turns pink)
function deckColours(t) {
  const T = TIMES;
  // macro: deep indigo top (#1E2250) to lavender horizon (#8E86C8), lifting through the hit into the fpv overcast
  const zen = key([[0, LA('#1E2250')], [T.firstLight, LA('#232A5E')], [T.hit, LA('#3A4590')], [T.cut2, LA('#8F92CE')], [T.sunBreak, LA('#8C98D4')]], Math.min(t, T.sunBreak));
  const hor = key([[0, LA('#8E86C8')], [T.firstLight, LA('#958FCC')], [T.hit, LA('#A0A6DC')], [T.cut2, LA('#C2C3E9')], [T.sunBreak, LA('#CDD1EF')]], Math.min(t, T.sunBreak));
  return { zen, hor };
}

// ------------------------------------------------------------------ module
export async function create(ctx) {
  const { camera, renderer, engine, rig, W, H } = ctx;
  const q = ctx.q;
  const T = TIMES;
  const objects = [];
  const allU = SU;
  const dbgCam = q.get('skycam') ? q.get('skycam').split(',').map(Number) : null;

  // ---- dome
  const domeM = worldMaterial({ vertexShader: DOME_VERT, fragmentShader: DOME_FRAG, uniforms: allU, side: THREE.BackSide, depthWrite: false, depthTest: true });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 48), domeM.material);
  dome.renderOrder = 900; dome.frustumCulled = false;
  objects.push(dome);


  // ---- cumulus groups
  // distance LOD: the far congestus (7-17 km) needs far fewer triangles per puff than the near aerial layers
  const geoHi = icosphere(10), geoMid = icosphere(6), geoLo = icosphere(4);
  const cuU = {
    uCuLit: { value: LC('#FFFCF7') }, uCuShade: { value: LC('#B9B2E0') }, uCuBase: { value: LC('#7A86A6') },
    uCuK: { value: new THREE.Vector4(0.85, 1.6, 0.6, 0.45) },   // ambient, rim, fog mix, self-shadow length
    uCuK2: { value: new THREE.Vector4(0.22, 0.62, 0.10, 0.3) },  // terminator lo/hi, warm band, cluster-normal mix
    uCuEro: { value: new THREE.Vector4(0.6, 3.0, 1.6, 1 / 32000) }, // erosion, noise freq, wisp squash, haze / m
    uCuK3: { value: new THREE.Vector4(0.46, 0.3, 0.7, 0) },     // lit intensity, warm sun tint, max haze
    uBoil: { value: 1 }, uCuDbg: { value: q.get('skycudbg') ? 1 : 0 }, uCuHideAll: { value: 1 },
    uRimBody: { value: 0 },
  };
  function makeGroup(name, layout, seed, cuOverride = {}, gHi = geoHi) {
    const R = rng(seed);
    const clouds = layout.map(o => ({ o, ...genCloud(R, o) }));
    const gU = {
      uCO: { value: Array.from({ length: NC }, () => new THREE.Vector4()) },
      uCS: { value: Array.from({ length: NC }, () => new THREE.Vector4(1, 1, 0, 0)) },
    };
    clouds.forEach((c, ci) => { gU.uCO.value[ci].set(c.o.x, c.o.y, c.o.z, 1); gU.uCS.value[ci].set(1, 1, 0, 1 / c.o.w); });
    const build = (geo, pick) => {
      const list = [];
      clouds.forEach((c, ci) => { for (const p of c.puffs) if (pick(p)) list.push([ci, p]); });
      const n = list.length;
      const aPR = new Float32Array(n * 4), aCI = new Float32Array(n * 4), aEc = new Float32Array(n * 4), aEr = new Float32Array(n * 4);
      list.forEach(([ci, p], k) => {
        aPR.set([p.x, p.y, p.z, p.r], k * 4); aCI.set([ci, p.order, p.seed, p.ao], k * 4);
        aEc.set([...p.b.ec, p.b.top], k * 4); aEr.set([...p.b.er, 0], k * 4);
      });
      const g = new THREE.InstancedBufferGeometry();
      g.index = geo.index; g.setAttribute('position', geo.getAttribute('position'));
      g.setAttribute('aPR', new THREE.InstancedBufferAttribute(aPR, 4));
      g.setAttribute('aCI', new THREE.InstancedBufferAttribute(aCI, 4));
      g.setAttribute('aEc', new THREE.InstancedBufferAttribute(aEc, 4));
      g.setAttribute('aEr', new THREE.InstancedBufferAttribute(aEr, 4));
      g.instanceCount = n;
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
      return { g, n };
    };
    const myCu = { ...cuU };
    for (const [k, v] of Object.entries(cuOverride)) myCu[k] = { value: v };
    const { material } = worldMaterial({ vertexShader: PUFF_VERT, fragmentShader: PUFF_FRAG, uniforms: { ...allU, ...myCu, ...gU } });
    const hi = build(gHi, p => p.lvl < 2), lo = build(geoLo, p => p.lvl >= 2);
    const meshes = [new THREE.Mesh(hi.g, material), new THREE.Mesh(lo.g, material)];
    meshes.forEach((m, i) => { m.frustumCulled = false; m.name = `cumulus_${name}_${i}`; });
    const footMat = worldMaterial({
      vertexShader: FOOT_VERT, fragmentShader: FOOT_FRAG, uniforms: { ...allU, ...gU },
      side: THREE.DoubleSide, depthTest: false, depthWrite: false, blending: THREE.CustomBlending,
      blendEquation: THREE.MaxEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    }).material;
    const foot = new THREE.Mesh(build(icosphere(3), p => p.lvl < 1).g, footMat);
    foot.frustumCulled = false;
    const setVisible = v => meshes.forEach(m => { m.visible = v; });
    return { name, clouds, meshes, foot, gU, n: hi.n + lo.n, setVisible, mat: material };
  }
  // lower each cloud's flat base until the terrain hides it from every camera that sees the group
  function fitBases(layout, t0, t1, dt, margin = 70) {
    const cams = [];
    for (let t = t0; t <= t1; t += dt) cams.push(rig.at(t).pos.clone());
    const H = ctx.data.heightAt;
    for (const o of layout) {
      let best = o.y;
      const pts = [[0, 0], [0.75, 0], [-0.75, 0], [0, 0.75], [0, -0.75]].map(([a, b]) => [o.x + a * o.w * 1.6, o.z + b * o.w * 1.6]);
      for (const C of cams) for (const [px, pz] of pts) {
        const dx = px - C.x, dz = pz - C.z, D = Math.hypot(dx, dz);
        let eMax = -1;
        for (let sd = 40; sd < D * 0.97; sd *= 1.035) eMax = Math.max(eMax, (H(C.x + dx / D * sd, C.z + dz / D * sd) - C.y) / sd);
        best = Math.min(best, C.y + D * eMax - margin - D * 0.004);
      }
      o.y = Math.max(best, H(o.x, o.z) - 250, 250);
    }
    return layout;
  }
  const SE_RIM_CANOPY = q.has('skyserim') ? +q.get('skyserim') : 1.0;  // gSE silver-lining strength in the canopy shot
  const gSE = makeGroup('se',fitBases(layoutSE(rng(11)), T.sunBreak - 0.3, T.cut4 - 0.01, 0.2), 101, {
    uCuK: new THREE.Vector4(0.62, 3.0, 0.3, 0.42), uCuEro: new THREE.Vector4(0.6, 3.0, 1.6, 1 / 30000), uCuK3: new THREE.Vector4(0.46, 0.3, 0.55, 0),
    uRimBody: 0 }, geoMid);
  const gNW = makeGroup('nw', fitBases(layoutNW(rng(22)), T.cut4, T.end, 0.35), 202, {
    uCuK: new THREE.Vector4(0.80, 1.4, 0.3, 0.45), uCuEro: new THREE.Vector4(0.6, 3.0, 1.6, 1 / 30000), uCuK3: new THREE.Vector4(0.44, 0.22, 0.8, 0) }, geoMid);
  const camAt = tt => { const c = rig.at(tt); return { pos: c.pos.clone(), target: c.target.clone() }; };
  const lowLayout = layoutLow(rng(33), camAt(T.cut6 + 0.01), camAt(lerp(T.resolve, T.end, 0.25)));
  const gLow = makeGroup('low', lowLayout, 303, {
    uCuK: new THREE.Vector4(0.72, 1.2, 0.22, 0.5), uCuK2: new THREE.Vector4(0.3, 0.6, 0.10, 0.3),
    uCuEro: new THREE.Vector4(0.9, 3.2, 2.0, 1 / 20000), uCuK3: new THREE.Vector4(0.46, 0.22, 0.5, 0) });
  const groups = [gSE, gNW, gLow];
  for (const g of groups) objects.push(...g.meshes);
  console.log('sky puffs', groups.map(g => `${g.name}:${g.clouds.length}/${g.n}`).join(' '), 'bases', [gSE, gNW].map(g => g.clouds.map(c => Math.round(c.o.y)).join(',')).join(' | '));

  function animGroups(t, s) {
    const shot = ctx.shot?.id ?? 'macro';
    const all = q.get('skyallclouds');
    gSE.setVisible(all || (shot === 'fpv' && t > T.sunBreak - 0.3) || shot === 'canopy');
    gNW.setVisible(all || shot === 'reveal' || shot === 'falls' || shot === 'aerial');
    gLow.setVisible(all || shot === 'aerial');
    // canopy: the backlit SE congestus gets its silver lining only on the outer silhouette (no per-puff outlines);
    // every other shot keeps the original per-puff rim (fpv frames before the cut are final)
    const rimBody = shot === 'canopy';
    gSE.mat.uniforms.uRimBody.value = rimBody ? 1 : 0;
    gSE.mat.uniforms.uCuK.value.y = rimBody ? SE_RIM_CANOPY : 3.0;
    const wind = [-6, -2.5]; // slow drift m/s
    // growth: puffs pop in (bottom-first, mixed order) while the whole cloud swells from its base
    const grow = (g, i, d) => {
      const c = g.clouds[i];
      d = all ? 1 : d;
      g.gU.uCO.value[i].set(c.o.x + wind[0] * t, c.o.y, c.o.z + wind[1] * t, d);
      g.gU.uCS.value[i].set(1, 0.55 + 0.45 * (1 - Math.pow(1 - d, 2)), 0, 1 / c.o.w);
    };
    gSE.clouds.forEach((c, i) => grow(gSE, i, clamp01((s.growSE - ((i * 3) % 7) * 0.04) / 0.72)));
    gNW.clouds.forEach((c, i) => grow(gNW, i, clamp01((s.growNW - ((i * 7) % 5) * 0.05) / 0.8)));
    // aerial wipe: the near veil burns off and drifts apart; the inner fair-weather clouds part to the
    // frame edges (clear of the heart by TIMES.resolve) and stay as framing; the outer ring barely moves
    const { Rv, Fv } = lowLayout;
    const p = s.part;
    const sun = sunAt(t);
    gLow.clouds.forEach((c, i) => {
      const { a, b, layer } = c.o;
      const rl = Math.hypot(a, b) || 1, ua = a / rl, ub = b / rl;
      let push = 0, dis = 0, sc = 1;
      const jit = ((i * 5) % 7) * 0.025;
      if (layer === 0) {          // veil: burns off first
        push = (110 + rl * 0.35) * p;
        dis = 1.4 * smoothstep(0.06, 0.7, p + jit);
        sc = 1 + 0.25 * p;
      } else if (layer === 1) {   // over the flower: drifts apart and evaporates, heart clear by the resolve
        push = (160 + rl * 0.5) * p;
        dis = 1.4 * smoothstep(0.22, 0.92, p + jit);
        sc = 1 + 0.15 * p;
      }
      const da = ua * push, db = ub * push;
      const x = c.o.x + Rv[0] * da + Fv[0] * db + 3 * (t - T.cut6), z = c.o.z + Rv[1] * da + Fv[1] * db;
      gLow.gU.uCO.value[i].set(x, c.o.y, z, 1);
      // shadows that land on the flower go once the wipe has played
      const gx = x - sun.x / Math.max(sun.y, 0.1) * c.o.y, gz = z - sun.z / Math.max(sun.y, 0.1) * c.o.y;
      const onFlower = 1 - smoothstep(1150, 1450, Math.hypot(gx, gz));
      gLow.gU.uCS.value[i].set(1 - onFlower * smoothstep(0.35, 0.9, p), sc, dis, 1 / c.o.w);
    });
  }

  // ---- cloud shadow coverage map
  const COV = 1024;
  const covRT = [0, 1].map(() => new THREE.WebGLRenderTarget(COV, COV, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, generateMipmaps: false }));
  const fsGeo = new THREE.PlaneGeometry(2, 2);
  const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const pass = (frag, uniforms, extra = {}) => {
    const m = worldMaterial({ vertexShader: FS_VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false, ...extra }).material;
    const mesh = new THREE.Mesh(fsGeo, m); mesh.frustumCulled = false;
    const sc = new THREE.Scene(); sc.add(mesh);
    return { scene: sc, mesh, u: m.uniforms };
  };
  const covU = { ...allU, uCovCam: { value: new THREE.Vector3() }, uCovTexel: { value: 10 } };
  const pCov = pass(COV_FRAG, covU);
  const blurU = { tSrc: { value: null }, uDir: { value: new THREE.Vector2() }, uRemap: { value: new THREE.Vector2(1, 0) } };
  const pBlur = pass(BLUR_FRAG, blurU);
  const footScene = new THREE.Scene(); footScene.add(gLow.foot);
  U.tCloudCov.value = covRT[0].texture;

  // ---- god rays (overlay)
  const RW = Math.max(64, Math.round(W / 4)), RH = Math.max(36, Math.round(H / 4));
  const rrt = () => new THREE.WebGLRenderTarget(RW, RH, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, generateMipmaps: false });
  const maskRT = rrt(), raysRT = rrt();
  const maskU = { ...allU, tDepth: { value: null }, uFullTexel: { value: new THREE.Vector2(1 / W, 1 / H) }, uInvVP: { value: new THREE.Matrix4() }, uCam: { value: new THREE.Vector3() }, uNear: { value: 0.1 }, uFar: { value: 1000 }, uSkyDepth: { value: 1e12 } };
  const pMask = pass(MASK_FRAG, maskU);
  const raysU = { tMask: { value: maskRT.texture }, uSunUV: { value: new THREE.Vector2() }, uLen: { value: 0.9 }, uDecay: { value: 0.985 }, uJit: { value: 0 } };
  const pRays = pass(RAYS_FRAG, raysU);
  const compU = { tRays: { value: raysRT.texture }, uRayCol: { value: new THREE.Color() }, uRayAmt: { value: 0 }, uSunUV: raysU.uSunUV, uAspect: { value: W / H }, uStripe: { value: new THREE.Vector2(0, 0) } };
  const compM = new THREE.ShaderMaterial({
    vertexShader: FS_VERT, fragmentShader: RAYCOMP_FRAG, uniforms: compU, transparent: true, depthTest: false, depthWrite: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
  const rayMesh = new THREE.Mesh(fsGeo, compM);
  rayMesh.frustumCulled = false; rayMesh.renderOrder = 1000;
  const _v = new THREE.Vector3(), _m = new THREE.Matrix4();
  rayMesh.onBeforeRender = (r, sc, cam) => {
    const prev = r.getRenderTarget();
    const prevAuto = r.autoClear;
    r.autoClear = true;
    maskU.tDepth.value = engine.sceneRT.depthTexture;
    maskU.uNear.value = cam.near; maskU.uFar.value = cam.far;
    maskU.uCam.value.copy(cam.position);
    _m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    maskU.uInvVP.value.copy(_m).invert();
    _v.copy(cam.position).addScaledVector(U.uSunDir.value, 1e4).project(cam);
    raysU.uSunUV.value.set(_v.x * 0.5 + 0.5, _v.y * 0.5 + 0.5);
    raysU.uJit.value = (U.uFrame.value % 64) * 3.7;
    r.setRenderTarget(maskRT); r.render(pMask.scene, fsCam);
    r.setRenderTarget(raysRT); r.render(pRays.scene, fsCam);
    r.setRenderTarget(prev);
    r.autoClear = prevAuto;
  };

  // fpv heading around the sun break (precomputed: rig.at() returns a shared object, so never call it per subframe)
  const HD0 = T.sunBreak - 0.5, HDdt = 0.05, heading = [];
  for (let tt = HD0; tt <= T.cut4 + 0.05; tt += HDdt) {
    const a = rig.at(Math.max(tt - 0.15, T.cut2)).pos.clone(), b = rig.at(Math.min(tt + 0.15, T.cut3 - 0.001)).pos.clone();
    heading.push(new THREE.Vector3(b.x - a.x, 0, b.z - a.z).normalize());
  }
  const _tear = new THREE.Vector3();
  // ---- shared state per time
  function applySky(t, fovDeg) {
    const s = skyState(t);
    const sun = sunAt(t);
    const dc = deckColours(t);
    SU.uSlot.value.set(s.slot, s.slotTop, 20 * DEG, 7.7 * DEG);
    SU.uSlotDir.value.set(sun.x, sun.z).normalize();
    // tear: centred on the sun (it stands just above the ESE saddle)
    // the hole opens around the sun but leans toward where the fpv camera is heading, so the break reads in frame
    const hi = Math.min(heading.length - 1, Math.max(0, Math.round((t - HD0) / HDdt)));
    const lean = 0.8 * smoothstep(T.sunBreak + 0.3, T.sunBreak + 0.8, t) * (1 - smoothstep(T.cut3, T.cut4, t));
    _tear.set(sun.x, sun.y, sun.z).addScaledVector(heading[hi], lean).normalize();
    SU.uTear.value.set(_tear.x, _tear.y, _tear.z, s.tearR);
    SU.uTearFx.value.set(s.edgeGlow, 0.8, 0.035 + 0.03 * smoothstep(T.sunBreak, T.cut4, t), 0);
    SU.uDeck.value.set(2600, s.thrG, s.thrT, 0.30);
    SU.uDeckDrift.value.set(-38 * t, -14 * t);
    SU.uDeckZen.value.setRGB(...dc.zen); SU.uDeckHor.value.setRGB(...dc.hor);
    const lift = 1 + 0.3 * smoothstep(T.sunBreak, T.sunBreak + 1.5, t);
    SU.uDeckZen.value.multiplyScalar(lift); SU.uDeckHor.value.multiplyScalar(lift);
    SU.uDeckLit.value = s.deckLit;
    SU.uDawn.value = s.dawn;
    SU.uSkyGlow.value = 1 + 1.0 * s.flare;
    // a compact, hot disc (reads as a round bokeh disc through the macro DOF) with a soft glow around it
    SU.uSunDisc.value.set(Math.cos((+q.get('skydisc') || 0.55) * DEG), key([[0, 14], [T.hit, 13], [T.cut2, 8], [T.sunBreak - 0.1, 7], [T.sunBreak + 0.4, 16], [T.end, 16]], t),
      key([[0, 1.0], [T.cut2, 0.6], [T.sunBreak, 0.3], [T.cut4, 0.0]], t), 0);
    SU.uSkyK.value.set(0, smoothstep(T.cut6, T.resolve, t) * 0.10, key([[0, 0.42], [T.pullStart, 0.5], [T.cut2, 1.0]], t),
      0.10 * smoothstep(T.sunBreak - 0.05, T.sunBreak + 0.15, t) * (1 - smoothstep(T.sunBreak + 0.8, T.sunBreak + 1.6, t)));
    SU.uPixAng.value = (fovDeg * DEG) / H;
    // keep the fog/haze colour (WORLD skyGradient) consistent with the deck before the break
    if (t < T.sunBreak + 1.0) {
      const k = smoothstep(T.sunBreak - 0.2, T.sunBreak + 1.0, t);
      const tz = U.uSkyZenith.value.clone(), th = U.uSkyHorizon.value.clone();
      U.uSkyZenith.value.setRGB(...dc.zen).lerp(tz, k);
      U.uSkyHorizon.value.setRGB(...dc.hor).lerp(th, k);
    }
    return s;
  }

  function update(t, c) {
    const cam = c.cam;
    if (dbgCam) {
      camera.position.set(dbgCam[0], dbgCam[1], dbgCam[2]); camera.up.set(0, 1, 0); camera.lookAt(dbgCam[3], dbgCam[4], dbgCam[5]);
      camera.fov = dbgCam[6] || 50; camera.near = 1; camera.far = 80000; camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
    }
    const s = applySky(t, dbgCam ? camera.fov : (cam?.fov ?? 50));
    const shot = c.shot.id;
    animGroups(t, s);
    // cloud shadows
    const csOn = shot === 'macro' ? 0 : key([[T.sunBreak - 0.05, 0], [T.sunBreak + 0.5, 0.5], [T.cut4, 0.46], [T.cut6, 0.42], [T.end, 0.42]], t);
    U.uCloudShadow.value.w = csOn;
    // god rays
    const sunInView = camera.getWorldDirection(_v).dot(U.uSunDir.value);
    const rayAmt = s.rays * smoothstep(-0.1, 0.35, sunInView) * (q.get('skyraydbg') ? 8 : 1) * (q.has('skyrays') ? +q.get('skyrays') : 1);
    compU.uRayAmt.value = rayAmt;
    rayMesh.visible = rayAmt > 0.0005;
    compU.uRayCol.value.copy(U.uSunColor.value);
    compU.uStripe.value.set(shot === 'fpv' || shot === 'canopy' ? 0.65 : 0.5, t * 0.35);
    maskU.uSkyDepth.value = shot === 'fpv' ? 2500 : 1e12;
    raysU.uLen.value = 0.85;
    raysU.uDecay.value = 0.988;
  }

  // coverage region: around the ground the camera looks at, shifted toward the sun to the cloud plane
  function preFrame(t, c) {
    const shot = c.shot.id;
    const cam = rig.at(t);
    const camPos = cam.pos.clone(), tgt = cam.target.clone();
    if (dbgCam) { camPos.set(dbgCam[0], dbgCam[1], dbgCam[2]); tgt.set(dbgCam[3], dbgCam[4], dbgCam[5]); }
    const s = applySky(t, cam.fov);
    const sun = sunAt(t);
    const fwd = tgt.clone().sub(camPos); fwd.y = 0; fwd.normalize();
    const reach = { macro: 200, fpv: 900, canopy: 1200, reveal: 1800, falls: 900, aerial: 3000 }[shot];
    const size = { macro: 4000, fpv: 9000, canopy: 9000, reveal: 11000, falls: 8000, aerial: 10000 }[shot];
    const alt = shot === 'aerial' ? 880 : 2600;
    U.uCloudAlt.value = alt;
    const gx = camPos.x + fwd.x * reach, gz = camPos.z + fwd.z * reach;
    const k = alt / Math.max(sun.y, 0.08);
    const cx = gx + sun.x * k, cz = gz + sun.z * k;
    const ox = cx - size / 2, oz = cz - size / 2;
    U.uCloudShadow.value.set(1 / size, -ox / size, -oz / size, U.uCloudShadow.value.w);
    covU.uCovCam.value.copy(camPos); covU.uCovTexel.value = size / COV;
    if (shot === 'macro') return; // no cloud shadows needed
    animGroups(t, s);
    const r = renderer;
    const prevAuto = r.autoClear;
    const pc = r.getClearColor(new THREE.Color()), pa = r.getClearAlpha();
    r.setClearColor(0x000000, 1); r.autoClear = true;
    r.setRenderTarget(covRT[0]); r.render(pCov.scene, fsCam);
    if (shot === 'aerial') { r.autoClear = false; r.render(footScene, fsCam); r.autoClear = true; }
    // soft penumbrae (~50-100 m): two separable gaussian rounds, then remap so cloudShadow()'s
    // smoothstep(0.35, 0.75) spans the whole blurred edge instead of re-sharpening it
    const stepT = THREE.MathUtils.clamp(18 / (size / COV), 0.8, 3.0);
    for (let k = 0; k < 2; k++) {
      blurU.uRemap.value.set(1, 0);
      blurU.tSrc.value = covRT[0].texture; blurU.uDir.value.set(stepT / COV, 0);
      r.setRenderTarget(covRT[1]); r.render(pBlur.scene, fsCam);
      if (k === 1) blurU.uRemap.value.set(0.42, 0.34);
      blurU.tSrc.value = covRT[1].texture; blurU.uDir.value.set(0, stepT / COV);
      r.setRenderTarget(covRT[0]); r.render(pBlur.scene, fsCam);
    }
    r.setRenderTarget(null);
    r.setClearColor(pc, pa); r.autoClear = prevAuto;
    engine.sync();
  }

  function post(t, p) {
    const s = skyState(t);
    const o = { bloomStrength: p.bloomStrength * (1 + 0.9 * s.flare) };
    if (q.get('skynodof')) o.cocK = 0;
    return o;
  }

  return { objects, overlay: [rayMesh], update, preFrame, post };
}
