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
import { backend_util } from '@tensorflow/tfjs-core';
import { CppDType } from './types';
let wasmSparseSegmentReduction;
export function setup(backend) {
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
export function sparseSegmentReduction(args, isMean) {
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
//# sourceMappingURL=SparseSegmentReduction.js.map