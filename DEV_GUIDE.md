# FIRST BLOOM: developer guide for module builders

This is a 30-second, 16:9, 4K painterly nature film. It is rendered offline, frame by frame, in three.js (r187, WebGL2) inside headless Chrome on an **AMD Radeon 780M iGPU**. The full creative brief is in `CONCEPT.json`; read the shots that touch your module.

## The look
Painterly "anime-realism": think Ghibli or Makoto Shinkai crossed with stylised 3D.
- The image is clean and dense with detail.
- Sunlight is strong, colour is saturated but tasteful, and atmospheric depth is deep.
- The whole image goes through an anisotropic Kuwahara paint filter, so shapes should read as bold, clean masses with crisp light/shadow separation.
- Noisy micro-detail turns to mush under the filter.
- Never pink or magenta; the reference has a hot-pink tree, so we avoid that.

## Palette
These are sRGB values. In GLSL use `s2l()` / the `C_*` defines from `src/world/terrain.js` (`PALETTE_GLSL`).

**Winter:**
| Element | Colour |
|---|---|
| Blue-hour indigo sky | #262B55 |
| Lavender haze | #8F87C4 |
| Snow in shadow (periwinkle) | #A9B4E0 |
| Rime highlight | #E8F1FF |
| Dawn gold | #FFC873 |

**Hero flower:**
| Element | Colour |
|---|---|
| Violet | #7B4FD6 |
| Backlit glow | #B48CFF |
| Silver hairs | #E6E9F5 |
| Gold stamens and pollen | #FFC42E |

**Spring:**
| Element | Colour |
|---|---|
| Deep cyan zenith | #1E8FD8 |
| Pale cyan horizon | #BFE9F5 |
| Cumulus white | #FFF8EC |
| Cumulus shadow (lavender) | #B9B2E0 |
| Emerald | #2FA35A |
| Backlit chartreuse | #A8DC4A |
| Forest viridian | #1F6B45 |
| Poppy red-orange (flower heads only) | #F2552C |
| Buttercup gold | #FFD23A |
| Cobalt | #2C5BD8 |
| Daisy white | #F7F5EE |
| Water turquoise | #36C2C9 |
| Glitter | #FFF1C2 |

## Files
| File | What it does |
|---|---|
| `render.mjs` | CLI that renders frames (details below). |
| `src/engine.js` | Subframe accumulation (AA plus true motion blur), then paint, DOF, particle overlay, bloom, AgX grade and finish. Do not edit. |
| `src/world/common.js` | `U` (shared uniforms), `WORLD_GLSL` (prelude injected into every world shader), `worldMaterial()`, `castShadow()`, `ShadowSystem`, `rng(seed)`. Do not edit. |
| `src/world/layout.js` | Pure-JS world layout: basin, knoll, six petal axes (`LOBES`), `petalSD`, `RIVER`, `CREEKS`, `LAKE`, `WATERFALL`, `GROVE`, `height()`, `forestMask()`. Do not edit. |
| `src/world/data.js` | Baked data loader: `data.heightAt(x, z)` (exact terrain height; use it for placement), `data.arrivalAt(x, z)` (bloom arrival on the CPU), `data.sampleInfo`. |
| `src/world/timeline.js` | `TIMES` (sync points), `shotAt(t)`, `bloomD(t)`, `sunAt`, `envAt`, and the camera rigs `makeCameraRig(data).at(t)` → `{pos, target, fov, near, far, focus, cocK}`. Do not edit; read it to know where the camera is. |
| `src/world/terrain.js` | Terrain mesh and shader, plus `PALETTE_GLSL`. Do not edit. |
| `src/worlds/film.js` | Assembles everything. It imports optional modules `src/world/{sky,vegetation,trees,hero,water,fx}.js`. Do not edit. |

