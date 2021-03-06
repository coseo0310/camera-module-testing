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
import { Step } from '@tensorflow/tfjs-core';
import { CppDType } from './types';
let wasmStep;
function setup(backend) {
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
export const stepConfig = {
    kernelName: Step,
    backendName: 'wasm',
    setupFunc: setup,
    kernelFunc: step
};
//# sourceMappingURL=Step.js.map