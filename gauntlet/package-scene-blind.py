#!/usr/bin/env python3
"""Lossless anonymous A/B packaging of full-scene captures against the official refs.

    python3 gauntlet/package-scene-blind.py <capture_dir> <out_dir> [seed]

Each case pairs a capture `<shot>.png` (1920x1080) with its official reference,
randomises the Q order and the A/B slot, applies identical HUD masks to both
images and copies `SCENE_RUBRIC.md` as `RUBRIC.md`. The private key is written
next to the package as `<out_dir>.private-key.json`; never hand it to judges.
Requires Pillow.
"""
import hashlib
import json
import os
import random
import shutil
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REF = os.path.join(ROOT, 'refs', 'slowroads', 'official')
RUBRIC = os.path.join(ROOT, 'gauntlet', 'SCENE_RUBRIC.md')
# shot -> (reference, masks [x, y, w, h] applied identically to both images).
# sr_04 carries the official HUD (trip, speed, autosteer); nothing else has one.
CASES = {
    'chase_summer_noon': ('sr_01.jpg', []),
    'chase_golden': ('sr_04.jpg', [[300, 870, 230, 150], [860, 850, 200, 180], [1440, 870, 210, 110]]),
    'chase_dawn': ('sr_13.jpg', []),
    'chase_night': ('sr_20.jpg', []),
    'cockpit_noon': ('sr_11.jpg', []),
    'cockpit_overcast': ('sr_11.jpg', []),
    'vista_wide': ('sr_03.jpg', []),
    'forest_dense': ('sr_16.jpg', []),
    'season_autumn': ('sr_22.jpg', []),
    'season_winter': ('sr_13.jpg', []),
}


def load(path, masks):
    image = Image.open(path).convert('RGB')
    if image.size != (1920, 1080):
        raise ValueError(f'{path}: expected 1920x1080, got {image.size}')
    pixels = image.load()
    for x, y, w, h in masks:
        for yy in range(y, y + h):
            for xx in range(x, x + w):
                pixels[xx, yy] = (20, 20, 20)
    return image


def sha256(path):
    with open(path, 'rb') as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def main(capture, out, seed):
    if os.path.exists(out):
        raise SystemExit(f'refusing to overwrite {out}')
    rng = random.Random(seed)
    shots = [s for s in CASES if os.path.exists(os.path.join(capture, s + '.png'))]
    rng.shuffle(shots)
    os.makedirs(out)
    key = []
    for index, shot in enumerate(shots, 1):
        qid = f'Q{index:02d}'
        ref, masks = CASES[shot]
        pair = [('build', os.path.join(capture, shot + '.png')), ('reference', os.path.join(REF, ref))]
        if rng.random() < 0.5:
            pair.reverse()
        os.makedirs(os.path.join(out, qid))
        for slot, (_, path) in zip('AB', pair):
            load(path, masks).save(os.path.join(out, qid, slot + '.png'))
        key.append({'id': qid, 'shot': shot, 'reference': ref, 'masks': masks,
                    'A': {'role': pair[0][0], 'file': pair[0][1], 'sha256': sha256(pair[0][1])},
                    'B': {'role': pair[1][0], 'file': pair[1][1], 'sha256': sha256(pair[1][1])}})
    shutil.copy(RUBRIC, os.path.join(out, 'RUBRIC.md'))
    key_path = out.rstrip('/') + '.private-key.json'
    with open(key_path, 'w') as handle:
        json.dump({'seed': seed, 'capture': capture, 'key': key}, handle, indent=1)
    print(json.dumps({'out': out, 'pairs': len(key), 'key': key_path}))


if __name__ == '__main__':
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    main(sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else random.SystemRandom().randrange(2**31))
