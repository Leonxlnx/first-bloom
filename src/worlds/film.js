// FIRST BLOOM — the film world. Assembles modules and drives them from the timeline.
import * as THREE from 'three';
import { U, ShadowSystem, worldMaterial } from '../world/common.js';
import { loadWorldData } from '../world/data.js';
import { createTerrain } from '../world/terrain.js';
import { TIMES, shotAt, bloomD, bloomWidth, sunAt, envAt, makeCameraRig } from '../world/timeline.js';
import { makeCameraRig as makeCameraRigV1 } from '../world/timeline_v1.js';
import { key, smoothstep, clamp01, lerp } from '../world/keys.js';

// optional modules: each file exports create(ctx) -> { objects?, overlay?, update?(t, ctx), preFrame?(t, ctx), post?(t, p) }
const MODULES = ['sky', 'vegetation', 'trees', 'hero', 'water', 'fx', 'glint'];

// finale grade (tuned with the aerial rig in the final round)
const AERIAL = { exposure: 0.80, contrast: 1.30, vignette: 0.42 };

const SKY_PLACEHOLDER = {
  vertexShader: /* glsl */`varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(position, 1.0); gl_Position = p.xyww; }`,
  fragmentShader: /* glsl */`varying vec3 vDir; void main(){ vec3 d = normalize(vDir); vec3 c = skyGradient(d); c += uSunColor * 30.0 * smoothstep(0.99985, 0.99995, dot(d, uSunDir)); gl_FragColor = vec4(c, 1.0); }`,
};

