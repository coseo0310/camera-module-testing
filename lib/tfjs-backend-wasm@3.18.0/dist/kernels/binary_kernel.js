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
import { backend_util, util } from '@tensorflow/tfjs-core';
import { CppDType } from './types';
export function createBinaryKernelConfig(kernelName, supportsFullBroadcast, dtype) {
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
//# sourceMappingURL=binary_kernel.js.map