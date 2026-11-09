// FIRST BLOOM — fx: particles + birds.
//
// Every system is a pure function of the subframe time t (plus the camera rigs,
// which are pure functions of t too), so frames render in any order and each
// subframe gets true motion blur from the engine's accumulation.
//
// Sprites live in the OVERLAY scene (composited after paint + DOF, before
// bloom), premultiplied. Each sprite blurs itself by the lens CoC
// (cocK * H/2160 * |1 - focus/z|, clamped), lowers its coverage by area (a soft
// bokeh disc), and fades against the scene depth (soft particles).
// Birds are real deforming geometry (flap in the vertex shader). They are also
// drawn in the overlay so the Kuwahara pass cannot smear a 6 px swallow away;
// they depth-test against the scene depth by hand and write the overlay depth
// buffer so sprites behind them are hidden.
//
// Systems (see update()):
//   snow      wrapped-box snowfall: macro (~20 sun-glint bokeh discs: hex aperture,
//             cat-eye, chroma fringe, 1:5 size spread), early FPV
//   hero      8 tiny irregular hex plate crystals tumbling through the macro focus
//   sparkle   wavefront glints (2-4 px view-dependent star flashes) + sparse glitter
//             puffs that pop at the front and die within 0.5 s (over-composited,
//             so pile-ups never exceed the puff colour), world-anchored cell grids
//   fpuff     pollen puffs where flowers pop behind the front (FPV)
//   motes     golden pollen motes in sunbeams (12.2+), aerial rising motes
//   bursts    one-shot events: hit pollen pulse, canopy crown sheds (clumps that
//             break apart + flakes)
//   lens      camera-locked lens snow: white-out build (fills bottom-up, 16.44-16.77)
//             and reveal clear (streaks off the frame edges, cut4 -> arrival)
//   petals    3 opaque violet tepals tumbling up past the lens (27.4-29.9)
//   birds     FPV swallow flock, swift near-miss on TIMES.swift (own smooth mesh,
//             per-subframe lens jitter), reveal flocks, falls swifts
// Every sprite is drawn as a per-subframe streak over its screen motion during the
// subframe's shutter slice (uVP0/uVP1/uSubDt), so low spp never strobes sprites.
import * as THREE from 'three';
import { worldMaterial, rng } from './common.js';
import { TIMES, bloomD, makeCameraRig, shotAt } from './timeline.js';
import { PALETTE_GLSL } from './terrain.js';
import * as L from './layout.js';
import { smoothstep, clamp01, lerp, easeInOut, easeOut } from './keys.js';

const V3 = THREE.Vector3, V4 = THREE.Vector4;
const Y = new V3(0, 1, 0);
const TAU = Math.PI * 2;

// ------------------------------------------------------------------ tuning
// Pixel sizes are authored for 3840x2160 and scaled by H/2160.
export const TUNE = {
  snowMacro: { nearN: 90, farN: 200, fall: 0.06, farFall: 0.30, bokehGamma: 0.5, rim: 0.22, minBlur: 16 },  // ~15-25 bokeh discs in frame
  snowFpv: { nearN: 1800, farN: 2400, fall: 0.9, farFall: 1.1 },
  sparkle: { intensity: 1.0, mist: 1.0 },
  motes: { n: 2600, intensity: 1.0 },
  birds: { minSpanPx: 16, rim: 1.0 },
  hitPollen: true,       // golden pollen pulse from the bud at 6.0 s (disable if hero.js already does it)
};

// inverse bloom clock: t(D) table (D -> time the wave value reaches D)
const INV_N = 4096, D_MAX = Math.ceil(bloomD(TIMES.end + 1) + 100);

// ------------------------------------------------------------------ GLSL
const FX_GLSL = /* glsl */`
${PALETTE_GLSL}
uniform sampler2D tDepth; uniform vec2 uRes; uniform vec4 uCamP; uniform float uMaxCoc; uniform float uPx;
uniform float uTau; uniform sampler2D tInvClock;
uniform sampler2D tHeight; uniform vec4 uGrid; uniform vec3 uGridK;
// sub-frame streaks: view-projection at the start / end of this subframe's
// slice of the shutter, and the slice length (s)
uniform mat4 uVP0; uniform mat4 uVP1; uniform float uSubDt;
#define C_GLITTER s2l(vec3(1.0, 0.945, 0.761))
#define C_DAWN s2l(vec3(1.0, 0.784, 0.451))
#define C_POLLEN s2l(vec3(1.0, 0.769, 0.180))
#define C_RIME s2l(vec3(0.910, 0.945, 1.0))
#define C_BACKLIT s2l(vec3(0.706, 0.549, 1.0))
float timeOfD(float D) { float u = clamp(D / ${D_MAX.toFixed(1)}, 0.0, 1.0); return texture2D(tInvClock, vec2(u * ${((INV_N - 1) / INV_N).toFixed(8)} + ${(0.5 / INV_N).toFixed(8)}, 0.5)).r; }
float linZ(float d) { float z = d * 2.0 - 1.0; return 2.0 * uCamP.x * uCamP.y / (uCamP.y + uCamP.x - z * (uCamP.y - uCamP.x)); }
float cocPx(float z) { return min(uCamP.w * abs(1.0 - uCamP.z / max(z, 1e-4)), uMaxCoc); }
float hgPhase(float c, float g) { float g2 = g * g; return (1.0 - g2) / (12.566 * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5)); }
// same ragged-front offset as bloomAmt()/bloomFront() in WORLD_GLSL
float frontOffset(vec2 xz) { return (fbm(xz * 0.11) - 0.5) * uBloomNoise * 2.0 + (vnoise(xz * 0.9) - 0.5) * 0.6; }
varying vec4 vCol;   // rgb radiance, a opacity factor (1 = reflective, <1 = emissive-ish)
varying vec4 vSpr;   // xy quad uv (1 = drawn radius), z drawn radius px, w view depth
varying vec4 vAux;   // system specific; w = coverage
varying vec4 vAux2;  // system specific
varying vec2 vStr;   // streak half-segment (screen frame, units of the drawn radius)

#ifdef IS_VERTEX
attribute float aI;
// exact terrain height (matches the terrain mesh triangulation)
float terrainH(vec2 xz) {
  float SK = 1.0 / uGridK.y; float NM = uGridK.z;
  float fi = (asinh((xz.x - uGrid.x) * SK / uGrid.z) / uGridK.x + 1.0) * 0.5 * NM;
  float fj = (asinh((xz.y - uGrid.y) * SK / uGrid.w) / uGridK.x + 1.0) * 0.5 * NM;
  fi = clamp(fi, 0.0, NM - 0.001); fj = clamp(fj, 0.0, NM - 0.001);
  ivec2 c = ivec2(floor(vec2(fi, fj)));
  float u = fi - float(c.x), v = fj - float(c.y);
  float h00 = texelFetch(tHeight, c, 0).r, h10 = texelFetch(tHeight, c + ivec2(1, 0), 0).r;
  float h01 = texelFetch(tHeight, c + ivec2(0, 1), 0).r, h11 = texelFetch(tHeight, c + ivec2(1, 1), 0).r;
  return u > v ? h00 + (h10 - h00) * u + (h11 - h10) * v : h00 + (h11 - h01) * u + (h01 - h00) * v;
}
// 4-tap sun shadow usable in the vertex stage (one value per particle)
float shadowV(vec3 wp) {
  if (uShadowOn < 0.5) return 1.0;
  vec3 s0 = (uShadowMat0 * vec4(wp, 1.0)).xyz * 0.5 + 0.5;
  if (all(greaterThan(s0.xy, vec2(0.02))) && all(lessThan(s0.xy, vec2(0.98))) && s0.z < 1.0) {
    float t = uShadowTexel.x * 2.0; float z = s0.z - uShadowTexel.x * 4.0;
    return 0.25 * (step(z, texture2D(tShadow0, s0.xy + vec2(t, t)).r) + step(z, texture2D(tShadow0, s0.xy + vec2(-t, t)).r)
                 + step(z, texture2D(tShadow0, s0.xy + vec2(t, -t)).r) + step(z, texture2D(tShadow0, s0.xy - vec2(t, t)).r));
  }
  vec3 s1 = (uShadowMat1 * vec4(wp, 1.0)).xyz * 0.5 + 0.5;
  if (all(greaterThan(s1.xy, vec2(0.0))) && all(lessThan(s1.xy, vec2(1.0))) && s1.z < 1.0) {
    float t = uShadowTexel.y * 1.5; float z = s1.z - uShadowTexel.y * 4.0;
    return 0.5 * (step(z, texture2D(tShadow1, s1.xy + vec2(t, t)).r) + step(z, texture2D(tShadow1, s1.xy - vec2(t, t)).r));
  }
  return 1.0;
}
void cull() { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); vCol = vec4(0.0); vAux = vec4(0.0); vAux2 = vec4(0.0); vSpr = vec4(0.0); vStr = vec2(0.0); }
// Camera-facing quad grown by the CoC. rW world radius, minPx minimum core radius
// (px), blur extra blur radius (px), quadK quad size relative to the drawn disc.
// nearOK: the sprite may sit in front of the camera's near plane (near-lens
// petals/motes in shots with a large near plane): slide it along its view ray to
// just beyond the near plane and scale it by the same factor, so its projected
// position and apparent size are unchanged.
// Streak: every subframe draws the sprite as a capsule over its screen motion
// during the subframe's slice of the shutter (camera motion via uVP0/uVP1 plus
// the particle's own velocity gVel), so the accumulated frame shows a smooth
// smear instead of N strobed copies. Disable (gStreak = false) for sprites that
// are staged relative to the camera.
// gCocCap caps the lens blur (px @ render res) for sprites that must stay small.
// gStrPx: camera-locked sprites pass their own screen-space streak (px) instead
bool gNearOK = false; bool gStreak = true; vec3 gVel = vec3(0.0); float gCocCap = 1e6; bool gScreenStr = false; vec2 gStrPx = vec2(0.0);
vec2 streakPx(vec3 wp) {
  if (gScreenStr) return gStrPx;
  if (!gStreak || uSubDt <= 0.0) return vec2(0.0);
  vec4 c0 = uVP0 * vec4(wp - gVel * 0.5 * uSubDt, 1.0), c1 = uVP1 * vec4(wp + gVel * 0.5 * uSubDt, 1.0);
  if (c0.w < 1e-3 || c1.w < 1e-3) return vec2(0.0);
  return (c1.xy / c1.w - c0.xy / c0.w) * 0.5 * uRes;
}
bool placeSpriteA(vec3 wp, float rW, float minPx, float blur, float quadK, float aspect, out float rDraw, out float eTrue, out float eCore) {
  vec4 vp = viewMatrix * vec4(wp, 1.0);
  float z = -vp.z;
  rDraw = 1.0; eTrue = 0.0; eCore = 0.0;
  if (gNearOK && z > 0.05 && z < uCamP.x * 1.6) {
    float k = uCamP.x * 1.6 / z;
    wp = cameraPosition + (wp - cameraPosition) * k; rW *= k;
    vp = viewMatrix * vec4(wp, 1.0); z = -vp.z;
  }
  if (z < uCamP.x * 1.5) return false;
  float pxPerM = projectionMatrix[1][1] * 0.5 * uRes.y / z;
  float rT = rW * pxPerM;
  float rC = max(rT, minPx);
  rDraw = rC + min(cocPx(z), gCocCap) + blur;
  eTrue = min(1.0, rT * rT / (rDraw * rDraw));
  eCore = rC * rC / (rDraw * rDraw);
  float rQ = rDraw * quadK + 1.0;
  vec2 d = streakPx(wp);
  float hl = 0.5 * length(d);
  vec2 a = hl > 0.35 ? d / (2.0 * hl) : vec2(1.0, 0.0);
  hl = hl > 0.35 ? min(hl, 0.45 * uRes.y) : 0.0;
  float rE = rQ * max(aspect, 1.0);
  vec2 off = a * position.x * (rE + hl) + vec2(-a.y, a.x) * position.y * rE;
  vec4 clip = projectionMatrix * vp;
  clip.xy += off * 2.0 / uRes * clip.w;
  gl_Position = clip;
  vSpr = vec4(off / rDraw, rDraw, z);
  vStr = a * hl / rDraw;
  return true;
}
bool placeSprite(vec3 wp, float rW, float minPx, float blur, float quadK, out float rDraw, out float eTrue, out float eCore) {
  return placeSpriteA(wp, rW, minPx, blur, quadK, 1.0, rDraw, eTrue, eCore);
}
vec2 ndcOf(vec3 wp) { vec4 c = projectionMatrix * viewMatrix * vec4(wp, 1.0); return c.xy / max(c.w, 1e-4); }
vec3 windDir3() { vec2 w = normalize(uWind.xy); return vec3(w.x, 0.0, w.y); }
#else
float sceneZ() { return linZ(texture2D(tDepth, gl_FragCoord.xy / uRes).x); }
float softOcc(float z, float soft) { return clamp((sceneZ() - z) / max(soft, 1e-4), 0.0, 1.0); }
float spriteMask(vec2 uv, float rDraw, float soft) {
  float d = length(uv);
  float g = exp(-d * d * 3.0);
  float aa = soft + 1.2 / max(rDraw, 1.0);
  float disc = 1.0 - smoothstep(1.0 - aa, 1.0, d);
  return mix(g, disc, smoothstep(1.5, 4.0, rDraw));
}
// collapse the streak segment: distance-to-segment coordinates
vec2 strUV(vec2 uv) { float l2 = dot(vStr, vStr); if (l2 < 1e-6) return uv; return uv - vStr * clamp(dot(uv, vStr) / l2, -1.0, 1.0); }
// energy kept constant along the streak (a disc swept over 2*hl radii)
float strK() { return 1.0 / (1.0 + length(vStr)); }
#endif
`;

