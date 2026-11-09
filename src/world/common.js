// World framework shared by every module: global uniforms, the WORLD GLSL
// prelude (sky, fog, lighting, wind, bloom-wave field, shadows), a material
// factory that also builds the matching depth-only material, and a 2-cascade
// sun shadow system that works with any custom vertex shader.
import * as THREE from 'three';
import { NOISE } from '../glsl/noise.js';

export const U = {
  uTime: { value: 0 },
  uFrame: { value: 0 },           // subframe counter (for per-subframe jitter)
  uSunDir: { value: new THREE.Vector3(0.3, 0.4, -0.8).normalize() },
  uSunColor: { value: new THREE.Color(1.0, 0.9, 0.75).multiplyScalar(3.0) },
  uSkyZenith: { value: new THREE.Color(0.10, 0.32, 0.85) },
  uSkyHorizon: { value: new THREE.Color(0.62, 0.78, 0.95) },
  uSkyAmbient: { value: new THREE.Color(0.35, 0.5, 0.75) },
  uGroundBounce: { value: new THREE.Color(0.18, 0.22, 0.10) },
  uFogDensity: { value: 0.00012 },
  uFogFalloff: { value: 0.0018 },
  uFogBase: { value: -8.0 },
  uFogTint: { value: new THREE.Color(1, 1, 1) },
  uFogStart: { value: 0.0 },
  uHaze: { value: 0.0 },
  // final-round gates (film.js applyEnv): 0 everywhere except where the fix applies
  uCreekFix: { value: 0.0 },      // fpv creek ride ~9.35-12.19 s (ramps in/out)
  uFarK: { value: 0.0 },          // 1 in the far shots: reveal, falls, aerial
  uWind: { value: new THREE.Vector4(0.8, -0.6, 1.0, 1.0) }, // dir.xy, strength, gust speed
  // bloom wave: arrival field (distance-like units) + current wavefront distance
  tArrival: { value: null },
  uArrivalBounds: { value: new THREE.Vector4(-4096, -8192, 8192, 12288) }, // minX, minZ, sizeX, sizeZ
  tArrivalNear: { value: null },
  uArrivalNearBounds: { value: new THREE.Vector4(-128, -128, 512, 512) },
  tInfo: { value: null }, tInfo2: { value: null },
  uInfoBounds: { value: new THREE.Vector4(-4096, -4096, 8192, 8192) },
  uBloomD: { value: -1.0 },
  uBloomWidth: { value: 3.0 },
  uBloomNoise: { value: 2.0 },
  // clouds (filled by sky module)
  tCloudCov: { value: null },
  uCloudShadow: { value: new THREE.Vector4(0.00025, 0.0, 0.0, 0.0) }, // scale, offX, offZ, strength
  uCloudAlt: { value: 1800.0 },
  // shadows
  tShadow0: { value: null }, tShadow1: { value: null },
  uShadowMat0: { value: new THREE.Matrix4() }, uShadowMat1: { value: new THREE.Matrix4() },
  uShadowTexel: { value: new THREE.Vector4(1 / 4096, 1 / 4096, 1.5, 1.0) }, // texel0, texel1, softness0, softness1
  uShadowOn: { value: 1.0 },
  uExposureHint: { value: 1.0 },
};

