#!/usr/bin/env bash
# Review material for the final (v2) frames: per-second keyframes, the joins between
# re-rendered and untouched frame ranges, and the fixed moments. Output: out/qa_v2/
set -e
cd "$(dirname "$0")"
F=frames/final; Q=out/qa_v2
rm -rf $Q; mkdir -p $Q
fr() { printf "$F/f%05d.png" $1; }
grid() { # name start count cols width
  local name=$1 start=$2 n=$3 cols=$4 w=$5 h=$(( $5 * 9 / 16 )) args="" fil="" lay="" ins=""
  for k in $(seq 0 $((n-1))); do
    args="$args -i $(fr $((start+k)))"
    fil="$fil[$k:v]scale=$w:$h,drawtext=text='f$((start+k))':x=8:y=8:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.5[s$k];"
    lay="$lay$(( (k%cols)*w ))_$(( (k/cols)*h ))|"; ins="$ins[s$k]"
  done
  ffmpeg -v error -y $args -filter_complex "${fil}${ins}xstack=inputs=$n:layout=${lay%|}" -q:v 3 $Q/$name.jpg 2>/dev/null
}
for s in $(seq 0 29); do f=$((s*30+15)); ffmpeg -v error -y -i $(fr $f) -vf scale=1920:-2 -q:v 3 $Q/sec$(printf %02d $s)_f$(printf %03d $f).jpg; done
# joins: last untouched / first re-rendered (or the reverse), 6 frames each
grid join_f198 198 6 3 640      # macro (old) -> pull (new) at f201
grid join_f223 223 6 3 640      # pull (new) -> fpv (old) at f226
grid join_f278 278 6 3 640      # fpv (old) -> creek window (new) at f281
grid join_f363 363 6 3 640      # creek window (new) -> fpv (old) at f366
grid join_f459 459 6 3 640      # fpv2 (old) -> canopy (new) at f462
grid join_f501 501 6 3 640      # canopy (new) -> reveal (new) white-out
grid join_f619 619 6 3 640      # reveal -> shatter
grid join_f708 708 6 3 640      # falls -> aerial
# fixed moments
grid fix_creek_f300 300 12 4 480
grid fix_pull_f201 201 12 4 480
grid fix_canopy_f470 470 12 4 480
grid fix_shatter_f622 622 12 4 480
grid fix_glint_f818 818 12 4 480
for f in 330 600 680 760 885; do ffmpeg -v error -y -i $(fr $f) -vf "crop=1280:720:1280:720" -q:v 2 $Q/crop4k_center_f$(printf %03d $f).jpg; done
ls $Q | wc -l