// ---- wrapped-box drift particles (snow, pollen motes)
const BOX_VS = /* glsl */`${FX_GLSL}
uniform vec4 uBA; // B, fall speed, radius, intensity
uniform vec4 uBB; // wind speed, sway, minPx(4K), bloom gate
uniform vec4 uBC; // box centre xyz, amount
uniform vec4 uBD; // minBlur px(4K), coverage gamma, kind (0 snow, 1 mote, 2 macro bokeh snow), bokeh rim
uniform vec4 uBlast; // centre xyz, strength
uniform float uSeed; uniform float uNearOK; uniform float uTauRate; uniform float uCocCap;
void main() {
  gNearOK = uNearOK > 0.5;
  vec3 h = hash33(vec3(aI * 0.7131 + uSeed, aI * 1.913 + 3.1, uSeed * 7.7 + 1.0));
  vec3 h2 = hash33(h * 91.7 + vec3(13.1, 5.7, 1.3));
  float B = uBA.x, tau = uTau;
  vec3 wd = windDir3();
  vec3 p = (h - 0.5) * B;
  p.y -= uBA.y * (0.55 + 0.9 * h2.x) * tau;
  p += wd * uBB.x * (0.6 + 0.8 * h2.y) * tau;
  gVel = (vec3(0.0, -uBA.y * (0.55 + 0.9 * h2.x), 0.0) + wd * uBB.x * (0.6 + 0.8 * h2.y)) * uTauRate;
  float ph = h2.z * 6.2831;
  p.x += sin(tau * (0.8 + 1.1 * h.x) + ph) * uBB.y;
  p.z += sin(tau * (0.6 + 0.9 * h.y) + ph * 1.7) * uBB.y;
  p.y += sin(tau * (1.1 + 0.7 * h.z) + ph * 2.3) * uBB.y * 0.5;
  vec3 loc = mod(p - uBC.xyz + 0.5 * B, B) - 0.5 * B;
  vec3 wp = uBC.xyz + loc;
  vec3 al = abs(loc) / (0.5 * B);
  float edge = 1.0 - smoothstep(0.7, 1.0, max(max(al.x, al.y), al.z));
  if (uBlast.w > 0.0) { vec3 d = wp - uBlast.xyz; float dl = length(d); wp += d / max(dl, 1e-4) * uBlast.w * exp(-dl / 0.3); }
  float gate = 1.0, gold = 0.0;
  if (uBB.w > 0.5) {
    float dd = (uBloomD - arrival(wp.xz) - frontOffset(wp.xz)) / uBloomWidth;
    gate = 1.0 - smoothstep(-0.2, 1.4, dd);
    gold = smoothstep(-1.2, 0.3, dd);
  }
  float amt = uBC.w * edge * gate;
  if (amt < 0.002) { cull(); return; }
  bool bokeh = uBD.z > 1.5;
  float rW = uBA.z * (0.5 + 1.0 * h2.y * h2.x + 0.3 * h.z);
  float z = -(viewMatrix * vec4(wp, 1.0)).z;
  // macro bokeh: the aperture disc size varies per flake (~1:5), not all at the clamp
  gCocCap = bokeh ? uMaxCoc * mix(0.2, 1.0, pow(h2.y, 1.4)) : uCocCap * uPx;
  float extra = max(0.0, uBD.x * uPx - min(cocPx(z), gCocCap));
  float rD, eT, eC;
  if (!placeSpriteA(wp, rW, uBB.z * uPx, extra, 1.0, 1.0, rD, eT, eC)) { cull(); return; }
  vec3 V = normalize(wp - cameraPosition);
  float c = dot(V, uSunDir);
  float sh = shadowV(wp);
  vec3 amb = uSkyAmbient * 1.2 + uSkyHorizon * 0.35;
  vec3 rad; float op;
  vAux2 = vec4(0.0);
  if (bokeh) {
    // only flakes that catch the sun read as bokeh (forward-scattered glints);
    // sky-lit ones are barely brighter than the sky behind them
    float glint = step(0.35, h.z) * sh * hgPhase(c, 0.62);
    vec3 sky = uSkyAmbient * 1.6 + uSkyHorizon * 0.5;
    rad = C_RIME * (sky + uSunColor * (0.04 + 2.6 * glint)) * uBA.w;
    op = 1.0;
    float alpha = (0.15 + 0.2 * h2.z) * smoothstep(1.0, 6.0, rD / uPx);  // tiny far flakes stay faint specks
    vCol = vec4(rad, op);
    vec2 n = ndcOf(wp);
    vAux = vec4(h.x, 0.0, 0.0, amt * mix(pow(eT, uBD.y), alpha, smoothstep(4.0, 12.0, rD / uPx)));
    vAux2 = vec4(n.x * uRes.x / uRes.y, n.y, 0.0, 0.0);
    return;
  }
  if (uBD.z < 0.5) {
    // flakes read slightly brighter than the sky behind them (cool skylight), and
    // light up gold-white toward the sun; a few facets catch a hard glint
    float glint = step(0.8, h2.z) * (0.5 + 0.5 * sin(tau * (3.0 + 4.0 * h.y) + ph * 5.0));
    float bv = 0.55 + 0.9 * h.y * h.y;
    vec3 sky = uSkyAmbient * 2.8 + uSkyHorizon * 0.9;
    rad = C_RIME * (sky + uSunColor * sh * (0.12 + 2.0 * hgPhase(c, 0.6)) * (1.0 + 2.0 * glint)) * bv * uBA.w;
    rad = mix(rad, C_GLITTER * (1.5 + 2.5 * luma(uSunColor)), gold * 0.85);
    op = 1.0;
    amt *= 0.35 + 0.65 * h2.x;
  } else {
    float tw = 0.6 + 0.4 * sin(uTime * (2.0 + 3.0 * h.x) + ph * 3.0);
    rad = C_POLLEN * (uSunColor * sh * (0.08 + 3.2 * hgPhase(c, 0.72)) * tw + amb * 0.35 + 0.35) * uBA.w;
    op = 0.55;
  }
  vCol = vec4(rad, op);
  vAux = vec4(h.x, gold, 0.0, amt * pow(eT, uBD.y));
  vAux2 = vec4(0.0);
}`;
const BOX_FS = /* glsl */`${FX_GLSL}
uniform vec4 uBD;
// soft hexagonal aperture (6 rounded blades), inradius-normalised
float hexD(vec2 q) { q = abs(q); return max(q.y, q.x * 0.8660254 + q.y * 0.5); }
float aperture(vec2 q, vec2 ce, float r, float aa) {
  float d = mix(length(q), hexD(q) * 1.05, 0.55) / r;
  float d2 = length(q - ce) / (r * 1.08);              // mechanical vignetting: cat-eye toward the edges
  return (1.0 - smoothstep(1.0 - aa, 1.0, d)) * (1.0 - smoothstep(1.0 - aa * 1.6, 1.0, d2));
}
void main() {
  vec2 uv = strUV(vSpr.xy);
  float occ = softOcc(vSpr.w, 0.03 + 0.08 * vSpr.w);
  if (uBD.z > 1.5) {
    float rD = vSpr.z;
    float g = spriteMask(uv, rD, 0.1);
    vec3 mrgb = vec3(g);
    float bk = smoothstep(5.0, 12.0, rD);
    if (bk > 0.0) {
      // vAux2.xy: sprite centre (aspect-corrected ndc); the second disc shifts with it
      vec2 ce = -vAux2.xy * 0.42;
      float aa = 0.1 + 2.0 / rD;
      // slight lateral chromatic fringe: red edge a touch wider, blue a touch tighter
      vec3 m3 = vec3(aperture(uv, ce, 1.025, aa), aperture(uv, ce, 1.0, aa), aperture(uv, ce, 0.972, aa));
      float rim = 1.0 + uBD.w * smoothstep(0.55, 0.97, length(uv));
      float body = 0.82 + 0.18 * vnoise(uv * 2.3 + vAux.x * 40.0);   // faint onion-ring / dust texture
      mrgb = mix(mrgb, m3 * rim * body, bk);
    }
    vec3 k3 = min(vAux.w * mrgb * occ * strK(), vec3(1.0));
    if (k3.g < 1e-5) discard;
    gl_FragColor = vec4(vCol.rgb * k3, vCol.a * k3.g);
    return;
  }
  float m = spriteMask(uv, vSpr.z, 0.1);
  float d = length(uv);
  m *= 1.0 + uBD.w * smoothstep(0.45, 0.95, d) * smoothstep(5.0, 14.0, vSpr.z);
  float k = min(vAux.w * m * occ * strK(), 1.0);
  if (k < 1e-5) discard;
  gl_FragColor = vec4(vCol.rgb * k, vCol.a * k);
}`;

// ---- macro snow crystals: small irregular hexagonal plates drifting through the
// focal plane (CPU paths in uniform arrays). Tumbling plates foreshorten and
// flash when a face lines up with the sun.
const NHERO = 8;
const HERO_VS = /* glsl */`${FX_GLSL}
uniform vec4 uHP[${NHERO}]; // xyz, radius
uniform vec4 uHQ[${NHERO}]; // rotation, alpha, seed, tumble angle
void main() {
  int i = int(aI);
  vec4 P = uHP[i], Q = uHQ[i];
  if (Q.y <= 0.001) { cull(); return; }
  float rD, eT, eC;
  if (!placeSprite(P.xyz, P.w, 0.8 * uPx, 0.0, 1.0, rD, eT, eC)) { cull(); return; }
  vec3 V = normalize(P.xyz - cameraPosition);
  float sh = shadowV(P.xyz);
  vec3 amb = uSkyAmbient * 2.2 + uSkyHorizon * 0.9;
  float sq = cos(Q.w);
  // the plate face reflects the sun when its tumble brings it edge-on to the half vector
  float flash = pow(max(1.0 - abs(abs(sq) - 0.55) * 2.2, 0.0), 6.0) * step(0.5, fract(Q.z * 7.3));
  vec3 rad = C_RIME * (amb + uSunColor * sh * (0.25 + 2.2 * hgPhase(dot(V, uSunDir), 0.55)) * (1.0 + 2.5 * flash));
  vCol = vec4(rad, 1.0);
  vAux = vec4(Q.x, Q.z, sqrt(eC), Q.y * pow(eT, 0.35));
  vAux2 = vec4(sq, flash, 0.0, 0.0);
}`;
const HERO_FS = /* glsl */`${FX_GLSL}
// irregular hexagonal plate: six half-planes at per-crystal distances
float plate(vec2 p, float seed, out float ridge) {
  float d = -1e3, dIn = -1e3;
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float a = fi * 1.0471976 + 0.08 * (fract(seed * (5.3 + fi * 2.1)) - 0.5);
    vec2 n = vec2(cos(a), sin(a));
    float r = 0.72 + 0.28 * fract(seed * (3.1 + fi * 1.7));
    d = max(d, dot(p, n) - r);
    dIn = max(dIn, dot(p, n) - r * 0.52);
  }
  ridge = max(1.0 - abs(dIn) / 0.05, 0.0);
  return d;
}
void main() {
  float rD = vSpr.z;
  float sharp = max(vAux.z, 0.05);
  float ca = cos(vAux.x), sa = sin(vAux.x);
  vec2 uv = vSpr.xy;
  vec2 p = mat2(ca, -sa, sa, ca) * uv / sharp * 1.22;   // hexagon corners stay inside the quad
  p.y /= max(abs(vAux2.x), 0.18);                       // tumble foreshortening
  float ridge;
  float sd = plate(p, vAux.y, ridge);
  float px = 1.5 / (rD * sharp);
  float cm = 1.0 - smoothstep(-px, px, sd);
  float edgeHi = smoothstep(-0.18, -0.02, sd);
  float body = cm * (0.45 + 0.4 * edgeHi + 0.35 * ridge) * (1.0 + 1.5 * vAux2.y);
  float disc = spriteMask(uv, rD, 0.1) * 0.7;
  float sw = smoothstep(0.45, 0.85, sharp);
  float m = mix(disc, body, sw);
  float occ = softOcc(vSpr.w, 0.01 + 0.05 * vSpr.w);
  float k = min(vAux.w * m * occ * strK(), 1.0);
  if (k < 1e-5) discard;
  gl_FragColor = vec4(vCol.rgb * k, vCol.a * k);
}`;

