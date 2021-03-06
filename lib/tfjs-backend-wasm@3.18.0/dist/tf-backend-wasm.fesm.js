/**
 * @license
 * Copyright 2022 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
import { _FusedMatMul, broadcast_util, util, Abs, backend_util, Add, AddN, Identity, Transpose, All, Any, ArgMax, AvgPool, Reshape, BatchMatMul, slice_util, buffer, Slice, BatchToSpaceND, Cast, Ceil, ClipByValue, Concat, Conv2D, Conv2DBackpropInput, Cos, Cosh, CropAndResize, Cumprod, Cumsum, DepthToSpace, DepthwiseConv2dNative, Elu, Equal, Exp, ExpandDims, Fill, FlipLeftRight, Floor, FloorDiv, FusedBatchNorm, FusedConv2D, FusedDepthwiseConv2D, GatherNd, gather_util, GatherV2, Greater, GreaterEqual, LeakyRelu, Less, LessEqual, Log, LogicalAnd, Max, Maximum, MaxPool, Mean, Min, Minimum, MirrorPad, Multiply, Neg, NonMaxSuppressionV3, NonMaxSuppressionV4, NonMaxSuppressionV5, NotEqual, OneHot, OnesLike, Pack, PadV2, Pow, Prelu, Prod, Range, RealDiv, Relu, Relu6, ResizeBilinear, Reverse, RotateWithOffset, Round, Rsqrt, ScatterNd, scatter_util, Select, Sigmoid, Sin, Softmax, SpaceToBatchND, SparseFillEmptyRows, SparseReshape, SparseSegmentMean, SparseSegmentSum, SplitV, Sqrt, Square, SquaredDifference, Step, StridedSlice, Sub, Sum, Tan, Tanh, Tile, TopK, Transform, Unpack, ZerosLike, registerKernel, env, KernelBackend, DataStorage, engine, deprecationWarn, registerBackend } from '@tensorflow/tfjs-core';
import path from 'path';
import fs from 'fs';
import worker_threads from 'worker_threads';
import perf_hooks from 'perf_hooks';
import os from 'os';

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
// This enum must align with the enum defined in cc/backend.h.
var CppDType;
(function (CppDType) {
    CppDType[CppDType["float32"] = 0] = "float32";
    CppDType[CppDType["int32"] = 1] = "int32";
    CppDType[CppDType["bool"] = 2] = "bool";
    CppDType[CppDType["string"] = 3] = "string";
    CppDType[CppDType["complex64"] = 4] = "complex64";
})(CppDType || (CppDType = {}));
// Must match enum in cc/fusable_activations.h.
var FusableActivation;
(function (FusableActivation) {
    FusableActivation[FusableActivation["linear"] = 0] = "linear";
    FusableActivation[FusableActivation["relu"] = 1] = "relu";
    FusableActivation[FusableActivation["relu6"] = 2] = "relu6";
    FusableActivation[FusableActivation["prelu"] = 3] = "prelu";
    FusableActivation[FusableActivation["leakyrelu"] = 4] = "leakyrelu";
    FusableActivation[FusableActivation["sigmoid"] = 5] = "sigmoid";
    FusableActivation[FusableActivation["elu"] = 6] = "elu";
})(FusableActivation || (FusableActivation = {}));

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmFusedMatMul;
function setup(backend) {
    wasmFusedMatMul = backend.wasm.cwrap(_FusedMatMul, null /* void */, [
        'number',
        'array',
        'number',
        'number',
        'array',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number' // out_id
    ]);
}
function fusedBatchMatMul(args) {
    const { inputs, backend, attrs } = args;
    const { a, b, bias, preluActivationWeights } = inputs;
    if (a.dtype !== 'float32' || b.dtype !== 'float32') {
        throw new Error(`_FusedMatMul for non non-float32 tensors not yet supported.`);
    }
    const { transposeA, transposeB, activation, leakyreluAlpha } = attrs;
    const aId = backend.dataIdMap.get(a.dataId).id;
    const bId = backend.dataIdMap.get(b.dataId).id;
    let biasId = 0;
    if (bias != null) {
        const biasData = backend.dataIdMap.get(bias.dataId);
        if (biasData.shape.length !== 1) {
            throw new Error(`_FusedMatMul only supports rank-1 bias but got ` +
                `rank ${biasData.shape.length}.`);
        }
        biasId = biasData.id;
    }
    const preluActivationWeightsId = preluActivationWeights == null ?
        0 :
        backend.dataIdMap.get(preluActivationWeights.dataId).id;
    const fusedActivation = FusableActivation[activation];
    if (fusedActivation == null) {
        throw new Error(`${activation} activation not yet supported for FusedConv2D ` +
            `in the wasm backend.`);
    }
    const leftDim = transposeA ? a.shape[2] : a.shape[1];
    const rightDim = transposeB ? b.shape[1] : b.shape[2];
    const batchDims = broadcast_util.assertAndGetBroadcastShape(a.shape.slice(0, -2), b.shape.slice(0, -2));
    const out = backend.makeOutput([...batchDims, leftDim, rightDim], a.dtype);
    const outId = backend.dataIdMap.get(out.dataId).id;
    const aShapeBytes = new Uint8Array(new Int32Array(a.shape).buffer);
    const bShapeBytes = new Uint8Array(new Int32Array(b.shape).buffer);
    wasmFusedMatMul(aId, aShapeBytes, a.shape.length, bId, bShapeBytes, b.shape.length, transposeA, transposeB, fusedActivation, biasId, preluActivationWeightsId, leakyreluAlpha || 0, outId);
    return out;
}
const _fusedMatMulConfig = {
    kernelName: _FusedMatMul,
    backendName: 'wasm',
    setupFunc: setup,
    kernelFunc: fusedBatchMatMul
};

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
function createUnaryKernelConfig(kernelName, outType) {
    let wasmFunc;
    function setupFunc(backend) {
        wasmFunc = backend.wasm.cwrap(kernelName, null /* void */, [
            'number',
            'number',
            'number',
        ]);
    }
    function kernelFunc(args) {
        const { backend, inputs: { x } } = args;
        const xId = backend.dataIdMap.get(x.dataId).id;
        const out = backend.makeOutput(x.shape, outType || x.dtype);
        const outId = backend.dataIdMap.get(out.dataId).id;
        // Short-circuit zero-sized tensors.
        if (util.sizeFromShape(out.shape) === 0) {
            return out;
        }
        wasmFunc(xId, CppDType[x.dtype], outId);
        return out;
    }
    return { kernelName, backendName: 'wasm', setupFunc, kernelFunc };
}

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
const absConfig = createUnaryKernelConfig(Abs);

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
function createBinaryKernelConfig(kernelName, supportsFullBroadcast, dtype) {
    let wasmFunc;
    function setupFunc(backend) {
        wasmFunc = backend.wasm.cwrap(kernelName, null /* void */, [
            'number',
            'array',
            'number',
            'number',
            'array',
            'number',
            'number',
            'number' // out_id
        ]);
    }
    function kernelFunc(args) {
        const { backend, inputs } = args;
        const { a, b } = inputs;
        const aId = backend.dataIdMap.get(a.dataId).id;
        const bId = backend.dataIdMap.get(b.dataId).id;
        const outputType = dtype != null ? dtype : a.dtype;
        const newShape = backend_util.assertAndGetBroadcastShape(a.shape, b.shape);
        const out = backend.makeOutput(newShape, outputType);
        // Short-circuit zero-sized tensors.
        if (util.sizeFromShape(newShape) === 0) {
            return out;
        }
        const aShapeBytes = new Uint8Array(new Int32Array(a.shape).buffer);
        const bShapeBytes = new Uint8Array(new Int32Array(b.shape).buffer);
        const outId = backend.dataIdMap.get(out.dataId).id;
        const kernelFunc = () => wasmFunc(aId, aShapeBytes, a.shape.length, bId, bShapeBytes, b.shape.length, CppDType[a.dtype], outId);
        kernelFunc();
        return out;
    }
    return { kernelName, backendName: 'wasm', setupFunc, kernelFunc };
}

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
const addConfig = createBinaryKernelConfig(Add);

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmFunc;
function setupFunc(backend) {
    wasmFunc = backend.wasm.cwrap(AddN, null /* void */, [
        'array',
        'number',
        'number',
        'number',
    ]);
}
function addn(args) {
    const { inputs, backend } = args;
    const out = backend.makeOutput(inputs[0].shape, inputs[0].dtype);
    // Short-circuit zero-sized tensors.
    if (util.sizeFromShape(out.shape) === 0) {
        return out;
    }
    const inputIds = inputs.map(x => backend.dataIdMap.get(x.dataId).id);
    const inputIdsBytes = new Uint8Array(new Int32Array(inputIds).buffer);
    const outId = backend.dataIdMap.get(out.dataId).id;
    wasmFunc(inputIdsBytes, inputIds.length, CppDType[out.dtype], outId);
    return out;
}
const addNConfig = {
    kernelName: AddN,
    backendName: 'wasm',
    setupFunc,
    kernelFunc: addn,
};

/**
 * @license
 * Copyright 2020 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
function identity(args) {
    const { inputs: { x }, backend } = args;
    const out = backend.makeOutput(x.shape, x.dtype);
    const inVals = backend.typedArrayFromHeap(x);
    const outVals = backend.typedArrayFromHeap(out);
    outVals.set(inVals);
    return out;
}
const identityConfig = {
    kernelName: Identity,
    backendName: 'wasm',
    kernelFunc: identity,
};

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmTranspose;
function setup$1(backend) {
    wasmTranspose = backend.wasm.cwrap(Transpose, null /* void */, [
        'number',
        'array',
        'number',
        'number',
        'number',
        'array',
        'number',
    ]);
}
function transpose(args) {
    const { inputs, backend, attrs } = args;
    // Reduce any dimensions with size one. Lower-rank transpose kernel performs
    // better due to simpler memory access pattern.
    const [reducedShape, perm] = removeOneSizeDims(inputs.x.shape, attrs.perm);
    let permIsNoOp = true;
    for (let i = 0; i < perm.length; i++) {
        if (perm[i] !== i) {
            permIsNoOp = false;
        }
    }
    const outShape = computeOutShape(inputs.x.shape, attrs.perm);
    const x = {
        dataId: inputs.x.dataId,
        shape: reducedShape,
        dtype: inputs.x.dtype
    };
    if (permIsNoOp) {
        const cloned = identity({ inputs, backend });
        cloned.shape = outShape;
        return cloned;
    }
    const out = backend.makeOutput(outShape, x.dtype);
    const xId = backend.dataIdMap.get(x.dataId).id;
    const outId = backend.dataIdMap.get(out.dataId).id;
    const permBytes = new Uint8Array(new Int32Array(perm).buffer);
    const xShapeBytes = new Uint8Array(new Int32Array(x.shape).buffer);
    wasmTranspose(xId, xShapeBytes, x.shape.length, CppDType[x.dtype], outId, permBytes, perm.length);
    return out;
}
function computeOutShape(inShape, perm) {
    const outShape = new Array(inShape.length);
    for (let i = 0; i < outShape.length; i++) {
        outShape[i] = inShape[perm[i]];
    }
    return outShape;
}
function removeOneSizeDims(shape, perm) {
    const newShape = [];
    const newPerm = [];
    for (let i = 0; i < shape.length; ++i) {
        if (shape[i] !== 1) {
            newShape.push(shape[i]);
        }
        if (shape[perm[i]] !== 1) {
            newPerm.push(perm[i]);
        }
    }
    for (let i = 0; i < newPerm.length; ++i) {
        let minValIdx = -1;
        for (let j = 0; j < newPerm.length; ++j) {
            if (newPerm[j] >= i &&
                (minValIdx === -1 || newPerm[minValIdx] > newPerm[j])) {
                minValIdx = j;
            }
        }
        newPerm[minValIdx] = i;
    }
    return [newShape, newPerm];
}
const transposeConfig = {
    kernelName: Transpose,
    backendName: 'wasm',
    kernelFunc: transpose,
    setupFunc: setup$1,
};

/**
 * @license
 * Copyright 2020 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
/**
 * Compute permutation axes and do a transpose if necessary.
 *
 * Used by reduction ops.
 * @param x input TensorInfo
 * @param axis reduction axes
 * @param backend wasm backend instance
 */
function permuteAxesAndTranspose(x, axis, backend) {
    const xShape = x.shape;
    const xRank = x.shape.length;
    const originalAxes = util.parseAxisParam(axis, xShape);
    let axes = originalAxes;
    const permutedAxes = backend_util.getAxesPermutation(axes, xRank);
    let xTransposed = null;
    let inputWasTransposed = false;
    if (permutedAxes != null) {
        const newShape = new Array(xRank);
        for (let i = 0; i < newShape.length; i++) {
            newShape[i] = xShape[permutedAxes[i]];
        }
        axes = backend_util.getInnerMostAxes(axes.length, xRank);
        xTransposed =
            transpose({ inputs: { x }, attrs: { perm: permutedAxes }, backend });
        const xId = backend.dataIdMap.get(x.dataId).id;
        const transposedId = backend.dataIdMap.get(xTransposed.dataId).id;
        if (transposedId !== xId) {
            inputWasTransposed = true;
        }
    }
    return { transposed: xTransposed, originalAxes, axes, inputWasTransposed };
}

/**
 * @license
 * Copyright 2021 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmAll;
function setup$2(backend) {
    wasmAll = backend.wasm.cwrap(All, null /*void*/, ['number, number, number']);
}
function all(args) {
    const { backend, inputs, attrs } = args;
    const { axis, keepDims } = attrs;
    const { x } = inputs;
    const xId = backend.dataIdMap.get(x.dataId).id;
    let inputId = xId;
    let input = x;
    const { transposed, axes, originalAxes, inputWasTransposed } = permuteAxesAndTranspose(x, axis, backend);
    if (inputWasTransposed) {
        const transposedId = backend.dataIdMap.get(transposed.dataId).id;
        input = transposed;
        inputId = transposedId;
    }
    const inputRank = input.shape.length;
    backend_util.assertAxesAreInnerMostDims('all', axes, inputRank);
    const [outShape, reduceShape] = backend_util.computeOutAndReduceShapes(input.shape, axes);
    const reduceSize = util.sizeFromShape(reduceShape);
    const out = backend.makeOutput(outShape, x.dtype);
    if (util.sizeFromShape(input.shape) !== 0) {
        const outId = backend.dataIdMap.get(out.dataId).id;
        wasmAll(inputId, reduceSize, outId);
    }
    if (inputWasTransposed) {
        // dispose of the transposed tensor.
        backend.disposeData(transposed.dataId);
    }
    if (keepDims) {
        // reshape
        const newShape = backend_util.expandShapeToKeepDim(out.shape, originalAxes);
        out.shape = newShape;
    }
    return out;
}
const allConfig = {
    kernelName: All,
    backendName: 'wasm',
    setupFunc: setup$2,
    kernelFunc: all
};

/**
 * @license
 * Copyright 2021 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmAny;
function setup$3(backend) {
    wasmAny = backend.wasm.cwrap(Any, null /*void*/, ['number, number, number']);
}
function any(args) {
    const { backend, inputs, attrs } = args;
    const { axis, keepDims } = attrs;
    const { x } = inputs;
    const xId = backend.dataIdMap.get(x.dataId).id;
    let inputId = xId;
    let input = x;
    const { transposed, axes, originalAxes, inputWasTransposed } = permuteAxesAndTranspose(x, axis, backend);
    if (inputWasTransposed) {
        const transposedId = backend.dataIdMap.get(transposed.dataId).id;
        input = transposed;
        inputId = transposedId;
    }
    const inputRank = input.shape.length;
    backend_util.assertAxesAreInnerMostDims('any', axes, inputRank);
    const [outShape, reduceShape] = backend_util.computeOutAndReduceShapes(input.shape, axes);
    const reduceSize = util.sizeFromShape(reduceShape);
    const out = backend.makeOutput(outShape, x.dtype);
    if (util.sizeFromShape(input.shape) !== 0) {
        const outId = backend.dataIdMap.get(out.dataId).id;
        wasmAny(inputId, reduceSize, outId);
    }
    if (inputWasTransposed) {
        // dispose of the transposed tensor.
        backend.disposeData(transposed.dataId);
    }
    if (keepDims) {
        // reshape
        const newShape = backend_util.expandShapeToKeepDim(out.shape, originalAxes);
        out.shape = newShape;
    }
    return out;
}
const anyConfig = {
    kernelName: Any,
    backendName: 'wasm',
    setupFunc: setup$3,
    kernelFunc: any
};

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmFunc$1;
function setup$4(backend) {
    wasmFunc$1 = backend.wasm.cwrap(ArgMax, null /* void */, [
        'number',
        'number',
        'number',
        'number',
        'number' // out_id
    ]);
}
function argmax(args) {
    const { backend, inputs, attrs } = args;
    const { axis } = attrs;
    const { x } = inputs;
    const xId = backend.dataIdMap.get(x.dataId).id;
    let inputId = xId;
    let input = x;
    const { transposed, axes, inputWasTransposed } = permuteAxesAndTranspose(x, axis, backend);
    if (inputWasTransposed) {
        const transposedId = backend.dataIdMap.get(transposed.dataId).id;
        if (transposedId !== xId) {
            // transpose was not a no-op. We will need to dispose of this
            // once we are done.
            input = transposed;
            inputId = transposedId;
        }
    }
    const outShape = input.shape.slice(0, -1);
    const out = backend.makeOutput(outShape, 'int32');
    const outId = backend.dataIdMap.get(out.dataId).id;
    const outerSize = util.sizeFromShape(out.shape);
    const innerSize = input.shape[axes[0]];
    wasmFunc$1(inputId, CppDType[input.dtype], outerSize, innerSize, outId);
    if (inputWasTransposed) {
        // dispose of the transposed tensor.
        backend.disposeData(transposed.dataId);
    }
    return out;
}
const argMaxConfig = {
    kernelName: ArgMax,
    backendName: 'wasm',
    kernelFunc: argmax,
    setupFunc: setup$4
};

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmAvgPool;
function setup$5(backend) {
    wasmAvgPool = backend.wasm.cwrap(AvgPool, null /* void */, [
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
    ]);
}
function avgPool(args) {
    const { inputs, attrs, backend } = args;
    const x = inputs.x;
    const xId = backend.dataIdMap.get(x.dataId).id;
    const { filterSize, strides, pad, dimRoundingMode } = attrs;
    const convInfo = backend_util.computePool2DInfo(x.shape, filterSize, strides, 1 /* dilations */, pad, dimRoundingMode);
    const filterHeight = convInfo.filterHeight;
    const filterWidth = convInfo.filterWidth;
    const padTop = convInfo.padInfo.top;
    const padRight = convInfo.padInfo.right;
    const padBottom = convInfo.padInfo.bottom;
    const padLeft = convInfo.padInfo.left;
    const strideHeight = convInfo.strideHeight;
    const strideWidth = convInfo.strideWidth;
    const channels = convInfo.inChannels;
    if (convInfo.dataFormat !== 'channelsLast') {
        throw new Error(`wasm backend does not support dataFormat:'` +
            `${convInfo.dataFormat}'. Please use 'channelsLast'.`);
    }
    if (convInfo.dilationWidth !== 1 || convInfo.dilationHeight !== 1) {
        throw new Error(`was backend only supports average pooling with dilation = [1, 1], ` +
            `got [${convInfo.dilationHeight}, ${convInfo.dilationWidth}].`);
    }
    const out = backend.makeOutput(convInfo.outShape, 'float32');
    const outId = backend.dataIdMap.get(out.dataId).id;
    wasmAvgPool(xId, x.shape[0], x.shape[1], x.shape[2], filterHeight, filterWidth, padTop, padRight, padBottom, padLeft, strideHeight, strideWidth, channels, outId);
    return out;
}
const avgPoolConfig = {
    kernelName: AvgPool,
    backendName: 'wasm',
    setupFunc: setup$5,
    kernelFunc: avgPool
};

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
function reshape(args) {
    const { inputs, attrs } = args;
    const { x } = inputs;
    const { shape } = attrs;
    const xSize = util.sizeFromShape(x.shape);
    const $shape = util.inferFromImplicitShape(shape, xSize);
    util.assert(xSize === util.sizeFromShape($shape), () => `new shape: ${$shape}, old shape: ${x.shape}. New shape and old ` +
        `shape must have the same number of elements.`);
    // Backend needs to track refCount for the dataId for reshape op
    args.backend.incRef(x.dataId);
    return { dataId: x.dataId, shape: $shape, dtype: x.dtype };
}
const reshapeConfig = {
    kernelName: Reshape,
    backendName: 'wasm',
    kernelFunc: reshape
};

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmBatchMatMul;
function setup$6(backend) {
    wasmBatchMatMul = backend.wasm.cwrap(BatchMatMul, null /* void */, [
        'number',
        'array',
        'number',
        'number',
        'array',
        'number',
        'number',
        'number',
        'number' // out_id
    ]);
}
function batchMatMul(args) {
    const { inputs, backend, attrs } = args;
    const { a, b } = inputs;
    const { transposeA, transposeB } = attrs;
    if (a.dtype !== 'float32' || b.dtype !== 'float32') {
        throw new Error(`BatchMatMul for non non-float32 tensors not yet supported.`);
    }
    const aRank = a.shape.length;
    const bRank = b.shape.length;
    const innerShapeA = transposeA ? a.shape[aRank - 2] : a.shape[aRank - 1];
    const innerShapeB = transposeB ? b.shape[bRank - 1] : b.shape[bRank - 2];
    const outerShapeA = transposeA ? a.shape[aRank - 1] : a.shape[aRank - 2];
    const outerShapeB = transposeB ? b.shape[bRank - 2] : b.shape[bRank - 1];
    const outerDimsA = a.shape.slice(0, -2);
    const outerDimsB = b.shape.slice(0, -2);
    const batchDimA = util.sizeFromShape(outerDimsA);
    const batchDimB = util.sizeFromShape(outerDimsB);
    const outShapeOuterDims = broadcast_util.assertAndGetBroadcastShape(a.shape.slice(0, -2), b.shape.slice(0, -2));
    const outShape = outShapeOuterDims.concat([outerShapeA, outerShapeB]);
    util.assert(innerShapeA === innerShapeB, () => `Error in matMul: inner shapes (${innerShapeA}) and (` +
        `${innerShapeB}) of Tensors with shapes ${a.shape} and ` +
        `${b.shape} and transposeA=${transposeA}` +
        ` and transposeB=${transposeB} must match.`);
    const a3dShape = transposeA ? [batchDimA, innerShapeA, outerShapeA] :
        [batchDimA, outerShapeA, innerShapeA];
    const b3dShape = transposeB ? [batchDimB, outerShapeB, innerShapeB] :
        [batchDimB, innerShapeB, outerShapeB];
    // The rest of the implementation is designed to operate on rank-3 tensors
    const a3d = reshape({ inputs: { x: a }, backend, attrs: { shape: a3dShape } });
    const b3d = reshape({ inputs: { x: b }, backend, attrs: { shape: b3dShape } });
    const a3dId = backend.dataIdMap.get(a3d.dataId).id;
    const b3dId = backend.dataIdMap.get(b3d.dataId).id;
    const leftDim = transposeA ? a3d.shape[2] : a3d.shape[1];
    const rightDim = transposeB ? b3d.shape[1] : b3d.shape[2];
    const batchDim = Math.max(batchDimA, batchDimB);
    const out = backend.makeOutput([batchDim, leftDim, rightDim], a3d.dtype);
    const outId = backend.dataIdMap.get(out.dataId).id;
    const aShapeBytes = new Uint8Array(new Int32Array(a3d.shape).buffer);
    const bShapeBytes = new Uint8Array(new Int32Array(b3d.shape).buffer);
    wasmBatchMatMul(a3dId, aShapeBytes, a3d.shape.length, b3dId, bShapeBytes, b3d.shape.length, transposeA, transposeB, outId);
    backend.disposeData(a3d.dataId);
    backend.disposeData(b3d.dataId);
    out.shape = outShape;
    return out;
}
const batchMatMulConfig = {
    kernelName: BatchMatMul,
    backendName: 'wasm',
    setupFunc: setup$6,
    kernelFunc: batchMatMul
};

/**
 * @license
 * Copyright 2020 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
function concatImpl(inputs, outShape, dtype, simplyConcat) {
    const outVals = util.getArrayFromDType(dtype, util.sizeFromShape(outShape));
    if (simplyConcat && dtype !== 'string') {
        // Use built-in TypedArray.set() method for speed.
        let offset = 0;
        inputs.forEach(input => {
            const size = util.sizeFromShape(input.shape);
            outVals.set(input.vals, offset);
            offset += size;
        });
    }
    else {
        let colOffset = 0;
        inputs.forEach(input => {
            const decodedData = dtype === 'string' ?
                backend_util.fromUint8ToStringArray(input.vals) :
                input.vals;
            let tIdx = 0;
            for (let row = 0; row < input.shape[0]; ++row) {
                const resIdx = row * outShape[1] + colOffset;
                for (let col = 0; col < input.shape[1]; ++col) {
                    outVals[resIdx + col] = decodedData[tIdx++];
                }
            }
            colOffset += input.shape[1];
        });
    }
    return outVals;
}

/**
 * @license
 * Copyright 2020 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
function rangeImpl(start, stop, step, dtype) {
    const sameStartStop = start === stop;
    const increasingRangeNegativeStep = start < stop && step < 0;
    const decreasingRangePositiveStep = stop < start && step > 1;
    if (sameStartStop || increasingRangeNegativeStep ||
        decreasingRangePositiveStep) {
        return util.makeZerosTypedArray(0, dtype);
    }
    const numElements = Math.abs(Math.ceil((stop - start) / step));
    const values = util.makeZerosTypedArray(numElements, dtype);
    if (stop < start && step === 1) {
        // Auto adjust the step's sign if it hasn't been set
        // (or was set to 1)
        step = -1;
    }
    values[0] = start;
    for (let i = 1; i < values.length; i++) {
        values[i] = values[i - 1] + step;
    }
    return values;
}

/**
 * @license
 * Copyright 2020 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
function sliceImpl(vals, begin, size, shape, dtype) {
    const isContinous = slice_util.isSliceContinous(shape, begin, size);
    const length = util.sizeFromShape(size);
    const xStrides = util.computeStrides(shape);
    if (isContinous) {
        const flatOffset = slice_util.computeFlatOffset(begin, xStrides);
        if (dtype === 'string') {
            return vals.slice(flatOffset, flatOffset + length);
        }
        return vals.subarray(flatOffset, flatOffset + length);
    }
    const decodedData = dtype === 'string' ?
        backend_util.fromUint8ToStringArray(vals) :
        vals;
    const inBuf = buffer(shape, dtype, decodedData);
    const outBuf = buffer(size, dtype);
    for (let i = 0; i < outBuf.size; ++i) {
        const outLoc = outBuf.indexToLoc(i);
        const inLoc = outLoc.map((idx, j) => idx + begin[j]);
        outBuf.set(inBuf.get(...inLoc), ...outLoc);
    }
    if (dtype === 'string') {
        return backend_util.fromStringArrayToUint8(outBuf.values);
    }
    return outBuf.values;
}

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
function slice(args) {
    const { inputs: { x }, attrs: { begin, size }, backend } = args;
    const [begin_, size_] = slice_util.parseSliceParams(x, begin, size);
    const isContinous = slice_util.isSliceContinous(x.shape, begin_, size_);
    const xVals = backend.readSync(x.dataId);
    const out = backend.makeOutput(size_, x.dtype);
    const xStrides = util.computeStrides(x.shape);
    const outData = backend.dataIdMap.get(out.dataId);
    if (isContinous) {
        const flatOffset = slice_util.computeFlatOffset(begin_, xStrides);
        if (x.dtype === 'string') {
            outData.stringBytes =
                xVals
                    .slice(flatOffset, flatOffset + util.sizeFromShape(size_));
        }
        else {
            const outVals = backend.typedArrayFromHeap(out);
            outVals.set(xVals
                .subarray(flatOffset, flatOffset + util.sizeFromShape(size_)));
        }
        return out;
    }
    if (x.dtype === 'string') {
        const res = sliceImpl(xVals, begin_, size_, x.shape, x.dtype);
        outData.stringBytes = res;
        return out;
    }
    const outVals = backend.typedArrayFromHeap(out);
    const rank = x.shape.length;
    if (rank === 2) {
        slice2d(xVals, xStrides[0], outVals, begin_, size_);
    }
    else if (rank === 3) {
        slice3d(xVals, xStrides[0], xStrides[1], outVals, begin_, size_);
    }
    else if (rank === 4) {
        slice4d(xVals, xStrides[0], xStrides[1], xStrides[2], outVals, begin_, size_);
    }
    else {
        const res = sliceImpl(xVals, begin_, size_, x.shape, x.dtype);
        outVals.set(res);
    }
    return out;
}
function slice2d(xVals, xStride, outVals, begin, size) {
    let outOffset = 0;
    const beginI = begin[0];
    const beginJ = begin[1];
    const endI = beginI + size[0];
    for (let i = beginI; i < endI; i++) {
        const xOffset = i * xStride + beginJ;
        outVals.set(xVals.subarray(xOffset, xOffset + size[1]), outOffset);
        outOffset += size[1];
    }
}
function slice3d(xVals, xStride1, xStride2, outVals, begin, size) {
    let outOffset = 0;
    const beginI = begin[0];
    const beginJ = begin[1];
    const beginK = begin[2];
    const endI = beginI + size[0];
    const endJ = beginJ + size[1];
    for (let i = beginI; i < endI; i++) {
        for (let j = beginJ; j < endJ; j++) {
            const xOffset = i * xStride1 + j * xStride2 + beginK;
            outVals.set(xVals.subarray(xOffset, xOffset + size[2]), outOffset);
            outOffset += size[2];
        }
    }
}
function slice4d(xVals, xStride1, xStride2, xStride3, outVals, begin, size) {
    let outOffset = 0;
    const beginI = begin[0];
    const beginJ = begin[1];
    const beginK = begin[2];
    const endI = beginI + size[0];
    const endJ = beginJ + size[1];
    const endK = beginK + size[2];
    const beginL = begin[3];
    for (let i = beginI; i < endI; i++) {
        for (let j = beginJ; j < endJ; j++) {
            for (let k = beginK; k < endK; k++) {
                const xOffset = i * xStride1 + j * xStride2 + k * xStride3 + beginL;
                outVals.set(xVals.subarray(xOffset, xOffset + size[3]), outOffset);
                outOffset += size[3];
            }
        }
    }
}
const sliceConfig = {
    kernelName: Slice,
    backendName: 'wasm',
    kernelFunc: slice,
};

/**
 * @license
 * Copyright 2021 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
function batchToSpaceND(args) {
    const { inputs, backend, attrs } = args;
    const { x } = inputs;
    const { blockShape, crops } = attrs;
    const prod = blockShape.reduce((a, b) => a * b);
    const reshaped = backend_util.getReshaped(x.shape, blockShape, prod);
    const permuted = backend_util.getPermuted(reshaped.length, blockShape.length);
    const reshapedPermuted = backend_util.getReshapedPermuted(x.shape, blockShape, prod);
    const sliceBeginCoords = backend_util.getSliceBeginCoords(crops, blockShape.length);
    const sliceSize = backend_util.getSliceSize(reshapedPermuted, crops, blockShape.length);
    const xReshaped = reshape({ inputs: { x }, backend, attrs: { shape: reshaped } });
    const xTransposed = transpose({ inputs: { x: xReshaped }, backend, attrs: { perm: permuted } });
    const xTransposedReshaped = reshape({ inputs: { x: xTransposed }, backend, attrs: { shape: reshapedPermuted } });
    const result = slice({
        inputs: { x: xTransposedReshaped },
        backend,
        attrs: { begin: sliceBeginCoords, size: sliceSize }
    });
    backend.disposeData(xReshaped.dataId);
    backend.disposeData(xTransposed.dataId);
    backend.disposeData(xReshaped.dataId);
    return result;
}
const batchToSpaceNDConfig = {
    kernelName: BatchToSpaceND,
    backendName: 'wasm',
    kernelFunc: batchToSpaceND
};

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
function cast(args) {
    const { inputs: { x }, attrs: { dtype }, backend } = args;
    const out = backend.makeOutput(x.shape, dtype);
    const inVals = backend.typedArrayFromHeap(x);
    const outVals = backend.typedArrayFromHeap(out);
    outVals.set(inVals);
    return out;
}
const castConfig = {
    kernelName: Cast,
    backendName: 'wasm',
    kernelFunc: cast,
};

/**
 * @license
 * Copyright 2021 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
const ceilConfig = createUnaryKernelConfig(Ceil);

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmClip;
function setup$7(backend) {
    wasmClip = backend.wasm.cwrap(ClipByValue, null /* void */, [
        'number',
        'number',
        'number',
        'number' // out_id
    ]);
}
function clip(args) {
    const { inputs, backend, attrs } = args;
    const { x } = inputs;
    const { clipValueMin, clipValueMax } = attrs;
    const xId = backend.dataIdMap.get(x.dataId).id;
    const out = backend.makeOutput(x.shape, x.dtype);
    const outId = backend.dataIdMap.get(out.dataId).id;
    wasmClip(xId, clipValueMin, clipValueMax, outId);
    return out;
}
const clipByValueConfig = {
    kernelName: ClipByValue,
    backendName: 'wasm',
    setupFunc: setup$7,
    kernelFunc: clip
};

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
function concat(args) {
    const { inputs, backend } = args;
    const axis = util.parseAxisParam(args.attrs.axis, inputs[0].shape)[0];
    let outShape = backend_util.computeOutShape(inputs.map(t => t.shape), axis);
    // Keep only non-empty tensors (ignore tensors with 0 in their shape).
    const $inputs = inputs.filter(t => util.sizeFromShape(t.shape) > 0);
    if ($inputs.length === 1) {
        return identity({ inputs: { x: $inputs[0] }, backend });
    }
    const out = backend.makeOutput(outShape, inputs[0].dtype);
    if (util.sizeFromShape(outShape) === 0) {
        return out;
    }
    const shapes = $inputs.map(t => t.shape);
    backend_util.assertParamsConsistent(shapes, axis);
    if ($inputs[0].dtype === 'string') {
        // Any concat of n-dimensional tensors across any axis can be reduced to
        // a concatenation of two-dimensional tensors across the axis 1 by first
        // partitioning the axes of the original tensors into those less than the
        // axis to be concatenated and the rest. Then reshape the tensors
        // into a two-dimensional tensor by collapsing these two sets of axes and
        // concatenate the resulting matrices across the axis 1, finally reshaping
        // the result to have the proper shape.
        const inputs2D = $inputs.map(t => {
            const innerSize = util.sizeFromShape(t.shape.slice(axis));
            const shape = [-1, innerSize];
            return reshape({ inputs: { x: t }, backend, attrs: { shape } });
        });
        const inputsValShapes = inputs2D.map(t => {
            return { vals: backend.readSync(t.dataId), shape: t.shape };
        });
        // Concats 2d tensors along axis=1.
        outShape =
            backend_util.computeOutShape(inputs2D.map(t => t.shape), 1 /* axis */);
        const simplyConcat = inputs2D[0].shape[0] === 1;
        const outVals = concatImpl(inputsValShapes, outShape, inputs[0].dtype, simplyConcat);
        const finalOutShape = backend_util.computeOutShape($inputs.map(t => t.shape), axis);
        out.shape = finalOutShape;
        const outData = backend.dataIdMap.get(out.dataId);
        outData.stringBytes = backend_util.fromStringArrayToUint8(outVals);
        inputs2D.forEach(t => backend.disposeData(t.dataId));
        return out;
    }
    const batchDim = util.sizeFromShape($inputs[0].shape.slice(0, axis));
    let sumInnerDims = 0;
    const innerDims = $inputs.map(input => {
        const innerDim = util.sizeFromShape(input.shape.slice(axis));
        sumInnerDims += innerDim;
        return innerDim;
    });
    const inVals = $inputs.map(input => backend.typedArrayFromHeap(input));
    const outVals = backend.typedArrayFromHeap(out);
    for (let b = 0; b < batchDim; b++) {
        let outOffset = b * sumInnerDims;
        for (let i = 0; i < inVals.length; i++) {
            const innerDim = innerDims[i];
            const inOffset = b * innerDim;
            const vals = inVals[i].subarray(inOffset, inOffset + innerDim);
            outVals.set(vals, outOffset);
            outOffset += innerDim;
        }
    }
    return out;
}
const concatConfig = {
    kernelName: Concat,
    backendName: 'wasm',
    kernelFunc: concat,
};

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmConv2d;
function setup$8(backend) {
    wasmConv2d = backend.wasm.cwrap(Conv2D, null /* void */, [
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
    ]);
}
function conv2d(args) {
    const { inputs, attrs, backend } = args;
    const { x, filter } = inputs;
    const xId = backend.dataIdMap.get(x.dataId).id;
    const filterId = backend.dataIdMap.get(filter.dataId).id;
    const { strides, dilations, pad, dimRoundingMode, dataFormat } = attrs;
    const $dataFormat = backend_util.convertConv2DDataFormat(dataFormat);
    const convInfo = backend_util.computeConv2DInfo(x.shape, filter.shape, strides, dilations, pad, dimRoundingMode, false, $dataFormat);
    const filterHeight = convInfo.filterHeight;
    const filterWidth = convInfo.filterWidth;
    const padTop = convInfo.padInfo.top;
    const padRight = convInfo.padInfo.right;
    const padBottom = convInfo.padInfo.bottom;
    const padLeft = convInfo.padInfo.left;
    const dilationHeight = convInfo.dilationHeight;
    const dilationWidth = convInfo.dilationWidth;
    const strideHeight = convInfo.strideHeight;
    const strideWidth = convInfo.strideWidth;
    const inputChannels = convInfo.inChannels;
    const outputChannels = convInfo.outChannels;
    const isSamePad = convInfo.padInfo.type === 'SAME' ? 1 : 0;
    if (convInfo.dataFormat !== 'channelsLast') {
        throw new Error(`wasm backend Conv2D does not support dataFormat:'` +
            `${convInfo.dataFormat}'. Please use 'channelsLast'.`);
    }
    const out = backend.makeOutput(convInfo.outShape, 'float32');
    const outId = backend.dataIdMap.get(out.dataId).id;
    wasmConv2d(xId, x.shape[0], x.shape[1], x.shape[2], filterId, filterHeight, filterWidth, padTop, padRight, padBottom, padLeft, isSamePad, dilationHeight, dilationWidth, strideHeight, strideWidth, inputChannels, outputChannels, outId);
    return out;
}
const conv2DConfig = {
    kernelName: Conv2D,
    backendName: 'wasm',
    setupFunc: setup$8,
    kernelFunc: conv2d
};

