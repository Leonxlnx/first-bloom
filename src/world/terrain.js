// Terrain: warped 2048^2 grid rebuilt in the vertex shader from the baked
// height texture; stylised winter -> spring shading with the giant-flower
// colour washes (petals violet/cobalt, daisy outline, gold heart, poppy meadow).
import * as THREE from 'three';
import * as L from './layout.js';
import { worldMaterial, castShadow, U } from './common.js';

export const PALETTE_GLSL = /* glsl */`
vec3 s2l(vec3 c) { return pow(c, vec3(2.2)); }
#define C_EMERALD s2l(vec3(0.184, 0.639, 0.353))
#define C_CHARTREUSE s2l(vec3(0.659, 0.863, 0.290))
#define C_VIRIDIAN s2l(vec3(0.122, 0.420, 0.271))
#define C_VIOLET s2l(vec3(0.482, 0.310, 0.839))
#define C_COBALT s2l(vec3(0.173, 0.357, 0.847))
#define C_POPPY s2l(vec3(0.949, 0.333, 0.173))
#define C_GOLD s2l(vec3(1.0, 0.824, 0.227))
#define C_DAISY s2l(vec3(0.969, 0.961, 0.933))
#define C_SNOW s2l(vec3(0.91, 0.945, 1.0))
#define C_SNOW_SH s2l(vec3(0.663, 0.706, 0.878))
#define C_ROCK s2l(vec3(0.50, 0.47, 0.46))
#define C_ROCK_DARK s2l(vec3(0.27, 0.25, 0.29))
#define C_SOIL s2l(vec3(0.36, 0.29, 0.22))
`;

const VERT = /* glsl */`
uniform sampler2D tHeight; uniform vec4 uGrid; uniform vec3 uGridK;
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
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

const FRAG = /* glsl */`
${PALETTE_GLSL}
uniform float uSnowline; uniform float uHeartR; uniform vec4 uHole;
varying vec3 vWorld; varying vec3 vNormal;

// stylised speckle field, three scales: fine flower dots near the camera,
// painterly drifts/clumps (5-15 m) at mid range, flat average far away
vec3 speckle(vec3 base, vec3 col, float coverage, vec2 xz, float freq, float dist, float seed) {
  float n = vnoise(xz * freq + seed) * 0.65 + vnoise(xz * freq * 2.7 + seed * 1.7) * 0.35;
  float near = smoothstep(coverage + 0.08, coverage - 0.08, 1.0 - n);
  float nm = vnoise(xz * 0.09 + seed * 3.1) * 0.6 + vnoise(xz * 0.23 + seed) * 0.4;
  float mid = smoothstep(coverage + 0.14, coverage - 0.14, 1.0 - nm);
  float m = mix(near, mid, smoothstep(25.0, 110.0, dist));
  m = mix(m, coverage, smoothstep(700.0, 2200.0, dist));
  return mix(base, col, m);
}

