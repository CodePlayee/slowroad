#!/usr/bin/env python3
"""Unblind and aggregate full-scene judge verdicts.

    python3 gauntlet/aggregate-scene-blind.py <key.json> <judge-*.json ...>

Prints wins (build / reference / tie), mean 0-5 scores, the mean per-dimension
gap (reference minus build) and the per-shot build mean.
"""
import json
import statistics
import sys

DIMS = ['composition', 'terrain', 'road', 'vegetation', 'ground', 'atmosphere', 'lighting', 'vehicle', 'cleanliness']


def main(key_path, verdict_paths):
    with open(key_path) as handle:
        key = {k['id']: k for k in json.load(handle)['key']}
    tally = {'build': 0, 'reference': 0, 'tie': 0}
    gaps = {d: [] for d in DIMS}
    build_scores, ref_scores, per_shot = [], [], {}
    for path in verdict_paths:
        with open(path) as handle:
            verdict = json.load(handle)
        for pair in verdict['pairs']:
            case = key[pair['id']]
            build = 'A' if case['A']['role'] == 'build' else 'B'
            ref = 'B' if build == 'A' else 'A'
            winner = pair['winner']
            tally['build' if winner == build else 'reference' if winner == ref else 'tie'] += 1
            for dim in DIMS:
                b, r = pair['scores'][build].get(dim), pair['scores'][ref].get(dim)
                if isinstance(b, (int, float)) and isinstance(r, (int, float)):
                    gaps[dim].append(r - b)
                    build_scores.append(b)
                    ref_scores.append(r)
                    per_shot.setdefault(case['shot'], []).append(b)
    print('wins', tally)
    print('mean build %.2f  reference %.2f' % (statistics.mean(build_scores), statistics.mean(ref_scores)))
    for dim, values in sorted(gaps.items(), key=lambda item: -statistics.mean(item[1]) if item[1] else 0):
        if values:
            print(f'gap {dim:12s} {statistics.mean(values):+.2f}')
    for shot, values in sorted(per_shot.items()):
        print(f'shot {shot:18s} {statistics.mean(values):.2f}')


if __name__ == '__main__':
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    main(sys.argv[1], sys.argv[2:])
