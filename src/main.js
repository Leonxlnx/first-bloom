import { Engine } from './engine.js';

const q = new URLSearchParams(location.search);
const W = +q.get('w') || 1920, H = +q.get('h') || 1080;
const spp = +q.get('spp') || 4, fps = +q.get('fps') || 30;
window.__film = { ready: false };

try {
  const engine = new Engine({ W, H, spp, fps, msaa: +(q.get('msaa') ?? 4) });
  const mod = await import(`./worlds/${q.get('world') || 'film'}.js`);
  const world = await mod.createWorld({ engine, renderer: engine.renderer, W, H, q });
  window.__film.renderFrame = async t => {
    const b64 = await engine.renderFrame(world, t, Math.round(t * fps));
    window.__film.stats = Object.fromEntries(Object.entries(engine.timing).map(([k, v]) => [k, Math.round(v)]));
    return b64;
  };
  const gl = engine.gl, dbg = gl.getExtension('WEBGL_debug_renderer_info');
  window.__film.info = { W, H, spp, renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '?', ...(world.info || {}) };
  window.__film.ready = true;
} catch (e) {
  console.error(e);
  window.__film.error = e.stack || String(e);
}