/**
 * @license
 * Copyright 2020 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmConv2DBackpropInput;
function setup$9(backend) {
    wasmConv2DBackpropInput = backend.wasm.cwrap(Conv2DBackpropInput, null, [
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
    ]);
}
function conv2DBackpropInput(args) {
    const { backend, inputs, attrs } = args;
    const { dy, filter } = inputs;
    const { strides, pad, dataFormat, dimRoundingMode, inputShape } = attrs;
    const dilations = 1;
    const $dataFormat = backend_util.convertConv2DDataFormat(dataFormat);
    const convInfo = backend_util.computeConv2DInfo(inputShape, filter.shape, strides, dilations, pad, dimRoundingMode, false /* depthwise */, $dataFormat);
    const { batchSize, filterHeight, filterWidth, inChannels, inHeight, inWidth, outChannels, outHeight, outWidth, strideHeight, strideWidth } = convInfo;
    const topPad = filterHeight - 1 - convInfo.padInfo.top;
    const leftPad = filterWidth - 1 - convInfo.padInfo.left;
    const isChannelsLast = convInfo.dataFormat === 'channelsLast';
    const dxStrides = util.computeStrides(convInfo.inShape);
    const dyStrides = util.computeStrides(dy.shape);
    const [fltS0, fltS1, fltS2] = util.computeStrides(filter.shape);
    const xBatchStride = dxStrides[0];
    const xRowStride = isChannelsLast ? dxStrides[1] : dxStrides[2];
    const xColStride = isChannelsLast ? dxStrides[2] : 1;
    const xChannelStride = isChannelsLast ? 1 : dxStrides[1];
    const yBatchStride = dyStrides[0];
    const yRowStride = isChannelsLast ? dyStrides[1] : dyStrides[2];
    const yColStride = isChannelsLast ? dyStrides[2] : 1;
    const yChannelStride = isChannelsLast ? 1 : dyStrides[1];
    const out = backend.makeOutput(convInfo.inShape, 'float32');
    const outId = backend.dataIdMap.get(out.dataId).id;
    const dyId = backend.dataIdMap.get(dy.dataId).id;
    const filterId = backend.dataIdMap.get(filter.dataId).id;
    wasmConv2DBackpropInput(dyId, filterId, batchSize, filterHeight, filterWidth, inHeight, inWidth, inChannels, outHeight, outWidth, outChannels, strideHeight, strideWidth, topPad, leftPad, fltS0, fltS1, fltS2, xBatchStride, xRowStride, xColStride, xChannelStride, yBatchStride, yRowStride, yColStride, yChannelStride, outId);
    return out;
}
const conv2DBackpropInputConfig = {
    kernelName: Conv2DBackpropInput,
    backendName: 'wasm',
    setupFunc: setup$9,
    kernelFunc: conv2DBackpropInput
};

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
const cosConfig = createUnaryKernelConfig(Cos);

/**
 * @license
 * Copyright 2021 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
const coshConfig = createUnaryKernelConfig(Cosh);

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
// Must match enum in CropAndResize.cc
var InterpolationMethod;
(function (InterpolationMethod) {
    InterpolationMethod[InterpolationMethod["bilinear"] = 0] = "bilinear";
    InterpolationMethod[InterpolationMethod["nearest"] = 1] = "nearest";
})(InterpolationMethod || (InterpolationMethod = {}));
let wasmCropAndResize;
function setup$a(backend) {
    wasmCropAndResize = backend.wasm.cwrap(CropAndResize, null /*void*/, [
        'number',
        'number',
        'number',
        'number',
        'array',
        'number',
        'number',
        'number',
        'number',
        'number' // out id
    ]);
}
function cropAndResize(args) {
    const { backend, inputs, attrs } = args;
    const { method, extrapolationValue, cropSize } = attrs;
    const { image, boxes, boxInd } = inputs;
    const numBoxes = boxes.shape[0];
    const [cropHeight, cropWidth] = cropSize;
    const outShape = [numBoxes, cropHeight, cropWidth, image.shape[3]];
    let imagesData = backend.dataIdMap.get(image.dataId);
    let castedData;
    if (image.dtype !== 'float32') {
        castedData = cast({ backend, inputs: { x: image }, attrs: { dtype: 'float32' } });
        imagesData = backend.dataIdMap.get(castedData.dataId);
    }
    const imagesId = imagesData.id;
    const boxesId = backend.dataIdMap.get(boxes.dataId).id;
    const boxIndId = backend.dataIdMap.get(boxInd.dataId).id;
    const out = backend.makeOutput(outShape, 'float32');
    const outId = backend.dataIdMap.get(out.dataId).id;
    const imagesShapeBytes = new Uint8Array(new Int32Array(image.shape).buffer);
    wasmCropAndResize(imagesId, boxesId, boxIndId, numBoxes, imagesShapeBytes, cropHeight, cropWidth, InterpolationMethod[method], extrapolationValue, outId);
    if (castedData != null) {
        backend.disposeData(castedData.dataId);
    }
    return out;
}
const cropAndResizeConfig = {
    kernelName: CropAndResize,
    backendName: 'wasm',
    setupFunc: setup$a,
    kernelFunc: cropAndResize
};

/**
 * @license
 * Copyright 2022 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmCumprod;
function setup$b(backend) {
    wasmCumprod = backend.wasm.cwrap(Cumprod, null /* void */, [
        'number',
        'number',
        'number',
        'number',
        'number',
        'number' // dtype
    ]);
}
function cumprod(args) {
    const { inputs, backend, attrs } = args;
    const { x } = inputs;
    const { axis, exclusive, reverse } = attrs;
    const xRank = x.shape.length;
    util.assert(x.dtype === 'float32' || x.dtype === 'int32', () => `cumprod does not support ${x.dtype} tensors in the WASM backend`);
    // permute required axis to inner most axis
    const permutation = backend_util.getAxesPermutation([axis], xRank);
    let permutedX = x;
    if (permutation !== null) {
        permutedX = transpose({ inputs: { x }, attrs: { perm: permutation }, backend });
    }
    const permutedAxis = backend_util.getInnerMostAxes(1, xRank)[0];
    backend_util.assertAxesAreInnerMostDims('cumprod', [permutedAxis], xRank);
    const permutedOut = backend.makeOutput(permutedX.shape, permutedX.dtype);
    const finalDim = permutedX.shape[permutedAxis];
    const permutedXId = backend.dataIdMap.get(permutedX.dataId).id;
    const permutedOutId = backend.dataIdMap.get(permutedOut.dataId).id;
    wasmCumprod(permutedXId, exclusive ? 1 : 0, reverse ? 1 : 0, finalDim, permutedOutId, CppDType[x.dtype]);
    // transpose data back if permuted
    let out = permutedOut;
    if (permutation !== null) {
        const undoPermutation = backend_util.getUndoAxesPermutation(permutation);
        out = transpose({ inputs: { x: permutedOut }, attrs: { perm: undoPermutation }, backend });
        backend.disposeData(permutedX.dataId);
        backend.disposeData(permutedOut.dataId);
    }
    return out;
}
const cumprodConfig = {
    kernelName: Cumprod,
    backendName: 'wasm',
    setupFunc: setup$b,
    kernelFunc: cumprod
};

/**
 * @license
 * Copyright 2020 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmCumsum;
function setup$c(backend) {
    wasmCumsum = backend.wasm.cwrap(Cumsum, null /* void */, [
        'number',
        'number',
        'number',
        'number',
        'number',
        'number' // dtype
    ]);
}
function cumsum(args) {
    const { inputs, backend, attrs } = args;
    const { x } = inputs;
    const { axis, exclusive, reverse } = attrs;
    const xRank = x.shape.length;
    util.assert(x.dtype === 'float32' || x.dtype === 'int32', () => `cumsum does not support ${x.dtype} tensors in the WASM backend`);
    // permute required axis to inner most axis
    const permutation = backend_util.getAxesPermutation([axis], xRank);
    let permutedX = x;
    if (permutation !== null) {
        permutedX = transpose({ inputs: { x }, attrs: { perm: permutation }, backend });
    }
    const permutedAxis = backend_util.getInnerMostAxes(1, xRank)[0];
    backend_util.assertAxesAreInnerMostDims('cumsum', [permutedAxis], xRank);
    const permutedOut = backend.makeOutput(permutedX.shape, permutedX.dtype);
    const finalDim = permutedX.shape[permutedAxis];
    const permutedXId = backend.dataIdMap.get(permutedX.dataId).id;
    const permutedOutId = backend.dataIdMap.get(permutedOut.dataId).id;
    wasmCumsum(permutedXId, exclusive ? 1 : 0, reverse ? 1 : 0, finalDim, permutedOutId, CppDType[x.dtype]);
    // transpose data back if permuted
    let out = permutedOut;
    if (permutation !== null) {
        const undoPermutation = backend_util.getUndoAxesPermutation(permutation);
        out = transpose({ inputs: { x: permutedOut }, attrs: { perm: undoPermutation }, backend });
        backend.disposeData(permutedX.dataId);
        backend.disposeData(permutedOut.dataId);
    }
    return out;
}
const cumsumConfig = {
    kernelName: Cumsum,
    backendName: 'wasm',
    setupFunc: setup$c,
    kernelFunc: cumsum
};

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmDepthToSpace;
function setup$d(backend) {
    wasmDepthToSpace = backend.wasm.cwrap(DepthToSpace, null /*void*/, [
        'number',
        'number',
        'number',
        'array',
        'number',
        'array',
        'array',
        'number',
        'number',
    ]);
}
function depthToSpace(args) {
    const { backend, inputs, attrs } = args;
    const { x } = inputs;
    const { blockSize, dataFormat } = attrs;
    const batchSize = x.shape[0];
    const inputHeight = (dataFormat === 'NHWC') ? x.shape[1] : x.shape[2];
    const inputWidth = (dataFormat === 'NHWC') ? x.shape[2] : x.shape[3];
    const inputDepth = (dataFormat === 'NHWC') ? x.shape[3] : x.shape[1];
    const outputHeight = inputHeight * blockSize;
    const outputWidth = inputWidth * blockSize;
    const outputDepth = inputDepth / (blockSize * blockSize);
    const outputShape = (dataFormat === 'NHWC') ?
        [batchSize, outputHeight, outputWidth, outputDepth] :
        [batchSize, outputDepth, outputHeight, outputWidth];
    const out = backend.makeOutput(outputShape, 'float32');
    const xData = backend.dataIdMap.get(x.dataId);
    const xId = xData.id;
    const xStridesBytes = new Uint8Array(new Int32Array(util.computeStrides(x.shape)).buffer);
    const outputShapeBytes = new Uint8Array(new Int32Array(outputShape).buffer);
    const outStridesBytes = new Uint8Array(new Int32Array(util.computeStrides(outputShape)).buffer);
    const outId = backend.dataIdMap.get(out.dataId).id;
    const channelsLast = dataFormat === 'NHWC' ? 1 : 0;
    wasmDepthToSpace(xId, blockSize, channelsLast, xStridesBytes, x.shape.length - 1, outputShapeBytes, outStridesBytes, outputShape.length, outId);
    return out;
}
const depthToSpaceConfig = {
    kernelName: DepthToSpace,
    backendName: 'wasm',
    setupFunc: setup$d,
    kernelFunc: depthToSpace
};

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmDepthwiseConv2d;
function setup$e(backend) {
    wasmDepthwiseConv2d =
        backend.wasm.cwrap(DepthwiseConv2dNative, null /* void */, [
            'number',
            'number',
            'number',
            'number',
            'number',
            'number',
            'number',
            'number',
            'number',
            'number',
            'number',
            'number',
            'number',
            'number',
            'number',
            'number',
            'number',
            'number',
            'number',
        ]);
}
function depthwiseConv2d(args) {
    const { inputs, attrs, backend } = args;
    const { x, filter } = inputs;
    const xId = backend.dataIdMap.get(x.dataId).id;
    const filterId = backend.dataIdMap.get(filter.dataId).id;
    const { strides, dilations, pad, dimRoundingMode } = attrs;
    const $dilations = dilations == null ? [1, 1] : dilations;
    const convInfo = backend_util.computeConv2DInfo(x.shape, filter.shape, strides, $dilations, pad, dimRoundingMode, true /* depthwise */);
    const filterHeight = convInfo.filterHeight;
    const filterWidth = convInfo.filterWidth;
    const padTop = convInfo.padInfo.top;
    const padRight = convInfo.padInfo.right;
    const padBottom = convInfo.padInfo.bottom;
    const padLeft = convInfo.padInfo.left;
    const dilationHeight = convInfo.dilationHeight;
    const dilationWidth = convInfo.dilationWidth;
    const strideHeight = convInfo.strideHeight;
    const strideWidth = convInfo.strideWidth;
    const inputChannels = convInfo.inChannels;
    const outputChannels = convInfo.outChannels;
    const isSamePad = convInfo.padInfo.type === 'SAME' ? 1 : 0;
    if (convInfo.dataFormat !== 'channelsLast') {
        throw new Error(`wasm backend DepthwiseConv2dNative does not support dataFormat:'` +
            `${convInfo.dataFormat}'. Please use 'channelsLast'.`);
    }
    const out = backend.makeOutput(convInfo.outShape, 'float32');
    const outId = backend.dataIdMap.get(out.dataId).id;
    wasmDepthwiseConv2d(xId, x.shape[0], x.shape[1], x.shape[2], filterId, filterHeight, filterWidth, padTop, padRight, padBottom, padLeft, isSamePad, dilationHeight, dilationWidth, strideHeight, strideWidth, inputChannels, outputChannels, outId);
    return out;
}
const depthwiseConv2dNativeConfig = {
    kernelName: DepthwiseConv2dNative,
    backendName: 'wasm',
    setupFunc: setup$e,
    kernelFunc: depthwiseConv2d
};

/**
 * @license
 * Copyright 2021 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
const eluConfig = createUnaryKernelConfig(Elu);

/**
 * @license
 * Copyright 2020 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
const supportsFullBroadcast = false;
const equalConfig = createBinaryKernelConfig(Equal, supportsFullBroadcast, 'bool');

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
const expConfig = createUnaryKernelConfig(Exp, 'float32');

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
function expandDims(args) {
    const { inputs, attrs, backend } = args;
    const { input } = inputs;
    const { dim } = attrs;
    const inputRank = input.shape.length;
    const newShape = input.shape.slice();
    let $dim = dim;
    if (dim < 0) {
        // Negative value is counted from the tail of rank.
        util.assert(-(inputRank + 1) <= dim, () => `Axis must be in the interval [${-(inputRank + 1)}, ${inputRank}]`);
        $dim = inputRank + dim + 1;
    }
    newShape.splice($dim, 0, 1);
    return reshape({ inputs: { x: input }, backend, attrs: { shape: newShape } });
}
const expandDimsConfig = {
    kernelName: ExpandDims,
    backendName: 'wasm',
    kernelFunc: expandDims,
};

/**
 * @license
 * Copyright 2020 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
function fill(args) {
    const { attrs: { shape, value, dtype }, backend } = args;
    const out = backend.makeOutput(shape, dtype);
    const outVals = backend.typedArrayFromHeap(out);
    outVals.fill(value);
    return out;
}
const fillConfig = {
    kernelName: Fill,
    backendName: 'wasm',
    kernelFunc: fill,
};

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmFlipLeftRight;
function setup$f(backend) {
    wasmFlipLeftRight = backend.wasm.cwrap(FlipLeftRight, null /* void */, [
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
    ]);
}
function flipLeftRight(args) {
    const { inputs, backend } = args;
    const { image } = inputs;
    const out = backend.makeOutput(image.shape, image.dtype);
    const imageId = backend.dataIdMap.get(image.dataId).id;
    const outId = backend.dataIdMap.get(out.dataId).id;
    const [batch, imageHeight, imageWidth, numChannels] = image.shape;
    wasmFlipLeftRight(imageId, batch, imageHeight, imageWidth, numChannels, outId);
    return out;
}
const flipLeftRightConfig = {
    kernelName: FlipLeftRight,
    backendName: 'wasm',
    kernelFunc: flipLeftRight,
    setupFunc: setup$f
};

/**
 * @license
 * Copyright 2020 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
const floorConfig = createUnaryKernelConfig(Floor);

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
const floorDivConfig = createBinaryKernelConfig(FloorDiv);

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmBatchNorm;
function setup$g(backend) {
    wasmBatchNorm = backend.wasm.cwrap(FusedBatchNorm, null /* void */, ['number', 'number', 'number', 'number', 'number', 'number', 'number']);
}
function fusedBatchNorm(args) {
    const { backend, inputs, attrs } = args;
    const { varianceEpsilon } = attrs;
    const { x, mean, variance, offset, scale } = inputs;
    const xId = backend.dataIdMap.get(x.dataId).id;
    const meanId = backend.dataIdMap.get(mean.dataId).id;
    const varianceId = backend.dataIdMap.get(variance.dataId).id;
    const offsetId = offset != null ? backend.dataIdMap.get(offset.dataId).id : 0;
    const scaleId = scale != null ? backend.dataIdMap.get(scale.dataId).id : 0;
    const out = backend.makeOutput(x.shape, x.dtype);
    // Short-circuit zero-sized tensors.
    if (util.sizeFromShape(x.shape) === 0) {
        return out;
    }
    const outId = backend.dataIdMap.get(out.dataId).id;
    wasmBatchNorm(xId, meanId, varianceId, offsetId, scaleId, varianceEpsilon, outId);
    return out;
}
const fusedBatchNormConfig = {
    kernelName: FusedBatchNorm,
    backendName: 'wasm',
    setupFunc: setup$g,
    kernelFunc: fusedBatchNorm
};

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmFusedConv2d;
function setup$h(backend) {
    wasmFusedConv2d = backend.wasm.cwrap(FusedConv2D, null /* void */, [
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
    ]);
}
function fusedConv2d(args) {
    const { inputs, attrs, backend } = args;
    const { x, filter, bias, preluActivationWeights } = inputs;
    const { strides, pad, dilations, dataFormat, dimRoundingMode, activation, leakyreluAlpha } = attrs;
    const convInfo = backend_util.computeConv2DInfo(x.shape, filter.shape, strides, dilations, pad, dimRoundingMode);
    const fusedActivation = FusableActivation[activation];
    if (fusedActivation == null) {
        throw new Error(`${activation} activation not yet supported for FusedConv2D ` +
            `in the wasm backend.`);
    }
    const xId = backend.dataIdMap.get(x.dataId).id;
    const filterId = backend.dataIdMap.get(filter.dataId).id;
    const outputChannels = convInfo.outChannels;
    let biasId = 0;
    if (bias != null) {
        const biasData = backend.dataIdMap.get(bias.dataId);
        if (biasData.shape.length !== 1) {
            throw new Error(`FusedConv2D only supports rank-1 bias but got ` +
                `rank ${biasData.shape.length}.`);
        }
        if (biasData.shape[0] !== outputChannels) {
            throw new Error(`FusedConv2D bias shape (${biasData.shape}) does not ` +
                `match the number of output channels (${outputChannels})`);
        }
        biasId = biasData.id;
    }
    const filterHeight = convInfo.filterHeight;
    const filterWidth = convInfo.filterWidth;
    const padTop = convInfo.padInfo.top;
    const padRight = convInfo.padInfo.right;
    const padBottom = convInfo.padInfo.bottom;
    const padLeft = convInfo.padInfo.left;
    const dilationHeight = convInfo.dilationHeight;
    const dilationWidth = convInfo.dilationWidth;
    const strideHeight = convInfo.strideHeight;
    const strideWidth = convInfo.strideWidth;
    const inputChannels = convInfo.inChannels;
    const isSamePad = convInfo.padInfo.type === 'SAME' ? 1 : 0;
    const batchSize = convInfo.batchSize;
    const inHeight = convInfo.inHeight;
    const inWidth = convInfo.inWidth;
    if (dataFormat !== 'NHWC') {
        throw new Error(`wasm backend FusedConv2D does not support dataFormat:'` +
            `${dataFormat}'. Please use 'NHWC'.`);
    }
    const out = backend.makeOutput(convInfo.outShape, 'float32');
    const outId = backend.dataIdMap.get(out.dataId).id;
    const preluActivationWeightsId = preluActivationWeights == null ?
        0 :
        backend.dataIdMap.get(preluActivationWeights.dataId).id;
    wasmFusedConv2d(xId, batchSize, inHeight, inWidth, filterId, filterHeight, filterWidth, biasId, padTop, padRight, padBottom, padLeft, isSamePad, dilationHeight, dilationWidth, strideHeight, strideWidth, inputChannels, outputChannels, fusedActivation, preluActivationWeightsId, leakyreluAlpha || 0, outId);
    return out;
}
const fusedConv2DConfig = {
    kernelName: FusedConv2D,
    backendName: 'wasm',
    setupFunc: setup$h,
    kernelFunc: fusedConv2d
};

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmFusedDepthwiseConv2d;
function setup$i(backend) {
    wasmFusedDepthwiseConv2d =
        backend.wasm.cwrap(FusedDepthwiseConv2D, null /* void */, [
            'number',
            'number',
            'number',
            'number',
            'number',
            'number',
            'number',
            'number',
            'number',
            'number',
            'number',
            'number',
            'number',
            'number',
            'number',
            'number',
            'number',
            'number',
            'number',
            'number',
            'number',
            'number',
            'number',
        ]);
}
function fusedDepthwiseConv2d(args) {
    const { inputs, attrs, backend } = args;
    const { x, filter, bias, preluActivationWeights } = inputs;
    const { strides, pad, dilations, dataFormat, dimRoundingMode, activation, leakyreluAlpha } = attrs;
    const convInfo = backend_util.computeConv2DInfo(x.shape, filter.shape, strides, dilations, pad, dimRoundingMode, true /* depthwise */);
    const fusedActivation = FusableActivation[activation];
    if (fusedActivation == null) {
        throw new Error(`${activation} activation not yet supported for FusedDepthwiseConv2D ` +
            `in the wasm backend.`);
    }
    const xId = backend.dataIdMap.get(x.dataId).id;
    const filterId = backend.dataIdMap.get(filter.dataId).id;
    const outputChannels = convInfo.outChannels;
    let biasId = 0;
    if (bias != null) {
        const biasData = backend.dataIdMap.get(bias.dataId);
        if (biasData.shape.length !== 1) {
            throw new Error(`FusedDepthwiseConv2D only supports rank-1 bias but got ` +
                `rank ${biasData.shape.length}.`);
        }
        if (biasData.shape[0] !== outputChannels) {
            throw new Error(`FusedDepthwiseConv2D bias shape (${biasData.shape}) does not ` +
                `match the number of output channels (${outputChannels})`);
        }
        biasId = biasData.id;
    }
    const filterHeight = convInfo.filterHeight;
    const filterWidth = convInfo.filterWidth;
    const padTop = convInfo.padInfo.top;
    const padRight = convInfo.padInfo.right;
    const padBottom = convInfo.padInfo.bottom;
    const padLeft = convInfo.padInfo.left;
    const dilationHeight = convInfo.dilationHeight;
    const dilationWidth = convInfo.dilationWidth;
    const strideHeight = convInfo.strideHeight;
    const strideWidth = convInfo.strideWidth;
    const inputChannels = convInfo.inChannels;
    const isSamePad = convInfo.padInfo.type === 'SAME' ? 1 : 0;
    const batchSize = convInfo.batchSize;
    const inHeight = convInfo.inHeight;
    const inWidth = convInfo.inWidth;
    if (dataFormat !== 'NHWC') {
        throw new Error(`wasm backend FusedDepthwiseConv2D does not support dataFormat:'` +
            `${dataFormat}'. Please use 'NHWC'.`);
    }
    const out = backend.makeOutput(convInfo.outShape, 'float32');
    const outId = backend.dataIdMap.get(out.dataId).id;
    const preluActivationWeightsId = preluActivationWeights == null ?
        0 :
        backend.dataIdMap.get(preluActivationWeights.dataId).id;
    wasmFusedDepthwiseConv2d(xId, batchSize, inHeight, inWidth, filterId, filterHeight, filterWidth, biasId, padTop, padRight, padBottom, padLeft, isSamePad, dilationHeight, dilationWidth, strideHeight, strideWidth, inputChannels, outputChannels, fusedActivation, preluActivationWeightsId, leakyreluAlpha || 0, outId);
    return out;
}
const fusedDepthwiseConv2DConfig = {
    kernelName: FusedDepthwiseConv2D,
    backendName: 'wasm',
    setupFunc: setup$i,
    kernelFunc: fusedDepthwiseConv2d
};

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmGatherNd;
function setup$j(backend) {
    wasmGatherNd = backend.wasm.cwrap(GatherNd, null /*void*/, [
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'array',
        'number' // outId
    ]);
}
function gatherNd(args) {
    const { backend, inputs } = args;
    const { params, indices } = inputs;
    const [resultShape, numSlices, sliceSize, strides] = gather_util.prepareAndValidate(params, indices);
    const out = backend.makeOutput(resultShape, params.dtype);
    if (numSlices === 0) {
        return out;
    }
    const indicesShape = indices.shape;
    const sliceRank = indicesShape[indicesShape.length - 1];
    const xData = backend.dataIdMap.get(params.dataId);
    const xId = xData.id;
    const indicesData = backend.dataIdMap.get(indices.dataId);
    const indicesId = indicesData.id;
    const stridesBytes = new Uint8Array(new Int32Array(strides).buffer);
    const outId = backend.dataIdMap.get(out.dataId).id;
    wasmGatherNd(xId, CppDType[params.dtype], indicesId, numSlices, sliceRank, sliceSize, stridesBytes, outId);
    return out;
}
const gatherNdConfig = {
    kernelName: GatherNd,
    backendName: 'wasm',
    setupFunc: setup$j,
    kernelFunc: gatherNd
};

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmGather;
function setup$k(backend) {
    wasmGather = backend.wasm.cwrap('Gather', null /*void*/, [
        'number',
        'number',
        'array',
        'number',
        'number',
        'number',
        'array',
        'number' // outId
    ]);
}
function gatherV2(args) {
    const { backend, inputs, attrs } = args;
    const { x, indices } = inputs;
    const { axis, batchDims } = attrs;
    // Throw error when any index is out of bound.
    const parsedAxis = util.parseAxisParam(axis, x.shape)[0];
    const indicesVals = backend.readSync(indices.dataId);
    const axisDim = x.shape[parsedAxis];
    for (let i = 0; i < indicesVals.length; ++i) {
        const index = indicesVals[i];
        util.assert(index <= axisDim - 1 && index >= 0, () => `GatherV2: the index value ${index} is not in [0, ${axisDim - 1}]`);
    }
    const shapeInfo = backend_util.segment_util.collectGatherOpShapeInfo(x, indices, parsedAxis, batchDims);
    const flattenX = reshape({
        inputs: { x },
        attrs: {
            shape: [
                shapeInfo.batchSize, shapeInfo.outerSize, shapeInfo.dimSize,
                shapeInfo.sliceSize
            ]
        },
        backend
    });
    const indicesSize = util.sizeFromShape(indices.shape);
    const flattenIndex = reshape({
        inputs: { x: indices },
        attrs: { shape: [shapeInfo.batchSize, indicesSize / shapeInfo.batchSize] },
        backend
    });
    const flattenOutputShape = [
        shapeInfo.batchSize, shapeInfo.outerSize, indicesSize / shapeInfo.batchSize,
        shapeInfo.sliceSize
    ];
    const out = backend.makeOutput(flattenOutputShape, x.dtype);
    if (util.sizeFromShape(x.shape) === 0) {
        return out;
    }
    const stridesSize = flattenX.shape.length - 1;
    const xData = backend.dataIdMap.get(flattenX.dataId);
    const xId = xData.id;
    const indicesData = backend.dataIdMap.get(flattenIndex.dataId);
    const indicesId = indicesData.id;
    const outId = backend.dataIdMap.get(out.dataId).id;
    const xStridesBytes = new Uint8Array(new Int32Array(util.computeStrides(flattenX.shape)).buffer);
    const outStridesBytes = new Uint8Array(new Int32Array(util.computeStrides(flattenOutputShape)).buffer);
    wasmGather(xId, CppDType[x.dtype], xStridesBytes, stridesSize, indicesId, shapeInfo.batchSize, outStridesBytes, outId);
    backend.disposeData(flattenX.dataId);
    backend.disposeData(flattenIndex.dataId);
    // reshape
    out.shape = shapeInfo.outputShape;
    return out;
}
const gatherV2Config = {
    kernelName: GatherV2,
    backendName: 'wasm',
    setupFunc: setup$k,
    kernelFunc: gatherV2
};

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
const supportsFullBroadcast$1 = false;
const greaterConfig = createBinaryKernelConfig(Greater, supportsFullBroadcast$1, 'bool');

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
const supportsFullBroadcast$2 = false;
const greaterEqualConfig = createBinaryKernelConfig(GreaterEqual, supportsFullBroadcast$2, 'bool');

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmFunc$2;
function setupFunc$1(backend) {
    wasmFunc$2 = backend.wasm.cwrap(LeakyRelu, null /* void */, [
        'number',
        'number',
        'number',
        'number',
    ]);
}
function leakyRelu(args) {
    const { inputs: { x }, attrs: { alpha }, backend } = args;
    const xId = backend.dataIdMap.get(x.dataId).id;
    // According to TF API, LeakyRelu returns float32 when input is either float32
    // or int32.
    const out = backend.makeOutput(x.shape, 'float32');
    if (util.sizeFromShape(x.shape) !== 0) {
        const outId = backend.dataIdMap.get(out.dataId).id;
        wasmFunc$2(xId, CppDType[x.dtype], alpha, outId);
    }
    return out;
}
const leakyReluConfig = {
    kernelName: LeakyRelu,
    backendName: 'wasm',
    setupFunc: setupFunc$1,
    kernelFunc: leakyRelu,
};

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
const supportsFullBroadcast$3 = false;
const lessConfig = createBinaryKernelConfig(Less, supportsFullBroadcast$3, 'bool');

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
const supportsFullBroadcast$4 = false;
const lessEqualConfig = createBinaryKernelConfig(LessEqual, supportsFullBroadcast$4, 'bool');

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
const logConfig = createUnaryKernelConfig(Log);

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
const supportsFullBroadcast$5 = false;
const logicalAndConfig = createBinaryKernelConfig(LogicalAnd, supportsFullBroadcast$5, 'bool');

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmMax;
function setup$l(backend) {
    wasmMax = backend.wasm.cwrap(Max, null /*void*/, [
        'number',
        'number',
        'number',
        'number',
    ]);
}
function max(args) {
    const { backend, inputs, attrs } = args;
    const { reductionIndices: axis, keepDims } = attrs;
    const { x } = inputs;
    const xId = backend.dataIdMap.get(x.dataId).id;
    let inputId = xId;
    let input = x;
    const { transposed, axes, originalAxes, inputWasTransposed } = permuteAxesAndTranspose(x, axis, backend);
    if (inputWasTransposed) {
        const transposedId = backend.dataIdMap.get(transposed.dataId).id;
        input = transposed;
        inputId = transposedId;
    }
    const inputRank = input.shape.length;
    backend_util.assertAxesAreInnerMostDims('max', axes, inputRank);
    const [outShape, reduceShape] = backend_util.computeOutAndReduceShapes(input.shape, axes);
    const reduceSize = util.sizeFromShape(reduceShape);
    const out = backend.makeOutput(outShape, x.dtype);
    if (util.sizeFromShape(input.shape) !== 0) {
        const outId = backend.dataIdMap.get(out.dataId).id;
        wasmMax(inputId, CppDType[x.dtype], reduceSize, outId);
    }
    if (inputWasTransposed) {
        // dispose of the transposed tensor.
        backend.disposeData(transposed.dataId);
    }
    if (keepDims) {
        // reshape
        const newShape = backend_util.expandShapeToKeepDim(out.shape, originalAxes);
        out.shape = newShape;
    }
    return out;
}
const maxConfig = {
    kernelName: Max,
    backendName: 'wasm',
    setupFunc: setup$l,
    kernelFunc: max
};

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
const maximumConfig = createBinaryKernelConfig(Maximum);

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmMaxPool;
function setup$m(backend) {
    wasmMaxPool = backend.wasm.cwrap(MaxPool, null /* void */, [
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
    ]);
}
function maxPool(args) {
    const { inputs, attrs, backend } = args;
    const x = inputs.x;
    const xId = backend.dataIdMap.get(x.dataId).id;
    // TF API supports int32 input. CPU and WebGL backend also support int32
    // input. WASM backend doesn't support it because it uses xnnpack which only
    // supports float32.
    //
    // Add the following assert only for the WASM backend instead of at core op
    // level.
    //
    // TODO: add support for int32 input.
    util.assert(x.dtype === 'float32', () => `Error in MaxPool: only float32 input is supported. Got ${x.dtype}.`);
    const { filterSize, strides, pad, dimRoundingMode } = attrs;
    const convInfo = backend_util.computePool2DInfo(x.shape, filterSize, strides, 1 /* dilations */, pad, dimRoundingMode);
    const filterHeight = convInfo.filterHeight;
    const filterWidth = convInfo.filterWidth;
    const padTop = convInfo.padInfo.top;
    const padRight = convInfo.padInfo.right;
    const padBottom = convInfo.padInfo.bottom;
    const padLeft = convInfo.padInfo.left;
    const dilationHeight = convInfo.dilationHeight;
    const dilationWidth = convInfo.dilationWidth;
    const strideHeight = convInfo.strideHeight;
    const strideWidth = convInfo.strideWidth;
    const inputChannels = convInfo.inChannels;
    const outputChannels = convInfo.outChannels;
    if (convInfo.dataFormat !== 'channelsLast') {
        throw new Error(`wasm backend does not support dataFormat:'` +
            `${convInfo.dataFormat}'. Please use 'channelsLast'.`);
    }
    const out = backend.makeOutput(convInfo.outShape, 'float32');
    const outId = backend.dataIdMap.get(out.dataId).id;
    wasmMaxPool(xId, x.shape[0], x.shape[1], x.shape[2], filterHeight, filterWidth, padTop, padRight, padBottom, padLeft, dilationHeight, dilationWidth, strideHeight, strideWidth, inputChannels, outputChannels, outId);
    return out;
}
const maxPoolConfig = {
    kernelName: MaxPool,
    backendName: 'wasm',
    setupFunc: setup$m,
    kernelFunc: maxPool
};