void main() {
  vec3 wp = vWorld; vec2 xz = wp.xz;
#ifndef IS_PATCH
  if (xz.x > uHole.x && xz.x < uHole.z && xz.y > uHole.y && xz.y < uHole.w) discard;
#endif
  vec3 N = normalize(vNormal);
  float dist = length(wp - cameraPosition);
  // fine detail normal (fades with distance)
  float dn = 1.0 - smoothstep(20.0, 300.0, dist);
  vec2 g = vec2(vnoise(xz * 1.7) - vnoise(xz * 1.7 + vec2(0.37, 0.0)), vnoise(xz * 1.7) - vnoise(xz * 1.7 + vec2(0.0, 0.37)));
  N = normalize(N + vec3(g.x, 0.0, g.y) * 0.35 * dn);
  float slope = 1.0 - N.y;
  vec4 inf = infoAt(xz); vec4 inf2 = info2At(xz);
  float r = inf2.y;
  float n1 = fbm(xz * 0.013), n2 = fbm(xz * 0.07 + 9.0), n3 = vnoise(xz * 0.9);

  // -------- snowline that never thaws (peaks)
  float snowNoise = (fbm(xz * 0.004) - 0.5) * 260.0;
  float peakSnow = smoothstep(uSnowline - 60.0, uSnowline + 60.0, wp.y + snowNoise) * smoothstep(0.75, 0.45, slope);
  float bloom = bloomAmt(xz) * (1.0 - peakSnow);
  float front = bloomFront(xz) * (1.0 - peakSnow);

  // -------- spring albedo: warm meadow with large painterly value variation
  float vBig = fbm(xz * 0.006 + 2.0), vMid = fbm(xz * 0.028 + 5.0);
  vec3 meadowShade = s2l(vec3(0.235, 0.431, 0.200)), meadowLit = s2l(vec3(0.490, 0.690, 0.263));
  vec3 grass = mix(meadowShade, meadowLit, clamp(0.2 + 0.8 * (vBig * 0.6 + vMid * 0.4), 0.0, 1.0)) * 0.8;
  grass = mix(grass, C_VIRIDIAN * 0.7, smoothstep(0.55, 0.8, n2) * 0.35);
  vec3 spring = grass;
  // organic drifts: edges wander, densities breathe, so it reads as a natural
  // bloom up close and resolves into the giant flower from high above
  float drift = fbm(xz * 0.009 + 4.0), drift2 = fbm(xz * 0.03 + 11.0);
  float sd = inf2.x;                                   // baked layout.petalField (organic)
  float petalIn = 1.0 - smoothstep(-30.0, 10.0, sd);   // soft ~40 m blend into the meadow
  float heart = 1.0 - smoothstep(uHeartR - 18.0, uHeartR + 10.0, r + (drift2 - 0.5) * 30.0);
  // tepal colour like the hero flower: deep violet at the base -> light violet at the tip
  float along = clamp(r / 1150.0, 0.0, 1.0);
  vec3 vDeep = s2l(vec3(0.294, 0.137, 0.565)), vMidC = s2l(vec3(0.478, 0.333, 0.784)), vLight = s2l(vec3(0.612, 0.486, 0.941));
  vec3 petalCol = mix(vDeep, vMidC, smoothstep(0.0, 0.45, along));
  petalCol = mix(petalCol, vLight, smoothstep(0.45, 1.0, along) * 0.8);
  petalCol = mix(petalCol, C_COBALT * 0.8, 0.16 * smoothstep(0.55, 0.85, inf2.w));
  petalCol *= 0.86 + 0.32 * (vMid - 0.5) + 0.22 * (vBig - 0.5);
  // veins: dark violet along each petal axis (around the creek) + faint secondaries
  float vein = (1.0 - smoothstep(5.0, 26.0, inf.y)) * smoothstep(80.0, 160.0, r);
  float sec = smoothstep(0.93, 0.99, abs(sin(inf2.z * 40.0 + r * 0.004))) * 0.5 * smoothstep(150.0, 400.0, r);
  petalCol *= 1.0 - 0.42 * vein - 0.16 * sec;
  // close to the camera the washes thin out to flower dots in grass (real
  // instanced flowers carry the colour there); from afar they read as solid colour
  float cs = mix(0.2, 1.0, smoothstep(30.0, 260.0, dist));
  float fq = mix(2.6, 1.0, smoothstep(20.0, 120.0, dist));
  float petalCov = petalIn * mix(0.84, 0.97, smoothstep(0.3, 0.7, drift)) * cs;
  spring = speckle(spring, petalCol, petalCov, xz, 0.75 * fq, dist, 1.0);
  // meadow wildflowers (thin out with distance: red + green dots average to brown)
  float outer = (1.0 - petalIn) * (1.0 - heart) * smoothstep(1350.0, 1100.0, r);
  spring = speckle(spring, C_POPPY * 0.85, 0.12 * outer * (0.5 + drift2) * (1.0 - smoothstep(60.0, 400.0, dist)), xz, 0.6 * fq, dist, 7.0);
  spring = speckle(spring, C_GOLD * 0.9, 0.05 * outer * mix(1.0, 0.2, smoothstep(250.0, 1200.0, dist)), xz, 0.55 * fq, dist, 13.0);
  // soft daisy drifts along the petal edges (no hard rim)
  float daisy = (1.0 - smoothstep(0.0, 30.0, abs(sd + 6.0))) * step(uHeartR, r) * smoothstep(0.35, 0.7, drift2);
  spring = speckle(spring, C_DAISY * 0.85, 0.3 * daisy * cs, xz, 0.9 * fq, dist, 3.0);
  // the heart: a gold-to-orange stamen boss with radial strokes and a darker centre
  float angH = atan(xz.y, xz.x);
  float stamen = vnoise(vec2(angH * 18.0, r * 0.05)) * 0.6 + vnoise(vec2(angH * 47.0, r * 0.12)) * 0.4;
  // (far shots: lemon-gold like the hero's stamens, only a slightly darker centre)
  vec3 bossLo = mix(s2l(vec3(0.95, 0.56, 0.17)), s2l(vec3(1.0, 0.769, 0.18)), uFarK);
  vec3 boss = mix(bossLo, C_GOLD, smoothstep(0.35, 0.75, stamen) * smoothstep(0.15, 0.8, r / uHeartR));
  boss *= mix(mix(0.5, 0.8, uFarK), 1.0, smoothstep(0.0, 0.5, r / uHeartR));
  spring = mix(spring, boss, heart * mix(0.3, 0.95, smoothstep(30.0, 200.0, dist)));
  // forest floor + rim slopes
  spring = mix(spring, C_VIRIDIAN * 0.45, inf.w * 0.85);
  float rimT = smoothstep(1400.0, 2200.0, r);
  spring = mix(spring, mix(C_VIRIDIAN * 0.55, meadowShade * 0.85, n2), rimT * 0.6);
  // banks
  float bank = max(1.0 - smoothstep(14.0, 30.0, inf.x), 1.0 - smoothstep(-2.0, 8.0, inf.z));
  spring = mix(spring, C_SOIL * 0.75, bank * 0.6);

  // -------- rock (steep / high): face-aligned painterly pattern — vertical
  // fissures + horizontal ledges, warm ochre-grey with darker seams
  float rockM = smoothstep(0.30, 0.50, slope + (n3 - 0.5) * 0.12) + smoothstep(700.0, 1300.0, wp.y) * smoothstep(0.22, 0.42, slope);
  rockM = clamp(rockM, 0.0, 1.0);
  vec3 Tf = normalize(vec3(-N.z, 0.0, N.x) + 1e-4);
  float fu = dot(wp, Tf), fv = wp.y;
  // columnar structure: tall vertical buttresses and gullies, a few thin ledges
  float column = vnoise(vec2(fu * 0.045, fv * 0.004)) * 0.65 + vnoise(vec2(fu * 0.16, fv * 0.012)) * 0.35;
  float fissure = smoothstep(0.58, 0.88, column);
  float buttress = smoothstep(0.25, 0.6, vnoise(vec2(fu * 0.012, fv * 0.002) + 7.0));
  float ledgeBand = smoothstep(0.74, 0.92, vnoise(vec2(fu * 0.01, fv * 0.055)) * 0.7 + vnoise(vec2(fu * 0.04, fv * 0.2)) * 0.3);
  // far shots: no ledge islands (they read as rows of white / green specks on the cirque walls)
  ledgeBand *= mix(1.0, 1.0 - smoothstep(200.0, 450.0, dist), uFarK);
  float tone = fbm(vec2(fu * 0.008, fv * 0.003) + 3.0);
  vec3 rockLight = s2l(vec3(0.47, 0.42, 0.38)), rockDark = s2l(vec3(0.19, 0.17, 0.23));
  vec3 rock = mix(rockDark, rockLight, 0.2 + 0.6 * tone * (0.55 + 0.45 * buttress));
  rock *= 1.0 - 0.55 * fissure;
  // dark water-stain streaks running down the faces + broad tonal columns that survive distance
  float stain = smoothstep(0.62, 0.9, vnoise(vec2(fu * 0.022, fv * 0.0016) + 13.0));
  rock *= 1.0 - 0.38 * stain * rockM;
  rock *= 0.8 + 0.4 * smoothstep(0.2, 0.8, vnoise(vec2(fu * 0.006, fv * 0.0008) + 4.0));
  // horizontal strata (2-6 m bands) + warm sunlit top / cool shaded base of tall faces
  float strata = smoothstep(0.35, 0.65, vnoise(vec2(fu * 0.004, fv * 0.22 + vnoise(vec2(fu * 0.01, 0.0)) * 1.5)));
  rock *= 0.82 + 0.3 * strata;
  rock *= mix(vec3(0.86, 0.9, 1.06), vec3(1.08, 1.0, 0.9), smoothstep(30.0, 230.0, wp.y));
  rock *= mix(vec3(1.0), vec3(0.74, 0.76, 0.88), uFarK);   // far shots: darker, cooler walls behind the falls
  // face relief: bend the normal across columns / ledges so the paint filter finds structure
  N = normalize(N + Tf * ((column - 0.5) * 0.9 + (buttress - 0.5) * 0.6) * rockM + vec3(0.0, 1.0, 0.0) * ledgeBand * 0.6 * rockM);
  // ledges hold a dusting of snow (winter) and moss / tiny flowers (spring)
  float ledgeCatch = ledgeBand * rockM;

  // -------- winter
  vec3 snow = C_SNOW * 0.86;
  vec3 winter = mix(snow, rock * 0.9, rockM * (1.0 - ledgeCatch * 0.55 * smoothstep(0.35, 0.7, N.y)) * 0.95);
  vec3 moss = mix(C_EMERALD * 0.45, C_CHARTREUSE * 0.5, n3);
  moss = speckle(moss, C_VIOLET * 0.8, 0.25, xz + fv, 1.3, dist, 21.0);
  spring = mix(spring, mix(rock, moss, ledgeCatch * 0.85), rockM);
  spring = mix(spring, mix(snow, rock, rockM * (1.0 - ledgeCatch) * 0.7), peakSnow);

  vec3 albedo = mix(winter, spring, bloom);
  // fresh thaw: a dark wet-earth strip just behind the wavefront
  float thaw = smoothstep(0.0, 0.2, bloom) * (1.0 - smoothstep(0.3, 0.75, bloom)) * (1.0 - rockM);
  albedo = mix(albedo, C_SOIL * 0.5, thaw * 0.55);

  // carpet relief: rolling mounds (25-60 m) so sun and shade shape the open
  // ground into painterly value bands instead of a flat fill
  vec2 rg = vec2(fbm(xz * 0.02 + 1.3) - fbm(xz * 0.02 + vec2(1.8, 1.3)), fbm(xz * 0.02 + 1.3) - fbm(xz * 0.02 + vec2(1.3, 1.8)));
  // (far shots: mounds only on the basin meadow, not on snow or the rim)
  float reliefK = mix(1.0, (1.0 - ((1.0 - bloom) + peakSnow * bloom)) * (1.0 - smoothstep(1250.0, 1500.0, r)), uFarK);
  N = normalize(N + vec3(rg.x, 0.0, rg.y) * 2.4 * (1.0 - rockM) * smoothstep(40.0, 200.0, dist) * reliefK);

  // -------- light
  float sh = sunShadow(wp + N * 0.15 * (1.0 + dist * 0.01), 1.0);
  float snowAmt = (1.0 - bloom) + peakSnow * bloom;
  vec3 col = shadeSurface(albedo, N, wp, mix(0.15, 0.35, snowAmt), 1.0, 0.0, sh);
  // snow: blue subsurface in shade + view-dependent glints
  float ndl = max(dot(N, uSunDir), 0.0);
  col += snowAmt * C_SNOW_SH * uSkyAmbient * 0.25 * (1.0 - ndl * sh);
  vec3 V = normalize(cameraPosition - wp);
  vec2 gp = floor(xz * 9.0);
  float gl = hash12(gp + floor(uTime * 0.0));
  float facet = pow(max(dot(reflect(-uSunDir, normalize(vec3(hash12(gp + 1.3) - 0.5, 1.2, hash12(gp + 7.1) - 0.5))), V), 0.0), 60.0);
  col += snowAmt * step(0.82, gl) * facet * uSunColor * 6.0 * sh * (1.0 - smoothstep(10.0, 80.0, dist));
  // wavefront glow: golden shimmer band
  col += pow(front, 4.0) * (1.0 - rockM) * smoothstep(0.55, 0.85, N.y) * s2l(vec3(1.0, 0.78, 0.40)) * uSunColor * 0.1 * (0.6 + 0.8 * vnoise(xz * 2.0 + uTime * 3.0));
  col = applyFog(col, wp);
  gl_FragColor = vec4(col, 1.0);
}`;

// high-res regular-grid patch (waterfall cirque) from its own baked heightmap
const PATCH_VERT = /* glsl */`
uniform sampler2D tPatch; uniform vec4 uPatch; // minX, minZ, size, n-1
uniform sampler2D tHeight; uniform vec4 uGrid; uniform vec3 uGridK;
attribute vec2 aIJ;
varying vec3 vWorld; varying vec3 vNormal;
// height of the MAIN (coarse) terrain surface at x,z — same triangulation as the mesh,
// so the patch border can meet it seamlessly
float mainH(float x, float z) {
  float NM = uGridK.z, SK = 1.0 / uGridK.y;
  float fi = (asinh((x - uGrid.x) * SK / uGrid.z) / uGridK.x + 1.0) * 0.5 * NM;
  float fj = (asinh((z - uGrid.y) * SK / uGrid.w) / uGridK.x + 1.0) * 0.5 * NM;
  float i = floor(fi), j = floor(fj), u = fi - i, v = fj - j;
  ivec2 p = ivec2(i, j);
  float h00 = texelFetch(tHeight, p, 0).r, h10 = texelFetch(tHeight, p + ivec2(1, 0), 0).r;
  float h01 = texelFetch(tHeight, p + ivec2(0, 1), 0).r, h11 = texelFetch(tHeight, p + ivec2(1, 1), 0).r;
  return u > v ? h00 + (h10 - h00) * u + (h11 - h10) * v : h00 + (h11 - h01) * u + (h01 - h00) * v;
}
float patchH(ivec2 ij, float st) {
  int NM = int(uPatch.w);
  float h = texelFetch(tPatch, ij, 0).r;
  float e = float(min(min(ij.x, ij.y), min(NM - ij.x, NM - ij.y)));
  float w = smoothstep(0.0, 10.0, e);
  return mix(mainH(uPatch.x + float(ij.x) * st, uPatch.y + float(ij.y) * st), h, w);
}
void main() {
  ivec2 ij = ivec2(aIJ); int NM = int(uPatch.w);
  float st = uPatch.z / uPatch.w;
  float h = patchH(ij, st);
  ivec2 ia = ivec2(max(ij.x - 1, 0), ij.y), ib = ivec2(min(ij.x + 1, NM), ij.y);
  ivec2 ja = ivec2(ij.x, max(ij.y - 1, 0)), jb = ivec2(ij.x, min(ij.y + 1, NM));
  float dhx = (patchH(ib, st) - patchH(ia, st)) / (float(ib.x - ia.x) * st);
  float dhz = (patchH(jb, st) - patchH(ja, st)) / (float(jb.y - ja.y) * st);
  vNormal = normalize(vec3(-dhx, 1.0, -dhz));
  vec3 wp = vec3(uPatch.x + aIJ.x * st, h, uPatch.y + aIJ.y * st);
  vWorld = wp;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

function gridGeometry(N) {
  const ij = new Uint16Array(N * N * 2);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const o = (j * N + i) * 2; ij[o] = i; ij[o + 1] = j; }
  const idx = new Uint32Array((N - 1) * (N - 1) * 6);
  let k = 0;
  for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
    const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
    idx[k++] = a; idx[k++] = c; idx[k++] = d; idx[k++] = a; idx[k++] = d; idx[k++] = b;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('aIJ', new THREE.Uint16BufferAttribute(ij, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return geo;
}

export function createTerrain(data) {
  const N = L.GRID.N;
  const geo = gridGeometry(N);
  const SK = Math.sinh(L.GRID.k);
  const uniforms = {
    tHeight: { value: data.heightTex },
    uGrid: { value: new THREE.Vector4(L.GRID.cx, L.GRID.cz, L.GRID.Lx, L.GRID.Lz) },
    uGridK: { value: new THREE.Vector3(L.GRID.k, 1 / SK, N - 1) },
    uSnowline: { value: 1150 },
    uHeartR: { value: L.HEART_R },
    uHole: { value: new THREE.Vector4(1e9, 1e9, -1e9, -1e9) },
  };
  const { material, depthMaterial } = worldMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms });
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  castShadow(mesh, depthMaterial);

  // waterfall patch (always on; the main grid discards inside it)
  const P = data.PATCH, cell = P.size / (P.n - 1);
  const pU = { ...uniforms, tPatch: { value: data.patchTex }, uPatch: { value: new THREE.Vector4(P.cx - P.size / 2, P.cz - P.size / 2, P.size, P.n - 1) } };
  const pm = worldMaterial({ vertexShader: PATCH_VERT, fragmentShader: FRAG, uniforms: pU, defines: { IS_PATCH: 1 } });
  const patch = new THREE.Mesh(gridGeometry(P.n), pm.material);
  patch.frustumCulled = false;
  castShadow(patch, pm.depthMaterial);
  const inset = 0;
  uniforms.uHole.value.set(P.cx - P.size / 2 + inset, P.cz - P.size / 2 + inset, P.cx + P.size / 2 - inset, P.cz + P.size / 2 - inset);
  return { mesh, patch, uniforms };
}
