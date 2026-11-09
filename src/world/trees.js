// Stylised trees.
//  * HERO GROVE on its rise (layout.GROVE): ~40 round Ghibli-style broadleaves.
//    Crowns are clumps of camera-facing alpha-tested leaf cards whose normals
//    are bent outward from the clump centres (soft painterly ball shading),
//    with a dark lumpy core per clump (dense interiors), back-light
//    translucency, snow pillows on the upward clumps, and real trunks/limbs.
//    Tree heights are clamped against the fpv/canopy camera path so the
//    canopy shot skims ~1 m over the crowns without ever clipping them.
//  * FOREST belts (layout forest mask): tens of thousands of instanced
//    conifers (slopes) and round broadleaf clumps (floor), culled per shot from
//    the precomputed camera paths and LOD'd by projected size.
// Winter -> spring: the FOREST follows the bloom wave at each tree's base
// (bloomAmt(base) == smoothstep(0,1,bloomP(base))). The HERO GROVE keeps its winter
// (dark foliage, snow caps on up-facing puffs, snow pillows) until the canopy skim and
// flushes on its own clock (planFlush): bottom-up, straight to fresh green, pillows
// shedding as the green front reaches them. Shed points are exported as ctx.treeShed
// for the fx snow puffs. All foliage uses 3-band painterly light (foliageBands).
import * as THREE from 'three';
import * as L from './layout.js';
import { worldMaterial, castShadow, rng } from './common.js';
import { PALETTE_GLSL } from './terrain.js';

// ---------------------------------------------------------------- tuning knobs
export const TUNE = {
  groveCount: 45,          // hero trees attempted (some may be dropped by the camera clamp)
  groveSpacing: 8.2,       // min trunk spacing (m)
  groveR: 50,              // placement radius around layout.GROVE (m)
  groveH: [10.0, 15.5],    // tree height at grove edge / centre (m)
  crownW: [0.46, 0.53],    // crown radius / height
  cardSize: 0.82,          // leaf-card edge (m)
  cardDensity: 40,         // cards per m^2 of clump radius^2
  coreScale: 0.66,         // core sphere radius / clump radius
  camClear: 1.0,           // min distance (m) between camera path and any crown
  forestSpacing: 7.0,      // forest jitter-grid spacing (m)
  coniferH: [14, 25], broadH: [9.5, 14.5],
  forestScale: [0.65, 1.3],// per-tree height scale (clump-correlated: taller in clump centres)
  clumpGlade: 0.3,         // acceptance multiplier in the glades between clumps (1 = no clumping)
  firShare: 0.45,          // share of conifers using the broad drooping fir silhouette
  lodPx: [260, 70],        // projected tree height (px @2160p): > [0] LOD0, > [1] LOD1, else LOD2
  lodPxShot: { falls: [170, 45] },
  // hero grove flush (driven by the canopy skim, not the terrain wave)
  flushDur: 0.6,           // s for p 0 -> 1 (bottom-to-top green front ~0.42 s)
  flushDelay: -0.05,       // s relative to the canopy cut when the grove face starts to flush (its caps stay to ~cut3+0.45)
  flushSpeed: 150,         // m/s of the flush front through the grove: it races ahead of the camera (~60 m/s), so the
                           // crown tops pop green and shed their snow in front of the lens around whiteout-0.4..+0.1
  flushJitter: 0.14,       // s random per-tree stagger on top of the front-to-back order
  shedPerTree: 4,          // exported snow shed points per crown (fx puffs)
};

