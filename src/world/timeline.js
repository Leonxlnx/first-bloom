// The film's single source of timing: shot boundaries, sync events, the bloom
// wave clock D(t), sun/sky/fog keys and per-shot camera rigs.
// Times are snapped to the music edit before the final render (see TIMES).
import * as THREE from 'three';
import * as L from './layout.js';
import { key, keyLinear, smoothstep, lerp, easeInOut, easeOut, shake, clamp01 } from './keys.js';

// Snapped to the music edit (audio/edit/edit_1.wav, "The Light Between Moments"):
// piano motif 3.03, silence 5.18, tutti hit 6.00 then a 0.507 s beat grid,
// F7 swell 16.79 -> bright arrival 17.31 (0.433 s grid), accent 20.72,
// descent 23.70, final Bb chord 25.50, ring-out and fade 27.6-30.
export const TIMES = {
  firstLight: 3.03, held: 5.18, hit: 6.0, pullStart: 6.7,
  cut2: 7.52,       // FPV wavefront (beat)
  creek: 9.55, catchUp: 11.58, sunBreak: 12.09, swift: 14.16,
  cut3: 15.4,       // canopy pull-up (suspension begins)
  whiteout: 16.4,
  cut4: 16.79,      // basin reveal (swell; white-out clears on the 17.31 arrival)
  arrival: 17.31,
  cut5: 20.72,      // waterfall shatter (accent)
  rainbow: 21.21,
  cut6: 23.7,       // aerial (descent)
  resolve: 25.5, glint: 27.5, fadeOut: 29.0, end: 30.0,
};

export const SHOTS = [
  { id: 'macro', start: 0, end: () => TIMES.cut2 },
  { id: 'fpv', start: () => TIMES.cut2, end: () => TIMES.cut3 },
  { id: 'canopy', start: () => TIMES.cut3, end: () => TIMES.cut4 },
  { id: 'reveal', start: () => TIMES.cut4, end: () => TIMES.cut5 },
  { id: 'falls', start: () => TIMES.cut5, end: () => TIMES.cut6 },
  { id: 'aerial', start: () => TIMES.cut6, end: () => TIMES.end + 1 },
];
const val = v => (typeof v === 'function' ? v() : v);
export function shotAt(t) {
  for (const s of SHOTS) if (t >= val(s.start) && t < val(s.end)) return { id: s.id, t0: val(s.start), t1: val(s.end), local: t - val(s.start) };
  return { id: 'aerial', t0: TIMES.cut6, t1: TIMES.end, local: t - TIMES.cut6 };
}

// ---------------- bloom wave clock (arrival units ~ metres of effort)
export function bloomD(t) {
  const T = TIMES;
  if (t < T.hit) return -10;
  // FPV section solved from desired front offsets (out/fpvarr.mjs): front ~9 m
  // ahead -> camera overtakes at the creek -> front catches up and passes under
  // the lens on the sun break -> races ahead to the grove during the canopy climb
  return key([
    [T.hit, 0], [T.pullStart, 2.5], [T.cut2, 20.8], [8.02, 31.5], [8.52, 43.7], [9.02, 54], [9.52, 58.5],
    [10.02, 60.6], [10.52, 62.8], [11.02, 65.9], [11.52, 71.7], [12.02, 81.8], [12.52, 97.4], [13.02, 112.5],
    [13.52, 128.5], [14.02, 143.3], [14.5, 155], [T.cut3, 166], [16.0, 185], [T.whiteout, 205], [T.cut4, 225],
    [T.cut4 + 1.0, 340], [T.cut5, 1270], [T.cut6, 1950], [T.resolve, 5200], [T.end, 7500],
  ], t);
}
export function bloomWidth(t) { return 2.5 + Math.max(0, bloomD(t)) * 0.035; }

