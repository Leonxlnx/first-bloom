// Loads the baked world data (see bake.mjs) and exposes textures + samplers.
import * as THREE from 'three';
import * as L from './layout.js';
import { U } from './common.js';

async function f32(url) { const r = await fetch(url); if (!r.ok) throw new Error('missing ' + url + ' (run node bake.mjs)'); return new Float32Array(await r.arrayBuffer()); }

function tex(data, w, h, format, filter) {
  const t = new THREE.DataTexture(data, w, h, format, THREE.FloatType);
  t.minFilter = t.magFilter = filter; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false; t.needsUpdate = true;
  return t;
}

export async function loadWorldData() {
  const meta = await (await fetch('/data/meta.json')).json();
  const [H, far, near, info, info2, patch] = await Promise.all([
    f32('/data/terrain_h.f32'), f32('/data/arrival_far.f32'), f32('/data/arrival_near.f32'), f32('/data/info_far.f32'), f32('/data/info2_far.f32'), f32('/data/patch_falls.f32'),
  ]);
  const PATCH = meta.PATCH;
  const patchTex = tex(patch, PATCH.n, PATCH.n, THREE.RedFormat, THREE.NearestFilter);
  const N = L.GRID.N;
  const { FAR, NEAR } = meta;
  const heightTex = tex(H, N, N, THREE.RedFormat, THREE.NearestFilter);
  const arrFar = tex(far, FAR.nx, FAR.nz, THREE.RedFormat, THREE.LinearFilter);
  const arrNear = tex(near, NEAR.nx, NEAR.nz, THREE.RedFormat, THREE.LinearFilter);
  const infoTex = tex(info, FAR.nx, FAR.nz, THREE.RGBAFormat, THREE.LinearFilter);
  const info2Tex = tex(info2, FAR.nx, FAR.nz, THREE.RGBAFormat, THREE.LinearFilter);
  U.tArrival.value = arrFar;
  U.uArrivalBounds.value.set(FAR.minX, FAR.minZ, FAR.sizeX, FAR.sizeZ);
  U.tArrivalNear.value = arrNear;
  U.uArrivalNearBounds.value.set(NEAR.minX, NEAR.minZ, NEAR.sizeX, NEAR.sizeZ);
  U.tInfo.value = infoTex; U.tInfo2.value = info2Tex;
  U.uInfoBounds.value.set(FAR.minX, FAR.minZ, FAR.sizeX, FAR.sizeZ);
  const heightAt = L.makeSampler(H);
  const sampleGrid = (D, G, x, z) => {
    const fx = (x - G.minX) / G.sizeX * G.nx - 0.5, fz = (z - G.minZ) / G.sizeZ * G.nz - 0.5;
    const i = Math.max(0, Math.min(G.nx - 2, Math.floor(fx))), j = Math.max(0, Math.min(G.nz - 2, Math.floor(fz)));
    const u = Math.min(1, Math.max(0, fx - i)), v = Math.min(1, Math.max(0, fz - j));
    const a = D[j * G.nx + i], b = D[j * G.nx + i + 1], c = D[(j + 1) * G.nx + i], d = D[(j + 1) * G.nx + i + 1];
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  };
  // CPU-side arrival (same blend as the GLSL arrival())
  const arrivalAt = (x, z) => {
    const nu = (x - NEAR.minX) / NEAR.sizeX, nv = (z - NEAR.minZ) / NEAR.sizeZ;
    const fa = sampleGrid(far, FAR, x, z);
    if (nu > 0.02 && nu < 0.98 && nv > 0.02 && nv < 0.98) {
      const w = Math.min(1, Math.min(nu - 0.02, 0.98 - nu, nv - 0.02, 0.98 - nv) / 0.08);
      return fa + (sampleGrid(near, NEAR, x, z) - fa) * w;
    }
    return fa;
  };
  return { meta, H, heightTex, patchTex, PATCH, heightAt, arrivalAt, info, FAR, NEAR, sampleInfo: (x, z, ch) => {
    const fx = Math.floor((x - FAR.minX) / FAR.sizeX * FAR.nx), fz = Math.floor((z - FAR.minZ) / FAR.sizeZ * FAR.nz);
    if (fx < 0 || fz < 0 || fx >= FAR.nx || fz >= FAR.nz) return 0;
    return info[(fz * FAR.nx + fx) * 4 + ch];
  } };
}