## Module contract (your deliverable is one file: `src/world/<name>.js`)
```js
export async function create(ctx) {
  // ctx: { THREE, scene, overlay, camera, renderer, engine, data, rig, U, TIMES, shotAt, bloomD, W, H, q }
  return {
    objects: [...],          // added to the main scene (opaque / alpha-tested, painted by Kuwahara)
    overlay: [...],          // optional: added to the OVERLAY scene (particles/sprites; composited AFTER paint+DOF, BEFORE bloom)
    update(t, ctx) {},       // called every SUBFRAME with subframe time t (motion blur!). ctx.cam = rig output, ctx.shot = {id, t0, t1, local}
    preFrame(t, ctx) {},     // optional: called once per output frame before subframes (expensive per-frame work, e.g. cloud rendering)
    post(t, p, ctx) {},      // optional: return post-param overrides
  };
}
```
- **Stateless and deterministic.** Everything must be a pure function of `t`; frames are rendered out of order and resumed. Never use `Math.random()`; use `rng(seed)` from common.js or hashes in GLSL. Animate in shaders from `uTime` where possible.
- **Materials.** Use `worldMaterial({vertexShader, fragmentShader, uniforms, ...})`. It prepends `WORLD_GLSL` and returns `{material, depthMaterial}`. Your vertex shader must compute a world position and write `gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0)`. Do not use modelViewMatrix unless your mesh has an identity transform, so the same code works for the sun's shadow camera. Inside the depth pass the define `DEPTH_PASS` is set. For alpha-tested cards pass `alphaTestInDepth: true` and `discard` under `#ifdef DEPTH_PASS`. Shadow casters call `castShadow(mesh, depthMaterial)`.
- **The WORLD_GLSL helpers.** Available in both shader stages unless noted:
  - **Bloom wave:**
    - `bloomAmt(xz)`: 0 is frozen winter, 1 is spring. Everything in the world switches by this.
    - `bloomFront(xz)`: a band right at the wavefront, for glow, growth overshoot and sparkles.
    - `arrival(xz)`: wave arrival value; `uBloomD` is the current wave value.
  - **Baked lookups:**
    - `infoAt(xz)`: x riverDist, y creekDist, z lakeDist (signed), w forest.
    - `info2At(xz)`: x petal field (< 0 inside a petal; this is `layout.petalField`, the organic petal outline the terrain paints, so use it or `L.petalField(x,z)` on the CPU for flower placement), y radius, z lobe delta, w variety noise.
  - **Sky and light:**
    - `skyGradient(dir)`, `applyFog(col, worldPos)` (aerial perspective; call it last in every opaque shader).
    - `windAt(xz, t)` (travelling gusts).
    - `cloudShadow(wp)`.
    - `sunShadow(wp, bias)`: **fragment shader only**.
    - `shadeSurface(albedo, N, wp, wrap, ao, translucency, shadow)` (stylised sun + sky + back-light).
  - **Noise:** `hash12/22/13/33`, `vnoise`, `vnoise3`, `snoise`, `fbm`, `fbm3`.
  - **Uniforms:** `uTime uSunDir uSunColor uSkyZenith uSkyHorizon uSkyAmbient uGroundBounce`, `cameraPosition`.
