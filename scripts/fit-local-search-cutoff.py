#!/usr/bin/env python3
"""Fit the native loopback search cutoff using judged development data.

Pass one JSONL file per model. Each row contains a normalized first-token Yes
probability in "score" and a relevance "grade" of 0, 1, or 2. Use the same
query/listing pairs for each model and keep final evaluation data separate.
Only counts and the shared calibration are printed. No network or dependencies.

Example:
    python3 scripts/fit-local-search-cutoff.py model-a-dev.jsonl model-b-dev.jsonl
"""
import argparse
from collections import Counter, defaultdict
from fractions import Fraction
import json
import math
from pathlib import Path


def read_scores(path):
    rows = []
    with path.open() as stream:
        for number, line in enumerate(stream, 1):
            try:
                row = json.loads(line)
                score, grade = row["score"], row["grade"]
                if type(score) not in (float, int) or not math.isfinite(score) or not 0 <= score <= 1:
                    raise ValueError()
                if type(grade) is not int or grade not in (0, 1, 2):
                    raise ValueError()
            except (ValueError, TypeError, KeyError):
                raise ValueError(f"{path.name}, line {number}: expected a score in [0,1] and a grade in {{0,1,2}}") from None
            rows.append((score, grade > 0))
    if len({label for _, label in rows}) < 2:
        raise ValueError(f"{path.name}: both relevant and unrelated examples are required")
    return rows


def fit(datasets):
    # Begin with all pairs admitted. As the threshold increases, removing a
    # negative improves specificity and removing a positive reduces recall.
    changes = defaultdict(Fraction)
    for rows in datasets:
        counts = Counter(label for _, label in rows)
        for score, positive in rows:
            changes[score] += Fraction(-1 if positive else 1, 2 * len(datasets) * counts[positive])
    scores = sorted(changes)
    if len(scores) < 2:
        raise ValueError("The model scores cannot separate any examples")
    accuracy = Fraction(1, 2)
    best_accuracy = Fraction(0)
    cutoff = 0
    for current, following in zip(scores, scores[1:]):
        accuracy += changes[current]
        if accuracy > best_accuracy:
            best_accuracy = accuracy
            cutoff = (current + following) / 2
    if best_accuracy <= Fraction(1, 2):
        raise ValueError("No cutoff improved on chance-balanced classification")
    return {"models": len(datasets), "scored_rows": sum(map(len, datasets)), "raw_cutoff": cutoff,
            "yes_odds": cutoff / (1 - cutoff), "balanced_accuracy": float(best_accuracy)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("scores", type=Path, nargs="+")
    args = parser.parse_args()
    try:
        print(json.dumps(fit([read_scores(path) for path in args.scores]), indent=2))
    except (OSError, ValueError) as err:
        parser.exit(2, f"{err}\n")
