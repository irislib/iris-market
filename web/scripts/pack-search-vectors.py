"""Reproduce Market's topic vectors from Iris Client commit 6419ec3b768f691da098554a63fcfe06f46cdbac.

Pass the pinned src/lib/post-search/model directory and destination file.
The input keyword index contains MiniLM-L3-v2 embeddings in tokenizer order.
Keep the signs of the first 9,000 vocabulary vectors. No query data is used.
"""
import hashlib
import json
import re
import sys
from pathlib import Path

source, destination = map(Path, sys.argv[1:])
def verified(name, digest):
    data = (source / name).read_bytes()
    if hashlib.sha256(data).hexdigest() != digest:
        raise ValueError(f"Unexpected {name}")
    return data

vocab = json.loads(verified("search-tokenizer.json", "2fc687b11de0bc1b3d8348f92e3b49ef1089a621506c7661fbf3248fcd54947e"))["model"]["vocab"]
vectors = verified("search-keywords.bin", "445e2f19b506873911325f594bb620dd156ac0c7ced05e1dbfba34a7814ed866")
words = sorted((w for w in vocab if re.fullmatch("[a-z]{3,18}", w)), key=vocab.get)[:9000]
signs = bytes(sum((vectors[i + j] < 128) << j for j in range(8)) for i in range(0, len(words) * 384, 8))
destination.write_bytes("\n".join(words).encode("ascii") + b"\0" + signs)