const SHOT_IDS = ['macro', 'fpv', 'canopy', 'reveal', 'falls', 'aerial'];
const HERO_SHOTS = new Set(['macro', 'fpv', 'canopy', 'reveal']);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
const hash2 = (i, j) => { let h = Math.imul(i | 0, 374761393) + Math.imul(j | 0, 668265263) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
const vnoise2 = (x, z) => {
  const i = Math.floor(x), j = Math.floor(z), u = x - i, v = z - j, su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
  return lerp(lerp(hash2(i, j), hash2(i + 1, j), su), lerp(hash2(i, j + 1), hash2(i + 1, j + 1), su), sv);
};
const norm3 = v => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

// ---------------------------------------------------------------- GLSL
const TREE_GLSL = /* glsl */`
${PALETTE_GLSL}
uniform float uTreeOfs; uniform float uTreeDbg;
uniform float uFlushDur; uniform float uPFloor;
// wave progress in band widths at a point: bloomAmt(xz) == smoothstep(0,1,bloomP(xz))
float bloomP(vec2 xz) {
  float a = arrival(xz) + (fbm(xz * 0.11) - 0.5) * uBloomNoise * 2.0 + (vnoise(xz * 0.9) - 0.5) * 0.6;
  return (uBloomD - a) / max(uBloomWidth, 1e-3) + uTreeOfs;
}
// hero grove: per-tree flush clock (start time tF, baked from the canopy skim) -> progress
float heroP(float tF) { return max((uTime - tF) / uFlushDur + uTreeOfs, uPFloor); }
#define SNOW_SHADE s2l(vec3(0.553, 0.639, 0.784))
`;

const FOLIAGE_GLSL = /* glsl */`
// painterly 3-band foliage light: shadow side / mid / sunlit top with hue-shifted
// albedos (cool shade, warm lit). A sun-relative fill (light scattered through and
// around the crowns) keeps the shadow side readable, never black. Back-light
// translucency on thin silhouettes.
vec3 foliageBands(vec3 aTop, vec3 aMid, vec3 aShade, vec3 transCol, vec3 N, vec3 wp, float ao, float sh, float wrap, float transAmt) {
  vec3 V = normalize(cameraPosition - wp);
  float ndl = dot(N, uSunDir);
  float diff = clamp((ndl + wrap) / (1.0 + wrap), 0.0, 1.0);
  float cs = cloudShadow(wp);
  float lit = diff * sh * cs;
  float bMid = smoothstep(0.10, 0.32, lit);
  float bTop = smoothstep(0.48, 0.72, lit);
  vec3 alb = mix(mix(aShade, aMid, bMid), aTop, bTop);
  vec3 hemi = mix(uGroundBounce, uSkyAmbient, N.y * 0.5 + 0.5);
  float sunE = 0.28 * bMid + 0.57 * bTop + 0.15 * lit;
  float fill = (0.09 + 0.08 * ao) * (0.6 + 0.4 * cs);
  vec3 col = alb * (uSunColor * (sunE + fill) + hemi * ao);
  float back = pow(clamp(dot(-V, uSunDir), 0.0, 1.0), 3.0);
  col += transCol * uSunColor * back * transAmt * cs * (sh * 0.7 + 0.04 * ao);
  return col;
}
`;

// ---- hero leaf cards (camera-facing quads; normals from clump centres)
const CARD_VERT = /* glsl */`
invariant gl_Position;
${TREE_GLSL}
attribute vec4 iPos;   // centre xyz, size
attribute vec4 iNrm;   // bent normal xyz, ao
attribute vec4 iTree;  // base x, base z, base y, tree height
attribute vec4 iRnd;   // rotation, atlas cell, rand, crown height 0..1
attribute float iFl;   // flush start time (s)
varying vec2 vUv; varying vec3 vWorld; varying vec3 vN; varying vec4 vA; varying float vVar;
void main() {
  float p = heroP(iFl);
  float spring = smoothstep(0.0, 1.0, p);
  vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  float rot = iRnd.x + sin(uTime * 5.3 + iRnd.z * 37.0) * 0.10 * spring;
  float cr = cos(rot), sr = sin(rot);
  vec2 c = vec2(cr * position.x - sr * position.y, sr * position.x + cr * position.y);
  vec3 wp = iPos.xyz + (camR * c.x + camU * c.y) * (iPos.w * 0.5);
  vec2 w = windAt(iTree.xy, uTime);
  float hh = clamp((iPos.y - iTree.z) / max(iTree.w, 1.0), 0.0, 1.3);
  wp.xz += w * hh * hh * (0.04 + 0.16 * spring);
  wp += vec3(sin(uTime * 3.1 + iRnd.z * 50.0), 0.0, cos(uTime * 2.7 + iRnd.z * 31.0)) * 0.02 * spring;
  float cell = mod(iRnd.y, 4.0);
  vUv = (vec2(mod(cell, 2.0), floor(cell * 0.5)) + uv) * 0.5;
  vWorld = wp; vN = iNrm.xyz; vA = vec4(iNrm.w, iRnd.w, iRnd.z, p);
  vVar = fract(iTree.x * 0.1373 + iTree.y * 0.0711) * 0.6 + floor(iRnd.y / 4.0) / 8.0 * 0.4;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

const HERO_FOLIAGE_GLSL = /* glsl */`
${FOLIAGE_GLSL}
// shared by the leaf cards and the clump cores
vec3 heroFoliage(vec3 N, vec3 Nc, vec3 wp, float ao, float y01, float rnd, float p, float leafShade, float leafSide, float treeVar, float lightK) {
  // bottom-up flush: a world-space noise front climbs the crown (~0.5 s), straight
  // from snow-laden dark winter foliage to fresh green (no intermediate hue)
  float wn = vnoise3(wp * 0.45) - 0.5;
  float jit = wn * 0.32 + (rnd - 0.5) * 0.05;
  float fh = -0.22 + 1.45 * p;
  float dy = y01 + jit - fh;
  float green = smoothstep(0.04, -0.04, dy);
  float glow = exp(-dy * dy / 0.006) * step(0.0, p) * (1.0 - smoothstep(0.9, 1.3, p));
  // snow caps only on the up-facing puffs (N.y > ~0.5); the flush takes them along
  float snowN = Nc.y + (leafShade - 0.7) * 0.18 + (rnd - 0.5) * 0.12 + wn * 0.5;
  float snow = smoothstep(0.6, 0.72, snowN) * (1.0 - green);
  // spring: chartreuse sunlit tops, fresh mid greens, cool deep-green shadow side
  vec3 sTop = mix(s2l(vec3(0.56, 0.80, 0.26)), s2l(vec3(0.71, 0.88, 0.35)), treeVar);   // lime <-> #B6E05A
  sTop = mix(sTop, s2l(vec3(0.78, 0.92, 0.42)), clamp(leafShade - 0.65, 0.0, 0.35));
  vec3 sMid = mix(s2l(vec3(0.27, 0.56, 0.22)), s2l(vec3(0.40, 0.66, 0.22)), treeVar);
  vec3 sShade = mix(s2l(vec3(0.20, 0.45, 0.26)), s2l(vec3(0.27, 0.53, 0.27)), ao);
  vec3 sTrans = s2l(vec3(0.62, 0.90, 0.26));
  // winter: dark foliage (#1E3326) under the snow, a breath of rime on the lit side
  vec3 wTop = s2l(vec3(0.36, 0.46, 0.43)), wMid = s2l(vec3(0.26, 0.38, 0.31)), wShade = s2l(vec3(0.19, 0.29, 0.27));
  vec3 wTrans = s2l(vec3(0.30, 0.40, 0.32)) * 0.4;
  vec3 aT = mix(wTop, sTop, green), aM = mix(wMid, sMid, green), aS = mix(wShade, sShade, green), tr = mix(wTrans, sTrans, green);
  aT = mix(aT, C_SNOW, snow); aM = mix(aM, mix(C_SNOW, SNOW_SHADE, 0.45), snow); aS = mix(aS, SNOW_SHADE, snow);
  tr = mix(tr, vec3(0.3, 0.32, 0.35), snow);
  float side = mix(1.0, 0.84, leafSide);
  float tint = 0.88 + 0.24 * fract(treeVar * 7.31);
  float sh = sunShadow(wp + Nc * 0.08, 2.0);
  // translucency concentrates where the view grazes a puff (thin silhouettes glow, bulk stays deep)
  float rim = 1.0 - max(dot(Nc, normalize(cameraPosition - wp)), 0.0);
  float thin = 0.25 + 0.75 * rim * rim;
  vec3 col = foliageBands(aT * side * tint, aM * side * tint, aS * mix(1.0, tint, 0.5), tr, N, wp, ao, sh * lightK, 0.45, mix(0.5, 1.0, green) * thin);
  col += glow * green * s2l(vec3(0.85, 1.0, 0.45)) * (uSunColor * 0.10 + uSkyAmbient * 0.25);
  float backV = pow(clamp(dot(normalize(wp - cameraPosition), uSunDir), 0.0, 1.0), 3.0);
  col += green * (1.0 - snow) * sTrans * uSunColor * backV * 0.11 * (0.3 + 0.7 * thin) * (0.5 + 0.5 * ao);
  return col;
}
`;

const CARD_FRAG = /* glsl */`
${TREE_GLSL}
uniform sampler2D tLeaf;
varying vec2 vUv; varying vec3 vWorld; varying vec3 vN; varying vec4 vA; varying float vVar;
#ifndef DEPTH_PASS
${HERO_FOLIAGE_GLSL}
#endif
void main() {
  vec4 tx = texture2D(tLeaf, vUv);
  vec2 dx = dFdx(vUv * 1024.0), dy = dFdy(vUv * 1024.0);
  float lod = 0.5 * log2(max(max(dot(dx, dx), dot(dy, dy)), 1e-8));
  float a = tx.a * (1.0 + max(lod, 0.0) * 0.22);
  if (a < 0.5) discard;
#ifdef DEPTH_PASS
  gl_FragColor = vec4(1.0);
#else
  vec3 Nc = normalize(vN);
  float id = tx.b;
  vec3 tilt = vec3(fract(id * 13.7) - 0.5, fract(id * 7.3) - 0.35, fract(id * 3.1) - 0.5);
  vec3 N = normalize(Nc + tilt * 0.22);   // clump normal dominates: sub-crown masses read
  vec3 col = heroFoliage(N, Nc, vWorld, vA.x, vA.y, vA.z, vA.w, tx.r, tx.g, vVar, 1.0);
  col = applyFog(col, vWorld);
  gl_FragColor = vec4(col, 1.0);
#endif
}`;

// ---- clump cores (lumpy dark spheres filling crown interiors)
const CORE_VERT = /* glsl */`
${TREE_GLSL}
attribute vec4 iC;     // centre xyz, radius
attribute vec4 iTree;  // base x, base z, base y, tree height
attribute vec4 iRnd;   // seed, y01, ao, -
attribute float iFl;   // flush start time (s)
varying vec3 vWorld; varying vec3 vN; varying vec3 vNc; varying vec4 vA; varying float vVar;
void main() {
  float p = heroP(iFl);
  float spring = smoothstep(0.0, 1.0, p);
  vec3 d = normalize(position);
  float lump = vnoise3(d * 2.3 + iRnd.x * 17.0) - 0.5;
  vec3 wp = iC.xyz + d * iC.w * (1.0 + lump * 0.32);
  vec2 w = windAt(iTree.xy, uTime);
  float hh = clamp((iC.y - iTree.z) / max(iTree.w, 1.0), 0.0, 1.3);
  wp.xz += w * hh * hh * (0.04 + 0.16 * spring);
  vWorld = wp; vNc = d; vN = normalize(d + vec3(0.0, 0.15, 0.0));
  float yl = clamp(iRnd.y + d.y * iC.w / max(iTree.w * 0.7, 1.0), 0.0, 1.0);
  vA = vec4(iRnd.z * (0.6 + 0.4 * (d.y * 0.5 + 0.5)), yl, iRnd.x, p);
  vVar = fract(iTree.x * 0.1373 + iTree.y * 0.0711) * 0.6 + iRnd.w * 0.4;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const CORE_FRAG = /* glsl */`
${TREE_GLSL}
varying vec3 vWorld; varying vec3 vN; varying vec3 vNc; varying vec4 vA; varying float vVar;
${HERO_FOLIAGE_GLSL}
void main() {
  // leafy speckle so gaps between cards read as deeper foliage, not a smooth ball
  float sp = vnoise3(vWorld * 3.1) * 0.6 + vnoise3(vWorld * 7.3) * 0.4;
  vec3 N = normalize(vN + (vec3(vnoise3(vWorld * 2.0 + 3.0), vnoise3(vWorld * 2.0 + 7.0), vnoise3(vWorld * 2.0 + 11.0)) - 0.5) * 0.9);
  vec3 col = heroFoliage(N, normalize(vNc), vWorld, vA.x * (0.45 + 0.4 * sp), vA.y, vA.z, vA.w, sp, step(0.55, sp), vVar, 0.45);
  col = applyFog(col, vWorld);
  gl_FragColor = vec4(col, 1.0);
}`;

// ---- snow pillows on the upward clumps: held through winter, shed (slump off the
// crown, drop and break up) the moment the flush front reaches them. The same shed
// times are exported to ctx.treeShed for the fx snow puffs.
const PILLOW_VERT = /* glsl */`
${TREE_GLSL}
attribute vec4 iC;     // centre xyz, horizontal radius
attribute vec4 iTree;
attribute vec4 iRnd;   // seed, vertical ratio, crown height 0..1, -
attribute float iFl;   // flush start time (s)
varying vec3 vWorld; varying vec3 vN;
void main() {
  float p = heroP(iFl);
  float pS = (iRnd.z + 0.22) / 1.45 + 0.04;          // green front reaches this pillow
  float s = clamp((p - pS) / 0.3, 0.0, 1.0);          // shed progress (~0.2 s)
  float k = 1.0 - smoothstep(0.2, 1.0, s);
  vec3 d = normalize(position);
  float lump = (vnoise3(d * 2.6 + iRnd.x * 23.0) - 0.5) + (vnoise3(d * 6.0 + iRnd.x * 11.0) - 0.5) * 0.45;
  vec3 e = vec3(1.0, iRnd.y, 1.0);
  vec3 q = d; if (q.y < 0.0) q.y *= 0.35;
  vec2 out2 = iC.xz - iTree.xy; out2 /= max(length(out2), 0.3);
  vec3 drop = vec3(out2.x, 0.0, out2.y) * s * iC.w * 0.7 - vec3(0.0, s * s * iC.w * 2.4, 0.0);
  vec3 wp = iC.xyz + drop + q * e * iC.w * (1.0 + lump * (0.5 + 0.8 * s)) * k;
  vec2 w = windAt(iTree.xy, uTime);
  float hh = clamp((iC.y - iTree.z) / max(iTree.w, 1.0), 0.0, 1.3);
  wp.xz += w * hh * hh * 0.04;
  vWorld = wp; vN = normalize(d / e + vec3(0.0, 0.2, 0.0));
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const PILLOW_FRAG = /* glsl */`
${TREE_GLSL}
varying vec3 vWorld; varying vec3 vN;
void main() {
  vec3 wp = vWorld;
  vec3 N = normalize(vN + (vec3(vnoise3(wp * 1.7), vnoise3(wp * 1.7 + 5.0), vnoise3(wp * 1.7 + 9.0)) - 0.5) * 0.5);
  float sh = sunShadow(wp + N * 0.08, 2.0);
  vec3 col = shadeSurface(C_SNOW, N, wp, 0.35, 1.0, 0.35, sh);
  float ndl = max(dot(N, uSunDir), 0.0);
  col += SNOW_SHADE * (uSunColor * 0.06 + uSkyAmbient * 0.25) * (1.0 - ndl * sh);
  vec3 V = normalize(cameraPosition - wp);
  vec3 gp = floor(wp * 14.0);
  float gl = step(0.86, hash13(gp));
  float facet = pow(max(dot(reflect(-uSunDir, normalize(hash33(gp) - 0.5 + vec3(0.0, 0.8, 0.0))), V), 0.0), 40.0);
  col += gl * facet * uSunColor * 3.0 * sh * (1.0 - smoothstep(6.0, 40.0, length(cameraPosition - wp)));
  col = applyFog(col, wp);
  gl_FragColor = vec4(col, 1.0);
}`;

// ---- trunks + limbs
const TRUNK_VERT = /* glsl */`
${TREE_GLSL}
attribute vec4 aT;     // base x, base z, height fraction, ao
attribute float aF;    // flush start time (s)
varying vec3 vWorld; varying vec3 vN; varying vec4 vT; varying float vP;
void main() {
  float p = heroP(aF);
  float spring = smoothstep(0.0, 1.0, p);
  vec3 wp = position;
  vec2 w = windAt(aT.xy, uTime);
  wp.xz += w * aT.z * aT.z * (0.04 + 0.16 * spring);
  vWorld = wp; vN = normal; vT = aT; vP = p;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const TRUNK_FRAG = /* glsl */`
${TREE_GLSL}
varying vec3 vWorld; varying vec3 vN; varying vec4 vT; varying float vP;
void main() {
  vec3 wp = vWorld; vec3 N = normalize(vN);
  float spring = smoothstep(0.0, 1.0, vP);
  float streak = vnoise(vec2((wp.x + wp.z) * 2.3, wp.y * 0.35)) * 0.6 + vnoise(vec2((wp.x - wp.z) * 6.0, wp.y * 1.3)) * 0.4;
  vec3 alb = s2l(vec3(0.25, 0.235, 0.24)) * (0.6 + 0.55 * streak);   // cool grey-brown bark
  alb = mix(alb, s2l(vec3(0.30, 0.42, 0.22)), spring * smoothstep(0.1, -0.5, dot(N, uSunDir)) * 0.5);
  float snow = smoothstep(0.30, 0.6, N.y + (vnoise(wp.xz * 5.0 + wp.y) - 0.5) * 0.35) * (1.0 - smoothstep(0.1, 0.9, vP));
  alb = mix(alb, C_SNOW * 0.9, snow);
  float sh = sunShadow(wp + N * 0.06, 1.5);
  vec3 col = shadeSurface(alb, N, wp, 0.25, vT.w, 0.0, sh) + alb * uSunColor * 0.09 * vT.w;
  col = applyFog(col, wp);
  gl_FragColor = vec4(col, 1.0);
}`;

// ---- forest instances (conifers + broadleaf clumps share one vertex shader)
const FOREST_VERT = /* glsl */`
${TREE_GLSL}
attribute vec4 aP;     // base xyz, height
attribute vec4 aR;     // rotation, width scale, seed, colour variation
attribute vec4 aPart;  // y (0..1), ao, underside/trunk flag, part id
varying vec3 vWorld; varying vec3 vN; varying vec4 vPart; varying vec4 vI;
void main() {
  float c = cos(aR.x), s = sin(aR.x);
  mat2 rot = mat2(c, s, -s, c);
  // per-instance silhouette variation: tier spacing (y exponent), taper, lean
  float h1 = fract(aR.z * 7.13), h2 = fract(aR.z * 13.37), h3 = fract(aR.z * 3.71);
  vec3 lp = position;
  float yk = mix(0.85, 1.2, h1);
  float yy = max(lp.y, 0.0);
  lp.y = lp.y < 0.0 ? lp.y : pow(yy, yk);
  float taper = mix(1.0 + (h2 - 0.4) * 0.35, 1.0 - (h2 - 0.4) * 0.35, clamp(yy, 0.0, 1.0));
  lp.xz = rot * (lp.xz * aR.y * taper);
  lp.xz += (vec2(h3, fract(h3 * 5.3)) - 0.5) * 0.06 * yy * yy;
  vec3 n = normal; n.xz = rot * (n.xz / (aR.y * taper));
  float p = bloomP(aP.xz);
  float spring = smoothstep(0.0, 1.0, p);
  vec3 wp = aP.xyz + lp * aP.w;
  vec2 w = windAt(aP.xz, uTime);
  wp.xz += w * position.y * position.y * aP.w * (0.002 + 0.006 * spring);
  vWorld = wp; vN = normalize(n); vPart = aPart; vI = vec4(p, aR.z, aR.w, aP.w);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const FOREST_FRAG = /* glsl */`
${TREE_GLSL}
float farK0(float d) { return smoothstep(900.0, 2500.0, d); }
varying vec3 vWorld; varying vec3 vN; varying vec4 vPart; varying vec4 vI;
#ifndef DEPTH_PASS
${FOLIAGE_GLSL}
#endif
void main() {
#ifdef DEPTH_PASS
  gl_FragColor = vec4(1.0);
#else
  vec3 wp = vWorld; vec3 N = normalize(vN);
  float dist = length(cameraPosition - wp);
  float y01 = vPart.x, ao = vPart.y, under = vPart.z;
  // needle-clump normal breakup (painterly masses instead of flat facets)
  N = normalize(N + (vec3(vnoise3(wp * 0.7), vnoise3(wp * 0.7 + 5.1), vnoise3(wp * 0.7 + 9.7)) - 0.5) * 0.55 * (1.0 - farK0(dist)));
  float p = vI.x, seed = vI.y, var = vI.z;
  float nn = vnoise(wp.xz * 1.9 + wp.y * 1.3);
  float jit = (vnoise(wp.xz * 0.35 + wp.y * 0.25) - 0.5) * 0.25 + (seed - 0.5) * 0.12;
  float fh = -0.25 + 1.5 * p;
  float green = smoothstep(fh + 0.08, fh - 0.08, y01 + jit);
  float fresh = smoothstep(0.3, 1.2, p) * exp(-max(p - 1.2, 0.0) * 0.45);
  float farK = smoothstep(700.0, 2600.0, dist);
  float sh = sunShadow(wp + N * (0.25 + dist * 0.0015), 2.0);
  // per-tree hue (+-6 %) and value jitter
  float hj = fract(seed * 23.17 + var * 3.7) * 2.0 - 1.0, vj = fract(seed * 41.3) * 2.0 - 1.0;
  vec3 hue = vec3(1.0 + 0.06 * hj, 1.0 + 0.015 * vj, 1.0 - 0.06 * hj) * (1.0 + 0.08 * vj);
  vec3 col;
  if (under > 1.5) {          // trunk
    vec3 alb = mix(s2l(vec3(0.26, 0.22, 0.21)), s2l(vec3(0.62, 0.66, 0.76)), (1.0 - green) * 0.25);
    col = shadeSurface(alb, N, wp, 0.3, 0.6, 0.0, sh);
  } else {
#ifdef CONIFER
    // winter: snow on the inner/upper part of each tier, drooping tips stay dark;
    // far away it thins so the belts read as dark masses
    float rad = vPart.w;
    float snowW = (1.0 - smoothstep(0.36, 0.58, rad + (nn - 0.5) * 0.4 + farK * 0.1)) * smoothstep(0.35, 0.6, N.y) * (1.0 - under);
    // spring: snow remnants linger on the shaded upper faces (more with altitude)
    float sunF = clamp(dot(N, uSunDir), 0.0, 1.0) * sh;
    float remn = smoothstep(0.55, 0.8, N.y + (nn - 0.5) * 0.35) * (1.0 - smoothstep(0.2, 0.5, sunF)) * smoothstep(0.42, 0.58, nn)
               * mix(0.4, 1.0, smoothstep(150.0, 800.0, wp.y)) * (1.0 - under) * (1.0 - smoothstep(0.45, 0.85, rad)) * (1.0 - farK);
    float snow = max(snowW * (1.0 - green), remn * green);
    // needles: #2E5A45 body, warm sunlit tips, cool teal shadow side
    vec3 nBase = s2l(vec3(0.165, 0.33, 0.225)) * hue;
    vec3 tipC = mix(s2l(vec3(0.42, 0.56, 0.24)), C_CHARTREUSE, 0.35 * fresh) * hue;
    float tipM = ao * ao * ao * (0.35 + 0.65 * nn);
    vec3 sTop = mix(nBase * 1.18, tipC, tipM * 0.8);
    vec3 sMid = nBase * (0.9 + 0.25 * tipM);
    vec3 sShade = s2l(vec3(0.14, 0.28, 0.22)) * hue;
    vec3 wTop = s2l(vec3(0.30, 0.40, 0.39)), wMid = s2l(vec3(0.20, 0.30, 0.29)), wShade = s2l(vec3(0.15, 0.24, 0.24));
    vec3 aT = mix(wTop, sTop, green), aM = mix(wMid, sMid, green), aS = mix(wShade, sShade, green);
    aT = mix(aT, C_SNOW, snow); aM = mix(aM, mix(C_SNOW, SNOW_SHADE, 0.5), snow); aS = mix(aS, SNOW_SHADE * 0.9, snow);
    vec3 tr = mix(vec3(0.03, 0.05, 0.05), C_CHARTREUSE * 0.3, green);
    col = foliageBands(aT, aM, aS, tr, N, wp, ao * mix(0.65, 0.35, under), sh * mix(1.0, 0.5, under), 0.2, 0.3);
    if (uTreeDbg > 3.5) { gl_FragColor = vec4(snow > 0.5 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 0.0, 1.0), 1.0); return; }
    if (uTreeDbg > 2.5) { gl_FragColor = vec4(N.y < 0.33 ? vec3(1.0, 0.0, 0.0) : N.y < 0.66 ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0), 1.0); return; }
    if (uTreeDbg > 1.5) { gl_FragColor = vec4(rad < 0.33 ? vec3(1.0, 0.0, 0.0) : rad < 0.66 ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0), 1.0); return; }
    if (uTreeDbg > 0.5) { gl_FragColor = vec4(snow, green, rad, 1.0); return; }
#else
    if (uTreeDbg > 0.5) { gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0); return; }
    // winter: dark foliage with snow caps on the up-facing lobes
    float snow = smoothstep(0.45, 0.62, N.y + (nn - 0.5) * 0.4) * (1.0 - green);
    float lv = clamp(var * 0.6 + nn * 0.45 + fresh * 0.3 - 0.15, 0.0, 1.0);
    vec3 sTop = mix(s2l(vec3(0.34, 0.53, 0.20)), s2l(vec3(0.46, 0.63, 0.23)), lv) * hue;
    vec3 sMid = mix(s2l(vec3(0.18, 0.38, 0.19)), s2l(vec3(0.25, 0.45, 0.19)), lv) * hue;
    vec3 sShade = s2l(vec3(0.17, 0.36, 0.28)) * hue;
    vec3 wTop = s2l(vec3(0.36, 0.45, 0.43)), wMid = s2l(vec3(0.25, 0.35, 0.31)), wShade = s2l(vec3(0.20, 0.31, 0.245));
    vec3 aT = mix(wTop, sTop, green), aM = mix(wMid, sMid, green), aS = mix(wShade, sShade, green);
    aT = mix(aT, C_SNOW, snow); aM = mix(aM, mix(C_SNOW, SNOW_SHADE, 0.45), snow); aS = mix(aS, SNOW_SHADE, snow);
    vec3 tr = mix(vec3(0.05, 0.06, 0.07), C_CHARTREUSE * 0.6, green);
    col = foliageBands(aT, aM, aS, tr, N, wp, ao * (0.45 + 0.45 * nn), sh * (0.8 + 0.2 * nn), 0.35, 0.5);
#endif
    col += fresh * green * C_CHARTREUSE * (uSunColor * 0.02 + uSkyAmbient * 0.04) * (0.5 + 0.5 * N.y);
  }
  col = applyFog(col, wp);
  gl_FragColor = vec4(col, 1.0);
