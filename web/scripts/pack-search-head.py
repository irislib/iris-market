"""Build the browser ONNX patch from pinned original and tuned DeBERTa files.

Usage: python pack-search-head.py original.onnx tuned.onnx > search-head.json
Requires onnx 1.19.1 and numpy.
"""
import base64
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import onnx
from onnx import numpy_helper

base, candidate = [Path(path).read_bytes() for path in sys.argv[1:]]
digest = lambda data: hashlib.sha256(data).hexdigest()
assert digest(base) == "3fac2500c45c75af42c7711de0d1b93d59577456100208be0dc1f9e8811946b6"
assert digest(candidate) == "d3ca651b22070e449abbd8393583dc7ddca6ea4235e8168cd4a204bf07ecb28b"
model = onnx.load_from_string(base)
trained = {p.name: p for p in onnx.load_from_string(candidate).graph.initializer}
for parameter in model.graph.initializer:
    if parameter.name.startswith("classifier."):
        orig = numpy_helper.to_array(parameter)
        extra = numpy_helper.to_array(trained[parameter.name])[..., 1:2]
        combined = np.concatenate([orig, extra], axis=-1)
        parameter.CopyFrom(numpy_helper.from_array(combined, parameter.name))
model.graph.output[0].type.tensor_type.shape.dim[-1].dim_value = 4
onnx.checker.check_model(model)
packed = model.SerializeToString()

# Encode only changed ranges in the pinned protobuf. Large identical encoder
# tensors are copied directly from the user's upstream model at load time.
a = b = 0
edits = []
while a < len(base) and b < len(packed):
    length = min(1024 * 1024, len(base) - a, len(packed) - b)
    old, new = base[a:a+length], packed[b:b+length]
    if old == new:
        a += length
        b += length
        continue
    same = next(i for i,(x,y) in enumerate(zip(old,new)) if x != y)
    a += same
    b += same
    for skip in range(0, 8192, 16):
        anchor = packed[b+skip:b+skip+64]
        end = base.find(anchor, a, a+16384) if len(anchor)==64 else -1
        if end >= 0:
            edits.append([a, end, base64.b64encode(packed[b:b+skip]).decode()])
            a = end
            b += skip
            break
    else:
        raise ValueError("Unexpected difference in the encoder")
if a!=len(base) or b!=len(packed):
    edits.append([a,len(base),base64.b64encode(packed[b:]).decode()])
print(json.dumps(dict(sha256=digest(packed), size=len(packed), edits=edits),indent=2))
