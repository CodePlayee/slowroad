#!/usr/bin/env python3
"""Lossless anonymous packaging of full-scene captures against the official refs.

    python3 gauntlet/package-scene-blind.py [--calibration DIR] <capture_dir> <out_dir>
    python3 gauntlet/package-scene-blind.py --progress PREV_DIR <capture_dir> <out_dir>

Scene mode pairs each capture `<shot>.png` (1920x1080) with its official reference
in a random Q order and A/B slot and copies `SCENE_RUBRIC.md` as `RUBRIC.md`.
--calibration mixes in frozen captures from DIR. They never change between rounds,
so their scores measure judge-panel drift; the aggregator keeps them out of results.

Progress mode shows only shots that differ between PREV_DIR and capture_dir, as
A/B with the official image as R.png, for the forced choice in `PROGRESS_RUBRIC.md`.

HUD masks are applied identically to every image. The private key is written next
to the package as `<out_dir>.private-key.json`; never hand it to judges. Requires
Pillow.
"""
import argparse
import hashlib
import json
import os
import random
import shutil

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REF = os.path.join(ROOT, 'refs', 'slowroads', 'official')
SCENE_RUBRIC = os.path.join(ROOT, 'gauntlet', 'SCENE_RUBRIC.md')
PROGRESS_RUBRIC = os.path.join(ROOT, 'gauntlet', 'PROGRESS_RUBRIC.md')
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
    # Held out from tuning: captured by holdout-round.sh, never by scene-round.sh.
    'holdout_a': ('sr_01.jpg', []),
    'holdout_b': ('sr_01.jpg', []),
    'holdout_c': ('sr_01.jpg', []),
    'holdout_d': ('sr_11.jpg', []),
    'holdout_e': ('sr_03.jpg', []),
    'holdout_f': ('sr_22.jpg', []),
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


def capture_path(directory, shot):
    return os.path.join(directory, shot + '.png')


def write_pair(out, qid, pair, masks):
    os.makedirs(os.path.join(out, qid))
    for slot, (_, path) in zip('AB', pair):
        load(path, masks).save(os.path.join(out, qid, slot + '.png'))


def slots(pair):
    return {slot: {'role': role, 'file': path, 'sha256': sha256(path)} for slot, (role, path) in zip('AB', pair)}


def package_scene(capture, out, calibration, rng):
    cases = [(s, capture, False) for s in CASES if os.path.exists(capture_path(capture, s))]
    if calibration:
        cases += [(s, calibration, True) for s in CASES if os.path.exists(capture_path(calibration, s))]
    rng.shuffle(cases)
    key = []
    for index, (shot, directory, frozen) in enumerate(cases, 1):
        qid = f'Q{index:02d}'
        ref, masks = CASES[shot]
        pair = [('build', capture_path(directory, shot)), ('reference', os.path.join(REF, ref))]
        if rng.random() < 0.5:
            pair.reverse()
        write_pair(out, qid, pair, masks)
        key.append({'id': qid, 'shot': shot, 'reference': ref, 'masks': masks, 'calibration': frozen, **slots(pair)})
    return key


def package_progress(capture, out, previous, rng):
    shots = [s for s in CASES if os.path.exists(capture_path(capture, s))]
    unchanged = [s for s in shots if sha256(capture_path(capture, s)) == sha256(capture_path(previous, s))]
    shots = [s for s in shots if s not in unchanged]
    rng.shuffle(shots)
    key = []
    for index, shot in enumerate(shots, 1):
        qid = f'Q{index:02d}'
        ref, masks = CASES[shot]
        pair = [('candidate', capture_path(capture, shot)), ('previous', capture_path(previous, shot))]
        if rng.random() < 0.5:
            pair.reverse()
        write_pair(out, qid, pair, masks)
        load(os.path.join(REF, ref), masks).save(os.path.join(out, qid, 'R.png'))
        key.append({'id': qid, 'shot': shot, 'reference': ref, 'masks': masks, **slots(pair)})
    return key, unchanged


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('capture')
    parser.add_argument('out')
    parser.add_argument('--calibration')
    parser.add_argument('--progress')
    parser.add_argument('--seed', type=int, default=random.SystemRandom().randrange(2**31))
    args = parser.parse_args()
    if args.calibration and args.progress:
        parser.error('--calibration applies to scene packages only')
    if os.path.exists(args.out):
        raise SystemExit(f'refusing to overwrite {args.out}')
    rng = random.Random(args.seed)
    os.makedirs(args.out)
    manifest = {'seed': args.seed, 'capture': args.capture}
    if args.progress:
        key, unchanged = package_progress(args.capture, args.out, args.progress, rng)
        manifest.update(mode='progress', previous=args.progress, unchanged=unchanged)
        shutil.copy(PROGRESS_RUBRIC, os.path.join(args.out, 'RUBRIC.md'))
    else:
        key = package_scene(args.capture, args.out, args.calibration, rng)
        manifest.update(mode='scene')
        shutil.copy(SCENE_RUBRIC, os.path.join(args.out, 'RUBRIC.md'))
    manifest['key'] = key
    key_path = args.out.rstrip('/') + '.private-key.json'
    with open(key_path, 'w') as handle:
        json.dump(manifest, handle, indent=1)
    print(json.dumps({'out': args.out, 'pairs': len(key), 'key': key_path, 'unchanged': manifest.get('unchanged', [])}))


if __name__ == '__main__':
    main()
