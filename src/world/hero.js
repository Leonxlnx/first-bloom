// FIRST BLOOM — the hero pasque flower (macro shot 0-7.6 s).
//
// A single Pulsatilla bud at the knoll (rig.budBase): six furled violet tepals
// whose shape is solved on the CPU every subframe (closed egg -> snap-open cup,
// written into a tiny float texture), sheathed in instanced silky hairs, furred
// with instanced rime needles that melt into dew drops where the blade of first
// light passes, a hairy stem with a feathery involucre, a crown of gold stamens,
// frosted grass blades for the rack-focus foreground, a macro snow crust disc,
// and self-blurred overlay particles (rime glints, dew spray, pollen pulse,
// snow-glitter bokeh, the pull-back spark).
//
// Everything is a pure function of t. Tuning knobs live in HERO below.
import * as THREE from 'three';
import { worldMaterial, castShadow, rng } from './common.js';
import { PALETTE_GLSL } from './terrain.js';
import { TIMES, sunAt } from './timeline.js';
import { smoothstep, clamp01, lerp } from './keys.js';

const DEG = Math.PI / 180;
const NU = 64;                 // tepal frame samples written to the texture
const NS = 4 * (NU - 1) + 1;   // integration steps along a tepal
const CW = 6;                  // texels per curve in tCurves
const MAXC = 128;

// ---------------------------------------------------------------- tuning knobs
export const HERO = {
  // bud geometry (metres)
  budH: 0.0365, budR: 0.0104, rec: 0.0024, whorlOff: 0.00045, wrap: 0.70,
  recH: 0.0855,          // receptacle height above ground while closed
  recLift: 0.0045,       // stem springs up by this much at the hit
  tiltClosed: 2.5, tiltOpen: 32,   // degrees, flower axis toward the camera
  openAlpha: 40, openCurl: 18,     // open tepal angle from the axis + tip recurve (deg)
  strain: 0.055,                   // held-breath tepal strain (fraction of opening)
  // opening after the hit: ease-out rise to an overshoot peak at `rise` s (~10 frames),
  // cosine settle to fully open by `settle` s; the dew spray leaves at the peak
  open: { rise: 0.33, over: 0.08, settle: 0.60, pow: 2.2 },
  openShrink: 0.08,                // open tepals are this much shorter (framing headroom)
  openShift: 0.0032,               // the open flower slides this far left (m, camera frame) to centre it
  // fur and frost
  hairLen: 0.0027, hairW: 0.000046, rimeLen: 0.0020, dewR: 0.00062,
  nHairTepal: 2200, nRimeTepal: 3400, nDewClusters: 3,   // dew: clusters of 1-4 drops per tepal
  turfN: 3200, turfR: 1.55,        // spring short-turf blades round the bud (covers the meadow's hero clearing)
  // first light: the blade reaches dot(wp - budBase, lightDir) = 0 at t0 and moves at speed (m/s)
  light: { t0: 0.0, speed: 0.08, melt: 0.85, flare: 2.4 },   // t0 is relative to TIMES.firstLight
  // overlay
  glitterN: 230, pollenN: 420, sprayN: 150, glintN: 380,
  lateGlint: true,       // the 27.5 s "first bloom" wink at the heart (disable if fx owns it)
};

// ---------------------------------------------------------------- GLSL shared by all hero shaders
const HERO_GLSL = /* glsl */`
${PALETTE_GLSL}
uniform sampler2D tTepal; uniform sampler2D tCurves;
uniform vec3 uBudBase; uniform vec3 uFC; uniform vec3 uFA; uniform vec3 uFX; uniform vec3 uFZ;
uniform vec4 uLight;   // xyz: sweep direction of the light blade, w: speed (m/s)
uniform vec4 uLightK;  // x: t0, y: melt duration, z: hit time, w: flare decay
uniform float uOpen; uniform float uGlow; uniform float uDewGone; uniform float uSince; uniform float uPx;
uniform vec4 uHeroMisc; // x: wetness, y: pulse radius (m), z: pulse strength, w: frost boost
uniform float uFScale;  // pull-back cheat: flower parts grow about the stem base while the camera races away
vec3 heroScaleP(vec3 p) { return uBudBase + (p - uBudBase) * uFScale; }

#define C_HAIR s2l(vec3(0.902, 0.914, 0.961))
#define C_RIME s2l(vec3(0.910, 0.945, 1.0))
#define C_VGLOW s2l(vec3(0.60, 0.43, 1.0))
#define C_HVIOLET s2l(vec3(0.52, 0.30, 0.84))
#define C_DEEPV s2l(vec3(0.294, 0.165, 0.620))
#define C_STAMEN s2l(vec3(1.0, 0.769, 0.180))
#define C_DAWN s2l(vec3(1.0, 0.784, 0.451))
#define C_TEP_BASE s2l(vec3(0.294, 0.137, 0.565))
#define C_TEP_TIP s2l(vec3(0.612, 0.486, 0.941))
#define C_TEP_EDGE s2l(vec3(0.788, 0.659, 1.0))
#define C_TEP_TRANS s2l(vec3(0.50, 0.30, 1.0))

float heroLitTime(vec3 wp) {
  float d = dot(wp - uBudBase, uLight.xyz);
  float n = vnoise(wp.xz * 90.0 + wp.y * 61.0) + 0.5 * vnoise(vec2(wp.x + wp.z, wp.y) * 230.0);
  return uLightK.x + d / uLight.w + (n - 0.75) * 0.10;
}
float heroLit(vec3 wp) { float tl = heroLitTime(wp); return smoothstep(tl - 0.05, tl + 0.08, uTime); }
float heroMelt(vec3 wp) { float tl = heroLitTime(wp); return max(smoothstep(tl + 0.15, tl + 0.15 + uLightK.y, uTime), step(uLightK.z, uTime)); }
float heroFlare(vec3 wp) { float dt = uTime - heroLitTime(wp); return dt > 0.0 ? smoothstep(0.0, 0.05, dt) * exp(-dt * uLightK.w) : 0.0; }
// same three from one arrival time: x lit, y melt, z flare
vec3 heroLMF(vec3 wp) {
  float tl = heroLitTime(wp); float dt = uTime - tl;
  return vec3(smoothstep(-0.05, 0.08, dt), max(smoothstep(0.15, 0.15 + uLightK.y, dt), step(uLightK.z, uTime)), dt > 0.0 ? smoothstep(0.0, 0.05, dt) * exp(-dt * uLightK.w) : 0.0);
}
#ifndef IS_VERTEX
// cheap 2-tap rotated lookup in the macro cascade for the many tiny hair / rime / dew fragments
float heroShadow(vec3 wp, float bias) {
  if (uShadowOn < 0.5) return 1.0;
  vec4 c0 = uShadowMat0 * vec4(wp, 1.0); vec3 s0 = c0.xyz * 0.5 + 0.5;
  if (all(greaterThan(s0.xy, vec2(0.02))) && all(lessThan(s0.xy, vec2(0.98))) && s0.z < 1.0) {
    s0.z -= bias * uShadowTexel.x * 2.0;
    float ang = hash12(gl_FragCoord.xy + uFrame * 17.0) * 6.2831;
    vec2 o = vec2(cos(ang), sin(ang)) * uShadowTexel.x * uShadowTexel.z * 0.75;
    return 0.5 * (step(s0.z, texture2D(tShadow0, s0.xy + o).r) + step(s0.z, texture2D(tShadow0, s0.xy - o).r));
  }
  return sunShadow(wp, bias);
}
#endif
float heroGreen(vec3 wp) {
  float r = length(wp.xz - uBudBase.xz);
  float local = smoothstep(0.0, 0.3, uSince - 0.05 - r * 1.1);
  return max(local, bloomAmt(wp.xz));
}

// ---- tepal frames (CPU-solved): rows k*4+{0:P,w 1:T,rc 2:N,- 3:B,-}
vec4 tepTex(float k, int row, float u) {
  float x = clamp(u, 0.0, 1.0) * ${(NU - 1).toFixed(1)};
  float x0 = floor(x); float f = x - x0;
  int iy = int(k + 0.5) * 4 + row;
  vec4 a = texelFetch(tTepal, ivec2(int(x0), iy), 0);
  vec4 b = texelFetch(tTepal, ivec2(min(int(x0) + 1, ${NU - 1}), iy), 0);
  return mix(a, b, f);
}
void tepalSurf(float k, float u, float v, out vec3 S, out vec3 n, out vec3 T, out vec3 B) {
  vec4 r0 = tepTex(k, 0, u), r1 = tepTex(k, 1, u), r2 = tepTex(k, 2, u), r3 = tepTex(k, 3, u);
  vec3 P = r0.xyz; float w = r0.w; T = normalize(r1.xyz); float rc = max(r1.w, 1e-5);
  vec3 N = normalize(r2.xyz); B = normalize(r3.xyz);
  // a little margin ruffle so edges are not ruler-straight
  float th = v * w / rc;
  S = P + B * sin(th) * rc - N * (1.0 - cos(th)) * rc;
  n = normalize(N * cos(th) + B * sin(th));
  S += n * (sin(u * 23.0 + k * 1.7) * 0.00012 * smoothstep(0.6, 1.0, abs(v)));
}

// ---- curves (stem / bract lobes / basal leaves / grass blades): cubic Bezier rows
void curveEval(float id, float s, out vec3 P, out vec3 T, out vec3 N, out vec3 B, out float r, out float kind, out vec4 prm) {
  int iy = int(id + 0.5);
  vec4 a = texelFetch(tCurves, ivec2(0, iy), 0), b = texelFetch(tCurves, ivec2(1, iy), 0);
  vec4 c = texelFetch(tCurves, ivec2(2, iy), 0), d = texelFetch(tCurves, ivec2(3, iy), 0);
  vec4 e = texelFetch(tCurves, ivec2(4, iy), 0); prm = texelFetch(tCurves, ivec2(5, iy), 0);
  float u = 1.0 - s;
  P = u * u * u * a.xyz + 3.0 * u * u * s * b.xyz + 3.0 * u * s * s * c.xyz + s * s * s * d.xyz;
  vec3 dP = 3.0 * u * u * (b.xyz - a.xyz) + 6.0 * u * s * (c.xyz - b.xyz) + 3.0 * s * s * (d.xyz - c.xyz);
  T = normalize(dP);
  N = normalize(e.xyz - T * dot(e.xyz, T));
  float tw = d.w * s;
  vec3 Bt = cross(T, N);
  N = N * cos(tw) + Bt * sin(tw);
  B = cross(T, N);
  r = mix(a.w, b.w, pow(s, e.w));
  kind = c.w;
  if (kind > 0.5) { // grass: shock-wave push from the hit, then spring back
    vec2 rd = P.xz - uBudBase.xz; float rr = length(rd);
    float ph = rr - uHeroMisc.y;
    float push = uHeroMisc.z * exp(-ph * ph / 0.006) * s * s;
    P.xz += rd / max(rr, 1e-3) * push * 0.010;
    P.y -= push * 0.002;
  }
}

// material ids: 0 tepal, 1 stem, 2 bract, 3 basal leaf, 4 grass blade
void rootFrame(vec4 rt, out vec3 P, out vec3 n, out vec3 T, out vec3 B, out float mat) {
  if (rt.x < 8.0) {
    tepalSurf(rt.x, rt.y, rt.z, P, n, T, B); mat = 0.0;
  } else {
    vec3 C, Tc, Nc, Bc; float r, kind; vec4 prm;
    curveEval(rt.x - 10.0, rt.y, C, Tc, Nc, Bc, r, kind, prm);
    T = Tc; mat = prm.x;
    if (kind < 0.5) {
      float a = rt.z * 6.2831853;
      n = Nc * cos(a) + Bc * sin(a); P = C + n * r; B = cross(n, T);
    } else {
      float v = clamp(rt.z, -1.0, 1.0); float fold = prm.y;
      P = C + Bc * v * r + Nc * abs(v) * r * fold;
      n = normalize(Nc - sign(v) * fold * Bc) * (rt.w < 0.0 ? -1.0 : 1.0);
      P += n * 0.00005;
      B = Bc;
    }
  }
}

float tepalCov(float k, float u, float v) {   // frost / fur coverage (seams stay violet)
  float av = abs(v);
  float outer = step(mod(k + 0.5, 2.0), 1.0);
  float cOuter = 1.0 - smoothstep(0.70, 0.92, av);
  float cInner = 1.0 - 0.95 * smoothstep(0.34, 0.48, av);
  return mix(cInner, cOuter, outer) * smoothstep(0.03, 0.14, u);
}

// irradiance from the sky dome + the snowfield (which bounces the bright horizon back up)
vec3 heroAmbient(vec3 n) {
  vec3 skyUp = mix(uSkyHorizon, uSkyZenith, 0.45);
  vec3 skyH = uSkyHorizon * 0.92;
  vec3 snow = mix(uSkyHorizon, uSkyZenith, 0.25) * s2l(vec3(0.84, 0.87, 1.0)) * 0.9 + uSunColor * max(uSunDir.y, 0.02) * 0.6;
  float y = clamp(n.y, -1.0, 1.0);
  vec3 c = y > 0.0 ? mix(skyH, skyUp, y) : mix(skyH, snow, -y);
  return c * 0.8;
}
vec3 heroSkyBehind(vec3 V) { return skyGradient(normalize(-V + vec3(0.0, 0.035, 0.0))); }
// violet tissue filters the warm sun: keep its glow violet (never pink)
vec3 heroSunNeutral(vec3 sunC) { float l = dot(sunC, vec3(0.2126, 0.7152, 0.0722)); return mix(vec3(l), sunC, 0.25); }
`;

