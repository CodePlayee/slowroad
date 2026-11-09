#!/bin/bash
# One blind-judged round from an immutable build: later source edits cannot leak in.
#
#   gauntlet/scene-round.sh <round> [previous-round-dir]
#
# Writes gauntlet/rounds/<round>/: src.tar.gz, code.patch, source.sha256, the ten
# canonical PNGs, capture.json, scene/ (with calibration pairs if
# gauntlet/rounds/calibration exists) and, given a previous dir, progress/.
# Needs Node >= 22.15 and a Playwright Chromium.
set -euo pipefail
ROUND=$1
PREVIOUS=${2:-}
PORT=${GAUNTLET_PORT:-5190}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=$ROOT/gauntlet/rounds/$ROUND
cd "$ROOT"
node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<15))throw new Error("Node >= 22.15 required, got "+process.version)'
[ ! -e "$OUT/capture.json" ] || { echo "refusing to overwrite $OUT"; exit 1; }
mkdir -p "$OUT"

git diff HEAD > "$OUT/code.patch"
git status --porcelain > "$OUT/status.txt"
tar czf "$OUT/src.tar.gz" src
find src public index.html vite.config.mjs package-lock.json -type f -print0 | sort -z | xargs -0 sha256sum > "$OUT/source.sha256"

node node_modules/vite/bin/vite.js build --outDir "$OUT/dist" --emptyOutDir --logLevel warn
node node_modules/vite/bin/vite.js preview --outDir "$OUT/dist" --port "$PORT" --strictPort --host 127.0.0.1 > "$OUT/preview.log" 2>&1 &
PREVIEW=$!
trap 'kill "$PREVIEW" 2>/dev/null || true; rm -rf "$OUT/dist"' EXIT
for _ in $(seq 60); do curl -sf "http://127.0.0.1:$PORT/" > /dev/null && break; sleep 1; done

export GAUNTLET_URL=http://127.0.0.1:$PORT
export PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.local/ms-playwright}
GAUNTLET_MANIFEST=capture-1.json node gauntlet/cpu-capture.mjs "$OUT" chase_summer_noon chase_dawn cockpit_noon vista_wide season_autumn > "$OUT/cap1.log" 2>&1 &
W1=$!
GAUNTLET_MANIFEST=capture-2.json node gauntlet/cpu-capture.mjs "$OUT" chase_golden chase_night cockpit_overcast forest_dense season_winter > "$OUT/cap2.log" 2>&1 &
W2=$!
S1=0; S2=0
wait "$W1" || S1=$?
wait "$W2" || S2=$?
[ "$S1" -eq 0 ] && [ "$S2" -eq 0 ] || { echo "capture workers failed: $S1 $S2"; cat "$OUT/cap1.log" "$OUT/cap2.log"; exit 1; }

python3 - "$OUT" <<'PY'
import json, sys
from pathlib import Path
from PIL import Image
out = Path(sys.argv[1])
expected = {'chase_summer_noon', 'chase_golden', 'chase_dawn', 'chase_night', 'cockpit_noon', 'cockpit_overcast', 'vista_wide', 'forest_dense', 'season_autumn', 'season_winter'}
rows = [r for n in (1, 2) for r in json.loads((out / f'capture-{n}.json').read_text())]
assert len(rows) == 10 and {r['id'] for r in rows} == expected, 'manifest coverage mismatch'
for r in rows:
    assert r['ok'] is True and not r.get('errors'), r
    with Image.open(out / (r['id'] + '.png')) as image:
        assert image.size == (1920, 1080), (r['id'], image.size)
    print(f"{r['id']:18s} {r['sec']:4d}s tris {r['stats']['triangles']:>9d} calls {r['stats']['drawCalls']:>5d}")
(out / 'capture.json').write_text(json.dumps(rows, indent=1))
PY

CALIBRATION=()
[ ! -d gauntlet/rounds/calibration ] || CALIBRATION=(--calibration "$ROOT/gauntlet/rounds/calibration")
python3 gauntlet/package-scene-blind.py "${CALIBRATION[@]}" "$OUT" "$OUT/scene"
[ -z "$PREVIOUS" ] || python3 gauntlet/package-scene-blind.py --progress "$PREVIOUS" "$OUT" "$OUT/progress"
