// Offline film engine: accumulates jittered, time-offset subframes (AA + true
// motion blur) into an HDR buffer, then runs the post chain:
//   DOF -> bloom -> tonemap/grade -> anisotropic Kuwahara (painterly) -> finish.
// Heavy fullscreen passes are drawn in scissor tiles with a sync after each so
// no single GPU submission runs long enough to trip a Windows TDR.
import * as THREE from 'three';

const FS_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const quadGeo = new THREE.PlaneGeometry(2, 2);
const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

class Pass {
  constructor(fragmentShader, uniforms = {}, extra = {}) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: FS_VERT, fragmentShader, uniforms,
      depthTest: false, depthWrite: false, ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'additive')),
    });
    this.additive = !!extra.additive;
    this.mesh = new THREE.Mesh(quadGeo, this.material);
    this.mesh.frustumCulled = false;
    this.u = this.material.uniforms;
  }
}

const rt = (w, h, o = {}) => new THREE.WebGLRenderTarget(w, h, {
  type: THREE.HalfFloatType, format: THREE.RGBAFormat,
  minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
  depthBuffer: false, generateMipmaps: false, ...o,
});

function halton(i, b) { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; }

// ---------------------------------------------------------------- shaders
const ACCUM_FRAG = /* glsl */`
uniform sampler2D tSrc; uniform float weight; varying vec2 vUv;
void main() { vec4 c = texture2D(tSrc, vUv); gl_FragColor = vec4(max(c.rgb, 0.0) * weight, weight); }`;

// Depth of field, gathered at reduced resolution (Gustafsson-style golden-angle
// spiral). Output rgb = blurred colour, a = how much the blurred layer should
// cover this pixel (accounts for near-field bleeding onto sharp background).
const DOF_FRAG = /* glsl */`
uniform sampler2D tColor; uniform sampler2D tDepth;
uniform vec2 texel; uniform float near; uniform float far;
uniform float focus; uniform float cocK; uniform float maxCoc; uniform float scale;
varying vec2 vUv;
float linDepth(vec2 uv) { float z = texture2D(tDepth, uv).x * 2.0 - 1.0; return 2.0 * near * far / (far + near - z * (far - near)); }
float cocPx(float d) { return clamp(cocK * abs(1.0 - focus / d), 0.0, maxCoc) * scale; }
void main() {
  float cd = linDepth(vUv);
  float cs = cocPx(cd);
  vec3 col = texture2D(tColor, vUv).rgb;
  float tot = 1.0; float cover = smoothstep(0.35, 1.0, cs);
  float r = 0.5; float ang = 0.0;
  float mx = maxCoc * scale;
  for (int k = 0; k < 400; k++) {
    if (r >= mx) break;
    vec2 tc = vUv + vec2(cos(ang), sin(ang)) * texel * r;
    vec3 sc = texture2D(tColor, tc).rgb;
    float sd = linDepth(tc);
    float ss = cocPx(sd);
    if (sd > cd) ss = clamp(ss, 0.0, cs * 2.0);
    float m = smoothstep(r - 0.5, r + 0.5, ss);
    col += mix(col / tot, sc, m);
    tot += 1.0;
    if (sd < cd && sd < focus) cover = max(cover, m * smoothstep(0.35, 1.0, ss));
    ang += 2.39996323; r += 0.5 / r;
  }
  gl_FragColor = vec4(col / tot, cover);
}`;

const DOF_COMP_FRAG = /* glsl */`
uniform sampler2D tSharp; uniform sampler2D tBlur; uniform sampler2D tDepth; uniform vec2 blurTexel;
uniform float near; uniform float far; uniform float focus; uniform float cocK; uniform float maxCoc;
varying vec2 vUv;
float linDepth(vec2 uv) { float z = texture2D(tDepth, uv).x * 2.0 - 1.0; return 2.0 * near * far / (far + near - z * (far - near)); }
void main() {
  vec3 s = texture2D(tSharp, vUv).rgb;
  // 4-tap tent upsample of the low-res blur layer
  vec4 b = 0.25 * (texture2D(tBlur, vUv + blurTexel * vec2(-0.5, -0.5)) + texture2D(tBlur, vUv + blurTexel * vec2(0.5, -0.5))
                 + texture2D(tBlur, vUv + blurTexel * vec2(-0.5, 0.5)) + texture2D(tBlur, vUv + blurTexel * vec2(0.5, 0.5)));
  float c = clamp(cocK * abs(1.0 - focus / linDepth(vUv)), 0.0, maxCoc);
  float w = max(smoothstep(1.6, 4.0, c), b.a * smoothstep(1.0, 3.0, c + 2.0 * b.a));
  gl_FragColor = vec4(mix(s, b.rgb, w), 1.0);
}`;