export const WORLD_GLSL = /* glsl */`
${NOISE}
uniform float uTime; uniform float uFrame;
uniform vec3 uSunDir; uniform vec3 uSunColor;
uniform vec3 uSkyZenith; uniform vec3 uSkyHorizon; uniform vec3 uSkyAmbient; uniform vec3 uGroundBounce;
uniform float uFogDensity; uniform float uFogFalloff; uniform float uFogBase; uniform vec3 uFogTint; uniform float uFogStart; uniform float uHaze;
uniform float uCreekFix; uniform float uFarK;
uniform vec4 uWind;
uniform sampler2D tArrival; uniform vec4 uArrivalBounds; uniform sampler2D tArrivalNear; uniform vec4 uArrivalNearBounds;
uniform sampler2D tInfo; uniform sampler2D tInfo2; uniform vec4 uInfoBounds; uniform float uBloomD; uniform float uBloomWidth; uniform float uBloomNoise;
uniform sampler2D tCloudCov; uniform vec4 uCloudShadow; uniform float uCloudAlt;
uniform sampler2D tShadow0; uniform sampler2D tShadow1; uniform mat4 uShadowMat0; uniform mat4 uShadowMat1; uniform vec4 uShadowTexel; uniform float uShadowOn;

// ---------------- bloom wave
float arrival0(vec2 xz) {
  float fa = texture2D(tArrival, (xz - uArrivalBounds.xy) / uArrivalBounds.zw).r;
  vec2 nu = (xz - uArrivalNearBounds.xy) / uArrivalNearBounds.zw;
  float e = min(min(nu.x - 0.02, 0.98 - nu.x), min(nu.y - 0.02, 0.98 - nu.y));
  if (e > 0.0) fa = mix(fa, texture2D(tArrivalNear, nu).r, min(1.0, e / 0.08));
  return fa;
}
float arrival(vec2 xz) {
  float fa = arrival0(xz);
  // a few baked cells are unreachable (inf) and would stay white winter forever;
  // in the far shots take the lowest finite neighbour 16 m away instead
  if (uFarK > 0.5 && !(fa < 1e6)) {
    float m = 1e6;
    m = min(m, arrival0(xz + vec2(16.0, 0.0))); m = min(m, arrival0(xz - vec2(16.0, 0.0)));
    m = min(m, arrival0(xz + vec2(0.0, 16.0))); m = min(m, arrival0(xz - vec2(0.0, 16.0)));
    fa = m;
  }
  return fa;
}
// baked terrain info: x riverDist, y creekDist, z lakeDist(signed), w forest
vec4 infoAt(vec2 xz) { return texture2D(tInfo, (xz - uInfoBounds.xy) / uInfoBounds.zw); }
// x petalSD (<0 inside petal), y radius, z lobe delta (rad), w variety noise
vec4 info2At(vec2 xz) { return texture2D(tInfo2, (xz - uInfoBounds.xy) / uInfoBounds.zw); }
// 0 = frozen winter, 1 = full spring. Ragged, organic front.
float bloomAmt(vec2 xz) {
  float a = arrival(xz) + (fbm(xz * 0.11) - 0.5) * uBloomNoise * 2.0 + (vnoise(xz * 0.9) - 0.5) * 0.6;
  return smoothstep(0.0, uBloomWidth, uBloomD - a);
}
// localized band right at the wavefront (for glow / sparkles / growth overshoot)
float bloomFront(vec2 xz) {
  float a = arrival(xz) + (fbm(xz * 0.11) - 0.5) * uBloomNoise * 2.0 + (vnoise(xz * 0.9) - 0.5) * 0.6;
  float d = (uBloomD - a) / max(uBloomWidth, 1e-3);
  return exp(-d * d * 2.0) * step(-1.5, d);
}

// ---------------- sky + aerial perspective
vec3 skyGradient(vec3 d) {
  float h = d.y;
  vec3 c = mix(uSkyHorizon, uSkyZenith, pow(clamp(h, 0.0, 1.0), 0.55));
  c = mix(c, uSkyHorizon * 0.85, smoothstep(0.0, -0.15, h));
  float sd = max(dot(d, uSunDir), 0.0);
  c += uSunColor * (0.06 * pow(sd, 6.0) + 0.22 * pow(sd, 48.0));
  return c;
}
vec3 applyFog(vec3 col, vec3 wp) {
  vec3 v = wp - cameraPosition; float dist0 = length(v); vec3 rd = v / max(dist0, 1e-4);
  float dist = max(dist0 - uFogStart, 0.0);           // clear foreground, fog only beyond uFogStart
  float b = uFogFalloff;
  float ry = (abs(rd.y) < 1e-4) ? 1e-4 : rd.y;
  float h0 = cameraPosition.y - uFogBase;
  float amt = (uFogDensity / b) * exp(-h0 * b) * (1.0 - exp(-dist * ry * b)) / ry;
  // plus a height-independent aerial-perspective haze so far ranges recede even from high up
  amt = 1.0 - exp(-max(amt, 0.0) - dist * uHaze);
  vec3 fd = normalize(vec3(rd.x, max(rd.y, 0.03), rd.z));
  vec3 fogc = skyGradient(fd) * uFogTint;
  fogc += uSunColor * 0.18 * pow(max(dot(rd, uSunDir), 0.0), 5.0);
  return mix(col, fogc, amt);
}

// ---------------- wind: travelling gust waves across the land
vec2 windAt(vec2 xz, float t) {
  vec2 dir = normalize(uWind.xy);
  float ph = dot(xz, dir) * 0.08 - t * uWind.w * 1.6;
  float gust = 0.55 + 0.45 * sin(ph) * (0.6 + 0.4 * sin(ph * 0.37 + xz.x * 0.013));
  float flutter = vnoise(xz * 0.7 + t * 2.3) - 0.5;
  return dir * uWind.z * (gust + flutter * 0.35) + vec2(-dir.y, dir.x) * flutter * 0.25 * uWind.z;
}

// ---------------- clouds shadow
float cloudShadow(vec3 wp) {
  if (uCloudShadow.w <= 0.0) return 1.0;
  vec2 p = wp.xz + uSunDir.xz / max(uSunDir.y, 0.08) * (uCloudAlt - wp.y);
  float c = texture2D(tCloudCov, p * uCloudShadow.x + uCloudShadow.yz).r;
  return 1.0 - uCloudShadow.w * smoothstep(0.35, 0.75, c);
}

#ifndef IS_VERTEX
// ---------------- sun shadows (2 cascades, rotated Poisson PCF; rotation
// changes per subframe so accumulation yields smooth penumbrae)
const vec2 POISSON[8] = vec2[8](vec2(-0.613, 0.617), vec2(0.170, -0.040), vec2(-0.299, -0.792), vec2(0.645, 0.493), vec2(-0.651, -0.172), vec2(0.421, -0.581), vec2(-0.044, 0.938), vec2(0.931, -0.058));
float shadowTap(sampler2D tex, vec3 sc, vec2 texel, float soft) {
  float ang = hash12(gl_FragCoord.xy + uFrame * 17.0) * 6.2831;
  mat2 rot = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
  float s = 0.0;
  for (int i = 0; i < 8; i++) {
    vec2 o = rot * POISSON[i] * texel * soft;
    s += step(sc.z, texture2D(tex, sc.xy + o).r);
  }
  return s / 8.0;
}
float sunShadow(vec3 wp, float bias) {
  if (uShadowOn < 0.5) return 1.0;
  vec4 c0 = uShadowMat0 * vec4(wp, 1.0);
  vec3 s0 = c0.xyz * 0.5 + 0.5;
  if (all(greaterThan(s0.xy, vec2(0.02))) && all(lessThan(s0.xy, vec2(0.98))) && s0.z < 1.0) {
    s0.z -= bias * uShadowTexel.x * 2.0;
    return shadowTap(tShadow0, s0, vec2(uShadowTexel.x), uShadowTexel.z);
  }
  vec4 c1 = uShadowMat1 * vec4(wp, 1.0);
  vec3 s1 = c1.xyz * 0.5 + 0.5;
  if (all(greaterThan(s1.xy, vec2(0.0))) && all(lessThan(s1.xy, vec2(1.0))) && s1.z < 1.0) {
    s1.z -= bias * uShadowTexel.y * 2.0;
    return shadowTap(tShadow1, s1, vec2(uShadowTexel.y), uShadowTexel.w);
  }
  return 1.0;
}
#endif

// ---------------- stylised lighting
// wrap: 0 = lambert, 0.5 = soft wrap. trans = back-light translucency (0..1)
vec3 shadeSurface(vec3 albedo, vec3 N, vec3 wp, float wrap, float ao, float trans, float shadow) {
  vec3 V = normalize(cameraPosition - wp);
  float ndl = dot(N, uSunDir);
  float diff = clamp((ndl + wrap) / (1.0 + wrap), 0.0, 1.0);
  diff = smoothstep(0.0, 1.0, diff);              // painterly: crisper terminator
  vec3 hemi = mix(uGroundBounce, uSkyAmbient, N.y * 0.5 + 0.5);
  float back = pow(clamp(dot(-V, uSunDir), 0.0, 1.0), 3.0) * trans;
  float cs = cloudShadow(wp);
  vec3 sun = uSunColor * shadow * cs;
  return albedo * (sun * (diff + back * 1.6) + hemi * ao);
}
`;

