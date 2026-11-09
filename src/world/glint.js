// The bookend: at TIMES.glint a tiny violet-gold star winks at the heart of the
// giant flower — the first bloom — seen from the high aerial. Overlay sprite,
// fixed screen-space size, occluded by scene depth.
import * as THREE from 'three';

export async function create(ctx) {
  const { TIMES, rig, engine, H } = ctx;
  const uniforms = {
    uPos: { value: rig.budHead.clone() },
    uSizePx: { value: 240 * H / 2160 },
    uRes: { value: new THREE.Vector2(ctx.W, ctx.H) },
    uAmp: { value: 0 },
    uRot: { value: 0 },
    tDepth: { value: engine.sceneRT.depthTexture },
    uNearFar: { value: new THREE.Vector2(1, 1000) },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthTest: false, depthWrite: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    vertexShader: /* glsl */`
      uniform vec3 uPos; uniform float uSizePx; uniform vec2 uRes; uniform float uRot;
      varying vec2 vQ; varying float vDepth; varying vec2 vScreen;
      void main() {
        vec4 c = projectionMatrix * viewMatrix * vec4(uPos, 1.0);
        vec2 q = position.xy; vQ = q;
        float cr = cos(uRot), sr = sin(uRot);
        vec2 o = mat2(cr, -sr, sr, cr) * q * uSizePx / uRes * 2.0;
        vDepth = c.w;
        gl_Position = vec4(c.xy / c.w + o, 0.0, 1.0);
        vScreen = (c.xy / c.w) * 0.5 + 0.5;
      }`,
    fragmentShader: /* glsl */`
      uniform float uAmp; uniform sampler2D tDepth; uniform vec2 uNearFar;
      varying vec2 vQ; varying float vDepth; varying vec2 vScreen;
      void main() {
        float z = texture2D(tDepth, vScreen).x * 2.0 - 1.0;
        float sceneD = 2.0 * uNearFar.x * uNearFar.y / (uNearFar.y + uNearFar.x - z * (uNearFar.y - uNearFar.x));
        float vis = vDepth < sceneD * 1.02 ? 1.0 : 0.0;
        vec2 q = vQ;
        float core = exp(-dot(q, q) * 60.0);
        float rays = exp(-abs(q.x) * 70.0) * exp(-abs(q.y) * 3.2) + exp(-abs(q.y) * 70.0) * exp(-abs(q.x) * 3.2);
        float diag = (exp(-abs(q.x - q.y) * 90.0) + exp(-abs(q.x + q.y) * 90.0)) * exp(-dot(q, q) * 9.0) * 0.35;
        float m = (core * 2.5 + rays + diag) * uAmp * vis;
        vec3 col = mix(vec3(0.62, 0.42, 1.0), vec3(1.0, 0.85, 0.45), core) * 6.0;
        gl_FragColor = vec4(col * m, 0.0);
      }`,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  return {
    overlay: [quad],
    update(t, c) {
      const k = (t - TIMES.glint) / 0.5;
      uniforms.uAmp.value = c.shot.id === 'aerial' ? Math.exp(-k * k) : 0;
      uniforms.uRot.value = (t - TIMES.glint) * 0.6;
      quad.visible = uniforms.uAmp.value > 0.003;
      uniforms.uNearFar.value.set(c.camera.near, c.camera.far);
    },
  };
}
