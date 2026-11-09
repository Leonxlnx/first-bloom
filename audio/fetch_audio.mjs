// node audio/fetch_audio.mjs [--all]
// Downloads the library audio the mix uses (music + SFX) from the original sources listed in
// audio/candidates/*/manifest.json. The files themselves are not in the repo: the Pixabay and
// Mixkit licences do not allow redistributing them on their own. --all also fetches the
// candidates that did not make the final mix.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { CUES } = await import('./cues.mjs');
const MUSIC_SRC = 'audio/candidates/music_a/pixabay_moonpetalmedia_the_light_between_moments.mp3';
const used = new Set([...CUES.map(c => c.file), MUSIC_SRC]);
const all = process.argv.includes('--all');

let got = 0, have = 0, failed = 0;
for (const g of ['music_a', 'music_b', 'sfx_ambience', 'sfx_design']) {
  const dir = path.join(ROOT, 'audio/candidates', g);
  for (const e of JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json')))) {
    const rel = `audio/candidates/${g}/${e.file}`, out = path.join(ROOT, rel);
    if (!all && !used.has(rel)) continue;
    if (fs.existsSync(out)) { have++; continue; }
    try {
      const r = await fetch(e.direct_url, { headers: { 'user-agent': 'Mozilla/5.0' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
      got++; console.log('ok  ', rel);
    } catch (err) {
      failed++; console.log('FAIL', rel, err.message, '-', e.source_page_url);
    }
  }
}
console.log(`downloaded ${got}, already present ${have}, failed ${failed}`);
if (failed) process.exitCode = 1;