const VERT_PRE = '#define IS_VERTEX 1\n';
const DEPTH_FRAG = /* glsl */`void main() { gl_FragColor = vec4(1.0); }`;

// Build a world material. The vertex shader must set gl_Position from a world
// position using projectionMatrix * viewMatrix (so the same source works for the
// sun's shadow camera). The fragment shader may use '#ifdef DEPTH_PASS' to do
// only alpha-testing; if depthFragment is omitted a trivial one is used.
export function worldMaterial({ vertexShader, fragmentShader, depthFragment, uniforms = {}, defines = {}, alphaTestInDepth = false, ...rest }) {
  const allUniforms = { ...U, ...uniforms };
  const material = new THREE.ShaderMaterial({
    uniforms: allUniforms, defines,
    vertexShader: VERT_PRE + WORLD_GLSL + vertexShader,
    fragmentShader: WORLD_GLSL + fragmentShader,
    ...rest,
  });
  const depthMaterial = new THREE.ShaderMaterial({
    uniforms: allUniforms, defines: { ...defines, DEPTH_PASS: 1 },
    vertexShader: VERT_PRE + WORLD_GLSL + vertexShader,
    fragmentShader: depthFragment ? WORLD_GLSL + depthFragment : (alphaTestInDepth ? WORLD_GLSL + fragmentShader : DEPTH_FRAG),
    side: rest.side ?? THREE.FrontSide,
  });
  return { material, depthMaterial };
}