/**
 * @license
 * Copyright 2020 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmMean;
function setup$n(backend) {
    wasmMean =
        backend.wasm.cwrap(Mean, null /*void*/, ['number, number, number']);
}
function mean(args) {
    const { backend, inputs, attrs } = args;
    const { axis, keepDims } = attrs;
    const { x } = inputs;
    const xId = backend.dataIdMap.get(x.dataId).id;
    let inputId = xId;
    let input = x;
    const { transposed, axes, originalAxes, inputWasTransposed } = permuteAxesAndTranspose(x, axis, backend);
    let reductionAxes = axes;
    if (inputWasTransposed) {
        const transposedId = backend.dataIdMap.get(transposed.dataId).id;
        if (transposedId !== xId) {
            // transpose was not a no-op. We will need to dispose of this
            // once we are done.
            input = transposed;
            inputId = transposedId;
            reductionAxes = backend_util.getInnerMostAxes(reductionAxes.length, input.shape.length);
        }
    }
    backend_util.assertAxesAreInnerMostDims('mean', reductionAxes, input.shape.length);
    const [outShape, reduceShape] = backend_util.computeOutAndReduceShapes(input.shape, reductionAxes);
    const reduceSize = util.sizeFromShape(reduceShape);
    let castedInput = input;
    if (input.dtype !== 'float32') {
        castedInput =
            cast({ backend, inputs: { x: input }, attrs: { dtype: 'float32' } });
        inputId = backend.dataIdMap.get(castedInput.dataId).id;
    }
    const out = backend.makeOutput(outShape, 'float32');
    if (util.sizeFromShape(input.shape) !== 0) {
        const outId = backend.dataIdMap.get(out.dataId).id;
        wasmMean(inputId, reduceSize, outId);
    }
    if (inputWasTransposed) {
        // dispose of the transposed tensor.
        backend.disposeData(transposed.dataId);
    }
    if (keepDims) {
        // reshape
        const newShape = backend_util.expandShapeToKeepDim(out.shape, originalAxes);
        out.shape = newShape;
    }
    if (input.dtype !== 'float32') {
        backend.disposeData(castedInput.dataId);
    }
    return out;
}
const meanConfig = {
    kernelName: Mean,
    backendName: 'wasm',
    setupFunc: setup$n,
    kernelFunc: mean
};

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmMin;
function setup$o(backend) {
    wasmMin = backend.wasm.cwrap(Min, null /*void*/, [
        'number',
        'number',
        'number',
        'number',
    ]);
}
function min(args) {
    const { backend, inputs, attrs } = args;
    const { axis, keepDims } = attrs;
    const { x } = inputs;
    const xId = backend.dataIdMap.get(x.dataId).id;
    let inputId = xId;
    let input = x;
    const { transposed, axes, originalAxes, inputWasTransposed } = permuteAxesAndTranspose(x, axis, backend);
    if (inputWasTransposed) {
        const transposedId = backend.dataIdMap.get(transposed.dataId).id;
        if (transposedId !== xId) {
            // transpose was not a no-op. We will need to dispose of this
            // once we are done.
            input = transposed;
            inputId = transposedId;
        }
    }
    const inputRank = input.shape.length;
    backend_util.assertAxesAreInnerMostDims('min', axes, inputRank);
    const [outShape, reduceShape] = backend_util.computeOutAndReduceShapes(input.shape, axes);
    const reduceSize = util.sizeFromShape(reduceShape);
    const out = backend.makeOutput(outShape, input.dtype);
    if (util.sizeFromShape(input.shape) !== 0) {
        const outId = backend.dataIdMap.get(out.dataId).id;
        wasmMin(inputId, CppDType[x.dtype], reduceSize, outId);
    }
    if (inputWasTransposed) {
        // dispose of the transposed tensor.
        backend.disposeData(transposed.dataId);
    }
    if (keepDims) {
        // reshape
        const newShape = backend_util.expandShapeToKeepDim(out.shape, originalAxes);
        out.shape = newShape;
    }
    return out;
}
const minConfig = {
    kernelName: Min,
    backendName: 'wasm',
    setupFunc: setup$o,
    kernelFunc: min
};

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
const minimumConfig = createBinaryKernelConfig(Minimum);

/**
 * @license
 * Copyright 2021 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
// Must match enum in MirrorPad.cc
var MirrorPaddingMode;
(function (MirrorPaddingMode) {
    MirrorPaddingMode[MirrorPaddingMode["reflect"] = 0] = "reflect";
    MirrorPaddingMode[MirrorPaddingMode["symmetric"] = 1] = "symmetric";
})(MirrorPaddingMode || (MirrorPaddingMode = {}));
let wasmMirrorPad;
function setup$p(backend) {
    wasmMirrorPad = backend.wasm.cwrap(MirrorPad, null /* void */, [
        'number',
        'array',
        'number',
        'number',
        'array',
        'array',
        'number',
        'number',
    ]);
}
function mirrorPad(args) {
    const { inputs: { x }, backend, attrs: { paddings, mode } } = args;
    const outShape = paddings.map((p, i) => p[0] /* beforePad */ + x.shape[i] + p[1] /* afterPad */);
    const xId = backend.dataIdMap.get(x.dataId).id;
    const out = backend.makeOutput(outShape, x.dtype);
    const outId = backend.dataIdMap.get(out.dataId).id;
    const xShapeBytes = new Uint8Array(new Int32Array(x.shape).buffer);
    const prePaddingsFlat = paddings.map(padTuple => padTuple[0]);
    const postPaddingsFlat = paddings.map(padTuple => padTuple[1]);
    const prePaddingsBytes = new Uint8Array(new Int32Array(prePaddingsFlat).buffer);
    const postPaddingsBytes = new Uint8Array(new Int32Array(postPaddingsFlat).buffer);
    wasmMirrorPad(xId, xShapeBytes, x.shape.length, CppDType[x.dtype], prePaddingsBytes, postPaddingsBytes, MirrorPaddingMode[mode], outId);
    return out;
}
const mirrorPadConfig = {
    kernelName: MirrorPad,
    backendName: 'wasm',
    kernelFunc: mirrorPad,
    setupFunc: setup$p
};

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
const multiplyConfig = createBinaryKernelConfig(Multiply);

/**
 * @license
 * Copyright 2020 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
const negConfig = createUnaryKernelConfig(Neg);

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
/**
 * Parse the result of the c++ method, which has the shape equivalent to
 * `Result`.
 */
function parseResultStruct(backend, resOffset) {
    const result = new Int32Array(backend.wasm.HEAPU8.buffer, resOffset, 4);
    const pSelectedIndices = result[0];
    const selectedSize = result[1];
    const pSelectedScores = result[2];
    const pValidOutputs = result[3];
    // Since the result was allocated on the heap, we have to delete it.
    backend.wasm._free(resOffset);
    return { pSelectedIndices, selectedSize, pSelectedScores, pValidOutputs };
}

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmFunc$3;
function setup$q(backend) {
    wasmFunc$3 = backend.wasm.cwrap(NonMaxSuppressionV3, 'number', // Result*
    [
        'number',
        'number',
        'number',
        'number',
        'number',
    ]);
}
function kernelFunc(args) {
    const { backend, inputs, attrs } = args;
    const { iouThreshold, maxOutputSize, scoreThreshold } = attrs;
    const { boxes, scores } = inputs;
    const boxesId = backend.dataIdMap.get(boxes.dataId).id;
    const scoresId = backend.dataIdMap.get(scores.dataId).id;
    const resOffset = wasmFunc$3(boxesId, scoresId, maxOutputSize, iouThreshold, scoreThreshold);
    const { pSelectedIndices, selectedSize, pSelectedScores, pValidOutputs } = parseResultStruct(backend, resOffset);
    // Since we are not using scores for V3, we have to delete it from the heap.
    backend.wasm._free(pSelectedScores);
    backend.wasm._free(pValidOutputs);
    const selectedIndicesTensor = backend.makeOutput([selectedSize], 'int32', pSelectedIndices);
    return selectedIndicesTensor;
}
const nonMaxSuppressionV3Config = {
    kernelName: NonMaxSuppressionV3,
    backendName: 'wasm',
    setupFunc: setup$q,
    kernelFunc: kernelFunc,
};

/**
 * @license
 * Copyright 2020 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmFunc$4;
function setup$r(backend) {
    wasmFunc$4 = backend.wasm.cwrap(NonMaxSuppressionV4, 'number', // Result*
    [
        'number',
        'number',
        'number',
        'number',
        'number',
        'bool',
    ]);
}
function nonMaxSuppressionV4(args) {
    const { backend, inputs, attrs } = args;
    const { iouThreshold, maxOutputSize, scoreThreshold, padToMaxOutputSize } = attrs;
    const { boxes, scores } = inputs;
    const boxesId = backend.dataIdMap.get(boxes.dataId).id;
    const scoresId = backend.dataIdMap.get(scores.dataId).id;
    const resOffset = wasmFunc$4(boxesId, scoresId, maxOutputSize, iouThreshold, scoreThreshold, padToMaxOutputSize);
    const { pSelectedIndices, selectedSize, pSelectedScores, pValidOutputs } = parseResultStruct(backend, resOffset);
    // Since we are not using scores for V4, we have to delete it from the heap.
    backend.wasm._free(pSelectedScores);
    const selectedIndicesTensor = backend.makeOutput([selectedSize], 'int32', pSelectedIndices);
    const validOutputsTensor = backend.makeOutput([], 'int32', pValidOutputs);
    return [selectedIndicesTensor, validOutputsTensor];
}
const nonMaxSuppressionV4Config = {
    kernelName: NonMaxSuppressionV4,
    backendName: 'wasm',
    setupFunc: setup$r,
    kernelFunc: nonMaxSuppressionV4,
};

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmFunc$5;
function setup$s(backend) {
    wasmFunc$5 = backend.wasm.cwrap(NonMaxSuppressionV5, 'number', // Result*
    [
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
    ]);
}
function kernelFunc$1(args) {
    const { backend, inputs, attrs } = args;
    const { iouThreshold, maxOutputSize, scoreThreshold, softNmsSigma } = attrs;
    const { boxes, scores } = inputs;
    const boxesId = backend.dataIdMap.get(boxes.dataId).id;
    const scoresId = backend.dataIdMap.get(scores.dataId).id;
    const resOffset = wasmFunc$5(boxesId, scoresId, maxOutputSize, iouThreshold, scoreThreshold, softNmsSigma);
    const { pSelectedIndices, selectedSize, pSelectedScores, pValidOutputs } = parseResultStruct(backend, resOffset);
    // Since we are not using validOutputs for V5, we have to delete it from the
    // heap.
    backend.wasm._free(pValidOutputs);
    const selectedIndicesTensor = backend.makeOutput([selectedSize], 'int32', pSelectedIndices);
    const selectedScoresTensor = backend.makeOutput([selectedSize], 'float32', pSelectedScores);
    return [selectedIndicesTensor, selectedScoresTensor];
}
const nonMaxSuppressionV5Config = {
    kernelName: NonMaxSuppressionV5,
    backendName: 'wasm',
    setupFunc: setup$s,
    kernelFunc: kernelFunc$1,
};

/**
 * @license
 * Copyright 2020 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
const supportsFullBroadcast$6 = false;
const notEqualConfig = createBinaryKernelConfig(NotEqual, supportsFullBroadcast$6, 'bool');

/**
 * @license
 * Copyright 2020 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmOneHot;
function setup$t(backend) {
    wasmOneHot = backend.wasm.cwrap(OneHot, null /* void */, [
        'number',
        'number',
        'number',
        'number',
        'number' // out_id
    ]);
}
function oneHot(args) {
    const { inputs, backend, attrs } = args;
    const { indices } = inputs;
    const { depth, onValue, offValue } = attrs;
    const out = backend.makeOutput([...indices.shape, depth], 'int32');
    const outId = backend.dataIdMap.get(out.dataId).id;
    const indicesData = backend.dataIdMap.get(indices.dataId);
    const indicesId = indicesData.id;
    wasmOneHot(indicesId, depth, onValue, offValue, outId);
    return out;
}
const oneHotConfig = {
    kernelName: OneHot,
    backendName: 'wasm',
    setupFunc: setup$t,
    kernelFunc: oneHot,
};

/**
 * @license
 * Copyright 2020 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
function onesLike(args) {
    const { inputs: { x }, backend } = args;
    const out = backend.makeOutput(x.shape, x.dtype);
    const outVals = backend.typedArrayFromHeap(out);
    outVals.fill(1);
    return out;
}
const onesLikeConfig = {
    kernelName: OnesLike,
    backendName: 'wasm',
    kernelFunc: onesLike,
};

/**
 * @license
 * Copyright 2020 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
function pack(args) {
    const { inputs, backend, attrs } = args;
    const { axis } = attrs;
    if (inputs.length === 1) {
        return expandDims({ inputs: { input: inputs[0] }, backend, attrs: { dim: axis } });
    }
    const shape = inputs[0].shape;
    const dtype = inputs[0].dtype;
    inputs.forEach(t => {
        util.assertShapesMatch(shape, t.shape, 'All tensors passed to stack must have matching shapes');
        util.assert(dtype === t.dtype, () => 'All tensors passed to stack must have matching dtypes');
    });
    const intermediateTensorInfos = [];
    const expandedTensors = inputs.map(t => {
        const expandedT = expandDims({ inputs: { input: t }, backend, attrs: { dim: axis } });
        intermediateTensorInfos.push(expandedT);
        return expandedT;
    });
    const result = concat({ inputs: expandedTensors, backend, attrs: { axis } });
    intermediateTensorInfos.forEach(t => backend.disposeData(t.dataId));
    return result;
}
const packConfig = {
    kernelName: Pack,
    backendName: 'wasm',
    kernelFunc: pack
};

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmPadV2;
function setup$u(backend) {
    wasmPadV2 = backend.wasm.cwrap(PadV2, null /* void */, [
        'number',
        'array',
        'number',
        'number',
        'array',
        'array',
        'number',
        'number',
    ]);
}
function pad(args) {
    const { inputs: { x }, backend, attrs: { paddings, constantValue } } = args;
    const outShape = paddings.map((p, i) => p[0] /* beforePad */ + x.shape[i] + p[1] /* afterPad */);
    if (util.sizeFromShape(x.shape) === 0) {
        // Short-circuit the computation, since x doesn't have value, only
        // the shape is used to compute output shape to pad.
        return fill({
            backend,
            attrs: { shape: outShape, value: constantValue, dtype: x.dtype }
        });
    }
    const xId = backend.dataIdMap.get(x.dataId).id;
    const out = backend.makeOutput(outShape, x.dtype);
    const outTensorData = backend.dataIdMap.get(out.dataId);
    const outId = outTensorData.id;
    const xShapeBytes = new Uint8Array(new Int32Array(x.shape).buffer);
    const prePaddingsFlat = paddings.map(padTuple => padTuple[0]);
    const postPaddingsFlat = paddings.map(padTuple => padTuple[1]);
    const prePaddingsBytes = new Uint8Array(new Int32Array(prePaddingsFlat).buffer);
    const postPaddingsBytes = new Uint8Array(new Int32Array(postPaddingsFlat).buffer);
    wasmPadV2(xId, xShapeBytes, x.shape.length, CppDType[x.dtype], prePaddingsBytes, postPaddingsBytes, constantValue, outId);
    return out;
}
const padV2Config = {
    kernelName: PadV2,
    backendName: 'wasm',
    kernelFunc: pad,
    setupFunc: setup$u
};

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
const powConfig = createBinaryKernelConfig(Pow);

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmPrelu;
function setup$v(backend) {
    wasmPrelu = backend.wasm.cwrap(Prelu, null /* void */, [
        'number',
        'number',
        'number' // out_id
    ]);
}
function prelu(args) {
    const { inputs, backend } = args;
    const { x, alpha } = inputs;
    const xId = backend.dataIdMap.get(x.dataId).id;
    const weightsId = backend.dataIdMap.get(alpha.dataId).id;
    let inputId = xId;
    const input = x;
    let castedInput = input;
    if (input.dtype !== 'float32') {
        castedInput = cast({ backend, inputs: { x }, attrs: { dtype: 'float32' } });
        inputId = backend.dataIdMap.get(castedInput.dataId).id;
    }
    const out = backend.makeOutput(x.shape, 'float32');
    const outId = backend.dataIdMap.get(out.dataId).id;
    wasmPrelu(inputId, weightsId, outId);
    if (input.dtype !== 'float32') {
        backend.disposeData(castedInput.dataId);
    }
    return out;
}
const preluConfig = {
    kernelName: Prelu,
    backendName: 'wasm',
    setupFunc: setup$v,
    kernelFunc: prelu
};

/**
 * @license
 * Copyright 2020 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmProd;
function setup$w(backend) {
    wasmProd = backend.wasm.cwrap(Prod, null /*void*/, [
        'number',
        'number',
        'number',
        'number'
    ]);
}
function prod(args) {
    const { backend, inputs, attrs } = args;
    const { axis, keepDims } = attrs;
    const { x } = inputs;
    const xId = backend.dataIdMap.get(x.dataId).id;
    let inputId = xId;
    let input = x;
    const { transposed, axes, originalAxes, inputWasTransposed } = permuteAxesAndTranspose(x, axis, backend);
    let reductionAxes = axes;
    if (inputWasTransposed) {
        const transposedId = backend.dataIdMap.get(transposed.dataId).id;
        if (transposedId !== xId) {
            // transpose was not a no-op. We will need to dispose of this
            // once we are done.
            input = transposed;
            inputId = transposedId;
            reductionAxes = backend_util.getInnerMostAxes(reductionAxes.length, input.shape.length);
        }
    }
    backend_util.assertAxesAreInnerMostDims('prod', reductionAxes, input.shape.length);
    const [outShape, reduceShape] = backend_util.computeOutAndReduceShapes(input.shape, reductionAxes);
    const reduceSize = util.sizeFromShape(reduceShape);
    const out = backend.makeOutput(outShape, input.dtype);
    if (util.sizeFromShape(input.shape) !== 0) {
        const outId = backend.dataIdMap.get(out.dataId).id;
        wasmProd(inputId, reduceSize, CppDType[out.dtype], outId);
    }
    if (inputWasTransposed) {
        // dispose of the transposed tensor.
        backend.disposeData(transposed.dataId);
    }
    if (keepDims) {
        // reshape
        const newShape = backend_util.expandShapeToKeepDim(out.shape, originalAxes);
        out.shape = newShape;
    }
    return out;
}
const prodConfig = {
    kernelName: Prod,
    backendName: 'wasm',
    setupFunc: setup$w,
    kernelFunc: prod
};

/**
 * @license
 * Copyright 2020 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
const range = (args) => {
    const { backend, attrs } = args;
    const { start, stop, step, dtype } = attrs;
    const values = rangeImpl(start, stop, step, dtype);
    const out = backend.makeOutput([values.length], dtype);
    const outVals = backend.typedArrayFromHeap(out);
    outVals.set(values);
    return out;
};
const rangeConfig = {
    kernelName: Range,
    backendName: 'wasm',
    kernelFunc: range
};

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
const realDivConfig = createBinaryKernelConfig(RealDiv);

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
const reluConfig = createUnaryKernelConfig(Relu);

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
const relu6Config = createUnaryKernelConfig(Relu6);

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmResizeBilinear;
function setup$x(backend) {
    wasmResizeBilinear = backend.wasm.cwrap(ResizeBilinear, null /*void*/, [
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number' // outId
    ]);
}
function resizeBilinear(args) {
    const { backend, inputs, attrs } = args;
    const { images } = inputs;
    const { alignCorners, halfPixelCenters, size } = attrs;
    const [newHeight, newWidth] = size;
    const [batch, oldHeight, oldWidth, numChannels] = images.shape;
    const outShape = [batch, newHeight, newWidth, numChannels];
    let xData = backend.dataIdMap.get(images.dataId);
    let castedData;
    if (xData.dtype !== 'float32') {
        castedData =
            cast({ backend, inputs: { x: images }, attrs: { dtype: 'float32' } });
        xData = backend.dataIdMap.get(castedData.dataId);
    }
    const xId = xData.id;
    const out = backend.makeOutput(outShape, 'float32');
    if (util.sizeFromShape(images.shape) === 0) {
        return out;
    }
    const outId = backend.dataIdMap.get(out.dataId).id;
    wasmResizeBilinear(xId, batch, oldHeight, oldWidth, numChannels, newHeight, newWidth, alignCorners ? 1 : 0, halfPixelCenters ? 1 : 0, outId);
    if (castedData != null) {
        backend.disposeData(castedData.dataId);
    }
    return out;
}
const resizeBilinearConfig = {
    kernelName: ResizeBilinear,
    backendName: 'wasm',
    setupFunc: setup$x,
    kernelFunc: resizeBilinear
};

/**
 * @license
 * Copyright 2020 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmReverse;
function setup$y(backend) {
    wasmReverse = backend.wasm.cwrap(Reverse, null, [
        'number',
        'array',
        'number',
        'array',
        'number',
        'number' // out_id
    ]);
}
function reverse(args) {
    const { inputs, backend, attrs } = args;
    const { x } = inputs;
    const { dims } = attrs;
    const axes = util.parseAxisParam(dims, x.shape);
    if (x.shape.length === 0) {
        return identity({ inputs: { x }, backend });
    }
    const out = backend.makeOutput(x.shape, x.dtype);
    const xId = backend.dataIdMap.get(x.dataId).id;
    const outId = backend.dataIdMap.get(out.dataId).id;
    const axesBytes = new Uint8Array(new Int32Array(axes).buffer);
    const outShapeBytes = new Uint8Array(new Int32Array(x.shape).buffer);
    wasmReverse(xId, axesBytes, axes.length, outShapeBytes, x.shape.length, outId);
    const reshaped = reshape({ inputs: { x: out }, attrs: { shape: x.shape }, backend });
    backend.disposeData(out.dataId);
    return reshaped;
}
const reverseConfig = {
    kernelName: Reverse,
    backendName: 'wasm',
    kernelFunc: reverse,
    setupFunc: setup$y
};

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmRotate;
function setup$z(backend) {
    wasmRotate = backend.wasm.cwrap(RotateWithOffset, null /* void */, [
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'array',
        'number',
        'number',
    ]);
}
function rotateWithOffset(args) {
    const { inputs, backend, attrs } = args;
    const { image } = inputs;
    const { radians, fillValue, center } = attrs;
    const out = backend.makeOutput(image.shape, image.dtype);
    const imageId = backend.dataIdMap.get(image.dataId).id;
    const outId = backend.dataIdMap.get(out.dataId).id;
    const [batch, imageHeight, imageWidth, numChannels] = image.shape;
    const [centerX, centerY] = backend_util.getImageCenter(center, imageHeight, imageWidth);
    const fillIsBlack = fillValue === 0;
    const fullOpacityValue = 255;
    const fillValues = typeof fillValue === 'number' ?
        [fillValue, fillValue, fillValue, fillIsBlack ? 0 : fullOpacityValue] :
        [...fillValue, fullOpacityValue];
    const fillBytes = new Uint8Array(new Int32Array(fillValues).buffer);
    wasmRotate(imageId, batch, imageHeight, imageWidth, numChannels, radians, centerX, centerY, fillBytes, fillValues.length, outId);
    return out;
}
const rotateWithOffsetConfig = {
    kernelName: RotateWithOffset,
    backendName: 'wasm',
    kernelFunc: rotateWithOffset,
    setupFunc: setup$z
};

/**
 * @license
 * Copyright 2021 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
const roundConfig = createUnaryKernelConfig(Round);

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
const rsqrtConfig = createUnaryKernelConfig(Rsqrt);

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmScatterNd;
function setup$A(backend) {
    wasmScatterNd = backend.wasm.cwrap(ScatterNd, null /*void*/, [
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'array',
        'number',
        'number' // outId
    ]);
}
function scatterNd(args) {
    const { backend, inputs, attrs } = args;
    const { indices, updates } = inputs;
    const { shape } = attrs;
    const out = backend.makeOutput(shape, updates.dtype);
    if (util.sizeFromShape(shape) === 0) {
        return out;
    }
    const { sliceRank, numUpdates, sliceSize, strides, outputSize } = scatter_util.calculateShapes(updates, indices, shape);
    const indicesData = backend.dataIdMap.get(indices.dataId);
    const indicesId = indicesData.id;
    const updatesData = backend.dataIdMap.get(updates.dataId);
    const updatesId = updatesData.id;
    const stridesBytes = new Uint8Array(new Int32Array(strides).buffer);
    const outId = backend.dataIdMap.get(out.dataId).id;
    wasmScatterNd(indicesId, updatesId, CppDType[updates.dtype], sliceRank, numUpdates, sliceSize, stridesBytes, outputSize, outId);
    return out;
}
const scatterNdConfig = {
    kernelName: ScatterNd,
    backendName: 'wasm',
    setupFunc: setup$A,
    kernelFunc: scatterNd
};