// ---------------- environment keys
const DEG = Math.PI / 180;
function sunVec(azDeg, elDeg) { // az: angle in x/z plane (dir(phi) convention), el: elevation
  const a = azDeg * DEG, e = elDeg * DEG;
  return new THREE.Vector3(Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e));
}
export function sunAt(t) {
  const T = TIMES;
  const az = key([[0, 22.5], [T.cut2, 26], [T.cut3, 38], [T.cut4, 50], [T.cut5, 52], [T.cut6, 44], [T.end, 42]], t);
  // the ESE rim saddle stands ~7.9 deg above the knoll: the sun clears it at firstLight
  const el = key([[0, 6.0], [T.firstLight, 8.4], [T.hit, 9.4], [T.cut2, 10.2], [T.sunBreak, 12], [T.cut3, 15], [T.cut4, 18], [T.cut5, 22], [T.cut6, 31], [T.end, 34]], t);
  // falls shot: hold the sun ~40 deg off the camera-to-falls axis (behind the camera), el 24, so the
  // base plume (water.js computes the bow around -sunDir)
  const hold = smoothstep(T.cut5 - 0.02, T.cut5, t) * (1 - smoothstep(T.cut6 - 0.02, T.cut6, t));
  const bowAz = L.WATERFALL.phi / DEG - 139.5;   // = 153 for falls at 292.5 (93 when they were at 232.5)
  return sunVec(lerp(az, bowAz, hold), lerp(el, 24, hold));
}
const C = hex => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; }; // three converts hex (sRGB) -> linear
export function envAt(t) {
  const T = TIMES;
  // spring factor of the sky (overcast lavender -> deep cyan), opens after the sun breaks
  const open = smoothstep(T.sunBreak - 0.2, T.cut4 + 2.5, t);
  const dawn = smoothstep(T.firstLight - 1.0, T.hit + 1.0, t);
  const zenith = key([[0, C('#262B55')], [T.hit, C('#3A3F78')], [T.cut2, C('#8E88C2')], [T.sunBreak, C('#7F8CCB')], [T.cut4, C('#2486D6')], [T.end, C('#1E8FD8')]], t);
  const horizon = key([[0, C('#8F87C4')], [T.hit, C('#B5A6D6')], [T.cut2, C('#CBC4E6')], [T.sunBreak, C('#D3D3EC')], [T.cut4, C('#BFE9F5')], [T.end, C('#BFE9F5')]], t);
  const sunCol = key([[0, [1.0, 0.55, 0.35]], [T.firstLight, [1.0, 0.62, 0.32]], [T.hit, [1.0, 0.72, 0.42]], [T.cut2, [1.0, 0.80, 0.55]], [T.sunBreak, [1.0, 0.86, 0.62]], [T.cut4, [1.0, 0.91, 0.72]], [T.end, [1.0, 0.93, 0.78]]], t);
  const sunI = key([[0, 0.0], [T.firstLight - 0.3, 0.05], [T.firstLight + 0.8, 2.2], [T.hit, 3.0], [T.cut2, 1.6], [T.sunBreak - 0.1, 1.5], [T.sunBreak + 0.6, 4.2], [T.cut4, 4.6], [T.end, 4.8]], t);
  const ambient = key([[0, 0.55], [T.hit, 0.65], [T.cut2, 0.9], [T.sunBreak, 0.85], [14.0, 0.9], [14.8, 1.3], [T.cut3, 1.3], [T.cut4, 0.9], [T.cut6, 1.05], [T.end, 1.05]], t);
  const fogDensity = key([[0, 0.0011], [T.cut2, 0.0005], [T.sunBreak, 0.0003], [T.cut4, 0.00008], [T.cut5, 0.00007], [T.cut6, 0.00005], [T.end, 0.00005]], t);
  return { open, dawn, zenith, horizon, sunCol, sunI, ambient, fogDensity };
}