const BLOOM_DOWN_FRAG = /* glsl */`
uniform sampler2D tSrc; uniform vec2 texel; uniform float karis; varying vec2 vUv;
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 kw(vec3 c) { return c / (1.0 + lum(c)); }
void main() {
  vec2 t = texel;
  vec3 a = texture2D(tSrc, vUv + t * vec2(-2, 2)).rgb, b = texture2D(tSrc, vUv + t * vec2(0, 2)).rgb, c = texture2D(tSrc, vUv + t * vec2(2, 2)).rgb;
  vec3 d = texture2D(tSrc, vUv + t * vec2(-2, 0)).rgb, e = texture2D(tSrc, vUv).rgb, f = texture2D(tSrc, vUv + t * vec2(2, 0)).rgb;
  vec3 g = texture2D(tSrc, vUv + t * vec2(-2, -2)).rgb, h = texture2D(tSrc, vUv + t * vec2(0, -2)).rgb, i = texture2D(tSrc, vUv + t * vec2(2, -2)).rgb;
  vec3 j = texture2D(tSrc, vUv + t * vec2(-1, 1)).rgb, k = texture2D(tSrc, vUv + t * vec2(1, 1)).rgb;
  vec3 l = texture2D(tSrc, vUv + t * vec2(-1, -1)).rgb, m = texture2D(tSrc, vUv + t * vec2(1, -1)).rgb;
  vec3 o;
  if (karis > 0.5) {
    vec3 g0 = (a + b + d + e) * 0.25, g1 = (b + c + e + f) * 0.25, g2 = (d + e + g + h) * 0.25, g3 = (e + f + h + i) * 0.25, g4 = (j + k + l + m) * 0.25;
    o = kw(g0) * 0.125 + kw(g1) * 0.125 + kw(g2) * 0.125 + kw(g3) * 0.125 + kw(g4) * 0.5;
    o = o / max(1.0 - lum(o), 1e-4);
  } else {
    o = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  gl_FragColor = vec4(max(o, 0.0), 1.0);
}`;

const BLOOM_UP_FRAG = /* glsl */`
uniform sampler2D tSrc; uniform vec2 texel; uniform float radius; varying vec2 vUv;
void main() {
  vec2 t = texel * radius;
  vec3 o = texture2D(tSrc, vUv).rgb * 4.0;
  o += (texture2D(tSrc, vUv + vec2(-t.x, 0)).rgb + texture2D(tSrc, vUv + vec2(t.x, 0)).rgb + texture2D(tSrc, vUv + vec2(0, -t.y)).rgb + texture2D(tSrc, vUv + vec2(0, t.y)).rgb) * 2.0;
  o += texture2D(tSrc, vUv + vec2(-t.x, -t.y)).rgb + texture2D(tSrc, vUv + vec2(t.x, -t.y)).rgb + texture2D(tSrc, vUv + vec2(-t.x, t.y)).rgb + texture2D(tSrc, vUv + vec2(t.x, t.y)).rgb;
  gl_FragColor = vec4(o / 16.0, 1.0);
}`;

