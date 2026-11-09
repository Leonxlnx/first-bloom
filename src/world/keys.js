// Keyframe helpers. keys = [[t, value], ...] sorted by t; value: number | array.
// Interpolation is monotone cubic (Fritsch-Carlson) per component, so curves
// pass through keys without overshoot — good for cameras and timing curves.
export const clamp01 = x => Math.min(1, Math.max(0, x));
export const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
export const lerp = (a, b, t) => a + (b - a) * t;
export const easeInOut = t => t * t * (3 - 2 * t);
export const easeOut = t => 1 - Math.pow(1 - t, 3);
export const easeIn = t => t * t * t;

function monotone1(ts, vs, t) {
  const n = ts.length;
  if (t <= ts[0]) return vs[0];
  if (t >= ts[n - 1]) return vs[n - 1];
  let i = 0; while (t > ts[i + 1]) i++;
  const h = ts[i + 1] - ts[i], d = (vs[i + 1] - vs[i]) / h;
  const slope = k => {
    if (k === 0 || k === n - 1) return (vs[Math.min(k + 1, n - 1)] - vs[Math.max(k - 1, 0)]) / (ts[Math.min(k + 1, n - 1)] - ts[Math.max(k - 1, 0)]) * 0.5;
    const d0 = (vs[k] - vs[k - 1]) / (ts[k] - ts[k - 1]), d1 = (vs[k + 1] - vs[k]) / (ts[k + 1] - ts[k]);
    if (d0 * d1 <= 0) return 0;
    return 3 * (ts[k + 1] - ts[k - 1]) / ((2 * ts[k + 1] - ts[k] - ts[k - 1]) / d0 + (ts[k + 1] + ts[k] - 2 * ts[k - 1]) / d1);
  };
  let m0 = slope(i), m1 = slope(i + 1);
  if (d === 0) { m0 = 0; m1 = 0; }
  const s = (t - ts[i]) / h, s2 = s * s, s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * vs[i] + (s3 - 2 * s2 + s) * h * m0 + (-2 * s3 + 3 * s2) * vs[i + 1] + (s3 - s2) * h * m1;
}

export function key(keys, t) {
  const ts = keys.map(k => k[0]);
  const v0 = keys[0][1];
  if (typeof v0 === 'number') return monotone1(ts, keys.map(k => k[1]), t);
  return v0.map((_, c) => monotone1(ts, keys.map(k => k[1][c]), t));
}

// linear (for step-like data)
export function keyLinear(keys, t) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 0; i < keys.length - 1; i++) {
    const [t0, a] = keys[i], [t1, b] = keys[i + 1];
    if (t <= t1) {
      const u = (t - t0) / (t1 - t0);
      return typeof a === 'number' ? lerp(a, b, u) : a.map((x, c) => lerp(x, b[c], u));
    }
  }
  return keys[keys.length - 1][1];
}

// smooth deterministic camera shake (sum of sines), amplitude-scaled
export function shake(t, seed = 0) {
  const f = (a, b, c) => Math.sin(t * a + seed * 1.3 + c) * 0.6 + Math.sin(t * b + seed * 2.1 + c * 1.7) * 0.4;
  return [f(7.3, 13.1, 0.0), f(6.1, 11.7, 2.0), f(5.3, 9.1, 4.0)];
}