- **Overlay particles.** They are rendered into a separate transparent buffer, per subframe, with **premultiplied alpha**: use `blending: CustomBlending, blendSrc: OneFactor, blendDst: OneMinusSrcAlphaFactor, depthTest: false, depthWrite: false, transparent: true`. Occlude them yourself by sampling the scene depth `ctx.engine.sceneRT.depthTexture`; linearise it with the camera near/far and discard or fade where the scene is closer (soft particles). They bypass the DOF pass, so blur them yourself: CoC in px = `cocK * (H/2160) * abs(1 - focus/dist)`, clamped to `maxCoc` (70 in macro, 30 otherwise). Here `focus` and `cocK` come from `ctx.cam`. Grow the sprite by the CoC and lower its alpha by area, which gives a soft bokeh disc.
- **Performance budget per subframe at 3840x2160** (the engine accumulates 8-16 subframes per frame):
  - The total scene should stay under about 450 ms.
  - Your module should take a fair share: vegetation under 180 ms, trees under 100, the rest under 60 each.
  - GPU memory for your buffers should stay under about 300 MB.
  - Cull by camera: only build or draw instances near what the camera of each shot can see (`rig.at(t)` lets you precompute every shot's camera path), and set `mesh.visible` per shot in `update()`.
  - Distance LOD.
  - Nothing should ever be a single draw that takes more than about 300 ms (the Windows GPU watchdog).

## Rendering and checking your work (always look at your stills)
```
node render.mjs --q "world=film&only=<yourmodule>" --times 2,9,13.5 --w 960 --h 540 --spp 2 --out out/<yourmodule>_v01 --sheet --cols 3
```
- `only=` loads only the listed modules (comma list), plus terrain and the placeholder sky. Always pass it, so other people's half-finished modules can't break your renders. Add `sky` to the list once `src/world/sky.js` exists, to see your module under the real sky.
- `--stats` prints per-pass ms. `--sheet` writes `<out>/_sheet.jpg`, a contact sheet; open it with the Read tool and look at it critically. Also open single PNGs at full size.
- Check perf at least once at `--w 1920 --h 1080 --spp 1 --stats` (the "scene" entry), and quote the number in your report.
- **Machine safety: other people's Blender jobs run on this laptop.**
  - render.mjs runs at below-normal priority, and a machine-wide semaphore allows only 2 renders at once, so you may wait for a slot. That is expected.
  - Never start more than one render at a time yourself, and never render above 1920x1080 or above spp 4 during look-dev.
  - Never kill other processes.
  - Keep any node scripts light.
- Write test or debug files only under `out/` or your own scratch.

## Coordinates and scale cheat-sheet
- Metres. +x is east, +z is south, y is up. The knoll and bud are at the origin (ground y ≈ 1.2).
- The basin floor is at y ≈ -5 to +20, radius about 1500. Rim mountains rise beyond to 2000+, with a snowline around 1150.
- The petal axes are at `LOBE0 = 22.5°` plus k·60° (direction `(cos, sin)` in x/z). The ESE petal (22.5°) is the FPV chase lobe.
- The grove sits on a rise at r=262, phi=55°. The lake is at r=165, phi=232.5° (NW of the knoll).
- The waterfall is on the NW rim at r≈1720, phi=232.5°: its base is at y≈20, the lip at y≈236 (r≈1745), set in a curved amphitheatre cliff with a hanging valley behind.
- The river runs waterfall → lake → past the knoll's west side → SSW outlet.
- The sun moves from ESE at dawn (it clears the ESE rim saddle at firstLight) to SE. Read `sunAt(t)`.
- Shots: the times are **music-locked**. Always use `TIMES.*` from timeline.js; never hard-code seconds.

| Shot | Time (s) | What happens |
|---|---|---|
| macro | 0-7.52 | Bud close-up. The camera is about 13 cm from the bud head, slightly below it, looking up ESE toward the dawn sun. firstLight 3.03, held breath 5.18, burst at hit 6.00, pull-back 6.7-7.52. |
| fpv | 7.52-15.40 | Low fast flight outward along the ESE petal and creek, 0.4-2.5 m above ground. The wave front leads the camera until about 9.5, then the camera is ahead of it over the creek (9.55-11.58, the wrong reflection). The front catches up and passes under the lens at catchUp 11.58. The sun breaks at sunBreak 12.09. Swift near-miss at 14.16. |
| canopy | 15.40-16.79 | Climbs over the grove; snow white-out from whiteout 16.40. |
| reveal | 16.79-20.72 | Crane reveal from just above and behind the grove crowns looking NW, 20 m up to 165 m. The white-out clears on the music's bright arrival at 17.31. |
| falls | 20.72-23.70 | About 900 m from the falls, a touch off-axis, 32-35° vfov: the whole cirque, falls, plume, and the river winding through forest. Shatter at cut5 20.72, rainbow from 21.21. |
| aerial | 23.70-30 | High aerial along the SSW river "stem" looking NNE at the flower-shaped basin, 1300-1850 m up. Final chord at resolve 25.50, glint 27.5, fade out 29-30. |

## Report back
Your final message is your report:
- what you built
- how to tune it
- measured perf at 1080p
- the paths of your best stills
- any request for changes to shared files: give the exact snippet; do not edit shared files yourself
