#!/usr/bin/env python3
"""Validate, unblind and aggregate judge verdicts from package-scene-blind.py.

    python3 gauntlet/aggregate-scene-blind.py <key.json> <judge-*.json ...>

Any malformed or incomplete verdict is a hard failure. Scene mode prints wins,
0-5 means, per-dimension and per-shot results for the current build, then the
frozen calibration pairs separately (they measure panel drift, not this build) and
each judge's decoded gaps. Progress mode prints candidate vs previous per shot.
"""
import collections
import json
import statistics
import sys

DIMS = ['composition', 'terrain', 'road', 'vegetation', 'ground', 'atmosphere', 'lighting', 'vehicle', 'cleanliness']
PROGRESS_DIMS = [d for d in DIMS if d != 'vehicle']
SNOW_SHOTS = {'season_winter', 'chase_dawn'}  # both pair with the snowy sr_13


def load_verdict(path, key):
    with open(path) as handle:
        verdict = json.load(handle)
    ids = [pair['id'] for pair in verdict['pairs']]
    if sorted(ids) != sorted(key):
        raise SystemExit(f'{path}: verdict covers {sorted(ids)}, expected {sorted(key)}')
    return verdict


def check_scene_pair(path, pair):
    if pair['winner'] not in ('A', 'B', 'tie') or type(pair['material_gap']) is not bool:
        raise SystemExit(f'{path} {pair["id"]}: bad winner or material_gap')
    if pair['biggest_gap']['weaker'] not in ('A', 'B'):
        raise SystemExit(f'{path} {pair["id"]}: bad biggest_gap')
    for side in 'AB':
        scores = pair['scores'][side]
        if set(scores) != set(DIMS):
            raise SystemExit(f'{path} {pair["id"]} {side}: wrong score keys')
        for value in scores.values():
            if value != 'N/A' and not (type(value) is int and 0 <= value <= 5):
                raise SystemExit(f'{path} {pair["id"]} {side}: bad score {value!r}')


def mean_score(scores):
    values = [v for v in scores.values() if isinstance(v, int)]
    return statistics.mean(values)


def scene(key, paths):
    tally = collections.Counter()
    gaps = {d: [] for d in DIMS}
    build_all, ref_all, per_shot = [], [], collections.defaultdict(list)
    calibration = collections.defaultdict(list)
    judge_means = collections.defaultdict(list)
    material, project_material, warnings, decoded = 0, 0, [], []
    for path in paths:
        verdict = load_verdict(path, key)
        decoded.append(f'== {verdict.get("judge", path)}')
        for pair in verdict['pairs']:
            check_scene_pair(path, pair)
            case = key[pair['id']]
            build = 'A' if case['A']['role'] == 'build' else 'B'
            ref = 'B' if build == 'A' else 'A'
            if case.get('calibration'):
                calibration[case['shot']].append(mean_score(pair['scores'][build]))
                continue
            winner = pair['winner']
            tally['build' if winner == build else 'reference' if winner == ref else 'tie'] += 1
            judge_means[verdict.get('judge', path)].append(mean_score(pair['scores'][build]))
            per_shot[case['shot']].append(mean_score(pair['scores'][build]))
            for dim in DIMS:
                b, r = pair['scores'][build][dim], pair['scores'][ref][dim]
                if isinstance(b, int) and isinstance(r, int):
                    gaps[dim].append(r - b)
                    build_all.append(b)
                    ref_all.append(r)
            weaker_build = pair['biggest_gap']['weaker'] == build
            material += pair['material_gap']
            project_material += pair['material_gap'] and weaker_build
            text = pair.get('reasons', '')
            if case['shot'] not in SNOW_SHOTS and ('雪' in text or 'snow' in text.lower()):
                warnings.append(f'{verdict.get("judge")} {pair["id"]} {case["shot"]}: reasons mention snow; verdict may be misfiled')
            side = 'BUILD' if weaker_build else 'ref'
            result = 'build' if winner == build else 'ref' if winner == ref else 'tie'
            decoded.append(f' {case["shot"]:18s} win={result} gap={pair["material_gap"]} weaker={side}: '
                           f'{pair["biggest_gap"].get("region", "")} -> {pair["biggest_gap"].get("target", "")}')
        for item in verdict.get('top_recurring_gaps', []):
            decoded.append(f'  TOP {item.get("rank")} {item.get("region", "")} -> {item.get("target", "")}')
    print('wins', dict(tally))
    print('mean build %.2f  reference %.2f' % (statistics.mean(build_all), statistics.mean(ref_all)))
    print(f'material gaps {material}, on build side {project_material}, of {sum(tally.values())}')
    for dim, values in sorted(gaps.items(), key=lambda item: -statistics.mean(item[1]) if item[1] else 0):
        if values:
            print(f'gap {dim:12s} {statistics.mean(values):+.2f}')
    for shot, values in sorted(per_shot.items()):
        print(f'shot {shot:18s} {statistics.mean(values):.2f}')
    print('judge means', {name: round(statistics.mean(v), 2) for name, v in judge_means.items()})
    for shot, values in sorted(calibration.items()):
        print(f'calibration {shot:18s} {statistics.mean(values):.2f} {[round(v, 2) for v in values]}')
    for line in warnings:
        print('WARNING', line)
    print('\n'.join(decoded))