#endif
}`;

// ---------------------------------------------------------------- textures
function makeLeafAtlas() {
  const S = 512, cv = document.createElement('canvas');
  cv.width = cv.height = S * 2;
  const g = cv.getContext('2d');
  const R = rng(20261);
  for (let cell = 0; cell < 4; cell++) {
    const ox = (cell % 2) * S, oy = Math.floor(cell / 2) * S;
    g.save(); g.beginPath(); g.rect(ox, oy, S, S); g.clip();
    const n = 13 + Math.floor(R() * 5);
    const leaves = [];
    for (let k = 0; k < n; k++) {
      const a = R() * Math.PI * 2, rr = Math.pow(R(), 0.6) * S * 0.27;
      const len = S * (0.16 + R() * 0.06), wid = len * (0.40 + R() * 0.12);
      leaves.push({ x: ox + S / 2 + Math.cos(a) * rr, y: oy + S / 2 + Math.sin(a) * rr, ang: a + (R() - 0.5) * 1.4, len, wid, sh: 0.5 + R() * 0.5, id: R() });
    }
    for (const lf of leaves) drawLeaf(g, lf);
    g.restore();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4; tex.premultiplyAlpha = false; tex.needsUpdate = true;
  return tex;
}
function drawLeaf(g, { x, y, ang, len, wid, sh, id }) {
  g.save(); g.translate(x, y); g.rotate(ang);
  const L2 = len / 2, w = wid / 2, B = Math.round(id * 255);
  for (const half of [-1, 1]) {   // folded leaf: two halves, G marks the shaded half
    const grad = g.createLinearGradient(-L2, 0, L2, 0);
    grad.addColorStop(0, `rgb(${Math.round(sh * 150)},${half > 0 ? 255 : 0},${B})`);
    grad.addColorStop(1, `rgb(${Math.round(sh * 255)},${half > 0 ? 255 : 0},${B})`);
    g.fillStyle = grad;
    g.beginPath(); g.moveTo(-L2, 0);
    g.bezierCurveTo(-L2 * 0.45, half * w * 1.25, L2 * 0.35, half * w * 1.05, L2, 0);
    g.closePath(); g.fill();
  }
  g.strokeStyle = `rgb(${Math.round(sh * 110)},128,${B})`; g.lineWidth = 3;
  g.beginPath(); g.moveTo(-L2 - len * 0.12, 0); g.lineTo(-L2 + 2, 0); g.stroke();
  g.restore();
}

// ---------------------------------------------------------------- geometry helpers
function icosphere(detail) {
  const t = (1 + Math.sqrt(5)) / 2;
  const v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(norm3);
  let f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let d = 0; d < detail; d++) {
    const cache = new Map(), nf = [];
    const mid = (a, b) => { const k = a < b ? a * 65536 + b : b * 65536 + a; if (cache.has(k)) return cache.get(k); v.push(norm3([(v[a][0] + v[b][0]) / 2, (v[a][1] + v[b][1]) / 2, (v[a][2] + v[b][2]) / 2])); cache.set(k, v.length - 1); return v.length - 1; };
    for (const [a, b, c] of f) { const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a); nf.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]); }
    f = nf;
  }
  // make every face wind CCW seen from outside
  f = f.map(([a, b, c]) => {
    const A = v[a], B = v[b], C = v[c];
    const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    return n[0] * A[0] + n[1] * A[1] + n[2] * A[2] < 0 ? [a, c, b] : [a, b, c];
  });
  return { v, f };
}
function sphereGeo(detail) {
  const { v, f } = icosphere(detail);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v.flat(), 3));
  g.setIndex(f.flat());
  return g;
}

// append a tube along pts (with radii) to a merged-geometry builder
function addTube(B, pts, radii, sides, attr) {
  const base = B.pos.length / 3;
  let prevB1 = null;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const t = norm3([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    let b1;
    if (prevB1) { const d = prevB1[0] * t[0] + prevB1[1] * t[1] + prevB1[2] * t[2]; b1 = norm3([prevB1[0] - t[0] * d, prevB1[1] - t[1] * d, prevB1[2] - t[2] * d]); }
    else b1 = norm3(cross(t, Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
    const b2 = cross(t, b1);
    prevB1 = b1;
    for (let s = 0; s < sides; s++) {
      const th = s / sides * Math.PI * 2, c = Math.cos(th), sn = Math.sin(th);
      const n = [b1[0] * c + b2[0] * sn, b1[1] * c + b2[1] * sn, b1[2] * c + b2[2] * sn];
      const r = radii[i];
      B.pos.push(pts[i][0] + n[0] * r, pts[i][1] + n[1] * r, pts[i][2] + n[2] * r);
      B.nrm.push(...n);
      B.at.push(...attr(i / (pts.length - 1), pts[i]));
    }
  }
  for (let i = 0; i < pts.length - 1; i++) for (let s = 0; s < sides; s++) {
    const a = base + i * sides + s, b = base + i * sides + (s + 1) % sides, c = a + sides, d = b + sides;
    B.idx.push(a, b, d, a, d, c);
  }
}
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// stylised conifer: stacked star-skirted tiers (unit height). rMul widens the skirts,
// droop pulls the tier tips down (spruce: narrow/stiff, fir: broad/drooping)
function buildConifer({ tiers, K, mid, under, trunk, rMul = 1, droop = 0.03 }) {
  const pos = [], nrm = [], part = [], idx = [];
  const add = (p, n, a) => { pos.push(...p); nrm.push(...n); part.push(...a); return pos.length / 3 - 1; };
  if (trunk) {
    const s = 6, b = pos.length / 3;
    for (let i = 0; i < 2; i++) for (let k = 0; k < s; k++) {
      const th = k / s * Math.PI * 2, r = i ? 0.018 : 0.03;
      add([Math.cos(th) * r, i ? 0.35 : -0.05, Math.sin(th) * r], [Math.cos(th), 0, Math.sin(th)], [i * 0.3, 0.6, 2, 0]);
    }
    for (let k = 0; k < s; k++) { const a = b + k, c = b + (k + 1) % s; idx.push(a, a + s, c + s, a, c + s, c); }
  }
  for (let i = 0; i < tiers; i++) {
    const f = i / tiers;
    const yb = 0.10 + 0.76 * Math.pow(f, 0.92);
    const yt = i === tiers - 1 ? 1.0 : yb + 0.30 * (1 - 0.4 * f);
    const Rr = (0.29 * Math.pow(1 - yb, 0.9) + 0.04) * rMul;
    const off = i * 0.9 + 0.3;
    const aoT = 0.65 + 0.35 * f;
    const ring = [], midR = [], dirs = [];
    for (let j = 0; j < 2 * K; j++) {
      const th = off + j * Math.PI / K, tip = j % 2 === 0;
      const rr = tip ? Rr : Rr * 0.66, yy = tip ? yb - droop * (1 - 0.5 * f) : yb + 0.03;
      const d = [Math.cos(th), 0, Math.sin(th)]; dirs.push([d, rr, yy, tip]);
      // rim normals lean outward (sides catch the sun), mid/apex normals lean up
      ring.push(add([d[0] * rr, yy, d[2] * rr], norm3([d[0], tip ? 0.28 : 0.42, d[2]]), [yy, (tip ? 1.0 : 0.7) * aoT, 0, tip ? 1.0 : 0.66]));
      if (mid) { const mr = rr * 0.5, my = yt - (yt - yy) * 0.42; midR.push(add([d[0] * mr, my, d[2] * mr], norm3([d[0] * 0.75, 0.7, d[2] * 0.75]), [my, 0.88 * aoT, 0, 0.5])); }
    }
    for (let j = 0; j < 2 * K; j++) {
      const j1 = (j + 1) % (2 * K);
      // one apex vertex per fan triangle so its normal can tilt toward that face
      const th = off + (j + 0.5) * Math.PI / K;
      const apex = add([0, yt, 0], norm3([Math.cos(th) * 0.55, 0.85, Math.sin(th) * 0.55]), [yt, 0.95 * aoT + 0.05, 0, 0]);
      if (mid) idx.push(apex, midR[j1], midR[j], midR[j], midR[j1], ring[j1], midR[j], ring[j1], ring[j]);
      else idx.push(apex, ring[j1], ring[j]);
    }
    if (under) {
      const c = add([0, yb + 0.08, 0], [0, -1, 0], [yb, 0.25, 1, 0]);
      const ru = dirs.map(([d, rr, yy]) => add([d[0] * rr, yy, d[2] * rr], norm3([d[0] * 0.6, -0.8, d[2] * 0.6]), [yy, 0.4 * aoT, 1, 1]));
      for (let j = 0; j < 2 * K; j++) idx.push(c, ru[j], ru[(j + 1) % (2 * K)]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 4));
  g.setIndex(idx);
  return g;
}

// round broadleaf clump: overlapping lumpy lobes with outward-bent normals (unit height)
function buildBlob({ lobes, detail, trunk, seed }) {
  const R = rng(seed);
  const ico = icosphere(detail);
  const pos = [], nrm = [], part = [], idx = [];
  const cc = [0, 0.6, 0], rad = [0.40, 0.33, 0.40];
  const L0 = [{ c: [0, 0.64, 0], r: 0.27 }];
  const dirs = [];
  for (let k = 0; dirs.length < lobes - 1 && k < 500; k++) {
    const y = 1 - Math.pow(R(), 0.85) * 1.4, ph = R() * Math.PI * 2, s = Math.sqrt(Math.max(0, 1 - y * y));
    const d = [Math.cos(ph) * s, y, Math.sin(ph) * s];
    if (dirs.some(e => e[0] * d[0] + e[1] * d[1] + e[2] * d[2] > 0.55)) continue;
    dirs.push(d);
  }
  for (const d of dirs) L0.push({ c: [cc[0] + d[0] * rad[0] * 0.62, cc[1] + d[1] * rad[1] * 0.6, cc[2] + d[2] * rad[2] * 0.62], r: 0.19 + R() * 0.06 });
  if (trunk) {
    const s = 5, b = pos.length / 3;
    for (let i = 0; i < 2; i++) for (let k = 0; k < s; k++) {
      const th = k / s * Math.PI * 2, r = i ? 0.025 : 0.04;
      pos.push(Math.cos(th) * r, i ? 0.5 : -0.05, Math.sin(th) * r); nrm.push(Math.cos(th), 0, Math.sin(th)); part.push(i * 0.45, 0.5, 2, 0);
    }
    for (let k = 0; k < s; k++) { const a = b + k, c = b + (k + 1) % s; idx.push(a, a + s, c + s, a, c + s, c); }
  }
  L0.forEach((lb, li) => {
    const b = pos.length / 3, ph = R() * 10;
    for (const v of ico.v) {
      const lump = 1 + 0.12 * Math.sin(v[0] * 5 + ph) * Math.sin(v[1] * 4 + ph * 1.3) * Math.sin(v[2] * 5 - ph);
      const p = [lb.c[0] + v[0] * lb.r * lump, lb.c[1] + v[1] * lb.r * lump * 0.92, lb.c[2] + v[2] * lb.r * lump];
      const cn = norm3([(p[0] - cc[0]) / rad[0], (p[1] - cc[1]) / rad[1], (p[2] - cc[2]) / rad[2]]);
      const n = norm3([v[0] * 0.7 + cn[0] * 0.3, v[1] * 0.7 + cn[1] * 0.3, v[2] * 0.7 + cn[2] * 0.3]);
      const out = Math.hypot((p[0] - cc[0]) / rad[0], (p[1] - cc[1]) / rad[1], (p[2] - cc[2]) / rad[2]);
      const ao = (0.35 + 0.65 * smooth(0.45, 1.05, out)) * (0.6 + 0.4 * (v[1] * 0.5 + 0.5));
      pos.push(...p); nrm.push(...n); part.push(Math.min(1, Math.max(0, (p[1] - 0.3) / 0.65)), ao, 0, li);
    }
    for (const [a, c, d] of ico.f) idx.push(b + a, b + c, b + d);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 4));
  g.setIndex(idx);
  return g;
}

function instanced(base, attrs, count) {
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index;
  for (const k in base.attributes) g.setAttribute(k, base.attributes[k]);
  for (const [k, arr, size] of attrs) g.setAttribute(k, new THREE.InstancedBufferAttribute(arr, size));
  g.instanceCount = count;
  return g;
}
function sphereOf(points, pad) { // points: flat xyz array (stride 3 or with stride)
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const p of points) box.expandByPoint(v.set(p[0], p[1], p[2]));
  const s = box.getBoundingSphere(new THREE.Sphere());
  s.radius += pad;
  return s;
}

// ---------------------------------------------------------------- hero grove
function makeTreeLocal(R, H) {
  const crownR = H * lerp(TUNE.crownW[0], TUNE.crownW[1], R()), crownRv = H * (0.36 + R() * 0.05);
  const cy = H - crownRv * 1.02;
  const lean = [(R() - 0.5) * 0.08, (R() - 0.5) * 0.08];
  const clumps = [{ c: [0, cy + crownRv * 0.08, 0], r: crownR * 0.56, inner: true, dir: [0, 1, 0] }];
  const n = 10 + Math.floor(R() * 4) + (H > 13 ? 2 : 0);
  const dirs = [];
  for (let k = 0; dirs.length < n && k < 3000; k++) {
    const y = 1 - Math.pow(R(), 0.8) * 1.55, ph = R() * Math.PI * 2, s = Math.sqrt(Math.max(0, 1 - y * y));
    const d = [Math.cos(ph) * s, y, Math.sin(ph) * s];
    if (dirs.some(e => e[0] * d[0] + e[1] * d[1] + e[2] * d[2] > 0.80)) continue;
    dirs.push(d);
  }
  for (const d of dirs) {
    const rc = crownR * (0.40 + R() * 0.12) * (d[1] < -0.2 ? 0.82 : 1);
    clumps.push({ c: [d[0] * crownR * 0.64, cy + d[1] * crownRv * 0.62, d[2] * crownR * 0.64], r: rc, dir: d });
  }
  for (const c of clumps) { c.c[0] += lean[0] * c.c[1]; c.c[2] += lean[1] * c.c[1]; }
  return { H, crownR, crownRv, cy, clumps, lean };
}

function clearOK(loc, x, y, z, sc, cams) {
  const m = TUNE.camClear;
  for (const [cx, cy, cz] of cams) {
    const dh = Math.hypot(cx - x, cz - z);
    if (dh > loc.crownR * 1.4 * sc + m + 2) continue;
    for (const c of loc.clumps) {
      const px = x + c.c[0] * sc, py = y + c.c[1] * sc, pz = z + c.c[2] * sc;
      const rad = c.r * sc * 1.08 + 0.4 + m;
      if ((cx - px) ** 2 + (cy - py) ** 2 + (cz - pz) ** 2 < rad * rad) return false;
    }
    if (dh < 1.6 + loc.H * 0.05 * sc && cy < y + loc.cy * sc) return false;
  }
  return true;
}

function buildGrove(ctx) {
  const { data, rig, TIMES } = ctx;
  const G = L.GROVE, R = rng(91173);
  const cams = [];
  for (let t = 10.5; t < TIMES.cut4 + 1.2; t += 0.004) {
    const c = rig.at(t);
    if (Math.hypot(c.pos.x - G.x, c.pos.z - G.z) < G.r + 30) cams.push([c.pos.x, c.pos.y, c.pos.z]);
  }
  const spots = [];
  for (let k = 0; k < 10000 && spots.length < TUNE.groveCount; k++) {
    const a = R() * Math.PI * 2, rr = TUNE.groveR * Math.sqrt(R());
    const x = G.x + Math.cos(a) * rr, z = G.z + Math.sin(a) * rr;
    const minD = TUNE.groveSpacing * (0.88 + 0.24 * R());
    if (spots.some(s => Math.hypot(s.x - x, s.z - z) < minD)) continue;
    spots.push({ x, z, d: rr });
  }
  const trees = [];
  for (const s of spots) {
    const H0 = lerp(TUNE.groveH[0], TUNE.groveH[1], 1 - Math.pow(Math.min(1, s.d / TUNE.groveR), 2)) * (0.9 + 0.2 * R());
    const loc = makeTreeLocal(R, H0);
    const by = data.heightAt(s.x, s.z) - 0.25;
    let sc = 1.0;
    for (; sc >= 0.45; sc -= 0.025) if (clearOK(loc, s.x, by, s.z, sc, cams)) break;
    if (sc < 0.45) continue;
    trees.push({ x: s.x, z: s.z, y: by, sc, loc });
  }
  const flush = planFlush(ctx, trees);

  // ---- build buffers
  const cards = { pos: [], nrm: [], tree: [], rnd: [], fl: [] };
  const cores = { c: [], tree: [], rnd: [], fl: [] };
  const pills = { c: [], tree: [], rnd: [], fl: [] };
  const trunk = { pos: [], nrm: [], at: [], fl: [], idx: [] };
  const bounds = [], shed = [];
  for (const T of trees) {
    const { loc, sc } = T;
    const th = loc.H * sc;
    const treeAttr = [T.x, T.z, T.y, th];
    const W = c => [T.x + c[0] * sc, T.y + c[1] * sc, T.z + c[2] * sc];
    const crownC = W([loc.lean[0] * loc.cy, loc.cy, loc.lean[1] * loc.cy]);
    const cR = loc.crownR * sc, cRv = loc.crownRv * sc;
    const yBot = crownC[1] - cRv * 0.95, yTop = crownC[1] + cRv * 1.1;
    const y01 = y => Math.min(1, Math.max(0, (y - yBot) / (yTop - yBot)));
    const CL = loc.clumps.map(c => ({ ...c, w: W(c.c), rw: c.r * sc, tint: Math.floor(R() * 8) }));
    bounds.push([T.x, T.y + th * 0.5, T.z]);
    const tPills = [];
    for (const [ci, c] of CL.entries()) {
      const rc = c.rw;
      // core
      cores.c.push(...c.w, rc * (c.inner ? 0.8 : TUNE.coreScale));
      cores.tree.push(...treeAttr);
      const cOut = Math.hypot((c.w[0] - crownC[0]) / cR, (c.w[1] - crownC[1]) / cRv, (c.w[2] - crownC[2]) / cR);
      cores.rnd.push(R(), y01(c.w[1]), 0.35 + 0.25 * Math.min(1, cOut), c.tint / 8);
      cores.fl.push(T.tF);
      // snow pillow (only where the clump top is not buried in another clump)
      const top = [c.w[0], c.w[1] + rc, c.w[2]];
      const buried = CL.some((o, oi) => oi !== ci && Math.hypot(top[0] - o.w[0], top[1] - o.w[1], top[2] - o.w[2]) < o.rw * 0.92);
      if (!buried && c.dir[1] > -0.1) {
        const pr0 = R(), pr1 = R();   // drawn for every candidate so the card layout stays put
        if (c.dir[1] > 0.25) {        // pillows only on the upper puffs: dark foliage shows between them
        const py = c.w[1] + rc * 0.64, py01 = y01(c.w[1] + rc * 0.5);
        pills.c.push(c.w[0], py, c.w[2], rc * 0.56);
        pills.tree.push(...treeAttr);
        pills.rnd.push(pr0, 0.44 + pr1 * 0.12, py01, 0);
        pills.fl.push(T.tF);
        // shed time: when the green front reaches the pillow (matches PILLOW_VERT pS)
        tPills.push({ x: c.w[0], y: py + rc * 0.2, z: c.w[2], r: rc * 0.56, t: T.tF + TUNE.flushDur * ((py01 + 0.22) / 1.45 + 0.04) });
        }
      }
      // leaf cards
      const n = Math.round(rc * rc * TUNE.cardDensity * (c.inner ? 0.45 : 1));
      for (let k = 0; k < n; k++) {
        const u = R() * 2 - 1, ph = R() * Math.PI * 2, s = Math.sqrt(1 - u * u);
        const d = [Math.cos(ph) * s, u, Math.sin(ph) * s];
        const rr = rc * (0.68 + 0.32 * Math.sqrt(R()));
        const p = [c.w[0] + d[0] * rr, c.w[1] + d[1] * rr, c.w[2] + d[2] * rr];
        if (CL.some((o, oi) => oi !== ci && Math.hypot(p[0] - o.w[0], p[1] - o.w[1], p[2] - o.w[2]) < o.rw * 0.8)) continue;
        const cn = norm3([(p[0] - crownC[0]) / cR, (p[1] - crownC[1]) / cRv, (p[2] - crownC[2]) / cR]);
        const nrm = norm3([d[0] * 0.72 + cn[0] * 0.28, d[1] * 0.72 + cn[1] * 0.28, d[2] * 0.72 + cn[2] * 0.28]);
        const cd = Math.hypot((p[0] - crownC[0]) / (cR * 1.15), (p[1] - crownC[1]) / (cRv * 1.15), (p[2] - crownC[2]) / (cR * 1.15));
        // creases where puffs meet read as dark seams (the Ghibli cauliflower look)
        let crease = 1;
        for (const [oi, o] of CL.entries()) {
          if (oi === ci) continue;
          const dj = Math.hypot(p[0] - o.w[0], p[1] - o.w[1], p[2] - o.w[2]) / o.rw;
          if (dj < 1.15) crease = Math.min(crease, lerp(0.45, 1, smooth(0.8, 1.15, dj)));
        }
        const under = 0.5 + 0.5 * smooth(0.0, 0.55, y01(p[1]));   // darker crown underside
        const ao = Math.max(0.08, crease * under * (0.3 + 0.7 * smooth(0.6, 1.0, rr / rc)) * (0.42 + 0.58 * smooth(0.25, 0.95, cd)) * (0.72 + 0.28 * (nrm[1] * 0.5 + 0.5)));
        cards.pos.push(...p, TUNE.cardSize * (0.85 + 0.3 * R()));
        cards.nrm.push(...nrm, ao);
        cards.tree.push(...treeAttr);
        cards.rnd.push(R() * Math.PI * 2, (Math.floor(R() * 4) % 4) + 4 * c.tint, R(), y01(p[1]));
        cards.fl.push(T.tF);
      }
    }
    // shed points for the fx puffs: the highest few snow pillows of this crown
    tPills.sort((a, b) => b.y - a.y);
    for (const sp of tPills.slice(0, TUNE.shedPerTree)) shed.push(sp);
    // trunk + limbs
    const r0 = 0.05 * loc.H * Math.sqrt(sc);
    const tTop = loc.cy + loc.crownRv * 0.1;
    const tPts = [], tRad = [];
    const bend = [(R() - 0.5) * 0.06, (R() - 0.5) * 0.06];
    for (let i = 0; i <= 6; i++) {
      const f = i / 6, yy = -0.4 / sc + f * (tTop + 0.4 / sc);
      const sw = Math.sin(f * Math.PI) * loc.H;
      tPts.push(W([loc.lean[0] * yy + bend[0] * sw, yy, loc.lean[1] * yy + bend[1] * sw]));
      tRad.push(r0 * (1 - 0.55 * f) * (1 + 0.7 * Math.exp(-Math.max(0, yy) * sc / (0.5 + r0))));
    }
    const at = (f, p) => [T.x, T.z, Math.max(0, (p[1] - T.y) / th), 0.55 + 0.45 * (1 - f)];
    addTube(trunk, tPts, tRad, 8, at);
    const limbs = CL.filter(c => !c.inner && c.dir[1] < 0.6).slice(0, 5);
    for (const c of limbs) {
      const f0 = 0.45 + R() * 0.3;
      const s0 = tPts[Math.round(f0 * 6)];
      const e = [lerp(s0[0], c.w[0], 0.85), lerp(s0[1], c.w[1], 0.85), lerp(s0[2], c.w[2], 0.85)];
      const ctl = [lerp(s0[0], e[0], 0.5), Math.max(s0[1], e[1]) + c.rw * 0.3, lerp(s0[2], e[2], 0.5)];
      const pts = [], rad = [];
      for (let i = 0; i <= 4; i++) {
        const f = i / 4, a = (1 - f) * (1 - f), b = 2 * f * (1 - f), cc = f * f;
        pts.push([a * s0[0] + b * ctl[0] + cc * e[0], a * s0[1] + b * ctl[1] + cc * e[1], a * s0[2] + b * ctl[2] + cc * e[2]]);
        rad.push(r0 * 0.5 * (1 - 0.7 * f));
      }
      addTube(trunk, pts, rad, 6, at);
    }
    while (trunk.fl.length < trunk.pos.length / 3) trunk.fl.push(T.tF);
  }
  shed.sort((a, b) => a.t - b.t);
  return { trees, cards, cores, pills, trunk, bounds, shed, flush };
}

// Hero-grove flush schedule. The grove holds its winter (dark foliage + snow caps)
// until the camera reaches the grove face at the canopy cut; then a front starts at
// the face (cut3 + flushDelay) and races through the grove along the camera's path at
// flushSpeed (faster than the camera), so crowns flush front-to-back with per-tree
// jitter, and their tops go green / shed their snow just ahead of the lens. Each crown
// flushes bottom-up over flushDur (see heroFoliage / PILLOW_VERT).
function planFlush(ctx, trees) {
  const { rig, TIMES } = ctx;
  const T0 = TIMES.cut3, T1 = TIMES.cut4 - 1e-3;
  const a = rig.at(T0).pos, ax = a.x, az = a.z;
  const b = rig.at(T1).pos, bx = b.x, bz = b.z;
  const dl = Math.hypot(bx - ax, bz - az) || 1, ux = (bx - ax) / dl, uz = (bz - az) / dl;
  const S = [];
  let smax = -1e9;
  for (let t = T0; t <= T1 + 1e-9; t += 0.005) {
    const p = rig.at(Math.min(t, T1)).pos;
    smax = Math.max(smax, (p.x - ax) * ux + (p.z - az) * uz);
    S.push([t, smax]);
  }
  const v0 = Math.max(15, (S[20][1] - S[0][1]) / (S[20][0] - S[0][0]));
  const vEnd = Math.max(15, (S[S.length - 1][1] - S[S.length - 21][1]) / (S[S.length - 1][0] - S[S.length - 21][0]));
  const camT = s => {
    if (s <= S[0][1]) return T0 + (s - S[0][1]) / v0;
    for (let i = 1; i < S.length; i++) if (S[i][1] >= s) {
      const [ta, sa] = S[i - 1], [tb, sb] = S[i];
      return ta + (tb - ta) * (s - sa) / Math.max(sb - sa, 1e-6);
    }
    return T1 + (s - S[S.length - 1][1]) / vEnd;
  };
  const R = rng(5150);
  const sOf = T => (T.x - ax) * ux + (T.z - az) * uz;
  const sFace = Math.min(...trees.map(sOf));
  for (const T of trees) {
    const s = sOf(T);
    // front starts at the grove face just after the cut and races ahead of the camera;
    // never let a crown still be unflushed when the camera passes over it
    let t = T0 + TUNE.flushDelay + (s - sFace) / TUNE.flushSpeed;
    t = Math.min(t, camT(s) - TUNE.flushDur * 0.6);
    T.tF = Math.max(T0 + TUNE.flushDelay, t) + R() * TUNE.flushJitter;
  }
  return { T0, ux, uz, ax, az };
}

// ---------------------------------------------------------------- forest placement + per-shot culling
function placeForest(ctx, heroTrees) {
  const { data } = ctx;
  const F = data.FAR, info = data.info, HAt = data.heightAt;
  const forestAt = (x, z) => {
    const fx = (x - F.minX) / F.sizeX * F.nx - 0.5, fz = (z - F.minZ) / F.sizeZ * F.nz - 0.5;
    const i = Math.floor(fx), j = Math.floor(fz);
    if (i < 0 || j < 0 || i >= F.nx - 1 || j >= F.nz - 1) return 0;
    const u = fx - i, v = fz - j, g = (a, b) => info[(b * F.nx + a) * 4 + 3];
    return (g(i, j) * (1 - u) + g(i + 1, j) * u) * (1 - v) + (g(i, j + 1) * (1 - u) + g(i + 1, j + 1) * u) * v;
  };
  const sp = TUNE.forestSpacing, R = rng(7331);
  const P = [], A = [], kind = [], hero = [];
  const push = (x, y, z, h, rot, wid, seed, vr, k, isHero) => { P.push(x, y, z, h); A.push(rot, wid, seed, vr); kind.push(k); hero.push(isHero ? 1 : 0); };
  for (let gz = -3000; gz <= 3000; gz += sp) for (let gx = -3000; gx <= 3000; gx += sp) {
    const j1 = R(), j2 = R(), acc = R(), s1 = R(), s2 = R(), s3 = R(), s4 = R();
    const x = gx + (j1 - 0.5) * sp * 0.95, z = gz + (j2 - 0.5) * sp * 0.95;
    const m = forestAt(x, z); if (m < 0.04) continue;
    if (Math.hypot(x - L.GROVE.x, z - L.GROVE.z) < L.GROVE.r + 14) continue;
    const r = Math.hypot(x, z);
    // keep the waterfall cliff, its plunge pool and the falls-shot sight line clear
    const dw = L.wrapAngle(Math.atan2(z, x) - L.WATERFALL.phi);
    const lat = Math.abs(dw) > 1.2 ? 1e4 : Math.abs(Math.sin(dw) * r);
    const corridor = smooth(85, 150, lat) + (1 - smooth(1330, 1420, r)) + smooth(1940, 2000, r);
    if (acc > Math.min(1, corridor)) continue;
    const y = HAt(x, z);
    const sl = Math.hypot(HAt(x + 1.5, z) - HAt(x - 1.5, z), HAt(x, z + 1.5) - HAt(x, z - 1.5)) / 3;
    // clumping: stands of trees with small glades between them (painterly masses, not a carpet)
    const cl = 0.6 * vnoise2(x / 52 + 11.3, z / 52 - 4.7) + 0.4 * vnoise2(x / 21 - 3.1, z / 21 + 8.9);
    const clumpK = lerp(TUNE.clumpGlade, 1.25, smooth(0.3, 0.66, cl));
    const prob = Math.min(1, m * 1.35) * smooth(1.2, 0.75, sl) * smooth(1030, 830, y) * clumpK;
    if (acc > prob) continue;
    const zone = smooth(1150, 1550, r);
    const conifer = s1 < 0.06 + 0.92 * zone;
    const hs = hash2(Math.round(gx * 7.3), Math.round(gz * 3.1));
    const hScale = lerp(TUNE.forestScale[0], TUNE.forestScale[1], Math.min(1, 0.55 * hs + 0.5 * smooth(0.28, 0.75, cl)));
    const h = (conifer ? lerp(TUNE.coniferH[0], TUNE.coniferH[1], s2) * (0.6 + 0.4 * smooth(1000, 400, y)) : lerp(TUNE.broadH[0], TUNE.broadH[1], s2)) * hScale;
    const fir = conifer && hash2(Math.round(gz * 5.7) + 17, Math.round(gx * 2.9) - 5) < TUNE.firShare;
    push(x, y - 0.3 - sl * 0.5, z, h, s3 * Math.PI * 2, conifer ? 0.8 + 0.42 * s4 : 0.9 + 0.35 * s4, s4, (s2 + s3) * 0.5, conifer ? (fir ? 2 : 0) : 1, false);
  }
  for (const T of heroTrees) push(T.x, T.y, T.z, T.loc.H * T.sc, T.x * 0.1, 1.15, 0.5, 0.5, 1, true);
  return { P: new Float32Array(P), A: new Float32Array(A), kind: new Uint8Array(kind), hero: new Uint8Array(hero), n: kind.length };
}

function shotRanges(T) {
  return { macro: [0, T.cut2], fpv: [T.cut2, T.cut3], canopy: [T.cut3, T.cut4], reveal: [T.cut4, T.cut5], falls: [T.cut5, T.cut6], aerial: [T.cut6, T.end] };
}

function cullForest(F, ctx, dbgCam) {
  const { rig, TIMES, W, H } = ctx;
  const aspect = W / H;
  const cam = new THREE.PerspectiveCamera(50, aspect, 0.5, 60000);
  const m4 = new THREE.Matrix4();
  const CELL = 96;
  const cells = new Map();
  for (let i = 0; i < F.n; i++) {
    const x = F.P[i * 4], y = F.P[i * 4 + 1], z = F.P[i * 4 + 2], h = F.P[i * 4 + 3];
    const key = Math.floor(x / CELL) * 4096 + Math.floor(z / CELL);
    let c = cells.get(key);
    if (!c) { c = { idx: [], box: new THREE.Box3() }; cells.set(key, c); }
    c.idx.push(i);
    c.box.expandByPoint(new THREE.Vector3(x, y, z)); c.box.expandByPoint(new THREE.Vector3(x, y + h, z));
  }
  for (const c of cells.values()) { c.box.min.x -= 60; c.box.min.z -= 60; c.box.max.x += 60; c.box.max.z += 60; c.box.min.y -= 5; }
  const camSets = {};
  const R = shotRanges(TIMES);
  for (const id of SHOT_IDS) {
    const [t0, t1] = R[id], N = id === 'canopy' ? 8 : 16;
    camSets[id] = [];
    for (let k = 0; k <= N; k++) {
      const c = rig.at(t0 + (t1 - t0 - 1e-3) * k / N);
      camSets[id].push({ pos: c.pos.clone(), target: c.target.clone(), fov: c.fov });
    }
  }
  if (dbgCam) camSets.dbg = [dbgCam];
  const out = {};
  for (const [id, list] of Object.entries(camSets)) {
    const samples = list.map(c => {
      cam.position.copy(c.pos); cam.up.set(0, 1, 0); cam.lookAt(c.target);
      cam.fov = Math.min(170, c.fov * 1.15 + 4); cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
      m4.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      return { fr: new THREE.Frustum().setFromProjectionMatrix(m4), pos: c.pos, k: 1080 / Math.tan(c.fov * Math.PI / 360) };
    });
    const heroShot = id === 'dbg' ? true : HERO_SHOTS.has(id);
    const lodPx = TUNE.lodPxShot[id] || TUNE.lodPx;
    const lists = [[[], [], []], [[], [], []], [[], [], []]];   // [kind: spruce, broadleaf, fir][lod] -> tree indices
    for (const c of cells.values()) {
      if (!samples.some(s => s.fr.intersectsBox(c.box))) continue;
      for (const i of c.idx) {
        if (F.hero[i] && heroShot) continue;
        const x = F.P[i * 4], y = F.P[i * 4 + 1] + F.P[i * 4 + 3] * 0.5, z = F.P[i * 4 + 2], h = F.P[i * 4 + 3];
        let px = 0;
        for (const s of samples) px = Math.max(px, h * s.k / Math.max(1, Math.hypot(x - s.pos.x, y - s.pos.y, z - s.pos.z)));
        const lod = px > lodPx[0] ? 0 : px > lodPx[1] ? 1 : 2;
        lists[F.kind[i]][lod].push(i);
      }
    }
    out[id] = lists;
  }
  return out;
}

// ---------------------------------------------------------------- module
export async function create(ctx) {
  const q = ctx.q || new URLSearchParams();
  const uTreeOfs = { value: +(q.get('treeBloomOfs') || 0) };
  let dbgCam = null;
  if (q.get('treeCam')) {
    const v = q.get('treeCam').split(',').map(Number);
    dbgCam = { pos: new THREE.Vector3(v[0], v[1], v[2]), target: new THREE.Vector3(v[3], v[4], v[5]), fov: v[6] || 50 };
  }
  const uPFloor = { value: -1e4 };
  const extra = { uTreeOfs, uTreeDbg: { value: +(q.get('treeDbg') || 0) }, uFlushDur: { value: TUNE.flushDur }, uPFloor };
  const hide = q.get('treeHide');   // look-dev: 'hero' | 'forest'
  const objects = [];

  // ---- hero grove
  const atlas = makeLeafAtlas();
  const grove = buildGrove(ctx);
  const gSphere = sphereOf(grove.bounds, 16);
  const heroMeshes = [];
  const mk = (geo, mat, depth) => { const m = new THREE.Mesh(geo, mat); geo.boundingSphere = gSphere; castShadow(m, depth); m.renderOrder = -6; objects.push(m); heroMeshes.push(m); return m; };
  {
    const quad = new THREE.BufferGeometry();
    quad.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    quad.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    quad.setIndex([0, 1, 2, 0, 2, 3]);
    const n = grove.cards.pos.length / 4;
    const geo = instanced(quad, [['iPos', new Float32Array(grove.cards.pos), 4], ['iNrm', new Float32Array(grove.cards.nrm), 4], ['iTree', new Float32Array(grove.cards.tree), 4], ['iRnd', new Float32Array(grove.cards.rnd), 4], ['iFl', new Float32Array(grove.cards.fl), 1]], n);
    const { material, depthMaterial } = worldMaterial({ vertexShader: CARD_VERT, fragmentShader: CARD_FRAG, uniforms: { ...extra, tLeaf: { value: atlas } }, side: THREE.DoubleSide, alphaTestInDepth: true });
    // alpha-tested depth prepass (cheap) so the full foliage shading runs ~once per pixel:
    // the colour pass keeps the same invariant vertex shader, tests LessEqual and writes no depth.
    depthMaterial.colorWrite = false;
    const pre = new THREE.Mesh(geo, depthMaterial);
    pre.renderOrder = -5; objects.push(pre); heroMeshes.push(pre);
    material.depthWrite = false;
    mk(geo, material, depthMaterial).renderOrder = -4;
  }
  {
    const sph = sphereGeo(2);
    const n = grove.cores.c.length / 4;
    const geo = instanced(sph, [['iC', new Float32Array(grove.cores.c), 4], ['iTree', new Float32Array(grove.cores.tree), 4], ['iRnd', new Float32Array(grove.cores.rnd), 4], ['iFl', new Float32Array(grove.cores.fl), 1]], n);
    const { material, depthMaterial } = worldMaterial({ vertexShader: CORE_VERT, fragmentShader: CORE_FRAG, uniforms: { ...extra } });
    mk(geo, material, depthMaterial);
  }
  {
    const sph = sphereGeo(2);
    const n = grove.pills.c.length / 4;
    const geo = instanced(sph, [['iC', new Float32Array(grove.pills.c), 4], ['iTree', new Float32Array(grove.pills.tree), 4], ['iRnd', new Float32Array(grove.pills.rnd), 4], ['iFl', new Float32Array(grove.pills.fl), 1]], n);
    const { material, depthMaterial } = worldMaterial({ vertexShader: PILLOW_VERT, fragmentShader: PILLOW_FRAG, uniforms: { ...extra } });
    mk(geo, material, depthMaterial);
  }
  {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(grove.trunk.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(grove.trunk.nrm, 3));
    geo.setAttribute('aT', new THREE.Float32BufferAttribute(grove.trunk.at, 4));
    geo.setAttribute('aF', new THREE.Float32BufferAttribute(grove.trunk.fl, 1));
    geo.setIndex(grove.trunk.idx);
    const { material, depthMaterial } = worldMaterial({ vertexShader: TRUNK_VERT, fragmentShader: TRUNK_FRAG, uniforms: { ...extra } });
    mk(geo, material, depthMaterial);
  }

  // ---- forest
  const F = placeForest(ctx, grove.trees);
  const sets = cullForest(F, ctx, dbgCam);
  // kinds: 0 spruce (slender, stiff tiers), 1 broadleaf clump, 2 fir (broad drooping skirts);
  // the vertex shader adds per-instance tier spacing / taper / lean on top
  const LODS = [
    [buildConifer({ tiers: 7, K: 10, mid: true, under: true, trunk: true, rMul: 0.9, droop: 0.035 }), buildConifer({ tiers: 5, K: 8, mid: true, under: true, trunk: false, rMul: 0.9, droop: 0.035 }), buildConifer({ tiers: 3, K: 5, mid: false, under: false, trunk: false, rMul: 0.92 })],
    [buildBlob({ lobes: 9, detail: 1, trunk: true, seed: 11 }), buildBlob({ lobes: 6, detail: 1, trunk: false, seed: 12 }), buildBlob({ lobes: 4, detail: 0, trunk: false, seed: 13 })],
    [buildConifer({ tiers: 5, K: 9, mid: true, under: true, trunk: true, rMul: 1.18, droop: 0.075 }), buildConifer({ tiers: 4, K: 7, mid: true, under: true, trunk: false, rMul: 1.18, droop: 0.075 }), buildConifer({ tiers: 3, K: 5, mid: false, under: false, trunk: false, rMul: 1.12, droop: 0.06 })],
  ];
  const fmats = [
    worldMaterial({ vertexShader: FOREST_VERT, fragmentShader: FOREST_FRAG, uniforms: { ...extra }, defines: { CONIFER: 1 } }),
    worldMaterial({ vertexShader: FOREST_VERT, fragmentShader: FOREST_FRAG, uniforms: { ...extra } }),
  ];
  const forestMeshes = {};
  const counts = {};
  for (const [id, lists] of Object.entries(sets)) {
    forestMeshes[id] = [];
    counts[id] = lists.map(l => l.map(a => a.length));
    for (let k = 0; k < 3; k++) for (let lod = 0; lod < 3; lod++) {
      const idx = lists[k][lod];
      if (!idx.length) continue;
      const P = new Float32Array(idx.length * 4), A = new Float32Array(idx.length * 4);
      const pts = [];
      idx.forEach((i, j) => { for (let c = 0; c < 4; c++) { P[j * 4 + c] = F.P[i * 4 + c]; A[j * 4 + c] = F.A[i * 4 + c]; } pts.push([F.P[i * 4], F.P[i * 4 + 1] + F.P[i * 4 + 3] * 0.5, F.P[i * 4 + 2]]); });
      const geo = instanced(LODS[k][lod], [['aP', P, 4], ['aR', A, 4]], idx.length);
      geo.boundingSphere = sphereOf(pts, 30);
      const fm = fmats[k === 1 ? 1 : 0];
      const mesh = new THREE.Mesh(geo, fm.material);
      castShadow(mesh, fm.depthMaterial);
      mesh.visible = false; mesh.renderOrder = -3 + lod * 0.1;
      objects.push(mesh); forestMeshes[id].push(mesh);
    }
  }
  console.log('[trees] grove', grove.trees.length, 'trees,', grove.cards.pos.length / 4, 'cards; forest', F.n, 'trees; per shot [spruce L0,L1,L2 | broad L0,L1,L2 | fir L0,L1,L2]', JSON.stringify(counts));
  // snow shed points for the fx puffs (sorted by time): {x, y, z, r, t}; each pillow
  // slumps off its crown over ~0.2 s starting at t
  const shedWin = grove.shed.filter(s => s.t >= ctx.TIMES.whiteout - 0.4 && s.t <= ctx.TIMES.whiteout + 0.1).length;
  console.log('[trees] flush', grove.trees.map(T => T.tF).reduce((a, b) => [Math.min(a[0], b), Math.max(a[1], b)], [1e9, -1e9]).map(v => v.toFixed(2)).join('-'),
    's; shed points', grove.shed.length, '(', shedWin, 'within whiteout-0.4..+0.1 )');
  ctx.treeShed = { points: grove.shed, dur: 0.3 * TUNE.flushDur, activeAt: (t, pre = 0.1, post = 0.6) => grove.shed.filter(s => t >= s.t - pre && t <= s.t + post) };

  return {
    objects,
    update(t, c) {
      const shot = dbgCam ? 'dbg' : (c.shot ? c.shot.id : 'macro');
      if (dbgCam) {
        const cam = c.camera;
        cam.position.copy(dbgCam.pos); cam.up.set(0, 1, 0); cam.lookAt(dbgCam.target);
        cam.fov = dbgCam.fov; cam.near = 0.1; cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
      }
      // hero grove: fully flushed from the reveal on (it is only ever seen in winter before the canopy)
      uPFloor.value = (shot === 'reveal' || shot === 'falls' || shot === 'aerial') ? 50 : -1e4;
      for (const m of heroMeshes) m.visible = (!!dbgCam || HERO_SHOTS.has(shot)) && hide !== 'hero' && hide !== 'all';
      for (const [id, list] of Object.entries(forestMeshes)) for (const m of list) m.visible = id === shot && hide !== 'forest' && hide !== 'all';
    },
  };
}
