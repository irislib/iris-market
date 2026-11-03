"""Fit the quantized DeBERTa classifier head using marketplace search pairs.

Inputs: upstream model directory, JSON from evaluate-search.mjs, output ONNX file.
Dependencies: onnx 1.19.1, onnxruntime 1.23.2, tokenizers 0.22.1, scipy 1.18.1, numpy 2.5.4.
The model repo is Xenova/nli-deberta-v3-xsmall at revision
2a4f614a701367a02d51389039afc998faeda637. Generate a corpus with
node web/scripts/evaluate-search.mjs titles|challenge|final > corpus.json.
"""
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
from onnx import TensorProto, helper, numpy_helper
from scipy.optimize import minimize
from scipy.special import expit, softmax
from tokenizers import Tokenizer

directory, corpus, output = map(Path, sys.argv[1:])
original = (directory / "onnx/model_quantized.onnx").read_bytes()
assert hashlib.sha256(original).hexdigest() == "3fac2500c45c75af42c7711de0d1b93d59577456100208be0dc1f9e8811946b6"
model = onnx.load_from_string(original)
hidden = "/pooler/Mul_1_output_0"
model.graph.output.append(helper.make_tensor_value_info(hidden, TensorProto.FLOAT, [None, 384]))
options = ort.SessionOptions()
options.intra_op_num_threads = 2
session = ort.InferenceSession(model.SerializeToString(), options, providers=["CPUExecutionProvider"])
tokenizer_path = directory / "tokenizer.json"
assert hashlib.sha256(tokenizer_path.read_bytes()).hexdigest() == "a86f883318afa11c8c10466f1bf4efaeb6ded28a52cbe57217a8fa0d0a2a87df"
tokenizer = Tokenizer.from_file(str(tokenizer_path))
samples = json.loads(corpus.read_text())


def inputs(sample):
    for text in sample["texts"]:
        ids = np.array([tokenizer.encode(text, sample["condition"]).ids], dtype=np.int64)
        yield {"input_ids": ids, "attention_mask": np.ones_like(ids)}


features, offsets, labels = [], [], []
for sample in samples:
    if sample["split"] == "train":
        for pair in inputs(sample):
            logits, state = session.run(None, pair)
            features.append(state[0])
            offsets.append(logits[0, 1] - np.logaddexp(logits[0, 0], logits[0, 2]))
            labels.append(sample["match"])

# Fit a regularized residual to the entailment column. The two competing
# classes retain their original weights. No evaluation examples enter the fit.
x = np.column_stack([features, np.ones(len(features))])
y = np.array(labels)


def loss(delta):
    z = offsets + x @ delta
    return (np.logaddexp(0, z).sum() - y @ z + delta @ delta / 2,
            x.T @ (expit(z) - y) + delta)


fit = minimize(loss, np.zeros(x.shape[1]), jac=True, method="L-BFGS-B")
assert fit.success, fit.message
params = {p.name: p for p in model.graph.initializer}
def read_parameter(name):
    return numpy_helper.to_array(params["classifier." + name]).copy()

weight, scale, zero, bias = map(read_parameter, ["weight_quantized", "weight_scale", "weight_zero_point", "bias"])
column = (weight[:, 1].astype(float) - zero[1]) * scale[1] + fit.x[:-1]
scale[1], zero[1] = np.max(abs(column)) / 127, 0
weight[:, 1] = np.rint(column / scale[1]).clip(-127, 127)
bias[1] += fit.x[-1]
for key, array in zip(["weight_quantized", "weight_scale", "weight_zero_point", "bias"], [weight, scale, zero, bias]):
    name = "classifier." + key
    params[name].CopyFrom(numpy_helper.from_array(array, name))
del model.graph.output[-1]
onnx.checker.check_model(model)
onnx.save(model, output)
tuned = ort.InferenceSession(str(output), options, providers=["CPUExecutionProvider"])
for name, engine in [("original", session), ("tuned", tuned)]:
    counts = {}
    rankings = {}
    for sample in samples:
        if sample["split"] != "test":
            continue
        score = 0
        for pair in inputs(sample):
            score = max(score, softmax(engine.run(["logits"], pair)[0][0])[1])
            if score >= .5:
                break
        query = sample["query"]
        group = "word" if " " not in query else "sentence" if query.endswith(".") else "phrase"
        key = ("TP" if sample["match"] else "FP") if score >= .5 else ("FN" if sample["match"] else "TN")
        counts.setdefault(group, []).append(key)
        rankings.setdefault(query, []).append((float(score), sample["match"]))
    print(name, {g: {k: a.count(k) for k in ["TP", "FP", "FN", "TN"]} for g, a in counts.items()})
    print("Relevant in top two:", sum(sum(y for _, y in sorted(a,key=lambda v:-v[0])[:2]) for a in rankings.values()), "/", len(rankings)*2)