// Tonemap + grade. AgX base (Troy Sobotka / three.js fit), then a creative
// grade in display space: exposure, contrast, OKLab chroma boost, split tone.
const GRADE_FRAG = /* glsl */`
uniform sampler2D tSrc; uniform sampler2D tBloom;
uniform float exposure; uniform float bloomStrength; uniform float saturation; uniform float vibrance;
uniform float contrast; uniform vec3 lift; uniform vec3 gain; uniform vec3 shadowTint; uniform vec3 highTint;
uniform float splitAmt; uniform float hueShift; uniform float blackPoint; uniform float shoulder;
uniform sampler2D tFlare; uniform sampler2D tStreak; uniform float flare; uniform float streak; uniform float flareThresh;
varying vec2 vUv;
// pseudo lens flare (ghosts + halo) and anamorphic streak from the bloom pyramid
vec3 ghosts(vec2 uv) {
  vec2 tc = 1.0 - uv;
  vec2 gv = (vec2(0.5) - tc) * 0.36;
  vec3 r = vec3(0.0);
  vec3 tints[5] = vec3[5](vec3(1.0, 0.75, 0.5), vec3(0.6, 0.8, 1.0), vec3(0.85, 0.6, 1.0), vec3(0.6, 1.0, 0.85), vec3(1.0, 0.9, 0.7));
  for (int i = 1; i < 6; i++) {
    vec2 o = tc + gv * float(i) * (1.0 + 0.15 * float(i));
    if (o.x < 0.0 || o.x > 1.0 || o.y < 0.0 || o.y > 1.0) continue;
    float w = pow(max(0.0, 1.0 - length(vec2(0.5) - o) / 0.7071), 6.0);
    r += max(texture2D(tFlare, o).rgb - flareThresh, 0.0) * w * tints[i - 1] * (0.6 / float(i));
  }
  vec2 hv = normalize(gv + 1e-5) * 0.42;
  vec2 ho = tc + hv;
  float hw = pow(max(0.0, 1.0 - length(vec2(0.5) - fract(ho)) / 0.7071), 4.0);
  r += max(texture2D(tFlare, ho).rgb - flareThresh, 0.0) * hw * vec3(0.9, 0.85, 1.0) * 0.06;
  return r;
}
vec3 streakAt(vec2 uv) {
  vec3 s = vec3(0.0);
  for (int i = -10; i <= 10; i++) {
    float w = exp(-abs(float(i)) * 0.28);
    s += max(texture2D(tStreak, uv + vec2(float(i) * 0.018, 0.0)).rgb - flareThresh, 0.0) * w;
  }
  return s * vec3(0.55, 0.7, 1.0) * 0.12;
}
vec3 agxDefaultContrastApprox(vec3 x) {
  vec3 x2 = x * x; vec3 x4 = x2 * x2;
  return + 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
vec3 AgX(vec3 color) {
  const mat3 AgXInsetMatrix = mat3(vec3(0.856627153315983, 0.137318972929847, 0.11189821299995), vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903), vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
  const mat3 AgXOutsetMatrix = mat3(vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826), vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294), vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
  const float AgxMinEv = -12.47393; const float AgxMaxEv = 4.026069;
  color = AgXInsetMatrix * color;
  color = max(color, 1e-10);
  color = log2(color);
  color = (color - AgxMinEv) / (AgxMaxEv - AgxMinEv);
  color = clamp(color, 0.0, 1.0);
  color = agxDefaultContrastApprox(color);
  color = AgXOutsetMatrix * color;
  color = pow(max(vec3(0.0), color), vec3(2.2));
  return clamp(color, 0.0, 1.0);
}
vec3 toOklab(vec3 c) {
  float l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  float m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  float s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
  l = pow(max(l, 0.0), 1.0 / 3.0); m = pow(max(m, 0.0), 1.0 / 3.0); s = pow(max(s, 0.0), 1.0 / 3.0);
  return vec3(0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s);
}
vec3 fromOklab(vec3 c) {
  float l = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  float m = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  float s = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  l = l * l * l; m = m * m * m; s = s * s * s;
  return vec3(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}
void main() {
  vec3 hdr = texture2D(tSrc, vUv).rgb;
  vec3 bl = texture2D(tBloom, vUv).rgb;
  hdr = mix(hdr, bl, bloomStrength);
  if (flare > 0.0) hdr += ghosts(vUv) * flare;
  if (streak > 0.0) hdr += streakAt(vUv) * streak;
  vec3 c = AgX(hdr * exposure);
  // contrast around mid grey in a perceptual-ish space
  c = pow(c, vec3(1.0 / 2.2));
  c = clamp((c - 0.5) * contrast + 0.5, 0.0, 1.0);
  c = pow(c, vec3(2.2));
  // lift / gain
  c = c * gain + lift * (1.0 - c);
  // chroma: saturation + vibrance (boost low-chroma more) in OKLab
  vec3 lab = toOklab(max(c, 0.0));
  float ch = length(lab.yz);
  float boost = saturation * (1.0 + vibrance * (1.0 - smoothstep(0.0, 0.25, ch)));
  float hs = hueShift; mat2 hr = mat2(cos(hs), -sin(hs), sin(hs), cos(hs));
  lab.yz = hr * lab.yz * boost;
  c = max(fromOklab(lab), 0.0);
  // split toning by luminance
  float L = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float sh = 1.0 - smoothstep(0.0, 0.45, L), hi = smoothstep(0.35, 1.0, L);
  c = c * mix(vec3(1.0), shadowTint, sh * splitAmt) * mix(vec3(1.0), highTint, hi * splitAmt);
  // levels in display space: black point (real darks) + soft highlight shoulder
  vec3 g = pow(max(c, 0.0), vec3(1.0 / 2.2));
  g = max(g - blackPoint, 0.0) / (1.0 - blackPoint);
  vec3 over = max(g - shoulder, 0.0);
  g = min(g, vec3(shoulder)) + (1.0 - shoulder) * (1.0 - exp(-over / (1.0 - shoulder)));
  c = pow(g, vec3(2.2));
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

// Anisotropic Kuwahara (Kyprianidis et al., polynomial weights).
const TENSOR_FRAG = /* glsl */`
uniform sampler2D tSrc; uniform vec2 texel; varying vec2 vUv;
vec3 enc(vec3 c) { c = max(c, 0.0); return pow(c / (1.0 + c), vec3(1.0 / 2.2)); }
vec3 S(float x, float y) { return enc(texture2D(tSrc, vUv + texel * vec2(x, y)).rgb); }
void main() {
  vec3 u = (-1.0 * S(-1., -1.) - 2.0 * S(-1., 0.) - 1.0 * S(-1., 1.) + 1.0 * S(1., -1.) + 2.0 * S(1., 0.) + 1.0 * S(1., 1.)) / 4.0;
  vec3 v = (-1.0 * S(-1., -1.) - 2.0 * S(0., -1.) - 1.0 * S(1., -1.) + 1.0 * S(-1., 1.) + 2.0 * S(0., 1.) + 1.0 * S(1., 1.)) / 4.0;
  gl_FragColor = vec4(dot(u, u), dot(v, v), dot(u, v), 1.0);
}`;
const GAUSS_FRAG = /* glsl */`
uniform sampler2D tSrc; uniform vec2 dir; uniform float sigma; varying vec2 vUv;
void main() {
  float tw = 0.0; vec4 acc = vec4(0.0);
  int R = int(ceil(sigma * 2.5));
  for (int i = -24; i <= 24; i++) {
    if (i < -R || i > R) continue;
    float w = exp(-float(i * i) / (2.0 * sigma * sigma));
    acc += texture2D(tSrc, vUv + dir * float(i)) * w; tw += w;
  }
  gl_FragColor = acc / tw;
}`;
const KUWAHARA_FRAG = /* glsl */`
uniform sampler2D tSrc; uniform sampler2D tTensor; uniform vec2 texel;
uniform float radius; uniform float hardness; uniform float sharpness; uniform float alpha; uniform float zeroCross;
uniform float mixAmt; uniform sampler2D tDepth; uniform vec2 uNF; uniform vec3 uDepthMix;
varying vec2 vUv;
vec3 enc(vec3 c) { c = max(c, 0.0); return pow(c / (1.0 + c), vec3(1.0 / 2.2)); }
vec3 dec(vec3 p) { vec3 q = min(pow(max(p, 0.0), vec3(2.2)), 0.9995); return q / (1.0 - q); }
void main() {
  vec3 g = texture2D(tTensor, vUv).xyz;
  float disc = sqrt(max(g.y * g.y - 2.0 * g.x * g.y + g.x * g.x + 4.0 * g.z * g.z, 0.0));
  float l1 = 0.5 * (g.y + g.x + disc), l2 = 0.5 * (g.y + g.x - disc);
  vec2 vv = vec2(l1 - g.x, -g.z);
  vec2 tt = length(vv) > 0.0 ? normalize(vv) : vec2(0.0, 1.0);
  float phi = -atan(tt.y, tt.x);
  float A = (l1 + l2 > 0.0) ? (l1 - l2) / (l1 + l2) : 0.0;
  float a = radius * clamp((alpha + A) / alpha, 0.1, 2.0);
  float b = radius * clamp(alpha / (alpha + A), 0.1, 2.0);
  float cp = cos(phi), sp = sin(phi);
  mat2 R = mat2(cp, -sp, sp, cp);
  mat2 Sm = mat2(0.5 / a, 0.0, 0.0, 0.5 / b);
  mat2 SR = Sm * R;
  int mxx = int(sqrt(a * a * cp * cp + b * b * sp * sp));
  int mxy = int(sqrt(a * a * sp * sp + b * b * cp * cp));
  float zeta = 2.0 / radius;
  float sz = sin(zeroCross);
  float eta = (zeta + cos(zeroCross)) / (sz * sz);
  vec4 m[8]; vec3 s[8];
  for (int k = 0; k < 8; k++) { m[k] = vec4(0.0); s[k] = vec3(0.0); }
  for (int y = -40; y <= 40; y++) {
    if (y < -mxy || y > mxy) continue;
    for (int x = -40; x <= 40; x++) {
      if (x < -mxx || x > mxx) continue;
      vec2 v = SR * vec2(float(x), float(y));
      if (dot(v, v) <= 0.25) {
        vec3 c = enc(texture2D(tSrc, vUv + vec2(float(x), float(y)) * texel).rgb);
        float w[8]; float sum = 0.0; float z, vxx, vyy;
        vxx = zeta - eta * v.x * v.x; vyy = zeta - eta * v.y * v.y;
        z = max(0.0, v.y + vxx); w[0] = z * z; sum += w[0];
        z = max(0.0, -v.x + vyy); w[2] = z * z; sum += w[2];
        z = max(0.0, -v.y + vxx); w[4] = z * z; sum += w[4];
        z = max(0.0, v.x + vyy); w[6] = z * z; sum += w[6];
        vec2 v2 = 0.70710678 * vec2(v.x - v.y, v.x + v.y);
        vxx = zeta - eta * v2.x * v2.x; vyy = zeta - eta * v2.y * v2.y;
        z = max(0.0, v2.y + vxx); w[1] = z * z; sum += w[1];
        z = max(0.0, -v2.x + vyy); w[3] = z * z; sum += w[3];
        z = max(0.0, -v2.y + vxx); w[5] = z * z; sum += w[5];
        z = max(0.0, v2.x + vyy); w[7] = z * z; sum += w[7];
        float gw = exp(-3.125 * dot(v, v)) / sum;
        for (int k = 0; k < 8; k++) { float wk = w[k] * gw; m[k] += vec4(c * wk, wk); s[k] += c * c * wk; }
      }
    }
  }
  vec4 o = vec4(0.0);
  for (int k = 0; k < 8; k++) {
    m[k].rgb /= max(m[k].w, 1e-6);
    s[k] = abs(s[k] / max(m[k].w, 1e-6) - m[k].rgb * m[k].rgb);
    float sig2 = s[k].r + s[k].g + s[k].b;
    float w = 1.0 / (1.0 + pow(hardness * 1000.0 * sig2, 0.5 * sharpness));
    o += vec4(m[k].rgb * w, w);
  }
  vec3 painted = dec(o.rgb / o.w);
  vec3 src = texture2D(tSrc, vUv).rgb;
  // paint strength by depth: lighter on very near objects, full mid-ground, softer sky
  float zd = texture2D(tDepth, vUv).x;
  float ld = 2.0 * uNF.x * uNF.y / (uNF.y + uNF.x - (zd * 2.0 - 1.0) * (uNF.y - uNF.x));
  float dk = zd >= 0.99999 ? uDepthMix.z : mix(uDepthMix.x, uDepthMix.y, smoothstep(2.0, 14.0, ld));
  gl_FragColor = vec4(mix(src, painted, mixAmt * dk), 1.0);
}`;

const FINISH_FRAG = /* glsl */`
uniform sampler2D tSrc; uniform vec2 texel; uniform float frame;
uniform float vignette; uniform float grain; uniform float ca; uniform float fade; uniform float letterbox;
uniform float sharpen; uniform vec3 fadeColor; uniform float canvas;
varying vec2 vUv;
float hash(vec3 p) { p = fract(p * vec3(443.897, 441.423, 437.195)); p += dot(p, p.yzx + 19.19); return fract((p.x + p.y) * p.z); }
vec3 srgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
void main() {
  vec2 d = vUv - 0.5;
  float r2 = dot(d, d);
  vec3 c;
  if (ca > 0.0) {
    vec2 off = d * r2 * ca;
    c = vec3(texture2D(tSrc, vUv - off).r, texture2D(tSrc, vUv).g, texture2D(tSrc, vUv + off).b);
  } else c = texture2D(tSrc, vUv).rgb;
  if (sharpen > 0.0) {
    vec3 bl = (texture2D(tSrc, vUv + vec2(texel.x, 0)).rgb + texture2D(tSrc, vUv - vec2(texel.x, 0)).rgb + texture2D(tSrc, vUv + vec2(0, texel.y)).rgb + texture2D(tSrc, vUv - vec2(0, texel.y)).rgb) * 0.25;
    c = max(c + (c - bl) * sharpen, 0.0);
  }
  c *= mix(1.0, smoothstep(0.85, 0.15, r2 * 1.6), vignette);
  c = mix(c, fadeColor, fade);
  vec3 s = srgb(clamp(c, 0.0, 1.0));
  // film grain (luma-weighted, strongest in mids) + triangular dither
  float L = dot(s, vec3(0.299, 0.587, 0.114));
  float gn = (hash(vec3(gl_FragCoord.xy, frame)) + hash(vec3(gl_FragCoord.xy + 17.3, frame * 1.7)) - 1.0);
  s += gn * grain * (0.35 + 0.65 * 4.0 * L * (1.0 - L));
  // static canvas tooth: one painted surface for the whole film
  vec2 cp = gl_FragCoord.xy;
  float tooth = hash(vec3(floor(cp * 0.5), 3.0)) * 0.5 + hash(vec3(floor(cp / 3.0), 7.0)) * 0.3 + 0.2 * sin((cp.x + cp.y) * 0.9) * sin((cp.x - cp.y) * 0.9);
  s *= 1.0 + (tooth - 0.5) * canvas;
  s += (hash(vec3(gl_FragCoord.xy * 1.31, frame + 5.0)) - hash(vec3(gl_FragCoord.xy * 0.77, frame + 9.0))) / 255.0;
  float bar = letterbox * 0.5;
  if (vUv.y < bar || vUv.y > 1.0 - bar) s = vec3(0.0);
  gl_FragColor = vec4(clamp(s, 0.0, 1.0), 1.0);
}`;

const OVER_FRAG = /* glsl */`
uniform sampler2D tBase; uniform sampler2D tOver; varying vec2 vUv;
void main() { vec3 b = texture2D(tBase, vUv).rgb; vec4 o = texture2D(tOver, vUv); gl_FragColor = vec4(b * (1.0 - clamp(o.a, 0.0, 1.0)) + o.rgb, 1.0); }`;

const ACCUM_PM_FRAG = /* glsl */`
uniform sampler2D tSrc; uniform float weight; varying vec2 vUv;
void main() { gl_FragColor = texture2D(tSrc, vUv) * weight; }`;

const ADD = { blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor, transparent: true, additive: true };

export const POST_DEFAULTS = {
  exposure: 1.0, bloomStrength: 0.04, bloomRadius: 1.0,
  saturation: 1.15, vibrance: 0.25, contrast: 1.05, hueShift: 0.0,
  lift: [0.0, 0.0, 0.0], gain: [1, 1, 1], shadowTint: [1, 1, 1], highTint: [1, 1, 1], splitAmt: 0.0,
  focus: 10, cocK: 0, maxCoc: 48,
  paint: 1.0, paintRadius: 7, paintHardness: 8, paintSharpness: 8, paintAlpha: 1.0, paintTensorSigma: 2.0,
  vignette: 0.35, grain: 0.035, ca: 0.0, fade: 0.0, fadeColor: [0, 0, 0], letterbox: 0.0, sharpen: 0.0,
  flare: 0.0, streak: 0.0, flareThresh: 2.0, blackPoint: 0.0, shoulder: 0.9,
  paintDepth: [0.45, 1.0, 0.65], canvas: 0.035,
  shutter: 0.5,
};

export class Engine {
  constructor({ W, H, spp = 8, fps = 30, msaa = 4, tile = 2 }) {
    this.W = W; this.H = H; this.spp = spp; this.fps = fps; this.tile = tile;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    document.body.appendChild(canvas);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance', alpha: false });
    renderer.setPixelRatio(1);
    renderer.setSize(W, H, false);
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.shadowMap.autoUpdate = false;
    renderer.autoClear = true;
    this.renderer = renderer;
    this.gl = renderer.getContext();

    this.sceneRT = rt(W, H, { depthBuffer: true, samples: msaa, depthTexture: new THREE.DepthTexture(W, H, THREE.FloatType) });
    this.accumRT = rt(W, H, { type: THREE.FloatType });
    this.rtA = rt(W, H); this.rtB = rt(W, H); this.rtC = rt(W, H);
    this.overlayRT = rt(W, H, { depthBuffer: true });
    this.overlayAccum = rt(W, H, { type: THREE.FloatType });
    this.ldrA = rt(W, H); this.ldrB = rt(W, H);
    this.dofScale = 0.25;
    const dw = Math.round(W * this.dofScale), dh = Math.round(H * this.dofScale);
    this.dofSrc = rt(dw, dh); this.dofRT = rt(dw, dh);
    this.tensorScale = 1.0;
    const tw = Math.round(W * this.tensorScale), th = Math.round(H * this.tensorScale);
    this.tensorA = rt(tw, th); this.tensorB = rt(tw, th);
    this.bloomMips = [];
    let bw = W, bh = H;
    for (let i = 0; i < 7; i++) { bw = Math.max(1, bw >> 1); bh = Math.max(1, bh >> 1); this.bloomMips.push(rt(bw, bh)); }

    this.pAccum = new Pass(ACCUM_FRAG, { tSrc: { value: null }, weight: { value: 1 } }, ADD);
    this.pAccumPM = new Pass(ACCUM_PM_FRAG, { tSrc: { value: null }, weight: { value: 1 } }, ADD);
    this.pOver = new Pass(OVER_FRAG, { tBase: { value: null }, tOver: { value: null } });
    this.pCopy = new Pass(`uniform sampler2D tSrc; varying vec2 vUv; void main(){ gl_FragColor = texture2D(tSrc, vUv); }`, { tSrc: { value: null } });
    this.pResolve = new Pass(`uniform sampler2D tSrc; varying vec2 vUv; void main(){ vec4 c = texture2D(tSrc, vUv); gl_FragColor = vec4(c.rgb / max(c.a, 1e-6), 1.0); }`, { tSrc: { value: null } });
    const u = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { value: v }]));
    this.pDof = new Pass(DOF_FRAG, u({ tColor: null, tDepth: null, texel: new THREE.Vector2(), near: 0.1, far: 1000, focus: 10, cocK: 0, maxCoc: 40, scale: this.dofScale }));
    this.pDofComp = new Pass(DOF_COMP_FRAG, u({ tSharp: null, tBlur: null, tDepth: null, blurTexel: new THREE.Vector2(1 / dw, 1 / dh), near: 0.1, far: 1000, focus: 10, cocK: 0, maxCoc: 40 }));
    this.pBloomDown = new Pass(BLOOM_DOWN_FRAG, u({ tSrc: null, texel: new THREE.Vector2(), karis: 0 }));
    this.pBloomUp = new Pass(BLOOM_UP_FRAG, u({ tSrc: null, texel: new THREE.Vector2(), radius: 1 }), ADD);
    this.pGrade = new Pass(GRADE_FRAG, u({ tSrc: null, tBloom: null, exposure: 1, bloomStrength: 0.04, saturation: 1, vibrance: 0, contrast: 1, lift: new THREE.Vector3(), gain: new THREE.Vector3(1, 1, 1), shadowTint: new THREE.Vector3(1, 1, 1), highTint: new THREE.Vector3(1, 1, 1), splitAmt: 0, hueShift: 0, tFlare: null, tStreak: null, flare: 0, streak: 0, flareThresh: 2.0, blackPoint: 0.0, shoulder: 0.9 }));
    this.pTensor = new Pass(TENSOR_FRAG, u({ tSrc: null, texel: new THREE.Vector2() }));
    this.pGauss = new Pass(GAUSS_FRAG, u({ tSrc: null, dir: new THREE.Vector2(), sigma: 2 }));
    this.pKuwa = new Pass(KUWAHARA_FRAG, u({ tSrc: null, tTensor: null, texel: new THREE.Vector2(1 / W, 1 / H), radius: 7, hardness: 8, sharpness: 8, alpha: 1, zeroCross: 0.58, mixAmt: 1, tDepth: null, uNF: new THREE.Vector2(0.1, 1000), uDepthMix: new THREE.Vector3(0.45, 1.0, 0.65) }));
    this.pFinish = new Pass(FINISH_FRAG, u({ tSrc: null, texel: new THREE.Vector2(1 / W, 1 / H), frame: 0, vignette: 0.3, grain: 0.03, ca: 0, fade: 0, letterbox: 0, sharpen: 0, fadeColor: new THREE.Vector3(), canvas: 0 }));
    this.timing = {};
  }

  // gl.finish() does not block in Chrome; a 1px readback of the default
  // framebuffer forces the GPU queue to drain (real sync + honest timings).
  sync() {
    const gl = this.gl; this._px = this._px || new Uint8Array(4);
    const fb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this._px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  }

  // Draw a fullscreen pass into target, optionally split into tiles x tiles.
  drawPass(pass, target, tiles = 1) {
    const r = this.renderer;
    const w = target ? target.width : this.W, h = target ? target.height : this.H;
    const prevClear = r.autoClear; if (pass.additive) r.autoClear = false;
    try { this._draw(pass, target, tiles, w, h); } finally { r.autoClear = prevClear; }
  }

  _draw(pass, target, tiles, w, h) {
    const r = this.renderer;
    if (tiles <= 1) {
      r.setRenderTarget(target); r.render(pass.mesh, quadCam); this.sync(); return;
    }
    const tw = Math.ceil(w / tiles), th = Math.ceil(h / tiles);
    for (let y = 0; y < tiles; y++) for (let x = 0; x < tiles; x++) {
      if (target) { target.scissor.set(x * tw, y * th, tw, th); target.scissorTest = true; }
      else { r.setScissor(x * tw, y * th, tw, th); r.setScissorTest(true); }
      r.setRenderTarget(target); r.render(pass.mesh, quadCam); this.sync();
    }
    if (target) target.scissorTest = false; else r.setScissorTest(false);
  }

  time(k, fn) { const t = performance.now(); fn(); this.timing[k] = (this.timing[k] || 0) + performance.now() - t; }

  async renderFrame(world, t, frameIndex) {
    const { renderer: r, W, H, spp } = this;
    this.timing = {};
    const post = { ...POST_DEFAULTS, ...(world.post ? world.post(t) : {}) };
    const shutter = post.shutter / this.fps;
    const hasOverlay = !!world.overlay;
    if (world.preFrame) this.time('preFrame', () => world.preFrame(t, this));

    // ---- accumulate subframes (base scene + optional particle overlay)
    r.setClearColor(0x000000, 0);
    r.setRenderTarget(this.accumRT); r.clear();
    if (hasOverlay) { r.setRenderTarget(this.overlayAccum); r.clear(); }
    // a frame centred on a cut would blend both shots: clamp its shutter to the current shot
    let lo = t - shutter / 2, hi = t + shutter / 2;
    if (world.shotWindow && spp > 1) { const [a, b] = world.shotWindow(t); lo = Math.max(lo, a); hi = Math.min(hi, b); }
    const clamped = lo > t - shutter / 2 || hi < t + shutter / 2;
    for (let s = 0; s < spp; s++) {
      const st = spp > 1 ? (clamped ? lo + ((s + 0.5) / spp) * (hi - lo) : t + ((s + 0.5) / spp - 0.5) * shutter) : t;
      const jx = spp > 1 ? halton(s + 1, 2) - 0.5 : 0, jy = spp > 1 ? halton(s + 1, 3) - 0.5 : 0;
      const sub = { sub: s, spp, engine: this, frameTime: t };
      if (clamped) sub.slice = (hi - lo) / spp;
      this.time('update', () => world.update(st, sub));
      const cam = world.camera;
      cam.setViewOffset(W, H, jx, jy, W, H);
      this.time('scene', () => {
        const tiles = world.sceneTiles || 1;
        const tw = Math.ceil(W / tiles), th = Math.ceil(H / tiles);
        for (let y = 0; y < tiles; y++) for (let x = 0; x < tiles; x++) {
          this.sceneRT.scissor.set(x * tw, y * th, tw, th); this.sceneRT.scissorTest = tiles > 1;
          r.setRenderTarget(this.sceneRT); r.render(world.scene, cam); this.sync();
        }
        this.sceneRT.scissorTest = false;
      });
      if (hasOverlay) this.time('overlay', () => {
        r.setRenderTarget(this.overlayRT); r.render(world.overlay, cam); this.sync();
      });
      cam.clearViewOffset();
      this.pAccum.u.tSrc.value = this.sceneRT.texture; this.pAccum.u.weight.value = 1 / spp;
      this.time('accum', () => this.drawPass(this.pAccum, this.accumRT));
      if (hasOverlay) {
        this.pAccumPM.u.tSrc.value = this.overlayRT.texture; this.pAccumPM.u.weight.value = 1 / spp;
        this.drawPass(this.pAccumPM, this.overlayAccum);
      }
    }
    if (world.postFrame) world.postFrame(t, this);
    this.pResolve.u.tSrc.value = this.accumRT.texture;
    this.drawPass(this.pResolve, this.rtA);
    let hdr = this.rtA;
    const other = () => (hdr === this.rtA ? this.rtB : this.rtA);

    // ---- painterly (anisotropic Kuwahara on the HDR base, Reinhard-encoded)
    if (post.paint > 0.001) this.time('paint', () => {
      const sc = this.tensorScale;
      this.pTensor.u.tSrc.value = hdr.texture; this.pTensor.u.texel.value.set(1 / W, 1 / H);
      this.drawPass(this.pTensor, this.tensorA);
      this.pGauss.u.sigma.value = Math.max(0.5, post.paintTensorSigma * (H / 2160) * 2 * sc);
      this.pGauss.u.tSrc.value = this.tensorA.texture; this.pGauss.u.dir.value.set(1 / this.tensorA.width, 0); this.drawPass(this.pGauss, this.tensorB);
      this.pGauss.u.tSrc.value = this.tensorB.texture; this.pGauss.u.dir.value.set(0, 1 / this.tensorA.height); this.drawPass(this.pGauss, this.tensorA);
      const k = this.pKuwa.u, dst = other();
      k.tSrc.value = hdr.texture; k.tTensor.value = this.tensorA.texture;
      k.radius.value = post.paintRadius * (H / 2160); k.hardness.value = post.paintHardness; k.sharpness.value = post.paintSharpness;
      k.alpha.value = post.paintAlpha; k.mixAmt.value = post.paint;
      k.tDepth.value = this.sceneRT.depthTexture; k.uNF.value.set(world.camera.near, world.camera.far); k.uDepthMix.value.fromArray(post.paintDepth);
      this.drawPass(this.pKuwa, dst, Math.max(2, Math.round(4 * H / 2160)));
      hdr = dst;
    });

    // ---- depth of field (base scene depth)
    if (post.cocK > 0.01) this.time('dof', () => {
      const cam = world.camera;
      for (const p of [this.pDof, this.pDofComp]) {
        p.u.tDepth.value = this.sceneRT.depthTexture;
        p.u.near.value = cam.near; p.u.far.value = cam.far;
        p.u.focus.value = post.focus; p.u.cocK.value = post.cocK * (H / 2160); p.u.maxCoc.value = post.maxCoc * (H / 2160);
      }
      this.pCopy.u.tSrc.value = hdr.texture;
      this.drawPass(this.pCopy, this.dofSrc);
      this.pDof.u.tColor.value = this.dofSrc.texture;
      this.pDof.u.texel.value.set(1 / this.dofSrc.width, 1 / this.dofSrc.height);
      this.drawPass(this.pDof, this.dofRT, 2);
      const dst = other();
      this.pDofComp.u.tSharp.value = hdr.texture; this.pDofComp.u.tBlur.value = this.dofRT.texture;
      this.drawPass(this.pDofComp, dst, 2);
      hdr = dst;
    });

    // ---- particle overlay (self-blurred sprites), premultiplied over
    if (hasOverlay) this.time('overComp', () => {
      const dst = other();
      this.pOver.u.tBase.value = hdr.texture; this.pOver.u.tOver.value = this.overlayAccum.texture;
      this.drawPass(this.pOver, dst); hdr = dst;
    });

    // ---- bloom pyramid
    this.time('bloom', () => {
      let src = hdr;
      this.bloomMips.forEach((m, i) => {
        this.pBloomDown.u.tSrc.value = src.texture;
        this.pBloomDown.u.texel.value.set(1 / src.width, 1 / src.height);
        this.pBloomDown.u.karis.value = i === 0 ? 1 : 0;
        this.drawPass(this.pBloomDown, m); src = m;
      });
      for (let i = this.bloomMips.length - 1; i > 0; i--) {
        const from = this.bloomMips[i], to = this.bloomMips[i - 1];
        this.pBloomUp.u.tSrc.value = from.texture;
        this.pBloomUp.u.texel.value.set(1 / from.width, 1 / from.height);
        this.pBloomUp.u.radius.value = post.bloomRadius;
        this.drawPass(this.pBloomUp, to);
      }
    });

    // ---- tonemap + grade
    this.time('grade', () => {
      const g = this.pGrade.u;
      g.tSrc.value = hdr.texture; g.tBloom.value = this.bloomMips[0].texture;
      g.exposure.value = post.exposure; g.bloomStrength.value = post.bloomStrength;
      g.saturation.value = post.saturation; g.vibrance.value = post.vibrance; g.contrast.value = post.contrast; g.hueShift.value = post.hueShift;
      g.lift.value.fromArray(post.lift); g.gain.value.fromArray(post.gain);
      g.shadowTint.value.fromArray(post.shadowTint); g.highTint.value.fromArray(post.highTint); g.splitAmt.value = post.splitAmt;
      g.tFlare.value = this.bloomMips[2].texture; g.tStreak.value = this.bloomMips[3].texture;
      g.flare.value = post.flare; g.streak.value = post.streak; g.flareThresh.value = post.flareThresh;
      g.blackPoint.value = post.blackPoint; g.shoulder.value = post.shoulder;
      this.drawPass(this.pGrade, this.ldrA, 2);
    });

    // ---- finish to canvas
    this.time('finish', () => {
      const f = this.pFinish.u;
      f.tSrc.value = this.ldrA.texture; f.frame.value = frameIndex ?? Math.round(t * this.fps);
      f.vignette.value = post.vignette; f.grain.value = post.grain * (H / 2160 < 0.75 ? 0.6 : 1); f.ca.value = post.ca; f.fade.value = post.fade;
      f.letterbox.value = post.letterbox; f.sharpen.value = post.sharpen; f.fadeColor.value.fromArray(post.fadeColor); f.canvas.value = post.canvas;
      this.drawPass(this.pFinish, null, 2);
    });
    let url;
    this.time('encode', () => { url = this.renderer.domElement.toDataURL('image/png'); });
    return url.slice(url.indexOf(',') + 1);
  }
}
