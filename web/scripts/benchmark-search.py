"""Reproduce the title-only shopping benchmark with the browser's packed classifier.

Usage: python benchmark-search.py BASE_MODEL_DIR ESCI_DIR
Uses duckdb 1.4.1 and the pinned Python dependencies in tune-search.py.
ESCI source: amazon-science/esci-data, commit 7916cdf6ab75a462e77f20ab40428a10923998d5.
Both shopping_queries_dataset_{examples,products}.parquet files are required.
"""
import base64
import hashlib
import json
import math
import random
import re
import sys
from collections import defaultdict
from pathlib import Path
from statistics import mean

import duckdb
import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

base, dataset = map(Path, sys.argv[1:])
for name, expected in [
    ("examples", "4a735b693b4a424a6fc67f5be6e4c811495c488bbf66d02a602d308b2744263a"),
    ("products", "25124442d064d64b26f74082d6fa09438d679efc0c183cf28d19064a2b65a265"),
]:
    with (dataset / f"shopping_queries_dataset_{name}.parquet").open("rb") as file:
        assert hashlib.file_digest(file, "sha256").hexdigest() == expected

db = duckdb.connect()
db.execute("set threads=2")
groups = defaultdict(list)
for query, product, label in db.execute("""
    select query, product_id, esci_label from read_parquet(?)
    where product_locale='us' and split='test' and small_version
    order by query, product_id
""", [str(dataset / "shopping_queries_dataset_examples.parquet")]).fetchall():
    groups[query].append((product, label))

# Sample held-out queries before scoring. Sentence variants retain the exact
# product intent and its labels. These are paraphrases, not recorded sentences.
forms = ["I am looking for {}.", "Where can I find {}?", "Can you show me {}?",
         "I want to buy {}.", "Do you have {}?", "Please find me {}."]
samples = []
seen = set()
rng = random.Random(20261103)
for kind, size in [("word", 120), ("phrase", 120), ("sentence", 120), ("confirmation", 100)]:
    if kind in ("sentence", "confirmation"):
        rng = random.Random(20261103 if kind == "sentence" else 79431)
    eligible = [q for q, items in groups.items()
                if q not in seen and bool(re.fullmatch(r"[\w-]+", q)) == (kind == "word")
                and len(items) >= 8 and len({y for _, y in items}) > 1
                and any(y == "E" for _, y in items)]
    for i, q in enumerate(rng.sample(eligible, size)):
        seen.add(q)
        text = forms[i % len(forms)].format(q) if kind in ("sentence", "confirmation") else q
        samples.extend((text, product, label, kind) for product, label in rng.sample(groups[q], 8))

db.execute("create table sample(q varchar, p varchar, y varchar, k varchar)")
db.executemany("insert into sample values (?, ?, ?, ?)", samples)
rows = db.execute("""
    select q,p,y,k,product_title from sample join read_parquet(?)
    on p=product_id and product_locale='us' order by q,p
""", [str(dataset / "shopping_queries_dataset_products.parquet")]).fetchall()
assert len(rows) == len(samples)

patch_path = Path(__file__).resolve().parents[1] / "src/feed-filter/search-head.json"
patch = json.loads(patch_path.read_text())
source = (base / "onnx/model_quantized.onnx").read_bytes()
pieces, cursor = [], 0
for start, end, replacement in patch["edits"]:
    pieces.extend((source[cursor:start], base64.b64decode(replacement)))
    cursor = end
packed = b"".join([*pieces, source[cursor:]])
assert hashlib.sha256(packed).hexdigest() == patch["sha256"]
options = ort.SessionOptions()
options.intra_op_num_threads = 3
engine = ort.InferenceSession(packed, options, providers=["CPUExecutionProvider"])
tokenizer = Tokenizer.from_file(str(base / "tokenizer.json"))
tokenizer.enable_truncation(max_length=512)
results = defaultdict(lambda: defaultdict(list))
for q, product, label, kind, title in rows:
    topic = kind == "word"
    condition = f"This text is about {q}." if topic else f"This listing offers {q}."
    texts = [title, title + "\nCategories: \n"] if topic else ["Offered: " + title]
    scores = [0., 0., 0.]
    for text in texts:
        ids = np.array([tokenizer.encode(text, condition).ids], dtype=np.int64)
        a, original, c, trained = engine.run(None, {"input_ids": ids, "attention_mask": np.ones_like(ids)})[0][0]
        for i, b in enumerate([original, trained, .25 * original + .75 * trained]):
            if scores[i] < .5:
                scores[i] = max(scores[i], float(1 / (1 + np.exp(a - b) + np.exp(c - b))))
        if min(scores) >= .5:
            break
    results[kind][q].append((product, label, *scores))


def gain(items):
    weights = {"E": 1., "S": .1, "C": .01, "I": 0.}
    return sum(weights[item[1]] / math.log2(i + 2) for i, item in enumerate(items[:3]))


for kind, queries in results.items():
    for idx, variant in enumerate(["upstream", "trained", "blended"], 2):
        quality = []
        exact = other = 0
        for items in queries.values():
            ideal = gain(sorted(items, key=lambda item: "ESCI".index(item[1])))
            visible = sorted((item for item in items if item[idx] >= .5), key=lambda item: (-item[idx], item[0]))
            if ideal:
                quality.append(gain(visible) / ideal)
            exact += sum(item[1] == "E" for item in visible)
            other += sum(item[1] != "E" for item in visible)
        print(kind, variant, "queries", len(queries), "nDCG@3", round(mean(quality), 3), "exact", exact, "other", other)
