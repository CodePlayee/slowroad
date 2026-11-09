#!/bin/bash
# Capture the shots held out from tuning, from a round's frozen source snapshot.
#
#   gauntlet/holdout-round.sh <round> [previous-round]
#
# Reads gauntlet/rounds/<round>/src.tar.gz and writes gauntlet/rounds/<round>/holdout/.
# With a previous round (already captured the same way) also builds a forced-choice
# package at gauntlet/rounds/<round>/holdout-progress. Needs Node >= 22.15.
set -euo pipefail
ROUND=$1
PREVIOUS=${2:-}
PORT=${GAUNTLET_PORT:-5202}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=$ROOT/gauntlet/rounds/$ROUND/holdout
WORK=$(mktemp -d /tmp/holdout-XXXXXX)
trap 'kill "${PREVIEW:-}" 2>/dev/null || true; rm -rf "$WORK"' EXIT
cd "$ROOT"
tar xzf "gauntlet/rounds/$ROUND/src.tar.gz" -C "$WORK"
cp -r public index.html vite.config.mjs package.json "$WORK/"
ln -s "$ROOT/node_modules" "$WORK/node_modules"
(cd "$WORK" && node node_modules/vite/bin/vite.js build --logLevel warn)
(cd "$WORK" && exec node node_modules/vite/bin/vite.js preview --port "$PORT" --strictPort --host 127.0.0.1) > /dev/null 2>&1 &
PREVIEW=$!
for _ in $(seq 60); do curl -sf "http://127.0.0.1:$PORT/" > /dev/null && break; sleep 1; done
mkdir -p "$OUT"
export GAUNTLET_URL=http://127.0.0.1:$PORT
export PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.local/ms-playwright}
GAUNTLET_MANIFEST=capture-1.json node gauntlet/cpu-capture.mjs "$OUT" holdout_a holdout_b holdout_c > "$OUT/cap1.log" 2>&1 &
W1=$!
GAUNTLET_MANIFEST=capture-2.json node gauntlet/cpu-capture.mjs "$OUT" holdout_d holdout_e holdout_f > "$OUT/cap2.log" 2>&1 &
W2=$!
S1=0; S2=0
wait "$W1" || S1=$?
wait "$W2" || S2=$?
[ "$S1" -eq 0 ] && [ "$S2" -eq 0 ] || { echo "holdout capture failed: $S1 $S2"; cat "$OUT/cap1.log" "$OUT/cap2.log"; exit 1; }
[ "$(ls "$OUT"/holdout_*.png | wc -l)" -eq 6 ] || { echo 'expected 6 holdout captures'; exit 1; }
[ -z "$PREVIOUS" ] || python3 gauntlet/package-scene-blind.py --progress "$ROOT/gauntlet/rounds/$PREVIOUS/holdout" "$OUT" "$ROOT/gauntlet/rounds/$ROUND/holdout-progress"