// Register a mesh as a shadow caster with its depth material.
export function castShadow(mesh, depthMaterial) {
  mesh.userData.depthMaterial = depthMaterial;
  mesh.userData.castShadow = true;
  return mesh;
}

export class ShadowSystem {
  constructor(renderer, size0 = 4096, size1 = 4096) {
    this.renderer = renderer;
    const mk = s => new THREE.WebGLRenderTarget(s, s, {
      type: THREE.UnsignedByteType, depthBuffer: true,
      depthTexture: new THREE.DepthTexture(s, s, THREE.FloatType),
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    });
    this.rt0 = mk(size0); this.rt1 = mk(size1);
    this.cam0 = new THREE.OrthographicCamera(); this.cam1 = new THREE.OrthographicCamera();
    U.tShadow0.value = this.rt0.depthTexture; U.tShadow1.value = this.rt1.depthTexture;
    U.uShadowTexel.value.x = 1 / size0; U.uShadowTexel.value.y = 1 / size1;
    this.bias = new THREE.Matrix4().set(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
  }

  // center: world-space focus; radius: half-extent of the cascade; depth: range along sun
  fit(cam, center, radius, depth) {
    const d = U.uSunDir.value;
    cam.left = -radius; cam.right = radius; cam.top = radius; cam.bottom = -radius;
    cam.near = 0; cam.far = depth * 2;
    // snap to texels to avoid shimmer between frames
    cam.position.copy(center).addScaledVector(d, depth);
    cam.up.set(0, 1, 0);
    if (Math.abs(d.y) > 0.99) cam.up.set(0, 0, 1);
    cam.lookAt(center);
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();
  }

  render(scene, c0, c1) {
    const r = this.renderer;
    this.fit(this.cam0, c0.center, c0.radius, c0.depth);
    this.fit(this.cam1, c1.center, c1.radius, c1.depth);
    U.uShadowTexel.value.z = c0.soft ?? 1.5; U.uShadowTexel.value.w = c1.soft ?? 1.0;
    const swaps = [];
    scene.traverse(o => {
      if (!o.isMesh && !o.isPoints) return;
      if (o.userData.castShadow && o.userData.depthMaterial) { swaps.push([o, o.material, o.visible]); o.material = o.userData.depthMaterial; }
      else if (o.visible) { swaps.push([o, o.material, true]); o.visible = false; }
    });
    const prevClear = r.getClearColor(new THREE.Color()), prevAlpha = r.getClearAlpha();
    r.setClearColor(0xffffff, 1);
    for (const [rt, cam, mat] of [[this.rt0, this.cam0, U.uShadowMat0], [this.rt1, this.cam1, U.uShadowMat1]]) {
      r.setRenderTarget(rt); r.clear(); r.render(scene, cam);
      mat.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    }
    for (const [o, m, v] of swaps) { o.material = m; o.visible = v; }
    r.setClearColor(prevClear, prevAlpha);
  }
}

// Seeded PRNG (mulberry32) for deterministic placement.
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp01 = x => Math.min(1, Math.max(0, x));