export async function createWorld({ engine, renderer, W, H, q }) {
  const data = await loadWorldData();
  const scene = new THREE.Scene();
  const overlay = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, W / H, 0.05, 60000);
  const rig = makeCameraRig(data);
  // Modules lay out vegetation, trees, clouds and lens tracks by sampling the camera path
  // at load. The final round changed only the pull-back and the aerial moves, so before
  // cut6 the load-time layout keeps the v1 path (frames that were not re-rendered stay
  // identical); per-frame calls and the aerial layout use the new rig.
  const rigV1 = makeCameraRigV1(data);
  let loading = true;
  const layoutRig = { ...rig, at: t => (loading && t < TIMES.cut6 ? rigV1 : rig).at(t) };
  const shadows = new ShadowSystem(renderer, 4096, 4096);
  const terrain = createTerrain(data);
  scene.add(terrain.mesh, terrain.patch);

  const only = q.get('only'); // e.g. only=terrain,sky for isolating modules
  const ctx = { THREE, scene, overlay, camera, renderer, engine, data, rig: layoutRig, U, TIMES, shotAt, bloomD, W, H, q, shot: null, t: 0 };
  const mods = [];
  for (const name of MODULES) {
    if (only && !only.split(',').includes(name)) continue;
    let mod;
    try { mod = await import(`../world/${name}.js`); } catch (e) { if (!String(e).includes('Failed to fetch') && !String(e).includes('404')) console.warn('module', name, e.message); continue; }
    const inst = await mod.create(ctx);
    if (inst.objects) inst.objects.forEach(o => scene.add(o));
    if (inst.overlay) inst.overlay.forEach(o => overlay.add(o));
    mods.push({ name, ...inst });
  }
  loading = false;
  if (!mods.find(m => m.name === 'sky')) {
    const { material } = worldMaterial({ ...SKY_PLACEHOLDER, depthWrite: false, depthTest: false, side: THREE.BackSide });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), material);
    sky.renderOrder = -10; sky.frustumCulled = false;
    scene.add(sky);
  }

  function applyEnv(t) {
    const env = envAt(t);
    U.uTime.value = t;
    U.uSunDir.value.copy(sunAt(t));
    U.uSunColor.value.setRGB(...env.sunCol).multiplyScalar(env.sunI);
    U.uSkyZenith.value.setRGB(...env.zenith);
    U.uSkyHorizon.value.setRGB(...env.horizon);
    U.uSkyAmbient.value.setRGB(...env.zenith).lerp(new THREE.Color().setRGB(...env.horizon), 0.55).multiplyScalar(env.ambient);
    U.uGroundBounce.value.setRGB(0.20, 0.22, 0.26).lerp(new THREE.Color(0.14, 0.2, 0.08), env.open).multiplyScalar(env.ambient * 0.6);
    U.uFogDensity.value = env.fogDensity;
    const sid = shotAt(t).id;
    U.uFogStart.value = { macro: 0, fpv: 60, canopy: 60, reveal: 200, falls: 300, aerial: 600 }[sid];
    U.uHaze.value = { macro: 0, fpv: 0.00002, canopy: 0.00003, reveal: 0.00006, falls: 0.00006, aerial: 0.00004 }[sid];
    // final-round gates: each is 0 outside the frames that get re-rendered
    U.uCreekFix.value = sid === 'fpv' ? smoothstep(TIMES.creek - 0.2, TIMES.creek + 0.15, t) * (1 - smoothstep(TIMES.sunBreak - 0.2, TIMES.sunBreak + 0.1, t)) : 0;
    U.uFarK.value = (sid === 'reveal' || sid === 'falls' || sid === 'aerial') ? 1 : 0;
    U.uBloomD.value = bloomD(t);
    U.uBloomWidth.value = bloomWidth(t);
    U.uBloomNoise.value = 1.2 + Math.max(0, bloomD(t)) * 0.012;
    return env;
  }

  const SHADOW = {
    macro: (c, t) => [{ center: c.focusPt, radius: lerp(0.35, 9, clamp01((t - TIMES.pullStart) / 0.9)), depth: 60, soft: 1.5 }, { center: c.focusPt, radius: 60, depth: 400, soft: 1 }],
    fpv: c => [{ center: c.focusPt, radius: 22, depth: 300, soft: 1.5 }, { center: c.focusPt, radius: 260, depth: 1200, soft: 1 }],
    canopy: c => [{ center: c.focusPt, radius: 40, depth: 300, soft: 1.5 }, { center: c.focusPt, radius: 300, depth: 1200, soft: 1 }],
    reveal: c => [{ center: c.focusPt, radius: 180, depth: 1500, soft: 1.2 }, { center: c.focusPt, radius: 1800, depth: 5000, soft: 1 }],
    falls: c => [{ center: c.focusPt, radius: 260, depth: 1500, soft: 1.2 }, { center: c.focusPt, radius: 1600, depth: 5000, soft: 1 }],
    aerial: c => [{ center: c.focusPt, radius: 1400, depth: 9000, soft: 1.0 }, { center: c.focusPt, radius: 4500, depth: 12000, soft: 1 }],
  };

  const world = {
    scene, overlay, camera,
    info: { modules: mods.map(m => m.name) },
    // engine clamps a frame's shutter to this window so no frame blends two shots
    shotWindow: t => { const s = shotAt(t); return [s.t0, s.t1 - 1e-4]; },
    preFrame(t, eng) {
      ctx.t = t; ctx.shot = shotAt(t);
      applyEnv(t);
      for (const m of mods) m.preFrame && m.preFrame(t, ctx);
    },
    update(t, sub) {
      ctx.t = t; ctx.shot = shotAt(t); ctx.sub = sub;
      U.uFrame.value = (sub?.sub ?? 0) + Math.round(t * 30) * 17;
      applyEnv(t);
      const c = rig.at(t);
      // look-dev override: ?cam=px,py,pz,tx,ty,tz,fov
      if (q.get('cam')) {
        const v = q.get('cam').split(',').map(Number);
        c.pos.set(v[0], v[1], v[2]); c.target.set(v[3], v[4], v[5]); if (v[6]) c.fov = v[6]; c.roll = 0;
        c.near = Math.max(0.05, c.pos.distanceTo(c.target) * 0.0005);
      }
      camera.position.copy(c.pos);
      camera.up.set(0, 1, 0);
      camera.lookAt(c.target);
      camera.rotateZ(c.roll || 0);
      camera.fov = c.fov; camera.near = c.near; camera.far = c.far;
      camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
      ctx.cam = c;
      for (const m of mods) m.update && m.update(t, ctx);
      // shadow cascades around a point a little in front of the camera
      const fwd = new THREE.Vector3(); camera.getWorldDirection(fwd);
      const shot = ctx.shot.id;
      const reach = { macro: 0.12, fpv: 12, canopy: 20, reveal: 150, falls: 300, aerial: 2500 }[shot];
      c.focusPt = camera.position.clone().addScaledVector(fwd, reach);
      if (shot === 'macro') c.focusPt.copy(rig.budHead);
      const [c0, c1] = SHADOW[shot](c, t);
      // shadows once per output frame (first subframe): within a half-shutter they don't move visibly
      if (!sub || !sub.sub) shadows.render(scene, c0, c1);
    },
    post(t) {
      const c = rig.at(t);
      const shot = shotAt(t).id;
      const fast = shot === 'canopy' || (shot === 'fpv' && t > TIMES.sunBreak + 0.8);
      const p = {
        // DOF only where it is meaningful (macro, falls/aerial focus pulls); the fast low
        // shots get their softness from true motion blur
        focus: c.focus, cocK: (shot === 'fpv' || shot === 'canopy') ? 0 : c.cocK, maxCoc: shot === 'macro' ? 70 : 30,
        // aerial is gated by shot (not new keys: key() is monotone cubic and would bend reveal/falls)
        exposure: shot === 'aerial' ? AERIAL.exposure : key([[0, 0.7], [TIMES.firstLight - 0.3, 0.74], [TIMES.firstLight + 0.9, 0.9], [TIMES.hit, 1.0], [TIMES.cut2, 0.92], [13.8, 0.95], [14.6, 1.12], [TIMES.cut3, 1.12], [TIMES.cut4, 0.74], [TIMES.end, 0.76]], t),
        shutter: shot === 'canopy' ? 0.3 : 0.5,
        // black point by shot: bright hazy daylight shots get more, the backlit grove approach much less
        blackPoint: { macro: 0.07, fpv: lerp(0.06, 0.0, smoothstep(13.8, 14.6, t)), canopy: 0.02, reveal: 0.11, falls: 0.12, aerial: 0.11 }[shot], shoulder: 0.88,
        paint: fast ? 0.5 : 1.0,
        saturation: key([[0, 1.05], [TIMES.hit, 1.14], [TIMES.cut4, 1.12], [TIMES.rainbow, 1.18], [TIMES.end, 1.15]], t),
        vibrance: 0.22, contrast: shot === 'macro' ? 1.26 : shot === 'aerial' ? AERIAL.contrast : 1.24,
        bloomStrength: 0.022,
        // warm highlights only once spring light arrives (keeps the violet blue-leaning in the macro)
        shadowTint: [0.88, 0.9, 1.14], highTint: [1.06, 1.0, 0.9], splitAmt: shot === 'macro' ? 0.1 : 0.3,
        lift: [-0.008, -0.008, 0.002],
        fade: Math.max(1 - smoothstep(0.0, 0.9, t), smoothstep(TIMES.fadeOut, TIMES.end - 0.05, t)),
        fadeColor: [0, 0, 0],
        grain: 0.03, vignette: shot === 'aerial' ? AERIAL.vignette : 0.32,
        // lens: flare ghosts + anamorphic streak (strong on the dawn sun and the sun break)
        flare: shot === 'macro' ? 0.3 : shot === 'fpv' ? 0.06 + 0.24 * smoothstep(TIMES.sunBreak - 0.2, TIMES.sunBreak + 0.5, t) : shot === 'canopy' ? 0.0 : 0.05,
        streak: shot === 'macro' ? 0.35 : shot === 'fpv' ? 0.1 + 0.25 * smoothstep(TIMES.sunBreak - 0.2, TIMES.sunBreak + 0.5, t) : shot === 'canopy' ? 0.0 : 0.08,
        flareThresh: 6.0,
      };
      // snow white-out into the reveal: builds behind the fx snow puffs, a fully opaque
      // white hold straddles the hidden 16.79 cut, then clears on the music's arrival
      // (fx drives the build/clear with lens snow; core adds a light veil and the hold)
      const hold = smoothstep(TIMES.cut4 - 0.10, TIMES.cut4 - 0.07, t) * (1 - smoothstep(TIMES.cut4 + 0.07, TIMES.cut4 + 0.10, t));
      const veil = t < TIMES.cut4 ? 0.3 * smoothstep(TIMES.whiteout + 0.1, TIMES.cut4 - 0.07, t) : 0.35 * (1 - smoothstep(TIMES.cut4 + 0.07, TIMES.arrival, t));
      const wo = Math.max(hold, veil);
      if (wo > p.fade) { p.fade = wo; p.fadeColor = [0.93, 0.95, 1.0]; }
      for (const m of mods) if (m.post) Object.assign(p, m.post(t, p, ctx) || {});
      // look-dev override: ?post=contrast:1.2,saturation:1.3
      if (q.get('post')) for (const kv of q.get('post').split(',')) { const [k, v] = kv.split(':'); if (k in p) p[k] = +v; }
      return p;
    },
  };
  return world;
}