/**
 * @license
 * Copyright 2020 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmSelect;
function setup$B(backend) {
    wasmSelect = backend.wasm.cwrap('SelectV2', null, [
        'number',
        'number',
        'number',
        'number',
        'number',
    ]);
}
function select(args) {
    const { inputs, backend } = args;
    const { condition, t, e } = inputs;
    const conditionId = backend.dataIdMap.get(condition.dataId).id;
    const tId = backend.dataIdMap.get(t.dataId).id;
    const eId = backend.dataIdMap.get(e.dataId).id;
    const out = backend.makeOutput(t.shape, t.dtype);
    const outId = backend.dataIdMap.get(out.dataId).id;
    const cRank = condition.shape.length;
    const tRank = t.shape.length;
    const offset = cRank === 0 || cRank > 1 || tRank === 1 ?
        1 :
        util.sizeFromShape(t.shape.slice(1));
    wasmSelect(conditionId, tId, eId, offset, outId);
    return out;
}
const selectConfig = {
    kernelName: Select,
    backendName: 'wasm',
    kernelFunc: select,
    setupFunc: setup$B
};

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmFunc$6;
function setup$C(backend) {
    wasmFunc$6 = backend.wasm.cwrap(Sigmoid, null /* void */, ['number', 'number']);
}
function sigmoid(args) {
    const { backend, inputs: { x } } = args;
    const xId = backend.dataIdMap.get(x.dataId).id;
    const out = backend.makeOutput(x.shape, x.dtype);
    const outId = backend.dataIdMap.get(out.dataId).id;
    // Short-circuit zero-sized tensors.
    if (util.sizeFromShape(out.shape) === 0) {
        return out;
    }
    wasmFunc$6(xId, outId);
    return out;
}
const sigmoidConfig = {
    kernelName: 'Sigmoid',
    backendName: 'wasm',
    setupFunc: setup$C,
    kernelFunc: sigmoid
};

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
const sinConfig = createUnaryKernelConfig(Sin);

/**
 * @license
 * Copyright 2020 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmFunc$7;
function setup$D(backend) {
    wasmFunc$7 = backend.wasm.cwrap(Softmax, null /* void */, [
        'number',
        'number',
        'number',
        'number' // batch
    ]);
}
function softmax(args) {
    const { backend, inputs: { logits }, attrs: { dim } } = args;
    const xId = backend.dataIdMap.get(logits.dataId).id;
    const out = backend.makeOutput(logits.shape, logits.dtype);
    const outId = backend.dataIdMap.get(out.dataId).id;
    const channels = logits.shape[dim];
    const batch = util.sizeFromShape(logits.shape) / channels;
    // Short-circuit zero-sized tensors.
    if (util.sizeFromShape(out.shape) === 0) {
        return out;
    }
    wasmFunc$7(xId, outId, channels, batch);
    return out;
}
const softmaxConfig = {
    kernelName: Softmax,
    backendName: 'wasm',
    setupFunc: setup$D,
    kernelFunc: softmax
};

/**
 * @license
 * Copyright 2021 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
function spaceToBatchND(args) {
    const { inputs, backend, attrs } = args;
    const { x } = inputs;
    const { blockShape, paddings } = attrs;
    const prod = util.sizeFromShape(blockShape);
    const completePaddings = [[0, 0]];
    completePaddings.push(...paddings);
    for (let i = 1 + blockShape.length; i < x.shape.length; ++i) {
        completePaddings.push([0, 0]);
    }
    const paddedX = padV2Config.kernelFunc({
        inputs: { x },
        backend,
        attrs: { paddings: completePaddings, constantValue: 0 }
    });
    const reshapedPaddedShape = backend_util.getReshaped(paddedX.shape, blockShape, prod, false);
    const permutedReshapedPaddedPermutation = backend_util.getPermuted(reshapedPaddedShape.length, blockShape.length, false);
    const flattenShape = backend_util.getReshapedPermuted(paddedX.shape, blockShape, prod, false);
    const reshapeInputs = { x: paddedX };
    const reshapeAttrs = { shape: reshapedPaddedShape };
    const paddedXReshaped = reshape({ inputs: reshapeInputs, backend, attrs: reshapeAttrs });
    const transposeInputs = { x: paddedXReshaped };
    const transposeAttrs = { perm: permutedReshapedPaddedPermutation };
    const paddedXT = transpose({ inputs: transposeInputs, backend, attrs: transposeAttrs });
    const resultReshapeInputs = { x: paddedXT };
    const resultReshapeAttrs = { shape: flattenShape };
    const result = reshape({ inputs: resultReshapeInputs, backend, attrs: resultReshapeAttrs });
    backend.disposeData(paddedX.dataId);
    backend.disposeData(paddedXReshaped.dataId);
    backend.disposeData(paddedXT.dataId);
    return result;
}
const spaceToBatchNDConfig = {
    kernelName: SpaceToBatchND,
    backendName: 'wasm',
    kernelFunc: spaceToBatchND
};

/**
 * @license
 * Copyright 2021 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmSparseFillEmptyRows;
function setup$E(backend) {
    wasmSparseFillEmptyRows =
        backend.wasm.cwrap('SparseFillEmptyRows', 'number', [
            'number',
            'number',
            'number',
            'number',
            'number',
            'number',
            'number',
            'number',
            'number',
            'number',
            'number',
            'number',
        ]);
}
function sparseFillEmptyRows(args) {
    const { backend, inputs } = args;
    const { indices, values, denseShape, defaultValue } = inputs;
    const indicesCount = indices.shape[0];
    const rank = indices.shape[1];
    const denseRows = backend.readSync(denseShape.dataId)[0];
    // Set output size to maximum possible and resize later (actual result
    // might be smaller).
    const maxOutputIndicesShape = [indicesCount + denseRows, rank];
    const indicesId = backend.dataIdMap.get(indices.dataId).id;
    const valuesId = backend.dataIdMap.get(values.dataId).id;
    const defaultValueId = backend.dataIdMap.get(defaultValue.dataId).id;
    const outputIndices = backend.makeOutput(maxOutputIndicesShape, indices.dtype);
    const outputIndicesId = backend.dataIdMap.get(outputIndices.dataId).id;
    const outputValues = backend.makeOutput(maxOutputIndicesShape.slice(0, 1), values.dtype);
    const outputValuesId = backend.dataIdMap.get(outputValues.dataId).id;
    const emptyRowIndicator = backend.makeOutput([denseRows], 'bool');
    const emptyRowIndicatorId = backend.dataIdMap.get(emptyRowIndicator.dataId).id;
    const reverseIndexMap = backend.makeOutput([indicesCount], indices.dtype);
    const reverseIndexMapId = backend.dataIdMap.get(reverseIndexMap.dataId).id;
    const exceptionValues = backend.makeOutput([4], 'int32');
    const exceptionValuesId = backend.dataIdMap.get(exceptionValues.dataId).id;
    const outputRows = wasmSparseFillEmptyRows(indicesId, valuesId, CppDType[values.dtype], indicesCount, denseRows, rank, defaultValueId, outputIndicesId, outputValuesId, emptyRowIndicatorId, reverseIndexMapId, exceptionValuesId);
    const exceptionValuesArray = backend.readSync(exceptionValues.dataId);
    let exceptionMessage;
    switch (exceptionValuesArray[0]) {
        case 1: {
            exceptionMessage =
                backend_util.getSparseFillEmptyRowsIndicesDenseShapeMismatch(exceptionValuesArray[1]);
            break;
        }
        case 2: {
            exceptionMessage =
                backend_util.getSparseFillEmptyRowsNegativeIndexErrorMessage(exceptionValuesArray[1], exceptionValuesArray[2]);
            break;
        }
        case 3:
            exceptionMessage =
                backend_util.getSparseFillEmptyRowsOutOfRangeIndexErrorMessage(exceptionValuesArray[1], exceptionValuesArray[2], exceptionValuesArray[3]);
            break;
        default:
            exceptionMessage = '';
    }
    backend.disposeData(exceptionValues.dataId);
    if (exceptionMessage) {
        backend.disposeData(outputIndices.dataId);
        backend.disposeData(outputValues.dataId);
        backend.disposeData(emptyRowIndicator.dataId);
        backend.disposeData(reverseIndexMap.dataId);
        throw new Error(exceptionMessage);
    }
    let resizedIndices = outputIndices;
    let resizedValues = outputValues;
    // Overestimated output size.
    if (outputRows !== maxOutputIndicesShape[0]) {
        resizedIndices = slice({
            inputs: { x: outputIndices },
            attrs: { begin: 0, size: [outputRows, rank] },
            backend
        });
        resizedValues = slice({
            inputs: { x: outputValues },
            attrs: { begin: 0, size: outputRows },
            backend
        });
        backend.disposeData(outputIndices.dataId);
        backend.disposeData(outputValues.dataId);
    }
    return [resizedIndices, resizedValues, emptyRowIndicator, reverseIndexMap];
}
const sparseFillEmptyRowsConfig = {
    kernelName: SparseFillEmptyRows,
    backendName: 'wasm',
    setupFunc: setup$E,
    kernelFunc: sparseFillEmptyRows
};

/**
 * @license
 * Copyright 2021 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmSparseReshape;
function setup$F(backend) {
    wasmSparseReshape = backend.wasm.cwrap(SparseReshape, null /*void*/, [
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
    ]);
}
function sparseReshape(args) {
    const { backend, inputs } = args;
    const { inputIndices, inputShape, newShape } = inputs;
    if (inputIndices.shape.length !== 2) {
        throw new Error(`Input indices should be a matrix but received shape
        ${inputIndices.shape}`);
    }
    if (inputShape.shape.length !== 1) {
        throw new Error(`Input shape should be a vector but received shape
        ${inputShape.shape}`);
    }
    if (newShape.shape.length !== 1) {
        throw new Error(`Target shape should be a vector but received shape ${newShape.shape}`);
    }
    const inputIndicesId = backend.dataIdMap.get(inputIndices.dataId).id;
    const inputShapeId = backend.dataIdMap.get(inputShape.dataId).id;
    const newShapeId = backend.dataIdMap.get(newShape.dataId).id;
    const nnz = inputIndices.shape[0];
    const outputRank = util.sizeFromShape(newShape.shape);
    const newIndices = backend.makeOutput([nnz, outputRank], inputIndices.dtype);
    const newIndicesId = backend.dataIdMap.get(newIndices.dataId).id;
    const outputShape = backend.makeOutput([outputRank], newShape.dtype);
    const outputShapeId = backend.dataIdMap.get(outputShape.dataId).id;
    const exceptionValues = backend.makeOutput([3], 'int32');
    const exceptionValuesId = backend.dataIdMap.get(exceptionValues.dataId).id;
    wasmSparseReshape(inputIndicesId, inputShapeId, newShapeId, nnz, newIndicesId, outputShapeId, exceptionValuesId);
    const exceptionValuesArray = backend.readSync(exceptionValues.dataId);
    let exceptionMessage;
    switch (exceptionValuesArray[0]) {
        case 0: {
            exceptionMessage =
                backend_util.getSparseReshapeMultipleNegativeOneOutputDimErrorMessage(exceptionValuesArray[1], exceptionValuesArray[2]);
            break;
        }
        case 1: {
            exceptionMessage =
                backend_util.getSparseReshapeNegativeOutputDimErrorMessage(exceptionValuesArray[1], exceptionValuesArray[2]);
            break;
        }
        case 2:
            exceptionMessage =
                backend_util.getSparseReshapeEmptyTensorZeroOutputDimErrorMessage();
            break;
        case 3: {
            const inputShapeValues = Array.from(backend.readSync(inputShape.dataId)), outputShapeValues = Array.from(backend.readSync(outputShape.dataId));
            exceptionMessage =
                backend_util.getSparseReshapeInputOutputMultipleErrorMessage(inputShapeValues, outputShapeValues);
            break;
        }
        case 4: {
            const inputShapeValues = Array.from(backend.readSync(inputShape.dataId)), outputShapeValues = Array.from(backend.readSync(outputShape.dataId));
            exceptionMessage =
                backend_util.getSparseReshapeInputOutputMismatchErrorMessage(inputShapeValues, outputShapeValues);
            break;
        }
        default:
            exceptionMessage = '';
    }
    backend.disposeData(exceptionValues.dataId);
    if (exceptionMessage) {
        backend.disposeData(newIndices.dataId);
        backend.disposeData(outputShape.dataId);
        throw new Error(exceptionMessage);
    }
    return [newIndices, outputShape];
}
const sparseReshapeConfig = {
    kernelName: SparseReshape,
    backendName: 'wasm',
    setupFunc: setup$F,
    kernelFunc: sparseReshape
};

/**
 * @license
 * Copyright 2021 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmSparseSegmentReduction;
function setup$G(backend) {
    wasmSparseSegmentReduction =
        backend.wasm.cwrap('SparseSegmentReduction', null /*void*/, [
            'number',
            'number',
            'number',
            'number',
            'number',
            'number',
            'number',
            'number',
            'number',
        ]);
}
function sparseSegmentReduction(args, isMean) {
    const { backend, inputs } = args;
    const { data, indices, segmentIds } = inputs;
    const numIndices = indices.shape[0];
    const segmentIdsBack = backend.readSync(segmentIds.dataId, numIndices - 1, numIndices)[0];
    const lastSegmentIdPlusOne = numIndices > 0 ? segmentIdsBack + 1 : 0;
    const outputRows = lastSegmentIdPlusOne;
    if (outputRows < 0) {
        throw (new Error(backend_util
            .getSparseSegmentReductionNegativeSegmentIdsErrorMessage()));
    }
    const outputShape = data.shape.slice();
    outputShape[0] = outputRows;
    const dataId = backend.dataIdMap.get(data.dataId).id;
    const indicesId = backend.dataIdMap.get(indices.dataId).id;
    const segmentIdsId = backend.dataIdMap.get(segmentIds.dataId).id;
    const output = backend.makeOutput(outputShape, data.dtype);
    const outputId = backend.dataIdMap.get(output.dataId).id;
    const exceptionValues = backend.makeOutput([4], 'int32');
    const exceptionValuesId = backend.dataIdMap.get(exceptionValues.dataId).id;
    wasmSparseSegmentReduction(dataId, CppDType[data.dtype], data.shape[0], indicesId, segmentIdsId, outputId, exceptionValuesId, isMean, 0);
    const exceptionValuesArray = backend.readSync(exceptionValues.dataId);
    let exceptionMessage;
    switch (exceptionValuesArray[0]) {
        case 0: {
            exceptionMessage =
                backend_util
                    .getSparseSegmentReductionNegativeSegmentIdsErrorMessage();
            break;
        }
        case 1: {
            exceptionMessage =
                backend_util
                    .getSparseSegmentReductionNonIncreasingSegmentIdsErrorMessage();
            break;
        }
        case 2:
            exceptionMessage =
                backend_util.getSparseSegmentReductionSegmentIdOutOfRangeErrorMessage(exceptionValuesArray[1], exceptionValuesArray[2]);
            break;
        case 3:
            exceptionMessage =
                backend_util.getSparseSegmentReductionIndicesOutOfRangeErrorMessage(exceptionValuesArray[1], exceptionValuesArray[2], exceptionValuesArray[3]);
            break;
        default:
            exceptionMessage = '';
    }
    backend.disposeData(exceptionValues.dataId);
    if (exceptionMessage) {
        backend.disposeData(output.dataId);
        throw new Error(exceptionMessage);
    }
    return output;
}

/**
 * @license
 * Copyright 2021 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
function sparseSegmentMean(args) {
    return sparseSegmentReduction(args, true);
}
const sparseSegmentMeanConfig = {
    kernelName: SparseSegmentMean,
    backendName: 'wasm',
    setupFunc: setup$G,
    kernelFunc: sparseSegmentMean
};

/**
 * @license
 * Copyright 2021 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
function sparseSegmentSum(args) {
    return sparseSegmentReduction(args, false);
}
const sparseSegmentSumConfig = {
    kernelName: SparseSegmentSum,
    backendName: 'wasm',
    setupFunc: setup$G,
    kernelFunc: sparseSegmentSum
};

/**
 * @license
 * Copyright 2020 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
function splitV(args) {
    const { inputs, attrs, backend } = args;
    const { x } = inputs;
    const { numOrSizeSplits, axis } = attrs;
    const $axis = util.parseAxisParam(axis, x.shape)[0];
    const splitSizes = backend_util.prepareSplitSize(x, numOrSizeSplits, $axis);
    const begin = new Array(x.shape.length).fill(0);
    const size = x.shape.slice();
    return splitSizes.map(s => {
        const xSliceSize = [...size];
        xSliceSize[$axis] = s;
        const xSlice = slice({ inputs: { x }, attrs: { begin, size: xSliceSize }, backend });
        begin[$axis] += s;
        return xSlice;
    });
}
const splitVConfig = {
    kernelName: SplitV,
    backendName: 'wasm',
    kernelFunc: splitV
};

/**
 * @license
 * Copyright 2020 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
const sqrtConfig = createUnaryKernelConfig(Sqrt);

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
const squareConfig = createUnaryKernelConfig(Square);

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
const squaredDifferenceConfig = createBinaryKernelConfig(SquaredDifference);

/**
 * @license
 * Copyright 2020 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmStep;
function setup$H(backend) {
    wasmStep = backend.wasm.cwrap(Step, null /*void*/, [
        'number',
        'number',
        'number',
        'number',
    ]);
}
function step(args) {
    const { backend, inputs, attrs } = args;
    const { alpha } = attrs;
    const { x } = inputs;
    const xId = backend.dataIdMap.get(x.dataId).id;
    const out = backend.makeOutput(x.shape, x.dtype);
    const outId = backend.dataIdMap.get(out.dataId).id;
    wasmStep(xId, alpha, CppDType[x.dtype], outId);
    return out;
}
const stepConfig = {
    kernelName: Step,
    backendName: 'wasm',
    setupFunc: setup$H,
    kernelFunc: step
};

/**
 * @license
 * Copyright 2021 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmStridedSlice;
function setup$I(backend) {
    wasmStridedSlice = backend.wasm.cwrap(StridedSlice, null /*void*/, [
        'number',
        'array',
        'number',
        'array',
        'array',
        'array',
        'array',
        'array',
        'number',
        'number',
    ]);
}
function stridedSlice(args) {
    const { backend, inputs, attrs } = args;
    const { x } = inputs;
    const { begin, end, strides, beginMask, endMask, ellipsisMask, newAxisMask, shrinkAxisMask } = attrs;
    const { finalShapeSparse, finalShape, isIdentity, sliceDim0, isSimpleSlice, begin: $begin, end: $end, strides: $strides } = slice_util.sliceInfo(x.shape, begin, end, strides, beginMask, endMask, ellipsisMask, newAxisMask, shrinkAxisMask);
    let result;
    if (isIdentity) {
        // Optimization #1, slice is a no-op plus reshape
        result = reshape({ inputs: { x }, backend, attrs: { shape: finalShape } });
    }
    else if (sliceDim0 || isSimpleSlice) {
        // Optimization #2, slice is memory contiguous (only occurs in dim 0)
        util.assert(x.shape.length >= 1, () => `Input must have rank at least 1, got: ${x.shape.length}`);
        const size = slice_util.computeOutShape($begin, $end, $strides);
        // To tolerate begin[0] > end[0] (a 0-output slice), we min(begin, end).
        const sliced = slice({ inputs: { x }, backend, attrs: { begin: $begin, size } });
        result =
            reshape({ inputs: { x: sliced }, backend, attrs: { shape: finalShape } });
        backend.disposeData(sliced.dataId);
    }
    else {
        const out = backend.makeOutput(finalShapeSparse, 'float32');
        const xId = backend.dataIdMap.get(x.dataId).id;
        const xStridesBytes = new Uint8Array(new Int32Array(util.computeStrides(x.shape)).buffer);
        const beginBytes = new Uint8Array(new Int32Array($begin).buffer);
        const endBytes = new Uint8Array(new Int32Array($end).buffer);
        const stridesBytes = new Uint8Array(new Int32Array($strides).buffer);
        const outputShapeBytes = new Uint8Array(new Int32Array(finalShapeSparse).buffer);
        const outStridesBytes = new Uint8Array(new Int32Array(util.computeStrides(finalShapeSparse)).buffer);
        const outId = backend.dataIdMap.get(out.dataId).id;
        wasmStridedSlice(xId, xStridesBytes, x.shape.length, beginBytes, endBytes, stridesBytes, outputShapeBytes, outStridesBytes, finalShapeSparse.length, outId);
        result = reshape({ inputs: { x: out }, backend, attrs: { shape: finalShape } });
        backend.disposeData(out.dataId);
    }
    return result;
}
const stridedSliceConfig = {
    kernelName: StridedSlice,
    backendName: 'wasm',
    setupFunc: setup$I,
    kernelFunc: stridedSlice
};

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
const subConfig = createBinaryKernelConfig(Sub);

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmSum;
function setup$J(backend) {
    wasmSum = backend.wasm.cwrap(Sum, null /*void*/, [
        'number',
        'number',
        'number',
        'number',
    ]);
}
function sum(args) {
    const { backend, inputs, attrs } = args;
    const { axis, keepDims } = attrs;
    const { x } = inputs;
    const xId = backend.dataIdMap.get(x.dataId).id;
    let inputId = xId;
    let input = x;
    const { transposed, axes, originalAxes, inputWasTransposed } = permuteAxesAndTranspose(x, axis, backend);
    let reductionAxes = axes;
    if (inputWasTransposed) {
        const transposedId = backend.dataIdMap.get(transposed.dataId).id;
        if (transposedId !== xId) {
            // transpose was not a no-op. We will need to dispose of this
            // once we are done.
            input = transposed;
            inputId = transposedId;
            reductionAxes = backend_util.getInnerMostAxes(reductionAxes.length, input.shape.length);
        }
    }
    backend_util.assertAxesAreInnerMostDims('sum', reductionAxes, input.shape.length);
    const [outShape, reduceShape] = backend_util.computeOutAndReduceShapes(input.shape, reductionAxes);
    const reduceSize = util.sizeFromShape(reduceShape);
    const out = backend.makeOutput(outShape, input.dtype);
    if (util.sizeFromShape(input.shape) !== 0) {
        const outId = backend.dataIdMap.get(out.dataId).id;
        wasmSum(inputId, reduceSize, CppDType[out.dtype], outId);
    }
    if (inputWasTransposed) {
        // dispose of the transposed tensor.
        backend.disposeData(transposed.dataId);
    }
    if (keepDims) {
        // reshape
        const newShape = backend_util.expandShapeToKeepDim(out.shape, originalAxes);
        out.shape = newShape;
    }
    return out;
}
const sumConfig = {
    kernelName: Sum,
    backendName: 'wasm',
    setupFunc: setup$J,
    kernelFunc: sum
};

/**
 * @license
 * Copyright 2021 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
const tanConfig = createUnaryKernelConfig(Tan);

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
const tanhConfig = createUnaryKernelConfig(Tanh);

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmTile;
function setup$K(backend) {
    wasmTile = backend.wasm.cwrap(Tile, null /* void */, [
        'number',
        'array',
        'number',
        'array',
        'number',
        'number' // out_id
    ]);
}
function tile(args) {
    const { inputs, backend, attrs } = args;
    const { x } = inputs;
    const xId = backend.dataIdMap.get(x.dataId).id;
    const { reps } = attrs;
    const newShape = new Array(x.shape.length);
    for (let i = 0; i < newShape.length; i++) {
        newShape[i] = x.shape[i] * reps[i];
    }
    const xShapeBytes = new Uint8Array(new Int32Array(x.shape).buffer);
    const newShapeBytes = new Uint8Array(new Int32Array(newShape).buffer);
    const out = backend.makeOutput(newShape, x.dtype);
    const outId = backend.dataIdMap.get(out.dataId).id;
    wasmTile(xId, xShapeBytes, x.shape.length, newShapeBytes, newShape.length, CppDType[out.dtype], outId);
    return out;
}
const tileConfig = {
    kernelName: Tile,
    backendName: 'wasm',
    setupFunc: setup$K,
    kernelFunc: tile
};

/**
 * @license
 * Copyright 2020 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmTopK;
function setup$L(backend) {
    wasmTopK = backend.wasm.cwrap(TopK, null /* void */, [
        'number',
        'array',
        'number',
        'number',
        'number',
        'bool',
        'number',
        'number',
    ]);
}
const topk = ({ inputs, backend, attrs }) => {
    const { x } = inputs;
    const { k, sorted } = attrs;
    const xId = backend.dataIdMap.get(x.dataId).id;
    const xShapeBytes = new Uint8Array(new Int32Array(x.shape).buffer);
    const outputShape = x.shape.slice();
    outputShape[outputShape.length - 1] = k;
    const outValues = backend.makeOutput(outputShape, x.dtype);
    const outValuesId = backend.dataIdMap.get(outValues.dataId).id;
    const outIndices = backend.makeOutput(outputShape, 'int32');
    const outIndicesId = backend.dataIdMap.get(outIndices.dataId).id;
    wasmTopK(xId, xShapeBytes, x.shape.length, CppDType[x.dtype], k, sorted, outValuesId, outIndicesId);
    return [outValues, outIndices];
};
const topKConfig = {
    kernelName: TopK,
    backendName: 'wasm',
    setupFunc: setup$L,
    kernelFunc: topk,
};

/**
 * @license
 * Copyright 2021 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
let wasmTransform;
function setup$M(backend) {
    wasmTransform = backend.wasm.cwrap(Transform, null /*void*/, [
        'number',
        'number',
        'bool',
        'number',
        'number',
        'number',
        'number',
        'number',
        'number',
        'array',
        'number',
        'number',
        'number',
        'number',
        'number' // outId
    ]);
}
function transform(args) {
    const { backend, inputs, attrs } = args;
    const { image, transforms } = inputs;
    const { interpolation, fillMode, fillValue, outputShape } = attrs;
    const [batch, imageHeight, imageWidth, numChannels] = image.shape;
    const [outHeight, outWidth] = outputShape != null ? outputShape : [imageHeight, imageWidth];
    const outShape = [batch, outHeight, outWidth,
        numChannels];
    const strides = new Uint8Array(new Int32Array(util.computeStrides(image.shape)).buffer);
    const out = backend.makeOutput(outShape, image.dtype);
    const outId = backend.dataIdMap.get(out.dataId).id;
    const imageData = backend.dataIdMap.get(image.dataId);
    const imageId = imageData.id;
    const transformsData = backend.dataIdMap.get(transforms.dataId);
    const transformsId = transformsData.id;
    const interpolationModeId = interpolation === 'nearest' ? 1 : 2;
    let fillModeId;
    switch (fillMode) {
        case 'constant':
            fillModeId = 1;
            break;
        case 'reflect':
            fillModeId = 2;
            break;
        case 'wrap':
            fillModeId = 3;
            break;
        case 'nearest':
            fillModeId = 4;
            break;
        default:
            fillModeId = 1;
            break;
    }
    wasmTransform(imageId, transformsId, (transforms.shape[0] > 1), batch, outHeight, outWidth, numChannels, imageWidth, imageHeight, strides, image.shape.length - 1, interpolationModeId, fillModeId, fillValue, outId);
    return out;
}
const transformConfig = {
    kernelName: Transform,
    backendName: 'wasm',
    setupFunc: setup$M,
    kernelFunc: transform
};

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
function unpack(args) {
    const { inputs, backend, attrs } = args;
    const { value } = inputs;
    let { axis } = attrs;
    if (axis < 0) {
        axis += value.shape.length;
    }
    const numOutputs = value.shape[axis];
    const rank = value.shape.length;
    const outShape = new Array(rank - 1);
    let outIndex = 0;
    for (let i = 0; i < rank; i++) {
        if (i !== axis) {
            outShape[outIndex++] = value.shape[i];
        }
    }
    const outs = new Array(numOutputs);
    const begin = new Array(rank).fill(0);
    const size = value.shape.slice();
    size[axis] = 1;
    for (let i = 0; i < outs.length; i++) {
        begin[axis] = i;
        outs[i] = slice({ inputs: { x: value }, attrs: { begin, size }, backend });
    }
    return outs.map(({ dataId, dtype }) => ({ dataId, dtype, shape: outShape }));
}
const unpackConfig = {
    kernelName: Unpack,
    backendName: 'wasm',
    kernelFunc: unpack,
};

/**
 * @license
 * Copyright 2020 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
function zerosLike(args) {
    const { inputs: { x }, backend } = args;
    const out = backend.makeOutput(x.shape, x.dtype);
    const outVals = backend.typedArrayFromHeap(out);
    outVals.fill(0);
    return out;
}
const zerosLikeConfig = {
    kernelName: ZerosLike,
    backendName: 'wasm',
    kernelFunc: zerosLike,
};

/**
 * @license
 * Copyright 2020 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
// List all kernel configs here
const kernelConfigs = [
    _fusedMatMulConfig,
    absConfig,
    addConfig,
    addNConfig,
    allConfig,
    anyConfig,
    argMaxConfig,
    avgPoolConfig,
    batchMatMulConfig,
    batchToSpaceNDConfig,
    castConfig,
    ceilConfig,
    clipByValueConfig,
    concatConfig,
    conv2DConfig,
    conv2DBackpropInputConfig,
    cosConfig,
    coshConfig,
    cropAndResizeConfig,
    cumprodConfig,
    cumsumConfig,
    depthToSpaceConfig,
    depthwiseConv2dNativeConfig,
    eluConfig,
    equalConfig,
    expConfig,
    expandDimsConfig,
    fillConfig,
    flipLeftRightConfig,
    floorConfig,
    floorDivConfig,
    fusedBatchNormConfig,
    fusedConv2DConfig,
    fusedDepthwiseConv2DConfig,
    gatherNdConfig,
    gatherV2Config,
    greaterConfig,
    greaterEqualConfig,
    identityConfig,
    leakyReluConfig,
    lessConfig,
    lessEqualConfig,
    logConfig,
    logicalAndConfig,
    maxConfig,
    maximumConfig,
    maxPoolConfig,
    meanConfig,
    minConfig,
    minimumConfig,
    mirrorPadConfig,
    multiplyConfig,
    negConfig,
    nonMaxSuppressionV3Config,
    nonMaxSuppressionV4Config,
    nonMaxSuppressionV5Config,
    notEqualConfig,
    oneHotConfig,
    onesLikeConfig,
    packConfig,
    padV2Config,
    powConfig,
    preluConfig,
    prodConfig,
    rangeConfig,
    realDivConfig,
    reluConfig,
    relu6Config,
    reshapeConfig,
    resizeBilinearConfig,
    reverseConfig,
    rotateWithOffsetConfig,
    roundConfig,
    rsqrtConfig,
    scatterNdConfig,
    selectConfig,
    sigmoidConfig,
    sinConfig,
    sliceConfig,
    softmaxConfig,
    spaceToBatchNDConfig,
    sparseFillEmptyRowsConfig,
    sparseReshapeConfig,
    sparseSegmentMeanConfig,
    sparseSegmentSumConfig,
    splitVConfig,
    sqrtConfig,
    squareConfig,
    squaredDifferenceConfig,
    stepConfig,
    stridedSliceConfig,
    subConfig,
    sumConfig,
    tanConfig,
    tanhConfig,
    tileConfig,
    topKConfig,
    transformConfig,
    transposeConfig,
    unpackConfig,
    zerosLikeConfig
];
for (const kernelConfig of kernelConfigs) {
    registerKernel(kernelConfig);
}

/**
 * @license
 * Copyright 2020 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
const ENV = env();
/**
 * True if SIMD is supported.
 */
// From: https://github.com/GoogleChromeLabs/wasm-feature-detect
ENV.registerFlag(
// This typed array passed in to WebAssembly.validate is WebAssembly binary
// code. In this case it is a small program that contains SIMD
// instructions.
'WASM_HAS_SIMD_SUPPORT', async () => WebAssembly.validate(new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3,
    2, 1, 0, 10, 9, 1, 7, 0, 65, 0, 253, 15, 26, 11
])));
/**
 * True if threads are supported.
 */
