// Sound design cue sheet — every cue is pinned to a picture event in TIMES.
// level = target RMS (dBFS) of the trimmed segment before the final loudness pass.
// Music sits around -19 dBFS RMS; beds well under it, hits just under it.
import { TIMES as T } from '../src/world/timeline.js';

const A = 'audio/candidates/sfx_ambience/', D = 'audio/candidates/sfx_design/';

export const DURATION = 30;
export const TARGET_LUFS = -14;
export const MUSIC = { file: 'audio/edit/edit_1.wav', at: 0, anchor: 'start', level: -19.5 };

export const CUES = [
  // ---------------- ACT I: frost (0 - 6.0)
  { file: A + 'wind_winter_bare_trees_kyles_fs637566.mp3', from: 4, dur: 7.0, at: 0, level: -34, fadeIn: 1.6, fadeOut: 1.6, lowpass: 6000 },
  { file: A + 'ice_creak_fracture_growing_vrymaa_fs735401.mp3', from: 6, dur: 2.5, at: 2.2, level: -40, fadeIn: 0.3, fadeOut: 0.8, lowpass: 4000 },
  { file: D + 'shimmer_mixkit_870_sparkling_fairy_glow.mp3', at: T.firstLight + 0.2, anchor: 'start', level: -36, fadeOut: 1.0 },
  { file: A + 'icicle_drips_morning_birds_fs805664.mp3', from: 12, dur: 2.4, at: T.firstLight + 1.1, level: -38, fadeIn: 0.2, fadeOut: 0.6, highpass: 900 },
  { file: D + 'riser_fs_425463_china_cymbal_swell_reversed.mp3', at: T.hit - 0.04, anchor: 'peak', level: -44, fadeIn: 1.2, lowpass: 7000 },
  // ---------------- 6.0 FIRST BLOOM hit
  { file: D + 'boom_fs_560156_soft_cinematic_impact.mp3', at: T.hit, anchor: 'onset', level: -22, fadeOut: 1.5 },
  { file: D + 'subdrop_fs_346316_ramons_sub_drop.mp3', at: T.hit, anchor: 'onset', level: -27, lowpass: 180 },
  { file: D + 'bloom_mixkit_3082_magic_sparkle_poof_hit.mp3', at: T.hit + 0.02, anchor: 'onset', level: -27 },
  { file: D + 'shimmer_fs_632344_shimmer_adh_dreaming.mp3', at: T.hit + 0.15, anchor: 'start', level: -31, fadeOut: 1.4 },
  { file: D + 'whoosh_mixkit_167_long_sweeping_air_swoosh.mp3', at: T.pullStart + 0.55, anchor: 'peak', level: -29, highpass: 120 },
  // ---------------- ACT II: wavefront chase (7.6 - 16.6)
  { file: D + 'whoosh_mixkit_1469_flying_fast_swoosh.mp3', at: T.cut2 + 0.05, anchor: 'peak', level: -28 },
  { file: A + 'meadow_wind_light_mixkit1166.mp3', from: 2, dur: 8.2, at: T.cut2, level: -33, fadeIn: 0.15, fadeOut: 0.6 },
  { file: D + 'bloom_fs_648958_plant_growing_ienba.mp3', from: 0.5, dur: 7.5, at: T.cut2, level: -34, fadeIn: 0.4, fadeOut: 1.0 },
  { file: D + 'shimmer_mixkit_2352_magic_glitter_particles.mp3', at: T.cut2 + 0.3, level: -37, fadeIn: 0.5, fadeOut: 1.5 },
  { file: A + 'birds_taking_off_fs499679.mp3', at: T.cut2 + 1.0, anchor: 'peak', level: -31, pan: -0.3 },
  { file: A + 'bird_flutter_small_mixkit2694.mp3', at: T.cut2 + 1.6, anchor: 'peak', level: -33, pan: 0.4 },
  // the creek: water under ice, crack zipping ahead, drips
  { file: A + 'brook_gurgling_garuda_fs639128.mp3', from: 10, dur: 3.2, at: T.creek - 0.3, level: -33, fadeIn: 0.4, fadeOut: 0.8 },
  { file: A + 'ice_lake_fractures_vrymaa_fs737896.mp3', from: 3.0, dur: 2.0, at: T.creek + 0.15, level: -30, fadeOut: 0.6 },
  { file: A + 'ice_cracks_frozen_puddle_fs168712.mp3', from: 20, dur: 1.4, at: T.creek + 0.9, level: -33, fadeOut: 0.4, pan: 0.2 },
  // sun breaks through
  { file: D + 'bloom_mixkit_658_choir_magic_shine.mp3', at: T.sunBreak + 0.1, anchor: 'start', level: -31, fadeOut: 1.0 },
  { file: A + 'meadow_spring_birdsong_soft_wind_fs847380.mp3', from: 30, dur: 4.6, at: T.sunBreak - 0.2, level: -33, fadeIn: 1.0, fadeOut: 0.8 },
  { file: A + 'bees_buzzing_lavender_fs528935.mp3', from: 2, dur: 3.0, at: T.sunBreak + 0.8, level: -40, fadeIn: 0.6, fadeOut: 0.8 },
  // swift near-miss
  { file: D + 'whoosh_mixkit_2607_fast_air_woosh.mp3', at: T.swift, anchor: 'peak', level: -25, pan: 0.15 },
  // canopy: leaves surge, snow puffs, riser into the reveal
  { file: A + 'leaves_trees_rustling_wind_fs523389.mp3', from: 12, dur: 1.5, at: T.cut3 - 0.1, level: -30, fadeIn: 0.3, fadeOut: 0.4 },
  { file: D + 'boom_mixkit_781_cinematic_impact_waves.mp3', dur: 1.2, at: 15.9, anchor: 'onset', level: -33, lowpass: 900, fadeOut: 0.5 },
  { file: D + 'boom_mixkit_781_cinematic_impact_waves.mp3', dur: 1.2, at: 16.1, anchor: 'onset', level: -34, lowpass: 700, fadeOut: 0.5, rate: 0.92 },
  { file: D + 'wind_mixkit_1168_woosh_wind.mp3', at: T.whiteout + 0.15, anchor: 'peak', level: -28, lowpass: 3000 },
  { file: D + 'riser_mixkit_784_reverse_cinematic_impact_trailer.mp3', at: T.cut4 - 0.02, anchor: 'peak', level: -31, fadeIn: 1.0 },
  // ---------------- ACT III: basin reveal (16.6 - 20.8)
  { file: D + 'whoosh_mixkit_2604_deep_air_woosh.mp3', at: T.cut4 + 0.25, anchor: 'peak', level: -29 },
  { file: A + 'wind_mountain_top_mixkit1267.mp3', from: 3, dur: 4.6, at: T.cut4, level: -36, fadeIn: 0.5, fadeOut: 1.0 },
  { file: A + 'ice_lake_fractures_vrymaa_fs737896.mp3', from: 20, dur: 3.5, at: T.cut4 + 0.6, level: -36, fadeIn: 0.2, fadeOut: 1.0, lowpass: 2500 },
  { file: A + 'river_water_flowing_mixkit2454.mp3', from: 20, dur: 4.4, at: T.cut4 + 0.2, level: -40, fadeIn: 1.5, fadeOut: 0.8 },
  { file: A + 'birds_flock_takeoff_pigeons_fs616623.mp3', at: T.cut4 + 1.9, anchor: 'peak', level: -38, lowpass: 5000, pan: -0.25 },
  // ---------------- 20.8 the falls unbound + rainbow
  { file: D + 'boom_mixkit_788_big_cinematic_impact.mp3', at: T.cut5, anchor: 'onset', level: -18.5, fadeOut: 1.8 },
  { file: A + 'ice_lake_fractures_vrymaa_fs737896.mp3', from: 10, dur: 2.2, at: T.cut5, level: -26, fadeOut: 0.8 },
  { file: D + 'subdrop_fs_856174_deep_sub_bass_rumble_drop.mp3', at: T.cut5, anchor: 'onset', level: -22.5, lowpass: 140 },
  { file: A + 'waterfall_in_woods_mixkit2517.mp3', from: 10, dur: 3.4, at: T.cut5 + 0.1, level: -30, fadeIn: 0.25, fadeOut: 0.6 },
  { file: D + 'shimmer_mixkit_3108_crystal_chime.mp3', at: T.rainbow, anchor: 'peak', level: -33 },
  { file: D + 'shimmer_mixkit_2350_magic_sparkle_whoosh.mp3', at: T.rainbow + 0.3, anchor: 'start', level: -35, fadeOut: 0.8 },
  // ---------------- 23.8 aerial: the valley is a flower
  { file: D + 'whoosh_mixkit_1167_swoosh_wind_passing.mp3', dur: 1.6, at: T.cut6 + 0.25, anchor: 'peak', level: -37, fadeOut: 0.5 },
  { file: A + 'wind_mountain_top_mixkit1267.mp3', from: 12, dur: 6.0, at: T.cut6 + 0.3, level: -44, fadeIn: 1.4, fadeOut: 2.0 },
  { file: A + 'waterfall_distant_lookout_fs348827.mp3', from: 4, dur: 6.0, at: T.cut6, level: -49, fadeIn: 1.0, fadeOut: 2.0 },
  { file: A + 'meadow_spring_birdsong_soft_wind_fs847380.mp3', from: 90, dur: 6.0, at: T.cut6 + 1.5, level: -44, fadeIn: 1.0, fadeOut: 2.0 },
  { file: D + 'shimmer_mixkit_2352_magic_glitter_particles.mp3', at: T.resolve - 0.1, level: -38, fadeIn: 0.4, fadeOut: 2.0 },
  { file: D + 'shimmer_mixkit_3108_crystal_chime.mp3', at: T.glint, anchor: 'peak', level: -31 },
  { file: A + 'bird_flutter_small_mixkit2694.mp3', at: 28.1, anchor: 'peak', level: -40, pan: -0.2, lowpass: 6000 },
];