// ---- wavefront sparkles + glitter mist on world-anchored cell grids
const SPARK_VS = /* glsl */`${FX_GLSL}
uniform vec4 uLA; // cell size, N, rMin, rMax
uniform vec4 uLB; // radial fade, scale S, intensity, mist fraction
uniform vec4 uLC; // anchor xz, active fraction, amount
uniform float uSeed;
void main() {
  float N = uLA.y;
  vec2 ij = vec2(mod(aI, N), floor(aI / N));
  vec2 cell = floor(uLC.xy / uLA.x) - floor(N * 0.5) + ij;
  vec2 h = hash22(cell + uSeed);
  vec2 h2 = hash22(cell * 1.731 + vec2(7.3, 1.1) + uSeed);
  vec2 h3 = hash22(cell * 0.917 + vec2(-3.1, 9.4) + uSeed);
  vec2 h4 = hash22(cell * 2.373 + vec2(5.5, -2.2) + uSeed);
  if (h4.x > uLC.z) { cull(); return; }
  vec2 xz = (cell + h) * uLA.x;
  float dc = length(xz - cameraPosition.xz);
  float wR = smoothstep(uLA.z, uLA.z + uLB.x, dc) * (1.0 - smoothstep(uLA.w - uLB.x, uLA.w, dc));
  if (wR <= 0.001) { cull(); return; }
  float aT = arrival(xz) + frontOffset(xz);
  float dd = (uBloomD - aT) / uBloomWidth;
  if (dd < -0.8 || dd > 2.6) { cull(); return; }
  // ageF: seconds since the front (dd = 0) passed this cell (negative before)
  float tFront = timeOfD(aT);
  float ageF = uTime - tFront;
  float age = max(ageF + 0.25, 0.0);
  float gy = terrainH(xz);
  float S = uLB.y;
  vec3 wd = windDir3();
  bool mist = h2.x < uLB.w;
  vec3 wp; float rW, op, env, quadK = 1.0, star = 0.0;
  vec3 rad;
  float aspect = 1.0;
  if (mist) {
    // discrete glitter puffs that pop at the front and die within ~0.5 s behind
    // it: small, low (top under ~1 m in the FPV layers), over-composited so any
    // pile-up converges to the puff colour (~ sunlit snow white) instead of
    // adding up into a glowing slab
    rW = min(S * (0.10 + 0.14 * h3.x), 0.45 + 0.3 * max(S - 4.0, 0.0));
    float grow = 0.7 + 0.5 * smoothstep(0.0, 0.5, ageF);
    rW *= grow;
    aspect = 1.0 + 0.35 * h4.y;
    wp = vec3(xz.x, gy + min(0.22 * S, 0.4) + rW * (0.7 + 0.3 * h3.y) + 0.3 * rW * max(ageF, 0.0), xz.y) + wd * S * 0.25 * max(ageF, 0.0);
    env = smoothstep(-0.12, 0.04, ageF) * (1.0 - smoothstep(0.12 + 0.12 * h3.y, 0.5, ageF));
    // never a lens-filling sprite
    env *= smoothstep(4.0, 10.0, length(wp - cameraPosition) / rW);
    vec3 V = normalize(wp - cameraPosition);
    rad = mix(C_GLITTER, C_DAWN, 0.45) * (uSkyAmbient * 1.1 + uSkyHorizon * 0.3 + uSunColor * (0.22 + 0.9 * hgPhase(dot(V, uSunDir), 0.45)));
    op = 1.0;
    gVel = wd * S * 0.25;
  } else {
    // glints: tiny facets that flash when they line up with the sun (view dependent)
    float rise = S * (0.08 + 0.5 * h3.x) * (1.0 - exp(-age * 2.5));
    wp = vec3(xz.x, gy + 0.03 * S + rise, xz.y) + wd * S * 0.15 * age;
    gVel = wd * S * 0.15;
    env = smoothstep(-0.7, -0.2, dd) * (1.0 - smoothstep(0.35 + 0.35 * h3.y, 0.95, ageF));
    vec3 nf = normalize(vec3(h3.x * 2.0 - 1.0, 1.1 + h4.x, h3.y * 2.0 - 1.0));
    vec3 Hh = normalize(uSunDir + normalize(cameraPosition - wp));
    float spec = pow(max(dot(nf, Hh), 0.0), 90.0);
    float tw = 0.35 + 0.65 * pow(0.5 + 0.5 * sin(uTime * (3.0 + 5.0 * h4.y) + h.x * 40.0), 3.0);
    rad = mix(C_GLITTER, C_DAWN, 0.3 + 0.7 * h3.y) * (1.2 + 18.0 * spec) * tw * (0.6 + 0.4 * luma(uSunColor));
    rW = 0.006 * S * (0.5 + h3.x);
    op = 0.3;
    star = smoothstep(0.35, 0.8, spec) * step(0.4, h4.y);
    quadK = star > 0.0 ? 3.5 : 1.0;
    gCocCap = 3.0 * uPx;          // 2-4 px stars, never bokeh balls
  }
  env *= wR * uLC.w;
  if (env < 0.002) { cull(); return; }
  float rD, eT, eC;
  if (!placeSpriteA(wp, rW, (mist ? 2.0 : 2.2) * uPx, 0.0, quadK, aspect, rD, eT, eC)) { cull(); return; }
  float cov = mist ? eT * 0.2 : min(1.0, eC * 4.0);
  vCol = vec4(rad * uLB.z, op);
  vAux = vec4(mist ? 1.0 : 0.0, star, h.x, env * cov);
  vAux2 = vec4(quadK, aspect, rW, 0.0);
}`;
const SPARK_FS = /* glsl */`${FX_GLSL}
void main() {
  vec2 uv = strUV(vSpr.xy);
  float d = length(uv);
  float m, soft;
  if (vAux.x > 0.5) {
    vec2 p = vec2(uv.x / vAux2.y, uv.y);
    float dp = length(p);
    float n = vnoise(uv * 1.9 + vAux.z * 31.0) * 0.6 + vnoise(uv * 4.3 - vAux.z * 17.0) * 0.4;
    m = exp(-dp * dp * 3.2) * (0.35 + 1.1 * n * n) * (1.0 - smoothstep(0.7, 1.0, dp));
    soft = vAux2.z * 1.5 + 0.02 * vSpr.w;   // depth-fade over the puff's own size: no hard intersections
  } else {
    m = spriteMask(uv, vSpr.z, 0.1);
    if (vAux.y > 0.0) {
      vec2 q = abs(vSpr.xy);
      float th = 0.7 / max(vSpr.z, 1.0);
      float rays = exp(-q.y / th) * max(0.0, 1.0 - q.x / vAux2.x) + exp(-q.x / th) * max(0.0, 1.0 - q.y / vAux2.x);
      m += vAux.y * 0.5 * rays;
    }
    soft = 0.15 + 0.03 * vSpr.w;
  }
  float occ = softOcc(vSpr.w, soft);
  float k = vAux.w * m * occ * strK();
  if (k < 1e-5) discard;
  gl_FragColor = vec4(vCol.rgb * k, min(vCol.a * k, 1.0));
}`;

// ---- pollen puffs where flowers pop behind the front (K grains per cell)
const FPUFF_VS = /* glsl */`${FX_GLSL}
uniform vec4 uPA; // cell, N, K, rMax
uniform vec4 uPB; // anchor xz, active fraction, amount
uniform float uSeed;
void main() {
  float K = uPA.z, N = uPA.y;
  float ci = floor(aI / K), k = mod(aI, K);
  vec2 ij = vec2(mod(ci, N), floor(ci / N));
  vec2 cell = floor(uPB.xy / uPA.x) - floor(N * 0.5) + ij;
  vec2 h = hash22(cell + uSeed), h2 = hash22(cell * 1.37 + vec2(4.1, 2.9) + uSeed);
  if (h2.x > uPB.z) { cull(); return; }
  vec2 xz = (cell + 0.15 + 0.7 * h) * uPA.x;
  float dc = length(xz - cameraPosition.xz);
  if (dc > uPA.w) { cull(); return; }
  float aT = arrival(xz) + frontOffset(xz);
  if (uBloomD < aT) { cull(); return; }
  float tb = timeOfD(aT + (0.35 + 0.8 * h2.y) * uBloomWidth);
  float age = uTime - tb;
  if (age < 0.0 || age > 2.4) { cull(); return; }
  vec3 g = hash33(vec3(cell * 0.37, k * 1.91 + 0.5));
  vec3 g2 = hash33(g * 53.1 + vec3(2.7, 1.3, 8.1));
  float gy = terrainH(xz);
  vec3 src = vec3(xz.x, gy + 0.22 + 0.3 * h2.y, xz.y);
  vec3 dir = normalize(vec3(g.x * 2.0 - 1.0, 0.25 + 0.9 * g.y, g.z * 2.0 - 1.0));
  float sp = 0.5 + 1.2 * g2.x;
  float drag = 3.0, fdr = (1.0 - exp(-drag * age)) / drag;
  vec3 wp = src + dir * sp * fdr + windDir3() * 0.6 * age + vec3(0.0, 0.1 * age, 0.0);
  gVel = dir * sp * exp(-drag * age) + windDir3() * 0.6 + vec3(0.0, 0.1, 0.0);
  bool glow = k < 0.5;
  float env = smoothstep(0.0, 0.05, age) * exp(-age * (glow ? 4.0 : 1.4)) * uPB.w;
  // the glow is only a faint warm breath around the grains (it used to read as
  // ochre lens blobs); grains never balloon into bokeh discs
  float rW = glow ? 0.035 + 0.06 * (1.0 - exp(-age * 3.0)) : 0.0011 + 0.0015 * g2.y;
  gCocCap = glow ? 1e6 : 5.0 * uPx;
  float rD, eT, eC;
  if (!placeSprite(wp, rW, (glow ? 2.0 : 1.3) * uPx, 0.0, 1.0, rD, eT, eC)) { cull(); return; }
  vec3 V = normalize(wp - cameraPosition);
  vec3 rad = C_POLLEN * (uSunColor * (0.3 + 1.6 * hgPhase(dot(V, uSunDir), 0.6)) + uSkyAmbient * 0.6 + 0.7);
  vCol = vec4(rad, glow ? 0.06 : 0.45);
  vAux = vec4(glow ? 1.0 : 0.0, 0.0, 0.0, env * (glow ? eT * 0.18 : min(1.0, eC * 1.5)));
  vAux2 = vec4(0.0);
}`;
const FPUFF_FS = /* glsl */`${FX_GLSL}
void main() {
  vec2 uv = strUV(vSpr.xy);
  float d = length(uv);
  float m = vAux.x > 0.5 ? exp(-d * d * 3.0) * (1.0 - smoothstep(0.8, 1.0, d)) : spriteMask(uv, vSpr.z, 0.1);
  float occ = softOcc(vSpr.w, 0.05 + 0.04 * vSpr.w);
  float k = vAux.w * m * occ * strK();
  if (k < 1e-5) discard;
  gl_FragColor = vec4(vCol.rgb * k, min(vCol.a * k, 1.0));
}`;

// ---- one-shot bursts (pollen pulse, crown snow puffs, white-out blast, lens-
// clearing veils): params in uniform arrays
const MAXEV = 14;
const EV_VS = /* glsl */`${FX_GLSL}
uniform vec4 uEvA[${MAXEV}]; // src xyz, t0
uniform vec4 uEvB[${MAXEV}]; // spread, speed, size, kind (0 pollen, 1 crown puff, 2 lens-clearing veils, 3 lens blast)
uniform vec4 uEvC[${MAXEV}]; // bias dir xyz, life
uniform vec4 uEvD[${MAXEV}]; // pre-age, gravity, drag, intensity
uniform vec4 uEvE[${MAXEV}]; // nBlob, nGrain, wind, opacity
uniform vec4 uEvF[${MAXEV}]; // plane axis xyz, planar amount (offsets/velocities confined to the plane normal to the axis)
uniform float uPer;
void main() {
  int e = int(floor(aI / uPer)); float k = mod(aI, uPer);
  vec4 A = uEvA[e], Bq = uEvB[e], C = uEvC[e], D = uEvD[e], E = uEvE[e], F = uEvF[e];
#ifdef BLOB
  float cnt = E.x;
#else
  float cnt = E.y;
#endif
  float age = uTime - A.w + D.x;
  if (k >= cnt || uTime < A.w || age > C.w) { cull(); return; }
  float fe = float(e);
#ifdef BLOB
  vec3 h = hash33(vec3(k * 1.37 + fe * 17.1, k * 0.71 + 3.3, fe * 5.3 + 11.0));
#else
  vec3 h = hash33(vec3(k * 1.37 + fe * 17.1, k * 0.71 + 3.3, fe * 5.3));
#endif
  vec3 h2 = hash33(h * 47.3 + vec3(1.7, 9.1, 3.3));
  int kind = int(Bq.w + 0.5);
  vec3 ax = F.xyz; float pl = F.w;
  vec3 dir = normalize(h * 2.0 - 1.0 + vec3(0.0, 1e-3, 0.0));
  vec3 sq = vec3(1.0, 0.5, 1.0);
  if (pl > 0.0) { dir = normalize(dir - ax * dot(dir, ax) * pl + vec3(1e-4, 2e-4, 0.0)); sq = vec3(1.0); }
  float drag = D.z, ed = exp(-drag * age), fdr = (1.0 - ed) / drag;
  vec3 o0, v0;
  float nPar = kind == 1 ? 3.0 : (kind == 3 ? 5.0 : 0.0);
  if (nPar > 0.0) {
    // clumps that break apart: every particle belongs to a parent clump; the
    // children start packed into one dense lump and drift apart as it disintegrates
    float pi = mod(k, nPar);
    vec3 hp = hash33(vec3(pi * 3.7 + fe * 17.1, fe * 2.3 + 1.0, pi * 1.3 + 7.7));
    vec3 pdir = normalize(hp * 2.0 - 1.0 + vec3(0.0, 1e-3, 0.0));
    vec3 pOff = pdir * (0.25 + 0.75 * hp.x) * Bq.x * 0.55 * sq;
    vec3 pv = normalize(pdir + C.xyz) * Bq.y * (0.6 + 0.5 * hp.y);
    float brk = Bq.x * (0.22 + 0.7 * (1.0 - exp(-age * 2.2)));
#ifdef BLOB
    o0 = pOff + dir * pow(h2.x, 0.6) * brk;
#else
    o0 = pOff + dir * pow(h2.x, 0.5) * brk * 1.4;
#endif
    v0 = pv + dir * Bq.y * 0.3 * h2.y;
  } else {
    o0 = dir * pow(h2.x, 0.4) * Bq.x * sq;
    v0 = normalize(dir + C.xyz) * Bq.y * (0.35 + 0.9 * h2.y);
  }
  vec3 wp = A.xyz + o0 + v0 * fdr + windDir3() * E.z * age;
  wp.y -= D.y / drag * (age - fdr);
  gVel = v0 * ed + windDir3() * E.z - vec3(0.0, D.y / drag * (1.0 - ed), 0.0);
  float life = C.w;
  float env = smoothstep(0.0, 0.08, age - D.x + 0.08 * step(0.001, D.x)) * (1.0 - smoothstep(life * 0.4, life, age));
#ifdef BLOB
  float rW = Bq.z * (0.5 + 0.7 * h2.z) * (0.55 + 0.9 * (1.0 - exp(-age * 1.3)));
  if (nPar > 0.0) rW *= 0.55 + 0.45 * h.y;   // fragments: a spread of sizes
  float minPx = 3.0 * uPx;
#else
  float rW = Bq.z * (0.35 + 1.2 * h2.z * h2.z);
  float minPx = 1.2 * uPx;
  gCocCap = 6.0 * uPx;   // flakes stay flakes (streaks), not bokeh balls
#endif
  float rD, eT, eC;
#ifdef BLOB
  // falling powder stretches into soft vertical veils
  float aspect = (kind == 1 || kind == 3) ? mix(1.0, 0.7, smoothstep(0.3, 1.6, age)) : 1.0;
#else
  float aspect = 1.0;
#endif
  if (!placeSpriteA(wp, rW, minPx, 0.0, 1.0, aspect, rD, eT, eC)) { cull(); return; }
  vec3 V = normalize(wp - cameraPosition);
  float c = dot(V, uSunDir);
  float sh = shadowV(wp);
  vec3 amb = uSkyAmbient * 1.15 + uSkyHorizon * 0.3;
  vec3 rad; float op;
  if (kind == 0) {
    rad = C_POLLEN * (uSunColor * sh * (0.3 + 1.8 * hgPhase(c, 0.6)) + amb * 0.5 + 0.9) * D.w;
#ifdef BLOB
    op = 0.0;
#else
    op = 0.75;
#endif
  } else {
    rad = C_RIME * (amb + uSunColor * sh * (0.35 + 1.5 * hgPhase(c, 0.55))) * D.w;
#ifndef BLOB
    float tw = pow(0.5 + 0.5 * sin(uTime * (7.0 + 9.0 * h.y) + h.z * 30.0), 3.0);
    rad *= 1.3 + 5.0 * tw * (0.3 + hgPhase(c, 0.75));
#endif
    op = 1.0;
  }
  float cov = env * E.w;
#ifdef BLOB
  cov *= (kind == 0 ? 0.5 : (nPar > 0.0 ? 0.6 : 1.0)) * pow(eT, 0.5);
  // sun direction across the sprite (view space) + back-light amount
  vec3 sv = (viewMatrix * vec4(uSunDir, 0.0)).xyz;
  vAux2 = vec4(normalize(sv.xy + 1e-5) * length(sv.xy), pow(max(c, 0.0), 2.0) * sh, h.x);
  // very near blobs would cover the whole frame many times over: fade them
  cov *= 1.0 - smoothstep(1.0, 1.8, rD / uRes.y);
#else
  cov *= min(1.0, pow(eC, 0.8) * 1.6);
  vAux2 = vec4(0.0);
#endif
  vCol = vec4(rad, op);
  vAux = vec4(float(kind), aspect, 0.0, cov);
}`;
const EV_FS = /* glsl */`${FX_GLSL}
void main() {
  vec2 uv = strUV(vSpr.xy);
  uv.x /= max(vAux.y, 0.1);
  float d = length(uv);
#ifdef BLOB
  float n1 = vnoise(uv * 2.2 + vAux2.w * 37.0), n2 = vnoise(uv * 4.7 + vAux2.w * 11.0);
  float dd = max(d + (n1 - 0.5) * 0.42 + (n2 - 0.5) * 0.16, 0.0);
  float m = exp(-dd * dd * 3.2) * (1.0 - smoothstep(0.85, 1.0, d));
  float lit = smoothstep(-0.9, 0.9, dot(uv, vAux2.xy) + (n1 - 0.5) * 0.5);
  // sun-backlit powder: thin edges glow warm, the dense core stays cool
  vec3 warm = vCol.rgb * vec3(1.22, 1.0, 0.72);
  vec3 col = vCol.rgb * (0.62 + 0.46 * lit) + warm * vAux2.z * 1.6 * smoothstep(0.3, 0.9, dd);
  float op = vAux.x < 0.5 ? 0.0 : 1.0;
  float soft = 0.4 + 0.1 * vSpr.w;
#else
  float m = spriteMask(uv, vSpr.z, 0.1);
  vec3 col = vCol.rgb;
  float op = vCol.a;
  float soft = 0.05 + 0.05 * vSpr.w;
#endif
  float occ = softOcc(vSpr.w, soft);
  float k = vAux.w * m * occ * strK();
  if (k < 1e-5) discard;
  gl_FragColor = vec4(col * k, min(op * k, 1.0));
}`;