// ---------------------------------------------------------------- tepals
const TEPAL_VS = /* glsl */`
attribute vec3 aT;  // k, u, v
varying vec3 vWorld; varying vec3 vN; varying vec3 vT; varying vec3 vK;
void main() {
  vec3 S, n, T, B; tepalSurf(aT.x, aT.y, aT.z, S, n, T, B);
  float du = aT.y < 0.99 ? 0.004 : -0.004, dv = aT.z < 0.98 ? 0.02 : -0.02;
  vec3 S1, n1, T1, B1, S2, n2, T2, B2;
  tepalSurf(aT.x, aT.y + du, aT.z, S1, n1, T1, B1);
  tepalSurf(aT.x, aT.y, aT.z + dv, S2, n2, T2, B2);
  vec3 g = cross((S2 - S) * sign(dv), (S1 - S) * sign(du));
  vec3 nn = length(g) > 1e-14 ? normalize(g) : n;
  if (dot(nn, n) < 0.0) nn = -nn;
  S = heroScaleP(S);
  vN = normalize(mix(n, nn, 0.7)); vT = T; vK = aT; vWorld = S;
  gl_Position = projectionMatrix * viewMatrix * vec4(S, 1.0);
}`;

const TEPAL_FS = /* glsl */`
varying vec3 vWorld; varying vec3 vN; varying vec3 vT; varying vec3 vK;
void main() {
  float k = vK.x, u = vK.y, v = vK.z;
  bool outside = gl_FrontFacing;
  vec3 n = normalize(vN); if (!outside) n = -n;
  vec3 V = normalize(cameraPosition - vWorld); vec3 L = uSunDir;
  float melt = heroMelt(vWorld), lit = heroLit(vWorld);
  float sh = sunShadow(vWorld + n * 0.0003, 0.012);
  vec3 sunC = uSunColor * lit * sh;
  float ndl = dot(n, L), ndv = clamp(dot(n, V), 0.0, 1.0);
  float back = pow(clamp(dot(-V, L), 0.0, 1.0), 3.0);
  float outerW = step(mod(k + 0.5, 2.0), 1.0);
  float cov = tepalCov(k, u, v);
  float vn = vnoise(vec2(v * 9.0 + k * 3.1, u * 14.0));
  float vein = 1.0 - 0.7 * smoothstep(0.84, 0.98, 0.5 + 0.5 * sin(v * 22.0 * (1.0 - 0.35 * u) + (vn - 0.5) * 0.8 + k)) * smoothstep(0.05, 0.35, u) * (1.0 - smoothstep(0.7, 0.95, u));
  vec3 sunN = heroSunNeutral(sunC);
  vec3 col;
  if (outside) {
    vec3 alb = mix(C_DEEPV * 0.8, C_HVIOLET, smoothstep(0.02, 0.55, u));
    alb = mix(alb, s2l(vec3(0.46, 0.40, 0.92)), smoothstep(0.7, 1.0, u) * 0.3);
    alb *= mix(0.94, 1.03, vein);
    // seams: deep violet where the frost does not reach, with a little contact shadow
    float seamAO = outerW > 0.5 ? 1.0 : 1.0 - 0.55 * smoothstep(0.34, 0.5, abs(v)) * (1.0 - smoothstep(0.58, 0.7, abs(v)));
    alb = mix(alb, mix(C_DEEPV, C_HVIOLET, 0.6) * 1.15, (1.0 - cov) * 0.85) * seamAO;
    float frost = cov * (1.0 - smoothstep(0.0, 0.75, melt));
    float crystals = smoothstep(0.3, 0.75, vnoise(vec2(u * 70.0, v * 22.0 + k * 9.0)) * 0.7 + vnoise(vec2(u * 190.0, v * 61.0)) * 0.3);
    float veil = cov * mix(0.18, 0.10, uHeroMisc.x);
    alb = mix(alb, C_HAIR * 0.8, veil);
    alb = mix(alb, C_RIME, frost * mix(0.55, 0.92, crystals) * uHeroMisc.w);
    float diff = clamp((ndl + 0.35) / 1.35, 0.0, 1.0);
    float trans = clamp(-ndl, 0.0, 1.0);
    col = alb * heroAmbient(n);
    col += alb * sunN * diff * 0.9;
    col += C_VGLOW * sunN * trans * (0.25 + 0.9 * back) * (1.0 - frost * 0.7);
    // light diffusing through the whole bud (faint violet body glow when backlit)
    col += C_VGLOW * heroSunNeutral(uSunColor) * lit * 0.03 * (1.0 - frost * 0.6);
    // grazing rim: frost scatters the bright sky / sun behind; once melted the real hair
    // fringe carries the halo, so the surface term stays a faint underlay (no cut-out outline)
    float rim = pow(1.0 - ndv, 2.5) * (0.4 + 0.6 * cov);
    float vis = sunShadow(vWorld + n * 0.0012, 0.01);
    col += (heroSkyBehind(V) * 0.55 + sunC * 2.2 * back) * rim * mix(C_HAIR, C_RIME, frost) * mix(0.6, 1.0, vis) * mix(0.12, 0.35, frost);
    // silky hair sheen: the coat of fibres lying along the tepal catches the sky in a soft band
    vec3 Tn = normalize(vT); vec3 Hs = normalize(vec3(0.0, 1.0, 0.0) + V);
    float THs = dot(Tn, Hs); float sheen = pow(sqrt(max(1.0 - THs * THs, 0.0)), 14.0);
    col += C_HAIR * heroAmbient(vec3(0.0, 1.0, 0.0)) * sheen * 0.32 * cov * (1.0 - frost);
    // seam glow: hot gold light leaking from inside (held breath + hit)
    float seam = smoothstep(0.80, 1.0, abs(v)) * outerW + (1.0 - outerW) * smoothstep(0.44, 0.54, abs(v)) * (1.0 - smoothstep(0.6, 0.7, abs(v)));
    col += C_STAMEN * uGlow * seam * (1.25 - u) * 2.2 * (1.0 - smoothstep(0.5, 0.9, uOpen));
    // thin translucent margins of the outer tepals catch the backlight: the seams read as violet lines
    col += C_VGLOW * heroSunNeutral(uSunColor) * lit * 0.22 * outerW * smoothstep(0.86, 0.99, abs(v)) * (1.0 - frost);
  } else {
    // inner side (the money shot): satin and hairless. Deep violet base -> luminous violet
    // tip, fine darker veins along the axis, thin-tissue transmission when backlit with
    // lavender margins. The transmitted light is filtered violet, so it stays saturated.
    float g = smoothstep(0.0, 0.92, u);
    float edge = smoothstep(0.55, 1.0, abs(v)) * smoothstep(0.1, 0.4, u);
    vec3 alb = mix(C_TEP_BASE, C_TEP_TIP, g);
    float veinM = smoothstep(0.06, 0.3, u) * (1.0 - smoothstep(0.8, 0.97, u));
    float vd = smoothstep(0.80, 0.97, 0.5 + 0.5 * sin(v * 30.0 * (1.0 - 0.3 * u) + (vn - 0.5) * 1.2 + k * 1.3)) * veinM;
    vd = max(vd, (1.0 - smoothstep(0.03, 0.09, abs(v))) * veinM * 0.8);   // midrib
    alb *= 1.0 - 0.24 * vd;
    float diff = clamp((ndl + 0.25) / 1.25, 0.0, 1.0);
    float shT = sunShadow(vWorld - n * 0.0006, 0.012);                    // sun reaching the back of this tepal
    vec3 sunT = heroSunNeutral(uSunColor * lit * shT);
    float trans = clamp(-ndl + 0.15, 0.0, 1.15);
    float thin = mix(0.45, 1.0, g) + 0.5 * edge;
    vec3 transC = mix(C_TEP_TRANS, C_TEP_EDGE, clamp(edge * 0.75 + g * 0.15, 0.0, 1.0));
    col = alb * heroAmbient(n) * 0.42;
    col += alb * sunN * diff * 0.6;
    col += transC * sunT * trans * (0.22 + 1.1 * back) * thin * 0.42 * (1.0 - 0.45 * vd);
    // warm sun bleeding through the thinnest margin: a gold hairline, kept off the violet body
    col += uSunColor * lit * shT * back * edge * smoothstep(0.93, 1.0, abs(v)) * 0.06;
    float spec = pow(clamp(dot(reflect(-L, n), V), 0.0, 1.0), 40.0);
    col += alb * sunC * spec * 0.4;
    col += C_STAMEN * uGlow * pow(1.0 - u, 3.0) * 0.6;
  }
  col = applyFog(col, vWorld);
  gl_FragColor = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------- hairs (instanced camera-facing ribbons)
const HAIR_VS = /* glsl */`
attribute vec2 aHair; attribute vec4 iRoot; attribute vec4 iRnd;
uniform float uHairLen; uniform float uHairW;
varying vec3 vWorld; varying vec3 vTan; varying float vS; varying vec3 vRootN; varying float vMat; varying float vRnd;
void main() {
  vec3 P, n, T, B; float mat;
  rootFrame(iRoot, P, n, T, B, mat);
  float wet = uHeroMisc.x;
  // silky pasque fur: tepal hairs combed toward the tip and standing off the surface (a
  // backlit silver fringe on the silhouette); stem / bract hairs lie flat along their organ
  float lenM = mat < 0.5 ? 1.0 : (mat < 1.5 ? 0.9 : (mat < 2.5 ? 0.6 : 0.45));
  float liftM = mat < 0.5 ? 1.0 : (mat < 1.5 ? 0.42 : (mat < 2.5 ? 0.5 : 0.8));
  float cov = 1.0;
  if (mat < 0.5) { // inner-whorl flanks sit under the outer tepals: keep their hairs short
    float outer = step(mod(iRoot.x + 0.5, 2.0), 1.0);
    cov = mix(mix(1.0, 0.25, smoothstep(0.42, 0.6, abs(iRoot.z))), 1.0 - 0.5 * smoothstep(0.85, 1.0, abs(iRoot.z)), outer);
  }
  float guard = step(0.86, iRnd.w);   // a few long guard hairs stand well off the surface
  float lift = (mix(0.22, 0.8, iRnd.y) + guard * 0.35) * liftM * mix(1.0, 0.7, wet);
  float az = (iRnd.z - 0.5) * (mat < 0.5 ? 0.6 : 0.5);
  if (mat < 0.5) az = az * (1.0 - smoothstep(0.6, 0.92, abs(iRoot.z))) - sign(iRoot.z) * 0.18 * smoothstep(0.6, 0.95, abs(iRoot.z));
  vec3 td = normalize(T * cos(az) + B * sin(az));
  vec3 d0 = normalize(n * sin(lift) + td * cos(lift));
  vec3 d1 = normalize(td + n * (0.10 - 0.22 * fract(iRnd.w * 7.0)) * (mat < 0.5 ? 1.0 : 0.3) - vec3(0.0, 0.2 * wet, 0.0));
  float L = uHairLen * lenM * mix(0.5, 1.2, iRnd.x) * (1.0 + 0.35 * guard) * cov;
  float s = aHair.x;
  vec3 p1 = P + d0 * L * 0.5; vec3 p2 = p1 + d1 * L * 0.55;
  vec3 pos = mix(mix(P, p1, s), mix(p1, p2, s), s);
  vec3 tg = normalize(mix(p1 - P, p2 - p1, s));
  vec3 V = normalize(cameraPosition - pos);
  vec3 side = normalize(cross(tg, V) + 1e-6);
  float dist = length(cameraPosition - pos);
  float w = max(uHairW * (1.0 - 0.55 * s), uPx * dist * 0.9);
  pos += side * aHair.y * w * 0.5;
  if (mat < 3.5) pos = heroScaleP(pos);
  vWorld = pos; vTan = tg; vS = s; vRootN = n; vMat = mat; vRnd = iRnd.x;
  gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
}`;

const HAIR_FS = /* glsl */`
varying vec3 vWorld; varying vec3 vTan; varying float vS; varying vec3 vRootN; varying float vMat; varying float vRnd;
void main() {
  vec3 T = normalize(vTan); vec3 V = normalize(cameraPosition - vWorld); vec3 L = uSunDir;
  vec3 lmf = heroLMF(vWorld);
  float lit = lmf.x, melt = lmf.y;
  float vis = heroShadow(vWorld, 0.006);
  float TL = dot(T, L); float sinTL = sqrt(max(1.0 - TL * TL, 0.0));
  float TV = dot(T, V); float sinTV = sqrt(max(1.0 - TV * TV, 0.0));
  float back = pow(clamp(dot(-V, L), 0.0, 1.0), 4.0);
  vec3 H = normalize(L + V);
  float TH = dot(T, H); float spec = pow(sqrt(max(1.0 - TH * TH, 0.0)), 60.0);
  vec3 base = C_HAIR;
  if (vMat < 0.5) base = mix(base, C_VIOLET * 1.3, (1.0 - vS) * 0.45);
  else if (vMat > 1.5) base = mix(base, s2l(vec3(0.62, 0.70, 0.58)), (1.0 - vS) * 0.4 * heroGreen(vWorld));
  float frost = 1.0 - smoothstep(0.0, 0.7, melt);
  base = mix(base, C_RIME, frost * 0.6);
  vec3 sunC = uSunColor * lit * vis;
  // hairs lying across the face of the organ stay a fine veil (the violet reads through);
  // hairs on the silhouette forward-scatter the low sun into a silver fringe
  float rimF = 1.0 - abs(dot(normalize(vRootN), V));
  vec3 col = base * heroAmbient(normalize(vRootN)) * (0.5 + 0.3 * sinTL) * mix(0.55, 1.0, rimF);
  col += base * heroSkyBehind(V) * mix(0.12, 0.6, vis) * sinTV * (0.6 + 0.4 * vS) * mix(0.5, 1.0, rimF);
  col += base * sunC * (0.15 * sinTL + 1.35 * back * sinTL * sinTV * (0.3 + 0.7 * rimF) + 0.35 * spec);
  col *= mix(0.85, 1.1, vRnd);
  col = applyFog(col, vWorld);
  gl_FragColor = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------- rime needles (instanced feathery ice cards)
const RIME_VS = /* glsl */`
attribute vec2 aCard; attribute vec4 iRoot; attribute vec4 iRnd; attribute vec4 iRnd2;
uniform float uRimeLen;
varying vec3 vWorld; varying vec2 vUV; varying vec3 vAxis; varying vec3 vRootN; varying vec4 vRnd; varying float vMelt; varying float vPxW;
void main() {
  vec3 P, n, T, B; float mat;
  rootFrame(iRoot, P, n, T, B, mat);
  float melt = heroMelt(P);
  float cov = mat < 0.5 ? tepalCov(iRoot.x, iRoot.y, iRoot.z) : 1.0;
  vec3 dir;
  bool edge = mat > 3.5 && abs(iRoot.z) > 0.95;
  if (edge) dir = normalize(B * sign(iRoot.z) + n * (iRnd.y - 0.5) * 0.9 + T * (0.25 + iRnd.z * 0.5));
  else dir = normalize(n + (vec3(iRnd.y, iRnd.z, iRnd.w) - 0.5) * 1.15 + T * 0.3);
  float lenM = mat < 0.5 ? 1.0 : (mat < 1.5 ? 1.0 : (mat < 3.5 ? 0.6 : (edge ? 1.45 : 0.9)));
  float L = uRimeLen * lenM * mix(0.3, 1.0, iRnd.x * iRnd.x) * cov * (1.0 - smoothstep(0.05, 0.85, melt));
  vec3 R = P + n * iRnd2.x * (mat < 0.5 ? 0.0012 : (mat < 2.5 ? 0.0010 : 0.0001));
  vec3 V = normalize(cameraPosition - R);
  vec3 side = normalize(cross(dir, V) + 1e-6);
  float dist = length(cameraPosition - R);
  float pxw = uPx * dist;
  float w = max(L * mix(0.24, 0.55, iRnd2.y), pxw * 0.9);
  vec3 pos = R + dir * L * aCard.x + side * aCard.y * w * 0.5;
  vUV = vec2(aCard.y, aCard.x); vAxis = dir; vRootN = n; vRnd = vec4(iRnd2.zw, iRnd.yz); vMelt = melt;
  vPxW = w / max(pxw, 1e-9);
  if (mat < 3.5) pos = heroScaleP(pos);
  vWorld = pos;
  gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
}`;

const RIME_FS = /* glsl */`
varying vec3 vWorld; varying vec2 vUV; varying vec3 vAxis; varying vec3 vRootN; varying vec4 vRnd; varying float vMelt; varying float vPxW;
void main() {
  vec2 uv = vUV;
  float ax = abs(uv.x);
  float taper = 1.0 - uv.y * 0.65;
  float spine = 1.0 - smoothstep(0.26 * taper, 0.42 * taper, ax);
  float yy = uv.y - ax * 0.55;
  float f = fract(yy * (3.0 + vRnd.y * 2.0) + vRnd.x * 7.0);
  float barbLen = (1.0 - uv.y) * 1.0;
  float barb = (1.0 - smoothstep(0.16, 0.30, abs(f - 0.5))) * step(ax, barbLen) * step(0.08, uv.y);
  float feather = step(0.3, vRnd.x) * smoothstep(6.0, 10.0, vPxW);
  // some crystals are hexagonal plates instead of needles/feathers
  float plate = step(0.82, vRnd.y) * smoothstep(6.0, 10.0, vPxW);
  vec2 hp = vec2(uv.x, (uv.y - 0.55) * 2.2);
  vec2 ah = abs(hp);
  float hexd = max(ah.x * 0.866 + ah.y * 0.5, ah.y);
  float shape = max(spine, barb * feather);
  if (plate > 0.5) shape = max(1.0 - smoothstep(0.78, 0.9, hexd), step(uv.y, 0.25) * (1.0 - smoothstep(0.2, 0.35, ax)));
  if (vPxW < 4.0) shape = 1.0 - smoothstep(0.6, 1.0, ax);
  shape *= 1.0 - smoothstep(0.90, 1.0, uv.y + ax * 0.3);
  if (shape < 0.5) discard;
  vec3 V = normalize(cameraPosition - vWorld); vec3 L = uSunDir;
  vec3 lmf = heroLMF(vWorld);
  float lit = lmf.x; float vis = heroShadow(vWorld, 0.005);
  vec3 A = normalize(vAxis);
  float AL = dot(A, L); float sinAL = sqrt(max(1.0 - AL * AL, 0.0));
  float AV = dot(A, V); float sinAV = sqrt(max(1.0 - AV * AV, 0.0));
  float back = pow(clamp(dot(-V, L), 0.0, 1.0), 6.0);
  vec3 fn = normalize(hash33(vec3(vRnd.xy * 97.0, vRnd.z * 13.0)) - 0.5);
  vec3 defl = normalize(-L + fn * 0.55);
  float glint = pow(clamp(dot(defl, V), 0.0, 1.0), 220.0);
  float flare = lmf.z;
  vec3 sunC = uSunColor * lit * vis;
  vec3 ice = C_RIME;
  // crystal facets: brighter where they face the sky, slight per-crystal variation
  float faceUp = 0.75 + 0.35 * clamp(A.y, -1.0, 1.0) + 0.2 * (vRnd.w - 0.5);
  vec3 col = ice * heroAmbient(normalize(vRootN + A)) * 1.25 * faceUp * uHeroMisc.w;
  col += ice * heroSkyBehind(V) * mix(0.25, 0.7, vis) * sinAV;
  col += sunC * ice * (0.15 + 1.5 * back * (0.35 + 0.65 * sinAL));
  col += sunC * glint * (6.0 + 40.0 * flare);
  // glassy as it melts: clear core, bright rims
  float rimE = smoothstep(0.35, 0.95, ax / max(taper * 0.3, 0.05));
  col = mix(col, col * mix(0.45, 1.5, rimE), smoothstep(0.1, 0.6, vMelt));
  col = applyFog(col, vWorld);
  gl_FragColor = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------- dew drops (instanced spheres)
const DEW_VS = /* glsl */`
attribute vec4 iRoot; attribute vec4 iRnd;
uniform float uDewR;
varying vec3 vWorld; varying vec3 vN; varying float vLit; varying vec3 vSN; varying float vMat;
void main() {
  vec3 P, n, T, B; float mat;
  rootFrame(iRoot, P, n, T, B, mat);
  float melt = heroMelt(P);
  float grow = smoothstep(0.2, 1.0, melt);
  bool hero = iRnd.w > 1.5;
  float gone = (mat < 0.5) ? uDewGone : 0.0;
  float rs = mat < 0.5 ? 1.0 : (mat > 3.5 ? 1.35 : 0.8);
  // 0.3-2x sizes: mostly small beads, a few fat drops
  float r = uDewR * rs * mix(0.3, 2.0, pow(iRnd.x, 2.2)) * grow * (1.0 - gone);
  if (hero) r = uDewR * 2.6 * smoothstep(0.1, 0.8, melt) * (1.0 - gone);
  vec3 lp = position;
  // drops are held up in the hair coat (tepals / stem / ruff); bare blades carry sessile beads
  float coat = mat < 0.5 ? 0.0004 + 0.0011 * iRnd.y : (mat < 2.5 ? 0.0003 + 0.0006 * iRnd.y : 0.00005);
  vec3 cen = P + n * (r * 0.8 + coat);
  if (hero) {
    // the trembling drop perched on the bud tip (held breath): offset along the surface normal
    // so it sits on the tepal, never through it
    cen = P + n * (r * 1.02 + 0.0001);
    float tr = smoothstep(${TIMES.held.toFixed(2)}, ${(TIMES.hit - 0.05).toFixed(2)}, uTime);
    float wob = sin(uTime * 6.2831 * 11.0) * (0.25 + 0.75 * tr);
    cen += B * wob * r * 0.10 * tr;
    lp += n * dot(lp, n) * 0.12 * tr * (0.6 + 0.4 * sin(uTime * 6.2831 * 11.0 + 1.3));
  } else {
    lp -= n * dot(lp, n) * 0.12; // slightly flattened
  }
  vec3 wp = cen + lp * r;
  if (mat < 3.5) wp = heroScaleP(wp);
  vN = normalize(position); vWorld = wp; vLit = heroLit(P); vSN = n; vMat = mat;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

const DEW_FS = /* glsl */`
varying vec3 vWorld; varying vec3 vN; varying float vLit; varying vec3 vSN; varying float vMat;
// environment seen through / in a drop: sky above, the cold snowfield below (smooth: no seam)
vec3 envDir(vec3 d) {
  vec3 gnd = uSkyAmbient * s2l(vec3(0.82, 0.86, 1.0)) * 1.3 + uSunColor * 0.04;
  return mix(gnd, skyGradient(normalize(vec3(d.x, max(d.y, 0.02), d.z))), smoothstep(-0.25, 0.1, d.y));
}
void main() {
  vec3 N = normalize(vN); vec3 V = normalize(cameraPosition - vWorld); vec3 L = uSunDir; vec3 nS = normalize(vSN);
  float sh = heroShadow(vWorld, 0.01);
  vec3 sunC = uSunColor * vLit * sh;
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  float F = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  vec3 R = reflect(-V, N);
  vec3 refl = envDir(R);
  // refraction (IOR 1.33): rays bent down into the organ show it magnified; the rest leave
  // through the far side as an inverted, magnified view of the sky
  vec3 tr = refract(-V, N, 0.75);
  vec3 lat = N - V * dot(N, V);
  vec3 td = normalize(-V - lat * 1.25);
  float down = smoothstep(0.05, -0.35, dot(tr, nS));
  vec3 sub;
  if (vMat < 0.5) sub = mix(C_HVIOLET, C_HAIR, 0.3) * heroAmbient(nS) * 1.1 + C_TEP_TRANS * heroSunNeutral(sunC) * 0.15;
  else if (vMat > 3.5) sub = mix(s2l(vec3(0.62, 0.57, 0.47)), C_EMERALD, heroGreen(vWorld)) * (heroAmbient(nS) * 0.8 + sunC * 0.1);
  else sub = s2l(vec3(0.42, 0.44, 0.38)) * heroAmbient(nS) * 0.8;
  vec3 thru = mix(envDir(td) * 1.05, sub * 1.3, down * 0.55);
  vec3 col = mix(thru, refl, F);
  col *= mix(0.1, 1.0, smoothstep(0.1, 0.38, ndv));              // dark refractive rim
  // skylight focused by the drop: a bright crescent low inside it
  col += (uSkyHorizon + uSkyZenith) * 0.35 * smoothstep(-0.15, -0.7, N.y) * smoothstep(0.25, 0.7, ndv);
  col += sunC * pow(clamp(dot(td, L), 0.0, 1.0), 900.0) * 30.0;   // the sun's tiny image
  col += sunC * pow(clamp(dot(td, L), 0.0, 1.0), 60.0) * 0.5;
  col += sunC * pow(clamp(dot(R, L), 0.0, 1.0), 1200.0) * 40.0;   // pinpoint glint on the rim
  col += (uSkyHorizon + uSkyZenith) * 0.5 * pow(clamp(R.y, 0.0, 1.0), 90.0) * 4.0;    // sky window
  col = applyFog(col, vWorld);
  gl_FragColor = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------- curves: tubes (stem, bracts, basal) + blades
const CURVE_VS = /* glsl */`
attribute vec2 aUV; attribute float iCurve;
varying vec3 vWorld; varying vec3 vN; varying vec3 vT; varying vec2 vUV; varying vec4 vPrm;
void main() {
  vec3 C, T, N, B; float r, kind; vec4 prm;
  curveEval(iCurve, aUV.x, C, T, N, B, r, kind, prm);
  vec3 wp, n;
  if (kind < 0.5) { float a = aUV.y * 6.2831853; n = N * cos(a) + B * sin(a); wp = C + n * r; }
  else {
    float v = aUV.y * 2.0 - 1.0; float fold = prm.y;
    wp = C + B * v * r + N * abs(v) * r * fold;
    n = abs(v) < 1e-3 ? N : normalize(N - sign(v) * fold * B);
  }
  if (kind < 0.5) wp = heroScaleP(wp);
  vWorld = wp; vN = n; vT = T; vUV = aUV; vPrm = prm;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

const TUBE_FS = /* glsl */`
varying vec3 vWorld; varying vec3 vN; varying vec3 vT; varying vec2 vUV; varying vec4 vPrm;
void main() {
  float mat = vPrm.x;
  vec3 n = normalize(vN);
  vec3 V = normalize(cameraPosition - vWorld); vec3 L = uSunDir;
  float lit = heroLit(vWorld), melt = heroMelt(vWorld);
  float sh = sunShadow(vWorld + n * 0.0003, 0.01);
  float green = heroGreen(vWorld);
  vec3 alb = mat < 1.5 ? mix(s2l(vec3(0.30, 0.22, 0.36)), s2l(vec3(0.30, 0.36, 0.22)), smoothstep(0.7, 0.2, vUV.x))
                       : mix(s2l(vec3(0.40, 0.45, 0.40)), s2l(vec3(0.30, 0.55, 0.30)), green);
  alb = mix(alb, C_HAIR * 0.8, mat > 1.5 && mat < 2.5 ? 0.08 : 0.3);
  float frost = 1.0 - smoothstep(0.0, 0.75, melt);
  alb = mix(alb, C_RIME, frost * 0.6 * uHeroMisc.w);
  vec3 sunC = uSunColor * lit * sh;
  float ndl = dot(n, L), ndv = clamp(dot(n, V), 0.0, 1.0);
  float diff = clamp((ndl + 0.4) / 1.4, 0.0, 1.0);
  float back = pow(clamp(dot(-V, L), 0.0, 1.0), 4.0);
  float rim = pow(1.0 - ndv, 2.5);
  float vis = sunShadow(vWorld + n * 0.001, 0.01);
  vec3 col = alb * heroAmbient(n) + alb * sunC * diff;
  col += (heroSkyBehind(V) * 0.5 + uSunColor * lit * vis * back * (mat > 1.5 ? 1.2 : 2.0)) * rim * C_HAIR * 0.35;   // faint: the hair fringe carries the rim
  col += alb * uSunColor * lit * vis * clamp(-ndl, 0.0, 1.0) * back * 0.4 * (mat > 1.5 ? 1.0 : 0.3);
  col = applyFog(col, vWorld);
  gl_FragColor = vec4(col, 1.0);
}`;

const BLADE_FS = /* glsl */`
varying vec3 vWorld; varying vec3 vN; varying vec3 vT; varying vec2 vUV; varying vec4 vPrm;
void main() {
  vec3 V = normalize(cameraPosition - vWorld); vec3 L = uSunDir;
  vec3 n = normalize(vN); if (dot(n, V) < 0.0) n = -n;
  float v = vUV.y * 2.0 - 1.0, s = vUV.x;
  float lit = heroLit(vWorld), melt = heroMelt(vWorld);
  float sh = sunShadow(vWorld + n * 0.0002, 0.008);
  float green = heroGreen(vWorld);
  float seed = vPrm.z;
  float veins = 0.5 + 0.5 * sin(v * 19.0 + seed * 7.0);
  vec3 dry = mix(s2l(vec3(0.66, 0.60, 0.50)), s2l(vec3(0.52, 0.47, 0.42)), smoothstep(0.3, 1.0, s) * 0.6 + seed * 0.2);
  vec3 fresh = mix(C_EMERALD * 0.9, C_CHARTREUSE * 0.85, smoothstep(0.2, 0.9, s));
  vec3 alb = mix(dry, fresh, green) * mix(0.88, 1.06, veins);
  alb *= 1.0 - 0.18 * (1.0 - smoothstep(0.0, 0.12, abs(v))); // midrib groove
  float frost = (1.0 - smoothstep(0.0, 0.8, melt)) * (0.55 + 0.45 * smoothstep(0.55, 1.0, abs(v)));
  float crystals = smoothstep(0.45, 0.8, vnoise(vec2(v * 6.0, s * 260.0) + seed * 31.0));
  alb = mix(alb, C_RIME, clamp(frost * (0.55 + 0.45 * crystals), 0.0, 1.0) * uHeroMisc.w);
  vec3 sunC = uSunColor * lit * sh;
  float ndl = dot(n, L), ndv = clamp(dot(n, V), 0.0, 1.0);
  float diff = clamp((ndl + 0.3) / 1.3, 0.0, 1.0);
  float back = pow(clamp(dot(-V, L), 0.0, 1.0), 3.0);
  vec3 transC = mix(s2l(vec3(0.95, 0.75, 0.45)), C_CHARTREUSE, green);
  vec3 col = alb * heroAmbient(n) + alb * sunC * diff;
  col += transC * sunC * clamp(-ndl, 0.0, 1.0) * (0.25 + 1.1 * back) * (1.0 - frost * 0.6);
  float rim = pow(1.0 - ndv, 3.0);
  col += (heroSkyBehind(V) * 0.35 + sunC * back * 1.5) * rim * mix(alb, C_RIME, frost);
  col = applyFog(col, vWorld);
  gl_FragColor = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------- stamens + pistils
const STAMEN_VS = /* glsl */`
attribute vec3 aLoc; attribute float aPart; attribute vec4 iA; attribute vec4 iB;
varying vec3 vWorld; varying vec3 vN; varying float vPart; varying float vType; varying float vY;
void main() {
  float phi = iA.x, rr = iA.y, lenR = iA.z, type = iA.w;
  float oc = clamp(uOpen, 0.0, 1.35);
  float o1 = min(oc, 1.0);
  vec3 radial = uFX * cos(phi) + uFZ * sin(phi);
  vec3 root = uFC + radial * rr * 0.0021 + uFA * 0.0008;   // inside the tepal hinge ring (no anthers poking through the front tepal)
  float spread = (type < 0.5 ? mix(0.10, 0.58, rr) : 0.05 + rr * 0.25) * mix(0.25, 1.0, smoothstep(0.0, 1.0, oc)) + (oc - o1) * 0.5;
  spread += (iB.x - 0.5) * 0.25;
  vec3 dir = normalize(uFA + radial * spread + (uFX * (iB.y - 0.5) + uFZ * (iB.z - 0.5)) * 0.18);
  float len = (type < 0.5 ? mix(0.0068, 0.0118, lenR) * mix(1.0, 0.8, rr) : mix(0.0105, 0.0135, lenR)) * mix(0.5, 1.0, smoothstep(0.0, 0.9, oc));
  vec3 side = normalize(cross(dir, radial + uFZ * 0.01));
  vec3 nrm = normalize(cross(side, dir));
  float y = aLoc.y;
  vec3 wp, n;
  vec3 bow = radial * len * 0.12;
  if (aPart < 0.5) {
    float rad = type < 0.5 ? 0.00011 : 0.000085;
    vec3 c = root + dir * len * y + bow * y * y;
    n = normalize(side * aLoc.x + nrm * aLoc.z);
    wp = c + n * rad;
  } else {
    vec3 tip = root + dir * len + bow;
    vec3 ax = normalize(dir + radial * 0.24);
    vec3 l = aLoc;
    vec3 sz = type < 0.5 ? vec3(0.00046, 0.00085, 0.00046) : vec3(0.00018, 0.00050, 0.00018);
    wp = tip + ax * (l.y + 0.85) * sz.y + side * l.x * sz.x + nrm * l.z * sz.z;
    n = normalize(ax * l.y / sz.y + side * l.x / sz.x + nrm * l.z / sz.z);
  }
  wp = heroScaleP(wp);
  vWorld = wp; vN = n; vPart = aPart; vType = type; vY = y;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

const STAMEN_FS = /* glsl */`
varying vec3 vWorld; varying vec3 vN; varying float vPart; varying float vType; varying float vY;
void main() {
  vec3 n = normalize(vN); vec3 V = normalize(cameraPosition - vWorld); vec3 L = uSunDir;
  float lit = heroLit(vWorld);
  float sh = sunShadow(vWorld + n * 0.0002, 0.008);
  vec3 sunC = uSunColor * lit * sh;
  vec3 alb;
  if (vType < 0.5) alb = vPart > 0.5 ? C_STAMEN : mix(s2l(vec3(0.95, 0.90, 0.62)), C_STAMEN, vY * 0.6);
  else alb = vPart > 0.5 ? s2l(vec3(0.62, 0.42, 0.95)) : mix(s2l(vec3(0.42, 0.25, 0.75)), s2l(vec3(0.60, 0.45, 0.95)), vY);
  float ndl = dot(n, L);
  float diff = clamp((ndl + 0.5) / 1.5, 0.0, 1.0);
  float back = pow(clamp(dot(-V, L), 0.0, 1.0), 3.0);
  vec3 col = alb * heroAmbient(n) + alb * sunC * diff * 1.1;
  col += alb * sunC * clamp(-ndl, 0.0, 1.0) * (0.4 + back) * 0.9;
  float rim = pow(1.0 - clamp(dot(n, V), 0.0, 1.0), 2.0);
  col += alb * uSunColor * lit * rim * back * 1.5;
  col += (vType < 0.5 ? C_STAMEN : C_VIOLET) * uGlow * (vPart > 0.5 ? 1.6 : 0.6);
  col = applyFog(col, vWorld);
  gl_FragColor = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------- macro snow crust disc
const GROUND_VS = /* glsl */`
varying vec3 vWorld; varying vec3 vN; varying float vR; varying float vBloom;
float crustH(vec2 xz, float bloom) {
  float r = length(xz - uBudBase.xz);
  float edge = smoothstep(0.62, 0.40, r);
  float h = mix(-0.004, 0.010, edge) - 0.026 * smoothstep(0.62, 0.72, r);   // beyond the crust: under the terrain
  h += ((fbm(xz * 16.0) - 0.5) * 0.010 + (vnoise(xz * 75.0) - 0.5) * 0.0016 + (vnoise(xz * 260.0) - 0.5) * 0.0004) * edge;
  h -= 0.006 * exp(-r * r / 0.0004) * edge; // small melt well around the stem
  // spring: a short-turf floor that covers the meadow's hero clearing and dips under the
  // terrain (and the meadow carpet) at its rim
  float hs = mix(0.002, -0.03, smoothstep(${(HERO.turfR - 0.3).toFixed(2)}, ${HERO.turfR.toFixed(2)}, r));
  return mix(h, hs, smoothstep(0.0, 0.75, bloom));
}
void main() {
  vec3 wp = position;
  float bloom = bloomAmt(wp.xz);
  float e = 0.0015;
  float h0 = crustH(wp.xz, bloom);
  float hx = crustH(wp.xz + vec2(e, 0.0), bloom), hz = crustH(wp.xz + vec2(0.0, e), bloom);
  wp.y += h0;
  vN = normalize(vec3(-(hx - h0) / e, 1.0, -(hz - h0) / e) + normal - vec3(0.0, 1.0, 0.0));
  vR = length(wp.xz - uBudBase.xz); vBloom = bloom;
  vWorld = wp;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

const GROUND_FS = /* glsl */`
varying vec3 vWorld; varying vec3 vN; varying float vR; varying float vBloom;
void main() {
  vec3 N = normalize(vN); vec3 V = normalize(cameraPosition - vWorld); vec3 L = uSunDir;
  vec2 xz = vWorld.xz;
  float lit = heroLit(vWorld);
  float sh = sunShadow(vWorld + N * 0.0015, 0.02);
  vec3 sunC = uSunColor * lit * sh;
  vec3 alb = C_SNOW * mix(0.94, 1.0, vnoise(xz * 140.0));
  float ndl = dot(N, L);
  float diff = smoothstep(0.0, 1.0, clamp((ndl + 0.35) / 1.35, 0.0, 1.0));
  vec3 col = alb * (sunC * diff + heroAmbient(N) * 0.95);
  col += C_SNOW_SH * uSkyAmbient * 0.3 * (1.0 - diff * sh * lit);
  // ice crystals: sparse facets that flash toward the low sun, plus sky glitter
  vec2 cell = floor(xz * 520.0);
  float h = hash12(cell);
  vec3 fn = normalize(vec3(hash12(cell + 3.1) - 0.5, 1.4, hash12(cell + 7.7) - 0.5));
  float facet = pow(clamp(dot(reflect(-L, fn), V), 0.0, 1.0), 90.0);
  col += step(0.86, h) * facet * sunC * 14.0;
  col += step(0.97, h) * uSkyAmbient * 1.4 * (0.5 + 0.5 * sin(uTime * 2.0 + h * 40.0));
  // fade our detail into the terrain's own shading at the rim
  float far = smoothstep(0.38, 0.6, vR);
  vec3 tcol = shadeSurface(C_SNOW, vec3(0.0, 1.0, 0.0), vWorld, 0.35, 1.0, 0.0, sh) + C_SNOW_SH * uSkyAmbient * 0.25 * (1.0 - max(L.y, 0.0) * sh);
  col = mix(col, tcol, far * 0.7);
  // spring turf floor: the meadow carpet's near-floor recipe (vegetation.js), so the hero
  // clearing reads as short grass continuing into the meadow, not a bare disc
  float spring = smoothstep(0.15, 0.85, vBloom);
  if (spring > 0.0) {
    float patchN = vnoise(xz * 0.07) * 0.6 + vnoise(xz * 0.23 + 4.0) * 0.4;
    float warm = smoothstep(0.3, 0.75, patchN);
    vec3 avg = mix(C_VIRIDIAN * 0.8, C_EMERALD * 0.62, 0.3 + 0.4 * warm);
    avg = mix(avg, C_CHARTREUSE * 0.62, 0.18 + 0.3 * warm);
    avg = mix(avg, avg * vec3(1.12, 1.06, 0.72), 0.5);
    float m1 = vnoise(xz * 2.4 + 2.0), m2 = vnoise(xz * 0.55 - 5.0);
    avg *= (0.62 + 0.38 * smoothstep(0.2, 0.8, m1)) * (0.8 + 0.4 * m2) * (0.8 + 0.2 * vnoise(xz * 30.0));
    vec3 scol = shadeSurface(avg, vec3(0.0, 1.0, 0.0), vWorld, 0.4, 0.7, 0.5, sunShadow(vWorld + vec3(0.0, 0.02, 0.0), 0.02));
    col = mix(col, scol, spring);
  }
  col = applyFog(col, vWorld);
  gl_FragColor = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------- spring turf: short blades sprouting round the bud after the hit
const TURF_VS = /* glsl */`
attribute vec2 aBl; attribute vec4 iP; attribute vec4 iT;   // iP: root xyz + r; iT: height, lean az, seed, width
varying vec3 vWorld; varying vec3 vN; varying float vS; varying float vSeed;
void main() {
  float r = iP.w;
  float grow = smoothstep(0.0, 0.45, uSince - 0.2 - r * 0.5) * smoothstep(0.3, 0.9, bloomAmt(iP.xz));
  float s = aBl.x;
  float h = iT.x * grow;
  vec3 ld = vec3(cos(iT.y), 0.0, sin(iT.y));
  vec2 wnd = windAt(iP.xz, uTime) * 0.12;
  vec3 bend = (ld * (0.2 + 0.45 * iT.z) + vec3(wnd.x, 0.0, wnd.y)) * h;
  vec3 C = iP.xyz - vec3(0.0, 0.008, 0.0) + vec3(0.0, h * s, 0.0) + bend * s * s;
  vec3 Tg = normalize(vec3(0.0, h, 0.0) + bend * 2.0 * s + vec3(0.0, 1e-5, 0.0));
  vec3 side = normalize(cross(Tg, ld) + vec3(1e-6, 0.0, 0.0));
  float dist = length(cameraPosition - C);
  float wdt = max(iT.w * (1.0 - s * 0.85), uPx * dist * 1.0) * step(0.001, grow);
  vec3 wp = C + side * aBl.y * wdt * 0.5;
  vN = normalize(cross(side, Tg)); vS = s; vSeed = iT.z; vWorld = wp;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const TURF_FS = /* glsl */`
varying vec3 vWorld; varying vec3 vN; varying float vS; varying float vSeed;
void main() {
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 n = normalize(vN); if (dot(n, V) < 0.0) n = -n;
  float sh = sunShadow(vWorld + n * 0.002, 0.02);
  vec3 alb = mix(C_VIRIDIAN * 0.6, mix(C_EMERALD * 0.85, C_CHARTREUSE * 0.8, 0.2 + 0.3 * vSeed), smoothstep(0.0, 0.8, vS));
  alb *= 0.8 + 0.3 * fract(vSeed * 7.3);
  vec3 col = shadeSurface(alb, n, vWorld, 0.5, mix(0.55, 1.0, vS), 0.6, sh);
  col = applyFog(col, vWorld);
  gl_FragColor = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------- overlay particles (premultiplied, self-blurred)
const OVER_COMMON = /* glsl */`
uniform sampler2D tDepth; uniform vec2 uNF; uniform vec4 uCoc; uniform float uPtMax;
float linD(float z) { float n = uNF.x, f = uNF.y; float ndc = z * 2.0 - 1.0; return 2.0 * n * f / (f + n - ndc * (f - n)); }
float cocAt(float d) { return min(uCoc.x * abs(1.0 - uCoc.y / max(d, 1e-4)), uCoc.z); }
float sceneVis(vec4 clip, float rel) {
  vec2 suv = clip.xy / clip.w * 0.5 + 0.5;
  if (any(lessThan(suv, vec2(0.0))) || any(greaterThan(suv, vec2(1.0)))) return 1.0;
  float sd = linD(textureLod(tDepth, suv, 0.0).x);
  return smoothstep(clip.w * (1.0 - rel), clip.w * (1.0 - rel * 0.3), sd);
}
float shadowVS(vec3 wp) {
  vec4 c0 = uShadowMat0 * vec4(wp, 1.0); vec3 s0 = c0.xyz * 0.5 + 0.5;
  if (all(greaterThan(s0.xy, vec2(0.02))) && all(lessThan(s0.xy, vec2(0.98))) && s0.z < 1.0)
    return step(s0.z - 0.000004, textureLod(tShadow0, s0.xy, 0.0).r);
  vec4 c1 = uShadowMat1 * vec4(wp, 1.0); vec3 s1 = c1.xyz * 0.5 + 0.5;
  if (all(greaterThan(s1.xy, vec2(0.0))) && all(lessThan(s1.xy, vec2(1.0))) && s1.z < 1.0)
    return step(s1.z - 0.00002, textureLod(tShadow1, s1.xy, 0.0).r);
  return 1.0;
}
`;

const POINT_VS = /* glsl */`
${OVER_COMMON}
attribute vec4 aA; attribute vec4 aB; attribute vec4 aC;
varying vec3 vCol; varying float vR; varying float vStar; varying float vSize; varying float vAlpha; varying float vE; varying float vSoft;
void main() {
  vec3 wp = vec3(0.0); vec3 col = vec3(0.0); float I = 0.0; float core = 1.2; float star = 0.0; float alpha = 0.0; float occRel = 0.03;
  float t = uTime;
#if KIND == 0
  // rime glints: crystals on the backlit rim flare as the light blade passes, then twinkle until melted
  vec3 P, n, T, B; float mat;
  rootFrame(aA, P, n, T, B, mat);
  // sits out at the rime-needle tips, so silhouette crystals poke past the body into the sun
  wp = P + n * (mat < 0.5 ? 0.0024 : 0.0014) * (0.6 + 0.4 * aB.y);
  float fl = heroFlare(P);
  float melt = heroMelt(P);
  float tw = pow(0.5 + 0.5 * sin(t * (7.0 + aB.x * 9.0) + aB.y * 40.0), 6.0);
  float sv = shadowVS(wp);
  float rimW = pow(1.0 - abs(dot(n, normalize(cameraPosition - wp))), 2.0);
  I = (fl * 2.4 + tw * 0.4 * (1.0 - melt)) * mix(0.55, 1.0, max(sv, rimW)) * mix(0.55, 1.0, rimW) * heroLit(P) * aB.z;
  col = mix(vec3(1.0, 0.86, 0.62), vec3(0.85, 0.92, 1.0), aB.w) * length(uSunColor) * 0.9;
  star = 1.0; core = 2.1;
#elif KIND == 1
  // dew spray flung at the hit: ballistic from the tepal surface
  float dt = t - aB.w;
  if (dt > 0.0) {
    float k = 2.5;
    wp = aA.xyz + aB.xyz * (1.0 - exp(-k * dt)) / k + vec3(0.0, -4.9, 0.0) * dt * dt;
    float fl = 0.55 + 0.45 * sin(dt * 60.0 + aA.w * 30.0);
    I = (1.0 - smoothstep(0.35, 0.75, dt)) * fl * aC.x * smoothstep(0.0, 0.02, dt);
    col = mix(vec3(1.0, 0.92, 0.75), vec3(0.75, 0.72, 1.0), aC.y) * length(uSunColor) * 1.6 + vec3(0.6, 0.6, 0.8);
    core = mix(1.4, 3.2, aC.z); star = 0.6; alpha = 0.0;
  }
#elif KIND == 2
  // pollen + light pulse: gold motes blasting out of the crown, then drifting
  float dt = t - aB.w;
  if (dt > 0.0) {
    float k = 3.2;
    vec3 c0 = uFC + uFA * 0.007;
    wp = c0 + aA.xyz * 0.003 + aB.xyz * (1.0 - exp(-k * dt)) / k + vec3(0.004, 0.012, 0.002) * dt;
    wp += vec3(sin(dt * 2.0 + aA.w * 9.0), 0.0, cos(dt * 1.7 + aA.w * 7.0)) * 0.004 * dt;
    float life = 1.0 - smoothstep(0.9, 1.7, dt);
    I = life * smoothstep(0.0, 0.03, dt) * aC.x * (0.6 + 0.4 * sin(dt * 9.0 + aA.w * 20.0)) * (1.0 + 2.0 * exp(-dt * 6.0));
    col = vec3(1.0, 0.74, 0.22) * 2.4;
    core = mix(1.0, 2.0, aC.y); star = 0.0;
  }
#elif KIND == 3
  // snow-crust glitter behind the bud: comes out as bokeh
  wp = aA.xyz;
  float tw = pow(0.5 + 0.5 * sin(t * (2.0 + aB.x * 5.0) + aB.y * 50.0), 8.0);
  float sunI = length(uSunColor);
  float sv = shadowVS(wp + vec3(0.0, 0.003, 0.0));
  I = aB.z * (0.25 * tw * (1.0 - smoothstep(0.5, 2.0, sunI)) * 0.6 + tw * sunI * sv * 1.1 * heroLit(wp));
  I *= 1.0 - smoothstep(${TIMES.pullStart.toFixed(2)}, ${(TIMES.pullStart + 0.4).toFixed(2)}, t);
  col = mix(vec3(0.75, 0.80, 1.0), vec3(1.0, 0.85, 0.62), smoothstep(0.3, 1.5, sunI) * aB.w);
  core = 1.2; star = 0.3; occRel = 0.02;
#elif KIND == 4
  // the pull-back spark: keeps the open flower reading as a violet spark with a gold heart
  wp = heroScaleP(uFC + uFA * 0.008);
  float d = length(cameraPosition - wp);
  I = smoothstep(0.9, 3.5, d) * smoothstep(${TIMES.pullStart.toFixed(2)}, ${(TIMES.pullStart + 0.5).toFixed(2)}, t) * aB.x;
  col = aB.y > 0.5 ? vec3(1.0, 0.62, 0.08) * 1.3 : vec3(0.30, 0.13, 1.0) * 1.05;
  core = aB.z * uCoc.w / 1080.0; star = aB.y > 0.5 ? 0.25 : 0.0; occRel = 0.2;
  alpha = aB.y > 0.5 ? 0.3 * min(I, 1.0) : min(0.95 * I, 0.92);
#else
  // the late wink at the heart (27.5 s)
  wp = uFC + uFA * 0.01;
  float x = (t - ${TIMES.glint.toFixed(2)}) / 0.35;
  I = exp(-x * x) * 3.0;
  col = mix(vec3(0.6, 0.45, 1.0), vec3(1.0, 0.8, 0.4), aB.y) * 2.0;
  core = aB.z; star = 1.0; occRel = 0.5;
#endif
  vec4 clip = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  if (I <= 1e-4 || clip.w <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  float vis = sceneVis(clip, occRel);
  float coc = cocAt(clip.w);
  core *= KIND == 4 ? 1.0 : uCoc.w / 1080.0;
  float rad = max(sqrt(core * core + coc * coc), 1.0);
  // energy conservation: a defocused sprite spreads the same light over its CoC disc
  float e = (core * core) / (rad * rad);
  float px = uCoc.w / 1080.0;
  float rayLen = star * (6.0 + 16.0 * min(I, 2.5)) * px * (1.0 - smoothstep(1.5, 6.0, coc));
  float size = min(2.0 * max(rad + 1.5, rayLen) + 2.0, uPtMax);
  gl_PointSize = size;
  vCol = col * I * vis; vR = rad; vStar = rayLen; vSize = size; vE = e; vAlpha = alpha * vis * e;
  vSoft = 1.0 - smoothstep(1.5, 5.0, coc);
  gl_Position = clip;
}`;

const POINT_FS = /* glsl */`
varying vec3 vCol; varying float vR; varying float vStar; varying float vSize; varying float vAlpha; varying float vE; varying float vSoft;
void main() {
  vec2 p = (gl_PointCoord - 0.5) * vSize;
  float r = length(p);
  float disc = 1.0 - smoothstep(vR - 0.8, vR + 0.6, r);
  float ring = 0.85 + 0.3 * smoothstep(vR * 0.55, vR, r);
  float glow = exp(-r * r / max(vR * vR * 0.3, 0.35)) * 1.7;
  float m = mix(disc * ring, glow, vSoft) * vE;
  float shapeA = mix(disc, glow / 1.7, vSoft);
  if (vStar > 0.0) {
    float rl = vStar * 0.33;
    float rays = exp(-abs(p.y) * 1.2) * exp(-abs(p.x) / rl) + exp(-abs(p.x) * 1.2) * exp(-abs(p.y) / rl);
    vec2 q = vec2(p.x + p.y, p.x - p.y) * 0.7071;
    rays += 0.35 * (exp(-abs(q.y) * 1.4) * exp(-abs(q.x) / (rl * 0.55)) + exp(-abs(q.x) * 1.4) * exp(-abs(q.y) / (rl * 0.55)));
    m += rays * 0.32;
  }
  if (m < 1e-4) discard;
  gl_FragColor = vec4(vCol * m, clamp(vAlpha * shapeA, 0.0, 1.0));
}`;

// billboard flash + shock ring at the hit
const FLASH_VS = /* glsl */`
${OVER_COMMON}
varying vec2 vQ; varying float vRadPx; varying float vDepth;
uniform vec4 uFlash; // x: radius (m), y: ring radius (m), z: core strength, w: ring strength
void main() {
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 c = uFC + uFA * 0.007;
  float R = max(uFlash.x, uFlash.y * 1.25);
  vec3 wp = c + (right * position.x + up * position.y) * R;
  vQ = position.xy * R;
  vDepth = (projectionMatrix * viewMatrix * vec4(c, 1.0)).w;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const FLASH_FS = /* glsl */`
${OVER_COMMON}
varying vec2 vQ; varying float vDepth;
uniform vec4 uFlash;
void main() {
  float r = length(vQ);
  float sd = linD(texelFetch(tDepth, ivec2(gl_FragCoord.xy), 0).x);
  float occ = smoothstep(vDepth - 0.008, vDepth - 0.001, sd);
  float core = exp(-r * r / max(uFlash.x * uFlash.x * 0.18, 1e-8)) * uFlash.z * mix(0.03, 1.0, occ);   // leaks out only as the tepals part
  float rw = max(uFlash.y * 0.12, 0.002);
  float ring = exp(-pow((r - uFlash.y) / rw, 2.0)) * uFlash.w;
  vec3 col = vec3(1.0, 0.82, 0.48) * core * 1.4 + vec3(1.0, 0.80, 0.42) * ring;
  gl_FragColor = vec4(col, 0.0);
}`;

// ---------------------------------------------------------------- helpers (CPU)
const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
// tepal opening after the hit (dt = s since the hit): ease-out rise to 1+over at `rise`,
// then a cosine settle (zero velocity at both ends) to 1 at `settle`
function openCurve(dt) {
  const { rise, over, settle, pow } = HERO.open;
  if (dt <= 0) return 0;
  if (dt < rise) return (1 + over) * (1 - Math.pow(1 - dt / rise, pow));
  const x = clamp01((dt - rise) / (settle - rise));
  return 1 + over * 0.5 * (1 + Math.cos(Math.PI * x));
}

function closedProfile(whorl) {
  const M = 900, H0 = HERO.budH * (whorl ? 0.965 : 1), off = whorl ? -HERO.whorlOff : HERO.whorlOff;
  const rho = tau => HERO.rec * (1 - tau) ** 2 + HERO.budR * Math.pow(Math.sin(Math.PI * Math.pow(tau, 0.7)), 0.9) + off * Math.sin(Math.PI * tau);
  const P = []; for (let i = 0; i <= M; i++) { const tau = i / M; P.push([rho(tau), H0 * tau]); }
  const cum = [0]; for (let i = 1; i <= M; i++) cum.push(cum[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
  const L = cum[M];
  const beta = new Float64Array(NS), rr = new Float64Array(NS);
  let i = 0;
  for (let j = 0; j < NS; j++) {
    const s = j / (NS - 1) * L;
    while (i < M - 1 && cum[i + 1] < s) i++;
    const f = (s - cum[i]) / Math.max(cum[i + 1] - cum[i], 1e-12);
    rr[j] = P[i][0] + (P[i + 1][0] - P[i][0]) * f;
    beta[j] = Math.atan2(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]);
  }
  return { L, beta, rho: rr };
}

function tubeGeometry(nS, nA) {
  const uv = [], pos = [], idx = [];
  for (let i = 0; i <= nS; i++) for (let j = 0; j <= nA; j++) { uv.push(i / nS, j / nA); pos.push(0, 0, 0); }
  const row = nA + 1;
  for (let i = 0; i < nS; i++) for (let j = 0; j < nA; j++) {
    const a = i * row + j, b = (i + 1) * row + j, c = i * row + j + 1, d = (i + 1) * row + j + 1;
    idx.push(a, c, b, c, d, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aUV', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

function ribbonGeometry(seg, name) {
  const a = [], pos = [], idx = [];
  for (let i = 0; i <= seg; i++) for (const s of [-1, 1]) { a.push(i / seg, s); pos.push(0, 0, 0); }
  for (let i = 0; i < seg; i++) { const o = i * 2; idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute(name, new THREE.Float32BufferAttribute(a, 2));
  g.setIndex(idx);
  return g;
}

function instanced(base, attrs, count) {
  const g = new THREE.InstancedBufferGeometry();
  if (base.index) g.setIndex(base.index);
  for (const k in base.attributes) g.setAttribute(k, base.attributes[k]);
  for (const [name, arr, size] of attrs) g.setAttribute(name, new THREE.InstancedBufferAttribute(arr, size));
  g.instanceCount = count;
  g.boundingSphere = new THREE.Sphere(V3(), 1e5);
  return g;
}

function stamenGeometry() {
  const pos = [], loc = [], part = [], idx = [];
  const NA = 6, NY = 5;
  for (let i = 0; i <= NY; i++) for (let j = 0; j <= NA; j++) {
    const a = j / NA * Math.PI * 2; loc.push(Math.cos(a), i / NY, Math.sin(a)); part.push(0); pos.push(0, 0, 0);
  }
  for (let i = 0; i < NY; i++) for (let j = 0; j < NA; j++) {
    const a = i * (NA + 1) + j, b = a + NA + 1;
    idx.push(a, b, a + 1, a + 1, b, b + 1);
  }
  const o = loc.length / 3;
  const SA = 10, SY = 7;
  for (let i = 0; i <= SY; i++) for (let j = 0; j <= SA; j++) {
    const th = i / SY * Math.PI, ph = j / SA * Math.PI * 2;
    loc.push(Math.sin(th) * Math.cos(ph), -Math.cos(th), Math.sin(th) * Math.sin(ph)); part.push(1); pos.push(0, 0, 0);
  }
  for (let i = 0; i < SY; i++) for (let j = 0; j < SA; j++) {
    const a = o + i * (SA + 1) + j, b = a + SA + 1;
    idx.push(a, b, a + 1, a + 1, b, b + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aLoc', new THREE.Float32BufferAttribute(loc, 3));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
  g.setIndex(idx);
  return g;
}

// ---------------------------------------------------------------- module
export async function create(ctx) {
  const { engine, data, rig, H } = ctx;
  const R = rng(91731);
  const base = rig.budBase.clone();
  const up = V3(0, 1, 0);
  // the macro camera's own frame (it looks roughly toward the dawn sun; read it from the rig)
  const c15 = rig.at(1.5);
  const cam15 = c15.pos.clone();
  const toSun = c15.target.clone().sub(c15.pos).setY(0).normalize();   // horizontal camera forward
  const toCam = toSun.clone().negate();
  const camRight = V3(-toSun.z, 0, toSun.x);
  const groundY = (x, z) => data.heightAt(x, z);

  // ---------------- shared uniforms
  const lightDir = camRight.clone().multiplyScalar(0.5).addScaledVector(up, 0.866).normalize();
  const tepalData = new Float32Array(NU * 24 * 4);
  const tepalTex = new THREE.DataTexture(tepalData, NU, 24, THREE.RGBAFormat, THREE.FloatType);
  tepalTex.minFilter = tepalTex.magFilter = THREE.NearestFilter; tepalTex.generateMipmaps = false; tepalTex.needsUpdate = true;
  const curveData = new Float32Array(CW * MAXC * 4);
  const curveTex = new THREE.DataTexture(curveData, CW, MAXC, THREE.RGBAFormat, THREE.FloatType);
  curveTex.minFilter = curveTex.magFilter = THREE.NearestFilter; curveTex.generateMipmaps = false; curveTex.needsUpdate = true;

  const HU = {
    tTepal: { value: tepalTex }, tCurves: { value: curveTex },
    uBudBase: { value: base.clone() },
    uFC: { value: V3() }, uFA: { value: V3(0, 1, 0) }, uFX: { value: V3(1, 0, 0) }, uFZ: { value: V3(0, 0, 1) },
    uLight: { value: new THREE.Vector4(lightDir.x, lightDir.y, lightDir.z, HERO.light.speed) },
    uLightK: { value: new THREE.Vector4(TIMES.firstLight + HERO.light.t0, HERO.light.melt, TIMES.hit, HERO.light.flare) },
    uOpen: { value: 0 }, uGlow: { value: 0 }, uDewGone: { value: 0 }, uSince: { value: -1 }, uPx: { value: 0.0003 },
    uHeroMisc: { value: new THREE.Vector4(0, -1, 0, 1) }, uFScale: { value: 1 },
    uHairLen: { value: HERO.hairLen }, uHairW: { value: HERO.hairW }, uRimeLen: { value: HERO.rimeLen }, uDewR: { value: HERO.dewR },
  };
  const OU = {
    tDepth: { value: engine.sceneRT.depthTexture }, uNF: { value: new THREE.Vector2(0.004, 60000) },
    uCoc: { value: new THREE.Vector4(40, 0.1, 35, H) }, uPtMax: { value: 256 },
    uFlash: { value: new THREE.Vector4() },
  };
  try {
    const gl = ctx.renderer.getContext();
    const pr = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
    if (pr && pr[1]) OU.uPtMax.value = Math.min(pr[1], 1024);
    if (ctx.q && ctx.q.get("heroHide")) console.log("hero: point size range", pr && pr[0], pr && pr[1]);
  } catch { /* keep default */ }

  const mk = (vs, fs, extra = {}, defines = {}) => worldMaterial({
    vertexShader: HERO_GLSL + vs, fragmentShader: HERO_GLSL + fs,
    uniforms: { ...HU, ...OU }, defines, ...extra,
  });

  // ---------------- flower kinematics (CPU)
  const prof = [closedProfile(0), closedProfile(1)];
  const PHI0 = 9 * DEG;
  const tv = Array.from({ length: 6 }, (_, k) => ({
    dphi: (R() - 0.5) * 5 * DEG, len: 1 + (R() - 0.5) * 0.04, wid: 1 + (R() - 0.5) * 0.06,
    dA: (R() - 0.5) * 8, delay: k * 0.004 + R() * 0.012, sw: 1 + (R() - 0.5) * 0.12, ph: R() * 6.28,
  }));
  const fs = {
    C: V3(), A: V3(), X: V3(), Z: V3(), o: new Float64Array(6), glow: 0, head: 0,
  };
  const lean = camRight.clone().multiplyScalar(0.04);
  function flowerState(t) {
    const T = TIMES;
    const dt = t - T.hit;
    const head = openCurve(dt * 0.92) + (dt > 0 ? 0.025 * Math.exp(-dt * 6) * Math.sin(dt * 24) : 0);
    fs.head = head;
    const tilt = lerp(HERO.tiltClosed, HERO.tiltOpen, head) * DEG;
    fs.A.copy(up).multiplyScalar(Math.cos(tilt)).addScaledVector(toCam, Math.sin(tilt)).addScaledVector(lean, 1 - clamp01(head)).normalize();
    fs.C.copy(base).addScaledVector(up, HERO.recH + HERO.recLift * head).addScaledVector(toCam, 0.003 * head).addScaledVector(camRight, 0.0008 - HERO.openShift * clamp01(head));
    fs.X.copy(toCam).addScaledVector(fs.A, -toCam.dot(fs.A)).normalize();
    fs.Z.crossVectors(fs.A, fs.X).normalize();
    const strain = HERO.strain * smoothstep(T.held, T.hit - 0.08, t);
    for (let k = 0; k < 6; k++) {
      const trem = t < T.hit ? 0.007 * Math.sin(t * 6.2831 * (9 + k * 0.7) + tv[k].ph) * smoothstep(T.held + 0.2, T.hit, t) : 0;
      const r = openCurve((dt - tv[k].delay) * tv[k].sw);
      fs.o[k] = strain + trem + (1 - strain) * r;
    }
    let glow = 0;
    if (t >= T.held && t < T.hit) glow = 0.85 * smoothstep(T.held, T.hit - 0.05, t) + 0.45 * Math.exp(-(((t - (T.held + 0.42)) / 0.07) ** 2));
    else if (t >= T.hit) glow = 0.3 + 0.55 * Math.exp(-(t - T.hit) / 0.3);
    fs.glow = glow;
    return fs;
  }

  // tepal frames -> texture (also returned for CPU sampling)
  const O = V3(), Bv = V3(), hinge = V3(), Pt = V3(), Tt = V3(), Nt = V3();
  function writeTepals(t, out = tepalData) {
    const st = flowerState(t);
    for (let k = 0; k < 6; k++) {
      const whorl = k % 2, pf = prof[whorl], v = tv[k];
      const o = st.o[k], oc = clamp01(o);
      const phi = k * 60 * DEG + PHI0 + v.dphi;
      O.copy(st.X).multiplyScalar(Math.cos(phi)).addScaledVector(st.Z, Math.sin(phi));
      Bv.crossVectors(st.A, O).normalize();
      hinge.copy(st.C).addScaledVector(O, HERO.rec);
      const Ls = pf.L * v.len * (1 - HERO.openShrink * smoothstep(0, 1, oc)), ds = Ls / (NS - 1);
      let x = 0, y = 0, prevB = 0;
      for (let i = 0; i < NS; i++) {
        const sn = i / (NS - 1);
        const bc = pf.beta[i];
        const bo = (HERO.openAlpha + (whorl ? -5 : 0) + v.dA) * DEG + HERO.openCurl * DEG * Math.pow(sn, 1.4);
        const b = bc + (bo - bc) * o;
        if (i > 0) { x += ds * 0.5 * (Math.sin(prevB) + Math.sin(b)); y += ds * 0.5 * (Math.cos(prevB) + Math.cos(b)); }
        prevB = b;
        if (i % 4) continue;
        const j = i / 4, row = k * 4;
        Pt.copy(hinge).addScaledVector(O, x).addScaledVector(st.A, y);
        Tt.copy(O).multiplyScalar(Math.sin(b)).addScaledVector(st.A, Math.cos(b));
        Nt.copy(O).multiplyScalar(Math.cos(b)).addScaledVector(st.A, -Math.sin(b));
        const rho = pf.rho[i] * v.len;
        // closed: half-width wraps the bud (wrap * rho); open: an elliptic, blunter, broader tepal
        const wOpen = HERO.budR * 0.78 * Math.pow(Math.sin(Math.PI * Math.pow(Math.max(sn, 1e-4), 0.85)), 0.62) * v.len + HERO.rec * 0.35 * (1 - sn);
        const w = lerp(HERO.wrap * rho, wOpen, smoothstep(0, 1, oc)) * v.wid * (whorl ? 0.93 : 1);
        const kap = (1 - oc) / Math.max(rho, 1e-5) + oc / (2.6 * w + 0.002);
        const rc = 1 / Math.max(kap, 1e-3);
        const set = (r, a, b2, c, d) => { const q = ((row + r) * NU + j) * 4; out[q] = a; out[q + 1] = b2; out[q + 2] = c; out[q + 3] = d; };
        set(0, Pt.x, Pt.y, Pt.z, w);
        set(1, Tt.x, Tt.y, Tt.z, rc);
        set(2, Nt.x, Nt.y, Nt.z, 0);
        set(3, Bv.x, Bv.y, Bv.z, 0);
      }
    }
    return out;
  }
  // CPU mirror of tepalSurf (for spray / glint seeding)
  function tepalSurfCPU(fr, k, u, v) {
    const x = clamp01(u) * (NU - 1), x0 = Math.min(Math.floor(x), NU - 2), f = x - x0;
    const g = (r, c) => { const a = ((k * 4 + r) * NU + x0) * 4 + c; return fr[a] * (1 - f) + fr[a + 4] * f; };
    const P = V3(g(0, 0), g(0, 1), g(0, 2)), w = g(0, 3), rc = Math.max(g(1, 3), 1e-5);
    const N = V3(g(2, 0), g(2, 1), g(2, 2)).normalize(), B = V3(g(3, 0), g(3, 1), g(3, 2)).normalize();
    const th = v * w / rc;
    const S = P.clone().addScaledVector(B, Math.sin(th) * rc).addScaledVector(N, -(1 - Math.cos(th)) * rc);
    const n = N.clone().multiplyScalar(Math.cos(th)).addScaledVector(B, Math.sin(th)).normalize();
    return { S, n };
  }

  // ---------------- curves: stem, involucre lobes, basal leaves, grass blades
  const curves = [];   // {id, kind, mat, len, hero, ...}
  const setCurve = (id, P0, P1, P2, P3, r0, r1, kind, twist, ref, taper, mat, fold, seed) => {
    const o = id * CW * 4;
    const put = (i, a, b, c, d) => { curveData[o + i * 4] = a; curveData[o + i * 4 + 1] = b; curveData[o + i * 4 + 2] = c; curveData[o + i * 4 + 3] = d; };
    put(0, P0.x, P0.y, P0.z, r0); put(1, P1.x, P1.y, P1.z, r1); put(2, P2.x, P2.y, P2.z, kind); put(3, P3.x, P3.y, P3.z, twist);
    put(4, ref.x, ref.y, ref.z, taper); put(5, mat, fold, seed, 0);
  };
  const bez = (P0, P1, P2, P3, s) => { const u = 1 - s; return V3().addScaledVector(P0, u * u * u).addScaledVector(P1, 3 * u * u * s).addScaledVector(P2, 3 * u * s * s).addScaledVector(P3, s * s * s); };
  const bezLen = (P0, P1, P2, P3) => { let l = 0, p = P0.clone(); for (let i = 1; i <= 16; i++) { const q = bez(P0, P1, P2, P3, i / 16); l += q.distanceTo(p); p = q; } return l; };

  // stem (id 0) + bract lobes (ids 1..27): dynamic
  const NB = 3, NL = 9;
  const bractVar = [];
  for (let b = 0; b < NB; b++) for (let l = 0; l < NL; l++) bractVar.push({
    phi: (b * 120 + 25 + (l - (NL - 1) / 2) * 9.5 + (R() - 0.5) * 6) * DEG, el: (24 + R() * 24 + Math.abs(l - 4) * 2.5) * DEG,
    len: 0.012 + R() * 0.010 - Math.abs(l - 4) * 0.0008, curl: 0.3 + R() * 0.35, seed: R(),
  });
  curves.push({ id: 0, kind: 0, mat: 1, len: 0.09 });
  bractVar.forEach((bv, i) => curves.push({ id: 1 + i, kind: 0, mat: 2, len: bv.len }));
  const sP0 = V3(), sP1 = V3(), sP2 = V3(), node = V3(), Ob = V3(), d0 = V3();
  function writeDynamicCurves() {
    const st = fs;
    sP0.copy(base).addScaledVector(up, -0.012);
    sP1.copy(base).addScaledVector(up, 0.03).addScaledVector(camRight, 0.0018).addScaledVector(toCam, 0.0008);
    sP2.copy(st.C).addScaledVector(st.A, -0.03);
    setCurve(0, sP0, sP1, sP2, st.C, 0.00165, 0.00135, 0, 0, toCam, 1, 1, 0, 0.3);
    node.copy(bez(sP0, sP1, sP2, st.C, 0.865));
    const spreadO = 0.72 * (1 + 0.18 * clamp01(st.head));   // the involucre ruff hugs the stem
    bractVar.forEach((bv, i) => {
      Ob.copy(st.X).multiplyScalar(Math.cos(bv.phi)).addScaledVector(st.Z, Math.sin(bv.phi));
      const el = bv.el * spreadO;
      d0.copy(st.A).multiplyScalar(Math.cos(el)).addScaledVector(Ob, Math.sin(el));
      const L = bv.len;
      const P0 = node.clone().addScaledVector(Ob, 0.0012);
      const P1 = P0.clone().addScaledVector(d0, L * 0.35);
      const P2 = P0.clone().addScaledVector(d0, L * 0.62).addScaledVector(st.A, L * 0.12 * bv.curl * 2);
      const P3 = P0.clone().addScaledVector(d0, L * 0.74).addScaledVector(st.A, L * 0.42 * bv.curl * 2);
      setCurve(1 + i, P0, P1, P2, P3, 0.00036, 0.00008, 0, 0, Ob, 1, 2, 0, bv.seed);
    });
  }

  // basal leaves (static): petiole + feathery lobes near the ground
  let cid = 1 + bractVar.length;
  for (const az of [205, 320, 75]) {
    const a = az * DEG, dir = V3(Math.cos(a), 0, Math.sin(a)), side = V3(-dir.z, 0, dir.x);
    const root = base.clone().addScaledVector(up, 0.004);
    const tipC = root.clone().addScaledVector(dir, 0.045); tipC.y = groundY(tipC.x, tipC.z) + 0.016;
    setCurve(cid, root, root.clone().addScaledVector(dir, 0.012).addScaledVector(up, 0.02), tipC.clone().addScaledVector(dir, -0.012), tipC, 0.0007, 0.0004, 0, 0, up, 1, 3, 0, R());
    curves.push({ id: cid++, kind: 0, mat: 3, len: 0.05 });
    for (let l = 0; l < 11; l++) {
      const fa = (l - 5) / 5, ld = dir.clone().multiplyScalar(Math.cos(fa * 1.1)).addScaledVector(side, Math.sin(fa * 1.1)).normalize();
      const L = 0.016 + R() * 0.012 - Math.abs(fa) * 0.006;
      const P0 = tipC.clone(); const P3 = P0.clone().addScaledVector(ld, L); P3.y = Math.max(P3.y + 0.004, groundY(P3.x, P3.z) + 0.012);
      setCurve(cid, P0, P0.clone().addScaledVector(ld, L * 0.35).addScaledVector(up, L * 0.25), P3.clone().addScaledVector(ld, -L * 0.25).addScaledVector(up, L * 0.1), P3, 0.00045, 0.0001, 0, 0, up, 1, 3, 0, R());
      curves.push({ id: cid++, kind: 0, mat: 3, len: L });
    }
  }
  const tubeIds = curves.map(c => c.id);

  // grass blades: hero foreground blades are placed in the macro camera's frame (t~1.5 s)
  const camPt = (f, x, h) => { const p = cam15.clone().addScaledVector(toSun, f).addScaledVector(camRight, x); p.y = groundY(p.x, p.z) + h; return p; };
  const HERO_BLADES = [
    // [f, x, h] x4 control points, half-width, twist, ref yaw (deg, around up from toCam), rime count
    [[0.084, -0.040, -0.004], [0.081, -0.036, 0.045], [0.077, -0.028, 0.088], [0.073, -0.0185, 0.107], 0.0017, 0.5, -20, 760],
    [[0.068, 0.046, -0.004], [0.070, 0.040, 0.050], [0.073, 0.027, 0.100], [0.078, 0.0135, 0.0965], 0.0014, -0.7, 25, 640],
    [[0.098, -0.056, -0.004], [0.096, -0.050, 0.050], [0.094, -0.041, 0.100], [0.092, -0.033, 0.132], 0.0012, 0.4, -40, 300],
    [[0.046, 0.026, -0.004], [0.047, 0.024, 0.050], [0.048, 0.019, 0.085], [0.050, 0.012, 0.097], 0.0015, 0.3, 15, 200],
    [[0.205, -0.030, -0.004], [0.203, -0.028, 0.050], [0.200, -0.025, 0.090], [0.198, -0.022, 0.118], 0.0014, 0.6, -10, 160],
    [[0.245, 0.040, -0.004], [0.242, 0.044, 0.050], [0.237, 0.050, 0.095], [0.232, 0.056, 0.128], 0.0016, -0.5, 30, 160],
    [[0.120, 0.075, -0.004], [0.118, 0.058, 0.045], [0.115, 0.034, 0.072], [0.112, 0.016, 0.077], 0.0011, 0.2, 50, 180],
  ];
  const blades = [];
  for (const [a, b, c, d, hw, tw, yaw, nr] of HERO_BLADES) {
    const P = [camPt(...a), camPt(...b), camPt(...c), camPt(...d)];
    const ref = toCam.clone().applyAxisAngle(up, yaw * DEG);
    setCurve(cid, P[0], P[1], P[2], P[3], hw, 0.0, 1, tw, ref, 4.0, 4, 0.22, R());
    blades.push({ id: cid, len: bezLen(...P), rime: nr, dew: 40, hero: true });
    curves.push({ id: cid++, kind: 1, mat: 4, len: bezLen(...P) });
  }
  // small winter grass tufts around the bud (seen during the pull-back)
  for (let tuft = 0; tuft < 9; tuft++) {
    let a, r;
    for (let tries = 0; tries < 20; tries++) {
      a = R() * Math.PI * 2; r = 0.09 + R() * 0.42;
      const dx = Math.cos(a), dz = Math.sin(a);
      const ang = Math.acos(dx * toCam.x + dz * toCam.z);
      if (!(ang < 50 * DEG && r < 0.45) && !(ang > 150 * DEG && r < 0.2)) break;
    }
    const c0 = base.clone().add(V3(Math.cos(a) * r, 0, Math.sin(a) * r));
    const nbl = 3 + Math.floor(R() * 4);
    for (let i = 0; i < nbl && cid < MAXC; i++) {
      const p0 = c0.clone().add(V3((R() - 0.5) * 0.02, 0, (R() - 0.5) * 0.02)); p0.y = groundY(p0.x, p0.z) - 0.004;
      const hgt = 0.035 + R() * 0.06, lean2 = V3(R() - 0.5, 0, R() - 0.5).normalize().multiplyScalar(hgt * (0.2 + R() * 0.5));
      const P1 = p0.clone().add(V3(0, hgt * 0.45, 0)).addScaledVector(lean2, 0.1);
      const P2 = p0.clone().add(V3(0, hgt * 0.85, 0)).addScaledVector(lean2, 0.5);
      const P3 = p0.clone().add(V3(0, hgt, 0)).addScaledVector(lean2, 1.0);
      const ref = V3(R() - 0.5, 0, R() - 0.5).normalize();
      setCurve(cid, p0, P1, P2, P3, 0.0011 + R() * 0.0008, 0, 1, (R() - 0.5) * 2, ref, 4.0, 4, 0.22, R());
      blades.push({ id: cid, len: bezLen(p0, P1, P2, P3), rime: 36, dew: 3, hero: false });
      curves.push({ id: cid++, kind: 1, mat: 4, len: hgt });
    }
  }
  const bladeIds = blades.map(b => b.id);

  // ---------------- instance roots
  const tepW = (whorl, u) => { const pf = prof[whorl]; const i = Math.round(u * (NS - 1)); return pf.rho[i] / HERO.budR; };
  function tepalRoots(n, vmax, out) {
    for (let k = 0; k < 6; k++) for (let i = 0; i < n;) {
      const u = 0.03 + R() * 0.955, v = (R() * 2 - 1) * vmax;
      if (R() > tepW(k % 2, u)) continue;
      out.push([k, u, v, 1]); i++;
    }
  }
  function curveRoots(list, perLen, out, opts = {}) {
    for (const c of list) {
      const n = Math.round((opts.count ? opts.count(c) : c.len * perLen));
      for (let i = 0; i < n; i++) {
        let s = opts.sdist ? opts.sdist(c) : 0.02 + R() * 0.97;
        if (c.kind === 1) {
          const edge = R() < (opts.edgeFrac ?? 0.7);
          const v = edge ? (R() < 0.5 ? -1 : 1) : (R() * 2 - 1) * 0.9;
          s = Math.pow(R(), 0.8) * 0.97 + 0.02;
          out.push([10 + c.id, s, v, R() < 0.5 ? -1 : 1]);
        } else out.push([10 + c.id, s, R(), 1]);
      }
    }
  }
  const flat = (rows, w = 4) => { const a = new Float32Array(rows.length * w); rows.forEach((r, i) => a.set(r, i * w)); return a; };
  const rnd4 = n => { const a = new Float32Array(n * 4); for (let i = 0; i < a.length; i++) a[i] = R(); return a; };

  const objects = [];
  const casters = [];

  // ---------------- tepal mesh
  {
    const NUm = 96, NVm = 32, aT = [], pos = [], idx = [];
    for (let k = 0; k < 6; k++) {
      const o = aT.length / 3;
      for (let i = 0; i <= NUm; i++) for (let j = 0; j <= NVm; j++) { aT.push(k, i / NUm, j / NVm * 2 - 1); pos.push(0, 0, 0); }
      const row = NVm + 1;
      for (let i = 0; i < NUm; i++) for (let j = 0; j < NVm; j++) {
        const a = o + i * row + j, b = o + (i + 1) * row + j, c = a + 1, d = b + 1;
        idx.push(a, c, b, c, d, b);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aT', new THREE.Float32BufferAttribute(aT, 3));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(V3(), 1e5);
    const { material, depthMaterial } = mk(TEPAL_VS, TEPAL_FS, { side: THREE.DoubleSide });
    const m = new THREE.Mesh(g, material); m.frustumCulled = false;
    castShadow(m, depthMaterial); objects.push(m); casters.push(m);
  }

  // ---------------- curve meshes
  {
    const g = instanced(tubeGeometry(40, 8), [['iCurve', new Float32Array(tubeIds), 1]], tubeIds.length);
    const { material, depthMaterial } = mk(CURVE_VS, TUBE_FS, { side: THREE.FrontSide });
    const m = new THREE.Mesh(g, material); m.frustumCulled = false;
    castShadow(m, depthMaterial); objects.push(m);
  }
  {
    const g = instanced(tubeGeometry(128, 6), [['iCurve', new Float32Array(bladeIds), 1]], bladeIds.length);
    const { material, depthMaterial } = mk(CURVE_VS, BLADE_FS, { side: THREE.DoubleSide });
    const m = new THREE.Mesh(g, material); m.frustumCulled = false;
    castShadow(m, depthMaterial); objects.push(m);
  }

  // ---------------- hairs
  const tubeCurves = curves.filter(c => c.kind === 0);
  {
    const roots = [];
    tepalRoots(HERO.nHairTepal, 0.97, roots);
    curveRoots(tubeCurves, 0, roots, {
      count: c => (c.mat === 1 ? 1150 : c.mat === 2 ? 80 : 6),
      sdist: c => (c.mat === 1 ? (R() < 0.6 ? 0.72 + R() * 0.28 : R()) : 0.03 + R() * 0.95),
    });
    const g = instanced(ribbonGeometry(4, 'aHair'), [['iRoot', flat(roots), 4], ['iRnd', rnd4(roots.length), 4]], roots.length);
    const { material } = mk(HAIR_VS, HAIR_FS, { side: THREE.DoubleSide });
    const m = new THREE.Mesh(g, material); m.frustumCulled = false; objects.push(m);
  }
  // ---------------- rime
  const rimeRootsAll = [];
  {
    const roots = [];
    tepalRoots(HERO.nRimeTepal, 0.97, roots);
    curveRoots(tubeCurves, 0, roots, {
      count: c => (c.mat === 1 ? 700 : c.mat === 2 ? 70 : 16),
      sdist: c => (c.mat === 1 ? (R() < 0.6 ? 0.72 + R() * 0.28 : R()) : 0.03 + R() * 0.95),
    });
    curveRoots(blades.map(b => ({ ...b, kind: 1 })), 0, roots, { count: c => c.rime, edgeFrac: 0.72 });
    rimeRootsAll.push(...roots);
    const g = instanced(ribbonGeometry(1, 'aCard'), [['iRoot', flat(roots), 4], ['iRnd', rnd4(roots.length), 4], ['iRnd2', rnd4(roots.length), 4]], roots.length);
    const { material } = mk(RIME_VS, RIME_FS, { side: THREE.DoubleSide, alphaToCoverage: false });
    const m = new THREE.Mesh(g, material); m.frustumCulled = false; objects.push(m);
  }
  // ---------------- dew
  {
    const roots = [];
    // tepals: a few clusters of 1-4 drops each (~45 on the bud), not an even scatter
    for (let k = 0; k < 6; k++) for (let c = 0; c < HERO.nDewClusters; c++) {
      const u0 = 0.25 + R() * 0.65, v0 = (R() * 2 - 1) * 0.7, m = 1 + Math.floor(R() * 4);
      for (let j = 0; j < m; j++) roots.push([k, clamp01(u0 + (R() - 0.5) * 0.07), Math.max(-0.9, Math.min(0.9, v0 + (R() - 0.5) * 0.2)), 1]);
    }
    curveRoots(tubeCurves, 0, roots, { count: c => (c.mat === 1 ? 14 : c.mat === 2 ? (R() < 0.3 ? 1 : 0) : 1) });
    curveRoots(blades.map(b => ({ ...b, kind: 1 })), 0, roots, { count: c => c.dew, edgeFrac: 0.5 });
    const rnd = rnd4(roots.length);
    // the hero drop at the bud tip (camera-facing outer tepal 0)
    roots.push([0, 0.935, 0.12, 1]);
    const rr = new Float32Array(rnd.length + 4); rr.set(rnd); rr.set([1, 0.3, 0.5, 2.0], rnd.length);
    const g = instanced(new THREE.IcosahedronGeometry(1, 3), [['iRoot', flat(roots), 4], ['iRnd', rr, 4]], roots.length);
    const { material } = mk(DEW_VS, DEW_FS, { side: THREE.FrontSide });
    const m = new THREE.Mesh(g, material); m.frustumCulled = false; objects.push(m);
  }
  // ---------------- stamens + pistils
  {
    const NSt = 230, NPi = 36, iA = new Float32Array((NSt + NPi) * 4), iB = rnd4(NSt + NPi);
    for (let i = 0; i < NSt; i++) {
      const rr = Math.sqrt((i + 0.5) / NSt) * 0.75 + 0.25;
      iA.set([i * 2.39996 + R() * 0.2, rr, R(), 0], i * 4);
    }
    for (let i = 0; i < NPi; i++) iA.set([i * 2.39996, Math.sqrt((i + 0.5) / NPi) * 0.3, R(), 1], (NSt + i) * 4);
    const g = instanced(stamenGeometry(), [['iA', iA, 4], ['iB', iB, 4]], NSt + NPi);
    const { material, depthMaterial } = mk(STAMEN_VS, STAMEN_FS, { side: THREE.FrontSide });
    const m = new THREE.Mesh(g, material); m.frustumCulled = false;
    castShadow(m, depthMaterial); objects.push(m);
  }
  // ---------------- macro snow crust disc
  {
    const NR = 120, NA = 240, pos = [], nrm = [], idx = [];
    pos.push(base.x, groundY(base.x, base.z), base.z); nrm.push(0, 1, 0);
    for (let i = 1; i <= NR; i++) {
      const r = HERO.turfR * Math.pow(i / NR, 1.6);
      for (let j = 0; j < NA; j++) {
        const a = j / NA * Math.PI * 2, x = base.x + Math.cos(a) * r, z = base.z + Math.sin(a) * r;
        pos.push(x, groundY(x, z), z);
        const e = 0.05, hx = groundY(x + e, z) - groundY(x - e, z), hz = groundY(x, z + e) - groundY(x, z - e);
        const nl = Math.hypot(hx, 2 * e, hz); nrm.push(-hx / nl, 2 * e / nl, -hz / nl);
      }
    }
    for (let j = 0; j < NA; j++) idx.push(0, 1 + ((j + 1) % NA), 1 + j);
    for (let i = 1; i < NR; i++) for (let j = 0; j < NA; j++) {
      const a = 1 + (i - 1) * NA + j, b = 1 + (i - 1) * NA + (j + 1) % NA, c = 1 + i * NA + j, d = 1 + i * NA + (j + 1) % NA;
      idx.push(a, b, c, b, d, c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(base.clone(), 2);
    const { material, depthMaterial } = mk(GROUND_VS, GROUND_FS, {});
    const m = new THREE.Mesh(g, material); m.frustumCulled = false;
    castShadow(m, depthMaterial); objects.push(m);
  }

  // ---------------- spring turf (short blades in the meadow's hero clearing; grow after the hit)
  {
    const n = HERO.turfN, iP = new Float32Array(n * 4), iT = new Float32Array(n * 4);
    const r0 = 0.12, r1 = HERO.turfR - 0.05;
    for (let i = 0; i < n; i++) {
      const r = Math.sqrt(r0 * r0 + R() * (r1 * r1 - r0 * r0)), a = R() * Math.PI * 2;
      const x = base.x + Math.cos(a) * r, z = base.z + Math.sin(a) * r;
      // toward the macro camera (it flies low over this side in the pull-back) the turf stays short
      const ang = Math.acos(Math.max(-1, Math.min(1, Math.cos(a) * toCam.x + Math.sin(a) * toCam.z)));
      const low = ang < 40 * DEG ? 0.55 : 1;
      const hgt = (0.045 + 0.1 * R()) * (0.6 + 0.6 * smoothstep(0.2, 1.2, r)) * low;
      iP.set([x, groundY(x, z), z, r], i * 4);
      iT.set([hgt, R() * Math.PI * 2, R(), 0.0035 + R() * 0.003], i * 4);
    }
    const g = instanced(ribbonGeometry(4, 'aBl'), [['iP', iP, 4], ['iT', iT, 4]], n);
    const { material } = mk(TURF_VS, TURF_FS, { side: THREE.DoubleSide });
    const m = new THREE.Mesh(g, material); m.frustumCulled = false; objects.push(m);
  }

  // ---------------- overlay particles
  const overlayObjs = [];
  const OVER_BLEND = { blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor, depthTest: false, depthWrite: false, transparent: true };
  const mkPoints = (kind, A, B, C) => {
    const n = A.length / 4;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('aA', new THREE.Float32BufferAttribute(A, 4));
    g.setAttribute('aB', new THREE.Float32BufferAttribute(B, 4));
    g.setAttribute('aC', new THREE.Float32BufferAttribute(C || new Float32Array(n * 4), 4));
    g.boundingSphere = new THREE.Sphere(V3(), 1e5);
    const { material } = mk(POINT_VS, POINT_FS, OVER_BLEND, { KIND: kind });
    const p = new THREE.Points(g, material); p.frustumCulled = false; p.renderOrder = 10; p.name = 'hero_ov' + kind;
    overlayObjs.push(p); return p;
  };
  // 0: rime glints (subset of rime roots on the bud, stem, involucre and blades)
  {
    // prefer crystals near the bud's silhouette as the macro camera sees it at first light (they are backlit)
    const pick = [];
    const fr4 = writeTepals(TIMES.firstLight + 1.0, new Float32Array(tepalData.length));
    const camL = rig.at(TIMES.firstLight + 1.0).pos.clone();
    const rimRime = [], frontRime = [];
    for (const r of rimeRootsAll) {
      if (r[0] >= 8) continue;
      const { S, n } = tepalSurfCPU(fr4, r[0], r[1], r[2]);
      const nv = n.dot(camL.clone().sub(S).normalize());
      if (nv > -0.12 && nv < 0.38) rimRime.push(r); else if (nv >= 0.38) frontRime.push(r);
    }
    const otherRime = rimeRootsAll.filter(r => r[0] >= 8);
    for (let i = 0; i < HERO.glintN; i++) {
      const x = R(), src = x < 0.45 ? rimRime : x < 0.75 ? frontRime : otherRime;
      if (src.length) pick.push(src[Math.floor(R() * src.length)]);
    }
    const B = rnd4(pick.length);
    for (let i = 0; i < pick.length; i++) B[i * 4 + 2] = 0.3 + 0.7 * Math.pow(R(), 2);
    mkPoints(0, flat(pick), B);
  }
  // 1: dew spray: flung off the tepals at the overshoot peak (where they stop dead), with the
  //    velocity they carried through the middle of the opening
  const tPeak = TIMES.hit + HERO.open.rise;
  {
    const fP = writeTepals(tPeak + 0.01, new Float32Array(tepalData.length));
    const f0 = writeTepals(TIMES.hit + HERO.open.rise * 0.4, new Float32Array(tepalData.length));
    const f1 = writeTepals(TIMES.hit + HERO.open.rise * 0.5, new Float32Array(tepalData.length));
    const dtV = HERO.open.rise * 0.1;
    const A = new Float32Array(HERO.sprayN * 4), Bb = new Float32Array(HERO.sprayN * 4), Cc = rnd4(HERO.sprayN);
    for (let i = 0; i < HERO.sprayN; i++) {
      const k = Math.floor(R() * 6), u = 0.35 + R() * 0.62, v = (R() * 2 - 1) * 0.8;
      const a = tepalSurfCPU(f0, k, u, v), b = tepalSurfCPU(f1, k, u, v), p = tepalSurfCPU(fP, k, u, v);
      const vel = b.S.clone().sub(a.S).multiplyScalar(1 / dtV * (0.6 + R() * 1.0)).addScaledVector(p.n, 0.12 + R() * 0.35).add(V3((R() - 0.5) * 0.2, 0.12 + R() * 0.25, (R() - 0.5) * 0.2));
      A.set([p.S.x, p.S.y, p.S.z, R()], i * 4);
      Bb.set([vel.x, vel.y, vel.z, tPeak - 0.015 + R() * 0.05], i * 4);
      Cc[i * 4] = 0.5 + 2.0 * Math.pow(R(), 3);
    }
    mkPoints(1, A, Bb, Cc);
  }
  // 2: pollen motes
  {
    const n = HERO.pollenN, A = new Float32Array(n * 4), Bb = new Float32Array(n * 4), Cc = rnd4(n);
    writeTepals(TIMES.hit + 0.6);
    const Aax = fs.A.clone();
    for (let i = 0; i < n; i++) {
      const d = V3(R() * 2 - 1, R() * 2 - 1, R() * 2 - 1); if (d.lengthSq() > 1 || d.lengthSq() < 1e-4) { i--; continue; }
      d.normalize();
      const sp = 0.12 + Math.pow(R(), 1.6) * 0.75;
      const vel = d.clone().addScaledVector(Aax, 0.55).normalize().multiplyScalar(sp);
      A.set([d.x, d.y, d.z, R()], i * 4);
      Bb.set([vel.x, vel.y, vel.z, TIMES.hit + 0.1 + R() * 0.15], i * 4);   // the crown bursts as the cup opens
      Cc[i * 4] = 0.35 + 1.2 * Math.pow(R(), 2.5);
    }
    mkPoints(2, A, Bb, Cc);
  }
  // 3: snow glitter bokeh on the snowfield behind the bud
  {
    const n = HERO.glitterN, A = new Float32Array(n * 4), Bb = rnd4(n);
    for (let i = 0; i < n; i++) {
      const d = 0.9 * Math.pow(9, R()), a = (R() - 0.5) * 42 * DEG;
      const dir = toSun.clone().applyAxisAngle(up, a);
      const p = cam15.clone().addScaledVector(dir, d); p.y = groundY(p.x, p.z) + 0.004;
      A.set([p.x, p.y, p.z, 1], i * 4);
      Bb[i * 4 + 2] = 0.15 + 2.2 * Math.pow(R(), 4);
    }
    mkPoints(3, A, Bb);
  }
  // 4: pull-back spark (violet halo + gold heart)
  mkPoints(4, new Float32Array(8), new Float32Array([1.0, 0, 26.0, 0, 1.2, 1, 3.4, 0]));
  // 5: late wink
  const late = HERO.lateGlint ? mkPoints(5, new Float32Array(8), new Float32Array([1, 0.2, 2.0, 0, 1, 0.9, 1.0, 0])) : null;
  // flash + shock ring billboard
  const flashMat = mk(FLASH_VS, FLASH_FS, OVER_BLEND).material;
  const flash = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), flashMat); flash.frustumCulled = false; flash.renderOrder = 9; flash.name = 'hero_flash';
  overlayObjs.push(flash);

  // ---------------- per-subframe update
  ['tepal', 'tube', 'blade', 'hair', 'rime', 'dew', 'stamen', 'ground', 'turf'].forEach((nm, i) => { objects[i].name = 'hero_' + nm; });
  const hide = new Set((ctx.q && ctx.q.get('heroHide') || '').split(',').filter(Boolean));
  writeTepals(0); writeDynamicCurves(); tepalTex.needsUpdate = true; curveTex.needsUpdate = true;
  function update(t, c) {
    const inMacro = c.shot.id === 'macro';
    for (const o of objects) o.visible = inMacro && !hide.has(o.name.slice(5));
    for (const o of overlayObjs) o.visible = inMacro && !hide.has(o.name.slice(5));
    if (late) late.visible = t > TIMES.glint - 1 && t < TIMES.glint + 1;
    if (!inMacro && !(late && late.visible)) return;
    writeTepals(t);
    writeDynamicCurves();
    tepalTex.needsUpdate = true; curveTex.needsUpdate = true;
    HU.uFC.value.copy(fs.C); HU.uFA.value.copy(fs.A); HU.uFX.value.copy(fs.X); HU.uFZ.value.copy(fs.Z);
    let om = 0; for (let k = 0; k < 6; k++) om += fs.o[k]; HU.uOpen.value = om / 6;
    HU.uGlow.value = fs.glow;
    HU.uFScale.value = 1 + 1.0 * smoothstep(TIMES.pullStart + 0.15, TIMES.cut2 - 0.05, t);
    HU.uDewGone.value = smoothstep(tPeak - 0.02, tPeak + 0.03, t);   // the drops leave as spray at the peak
    HU.uSince.value = t - TIMES.hit;
    const since = t - TIMES.hit;
    HU.uHeroMisc.value.set(
      smoothstep(TIMES.firstLight + 1.0, TIMES.held, t),                 // wetness
      since > 0 ? since * 1.3 : -1,                                       // pulse radius
      since > 0 ? Math.exp(-since * 2.2) * (1 - Math.exp(-since * 30)) : 0, // pulse strength
      1.25);
    const cam = c.cam;
    HU.uPx.value = 2 * Math.tan(cam.fov * DEG / 2) / H;
    OU.uNF.value.set(cam.near, cam.far);
    const maxCoc = 70;
    OU.uCoc.value.set(cam.cocK * H / 2160, cam.focus, maxCoc * H / 2160, H);
    // flash: hot core at the hit + an expanding ring of gold light
    if (since > -0.02 && since < 0.9) {
      const s = Math.max(since, 0);
      OU.uFlash.value.set(0.011 + s * 0.012, 0.004 + 0.9 * (1 - Math.exp(-s * 3.2)) * 0.45, 1.0 * Math.exp(-s / 0.14) * smoothstep(-0.02, 0.02, since), 1.2 * Math.exp(-s / 0.22) * smoothstep(0.0, 0.03, s));
      flash.visible = inMacro && !hide.has('flash');
    } else flash.visible = false;
  }

  return { objects, overlay: overlayObjs, update, _dbg: { writeTepals, tepalSurfCPU, fs, size: tepalData.length } };
}