def progress(key, paths, unchanged):
    votes = collections.defaultdict(list)
    dims = collections.defaultdict(collections.Counter)
    decoded = []
    for path in paths:
        verdict = load_verdict(path, key)
        decoded.append(f'== {verdict.get("judge", path)}')
        for pair in verdict['pairs']:
            if pair['closer'] not in ('A', 'B') or pair['confidence'] not in ('high', 'medium', 'low'):
                raise SystemExit(f'{path} {pair["id"]}: bad closer or confidence')
            case = key[pair['id']]
            candidate = 'A' if case['A']['role'] == 'candidate' else 'B'
            won = pair['closer'] == candidate
            votes[case['shot']].append(('cand' if won else 'prev', pair['confidence']))
            for dim in PROGRESS_DIMS:
                value = pair['dimensions'][dim]
                if value not in ('A', 'B', 'same'):
                    raise SystemExit(f'{path} {pair["id"]}: bad dimension {dim}={value!r}')
                dims[dim]['same' if value == 'same' else 'cand' if value == candidate else 'prev'] += 1
            decoded.append(f' {case["shot"]:18s} {"cand" if won else "prev"}/{pair["confidence"]}: '
                           f'{pair.get("changed", "")} | regression: {pair.get("regression", "")}')
        gap = verdict.get('next_gap', {})
        decoded.append(f'  NEXT {gap.get("region", "")} -> {gap.get("target", "")}')
    flat = [vote for values in votes.values() for vote, _ in values]
    cand, prev = flat.count('cand'), flat.count('prev')
    print(f'candidate {cand}  previous {prev}  unchanged shots {unchanged}')
    # 30 correlated votes: a bare majority is indistinguishable from chance.
    total = cand + prev
    print('verdict', 'ACCEPT' if cand >= total * 2 / 3 else 'REJECT' if cand <= total / 2 - 1 else 'INCONCLUSIVE: split the change')
    for shot, values in sorted(votes.items()):
        print(f'shot {shot:18s} {" ".join(f"{v}/{c}" for v, c in values)}')
    for dim in PROGRESS_DIMS:
        print(f'dim {dim:12s} cand {dims[dim]["cand"]:2d}  prev {dims[dim]["prev"]:2d}  same {dims[dim]["same"]:2d}')
    print('\n'.join(decoded))


def main(key_path, paths):
    with open(key_path) as handle:
        manifest = json.load(handle)
    key = {k['id']: k for k in manifest['key']}
    if manifest.get('mode') == 'progress':
        progress(key, paths, manifest.get('unchanged', []))
    else:
        scene(key, paths)


if __name__ == '__main__':
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    main(sys.argv[1], sys.argv[2:])