// ---- lens snow (camera-locked): the white-out build (powder kicked up in front
// of the lens fills the frame from the bottom up) and the reveal clear (the
// powder streaks off the frame edges, centre first). Positions are authored in
// screen space (ndc + depth), so the choreography holds whatever the camera
// does; streaks come from the authored screen velocity. Shares EV_FS.
const LENS_NB = 52, LENS_NG = 520;
const LENS_VS = /* glsl */`${FX_GLSL}
uniform vec4 uLM; // mode (0 build, 1 clear), t0, t1, amount
void main() {
  float k = aI;
#ifdef BLOB
  vec3 h = hash33(vec3(k * 1.37 + 3.1, k * 0.71 + 9.3, 17.0));
#else
  vec3 h = hash33(vec3(k * 1.37 + 5.7, k * 0.71 + 2.3, 29.0));
#endif
  vec3 h2 = hash33(h * 47.3 + vec3(1.7, 9.1, 3.3));
  float th = 1.0 / projectionMatrix[1][1], asp = projectionMatrix[1][1] / projectionMatrix[0][0];
  vec2 p, v; float z, rN, env;
  if (uLM.x < 0.5) {
    // build: spawn rate rises toward t1; every puff enters below the frame and
    // rises (with a little zoom-burst spread) through it
    float ts = mix(uLM.y, uLM.z, pow(h.x, 0.75));
    float age = uTime - ts;
    if (age < 0.0) { cull(); return; }
#ifdef BLOB
    z = 0.5 + 1.8 * h.y;
    float vy = 7.5 + 6.0 * h2.y;
    float rN0 = 0.36 + 0.44 * h2.z;
    rN = rN0 * (1.0 + 1.4 * age);
#else
    if (k > 240.0) { cull(); return; }
    z = 0.5 + 2.5 * h.y;
    float vy = 6.0 + 7.0 * h2.y;
    float rN0 = (0.0018 + 0.003 * h2.z) / z;
    rN = rN0;
#endif
    float x0 = (h.z * 2.0 - 1.0) * 1.15;
    p = vec2(x0 * (1.0 + 0.7 * age), -1.15 - rN0 - 0.15 * h2.x + vy * age);
    v = vec2(x0 * 0.7, vy);
    env = smoothstep(0.0, 0.03, age);
  } else {
    // clear: start covering the frame, then accelerate radially off the edges
    float age = uTime - uLM.y, dur = uLM.z - uLM.y;
    if (age < 0.0 || age > dur + 0.05) { cull(); return; }
    vec2 p0 = (vec2(h.y, h.z) * 2.0 - 1.0) * vec2(1.1, 1.05);
    vec2 dir = normalize(p0 * vec2(asp, 1.0) + vec2(1e-3, 0.0)) / vec2(asp, 1.0);
#ifdef BLOB
    z = 0.6 + 1.8 * h2.x;
    float s = 0.6 + 0.8 * h2.y;
    float D = s * (0.4 * age + 9.0 * age * age), dD = s * (0.4 + 18.0 * age);
    rN = (0.32 + 0.34 * h2.z) * (1.0 + 0.8 * age);
#else
    z = 0.3 + 2.4 * h2.x;
    float s = 0.8 + 1.0 * h2.y;
    float D = s * (1.0 * age + 14.0 * age * age), dD = s * (1.0 + 28.0 * age);
    rN = (0.0035 + 0.006 * h2.z) / z;
#endif
    p = p0 + dir * D; v = dir * dD;
    env = 1.0 - smoothstep(dur * 0.75, dur, age);
  }
  if (abs(p.x) - rN / asp > 1.05 || abs(p.y) - rN > 1.05) { cull(); return; }
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 fwd = -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
  vec3 wp = cameraPosition + right * (p.x * z * th * asp) + up * (p.y * z * th) + fwd * z;
  gScreenStr = true; gStrPx = v * uSubDt * 0.5 * uRes;
  float rW = rN * z * th;
#ifdef BLOB
  float minPx = 3.0 * uPx;
#else
  float minPx = 1.2 * uPx;
  gCocCap = 6.0 * uPx;
#endif
  float rD, eT, eC;
  if (!placeSpriteA(wp, rW, minPx, 0.0, 1.0, 1.0, rD, eT, eC)) { cull(); return; }
  vec3 V = normalize(wp - cameraPosition);
  float c = dot(V, uSunDir);
  vec3 amb = uSkyAmbient * 1.15 + uSkyHorizon * 0.3;
  vec3 rad = C_RIME * (amb + uSunColor * (0.35 + 1.5 * hgPhase(c, 0.55)));
  float cov = env * uLM.w;
#ifdef BLOB
  cov *= 0.62 * pow(eT, 0.5);
  vec3 sv = (viewMatrix * vec4(uSunDir, 0.0)).xyz;
  vAux2 = vec4(normalize(sv.xy + 1e-5) * length(sv.xy), pow(max(c, 0.0), 2.0), h.x);
#else
  float tw = pow(0.5 + 0.5 * sin(uTime * (7.0 + 9.0 * h.y) + h.z * 30.0), 3.0);
  rad *= 0.8 + 1.5 * tw * (0.3 + hgPhase(c, 0.75));
  cov *= min(1.0, pow(eC, 0.8) * 1.2) * 0.7;
  vAux2 = vec4(0.0);
#endif
  vCol = vec4(rad, 1.0);
  vAux = vec4(1.0, 1.0, 0.0, cov);
}`;

// ---- out-of-focus petals (aerial): CPU paths in uniform arrays
const PETAL_VS = /* glsl */`${FX_GLSL}
uniform vec4 uPP[8]; // xyz, half length
uniform vec4 uPQ[8]; // angle, squash (signed), alpha, blur px(4K)
void main() {
  int i = int(aI);
  vec4 P = uPP[i], Q = uPQ[i];
  if (Q.z <= 0.001) { cull(); return; }
  float rD, eT, eC;
  gNearOK = true; gStreak = false;   // staged relative to the camera
  gCocCap = 0.0;                     // the blur is authored per petal (Q.w)
  if (!placeSpriteA(P.xyz, P.w, 2.0 * uPx, Q.w * uPx, 1.0, 1.0, rD, eT, eC)) { cull(); return; }
  vec3 V = normalize(P.xyz - cameraPosition);
  float c = dot(V, uSunDir);
  vec3 amb = uSkyAmbient * 1.1 + uSkyHorizon * 0.3;
  vec3 rad = C_VIOLET * (uSunColor * (0.25 + 0.75 * abs(Q.y)) * 0.32 + amb * 0.6) + C_BACKLIT * uSunColor * 0.25 * hgPhase(c, 0.5);
  vCol = vec4(rad, 1.0);
  vAux = vec4(Q.x, Q.y, eC, Q.z * min(1.0, pow(eT, 0.25) * 1.1));
  vAux2 = vec4(0.0);
}`;
const PETAL_FS = /* glsl */`${FX_GLSL}
void main() {
  float ca = cos(vAux.x), sa = sin(vAux.x);
  vec2 p = mat2(ca, -sa, sa, ca) * vSpr.xy;
  float core = sqrt(max(vAux.z, 1e-4));
  p /= core;
  float sq = max(abs(vAux.y), 0.12);
  p.y /= sq;
  float u = clamp(p.x * 0.5 + 0.5, 0.0, 1.0);
  // pasque tepal: narrow base, widest ~60% along, pointed tip (w/l ~0.4)
  float w = 0.42 * pow(max(sin(3.14159 * pow(u, 1.357)), 0.0), 0.75);
  float sd = max(abs(p.y) - w, abs(p.x) - 1.0);
  float blurU = (1.0 - core) / core + 1.5 / (vSpr.z * core);
  float m = 1.0 - smoothstep(-blurU, blurU, sd * mix(1.0, sq, 0.5));
  // dark violet base -> light tip, darker midrib, thin edges glowing when backlit
  vec3 col = vCol.rgb * mix(0.55, 1.35, u) * (1.0 - 0.22 * exp(-abs(p.y) * 30.0));
  col += C_BACKLIT * uSunColor * 0.06 * smoothstep(-0.12, 0.0, sd);
  float occ = softOcc(vSpr.w, 0.2);
  float k = min(vAux.w * m * occ * 0.95, 1.0);
  if (k < 1e-5) discard;
  gl_FragColor = vec4(col * k, k);
}`;

// ---- birds: instanced deforming silhouettes
const BIRD_VS = /* glsl */`${PALETTE_GLSL}
uniform vec2 uRes; uniform float uPx; uniform float uMinSpanPx;
attribute vec4 aWing;  // side, span s, chord c, part (0 body, 1 wing, 2 tail)
attribute float aBelly;
attribute vec4 aFlap;  // (instanced) phase, amplitude, dihedral, sweep
varying vec3 vN; varying vec3 vW; varying float vViewZ; varying vec2 vB; varying vec2 vC;
#ifdef HERO
// lens jitter per subframe (unit-disc sample) and the CoC gain (px @2160p) relative
// to the bird's centre depth: the eye/body stays sharp, the near wing defocuses
uniform vec2 uLens; uniform float uLensK;
#endif
void main() {
  vec3 p = position; vec3 n = normal;
  float side = aWing.x, s = aWing.y;
  // distant birds: keep a minimum on-screen span, and fatten chord/body so a
  // 6-10 px bird still reads as a little dark checkmark instead of a 1 px line
  vec3 center = instanceMatrix[3].xyz;
  float sc = length(instanceMatrix[0].xyz);
  float zc = max(-(viewMatrix * vec4(center, 1.0)).z, 1e-3);
  float spanPx = sc * projectionMatrix[1][1] * 0.5 * uRes.y / zc;
  float grow = clamp(uMinSpanPx * uPx / max(spanPx, 1e-4), 1.0, 80.0);
  float span4k = spanPx * grow / uPx;                       // final on-screen span in 2160p pixels
  float fat = mix(2.2, 1.0, smoothstep(14.0, 56.0, span4k));
  if (aWing.w > 0.5 && aWing.w < 1.5) {
    float x0 = 0.025;
    float r = abs(p.x) - x0;
    float fold = max(0.0, cos(aFlap.x)) * aFlap.y;          // upstroke: wing partly folds
    r *= 1.0 - 0.22 * fold * s;
    float th = aFlap.z + aFlap.y * sin(aFlap.x - 0.75 * s) * (0.55 + 0.45 * s);
    float c = cos(th), sn = sin(th);
    vec2 q = vec2(r * c - p.y * sn, r * sn + p.y * c);
    p.x = side * (x0 + q.x);
    p.y = q.y;
    p.z -= aFlap.w * s * s * 0.14 + 0.05 * fold * s * s;
    n = normalize(vec3(n.x * c - side * n.y * sn, side * n.x * sn + n.y * c, n.z));
    p.z *= fat; p.y *= mix(1.0, fat, 0.5);
  } else {
    p.y += 0.006 * sin(aFlap.x + 3.14159) * aFlap.y;
    if (aWing.w > 1.5) p.x *= 1.0 + 0.25 * aFlap.w;            // tail spreads a little when gliding
    p.x *= fat; p.y *= fat;
  }
  vec4 wp = instanceMatrix * vec4(p * grow, 1.0);
  vW = wp.xyz;
  vN = normalize(mat3(instanceMatrix) * n);
  vec4 vp = viewMatrix * wp;
  vViewZ = -vp.z;
  vB = vec2(aBelly, aWing.w);
  vC = aWing.yz;
  gl_Position = projectionMatrix * vp;
#ifdef HERO
  float coc = uLensK * uPx * abs(1.0 - zc / max(vViewZ, 1e-3));
  gl_Position.xy += uLens * min(coc, 40.0 * uPx) * 2.0 / uRes * gl_Position.w;
#endif
}`;
const BIRD_FS = /* glsl */`${PALETTE_GLSL}
uniform sampler2D tDepth; uniform vec2 uRes; uniform vec4 uCamP; uniform float uRim;
uniform vec3 uTop; uniform vec3 uBelly;
varying vec3 vN; varying vec3 vW; varying float vViewZ; varying vec2 vB; varying vec2 vC;
float linZ(float d) { float z = d * 2.0 - 1.0; return 2.0 * uCamP.x * uCamP.y / (uCamP.y + uCamP.x - z * (uCamP.y - uCamP.x)); }
void main() {
  float sz = linZ(texture2D(tDepth, gl_FragCoord.xy / uRes).x);
  if (sz < vViewZ * 0.995 - 0.02) discard;
  vec3 V = normalize(cameraPosition - vW);
  vec3 N = normalize(vN); if (dot(N, V) < 0.0) N = -N;
  vec3 alb = mix(uTop, uBelly, vB.x);
  float ndl = dot(N, uSunDir);
  float diff = smoothstep(-0.05, 0.55, ndl);
  vec3 hemi = mix(uGroundBounce, uSkyAmbient, N.y * 0.5 + 0.5);
  float back = pow(max(dot(-V, uSunDir), 0.0), 3.0);
  float fres = pow(1.0 - max(dot(N, V), 0.0), 2.5);
  bool wing = vB.y > 0.5 && vB.y < 1.5;
#ifdef HERO
  // the close-up swift: sooty brown-black with a pale throat, slight gloss on the
  // body, flight feathers darker toward the trailing edge and glowing warm where
  // the low sun shines through them, a hot sun rim on every silhouette edge
  if (wing) alb *= mix(1.15, 0.7, smoothstep(0.35, 1.0, vC.y));
  vec3 col = alb * (uSunColor * diff * 0.45 + hemi * 0.75);
  vec3 Hh = normalize(uSunDir + V);
  col += uSunColor * 0.035 * pow(max(dot(N, Hh), 0.0), 48.0) * step(0.0, ndl) * (wing ? 0.4 : 1.0);   // slight gloss
  float edgeT = wing ? smoothstep(0.5, 1.0, vC.y) * 1.4 + smoothstep(0.8, 1.0, vC.x) + 0.4 * smoothstep(0.2, 0.0, vC.y) : 0.0;
  col += uSunColor * vec3(1.0, 0.74, 0.46) * 0.03 * back * (0.1 + edgeT) * (wing ? 1.0 : 0.2);
  col += uSunColor * vec3(1.0, 0.84, 0.6) * (0.06 * fres + 0.55 * back * fres * fres) * uRim;
#else
  vec3 col = alb * (uSunColor * diff * 0.4 + hemi * 0.55);
  col += uSunColor * vec3(1.0, 0.86, 0.66) * (0.04 * fres + 0.3 * back * (0.25 + fres)) * uRim;
  col += uSunColor * vec3(0.30, 0.22, 0.14) * 0.05 * back * (wing ? 1.0 : 0.0);
#endif
  col = applyFog(col, vW);
  gl_FragColor = vec4(col, 1.0);
}`;