// ---------------- cameras
// heightAt and arrivalAt come from the loaded world data.
export function makeCameraRig(data) {
  const H = data.heightAt;
  const budBase = new THREE.Vector3(0, H(0, 0), 0);
  const budHead = budBase.clone().add(new THREE.Vector3(0, 0.105, 0));
  const P = (r, deg) => [Math.cos(deg * DEG) * r, Math.sin(deg * DEG) * r];

  // FPV path (ground plan); heights from terrain + clearance keys
  const fpvPlan = [P(14, 21), P(40, 22.5), P(75, 22), P(110, 24), P(140, 27), P(170, 33), P(195, 42), P(212, 50), P(222, 55)];
  const fpvCurve = new THREE.CatmullRomCurve3(fpvPlan.map(([x, z]) => new THREE.Vector3(x, 0, z)), false, 'centripetal');
  // canopy climb continues over the grove
  const grovePlan = [P(205, 52), P(222, 55), P(240, 56), P(262, 55.5), P(290, 55)];
  const groveCurve = new THREE.CatmullRomCurve3(grovePlan.map(([x, z]) => new THREE.Vector3(x, 0, z)), false, 'centripetal');

  // the ESE creek (petal midvein) as an arclength-parametrised path for the creek ride
  const creekPts = L.CREEKS[0].slice().reverse();            // inner end (r~90) -> petal tip
  const creekS = [0];
  for (let i = 1; i < creekPts.length; i++) creekS.push(creekS[i - 1] + Math.hypot(creekPts[i][0] - creekPts[i - 1][0], creekPts[i][1] - creekPts[i - 1][1]));
  const creekR0 = Math.hypot(creekPts[0][0], creekPts[0][1]);
  const creekAt = s => {                                        // point + tangent at arclength s
    let i = 0; while (i < creekPts.length - 2 && creekS[i + 1] < s) i++;
    const [ax, az] = creekPts[i], [bx, bz] = creekPts[i + 1], l = creekS[i + 1] - creekS[i];
    const tx = (bx - ax) / l, tz = (bz - az) / l, u = s - creekS[i];
    return { x: ax + tx * u, z: az + tz * u, tx, tz };
  };

  const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();
  const out = { pos: new THREE.Vector3(), target: new THREE.Vector3(), fov: 40, roll: 0, near: 0.05, far: 60000, focus: 10, cocK: 0 };

  function macro(t) {
    const T = TIMES;
    // look up at the bud against the dawn sky; the sun (fixed reference at the
    // hit) sits ~3 deg right of the bud head so it peeks out beside it
    const sd = sunAt(T.hit).clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), 3.2 * DEG);
    const toSun = new THREE.Vector3(sd.x, 0, sd.z).normalize();
    const push = key([[0, 0.135], [T.held, 0.126], [T.hit, 0.126]], Math.min(t, T.hit));
    const pull = easeInOut(clamp01((t - T.pullStart) / (T.cut2 - T.pullStart)));
    const pullE = Math.pow(pull, 1.6);
    const dist = lerp(push, 6.5, pullE);
    // pull-back stays fairly low and level (no tiny-planet look): the expanding
    // ring of spring reads against the snow beyond
    const lift = lerp(-dist * Math.tan(7.5 * DEG), 2.6, Math.pow(pull, 1.7));
    out.pos.copy(budHead).addScaledVector(toSun, -dist); out.pos.y += lift;
    // side drift + micro jitter
    const side = new THREE.Vector3(-toSun.z, 0, toSun.x);
    // drift and look-ahead ease in late (pow): the camera is only ~0.13 m from the bud
    // when the dolly starts, so linear terms swung the view ~20 deg in 2 frames.
    // pull = 0 / 1 give the same pose as before (bud frames and the cut2 framing unchanged)
    out.pos.addScaledVector(side, 0.004 * Math.sin(t * 0.7) + Math.pow(pull, 2.0) * 1.2);
    out.target.copy(budHead).addScaledVector(new THREE.Vector3(0, 1, 0), lerp(0.002, -0.05, pull)).addScaledVector(toSun, Math.pow(pull, 2.5) * 3.0);
    const sk = shake(t, 1); const hitShake = Math.exp(-Math.max(0, t - T.hit) * 9) * (t >= T.hit ? 1 : 0);
    out.target.x += (sk[0] * 0.00015 + sk[0] * hitShake * 0.0012); out.target.y += sk[1] * 0.00015 + sk[1] * hitShake * 0.0012;
    out.fov = lerp(22, 42, easeInOut(pull));
    out.near = lerp(0.004, 0.08, pull); out.far = 60000;
    out.roll = 0;
    // focus on the bud from the first frame (the scroll-stopper), a slight breath of
    // focus drift at first light
    out.focus = lerp(dist * (1 + 0.04 * Math.sin(clamp01((t - T.firstLight) / 1.2) * Math.PI)), out.pos.distanceTo(budHead), pull);
    out.cocK = lerp(80, 6, easeOut(pull));
    return out;
  }

  function fpv(t) {
    const T = TIMES;
    // progress along path (fraction) — speed ~30 m/s, slowing to ~20
    const u = key([[T.cut2, 0.0], [T.creek, 0.28], [T.catchUp, 0.50], [T.sunBreak, 0.565], [T.cut3, 0.93], [T.cut3 + 0.2, 0.95]], t);
    fpvCurve.getPointAt(clamp01(u), tmp);
    const ahead = fpvCurve.getPointAt(clamp01(u + 0.03), tmp2.clone());
    const clear = key([[T.cut2, 1.2], [T.creek - 0.4, 1.0], [T.creek + 0.3, 0.45], [T.catchUp, 0.4], [T.sunBreak, 0.9], [T.sunBreak + 1.4, 2.5], [T.cut3, 2.3]], t);
    out.pos.set(tmp.x, H(tmp.x, tmp.z) + clear, tmp.z);
    const sk = shake(t * 1.4, 3);
    out.pos.x += sk[0] * 0.05; out.pos.y += sk[1] * 0.04; out.pos.z += sk[2] * 0.05;
    // the sun break: tilt up and yaw a touch right so the sun tears through the clouds in the
    // upper-left third (12.1-13.3), then settle back to the meadow
    const pitch = key([[T.cut2, -4], [T.creek, -7], [T.catchUp, -5], [T.sunBreak - 0.1, 0], [T.sunBreak + 0.45, 3], [T.sunBreak + 0.8, 3], [13.3, -1], [T.cut3, -1]], t) * DEG;
    const yawOff = key([[T.catchUp, 0], [T.sunBreak, 0], [T.sunBreak + 0.45, 12], [T.sunBreak + 0.8, 12], [13.4, 0]], t) * DEG;
    const dir = new THREE.Vector3(ahead.x - tmp.x, 0, ahead.z - tmp.z).normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), -yawOff);
    out.target.copy(out.pos).add(dir.multiplyScalar(10)); out.target.y += Math.tan(pitch) * 10;
    // bank from curvature
    const a0 = fpvCurve.getTangentAt(clamp01(u)), a1 = fpvCurve.getTangentAt(clamp01(u + 0.02));
    const turn = Math.atan2(a0.x * a1.z - a0.z * a1.x, a0.x * a1.x + a0.z * a1.z);
    out.roll = THREE.MathUtils.clamp(turn * 3, -0.07, 0.07) + sk[2] * 0.008;
    out.fov = 62; out.near = 0.05; out.far = 60000;
    out.focus = 6; out.cocK = 2.5;
    // THE WRONG REFLECTION: ride the ESE creek just above its water (water.js keeps
    // it at bed + 0.5), keeping the rig's pace along the lobe
    const w = smoothstep(T.creek - 0.25, T.creek + 0.25, t) * (1 - smoothstep(T.catchUp + 0.17, T.catchUp + 0.67, t));
    if (w > 0) {
      const sC = Math.hypot(out.pos.x, out.pos.z) - creekR0;
      const a = creekAt(sC), b = creekAt(sC + 10);
      const px = a.x - a.tz * 0.7, pz = a.z + a.tx * 0.7;
      const py = Math.max(H(px, pz) + 0.3, H(a.x, a.z) + 1.0);
      const cdir = new THREE.Vector3(b.x - px, 0, b.z - pz).normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), -6 * DEG);
      const rigLook = out.target.clone().sub(out.pos).normalize().multiplyScalar(10);
      const creekLook = cdir.multiplyScalar(10); creekLook.y = Math.tan(-6 * DEG) * 10;
      out.pos.set(lerp(out.pos.x, px, w), lerp(out.pos.y, py, w), lerp(out.pos.z, pz, w));
      out.target.copy(out.pos).add(rigLook.lerp(creekLook, w));
      out.roll *= 1 - 0.6 * w;
    }
    return out;
  }

  function canopy(t) {
    const T = TIMES;
    const u = key([[T.cut3, 0.0], [T.cut4, 1.0]], t);
    groveCurve.getPointAt(clamp01(u), tmp);
    const ground = H(tmp.x, tmp.z);
    const clear = key([[T.cut3, 2.3], [T.cut3 + 0.6, 15], [T.cut4, 19]], t);
    out.pos.set(tmp.x, ground + clear, tmp.z);
    const sk = shake(t * 1.6, 5);
    out.pos.x += sk[0] * 0.06; out.pos.y += sk[1] * 0.05;
    const dir = groveCurve.getTangentAt(clamp01(Math.min(u + 0.05, 1)));
    const pitch = key([[T.cut3, 5], [T.cut3 + 0.35, 25], [T.cut3 + 0.8, 4], [T.cut4, -2]], t) * DEG;
    out.target.copy(out.pos).add(new THREE.Vector3(dir.x, 0, dir.z).normalize().multiplyScalar(10)); out.target.y += Math.tan(pitch) * 10;
    out.roll = sk[2] * 0.015; out.fov = 64; out.near = 0.05; out.far = 60000; out.focus = 8; out.cocK = 2;
    return out;
  }

  function reveal(t) {
    const T = TIMES;
    const s = clamp01((t - T.cut4) / (T.cut5 - T.cut4));
    // crane reveal: start just above/behind the grove crowns looking NW (crowns fill
    // the foreground), rise over them as the basin, lake and falls open up
    const G = new THREE.Vector3(Math.cos(125 * DEG) * 600, 0, Math.sin(125 * DEG) * 600);
    const dir = new THREE.Vector3(L.WATERFALL.x - G.x, 0, L.WATERFALL.z - G.z).normalize();
    const start = G.clone().addScaledVector(dir, -30);
    const yaw0 = Math.atan2(dir.z, dir.x) + 4 * DEG, yaw = yaw0 - 8 * DEG * easeInOut(s);
    const fwd = 68 * easeInOut(Math.min(1, s * 1.1));
    out.pos.copy(start).addScaledVector(dir, fwd);
    const alt = lerp(20, 95, easeInOut(Math.pow(s, 0.8)));
    out.pos.y = H(G.x, G.z) + alt;
    const pitch = lerp(-3.5, -5.5, easeInOut(s)) * DEG;
    out.target.set(out.pos.x + Math.cos(yaw) * 100, out.pos.y + Math.tan(pitch) * 100, out.pos.z + Math.sin(yaw) * 100);
    const sk = shake(t * 0.6, 7); out.pos.y += sk[1] * 0.3;
    out.roll = sk[2] * 0.004; out.fov = lerp(55, 45, easeInOut(s)); out.near = 0.3; out.far = 60000; out.focus = 500; out.cocK = 0;
    return out;
  }

  function falls(t) {
    const T = TIMES;
    const s = clamp01((t - T.cut5) / (T.cut6 - T.cut5));
    // ~900 m out in the basin, a touch off-axis: the whole cirque, falls, plume,
    // river winding through the forest below, peaks above
    const wr = L.WATERFALL.r, phi = L.WATERFALL.phi;
    const camR = wr - lerp(910, 880, s);
    const side = -4.5 * DEG;
    out.pos.set(Math.cos(phi + side) * camR, 0, Math.sin(phi + side) * camR);
    out.pos.y = H(out.pos.x, out.pos.z) + lerp(68, 72, s);
    out.target.set(Math.cos(phi) * (wr - 6), lerp(150, 158, s), Math.sin(phi) * (wr - 6));
    const sk = shake(t * 0.5, 9); out.target.x += sk[0] * 0.3; out.target.y += sk[1] * 0.25;
    // 8% push-in, accelerating slightly after the burst
    out.roll = 0; out.fov = lerp(24, 22.1, Math.pow(s, 0.8)); out.near = 1; out.far = 60000; out.focus = 900; out.cocK = 0;
    return out;
  }

  // high aerial along the river "stem" (SSW outlet gorge, low rim) looking back
  // NNE: the stem leads the eye into the giant flower; falls + peaks beyond
  function aerial(t) {
    // never static: a continuous rise + pull-back with a slow ~10 deg orbit and a
    // tilt-up that brings the horizon, peaks and sky into the top quarter; the
    // flower ends ~half the frame wide, lower-centre, the river stem from the bottom
    const T = TIMES;
    const u = clamp01((t - T.cut6) / (T.end - T.cut6));
    const s = 1 - Math.pow(1 - u, 2.2);                       // long ease-out, still moving at the end
    const orbit = (112.5 + lerp(-4, 6, easeInOut(u))) * DEG;
    // final round: shorter pull-back / rise and less tilt-up, so the flower stays large
    // (~56% of frame width at the end) and the busy rim peaks stay out of frame
    // (start pose at cut6 unchanged)
    const back = lerp(1450, 2300, s), alt = lerp(1300, 1480, s);
    out.pos.set(Math.cos(orbit) * back, alt, Math.sin(orbit) * back);
    const pitch = lerp(-44, -27, Math.pow(s, 0.9)) * DEG;
    const look = new THREE.Vector3(-Math.cos(orbit), 0, -Math.sin(orbit)).applyAxisAngle(new THREE.Vector3(0, 1, 0), lerp(2, -1.5, s) * DEG);
    out.target.copy(out.pos).addScaledVector(look, 1000); out.target.y += Math.tan(pitch) * 1000;
    out.roll = lerp(-0.012, 0.0, s); out.fov = lerp(50, 47, s); out.near = 2; out.far = 80000; out.focus = 3000; out.cocK = 0;
    return out;
  }

  const rigs = { macro, fpv, canopy, reveal, falls, aerial };
  return { budBase, budHead, fpvCurve, groveCurve, at: t => rigs[shotAt(t).id](t) };
}