// From: https://github.com/GoogleChromeLabs/wasm-feature-detect
ENV.registerFlag('WASM_HAS_MULTITHREAD_SUPPORT', async () => {
    // TODO(annxingyuan): Enable node support once this is resolved:
    // https://github.com/tensorflow/tfjs/issues/3830
    if (ENV.get('IS_NODE')) {
        return false;
    }
    try {
        // Test for transferability of SABs (needed for Firefox)
        // https://groups.google.com/forum/#!msg/mozilla.dev.platform/IHkBZlHETpA/dwsMNchWEQAJ
        new MessageChannel().port1.postMessage(new SharedArrayBuffer(1));
        // This typed array is a WebAssembly program containing threaded
        // instructions.
        return WebAssembly.validate(new Uint8Array([
            0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5,
            4, 1, 3, 1, 1, 10, 11, 1, 9, 0, 65, 0, 254, 16, 2, 0, 26, 11
        ]));
    }
    catch (e) {
        return false;
    }
});

var commonjsGlobal = typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : typeof self !== 'undefined' ? self : {};

function createCommonjsModule(fn, module) {
	return module = { exports: {} }, fn(module, module.exports), module.exports;
}

var tfjsBackendWasmThreadedSimd = createCommonjsModule(function (module, exports) {
var WasmBackendModuleThreadedSimd = (() => {
  var _scriptDir = typeof document !== 'undefined' && document.currentScript ? document.currentScript.src : undefined;
  if (typeof __filename !== 'undefined') _scriptDir = _scriptDir || __filename;
  return (
function(WasmBackendModuleThreadedSimd) {
  WasmBackendModuleThreadedSimd = WasmBackendModuleThreadedSimd || {};

function GROWABLE_HEAP_I8(){if(wasmMemory.buffer!=buffer){updateGlobalBufferAndViews(wasmMemory.buffer);}return HEAP8}function GROWABLE_HEAP_U8(){if(wasmMemory.buffer!=buffer){updateGlobalBufferAndViews(wasmMemory.buffer);}return HEAPU8}function GROWABLE_HEAP_I32(){if(wasmMemory.buffer!=buffer){updateGlobalBufferAndViews(wasmMemory.buffer);}return HEAP32}function GROWABLE_HEAP_F64(){if(wasmMemory.buffer!=buffer){updateGlobalBufferAndViews(wasmMemory.buffer);}return HEAPF64}var Module=typeof WasmBackendModuleThreadedSimd!=="undefined"?WasmBackendModuleThreadedSimd:{};var readyPromiseResolve,readyPromiseReject;Module["ready"]=new Promise(function(resolve,reject){readyPromiseResolve=resolve;readyPromiseReject=reject;});var beforeListeners;if(typeof process!=="undefined"&&process.listeners){beforeListeners={uncaughtException:process.listeners("uncaughtException"),unhandledRejection:process.listeners("unhandledRejection")};}var moduleOverrides=Object.assign({},Module);var arguments_=[];var thisProgram="./this.program";var quit_=(status,toThrow)=>{throw toThrow};var ENVIRONMENT_IS_WEB=typeof window==="object";var ENVIRONMENT_IS_WORKER=typeof importScripts==="function";var ENVIRONMENT_IS_NODE=typeof process==="object"&&typeof process.versions==="object"&&typeof process.versions.node==="string";var ENVIRONMENT_IS_PTHREAD=Module["ENVIRONMENT_IS_PTHREAD"]||false;var scriptDirectory="";function locateFile(path){if(Module["locateFile"]){return Module["locateFile"](path,scriptDirectory)}return scriptDirectory+path}var read_,readAsync,readBinary;function logExceptionOnExit(e){if(e instanceof ExitStatus)return;let toLog=e;err("exiting due to exception: "+toLog);}var fs$1;var nodePath;var requireNodeFS;if(ENVIRONMENT_IS_NODE){if(ENVIRONMENT_IS_WORKER){scriptDirectory=path.dirname(scriptDirectory)+"/";}else {scriptDirectory=__dirname+"/";}requireNodeFS=(()=>{if(!nodePath){fs$1=fs;nodePath=path;}});read_=function shell_read(filename,binary){requireNodeFS();filename=nodePath["normalize"](filename);return fs$1.readFileSync(filename,binary?undefined:"utf8")};readBinary=(filename=>{var ret=read_(filename,true);if(!ret.buffer){ret=new Uint8Array(ret);}return ret});readAsync=((filename,onload,onerror)=>{requireNodeFS();filename=nodePath["normalize"](filename);fs$1.readFile(filename,function(err,data){if(err)onerror(err);else onload(data.buffer);});});if(process["argv"].length>1){thisProgram=process["argv"][1].replace(/\\/g,"/");}arguments_=process["argv"].slice(2);process["on"]("uncaughtException",function(ex){if(!(ex instanceof ExitStatus)){throw ex}});process["on"]("unhandledRejection",function(reason){throw reason});quit_=((status,toThrow)=>{if(keepRuntimeAlive()){process["exitCode"]=status;throw toThrow}logExceptionOnExit(toThrow);process["exit"](status);});Module["inspect"]=function(){return "[Emscripten Module object]"};let nodeWorkerThreads;try{nodeWorkerThreads=worker_threads;}catch(e){console.error('The "worker_threads" module is not supported in this node.js build - perhaps a newer version is needed?');throw e}commonjsGlobal.Worker=nodeWorkerThreads.Worker;}else if(ENVIRONMENT_IS_WEB||ENVIRONMENT_IS_WORKER){if(ENVIRONMENT_IS_WORKER){scriptDirectory=self.location.href;}else if(typeof document!=="undefined"&&document.currentScript){scriptDirectory=document.currentScript.src;}if(typeof _scriptDir !== "undefined" && _scriptDir){scriptDirectory=_scriptDir;}if(scriptDirectory.indexOf("blob:")!==0){scriptDirectory=scriptDirectory.substr(0,scriptDirectory.replace(/[?#].*/,"").lastIndexOf("/")+1);}else {scriptDirectory="";}if(!ENVIRONMENT_IS_NODE){read_=(url=>{var xhr=new XMLHttpRequest;xhr.open("GET",url,false);xhr.send(null);return xhr.responseText});if(ENVIRONMENT_IS_WORKER){readBinary=(url=>{var xhr=new XMLHttpRequest;xhr.open("GET",url,false);xhr.responseType="arraybuffer";xhr.send(null);return new Uint8Array(xhr.response)});}readAsync=((url,onload,onerror)=>{var xhr=new XMLHttpRequest;xhr.open("GET",url,true);xhr.responseType="arraybuffer";xhr.onload=(()=>{if(xhr.status==200||xhr.status==0&&xhr.response){onload(xhr.response);return}onerror();});xhr.onerror=onerror;xhr.send(null);});}}if(ENVIRONMENT_IS_NODE){if(typeof performance==="undefined"){commonjsGlobal.performance=perf_hooks.performance;}}var defaultPrint=console.log.bind(console);var defaultPrintErr=console.warn.bind(console);if(ENVIRONMENT_IS_NODE){requireNodeFS();defaultPrint=(str=>fs$1.writeSync(1,str+"\n"));defaultPrintErr=(str=>fs$1.writeSync(2,str+"\n"));}var out=Module["print"]||defaultPrint;var err=Module["printErr"]||defaultPrintErr;Object.assign(Module,moduleOverrides);moduleOverrides=null;if(Module["arguments"])arguments_=Module["arguments"];if(Module["thisProgram"])thisProgram=Module["thisProgram"];if(Module["quit"])quit_=Module["quit"];function warnOnce(text){if(!warnOnce.shown)warnOnce.shown={};if(!warnOnce.shown[text]){warnOnce.shown[text]=1;err(text);}}var wasmBinary;if(Module["wasmBinary"])wasmBinary=Module["wasmBinary"];var noExitRuntime=Module["noExitRuntime"]||true;if(typeof WebAssembly!=="object"){abort("no native wasm support detected");}var wasmMemory;var wasmModule;var ABORT=false;var EXITSTATUS;function getCFunc(ident){var func=Module["_"+ident];return func}function ccall(ident,returnType,argTypes,args,opts){var toC={"string":function(str){var ret=0;if(str!==null&&str!==undefined&&str!==0){var len=(str.length<<2)+1;ret=stackAlloc(len);stringToUTF8(str,ret,len);}return ret},"array":function(arr){var ret=stackAlloc(arr.length);writeArrayToMemory(arr,ret);return ret}};function convertReturnValue(ret){if(returnType==="string")return UTF8ToString(ret);if(returnType==="boolean")return Boolean(ret);return ret}var func=getCFunc(ident);var cArgs=[];var stack=0;if(args){for(var i=0;i<args.length;i++){var converter=toC[argTypes[i]];if(converter){if(stack===0)stack=stackSave();cArgs[i]=converter(args[i]);}else {cArgs[i]=args[i];}}}var ret=func.apply(null,cArgs);function onDone(ret){if(stack!==0)stackRestore(stack);return convertReturnValue(ret)}ret=onDone(ret);return ret}function cwrap(ident,returnType,argTypes,opts){argTypes=argTypes||[];var numericArgs=argTypes.every(function(type){return type==="number"});var numericRet=returnType!=="string";if(numericRet&&numericArgs&&!opts){return getCFunc(ident)}return function(){return ccall(ident,returnType,argTypes,arguments)}}function TextDecoderWrapper(encoding){var textDecoder=new TextDecoder(encoding);this.decode=(data=>{if(data.buffer instanceof SharedArrayBuffer){data=new Uint8Array(data);}return textDecoder.decode.call(textDecoder,data)});}var UTF8Decoder=typeof TextDecoder!=="undefined"?new TextDecoderWrapper("utf8"):undefined;function UTF8ArrayToString(heap,idx,maxBytesToRead){var endIdx=idx+maxBytesToRead;var endPtr=idx;while(heap[endPtr]&&!(endPtr>=endIdx))++endPtr;if(endPtr-idx>16&&heap.subarray&&UTF8Decoder){return UTF8Decoder.decode(heap.subarray(idx,endPtr))}else {var str="";while(idx<endPtr){var u0=heap[idx++];if(!(u0&128)){str+=String.fromCharCode(u0);continue}var u1=heap[idx++]&63;if((u0&224)==192){str+=String.fromCharCode((u0&31)<<6|u1);continue}var u2=heap[idx++]&63;if((u0&240)==224){u0=(u0&15)<<12|u1<<6|u2;}else {u0=(u0&7)<<18|u1<<12|u2<<6|heap[idx++]&63;}if(u0<65536){str+=String.fromCharCode(u0);}else {var ch=u0-65536;str+=String.fromCharCode(55296|ch>>10,56320|ch&1023);}}}return str}function UTF8ToString(ptr,maxBytesToRead){return ptr?UTF8ArrayToString(GROWABLE_HEAP_U8(),ptr,maxBytesToRead):""}function stringToUTF8Array(str,heap,outIdx,maxBytesToWrite){if(!(maxBytesToWrite>0))return 0;var startIdx=outIdx;var endIdx=outIdx+maxBytesToWrite-1;for(var i=0;i<str.length;++i){var u=str.charCodeAt(i);if(u>=55296&&u<=57343){var u1=str.charCodeAt(++i);u=65536+((u&1023)<<10)|u1&1023;}if(u<=127){if(outIdx>=endIdx)break;heap[outIdx++]=u;}else if(u<=2047){if(outIdx+1>=endIdx)break;heap[outIdx++]=192|u>>6;heap[outIdx++]=128|u&63;}else if(u<=65535){if(outIdx+2>=endIdx)break;heap[outIdx++]=224|u>>12;heap[outIdx++]=128|u>>6&63;heap[outIdx++]=128|u&63;}else {if(outIdx+3>=endIdx)break;heap[outIdx++]=240|u>>18;heap[outIdx++]=128|u>>12&63;heap[outIdx++]=128|u>>6&63;heap[outIdx++]=128|u&63;}}heap[outIdx]=0;return outIdx-startIdx}function stringToUTF8(str,outPtr,maxBytesToWrite){return stringToUTF8Array(str,GROWABLE_HEAP_U8(),outPtr,maxBytesToWrite)}function lengthBytesUTF8(str){var len=0;for(var i=0;i<str.length;++i){var u=str.charCodeAt(i);if(u>=55296&&u<=57343)u=65536+((u&1023)<<10)|str.charCodeAt(++i)&1023;if(u<=127)++len;else if(u<=2047)len+=2;else if(u<=65535)len+=3;else len+=4;}return len}var UTF16Decoder=typeof TextDecoder!=="undefined"?new TextDecoderWrapper("utf-16le"):undefined;function writeArrayToMemory(array,buffer){GROWABLE_HEAP_I8().set(array,buffer);}function alignUp(x,multiple){if(x%multiple>0){x+=multiple-x%multiple;}return x}var buffer,HEAP8,HEAPU8,HEAP16,HEAPU16,HEAP32,HEAPU32,HEAPF32,HEAPF64;if(ENVIRONMENT_IS_PTHREAD){buffer=Module["buffer"];}function updateGlobalBufferAndViews(buf){buffer=buf;Module["HEAP8"]=HEAP8=new Int8Array(buf);Module["HEAP16"]=HEAP16=new Int16Array(buf);Module["HEAP32"]=HEAP32=new Int32Array(buf);Module["HEAPU8"]=HEAPU8=new Uint8Array(buf);Module["HEAPU16"]=HEAPU16=new Uint16Array(buf);Module["HEAPU32"]=HEAPU32=new Uint32Array(buf);Module["HEAPF32"]=HEAPF32=new Float32Array(buf);Module["HEAPF64"]=HEAPF64=new Float64Array(buf);}var INITIAL_MEMORY=Module["INITIAL_MEMORY"]||16777216;if(ENVIRONMENT_IS_PTHREAD){wasmMemory=Module["wasmMemory"];buffer=Module["buffer"];}else {if(Module["wasmMemory"]){wasmMemory=Module["wasmMemory"];}else {wasmMemory=new WebAssembly.Memory({"initial":INITIAL_MEMORY/65536,"maximum":2147483648/65536,"shared":true});if(!(wasmMemory.buffer instanceof SharedArrayBuffer)){err("requested a shared WebAssembly.Memory but the returned buffer is not a SharedArrayBuffer, indicating that while the browser has SharedArrayBuffer it does not have WebAssembly threads support - you may need to set a flag");if(ENVIRONMENT_IS_NODE){console.log("(on node you may need: --experimental-wasm-threads --experimental-wasm-bulk-memory and also use a recent version)");}throw Error("bad memory")}}}if(wasmMemory){buffer=wasmMemory.buffer;}INITIAL_MEMORY=buffer.byteLength;updateGlobalBufferAndViews(buffer);var wasmTable;var __ATPRERUN__=[];var __ATINIT__=[];var __ATPOSTRUN__=[];var runtimeKeepaliveCounter=0;function keepRuntimeAlive(){return noExitRuntime||runtimeKeepaliveCounter>0}function preRun(){if(Module["preRun"]){if(typeof Module["preRun"]=="function")Module["preRun"]=[Module["preRun"]];while(Module["preRun"].length){addOnPreRun(Module["preRun"].shift());}}callRuntimeCallbacks(__ATPRERUN__);}function initRuntime(){if(ENVIRONMENT_IS_PTHREAD)return;callRuntimeCallbacks(__ATINIT__);}function exitRuntime(){if(ENVIRONMENT_IS_PTHREAD)return;PThread.terminateAllThreads();}function postRun(){if(ENVIRONMENT_IS_PTHREAD)return;if(Module["postRun"]){if(typeof Module["postRun"]=="function")Module["postRun"]=[Module["postRun"]];while(Module["postRun"].length){addOnPostRun(Module["postRun"].shift());}}callRuntimeCallbacks(__ATPOSTRUN__);}function addOnPreRun(cb){__ATPRERUN__.unshift(cb);}function addOnInit(cb){__ATINIT__.unshift(cb);}function addOnPostRun(cb){__ATPOSTRUN__.unshift(cb);}var runDependencies=0;var dependenciesFulfilled=null;function addRunDependency(id){runDependencies++;if(Module["monitorRunDependencies"]){Module["monitorRunDependencies"](runDependencies);}}function removeRunDependency(id){runDependencies--;if(Module["monitorRunDependencies"]){Module["monitorRunDependencies"](runDependencies);}if(runDependencies==0){if(dependenciesFulfilled){var callback=dependenciesFulfilled;dependenciesFulfilled=null;callback();}}}Module["preloadedImages"]={};Module["preloadedAudios"]={};function abort(what){if(ENVIRONMENT_IS_PTHREAD){postMessage({"cmd":"onAbort","arg":what});}else {if(Module["onAbort"]){Module["onAbort"](what);}}what="Aborted("+what+")";err(what);ABORT=true;EXITSTATUS=1;what+=". Build with -s ASSERTIONS=1 for more info.";var e=new WebAssembly.RuntimeError(what);readyPromiseReject(e);throw e}var dataURIPrefix="data:application/octet-stream;base64,";function isDataURI(filename){return filename.startsWith(dataURIPrefix)}function isFileURI(filename){return filename.startsWith("file://")}var wasmBinaryFile;wasmBinaryFile="tfjs-backend-wasm-threaded-simd.wasm";if(!isDataURI(wasmBinaryFile)){wasmBinaryFile=locateFile(wasmBinaryFile);}function getBinary(file){try{if(file==wasmBinaryFile&&wasmBinary){return new Uint8Array(wasmBinary)}if(readBinary){return readBinary(file)}else {throw "both async and sync fetching of the wasm failed"}}catch(err){abort(err);}}function getBinaryPromise(){if(!wasmBinary&&(ENVIRONMENT_IS_WEB||ENVIRONMENT_IS_WORKER)){if(typeof fetch==="function"&&!isFileURI(wasmBinaryFile)){return fetch(wasmBinaryFile,{credentials:"same-origin"}).then(function(response){if(!response["ok"]){throw "failed to load wasm binary file at '"+wasmBinaryFile+"'"}return response["arrayBuffer"]()}).catch(function(){return getBinary(wasmBinaryFile)})}else {if(readAsync){return new Promise(function(resolve,reject){readAsync(wasmBinaryFile,function(response){resolve(new Uint8Array(response));},reject);})}}}return Promise.resolve().then(function(){return getBinary(wasmBinaryFile)})}function createWasm(){var info={"env":asmLibraryArg,"wasi_snapshot_preview1":asmLibraryArg};function receiveInstance(instance,module){var exports=instance.exports;Module["asm"]=exports;registerTlsInit(Module["asm"]["emscripten_tls_init"]);wasmTable=Module["asm"]["__indirect_function_table"];addOnInit(Module["asm"]["__wasm_call_ctors"]);wasmModule=module;if(!ENVIRONMENT_IS_PTHREAD){var numWorkersToLoad=PThread.unusedWorkers.length;PThread.unusedWorkers.forEach(function(w){PThread.loadWasmModuleToWorker(w,function(){if(!--numWorkersToLoad)removeRunDependency();});});}}if(!ENVIRONMENT_IS_PTHREAD){addRunDependency();}function receiveInstantiationResult(result){receiveInstance(result["instance"],result["module"]);}function instantiateArrayBuffer(receiver){return getBinaryPromise().then(function(binary){return WebAssembly.instantiate(binary,info)}).then(function(instance){return instance}).then(receiver,function(reason){err("failed to asynchronously prepare wasm: "+reason);abort(reason);})}function instantiateAsync(){if(!wasmBinary&&typeof WebAssembly.instantiateStreaming==="function"&&!isDataURI(wasmBinaryFile)&&!isFileURI(wasmBinaryFile)&&typeof fetch==="function"){return fetch(wasmBinaryFile,{credentials:"same-origin"}).then(function(response){var result=WebAssembly.instantiateStreaming(response,info);return result.then(receiveInstantiationResult,function(reason){err("wasm streaming compile failed: "+reason);err("falling back to ArrayBuffer instantiation");return instantiateArrayBuffer(receiveInstantiationResult)})})}else {return instantiateArrayBuffer(receiveInstantiationResult)}}if(Module["instantiateWasm"]){try{var exports=Module["instantiateWasm"](info,receiveInstance);return exports}catch(e){err("Module.instantiateWasm callback failed with error: "+e);return false}}instantiateAsync().catch(readyPromiseReject);return {}}var ASM_CONSTS={};function callRuntimeCallbacks(callbacks){while(callbacks.length>0){var callback=callbacks.shift();if(typeof callback=="function"){callback(Module);continue}var func=callback.func;if(typeof func==="number"){if(callback.arg===undefined){getWasmTableEntry(func)();}else {getWasmTableEntry(func)(callback.arg);}}else {func(callback.arg===undefined?null:callback.arg);}}}function withStackSave(f){var stack=stackSave();var ret=f();stackRestore(stack);return ret}function killThread(pthread_ptr){GROWABLE_HEAP_I32()[pthread_ptr>>2]=0;var pthread=PThread.pthreads[pthread_ptr];delete PThread.pthreads[pthread_ptr];pthread.worker.terminate();__emscripten_thread_free_data(pthread_ptr);PThread.runningWorkers.splice(PThread.runningWorkers.indexOf(pthread.worker),1);pthread.worker.pthread=undefined;}function cancelThread(pthread_ptr){var pthread=PThread.pthreads[pthread_ptr];pthread.worker.postMessage({"cmd":"cancel"});}function cleanupThread(pthread_ptr){var pthread=PThread.pthreads[pthread_ptr];if(pthread){GROWABLE_HEAP_I32()[pthread_ptr>>2]=0;var worker=pthread.worker;PThread.returnWorkerToPool(worker);}}function _exit(status){exit(status);}function handleException(e){if(e instanceof ExitStatus||e=="unwind"){return EXITSTATUS}quit_(1,e);}var PThread={unusedWorkers:[],runningWorkers:[],tlsInitFunctions:[],init:function(){if(ENVIRONMENT_IS_PTHREAD){PThread.initWorker();}else {PThread.initMainThread();}},initMainThread:function(){var pthreadPoolSize=8;for(var i=0;i<pthreadPoolSize;++i){PThread.allocateUnusedWorker();}},initWorker:function(){noExitRuntime=false;},pthreads:{},setExitStatus:function(status){EXITSTATUS=status;},terminateAllThreads:function(){for(var t in PThread.pthreads){var pthread=PThread.pthreads[t];if(pthread&&pthread.worker){PThread.returnWorkerToPool(pthread.worker);}}for(var i=0;i<PThread.unusedWorkers.length;++i){var worker=PThread.unusedWorkers[i];worker.terminate();}PThread.unusedWorkers=[];},returnWorkerToPool:function(worker){PThread.runWithoutMainThreadQueuedCalls(function(){delete PThread.pthreads[worker.pthread.threadInfoStruct];PThread.unusedWorkers.push(worker);PThread.runningWorkers.splice(PThread.runningWorkers.indexOf(worker),1);__emscripten_thread_free_data(worker.pthread.threadInfoStruct);worker.pthread=undefined;});},runWithoutMainThreadQueuedCalls:function(func){GROWABLE_HEAP_I32()[__emscripten_allow_main_runtime_queued_calls>>2]=0;try{func();}finally{GROWABLE_HEAP_I32()[__emscripten_allow_main_runtime_queued_calls>>2]=1;}},receiveObjectTransfer:function(data){},threadInit:function(){for(var i in PThread.tlsInitFunctions){PThread.tlsInitFunctions[i]();}},loadWasmModuleToWorker:function(worker,onFinishedLoading){worker.onmessage=(e=>{var d=e["data"];var cmd=d["cmd"];if(worker.pthread)PThread.currentProxiedOperationCallerThread=worker.pthread.threadInfoStruct;if(d["targetThread"]&&d["targetThread"]!=_pthread_self()){var thread=PThread.pthreads[d.targetThread];if(thread){thread.worker.postMessage(d,d["transferList"]);}else {err('Internal error! Worker sent a message "'+cmd+'" to target pthread '+d["targetThread"]+", but that thread no longer exists!");}PThread.currentProxiedOperationCallerThread=undefined;return}if(cmd==="processQueuedMainThreadWork"){_emscripten_main_thread_process_queued_calls();}else if(cmd==="spawnThread"){spawnThread(d);}else if(cmd==="cleanupThread"){cleanupThread(d["thread"]);}else if(cmd==="killThread"){killThread(d["thread"]);}else if(cmd==="cancelThread"){cancelThread(d["thread"]);}else if(cmd==="loaded"){worker.loaded=true;if(onFinishedLoading)onFinishedLoading(worker);if(worker.runPthread){worker.runPthread();delete worker.runPthread;}}else if(cmd==="print"){out("Thread "+d["threadId"]+": "+d["text"]);}else if(cmd==="printErr"){err("Thread "+d["threadId"]+": "+d["text"]);}else if(cmd==="alert"){alert("Thread "+d["threadId"]+": "+d["text"]);}else if(d.target==="setimmediate"){worker.postMessage(d);}else if(cmd==="onAbort"){if(Module["onAbort"]){Module["onAbort"](d["arg"]);}}else {err("worker sent an unknown command "+cmd);}PThread.currentProxiedOperationCallerThread=undefined;});worker.onerror=(e=>{var message="worker sent an error!";err(message+" "+e.filename+":"+e.lineno+": "+e.message);throw e});if(ENVIRONMENT_IS_NODE){worker.on("message",function(data){worker.onmessage({data:data});});worker.on("error",function(e){worker.onerror(e);});worker.on("detachedExit",function(){});}worker.postMessage({"cmd":"load","urlOrBlob":Module["mainScriptUrlOrBlob"]||_scriptDir,"wasmMemory":wasmMemory,"wasmModule":wasmModule});},allocateUnusedWorker:function(){var pthreadMainJs=locateFile("tfjs-backend-wasm-threaded-simd.worker.js");PThread.unusedWorkers.push(new Worker(pthreadMainJs));},getNewWorker:function(){if(PThread.unusedWorkers.length==0){PThread.allocateUnusedWorker();PThread.loadWasmModuleToWorker(PThread.unusedWorkers[0]);}return PThread.unusedWorkers.pop()}};function establishStackSpace(){var pthread_ptr=_pthread_self();var stackTop=GROWABLE_HEAP_I32()[pthread_ptr+44>>2];var stackSize=GROWABLE_HEAP_I32()[pthread_ptr+48>>2];var stackMax=stackTop-stackSize;_emscripten_stack_set_limits(stackTop,stackMax);stackRestore(stackTop);}Module["establishStackSpace"]=establishStackSpace;function exitOnMainThread(returnCode){if(ENVIRONMENT_IS_PTHREAD)return _emscripten_proxy_to_main_thread_js(1,0,returnCode);try{_exit(returnCode);}catch(e){handleException(e);}}var wasmTableMirror=[];function getWasmTableEntry(funcPtr){var func=wasmTableMirror[funcPtr];if(!func){if(funcPtr>=wasmTableMirror.length)wasmTableMirror.length=funcPtr+1;wasmTableMirror[funcPtr]=func=wasmTable.get(funcPtr);}return func}function invokeEntryPoint(ptr,arg){return getWasmTableEntry(ptr)(arg)}Module["invokeEntryPoint"]=invokeEntryPoint;function registerTlsInit(tlsInitFunc,moduleExports,metadata){PThread.tlsInitFunctions.push(tlsInitFunc);}var _emscripten_get_now;if(ENVIRONMENT_IS_NODE){_emscripten_get_now=(()=>{var t=process["hrtime"]();return t[0]*1e3+t[1]/1e6});}else if(ENVIRONMENT_IS_PTHREAD){_emscripten_get_now=(()=>performance.now()-Module["__performance_now_clock_drift"]);}else _emscripten_get_now=(()=>performance.now());var _emscripten_get_now_is_monotonic=true;function setErrNo(value){GROWABLE_HEAP_I32()[___errno_location()>>2]=value;return value}function _clock_gettime(clk_id,tp){var now;if(clk_id===0){now=Date.now();}else if((clk_id===1||clk_id===4)&&_emscripten_get_now_is_monotonic){now=_emscripten_get_now();}else {setErrNo(28);return -1}GROWABLE_HEAP_I32()[tp>>2]=now/1e3|0;GROWABLE_HEAP_I32()[tp+4>>2]=now%1e3*1e3*1e3|0;return 0}function ___clock_gettime(a0,a1){return _clock_gettime(a0,a1)}function ___emscripten_init_main_thread_js(tb){__emscripten_thread_init(tb,!ENVIRONMENT_IS_WORKER,1,!ENVIRONMENT_IS_WEB);PThread.threadInit();}function ___emscripten_thread_cleanup(thread){if(!ENVIRONMENT_IS_PTHREAD)cleanupThread(thread);else postMessage({"cmd":"cleanupThread","thread":thread});}function spawnThread(threadParams){var worker=PThread.getNewWorker();if(!worker){return 6}PThread.runningWorkers.push(worker);var pthread=PThread.pthreads[threadParams.pthread_ptr]={worker:worker,threadInfoStruct:threadParams.pthread_ptr};worker.pthread=pthread;var msg={"cmd":"run","start_routine":threadParams.startRoutine,"arg":threadParams.arg,"threadInfoStruct":threadParams.pthread_ptr};worker.runPthread=(()=>{msg.time=performance.now();worker.postMessage(msg,threadParams.transferList);});if(worker.loaded){worker.runPthread();delete worker.runPthread;}return 0}function ___pthread_create_js(pthread_ptr,attr,start_routine,arg){if(typeof SharedArrayBuffer==="undefined"){err("Current environment does not support SharedArrayBuffer, pthreads are not available!");return 6}var transferList=[];var error=0;if(ENVIRONMENT_IS_PTHREAD&&(transferList.length===0||error)){return _emscripten_sync_run_in_main_thread_4(687865856,pthread_ptr,attr,start_routine,arg)}var threadParams={startRoutine:start_routine,pthread_ptr:pthread_ptr,arg:arg,transferList:transferList};if(ENVIRONMENT_IS_PTHREAD){threadParams.cmd="spawnThread";postMessage(threadParams,transferList);return 0}return spawnThread(threadParams)}function __emscripten_default_pthread_stack_size(){return 2097152}function __emscripten_notify_thread_queue(targetThreadId,mainThreadId){if(targetThreadId==mainThreadId){postMessage({"cmd":"processQueuedMainThreadWork"});}else if(ENVIRONMENT_IS_PTHREAD){postMessage({"targetThread":targetThreadId,"cmd":"processThreadQueue"});}else {var pthread=PThread.pthreads[targetThreadId];var worker=pthread&&pthread.worker;if(!worker){return}worker.postMessage({"cmd":"processThreadQueue"});}return 1}function _abort(){abort("");}function _emscripten_check_blocking_allowed(){if(ENVIRONMENT_IS_NODE)return;if(ENVIRONMENT_IS_WORKER)return;warnOnce("Blocking on the main thread is very dangerous, see https://emscripten.org/docs/porting/pthreads.html#blocking-on-the-main-browser-thread");}function _emscripten_get_heap_max(){return 2147483648}function _emscripten_memcpy_big(dest,src,num){GROWABLE_HEAP_U8().copyWithin(dest,src,src+num);}function _emscripten_num_logical_cores(){if(ENVIRONMENT_IS_NODE)return os.cpus().length;return navigator["hardwareConcurrency"]}function _emscripten_proxy_to_main_thread_js(index,sync){var numCallArgs=arguments.length-2;var outerArgs=arguments;return withStackSave(function(){var serializedNumCallArgs=numCallArgs;var args=stackAlloc(serializedNumCallArgs*8);var b=args>>3;for(var i=0;i<numCallArgs;i++){var arg=outerArgs[2+i];GROWABLE_HEAP_F64()[b+i]=arg;}return _emscripten_run_in_main_runtime_thread_js(index,serializedNumCallArgs,args,sync)})}var _emscripten_receive_on_main_thread_js_callArgs=[];function _emscripten_receive_on_main_thread_js(index,numCallArgs,args){_emscripten_receive_on_main_thread_js_callArgs.length=numCallArgs;var b=args>>3;for(var i=0;i<numCallArgs;i++){_emscripten_receive_on_main_thread_js_callArgs[i]=GROWABLE_HEAP_F64()[b+i];}var isEmAsmConst=index<0;var func=!isEmAsmConst?proxiedFunctionTable[index]:ASM_CONSTS[-index-1];return func.apply(null,_emscripten_receive_on_main_thread_js_callArgs)}function emscripten_realloc_buffer(size){try{wasmMemory.grow(size-buffer.byteLength+65535>>>16);updateGlobalBufferAndViews(wasmMemory.buffer);return 1}catch(e){}}function _emscripten_resize_heap(requestedSize){var oldSize=GROWABLE_HEAP_U8().length;requestedSize=requestedSize>>>0;if(requestedSize<=oldSize){return false}var maxHeapSize=_emscripten_get_heap_max();if(requestedSize>maxHeapSize){return false}for(var cutDown=1;cutDown<=4;cutDown*=2){var overGrownHeapSize=oldSize*(1+.2/cutDown);overGrownHeapSize=Math.min(overGrownHeapSize,requestedSize+100663296);var newSize=Math.min(maxHeapSize,alignUp(Math.max(requestedSize,overGrownHeapSize),65536));var replacement=emscripten_realloc_buffer(newSize);if(replacement){return true}}return false}var JSEvents={inEventHandler:0,removeAllEventListeners:function(){for(var i=JSEvents.eventHandlers.length-1;i>=0;--i){JSEvents._removeHandler(i);}JSEvents.eventHandlers=[];JSEvents.deferredCalls=[];},registerRemoveEventListeners:function(){if(!JSEvents.removeEventListenersRegistered){JSEvents.removeEventListenersRegistered=true;}},deferredCalls:[],deferCall:function(targetFunction,precedence,argsList){function arraysHaveEqualContent(arrA,arrB){if(arrA.length!=arrB.length)return false;for(var i in arrA){if(arrA[i]!=arrB[i])return false}return true}for(var i in JSEvents.deferredCalls){var call=JSEvents.deferredCalls[i];if(call.targetFunction==targetFunction&&arraysHaveEqualContent(call.argsList,argsList)){return}}JSEvents.deferredCalls.push({targetFunction:targetFunction,precedence:precedence,argsList:argsList});JSEvents.deferredCalls.sort(function(x,y){return x.precedence<y.precedence});},removeDeferredCalls:function(targetFunction){for(var i=0;i<JSEvents.deferredCalls.length;++i){if(JSEvents.deferredCalls[i].targetFunction==targetFunction){JSEvents.deferredCalls.splice(i,1);--i;}}},canPerformEventHandlerRequests:function(){return JSEvents.inEventHandler&&JSEvents.currentEventHandler.allowsDeferredCalls},runDeferredCalls:function(){if(!JSEvents.canPerformEventHandlerRequests()){return}for(var i=0;i<JSEvents.deferredCalls.length;++i){var call=JSEvents.deferredCalls[i];JSEvents.deferredCalls.splice(i,1);--i;call.targetFunction.apply(null,call.argsList);}},eventHandlers:[],removeAllHandlersOnTarget:function(target,eventTypeString){for(var i=0;i<JSEvents.eventHandlers.length;++i){if(JSEvents.eventHandlers[i].target==target&&(!eventTypeString||eventTypeString==JSEvents.eventHandlers[i].eventTypeString)){JSEvents._removeHandler(i--);}}},_removeHandler:function(i){var h=JSEvents.eventHandlers[i];h.target.removeEventListener(h.eventTypeString,h.eventListenerFunc,h.useCapture);JSEvents.eventHandlers.splice(i,1);},registerOrRemoveHandler:function(eventHandler){var jsEventHandler=function jsEventHandler(event){++JSEvents.inEventHandler;JSEvents.currentEventHandler=eventHandler;JSEvents.runDeferredCalls();eventHandler.handlerFunc(event);JSEvents.runDeferredCalls();--JSEvents.inEventHandler;};if(eventHandler.callbackfunc){eventHandler.eventListenerFunc=jsEventHandler;eventHandler.target.addEventListener(eventHandler.eventTypeString,jsEventHandler,eventHandler.useCapture);JSEvents.eventHandlers.push(eventHandler);JSEvents.registerRemoveEventListeners();}else {for(var i=0;i<JSEvents.eventHandlers.length;++i){if(JSEvents.eventHandlers[i].target==eventHandler.target&&JSEvents.eventHandlers[i].eventTypeString==eventHandler.eventTypeString){JSEvents._removeHandler(i--);}}}},queueEventHandlerOnThread_iiii:function(targetThread,eventHandlerFunc,eventTypeId,eventData,userData){withStackSave(function(){var varargs=stackAlloc(12);GROWABLE_HEAP_I32()[varargs>>2]=eventTypeId;GROWABLE_HEAP_I32()[varargs+4>>2]=eventData;GROWABLE_HEAP_I32()[varargs+8>>2]=userData;_emscripten_dispatch_to_thread_(targetThread,637534208,eventHandlerFunc,eventData,varargs);});},getTargetThreadForEventCallback:function(targetThread){switch(targetThread){case 1:return 0;case 2:return PThread.currentProxiedOperationCallerThread;default:return targetThread}},getNodeNameForTarget:function(target){if(!target)return "";if(target==window)return "#window";if(target==screen)return "#screen";return target&&target.nodeName?target.nodeName:""},fullscreenEnabled:function(){return document.fullscreenEnabled||document.webkitFullscreenEnabled}};function stringToNewUTF8(jsString){var length=lengthBytesUTF8(jsString)+1;var cString=_malloc(length);stringToUTF8(jsString,cString,length);return cString}function _emscripten_set_offscreencanvas_size_on_target_thread_js(targetThread,targetCanvas,width,height){withStackSave(function(){var varargs=stackAlloc(12);var targetCanvasPtr=0;if(targetCanvas){targetCanvasPtr=stringToNewUTF8(targetCanvas);}GROWABLE_HEAP_I32()[varargs>>2]=targetCanvasPtr;GROWABLE_HEAP_I32()[varargs+4>>2]=width;GROWABLE_HEAP_I32()[varargs+8>>2]=height;_emscripten_dispatch_to_thread_(targetThread,657457152,0,targetCanvasPtr,varargs);});}function _emscripten_set_offscreencanvas_size_on_target_thread(targetThread,targetCanvas,width,height){targetCanvas=targetCanvas?UTF8ToString(targetCanvas):"";_emscripten_set_offscreencanvas_size_on_target_thread_js(targetThread,targetCanvas,width,height);}function maybeCStringToJsString(cString){return cString>2?UTF8ToString(cString):cString}var specialHTMLTargets=[0,typeof document!=="undefined"?document:0,typeof window!=="undefined"?window:0];function findEventTarget(target){target=maybeCStringToJsString(target);var domElement=specialHTMLTargets[target]||(typeof document!=="undefined"?document.querySelector(target):undefined);return domElement}function findCanvasEventTarget(target){return findEventTarget(target)}function _emscripten_set_canvas_element_size_calling_thread(target,width,height){var canvas=findCanvasEventTarget(target);if(!canvas)return -4;if(canvas.canvasSharedPtr){GROWABLE_HEAP_I32()[canvas.canvasSharedPtr>>2]=width;GROWABLE_HEAP_I32()[canvas.canvasSharedPtr+4>>2]=height;}if(canvas.offscreenCanvas||!canvas.controlTransferredOffscreen){if(canvas.offscreenCanvas)canvas=canvas.offscreenCanvas;var autoResizeViewport=false;if(canvas.GLctxObject&&canvas.GLctxObject.GLctx){var prevViewport=canvas.GLctxObject.GLctx.getParameter(2978);autoResizeViewport=prevViewport[0]===0&&prevViewport[1]===0&&prevViewport[2]===canvas.width&&prevViewport[3]===canvas.height;}canvas.width=width;canvas.height=height;if(autoResizeViewport){canvas.GLctxObject.GLctx.viewport(0,0,width,height);}}else if(canvas.canvasSharedPtr){var targetThread=GROWABLE_HEAP_I32()[canvas.canvasSharedPtr+8>>2];_emscripten_set_offscreencanvas_size_on_target_thread(targetThread,target,width,height);return 1}else {return -4}return 0}function _emscripten_set_canvas_element_size_main_thread(target,width,height){if(ENVIRONMENT_IS_PTHREAD)return _emscripten_proxy_to_main_thread_js(2,1,target,width,height);return _emscripten_set_canvas_element_size_calling_thread(target,width,height)}function _emscripten_set_canvas_element_size(target,width,height){var canvas=findCanvasEventTarget(target);if(canvas){return _emscripten_set_canvas_element_size_calling_thread(target,width,height)}else {return _emscripten_set_canvas_element_size_main_thread(target,width,height)}}function _emscripten_unwind_to_js_event_loop(){throw "unwind"}function __webgl_enable_ANGLE_instanced_arrays(ctx){var ext=ctx.getExtension("ANGLE_instanced_arrays");if(ext){ctx["vertexAttribDivisor"]=function(index,divisor){ext["vertexAttribDivisorANGLE"](index,divisor);};ctx["drawArraysInstanced"]=function(mode,first,count,primcount){ext["drawArraysInstancedANGLE"](mode,first,count,primcount);};ctx["drawElementsInstanced"]=function(mode,count,type,indices,primcount){ext["drawElementsInstancedANGLE"](mode,count,type,indices,primcount);};return 1}}function __webgl_enable_OES_vertex_array_object(ctx){var ext=ctx.getExtension("OES_vertex_array_object");if(ext){ctx["createVertexArray"]=function(){return ext["createVertexArrayOES"]()};ctx["deleteVertexArray"]=function(vao){ext["deleteVertexArrayOES"](vao);};ctx["bindVertexArray"]=function(vao){ext["bindVertexArrayOES"](vao);};ctx["isVertexArray"]=function(vao){return ext["isVertexArrayOES"](vao)};return 1}}function __webgl_enable_WEBGL_draw_buffers(ctx){var ext=ctx.getExtension("WEBGL_draw_buffers");if(ext){ctx["drawBuffers"]=function(n,bufs){ext["drawBuffersWEBGL"](n,bufs);};return 1}}function __webgl_enable_WEBGL_multi_draw(ctx){return !!(ctx.multiDrawWebgl=ctx.getExtension("WEBGL_multi_draw"))}var GL={counter:1,buffers:[],programs:[],framebuffers:[],renderbuffers:[],textures:[],shaders:[],vaos:[],contexts:{},offscreenCanvases:{},queries:[],stringCache:{},unpackAlignment:4,recordError:function recordError(errorCode){if(!GL.lastError){GL.lastError=errorCode;}},getNewId:function(table){var ret=GL.counter++;for(var i=table.length;i<ret;i++){table[i]=null;}return ret},getSource:function(shader,count,string,length){var source="";for(var i=0;i<count;++i){var len=length?GROWABLE_HEAP_I32()[length+i*4>>2]:-1;source+=UTF8ToString(GROWABLE_HEAP_I32()[string+i*4>>2],len<0?undefined:len);}return source},createContext:function(canvas,webGLContextAttributes){if(!canvas.getContextSafariWebGL2Fixed){canvas.getContextSafariWebGL2Fixed=canvas.getContext;canvas.getContext=function(ver,attrs){var gl=canvas.getContextSafariWebGL2Fixed(ver,attrs);return ver=="webgl"==gl instanceof WebGLRenderingContext?gl:null};}var ctx=canvas.getContext("webgl",webGLContextAttributes);if(!ctx)return 0;var handle=GL.registerContext(ctx,webGLContextAttributes);return handle},registerContext:function(ctx,webGLContextAttributes){var handle=_malloc(8);GROWABLE_HEAP_I32()[handle+4>>2]=_pthread_self();var context={handle:handle,attributes:webGLContextAttributes,version:webGLContextAttributes.majorVersion,GLctx:ctx};if(ctx.canvas)ctx.canvas.GLctxObject=context;GL.contexts[handle]=context;if(typeof webGLContextAttributes.enableExtensionsByDefault==="undefined"||webGLContextAttributes.enableExtensionsByDefault){GL.initExtensions(context);}return handle},makeContextCurrent:function(contextHandle){GL.currentContext=GL.contexts[contextHandle];Module.ctx=GLctx=GL.currentContext&&GL.currentContext.GLctx;return !(contextHandle&&!GLctx)},getContext:function(contextHandle){return GL.contexts[contextHandle]},deleteContext:function(contextHandle){if(GL.currentContext===GL.contexts[contextHandle])GL.currentContext=null;if(typeof JSEvents==="object")JSEvents.removeAllHandlersOnTarget(GL.contexts[contextHandle].GLctx.canvas);if(GL.contexts[contextHandle]&&GL.contexts[contextHandle].GLctx.canvas)GL.contexts[contextHandle].GLctx.canvas.GLctxObject=undefined;_free(GL.contexts[contextHandle].handle);GL.contexts[contextHandle]=null;},initExtensions:function(context){if(!context)context=GL.currentContext;if(context.initExtensionsDone)return;context.initExtensionsDone=true;var GLctx=context.GLctx;__webgl_enable_ANGLE_instanced_arrays(GLctx);__webgl_enable_OES_vertex_array_object(GLctx);__webgl_enable_WEBGL_draw_buffers(GLctx);{GLctx.disjointTimerQueryExt=GLctx.getExtension("EXT_disjoint_timer_query");}__webgl_enable_WEBGL_multi_draw(GLctx);var exts=GLctx.getSupportedExtensions()||[];exts.forEach(function(ext){if(!ext.includes("lose_context")&&!ext.includes("debug")){GLctx.getExtension(ext);}});}};var __emscripten_webgl_power_preferences=["default","low-power","high-performance"];function _emscripten_webgl_do_create_context(target,attributes){var a=attributes>>2;var powerPreference=GROWABLE_HEAP_I32()[a+(24>>2)];var contextAttributes={"alpha":!!GROWABLE_HEAP_I32()[a+(0>>2)],"depth":!!GROWABLE_HEAP_I32()[a+(4>>2)],"stencil":!!GROWABLE_HEAP_I32()[a+(8>>2)],"antialias":!!GROWABLE_HEAP_I32()[a+(12>>2)],"premultipliedAlpha":!!GROWABLE_HEAP_I32()[a+(16>>2)],"preserveDrawingBuffer":!!GROWABLE_HEAP_I32()[a+(20>>2)],"powerPreference":__emscripten_webgl_power_preferences[powerPreference],"failIfMajorPerformanceCaveat":!!GROWABLE_HEAP_I32()[a+(28>>2)],majorVersion:GROWABLE_HEAP_I32()[a+(32>>2)],minorVersion:GROWABLE_HEAP_I32()[a+(36>>2)],enableExtensionsByDefault:GROWABLE_HEAP_I32()[a+(40>>2)],explicitSwapControl:GROWABLE_HEAP_I32()[a+(44>>2)],proxyContextToMainThread:GROWABLE_HEAP_I32()[a+(48>>2)],renderViaOffscreenBackBuffer:GROWABLE_HEAP_I32()[a+(52>>2)]};var canvas=findCanvasEventTarget(target);if(!canvas){return 0}if(contextAttributes.explicitSwapControl){return 0}var contextHandle=GL.createContext(canvas,contextAttributes);return contextHandle}function _emscripten_webgl_create_context(a0,a1){return _emscripten_webgl_do_create_context(a0,a1)}var SYSCALLS={mappings:{},buffers:[null,[],[]],printChar:function(stream,curr){var buffer=SYSCALLS.buffers[stream];if(curr===0||curr===10){(stream===1?out:err)(UTF8ArrayToString(buffer,0));buffer.length=0;}else {buffer.push(curr);}},varargs:undefined,get:function(){SYSCALLS.varargs+=4;var ret=GROWABLE_HEAP_I32()[SYSCALLS.varargs-4>>2];return ret},getStr:function(ptr){var ret=UTF8ToString(ptr);return ret},get64:function(low,high){return low}};function _fd_close(fd){if(ENVIRONMENT_IS_PTHREAD)return _emscripten_proxy_to_main_thread_js(3,1,fd);return 0}function _fd_seek(fd,offset_low,offset_high,whence,newOffset){if(ENVIRONMENT_IS_PTHREAD)return _emscripten_proxy_to_main_thread_js(4,1,fd,offset_low,offset_high,whence,newOffset)}function _fd_write(fd,iov,iovcnt,pnum){if(ENVIRONMENT_IS_PTHREAD)return _emscripten_proxy_to_main_thread_js(5,1,fd,iov,iovcnt,pnum);var num=0;for(var i=0;i<iovcnt;i++){var ptr=GROWABLE_HEAP_I32()[iov>>2];var len=GROWABLE_HEAP_I32()[iov+4>>2];iov+=8;for(var j=0;j<len;j++){SYSCALLS.printChar(fd,GROWABLE_HEAP_U8()[ptr+j]);}num+=len;}GROWABLE_HEAP_I32()[pnum>>2]=num;return 0}function _setTempRet0(val){}PThread.init();var GLctx;var proxiedFunctionTable=[null,exitOnMainThread,_emscripten_set_canvas_element_size_main_thread,_fd_close,_fd_seek,_fd_write];var asmLibraryArg={"__clock_gettime":___clock_gettime,"__emscripten_init_main_thread_js":___emscripten_init_main_thread_js,"__emscripten_thread_cleanup":___emscripten_thread_cleanup,"__pthread_create_js":___pthread_create_js,"_emscripten_default_pthread_stack_size":__emscripten_default_pthread_stack_size,"_emscripten_notify_thread_queue":__emscripten_notify_thread_queue,"abort":_abort,"emscripten_check_blocking_allowed":_emscripten_check_blocking_allowed,"emscripten_get_heap_max":_emscripten_get_heap_max,"emscripten_get_now":_emscripten_get_now,"emscripten_memcpy_big":_emscripten_memcpy_big,"emscripten_num_logical_cores":_emscripten_num_logical_cores,"emscripten_receive_on_main_thread_js":_emscripten_receive_on_main_thread_js,"emscripten_resize_heap":_emscripten_resize_heap,"emscripten_set_canvas_element_size":_emscripten_set_canvas_element_size,"emscripten_unwind_to_js_event_loop":_emscripten_unwind_to_js_event_loop,"emscripten_webgl_create_context":_emscripten_webgl_create_context,"exit":_exit,"fd_close":_fd_close,"fd_seek":_fd_seek,"fd_write":_fd_write,"memory":wasmMemory||Module["wasmMemory"],"setTempRet0":_setTempRet0};var asm=createWasm();var ___wasm_call_ctors=Module["___wasm_call_ctors"]=function(){return (___wasm_call_ctors=Module["___wasm_call_ctors"]=Module["asm"]["__wasm_call_ctors"]).apply(null,arguments)};var _init=Module["_init"]=function(){return (_init=Module["_init"]=Module["asm"]["init"]).apply(null,arguments)};var _init_with_threads_count=Module["_init_with_threads_count"]=function(){return (_init_with_threads_count=Module["_init_with_threads_count"]=Module["asm"]["init_with_threads_count"]).apply(null,arguments)};var _get_threads_count=Module["_get_threads_count"]=function(){return (_get_threads_count=Module["_get_threads_count"]=Module["asm"]["get_threads_count"]).apply(null,arguments)};var _register_tensor=Module["_register_tensor"]=function(){return (_register_tensor=Module["_register_tensor"]=Module["asm"]["register_tensor"]).apply(null,arguments)};var _dispose_data=Module["_dispose_data"]=function(){return (_dispose_data=Module["_dispose_data"]=Module["asm"]["dispose_data"]).apply(null,arguments)};var _dispose=Module["_dispose"]=function(){return (_dispose=Module["_dispose"]=Module["asm"]["dispose"]).apply(null,arguments)};var _Abs=Module["_Abs"]=function(){return (_Abs=Module["_Abs"]=Module["asm"]["Abs"]).apply(null,arguments)};var _Add=Module["_Add"]=function(){return (_Add=Module["_Add"]=Module["asm"]["Add"]).apply(null,arguments)};var _AddN=Module["_AddN"]=function(){return (_AddN=Module["_AddN"]=Module["asm"]["AddN"]).apply(null,arguments)};var _All=Module["_All"]=function(){return (_All=Module["_All"]=Module["asm"]["All"]).apply(null,arguments)};var _Any=Module["_Any"]=function(){return (_Any=Module["_Any"]=Module["asm"]["Any"]).apply(null,arguments)};var _ArgMax=Module["_ArgMax"]=function(){return (_ArgMax=Module["_ArgMax"]=Module["asm"]["ArgMax"]).apply(null,arguments)};var _AvgPool=Module["_AvgPool"]=function(){return (_AvgPool=Module["_AvgPool"]=Module["asm"]["AvgPool"]).apply(null,arguments)};var _BatchMatMul=Module["_BatchMatMul"]=function(){return (_BatchMatMul=Module["_BatchMatMul"]=Module["asm"]["BatchMatMul"]).apply(null,arguments)};var _Ceil=Module["_Ceil"]=function(){return (_Ceil=Module["_Ceil"]=Module["asm"]["Ceil"]).apply(null,arguments)};var _ClipByValue=Module["_ClipByValue"]=function(){return (_ClipByValue=Module["_ClipByValue"]=Module["asm"]["ClipByValue"]).apply(null,arguments)};var _Conv2D=Module["_Conv2D"]=function(){return (_Conv2D=Module["_Conv2D"]=Module["asm"]["Conv2D"]).apply(null,arguments)};var _Conv2DBackpropInput=Module["_Conv2DBackpropInput"]=function(){return (_Conv2DBackpropInput=Module["_Conv2DBackpropInput"]=Module["asm"]["Conv2DBackpropInput"]).apply(null,arguments)};var _Cos=Module["_Cos"]=function(){return (_Cos=Module["_Cos"]=Module["asm"]["Cos"]).apply(null,arguments)};var _Cosh=Module["_Cosh"]=function(){return (_Cosh=Module["_Cosh"]=Module["asm"]["Cosh"]).apply(null,arguments)};var _CropAndResize=Module["_CropAndResize"]=function(){return (_CropAndResize=Module["_CropAndResize"]=Module["asm"]["CropAndResize"]).apply(null,arguments)};var _Cumprod=Module["_Cumprod"]=function(){return (_Cumprod=Module["_Cumprod"]=Module["asm"]["Cumprod"]).apply(null,arguments)};var _Cumsum=Module["_Cumsum"]=function(){return (_Cumsum=Module["_Cumsum"]=Module["asm"]["Cumsum"]).apply(null,arguments)};var _DepthToSpace=Module["_DepthToSpace"]=function(){return (_DepthToSpace=Module["_DepthToSpace"]=Module["asm"]["DepthToSpace"]).apply(null,arguments)};var _DepthwiseConv2dNative=Module["_DepthwiseConv2dNative"]=function(){return (_DepthwiseConv2dNative=Module["_DepthwiseConv2dNative"]=Module["asm"]["DepthwiseConv2dNative"]).apply(null,arguments)};var _Elu=Module["_Elu"]=function(){return (_Elu=Module["_Elu"]=Module["asm"]["Elu"]).apply(null,arguments)};var _Equal=Module["_Equal"]=function(){return (_Equal=Module["_Equal"]=Module["asm"]["Equal"]).apply(null,arguments)};var _Exp=Module["_Exp"]=function(){return (_Exp=Module["_Exp"]=Module["asm"]["Exp"]).apply(null,arguments)};var _FlipLeftRight=Module["_FlipLeftRight"]=function(){return (_FlipLeftRight=Module["_FlipLeftRight"]=Module["asm"]["FlipLeftRight"]).apply(null,arguments)};var _Floor=Module["_Floor"]=function(){return (_Floor=Module["_Floor"]=Module["asm"]["Floor"]).apply(null,arguments)};var _FloorDiv=Module["_FloorDiv"]=function(){return (_FloorDiv=Module["_FloorDiv"]=Module["asm"]["FloorDiv"]).apply(null,arguments)};var _FusedBatchNorm=Module["_FusedBatchNorm"]=function(){return (_FusedBatchNorm=Module["_FusedBatchNorm"]=Module["asm"]["FusedBatchNorm"]).apply(null,arguments)};var _FusedConv2D=Module["_FusedConv2D"]=function(){return (_FusedConv2D=Module["_FusedConv2D"]=Module["asm"]["FusedConv2D"]).apply(null,arguments)};var _FusedDepthwiseConv2D=Module["_FusedDepthwiseConv2D"]=function(){return (_FusedDepthwiseConv2D=Module["_FusedDepthwiseConv2D"]=Module["asm"]["FusedDepthwiseConv2D"]).apply(null,arguments)};var _Gather=Module["_Gather"]=function(){return (_Gather=Module["_Gather"]=Module["asm"]["Gather"]).apply(null,arguments)};var _GatherNd=Module["_GatherNd"]=function(){return (_GatherNd=Module["_GatherNd"]=Module["asm"]["GatherNd"]).apply(null,arguments)};var _Greater=Module["_Greater"]=function(){return (_Greater=Module["_Greater"]=Module["asm"]["Greater"]).apply(null,arguments)};var _GreaterEqual=Module["_GreaterEqual"]=function(){return (_GreaterEqual=Module["_GreaterEqual"]=Module["asm"]["GreaterEqual"]).apply(null,arguments)};var _LeakyRelu=Module["_LeakyRelu"]=function(){return (_LeakyRelu=Module["_LeakyRelu"]=Module["asm"]["LeakyRelu"]).apply(null,arguments)};var _Less=Module["_Less"]=function(){return (_Less=Module["_Less"]=Module["asm"]["Less"]).apply(null,arguments)};var _LessEqual=Module["_LessEqual"]=function(){return (_LessEqual=Module["_LessEqual"]=Module["asm"]["LessEqual"]).apply(null,arguments)};var _Log=Module["_Log"]=function(){return (_Log=Module["_Log"]=Module["asm"]["Log"]).apply(null,arguments)};var _LogicalAnd=Module["_LogicalAnd"]=function(){return (_LogicalAnd=Module["_LogicalAnd"]=Module["asm"]["LogicalAnd"]).apply(null,arguments)};var _Max=Module["_Max"]=function(){return (_Max=Module["_Max"]=Module["asm"]["Max"]).apply(null,arguments)};var _MaxPool=Module["_MaxPool"]=function(){return (_MaxPool=Module["_MaxPool"]=Module["asm"]["MaxPool"]).apply(null,arguments)};var _Maximum=Module["_Maximum"]=function(){return (_Maximum=Module["_Maximum"]=Module["asm"]["Maximum"]).apply(null,arguments)};var _Mean=Module["_Mean"]=function(){return (_Mean=Module["_Mean"]=Module["asm"]["Mean"]).apply(null,arguments)};var _Min=Module["_Min"]=function(){return (_Min=Module["_Min"]=Module["asm"]["Min"]).apply(null,arguments)};var _Minimum=Module["_Minimum"]=function(){return (_Minimum=Module["_Minimum"]=Module["asm"]["Minimum"]).apply(null,arguments)};var _MirrorPad=Module["_MirrorPad"]=function(){return (_MirrorPad=Module["_MirrorPad"]=Module["asm"]["MirrorPad"]).apply(null,arguments)};var _Multiply=Module["_Multiply"]=function(){return (_Multiply=Module["_Multiply"]=Module["asm"]["Multiply"]).apply(null,arguments)};var _Neg=Module["_Neg"]=function(){return (_Neg=Module["_Neg"]=Module["asm"]["Neg"]).apply(null,arguments)};var _NonMaxSuppressionV3=Module["_NonMaxSuppressionV3"]=function(){return (_NonMaxSuppressionV3=Module["_NonMaxSuppressionV3"]=Module["asm"]["NonMaxSuppressionV3"]).apply(null,arguments)};var _NonMaxSuppressionV4=Module["_NonMaxSuppressionV4"]=function(){return (_NonMaxSuppressionV4=Module["_NonMaxSuppressionV4"]=Module["asm"]["NonMaxSuppressionV4"]).apply(null,arguments)};var _NonMaxSuppressionV5=Module["_NonMaxSuppressionV5"]=function(){return (_NonMaxSuppressionV5=Module["_NonMaxSuppressionV5"]=Module["asm"]["NonMaxSuppressionV5"]).apply(null,arguments)};var _NotEqual=Module["_NotEqual"]=function(){return (_NotEqual=Module["_NotEqual"]=Module["asm"]["NotEqual"]).apply(null,arguments)};var _OneHot=Module["_OneHot"]=function(){return (_OneHot=Module["_OneHot"]=Module["asm"]["OneHot"]).apply(null,arguments)};var _PadV2=Module["_PadV2"]=function(){return (_PadV2=Module["_PadV2"]=Module["asm"]["PadV2"]).apply(null,arguments)};var _Pow=Module["_Pow"]=function(){return (_Pow=Module["_Pow"]=Module["asm"]["Pow"]).apply(null,arguments)};var _Prelu=Module["_Prelu"]=function(){return (_Prelu=Module["_Prelu"]=Module["asm"]["Prelu"]).apply(null,arguments)};var _Prod=Module["_Prod"]=function(){return (_Prod=Module["_Prod"]=Module["asm"]["Prod"]).apply(null,arguments)};var _RealDiv=Module["_RealDiv"]=function(){return (_RealDiv=Module["_RealDiv"]=Module["asm"]["RealDiv"]).apply(null,arguments)};var _Relu=Module["_Relu"]=function(){return (_Relu=Module["_Relu"]=Module["asm"]["Relu"]).apply(null,arguments)};var _Relu6=Module["_Relu6"]=function(){return (_Relu6=Module["_Relu6"]=Module["asm"]["Relu6"]).apply(null,arguments)};var _ResizeBilinear=Module["_ResizeBilinear"]=function(){return (_ResizeBilinear=Module["_ResizeBilinear"]=Module["asm"]["ResizeBilinear"]).apply(null,arguments)};var _Reverse=Module["_Reverse"]=function(){return (_Reverse=Module["_Reverse"]=Module["asm"]["Reverse"]).apply(null,arguments)};var _RotateWithOffset=Module["_RotateWithOffset"]=function(){return (_RotateWithOffset=Module["_RotateWithOffset"]=Module["asm"]["RotateWithOffset"]).apply(null,arguments)};var _Round=Module["_Round"]=function(){return (_Round=Module["_Round"]=Module["asm"]["Round"]).apply(null,arguments)};var _Rsqrt=Module["_Rsqrt"]=function(){return (_Rsqrt=Module["_Rsqrt"]=Module["asm"]["Rsqrt"]).apply(null,arguments)};var _ScatterNd=Module["_ScatterNd"]=function(){return (_ScatterNd=Module["_ScatterNd"]=Module["asm"]["ScatterNd"]).apply(null,arguments)};var _SelectV2=Module["_SelectV2"]=function(){return (_SelectV2=Module["_SelectV2"]=Module["asm"]["SelectV2"]).apply(null,arguments)};var _Sigmoid=Module["_Sigmoid"]=function(){return (_Sigmoid=Module["_Sigmoid"]=Module["asm"]["Sigmoid"]).apply(null,arguments)};var _Sin=Module["_Sin"]=function(){return (_Sin=Module["_Sin"]=Module["asm"]["Sin"]).apply(null,arguments)};var _Softmax=Module["_Softmax"]=function(){return (_Softmax=Module["_Softmax"]=Module["asm"]["Softmax"]).apply(null,arguments)};var _SparseFillEmptyRows=Module["_SparseFillEmptyRows"]=function(){return (_SparseFillEmptyRows=Module["_SparseFillEmptyRows"]=Module["asm"]["SparseFillEmptyRows"]).apply(null,arguments)};var _SparseReshape=Module["_SparseReshape"]=function(){return (_SparseReshape=Module["_SparseReshape"]=Module["asm"]["SparseReshape"]).apply(null,arguments)};var _SparseSegmentReduction=Module["_SparseSegmentReduction"]=function(){return (_SparseSegmentReduction=Module["_SparseSegmentReduction"]=Module["asm"]["SparseSegmentReduction"]).apply(null,arguments)};var _Sqrt=Module["_Sqrt"]=function(){return (_Sqrt=Module["_Sqrt"]=Module["asm"]["Sqrt"]).apply(null,arguments)};var _Square=Module["_Square"]=function(){return (_Square=Module["_Square"]=Module["asm"]["Square"]).apply(null,arguments)};var _SquaredDifference=Module["_SquaredDifference"]=function(){return (_SquaredDifference=Module["_SquaredDifference"]=Module["asm"]["SquaredDifference"]).apply(null,arguments)};var _Step=Module["_Step"]=function(){return (_Step=Module["_Step"]=Module["asm"]["Step"]).apply(null,arguments)};var _StridedSlice=Module["_StridedSlice"]=function(){return (_StridedSlice=Module["_StridedSlice"]=Module["asm"]["StridedSlice"]).apply(null,arguments)};var _Sub=Module["_Sub"]=function(){return (_Sub=Module["_Sub"]=Module["asm"]["Sub"]).apply(null,arguments)};var _Sum=Module["_Sum"]=function(){return (_Sum=Module["_Sum"]=Module["asm"]["Sum"]).apply(null,arguments)};var _Tan=Module["_Tan"]=function(){return (_Tan=Module["_Tan"]=Module["asm"]["Tan"]).apply(null,arguments)};var _Tanh=Module["_Tanh"]=function(){return (_Tanh=Module["_Tanh"]=Module["asm"]["Tanh"]).apply(null,arguments)};var _Tile=Module["_Tile"]=function(){return (_Tile=Module["_Tile"]=Module["asm"]["Tile"]).apply(null,arguments)};var _TopK=Module["_TopK"]=function(){return (_TopK=Module["_TopK"]=Module["asm"]["TopK"]).apply(null,arguments)};var _Transform=Module["_Transform"]=function(){return (_Transform=Module["_Transform"]=Module["asm"]["Transform"]).apply(null,arguments)};var _Transpose=Module["_Transpose"]=function(){return (_Transpose=Module["_Transpose"]=Module["asm"]["Transpose"]).apply(null,arguments)};var __FusedMatMul=Module["__FusedMatMul"]=function(){return (__FusedMatMul=Module["__FusedMatMul"]=Module["asm"]["_FusedMatMul"]).apply(null,arguments)};var _malloc=Module["_malloc"]=function(){return (_malloc=Module["_malloc"]=Module["asm"]["malloc"]).apply(null,arguments)};var _free=Module["_free"]=function(){return (_free=Module["_free"]=Module["asm"]["free"]).apply(null,arguments)};var _emscripten_tls_init=Module["_emscripten_tls_init"]=function(){return (_emscripten_tls_init=Module["_emscripten_tls_init"]=Module["asm"]["emscripten_tls_init"]).apply(null,arguments)};var ___errno_location=Module["___errno_location"]=function(){return (___errno_location=Module["___errno_location"]=Module["asm"]["__errno_location"]).apply(null,arguments)};var _pthread_self=Module["_pthread_self"]=function(){return (_pthread_self=Module["_pthread_self"]=Module["asm"]["pthread_self"]).apply(null,arguments)};var _emscripten_main_thread_process_queued_calls=Module["_emscripten_main_thread_process_queued_calls"]=function(){return (_emscripten_main_thread_process_queued_calls=Module["_emscripten_main_thread_process_queued_calls"]=Module["asm"]["emscripten_main_thread_process_queued_calls"]).apply(null,arguments)};var __emscripten_thread_crashed=Module["__emscripten_thread_crashed"]=function(){return (__emscripten_thread_crashed=Module["__emscripten_thread_crashed"]=Module["asm"]["_emscripten_thread_crashed"]).apply(null,arguments)};var __emscripten_thread_init=Module["__emscripten_thread_init"]=function(){return (__emscripten_thread_init=Module["__emscripten_thread_init"]=Module["asm"]["_emscripten_thread_init"]).apply(null,arguments)};var _emscripten_current_thread_process_queued_calls=Module["_emscripten_current_thread_process_queued_calls"]=function(){return (_emscripten_current_thread_process_queued_calls=Module["_emscripten_current_thread_process_queued_calls"]=Module["asm"]["emscripten_current_thread_process_queued_calls"]).apply(null,arguments)};var _emscripten_main_browser_thread_id=Module["_emscripten_main_browser_thread_id"]=function(){return (_emscripten_main_browser_thread_id=Module["_emscripten_main_browser_thread_id"]=Module["asm"]["emscripten_main_browser_thread_id"]).apply(null,arguments)};var _emscripten_sync_run_in_main_thread_2=Module["_emscripten_sync_run_in_main_thread_2"]=function(){return (_emscripten_sync_run_in_main_thread_2=Module["_emscripten_sync_run_in_main_thread_2"]=Module["asm"]["emscripten_sync_run_in_main_thread_2"]).apply(null,arguments)};var _emscripten_sync_run_in_main_thread_4=Module["_emscripten_sync_run_in_main_thread_4"]=function(){return (_emscripten_sync_run_in_main_thread_4=Module["_emscripten_sync_run_in_main_thread_4"]=Module["asm"]["emscripten_sync_run_in_main_thread_4"]).apply(null,arguments)};var _emscripten_run_in_main_runtime_thread_js=Module["_emscripten_run_in_main_runtime_thread_js"]=function(){return (_emscripten_run_in_main_runtime_thread_js=Module["_emscripten_run_in_main_runtime_thread_js"]=Module["asm"]["emscripten_run_in_main_runtime_thread_js"]).apply(null,arguments)};var _emscripten_dispatch_to_thread_=Module["_emscripten_dispatch_to_thread_"]=function(){return (_emscripten_dispatch_to_thread_=Module["_emscripten_dispatch_to_thread_"]=Module["asm"]["emscripten_dispatch_to_thread_"]).apply(null,arguments)};var __emscripten_thread_free_data=Module["__emscripten_thread_free_data"]=function(){return (__emscripten_thread_free_data=Module["__emscripten_thread_free_data"]=Module["asm"]["_emscripten_thread_free_data"]).apply(null,arguments)};var __emscripten_thread_exit=Module["__emscripten_thread_exit"]=function(){return (__emscripten_thread_exit=Module["__emscripten_thread_exit"]=Module["asm"]["_emscripten_thread_exit"]).apply(null,arguments)};var _memalign=Module["_memalign"]=function(){return (_memalign=Module["_memalign"]=Module["asm"]["memalign"]).apply(null,arguments)};var _emscripten_stack_set_limits=Module["_emscripten_stack_set_limits"]=function(){return (_emscripten_stack_set_limits=Module["_emscripten_stack_set_limits"]=Module["asm"]["emscripten_stack_set_limits"]).apply(null,arguments)};var stackSave=Module["stackSave"]=function(){return (stackSave=Module["stackSave"]=Module["asm"]["stackSave"]).apply(null,arguments)};var stackRestore=Module["stackRestore"]=function(){return (stackRestore=Module["stackRestore"]=Module["asm"]["stackRestore"]).apply(null,arguments)};var stackAlloc=Module["stackAlloc"]=function(){return (stackAlloc=Module["stackAlloc"]=Module["asm"]["stackAlloc"]).apply(null,arguments)};var dynCall_iijjiiii=Module["dynCall_iijjiiii"]=function(){return (dynCall_iijjiiii=Module["dynCall_iijjiiii"]=Module["asm"]["dynCall_iijjiiii"]).apply(null,arguments)};var dynCall_jiji=Module["dynCall_jiji"]=function(){return (dynCall_jiji=Module["dynCall_jiji"]=Module["asm"]["dynCall_jiji"]).apply(null,arguments)};var __emscripten_allow_main_runtime_queued_calls=Module["__emscripten_allow_main_runtime_queued_calls"]=21464;Module["cwrap"]=cwrap;Module["keepRuntimeAlive"]=keepRuntimeAlive;Module["PThread"]=PThread;Module["PThread"]=PThread;Module["wasmMemory"]=wasmMemory;Module["ExitStatus"]=ExitStatus;var calledRun;function ExitStatus(status){this.name="ExitStatus";this.message="Program terminated with exit("+status+")";this.status=status;}dependenciesFulfilled=function runCaller(){if(!calledRun)run();if(!calledRun)dependenciesFulfilled=runCaller;};function run(args){if(runDependencies>0){return}if(ENVIRONMENT_IS_PTHREAD){readyPromiseResolve(Module);initRuntime();postMessage({"cmd":"loaded"});return}preRun();if(runDependencies>0){return}function doRun(){if(calledRun)return;calledRun=true;Module["calledRun"]=true;if(ABORT)return;initRuntime();readyPromiseResolve(Module);if(Module["onRuntimeInitialized"])Module["onRuntimeInitialized"]();postRun();}if(Module["setStatus"]){Module["setStatus"]("Running...");setTimeout(function(){setTimeout(function(){Module["setStatus"]("");},1);doRun();},1);}else {doRun();}}Module["run"]=run;function exit(status,implicit){EXITSTATUS=status;if(!implicit){if(ENVIRONMENT_IS_PTHREAD){exitOnMainThread(status);throw "unwind"}}if(keepRuntimeAlive());else {exitRuntime();}procExit(status);}function procExit(code){EXITSTATUS=code;if(!keepRuntimeAlive()){PThread.terminateAllThreads();if(Module["onExit"])Module["onExit"](code);ABORT=true;}quit_(code,new ExitStatus(code));}if(Module["preInit"]){if(typeof Module["preInit"]=="function")Module["preInit"]=[Module["preInit"]];while(Module["preInit"].length>0){Module["preInit"].pop()();}}run();var listenersAdded;if(beforeListeners){listenersAdded={uncaughtException:process.listeners("uncaughtException").filter(function(listener){return !beforeListeners.uncaughtException.indexOf(listener)>-1}),unhandledRejection:process.listeners("unhandledRejection").filter(function(listener){return !beforeListeners.unhandledRejection.indexOf(listener)>-1})};}var actualModule;if(typeof WasmBackendModule!=="undefined"){actualModule=WasmBackendModule;}else if(typeof WasmBackendModuleThreadedSimd!=="undefined"){actualModule=WasmBackendModuleThreadedSimd;}else {throw new Error("Could not find wasm module in post.js")}if(listenersAdded){var tmpDispose=actualModule["_dispose"];actualModule["_dispose"]=function(){tmpDispose();listenersAdded.uncaughtException.forEach(function(listener){process.removeListener("uncaughtException",listener);});listenersAdded.unhandledRejection.forEach(function(listener){process.removeListener("unhandledRejection",listener);});};}


  return WasmBackendModuleThreadedSimd.ready
}
);
})();
module.exports = WasmBackendModuleThreadedSimd;
});

const wasmWorkerContents = '"use strict";var Module={};var ENVIRONMENT_IS_NODE=typeof process==="object"&&typeof process.versions==="object"&&typeof process.versions.node==="string";if(ENVIRONMENT_IS_NODE){var nodeWorkerThreads=require("worker_threads");var parentPort=nodeWorkerThreads.parentPort;parentPort.on("message",function(data){onmessage({data:data})});var fs=require("fs");Object.assign(global,{self:global,require:require,Module:Module,location:{href:__filename},Worker:nodeWorkerThreads.Worker,importScripts:function(f){(0,eval)(fs.readFileSync(f,"utf8"))},postMessage:function(msg){parentPort.postMessage(msg)},performance:global.performance||{now:function(){return Date.now()}}})}function threadPrintErr(){var text=Array.prototype.slice.call(arguments).join(" ");if(ENVIRONMENT_IS_NODE){fs.writeSync(2,text+"\n");return}console.error(text)}function threadAlert(){var text=Array.prototype.slice.call(arguments).join(" ");postMessage({cmd:"alert",text:text,threadId:Module["_pthread_self"]()})}var err=threadPrintErr;self.alert=threadAlert;Module["instantiateWasm"]=((info,receiveInstance)=>{var instance=new WebAssembly.Instance(Module["wasmModule"],info);receiveInstance(instance);Module["wasmModule"]=null;return instance.exports});self.onmessage=(e=>{try{if(e.data.cmd==="load"){Module["wasmModule"]=e.data.wasmModule;Module["wasmMemory"]=e.data.wasmMemory;Module["buffer"]=Module["wasmMemory"].buffer;Module["ENVIRONMENT_IS_PTHREAD"]=true;if(typeof e.data.urlOrBlob==="string"){importScripts(e.data.urlOrBlob)}else{var objectUrl=URL.createObjectURL(e.data.urlOrBlob);importScripts(objectUrl);URL.revokeObjectURL(objectUrl)}WasmBackendModuleThreadedSimd(Module).then(function(instance){Module=instance})}else if(e.data.cmd==="run"){Module["__performance_now_clock_drift"]=performance.now()-e.data.time;Module["__emscripten_thread_init"](e.data.threadInfoStruct,0,0,1);Module["establishStackSpace"]();Module["PThread"].receiveObjectTransfer(e.data);Module["PThread"].threadInit();try{var result=Module["invokeEntryPoint"](e.data.start_routine,e.data.arg);if(Module["keepRuntimeAlive"]()){Module["PThread"].setExitStatus(result)}else{Module["__emscripten_thread_exit"](result)}}catch(ex){if(ex!="unwind"){if(ex instanceof Module["ExitStatus"]){if(Module["keepRuntimeAlive"]()){}else{Module["__emscripten_thread_exit"](ex.status)}}else{throw ex}}}}else if(e.data.cmd==="cancel"){if(Module["_pthread_self"]()){Module["__emscripten_thread_exit"](-1)}}else if(e.data.target==="setimmediate"){}else if(e.data.cmd==="processThreadQueue"){if(Module["_pthread_self"]()){Module["_emscripten_current_thread_process_queued_calls"]()}}else if(e.data.cmd==="processProxyingQueue"){if(Module["_pthread_self"]()){Module["_emscripten_proxy_execute_queue"](e.data.queue)}}else{err("worker.js received unknown command "+e.data.cmd);err(e.data)}}catch(ex){err("worker.js onmessage() captured an uncaught exception: "+ex);if(ex&&ex.stack)err(ex.stack);if(Module["__emscripten_thread_crashed"]){Module["__emscripten_thread_crashed"]()}throw ex}});';

var tfjsBackendWasm = createCommonjsModule(function (module, exports) {
var WasmBackendModule = (() => {
  var _scriptDir = typeof document !== 'undefined' && document.currentScript ? document.currentScript.src : undefined;
  if (typeof __filename !== 'undefined') _scriptDir = _scriptDir || __filename;
  return (
function(WasmBackendModule) {
  WasmBackendModule = WasmBackendModule || {};

var Module=typeof WasmBackendModule!=="undefined"?WasmBackendModule:{};var readyPromiseResolve,readyPromiseReject;Module["ready"]=new Promise(function(resolve,reject){readyPromiseResolve=resolve;readyPromiseReject=reject;});var beforeListeners;if(typeof process!=="undefined"&&process.listeners){beforeListeners={uncaughtException:process.listeners("uncaughtException"),unhandledRejection:process.listeners("unhandledRejection")};}var moduleOverrides=Object.assign({},Module);var arguments_=[];var thisProgram="./this.program";var quit_=(status,toThrow)=>{throw toThrow};var ENVIRONMENT_IS_WEB=typeof window==="object";var ENVIRONMENT_IS_WORKER=typeof importScripts==="function";var ENVIRONMENT_IS_NODE=typeof process==="object"&&typeof process.versions==="object"&&typeof process.versions.node==="string";var scriptDirectory="";function locateFile(path){if(Module["locateFile"]){return Module["locateFile"](path,scriptDirectory)}return scriptDirectory+path}var read_,readAsync,readBinary;function logExceptionOnExit(e){if(e instanceof ExitStatus)return;let toLog=e;err("exiting due to exception: "+toLog);}var fs$1;var nodePath;var requireNodeFS;if(ENVIRONMENT_IS_NODE){if(ENVIRONMENT_IS_WORKER){scriptDirectory=path.dirname(scriptDirectory)+"/";}else {scriptDirectory=__dirname+"/";}requireNodeFS=(()=>{if(!nodePath){fs$1=fs;nodePath=path;}});read_=function shell_read(filename,binary){requireNodeFS();filename=nodePath["normalize"](filename);return fs$1.readFileSync(filename,binary?undefined:"utf8")};readBinary=(filename=>{var ret=read_(filename,true);if(!ret.buffer){ret=new Uint8Array(ret);}return ret});readAsync=((filename,onload,onerror)=>{requireNodeFS();filename=nodePath["normalize"](filename);fs$1.readFile(filename,function(err,data){if(err)onerror(err);else onload(data.buffer);});});if(process["argv"].length>1){thisProgram=process["argv"][1].replace(/\\/g,"/");}arguments_=process["argv"].slice(2);process["on"]("uncaughtException",function(ex){if(!(ex instanceof ExitStatus)){throw ex}});process["on"]("unhandledRejection",function(reason){throw reason});quit_=((status,toThrow)=>{if(keepRuntimeAlive()){process["exitCode"]=status;throw toThrow}logExceptionOnExit(toThrow);process["exit"](status);});Module["inspect"]=function(){return "[Emscripten Module object]"};}else if(ENVIRONMENT_IS_WEB||ENVIRONMENT_IS_WORKER){if(ENVIRONMENT_IS_WORKER){scriptDirectory=self.location.href;}else if(typeof document!=="undefined"&&document.currentScript){scriptDirectory=document.currentScript.src;}if(_scriptDir){scriptDirectory=_scriptDir;}if(scriptDirectory.indexOf("blob:")!==0){scriptDirectory=scriptDirectory.substr(0,scriptDirectory.replace(/[?#].*/,"").lastIndexOf("/")+1);}else {scriptDirectory="";}{read_=(url=>{var xhr=new XMLHttpRequest;xhr.open("GET",url,false);xhr.send(null);return xhr.responseText});if(ENVIRONMENT_IS_WORKER){readBinary=(url=>{var xhr=new XMLHttpRequest;xhr.open("GET",url,false);xhr.responseType="arraybuffer";xhr.send(null);return new Uint8Array(xhr.response)});}readAsync=((url,onload,onerror)=>{var xhr=new XMLHttpRequest;xhr.open("GET",url,true);xhr.responseType="arraybuffer";xhr.onload=(()=>{if(xhr.status==200||xhr.status==0&&xhr.response){onload(xhr.response);return}onerror();});xhr.onerror=onerror;xhr.send(null);});}}var out=Module["print"]||console.log.bind(console);var err=Module["printErr"]||console.warn.bind(console);Object.assign(Module,moduleOverrides);moduleOverrides=null;if(Module["arguments"])arguments_=Module["arguments"];if(Module["thisProgram"])thisProgram=Module["thisProgram"];if(Module["quit"])quit_=Module["quit"];var wasmBinary;if(Module["wasmBinary"])wasmBinary=Module["wasmBinary"];var noExitRuntime=Module["noExitRuntime"]||true;if(typeof WebAssembly!=="object"){abort("no native wasm support detected");}var wasmMemory;var ABORT=false;function getCFunc(ident){var func=Module["_"+ident];return func}function ccall(ident,returnType,argTypes,args,opts){var toC={"string":function(str){var ret=0;if(str!==null&&str!==undefined&&str!==0){var len=(str.length<<2)+1;ret=stackAlloc(len);stringToUTF8(str,ret,len);}return ret},"array":function(arr){var ret=stackAlloc(arr.length);writeArrayToMemory(arr,ret);return ret}};function convertReturnValue(ret){if(returnType==="string")return UTF8ToString(ret);if(returnType==="boolean")return Boolean(ret);return ret}var func=getCFunc(ident);var cArgs=[];var stack=0;if(args){for(var i=0;i<args.length;i++){var converter=toC[argTypes[i]];if(converter){if(stack===0)stack=stackSave();cArgs[i]=converter(args[i]);}else {cArgs[i]=args[i];}}}var ret=func.apply(null,cArgs);function onDone(ret){if(stack!==0)stackRestore(stack);return convertReturnValue(ret)}ret=onDone(ret);return ret}function cwrap(ident,returnType,argTypes,opts){argTypes=argTypes||[];var numericArgs=argTypes.every(function(type){return type==="number"});var numericRet=returnType!=="string";if(numericRet&&numericArgs&&!opts){return getCFunc(ident)}return function(){return ccall(ident,returnType,argTypes,arguments)}}var UTF8Decoder=typeof TextDecoder!=="undefined"?new TextDecoder("utf8"):undefined;function UTF8ArrayToString(heap,idx,maxBytesToRead){var endIdx=idx+maxBytesToRead;var endPtr=idx;while(heap[endPtr]&&!(endPtr>=endIdx))++endPtr;if(endPtr-idx>16&&heap.subarray&&UTF8Decoder){return UTF8Decoder.decode(heap.subarray(idx,endPtr))}else {var str="";while(idx<endPtr){var u0=heap[idx++];if(!(u0&128)){str+=String.fromCharCode(u0);continue}var u1=heap[idx++]&63;if((u0&224)==192){str+=String.fromCharCode((u0&31)<<6|u1);continue}var u2=heap[idx++]&63;if((u0&240)==224){u0=(u0&15)<<12|u1<<6|u2;}else {u0=(u0&7)<<18|u1<<12|u2<<6|heap[idx++]&63;}if(u0<65536){str+=String.fromCharCode(u0);}else {var ch=u0-65536;str+=String.fromCharCode(55296|ch>>10,56320|ch&1023);}}}return str}function UTF8ToString(ptr,maxBytesToRead){return ptr?UTF8ArrayToString(HEAPU8,ptr,maxBytesToRead):""}function stringToUTF8Array(str,heap,outIdx,maxBytesToWrite){if(!(maxBytesToWrite>0))return 0;var startIdx=outIdx;var endIdx=outIdx+maxBytesToWrite-1;for(var i=0;i<str.length;++i){var u=str.charCodeAt(i);if(u>=55296&&u<=57343){var u1=str.charCodeAt(++i);u=65536+((u&1023)<<10)|u1&1023;}if(u<=127){if(outIdx>=endIdx)break;heap[outIdx++]=u;}else if(u<=2047){if(outIdx+1>=endIdx)break;heap[outIdx++]=192|u>>6;heap[outIdx++]=128|u&63;}else if(u<=65535){if(outIdx+2>=endIdx)break;heap[outIdx++]=224|u>>12;heap[outIdx++]=128|u>>6&63;heap[outIdx++]=128|u&63;}else {if(outIdx+3>=endIdx)break;heap[outIdx++]=240|u>>18;heap[outIdx++]=128|u>>12&63;heap[outIdx++]=128|u>>6&63;heap[outIdx++]=128|u&63;}}heap[outIdx]=0;return outIdx-startIdx}function stringToUTF8(str,outPtr,maxBytesToWrite){return stringToUTF8Array(str,HEAPU8,outPtr,maxBytesToWrite)}var UTF16Decoder=typeof TextDecoder!=="undefined"?new TextDecoder("utf-16le"):undefined;function writeArrayToMemory(array,buffer){HEAP8.set(array,buffer);}function alignUp(x,multiple){if(x%multiple>0){x+=multiple-x%multiple;}return x}var buffer,HEAP8,HEAPU8,HEAP16,HEAPU16,HEAP32,HEAPU32,HEAPF32,HEAPF64;function updateGlobalBufferAndViews(buf){buffer=buf;Module["HEAP8"]=HEAP8=new Int8Array(buf);Module["HEAP16"]=HEAP16=new Int16Array(buf);Module["HEAP32"]=HEAP32=new Int32Array(buf);Module["HEAPU8"]=HEAPU8=new Uint8Array(buf);Module["HEAPU16"]=HEAPU16=new Uint16Array(buf);Module["HEAPU32"]=HEAPU32=new Uint32Array(buf);Module["HEAPF32"]=HEAPF32=new Float32Array(buf);Module["HEAPF64"]=HEAPF64=new Float64Array(buf);}var INITIAL_MEMORY=Module["INITIAL_MEMORY"]||16777216;var wasmTable;var __ATPRERUN__=[];var __ATINIT__=[];var __ATPOSTRUN__=[];var runtimeKeepaliveCounter=0;function keepRuntimeAlive(){return noExitRuntime||runtimeKeepaliveCounter>0}function preRun(){if(Module["preRun"]){if(typeof Module["preRun"]=="function")Module["preRun"]=[Module["preRun"]];while(Module["preRun"].length){addOnPreRun(Module["preRun"].shift());}}callRuntimeCallbacks(__ATPRERUN__);}function initRuntime(){callRuntimeCallbacks(__ATINIT__);}function postRun(){if(Module["postRun"]){if(typeof Module["postRun"]=="function")Module["postRun"]=[Module["postRun"]];while(Module["postRun"].length){addOnPostRun(Module["postRun"].shift());}}callRuntimeCallbacks(__ATPOSTRUN__);}function addOnPreRun(cb){__ATPRERUN__.unshift(cb);}function addOnInit(cb){__ATINIT__.unshift(cb);}function addOnPostRun(cb){__ATPOSTRUN__.unshift(cb);}var runDependencies=0;var dependenciesFulfilled=null;function addRunDependency(id){runDependencies++;if(Module["monitorRunDependencies"]){Module["monitorRunDependencies"](runDependencies);}}function removeRunDependency(id){runDependencies--;if(Module["monitorRunDependencies"]){Module["monitorRunDependencies"](runDependencies);}if(runDependencies==0){if(dependenciesFulfilled){var callback=dependenciesFulfilled;dependenciesFulfilled=null;callback();}}}Module["preloadedImages"]={};Module["preloadedAudios"]={};function abort(what){{if(Module["onAbort"]){Module["onAbort"](what);}}what="Aborted("+what+")";err(what);ABORT=true;what+=". Build with -s ASSERTIONS=1 for more info.";var e=new WebAssembly.RuntimeError(what);readyPromiseReject(e);throw e}var dataURIPrefix="data:application/octet-stream;base64,";function isDataURI(filename){return filename.startsWith(dataURIPrefix)}function isFileURI(filename){return filename.startsWith("file://")}var wasmBinaryFile;wasmBinaryFile="tfjs-backend-wasm.wasm";if(!isDataURI(wasmBinaryFile)){wasmBinaryFile=locateFile(wasmBinaryFile);}function getBinary(file){try{if(file==wasmBinaryFile&&wasmBinary){return new Uint8Array(wasmBinary)}if(readBinary){return readBinary(file)}else {throw "both async and sync fetching of the wasm failed"}}catch(err){abort(err);}}function getBinaryPromise(){if(!wasmBinary&&(ENVIRONMENT_IS_WEB||ENVIRONMENT_IS_WORKER)){if(typeof fetch==="function"&&!isFileURI(wasmBinaryFile)){return fetch(wasmBinaryFile,{credentials:"same-origin"}).then(function(response){if(!response["ok"]){throw "failed to load wasm binary file at '"+wasmBinaryFile+"'"}return response["arrayBuffer"]()}).catch(function(){return getBinary(wasmBinaryFile)})}else {if(readAsync){return new Promise(function(resolve,reject){readAsync(wasmBinaryFile,function(response){resolve(new Uint8Array(response));},reject);})}}}return Promise.resolve().then(function(){return getBinary(wasmBinaryFile)})}function createWasm(){var info={"env":asmLibraryArg,"wasi_snapshot_preview1":asmLibraryArg};function receiveInstance(instance,module){var exports=instance.exports;Module["asm"]=exports;wasmMemory=Module["asm"]["memory"];updateGlobalBufferAndViews(wasmMemory.buffer);wasmTable=Module["asm"]["__indirect_function_table"];addOnInit(Module["asm"]["__wasm_call_ctors"]);removeRunDependency();}addRunDependency();function receiveInstantiationResult(result){receiveInstance(result["instance"]);}function instantiateArrayBuffer(receiver){return getBinaryPromise().then(function(binary){return WebAssembly.instantiate(binary,info)}).then(function(instance){return instance}).then(receiver,function(reason){err("failed to asynchronously prepare wasm: "+reason);abort(reason);})}function instantiateAsync(){if(!wasmBinary&&typeof WebAssembly.instantiateStreaming==="function"&&!isDataURI(wasmBinaryFile)&&!isFileURI(wasmBinaryFile)&&typeof fetch==="function"){return fetch(wasmBinaryFile,{credentials:"same-origin"}).then(function(response){var result=WebAssembly.instantiateStreaming(response,info);return result.then(receiveInstantiationResult,function(reason){err("wasm streaming compile failed: "+reason);err("falling back to ArrayBuffer instantiation");return instantiateArrayBuffer(receiveInstantiationResult)})})}else {return instantiateArrayBuffer(receiveInstantiationResult)}}if(Module["instantiateWasm"]){try{var exports=Module["instantiateWasm"](info,receiveInstance);return exports}catch(e){err("Module.instantiateWasm callback failed with error: "+e);return false}}instantiateAsync().catch(readyPromiseReject);return {}}function callRuntimeCallbacks(callbacks){while(callbacks.length>0){var callback=callbacks.shift();if(typeof callback=="function"){callback(Module);continue}var func=callback.func;if(typeof func==="number"){if(callback.arg===undefined){getWasmTableEntry(func)();}else {getWasmTableEntry(func)(callback.arg);}}else {func(callback.arg===undefined?null:callback.arg);}}}var wasmTableMirror=[];function getWasmTableEntry(funcPtr){var func=wasmTableMirror[funcPtr];if(!func){if(funcPtr>=wasmTableMirror.length)wasmTableMirror.length=funcPtr+1;wasmTableMirror[funcPtr]=func=wasmTable.get(funcPtr);}return func}function _abort(){abort("");}function _emscripten_get_heap_max(){return 2147483648}function _emscripten_memcpy_big(dest,src,num){HEAPU8.copyWithin(dest,src,src+num);}function emscripten_realloc_buffer(size){try{wasmMemory.grow(size-buffer.byteLength+65535>>>16);updateGlobalBufferAndViews(wasmMemory.buffer);return 1}catch(e){}}function _emscripten_resize_heap(requestedSize){var oldSize=HEAPU8.length;requestedSize=requestedSize>>>0;var maxHeapSize=_emscripten_get_heap_max();if(requestedSize>maxHeapSize){return false}for(var cutDown=1;cutDown<=4;cutDown*=2){var overGrownHeapSize=oldSize*(1+.2/cutDown);overGrownHeapSize=Math.min(overGrownHeapSize,requestedSize+100663296);var newSize=Math.min(maxHeapSize,alignUp(Math.max(requestedSize,overGrownHeapSize),65536));var replacement=emscripten_realloc_buffer(newSize);if(replacement){return true}}return false}var SYSCALLS={mappings:{},buffers:[null,[],[]],printChar:function(stream,curr){var buffer=SYSCALLS.buffers[stream];if(curr===0||curr===10){(stream===1?out:err)(UTF8ArrayToString(buffer,0));buffer.length=0;}else {buffer.push(curr);}},varargs:undefined,get:function(){SYSCALLS.varargs+=4;var ret=HEAP32[SYSCALLS.varargs-4>>2];return ret},getStr:function(ptr){var ret=UTF8ToString(ptr);return ret},get64:function(low,high){return low}};function _fd_close(fd){return 0}function _fd_seek(fd,offset_low,offset_high,whence,newOffset){}function _fd_write(fd,iov,iovcnt,pnum){var num=0;for(var i=0;i<iovcnt;i++){var ptr=HEAP32[iov>>2];var len=HEAP32[iov+4>>2];iov+=8;for(var j=0;j<len;j++){SYSCALLS.printChar(fd,HEAPU8[ptr+j]);}num+=len;}HEAP32[pnum>>2]=num;return 0}function _setTempRet0(val){}var asmLibraryArg={"abort":_abort,"emscripten_get_heap_max":_emscripten_get_heap_max,"emscripten_memcpy_big":_emscripten_memcpy_big,"emscripten_resize_heap":_emscripten_resize_heap,"fd_close":_fd_close,"fd_seek":_fd_seek,"fd_write":_fd_write,"setTempRet0":_setTempRet0};var asm=createWasm();var ___wasm_call_ctors=Module["___wasm_call_ctors"]=function(){return (___wasm_call_ctors=Module["___wasm_call_ctors"]=Module["asm"]["__wasm_call_ctors"]).apply(null,arguments)};var _init=Module["_init"]=function(){return (_init=Module["_init"]=Module["asm"]["init"]).apply(null,arguments)};var _init_with_threads_count=Module["_init_with_threads_count"]=function(){return (_init_with_threads_count=Module["_init_with_threads_count"]=Module["asm"]["init_with_threads_count"]).apply(null,arguments)};var _get_threads_count=Module["_get_threads_count"]=function(){return (_get_threads_count=Module["_get_threads_count"]=Module["asm"]["get_threads_count"]).apply(null,arguments)};var _register_tensor=Module["_register_tensor"]=function(){return (_register_tensor=Module["_register_tensor"]=Module["asm"]["register_tensor"]).apply(null,arguments)};var _dispose_data=Module["_dispose_data"]=function(){return (_dispose_data=Module["_dispose_data"]=Module["asm"]["dispose_data"]).apply(null,arguments)};var _dispose=Module["_dispose"]=function(){return (_dispose=Module["_dispose"]=Module["asm"]["dispose"]).apply(null,arguments)};var _Abs=Module["_Abs"]=function(){return (_Abs=Module["_Abs"]=Module["asm"]["Abs"]).apply(null,arguments)};var _Add=Module["_Add"]=function(){return (_Add=Module["_Add"]=Module["asm"]["Add"]).apply(null,arguments)};var _AddN=Module["_AddN"]=function(){return (_AddN=Module["_AddN"]=Module["asm"]["AddN"]).apply(null,arguments)};var _All=Module["_All"]=function(){return (_All=Module["_All"]=Module["asm"]["All"]).apply(null,arguments)};var _Any=Module["_Any"]=function(){return (_Any=Module["_Any"]=Module["asm"]["Any"]).apply(null,arguments)};var _ArgMax=Module["_ArgMax"]=function(){return (_ArgMax=Module["_ArgMax"]=Module["asm"]["ArgMax"]).apply(null,arguments)};var _AvgPool=Module["_AvgPool"]=function(){return (_AvgPool=Module["_AvgPool"]=Module["asm"]["AvgPool"]).apply(null,arguments)};var _BatchMatMul=Module["_BatchMatMul"]=function(){return (_BatchMatMul=Module["_BatchMatMul"]=Module["asm"]["BatchMatMul"]).apply(null,arguments)};var _Ceil=Module["_Ceil"]=function(){return (_Ceil=Module["_Ceil"]=Module["asm"]["Ceil"]).apply(null,arguments)};var _ClipByValue=Module["_ClipByValue"]=function(){return (_ClipByValue=Module["_ClipByValue"]=Module["asm"]["ClipByValue"]).apply(null,arguments)};var _Conv2D=Module["_Conv2D"]=function(){return (_Conv2D=Module["_Conv2D"]=Module["asm"]["Conv2D"]).apply(null,arguments)};var _Conv2DBackpropInput=Module["_Conv2DBackpropInput"]=function(){return (_Conv2DBackpropInput=Module["_Conv2DBackpropInput"]=Module["asm"]["Conv2DBackpropInput"]).apply(null,arguments)};var _Cos=Module["_Cos"]=function(){return (_Cos=Module["_Cos"]=Module["asm"]["Cos"]).apply(null,arguments)};var _Cosh=Module["_Cosh"]=function(){return (_Cosh=Module["_Cosh"]=Module["asm"]["Cosh"]).apply(null,arguments)};var _CropAndResize=Module["_CropAndResize"]=function(){return (_CropAndResize=Module["_CropAndResize"]=Module["asm"]["CropAndResize"]).apply(null,arguments)};var _Cumprod=Module["_Cumprod"]=function(){return (_Cumprod=Module["_Cumprod"]=Module["asm"]["Cumprod"]).apply(null,arguments)};var _Cumsum=Module["_Cumsum"]=function(){return (_Cumsum=Module["_Cumsum"]=Module["asm"]["Cumsum"]).apply(null,arguments)};var _DepthToSpace=Module["_DepthToSpace"]=function(){return (_DepthToSpace=Module["_DepthToSpace"]=Module["asm"]["DepthToSpace"]).apply(null,arguments)};var _DepthwiseConv2dNative=Module["_DepthwiseConv2dNative"]=function(){return (_DepthwiseConv2dNative=Module["_DepthwiseConv2dNative"]=Module["asm"]["DepthwiseConv2dNative"]).apply(null,arguments)};var _Elu=Module["_Elu"]=function(){return (_Elu=Module["_Elu"]=Module["asm"]["Elu"]).apply(null,arguments)};var _Equal=Module["_Equal"]=function(){return (_Equal=Module["_Equal"]=Module["asm"]["Equal"]).apply(null,arguments)};var _Exp=Module["_Exp"]=function(){return (_Exp=Module["_Exp"]=Module["asm"]["Exp"]).apply(null,arguments)};var _FlipLeftRight=Module["_FlipLeftRight"]=function(){return (_FlipLeftRight=Module["_FlipLeftRight"]=Module["asm"]["FlipLeftRight"]).apply(null,arguments)};var _Floor=Module["_Floor"]=function(){return (_Floor=Module["_Floor"]=Module["asm"]["Floor"]).apply(null,arguments)};var _FloorDiv=Module["_FloorDiv"]=function(){return (_FloorDiv=Module["_FloorDiv"]=Module["asm"]["FloorDiv"]).apply(null,arguments)};var _FusedBatchNorm=Module["_FusedBatchNorm"]=function(){return (_FusedBatchNorm=Module["_FusedBatchNorm"]=Module["asm"]["FusedBatchNorm"]).apply(null,arguments)};var _FusedConv2D=Module["_FusedConv2D"]=function(){return (_FusedConv2D=Module["_FusedConv2D"]=Module["asm"]["FusedConv2D"]).apply(null,arguments)};var _FusedDepthwiseConv2D=Module["_FusedDepthwiseConv2D"]=function(){return (_FusedDepthwiseConv2D=Module["_FusedDepthwiseConv2D"]=Module["asm"]["FusedDepthwiseConv2D"]).apply(null,arguments)};var _Gather=Module["_Gather"]=function(){return (_Gather=Module["_Gather"]=Module["asm"]["Gather"]).apply(null,arguments)};var _GatherNd=Module["_GatherNd"]=function(){return (_GatherNd=Module["_GatherNd"]=Module["asm"]["GatherNd"]).apply(null,arguments)};var _Greater=Module["_Greater"]=function(){return (_Greater=Module["_Greater"]=Module["asm"]["Greater"]).apply(null,arguments)};var _GreaterEqual=Module["_GreaterEqual"]=function(){return (_GreaterEqual=Module["_GreaterEqual"]=Module["asm"]["GreaterEqual"]).apply(null,arguments)};var _LeakyRelu=Module["_LeakyRelu"]=function(){return (_LeakyRelu=Module["_LeakyRelu"]=Module["asm"]["LeakyRelu"]).apply(null,arguments)};var _Less=Module["_Less"]=function(){return (_Less=Module["_Less"]=Module["asm"]["Less"]).apply(null,arguments)};var _LessEqual=Module["_LessEqual"]=function(){return (_LessEqual=Module["_LessEqual"]=Module["asm"]["LessEqual"]).apply(null,arguments)};var _Log=Module["_Log"]=function(){return (_Log=Module["_Log"]=Module["asm"]["Log"]).apply(null,arguments)};var _LogicalAnd=Module["_LogicalAnd"]=function(){return (_LogicalAnd=Module["_LogicalAnd"]=Module["asm"]["LogicalAnd"]).apply(null,arguments)};var _Max=Module["_Max"]=function(){return (_Max=Module["_Max"]=Module["asm"]["Max"]).apply(null,arguments)};var _MaxPool=Module["_MaxPool"]=function(){return (_MaxPool=Module["_MaxPool"]=Module["asm"]["MaxPool"]).apply(null,arguments)};var _Maximum=Module["_Maximum"]=function(){return (_Maximum=Module["_Maximum"]=Module["asm"]["Maximum"]).apply(null,arguments)};var _Mean=Module["_Mean"]=function(){return (_Mean=Module["_Mean"]=Module["asm"]["Mean"]).apply(null,arguments)};var _Min=Module["_Min"]=function(){return (_Min=Module["_Min"]=Module["asm"]["Min"]).apply(null,arguments)};var _Minimum=Module["_Minimum"]=function(){return (_Minimum=Module["_Minimum"]=Module["asm"]["Minimum"]).apply(null,arguments)};var _MirrorPad=Module["_MirrorPad"]=function(){return (_MirrorPad=Module["_MirrorPad"]=Module["asm"]["MirrorPad"]).apply(null,arguments)};var _Multiply=Module["_Multiply"]=function(){return (_Multiply=Module["_Multiply"]=Module["asm"]["Multiply"]).apply(null,arguments)};var _Neg=Module["_Neg"]=function(){return (_Neg=Module["_Neg"]=Module["asm"]["Neg"]).apply(null,arguments)};var _NonMaxSuppressionV3=Module["_NonMaxSuppressionV3"]=function(){return (_NonMaxSuppressionV3=Module["_NonMaxSuppressionV3"]=Module["asm"]["NonMaxSuppressionV3"]).apply(null,arguments)};var _NonMaxSuppressionV4=Module["_NonMaxSuppressionV4"]=function(){return (_NonMaxSuppressionV4=Module["_NonMaxSuppressionV4"]=Module["asm"]["NonMaxSuppressionV4"]).apply(null,arguments)};var _NonMaxSuppressionV5=Module["_NonMaxSuppressionV5"]=function(){return (_NonMaxSuppressionV5=Module["_NonMaxSuppressionV5"]=Module["asm"]["NonMaxSuppressionV5"]).apply(null,arguments)};var _NotEqual=Module["_NotEqual"]=function(){return (_NotEqual=Module["_NotEqual"]=Module["asm"]["NotEqual"]).apply(null,arguments)};var _OneHot=Module["_OneHot"]=function(){return (_OneHot=Module["_OneHot"]=Module["asm"]["OneHot"]).apply(null,arguments)};var _PadV2=Module["_PadV2"]=function(){return (_PadV2=Module["_PadV2"]=Module["asm"]["PadV2"]).apply(null,arguments)};var _Pow=Module["_Pow"]=function(){return (_Pow=Module["_Pow"]=Module["asm"]["Pow"]).apply(null,arguments)};var _Prelu=Module["_Prelu"]=function(){return (_Prelu=Module["_Prelu"]=Module["asm"]["Prelu"]).apply(null,arguments)};var _Prod=Module["_Prod"]=function(){return (_Prod=Module["_Prod"]=Module["asm"]["Prod"]).apply(null,arguments)};var _RealDiv=Module["_RealDiv"]=function(){return (_RealDiv=Module["_RealDiv"]=Module["asm"]["RealDiv"]).apply(null,arguments)};var _Relu=Module["_Relu"]=function(){return (_Relu=Module["_Relu"]=Module["asm"]["Relu"]).apply(null,arguments)};var _Relu6=Module["_Relu6"]=function(){return (_Relu6=Module["_Relu6"]=Module["asm"]["Relu6"]).apply(null,arguments)};var _ResizeBilinear=Module["_ResizeBilinear"]=function(){return (_ResizeBilinear=Module["_ResizeBilinear"]=Module["asm"]["ResizeBilinear"]).apply(null,arguments)};var _Reverse=Module["_Reverse"]=function(){return (_Reverse=Module["_Reverse"]=Module["asm"]["Reverse"]).apply(null,arguments)};var _RotateWithOffset=Module["_RotateWithOffset"]=function(){return (_RotateWithOffset=Module["_RotateWithOffset"]=Module["asm"]["RotateWithOffset"]).apply(null,arguments)};var _Round=Module["_Round"]=function(){return (_Round=Module["_Round"]=Module["asm"]["Round"]).apply(null,arguments)};var _Rsqrt=Module["_Rsqrt"]=function(){return (_Rsqrt=Module["_Rsqrt"]=Module["asm"]["Rsqrt"]).apply(null,arguments)};var _ScatterNd=Module["_ScatterNd"]=function(){return (_ScatterNd=Module["_ScatterNd"]=Module["asm"]["ScatterNd"]).apply(null,arguments)};var _SelectV2=Module["_SelectV2"]=function(){return (_SelectV2=Module["_SelectV2"]=Module["asm"]["SelectV2"]).apply(null,arguments)};var _Sigmoid=Module["_Sigmoid"]=function(){return (_Sigmoid=Module["_Sigmoid"]=Module["asm"]["Sigmoid"]).apply(null,arguments)};var _Sin=Module["_Sin"]=function(){return (_Sin=Module["_Sin"]=Module["asm"]["Sin"]).apply(null,arguments)};var _Softmax=Module["_Softmax"]=function(){return (_Softmax=Module["_Softmax"]=Module["asm"]["Softmax"]).apply(null,arguments)};var _SparseFillEmptyRows=Module["_SparseFillEmptyRows"]=function(){return (_SparseFillEmptyRows=Module["_SparseFillEmptyRows"]=Module["asm"]["SparseFillEmptyRows"]).apply(null,arguments)};var _SparseReshape=Module["_SparseReshape"]=function(){return (_SparseReshape=Module["_SparseReshape"]=Module["asm"]["SparseReshape"]).apply(null,arguments)};var _SparseSegmentReduction=Module["_SparseSegmentReduction"]=function(){return (_SparseSegmentReduction=Module["_SparseSegmentReduction"]=Module["asm"]["SparseSegmentReduction"]).apply(null,arguments)};var _Sqrt=Module["_Sqrt"]=function(){return (_Sqrt=Module["_Sqrt"]=Module["asm"]["Sqrt"]).apply(null,arguments)};var _Square=Module["_Square"]=function(){return (_Square=Module["_Square"]=Module["asm"]["Square"]).apply(null,arguments)};var _SquaredDifference=Module["_SquaredDifference"]=function(){return (_SquaredDifference=Module["_SquaredDifference"]=Module["asm"]["SquaredDifference"]).apply(null,arguments)};var _Step=Module["_Step"]=function(){return (_Step=Module["_Step"]=Module["asm"]["Step"]).apply(null,arguments)};var _StridedSlice=Module["_StridedSlice"]=function(){return (_StridedSlice=Module["_StridedSlice"]=Module["asm"]["StridedSlice"]).apply(null,arguments)};var _Sub=Module["_Sub"]=function(){return (_Sub=Module["_Sub"]=Module["asm"]["Sub"]).apply(null,arguments)};var _Sum=Module["_Sum"]=function(){return (_Sum=Module["_Sum"]=Module["asm"]["Sum"]).apply(null,arguments)};var _Tan=Module["_Tan"]=function(){return (_Tan=Module["_Tan"]=Module["asm"]["Tan"]).apply(null,arguments)};var _Tanh=Module["_Tanh"]=function(){return (_Tanh=Module["_Tanh"]=Module["asm"]["Tanh"]).apply(null,arguments)};var _Tile=Module["_Tile"]=function(){return (_Tile=Module["_Tile"]=Module["asm"]["Tile"]).apply(null,arguments)};var _TopK=Module["_TopK"]=function(){return (_TopK=Module["_TopK"]=Module["asm"]["TopK"]).apply(null,arguments)};var _Transform=Module["_Transform"]=function(){return (_Transform=Module["_Transform"]=Module["asm"]["Transform"]).apply(null,arguments)};var _Transpose=Module["_Transpose"]=function(){return (_Transpose=Module["_Transpose"]=Module["asm"]["Transpose"]).apply(null,arguments)};var __FusedMatMul=Module["__FusedMatMul"]=function(){return (__FusedMatMul=Module["__FusedMatMul"]=Module["asm"]["_FusedMatMul"]).apply(null,arguments)};var _malloc=Module["_malloc"]=function(){return (_malloc=Module["_malloc"]=Module["asm"]["malloc"]).apply(null,arguments)};var _free=Module["_free"]=function(){return (_free=Module["_free"]=Module["asm"]["free"]).apply(null,arguments)};var ___errno_location=Module["___errno_location"]=function(){return (___errno_location=Module["___errno_location"]=Module["asm"]["__errno_location"]).apply(null,arguments)};var _emscripten_main_thread_process_queued_calls=Module["_emscripten_main_thread_process_queued_calls"]=function(){return (_emscripten_main_thread_process_queued_calls=Module["_emscripten_main_thread_process_queued_calls"]=Module["asm"]["emscripten_main_thread_process_queued_calls"]).apply(null,arguments)};var stackSave=Module["stackSave"]=function(){return (stackSave=Module["stackSave"]=Module["asm"]["stackSave"]).apply(null,arguments)};var stackRestore=Module["stackRestore"]=function(){return (stackRestore=Module["stackRestore"]=Module["asm"]["stackRestore"]).apply(null,arguments)};var stackAlloc=Module["stackAlloc"]=function(){return (stackAlloc=Module["stackAlloc"]=Module["asm"]["stackAlloc"]).apply(null,arguments)};var dynCall_iijjiiii=Module["dynCall_iijjiiii"]=function(){return (dynCall_iijjiiii=Module["dynCall_iijjiiii"]=Module["asm"]["dynCall_iijjiiii"]).apply(null,arguments)};var dynCall_jiji=Module["dynCall_jiji"]=function(){return (dynCall_jiji=Module["dynCall_jiji"]=Module["asm"]["dynCall_jiji"]).apply(null,arguments)};Module["cwrap"]=cwrap;var calledRun;function ExitStatus(status){this.name="ExitStatus";this.message="Program terminated with exit("+status+")";this.status=status;}dependenciesFulfilled=function runCaller(){if(!calledRun)run();if(!calledRun)dependenciesFulfilled=runCaller;};function run(args){if(runDependencies>0){return}preRun();if(runDependencies>0){return}function doRun(){if(calledRun)return;calledRun=true;Module["calledRun"]=true;if(ABORT)return;initRuntime();readyPromiseResolve(Module);if(Module["onRuntimeInitialized"])Module["onRuntimeInitialized"]();postRun();}if(Module["setStatus"]){Module["setStatus"]("Running...");setTimeout(function(){setTimeout(function(){Module["setStatus"]("");},1);doRun();},1);}else {doRun();}}Module["run"]=run;if(Module["preInit"]){if(typeof Module["preInit"]=="function")Module["preInit"]=[Module["preInit"]];while(Module["preInit"].length>0){Module["preInit"].pop()();}}run();var listenersAdded;if(beforeListeners){listenersAdded={uncaughtException:process.listeners("uncaughtException").filter(function(listener){return !beforeListeners.uncaughtException.indexOf(listener)>-1}),unhandledRejection:process.listeners("unhandledRejection").filter(function(listener){return !beforeListeners.unhandledRejection.indexOf(listener)>-1})};}var actualModule;if(typeof WasmBackendModule!=="undefined"){actualModule=WasmBackendModule;}else if(typeof WasmBackendModuleThreadedSimd!=="undefined"){actualModule=WasmBackendModuleThreadedSimd;}else {throw new Error("Could not find wasm module in post.js")}if(listenersAdded){var tmpDispose=actualModule["_dispose"];actualModule["_dispose"]=function(){tmpDispose();listenersAdded.uncaughtException.forEach(function(listener){process.removeListener("uncaughtException",listener);});listenersAdded.unhandledRejection.forEach(function(listener){process.removeListener("unhandledRejection",listener);});};}


  return WasmBackendModule.ready
}
);
})();
module.exports = WasmBackendModule;
});

/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
class BackendWasm extends KernelBackend {
    constructor(wasm) {
        super();
        this.wasm = wasm;
        // 0 is reserved for null data ids.
        this.dataIdNextNumber = 1;
        this.wasm.tfjs.initWithThreadsCount(threadsCount);
        actualThreadsCount = this.wasm.tfjs.getThreadsCount();
        this.dataIdMap = new DataStorage(this, engine());
    }
    write(values, shape, dtype) {
        const dataId = { id: this.dataIdNextNumber++ };
        this.move(dataId, values, shape, dtype, 1);
        return dataId;
    }
    numDataIds() {
        return this.dataIdMap.numDataIds();
    }
    async time(f) {
        const start = util.now();
        f();
        const kernelMs = util.now() - start;
        return { kernelMs };
    }
    move(dataId, values, shape, dtype, refCount) {
        const id = this.dataIdNextNumber++;
        if (dtype === 'string') {
            const stringBytes = values;
            this.dataIdMap.set(dataId, { id, stringBytes, shape, dtype, memoryOffset: null, refCount });
            return;
        }
        const size = util.sizeFromShape(shape);
        const numBytes = size * util.bytesPerElement(dtype);
        const memoryOffset = this.wasm._malloc(numBytes);
        this.dataIdMap.set(dataId, { id, memoryOffset, shape, dtype, refCount });
        this.wasm.tfjs.registerTensor(id, size, memoryOffset);
        if (values != null) {
            this.wasm.HEAPU8.set(new Uint8Array(values.buffer, values.byteOffset, numBytes), memoryOffset);
        }
    }
    async read(dataId) {
        return this.readSync(dataId);
    }
    readSync(dataId, start, end) {
        const { memoryOffset, dtype, shape, stringBytes } = this.dataIdMap.get(dataId);
        if (dtype === 'string') {
            // Slice all elements.
            if ((start == null || start === 0) &&
                (end == null || end >= stringBytes.length)) {
                return stringBytes;
            }
            return stringBytes.slice(start, end);
        }
        start = start || 0;
        end = end || util.sizeFromShape(shape);
        const bytesPerElement = util.bytesPerElement(dtype);
        const bytes = this.wasm.HEAPU8.slice(memoryOffset + start * bytesPerElement, memoryOffset + end * bytesPerElement);
        return typedArrayFromBuffer(bytes.buffer, dtype);
    }
    /**
     * Dispose the memory if the dataId has 0 refCount. Return true if the memory
     * is released, false otherwise.
     * @param dataId
     * @oaram force Optional, remove the data regardless of refCount
     */
    disposeData(dataId, force = false) {
        if (this.dataIdMap.has(dataId)) {
            const data = this.dataIdMap.get(dataId);
            data.refCount--;
            if (!force && data.refCount > 0) {
                return false;
            }
            this.wasm._free(data.memoryOffset);
            this.wasm.tfjs.disposeData(data.id);
            this.dataIdMap.delete(dataId);
        }
        return true;
    }
    /** Return refCount of a `TensorData`. */
    refCount(dataId) {
        if (this.dataIdMap.has(dataId)) {
            const tensorData = this.dataIdMap.get(dataId);
            return tensorData.refCount;
        }
        return 0;
    }
    incRef(dataId) {
        const data = this.dataIdMap.get(dataId);
        if (data != null) {
            data.refCount++;
        }
    }
    floatPrecision() {
        return 32;
    }
    // Returns the memory offset of a tensor. Useful for debugging and unit
    // testing.
    getMemoryOffset(dataId) {
        return this.dataIdMap.get(dataId).memoryOffset;
    }
    dispose() {
        this.wasm.tfjs.dispose();
        if ('PThread' in this.wasm) {
            this.wasm.PThread.terminateAllThreads();
        }
        this.wasm = null;
    }
    memory() {
        return { unreliable: false };
    }
    /**
     * Make a tensor info for the output of an op. If `memoryOffset` is not
     * present, this method allocates memory on the WASM heap. If `memoryOffset`
     * is present, the memory was allocated elsewhere (in c++) and we just record
     * the pointer where that memory lives.
     */
    makeOutput(shape, dtype, memoryOffset) {
        let dataId;
        if (memoryOffset == null) {
            dataId = this.write(null /* values */, shape, dtype);
        }
        else {
            const id = this.dataIdNextNumber++;
            dataId = { id };
            this.dataIdMap.set(dataId, { id, memoryOffset, shape, dtype, refCount: 1 });
            const size = util.sizeFromShape(shape);
            this.wasm.tfjs.registerTensor(id, size, memoryOffset);
        }
        return { dataId, shape, dtype };
    }
    typedArrayFromHeap({ shape, dtype, dataId }) {
        const buffer = this.wasm.HEAPU8.buffer;
        const { memoryOffset } = this.dataIdMap.get(dataId);
        const size = util.sizeFromShape(shape);
        switch (dtype) {
            case 'float32':
                return new Float32Array(buffer, memoryOffset, size);
            case 'int32':
                return new Int32Array(buffer, memoryOffset, size);
            case 'bool':
                return new Uint8Array(buffer, memoryOffset, size);
            default:
                throw new Error(`Unknown dtype ${dtype}`);
        }
    }
}
function createInstantiateWasmFunc(path) {
    // this will be replace by rollup plugin patchWechatWebAssembly in
    // minprogram's output.
    // tslint:disable-next-line:no-any
    return (imports, callback) => {
        util.fetch(path, { credentials: 'same-origin' }).then((response) => {
            if (!response['ok']) {
                imports.env.a(`failed to load wasm binary file at '${path}'`);
            }
            response.arrayBuffer().then(binary => {
                WebAssembly.instantiate(binary, imports).then(output => {
                    callback(output.instance, output.module);
                });
            });
        });
        return {};
    };
}
/**
 * Returns the path of the WASM binary.
 * @param simdSupported whether SIMD is supported
 * @param threadsSupported whether multithreading is supported
 * @param wasmModuleFolder the directory containing the WASM binaries.
 */
function getPathToWasmBinary(simdSupported, threadsSupported, wasmModuleFolder) {
    if (wasmPath != null) {
        // If wasmPath is defined, the user has supplied a full path to
        // the vanilla .wasm binary.
        return wasmPath;
    }
    let path = 'tfjs-backend-wasm.wasm';
    if (simdSupported && threadsSupported) {
        path = 'tfjs-backend-wasm-threaded-simd.wasm';
    }
    else if (simdSupported) {
        path = 'tfjs-backend-wasm-simd.wasm';
    }
    if (wasmFileMap != null) {
        if (wasmFileMap[path] != null) {
            return wasmFileMap[path];
        }
    }
    return wasmModuleFolder + path;
}
/**
 * Initializes the wasm module and creates the js <--> wasm bridge.
 *
 * NOTE: We wrap the wasm module in a object with property 'wasm' instead of
 * returning Promise<BackendWasmModule> to avoid freezing Chrome (last tested
 * in Chrome 76).
 */
async function init() {
    const [simdSupported, threadsSupported] = await Promise.all([
        env().getAsync('WASM_HAS_SIMD_SUPPORT'),
        env().getAsync('WASM_HAS_MULTITHREAD_SUPPORT')
    ]);
    return new Promise((resolve, reject) => {
        const factoryConfig = {};
        /**
         * This function overrides the Emscripten module locateFile utility.
         * @param path The relative path to the file that needs to be loaded.
         * @param prefix The path to the main JavaScript file's directory.
         */
        factoryConfig.locateFile = (path, prefix) => {
            if (path.endsWith('.worker.js')) {
                // Escape '\n' because Blob will turn it into a newline.
                // There should be a setting for this, but 'endings: "native"' does
                // not seem to work.
                const response = wasmWorkerContents.replace(/\n/g, '\\n');
                const blob = new Blob([response], { type: 'application/javascript' });
                return URL.createObjectURL(blob);
            }
            if (path.endsWith('.wasm')) {
                return getPathToWasmBinary(simdSupported, threadsSupported, wasmPathPrefix != null ? wasmPathPrefix : prefix);
            }
            return prefix + path;
        };
        // Use the instantiateWasm override when system fetch is not available.
        // Reference:
        // https://github.com/emscripten-core/emscripten/blob/2bca083cbbd5a4133db61fbd74d04f7feecfa907/tests/manual_wasm_instantiate.html#L170
        if (customFetch) {
            factoryConfig.instantiateWasm =
                createInstantiateWasmFunc(getPathToWasmBinary(simdSupported, threadsSupported, wasmPathPrefix != null ? wasmPathPrefix : ''));
        }
        let initialized = false;
        factoryConfig.onAbort = () => {
            if (initialized) {
                // Emscripten already called console.warn so no need to double log.
                return;
            }
            if (initAborted) {
                // Emscripten calls `onAbort` twice, resulting in double error
                // messages.
                return;
            }
            initAborted = true;
            const rejectMsg = 'Make sure the server can serve the `.wasm` file relative to the ' +
                'bundled js file. For more details see https://github.com/tensorflow/tfjs/blob/master/tfjs-backend-wasm/README.md#using-bundlers';
            reject({ message: rejectMsg });
        };
        let wasm;
        // If `wasmPath` has been defined we must initialize the vanilla module.
        if (threadsSupported && simdSupported && wasmPath == null) {
            factoryConfig.mainScriptUrlOrBlob = new Blob([`var WasmBackendModuleThreadedSimd = ` +
                    tfjsBackendWasmThreadedSimd.toString()], { type: 'text/javascript' });
            wasm = tfjsBackendWasmThreadedSimd(factoryConfig);
        }
        else {
            // The wasmFactory works for both vanilla and SIMD binaries.
            wasm = tfjsBackendWasm(factoryConfig);
        }
        // The WASM module has been successfully created by the factory.
        // Any error will be caught by the onAbort callback defined above.
        wasm.then((module) => {
            initialized = true;
            initAborted = false;
            const voidReturnType = null;
            // Using the tfjs namespace to avoid conflict with emscripten's API.
            module.tfjs = {
                init: module.cwrap('init', null, []),
                initWithThreadsCount: module.cwrap('init_with_threads_count', null, ['number']),
                getThreadsCount: module.cwrap('get_threads_count', 'number', []),
                registerTensor: module.cwrap('register_tensor', null, [
                    'number',
                    'number',
                    'number',
                ]),
                disposeData: module.cwrap('dispose_data', voidReturnType, ['number']),
                dispose: module.cwrap('dispose', voidReturnType, []),
            };
            resolve({ wasm: module });
        });
    });
}
function typedArrayFromBuffer(buffer, dtype) {
    switch (dtype) {
        case 'float32':
            return new Float32Array(buffer);
        case 'int32':
            return new Int32Array(buffer);
        case 'bool':
            return new Uint8Array(buffer);
        default:
            throw new Error(`Unknown dtype ${dtype}`);
    }
}
const wasmBinaryNames = [
    'tfjs-backend-wasm.wasm', 'tfjs-backend-wasm-simd.wasm',
    'tfjs-backend-wasm-threaded-simd.wasm'
];
let wasmPath = null;
let wasmPathPrefix = null;
let wasmFileMap = {};
let initAborted = false;
let customFetch = false;
/**
 * @deprecated Use `setWasmPaths` instead.
 * Sets the path to the `.wasm` file which will be fetched when the wasm
 * backend is initialized. See
 * https://github.com/tensorflow/tfjs/blob/master/tfjs-backend-wasm/README.md#using-bundlers
 * for more details.
 * @param path wasm file path or url
 * @param usePlatformFetch optional boolean to use platform fetch to download
 *     the wasm file, default to false.
 *
 * @doc {heading: 'Environment', namespace: 'wasm'}
 */
function setWasmPath(path, usePlatformFetch = false) {
    deprecationWarn('setWasmPath has been deprecated in favor of setWasmPaths and' +
        ' will be removed in a future release.');
    if (initAborted) {
        throw new Error('The WASM backend was already initialized. Make sure you call ' +
            '`setWasmPath()` before you call `tf.setBackend()` or `tf.ready()`');
    }
    wasmPath = path;
    customFetch = usePlatformFetch;
}
/**
 * Configures the locations of the WASM binaries.
 *
 * ```js
 * setWasmPaths({
 *  'tfjs-backend-wasm.wasm': 'renamed.wasm',
 *  'tfjs-backend-wasm-simd.wasm': 'renamed-simd.wasm',
 *  'tfjs-backend-wasm-threaded-simd.wasm': 'renamed-threaded-simd.wasm'
 * });
 * tf.setBackend('wasm');
 * ```
 *
 * @param prefixOrFileMap This can be either a string or object:
 *  - (string) The path to the directory where the WASM binaries are located.
 *     Note that this prefix will be used to load each binary (vanilla,
 *     SIMD-enabled, threading-enabled, etc.).
 *  - (object) Mapping from names of WASM binaries to custom
 *     full paths specifying the locations of those binaries. This is useful if
 *     your WASM binaries are not all located in the same directory, or if your
 *     WASM binaries have been renamed.
 * @param usePlatformFetch optional boolean to use platform fetch to download
 *     the wasm file, default to false.
 *
 * @doc {heading: 'Environment', namespace: 'wasm'}
 */
function setWasmPaths(prefixOrFileMap, usePlatformFetch = false) {
    if (initAborted) {
        throw new Error('The WASM backend was already initialized. Make sure you call ' +
            '`setWasmPaths()` before you call `tf.setBackend()` or ' +
            '`tf.ready()`');
    }
    if (typeof prefixOrFileMap === 'string') {
        wasmPathPrefix = prefixOrFileMap;
    }
    else {
        wasmFileMap = prefixOrFileMap;
        const missingPaths = wasmBinaryNames.filter(name => wasmFileMap[name] == null);
        if (missingPaths.length > 0) {
            throw new Error(`There were no entries found for the following binaries: ` +
                `${missingPaths.join(',')}. Please either call setWasmPaths with a ` +
                `map providing a path for each binary, or with a string indicating ` +
                `the directory where all the binaries can be found.`);
        }
    }
    customFetch = usePlatformFetch;
}
let threadsCount = -1;
let actualThreadsCount = -1;
/**
 * Sets the number of threads that will be used by XNNPACK to create
 * threadpool (default to the number of logical CPU cores).
 *
 * This must be called before calling `tf.setBackend('wasm')`.
 */
function setThreadsCount(numThreads) {
    threadsCount = numThreads;
}
/**
 * Gets the actual threads count that is used by XNNPACK.
 *
 * It is set after the backend is intialized.
 */
function getThreadsCount() {
    if (actualThreadsCount === -1) {
        throw new Error(`WASM backend not initialized.`);
    }
    return actualThreadsCount;
}

/** @license See the LICENSE file. */
// This code is auto-generated, do not modify this file!
const version = '3.18.0';

/**
 * @license
 * Copyright 2020 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
const WASM_PRIORITY = 2;
registerBackend('wasm', async () => {
    const { wasm } = await init();
    return new BackendWasm(wasm);
}, WASM_PRIORITY);

export { BackendWasm, getThreadsCount, setThreadsCount, setWasmPath, setWasmPaths, version as version_wasm };
//# sourceMappingURL=tf-backend-wasm.fesm.js.map