// ------------------------------------------------------------------ helpers
function quadGeo(count) {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  const ids = new Float32Array(count); for (let i = 0; i < count; i++) ids[i] = i;
  g.setAttribute('aI', new THREE.InstancedBufferAttribute(ids, 1));
  g.instanceCount = count;
  g.boundingSphere = new THREE.Sphere(new V3(), 1e9);
  return g;
}

// Stylised swallow / swift: lofted body, scythe wings (3 verts per section for
// camber), forked tail. Unit span (tip to tip ~1).
// Catmull-Rom refinement of a list of numeric rows (smooth silhouettes for the
// close-up swift)
function refineRows(rows, f) {
  if (f <= 1) return rows;
  const out = [], n = rows.length;
  const at = i => rows[Math.max(0, Math.min(n - 1, i))];
  for (let j = 0; j < n - 1; j++) {
    for (let k = 0; k < f; k++) {
      const u = k / f, u2 = u * u, u3 = u2 * u;
      const p0 = at(j - 1), p1 = at(j), p2 = at(j + 1), p3 = at(j + 2);
      out.push(p1.map((_, c) => 0.5 * (2 * p1[c] + (-p0[c] + p2[c]) * u + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * u2 + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * u3)));
    }
  }
  out.push(rows[n - 1].slice());
  return out;
}
function buildBird(kind, hi = false) {
  const sw = kind === 'swift';
  const P = [], N = [], Wg = [], Bl = [], I = [];
  const v = (x, y, z, nx, ny, nz, side, s, c, part, belly) => { P.push(x, y, z); N.push(nx, ny, nz); Wg.push(side, s, c, part); Bl.push(belly); return P.length / 3 - 1; };
  const prof = refineRows(sw
    ? [[0.15, 0.004, 0.004], [0.13, 0.016, 0.014], [0.10, 0.026, 0.022], [0.06, 0.030, 0.026], [0.02, 0.031, 0.027], [-0.03, 0.027, 0.023], [-0.08, 0.019, 0.016], [-0.115, 0.010, 0.008]]
    : [[0.16, 0.003, 0.003], [0.14, 0.015, 0.013], [0.11, 0.025, 0.022], [0.07, 0.028, 0.025], [0.03, 0.033, 0.029], [-0.02, 0.030, 0.026], [-0.07, 0.021, 0.018], [-0.11, 0.011, 0.009]], hi ? 3 : 1);
  const RS = hi ? 16 : 8;
  const rings = prof.map(([z, w, h]) => {
    const ids = [];
    for (let k = 0; k < RS; k++) {
      const a = k / RS * TAU, ca = Math.cos(a), sa = Math.sin(a);
      const nx = ca / w, ny = sa / h, nl = Math.hypot(nx, ny);
      // swallow: pale belly; swift: pale throat patch under the chin only
      const belly = sw ? smoothstep(0.09, 0.125, z) * smoothstep(-0.35, -0.8, sa) : (sa < -0.35 ? 1 : 0);
      ids.push(v(ca * w, sa * h, z, nx / nl, ny / nl, 0, 0, 0, 0, 0, belly));
    }
    return ids;
  });
  for (let r = 0; r < rings.length - 1; r++) for (let k = 0; k < RS; k++) {
    const a = rings[r][k], b = rings[r][(k + 1) % RS], c = rings[r + 1][k], d = rings[r + 1][(k + 1) % RS];
    I.push(a, c, b, b, c, d);
  }
  const nose = v(0, 0, prof[0][0] + 0.012, 0, 0, 1, 0, 0, 0, 0, 0);
  for (let k = 0; k < RS; k++) I.push(nose, rings[0][(k + 1) % RS], rings[0][k]);
  // wings
  const sec = refineRows(sw
    ? [[0, 0.022, 0.05, 0.022, -0.04], [0.15, 0.07, 0.06, 0.07, -0.05], [0.3, 0.13, 0.06, 0.125, -0.055], [0.45, 0.2, 0.045, 0.19, -0.065], [0.6, 0.28, 0.01, 0.26, -0.08], [0.75, 0.36, -0.04, 0.34, -0.1], [0.88, 0.43, -0.1, 0.415, -0.135], [1, 0.5, -0.175, 0.495, -0.185]]
    : [[0, 0.025, 0.06, 0.025, -0.05], [0.15, 0.09, 0.075, 0.085, -0.065], [0.3, 0.16, 0.07, 0.15, -0.075], [0.45, 0.23, 0.045, 0.21, -0.085], [0.6, 0.3, 0.01, 0.28, -0.1], [0.75, 0.37, -0.035, 0.35, -0.12], [0.88, 0.43, -0.085, 0.41, -0.145], [1, 0.49, -0.15, 0.485, -0.165]], hi ? 3 : 1);
  for (const side of [-1, 1]) {
    const ids = sec.map(([s, xl, zl, xt, zt]) => {
      const xm = (xl + xt) * 0.5, zm = zl * 0.55 + zt * 0.45;
      return [
        v(side * xl, 0.002, zl, 0, 0.9, 0.44, side, s, 0, 1, 0),
        v(side * xm, 0.006 * (1 - s * 0.7), zm, 0, 1, 0, side, s, 0.5, 1, 0),
        v(side * xt, 0.0, zt, 0, 0.95, -0.3, side, s, 1, 1, 0),
      ];
    });
    for (let j = 0; j < ids.length - 1; j++) {
      const [a0, b0, c0] = ids[j], [a1, b1, c1] = ids[j + 1];
      I.push(a0, b0, a1, b0, b1, a1, b0, c0, b1, c0, c1, b1);
    }
  }
  // forked tail
  const T = sw
    ? { bx: 0.02, bz: -0.1, ox: 0.04, oz: -0.165, tx: 0.058, tz: -0.255, nz: -0.15 }
    : { bx: 0.022, bz: -0.1, ox: 0.046, oz: -0.19, tx: 0.088, tz: -0.37, nz: -0.168 };
  const bc = v(0, 0, -0.105, 0, 1, 0, 0, 0, 0, 2, 0), nc = v(0, 0, T.nz, 0, 1, 0, 0, 0, 0, 2, 0);
  for (const side of [-1, 1]) {
    const bl = v(side * T.bx, 0, T.bz, 0, 1, 0, 0, 0, 0, 2, 0);
    const ol = v(side * T.ox, 0, T.oz, 0, 1, 0, 0, 0, 0, 2, 0);
    const tl = v(side * T.tx, 0, T.tz, 0, 1, 0, 0, 0, 0, 2, 0);
    I.push(bc, bl, ol, bc, ol, nc, nc, ol, tl);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('aWing', new THREE.Float32BufferAttribute(Wg, 4));
  g.setAttribute('aBelly', new THREE.Float32BufferAttribute(Bl, 1));
  g.setIndex(I);
  return g;
}

const SPRITE_BLEND = {
  transparent: true, depthWrite: false, depthTest: true,
  blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
  blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
};

// ------------------------------------------------------------------ module
export async function create(ctx) {
  const { engine, data, W, H, q, camera } = ctx;
  const only = q.get('fx');
  const on = name => !only || only.split(',').includes(name);
  const rig = makeCameraRig(data);
  const HT = data.heightAt;

  // ---- inverse bloom clock t(D)
  const inv = new Float32Array(INV_N);
  { let tt = TIMES.hit; for (let k = 0; k < INV_N; k++) { const D = k / (INV_N - 1) * D_MAX; while (tt < 40 && bloomD(tt) < D) tt += 0.002; inv[k] = tt; } }
  const invTex = new THREE.DataTexture(inv, INV_N, 1, THREE.RedFormat, THREE.FloatType);
  invTex.minFilter = invTex.magFilter = THREE.LinearFilter; invTex.wrapS = invTex.wrapT = THREE.ClampToEdgeWrapping;
  invTex.generateMipmaps = false; invTex.needsUpdate = true;
  const tOfD = D => { const u = Math.min(1, Math.max(0, D / D_MAX)) * (INV_N - 1); const i = Math.min(INV_N - 2, Math.floor(u)); return lerp(inv[i], inv[i + 1], u - i); };

  // ---- particle clock (slow-mo through the held breath, snaps back at the hit)
  // rate 1 -> 0.3 over [held-0.08, held+0.22], 0.3 until the hit, then 1 again
  const tau = t => {
    const a = TIMES.held - 0.08, b = TIMES.held + 0.22, w = b - a;
    if (t <= a) return t;
    if (t <= b) { const x = t - a; return a + x - 0.7 * x * x / (2 * w); }
    const tb = b - 0.7 * w / 2;
    if (t <= TIMES.hit) return tb + 0.3 * (t - b);
    return tb + 0.3 * (TIMES.hit - b) + (t - TIMES.hit);
  };
  const tauHit = tau(TIMES.hit);

  const SK = Math.sinh(L.GRID.k);
  const FXU = {
    tDepth: { value: engine.sceneRT.depthTexture },
    uRes: { value: new THREE.Vector2(W, H) },
    uCamP: { value: new V4(0.05, 60000, 10, 0) },
    uMaxCoc: { value: 30 * H / 2160 },
    uPx: { value: H / 2160 },
    uTau: { value: 0 },
    tInvClock: { value: invTex },
    tHeight: { value: data.heightTex },
    uGrid: { value: new V4(L.GRID.cx, L.GRID.cz, L.GRID.Lx, L.GRID.Lz) },
    uGridK: { value: new V3(L.GRID.k, 1 / SK, L.GRID.N - 1) },
    uVP0: { value: new THREE.Matrix4() }, uVP1: { value: new THREE.Matrix4() }, uSubDt: { value: 0 },
    uTauRate: { value: 1 },
  };
  // view-projection of the (shot-clamped) camera rig at time tt, for streaks
  const scam = new THREE.PerspectiveCamera(40, W / H, 0.05, 60000);
  const vpAt = (tt, shot, out) => {
    const c = rig.at(Math.min(Math.max(tt, shot.t0), shot.t1 - 1e-4));
    scam.position.copy(c.pos); scam.up.set(0, 1, 0); scam.lookAt(c.target); scam.rotateZ(c.roll || 0);
    scam.fov = c.fov; scam.near = c.near; scam.far = c.far; scam.updateProjectionMatrix(); scam.updateMatrixWorld(true);
    return out.multiplyMatrices(scam.projectionMatrix, scam.matrixWorldInverse);
  };
  // the engine spreads spp subframes over the shutter: recover the shutter from
  // the first subframe's offset (it is never the centre sample when spp > 1)
  let shutterGuess = 0.5 / 30;
  const subDt = (t, sub) => {
    if (sub && sub.slice !== undefined) return sub.slice;   // shutter clamped at a cut (engine)
    if (!sub || !(sub.spp > 1) || sub.frameTime === undefined) return 0;
    const den = (sub.sub + 0.5) / sub.spp - 0.5;
    if (Math.abs(den) > 1e-6) shutterGuess = Math.max(0, (t - sub.frameTime) / den);
    return shutterGuess / sub.spp;
  };
  const spriteMat = (vs, fs, own, defines = {}) => worldMaterial({ vertexShader: vs, fragmentShader: fs, uniforms: { ...FXU, ...own }, defines, ...SPRITE_BLEND }).material;
  const mkMesh = (geo, mat, order) => { const m = new THREE.Mesh(geo, mat); m.frustumCulled = false; m.renderOrder = order; m.visible = false; return m; };
  const overlayObjs = [];
  const add = m => { overlayObjs.push(m); return m; };

  // camera frame helper (own rig instance: never mutates the world's ctx.cam)
  const frameAt = t => {
    const c = rig.at(t);
    const pos = c.pos.clone(), fwd = c.target.clone().sub(c.pos).normalize();
    const right = new V3().crossVectors(fwd, Y).normalize();
    const up = new V3().crossVectors(right, fwd).normalize();
    return { pos, fwd, right, up, fov: c.fov };
  };

  // ================================================================ snow + motes
  const boxU = () => ({ uBA: { value: new V4() }, uBB: { value: new V4() }, uBC: { value: new V4() }, uBD: { value: new V4() }, uBlast: { value: new V4() }, uSeed: { value: 0 }, uNearOK: { value: 0 }, uCocCap: { value: 1e6 } });
  const mkBox = (n, seed, order) => { const u = boxU(); u.uSeed.value = seed; return add(mkMesh(quadGeo(n), spriteMat(BOX_VS, BOX_FS, u), order)); };
  const snowNear = mkBox(Math.max(TUNE.snowMacro.nearN, TUNE.snowFpv.nearN), 1.3, 20);
  const snowFar = mkBox(Math.max(TUNE.snowMacro.farN, TUNE.snowFpv.farN), 7.9, 19);
  const motes = mkBox(TUNE.motes.n, 4.4, 21);
  const setBox = (m, o) => {
    const u = m.material.uniforms;
    u.uBA.value.set(o.B, o.fall, o.r, o.I ?? 1);
    u.uBB.value.set(o.wind ?? 0, o.sway ?? 0, o.minPx ?? 1.5, o.gate ?? 0);
    u.uBC.value.set(o.c.x, o.c.y, o.c.z, o.amt);
    u.uBD.value.set(o.minBlur ?? 0, o.gamma ?? 0.6, o.kind ?? 0, o.rim ?? 0);
    if (o.blast) u.uBlast.value.copy(o.blast); else u.uBlast.value.set(0, 0, 0, 0);
    u.uNearOK.value = o.nearOK ? 1 : 0;
    u.uCocCap.value = o.cocCap ?? 1e6;
    m.geometry.instanceCount = o.n;
    m.visible = o.amt > 0.001;
  };

  // ================================================================ hero crystals (macro)
  const heroU = { uHP: { value: Array.from({ length: NHERO }, () => new V4()) }, uHQ: { value: Array.from({ length: NHERO }, () => new V4()) } };
  const hero = add(mkMesh(quadGeo(NHERO), spriteMat(HERO_VS, HERO_FS, heroU), 22));
  const hf = frameAt(1.0);
  // camera-local paths (x right, y up, z forward, metres) on the slow-mo clock:
  // small (<= ~12 px @1080) irregular plates drifting down through the thin focal
  // slab around the bud (~0.13 m), so they sharpen and soften as they fall
  const HERO = (() => {
    const R = rng(5150), out = [];
    const span = tauHit + 0.4 - 0.15;
    for (let i = 0; i < NHERO; i++) {
      const a = 0.15 + (i + R() * 0.7) * span / NHERO, dur = 1.7 + R() * 1.1;
      let x0 = (R() * 2 - 1) * 0.036; if (Math.abs(x0) < 0.012) x0 = Math.sign(x0 || 1) * (0.012 + R() * 0.01);
      const y0 = 0.018 + R() * 0.012, z = 0.113 + R() * 0.042;
      out.push({ a, b: a + dur, p0: [x0, y0, z], p1: [x0 + (R() * 2 - 1) * 0.008, y0 - 0.032 - R() * 0.014, z + (R() * 2 - 1) * 0.006],
        r: 0.00016 + R() * 0.00009, spin: (R() * 2 - 1) * 0.8, tumble: 1.2 + R() * 2.2, ph: R() * TAU, seed: R() });
    }
    return out;
  })();
  const blastAt = t => (t < TIMES.hit ? 0 : 0.22 * (1 - Math.exp(-(t - TIMES.hit) * 7)));
  function updateHero(t) {
    const T = tau(t);
    const bud = rig.budHead, bs = blastAt(t);
    HERO.forEach((h, i) => {
      const u = (T - h.a) / (h.b - h.a);
      const x = lerp(h.p0[0], h.p1[0], u) + 0.0012 * Math.sin(T * 1.7 + h.ph), y = lerp(h.p0[1], h.p1[1], u), z = lerp(h.p0[2], h.p1[2], u);
      const p = hf.pos.clone().addScaledVector(hf.right, x).addScaledVector(hf.up, y).addScaledVector(hf.fwd, z);
      if (bs > 0) { const d = p.clone().sub(bud); const dl = Math.max(d.length(), 1e-4); p.addScaledVector(d, bs * Math.exp(-dl / 0.3) / dl); }
      const alpha = smoothstep(0, 0.15, u) * (1 - smoothstep(0.85, 1.0, u)) * (1 - smoothstep(TIMES.pullStart - 0.1, TIMES.pullStart + 0.15, t));
      heroU.uHP.value[i].set(p.x, p.y, p.z, h.r);
      heroU.uHQ.value[i].set(h.ph + h.spin * T, u > 0 && u < 1 ? alpha : 0, h.seed, h.ph * 1.3 + h.tumble * T);
    });
  }

  // ================================================================ sparkles
  const sparkU = () => ({ uLA: { value: new V4() }, uLB: { value: new V4() }, uLC: { value: new V4() }, uSeed: { value: 0 } });
  const LAYERS = [
    { name: 'micro', cell: 0.07, N: 72, seed: 3.1 },
    { name: 'near', cell: 0.4, N: 100, seed: 5.7 },
    { name: 'mid', cell: 2.2, N: 120, seed: 8.3 },
    { name: 'far', cell: 14.0, N: 210, seed: 11.9 },
  ].map((l, i) => { const u = sparkU(); u.uSeed.value = l.seed; return { ...l, mesh: add(mkMesh(quadGeo(l.N * l.N), spriteMat(SPARK_VS, SPARK_FS, u), 12 + i)) }; });
  const setLayer = (l, o, cx, cz) => {
    const u = l.mesh.material.uniforms;
    u.uLA.value.set(l.cell, l.N, o.rMin, o.rMax);
    u.uLB.value.set(o.fade, o.S, (o.I ?? 1) * TUNE.sparkle.intensity, (o.mist ?? 0.15) * TUNE.sparkle.mist);
    u.uLC.value.set(cx, cz, o.active ?? 0.6, o.amt ?? 1);
    l.mesh.visible = (o.amt ?? 1) > 0.001;
  };

  // ================================================================ flower pollen puffs at the front
  const fpU = { uPA: { value: new V4(1.1, 44, 8, 22) }, uPB: { value: new V4() }, uSeed: { value: 2.2 } };
  const fpuff = add(mkMesh(quadGeo(44 * 44 * 8), spriteMat(FPUFF_VS, FPUFF_FS, fpU), 17));

  // ================================================================ bursts (one-shot events)
  const evU = () => ({
    uEvA: { value: Array.from({ length: MAXEV }, () => new V4(0, 0, 0, 1e6)) }, uEvB: { value: Array.from({ length: MAXEV }, () => new V4()) },
    uEvC: { value: Array.from({ length: MAXEV }, () => new V4()) }, uEvD: { value: Array.from({ length: MAXEV }, () => new V4(0, 0, 1, 1)) },
    uEvE: { value: Array.from({ length: MAXEV }, () => new V4()) }, uEvF: { value: Array.from({ length: MAXEV }, () => new V4()) }, uPer: { value: 0 },
  });
  const BLOB_PER = 40, GRAIN_PER = 520;
  const blobU = evU(), grainU = evU();
  blobU.uPer.value = BLOB_PER; grainU.uPer.value = GRAIN_PER;
  const blobs = add(mkMesh(quadGeo(MAXEV * BLOB_PER), spriteMat(EV_VS, EV_FS, blobU, { BLOB: 1 }), 24));
  const grains = add(mkMesh(quadGeo(MAXEV * GRAIN_PER), spriteMat(EV_VS, EV_FS, grainU), 25));
  const EVENTS = [];
  if (TUNE.hitPollen) EVENTS.push({ shots: ['macro'], t0: TIMES.hit, src: rig.budHead.clone().add(new V3(0, 0.01, 0)), spread: 0.006, speed: 0.2, blob: 0.012, grain: 0.00032, kind: 0, dir: [0, 0.5, 0], life: 3.4, pre: 0, grav: -0.01, drag: 1.6, I: 1.0, nB: 0, nG: 260, wind: 0.015, op: 1 });
  {
    // Canopy (the camera skims ~1-5 m over the crowns at ~60 m/s): crowns along
    // the flight path shed snow as we pass, 16.0-16.5. Each shed is 3 packed
    // clumps that break apart into powder + ~300 flakes. Sources sit just under
    // and beside the path at the point the camera crosses a moment later.
    const R = rng(1640);
    const S = (f, a, b, c) => f.pos.clone().addScaledVector(f.fwd, a).addScaledVector(f.right, b).addScaledVector(Y, c);
    const t0s = TIMES.whiteout - 0.42, t1s = TIMES.whiteout + 0.06;
    const base = { shots: ['canopy'], spread: 1.5, speed: 1.6, kind: 1, dir: [0, -0.35, 0], life: 2.2, pre: 0.05, grav: 2.2, drag: 1.4, I: 1, wind: 0.8, op: 0.55 };
    for (let i = 0; i < 6; i++) {
      const ts = lerp(t0s, t1s, i / 5) + (R() - 0.5) * 0.03, lead = 0.17 + R() * 0.08;
      const f = frameAt(Math.min(ts + lead, TIMES.cut4 - 0.01));
      EVENTS.push({ ...base, t0: ts, src: S(f, R() * 1.5, (i % 2 ? 1 : -1) * (1.7 + R() * 2.4), -(2.0 + R() * 1.3)), blob: 0.5 + R() * 0.2, grain: 0.032, nB: 39, nG: 420 });
    }
    // two bigger slides further ahead, readable for longer as falling plumes
    for (const [ts, lead, side] of [[TIMES.whiteout - 0.47, 0.62, -8], [TIMES.whiteout - 0.26, 0.66, 9]]) {
      const f = frameAt(Math.min(ts + lead, TIMES.cut4 - 0.01));
      EVENTS.push({ ...base, t0: ts, src: S(f, 0, side, -2.4), spread: 2.2, speed: 1.9, blob: 0.85, grain: 0.04, nB: 39, nG: 500, life: 2.4 });
    }
  }
  // White-out build (canopy) and reveal clear: camera-locked lens snow. Core holds
  // pure white across the 16.79 cut; the build reaches full cover by ~16.72 and
  // the clear opens from the centre out, gone by the arrival beat.
  const lensU = { uLM: { value: new V4() } };
  const lensBlobs = add(mkMesh(quadGeo(LENS_NB), spriteMat(LENS_VS, EV_FS, lensU, { BLOB: 1 }), 27));
  const lensGrains = add(mkMesh(quadGeo(LENS_NG), spriteMat(LENS_VS, EV_FS, lensU), 28));
  const LENS_BUILD = [TIMES.whiteout + 0.04, TIMES.cut4 - 0.02];
  const LENS_CLEAR = [TIMES.cut4, (TIMES.arrival ?? TIMES.cut4 + 0.52) + 0.02];
  function updateLens(t, shot) {
    let on2 = false;
    if (shot === 'canopy' && t > LENS_BUILD[0] - 0.01) { lensU.uLM.value.set(0, LENS_BUILD[0], LENS_BUILD[1], 1); on2 = true; }
    else if (shot === 'reveal' && t < LENS_CLEAR[1] + 0.05) { lensU.uLM.value.set(1, LENS_CLEAR[0], LENS_CLEAR[1], 1); on2 = true; }
    lensBlobs.visible = lensGrains.visible = on2;
  }
  if (EVENTS.length > MAXEV) throw new Error('fx: too many events');
  function updateEvents(t, shot) {
    let any = false;
    EVENTS.forEach((e, i) => {
      const act = e.shots.includes(shot) && t >= e.t0 - 0.01 && t < e.t0 + e.life - e.pre + 0.05;
      any = any || act;
      for (const U2 of [blobU, grainU]) {
        U2.uEvA.value[i].set(e.src.x, e.src.y, e.src.z, act ? e.t0 : 1e6);
        U2.uEvB.value[i].set(e.spread, e.speed, U2 === blobU ? e.blob : e.grain, e.kind);
        U2.uEvC.value[i].set(e.dir[0], e.dir[1], e.dir[2], e.life);
        U2.uEvD.value[i].set(e.pre, e.grav, e.drag, e.I);
        U2.uEvE.value[i].set(e.nB, e.nG, e.wind, e.op);
        if (e.plane) U2.uEvF.value[i].set(e.plane.x, e.plane.y, e.plane.z, e.planar ?? 1); else U2.uEvF.value[i].set(0, 0, 0, 0);
      }
    });
    blobs.geometry.instanceCount = EVENTS.length * BLOB_PER;
    grains.geometry.instanceCount = EVENTS.length * GRAIN_PER;
    blobs.visible = grains.visible = any;
  }

  // ================================================================ petals (aerial 28-29 s)
  const petU = { uPP: { value: Array.from({ length: 8 }, () => new V4()) }, uPQ: { value: Array.from({ length: 8 }, () => new V4()) } };
  const petals = add(mkMesh(quadGeo(8), spriteMat(PETAL_VS, PETAL_FS, petU), 26));
  // choreographed in screen terms: three petals (never more than 2-3 on screen)
  // tumble up past the lens at `rate` half-frame-heights per second, 0.3-0.5 m
  // out, opaque and only moderately defocused so they read as petals
  const PET = (() => {
    const R = rng(2828);
    return [[0.62, 0.36, -1.6], [-0.58, 0.44, -1.2], [0.18, 0.5, -0.85]].map(([xN, z, dtStart]) => ({
      t0: TIMES.fadeOut + dtStart + R() * 0.08, xN, z, rate: 1.05 + R() * 0.3, xr: (R() * 2 - 1) * 0.18,
      spin: (R() * 2 - 1) * 1.2, tumble: 1.6 + R() * 1.6, len: 0.022 + R() * 0.006, ph: R() * TAU,
    }));
  })();
  function updatePetals(t) {
    let any = false;
    const f = frameAt(t);
    const th = Math.tan(f.fov * Math.PI / 360), asp = W / H;
    PET.forEach((p, i) => {
      const dt = t - p.t0;
      const yN = -1.35 + p.rate * dt + 0.06 * Math.sin(dt * 3.1 + p.ph);
      if (dt < 0 || yN > 1.4) { petU.uPQ.value[i].set(0, 0, 0, 0); return; }
      any = true;
      const xN = p.xN + p.xr * dt + 0.05 * Math.sin(dt * 2.3 + p.ph);
      const P = f.pos.clone().addScaledVector(f.right, xN * p.z * th * asp).addScaledVector(f.up, yN * p.z * th).addScaledVector(f.fwd, p.z);
      petU.uPP.value[i].set(P.x, P.y, P.z, p.len);
      // blur radius (2160p px): grows as the petal gets nearer the lens
      petU.uPQ.value[i].set(p.ph + p.spin * dt, Math.cos(p.tumble * dt + p.ph), smoothstep(0, 0.12, dt), Math.min(40, 9 / p.z));
    });
    for (let i = PET.length; i < 8; i++) petU.uPQ.value[i].set(0, 0, 0, 0);
    petals.visible = any;
  }

  // ================================================================ birds
  const birdU = {
    tDepth: FXU.tDepth, uRes: FXU.uRes, uCamP: FXU.uCamP, uPx: FXU.uPx,
    uMinSpanPx: { value: TUNE.birds.minSpanPx }, uRim: { value: TUNE.birds.rim },
    uTop: { value: new THREE.Color('#1a2140') }, uBelly: { value: new THREE.Color('#cbbfae').multiplyScalar(0.85) },
  };
  const birdMat = worldMaterial({ vertexShader: BIRD_VS, fragmentShader: BIRD_FS, uniforms: birdU, side: THREE.DoubleSide, depthTest: true, depthWrite: true }).material;
  // the near-miss swift: own smooth mesh + material (gloss, throat, feather glow,
  // per-subframe lens jitter so the near wing defocuses through the accumulation)
  const heroBirdU = {
    tDepth: FXU.tDepth, uRes: FXU.uRes, uCamP: FXU.uCamP, uPx: FXU.uPx,
    uMinSpanPx: { value: 1 }, uRim: { value: 1.0 },
    uTop: { value: new THREE.Color('#241e1a') }, uBelly: { value: new THREE.Color('#cfc5b4') },
    uLens: { value: new THREE.Vector2() }, uLensK: { value: 18 },
  };
  const heroBirdMat = worldMaterial({ vertexShader: BIRD_VS, fragmentShader: BIRD_FS, uniforms: heroBirdU, defines: { HERO: 1 }, side: THREE.DoubleSide, depthTest: true, depthWrite: true }).material;
  const mkBirds = (kind, cap, mat = birdMat, hi = false) => {
    const g = buildBird(kind, hi);
    const flap = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4); flap.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aFlap', flap);
    const m = new THREE.InstancedMesh(g, mat, cap);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false; m.renderOrder = 0; m.count = 0; m.visible = false;
    return add(m);
  };
  const swallowMesh = mkBirds('swallow', 256), swiftMesh = mkBirds('swift', 16), heroSwiftMesh = mkBirds('swift', 1, heroBirdMat, true);

  // smoothed, shot-clamped camera anchor (filters the FPV shake out of formations)
  const anchorCache = new Map();
  const tmpV = new V3();
  function anchor(t) {
    const key = Math.round(t * 1e5);
    let a = anchorCache.get(key); if (a) return a;
    const s = shotAt(t); const pos = new V3(), fwd = new V3();
    for (let k = -3; k <= 3; k++) {
      const tt = Math.min(Math.max(t + k * 0.05, s.t0), s.t1 - 1e-4);
      const c = rig.at(tt); pos.add(c.pos); fwd.add(tmpV.copy(c.target).sub(c.pos).normalize());
    }
    pos.multiplyScalar(1 / 7); fwd.y = 0; fwd.normalize();
    a = { pos, fwd, right: new V3(-fwd.z, 0, fwd.x) };
    if (anchorCache.size > 256) anchorCache.clear();
    anchorCache.set(key, a);
    return a;
  }

  // --- FPV swallow flock: bursts from the fresh grass ahead of the front (~8.2-8.9 s),
  // flies with the camera, then wheels overhead after the sun breaks.
  const R1 = rng(4242);
  const SWALLOWS = Array.from({ length: 12 }, () => ({
    tl: TIMES.cut2 + 0.63 + R1() * 0.75, A: 10 + R1() * 5, x0: (R1() * 2 - 1) * 4,
    ahead: 5.5 + R1() * 6, side: (R1() * 2 - 1) * 3.2, hgt: 0.7 + R1() * 2.0,
    w1: 0.6 + R1() * 0.7, w2: 0.5 + R1() * 0.8, w3: 0.9 + R1(), p1: R1() * TAU, p2: R1() * TAU, p3: R1() * TAU,
    ww: (R1() < 0.5 ? -1 : 1) * (0.7 + R1() * 0.6), pw: R1() * TAU, rr: R1(),
    span: 0.31 + R1() * 0.04, f: 7 + R1() * 2.5, fp: R1() * TAU, gs: R1() * 100,
  }));
  SWALLOWS.forEach(b => {
    const a = anchor(b.tl);
    b.L = a.pos.clone().addScaledVector(a.fwd, b.A).addScaledVector(a.right, b.x0);
    b.L.y = HT(b.L.x, b.L.z) + 0.15;
  });
  function swallowPos(b, t) {
    if (t < b.tl) return null;
    const a = anchor(t);
    const wb = smoothstep(TIMES.sunBreak - 0.1, TIMES.sunBreak + 1.5, t);
    const th = t * b.ww + b.pw;
    const ahead = lerp(b.ahead + 2.2 * Math.sin(t * b.w1 + b.p1), 13 + 7 * Math.cos(th), wb);
    const side = lerp(b.side + 2.6 * Math.sin(t * b.w2 + b.p2), 8 * Math.sin(th) + b.side * 0.5, wb);
    const P = a.pos.clone().addScaledVector(a.fwd, ahead).addScaledVector(a.right, side);
    const yLow = HT(P.x, P.z) + b.hgt + 0.8 * Math.sin(t * b.w3 + b.p3);
    const yHigh = a.pos.y + 5.5 + 5 * b.rr + 1.5 * Math.sin(t * 1.3 + b.p3);
    P.y = lerp(yLow, yHigh, wb);
    const w = easeInOut(clamp01((t - b.tl) / 0.75));
    const hop = Math.sin(Math.PI * w) * 1.2;
    return b.L.clone().lerp(P, w).add(new V3(0, hop, 0));
  }
  const noise1 = (t, s) => 0.5 + 0.5 * Math.sin(t * 1.3 + s) * Math.sin(t * 0.77 + s * 1.7);
  const flapOf = (b, t, burst) => {
    const g = smoothstep(0.55, 0.8, noise1(t, b.gs)) * (1 - burst);
    return [TAU * b.f * t + b.fp, lerp(0.85, 0.05, g) * (1 + 0.15 * burst), lerp(0.08, 0.22, g), lerp(0.15, 0.55, g)];
  };

  // --- the swift near-miss on the TIMES.swift beat. Staged in the frame of the
  // live camera rig (so FPV shake never jitters it): it enters upper right at
  // ~-0.1 s, ~1 m out and small, dives in to ~0.42 m from the lens where it
  // almost hangs, wings spread across ~47% of the frame width, exactly on the
  // beat, then whips out past the lower-left corner by ~+0.1 s.
  // s = (t - T0) / 0.1; screen position in ndc, depth in metres.
  const SWIFT = (() => {
    const T0 = TIMES.swift, D = 0.1;
    const k3 = s => (s < 0 ? 1.15 : 1.8), k3y = s => (s < 0 ? 0.62 : 1.1);
    const rel = s => [0.03 - 0.05 * s - k3(s) * s * s * s, 0.22 - 0.42 * s - k3y(s) * s * s * s, 0.44 + 0.5 * Math.max(-s, 0) ** 2 - 0.1 * Math.max(s, 0)];
    const toW = (f, [xn, yn, z], o) => {
      const th = Math.tan(f.fov * Math.PI / 360);
      return o.addScaledVector(f.right, xn * z * th * (W / H)).addScaledVector(f.up, yn * z * th).addScaledVector(f.fwd, z);
    };
    const pos = t => { const s = (t - T0) / D; if (Math.abs(s) > 1.15) return null; const f = frameAt(t); return toW(f, rel(s), f.pos.clone()); };
    // nose along its motion across the frame, belly (dark scythe planform, pale
    // throat) toward the lens, rolling through the pass so the wings sweep
    // diagonally; the sun behind it rims every edge
    const orient = t => {
      const f = frameAt(t), s = (t - T0) / D, e = 0.02;
      const a = toW(f, rel(s - e), new V3()), b = toW(f, rel(s + e), new V3());
      // full planform toward the lens: back faces straight away from the camera,
      // nose along the screen motion; only a gentle roll through the pass
      const up = a.clone().add(b).multiplyScalar(0.5).normalize();     // camera -> bird
      const fw = b.sub(a); fw.addScaledVector(up, -fw.dot(up)).normalize();
      up.applyAxisAngle(fw, 0.12 + 0.35 * s);
      return { f: fw, u: up };
    };
    // ~2.5 keyed wingbeats: flapping in, a held glide (wings fully spread) through
    // the beat, flapping out; phase integrated from a smooth frequency profile
    const NT = 241, S0 = -1.2, S1 = 1.2, ph = new Float32Array(NT);
    const w = s => smoothstep(0.2, 0.42, Math.abs(s));
    for (let i = 1; i < NT; i++) { const s = S0 + (i - 0.5) * (S1 - S0) / (NT - 1); ph[i] = ph[i - 1] + TAU * 10 * w(s) * D * (S1 - S0) / (NT - 1); }
    const flap = t => {
      const s = Math.min(S1, Math.max(S0, (t - T0) / D)), u = (s - S0) / (S1 - S0) * (NT - 1), i = Math.min(NT - 2, Math.floor(u));
      const g = 1 - w(s);
      return [lerp(ph[i], ph[i + 1], u - i) + 1.2, lerp(0.6, 0.04, g), lerp(0.08, 0.12, g), lerp(0.25, 0.22, g)];
    };
    return { T0, span: 0.42, pos, orient, flap };
  })();
  const swiftPos = t => SWIFT.pos(t);

  // --- reveal flocks lifting off the basin floor as the wave passes them
  const R2 = rng(777);
  const FLOCKS = [];
  // ground point under screen position (sx, sy in NDC) for camera frame f
  const groundHit = (f, sx, sy) => {
    const th = Math.tan(f.fov * Math.PI / 360);
    const d = f.fwd.clone().addScaledVector(f.right, sx * th * W / H).addScaledVector(f.up, sy * th).normalize();
    let s = 5, prev = 0;
    for (let i = 0; i < 400 && s < 6000; i++) {
      const p = f.pos.clone().addScaledVector(d, s);
      if (p.y < HT(p.x, p.z)) {
        let a = prev, b = s;
        for (let k = 0; k < 20; k++) { const m = (a + b) / 2, q2 = f.pos.clone().addScaledVector(d, m); if (q2.y < HT(q2.x, q2.z)) b = m; else a = m; }
        return f.pos.clone().addScaledVector(d, b);
      }
      prev = s; s = s * 1.03 + 2;
    }
    return null;
  };
  {
    // each flock lifts at its own beat, from the ground point (in frame) where the
    // wavefront is passing at that moment: the bloom flushes them up
    const PLAN = [[0.25, -0.45, 34], [0.75, 0.42, 40], [1.3, -0.15, 36], [1.9, 0.62, 44], [2.5, -0.6, 40], [3.0, 0.2, 46]];
    const span = TIMES.cut5 - TIMES.cut4;
    PLAN.forEach(([dt, sx, n]) => {
      const tl = TIMES.cut4 + dt * span / 4.0;
      const f = frameAt(Math.min(tl + 0.8, TIMES.cut5 - 0.05));
      const Dl = bloomD(tl);
      let best = null, bestErr = 1e9;
      for (let sy = -0.92; sy <= 0.1; sy += 0.03) {
        const g = groundHit(f, sx, sy); if (!g) continue;
        const err = Math.abs(data.arrivalAt(g.x, g.z) - Dl);
        if (err < bestErr) { bestErr = err; best = g; }
      }
      if (!best) best = groundHit(f, sx, -0.35) || f.pos.clone().addScaledVector(f.fwd, 300);
      const dist = best.distanceTo(f.pos);
      const fw = new V3(f.fwd.x, 0, f.fwd.z).normalize();
      const ang = Math.atan2(fw.z, fw.x) + (R2() * 2 - 1) * 0.8;
      const fl = {
        site: new V3(best.x, HT(best.x, best.z), best.z), tl, n, alt: 25 + R2() * 40 + dist * 0.03, speed: 9 + R2() * 6,
        dir: new V3(Math.cos(ang), 0, Math.sin(ang)), spin: (R2() < 0.5 ? -1 : 1) * (0.25 + R2() * 0.3),
        spread: 12 + R2() * 10 + dist * 0.035, birds: [],
      };
      for (let i = 0; i < n; i++) {
        const a = R2() * TAU, rr = Math.sqrt(R2()) * fl.spread;
        fl.birds.push({ o: new V3(Math.cos(a) * rr, (R2() * 2 - 1) * fl.spread * 0.35, Math.sin(a) * rr), delay: R2() * 0.9, f: 9 + R2() * 3, fp: R2() * TAU, gs: R2() * 100, span: 0.3 + R2() * 0.05, ph: R2() * TAU });
      }
      FLOCKS.push(fl);
    });
  }
  if (q.get('fxdbg')) console.log('fx flocks', JSON.stringify(FLOCKS.map(f => ({ tl: +f.tl.toFixed(2), site: f.site.toArray().map(v => Math.round(v)), n: f.n }))));
  function flockPos(fl, b, t) {
    const age = t - fl.tl - b.delay;
    if (age < 0) return null;
    const A = t - fl.tl;
    const C = fl.site.clone().addScaledVector(Y, 2 + fl.alt * (1 - Math.exp(-A / 1.8)))
      .addScaledVector(fl.dir, fl.speed * (A - 1.4 * (1 - Math.exp(-A / 1.4))));
    const yaw = fl.spin * A + 0.3 * Math.sin(A * 0.6 + b.ph);
    const breathe = 1 + 0.18 * Math.sin(A * 0.9 + b.ph * 0.3);
    const ox = b.o.x * Math.cos(yaw) - b.o.z * Math.sin(yaw), oz = b.o.x * Math.sin(yaw) + b.o.z * Math.cos(yaw);
    const slot = C.add(new V3(ox * breathe, b.o.y + 3 * Math.sin(A * 1.1 + b.o.x * 0.1), oz * breathe));
    const g = fl.site.clone().add(new V3(b.o.x * 0.6, 0, b.o.z * 0.6)); g.y = HT(g.x, g.z) + 0.3;
    const w = easeOut(clamp01(age / 1.6));
    return g.lerp(slot, w);
  }

  // --- falls: swifts cutting across the spray plume (telephoto, ~70-160 m from the lens)
  const FALLS = (() => {
    const f = frameAt((TIMES.cut5 + TIMES.cut6) / 2);
    const tanH = Math.tan(f.fov * Math.PI / 360);
    const R3 = rng(31337);
    const a = TIMES.cut5, b = TIMES.cut6;
    return [[a + 0.63, 60, 17, -0.25], [a + 0.88, 85, 15, -0.08], [b - 1.0, 48, -16, -0.35], [b - 0.75, 75, -15, 0.05], [b - 0.55, 58, 19, -0.18], [b - 0.25, 95, -16, -0.3]]
      .map(([tc, d, vx, yN]) => ({ f, tanH, tc, d, vx, yN, ay: 0.06 + R3() * 0.08, dz: (R3() * 2 - 1) * 12, cv: (R3() * 2 - 1) * 3, ph: R3() * TAU, f0: 8 + R3() * 3, fp: R3() * TAU, gs: R3() * 100 }));
  })();
  function fallsPos(b, t) {
    const dt = t - b.tc;
    const halfW = b.d * b.tanH * W / H;
    if (Math.abs(b.vx * dt) > halfW * 1.35) return null;
    // weaving, hard-banked arcs (the depth weave gives ~3 g of lateral pull, so the
    // coordinated bank turns the scythe planform toward the lens instead of a side-on dash)
    return b.f.pos.clone().addScaledVector(b.f.fwd, b.d + b.dz * dt + 6 * Math.sin(2.2 * dt + b.ph)).addScaledVector(b.f.right, b.vx * dt)
      .addScaledVector(b.f.up, b.d * b.tanH * (b.yN + b.ay * Math.sin(1.7 * dt + b.ph * 1.3)));
  }

  // kinematics -> instance matrix (heading = velocity, banked by lateral accel)
  const m4 = new THREE.Matrix4(), xa = new V3(), ya = new V3(), za = new V3(), sv = new V3();
  const H_FD = 1 / 120;
  function putBird(mesh, i, fn, t, span, flap, orient) {
    const a = fn(t - H_FD), b = fn(t), c = fn(t + H_FD);
    if (!a || !b || !c) return false;
    if (orient) {
      // explicit heading/up (the near-miss swift is staged relative to the lens)
      const o = orient(t);
      za.copy(o.f).normalize();
      ya.copy(o.u).addScaledVector(za, -o.u.dot(za)).normalize();
    } else {
      za.copy(c).sub(a).multiplyScalar(1 / (2 * H_FD));
      const acc = c.clone().add(a).addScaledVector(b, -2).multiplyScalar(1 / (H_FD * H_FD));
      const sp = za.length(); if (sp < 1e-3) za.set(0, 0, 1); else za.multiplyScalar(1 / sp);
      ya.copy(acc).addScaledVector(za, -acc.dot(za));
      const lm = ya.length(); if (lm > 25) ya.multiplyScalar(25 / lm);
      ya.y += 9.8;
      ya.addScaledVector(za, -ya.dot(za)).normalize();
    }
    xa.crossVectors(ya, za);
    m4.makeBasis(xa, ya, za).scale(sv.set(span, span, span)).setPosition(b);
    mesh.setMatrixAt(i, m4);
    mesh.geometry.attributes.aFlap.setXYZW(i, flap[0], flap[1], flap[2], flap[3]);
    return true;
  }
  function updateBirds(t, shot, sub) {
    let ns = 0, nw = 0, nh = 0;
    birdU.uMinSpanPx.value = TUNE.birds.minSpanPx * (shot === 'reveal' ? 1.7 : shot === 'falls' ? 2.0 : 1) * +(q.get('fxbirdk') || 1);
    if ((shot === 'fpv' || shot === 'canopy') && on('birds')) {
      for (const b of SWALLOWS) {
        if (t < b.tl) continue;
        const burst = 1 - smoothstep(0.6, 1.4, t - b.tl);
        const grow = smoothstep(b.tl, b.tl + 0.1, t);
        if (putBird(swallowMesh, ns, tt => swallowPos(b, tt), t, b.span * grow + 1e-4, flapOf(b, t, burst))) ns++;
      }
      if (shot === 'fpv' && putBird(heroSwiftMesh, 0, swiftPos, t, SWIFT.span, SWIFT.flap(t), SWIFT.orient)) {
        nh = 1;
        // lens sample for this subframe (decorrelated from the shutter order)
        const spp = sub?.spp || 1, si = spp > 1 ? ((sub.sub * 7 + 3) % spp) : 0;
        const r = spp > 1 ? Math.sqrt((si + 0.5) / spp) : 0, a = si * 2.39996 + 0.7;
        heroBirdU.uLens.value.set(r * Math.cos(a), r * Math.sin(a));
      }
    }
    if (shot === 'reveal' && on('birds')) {
      for (const fl of FLOCKS) for (const b of fl.birds) {
        if (ns >= swallowMesh.instanceMatrix.count) break;
        const age = t - fl.tl - b.delay;
        if (age < 0) continue;
        const burst = 1 - smoothstep(1.0, 2.5, age);
        const flap = flapOf(b, t, burst); flap[1] = Math.max(flap[1], 0.25);
        if (putBird(swallowMesh, ns, tt => flockPos(fl, b, tt), t, b.span * smoothstep(0, 0.12, age) + 1e-4, flap)) ns++;
      }
    }
    if (shot === 'falls' && on('birds')) {
      for (const b of FALLS) {
        const g = smoothstep(0.5, 0.8, noise1(t, b.gs));
        // crossing side-on they would collapse to a dash: bank the back toward the lens
        const orient = tt => {
          // sample inside the window putBird already null-checked (t +- H_FD)
          const p0 = fallsPos(b, tt - H_FD * 0.99) || fallsPos(b, tt), p1 = fallsPos(b, tt + H_FD * 0.99) || fallsPos(b, tt);
          const f = p1.clone().sub(p0); if (f.lengthSq() < 1e-12) f.copy(b.f.right); f.normalize();
          const toCam = b.f.pos.clone().sub(p1).normalize();
          const u = Y.clone().multiplyScalar(0.55).addScaledVector(toCam, 0.85).normalize().applyAxisAngle(f, 0.3 * Math.sin(tt * 2.1 + b.ph));
          return { f, u };
        };
        if (putBird(swiftMesh, nw, tt => fallsPos(b, tt), t, 0.42, [TAU * b.f0 * t + b.fp, lerp(0.6, 0.12, g), lerp(0.05, 0.12, g), lerp(0.3, 0.6, g)], orient)) nw++;
      }
    }
    if (q.get('fxdbg') && shot === 'falls') console.log('fx falls', t.toFixed(2), nw, FALLS.map(b => { const p = fallsPos(b, t); if (!p) return '-'; const d = p.distanceTo(camera.position); const s = p.clone().project(camera); return `${d.toFixed(0)}m@(${s.x.toFixed(2)},${s.y.toFixed(2)})`; }).join(' '));
    if (q.get('fxdbg') && shot === 'reveal') { const e = new THREE.Matrix4(); swallowMesh.getMatrixAt(0, e); console.log('fx reveal birds', t.toFixed(2), ns, JSON.stringify(new V3().setFromMatrixPosition(e)), JSON.stringify(camera.position)); }
    if (q.get('fxdbg') && Math.abs(t - TIMES.swift) < 0.05) { const e = new THREE.Matrix4(); swiftMesh.getMatrixAt(0, e); console.log('fx swift@', t.toFixed(3), shot, nw, JSON.stringify(new V3().setFromMatrixPosition(e)), 'world', JSON.stringify(camera.position), 'mine', JSON.stringify(rig.at(t).pos), 'ctxrig', JSON.stringify(ctx.rig.at(t).pos)); }
    for (const [m, n] of [[swallowMesh, ns], [swiftMesh, nw], [heroSwiftMesh, nh]]) {
      m.count = n; m.visible = n > 0;
      if (n > 0) { m.instanceMatrix.needsUpdate = true; m.geometry.attributes.aFlap.needsUpdate = true; }
    }
  }

  // ================================================================ per-subframe update
  const fwdV = new V3(), cpos = new V3();
  function update(t, c) {
    const shot = c.shot.id, cam = c.cam;
    FXU.uCamP.value.set(camera.near, camera.far, cam.focus, cam.cocK * H / 2160);
    FXU.uMaxCoc.value = (shot === 'macro' ? 70 : 30) * H / 2160;
    FXU.uTau.value = tau(t);
    FXU.uTauRate.value = (tau(t + 0.005) - tau(t - 0.005)) / 0.01;
    // sub-frame streak matrices: the camera over this subframe's shutter slice
    const sd = subDt(t, c.sub);
    FXU.uSubDt.value = sd;
    if (sd > 0) { vpAt(t - sd * 0.5, c.shot, FXU.uVP0.value); vpAt(t + sd * 0.5, c.shot, FXU.uVP1.value); }
    camera.getWorldDirection(fwdV); cpos.copy(camera.position);
    const ahead = d => cpos.clone().addScaledVector(fwdV, d);
    const S = TUNE.snowMacro, F = TUNE.snowFpv;
    // the macro pull-back (6.7-7.5) whips the near-lens particles across the
    // frame: clear them before the camera starts moving
    const pullCut = 1 - smoothstep(TIMES.pullStart - 0.1, TIMES.pullStart + 0.25, t);

    // ---- snow
    if (shot === 'macro' && on('snow')) {
      const bs = blastAt(t);
      setBox(snowNear, { n: S.nearN, B: 0.9, c: ahead(0.43), fall: S.fall, r: 0.0011, wind: 0.025, sway: 0.012, minPx: 1.5, amt: pullCut, minBlur: S.minBlur, gamma: S.bokehGamma, rim: S.rim, kind: 2, blast: bs > 0 ? new V4(rig.budHead.x, rig.budHead.y, rig.budHead.z, bs) : null });
      setBox(snowFar, { n: S.farN, B: 9, c: ahead(4.3), fall: S.farFall, r: 0.0016, wind: 0.12, sway: 0.05, minPx: 1.5, amt: lerp(0.3, 1, pullCut), minBlur: S.minBlur * 0.5, gamma: S.bokehGamma, rim: S.rim * 0.6, kind: 2 });
    } else if (shot === 'fpv' && on('snow')) {
      const fade = 1 - smoothstep(TIMES.sunBreak - 0.4, TIMES.sunBreak + 0.4, t);
      setBox(snowNear, { n: F.nearN, B: 10, c: ahead(4.4), fall: F.fall, r: 0.0045, wind: 1.0, sway: 0.15, minPx: 2.2, gate: 1, amt: fade, gamma: 0.45, I: 1.5, cocCap: 14 });
      setBox(snowFar, { n: F.farN, B: 60, c: ahead(27), fall: F.farFall, r: 0.014, wind: 1.2, sway: 0.4, minPx: 1.8, gate: 1, amt: fade, gamma: 0.5, I: 1.4, cocCap: 14 });
    } else { snowNear.visible = snowFar.visible = false; }

    // ---- hero crystals
    if (shot === 'macro' && on('hero') && t < TIMES.pullStart + 0.6) { updateHero(t); hero.visible = true; } else hero.visible = false;

    // ---- pollen motes
    if (on('motes') && ((shot === 'fpv' && t > TIMES.sunBreak - 0.1) || shot === 'canopy')) {
      const amt = smoothstep(TIMES.sunBreak, TIMES.sunBreak + 0.8, t) * (1 - smoothstep(TIMES.whiteout - 0.25, TIMES.whiteout + 0.05, t));
      setBox(motes, { n: TUNE.motes.n, B: 13, c: ahead(5.3), fall: -0.12, r: 0.0009, wind: 0.9, sway: 0.2, minPx: 1.3, amt, kind: 1, gamma: 0.6, I: TUNE.motes.intensity, cocCap: 10 });
    } else if (on('motes') && shot === 'aerial') {
      const amt = 0.6 * smoothstep(TIMES.resolve - 0.2, TIMES.resolve + 0.8, t) * (1 - smoothstep(TIMES.fadeOut, TIMES.fadeOut + 0.6, t));
      setBox(motes, { n: 700, B: 7, c: ahead(3.2), fall: -0.35, r: 0.0012, wind: 0.4, sway: 0.15, minPx: 1.5, amt, kind: 1, gamma: 0.6, minBlur: 16, I: TUNE.motes.intensity, nearOK: true });
    } else motes.visible = false;

    // ---- wavefront sparkles
    const [micro, near, mid, far] = LAYERS;
    for (const l of LAYERS) l.mesh.visible = false;
    if (on('sparkle')) {
      const cx = cpos.x, cz = cpos.z;
      if (shot === 'macro' && t > TIMES.hit - 0.05) {
        setLayer(micro, { rMin: 0, rMax: 2.6, fade: 0.6, S: 0.15, mist: 0.05, active: 0.3, amt: lerp(0.2, 1, pullCut) }, cx, cz);
        setLayer(near, { rMin: 1.8, rMax: 19, fade: 2.0, S: 0.8, mist: 0.06, active: 0.6 }, cx, cz);
        if (t > TIMES.pullStart) setLayer(mid, { rMin: 15, rMax: 120, fade: 10, S: 3.0, mist: 0.08, active: 0.6 }, cx, cz);
      } else if (shot === 'fpv' || shot === 'canopy') {
        setLayer(near, { rMin: 0, rMax: 19, fade: 3, S: 1.0, mist: 0.05, active: 0.85 }, cx, cz);
        setLayer(mid, { rMin: 15, rMax: 130, fade: 10, S: 3.2, mist: 0.08, active: 0.85 }, cx, cz);
        if (shot === 'canopy') setLayer(far, { rMin: 110, rMax: 700, fade: 60, S: 12, mist: 0.1, active: 0.8 }, cx, cz);
      } else if (shot === 'reveal') {
        setLayer(mid, { rMin: 0, rMax: 130, fade: 10, S: 3.2, mist: 0.08, active: 0.7 }, cx, cz);
        setLayer(far, { rMin: 110, rMax: 1450, fade: 80, S: 16, mist: 0.1, active: 0.85 }, cx, cz);
      }
    }

    // ---- flower pollen puffs
    if (on('fpuff') && (shot === 'fpv' || (shot === 'macro' && t > TIMES.pullStart))) {
      fpU.uPB.value.set(cpos.x, cpos.z, 0.4, shot === 'macro' ? 0.2 : 1);
      fpuff.visible = true;
    } else fpuff.visible = false;

    // ---- bursts
    if (on('bursts')) { updateEvents(t, shot); updateLens(t, shot); } else blobs.visible = grains.visible = lensBlobs.visible = lensGrains.visible = false;

    // ---- petals
    if (on('petals') && shot === 'aerial' && t > TIMES.fadeOut - 1.7) updatePetals(t); else petals.visible = false;

    // ---- birds
    updateBirds(t, shot, c.sub);
  }

  return { objects: [], overlay: overlayObjs, update };
}
