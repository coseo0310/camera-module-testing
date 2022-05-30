// tensorflowJS
function inference_tfjs(image, tfjsModel) {
  // 320 * 320 size 로 input을 받던가 320 * 320 size로 resize 해야함

  let input = tf.expandDims(image);
  input = input.toFloat();

  let outputTensor = tfjsModel.predict(input);

  // fp32
  // const pts = Array.from(outputTensor[6].dataSync());
  // const pts_score = Array.from(outputTensor[7].dataSync());
  // const vmap = Array.from(outputTensor[12].dataSync());

  // fp16
  const pts = Array.from(outputTensor[9].dataSync());
  const pts_score = Array.from(outputTensor[15].dataSync());
  const vmap = Array.from(outputTensor[13].dataSync());

  return [pts, pts_score, vmap];
}

async function pred_squares(pyodide, pts, pts_score, vmap) {
  pyodide.globals.set("pts", pts);
  pyodide.globals.set("pts_score", pts_score);
  pyodide.globals.set("vmap", vmap);
  pyodide.runPython(`
        import os
        import numpy as np

        def pred_squares(pts, pts_score, vmap):
            

            params ={'score': 0.10,
                    'outside_ratio': 0.10,
                    'inside_ratio': 0.50,
                    'w_overlap': 0.0,
                    'w_degree': 1.14,
                    'w_length': 0.03,
                    'w_area': 1.84,
                    'w_center': 1.46}

            input_shape = [320, 320]
            original_shape = [320, 320]

            pts_list = [v for v in pts]
            pts_score_list = [v for v in pts_score]
            vmap_list = [v for v in vmap]
            pts = np.array(pts_list).reshape(200,2)
            pts_score = np.array(pts_score_list).reshape(200)
            vmap = np.array(vmap_list).reshape(160, 160, 4)

            start = vmap[:,:,:2]
            end = vmap[:,:,2:]
            dist_map = np.sqrt(np.sum((start - end) ** 2, axis=-1))

            junc_list = []
            segments_list = []
            for junc, score in zip(pts, pts_score):
                y, x = junc
                distance = dist_map[y, x]
                if score > params['score'] and distance > 20.0:
                    junc_list.append([x, y])
                    disp_x_start, disp_y_start, disp_x_end, disp_y_end = vmap[y, x, :]
                    d_arrow = 1.0
                    x_start = x + d_arrow * disp_x_start
                    y_start = y + d_arrow * disp_y_start
                    x_end = x + d_arrow * disp_x_end
                    y_end = y + d_arrow * disp_y_end
                    segments_list.append([x_start, y_start, x_end, y_end])
                    
            segments = np.array(segments_list)
            
            ####### post processing for squares
            # 1. get unique lines
            point = np.array([[0, 0]])
            point = point[0]
            start = segments[:,:2]
            end = segments[:,2:]
            diff = start - end
            a = diff[:, 1]
            b = -diff[:, 0]
            c = a * start[:,0] + b * start[:,1]

            d = np.abs(a * point[0] + b * point[1] - c) / np.sqrt(a ** 2 + b ** 2 + 1e-10)
            theta = np.arctan2(diff[:,0], diff[:,1]) * 180 / np.pi
            theta[theta < 0.0] += 180
            hough = np.concatenate([d[:,None], theta[:,None]], axis=-1)

            d_quant = 1
            theta_quant = 2
            hough[:,0] //= d_quant
            hough[:,1] //= theta_quant
            _, indices, counts = np.unique(hough, axis=0, return_index=True, return_counts=True)
            
            acc_map = np.zeros([512 // d_quant + 1, 360 // theta_quant + 1], dtype='float32')
            idx_map = np.zeros([512 // d_quant + 1, 360 // theta_quant + 1], dtype='int32') - 1
            yx_indices = hough[indices,:].astype('int32')
            acc_map[yx_indices[:,0], yx_indices[:,1]] = counts
            idx_map[yx_indices[:,0], yx_indices[:,1]] = indices
            
            acc_map_np = acc_map
            acc_map = acc_map[None,:,:,None]

            ### suppression using numpy op
            acc_map = acc_map.reshape((acc_map.shape[1], acc_map.shape[2]))
            max_acc_map = pooling(acc_map, 5, stride=1, pad=False)
            acc_map = acc_map * np.equal(acc_map, max_acc_map).astype(np.float32)
            flatten_acc_map = acc_map.reshape((1, -1))
            topk_values, topk_indices = top_k(flatten_acc_map, len(pts))
            h, w = acc_map.shape
            y = np.expand_dims(topk_indices // w, axis=-1)
            x = np.expand_dims(topk_indices % w, axis=-1)
            yx = np.concatenate([y, x], axis=-1)
            ###

            indices = idx_map[yx[:,0], yx[:,1]]
            topk_values = topk_values
            basis = 5 // 2
            merged_segments = []
            for yx_pt, max_indice, value in zip(yx, indices, topk_values):
                y, x = yx_pt
                if max_indice == -1 or value == 0:
                    continue
                segment_list = []
                for y_offset in range(-basis, basis+1):
                    for x_offset in range(-basis, basis+1):
                        indice = idx_map[y+y_offset,x+x_offset]
                        cnt = int(acc_map_np[y+y_offset,x+x_offset])
                        if indice != -1:
                            segment_list.append(segments[indice])
                        if cnt > 1:
                            check_cnt = 1
                            current_hough = hough[indice]
                            for new_indice, new_hough in enumerate(hough):
                                if (current_hough == new_hough).all() and indice != new_indice:
                                    segment_list.append(segments[new_indice])
                                    check_cnt += 1
                                if check_cnt == cnt:
                                    break
                group_segments = np.array(segment_list).reshape([-1, 2])
                sorted_group_segments = np.sort(group_segments, axis=0)
                x_min, y_min = sorted_group_segments[0,:]
                x_max, y_max = sorted_group_segments[-1,:]

                deg = theta[max_indice]
                if deg >= 90:
                    merged_segments.append([x_min, y_max, x_max, y_min])
                else:
                    merged_segments.append([x_min, y_min, x_max, y_max])

            # 2. get intersections
            new_segments = np.array(merged_segments) # (x1, y1, x2, y2)
            start = new_segments[:,:2] # (x1, y1)
            end = new_segments[:,2:] # (x2, y2)
            new_centers = (start + end) / 2.0
            diff = start - end
            dist_segments = np.sqrt(np.sum(diff ** 2, axis=-1))

            # ax + by = c
            a = diff[:,1]
            b = -diff[:,0]
            c = a * start[:,0] + b * start[:,1]
            pre_det = a[:,None] * b[None,:]
            det = pre_det - np.transpose(pre_det)

            pre_inter_y = a[:,None] * c[None,:]
            inter_y = (pre_inter_y - np.transpose(pre_inter_y)) / (det + 1e-10)
            pre_inter_x = c[:,None] * b[None,:]
            inter_x = (pre_inter_x - np.transpose(pre_inter_x)) / (det + 1e-10)
            inter_pts = np.concatenate([inter_x[:,:,None], inter_y[:,:,None]], axis=-1).astype('int32')
            
            # 3. get corner information
            # 3.1 get distance
            '''
            dist_segments:
                | dist(0), dist(1), dist(2), ...|
            dist_inter_to_segment1:
                | dist(inter,0), dist(inter,0), dist(inter,0), ... |
                | dist(inter,1), dist(inter,1), dist(inter,1), ... |
                ...
            dist_inter_to_semgnet2:
                | dist(inter,0), dist(inter,1), dist(inter,2), ... |
                | dist(inter,0), dist(inter,1), dist(inter,2), ... |
                ...
            '''

            dist_inter_to_segment1_start = np.sqrt(np.sum(((inter_pts - start[:,None,:]) ** 2), axis=-1, keepdims=True)) # [n_batch, n_batch, 1]
            dist_inter_to_segment1_end = np.sqrt(np.sum(((inter_pts - end[:,None,:]) ** 2), axis=-1, keepdims=True)) # [n_batch, n_batch, 1]
            dist_inter_to_segment2_start = np.sqrt(np.sum(((inter_pts - start[None,:,:]) ** 2), axis=-1, keepdims=True)) # [n_batch, n_batch, 1]
            dist_inter_to_segment2_end = np.sqrt(np.sum(((inter_pts - end[None,:,:]) ** 2), axis=-1, keepdims=True)) # [n_batch, n_batch, 1]
            
            # sort ascending
            dist_inter_to_segment1 = np.sort(np.concatenate([dist_inter_to_segment1_start, dist_inter_to_segment1_end], axis=-1), axis=-1) # [n_batch, n_batch, 2]
            dist_inter_to_segment2 = np.sort(np.concatenate([dist_inter_to_segment2_start, dist_inter_to_segment2_end], axis=-1), axis=-1) # [n_batch, n_batch, 2]

            # 3.2 get degree
            inter_to_start = new_centers[:,None,:] - inter_pts
            deg_inter_to_start = np.arctan2(inter_to_start[:,:,1], inter_to_start[:,:,0]) * 180 / np.pi
            deg_inter_to_start[deg_inter_to_start < 0.0] += 360
            inter_to_end = new_centers[None,:,:] - inter_pts
            deg_inter_to_end = np.arctan2(inter_to_end[:,:,1], inter_to_end[:,:,0]) * 180 / np.pi
            deg_inter_to_end[deg_inter_to_end < 0.0] += 360
            
            '''
            0 -- 1
            |    |
            3 -- 2
            '''
            # rename variables
            deg1_map, deg2_map = deg_inter_to_start, deg_inter_to_end
            # sort deg ascending
            deg_sort = np.sort(np.concatenate([deg1_map[:,:,None], deg2_map[:,:,None]], axis=-1), axis=-1)
            
            deg_diff_map = np.abs(deg1_map - deg2_map)
            # we only consider the smallest degree of intersect
            deg_diff_map[deg_diff_map > 180] = 360 - deg_diff_map[deg_diff_map > 180]
            
            # define available degree range
            deg_range = [60, 120]
            
            corner_dict = {corner_info: [] for corner_info in range(4)}
            inter_points = []
            for i in range(inter_pts.shape[0]):
                for j in range(i + 1, inter_pts.shape[1]):
                    # i, j > line index, always i < j
                    x, y = inter_pts[i, j, :]
                    deg1, deg2 = deg_sort[i, j, :]
                    deg_diff = deg_diff_map[i, j]
                    
                    check_degree = deg_diff > deg_range[0] and deg_diff < deg_range[1]

                    outside_ratio = params['outside_ratio'] # over ratio >>> drop it!
                    inside_ratio = params['inside_ratio'] # over ratio >>> drop it!
                    check_distance = ((dist_inter_to_segment1[i,j,1] >= dist_segments[i] and \
                                        dist_inter_to_segment1[i,j,0] <= dist_segments[i] * outside_ratio) or \
                                        (dist_inter_to_segment1[i,j,1] <= dist_segments[i] and \
                                        dist_inter_to_segment1[i,j,0] <= dist_segments[i] * inside_ratio)) and \
                                    ((dist_inter_to_segment2[i,j,1] >= dist_segments[j] and \
                                        dist_inter_to_segment2[i,j,0] <= dist_segments[j] * outside_ratio) or \
                                        (dist_inter_to_segment2[i,j,1] <= dist_segments[j] and \
                                        dist_inter_to_segment2[i,j,0] <= dist_segments[j] * inside_ratio))

                    if check_degree and check_distance:
                        corner_info = None

                        if (deg1 >= 0 and deg1 <= 45 and deg2 >=45 and deg2 <= 120) or \
                            (deg2 >= 315 and deg1 >= 45 and deg1 <= 120):
                            corner_info, color_info = 0, 'blue'
                        elif (deg1 >= 45 and deg1 <= 125 and deg2 >= 125 and deg2 <= 225):
                            corner_info, color_info = 1, 'green'
                        elif (deg1 >= 125 and deg1 <= 225 and deg2 >= 225 and deg2 <= 315):
                            corner_info, color_info = 2, 'black'
                        elif (deg1 >= 0 and deg1 <= 45 and deg2 >= 225 and deg2 <= 315) or \
                            (deg2 >= 315 and deg1 >= 225 and deg1 <= 315):
                            corner_info, color_info = 3, 'cyan'
                        else:
                            corner_info, color_info = 4, 'red' # we don't use it
                            continue
                        
                        corner_dict[corner_info].append([x, y, i, j])
                        inter_points.append([x, y])
            
            square_list = []
            connect_list = []
            segments_list = []
            for corner0 in corner_dict[0]:
                for corner1 in corner_dict[1]:
                    connect01 = False
                    for corner0_line in corner0[2:]:
                        if corner0_line in corner1[2:]:
                            connect01 = True
                            break
                    if connect01:
                        for corner2 in corner_dict[2]:
                            connect12 = False
                            for corner1_line in corner1[2:]:
                                if corner1_line in corner2[2:]:
                                    connect12 = True
                                    break
                            if connect12:
                                for corner3 in corner_dict[3]:
                                    connect23 = False
                                    for corner2_line in corner2[2:]:
                                        if corner2_line in corner3[2:]:
                                            connect23 = True
                                            break
                                    if connect23:
                                        for corner3_line in corner3[2:]:
                                            if corner3_line in corner0[2:]:
                                                # SQUARE!!!
                                                '''
                                                0 -- 1
                                                |    |
                                                3 -- 2
                                                square_list:
                                                    order: 0 > 1 > 2 > 3
                                                    | x0, y0, x1, y1, x2, y2, x3, y3 |
                                                    | x0, y0, x1, y1, x2, y2, x3, y3 |
                                                    ...
                                                connect_list:
                                                    order: 01 > 12 > 23 > 30
                                                    | line_idx01, line_idx12, line_idx23, line_idx30 |
                                                    | line_idx01, line_idx12, line_idx23, line_idx30 |
                                                    ...
                                                segments_list:
                                                    order: 0 > 1 > 2 > 3
                                                    | line_idx0_i, line_idx0_j, line_idx1_i, line_idx1_j, line_idx2_i, line_idx2_j, line_idx3_i, line_idx3_j |
                                                    | line_idx0_i, line_idx0_j, line_idx1_i, line_idx1_j, line_idx2_i, line_idx2_j, line_idx3_i, line_idx3_j |
                                                    ...
                                                '''
                                                square_list.append(corner0[:2] + corner1[:2] + corner2[:2] + corner3[:2])
                                                connect_list.append([corner0_line, corner1_line, corner2_line, corner3_line])
                                                segments_list.append(corner0[2:] + corner1[2:] + corner2[2:] + corner3[2:])
            

            def check_outside_inside(segments_info, connect_idx):
                # return 'outside or inside', min distance, cover_param, peri_param
                if connect_idx == segments_info[0]:
                    check_dist_mat = dist_inter_to_segment1
                else:
                    check_dist_mat = dist_inter_to_segment2
                
                i, j = segments_info
                min_dist, max_dist = check_dist_mat[i, j, :]
                connect_dist = dist_segments[connect_idx]
                if max_dist > connect_dist:
                    return 'outside', min_dist, 0, 1
                else:
                    return 'inside', min_dist, -1, -1


            top_square = None
            try:
                map_size = input_shape[0] / 2
                squares = np.array(square_list).reshape([-1,4,2])
                score_array = []
                connect_array = np.array(connect_list)
                segments_array = np.array(segments_list).reshape([-1,4,2])
                # get degree of corners:
                squares_rollup = np.roll(squares, 1, axis=1)
                squares_rolldown = np.roll(squares, -1, axis=1)
                vec1 = squares_rollup - squares
                normalized_vec1 = vec1 / (np.linalg.norm(vec1, axis=-1, keepdims=True) + 1e-10)
                vec2 = squares_rolldown - squares
                normalized_vec2 = vec2 / (np.linalg.norm(vec2, axis=-1, keepdims=True) + 1e-10)
                inner_products = np.sum(normalized_vec1 * normalized_vec2, axis=-1) # [n_squares, 4]
                squares_degree = np.arccos(inner_products) * 180 / np.pi # [n_squares, 4]
                
                # get square score
                overlap_scores = []
                degree_scores = []
                length_scores = []
                for connects, segments, square, degree in zip(connect_array, segments_array, squares, squares_degree):
                    '''
                    0 -- 1
                    |    |
                    3 -- 2
                    
                    # segments: [4, 2]
                    # connects: [4]
                    '''
                    
                    ###################################### OVERLAP SCORES
                    cover = 0
                    perimeter = 0
                    # check 0 > 1 > 2 > 3
                    square_length = []
                    
                    for start_idx in range(4):
                        end_idx = (start_idx + 1) % 4
                        
                        connect_idx = connects[start_idx] # segment idx of segment01
                        start_segments = segments[start_idx]
                        end_segments = segments[end_idx]
                        
                        start_point = square[start_idx]
                        end_point = square[end_idx]
                        
                        # check whether outside or inside
                        start_position, start_min, start_cover_param, start_peri_param = check_outside_inside(start_segments, connect_idx)
                        end_position, end_min, end_cover_param, end_peri_param = check_outside_inside(end_segments, connect_idx)
                        
                        cover += dist_segments[connect_idx] + start_cover_param * start_min + end_cover_param * end_min
                        perimeter += dist_segments[connect_idx] + start_peri_param * start_min + end_peri_param * end_min
                        
                        square_length.append(dist_segments[connect_idx] + start_peri_param * start_min + end_peri_param * end_min)
                    
                    overlap_scores.append(cover / perimeter)    
                    ######################################
                    ###################################### DEGREE SCORES
                    '''
                    deg0 vs deg2
                    deg1 vs deg3
                    '''
                    deg0, deg1, deg2, deg3 = degree
                    deg_ratio1 = deg0 / deg2
                    if deg_ratio1 > 1.0:
                        deg_ratio1 = 1 / deg_ratio1
                    deg_ratio2 = deg1 / deg3
                    if deg_ratio2 > 1.0:
                        deg_ratio2 = 1 / deg_ratio2
                    degree_scores.append((deg_ratio1 + deg_ratio2) / 2)
                    ######################################
                    ###################################### LENGTH SCORES
                    '''
                    len0 vs len2
                    len1 vs len3
                    '''
                    len0, len1, len2, len3 = square_length
                    len_ratio1 = len0 / len2 if len2 > len0 else len2 / len0
                    len_ratio2 = len1 / len3 if len3 > len1 else len3 / len1
                    length_scores.append((len_ratio1 + len_ratio2) / 2)

                    ######################################
                
                overlap_scores = np.array(overlap_scores)
                overlap_scores /= np.max(overlap_scores)
                    
                degree_scores = np.array(degree_scores)
                #degree_scores /= np.max(degree_scores)
                
                length_scores = np.array(length_scores)

                ###################################### AREA SCORES
                area_scores = np.reshape(squares, [-1, 4, 2])
                area_x = area_scores[:,:,0]
                area_y = area_scores[:,:,1]
                correction = area_x[:,-1] * area_y[:,0] - area_y[:,-1] * area_x[:,0]
                area_scores = np.sum(area_x[:,:-1] * area_y[:,1:], axis=-1) - np.sum(area_y[:,:-1] * area_x[:,1:], axis=-1)
                area_scores = 0.5 * np.abs(area_scores + correction)
                area_scores /= (map_size * map_size) #np.max(area_scores)
                ######################################
                
                ###################################### CENTER SCORES
                centers = np.array([[256 // 2, 256 // 2]], dtype='float32') # [1, 2]
                # squares: [n, 4, 2]
                square_centers = np.mean(squares, axis=1) # [n, 2]
                center2center = np.sqrt(np.sum((centers - square_centers) ** 2, axis=1))
                center_scores = center2center / (map_size / np.sqrt(2.0))


                '''
                score_w = [overlap, degree, area, center, length]
                '''
                score_w = [0.0, 1.0, 10.0, 0.5, 1.0]
                score_array = params['w_overlap'] * overlap_scores \
                                + params['w_degree'] * degree_scores \
                                + params['w_area'] * area_scores \
                                - params['w_center'] * center_scores \
                                + params['w_length'] * length_scores

                best_square = []

                sorted_idx = np.argsort(score_array)[::-1]
                score_array = score_array[sorted_idx]
                squares = squares[sorted_idx]

            except Exception as e:
                pass
            try:
                squares[:,:,0] = squares[:,:,0] * 2 / input_shape[1] * original_shape[1]
                squares[:,:,1] = squares[:,:,1] * 2 / input_shape[0] * original_shape[0]
            except:
                squares = []
 
            return squares[0]

        def pooling(acc_map, f, stride=None, method='max', pad=False,
                          return_max_pos=False):
            acc_map_s1, acc_map_s2 = acc_map.shape[0], acc_map.shape[1]
            acc_map_concat = np.concatenate([np.zeros((2, acc_map_s2)), acc_map, np.zeros((2, acc_map_s2))], axis=0)
            mat = np.concatenate([np.zeros((acc_map_s1 + 4, 2)), acc_map_concat, np.zeros((acc_map_s1 + 4, 2))], axis=1)
            
            m, n = mat.shape[:2]
            if stride is None:
                stride = f
            _ceil = lambda x, y: x//y + 1
            if pad:
                ny = _ceil(m, stride)
                nx = _ceil(n, stride)
                size = ((ny-1)*stride+f, (nx-1)*stride+f) + mat.shape[2:]
                mat_pad = np.full(size, 0)
                mat_pad[:m, :n, ...] = mat
            else:
                mat_pad = mat[:(m-f)//stride*stride+f, :(n-f)//stride*stride+f, ...]
            view = asStride(mat_pad, (f, f), stride)
            if method == 'max':
                result = np.nanmax(view, axis=(2, 3), keepdims=return_max_pos)
            else:
                result = np.nanmean(view, axis=(2, 3), keepdims=return_max_pos)
            if return_max_pos:
                pos = np.where(result == view, 1, 0)
                result = np.squeeze(result)
                return result, pos
            else:
                return result

        def asStride(arr, sub_shape, stride):
            s0, s1 = arr.strides[:2]
            m1, n1 = arr.shape[:2]
            m2, n2 = sub_shape[:2]
            view_shape = (1+(m1-m2)//stride, 1+(n1-n2)//stride, m2, n2)+arr.shape[2:]
            strides = (stride*s0, stride*s1, s0, s1)+arr.strides[2:]
            subs = np.lib.stride_tricks.as_strided(
                arr, view_shape, strides=strides, writeable=False)
            return subs

        def top_k(array, n):
            flat = array.flatten()
            indices = np.argpartition(flat, -n)[-n:]
            indices = indices[np.argsort(-flat[indices])]
            return flat[indices], indices

        square = pred_squares(pts, pts_score, vmap)
    `);
  return pyodide.globals.get("square").toJs();
}

async function load(model_path) {
  let tfjsModel = await tf.loadGraphModel(model_path);
  let preheat = tf.zeros([1, 320, 320, 3]).toFloat();
  tfjsModel.predict(preheat);

  let pyodide = await loadPyodide();
  await pyodide.loadPackage("numpy");
  await pyodide.runPythonAsync(`
            import os
            import numpy as np
        `);

  return [tfjsModel, pyodide];
}

async function detect(img, model) {
  let [tfjsModel, pyodide] = model;
  let [pts, pts_score, vmap] = inference_tfjs(img, tfjsModel);

  let square = [];
  try {
    if (WebAssembly) {
      console.log("Running WebAssembly 💻");
      square = await pred_squares(pyodide, pts, pts_score, vmap);
    } else {
      console.log("Running numjs 💿");
      square = pred_squares_numjs(pts, pts_score, vmap);
    }
  } catch (error) {
    square = [];
  }
  return square;
}

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
(function (global, factory) {
  typeof exports === 'object' && typeof module !== 'undefined' ? factory(exports, require('@tensorflow/tfjs-core'), require('path'), require('fs'), require('worker_threads'), require('perf_hooks'), require('os')) :
  typeof define === 'function' && define.amd ? define(['exports', '@tensorflow/tfjs-core', 'path', 'fs', 'worker_threads', 'perf_hooks', 'os'], factory) :
  (global = global || self, factory((global.tf = global.tf || {}, global.tf.wasm = global.tf.wasm || {}), global.tf, global.path, global.fs, global.worker_threads, global.perf_hooks, global.os));
}(undefined, (function (exports, tfjsCore, path, fs, worker_threads, perf_hooks, os) {
  path = path && Object.prototype.hasOwnProperty.call(path, 'default') ? path['default'] : path;
  fs = fs && Object.prototype.hasOwnProperty.call(fs, 'default') ? fs['default'] : fs;
  worker_threads = worker_threads && Object.prototype.hasOwnProperty.call(worker_threads, 'default') ? worker_threads['default'] : worker_threads;
  perf_hooks = perf_hooks && Object.prototype.hasOwnProperty.call(perf_hooks, 'default') ? perf_hooks['default'] : perf_hooks;
  os = os && Object.prototype.hasOwnProperty.call(os, 'default') ? os['default'] : os;

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
  var wasmFusedMatMul;
  function setup(backend) {
      wasmFusedMatMul = backend.wasm.cwrap(tfjsCore._FusedMatMul, null /* void */, [
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
      var inputs = args.inputs, backend = args.backend, attrs = args.attrs;
      var a = inputs.a, b = inputs.b, bias = inputs.bias, preluActivationWeights = inputs.preluActivationWeights;
      if (a.dtype !== 'float32' || b.dtype !== 'float32') {
          throw new Error("_FusedMatMul for non non-float32 tensors not yet supported.");
      }
      var transposeA = attrs.transposeA, transposeB = attrs.transposeB, activation = attrs.activation, leakyreluAlpha = attrs.leakyreluAlpha;
      var aId = backend.dataIdMap.get(a.dataId).id;
      var bId = backend.dataIdMap.get(b.dataId).id;
      var biasId = 0;
      if (bias != null) {
          var biasData = backend.dataIdMap.get(bias.dataId);
          if (biasData.shape.length !== 1) {
              throw new Error("_FusedMatMul only supports rank-1 bias but got " +
                  ("rank " + biasData.shape.length + "."));
          }
          biasId = biasData.id;
      }
      var preluActivationWeightsId = preluActivationWeights == null ?
          0 :
          backend.dataIdMap.get(preluActivationWeights.dataId).id;
      var fusedActivation = FusableActivation[activation];
      if (fusedActivation == null) {
          throw new Error(activation + " activation not yet supported for FusedConv2D " +
              "in the wasm backend.");
      }
      var leftDim = transposeA ? a.shape[2] : a.shape[1];
      var rightDim = transposeB ? b.shape[1] : b.shape[2];
      var batchDims = tfjsCore.broadcast_util.assertAndGetBroadcastShape(a.shape.slice(0, -2), b.shape.slice(0, -2));
      var out = backend.makeOutput(batchDims.concat([leftDim, rightDim]), a.dtype);
      var outId = backend.dataIdMap.get(out.dataId).id;
      var aShapeBytes = new Uint8Array(new Int32Array(a.shape).buffer);
      var bShapeBytes = new Uint8Array(new Int32Array(b.shape).buffer);
      wasmFusedMatMul(aId, aShapeBytes, a.shape.length, bId, bShapeBytes, b.shape.length, transposeA, transposeB, fusedActivation, biasId, preluActivationWeightsId, leakyreluAlpha || 0, outId);
      return out;
  }
  var _fusedMatMulConfig = {
      kernelName: tfjsCore._FusedMatMul,
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
      var wasmFunc;
      function setupFunc(backend) {
          wasmFunc = backend.wasm.cwrap(kernelName, null /* void */, [
              'number',
              'number',
              'number',
          ]);
      }
      function kernelFunc(args) {
          var backend = args.backend, x = args.inputs.x;
          var xId = backend.dataIdMap.get(x.dataId).id;
          var out = backend.makeOutput(x.shape, outType || x.dtype);
          var outId = backend.dataIdMap.get(out.dataId).id;
          // Short-circuit zero-sized tensors.
          if (tfjsCore.util.sizeFromShape(out.shape) === 0) {
              return out;
          }
          wasmFunc(xId, CppDType[x.dtype], outId);
          return out;
      }
      return { kernelName: kernelName, backendName: 'wasm', setupFunc: setupFunc, kernelFunc: kernelFunc };
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
  var absConfig = createUnaryKernelConfig(tfjsCore.Abs);

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
      var wasmFunc;
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
          var backend = args.backend, inputs = args.inputs;
          var a = inputs.a, b = inputs.b;
          var aId = backend.dataIdMap.get(a.dataId).id;
          var bId = backend.dataIdMap.get(b.dataId).id;
          var outputType = dtype != null ? dtype : a.dtype;
          var newShape = tfjsCore.backend_util.assertAndGetBroadcastShape(a.shape, b.shape);
          var out = backend.makeOutput(newShape, outputType);
          // Short-circuit zero-sized tensors.
          if (tfjsCore.util.sizeFromShape(newShape) === 0) {
              return out;
          }
          var aShapeBytes = new Uint8Array(new Int32Array(a.shape).buffer);
          var bShapeBytes = new Uint8Array(new Int32Array(b.shape).buffer);
          var outId = backend.dataIdMap.get(out.dataId).id;
          var kernelFunc = function () { return wasmFunc(aId, aShapeBytes, a.shape.length, bId, bShapeBytes, b.shape.length, CppDType[a.dtype], outId); };
          kernelFunc();
          return out;
      }
      return { kernelName: kernelName, backendName: 'wasm', setupFunc: setupFunc, kernelFunc: kernelFunc };
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
  var addConfig = createBinaryKernelConfig(tfjsCore.Add);

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
  var wasmFunc;
  function setupFunc(backend) {
      wasmFunc = backend.wasm.cwrap(tfjsCore.AddN, null /* void */, [
          'array',
          'number',
          'number',
          'number',
      ]);
  }
  function addn(args) {
      var inputs = args.inputs, backend = args.backend;
      var out = backend.makeOutput(inputs[0].shape, inputs[0].dtype);
      // Short-circuit zero-sized tensors.
      if (tfjsCore.util.sizeFromShape(out.shape) === 0) {
          return out;
      }
      var inputIds = inputs.map(function (x) { return backend.dataIdMap.get(x.dataId).id; });
      var inputIdsBytes = new Uint8Array(new Int32Array(inputIds).buffer);
      var outId = backend.dataIdMap.get(out.dataId).id;
      wasmFunc(inputIdsBytes, inputIds.length, CppDType[out.dtype], outId);
      return out;
  }
  var addNConfig = {
      kernelName: tfjsCore.AddN,
      backendName: 'wasm',
      setupFunc: setupFunc,
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
      var x = args.inputs.x, backend = args.backend;
      var out = backend.makeOutput(x.shape, x.dtype);
      var inVals = backend.typedArrayFromHeap(x);
      var outVals = backend.typedArrayFromHeap(out);
      outVals.set(inVals);
      return out;
  }
  var identityConfig = {
      kernelName: tfjsCore.Identity,
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
  var wasmTranspose;
  function setup$1(backend) {
      wasmTranspose = backend.wasm.cwrap(tfjsCore.Transpose, null /* void */, [
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
      var inputs = args.inputs, backend = args.backend, attrs = args.attrs;
      // Reduce any dimensions with size one. Lower-rank transpose kernel performs
      // better due to simpler memory access pattern.
      var _a = removeOneSizeDims(inputs.x.shape, attrs.perm), reducedShape = _a[0], perm = _a[1];
      var permIsNoOp = true;
      for (var i = 0; i < perm.length; i++) {
          if (perm[i] !== i) {
              permIsNoOp = false;
          }
      }
      var outShape = computeOutShape(inputs.x.shape, attrs.perm);
      var x = {
          dataId: inputs.x.dataId,
          shape: reducedShape,
          dtype: inputs.x.dtype
      };
      if (permIsNoOp) {
          var cloned = identity({ inputs: inputs, backend: backend });
          cloned.shape = outShape;
          return cloned;
      }
      var out = backend.makeOutput(outShape, x.dtype);
      var xId = backend.dataIdMap.get(x.dataId).id;
      var outId = backend.dataIdMap.get(out.dataId).id;
      var permBytes = new Uint8Array(new Int32Array(perm).buffer);
      var xShapeBytes = new Uint8Array(new Int32Array(x.shape).buffer);
      wasmTranspose(xId, xShapeBytes, x.shape.length, CppDType[x.dtype], outId, permBytes, perm.length);
      return out;
  }
  function computeOutShape(inShape, perm) {
      var outShape = new Array(inShape.length);
      for (var i = 0; i < outShape.length; i++) {
          outShape[i] = inShape[perm[i]];
      }
      return outShape;
  }
  function removeOneSizeDims(shape, perm) {
      var newShape = [];
      var newPerm = [];
      for (var i = 0; i < shape.length; ++i) {
          if (shape[i] !== 1) {
              newShape.push(shape[i]);
          }
          if (shape[perm[i]] !== 1) {
              newPerm.push(perm[i]);
          }
      }
      for (var i = 0; i < newPerm.length; ++i) {
          var minValIdx = -1;
          for (var j = 0; j < newPerm.length; ++j) {
              if (newPerm[j] >= i &&
                  (minValIdx === -1 || newPerm[minValIdx] > newPerm[j])) {
                  minValIdx = j;
              }
          }
          newPerm[minValIdx] = i;
      }
      return [newShape, newPerm];
  }
  var transposeConfig = {
      kernelName: tfjsCore.Transpose,
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
      var xShape = x.shape;
      var xRank = x.shape.length;
      var originalAxes = tfjsCore.util.parseAxisParam(axis, xShape);
      var axes = originalAxes;
      var permutedAxes = tfjsCore.backend_util.getAxesPermutation(axes, xRank);
      var xTransposed = null;
      var inputWasTransposed = false;
      if (permutedAxes != null) {
          var newShape = new Array(xRank);
          for (var i = 0; i < newShape.length; i++) {
              newShape[i] = xShape[permutedAxes[i]];
          }
          axes = tfjsCore.backend_util.getInnerMostAxes(axes.length, xRank);
          xTransposed =
              transpose({ inputs: { x: x }, attrs: { perm: permutedAxes }, backend: backend });
          var xId = backend.dataIdMap.get(x.dataId).id;
          var transposedId = backend.dataIdMap.get(xTransposed.dataId).id;
          if (transposedId !== xId) {
              inputWasTransposed = true;
          }
      }
      return { transposed: xTransposed, originalAxes: originalAxes, axes: axes, inputWasTransposed: inputWasTransposed };
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
  var wasmAll;
  function setup$2(backend) {
      wasmAll = backend.wasm.cwrap(tfjsCore.All, null /*void*/, ['number, number, number']);
  }
  function all(args) {
      var backend = args.backend, inputs = args.inputs, attrs = args.attrs;
      var axis = attrs.axis, keepDims = attrs.keepDims;
      var x = inputs.x;
      var xId = backend.dataIdMap.get(x.dataId).id;
      var inputId = xId;
      var input = x;
      var _a = permuteAxesAndTranspose(x, axis, backend), transposed = _a.transposed, axes = _a.axes, originalAxes = _a.originalAxes, inputWasTransposed = _a.inputWasTransposed;
      if (inputWasTransposed) {
          var transposedId = backend.dataIdMap.get(transposed.dataId).id;
          input = transposed;
          inputId = transposedId;
      }
      var inputRank = input.shape.length;
      tfjsCore.backend_util.assertAxesAreInnerMostDims('all', axes, inputRank);
      var _b = tfjsCore.backend_util.computeOutAndReduceShapes(input.shape, axes), outShape = _b[0], reduceShape = _b[1];
      var reduceSize = tfjsCore.util.sizeFromShape(reduceShape);
      var out = backend.makeOutput(outShape, x.dtype);
      if (tfjsCore.util.sizeFromShape(input.shape) !== 0) {
          var outId = backend.dataIdMap.get(out.dataId).id;
          wasmAll(inputId, reduceSize, outId);
      }
      if (inputWasTransposed) {
          // dispose of the transposed tensor.
          backend.disposeData(transposed.dataId);
      }
      if (keepDims) {
          // reshape
          var newShape = tfjsCore.backend_util.expandShapeToKeepDim(out.shape, originalAxes);
          out.shape = newShape;
      }
      return out;
  }
  var allConfig = {
      kernelName: tfjsCore.All,
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
  var wasmAny;
  function setup$3(backend) {
      wasmAny = backend.wasm.cwrap(tfjsCore.Any, null /*void*/, ['number, number, number']);
  }
  function any(args) {
      var backend = args.backend, inputs = args.inputs, attrs = args.attrs;
      var axis = attrs.axis, keepDims = attrs.keepDims;
      var x = inputs.x;
      var xId = backend.dataIdMap.get(x.dataId).id;
      var inputId = xId;
      var input = x;
      var _a = permuteAxesAndTranspose(x, axis, backend), transposed = _a.transposed, axes = _a.axes, originalAxes = _a.originalAxes, inputWasTransposed = _a.inputWasTransposed;
      if (inputWasTransposed) {
          var transposedId = backend.dataIdMap.get(transposed.dataId).id;
          input = transposed;
          inputId = transposedId;
      }
      var inputRank = input.shape.length;
      tfjsCore.backend_util.assertAxesAreInnerMostDims('any', axes, inputRank);
      var _b = tfjsCore.backend_util.computeOutAndReduceShapes(input.shape, axes), outShape = _b[0], reduceShape = _b[1];
      var reduceSize = tfjsCore.util.sizeFromShape(reduceShape);
      var out = backend.makeOutput(outShape, x.dtype);
      if (tfjsCore.util.sizeFromShape(input.shape) !== 0) {
          var outId = backend.dataIdMap.get(out.dataId).id;
          wasmAny(inputId, reduceSize, outId);
      }
      if (inputWasTransposed) {
          // dispose of the transposed tensor.
          backend.disposeData(transposed.dataId);
      }
      if (keepDims) {
          // reshape
          var newShape = tfjsCore.backend_util.expandShapeToKeepDim(out.shape, originalAxes);
          out.shape = newShape;
      }
      return out;
  }
  var anyConfig = {
      kernelName: tfjsCore.Any,
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
  var wasmFunc$1;
  function setup$4(backend) {
      wasmFunc$1 = backend.wasm.cwrap(tfjsCore.ArgMax, null /* void */, [
          'number',
          'number',
          'number',
          'number',
          'number' // out_id
      ]);
  }
  function argmax(args) {
      var backend = args.backend, inputs = args.inputs, attrs = args.attrs;
      var axis = attrs.axis;
      var x = inputs.x;
      var xId = backend.dataIdMap.get(x.dataId).id;
      var inputId = xId;
      var input = x;
      var _a = permuteAxesAndTranspose(x, axis, backend), transposed = _a.transposed, axes = _a.axes, inputWasTransposed = _a.inputWasTransposed;
      if (inputWasTransposed) {
          var transposedId = backend.dataIdMap.get(transposed.dataId).id;
          if (transposedId !== xId) {
              // transpose was not a no-op. We will need to dispose of this
              // once we are done.
              input = transposed;
              inputId = transposedId;
          }
      }
      var outShape = input.shape.slice(0, -1);
      var out = backend.makeOutput(outShape, 'int32');
      var outId = backend.dataIdMap.get(out.dataId).id;
      var outerSize = tfjsCore.util.sizeFromShape(out.shape);
      var innerSize = input.shape[axes[0]];
      wasmFunc$1(inputId, CppDType[input.dtype], outerSize, innerSize, outId);
      if (inputWasTransposed) {
          // dispose of the transposed tensor.
          backend.disposeData(transposed.dataId);
      }
      return out;
  }
  var argMaxConfig = {
      kernelName: tfjsCore.ArgMax,
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
  var wasmAvgPool;
  function setup$5(backend) {
      wasmAvgPool = backend.wasm.cwrap(tfjsCore.AvgPool, null /* void */, [
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
      var inputs = args.inputs, attrs = args.attrs, backend = args.backend;
      var x = inputs.x;
      var xId = backend.dataIdMap.get(x.dataId).id;
      var filterSize = attrs.filterSize, strides = attrs.strides, pad = attrs.pad, dimRoundingMode = attrs.dimRoundingMode;
      var convInfo = tfjsCore.backend_util.computePool2DInfo(x.shape, filterSize, strides, 1 /* dilations */, pad, dimRoundingMode);
      var filterHeight = convInfo.filterHeight;
      var filterWidth = convInfo.filterWidth;
      var padTop = convInfo.padInfo.top;
      var padRight = convInfo.padInfo.right;
      var padBottom = convInfo.padInfo.bottom;
      var padLeft = convInfo.padInfo.left;
      var strideHeight = convInfo.strideHeight;
      var strideWidth = convInfo.strideWidth;
      var channels = convInfo.inChannels;
      if (convInfo.dataFormat !== 'channelsLast') {
          throw new Error("wasm backend does not support dataFormat:'" +
              (convInfo.dataFormat + "'. Please use 'channelsLast'."));
      }
      if (convInfo.dilationWidth !== 1 || convInfo.dilationHeight !== 1) {
          throw new Error("was backend only supports average pooling with dilation = [1, 1], " +
              ("got [" + convInfo.dilationHeight + ", " + convInfo.dilationWidth + "]."));
      }
      var out = backend.makeOutput(convInfo.outShape, 'float32');
      var outId = backend.dataIdMap.get(out.dataId).id;
      wasmAvgPool(xId, x.shape[0], x.shape[1], x.shape[2], filterHeight, filterWidth, padTop, padRight, padBottom, padLeft, strideHeight, strideWidth, channels, outId);
      return out;
  }
  var avgPoolConfig = {
      kernelName: tfjsCore.AvgPool,
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
      var inputs = args.inputs, attrs = args.attrs;
      var x = inputs.x;
      var shape = attrs.shape;
      var xSize = tfjsCore.util.sizeFromShape(x.shape);
      var $shape = tfjsCore.util.inferFromImplicitShape(shape, xSize);
      tfjsCore.util.assert(xSize === tfjsCore.util.sizeFromShape($shape), function () { return "new shape: " + $shape + ", old shape: " + x.shape + ". New shape and old " +
          "shape must have the same number of elements."; });
      // Backend needs to track refCount for the dataId for reshape op
      args.backend.incRef(x.dataId);
      return { dataId: x.dataId, shape: $shape, dtype: x.dtype };
  }
  var reshapeConfig = {
      kernelName: tfjsCore.Reshape,
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
  var wasmBatchMatMul;
  function setup$6(backend) {
      wasmBatchMatMul = backend.wasm.cwrap(tfjsCore.BatchMatMul, null /* void */, [
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
      var inputs = args.inputs, backend = args.backend, attrs = args.attrs;
      var a = inputs.a, b = inputs.b;
      var transposeA = attrs.transposeA, transposeB = attrs.transposeB;
      if (a.dtype !== 'float32' || b.dtype !== 'float32') {
          throw new Error("BatchMatMul for non non-float32 tensors not yet supported.");
      }
      var aRank = a.shape.length;
      var bRank = b.shape.length;
      var innerShapeA = transposeA ? a.shape[aRank - 2] : a.shape[aRank - 1];
      var innerShapeB = transposeB ? b.shape[bRank - 1] : b.shape[bRank - 2];
      var outerShapeA = transposeA ? a.shape[aRank - 1] : a.shape[aRank - 2];
      var outerShapeB = transposeB ? b.shape[bRank - 2] : b.shape[bRank - 1];
      var outerDimsA = a.shape.slice(0, -2);
      var outerDimsB = b.shape.slice(0, -2);
      var batchDimA = tfjsCore.util.sizeFromShape(outerDimsA);
      var batchDimB = tfjsCore.util.sizeFromShape(outerDimsB);
      var outShapeOuterDims = tfjsCore.broadcast_util.assertAndGetBroadcastShape(a.shape.slice(0, -2), b.shape.slice(0, -2));
      var outShape = outShapeOuterDims.concat([outerShapeA, outerShapeB]);
      tfjsCore.util.assert(innerShapeA === innerShapeB, function () { return "Error in matMul: inner shapes (" + innerShapeA + ") and (" +
          (innerShapeB + ") of Tensors with shapes " + a.shape + " and ") +
          (b.shape + " and transposeA=" + transposeA) +
          (" and transposeB=" + transposeB + " must match."); });
      var a3dShape = transposeA ? [batchDimA, innerShapeA, outerShapeA] :
          [batchDimA, outerShapeA, innerShapeA];
      var b3dShape = transposeB ? [batchDimB, outerShapeB, innerShapeB] :
          [batchDimB, innerShapeB, outerShapeB];
      // The rest of the implementation is designed to operate on rank-3 tensors
      var a3d = reshape({ inputs: { x: a }, backend: backend, attrs: { shape: a3dShape } });
      var b3d = reshape({ inputs: { x: b }, backend: backend, attrs: { shape: b3dShape } });
      var a3dId = backend.dataIdMap.get(a3d.dataId).id;
      var b3dId = backend.dataIdMap.get(b3d.dataId).id;
      var leftDim = transposeA ? a3d.shape[2] : a3d.shape[1];
      var rightDim = transposeB ? b3d.shape[1] : b3d.shape[2];
      var batchDim = Math.max(batchDimA, batchDimB);
      var out = backend.makeOutput([batchDim, leftDim, rightDim], a3d.dtype);
      var outId = backend.dataIdMap.get(out.dataId).id;
      var aShapeBytes = new Uint8Array(new Int32Array(a3d.shape).buffer);
      var bShapeBytes = new Uint8Array(new Int32Array(b3d.shape).buffer);
      wasmBatchMatMul(a3dId, aShapeBytes, a3d.shape.length, b3dId, bShapeBytes, b3d.shape.length, transposeA, transposeB, outId);
      backend.disposeData(a3d.dataId);
      backend.disposeData(b3d.dataId);
      out.shape = outShape;
      return out;
  }
  var batchMatMulConfig = {
      kernelName: tfjsCore.BatchMatMul,
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
      const outVals = tfjsCore.util.getArrayFromDType(dtype, tfjsCore.util.sizeFromShape(outShape));
      if (simplyConcat && dtype !== 'string') {
          // Use built-in TypedArray.set() method for speed.
          let offset = 0;
          inputs.forEach(input => {
              const size = tfjsCore.util.sizeFromShape(input.shape);
              outVals.set(input.vals, offset);
              offset += size;
          });
      }
      else {
          let colOffset = 0;
          inputs.forEach(input => {
              const decodedData = dtype === 'string' ?
                  tfjsCore.backend_util.fromUint8ToStringArray(input.vals) :
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
          return tfjsCore.util.makeZerosTypedArray(0, dtype);
      }
      const numElements = Math.abs(Math.ceil((stop - start) / step));
      const values = tfjsCore.util.makeZerosTypedArray(numElements, dtype);
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
      const isContinous = tfjsCore.slice_util.isSliceContinous(shape, begin, size);
      const length = tfjsCore.util.sizeFromShape(size);
      const xStrides = tfjsCore.util.computeStrides(shape);
      if (isContinous) {
          const flatOffset = tfjsCore.slice_util.computeFlatOffset(begin, xStrides);
          if (dtype === 'string') {
              return vals.slice(flatOffset, flatOffset + length);
          }
          return vals.subarray(flatOffset, flatOffset + length);
      }
      const decodedData = dtype === 'string' ?
          tfjsCore.backend_util.fromUint8ToStringArray(vals) :
          vals;
      const inBuf = tfjsCore.buffer(shape, dtype, decodedData);
      const outBuf = tfjsCore.buffer(size, dtype);
      for (let i = 0; i < outBuf.size; ++i) {
          const outLoc = outBuf.indexToLoc(i);
          const inLoc = outLoc.map((idx, j) => idx + begin[j]);
          outBuf.set(inBuf.get(...inLoc), ...outLoc);
      }
      if (dtype === 'string') {
          return tfjsCore.backend_util.fromStringArrayToUint8(outBuf.values);
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
      var x = args.inputs.x, _a = args.attrs, begin = _a.begin, size = _a.size, backend = args.backend;
      var _b = tfjsCore.slice_util.parseSliceParams(x, begin, size), begin_ = _b[0], size_ = _b[1];
      var isContinous = tfjsCore.slice_util.isSliceContinous(x.shape, begin_, size_);
      var xVals = backend.readSync(x.dataId);
      var out = backend.makeOutput(size_, x.dtype);
      var xStrides = tfjsCore.util.computeStrides(x.shape);
      var outData = backend.dataIdMap.get(out.dataId);
      if (isContinous) {
          var flatOffset = tfjsCore.slice_util.computeFlatOffset(begin_, xStrides);
          if (x.dtype === 'string') {
              outData.stringBytes =
                  xVals
                      .slice(flatOffset, flatOffset + tfjsCore.util.sizeFromShape(size_));
          }
          else {
              var outVals_1 = backend.typedArrayFromHeap(out);
              outVals_1.set(xVals
                  .subarray(flatOffset, flatOffset + tfjsCore.util.sizeFromShape(size_)));
          }
          return out;
      }
      if (x.dtype === 'string') {
          var res = sliceImpl(xVals, begin_, size_, x.shape, x.dtype);
          outData.stringBytes = res;
          return out;
      }
      var outVals = backend.typedArrayFromHeap(out);
      var rank = x.shape.length;
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
          var res = sliceImpl(xVals, begin_, size_, x.shape, x.dtype);
          outVals.set(res);
      }
      return out;
  }
  function slice2d(xVals, xStride, outVals, begin, size) {
      var outOffset = 0;
      var beginI = begin[0];
      var beginJ = begin[1];
      var endI = beginI + size[0];
      for (var i = beginI; i < endI; i++) {
          var xOffset = i * xStride + beginJ;
          outVals.set(xVals.subarray(xOffset, xOffset + size[1]), outOffset);
          outOffset += size[1];
      }
  }
  function slice3d(xVals, xStride1, xStride2, outVals, begin, size) {
      var outOffset = 0;
      var beginI = begin[0];
      var beginJ = begin[1];
      var beginK = begin[2];
      var endI = beginI + size[0];
      var endJ = beginJ + size[1];
      for (var i = beginI; i < endI; i++) {
          for (var j = beginJ; j < endJ; j++) {
              var xOffset = i * xStride1 + j * xStride2 + beginK;
              outVals.set(xVals.subarray(xOffset, xOffset + size[2]), outOffset);
              outOffset += size[2];
          }
      }
  }
  function slice4d(xVals, xStride1, xStride2, xStride3, outVals, begin, size) {
      var outOffset = 0;
      var beginI = begin[0];
      var beginJ = begin[1];
      var beginK = begin[2];
      var endI = beginI + size[0];
      var endJ = beginJ + size[1];
      var endK = beginK + size[2];
      var beginL = begin[3];
      for (var i = beginI; i < endI; i++) {
          for (var j = beginJ; j < endJ; j++) {
              for (var k = beginK; k < endK; k++) {
                  var xOffset = i * xStride1 + j * xStride2 + k * xStride3 + beginL;
                  outVals.set(xVals.subarray(xOffset, xOffset + size[3]), outOffset);
                  outOffset += size[3];
              }
          }
      }
  }
  var sliceConfig = {
      kernelName: tfjsCore.Slice,
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
      var inputs = args.inputs, backend = args.backend, attrs = args.attrs;
      var x = inputs.x;
      var blockShape = attrs.blockShape, crops = attrs.crops;
      var prod = blockShape.reduce(function (a, b) { return a * b; });
      var reshaped = tfjsCore.backend_util.getReshaped(x.shape, blockShape, prod);
      var permuted = tfjsCore.backend_util.getPermuted(reshaped.length, blockShape.length);
      var reshapedPermuted = tfjsCore.backend_util.getReshapedPermuted(x.shape, blockShape, prod);
      var sliceBeginCoords = tfjsCore.backend_util.getSliceBeginCoords(crops, blockShape.length);
      var sliceSize = tfjsCore.backend_util.getSliceSize(reshapedPermuted, crops, blockShape.length);
      var xReshaped = reshape({ inputs: { x: x }, backend: backend, attrs: { shape: reshaped } });
      var xTransposed = transpose({ inputs: { x: xReshaped }, backend: backend, attrs: { perm: permuted } });
      var xTransposedReshaped = reshape({ inputs: { x: xTransposed }, backend: backend, attrs: { shape: reshapedPermuted } });
      var result = slice({
          inputs: { x: xTransposedReshaped },
          backend: backend,
          attrs: { begin: sliceBeginCoords, size: sliceSize }
      });
      backend.disposeData(xReshaped.dataId);
      backend.disposeData(xTransposed.dataId);
      backend.disposeData(xReshaped.dataId);
      return result;
  }
  var batchToSpaceNDConfig = {
      kernelName: tfjsCore.BatchToSpaceND,
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
      var x = args.inputs.x, dtype = args.attrs.dtype, backend = args.backend;
      var out = backend.makeOutput(x.shape, dtype);
      var inVals = backend.typedArrayFromHeap(x);
      var outVals = backend.typedArrayFromHeap(out);
      outVals.set(inVals);
      return out;
  }
  var castConfig = {
      kernelName: tfjsCore.Cast,
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
  var ceilConfig = createUnaryKernelConfig(tfjsCore.Ceil);

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
  var wasmClip;
  function setup$7(backend) {
      wasmClip = backend.wasm.cwrap(tfjsCore.ClipByValue, null /* void */, [
          'number',
          'number',
          'number',
          'number' // out_id
      ]);
  }
  function clip(args) {
      var inputs = args.inputs, backend = args.backend, attrs = args.attrs;
      var x = inputs.x;
      var clipValueMin = attrs.clipValueMin, clipValueMax = attrs.clipValueMax;
      var xId = backend.dataIdMap.get(x.dataId).id;
      var out = backend.makeOutput(x.shape, x.dtype);
      var outId = backend.dataIdMap.get(out.dataId).id;
      wasmClip(xId, clipValueMin, clipValueMax, outId);
      return out;
  }
  var clipByValueConfig = {
      kernelName: tfjsCore.ClipByValue,
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
      var inputs = args.inputs, backend = args.backend;
      var axis = tfjsCore.util.parseAxisParam(args.attrs.axis, inputs[0].shape)[0];
      var outShape = tfjsCore.backend_util.computeOutShape(inputs.map(function (t) { return t.shape; }), axis);
      // Keep only non-empty tensors (ignore tensors with 0 in their shape).
      var $inputs = inputs.filter(function (t) { return tfjsCore.util.sizeFromShape(t.shape) > 0; });
      if ($inputs.length === 1) {
          return identity({ inputs: { x: $inputs[0] }, backend: backend });
      }
      var out = backend.makeOutput(outShape, inputs[0].dtype);
      if (tfjsCore.util.sizeFromShape(outShape) === 0) {
          return out;
      }
      var shapes = $inputs.map(function (t) { return t.shape; });
      tfjsCore.backend_util.assertParamsConsistent(shapes, axis);
      if ($inputs[0].dtype === 'string') {
          // Any concat of n-dimensional tensors across any axis can be reduced to
          // a concatenation of two-dimensional tensors across the axis 1 by first
          // partitioning the axes of the original tensors into those less than the
          // axis to be concatenated and the rest. Then reshape the tensors
          // into a two-dimensional tensor by collapsing these two sets of axes and
          // concatenate the resulting matrices across the axis 1, finally reshaping
          // the result to have the proper shape.
          var inputs2D = $inputs.map(function (t) {
              var innerSize = tfjsCore.util.sizeFromShape(t.shape.slice(axis));
              var shape = [-1, innerSize];
              return reshape({ inputs: { x: t }, backend: backend, attrs: { shape: shape } });
          });
          var inputsValShapes = inputs2D.map(function (t) {
              return { vals: backend.readSync(t.dataId), shape: t.shape };
          });
          // Concats 2d tensors along axis=1.
          outShape =
              tfjsCore.backend_util.computeOutShape(inputs2D.map(function (t) { return t.shape; }), 1 /* axis */);
          var simplyConcat = inputs2D[0].shape[0] === 1;
          var outVals_1 = concatImpl(inputsValShapes, outShape, inputs[0].dtype, simplyConcat);
          var finalOutShape = tfjsCore.backend_util.computeOutShape($inputs.map(function (t) { return t.shape; }), axis);
          out.shape = finalOutShape;
          var outData = backend.dataIdMap.get(out.dataId);
          outData.stringBytes = tfjsCore.backend_util.fromStringArrayToUint8(outVals_1);
          inputs2D.forEach(function (t) { return backend.disposeData(t.dataId); });
          return out;
      }
      var batchDim = tfjsCore.util.sizeFromShape($inputs[0].shape.slice(0, axis));
      var sumInnerDims = 0;
      var innerDims = $inputs.map(function (input) {
          var innerDim = tfjsCore.util.sizeFromShape(input.shape.slice(axis));
          sumInnerDims += innerDim;
          return innerDim;
      });
      var inVals = $inputs.map(function (input) { return backend.typedArrayFromHeap(input); });
      var outVals = backend.typedArrayFromHeap(out);
      for (var b = 0; b < batchDim; b++) {
          var outOffset = b * sumInnerDims;
          for (var i = 0; i < inVals.length; i++) {
              var innerDim = innerDims[i];
              var inOffset = b * innerDim;
              var vals = inVals[i].subarray(inOffset, inOffset + innerDim);
              outVals.set(vals, outOffset);
              outOffset += innerDim;
          }
      }
      return out;
  }
  var concatConfig = {
      kernelName: tfjsCore.Concat,
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
  var wasmConv2d;
  function setup$8(backend) {
      wasmConv2d = backend.wasm.cwrap(tfjsCore.Conv2D, null /* void */, [
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
      var inputs = args.inputs, attrs = args.attrs, backend = args.backend;
      var x = inputs.x, filter = inputs.filter;
      var xId = backend.dataIdMap.get(x.dataId).id;
      var filterId = backend.dataIdMap.get(filter.dataId).id;
      var strides = attrs.strides, dilations = attrs.dilations, pad = attrs.pad, dimRoundingMode = attrs.dimRoundingMode, dataFormat = attrs.dataFormat;
      var $dataFormat = tfjsCore.backend_util.convertConv2DDataFormat(dataFormat);
      var convInfo = tfjsCore.backend_util.computeConv2DInfo(x.shape, filter.shape, strides, dilations, pad, dimRoundingMode, false, $dataFormat);
      var filterHeight = convInfo.filterHeight;
      var filterWidth = convInfo.filterWidth;
      var padTop = convInfo.padInfo.top;
      var padRight = convInfo.padInfo.right;
      var padBottom = convInfo.padInfo.bottom;
      var padLeft = convInfo.padInfo.left;
      var dilationHeight = convInfo.dilationHeight;
      var dilationWidth = convInfo.dilationWidth;
      var strideHeight = convInfo.strideHeight;
      var strideWidth = convInfo.strideWidth;
      var inputChannels = convInfo.inChannels;
      var outputChannels = convInfo.outChannels;
      var isSamePad = convInfo.padInfo.type === 'SAME' ? 1 : 0;
      if (convInfo.dataFormat !== 'channelsLast') {
          throw new Error("wasm backend Conv2D does not support dataFormat:'" +
              (convInfo.dataFormat + "'. Please use 'channelsLast'."));
      }
      var out = backend.makeOutput(convInfo.outShape, 'float32');
      var outId = backend.dataIdMap.get(out.dataId).id;
      wasmConv2d(xId, x.shape[0], x.shape[1], x.shape[2], filterId, filterHeight, filterWidth, padTop, padRight, padBottom, padLeft, isSamePad, dilationHeight, dilationWidth, strideHeight, strideWidth, inputChannels, outputChannels, outId);
      return out;
  }
  var conv2DConfig = {
      kernelName: tfjsCore.Conv2D,
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
  var wasmConv2DBackpropInput;
  function setup$9(backend) {
      wasmConv2DBackpropInput = backend.wasm.cwrap(tfjsCore.Conv2DBackpropInput, null, [
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
      var backend = args.backend, inputs = args.inputs, attrs = args.attrs;
      var dy = inputs.dy, filter = inputs.filter;
      var strides = attrs.strides, pad = attrs.pad, dataFormat = attrs.dataFormat, dimRoundingMode = attrs.dimRoundingMode, inputShape = attrs.inputShape;
      var dilations = 1;
      var $dataFormat = tfjsCore.backend_util.convertConv2DDataFormat(dataFormat);
      var convInfo = tfjsCore.backend_util.computeConv2DInfo(inputShape, filter.shape, strides, dilations, pad, dimRoundingMode, false /* depthwise */, $dataFormat);
      var batchSize = convInfo.batchSize, filterHeight = convInfo.filterHeight, filterWidth = convInfo.filterWidth, inChannels = convInfo.inChannels, inHeight = convInfo.inHeight, inWidth = convInfo.inWidth, outChannels = convInfo.outChannels, outHeight = convInfo.outHeight, outWidth = convInfo.outWidth, strideHeight = convInfo.strideHeight, strideWidth = convInfo.strideWidth;
      var topPad = filterHeight - 1 - convInfo.padInfo.top;
      var leftPad = filterWidth - 1 - convInfo.padInfo.left;
      var isChannelsLast = convInfo.dataFormat === 'channelsLast';
      var dxStrides = tfjsCore.util.computeStrides(convInfo.inShape);
      var dyStrides = tfjsCore.util.computeStrides(dy.shape);
      var _a = tfjsCore.util.computeStrides(filter.shape), fltS0 = _a[0], fltS1 = _a[1], fltS2 = _a[2];
      var xBatchStride = dxStrides[0];
      var xRowStride = isChannelsLast ? dxStrides[1] : dxStrides[2];
      var xColStride = isChannelsLast ? dxStrides[2] : 1;
      var xChannelStride = isChannelsLast ? 1 : dxStrides[1];
      var yBatchStride = dyStrides[0];
      var yRowStride = isChannelsLast ? dyStrides[1] : dyStrides[2];
      var yColStride = isChannelsLast ? dyStrides[2] : 1;
      var yChannelStride = isChannelsLast ? 1 : dyStrides[1];
      var out = backend.makeOutput(convInfo.inShape, 'float32');
      var outId = backend.dataIdMap.get(out.dataId).id;
      var dyId = backend.dataIdMap.get(dy.dataId).id;
      var filterId = backend.dataIdMap.get(filter.dataId).id;
      wasmConv2DBackpropInput(dyId, filterId, batchSize, filterHeight, filterWidth, inHeight, inWidth, inChannels, outHeight, outWidth, outChannels, strideHeight, strideWidth, topPad, leftPad, fltS0, fltS1, fltS2, xBatchStride, xRowStride, xColStride, xChannelStride, yBatchStride, yRowStride, yColStride, yChannelStride, outId);
      return out;
  }
  var conv2DBackpropInputConfig = {
      kernelName: tfjsCore.Conv2DBackpropInput,
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
  var cosConfig = createUnaryKernelConfig(tfjsCore.Cos);

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
  var coshConfig = createUnaryKernelConfig(tfjsCore.Cosh);

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
  var wasmCropAndResize;
  function setup$a(backend) {
      wasmCropAndResize = backend.wasm.cwrap(tfjsCore.CropAndResize, null /*void*/, [
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
      var backend = args.backend, inputs = args.inputs, attrs = args.attrs;
      var method = attrs.method, extrapolationValue = attrs.extrapolationValue, cropSize = attrs.cropSize;
      var image = inputs.image, boxes = inputs.boxes, boxInd = inputs.boxInd;
      var numBoxes = boxes.shape[0];
      var _a = cropSize, cropHeight = _a[0], cropWidth = _a[1];
      var outShape = [numBoxes, cropHeight, cropWidth, image.shape[3]];
      var imagesData = backend.dataIdMap.get(image.dataId);
      var castedData;
      if (image.dtype !== 'float32') {
          castedData = cast({ backend: backend, inputs: { x: image }, attrs: { dtype: 'float32' } });
          imagesData = backend.dataIdMap.get(castedData.dataId);
      }
      var imagesId = imagesData.id;
      var boxesId = backend.dataIdMap.get(boxes.dataId).id;
      var boxIndId = backend.dataIdMap.get(boxInd.dataId).id;
      var out = backend.makeOutput(outShape, 'float32');
      var outId = backend.dataIdMap.get(out.dataId).id;
      var imagesShapeBytes = new Uint8Array(new Int32Array(image.shape).buffer);
      wasmCropAndResize(imagesId, boxesId, boxIndId, numBoxes, imagesShapeBytes, cropHeight, cropWidth, InterpolationMethod[method], extrapolationValue, outId);
      if (castedData != null) {
          backend.disposeData(castedData.dataId);
      }
      return out;
  }
  var cropAndResizeConfig = {
      kernelName: tfjsCore.CropAndResize,
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
  var wasmCumprod;
  function setup$b(backend) {
      wasmCumprod = backend.wasm.cwrap(tfjsCore.Cumprod, null /* void */, [
          'number',
          'number',
          'number',
          'number',
          'number',
          'number' // dtype
      ]);
  }
  function cumprod(args) {
      var inputs = args.inputs, backend = args.backend, attrs = args.attrs;
      var x = inputs.x;
      var axis = attrs.axis, exclusive = attrs.exclusive, reverse = attrs.reverse;
      var xRank = x.shape.length;
      tfjsCore.util.assert(x.dtype === 'float32' || x.dtype === 'int32', function () { return "cumprod does not support " + x.dtype + " tensors in the WASM backend"; });
      // permute required axis to inner most axis
      var permutation = tfjsCore.backend_util.getAxesPermutation([axis], xRank);
      var permutedX = x;
      if (permutation !== null) {
          permutedX = transpose({ inputs: { x: x }, attrs: { perm: permutation }, backend: backend });
      }
      var permutedAxis = tfjsCore.backend_util.getInnerMostAxes(1, xRank)[0];
      tfjsCore.backend_util.assertAxesAreInnerMostDims('cumprod', [permutedAxis], xRank);
      var permutedOut = backend.makeOutput(permutedX.shape, permutedX.dtype);
      var finalDim = permutedX.shape[permutedAxis];
      var permutedXId = backend.dataIdMap.get(permutedX.dataId).id;
      var permutedOutId = backend.dataIdMap.get(permutedOut.dataId).id;
      wasmCumprod(permutedXId, exclusive ? 1 : 0, reverse ? 1 : 0, finalDim, permutedOutId, CppDType[x.dtype]);
      // transpose data back if permuted
      var out = permutedOut;
      if (permutation !== null) {
          var undoPermutation = tfjsCore.backend_util.getUndoAxesPermutation(permutation);
          out = transpose({ inputs: { x: permutedOut }, attrs: { perm: undoPermutation }, backend: backend });
          backend.disposeData(permutedX.dataId);
          backend.disposeData(permutedOut.dataId);
      }
      return out;
  }
  var cumprodConfig = {
      kernelName: tfjsCore.Cumprod,
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
  var wasmCumsum;
  function setup$c(backend) {
      wasmCumsum = backend.wasm.cwrap(tfjsCore.Cumsum, null /* void */, [
          'number',
          'number',
          'number',
          'number',
          'number',
          'number' // dtype
      ]);
  }
  function cumsum(args) {
      var inputs = args.inputs, backend = args.backend, attrs = args.attrs;
      var x = inputs.x;
      var axis = attrs.axis, exclusive = attrs.exclusive, reverse = attrs.reverse;
      var xRank = x.shape.length;
      tfjsCore.util.assert(x.dtype === 'float32' || x.dtype === 'int32', function () { return "cumsum does not support " + x.dtype + " tensors in the WASM backend"; });
      // permute required axis to inner most axis
      var permutation = tfjsCore.backend_util.getAxesPermutation([axis], xRank);
      var permutedX = x;
      if (permutation !== null) {
          permutedX = transpose({ inputs: { x: x }, attrs: { perm: permutation }, backend: backend });
      }
      var permutedAxis = tfjsCore.backend_util.getInnerMostAxes(1, xRank)[0];
      tfjsCore.backend_util.assertAxesAreInnerMostDims('cumsum', [permutedAxis], xRank);
      var permutedOut = backend.makeOutput(permutedX.shape, permutedX.dtype);
      var finalDim = permutedX.shape[permutedAxis];
      var permutedXId = backend.dataIdMap.get(permutedX.dataId).id;
      var permutedOutId = backend.dataIdMap.get(permutedOut.dataId).id;
      wasmCumsum(permutedXId, exclusive ? 1 : 0, reverse ? 1 : 0, finalDim, permutedOutId, CppDType[x.dtype]);
      // transpose data back if permuted
      var out = permutedOut;
      if (permutation !== null) {
          var undoPermutation = tfjsCore.backend_util.getUndoAxesPermutation(permutation);
          out = transpose({ inputs: { x: permutedOut }, attrs: { perm: undoPermutation }, backend: backend });
          backend.disposeData(permutedX.dataId);
          backend.disposeData(permutedOut.dataId);
      }
      return out;
  }
  var cumsumConfig = {
      kernelName: tfjsCore.Cumsum,
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
  var wasmDepthToSpace;
  function setup$d(backend) {
      wasmDepthToSpace = backend.wasm.cwrap(tfjsCore.DepthToSpace, null /*void*/, [
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
      var backend = args.backend, inputs = args.inputs, attrs = args.attrs;
      var x = inputs.x;
      var blockSize = attrs.blockSize, dataFormat = attrs.dataFormat;
      var batchSize = x.shape[0];
      var inputHeight = (dataFormat === 'NHWC') ? x.shape[1] : x.shape[2];
      var inputWidth = (dataFormat === 'NHWC') ? x.shape[2] : x.shape[3];
      var inputDepth = (dataFormat === 'NHWC') ? x.shape[3] : x.shape[1];
      var outputHeight = inputHeight * blockSize;
      var outputWidth = inputWidth * blockSize;
      var outputDepth = inputDepth / (blockSize * blockSize);
      var outputShape = (dataFormat === 'NHWC') ?
          [batchSize, outputHeight, outputWidth, outputDepth] :
          [batchSize, outputDepth, outputHeight, outputWidth];
      var out = backend.makeOutput(outputShape, 'float32');
      var xData = backend.dataIdMap.get(x.dataId);
      var xId = xData.id;
      var xStridesBytes = new Uint8Array(new Int32Array(tfjsCore.util.computeStrides(x.shape)).buffer);
      var outputShapeBytes = new Uint8Array(new Int32Array(outputShape).buffer);
      var outStridesBytes = new Uint8Array(new Int32Array(tfjsCore.util.computeStrides(outputShape)).buffer);
      var outId = backend.dataIdMap.get(out.dataId).id;
      var channelsLast = dataFormat === 'NHWC' ? 1 : 0;
      wasmDepthToSpace(xId, blockSize, channelsLast, xStridesBytes, x.shape.length - 1, outputShapeBytes, outStridesBytes, outputShape.length, outId);
      return out;
  }
  var depthToSpaceConfig = {
      kernelName: tfjsCore.DepthToSpace,
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
  var wasmDepthwiseConv2d;
  function setup$e(backend) {
      wasmDepthwiseConv2d =
          backend.wasm.cwrap(tfjsCore.DepthwiseConv2dNative, null /* void */, [
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
      var inputs = args.inputs, attrs = args.attrs, backend = args.backend;
      var x = inputs.x, filter = inputs.filter;
      var xId = backend.dataIdMap.get(x.dataId).id;
      var filterId = backend.dataIdMap.get(filter.dataId).id;
      var strides = attrs.strides, dilations = attrs.dilations, pad = attrs.pad, dimRoundingMode = attrs.dimRoundingMode;
      var $dilations = dilations == null ? [1, 1] : dilations;
      var convInfo = tfjsCore.backend_util.computeConv2DInfo(x.shape, filter.shape, strides, $dilations, pad, dimRoundingMode, true /* depthwise */);
      var filterHeight = convInfo.filterHeight;
      var filterWidth = convInfo.filterWidth;
      var padTop = convInfo.padInfo.top;
      var padRight = convInfo.padInfo.right;
      var padBottom = convInfo.padInfo.bottom;
      var padLeft = convInfo.padInfo.left;
      var dilationHeight = convInfo.dilationHeight;
      var dilationWidth = convInfo.dilationWidth;
      var strideHeight = convInfo.strideHeight;
      var strideWidth = convInfo.strideWidth;
      var inputChannels = convInfo.inChannels;
      var outputChannels = convInfo.outChannels;
      var isSamePad = convInfo.padInfo.type === 'SAME' ? 1 : 0;
      if (convInfo.dataFormat !== 'channelsLast') {
          throw new Error("wasm backend DepthwiseConv2dNative does not support dataFormat:'" +
              (convInfo.dataFormat + "'. Please use 'channelsLast'."));
      }
      var out = backend.makeOutput(convInfo.outShape, 'float32');
      var outId = backend.dataIdMap.get(out.dataId).id;
      wasmDepthwiseConv2d(xId, x.shape[0], x.shape[1], x.shape[2], filterId, filterHeight, filterWidth, padTop, padRight, padBottom, padLeft, isSamePad, dilationHeight, dilationWidth, strideHeight, strideWidth, inputChannels, outputChannels, outId);
      return out;
  }
  var depthwiseConv2dNativeConfig = {
      kernelName: tfjsCore.DepthwiseConv2dNative,
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
  var eluConfig = createUnaryKernelConfig(tfjsCore.Elu);

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
  var supportsFullBroadcast = false;
  var equalConfig = createBinaryKernelConfig(tfjsCore.Equal, supportsFullBroadcast, 'bool');

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
  var expConfig = createUnaryKernelConfig(tfjsCore.Exp, 'float32');

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
      var inputs = args.inputs, attrs = args.attrs, backend = args.backend;
      var input = inputs.input;
      var dim = attrs.dim;
      var inputRank = input.shape.length;
      var newShape = input.shape.slice();
      var $dim = dim;
      if (dim < 0) {
          // Negative value is counted from the tail of rank.
          tfjsCore.util.assert(-(inputRank + 1) <= dim, function () { return "Axis must be in the interval [" + -(inputRank + 1) + ", " + inputRank + "]"; });
          $dim = inputRank + dim + 1;
      }
      newShape.splice($dim, 0, 1);
      return reshape({ inputs: { x: input }, backend: backend, attrs: { shape: newShape } });
  }
  var expandDimsConfig = {
      kernelName: tfjsCore.ExpandDims,
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
      var _a = args.attrs, shape = _a.shape, value = _a.value, dtype = _a.dtype, backend = args.backend;
      var out = backend.makeOutput(shape, dtype);
      var outVals = backend.typedArrayFromHeap(out);
      outVals.fill(value);
      return out;
  }
  var fillConfig = {
      kernelName: tfjsCore.Fill,
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
  var wasmFlipLeftRight;
  function setup$f(backend) {
      wasmFlipLeftRight = backend.wasm.cwrap(tfjsCore.FlipLeftRight, null /* void */, [
          'number',
          'number',
          'number',
          'number',
          'number',
          'number',
      ]);
  }
  function flipLeftRight(args) {
      var inputs = args.inputs, backend = args.backend;
      var image = inputs.image;
      var out = backend.makeOutput(image.shape, image.dtype);
      var imageId = backend.dataIdMap.get(image.dataId).id;
      var outId = backend.dataIdMap.get(out.dataId).id;
      var _a = image.shape, batch = _a[0], imageHeight = _a[1], imageWidth = _a[2], numChannels = _a[3];
      wasmFlipLeftRight(imageId, batch, imageHeight, imageWidth, numChannels, outId);
      return out;
  }
  var flipLeftRightConfig = {
      kernelName: tfjsCore.FlipLeftRight,
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
  var floorConfig = createUnaryKernelConfig(tfjsCore.Floor);

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
  var floorDivConfig = createBinaryKernelConfig(tfjsCore.FloorDiv);

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
  var wasmBatchNorm;
  function setup$g(backend) {
      wasmBatchNorm = backend.wasm.cwrap(tfjsCore.FusedBatchNorm, null /* void */, ['number', 'number', 'number', 'number', 'number', 'number', 'number']);
  }
  function fusedBatchNorm(args) {
      var backend = args.backend, inputs = args.inputs, attrs = args.attrs;
      var varianceEpsilon = attrs.varianceEpsilon;
      var x = inputs.x, mean = inputs.mean, variance = inputs.variance, offset = inputs.offset, scale = inputs.scale;
      var xId = backend.dataIdMap.get(x.dataId).id;
      var meanId = backend.dataIdMap.get(mean.dataId).id;
      var varianceId = backend.dataIdMap.get(variance.dataId).id;
      var offsetId = offset != null ? backend.dataIdMap.get(offset.dataId).id : 0;
      var scaleId = scale != null ? backend.dataIdMap.get(scale.dataId).id : 0;
      var out = backend.makeOutput(x.shape, x.dtype);
      // Short-circuit zero-sized tensors.
      if (tfjsCore.util.sizeFromShape(x.shape) === 0) {
          return out;
      }
      var outId = backend.dataIdMap.get(out.dataId).id;
      wasmBatchNorm(xId, meanId, varianceId, offsetId, scaleId, varianceEpsilon, outId);
      return out;
  }
  var fusedBatchNormConfig = {
      kernelName: tfjsCore.FusedBatchNorm,
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
  var wasmFusedConv2d;
  function setup$h(backend) {
      wasmFusedConv2d = backend.wasm.cwrap(tfjsCore.FusedConv2D, null /* void */, [
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
      var inputs = args.inputs, attrs = args.attrs, backend = args.backend;
      var x = inputs.x, filter = inputs.filter, bias = inputs.bias, preluActivationWeights = inputs.preluActivationWeights;
      var strides = attrs.strides, pad = attrs.pad, dilations = attrs.dilations, dataFormat = attrs.dataFormat, dimRoundingMode = attrs.dimRoundingMode, activation = attrs.activation, leakyreluAlpha = attrs.leakyreluAlpha;
      var convInfo = tfjsCore.backend_util.computeConv2DInfo(x.shape, filter.shape, strides, dilations, pad, dimRoundingMode);
      var fusedActivation = FusableActivation[activation];
      if (fusedActivation == null) {
          throw new Error(activation + " activation not yet supported for FusedConv2D " +
              "in the wasm backend.");
      }
      var xId = backend.dataIdMap.get(x.dataId).id;
      var filterId = backend.dataIdMap.get(filter.dataId).id;
      var outputChannels = convInfo.outChannels;
      var biasId = 0;
      if (bias != null) {
          var biasData = backend.dataIdMap.get(bias.dataId);
          if (biasData.shape.length !== 1) {
              throw new Error("FusedConv2D only supports rank-1 bias but got " +
                  ("rank " + biasData.shape.length + "."));
          }
          if (biasData.shape[0] !== outputChannels) {
              throw new Error("FusedConv2D bias shape (" + biasData.shape + ") does not " +
                  ("match the number of output channels (" + outputChannels + ")"));
          }
          biasId = biasData.id;
      }
      var filterHeight = convInfo.filterHeight;
      var filterWidth = convInfo.filterWidth;
      var padTop = convInfo.padInfo.top;
      var padRight = convInfo.padInfo.right;
      var padBottom = convInfo.padInfo.bottom;
      var padLeft = convInfo.padInfo.left;
      var dilationHeight = convInfo.dilationHeight;
      var dilationWidth = convInfo.dilationWidth;
      var strideHeight = convInfo.strideHeight;
      var strideWidth = convInfo.strideWidth;
      var inputChannels = convInfo.inChannels;
      var isSamePad = convInfo.padInfo.type === 'SAME' ? 1 : 0;
      var batchSize = convInfo.batchSize;
      var inHeight = convInfo.inHeight;
      var inWidth = convInfo.inWidth;
      if (dataFormat !== 'NHWC') {
          throw new Error("wasm backend FusedConv2D does not support dataFormat:'" +
              (dataFormat + "'. Please use 'NHWC'."));
      }
      var out = backend.makeOutput(convInfo.outShape, 'float32');
      var outId = backend.dataIdMap.get(out.dataId).id;
      var preluActivationWeightsId = preluActivationWeights == null ?
          0 :
          backend.dataIdMap.get(preluActivationWeights.dataId).id;
      wasmFusedConv2d(xId, batchSize, inHeight, inWidth, filterId, filterHeight, filterWidth, biasId, padTop, padRight, padBottom, padLeft, isSamePad, dilationHeight, dilationWidth, strideHeight, strideWidth, inputChannels, outputChannels, fusedActivation, preluActivationWeightsId, leakyreluAlpha || 0, outId);
      return out;
  }
  var fusedConv2DConfig = {
      kernelName: tfjsCore.FusedConv2D,
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
  var wasmFusedDepthwiseConv2d;
  function setup$i(backend) {
      wasmFusedDepthwiseConv2d =
          backend.wasm.cwrap(tfjsCore.FusedDepthwiseConv2D, null /* void */, [
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
      var inputs = args.inputs, attrs = args.attrs, backend = args.backend;
      var x = inputs.x, filter = inputs.filter, bias = inputs.bias, preluActivationWeights = inputs.preluActivationWeights;
      var strides = attrs.strides, pad = attrs.pad, dilations = attrs.dilations, dataFormat = attrs.dataFormat, dimRoundingMode = attrs.dimRoundingMode, activation = attrs.activation, leakyreluAlpha = attrs.leakyreluAlpha;
      var convInfo = tfjsCore.backend_util.computeConv2DInfo(x.shape, filter.shape, strides, dilations, pad, dimRoundingMode, true /* depthwise */);
      var fusedActivation = FusableActivation[activation];
      if (fusedActivation == null) {
          throw new Error(activation + " activation not yet supported for FusedDepthwiseConv2D " +
              "in the wasm backend.");
      }
      var xId = backend.dataIdMap.get(x.dataId).id;
      var filterId = backend.dataIdMap.get(filter.dataId).id;
      var outputChannels = convInfo.outChannels;
      var biasId = 0;
      if (bias != null) {
          var biasData = backend.dataIdMap.get(bias.dataId);
          if (biasData.shape.length !== 1) {
              throw new Error("FusedDepthwiseConv2D only supports rank-1 bias but got " +
                  ("rank " + biasData.shape.length + "."));
          }
          if (biasData.shape[0] !== outputChannels) {
              throw new Error("FusedDepthwiseConv2D bias shape (" + biasData.shape + ") does not " +
                  ("match the number of output channels (" + outputChannels + ")"));
          }
          biasId = biasData.id;
      }
      var filterHeight = convInfo.filterHeight;
      var filterWidth = convInfo.filterWidth;
      var padTop = convInfo.padInfo.top;
      var padRight = convInfo.padInfo.right;
      var padBottom = convInfo.padInfo.bottom;
      var padLeft = convInfo.padInfo.left;
      var dilationHeight = convInfo.dilationHeight;
      var dilationWidth = convInfo.dilationWidth;
      var strideHeight = convInfo.strideHeight;
      var strideWidth = convInfo.strideWidth;
      var inputChannels = convInfo.inChannels;
      var isSamePad = convInfo.padInfo.type === 'SAME' ? 1 : 0;
      var batchSize = convInfo.batchSize;
      var inHeight = convInfo.inHeight;
      var inWidth = convInfo.inWidth;
      if (dataFormat !== 'NHWC') {
          throw new Error("wasm backend FusedDepthwiseConv2D does not support dataFormat:'" +
              (dataFormat + "'. Please use 'NHWC'."));
      }
      var out = backend.makeOutput(convInfo.outShape, 'float32');
      var outId = backend.dataIdMap.get(out.dataId).id;
      var preluActivationWeightsId = preluActivationWeights == null ?
          0 :
          backend.dataIdMap.get(preluActivationWeights.dataId).id;
      wasmFusedDepthwiseConv2d(xId, batchSize, inHeight, inWidth, filterId, filterHeight, filterWidth, biasId, padTop, padRight, padBottom, padLeft, isSamePad, dilationHeight, dilationWidth, strideHeight, strideWidth, inputChannels, outputChannels, fusedActivation, preluActivationWeightsId, leakyreluAlpha || 0, outId);
      return out;
  }
  var fusedDepthwiseConv2DConfig = {
      kernelName: tfjsCore.FusedDepthwiseConv2D,
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
  var wasmGatherNd;
  function setup$j(backend) {
      wasmGatherNd = backend.wasm.cwrap(tfjsCore.GatherNd, null /*void*/, [
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
      var backend = args.backend, inputs = args.inputs;
      var params = inputs.params, indices = inputs.indices;
      var _a = tfjsCore.gather_util.prepareAndValidate(params, indices), resultShape = _a[0], numSlices = _a[1], sliceSize = _a[2], strides = _a[3];
      var out = backend.makeOutput(resultShape, params.dtype);
      if (numSlices === 0) {
          return out;
      }
      var indicesShape = indices.shape;
      var sliceRank = indicesShape[indicesShape.length - 1];
      var xData = backend.dataIdMap.get(params.dataId);
      var xId = xData.id;
      var indicesData = backend.dataIdMap.get(indices.dataId);
      var indicesId = indicesData.id;
      var stridesBytes = new Uint8Array(new Int32Array(strides).buffer);
      var outId = backend.dataIdMap.get(out.dataId).id;
      wasmGatherNd(xId, CppDType[params.dtype], indicesId, numSlices, sliceRank, sliceSize, stridesBytes, outId);
      return out;
  }
  var gatherNdConfig = {
      kernelName: tfjsCore.GatherNd,
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
  var wasmGather;
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
      var backend = args.backend, inputs = args.inputs, attrs = args.attrs;
      var x = inputs.x, indices = inputs.indices;
      var axis = attrs.axis, batchDims = attrs.batchDims;
      // Throw error when any index is out of bound.
      var parsedAxis = tfjsCore.util.parseAxisParam(axis, x.shape)[0];
      var indicesVals = backend.readSync(indices.dataId);
      var axisDim = x.shape[parsedAxis];
      var _loop_1 = function (i) {
          var index = indicesVals[i];
          tfjsCore.util.assert(index <= axisDim - 1 && index >= 0, function () {
              return "GatherV2: the index value " + index + " is not in [0, " + (axisDim - 1) + "]";
          });
      };
      for (var i = 0; i < indicesVals.length; ++i) {
          _loop_1(i);
      }
      var shapeInfo = tfjsCore.backend_util.segment_util.collectGatherOpShapeInfo(x, indices, parsedAxis, batchDims);
      var flattenX = reshape({
          inputs: { x: x },
          attrs: {
              shape: [
                  shapeInfo.batchSize, shapeInfo.outerSize, shapeInfo.dimSize,
                  shapeInfo.sliceSize
              ]
          },
          backend: backend
      });
      var indicesSize = tfjsCore.util.sizeFromShape(indices.shape);
      var flattenIndex = reshape({
          inputs: { x: indices },
          attrs: { shape: [shapeInfo.batchSize, indicesSize / shapeInfo.batchSize] },
          backend: backend
      });
      var flattenOutputShape = [
          shapeInfo.batchSize, shapeInfo.outerSize, indicesSize / shapeInfo.batchSize,
          shapeInfo.sliceSize
      ];
      var out = backend.makeOutput(flattenOutputShape, x.dtype);
      if (tfjsCore.util.sizeFromShape(x.shape) === 0) {
          return out;
      }
      var stridesSize = flattenX.shape.length - 1;
      var xData = backend.dataIdMap.get(flattenX.dataId);
      var xId = xData.id;
      var indicesData = backend.dataIdMap.get(flattenIndex.dataId);
      var indicesId = indicesData.id;
      var outId = backend.dataIdMap.get(out.dataId).id;
      var xStridesBytes = new Uint8Array(new Int32Array(tfjsCore.util.computeStrides(flattenX.shape)).buffer);
      var outStridesBytes = new Uint8Array(new Int32Array(tfjsCore.util.computeStrides(flattenOutputShape)).buffer);
      wasmGather(xId, CppDType[x.dtype], xStridesBytes, stridesSize, indicesId, shapeInfo.batchSize, outStridesBytes, outId);
      backend.disposeData(flattenX.dataId);
      backend.disposeData(flattenIndex.dataId);
      // reshape
      out.shape = shapeInfo.outputShape;
      return out;
  }
  var gatherV2Config = {
      kernelName: tfjsCore.GatherV2,
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
  var supportsFullBroadcast$1 = false;
  var greaterConfig = createBinaryKernelConfig(tfjsCore.Greater, supportsFullBroadcast$1, 'bool');

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
  var supportsFullBroadcast$2 = false;
  var greaterEqualConfig = createBinaryKernelConfig(tfjsCore.GreaterEqual, supportsFullBroadcast$2, 'bool');

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
  var wasmFunc$2;
  function setupFunc$1(backend) {
      wasmFunc$2 = backend.wasm.cwrap(tfjsCore.LeakyRelu, null /* void */, [
          'number',
          'number',
          'number',
          'number',
      ]);
  }
  function leakyRelu(args) {
      var x = args.inputs.x, alpha = args.attrs.alpha, backend = args.backend;
      var xId = backend.dataIdMap.get(x.dataId).id;
      // According to TF API, LeakyRelu returns float32 when input is either float32
      // or int32.
      var out = backend.makeOutput(x.shape, 'float32');
      if (tfjsCore.util.sizeFromShape(x.shape) !== 0) {
          var outId = backend.dataIdMap.get(out.dataId).id;
          wasmFunc$2(xId, CppDType[x.dtype], alpha, outId);
      }
      return out;
  }
  var leakyReluConfig = {
      kernelName: tfjsCore.LeakyRelu,
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
  var supportsFullBroadcast$3 = false;
  var lessConfig = createBinaryKernelConfig(tfjsCore.Less, supportsFullBroadcast$3, 'bool');

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
  var supportsFullBroadcast$4 = false;
  var lessEqualConfig = createBinaryKernelConfig(tfjsCore.LessEqual, supportsFullBroadcast$4, 'bool');

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
  var logConfig = createUnaryKernelConfig(tfjsCore.Log);

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
  var supportsFullBroadcast$5 = false;
  var logicalAndConfig = createBinaryKernelConfig(tfjsCore.LogicalAnd, supportsFullBroadcast$5, 'bool');

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
  var wasmMax;
  function setup$l(backend) {
      wasmMax = backend.wasm.cwrap(tfjsCore.Max, null /*void*/, [
          'number',
          'number',
          'number',
          'number',
      ]);
  }
  function max(args) {
      var backend = args.backend, inputs = args.inputs, attrs = args.attrs;
      var axis = attrs.reductionIndices, keepDims = attrs.keepDims;
      var x = inputs.x;
      var xId = backend.dataIdMap.get(x.dataId).id;
      var inputId = xId;
      var input = x;
      var _a = permuteAxesAndTranspose(x, axis, backend), transposed = _a.transposed, axes = _a.axes, originalAxes = _a.originalAxes, inputWasTransposed = _a.inputWasTransposed;
      if (inputWasTransposed) {
          var transposedId = backend.dataIdMap.get(transposed.dataId).id;
          input = transposed;
          inputId = transposedId;
      }
      var inputRank = input.shape.length;
      tfjsCore.backend_util.assertAxesAreInnerMostDims('max', axes, inputRank);
      var _b = tfjsCore.backend_util.computeOutAndReduceShapes(input.shape, axes), outShape = _b[0], reduceShape = _b[1];
      var reduceSize = tfjsCore.util.sizeFromShape(reduceShape);
      var out = backend.makeOutput(outShape, x.dtype);
      if (tfjsCore.util.sizeFromShape(input.shape) !== 0) {
          var outId = backend.dataIdMap.get(out.dataId).id;
          wasmMax(inputId, CppDType[x.dtype], reduceSize, outId);
      }
      if (inputWasTransposed) {
          // dispose of the transposed tensor.
          backend.disposeData(transposed.dataId);
      }
      if (keepDims) {
          // reshape
          var newShape = tfjsCore.backend_util.expandShapeToKeepDim(out.shape, originalAxes);
          out.shape = newShape;
      }
      return out;
  }
  var maxConfig = {
      kernelName: tfjsCore.Max,
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
  var maximumConfig = createBinaryKernelConfig(tfjsCore.Maximum);

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
  var wasmMaxPool;
  function setup$m(backend) {
      wasmMaxPool = backend.wasm.cwrap(tfjsCore.MaxPool, null /* void */, [
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
      var inputs = args.inputs, attrs = args.attrs, backend = args.backend;
      var x = inputs.x;
      var xId = backend.dataIdMap.get(x.dataId).id;
      // TF API supports int32 input. CPU and WebGL backend also support int32
      // input. WASM backend doesn't support it because it uses xnnpack which only
      // supports float32.
      //
      // Add the following assert only for the WASM backend instead of at core op
      // level.
      //
      // TODO: add support for int32 input.
      tfjsCore.util.assert(x.dtype === 'float32', function () {
          return "Error in MaxPool: only float32 input is supported. Got " + x.dtype + ".";
      });
      var filterSize = attrs.filterSize, strides = attrs.strides, pad = attrs.pad, dimRoundingMode = attrs.dimRoundingMode;
      var convInfo = tfjsCore.backend_util.computePool2DInfo(x.shape, filterSize, strides, 1 /* dilations */, pad, dimRoundingMode);
      var filterHeight = convInfo.filterHeight;
      var filterWidth = convInfo.filterWidth;
      var padTop = convInfo.padInfo.top;
      var padRight = convInfo.padInfo.right;
      var padBottom = convInfo.padInfo.bottom;
      var padLeft = convInfo.padInfo.left;
      var dilationHeight = convInfo.dilationHeight;
      var dilationWidth = convInfo.dilationWidth;
      var strideHeight = convInfo.strideHeight;
      var strideWidth = convInfo.strideWidth;
      var inputChannels = convInfo.inChannels;
      var outputChannels = convInfo.outChannels;
      if (convInfo.dataFormat !== 'channelsLast') {
          throw new Error("wasm backend does not support dataFormat:'" +
              (convInfo.dataFormat + "'. Please use 'channelsLast'."));
      }
      var out = backend.makeOutput(convInfo.outShape, 'float32');
      var outId = backend.dataIdMap.get(out.dataId).id;
      wasmMaxPool(xId, x.shape[0], x.shape[1], x.shape[2], filterHeight, filterWidth, padTop, padRight, padBottom, padLeft, dilationHeight, dilationWidth, strideHeight, strideWidth, inputChannels, outputChannels, outId);
      return out;
  }
  var maxPoolConfig = {
      kernelName: tfjsCore.MaxPool,
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
  var wasmMean;
  function setup$n(backend) {
      wasmMean =
          backend.wasm.cwrap(tfjsCore.Mean, null /*void*/, ['number, number, number']);
  }
  function mean(args) {
      var backend = args.backend, inputs = args.inputs, attrs = args.attrs;
      var axis = attrs.axis, keepDims = attrs.keepDims;
      var x = inputs.x;
      var xId = backend.dataIdMap.get(x.dataId).id;
      var inputId = xId;
      var input = x;
      var _a = permuteAxesAndTranspose(x, axis, backend), transposed = _a.transposed, axes = _a.axes, originalAxes = _a.originalAxes, inputWasTransposed = _a.inputWasTransposed;
      var reductionAxes = axes;
      if (inputWasTransposed) {
          var transposedId = backend.dataIdMap.get(transposed.dataId).id;
          if (transposedId !== xId) {
              // transpose was not a no-op. We will need to dispose of this
              // once we are done.
              input = transposed;
              inputId = transposedId;
              reductionAxes = tfjsCore.backend_util.getInnerMostAxes(reductionAxes.length, input.shape.length);
          }
      }
      tfjsCore.backend_util.assertAxesAreInnerMostDims('mean', reductionAxes, input.shape.length);
      var _b = tfjsCore.backend_util.computeOutAndReduceShapes(input.shape, reductionAxes), outShape = _b[0], reduceShape = _b[1];
      var reduceSize = tfjsCore.util.sizeFromShape(reduceShape);
      var castedInput = input;
      if (input.dtype !== 'float32') {
          castedInput =
              cast({ backend: backend, inputs: { x: input }, attrs: { dtype: 'float32' } });
          inputId = backend.dataIdMap.get(castedInput.dataId).id;
      }
      var out = backend.makeOutput(outShape, 'float32');
      if (tfjsCore.util.sizeFromShape(input.shape) !== 0) {
          var outId = backend.dataIdMap.get(out.dataId).id;
          wasmMean(inputId, reduceSize, outId);
      }
      if (inputWasTransposed) {
          // dispose of the transposed tensor.
          backend.disposeData(transposed.dataId);
      }
      if (keepDims) {
          // reshape
          var newShape = tfjsCore.backend_util.expandShapeToKeepDim(out.shape, originalAxes);
          out.shape = newShape;
      }
      if (input.dtype !== 'float32') {
          backend.disposeData(castedInput.dataId);
      }
      return out;
  }
  var meanConfig = {
      kernelName: tfjsCore.Mean,
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
  var wasmMin;
  function setup$o(backend) {
      wasmMin = backend.wasm.cwrap(tfjsCore.Min, null /*void*/, [
          'number',
          'number',
          'number',
          'number',
      ]);
  }
  function min(args) {
      var backend = args.backend, inputs = args.inputs, attrs = args.attrs;
      var axis = attrs.axis, keepDims = attrs.keepDims;
      var x = inputs.x;
      var xId = backend.dataIdMap.get(x.dataId).id;
      var inputId = xId;
      var input = x;
      var _a = permuteAxesAndTranspose(x, axis, backend), transposed = _a.transposed, axes = _a.axes, originalAxes = _a.originalAxes, inputWasTransposed = _a.inputWasTransposed;
      if (inputWasTransposed) {
          var transposedId = backend.dataIdMap.get(transposed.dataId).id;
          if (transposedId !== xId) {
              // transpose was not a no-op. We will need to dispose of this
              // once we are done.
              input = transposed;
              inputId = transposedId;
          }
      }
      var inputRank = input.shape.length;
      tfjsCore.backend_util.assertAxesAreInnerMostDims('min', axes, inputRank);
      var _b = tfjsCore.backend_util.computeOutAndReduceShapes(input.shape, axes), outShape = _b[0], reduceShape = _b[1];
      var reduceSize = tfjsCore.util.sizeFromShape(reduceShape);
      var out = backend.makeOutput(outShape, input.dtype);
      if (tfjsCore.util.sizeFromShape(input.shape) !== 0) {
          var outId = backend.dataIdMap.get(out.dataId).id;
          wasmMin(inputId, CppDType[x.dtype], reduceSize, outId);
      }
      if (inputWasTransposed) {
          // dispose of the transposed tensor.
          backend.disposeData(transposed.dataId);
      }
      if (keepDims) {
          // reshape
          var newShape = tfjsCore.backend_util.expandShapeToKeepDim(out.shape, originalAxes);
          out.shape = newShape;
      }
      return out;
  }
  var minConfig = {
      kernelName: tfjsCore.Min,
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
  var minimumConfig = createBinaryKernelConfig(tfjsCore.Minimum);

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
  var wasmMirrorPad;
  function setup$p(backend) {
      wasmMirrorPad = backend.wasm.cwrap(tfjsCore.MirrorPad, null /* void */, [
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
      var x = args.inputs.x, backend = args.backend, _a = args.attrs, paddings = _a.paddings, mode = _a.mode;
      var outShape = paddings.map(function (p, i) { return p[0] /* beforePad */ + x.shape[i] + p[1]; } /* afterPad */);
      var xId = backend.dataIdMap.get(x.dataId).id;
      var out = backend.makeOutput(outShape, x.dtype);
      var outId = backend.dataIdMap.get(out.dataId).id;
      var xShapeBytes = new Uint8Array(new Int32Array(x.shape).buffer);
      var prePaddingsFlat = paddings.map(function (padTuple) { return padTuple[0]; });
      var postPaddingsFlat = paddings.map(function (padTuple) { return padTuple[1]; });
      var prePaddingsBytes = new Uint8Array(new Int32Array(prePaddingsFlat).buffer);
      var postPaddingsBytes = new Uint8Array(new Int32Array(postPaddingsFlat).buffer);
      wasmMirrorPad(xId, xShapeBytes, x.shape.length, CppDType[x.dtype], prePaddingsBytes, postPaddingsBytes, MirrorPaddingMode[mode], outId);
      return out;
  }
  var mirrorPadConfig = {
      kernelName: tfjsCore.MirrorPad,
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
  var multiplyConfig = createBinaryKernelConfig(tfjsCore.Multiply);

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
  var negConfig = createUnaryKernelConfig(tfjsCore.Neg);

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
      var result = new Int32Array(backend.wasm.HEAPU8.buffer, resOffset, 4);
      var pSelectedIndices = result[0];
      var selectedSize = result[1];
      var pSelectedScores = result[2];
      var pValidOutputs = result[3];
      // Since the result was allocated on the heap, we have to delete it.
      backend.wasm._free(resOffset);
      return { pSelectedIndices: pSelectedIndices, selectedSize: selectedSize, pSelectedScores: pSelectedScores, pValidOutputs: pValidOutputs };
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
  var wasmFunc$3;
  function setup$q(backend) {
      wasmFunc$3 = backend.wasm.cwrap(tfjsCore.NonMaxSuppressionV3, 'number', // Result*
      [
          'number',
          'number',
          'number',
          'number',
          'number',
      ]);
  }
  function kernelFunc(args) {
      var backend = args.backend, inputs = args.inputs, attrs = args.attrs;
      var iouThreshold = attrs.iouThreshold, maxOutputSize = attrs.maxOutputSize, scoreThreshold = attrs.scoreThreshold;
      var boxes = inputs.boxes, scores = inputs.scores;
      var boxesId = backend.dataIdMap.get(boxes.dataId).id;
      var scoresId = backend.dataIdMap.get(scores.dataId).id;
      var resOffset = wasmFunc$3(boxesId, scoresId, maxOutputSize, iouThreshold, scoreThreshold);
      var _a = parseResultStruct(backend, resOffset), pSelectedIndices = _a.pSelectedIndices, selectedSize = _a.selectedSize, pSelectedScores = _a.pSelectedScores, pValidOutputs = _a.pValidOutputs;
      // Since we are not using scores for V3, we have to delete it from the heap.
      backend.wasm._free(pSelectedScores);
      backend.wasm._free(pValidOutputs);
      var selectedIndicesTensor = backend.makeOutput([selectedSize], 'int32', pSelectedIndices);
      return selectedIndicesTensor;
  }
  var nonMaxSuppressionV3Config = {
      kernelName: tfjsCore.NonMaxSuppressionV3,
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
  var wasmFunc$4;
  function setup$r(backend) {
      wasmFunc$4 = backend.wasm.cwrap(tfjsCore.NonMaxSuppressionV4, 'number', // Result*
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
      var backend = args.backend, inputs = args.inputs, attrs = args.attrs;
      var iouThreshold = attrs.iouThreshold, maxOutputSize = attrs.maxOutputSize, scoreThreshold = attrs.scoreThreshold, padToMaxOutputSize = attrs.padToMaxOutputSize;
      var boxes = inputs.boxes, scores = inputs.scores;
      var boxesId = backend.dataIdMap.get(boxes.dataId).id;
      var scoresId = backend.dataIdMap.get(scores.dataId).id;
      var resOffset = wasmFunc$4(boxesId, scoresId, maxOutputSize, iouThreshold, scoreThreshold, padToMaxOutputSize);
      var _a = parseResultStruct(backend, resOffset), pSelectedIndices = _a.pSelectedIndices, selectedSize = _a.selectedSize, pSelectedScores = _a.pSelectedScores, pValidOutputs = _a.pValidOutputs;
      // Since we are not using scores for V4, we have to delete it from the heap.
      backend.wasm._free(pSelectedScores);
      var selectedIndicesTensor = backend.makeOutput([selectedSize], 'int32', pSelectedIndices);
      var validOutputsTensor = backend.makeOutput([], 'int32', pValidOutputs);
      return [selectedIndicesTensor, validOutputsTensor];
  }
  var nonMaxSuppressionV4Config = {
      kernelName: tfjsCore.NonMaxSuppressionV4,
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
  var wasmFunc$5;
  function setup$s(backend) {
      wasmFunc$5 = backend.wasm.cwrap(tfjsCore.NonMaxSuppressionV5, 'number', // Result*
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
      var backend = args.backend, inputs = args.inputs, attrs = args.attrs;
      var iouThreshold = attrs.iouThreshold, maxOutputSize = attrs.maxOutputSize, scoreThreshold = attrs.scoreThreshold, softNmsSigma = attrs.softNmsSigma;
      var boxes = inputs.boxes, scores = inputs.scores;
      var boxesId = backend.dataIdMap.get(boxes.dataId).id;
      var scoresId = backend.dataIdMap.get(scores.dataId).id;
      var resOffset = wasmFunc$5(boxesId, scoresId, maxOutputSize, iouThreshold, scoreThreshold, softNmsSigma);
      var _a = parseResultStruct(backend, resOffset), pSelectedIndices = _a.pSelectedIndices, selectedSize = _a.selectedSize, pSelectedScores = _a.pSelectedScores, pValidOutputs = _a.pValidOutputs;
      // Since we are not using validOutputs for V5, we have to delete it from the
      // heap.
      backend.wasm._free(pValidOutputs);
      var selectedIndicesTensor = backend.makeOutput([selectedSize], 'int32', pSelectedIndices);
      var selectedScoresTensor = backend.makeOutput([selectedSize], 'float32', pSelectedScores);
      return [selectedIndicesTensor, selectedScoresTensor];
  }
  var nonMaxSuppressionV5Config = {
      kernelName: tfjsCore.NonMaxSuppressionV5,
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
  var supportsFullBroadcast$6 = false;
  var notEqualConfig = createBinaryKernelConfig(tfjsCore.NotEqual, supportsFullBroadcast$6, 'bool');

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
  var wasmOneHot;
  function setup$t(backend) {
      wasmOneHot = backend.wasm.cwrap(tfjsCore.OneHot, null /* void */, [
          'number',
          'number',
          'number',
          'number',
          'number' // out_id
      ]);
  }
  function oneHot(args) {
      var inputs = args.inputs, backend = args.backend, attrs = args.attrs;
      var indices = inputs.indices;
      var depth = attrs.depth, onValue = attrs.onValue, offValue = attrs.offValue;
      var out = backend.makeOutput(indices.shape.concat([depth]), 'int32');
      var outId = backend.dataIdMap.get(out.dataId).id;
      var indicesData = backend.dataIdMap.get(indices.dataId);
      var indicesId = indicesData.id;
      wasmOneHot(indicesId, depth, onValue, offValue, outId);
      return out;
  }
  var oneHotConfig = {
      kernelName: tfjsCore.OneHot,
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
      var x = args.inputs.x, backend = args.backend;
      var out = backend.makeOutput(x.shape, x.dtype);
      var outVals = backend.typedArrayFromHeap(out);
      outVals.fill(1);
      return out;
  }
  var onesLikeConfig = {
      kernelName: tfjsCore.OnesLike,
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
      var inputs = args.inputs, backend = args.backend, attrs = args.attrs;
      var axis = attrs.axis;
      if (inputs.length === 1) {
          return expandDims({ inputs: { input: inputs[0] }, backend: backend, attrs: { dim: axis } });
      }
      var shape = inputs[0].shape;
      var dtype = inputs[0].dtype;
      inputs.forEach(function (t) {
          tfjsCore.util.assertShapesMatch(shape, t.shape, 'All tensors passed to stack must have matching shapes');
          tfjsCore.util.assert(dtype === t.dtype, function () { return 'All tensors passed to stack must have matching dtypes'; });
      });
      var intermediateTensorInfos = [];
      var expandedTensors = inputs.map(function (t) {
          var expandedT = expandDims({ inputs: { input: t }, backend: backend, attrs: { dim: axis } });
          intermediateTensorInfos.push(expandedT);
          return expandedT;
      });
      var result = concat({ inputs: expandedTensors, backend: backend, attrs: { axis: axis } });
      intermediateTensorInfos.forEach(function (t) { return backend.disposeData(t.dataId); });
      return result;
  }
  var packConfig = {
      kernelName: tfjsCore.Pack,
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
  var wasmPadV2;
  function setup$u(backend) {
      wasmPadV2 = backend.wasm.cwrap(tfjsCore.PadV2, null /* void */, [
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
      var x = args.inputs.x, backend = args.backend, _a = args.attrs, paddings = _a.paddings, constantValue = _a.constantValue;
      var outShape = paddings.map(function (p, i) { return p[0] /* beforePad */ + x.shape[i] + p[1]; } /* afterPad */);
      if (tfjsCore.util.sizeFromShape(x.shape) === 0) {
          // Short-circuit the computation, since x doesn't have value, only
          // the shape is used to compute output shape to pad.
          return fill({
              backend: backend,
              attrs: { shape: outShape, value: constantValue, dtype: x.dtype }
          });
      }
      var xId = backend.dataIdMap.get(x.dataId).id;
      var out = backend.makeOutput(outShape, x.dtype);
      var outTensorData = backend.dataIdMap.get(out.dataId);
      var outId = outTensorData.id;
      var xShapeBytes = new Uint8Array(new Int32Array(x.shape).buffer);
      var prePaddingsFlat = paddings.map(function (padTuple) { return padTuple[0]; });
      var postPaddingsFlat = paddings.map(function (padTuple) { return padTuple[1]; });
      var prePaddingsBytes = new Uint8Array(new Int32Array(prePaddingsFlat).buffer);
      var postPaddingsBytes = new Uint8Array(new Int32Array(postPaddingsFlat).buffer);
      wasmPadV2(xId, xShapeBytes, x.shape.length, CppDType[x.dtype], prePaddingsBytes, postPaddingsBytes, constantValue, outId);
      return out;
  }
  var padV2Config = {
      kernelName: tfjsCore.PadV2,
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
  var powConfig = createBinaryKernelConfig(tfjsCore.Pow);

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
  var wasmPrelu;
  function setup$v(backend) {
      wasmPrelu = backend.wasm.cwrap(tfjsCore.Prelu, null /* void */, [
          'number',
          'number',
          'number' // out_id
      ]);
  }
  function prelu(args) {
      var inputs = args.inputs, backend = args.backend;
      var x = inputs.x, alpha = inputs.alpha;
      var xId = backend.dataIdMap.get(x.dataId).id;
      var weightsId = backend.dataIdMap.get(alpha.dataId).id;
      var inputId = xId;
      var input = x;
      var castedInput = input;
      if (input.dtype !== 'float32') {
          castedInput = cast({ backend: backend, inputs: { x: x }, attrs: { dtype: 'float32' } });
          inputId = backend.dataIdMap.get(castedInput.dataId).id;
      }
      var out = backend.makeOutput(x.shape, 'float32');
      var outId = backend.dataIdMap.get(out.dataId).id;
      wasmPrelu(inputId, weightsId, outId);
      if (input.dtype !== 'float32') {
          backend.disposeData(castedInput.dataId);
      }
      return out;
  }
  var preluConfig = {
      kernelName: tfjsCore.Prelu,
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
  var wasmProd;
  function setup$w(backend) {
      wasmProd = backend.wasm.cwrap(tfjsCore.Prod, null /*void*/, [
          'number',
          'number',
          'number',
          'number'
      ]);
  }
  function prod(args) {
      var backend = args.backend, inputs = args.inputs, attrs = args.attrs;
      var axis = attrs.axis, keepDims = attrs.keepDims;
      var x = inputs.x;
      var xId = backend.dataIdMap.get(x.dataId).id;
      var inputId = xId;
      var input = x;
      var _a = permuteAxesAndTranspose(x, axis, backend), transposed = _a.transposed, axes = _a.axes, originalAxes = _a.originalAxes, inputWasTransposed = _a.inputWasTransposed;
      var reductionAxes = axes;
      if (inputWasTransposed) {
          var transposedId = backend.dataIdMap.get(transposed.dataId).id;
          if (transposedId !== xId) {
              // transpose was not a no-op. We will need to dispose of this
              // once we are done.
              input = transposed;
              inputId = transposedId;
              reductionAxes = tfjsCore.backend_util.getInnerMostAxes(reductionAxes.length, input.shape.length);
          }
      }
      tfjsCore.backend_util.assertAxesAreInnerMostDims('prod', reductionAxes, input.shape.length);
      var _b = tfjsCore.backend_util.computeOutAndReduceShapes(input.shape, reductionAxes), outShape = _b[0], reduceShape = _b[1];
      var reduceSize = tfjsCore.util.sizeFromShape(reduceShape);
      var out = backend.makeOutput(outShape, input.dtype);
      if (tfjsCore.util.sizeFromShape(input.shape) !== 0) {
          var outId = backend.dataIdMap.get(out.dataId).id;
          wasmProd(inputId, reduceSize, CppDType[out.dtype], outId);
      }
      if (inputWasTransposed) {
          // dispose of the transposed tensor.
          backend.disposeData(transposed.dataId);
      }
      if (keepDims) {
          // reshape
          var newShape = tfjsCore.backend_util.expandShapeToKeepDim(out.shape, originalAxes);
          out.shape = newShape;
      }
      return out;
  }
  var prodConfig = {
      kernelName: tfjsCore.Prod,
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
  var range = function (args) {
      var backend = args.backend, attrs = args.attrs;
      var start = attrs.start, stop = attrs.stop, step = attrs.step, dtype = attrs.dtype;
      var values = rangeImpl(start, stop, step, dtype);
      var out = backend.makeOutput([values.length], dtype);
      var outVals = backend.typedArrayFromHeap(out);
      outVals.set(values);
      return out;
  };
  var rangeConfig = {
      kernelName: tfjsCore.Range,
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
  var realDivConfig = createBinaryKernelConfig(tfjsCore.RealDiv);

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
  var reluConfig = createUnaryKernelConfig(tfjsCore.Relu);

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
  var relu6Config = createUnaryKernelConfig(tfjsCore.Relu6);

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
  var wasmResizeBilinear;
  function setup$x(backend) {
      wasmResizeBilinear = backend.wasm.cwrap(tfjsCore.ResizeBilinear, null /*void*/, [
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
      var backend = args.backend, inputs = args.inputs, attrs = args.attrs;
      var images = inputs.images;
      var alignCorners = attrs.alignCorners, halfPixelCenters = attrs.halfPixelCenters, size = attrs.size;
      var newHeight = size[0], newWidth = size[1];
      var _a = images.shape, batch = _a[0], oldHeight = _a[1], oldWidth = _a[2], numChannels = _a[3];
      var outShape = [batch, newHeight, newWidth, numChannels];
      var xData = backend.dataIdMap.get(images.dataId);
      var castedData;
      if (xData.dtype !== 'float32') {
          castedData =
              cast({ backend: backend, inputs: { x: images }, attrs: { dtype: 'float32' } });
          xData = backend.dataIdMap.get(castedData.dataId);
      }
      var xId = xData.id;
      var out = backend.makeOutput(outShape, 'float32');
      if (tfjsCore.util.sizeFromShape(images.shape) === 0) {
          return out;
      }
      var outId = backend.dataIdMap.get(out.dataId).id;
      wasmResizeBilinear(xId, batch, oldHeight, oldWidth, numChannels, newHeight, newWidth, alignCorners ? 1 : 0, halfPixelCenters ? 1 : 0, outId);
      if (castedData != null) {
          backend.disposeData(castedData.dataId);
      }
      return out;
  }
  var resizeBilinearConfig = {
      kernelName: tfjsCore.ResizeBilinear,
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
  var wasmReverse;
  function setup$y(backend) {
      wasmReverse = backend.wasm.cwrap(tfjsCore.Reverse, null, [
          'number',
          'array',
          'number',
          'array',
          'number',
          'number' // out_id
      ]);
  }
  function reverse(args) {
      var inputs = args.inputs, backend = args.backend, attrs = args.attrs;
      var x = inputs.x;
      var dims = attrs.dims;
      var axes = tfjsCore.util.parseAxisParam(dims, x.shape);
      if (x.shape.length === 0) {
          return identity({ inputs: { x: x }, backend: backend });
      }
      var out = backend.makeOutput(x.shape, x.dtype);
      var xId = backend.dataIdMap.get(x.dataId).id;
      var outId = backend.dataIdMap.get(out.dataId).id;
      var axesBytes = new Uint8Array(new Int32Array(axes).buffer);
      var outShapeBytes = new Uint8Array(new Int32Array(x.shape).buffer);
      wasmReverse(xId, axesBytes, axes.length, outShapeBytes, x.shape.length, outId);
      var reshaped = reshape({ inputs: { x: out }, attrs: { shape: x.shape }, backend: backend });
      backend.disposeData(out.dataId);
      return reshaped;
  }
  var reverseConfig = {
      kernelName: tfjsCore.Reverse,
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
  var wasmRotate;
  function setup$z(backend) {
      wasmRotate = backend.wasm.cwrap(tfjsCore.RotateWithOffset, null /* void */, [
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
      var inputs = args.inputs, backend = args.backend, attrs = args.attrs;
      var image = inputs.image;
      var radians = attrs.radians, fillValue = attrs.fillValue, center = attrs.center;
      var out = backend.makeOutput(image.shape, image.dtype);
      var imageId = backend.dataIdMap.get(image.dataId).id;
      var outId = backend.dataIdMap.get(out.dataId).id;
      var _a = image.shape, batch = _a[0], imageHeight = _a[1], imageWidth = _a[2], numChannels = _a[3];
      var _b = tfjsCore.backend_util.getImageCenter(center, imageHeight, imageWidth), centerX = _b[0], centerY = _b[1];
      var fillIsBlack = fillValue === 0;
      var fullOpacityValue = 255;
      var fillValues = typeof fillValue === 'number' ?
          [fillValue, fillValue, fillValue, fillIsBlack ? 0 : fullOpacityValue] : fillValue.concat([fullOpacityValue]);
      var fillBytes = new Uint8Array(new Int32Array(fillValues).buffer);
      wasmRotate(imageId, batch, imageHeight, imageWidth, numChannels, radians, centerX, centerY, fillBytes, fillValues.length, outId);
      return out;
  }
  var rotateWithOffsetConfig = {
      kernelName: tfjsCore.RotateWithOffset,
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
  var roundConfig = createUnaryKernelConfig(tfjsCore.Round);

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
  var rsqrtConfig = createUnaryKernelConfig(tfjsCore.Rsqrt);

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
  var wasmScatterNd;
  function setup$A(backend) {
      wasmScatterNd = backend.wasm.cwrap(tfjsCore.ScatterNd, null /*void*/, [
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
      var backend = args.backend, inputs = args.inputs, attrs = args.attrs;
      var indices = inputs.indices, updates = inputs.updates;
      var shape = attrs.shape;
      var out = backend.makeOutput(shape, updates.dtype);
      if (tfjsCore.util.sizeFromShape(shape) === 0) {
          return out;
      }
      var _a = tfjsCore.scatter_util.calculateShapes(updates, indices, shape), sliceRank = _a.sliceRank, numUpdates = _a.numUpdates, sliceSize = _a.sliceSize, strides = _a.strides, outputSize = _a.outputSize;
      var indicesData = backend.dataIdMap.get(indices.dataId);
      var indicesId = indicesData.id;
      var updatesData = backend.dataIdMap.get(updates.dataId);
      var updatesId = updatesData.id;
      var stridesBytes = new Uint8Array(new Int32Array(strides).buffer);
      var outId = backend.dataIdMap.get(out.dataId).id;
      wasmScatterNd(indicesId, updatesId, CppDType[updates.dtype], sliceRank, numUpdates, sliceSize, stridesBytes, outputSize, outId);
      return out;
  }
  var scatterNdConfig = {
      kernelName: tfjsCore.ScatterNd,
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
  var wasmSelect;
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
      var inputs = args.inputs, backend = args.backend;
      var condition = inputs.condition, t = inputs.t, e = inputs.e;
      var conditionId = backend.dataIdMap.get(condition.dataId).id;
      var tId = backend.dataIdMap.get(t.dataId).id;
      var eId = backend.dataIdMap.get(e.dataId).id;
      var out = backend.makeOutput(t.shape, t.dtype);
      var outId = backend.dataIdMap.get(out.dataId).id;
      var cRank = condition.shape.length;
      var tRank = t.shape.length;
      var offset = cRank === 0 || cRank > 1 || tRank === 1 ?
          1 :
          tfjsCore.util.sizeFromShape(t.shape.slice(1));
      wasmSelect(conditionId, tId, eId, offset, outId);
      return out;
  }
  var selectConfig = {
      kernelName: tfjsCore.Select,
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
  var wasmFunc$6;
  function setup$C(backend) {
      wasmFunc$6 = backend.wasm.cwrap(tfjsCore.Sigmoid, null /* void */, ['number', 'number']);
  }
  function sigmoid(args) {
      var backend = args.backend, x = args.inputs.x;
      var xId = backend.dataIdMap.get(x.dataId).id;
      var out = backend.makeOutput(x.shape, x.dtype);
      var outId = backend.dataIdMap.get(out.dataId).id;
      // Short-circuit zero-sized tensors.
      if (tfjsCore.util.sizeFromShape(out.shape) === 0) {
          return out;
      }
      wasmFunc$6(xId, outId);
      return out;
  }
  var sigmoidConfig = {
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
  var sinConfig = createUnaryKernelConfig(tfjsCore.Sin);

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
  var wasmFunc$7;
  function setup$D(backend) {
      wasmFunc$7 = backend.wasm.cwrap(tfjsCore.Softmax, null /* void */, [
          'number',
          'number',
          'number',
          'number' // batch
      ]);
  }
  function softmax(args) {
      var backend = args.backend, logits = args.inputs.logits, dim = args.attrs.dim;
      var xId = backend.dataIdMap.get(logits.dataId).id;
      var out = backend.makeOutput(logits.shape, logits.dtype);
      var outId = backend.dataIdMap.get(out.dataId).id;
      var channels = logits.shape[dim];
      var batch = tfjsCore.util.sizeFromShape(logits.shape) / channels;
      // Short-circuit zero-sized tensors.
      if (tfjsCore.util.sizeFromShape(out.shape) === 0) {
          return out;
      }
      wasmFunc$7(xId, outId, channels, batch);
      return out;
  }
  var softmaxConfig = {
      kernelName: tfjsCore.Softmax,
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
      var inputs = args.inputs, backend = args.backend, attrs = args.attrs;
      var x = inputs.x;
      var blockShape = attrs.blockShape, paddings = attrs.paddings;
      var prod = tfjsCore.util.sizeFromShape(blockShape);
      var completePaddings = [[0, 0]];
      completePaddings.push.apply(completePaddings, paddings);
      for (var i = 1 + blockShape.length; i < x.shape.length; ++i) {
          completePaddings.push([0, 0]);
      }
      var paddedX = padV2Config.kernelFunc({
          inputs: { x: x },
          backend: backend,
          attrs: { paddings: completePaddings, constantValue: 0 }
      });
      var reshapedPaddedShape = tfjsCore.backend_util.getReshaped(paddedX.shape, blockShape, prod, false);
      var permutedReshapedPaddedPermutation = tfjsCore.backend_util.getPermuted(reshapedPaddedShape.length, blockShape.length, false);
      var flattenShape = tfjsCore.backend_util.getReshapedPermuted(paddedX.shape, blockShape, prod, false);
      var reshapeInputs = { x: paddedX };
      var reshapeAttrs = { shape: reshapedPaddedShape };
      var paddedXReshaped = reshape({ inputs: reshapeInputs, backend: backend, attrs: reshapeAttrs });
      var transposeInputs = { x: paddedXReshaped };
      var transposeAttrs = { perm: permutedReshapedPaddedPermutation };
      var paddedXT = transpose({ inputs: transposeInputs, backend: backend, attrs: transposeAttrs });
      var resultReshapeInputs = { x: paddedXT };
      var resultReshapeAttrs = { shape: flattenShape };
      var result = reshape({ inputs: resultReshapeInputs, backend: backend, attrs: resultReshapeAttrs });
      backend.disposeData(paddedX.dataId);
      backend.disposeData(paddedXReshaped.dataId);
      backend.disposeData(paddedXT.dataId);
      return result;
  }
  var spaceToBatchNDConfig = {
      kernelName: tfjsCore.SpaceToBatchND,
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
  var wasmSparseFillEmptyRows;
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
      var backend = args.backend, inputs = args.inputs;
      var indices = inputs.indices, values = inputs.values, denseShape = inputs.denseShape, defaultValue = inputs.defaultValue;
      var indicesCount = indices.shape[0];
      var rank = indices.shape[1];
      var denseRows = backend.readSync(denseShape.dataId)[0];
      // Set output size to maximum possible and resize later (actual result
      // might be smaller).
      var maxOutputIndicesShape = [indicesCount + denseRows, rank];
      var indicesId = backend.dataIdMap.get(indices.dataId).id;
      var valuesId = backend.dataIdMap.get(values.dataId).id;
      var defaultValueId = backend.dataIdMap.get(defaultValue.dataId).id;
      var outputIndices = backend.makeOutput(maxOutputIndicesShape, indices.dtype);
      var outputIndicesId = backend.dataIdMap.get(outputIndices.dataId).id;
      var outputValues = backend.makeOutput(maxOutputIndicesShape.slice(0, 1), values.dtype);
      var outputValuesId = backend.dataIdMap.get(outputValues.dataId).id;
      var emptyRowIndicator = backend.makeOutput([denseRows], 'bool');
      var emptyRowIndicatorId = backend.dataIdMap.get(emptyRowIndicator.dataId).id;
      var reverseIndexMap = backend.makeOutput([indicesCount], indices.dtype);
      var reverseIndexMapId = backend.dataIdMap.get(reverseIndexMap.dataId).id;
      var exceptionValues = backend.makeOutput([4], 'int32');
      var exceptionValuesId = backend.dataIdMap.get(exceptionValues.dataId).id;
      var outputRows = wasmSparseFillEmptyRows(indicesId, valuesId, CppDType[values.dtype], indicesCount, denseRows, rank, defaultValueId, outputIndicesId, outputValuesId, emptyRowIndicatorId, reverseIndexMapId, exceptionValuesId);
      var exceptionValuesArray = backend.readSync(exceptionValues.dataId);
      var exceptionMessage;
      switch (exceptionValuesArray[0]) {
          case 1: {
              exceptionMessage =
                  tfjsCore.backend_util.getSparseFillEmptyRowsIndicesDenseShapeMismatch(exceptionValuesArray[1]);
              break;
          }
          case 2: {
              exceptionMessage =
                  tfjsCore.backend_util.getSparseFillEmptyRowsNegativeIndexErrorMessage(exceptionValuesArray[1], exceptionValuesArray[2]);
              break;
          }
          case 3:
              exceptionMessage =
                  tfjsCore.backend_util.getSparseFillEmptyRowsOutOfRangeIndexErrorMessage(exceptionValuesArray[1], exceptionValuesArray[2], exceptionValuesArray[3]);
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
      var resizedIndices = outputIndices;
      var resizedValues = outputValues;
      // Overestimated output size.
      if (outputRows !== maxOutputIndicesShape[0]) {
          resizedIndices = slice({
              inputs: { x: outputIndices },
              attrs: { begin: 0, size: [outputRows, rank] },
              backend: backend
          });
          resizedValues = slice({
              inputs: { x: outputValues },
              attrs: { begin: 0, size: outputRows },
              backend: backend
          });
          backend.disposeData(outputIndices.dataId);
          backend.disposeData(outputValues.dataId);
      }
      return [resizedIndices, resizedValues, emptyRowIndicator, reverseIndexMap];
  }
  var sparseFillEmptyRowsConfig = {
      kernelName: tfjsCore.SparseFillEmptyRows,
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
  var wasmSparseReshape;
  function setup$F(backend) {
      wasmSparseReshape = backend.wasm.cwrap(tfjsCore.SparseReshape, null /*void*/, [
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
      var backend = args.backend, inputs = args.inputs;
      var inputIndices = inputs.inputIndices, inputShape = inputs.inputShape, newShape = inputs.newShape;
      if (inputIndices.shape.length !== 2) {
          throw new Error("Input indices should be a matrix but received shape\n        " + inputIndices.shape);
      }
      if (inputShape.shape.length !== 1) {
          throw new Error("Input shape should be a vector but received shape\n        " + inputShape.shape);
      }
      if (newShape.shape.length !== 1) {
          throw new Error("Target shape should be a vector but received shape " + newShape.shape);
      }
      var inputIndicesId = backend.dataIdMap.get(inputIndices.dataId).id;
      var inputShapeId = backend.dataIdMap.get(inputShape.dataId).id;
      var newShapeId = backend.dataIdMap.get(newShape.dataId).id;
      var nnz = inputIndices.shape[0];
      var outputRank = tfjsCore.util.sizeFromShape(newShape.shape);
      var newIndices = backend.makeOutput([nnz, outputRank], inputIndices.dtype);
      var newIndicesId = backend.dataIdMap.get(newIndices.dataId).id;
      var outputShape = backend.makeOutput([outputRank], newShape.dtype);
      var outputShapeId = backend.dataIdMap.get(outputShape.dataId).id;
      var exceptionValues = backend.makeOutput([3], 'int32');
      var exceptionValuesId = backend.dataIdMap.get(exceptionValues.dataId).id;
      wasmSparseReshape(inputIndicesId, inputShapeId, newShapeId, nnz, newIndicesId, outputShapeId, exceptionValuesId);
      var exceptionValuesArray = backend.readSync(exceptionValues.dataId);
      var exceptionMessage;
      switch (exceptionValuesArray[0]) {
          case 0: {
              exceptionMessage =
                  tfjsCore.backend_util.getSparseReshapeMultipleNegativeOneOutputDimErrorMessage(exceptionValuesArray[1], exceptionValuesArray[2]);
              break;
          }
          case 1: {
              exceptionMessage =
                  tfjsCore.backend_util.getSparseReshapeNegativeOutputDimErrorMessage(exceptionValuesArray[1], exceptionValuesArray[2]);
              break;
          }
          case 2:
              exceptionMessage =
                  tfjsCore.backend_util.getSparseReshapeEmptyTensorZeroOutputDimErrorMessage();
              break;
          case 3: {
              var inputShapeValues = Array.from(backend.readSync(inputShape.dataId)), outputShapeValues = Array.from(backend.readSync(outputShape.dataId));
              exceptionMessage =
                  tfjsCore.backend_util.getSparseReshapeInputOutputMultipleErrorMessage(inputShapeValues, outputShapeValues);
              break;
          }
          case 4: {
              var inputShapeValues = Array.from(backend.readSync(inputShape.dataId)), outputShapeValues = Array.from(backend.readSync(outputShape.dataId));
              exceptionMessage =
                  tfjsCore.backend_util.getSparseReshapeInputOutputMismatchErrorMessage(inputShapeValues, outputShapeValues);
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
  var sparseReshapeConfig = {
      kernelName: tfjsCore.SparseReshape,
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
  var wasmSparseSegmentReduction;
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
      var backend = args.backend, inputs = args.inputs;
      var data = inputs.data, indices = inputs.indices, segmentIds = inputs.segmentIds;
      var numIndices = indices.shape[0];
      var segmentIdsBack = backend.readSync(segmentIds.dataId, numIndices - 1, numIndices)[0];
      var lastSegmentIdPlusOne = numIndices > 0 ? segmentIdsBack + 1 : 0;
      var outputRows = lastSegmentIdPlusOne;
      if (outputRows < 0) {
          throw (new Error(tfjsCore.backend_util
              .getSparseSegmentReductionNegativeSegmentIdsErrorMessage()));
      }
      var outputShape = data.shape.slice();
      outputShape[0] = outputRows;
      var dataId = backend.dataIdMap.get(data.dataId).id;
      var indicesId = backend.dataIdMap.get(indices.dataId).id;
      var segmentIdsId = backend.dataIdMap.get(segmentIds.dataId).id;
      var output = backend.makeOutput(outputShape, data.dtype);
      var outputId = backend.dataIdMap.get(output.dataId).id;
      var exceptionValues = backend.makeOutput([4], 'int32');
      var exceptionValuesId = backend.dataIdMap.get(exceptionValues.dataId).id;
      wasmSparseSegmentReduction(dataId, CppDType[data.dtype], data.shape[0], indicesId, segmentIdsId, outputId, exceptionValuesId, isMean, 0);
      var exceptionValuesArray = backend.readSync(exceptionValues.dataId);
      var exceptionMessage;
      switch (exceptionValuesArray[0]) {
          case 0: {
              exceptionMessage =
                  tfjsCore.backend_util
                      .getSparseSegmentReductionNegativeSegmentIdsErrorMessage();
              break;
          }
          case 1: {
              exceptionMessage =
                  tfjsCore.backend_util
                      .getSparseSegmentReductionNonIncreasingSegmentIdsErrorMessage();
              break;
          }
          case 2:
              exceptionMessage =
                  tfjsCore.backend_util.getSparseSegmentReductionSegmentIdOutOfRangeErrorMessage(exceptionValuesArray[1], exceptionValuesArray[2]);
              break;
          case 3:
              exceptionMessage =
                  tfjsCore.backend_util.getSparseSegmentReductionIndicesOutOfRangeErrorMessage(exceptionValuesArray[1], exceptionValuesArray[2], exceptionValuesArray[3]);
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
  var sparseSegmentMeanConfig = {
      kernelName: tfjsCore.SparseSegmentMean,
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
  var sparseSegmentSumConfig = {
      kernelName: tfjsCore.SparseSegmentSum,
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
      var inputs = args.inputs, attrs = args.attrs, backend = args.backend;
      var x = inputs.x;
      var numOrSizeSplits = attrs.numOrSizeSplits, axis = attrs.axis;
      var $axis = tfjsCore.util.parseAxisParam(axis, x.shape)[0];
      var splitSizes = tfjsCore.backend_util.prepareSplitSize(x, numOrSizeSplits, $axis);
      var begin = new Array(x.shape.length).fill(0);
      var size = x.shape.slice();
      return splitSizes.map(function (s) {
          var xSliceSize = size.slice();
          xSliceSize[$axis] = s;
          var xSlice = slice({ inputs: { x: x }, attrs: { begin: begin, size: xSliceSize }, backend: backend });
          begin[$axis] += s;
          return xSlice;
      });
  }
  var splitVConfig = {
      kernelName: tfjsCore.SplitV,
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
  var sqrtConfig = createUnaryKernelConfig(tfjsCore.Sqrt);

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
  var squareConfig = createUnaryKernelConfig(tfjsCore.Square);

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
  var squaredDifferenceConfig = createBinaryKernelConfig(tfjsCore.SquaredDifference);

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
  var wasmStep;
  function setup$H(backend) {
      wasmStep = backend.wasm.cwrap(tfjsCore.Step, null /*void*/, [
          'number',
          'number',
          'number',
          'number',
      ]);
  }
  function step(args) {
      var backend = args.backend, inputs = args.inputs, attrs = args.attrs;
      var alpha = attrs.alpha;
      var x = inputs.x;
      var xId = backend.dataIdMap.get(x.dataId).id;
      var out = backend.makeOutput(x.shape, x.dtype);
      var outId = backend.dataIdMap.get(out.dataId).id;
      wasmStep(xId, alpha, CppDType[x.dtype], outId);
      return out;
  }
  var stepConfig = {
      kernelName: tfjsCore.Step,
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
  var wasmStridedSlice;
  function setup$I(backend) {
      wasmStridedSlice = backend.wasm.cwrap(tfjsCore.StridedSlice, null /*void*/, [
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
      var backend = args.backend, inputs = args.inputs, attrs = args.attrs;
      var x = inputs.x;
      var begin = attrs.begin, end = attrs.end, strides = attrs.strides, beginMask = attrs.beginMask, endMask = attrs.endMask, ellipsisMask = attrs.ellipsisMask, newAxisMask = attrs.newAxisMask, shrinkAxisMask = attrs.shrinkAxisMask;
      var _a = tfjsCore.slice_util.sliceInfo(x.shape, begin, end, strides, beginMask, endMask, ellipsisMask, newAxisMask, shrinkAxisMask), finalShapeSparse = _a.finalShapeSparse, finalShape = _a.finalShape, isIdentity = _a.isIdentity, sliceDim0 = _a.sliceDim0, isSimpleSlice = _a.isSimpleSlice, $begin = _a.begin, $end = _a.end, $strides = _a.strides;
      var result;
      if (isIdentity) {
          // Optimization #1, slice is a no-op plus reshape
          result = reshape({ inputs: { x: x }, backend: backend, attrs: { shape: finalShape } });
      }
      else if (sliceDim0 || isSimpleSlice) {
          // Optimization #2, slice is memory contiguous (only occurs in dim 0)
          tfjsCore.util.assert(x.shape.length >= 1, function () { return "Input must have rank at least 1, got: " + x.shape.length; });
          var size = tfjsCore.slice_util.computeOutShape($begin, $end, $strides);
          // To tolerate begin[0] > end[0] (a 0-output slice), we min(begin, end).
          var sliced = slice({ inputs: { x: x }, backend: backend, attrs: { begin: $begin, size: size } });
          result =
              reshape({ inputs: { x: sliced }, backend: backend, attrs: { shape: finalShape } });
          backend.disposeData(sliced.dataId);
      }
      else {
          var out = backend.makeOutput(finalShapeSparse, 'float32');
          var xId = backend.dataIdMap.get(x.dataId).id;
          var xStridesBytes = new Uint8Array(new Int32Array(tfjsCore.util.computeStrides(x.shape)).buffer);
          var beginBytes = new Uint8Array(new Int32Array($begin).buffer);
          var endBytes = new Uint8Array(new Int32Array($end).buffer);
          var stridesBytes = new Uint8Array(new Int32Array($strides).buffer);
          var outputShapeBytes = new Uint8Array(new Int32Array(finalShapeSparse).buffer);
          var outStridesBytes = new Uint8Array(new Int32Array(tfjsCore.util.computeStrides(finalShapeSparse)).buffer);
          var outId = backend.dataIdMap.get(out.dataId).id;
          wasmStridedSlice(xId, xStridesBytes, x.shape.length, beginBytes, endBytes, stridesBytes, outputShapeBytes, outStridesBytes, finalShapeSparse.length, outId);
          result = reshape({ inputs: { x: out }, backend: backend, attrs: { shape: finalShape } });
          backend.disposeData(out.dataId);
      }
      return result;
  }
  var stridedSliceConfig = {
      kernelName: tfjsCore.StridedSlice,
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
  var subConfig = createBinaryKernelConfig(tfjsCore.Sub);

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
  var wasmSum;
  function setup$J(backend) {
      wasmSum = backend.wasm.cwrap(tfjsCore.Sum, null /*void*/, [
          'number',
          'number',
          'number',
          'number',
      ]);
  }
  function sum(args) {
      var backend = args.backend, inputs = args.inputs, attrs = args.attrs;
      var axis = attrs.axis, keepDims = attrs.keepDims;
      var x = inputs.x;
      var xId = backend.dataIdMap.get(x.dataId).id;
      var inputId = xId;
      var input = x;
      var _a = permuteAxesAndTranspose(x, axis, backend), transposed = _a.transposed, axes = _a.axes, originalAxes = _a.originalAxes, inputWasTransposed = _a.inputWasTransposed;
      var reductionAxes = axes;
      if (inputWasTransposed) {
          var transposedId = backend.dataIdMap.get(transposed.dataId).id;
          if (transposedId !== xId) {
              // transpose was not a no-op. We will need to dispose of this
              // once we are done.
              input = transposed;
              inputId = transposedId;
              reductionAxes = tfjsCore.backend_util.getInnerMostAxes(reductionAxes.length, input.shape.length);
          }
      }
      tfjsCore.backend_util.assertAxesAreInnerMostDims('sum', reductionAxes, input.shape.length);
      var _b = tfjsCore.backend_util.computeOutAndReduceShapes(input.shape, reductionAxes), outShape = _b[0], reduceShape = _b[1];
      var reduceSize = tfjsCore.util.sizeFromShape(reduceShape);
      var out = backend.makeOutput(outShape, input.dtype);
      if (tfjsCore.util.sizeFromShape(input.shape) !== 0) {
          var outId = backend.dataIdMap.get(out.dataId).id;
          wasmSum(inputId, reduceSize, CppDType[out.dtype], outId);
      }
      if (inputWasTransposed) {
          // dispose of the transposed tensor.
          backend.disposeData(transposed.dataId);
      }
      if (keepDims) {
          // reshape
          var newShape = tfjsCore.backend_util.expandShapeToKeepDim(out.shape, originalAxes);
          out.shape = newShape;
      }
      return out;
  }
  var sumConfig = {
      kernelName: tfjsCore.Sum,
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
  var tanConfig = createUnaryKernelConfig(tfjsCore.Tan);

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
  var tanhConfig = createUnaryKernelConfig(tfjsCore.Tanh);

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
  var wasmTile;
  function setup$K(backend) {
      wasmTile = backend.wasm.cwrap(tfjsCore.Tile, null /* void */, [
          'number',
          'array',
          'number',
          'array',
          'number',
          'number' // out_id
      ]);
  }
  function tile(args) {
      var inputs = args.inputs, backend = args.backend, attrs = args.attrs;
      var x = inputs.x;
      var xId = backend.dataIdMap.get(x.dataId).id;
      var reps = attrs.reps;
      var newShape = new Array(x.shape.length);
      for (var i = 0; i < newShape.length; i++) {
          newShape[i] = x.shape[i] * reps[i];
      }
      var xShapeBytes = new Uint8Array(new Int32Array(x.shape).buffer);
      var newShapeBytes = new Uint8Array(new Int32Array(newShape).buffer);
      var out = backend.makeOutput(newShape, x.dtype);
      var outId = backend.dataIdMap.get(out.dataId).id;
      wasmTile(xId, xShapeBytes, x.shape.length, newShapeBytes, newShape.length, CppDType[out.dtype], outId);
      return out;
  }
  var tileConfig = {
      kernelName: tfjsCore.Tile,
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
  var wasmTopK;
  function setup$L(backend) {
      wasmTopK = backend.wasm.cwrap(tfjsCore.TopK, null /* void */, [
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
  var topk = function (_a) {
      var inputs = _a.inputs, backend = _a.backend, attrs = _a.attrs;
      var x = inputs.x;
      var k = attrs.k, sorted = attrs.sorted;
      var xId = backend.dataIdMap.get(x.dataId).id;
      var xShapeBytes = new Uint8Array(new Int32Array(x.shape).buffer);
      var outputShape = x.shape.slice();
      outputShape[outputShape.length - 1] = k;
      var outValues = backend.makeOutput(outputShape, x.dtype);
      var outValuesId = backend.dataIdMap.get(outValues.dataId).id;
      var outIndices = backend.makeOutput(outputShape, 'int32');
      var outIndicesId = backend.dataIdMap.get(outIndices.dataId).id;
      wasmTopK(xId, xShapeBytes, x.shape.length, CppDType[x.dtype], k, sorted, outValuesId, outIndicesId);
      return [outValues, outIndices];
  };
  var topKConfig = {
      kernelName: tfjsCore.TopK,
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
  var wasmTransform;
  function setup$M(backend) {
      wasmTransform = backend.wasm.cwrap(tfjsCore.Transform, null /*void*/, [
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
      var backend = args.backend, inputs = args.inputs, attrs = args.attrs;
      var image = inputs.image, transforms = inputs.transforms;
      var interpolation = attrs.interpolation, fillMode = attrs.fillMode, fillValue = attrs.fillValue, outputShape = attrs.outputShape;
      var _a = image.shape, batch = _a[0], imageHeight = _a[1], imageWidth = _a[2], numChannels = _a[3];
      var _b = outputShape != null ? outputShape : [imageHeight, imageWidth], outHeight = _b[0], outWidth = _b[1];
      var outShape = [batch, outHeight, outWidth,
          numChannels];
      var strides = new Uint8Array(new Int32Array(tfjsCore.util.computeStrides(image.shape)).buffer);
      var out = backend.makeOutput(outShape, image.dtype);
      var outId = backend.dataIdMap.get(out.dataId).id;
      var imageData = backend.dataIdMap.get(image.dataId);
      var imageId = imageData.id;
      var transformsData = backend.dataIdMap.get(transforms.dataId);
      var transformsId = transformsData.id;
      var interpolationModeId = interpolation === 'nearest' ? 1 : 2;
      var fillModeId;
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
  var transformConfig = {
      kernelName: tfjsCore.Transform,
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
      var inputs = args.inputs, backend = args.backend, attrs = args.attrs;
      var value = inputs.value;
      var axis = attrs.axis;
      if (axis < 0) {
          axis += value.shape.length;
      }
      var numOutputs = value.shape[axis];
      var rank = value.shape.length;
      var outShape = new Array(rank - 1);
      var outIndex = 0;
      for (var i = 0; i < rank; i++) {
          if (i !== axis) {
              outShape[outIndex++] = value.shape[i];
          }
      }
      var outs = new Array(numOutputs);
      var begin = new Array(rank).fill(0);
      var size = value.shape.slice();
      size[axis] = 1;
      for (var i = 0; i < outs.length; i++) {
          begin[axis] = i;
          outs[i] = slice({ inputs: { x: value }, attrs: { begin: begin, size: size }, backend: backend });
      }
      return outs.map(function (_a) {
          var dataId = _a.dataId, dtype = _a.dtype;
          return ({ dataId: dataId, dtype: dtype, shape: outShape });
      });
  }
  var unpackConfig = {
      kernelName: tfjsCore.Unpack,
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
      var x = args.inputs.x, backend = args.backend;
      var out = backend.makeOutput(x.shape, x.dtype);
      var outVals = backend.typedArrayFromHeap(out);
      outVals.fill(0);
      return out;
  }
  var zerosLikeConfig = {
      kernelName: tfjsCore.ZerosLike,
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
  var kernelConfigs = [
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
  for (var _i = 0, kernelConfigs_1 = kernelConfigs; _i < kernelConfigs_1.length; _i++) {
      var kernelConfig = kernelConfigs_1[_i];
      tfjsCore.registerKernel(kernelConfig);
  }

  /*! *****************************************************************************
  Copyright (c) Microsoft Corporation.

  Permission to use, copy, modify, and/or distribute this software for any
  purpose with or without fee is hereby granted.

  THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
  REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
  AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
  INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
  LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
  OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
  PERFORMANCE OF THIS SOFTWARE.
  ***************************************************************************** */
  /* global Reflect, Promise */

  var extendStatics = function(d, b) {
      extendStatics = Object.setPrototypeOf ||
          ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
          function (d, b) { for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p]; };
      return extendStatics(d, b);
  };

  function __extends(d, b) {
      extendStatics(d, b);
      function __() { this.constructor = d; }
      d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  }

  function __awaiter(thisArg, _arguments, P, generator) {
      function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
      return new (P || (P = Promise))(function (resolve, reject) {
          function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
          function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
          function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
          step((generator = generator.apply(thisArg, _arguments || [])).next());
      });
  }

  function __generator(thisArg, body) {
      var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g;
      return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
      function verb(n) { return function (v) { return step([n, v]); }; }
      function step(op) {
          if (f) throw new TypeError("Generator is already executing.");
          while (_) try {
              if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
              if (y = 0, t) op = [op[0] & 2, t.value];
              switch (op[0]) {
                  case 0: case 1: t = op; break;
                  case 4: _.label++; return { value: op[1], done: false };
                  case 5: _.label++; y = op[1]; op = [0]; continue;
                  case 7: op = _.ops.pop(); _.trys.pop(); continue;
                  default:
                      if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                      if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                      if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                      if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                      if (t[2]) _.ops.pop();
                      _.trys.pop(); continue;
              }
              op = body.call(thisArg, _);
          } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
          if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
      }
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
  var _this = undefined;
  var ENV = tfjsCore.env();
  /**
   * True if SIMD is supported.
   */
  // From: https://github.com/GoogleChromeLabs/wasm-feature-detect
  ENV.registerFlag(
  // This typed array passed in to WebAssembly.validate is WebAssembly binary
  // code. In this case it is a small program that contains SIMD
  // instructions.
  'WASM_HAS_SIMD_SUPPORT', function () { return __awaiter(_this, void 0, void 0, function () {
      return __generator(this, function (_a) {
          return [2 /*return*/, WebAssembly.validate(new Uint8Array([
                  0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3,
                  2, 1, 0, 10, 9, 1, 7, 0, 65, 0, 253, 15, 26, 11
              ]))];
      });
  }); });
  /**
   * True if threads are supported.
   */
  // From: https://github.com/GoogleChromeLabs/wasm-feature-detect
  ENV.registerFlag('WASM_HAS_MULTITHREAD_SUPPORT', function () { return __awaiter(_this, void 0, void 0, function () {
      return __generator(this, function (_a) {
          // TODO(annxingyuan): Enable node support once this is resolved:
          // https://github.com/tensorflow/tfjs/issues/3830
          if (ENV.get('IS_NODE')) {
              return [2 /*return*/, false];
          }
          try {
              // Test for transferability of SABs (needed for Firefox)
              // https://groups.google.com/forum/#!msg/mozilla.dev.platform/IHkBZlHETpA/dwsMNchWEQAJ
              new MessageChannel().port1.postMessage(new SharedArrayBuffer(1));
              // This typed array is a WebAssembly program containing threaded
              // instructions.
              return [2 /*return*/, WebAssembly.validate(new Uint8Array([
                      0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5,
                      4, 1, 3, 1, 1, 10, 11, 1, 9, 0, 65, 0, 254, 16, 2, 0, 26, 11
                  ]))];
          }
          catch (e) {
              return [2 /*return*/, false];
          }
          return [2 /*return*/];
      });
  }); });

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

  function GROWABLE_HEAP_I8(){if(wasmMemory.buffer!=buffer){updateGlobalBufferAndViews(wasmMemory.buffer);}return HEAP8}function GROWABLE_HEAP_U8(){if(wasmMemory.buffer!=buffer){updateGlobalBufferAndViews(wasmMemory.buffer);}return HEAPU8}function GROWABLE_HEAP_I32(){if(wasmMemory.buffer!=buffer){updateGlobalBufferAndViews(wasmMemory.buffer);}return HEAP32}function GROWABLE_HEAP_F64(){if(wasmMemory.buffer!=buffer){updateGlobalBufferAndViews(wasmMemory.buffer);}return HEAPF64}var Module=typeof WasmBackendModuleThreadedSimd!=="undefined"?WasmBackendModuleThreadedSimd:{};var readyPromiseResolve,readyPromiseReject;Module["ready"]=new Promise(function(resolve,reject){readyPromiseResolve=resolve;readyPromiseReject=reject;});var beforeListeners;if(typeof process!=="undefined"&&process.listeners){beforeListeners={uncaughtException:process.listeners("uncaughtException"),unhandledRejection:process.listeners("unhandledRejection")};}var moduleOverrides=Object.assign({},Module);var quit_=(status,toThrow)=>{throw toThrow};var ENVIRONMENT_IS_WEB=typeof window==="object";var ENVIRONMENT_IS_WORKER=typeof importScripts==="function";var ENVIRONMENT_IS_NODE=typeof process==="object"&&typeof process.versions==="object"&&typeof process.versions.node==="string";var ENVIRONMENT_IS_PTHREAD=Module["ENVIRONMENT_IS_PTHREAD"]||false;var scriptDirectory="";function locateFile(path){if(Module["locateFile"]){return Module["locateFile"](path,scriptDirectory)}return scriptDirectory+path}var read_,readAsync,readBinary;function logExceptionOnExit(e){if(e instanceof ExitStatus)return;let toLog=e;err("exiting due to exception: "+toLog);}var fs$1;var nodePath;var requireNodeFS;if(ENVIRONMENT_IS_NODE){if(ENVIRONMENT_IS_WORKER){scriptDirectory=path.dirname(scriptDirectory)+"/";}else {scriptDirectory=__dirname+"/";}requireNodeFS=(()=>{if(!nodePath){fs$1=fs;nodePath=path;}});read_=function shell_read(filename,binary){requireNodeFS();filename=nodePath["normalize"](filename);return fs$1.readFileSync(filename,binary?undefined:"utf8")};readBinary=(filename=>{var ret=read_(filename,true);if(!ret.buffer){ret=new Uint8Array(ret);}return ret});readAsync=((filename,onload,onerror)=>{requireNodeFS();filename=nodePath["normalize"](filename);fs$1.readFile(filename,function(err,data){if(err)onerror(err);else onload(data.buffer);});});if(process["argv"].length>1){process["argv"][1].replace(/\\/g,"/");}process["argv"].slice(2);process["on"]("uncaughtException",function(ex){if(!(ex instanceof ExitStatus)){throw ex}});process["on"]("unhandledRejection",function(reason){throw reason});quit_=((status,toThrow)=>{if(keepRuntimeAlive()){process["exitCode"]=status;throw toThrow}logExceptionOnExit(toThrow);process["exit"](status);});Module["inspect"]=function(){return "[Emscripten Module object]"};let nodeWorkerThreads;try{nodeWorkerThreads=worker_threads;}catch(e){console.error('The "worker_threads" module is not supported in this node.js build - perhaps a newer version is needed?');throw e}commonjsGlobal.Worker=nodeWorkerThreads.Worker;}else if(ENVIRONMENT_IS_WEB||ENVIRONMENT_IS_WORKER){if(ENVIRONMENT_IS_WORKER){scriptDirectory=self.location.href;}else if(typeof document!=="undefined"&&document.currentScript){scriptDirectory=document.currentScript.src;}if(typeof _scriptDir !== "undefined" && _scriptDir){scriptDirectory=_scriptDir;}if(scriptDirectory.indexOf("blob:")!==0){scriptDirectory=scriptDirectory.substr(0,scriptDirectory.replace(/[?#].*/,"").lastIndexOf("/")+1);}else {scriptDirectory="";}if(!ENVIRONMENT_IS_NODE){read_=(url=>{var xhr=new XMLHttpRequest;xhr.open("GET",url,false);xhr.send(null);return xhr.responseText});if(ENVIRONMENT_IS_WORKER){readBinary=(url=>{var xhr=new XMLHttpRequest;xhr.open("GET",url,false);xhr.responseType="arraybuffer";xhr.send(null);return new Uint8Array(xhr.response)});}readAsync=((url,onload,onerror)=>{var xhr=new XMLHttpRequest;xhr.open("GET",url,true);xhr.responseType="arraybuffer";xhr.onload=(()=>{if(xhr.status==200||xhr.status==0&&xhr.response){onload(xhr.response);return}onerror();});xhr.onerror=onerror;xhr.send(null);});}}if(ENVIRONMENT_IS_NODE){if(typeof performance==="undefined"){commonjsGlobal.performance=perf_hooks.performance;}}var defaultPrint=console.log.bind(console);var defaultPrintErr=console.warn.bind(console);if(ENVIRONMENT_IS_NODE){requireNodeFS();defaultPrint=(str=>fs$1.writeSync(1,str+"\n"));defaultPrintErr=(str=>fs$1.writeSync(2,str+"\n"));}var out=Module["print"]||defaultPrint;var err=Module["printErr"]||defaultPrintErr;Object.assign(Module,moduleOverrides);moduleOverrides=null;if(Module["arguments"]);if(Module["thisProgram"]);if(Module["quit"])quit_=Module["quit"];function warnOnce(text){if(!warnOnce.shown)warnOnce.shown={};if(!warnOnce.shown[text]){warnOnce.shown[text]=1;err(text);}}var wasmBinary;if(Module["wasmBinary"])wasmBinary=Module["wasmBinary"];var noExitRuntime=Module["noExitRuntime"]||true;if(typeof WebAssembly!=="object"){abort("no native wasm support detected");}var wasmMemory;var wasmModule;var ABORT=false;var EXITSTATUS;function getCFunc(ident){var func=Module["_"+ident];return func}function ccall(ident,returnType,argTypes,args,opts){var toC={"string":function(str){var ret=0;if(str!==null&&str!==undefined&&str!==0){var len=(str.length<<2)+1;ret=stackAlloc(len);stringToUTF8(str,ret,len);}return ret},"array":function(arr){var ret=stackAlloc(arr.length);writeArrayToMemory(arr,ret);return ret}};function convertReturnValue(ret){if(returnType==="string")return UTF8ToString(ret);if(returnType==="boolean")return Boolean(ret);return ret}var func=getCFunc(ident);var cArgs=[];var stack=0;if(args){for(var i=0;i<args.length;i++){var converter=toC[argTypes[i]];if(converter){if(stack===0)stack=stackSave();cArgs[i]=converter(args[i]);}else {cArgs[i]=args[i];}}}var ret=func.apply(null,cArgs);function onDone(ret){if(stack!==0)stackRestore(stack);return convertReturnValue(ret)}ret=onDone(ret);return ret}function cwrap(ident,returnType,argTypes,opts){argTypes=argTypes||[];var numericArgs=argTypes.every(function(type){return type==="number"});var numericRet=returnType!=="string";if(numericRet&&numericArgs&&!opts){return getCFunc(ident)}return function(){return ccall(ident,returnType,argTypes,arguments)}}function TextDecoderWrapper(encoding){var textDecoder=new TextDecoder(encoding);this.decode=(data=>{if(data.buffer instanceof SharedArrayBuffer){data=new Uint8Array(data);}return textDecoder.decode.call(textDecoder,data)});}var UTF8Decoder=typeof TextDecoder!=="undefined"?new TextDecoderWrapper("utf8"):undefined;function UTF8ArrayToString(heap,idx,maxBytesToRead){var endIdx=idx+maxBytesToRead;var endPtr=idx;while(heap[endPtr]&&!(endPtr>=endIdx))++endPtr;if(endPtr-idx>16&&heap.subarray&&UTF8Decoder){return UTF8Decoder.decode(heap.subarray(idx,endPtr))}else {var str="";while(idx<endPtr){var u0=heap[idx++];if(!(u0&128)){str+=String.fromCharCode(u0);continue}var u1=heap[idx++]&63;if((u0&224)==192){str+=String.fromCharCode((u0&31)<<6|u1);continue}var u2=heap[idx++]&63;if((u0&240)==224){u0=(u0&15)<<12|u1<<6|u2;}else {u0=(u0&7)<<18|u1<<12|u2<<6|heap[idx++]&63;}if(u0<65536){str+=String.fromCharCode(u0);}else {var ch=u0-65536;str+=String.fromCharCode(55296|ch>>10,56320|ch&1023);}}}return str}function UTF8ToString(ptr,maxBytesToRead){return ptr?UTF8ArrayToString(GROWABLE_HEAP_U8(),ptr,maxBytesToRead):""}function stringToUTF8Array(str,heap,outIdx,maxBytesToWrite){if(!(maxBytesToWrite>0))return 0;var startIdx=outIdx;var endIdx=outIdx+maxBytesToWrite-1;for(var i=0;i<str.length;++i){var u=str.charCodeAt(i);if(u>=55296&&u<=57343){var u1=str.charCodeAt(++i);u=65536+((u&1023)<<10)|u1&1023;}if(u<=127){if(outIdx>=endIdx)break;heap[outIdx++]=u;}else if(u<=2047){if(outIdx+1>=endIdx)break;heap[outIdx++]=192|u>>6;heap[outIdx++]=128|u&63;}else if(u<=65535){if(outIdx+2>=endIdx)break;heap[outIdx++]=224|u>>12;heap[outIdx++]=128|u>>6&63;heap[outIdx++]=128|u&63;}else {if(outIdx+3>=endIdx)break;heap[outIdx++]=240|u>>18;heap[outIdx++]=128|u>>12&63;heap[outIdx++]=128|u>>6&63;heap[outIdx++]=128|u&63;}}heap[outIdx]=0;return outIdx-startIdx}function stringToUTF8(str,outPtr,maxBytesToWrite){return stringToUTF8Array(str,GROWABLE_HEAP_U8(),outPtr,maxBytesToWrite)}function lengthBytesUTF8(str){var len=0;for(var i=0;i<str.length;++i){var u=str.charCodeAt(i);if(u>=55296&&u<=57343)u=65536+((u&1023)<<10)|str.charCodeAt(++i)&1023;if(u<=127)++len;else if(u<=2047)len+=2;else if(u<=65535)len+=3;else len+=4;}return len}typeof TextDecoder!=="undefined"?new TextDecoderWrapper("utf-16le"):undefined;function writeArrayToMemory(array,buffer){GROWABLE_HEAP_I8().set(array,buffer);}function alignUp(x,multiple){if(x%multiple>0){x+=multiple-x%multiple;}return x}var buffer,HEAP8,HEAPU8,HEAP32,HEAPF64;if(ENVIRONMENT_IS_PTHREAD){buffer=Module["buffer"];}function updateGlobalBufferAndViews(buf){buffer=buf;Module["HEAP8"]=HEAP8=new Int8Array(buf);Module["HEAP16"]=new Int16Array(buf);Module["HEAP32"]=HEAP32=new Int32Array(buf);Module["HEAPU8"]=HEAPU8=new Uint8Array(buf);Module["HEAPU16"]=new Uint16Array(buf);Module["HEAPU32"]=new Uint32Array(buf);Module["HEAPF32"]=new Float32Array(buf);Module["HEAPF64"]=HEAPF64=new Float64Array(buf);}var INITIAL_MEMORY=Module["INITIAL_MEMORY"]||16777216;if(ENVIRONMENT_IS_PTHREAD){wasmMemory=Module["wasmMemory"];buffer=Module["buffer"];}else {if(Module["wasmMemory"]){wasmMemory=Module["wasmMemory"];}else {wasmMemory=new WebAssembly.Memory({"initial":INITIAL_MEMORY/65536,"maximum":2147483648/65536,"shared":true});if(!(wasmMemory.buffer instanceof SharedArrayBuffer)){err("requested a shared WebAssembly.Memory but the returned buffer is not a SharedArrayBuffer, indicating that while the browser has SharedArrayBuffer it does not have WebAssembly threads support - you may need to set a flag");if(ENVIRONMENT_IS_NODE){console.log("(on node you may need: --experimental-wasm-threads --experimental-wasm-bulk-memory and also use a recent version)");}throw Error("bad memory")}}}if(wasmMemory){buffer=wasmMemory.buffer;}INITIAL_MEMORY=buffer.byteLength;updateGlobalBufferAndViews(buffer);var wasmTable;var __ATPRERUN__=[];var __ATINIT__=[];var __ATPOSTRUN__=[];var runtimeKeepaliveCounter=0;function keepRuntimeAlive(){return noExitRuntime||runtimeKeepaliveCounter>0}function preRun(){if(Module["preRun"]){if(typeof Module["preRun"]=="function")Module["preRun"]=[Module["preRun"]];while(Module["preRun"].length){addOnPreRun(Module["preRun"].shift());}}callRuntimeCallbacks(__ATPRERUN__);}function initRuntime(){if(ENVIRONMENT_IS_PTHREAD)return;callRuntimeCallbacks(__ATINIT__);}function exitRuntime(){if(ENVIRONMENT_IS_PTHREAD)return;PThread.terminateAllThreads();}function postRun(){if(ENVIRONMENT_IS_PTHREAD)return;if(Module["postRun"]){if(typeof Module["postRun"]=="function")Module["postRun"]=[Module["postRun"]];while(Module["postRun"].length){addOnPostRun(Module["postRun"].shift());}}callRuntimeCallbacks(__ATPOSTRUN__);}function addOnPreRun(cb){__ATPRERUN__.unshift(cb);}function addOnInit(cb){__ATINIT__.unshift(cb);}function addOnPostRun(cb){__ATPOSTRUN__.unshift(cb);}var runDependencies=0;var dependenciesFulfilled=null;function addRunDependency(id){runDependencies++;if(Module["monitorRunDependencies"]){Module["monitorRunDependencies"](runDependencies);}}function removeRunDependency(id){runDependencies--;if(Module["monitorRunDependencies"]){Module["monitorRunDependencies"](runDependencies);}if(runDependencies==0){if(dependenciesFulfilled){var callback=dependenciesFulfilled;dependenciesFulfilled=null;callback();}}}Module["preloadedImages"]={};Module["preloadedAudios"]={};function abort(what){if(ENVIRONMENT_IS_PTHREAD){postMessage({"cmd":"onAbort","arg":what});}else {if(Module["onAbort"]){Module["onAbort"](what);}}what="Aborted("+what+")";err(what);ABORT=true;EXITSTATUS=1;what+=". Build with -s ASSERTIONS=1 for more info.";var e=new WebAssembly.RuntimeError(what);readyPromiseReject(e);throw e}var dataURIPrefix="data:application/octet-stream;base64,";function isDataURI(filename){return filename.startsWith(dataURIPrefix)}function isFileURI(filename){return filename.startsWith("file://")}var wasmBinaryFile;wasmBinaryFile="tfjs-backend-wasm-threaded-simd.wasm";if(!isDataURI(wasmBinaryFile)){wasmBinaryFile=locateFile(wasmBinaryFile);}function getBinary(file){try{if(file==wasmBinaryFile&&wasmBinary){return new Uint8Array(wasmBinary)}if(readBinary){return readBinary(file)}else {throw "both async and sync fetching of the wasm failed"}}catch(err){abort(err);}}function getBinaryPromise(){if(!wasmBinary&&(ENVIRONMENT_IS_WEB||ENVIRONMENT_IS_WORKER)){if(typeof fetch==="function"&&!isFileURI(wasmBinaryFile)){return fetch(wasmBinaryFile,{credentials:"same-origin"}).then(function(response){if(!response["ok"]){throw "failed to load wasm binary file at '"+wasmBinaryFile+"'"}return response["arrayBuffer"]()}).catch(function(){return getBinary(wasmBinaryFile)})}else {if(readAsync){return new Promise(function(resolve,reject){readAsync(wasmBinaryFile,function(response){resolve(new Uint8Array(response));},reject);})}}}return Promise.resolve().then(function(){return getBinary(wasmBinaryFile)})}function createWasm(){var info={"env":asmLibraryArg,"wasi_snapshot_preview1":asmLibraryArg};function receiveInstance(instance,module){var exports=instance.exports;Module["asm"]=exports;registerTlsInit(Module["asm"]["emscripten_tls_init"]);wasmTable=Module["asm"]["__indirect_function_table"];addOnInit(Module["asm"]["__wasm_call_ctors"]);wasmModule=module;if(!ENVIRONMENT_IS_PTHREAD){var numWorkersToLoad=PThread.unusedWorkers.length;PThread.unusedWorkers.forEach(function(w){PThread.loadWasmModuleToWorker(w,function(){if(!--numWorkersToLoad)removeRunDependency();});});}}if(!ENVIRONMENT_IS_PTHREAD){addRunDependency();}function receiveInstantiationResult(result){receiveInstance(result["instance"],result["module"]);}function instantiateArrayBuffer(receiver){return getBinaryPromise().then(function(binary){return WebAssembly.instantiate(binary,info)}).then(function(instance){return instance}).then(receiver,function(reason){err("failed to asynchronously prepare wasm: "+reason);abort(reason);})}function instantiateAsync(){if(!wasmBinary&&typeof WebAssembly.instantiateStreaming==="function"&&!isDataURI(wasmBinaryFile)&&!isFileURI(wasmBinaryFile)&&typeof fetch==="function"){return fetch(wasmBinaryFile,{credentials:"same-origin"}).then(function(response){var result=WebAssembly.instantiateStreaming(response,info);return result.then(receiveInstantiationResult,function(reason){err("wasm streaming compile failed: "+reason);err("falling back to ArrayBuffer instantiation");return instantiateArrayBuffer(receiveInstantiationResult)})})}else {return instantiateArrayBuffer(receiveInstantiationResult)}}if(Module["instantiateWasm"]){try{var exports=Module["instantiateWasm"](info,receiveInstance);return exports}catch(e){err("Module.instantiateWasm callback failed with error: "+e);return false}}instantiateAsync().catch(readyPromiseReject);return {}}var ASM_CONSTS={};function callRuntimeCallbacks(callbacks){while(callbacks.length>0){var callback=callbacks.shift();if(typeof callback=="function"){callback(Module);continue}var func=callback.func;if(typeof func==="number"){if(callback.arg===undefined){getWasmTableEntry(func)();}else {getWasmTableEntry(func)(callback.arg);}}else {func(callback.arg===undefined?null:callback.arg);}}}function withStackSave(f){var stack=stackSave();var ret=f();stackRestore(stack);return ret}function killThread(pthread_ptr){GROWABLE_HEAP_I32()[pthread_ptr>>2]=0;var pthread=PThread.pthreads[pthread_ptr];delete PThread.pthreads[pthread_ptr];pthread.worker.terminate();__emscripten_thread_free_data(pthread_ptr);PThread.runningWorkers.splice(PThread.runningWorkers.indexOf(pthread.worker),1);pthread.worker.pthread=undefined;}function cancelThread(pthread_ptr){var pthread=PThread.pthreads[pthread_ptr];pthread.worker.postMessage({"cmd":"cancel"});}function cleanupThread(pthread_ptr){var pthread=PThread.pthreads[pthread_ptr];if(pthread){GROWABLE_HEAP_I32()[pthread_ptr>>2]=0;var worker=pthread.worker;PThread.returnWorkerToPool(worker);}}function _exit(status){exit(status);}function handleException(e){if(e instanceof ExitStatus||e=="unwind"){return EXITSTATUS}quit_(1,e);}var PThread={unusedWorkers:[],runningWorkers:[],tlsInitFunctions:[],init:function(){if(ENVIRONMENT_IS_PTHREAD){PThread.initWorker();}else {PThread.initMainThread();}},initMainThread:function(){var pthreadPoolSize=8;for(var i=0;i<pthreadPoolSize;++i){PThread.allocateUnusedWorker();}},initWorker:function(){noExitRuntime=false;},pthreads:{},setExitStatus:function(status){EXITSTATUS=status;},terminateAllThreads:function(){for(var t in PThread.pthreads){var pthread=PThread.pthreads[t];if(pthread&&pthread.worker){PThread.returnWorkerToPool(pthread.worker);}}for(var i=0;i<PThread.unusedWorkers.length;++i){var worker=PThread.unusedWorkers[i];worker.terminate();}PThread.unusedWorkers=[];},returnWorkerToPool:function(worker){PThread.runWithoutMainThreadQueuedCalls(function(){delete PThread.pthreads[worker.pthread.threadInfoStruct];PThread.unusedWorkers.push(worker);PThread.runningWorkers.splice(PThread.runningWorkers.indexOf(worker),1);__emscripten_thread_free_data(worker.pthread.threadInfoStruct);worker.pthread=undefined;});},runWithoutMainThreadQueuedCalls:function(func){GROWABLE_HEAP_I32()[__emscripten_allow_main_runtime_queued_calls>>2]=0;try{func();}finally{GROWABLE_HEAP_I32()[__emscripten_allow_main_runtime_queued_calls>>2]=1;}},receiveObjectTransfer:function(data){},threadInit:function(){for(var i in PThread.tlsInitFunctions){PThread.tlsInitFunctions[i]();}},loadWasmModuleToWorker:function(worker,onFinishedLoading){worker.onmessage=(e=>{var d=e["data"];var cmd=d["cmd"];if(worker.pthread)PThread.currentProxiedOperationCallerThread=worker.pthread.threadInfoStruct;if(d["targetThread"]&&d["targetThread"]!=_pthread_self()){var thread=PThread.pthreads[d.targetThread];if(thread){thread.worker.postMessage(d,d["transferList"]);}else {err('Internal error! Worker sent a message "'+cmd+'" to target pthread '+d["targetThread"]+", but that thread no longer exists!");}PThread.currentProxiedOperationCallerThread=undefined;return}if(cmd==="processQueuedMainThreadWork"){_emscripten_main_thread_process_queued_calls();}else if(cmd==="spawnThread"){spawnThread(d);}else if(cmd==="cleanupThread"){cleanupThread(d["thread"]);}else if(cmd==="killThread"){killThread(d["thread"]);}else if(cmd==="cancelThread"){cancelThread(d["thread"]);}else if(cmd==="loaded"){worker.loaded=true;if(onFinishedLoading)onFinishedLoading(worker);if(worker.runPthread){worker.runPthread();delete worker.runPthread;}}else if(cmd==="print"){out("Thread "+d["threadId"]+": "+d["text"]);}else if(cmd==="printErr"){err("Thread "+d["threadId"]+": "+d["text"]);}else if(cmd==="alert"){alert("Thread "+d["threadId"]+": "+d["text"]);}else if(d.target==="setimmediate"){worker.postMessage(d);}else if(cmd==="onAbort"){if(Module["onAbort"]){Module["onAbort"](d["arg"]);}}else {err("worker sent an unknown command "+cmd);}PThread.currentProxiedOperationCallerThread=undefined;});worker.onerror=(e=>{var message="worker sent an error!";err(message+" "+e.filename+":"+e.lineno+": "+e.message);throw e});if(ENVIRONMENT_IS_NODE){worker.on("message",function(data){worker.onmessage({data:data});});worker.on("error",function(e){worker.onerror(e);});worker.on("detachedExit",function(){});}worker.postMessage({"cmd":"load","urlOrBlob":Module["mainScriptUrlOrBlob"]||_scriptDir,"wasmMemory":wasmMemory,"wasmModule":wasmModule});},allocateUnusedWorker:function(){var pthreadMainJs=locateFile("tfjs-backend-wasm-threaded-simd.worker.js");PThread.unusedWorkers.push(new Worker(pthreadMainJs));},getNewWorker:function(){if(PThread.unusedWorkers.length==0){PThread.allocateUnusedWorker();PThread.loadWasmModuleToWorker(PThread.unusedWorkers[0]);}return PThread.unusedWorkers.pop()}};function establishStackSpace(){var pthread_ptr=_pthread_self();var stackTop=GROWABLE_HEAP_I32()[pthread_ptr+44>>2];var stackSize=GROWABLE_HEAP_I32()[pthread_ptr+48>>2];var stackMax=stackTop-stackSize;_emscripten_stack_set_limits(stackTop,stackMax);stackRestore(stackTop);}Module["establishStackSpace"]=establishStackSpace;function exitOnMainThread(returnCode){if(ENVIRONMENT_IS_PTHREAD)return _emscripten_proxy_to_main_thread_js(1,0,returnCode);try{_exit(returnCode);}catch(e){handleException(e);}}var wasmTableMirror=[];function getWasmTableEntry(funcPtr){var func=wasmTableMirror[funcPtr];if(!func){if(funcPtr>=wasmTableMirror.length)wasmTableMirror.length=funcPtr+1;wasmTableMirror[funcPtr]=func=wasmTable.get(funcPtr);}return func}function invokeEntryPoint(ptr,arg){return getWasmTableEntry(ptr)(arg)}Module["invokeEntryPoint"]=invokeEntryPoint;function registerTlsInit(tlsInitFunc,moduleExports,metadata){PThread.tlsInitFunctions.push(tlsInitFunc);}var _emscripten_get_now;if(ENVIRONMENT_IS_NODE){_emscripten_get_now=(()=>{var t=process["hrtime"]();return t[0]*1e3+t[1]/1e6});}else if(ENVIRONMENT_IS_PTHREAD){_emscripten_get_now=(()=>performance.now()-Module["__performance_now_clock_drift"]);}else _emscripten_get_now=(()=>performance.now());var _emscripten_get_now_is_monotonic=true;function setErrNo(value){GROWABLE_HEAP_I32()[___errno_location()>>2]=value;return value}function _clock_gettime(clk_id,tp){var now;if(clk_id===0){now=Date.now();}else if((clk_id===1||clk_id===4)&&_emscripten_get_now_is_monotonic){now=_emscripten_get_now();}else {setErrNo(28);return -1}GROWABLE_HEAP_I32()[tp>>2]=now/1e3|0;GROWABLE_HEAP_I32()[tp+4>>2]=now%1e3*1e3*1e3|0;return 0}function ___clock_gettime(a0,a1){return _clock_gettime(a0,a1)}function ___emscripten_init_main_thread_js(tb){__emscripten_thread_init(tb,!ENVIRONMENT_IS_WORKER,1,!ENVIRONMENT_IS_WEB);PThread.threadInit();}function ___emscripten_thread_cleanup(thread){if(!ENVIRONMENT_IS_PTHREAD)cleanupThread(thread);else postMessage({"cmd":"cleanupThread","thread":thread});}function spawnThread(threadParams){var worker=PThread.getNewWorker();if(!worker){return 6}PThread.runningWorkers.push(worker);var pthread=PThread.pthreads[threadParams.pthread_ptr]={worker:worker,threadInfoStruct:threadParams.pthread_ptr};worker.pthread=pthread;var msg={"cmd":"run","start_routine":threadParams.startRoutine,"arg":threadParams.arg,"threadInfoStruct":threadParams.pthread_ptr};worker.runPthread=(()=>{msg.time=performance.now();worker.postMessage(msg,threadParams.transferList);});if(worker.loaded){worker.runPthread();delete worker.runPthread;}return 0}function ___pthread_create_js(pthread_ptr,attr,start_routine,arg){if(typeof SharedArrayBuffer==="undefined"){err("Current environment does not support SharedArrayBuffer, pthreads are not available!");return 6}var transferList=[];var error=0;if(ENVIRONMENT_IS_PTHREAD&&(transferList.length===0||error)){return _emscripten_sync_run_in_main_thread_4(687865856,pthread_ptr,attr,start_routine,arg)}var threadParams={startRoutine:start_routine,pthread_ptr:pthread_ptr,arg:arg,transferList:transferList};if(ENVIRONMENT_IS_PTHREAD){threadParams.cmd="spawnThread";postMessage(threadParams,transferList);return 0}return spawnThread(threadParams)}function __emscripten_default_pthread_stack_size(){return 2097152}function __emscripten_notify_thread_queue(targetThreadId,mainThreadId){if(targetThreadId==mainThreadId){postMessage({"cmd":"processQueuedMainThreadWork"});}else if(ENVIRONMENT_IS_PTHREAD){postMessage({"targetThread":targetThreadId,"cmd":"processThreadQueue"});}else {var pthread=PThread.pthreads[targetThreadId];var worker=pthread&&pthread.worker;if(!worker){return}worker.postMessage({"cmd":"processThreadQueue"});}return 1}function _abort(){abort("");}function _emscripten_check_blocking_allowed(){if(ENVIRONMENT_IS_NODE)return;if(ENVIRONMENT_IS_WORKER)return;warnOnce("Blocking on the main thread is very dangerous, see https://emscripten.org/docs/porting/pthreads.html#blocking-on-the-main-browser-thread");}function _emscripten_get_heap_max(){return 2147483648}function _emscripten_memcpy_big(dest,src,num){GROWABLE_HEAP_U8().copyWithin(dest,src,src+num);}function _emscripten_num_logical_cores(){if(ENVIRONMENT_IS_NODE)return os.cpus().length;return navigator["hardwareConcurrency"]}function _emscripten_proxy_to_main_thread_js(index,sync){var numCallArgs=arguments.length-2;var outerArgs=arguments;return withStackSave(function(){var serializedNumCallArgs=numCallArgs;var args=stackAlloc(serializedNumCallArgs*8);var b=args>>3;for(var i=0;i<numCallArgs;i++){var arg=outerArgs[2+i];GROWABLE_HEAP_F64()[b+i]=arg;}return _emscripten_run_in_main_runtime_thread_js(index,serializedNumCallArgs,args,sync)})}var _emscripten_receive_on_main_thread_js_callArgs=[];function _emscripten_receive_on_main_thread_js(index,numCallArgs,args){_emscripten_receive_on_main_thread_js_callArgs.length=numCallArgs;var b=args>>3;for(var i=0;i<numCallArgs;i++){_emscripten_receive_on_main_thread_js_callArgs[i]=GROWABLE_HEAP_F64()[b+i];}var isEmAsmConst=index<0;var func=!isEmAsmConst?proxiedFunctionTable[index]:ASM_CONSTS[-index-1];return func.apply(null,_emscripten_receive_on_main_thread_js_callArgs)}function emscripten_realloc_buffer(size){try{wasmMemory.grow(size-buffer.byteLength+65535>>>16);updateGlobalBufferAndViews(wasmMemory.buffer);return 1}catch(e){}}function _emscripten_resize_heap(requestedSize){var oldSize=GROWABLE_HEAP_U8().length;requestedSize=requestedSize>>>0;if(requestedSize<=oldSize){return false}var maxHeapSize=_emscripten_get_heap_max();if(requestedSize>maxHeapSize){return false}for(var cutDown=1;cutDown<=4;cutDown*=2){var overGrownHeapSize=oldSize*(1+.2/cutDown);overGrownHeapSize=Math.min(overGrownHeapSize,requestedSize+100663296);var newSize=Math.min(maxHeapSize,alignUp(Math.max(requestedSize,overGrownHeapSize),65536));var replacement=emscripten_realloc_buffer(newSize);if(replacement){return true}}return false}var JSEvents={inEventHandler:0,removeAllEventListeners:function(){for(var i=JSEvents.eventHandlers.length-1;i>=0;--i){JSEvents._removeHandler(i);}JSEvents.eventHandlers=[];JSEvents.deferredCalls=[];},registerRemoveEventListeners:function(){if(!JSEvents.removeEventListenersRegistered){JSEvents.removeEventListenersRegistered=true;}},deferredCalls:[],deferCall:function(targetFunction,precedence,argsList){function arraysHaveEqualContent(arrA,arrB){if(arrA.length!=arrB.length)return false;for(var i in arrA){if(arrA[i]!=arrB[i])return false}return true}for(var i in JSEvents.deferredCalls){var call=JSEvents.deferredCalls[i];if(call.targetFunction==targetFunction&&arraysHaveEqualContent(call.argsList,argsList)){return}}JSEvents.deferredCalls.push({targetFunction:targetFunction,precedence:precedence,argsList:argsList});JSEvents.deferredCalls.sort(function(x,y){return x.precedence<y.precedence});},removeDeferredCalls:function(targetFunction){for(var i=0;i<JSEvents.deferredCalls.length;++i){if(JSEvents.deferredCalls[i].targetFunction==targetFunction){JSEvents.deferredCalls.splice(i,1);--i;}}},canPerformEventHandlerRequests:function(){return JSEvents.inEventHandler&&JSEvents.currentEventHandler.allowsDeferredCalls},runDeferredCalls:function(){if(!JSEvents.canPerformEventHandlerRequests()){return}for(var i=0;i<JSEvents.deferredCalls.length;++i){var call=JSEvents.deferredCalls[i];JSEvents.deferredCalls.splice(i,1);--i;call.targetFunction.apply(null,call.argsList);}},eventHandlers:[],removeAllHandlersOnTarget:function(target,eventTypeString){for(var i=0;i<JSEvents.eventHandlers.length;++i){if(JSEvents.eventHandlers[i].target==target&&(!eventTypeString||eventTypeString==JSEvents.eventHandlers[i].eventTypeString)){JSEvents._removeHandler(i--);}}},_removeHandler:function(i){var h=JSEvents.eventHandlers[i];h.target.removeEventListener(h.eventTypeString,h.eventListenerFunc,h.useCapture);JSEvents.eventHandlers.splice(i,1);},registerOrRemoveHandler:function(eventHandler){var jsEventHandler=function jsEventHandler(event){++JSEvents.inEventHandler;JSEvents.currentEventHandler=eventHandler;JSEvents.runDeferredCalls();eventHandler.handlerFunc(event);JSEvents.runDeferredCalls();--JSEvents.inEventHandler;};if(eventHandler.callbackfunc){eventHandler.eventListenerFunc=jsEventHandler;eventHandler.target.addEventListener(eventHandler.eventTypeString,jsEventHandler,eventHandler.useCapture);JSEvents.eventHandlers.push(eventHandler);JSEvents.registerRemoveEventListeners();}else {for(var i=0;i<JSEvents.eventHandlers.length;++i){if(JSEvents.eventHandlers[i].target==eventHandler.target&&JSEvents.eventHandlers[i].eventTypeString==eventHandler.eventTypeString){JSEvents._removeHandler(i--);}}}},queueEventHandlerOnThread_iiii:function(targetThread,eventHandlerFunc,eventTypeId,eventData,userData){withStackSave(function(){var varargs=stackAlloc(12);GROWABLE_HEAP_I32()[varargs>>2]=eventTypeId;GROWABLE_HEAP_I32()[varargs+4>>2]=eventData;GROWABLE_HEAP_I32()[varargs+8>>2]=userData;_emscripten_dispatch_to_thread_(targetThread,637534208,eventHandlerFunc,eventData,varargs);});},getTargetThreadForEventCallback:function(targetThread){switch(targetThread){case 1:return 0;case 2:return PThread.currentProxiedOperationCallerThread;default:return targetThread}},getNodeNameForTarget:function(target){if(!target)return "";if(target==window)return "#window";if(target==screen)return "#screen";return target&&target.nodeName?target.nodeName:""},fullscreenEnabled:function(){return document.fullscreenEnabled||document.webkitFullscreenEnabled}};function stringToNewUTF8(jsString){var length=lengthBytesUTF8(jsString)+1;var cString=_malloc(length);stringToUTF8(jsString,cString,length);return cString}function _emscripten_set_offscreencanvas_size_on_target_thread_js(targetThread,targetCanvas,width,height){withStackSave(function(){var varargs=stackAlloc(12);var targetCanvasPtr=0;if(targetCanvas){targetCanvasPtr=stringToNewUTF8(targetCanvas);}GROWABLE_HEAP_I32()[varargs>>2]=targetCanvasPtr;GROWABLE_HEAP_I32()[varargs+4>>2]=width;GROWABLE_HEAP_I32()[varargs+8>>2]=height;_emscripten_dispatch_to_thread_(targetThread,657457152,0,targetCanvasPtr,varargs);});}function _emscripten_set_offscreencanvas_size_on_target_thread(targetThread,targetCanvas,width,height){targetCanvas=targetCanvas?UTF8ToString(targetCanvas):"";_emscripten_set_offscreencanvas_size_on_target_thread_js(targetThread,targetCanvas,width,height);}function maybeCStringToJsString(cString){return cString>2?UTF8ToString(cString):cString}var specialHTMLTargets=[0,typeof document!=="undefined"?document:0,typeof window!=="undefined"?window:0];function findEventTarget(target){target=maybeCStringToJsString(target);var domElement=specialHTMLTargets[target]||(typeof document!=="undefined"?document.querySelector(target):undefined);return domElement}function findCanvasEventTarget(target){return findEventTarget(target)}function _emscripten_set_canvas_element_size_calling_thread(target,width,height){var canvas=findCanvasEventTarget(target);if(!canvas)return -4;if(canvas.canvasSharedPtr){GROWABLE_HEAP_I32()[canvas.canvasSharedPtr>>2]=width;GROWABLE_HEAP_I32()[canvas.canvasSharedPtr+4>>2]=height;}if(canvas.offscreenCanvas||!canvas.controlTransferredOffscreen){if(canvas.offscreenCanvas)canvas=canvas.offscreenCanvas;var autoResizeViewport=false;if(canvas.GLctxObject&&canvas.GLctxObject.GLctx){var prevViewport=canvas.GLctxObject.GLctx.getParameter(2978);autoResizeViewport=prevViewport[0]===0&&prevViewport[1]===0&&prevViewport[2]===canvas.width&&prevViewport[3]===canvas.height;}canvas.width=width;canvas.height=height;if(autoResizeViewport){canvas.GLctxObject.GLctx.viewport(0,0,width,height);}}else if(canvas.canvasSharedPtr){var targetThread=GROWABLE_HEAP_I32()[canvas.canvasSharedPtr+8>>2];_emscripten_set_offscreencanvas_size_on_target_thread(targetThread,target,width,height);return 1}else {return -4}return 0}function _emscripten_set_canvas_element_size_main_thread(target,width,height){if(ENVIRONMENT_IS_PTHREAD)return _emscripten_proxy_to_main_thread_js(2,1,target,width,height);return _emscripten_set_canvas_element_size_calling_thread(target,width,height)}function _emscripten_set_canvas_element_size(target,width,height){var canvas=findCanvasEventTarget(target);if(canvas){return _emscripten_set_canvas_element_size_calling_thread(target,width,height)}else {return _emscripten_set_canvas_element_size_main_thread(target,width,height)}}function _emscripten_unwind_to_js_event_loop(){throw "unwind"}function __webgl_enable_ANGLE_instanced_arrays(ctx){var ext=ctx.getExtension("ANGLE_instanced_arrays");if(ext){ctx["vertexAttribDivisor"]=function(index,divisor){ext["vertexAttribDivisorANGLE"](index,divisor);};ctx["drawArraysInstanced"]=function(mode,first,count,primcount){ext["drawArraysInstancedANGLE"](mode,first,count,primcount);};ctx["drawElementsInstanced"]=function(mode,count,type,indices,primcount){ext["drawElementsInstancedANGLE"](mode,count,type,indices,primcount);};return 1}}function __webgl_enable_OES_vertex_array_object(ctx){var ext=ctx.getExtension("OES_vertex_array_object");if(ext){ctx["createVertexArray"]=function(){return ext["createVertexArrayOES"]()};ctx["deleteVertexArray"]=function(vao){ext["deleteVertexArrayOES"](vao);};ctx["bindVertexArray"]=function(vao){ext["bindVertexArrayOES"](vao);};ctx["isVertexArray"]=function(vao){return ext["isVertexArrayOES"](vao)};return 1}}function __webgl_enable_WEBGL_draw_buffers(ctx){var ext=ctx.getExtension("WEBGL_draw_buffers");if(ext){ctx["drawBuffers"]=function(n,bufs){ext["drawBuffersWEBGL"](n,bufs);};return 1}}function __webgl_enable_WEBGL_multi_draw(ctx){return !!(ctx.multiDrawWebgl=ctx.getExtension("WEBGL_multi_draw"))}var GL={counter:1,buffers:[],programs:[],framebuffers:[],renderbuffers:[],textures:[],shaders:[],vaos:[],contexts:{},offscreenCanvases:{},queries:[],stringCache:{},unpackAlignment:4,recordError:function recordError(errorCode){if(!GL.lastError){GL.lastError=errorCode;}},getNewId:function(table){var ret=GL.counter++;for(var i=table.length;i<ret;i++){table[i]=null;}return ret},getSource:function(shader,count,string,length){var source="";for(var i=0;i<count;++i){var len=length?GROWABLE_HEAP_I32()[length+i*4>>2]:-1;source+=UTF8ToString(GROWABLE_HEAP_I32()[string+i*4>>2],len<0?undefined:len);}return source},createContext:function(canvas,webGLContextAttributes){if(!canvas.getContextSafariWebGL2Fixed){canvas.getContextSafariWebGL2Fixed=canvas.getContext;canvas.getContext=function(ver,attrs){var gl=canvas.getContextSafariWebGL2Fixed(ver,attrs);return ver=="webgl"==gl instanceof WebGLRenderingContext?gl:null};}var ctx=canvas.getContext("webgl",webGLContextAttributes);if(!ctx)return 0;var handle=GL.registerContext(ctx,webGLContextAttributes);return handle},registerContext:function(ctx,webGLContextAttributes){var handle=_malloc(8);GROWABLE_HEAP_I32()[handle+4>>2]=_pthread_self();var context={handle:handle,attributes:webGLContextAttributes,version:webGLContextAttributes.majorVersion,GLctx:ctx};if(ctx.canvas)ctx.canvas.GLctxObject=context;GL.contexts[handle]=context;if(typeof webGLContextAttributes.enableExtensionsByDefault==="undefined"||webGLContextAttributes.enableExtensionsByDefault){GL.initExtensions(context);}return handle},makeContextCurrent:function(contextHandle){GL.currentContext=GL.contexts[contextHandle];Module.ctx=GLctx=GL.currentContext&&GL.currentContext.GLctx;return !(contextHandle&&!GLctx)},getContext:function(contextHandle){return GL.contexts[contextHandle]},deleteContext:function(contextHandle){if(GL.currentContext===GL.contexts[contextHandle])GL.currentContext=null;if(typeof JSEvents==="object")JSEvents.removeAllHandlersOnTarget(GL.contexts[contextHandle].GLctx.canvas);if(GL.contexts[contextHandle]&&GL.contexts[contextHandle].GLctx.canvas)GL.contexts[contextHandle].GLctx.canvas.GLctxObject=undefined;_free(GL.contexts[contextHandle].handle);GL.contexts[contextHandle]=null;},initExtensions:function(context){if(!context)context=GL.currentContext;if(context.initExtensionsDone)return;context.initExtensionsDone=true;var GLctx=context.GLctx;__webgl_enable_ANGLE_instanced_arrays(GLctx);__webgl_enable_OES_vertex_array_object(GLctx);__webgl_enable_WEBGL_draw_buffers(GLctx);{GLctx.disjointTimerQueryExt=GLctx.getExtension("EXT_disjoint_timer_query");}__webgl_enable_WEBGL_multi_draw(GLctx);var exts=GLctx.getSupportedExtensions()||[];exts.forEach(function(ext){if(!ext.includes("lose_context")&&!ext.includes("debug")){GLctx.getExtension(ext);}});}};var __emscripten_webgl_power_preferences=["default","low-power","high-performance"];function _emscripten_webgl_do_create_context(target,attributes){var a=attributes>>2;var powerPreference=GROWABLE_HEAP_I32()[a+(24>>2)];var contextAttributes={"alpha":!!GROWABLE_HEAP_I32()[a+(0>>2)],"depth":!!GROWABLE_HEAP_I32()[a+(4>>2)],"stencil":!!GROWABLE_HEAP_I32()[a+(8>>2)],"antialias":!!GROWABLE_HEAP_I32()[a+(12>>2)],"premultipliedAlpha":!!GROWABLE_HEAP_I32()[a+(16>>2)],"preserveDrawingBuffer":!!GROWABLE_HEAP_I32()[a+(20>>2)],"powerPreference":__emscripten_webgl_power_preferences[powerPreference],"failIfMajorPerformanceCaveat":!!GROWABLE_HEAP_I32()[a+(28>>2)],majorVersion:GROWABLE_HEAP_I32()[a+(32>>2)],minorVersion:GROWABLE_HEAP_I32()[a+(36>>2)],enableExtensionsByDefault:GROWABLE_HEAP_I32()[a+(40>>2)],explicitSwapControl:GROWABLE_HEAP_I32()[a+(44>>2)],proxyContextToMainThread:GROWABLE_HEAP_I32()[a+(48>>2)],renderViaOffscreenBackBuffer:GROWABLE_HEAP_I32()[a+(52>>2)]};var canvas=findCanvasEventTarget(target);if(!canvas){return 0}if(contextAttributes.explicitSwapControl){return 0}var contextHandle=GL.createContext(canvas,contextAttributes);return contextHandle}function _emscripten_webgl_create_context(a0,a1){return _emscripten_webgl_do_create_context(a0,a1)}var SYSCALLS={mappings:{},buffers:[null,[],[]],printChar:function(stream,curr){var buffer=SYSCALLS.buffers[stream];if(curr===0||curr===10){(stream===1?out:err)(UTF8ArrayToString(buffer,0));buffer.length=0;}else {buffer.push(curr);}},varargs:undefined,get:function(){SYSCALLS.varargs+=4;var ret=GROWABLE_HEAP_I32()[SYSCALLS.varargs-4>>2];return ret},getStr:function(ptr){var ret=UTF8ToString(ptr);return ret},get64:function(low,high){return low}};function _fd_close(fd){if(ENVIRONMENT_IS_PTHREAD)return _emscripten_proxy_to_main_thread_js(3,1,fd);return 0}function _fd_seek(fd,offset_low,offset_high,whence,newOffset){if(ENVIRONMENT_IS_PTHREAD)return _emscripten_proxy_to_main_thread_js(4,1,fd,offset_low,offset_high,whence,newOffset)}function _fd_write(fd,iov,iovcnt,pnum){if(ENVIRONMENT_IS_PTHREAD)return _emscripten_proxy_to_main_thread_js(5,1,fd,iov,iovcnt,pnum);var num=0;for(var i=0;i<iovcnt;i++){var ptr=GROWABLE_HEAP_I32()[iov>>2];var len=GROWABLE_HEAP_I32()[iov+4>>2];iov+=8;for(var j=0;j<len;j++){SYSCALLS.printChar(fd,GROWABLE_HEAP_U8()[ptr+j]);}num+=len;}GROWABLE_HEAP_I32()[pnum>>2]=num;return 0}function _setTempRet0(val){}PThread.init();var GLctx;var proxiedFunctionTable=[null,exitOnMainThread,_emscripten_set_canvas_element_size_main_thread,_fd_close,_fd_seek,_fd_write];var asmLibraryArg={"__clock_gettime":___clock_gettime,"__emscripten_init_main_thread_js":___emscripten_init_main_thread_js,"__emscripten_thread_cleanup":___emscripten_thread_cleanup,"__pthread_create_js":___pthread_create_js,"_emscripten_default_pthread_stack_size":__emscripten_default_pthread_stack_size,"_emscripten_notify_thread_queue":__emscripten_notify_thread_queue,"abort":_abort,"emscripten_check_blocking_allowed":_emscripten_check_blocking_allowed,"emscripten_get_heap_max":_emscripten_get_heap_max,"emscripten_get_now":_emscripten_get_now,"emscripten_memcpy_big":_emscripten_memcpy_big,"emscripten_num_logical_cores":_emscripten_num_logical_cores,"emscripten_receive_on_main_thread_js":_emscripten_receive_on_main_thread_js,"emscripten_resize_heap":_emscripten_resize_heap,"emscripten_set_canvas_element_size":_emscripten_set_canvas_element_size,"emscripten_unwind_to_js_event_loop":_emscripten_unwind_to_js_event_loop,"emscripten_webgl_create_context":_emscripten_webgl_create_context,"exit":_exit,"fd_close":_fd_close,"fd_seek":_fd_seek,"fd_write":_fd_write,"memory":wasmMemory||Module["wasmMemory"],"setTempRet0":_setTempRet0};createWasm();Module["___wasm_call_ctors"]=function(){return (Module["___wasm_call_ctors"]=Module["asm"]["__wasm_call_ctors"]).apply(null,arguments)};Module["_init"]=function(){return (Module["_init"]=Module["asm"]["init"]).apply(null,arguments)};Module["_init_with_threads_count"]=function(){return (Module["_init_with_threads_count"]=Module["asm"]["init_with_threads_count"]).apply(null,arguments)};Module["_get_threads_count"]=function(){return (Module["_get_threads_count"]=Module["asm"]["get_threads_count"]).apply(null,arguments)};Module["_register_tensor"]=function(){return (Module["_register_tensor"]=Module["asm"]["register_tensor"]).apply(null,arguments)};Module["_dispose_data"]=function(){return (Module["_dispose_data"]=Module["asm"]["dispose_data"]).apply(null,arguments)};Module["_dispose"]=function(){return (Module["_dispose"]=Module["asm"]["dispose"]).apply(null,arguments)};Module["_Abs"]=function(){return (Module["_Abs"]=Module["asm"]["Abs"]).apply(null,arguments)};Module["_Add"]=function(){return (Module["_Add"]=Module["asm"]["Add"]).apply(null,arguments)};Module["_AddN"]=function(){return (Module["_AddN"]=Module["asm"]["AddN"]).apply(null,arguments)};Module["_All"]=function(){return (Module["_All"]=Module["asm"]["All"]).apply(null,arguments)};Module["_Any"]=function(){return (Module["_Any"]=Module["asm"]["Any"]).apply(null,arguments)};Module["_ArgMax"]=function(){return (Module["_ArgMax"]=Module["asm"]["ArgMax"]).apply(null,arguments)};Module["_AvgPool"]=function(){return (Module["_AvgPool"]=Module["asm"]["AvgPool"]).apply(null,arguments)};Module["_BatchMatMul"]=function(){return (Module["_BatchMatMul"]=Module["asm"]["BatchMatMul"]).apply(null,arguments)};Module["_Ceil"]=function(){return (Module["_Ceil"]=Module["asm"]["Ceil"]).apply(null,arguments)};Module["_ClipByValue"]=function(){return (Module["_ClipByValue"]=Module["asm"]["ClipByValue"]).apply(null,arguments)};Module["_Conv2D"]=function(){return (Module["_Conv2D"]=Module["asm"]["Conv2D"]).apply(null,arguments)};Module["_Conv2DBackpropInput"]=function(){return (Module["_Conv2DBackpropInput"]=Module["asm"]["Conv2DBackpropInput"]).apply(null,arguments)};Module["_Cos"]=function(){return (Module["_Cos"]=Module["asm"]["Cos"]).apply(null,arguments)};Module["_Cosh"]=function(){return (Module["_Cosh"]=Module["asm"]["Cosh"]).apply(null,arguments)};Module["_CropAndResize"]=function(){return (Module["_CropAndResize"]=Module["asm"]["CropAndResize"]).apply(null,arguments)};Module["_Cumprod"]=function(){return (Module["_Cumprod"]=Module["asm"]["Cumprod"]).apply(null,arguments)};Module["_Cumsum"]=function(){return (Module["_Cumsum"]=Module["asm"]["Cumsum"]).apply(null,arguments)};Module["_DepthToSpace"]=function(){return (Module["_DepthToSpace"]=Module["asm"]["DepthToSpace"]).apply(null,arguments)};Module["_DepthwiseConv2dNative"]=function(){return (Module["_DepthwiseConv2dNative"]=Module["asm"]["DepthwiseConv2dNative"]).apply(null,arguments)};Module["_Elu"]=function(){return (Module["_Elu"]=Module["asm"]["Elu"]).apply(null,arguments)};Module["_Equal"]=function(){return (Module["_Equal"]=Module["asm"]["Equal"]).apply(null,arguments)};Module["_Exp"]=function(){return (Module["_Exp"]=Module["asm"]["Exp"]).apply(null,arguments)};Module["_FlipLeftRight"]=function(){return (Module["_FlipLeftRight"]=Module["asm"]["FlipLeftRight"]).apply(null,arguments)};Module["_Floor"]=function(){return (Module["_Floor"]=Module["asm"]["Floor"]).apply(null,arguments)};Module["_FloorDiv"]=function(){return (Module["_FloorDiv"]=Module["asm"]["FloorDiv"]).apply(null,arguments)};Module["_FusedBatchNorm"]=function(){return (Module["_FusedBatchNorm"]=Module["asm"]["FusedBatchNorm"]).apply(null,arguments)};Module["_FusedConv2D"]=function(){return (Module["_FusedConv2D"]=Module["asm"]["FusedConv2D"]).apply(null,arguments)};Module["_FusedDepthwiseConv2D"]=function(){return (Module["_FusedDepthwiseConv2D"]=Module["asm"]["FusedDepthwiseConv2D"]).apply(null,arguments)};Module["_Gather"]=function(){return (Module["_Gather"]=Module["asm"]["Gather"]).apply(null,arguments)};Module["_GatherNd"]=function(){return (Module["_GatherNd"]=Module["asm"]["GatherNd"]).apply(null,arguments)};Module["_Greater"]=function(){return (Module["_Greater"]=Module["asm"]["Greater"]).apply(null,arguments)};Module["_GreaterEqual"]=function(){return (Module["_GreaterEqual"]=Module["asm"]["GreaterEqual"]).apply(null,arguments)};Module["_LeakyRelu"]=function(){return (Module["_LeakyRelu"]=Module["asm"]["LeakyRelu"]).apply(null,arguments)};Module["_Less"]=function(){return (Module["_Less"]=Module["asm"]["Less"]).apply(null,arguments)};Module["_LessEqual"]=function(){return (Module["_LessEqual"]=Module["asm"]["LessEqual"]).apply(null,arguments)};Module["_Log"]=function(){return (Module["_Log"]=Module["asm"]["Log"]).apply(null,arguments)};Module["_LogicalAnd"]=function(){return (Module["_LogicalAnd"]=Module["asm"]["LogicalAnd"]).apply(null,arguments)};Module["_Max"]=function(){return (Module["_Max"]=Module["asm"]["Max"]).apply(null,arguments)};Module["_MaxPool"]=function(){return (Module["_MaxPool"]=Module["asm"]["MaxPool"]).apply(null,arguments)};Module["_Maximum"]=function(){return (Module["_Maximum"]=Module["asm"]["Maximum"]).apply(null,arguments)};Module["_Mean"]=function(){return (Module["_Mean"]=Module["asm"]["Mean"]).apply(null,arguments)};Module["_Min"]=function(){return (Module["_Min"]=Module["asm"]["Min"]).apply(null,arguments)};Module["_Minimum"]=function(){return (Module["_Minimum"]=Module["asm"]["Minimum"]).apply(null,arguments)};Module["_MirrorPad"]=function(){return (Module["_MirrorPad"]=Module["asm"]["MirrorPad"]).apply(null,arguments)};Module["_Multiply"]=function(){return (Module["_Multiply"]=Module["asm"]["Multiply"]).apply(null,arguments)};Module["_Neg"]=function(){return (Module["_Neg"]=Module["asm"]["Neg"]).apply(null,arguments)};Module["_NonMaxSuppressionV3"]=function(){return (Module["_NonMaxSuppressionV3"]=Module["asm"]["NonMaxSuppressionV3"]).apply(null,arguments)};Module["_NonMaxSuppressionV4"]=function(){return (Module["_NonMaxSuppressionV4"]=Module["asm"]["NonMaxSuppressionV4"]).apply(null,arguments)};Module["_NonMaxSuppressionV5"]=function(){return (Module["_NonMaxSuppressionV5"]=Module["asm"]["NonMaxSuppressionV5"]).apply(null,arguments)};Module["_NotEqual"]=function(){return (Module["_NotEqual"]=Module["asm"]["NotEqual"]).apply(null,arguments)};Module["_OneHot"]=function(){return (Module["_OneHot"]=Module["asm"]["OneHot"]).apply(null,arguments)};Module["_PadV2"]=function(){return (Module["_PadV2"]=Module["asm"]["PadV2"]).apply(null,arguments)};Module["_Pow"]=function(){return (Module["_Pow"]=Module["asm"]["Pow"]).apply(null,arguments)};Module["_Prelu"]=function(){return (Module["_Prelu"]=Module["asm"]["Prelu"]).apply(null,arguments)};Module["_Prod"]=function(){return (Module["_Prod"]=Module["asm"]["Prod"]).apply(null,arguments)};Module["_RealDiv"]=function(){return (Module["_RealDiv"]=Module["asm"]["RealDiv"]).apply(null,arguments)};Module["_Relu"]=function(){return (Module["_Relu"]=Module["asm"]["Relu"]).apply(null,arguments)};Module["_Relu6"]=function(){return (Module["_Relu6"]=Module["asm"]["Relu6"]).apply(null,arguments)};Module["_ResizeBilinear"]=function(){return (Module["_ResizeBilinear"]=Module["asm"]["ResizeBilinear"]).apply(null,arguments)};Module["_Reverse"]=function(){return (Module["_Reverse"]=Module["asm"]["Reverse"]).apply(null,arguments)};Module["_RotateWithOffset"]=function(){return (Module["_RotateWithOffset"]=Module["asm"]["RotateWithOffset"]).apply(null,arguments)};Module["_Round"]=function(){return (Module["_Round"]=Module["asm"]["Round"]).apply(null,arguments)};Module["_Rsqrt"]=function(){return (Module["_Rsqrt"]=Module["asm"]["Rsqrt"]).apply(null,arguments)};Module["_ScatterNd"]=function(){return (Module["_ScatterNd"]=Module["asm"]["ScatterNd"]).apply(null,arguments)};Module["_SelectV2"]=function(){return (Module["_SelectV2"]=Module["asm"]["SelectV2"]).apply(null,arguments)};Module["_Sigmoid"]=function(){return (Module["_Sigmoid"]=Module["asm"]["Sigmoid"]).apply(null,arguments)};Module["_Sin"]=function(){return (Module["_Sin"]=Module["asm"]["Sin"]).apply(null,arguments)};Module["_Softmax"]=function(){return (Module["_Softmax"]=Module["asm"]["Softmax"]).apply(null,arguments)};Module["_SparseFillEmptyRows"]=function(){return (Module["_SparseFillEmptyRows"]=Module["asm"]["SparseFillEmptyRows"]).apply(null,arguments)};Module["_SparseReshape"]=function(){return (Module["_SparseReshape"]=Module["asm"]["SparseReshape"]).apply(null,arguments)};Module["_SparseSegmentReduction"]=function(){return (Module["_SparseSegmentReduction"]=Module["asm"]["SparseSegmentReduction"]).apply(null,arguments)};Module["_Sqrt"]=function(){return (Module["_Sqrt"]=Module["asm"]["Sqrt"]).apply(null,arguments)};Module["_Square"]=function(){return (Module["_Square"]=Module["asm"]["Square"]).apply(null,arguments)};Module["_SquaredDifference"]=function(){return (Module["_SquaredDifference"]=Module["asm"]["SquaredDifference"]).apply(null,arguments)};Module["_Step"]=function(){return (Module["_Step"]=Module["asm"]["Step"]).apply(null,arguments)};Module["_StridedSlice"]=function(){return (Module["_StridedSlice"]=Module["asm"]["StridedSlice"]).apply(null,arguments)};Module["_Sub"]=function(){return (Module["_Sub"]=Module["asm"]["Sub"]).apply(null,arguments)};Module["_Sum"]=function(){return (Module["_Sum"]=Module["asm"]["Sum"]).apply(null,arguments)};Module["_Tan"]=function(){return (Module["_Tan"]=Module["asm"]["Tan"]).apply(null,arguments)};Module["_Tanh"]=function(){return (Module["_Tanh"]=Module["asm"]["Tanh"]).apply(null,arguments)};Module["_Tile"]=function(){return (Module["_Tile"]=Module["asm"]["Tile"]).apply(null,arguments)};Module["_TopK"]=function(){return (Module["_TopK"]=Module["asm"]["TopK"]).apply(null,arguments)};Module["_Transform"]=function(){return (Module["_Transform"]=Module["asm"]["Transform"]).apply(null,arguments)};Module["_Transpose"]=function(){return (Module["_Transpose"]=Module["asm"]["Transpose"]).apply(null,arguments)};Module["__FusedMatMul"]=function(){return (Module["__FusedMatMul"]=Module["asm"]["_FusedMatMul"]).apply(null,arguments)};var _malloc=Module["_malloc"]=function(){return (_malloc=Module["_malloc"]=Module["asm"]["malloc"]).apply(null,arguments)};var _free=Module["_free"]=function(){return (_free=Module["_free"]=Module["asm"]["free"]).apply(null,arguments)};Module["_emscripten_tls_init"]=function(){return (Module["_emscripten_tls_init"]=Module["asm"]["emscripten_tls_init"]).apply(null,arguments)};var ___errno_location=Module["___errno_location"]=function(){return (___errno_location=Module["___errno_location"]=Module["asm"]["__errno_location"]).apply(null,arguments)};var _pthread_self=Module["_pthread_self"]=function(){return (_pthread_self=Module["_pthread_self"]=Module["asm"]["pthread_self"]).apply(null,arguments)};var _emscripten_main_thread_process_queued_calls=Module["_emscripten_main_thread_process_queued_calls"]=function(){return (_emscripten_main_thread_process_queued_calls=Module["_emscripten_main_thread_process_queued_calls"]=Module["asm"]["emscripten_main_thread_process_queued_calls"]).apply(null,arguments)};Module["__emscripten_thread_crashed"]=function(){return (Module["__emscripten_thread_crashed"]=Module["asm"]["_emscripten_thread_crashed"]).apply(null,arguments)};var __emscripten_thread_init=Module["__emscripten_thread_init"]=function(){return (__emscripten_thread_init=Module["__emscripten_thread_init"]=Module["asm"]["_emscripten_thread_init"]).apply(null,arguments)};Module["_emscripten_current_thread_process_queued_calls"]=function(){return (Module["_emscripten_current_thread_process_queued_calls"]=Module["asm"]["emscripten_current_thread_process_queued_calls"]).apply(null,arguments)};Module["_emscripten_main_browser_thread_id"]=function(){return (Module["_emscripten_main_browser_thread_id"]=Module["asm"]["emscripten_main_browser_thread_id"]).apply(null,arguments)};Module["_emscripten_sync_run_in_main_thread_2"]=function(){return (Module["_emscripten_sync_run_in_main_thread_2"]=Module["asm"]["emscripten_sync_run_in_main_thread_2"]).apply(null,arguments)};var _emscripten_sync_run_in_main_thread_4=Module["_emscripten_sync_run_in_main_thread_4"]=function(){return (_emscripten_sync_run_in_main_thread_4=Module["_emscripten_sync_run_in_main_thread_4"]=Module["asm"]["emscripten_sync_run_in_main_thread_4"]).apply(null,arguments)};var _emscripten_run_in_main_runtime_thread_js=Module["_emscripten_run_in_main_runtime_thread_js"]=function(){return (_emscripten_run_in_main_runtime_thread_js=Module["_emscripten_run_in_main_runtime_thread_js"]=Module["asm"]["emscripten_run_in_main_runtime_thread_js"]).apply(null,arguments)};var _emscripten_dispatch_to_thread_=Module["_emscripten_dispatch_to_thread_"]=function(){return (_emscripten_dispatch_to_thread_=Module["_emscripten_dispatch_to_thread_"]=Module["asm"]["emscripten_dispatch_to_thread_"]).apply(null,arguments)};var __emscripten_thread_free_data=Module["__emscripten_thread_free_data"]=function(){return (__emscripten_thread_free_data=Module["__emscripten_thread_free_data"]=Module["asm"]["_emscripten_thread_free_data"]).apply(null,arguments)};Module["__emscripten_thread_exit"]=function(){return (Module["__emscripten_thread_exit"]=Module["asm"]["_emscripten_thread_exit"]).apply(null,arguments)};Module["_memalign"]=function(){return (Module["_memalign"]=Module["asm"]["memalign"]).apply(null,arguments)};var _emscripten_stack_set_limits=Module["_emscripten_stack_set_limits"]=function(){return (_emscripten_stack_set_limits=Module["_emscripten_stack_set_limits"]=Module["asm"]["emscripten_stack_set_limits"]).apply(null,arguments)};var stackSave=Module["stackSave"]=function(){return (stackSave=Module["stackSave"]=Module["asm"]["stackSave"]).apply(null,arguments)};var stackRestore=Module["stackRestore"]=function(){return (stackRestore=Module["stackRestore"]=Module["asm"]["stackRestore"]).apply(null,arguments)};var stackAlloc=Module["stackAlloc"]=function(){return (stackAlloc=Module["stackAlloc"]=Module["asm"]["stackAlloc"]).apply(null,arguments)};Module["dynCall_iijjiiii"]=function(){return (Module["dynCall_iijjiiii"]=Module["asm"]["dynCall_iijjiiii"]).apply(null,arguments)};Module["dynCall_jiji"]=function(){return (Module["dynCall_jiji"]=Module["asm"]["dynCall_jiji"]).apply(null,arguments)};var __emscripten_allow_main_runtime_queued_calls=Module["__emscripten_allow_main_runtime_queued_calls"]=21464;Module["cwrap"]=cwrap;Module["keepRuntimeAlive"]=keepRuntimeAlive;Module["PThread"]=PThread;Module["PThread"]=PThread;Module["wasmMemory"]=wasmMemory;Module["ExitStatus"]=ExitStatus;var calledRun;function ExitStatus(status){this.name="ExitStatus";this.message="Program terminated with exit("+status+")";this.status=status;}dependenciesFulfilled=function runCaller(){if(!calledRun)run();if(!calledRun)dependenciesFulfilled=runCaller;};function run(args){if(runDependencies>0){return}if(ENVIRONMENT_IS_PTHREAD){readyPromiseResolve(Module);initRuntime();postMessage({"cmd":"loaded"});return}preRun();if(runDependencies>0){return}function doRun(){if(calledRun)return;calledRun=true;Module["calledRun"]=true;if(ABORT)return;initRuntime();readyPromiseResolve(Module);if(Module["onRuntimeInitialized"])Module["onRuntimeInitialized"]();postRun();}if(Module["setStatus"]){Module["setStatus"]("Running...");setTimeout(function(){setTimeout(function(){Module["setStatus"]("");},1);doRun();},1);}else {doRun();}}Module["run"]=run;function exit(status,implicit){EXITSTATUS=status;if(!implicit){if(ENVIRONMENT_IS_PTHREAD){exitOnMainThread(status);throw "unwind"}}if(keepRuntimeAlive());else {exitRuntime();}procExit(status);}function procExit(code){EXITSTATUS=code;if(!keepRuntimeAlive()){PThread.terminateAllThreads();if(Module["onExit"])Module["onExit"](code);ABORT=true;}quit_(code,new ExitStatus(code));}if(Module["preInit"]){if(typeof Module["preInit"]=="function")Module["preInit"]=[Module["preInit"]];while(Module["preInit"].length>0){Module["preInit"].pop()();}}run();var listenersAdded;if(beforeListeners){listenersAdded={uncaughtException:process.listeners("uncaughtException").filter(function(listener){return !beforeListeners.uncaughtException.indexOf(listener)>-1}),unhandledRejection:process.listeners("unhandledRejection").filter(function(listener){return !beforeListeners.unhandledRejection.indexOf(listener)>-1})};}var actualModule;if(typeof WasmBackendModule!=="undefined"){actualModule=WasmBackendModule;}else if(typeof WasmBackendModuleThreadedSimd!=="undefined"){actualModule=WasmBackendModuleThreadedSimd;}else {throw new Error("Could not find wasm module in post.js")}if(listenersAdded){var tmpDispose=actualModule["_dispose"];actualModule["_dispose"]=function(){tmpDispose();listenersAdded.uncaughtException.forEach(function(listener){process.removeListener("uncaughtException",listener);});listenersAdded.unhandledRejection.forEach(function(listener){process.removeListener("unhandledRejection",listener);});};}


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

  var Module=typeof WasmBackendModule!=="undefined"?WasmBackendModule:{};var readyPromiseResolve,readyPromiseReject;Module["ready"]=new Promise(function(resolve,reject){readyPromiseResolve=resolve;readyPromiseReject=reject;});var beforeListeners;if(typeof process!=="undefined"&&process.listeners){beforeListeners={uncaughtException:process.listeners("uncaughtException"),unhandledRejection:process.listeners("unhandledRejection")};}var moduleOverrides=Object.assign({},Module);var ENVIRONMENT_IS_WEB=typeof window==="object";var ENVIRONMENT_IS_WORKER=typeof importScripts==="function";var ENVIRONMENT_IS_NODE=typeof process==="object"&&typeof process.versions==="object"&&typeof process.versions.node==="string";var scriptDirectory="";function locateFile(path){if(Module["locateFile"]){return Module["locateFile"](path,scriptDirectory)}return scriptDirectory+path}var read_,readAsync,readBinary;var fs$1;var nodePath;var requireNodeFS;if(ENVIRONMENT_IS_NODE){if(ENVIRONMENT_IS_WORKER){scriptDirectory=path.dirname(scriptDirectory)+"/";}else {scriptDirectory=__dirname+"/";}requireNodeFS=(()=>{if(!nodePath){fs$1=fs;nodePath=path;}});read_=function shell_read(filename,binary){requireNodeFS();filename=nodePath["normalize"](filename);return fs$1.readFileSync(filename,binary?undefined:"utf8")};readBinary=(filename=>{var ret=read_(filename,true);if(!ret.buffer){ret=new Uint8Array(ret);}return ret});readAsync=((filename,onload,onerror)=>{requireNodeFS();filename=nodePath["normalize"](filename);fs$1.readFile(filename,function(err,data){if(err)onerror(err);else onload(data.buffer);});});if(process["argv"].length>1){process["argv"][1].replace(/\\/g,"/");}process["argv"].slice(2);process["on"]("uncaughtException",function(ex){if(!(ex instanceof ExitStatus)){throw ex}});process["on"]("unhandledRejection",function(reason){throw reason});Module["inspect"]=function(){return "[Emscripten Module object]"};}else if(ENVIRONMENT_IS_WEB||ENVIRONMENT_IS_WORKER){if(ENVIRONMENT_IS_WORKER){scriptDirectory=self.location.href;}else if(typeof document!=="undefined"&&document.currentScript){scriptDirectory=document.currentScript.src;}if(_scriptDir){scriptDirectory=_scriptDir;}if(scriptDirectory.indexOf("blob:")!==0){scriptDirectory=scriptDirectory.substr(0,scriptDirectory.replace(/[?#].*/,"").lastIndexOf("/")+1);}else {scriptDirectory="";}{read_=(url=>{var xhr=new XMLHttpRequest;xhr.open("GET",url,false);xhr.send(null);return xhr.responseText});if(ENVIRONMENT_IS_WORKER){readBinary=(url=>{var xhr=new XMLHttpRequest;xhr.open("GET",url,false);xhr.responseType="arraybuffer";xhr.send(null);return new Uint8Array(xhr.response)});}readAsync=((url,onload,onerror)=>{var xhr=new XMLHttpRequest;xhr.open("GET",url,true);xhr.responseType="arraybuffer";xhr.onload=(()=>{if(xhr.status==200||xhr.status==0&&xhr.response){onload(xhr.response);return}onerror();});xhr.onerror=onerror;xhr.send(null);});}}var out=Module["print"]||console.log.bind(console);var err=Module["printErr"]||console.warn.bind(console);Object.assign(Module,moduleOverrides);moduleOverrides=null;if(Module["arguments"]);if(Module["thisProgram"]);if(Module["quit"]);var wasmBinary;if(Module["wasmBinary"])wasmBinary=Module["wasmBinary"];Module["noExitRuntime"]||true;if(typeof WebAssembly!=="object"){abort("no native wasm support detected");}var wasmMemory;var ABORT=false;function getCFunc(ident){var func=Module["_"+ident];return func}function ccall(ident,returnType,argTypes,args,opts){var toC={"string":function(str){var ret=0;if(str!==null&&str!==undefined&&str!==0){var len=(str.length<<2)+1;ret=stackAlloc(len);stringToUTF8(str,ret,len);}return ret},"array":function(arr){var ret=stackAlloc(arr.length);writeArrayToMemory(arr,ret);return ret}};function convertReturnValue(ret){if(returnType==="string")return UTF8ToString(ret);if(returnType==="boolean")return Boolean(ret);return ret}var func=getCFunc(ident);var cArgs=[];var stack=0;if(args){for(var i=0;i<args.length;i++){var converter=toC[argTypes[i]];if(converter){if(stack===0)stack=stackSave();cArgs[i]=converter(args[i]);}else {cArgs[i]=args[i];}}}var ret=func.apply(null,cArgs);function onDone(ret){if(stack!==0)stackRestore(stack);return convertReturnValue(ret)}ret=onDone(ret);return ret}function cwrap(ident,returnType,argTypes,opts){argTypes=argTypes||[];var numericArgs=argTypes.every(function(type){return type==="number"});var numericRet=returnType!=="string";if(numericRet&&numericArgs&&!opts){return getCFunc(ident)}return function(){return ccall(ident,returnType,argTypes,arguments)}}var UTF8Decoder=typeof TextDecoder!=="undefined"?new TextDecoder("utf8"):undefined;function UTF8ArrayToString(heap,idx,maxBytesToRead){var endIdx=idx+maxBytesToRead;var endPtr=idx;while(heap[endPtr]&&!(endPtr>=endIdx))++endPtr;if(endPtr-idx>16&&heap.subarray&&UTF8Decoder){return UTF8Decoder.decode(heap.subarray(idx,endPtr))}else {var str="";while(idx<endPtr){var u0=heap[idx++];if(!(u0&128)){str+=String.fromCharCode(u0);continue}var u1=heap[idx++]&63;if((u0&224)==192){str+=String.fromCharCode((u0&31)<<6|u1);continue}var u2=heap[idx++]&63;if((u0&240)==224){u0=(u0&15)<<12|u1<<6|u2;}else {u0=(u0&7)<<18|u1<<12|u2<<6|heap[idx++]&63;}if(u0<65536){str+=String.fromCharCode(u0);}else {var ch=u0-65536;str+=String.fromCharCode(55296|ch>>10,56320|ch&1023);}}}return str}function UTF8ToString(ptr,maxBytesToRead){return ptr?UTF8ArrayToString(HEAPU8,ptr,maxBytesToRead):""}function stringToUTF8Array(str,heap,outIdx,maxBytesToWrite){if(!(maxBytesToWrite>0))return 0;var startIdx=outIdx;var endIdx=outIdx+maxBytesToWrite-1;for(var i=0;i<str.length;++i){var u=str.charCodeAt(i);if(u>=55296&&u<=57343){var u1=str.charCodeAt(++i);u=65536+((u&1023)<<10)|u1&1023;}if(u<=127){if(outIdx>=endIdx)break;heap[outIdx++]=u;}else if(u<=2047){if(outIdx+1>=endIdx)break;heap[outIdx++]=192|u>>6;heap[outIdx++]=128|u&63;}else if(u<=65535){if(outIdx+2>=endIdx)break;heap[outIdx++]=224|u>>12;heap[outIdx++]=128|u>>6&63;heap[outIdx++]=128|u&63;}else {if(outIdx+3>=endIdx)break;heap[outIdx++]=240|u>>18;heap[outIdx++]=128|u>>12&63;heap[outIdx++]=128|u>>6&63;heap[outIdx++]=128|u&63;}}heap[outIdx]=0;return outIdx-startIdx}function stringToUTF8(str,outPtr,maxBytesToWrite){return stringToUTF8Array(str,HEAPU8,outPtr,maxBytesToWrite)}typeof TextDecoder!=="undefined"?new TextDecoder("utf-16le"):undefined;function writeArrayToMemory(array,buffer){HEAP8.set(array,buffer);}function alignUp(x,multiple){if(x%multiple>0){x+=multiple-x%multiple;}return x}var buffer,HEAP8,HEAPU8,HEAP32;function updateGlobalBufferAndViews(buf){buffer=buf;Module["HEAP8"]=HEAP8=new Int8Array(buf);Module["HEAP16"]=new Int16Array(buf);Module["HEAP32"]=HEAP32=new Int32Array(buf);Module["HEAPU8"]=HEAPU8=new Uint8Array(buf);Module["HEAPU16"]=new Uint16Array(buf);Module["HEAPU32"]=new Uint32Array(buf);Module["HEAPF32"]=new Float32Array(buf);Module["HEAPF64"]=new Float64Array(buf);}Module["INITIAL_MEMORY"]||16777216;var wasmTable;var __ATPRERUN__=[];var __ATINIT__=[];var __ATPOSTRUN__=[];function preRun(){if(Module["preRun"]){if(typeof Module["preRun"]=="function")Module["preRun"]=[Module["preRun"]];while(Module["preRun"].length){addOnPreRun(Module["preRun"].shift());}}callRuntimeCallbacks(__ATPRERUN__);}function initRuntime(){callRuntimeCallbacks(__ATINIT__);}function postRun(){if(Module["postRun"]){if(typeof Module["postRun"]=="function")Module["postRun"]=[Module["postRun"]];while(Module["postRun"].length){addOnPostRun(Module["postRun"].shift());}}callRuntimeCallbacks(__ATPOSTRUN__);}function addOnPreRun(cb){__ATPRERUN__.unshift(cb);}function addOnInit(cb){__ATINIT__.unshift(cb);}function addOnPostRun(cb){__ATPOSTRUN__.unshift(cb);}var runDependencies=0;var dependenciesFulfilled=null;function addRunDependency(id){runDependencies++;if(Module["monitorRunDependencies"]){Module["monitorRunDependencies"](runDependencies);}}function removeRunDependency(id){runDependencies--;if(Module["monitorRunDependencies"]){Module["monitorRunDependencies"](runDependencies);}if(runDependencies==0){if(dependenciesFulfilled){var callback=dependenciesFulfilled;dependenciesFulfilled=null;callback();}}}Module["preloadedImages"]={};Module["preloadedAudios"]={};function abort(what){{if(Module["onAbort"]){Module["onAbort"](what);}}what="Aborted("+what+")";err(what);ABORT=true;what+=". Build with -s ASSERTIONS=1 for more info.";var e=new WebAssembly.RuntimeError(what);readyPromiseReject(e);throw e}var dataURIPrefix="data:application/octet-stream;base64,";function isDataURI(filename){return filename.startsWith(dataURIPrefix)}function isFileURI(filename){return filename.startsWith("file://")}var wasmBinaryFile;wasmBinaryFile="tfjs-backend-wasm.wasm";if(!isDataURI(wasmBinaryFile)){wasmBinaryFile=locateFile(wasmBinaryFile);}function getBinary(file){try{if(file==wasmBinaryFile&&wasmBinary){return new Uint8Array(wasmBinary)}if(readBinary){return readBinary(file)}else {throw "both async and sync fetching of the wasm failed"}}catch(err){abort(err);}}function getBinaryPromise(){if(!wasmBinary&&(ENVIRONMENT_IS_WEB||ENVIRONMENT_IS_WORKER)){if(typeof fetch==="function"&&!isFileURI(wasmBinaryFile)){return fetch(wasmBinaryFile,{credentials:"same-origin"}).then(function(response){if(!response["ok"]){throw "failed to load wasm binary file at '"+wasmBinaryFile+"'"}return response["arrayBuffer"]()}).catch(function(){return getBinary(wasmBinaryFile)})}else {if(readAsync){return new Promise(function(resolve,reject){readAsync(wasmBinaryFile,function(response){resolve(new Uint8Array(response));},reject);})}}}return Promise.resolve().then(function(){return getBinary(wasmBinaryFile)})}function createWasm(){var info={"env":asmLibraryArg,"wasi_snapshot_preview1":asmLibraryArg};function receiveInstance(instance,module){var exports=instance.exports;Module["asm"]=exports;wasmMemory=Module["asm"]["memory"];updateGlobalBufferAndViews(wasmMemory.buffer);wasmTable=Module["asm"]["__indirect_function_table"];addOnInit(Module["asm"]["__wasm_call_ctors"]);removeRunDependency();}addRunDependency();function receiveInstantiationResult(result){receiveInstance(result["instance"]);}function instantiateArrayBuffer(receiver){return getBinaryPromise().then(function(binary){return WebAssembly.instantiate(binary,info)}).then(function(instance){return instance}).then(receiver,function(reason){err("failed to asynchronously prepare wasm: "+reason);abort(reason);})}function instantiateAsync(){if(!wasmBinary&&typeof WebAssembly.instantiateStreaming==="function"&&!isDataURI(wasmBinaryFile)&&!isFileURI(wasmBinaryFile)&&typeof fetch==="function"){return fetch(wasmBinaryFile,{credentials:"same-origin"}).then(function(response){var result=WebAssembly.instantiateStreaming(response,info);return result.then(receiveInstantiationResult,function(reason){err("wasm streaming compile failed: "+reason);err("falling back to ArrayBuffer instantiation");return instantiateArrayBuffer(receiveInstantiationResult)})})}else {return instantiateArrayBuffer(receiveInstantiationResult)}}if(Module["instantiateWasm"]){try{var exports=Module["instantiateWasm"](info,receiveInstance);return exports}catch(e){err("Module.instantiateWasm callback failed with error: "+e);return false}}instantiateAsync().catch(readyPromiseReject);return {}}function callRuntimeCallbacks(callbacks){while(callbacks.length>0){var callback=callbacks.shift();if(typeof callback=="function"){callback(Module);continue}var func=callback.func;if(typeof func==="number"){if(callback.arg===undefined){getWasmTableEntry(func)();}else {getWasmTableEntry(func)(callback.arg);}}else {func(callback.arg===undefined?null:callback.arg);}}}var wasmTableMirror=[];function getWasmTableEntry(funcPtr){var func=wasmTableMirror[funcPtr];if(!func){if(funcPtr>=wasmTableMirror.length)wasmTableMirror.length=funcPtr+1;wasmTableMirror[funcPtr]=func=wasmTable.get(funcPtr);}return func}function _abort(){abort("");}function _emscripten_get_heap_max(){return 2147483648}function _emscripten_memcpy_big(dest,src,num){HEAPU8.copyWithin(dest,src,src+num);}function emscripten_realloc_buffer(size){try{wasmMemory.grow(size-buffer.byteLength+65535>>>16);updateGlobalBufferAndViews(wasmMemory.buffer);return 1}catch(e){}}function _emscripten_resize_heap(requestedSize){var oldSize=HEAPU8.length;requestedSize=requestedSize>>>0;var maxHeapSize=_emscripten_get_heap_max();if(requestedSize>maxHeapSize){return false}for(var cutDown=1;cutDown<=4;cutDown*=2){var overGrownHeapSize=oldSize*(1+.2/cutDown);overGrownHeapSize=Math.min(overGrownHeapSize,requestedSize+100663296);var newSize=Math.min(maxHeapSize,alignUp(Math.max(requestedSize,overGrownHeapSize),65536));var replacement=emscripten_realloc_buffer(newSize);if(replacement){return true}}return false}var SYSCALLS={mappings:{},buffers:[null,[],[]],printChar:function(stream,curr){var buffer=SYSCALLS.buffers[stream];if(curr===0||curr===10){(stream===1?out:err)(UTF8ArrayToString(buffer,0));buffer.length=0;}else {buffer.push(curr);}},varargs:undefined,get:function(){SYSCALLS.varargs+=4;var ret=HEAP32[SYSCALLS.varargs-4>>2];return ret},getStr:function(ptr){var ret=UTF8ToString(ptr);return ret},get64:function(low,high){return low}};function _fd_close(fd){return 0}function _fd_seek(fd,offset_low,offset_high,whence,newOffset){}function _fd_write(fd,iov,iovcnt,pnum){var num=0;for(var i=0;i<iovcnt;i++){var ptr=HEAP32[iov>>2];var len=HEAP32[iov+4>>2];iov+=8;for(var j=0;j<len;j++){SYSCALLS.printChar(fd,HEAPU8[ptr+j]);}num+=len;}HEAP32[pnum>>2]=num;return 0}function _setTempRet0(val){}var asmLibraryArg={"abort":_abort,"emscripten_get_heap_max":_emscripten_get_heap_max,"emscripten_memcpy_big":_emscripten_memcpy_big,"emscripten_resize_heap":_emscripten_resize_heap,"fd_close":_fd_close,"fd_seek":_fd_seek,"fd_write":_fd_write,"setTempRet0":_setTempRet0};createWasm();Module["___wasm_call_ctors"]=function(){return (Module["___wasm_call_ctors"]=Module["asm"]["__wasm_call_ctors"]).apply(null,arguments)};Module["_init"]=function(){return (Module["_init"]=Module["asm"]["init"]).apply(null,arguments)};Module["_init_with_threads_count"]=function(){return (Module["_init_with_threads_count"]=Module["asm"]["init_with_threads_count"]).apply(null,arguments)};Module["_get_threads_count"]=function(){return (Module["_get_threads_count"]=Module["asm"]["get_threads_count"]).apply(null,arguments)};Module["_register_tensor"]=function(){return (Module["_register_tensor"]=Module["asm"]["register_tensor"]).apply(null,arguments)};Module["_dispose_data"]=function(){return (Module["_dispose_data"]=Module["asm"]["dispose_data"]).apply(null,arguments)};Module["_dispose"]=function(){return (Module["_dispose"]=Module["asm"]["dispose"]).apply(null,arguments)};Module["_Abs"]=function(){return (Module["_Abs"]=Module["asm"]["Abs"]).apply(null,arguments)};Module["_Add"]=function(){return (Module["_Add"]=Module["asm"]["Add"]).apply(null,arguments)};Module["_AddN"]=function(){return (Module["_AddN"]=Module["asm"]["AddN"]).apply(null,arguments)};Module["_All"]=function(){return (Module["_All"]=Module["asm"]["All"]).apply(null,arguments)};Module["_Any"]=function(){return (Module["_Any"]=Module["asm"]["Any"]).apply(null,arguments)};Module["_ArgMax"]=function(){return (Module["_ArgMax"]=Module["asm"]["ArgMax"]).apply(null,arguments)};Module["_AvgPool"]=function(){return (Module["_AvgPool"]=Module["asm"]["AvgPool"]).apply(null,arguments)};Module["_BatchMatMul"]=function(){return (Module["_BatchMatMul"]=Module["asm"]["BatchMatMul"]).apply(null,arguments)};Module["_Ceil"]=function(){return (Module["_Ceil"]=Module["asm"]["Ceil"]).apply(null,arguments)};Module["_ClipByValue"]=function(){return (Module["_ClipByValue"]=Module["asm"]["ClipByValue"]).apply(null,arguments)};Module["_Conv2D"]=function(){return (Module["_Conv2D"]=Module["asm"]["Conv2D"]).apply(null,arguments)};Module["_Conv2DBackpropInput"]=function(){return (Module["_Conv2DBackpropInput"]=Module["asm"]["Conv2DBackpropInput"]).apply(null,arguments)};Module["_Cos"]=function(){return (Module["_Cos"]=Module["asm"]["Cos"]).apply(null,arguments)};Module["_Cosh"]=function(){return (Module["_Cosh"]=Module["asm"]["Cosh"]).apply(null,arguments)};Module["_CropAndResize"]=function(){return (Module["_CropAndResize"]=Module["asm"]["CropAndResize"]).apply(null,arguments)};Module["_Cumprod"]=function(){return (Module["_Cumprod"]=Module["asm"]["Cumprod"]).apply(null,arguments)};Module["_Cumsum"]=function(){return (Module["_Cumsum"]=Module["asm"]["Cumsum"]).apply(null,arguments)};Module["_DepthToSpace"]=function(){return (Module["_DepthToSpace"]=Module["asm"]["DepthToSpace"]).apply(null,arguments)};Module["_DepthwiseConv2dNative"]=function(){return (Module["_DepthwiseConv2dNative"]=Module["asm"]["DepthwiseConv2dNative"]).apply(null,arguments)};Module["_Elu"]=function(){return (Module["_Elu"]=Module["asm"]["Elu"]).apply(null,arguments)};Module["_Equal"]=function(){return (Module["_Equal"]=Module["asm"]["Equal"]).apply(null,arguments)};Module["_Exp"]=function(){return (Module["_Exp"]=Module["asm"]["Exp"]).apply(null,arguments)};Module["_FlipLeftRight"]=function(){return (Module["_FlipLeftRight"]=Module["asm"]["FlipLeftRight"]).apply(null,arguments)};Module["_Floor"]=function(){return (Module["_Floor"]=Module["asm"]["Floor"]).apply(null,arguments)};Module["_FloorDiv"]=function(){return (Module["_FloorDiv"]=Module["asm"]["FloorDiv"]).apply(null,arguments)};Module["_FusedBatchNorm"]=function(){return (Module["_FusedBatchNorm"]=Module["asm"]["FusedBatchNorm"]).apply(null,arguments)};Module["_FusedConv2D"]=function(){return (Module["_FusedConv2D"]=Module["asm"]["FusedConv2D"]).apply(null,arguments)};Module["_FusedDepthwiseConv2D"]=function(){return (Module["_FusedDepthwiseConv2D"]=Module["asm"]["FusedDepthwiseConv2D"]).apply(null,arguments)};Module["_Gather"]=function(){return (Module["_Gather"]=Module["asm"]["Gather"]).apply(null,arguments)};Module["_GatherNd"]=function(){return (Module["_GatherNd"]=Module["asm"]["GatherNd"]).apply(null,arguments)};Module["_Greater"]=function(){return (Module["_Greater"]=Module["asm"]["Greater"]).apply(null,arguments)};Module["_GreaterEqual"]=function(){return (Module["_GreaterEqual"]=Module["asm"]["GreaterEqual"]).apply(null,arguments)};Module["_LeakyRelu"]=function(){return (Module["_LeakyRelu"]=Module["asm"]["LeakyRelu"]).apply(null,arguments)};Module["_Less"]=function(){return (Module["_Less"]=Module["asm"]["Less"]).apply(null,arguments)};Module["_LessEqual"]=function(){return (Module["_LessEqual"]=Module["asm"]["LessEqual"]).apply(null,arguments)};Module["_Log"]=function(){return (Module["_Log"]=Module["asm"]["Log"]).apply(null,arguments)};Module["_LogicalAnd"]=function(){return (Module["_LogicalAnd"]=Module["asm"]["LogicalAnd"]).apply(null,arguments)};Module["_Max"]=function(){return (Module["_Max"]=Module["asm"]["Max"]).apply(null,arguments)};Module["_MaxPool"]=function(){return (Module["_MaxPool"]=Module["asm"]["MaxPool"]).apply(null,arguments)};Module["_Maximum"]=function(){return (Module["_Maximum"]=Module["asm"]["Maximum"]).apply(null,arguments)};Module["_Mean"]=function(){return (Module["_Mean"]=Module["asm"]["Mean"]).apply(null,arguments)};Module["_Min"]=function(){return (Module["_Min"]=Module["asm"]["Min"]).apply(null,arguments)};Module["_Minimum"]=function(){return (Module["_Minimum"]=Module["asm"]["Minimum"]).apply(null,arguments)};Module["_MirrorPad"]=function(){return (Module["_MirrorPad"]=Module["asm"]["MirrorPad"]).apply(null,arguments)};Module["_Multiply"]=function(){return (Module["_Multiply"]=Module["asm"]["Multiply"]).apply(null,arguments)};Module["_Neg"]=function(){return (Module["_Neg"]=Module["asm"]["Neg"]).apply(null,arguments)};Module["_NonMaxSuppressionV3"]=function(){return (Module["_NonMaxSuppressionV3"]=Module["asm"]["NonMaxSuppressionV3"]).apply(null,arguments)};Module["_NonMaxSuppressionV4"]=function(){return (Module["_NonMaxSuppressionV4"]=Module["asm"]["NonMaxSuppressionV4"]).apply(null,arguments)};Module["_NonMaxSuppressionV5"]=function(){return (Module["_NonMaxSuppressionV5"]=Module["asm"]["NonMaxSuppressionV5"]).apply(null,arguments)};Module["_NotEqual"]=function(){return (Module["_NotEqual"]=Module["asm"]["NotEqual"]).apply(null,arguments)};Module["_OneHot"]=function(){return (Module["_OneHot"]=Module["asm"]["OneHot"]).apply(null,arguments)};Module["_PadV2"]=function(){return (Module["_PadV2"]=Module["asm"]["PadV2"]).apply(null,arguments)};Module["_Pow"]=function(){return (Module["_Pow"]=Module["asm"]["Pow"]).apply(null,arguments)};Module["_Prelu"]=function(){return (Module["_Prelu"]=Module["asm"]["Prelu"]).apply(null,arguments)};Module["_Prod"]=function(){return (Module["_Prod"]=Module["asm"]["Prod"]).apply(null,arguments)};Module["_RealDiv"]=function(){return (Module["_RealDiv"]=Module["asm"]["RealDiv"]).apply(null,arguments)};Module["_Relu"]=function(){return (Module["_Relu"]=Module["asm"]["Relu"]).apply(null,arguments)};Module["_Relu6"]=function(){return (Module["_Relu6"]=Module["asm"]["Relu6"]).apply(null,arguments)};Module["_ResizeBilinear"]=function(){return (Module["_ResizeBilinear"]=Module["asm"]["ResizeBilinear"]).apply(null,arguments)};Module["_Reverse"]=function(){return (Module["_Reverse"]=Module["asm"]["Reverse"]).apply(null,arguments)};Module["_RotateWithOffset"]=function(){return (Module["_RotateWithOffset"]=Module["asm"]["RotateWithOffset"]).apply(null,arguments)};Module["_Round"]=function(){return (Module["_Round"]=Module["asm"]["Round"]).apply(null,arguments)};Module["_Rsqrt"]=function(){return (Module["_Rsqrt"]=Module["asm"]["Rsqrt"]).apply(null,arguments)};Module["_ScatterNd"]=function(){return (Module["_ScatterNd"]=Module["asm"]["ScatterNd"]).apply(null,arguments)};Module["_SelectV2"]=function(){return (Module["_SelectV2"]=Module["asm"]["SelectV2"]).apply(null,arguments)};Module["_Sigmoid"]=function(){return (Module["_Sigmoid"]=Module["asm"]["Sigmoid"]).apply(null,arguments)};Module["_Sin"]=function(){return (Module["_Sin"]=Module["asm"]["Sin"]).apply(null,arguments)};Module["_Softmax"]=function(){return (Module["_Softmax"]=Module["asm"]["Softmax"]).apply(null,arguments)};Module["_SparseFillEmptyRows"]=function(){return (Module["_SparseFillEmptyRows"]=Module["asm"]["SparseFillEmptyRows"]).apply(null,arguments)};Module["_SparseReshape"]=function(){return (Module["_SparseReshape"]=Module["asm"]["SparseReshape"]).apply(null,arguments)};Module["_SparseSegmentReduction"]=function(){return (Module["_SparseSegmentReduction"]=Module["asm"]["SparseSegmentReduction"]).apply(null,arguments)};Module["_Sqrt"]=function(){return (Module["_Sqrt"]=Module["asm"]["Sqrt"]).apply(null,arguments)};Module["_Square"]=function(){return (Module["_Square"]=Module["asm"]["Square"]).apply(null,arguments)};Module["_SquaredDifference"]=function(){return (Module["_SquaredDifference"]=Module["asm"]["SquaredDifference"]).apply(null,arguments)};Module["_Step"]=function(){return (Module["_Step"]=Module["asm"]["Step"]).apply(null,arguments)};Module["_StridedSlice"]=function(){return (Module["_StridedSlice"]=Module["asm"]["StridedSlice"]).apply(null,arguments)};Module["_Sub"]=function(){return (Module["_Sub"]=Module["asm"]["Sub"]).apply(null,arguments)};Module["_Sum"]=function(){return (Module["_Sum"]=Module["asm"]["Sum"]).apply(null,arguments)};Module["_Tan"]=function(){return (Module["_Tan"]=Module["asm"]["Tan"]).apply(null,arguments)};Module["_Tanh"]=function(){return (Module["_Tanh"]=Module["asm"]["Tanh"]).apply(null,arguments)};Module["_Tile"]=function(){return (Module["_Tile"]=Module["asm"]["Tile"]).apply(null,arguments)};Module["_TopK"]=function(){return (Module["_TopK"]=Module["asm"]["TopK"]).apply(null,arguments)};Module["_Transform"]=function(){return (Module["_Transform"]=Module["asm"]["Transform"]).apply(null,arguments)};Module["_Transpose"]=function(){return (Module["_Transpose"]=Module["asm"]["Transpose"]).apply(null,arguments)};Module["__FusedMatMul"]=function(){return (Module["__FusedMatMul"]=Module["asm"]["_FusedMatMul"]).apply(null,arguments)};Module["_malloc"]=function(){return (Module["_malloc"]=Module["asm"]["malloc"]).apply(null,arguments)};Module["_free"]=function(){return (Module["_free"]=Module["asm"]["free"]).apply(null,arguments)};Module["___errno_location"]=function(){return (Module["___errno_location"]=Module["asm"]["__errno_location"]).apply(null,arguments)};Module["_emscripten_main_thread_process_queued_calls"]=function(){return (Module["_emscripten_main_thread_process_queued_calls"]=Module["asm"]["emscripten_main_thread_process_queued_calls"]).apply(null,arguments)};var stackSave=Module["stackSave"]=function(){return (stackSave=Module["stackSave"]=Module["asm"]["stackSave"]).apply(null,arguments)};var stackRestore=Module["stackRestore"]=function(){return (stackRestore=Module["stackRestore"]=Module["asm"]["stackRestore"]).apply(null,arguments)};var stackAlloc=Module["stackAlloc"]=function(){return (stackAlloc=Module["stackAlloc"]=Module["asm"]["stackAlloc"]).apply(null,arguments)};Module["dynCall_iijjiiii"]=function(){return (Module["dynCall_iijjiiii"]=Module["asm"]["dynCall_iijjiiii"]).apply(null,arguments)};Module["dynCall_jiji"]=function(){return (Module["dynCall_jiji"]=Module["asm"]["dynCall_jiji"]).apply(null,arguments)};Module["cwrap"]=cwrap;var calledRun;function ExitStatus(status){this.name="ExitStatus";this.message="Program terminated with exit("+status+")";this.status=status;}dependenciesFulfilled=function runCaller(){if(!calledRun)run();if(!calledRun)dependenciesFulfilled=runCaller;};function run(args){if(runDependencies>0){return}preRun();if(runDependencies>0){return}function doRun(){if(calledRun)return;calledRun=true;Module["calledRun"]=true;if(ABORT)return;initRuntime();readyPromiseResolve(Module);if(Module["onRuntimeInitialized"])Module["onRuntimeInitialized"]();postRun();}if(Module["setStatus"]){Module["setStatus"]("Running...");setTimeout(function(){setTimeout(function(){Module["setStatus"]("");},1);doRun();},1);}else {doRun();}}Module["run"]=run;if(Module["preInit"]){if(typeof Module["preInit"]=="function")Module["preInit"]=[Module["preInit"]];while(Module["preInit"].length>0){Module["preInit"].pop()();}}run();var listenersAdded;if(beforeListeners){listenersAdded={uncaughtException:process.listeners("uncaughtException").filter(function(listener){return !beforeListeners.uncaughtException.indexOf(listener)>-1}),unhandledRejection:process.listeners("unhandledRejection").filter(function(listener){return !beforeListeners.unhandledRejection.indexOf(listener)>-1})};}var actualModule;if(typeof WasmBackendModule!=="undefined"){actualModule=WasmBackendModule;}else if(typeof WasmBackendModuleThreadedSimd!=="undefined"){actualModule=WasmBackendModuleThreadedSimd;}else {throw new Error("Could not find wasm module in post.js")}if(listenersAdded){var tmpDispose=actualModule["_dispose"];actualModule["_dispose"]=function(){tmpDispose();listenersAdded.uncaughtException.forEach(function(listener){process.removeListener("uncaughtException",listener);});listenersAdded.unhandledRejection.forEach(function(listener){process.removeListener("unhandledRejection",listener);});};}


    return WasmBackendModule.ready
  }
  );
  })();
  module.exports = WasmBackendModule;
  });

  var BackendWasm = /** @class */ (function (_super) {
      __extends(BackendWasm, _super);
      function BackendWasm(wasm) {
          var _this = _super.call(this) || this;
          _this.wasm = wasm;
          // 0 is reserved for null data ids.
          _this.dataIdNextNumber = 1;
          _this.wasm.tfjs.initWithThreadsCount(threadsCount);
          actualThreadsCount = _this.wasm.tfjs.getThreadsCount();
          _this.dataIdMap = new tfjsCore.DataStorage(_this, tfjsCore.engine());
          return _this;
      }
      BackendWasm.prototype.write = function (values, shape, dtype) {
          var dataId = { id: this.dataIdNextNumber++ };
          this.move(dataId, values, shape, dtype, 1);
          return dataId;
      };
      BackendWasm.prototype.numDataIds = function () {
          return this.dataIdMap.numDataIds();
      };
      BackendWasm.prototype.time = function (f) {
          return __awaiter(this, void 0, void 0, function () {
              var start, kernelMs;
              return __generator(this, function (_a) {
                  start = tfjsCore.util.now();
                  f();
                  kernelMs = tfjsCore.util.now() - start;
                  return [2 /*return*/, { kernelMs: kernelMs }];
              });
          });
      };
      BackendWasm.prototype.move = function (dataId, values, shape, dtype, refCount) {
          var id = this.dataIdNextNumber++;
          if (dtype === 'string') {
              var stringBytes = values;
              this.dataIdMap.set(dataId, { id: id, stringBytes: stringBytes, shape: shape, dtype: dtype, memoryOffset: null, refCount: refCount });
              return;
          }
          var size = tfjsCore.util.sizeFromShape(shape);
          var numBytes = size * tfjsCore.util.bytesPerElement(dtype);
          var memoryOffset = this.wasm._malloc(numBytes);
          this.dataIdMap.set(dataId, { id: id, memoryOffset: memoryOffset, shape: shape, dtype: dtype, refCount: refCount });
          this.wasm.tfjs.registerTensor(id, size, memoryOffset);
          if (values != null) {
              this.wasm.HEAPU8.set(new Uint8Array(values.buffer, values.byteOffset, numBytes), memoryOffset);
          }
      };
      BackendWasm.prototype.read = function (dataId) {
          return __awaiter(this, void 0, void 0, function () {
              return __generator(this, function (_a) {
                  return [2 /*return*/, this.readSync(dataId)];
              });
          });
      };
      BackendWasm.prototype.readSync = function (dataId, start, end) {
          var _a = this.dataIdMap.get(dataId), memoryOffset = _a.memoryOffset, dtype = _a.dtype, shape = _a.shape, stringBytes = _a.stringBytes;
          if (dtype === 'string') {
              // Slice all elements.
              if ((start == null || start === 0) &&
                  (end == null || end >= stringBytes.length)) {
                  return stringBytes;
              }
              return stringBytes.slice(start, end);
          }
          start = start || 0;
          end = end || tfjsCore.util.sizeFromShape(shape);
          var bytesPerElement = tfjsCore.util.bytesPerElement(dtype);
          var bytes = this.wasm.HEAPU8.slice(memoryOffset + start * bytesPerElement, memoryOffset + end * bytesPerElement);
          return typedArrayFromBuffer(bytes.buffer, dtype);
      };
      /**
       * Dispose the memory if the dataId has 0 refCount. Return true if the memory
       * is released, false otherwise.
       * @param dataId
       * @oaram force Optional, remove the data regardless of refCount
       */
      BackendWasm.prototype.disposeData = function (dataId, force) {
          if (force === void 0) { force = false; }
          if (this.dataIdMap.has(dataId)) {
              var data = this.dataIdMap.get(dataId);
              data.refCount--;
              if (!force && data.refCount > 0) {
                  return false;
              }
              this.wasm._free(data.memoryOffset);
              this.wasm.tfjs.disposeData(data.id);
              this.dataIdMap.delete(dataId);
          }
          return true;
      };
      /** Return refCount of a `TensorData`. */
      BackendWasm.prototype.refCount = function (dataId) {
          if (this.dataIdMap.has(dataId)) {
              var tensorData = this.dataIdMap.get(dataId);
              return tensorData.refCount;
          }
          return 0;
      };
      BackendWasm.prototype.incRef = function (dataId) {
          var data = this.dataIdMap.get(dataId);
          if (data != null) {
              data.refCount++;
          }
      };
      BackendWasm.prototype.floatPrecision = function () {
          return 32;
      };
      // Returns the memory offset of a tensor. Useful for debugging and unit
      // testing.
      BackendWasm.prototype.getMemoryOffset = function (dataId) {
          return this.dataIdMap.get(dataId).memoryOffset;
      };
      BackendWasm.prototype.dispose = function () {
          this.wasm.tfjs.dispose();
          if ('PThread' in this.wasm) {
              this.wasm.PThread.terminateAllThreads();
          }
          this.wasm = null;
      };
      BackendWasm.prototype.memory = function () {
          return { unreliable: false };
      };
      /**
       * Make a tensor info for the output of an op. If `memoryOffset` is not
       * present, this method allocates memory on the WASM heap. If `memoryOffset`
       * is present, the memory was allocated elsewhere (in c++) and we just record
       * the pointer where that memory lives.
       */
      BackendWasm.prototype.makeOutput = function (shape, dtype, memoryOffset) {
          var dataId;
          if (memoryOffset == null) {
              dataId = this.write(null /* values */, shape, dtype);
          }
          else {
              var id = this.dataIdNextNumber++;
              dataId = { id: id };
              this.dataIdMap.set(dataId, { id: id, memoryOffset: memoryOffset, shape: shape, dtype: dtype, refCount: 1 });
              var size = tfjsCore.util.sizeFromShape(shape);
              this.wasm.tfjs.registerTensor(id, size, memoryOffset);
          }
          return { dataId: dataId, shape: shape, dtype: dtype };
      };
      BackendWasm.prototype.typedArrayFromHeap = function (_a) {
          var shape = _a.shape, dtype = _a.dtype, dataId = _a.dataId;
          var buffer = this.wasm.HEAPU8.buffer;
          var memoryOffset = this.dataIdMap.get(dataId).memoryOffset;
          var size = tfjsCore.util.sizeFromShape(shape);
          switch (dtype) {
              case 'float32':
                  return new Float32Array(buffer, memoryOffset, size);
              case 'int32':
                  return new Int32Array(buffer, memoryOffset, size);
              case 'bool':
                  return new Uint8Array(buffer, memoryOffset, size);
              default:
                  throw new Error("Unknown dtype " + dtype);
          }
      };
      return BackendWasm;
  }(tfjsCore.KernelBackend));
  function createInstantiateWasmFunc(path) {
      // this will be replace by rollup plugin patchWechatWebAssembly in
      // minprogram's output.
      // tslint:disable-next-line:no-any
      return function (imports, callback) {
          tfjsCore.util.fetch(path, { credentials: 'same-origin' }).then(function (response) {
              if (!response['ok']) {
                  imports.env.a("failed to load wasm binary file at '" + path + "'");
              }
              response.arrayBuffer().then(function (binary) {
                  WebAssembly.instantiate(binary, imports).then(function (output) {
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
      var path = 'tfjs-backend-wasm.wasm';
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
  function init() {
      return __awaiter(this, void 0, void 0, function () {
          var _a, simdSupported, threadsSupported;
          return __generator(this, function (_b) {
              switch (_b.label) {
                  case 0: return [4 /*yield*/, Promise.all([
                          tfjsCore.env().getAsync('WASM_HAS_SIMD_SUPPORT'),
                          tfjsCore.env().getAsync('WASM_HAS_MULTITHREAD_SUPPORT')
                      ])];
                  case 1:
                      _a = _b.sent(), simdSupported = _a[0], threadsSupported = _a[1];
                      return [2 /*return*/, new Promise(function (resolve, reject) {
                              var factoryConfig = {};
                              /**
                               * This function overrides the Emscripten module locateFile utility.
                               * @param path The relative path to the file that needs to be loaded.
                               * @param prefix The path to the main JavaScript file's directory.
                               */
                              factoryConfig.locateFile = function (path, prefix) {
                                  if (path.endsWith('.worker.js')) {
                                      // Escape '\n' because Blob will turn it into a newline.
                                      // There should be a setting for this, but 'endings: "native"' does
                                      // not seem to work.
                                      var response = wasmWorkerContents.replace(/\n/g, '\\n');
                                      var blob = new Blob([response], { type: 'application/javascript' });
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
                              var initialized = false;
                              factoryConfig.onAbort = function () {
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
                                  var rejectMsg = 'Make sure the server can serve the `.wasm` file relative to the ' +
                                      'bundled js file. For more details see https://github.com/tensorflow/tfjs/blob/master/tfjs-backend-wasm/README.md#using-bundlers';
                                  reject({ message: rejectMsg });
                              };
                              var wasm;
                              // If `wasmPath` has been defined we must initialize the vanilla module.
                              if (threadsSupported && simdSupported && wasmPath == null) {
                                  factoryConfig.mainScriptUrlOrBlob = new Blob(["var WasmBackendModuleThreadedSimd = " +
                                          tfjsBackendWasmThreadedSimd.toString()], { type: 'text/javascript' });
                                  wasm = tfjsBackendWasmThreadedSimd(factoryConfig);
                              }
                              else {
                                  // The wasmFactory works for both vanilla and SIMD binaries.
                                  wasm = tfjsBackendWasm(factoryConfig);
                              }
                              // The WASM module has been successfully created by the factory.
                              // Any error will be caught by the onAbort callback defined above.
                              wasm.then(function (module) {
                                  initialized = true;
                                  initAborted = false;
                                  var voidReturnType = null;
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
                          })];
              }
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
              throw new Error("Unknown dtype " + dtype);
      }
  }
  var wasmBinaryNames = [
      'tfjs-backend-wasm.wasm', 'tfjs-backend-wasm-simd.wasm',
      'tfjs-backend-wasm-threaded-simd.wasm'
  ];
  var wasmPath = null;
  var wasmPathPrefix = null;
  var wasmFileMap = {};
  var initAborted = false;
  var customFetch = false;
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
  function setWasmPath(path, usePlatformFetch) {
      if (usePlatformFetch === void 0) { usePlatformFetch = false; }
      tfjsCore.deprecationWarn('setWasmPath has been deprecated in favor of setWasmPaths and' +
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
  function setWasmPaths(prefixOrFileMap, usePlatformFetch) {
      if (usePlatformFetch === void 0) { usePlatformFetch = false; }
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
          var missingPaths = wasmBinaryNames.filter(function (name) { return wasmFileMap[name] == null; });
          if (missingPaths.length > 0) {
              throw new Error("There were no entries found for the following binaries: " +
                  (missingPaths.join(',') + ". Please either call setWasmPaths with a ") +
                  "map providing a path for each binary, or with a string indicating " +
                  "the directory where all the binaries can be found.");
          }
      }
      customFetch = usePlatformFetch;
  }
  var threadsCount = -1;
  var actualThreadsCount = -1;
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
          throw new Error("WASM backend not initialized.");
      }
      return actualThreadsCount;
  }

  /** @license See the LICENSE file. */
  // This code is auto-generated, do not modify this file!
  var version = '3.18.0';

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
  var _this$1 = undefined;
  var WASM_PRIORITY = 2;
  tfjsCore.registerBackend('wasm', function () { return __awaiter(_this$1, void 0, void 0, function () {
      var wasm;
      return __generator(this, function (_a) {
          switch (_a.label) {
              case 0: return [4 /*yield*/, init()];
              case 1:
                  wasm = (_a.sent()).wasm;
                  return [2 /*return*/, new BackendWasm(wasm)];
          }
      });
  }); }, WASM_PRIORITY);

  exports.BackendWasm = BackendWasm;
  exports.getThreadsCount = getThreadsCount;
  exports.setThreadsCount = setThreadsCount;
  exports.setWasmPath = setWasmPath;
  exports.setWasmPaths = setWasmPaths;
  exports.version_wasm = version;

  Object.defineProperty(exports, '__esModule', { value: true });

})));

/*! numjs */

!function(r){"object"==typeof exports&&"undefined"!=typeof module?module.exports=r():"function"==typeof define&&define.amd?define([],r):("undefined"!=typeof window?window:"undefined"!=typeof global?global:"undefined"!=typeof self?self:this).nj=r();}(function(){return function e(i,a,o){function u(n,r){if(!a[n]){if(!i[n]){var t="function"==typeof require&&require;if(!r&&t)return t(n,!0);if(s)return s(n,!0);throw (t=new Error("Cannot find module '"+n+"'")).code="MODULE_NOT_FOUND",t}t=a[n]={exports:{}},i[n][0].call(t.exports,function(r){return u(i[n][1][r]||r)},t,t.exports,e,i,a,o);}return a[n].exports}for(var s="function"==typeof require&&require,r=0;r<o.length;r++)u(o[r]);return u}({1:[function(r,n,t){t.byteLength=function(r){var n=f(r),r=n[0],n=n[1];return 3*(r+n)/4-n},t.toByteArray=function(r){var n,t,e=f(r),i=e[0],e=e[1],a=new l(function(r,n){return 3*(r+n)/4-n}(i,e)),o=0,u=0<e?i-4:i;for(t=0;t<u;t+=4)n=s[r.charCodeAt(t)]<<18|s[r.charCodeAt(t+1)]<<12|s[r.charCodeAt(t+2)]<<6|s[r.charCodeAt(t+3)],a[o++]=n>>16&255,a[o++]=n>>8&255,a[o++]=255&n;2===e&&(n=s[r.charCodeAt(t)]<<2|s[r.charCodeAt(t+1)]>>4,a[o++]=255&n);1===e&&(n=s[r.charCodeAt(t)]<<10|s[r.charCodeAt(t+1)]<<4|s[r.charCodeAt(t+2)]>>2,a[o++]=n>>8&255,a[o++]=255&n);return a},t.fromByteArray=function(r){for(var n,t=r.length,e=t%3,i=[],a=0,o=t-e;a<o;a+=16383)i.push(function(r,n,t){for(var e,i=[],a=n;a<t;a+=3)e=(r[a]<<16&16711680)+(r[a+1]<<8&65280)+(255&r[a+2]),i.push(function(r){return u[r>>18&63]+u[r>>12&63]+u[r>>6&63]+u[63&r]}(e));return i.join("")}(r,a,o<a+16383?o:a+16383));1==e?(n=r[t-1],i.push(u[n>>2]+u[n<<4&63]+"==")):2==e&&(n=(r[t-2]<<8)+r[t-1],i.push(u[n>>10]+u[n>>4&63]+u[n<<2&63]+"="));return i.join("")};for(var u=[],s=[],l="undefined"!=typeof Uint8Array?Uint8Array:Array,e="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",i=0,a=e.length;i<a;++i)u[i]=e[i],s[e.charCodeAt(i)]=i;function f(r){var n=r.length;if(0<n%4)throw new Error("Invalid string. Length must be a multiple of 4");r=r.indexOf("=");return [r=-1===r?n:r,r===n?0:4-r%4]}s["-".charCodeAt(0)]=62,s["_".charCodeAt(0)]=63;},{}],2:[function(r,n,t){function e(r){var n=32;return (r&=-r)&&n--,65535&r&&(n-=16),16711935&r&&(n-=8),252645135&r&&(n-=4),858993459&r&&(n-=2),1431655765&r&&--n,n}t.INT_BITS=32,t.INT_MAX=2147483647,t.INT_MIN=-1<<31,t.sign=function(r){return (0<r)-(r<0)},t.abs=function(r){var n=r>>31;return (r^n)-n},t.min=function(r,n){return n^(r^n)&-(r<n)},t.max=function(r,n){return r^(r^n)&-(r<n)},t.isPow2=function(r){return !(r&r-1||!r)},t.log2=function(r){var n,t=(65535<r)<<4;return t|=n=(255<(r>>>=t))<<3,t|=n=(15<(r>>>=n))<<2,(t|=n=(3<(r>>>=n))<<1)|(r>>>=n)>>1},t.log10=function(r){return 1e9<=r?9:1e8<=r?8:1e7<=r?7:1e6<=r?6:1e5<=r?5:1e4<=r?4:1e3<=r?3:100<=r?2:10<=r?1:0},t.popCount=function(r){return 16843009*((r=(858993459&(r-=r>>>1&1431655765))+(r>>>2&858993459))+(r>>>4)&252645135)>>>24},t.countTrailingZeros=e,t.nextPow2=function(r){return r+=0===r,--r,r|=r>>>1,r|=r>>>2,r|=r>>>4,r|=r>>>8,(r|=r>>>16)+1},t.prevPow2=function(r){return r|=r>>>1,r|=r>>>2,r|=r>>>4,r|=r>>>8,(r|=r>>>16)-(r>>>1)},t.parity=function(r){return r^=r>>>16,r^=r>>>8,r^=r>>>4,27030>>>(r&=15)&1};var i=new Array(256);!function(r){for(var n=0;n<256;++n){var t=n,e=n,i=7;for(t>>>=1;t;t>>>=1)e<<=1,e|=1&t,--i;r[n]=e<<i&255;}}(i),t.reverse=function(r){return i[255&r]<<24|i[r>>>8&255]<<16|i[r>>>16&255]<<8|i[r>>>24&255]},t.interleave2=function(r,n){return (r=1431655765&((r=858993459&((r=252645135&((r=16711935&((r&=65535)|r<<8))|r<<4))|r<<2))|r<<1))|(n=1431655765&((n=858993459&((n=252645135&((n=16711935&((n&=65535)|n<<8))|n<<4))|n<<2))|n<<1))<<1},t.deinterleave2=function(r,n){return (r=65535&((r=16711935&((r=252645135&((r=858993459&((r=r>>>n&1431655765)|r>>>1))|r>>>2))|r>>>4))|r>>>16))<<16>>16},t.interleave3=function(r,n,t){return r=1227133513&((r=3272356035&((r=251719695&((r=4278190335&((r&=1023)|r<<16))|r<<8))|r<<4))|r<<2),(r|=(n=1227133513&((n=3272356035&((n=251719695&((n=4278190335&((n&=1023)|n<<16))|n<<8))|n<<4))|n<<2))<<1)|(t=1227133513&((t=3272356035&((t=251719695&((t=4278190335&((t&=1023)|t<<16))|t<<8))|t<<4))|t<<2))<<2},t.deinterleave3=function(r,n){return (r=1023&((r=4278190335&((r=251719695&((r=3272356035&((r=r>>>n&1227133513)|r>>>2))|r>>>4))|r>>>8))|r>>>16))<<22>>22},t.nextCombination=function(r){var n=r|r-1;return 1+n|(~n&-~n)-1>>>e(r)+1};},{}],3:[function(r,n,t){var u=r("base64-js"),a=r("ieee754"),r="function"==typeof Symbol&&"function"==typeof Symbol.for?Symbol.for("nodejs.util.inspect.custom"):null;t.Buffer=c,t.SlowBuffer=function(r){+r!=r&&(r=0);return c.alloc(+r)},t.INSPECT_MAX_BYTES=50;var e=2147483647;function i(r){if(e<r)throw new RangeError('The value "'+r+'" is invalid for option "size"');r=new Uint8Array(r);return Object.setPrototypeOf(r,c.prototype),r}function c(r,n,t){if("number"!=typeof r)return o(r,n,t);if("string"==typeof n)throw new TypeError('The "string" argument must be of type string. Received type number');return l(r)}function o(r,n,t){if("string"==typeof r)return function(r,n){"string"==typeof n&&""!==n||(n="utf8");if(!c.isEncoding(n))throw new TypeError("Unknown encoding: "+n);var t=0|p(r,n),e=i(t),n=e.write(r,n);n!==t&&(e=e.slice(0,n));return e}(r,n);if(ArrayBuffer.isView(r))return function(r){if(U(r,Uint8Array)){var n=new Uint8Array(r);return h(n.buffer,n.byteOffset,n.byteLength)}return f(r)}(r);if(null==r)throw new TypeError("The first argument must be one of type string, Buffer, ArrayBuffer, Array, or Array-like Object. Received type "+typeof r);if(U(r,ArrayBuffer)||r&&U(r.buffer,ArrayBuffer))return h(r,n,t);if("undefined"!=typeof SharedArrayBuffer&&(U(r,SharedArrayBuffer)||r&&U(r.buffer,SharedArrayBuffer)))return h(r,n,t);if("number"==typeof r)throw new TypeError('The "value" argument must not be of type number. Received type number');var e=r.valueOf&&r.valueOf();if(null!=e&&e!==r)return c.from(e,n,t);e=function(r){if(c.isBuffer(r)){var n=0|_(r.length),t=i(n);return 0===t.length?t:(r.copy(t,0,0,n),t)}if(void 0!==r.length)return "number"!=typeof r.length||N(r.length)?i(0):f(r);if("Buffer"===r.type&&Array.isArray(r.data))return f(r.data)}(r);if(e)return e;if("undefined"!=typeof Symbol&&null!=Symbol.toPrimitive&&"function"==typeof r[Symbol.toPrimitive])return c.from(r[Symbol.toPrimitive]("string"),n,t);throw new TypeError("The first argument must be one of type string, Buffer, ArrayBuffer, Array, or Array-like Object. Received type "+typeof r)}function s(r){if("number"!=typeof r)throw new TypeError('"size" argument must be of type number');if(r<0)throw new RangeError('The value "'+r+'" is invalid for option "size"')}function l(r){return s(r),i(r<0?0:0|_(r))}function f(r){for(var n=r.length<0?0:0|_(r.length),t=i(n),e=0;e<n;e+=1)t[e]=255&r[e];return t}function h(r,n,t){if(n<0||r.byteLength<n)throw new RangeError('"offset" is outside of buffer bounds');if(r.byteLength<n+(t||0))throw new RangeError('"length" is outside of buffer bounds');t=void 0===n&&void 0===t?new Uint8Array(r):void 0===t?new Uint8Array(r,n):new Uint8Array(r,n,t);return Object.setPrototypeOf(t,c.prototype),t}function _(r){if(e<=r)throw new RangeError("Attempt to allocate Buffer larger than maximum size: 0x"+e.toString(16)+" bytes");return 0|r}function p(r,n){if(c.isBuffer(r))return r.length;if(ArrayBuffer.isView(r)||U(r,ArrayBuffer))return r.byteLength;if("string"!=typeof r)throw new TypeError('The "string" argument must be one of type string, Buffer, or ArrayBuffer. Received type '+typeof r);var t=r.length,e=2<arguments.length&&!0===arguments[2];if(!e&&0===t)return 0;for(var i=!1;;)switch(n){case"ascii":case"latin1":case"binary":return t;case"utf8":case"utf-8":return B(r).length;case"ucs2":case"ucs-2":case"utf16le":case"utf-16le":return 2*t;case"hex":return t>>>1;case"base64":return T(r).length;default:if(i)return e?-1:B(r).length;n=(""+n).toLowerCase(),i=!0;}}function g(r,n,t){var e,i,a,o=!1;if((n=void 0===n||n<0?0:n)>this.length)return "";if((t=void 0===t||t>this.length?this.length:t)<=0)return "";if((t>>>=0)<=(n>>>=0))return "";for(r=r||"utf8";;)switch(r){case"hex":return function(r,n,t){var e=r.length;(!n||n<0)&&(n=0);(!t||t<0||e<t)&&(t=e);for(var i="",a=n;a<t;++a)i+=O[r[a]];return i}(this,n,t);case"utf8":case"utf-8":return m(this,n,t);case"ascii":return function(r,n,t){var e="";t=Math.min(r.length,t);for(var i=n;i<t;++i)e+=String.fromCharCode(127&r[i]);return e}(this,n,t);case"latin1":case"binary":return function(r,n,t){var e="";t=Math.min(r.length,t);for(var i=n;i<t;++i)e+=String.fromCharCode(r[i]);return e}(this,n,t);case"base64":return e=this,a=t,0===(i=n)&&a===e.length?u.fromByteArray(e):u.fromByteArray(e.slice(i,a));case"ucs2":case"ucs-2":case"utf16le":case"utf-16le":return function(r,n,t){for(var e=r.slice(n,t),i="",a=0;a<e.length-1;a+=2)i+=String.fromCharCode(e[a]+256*e[a+1]);return i}(this,n,t);default:if(o)throw new TypeError("Unknown encoding: "+r);r=(r+"").toLowerCase(),o=!0;}}function y(r,n,t){var e=r[n];r[n]=r[t],r[t]=e;}function v(r,n,t,e,i){if(0===r.length)return -1;if("string"==typeof t?(e=t,t=0):2147483647<t?t=2147483647:t<-2147483648&&(t=-2147483648),(t=(t=N(t=+t)?i?0:r.length-1:t)<0?r.length+t:t)>=r.length){if(i)return -1;t=r.length-1;}else if(t<0){if(!i)return -1;t=0;}if("string"==typeof n&&(n=c.from(n,e)),c.isBuffer(n))return 0===n.length?-1:d(r,n,t,e,i);if("number"==typeof n)return n&=255,"function"==typeof Uint8Array.prototype.indexOf?(i?Uint8Array.prototype.indexOf:Uint8Array.prototype.lastIndexOf).call(r,n,t):d(r,[n],t,e,i);throw new TypeError("val must be string, number or Buffer")}function d(r,n,t,e,i){var a=1,o=r.length,u=n.length;if(void 0!==e&&("ucs2"===(e=String(e).toLowerCase())||"ucs-2"===e||"utf16le"===e||"utf-16le"===e)){if(r.length<2||n.length<2)return -1;o/=a=2,u/=2,t/=2;}function s(r,n){return 1===a?r[n]:r.readUInt16BE(n*a)}if(i)for(var l=-1,f=t;f<o;f++)if(s(r,f)===s(n,-1===l?0:f-l)){if(f-(l=-1===l?f:l)+1===u)return l*a}else -1!==l&&(f-=f-l),l=-1;else for(f=t=o<t+u?o-u:t;0<=f;f--){for(var c=!0,h=0;h<u;h++)if(s(r,f+h)!==s(n,h)){c=!1;break}if(c)return f}return -1}function b(r,n,t,e){return S(function(r){for(var n=[],t=0;t<r.length;++t)n.push(255&r.charCodeAt(t));return n}(n),r,t,e)}function w(r,n,t,e){return S(function(r,n){for(var t,e,i=[],a=0;a<r.length&&!((n-=2)<0);++a)e=r.charCodeAt(a),t=e>>8,e=e%256,i.push(e),i.push(t);return i}(n,r.length-t),r,t,e)}function m(r,n,t){t=Math.min(r.length,t);for(var e=[],i=n;i<t;){var a,o,u,s,l=r[i],f=null,c=239<l?4:223<l?3:191<l?2:1;if(i+c<=t)switch(c){case 1:l<128&&(f=l);break;case 2:128==(192&(a=r[i+1]))&&127<(s=(31&l)<<6|63&a)&&(f=s);break;case 3:a=r[i+1],o=r[i+2],128==(192&a)&&128==(192&o)&&2047<(s=(15&l)<<12|(63&a)<<6|63&o)&&(s<55296||57343<s)&&(f=s);break;case 4:a=r[i+1],o=r[i+2],u=r[i+3],128==(192&a)&&128==(192&o)&&128==(192&u)&&65535<(s=(15&l)<<18|(63&a)<<12|(63&o)<<6|63&u)&&s<1114112&&(f=s);}null===f?(f=65533,c=1):65535<f&&(f-=65536,e.push(f>>>10&1023|55296),f=56320|1023&f),e.push(f),i+=c;}return function(r){var n=r.length;if(n<=A)return String.fromCharCode.apply(String,r);var t="",e=0;for(;e<n;)t+=String.fromCharCode.apply(String,r.slice(e,e+=A));return t}(e)}t.kMaxLength=e,(c.TYPED_ARRAY_SUPPORT=function(){try{var r=new Uint8Array(1),n={foo:function(){return 42}};return Object.setPrototypeOf(n,Uint8Array.prototype),Object.setPrototypeOf(r,n),42===r.foo()}catch(r){return !1}}())||"undefined"==typeof console||"function"!=typeof console.error||console.error("This browser lacks typed array (Uint8Array) support which is required by `buffer` v5.x. Use `buffer` v4.x if you require old browser support."),Object.defineProperty(c.prototype,"parent",{enumerable:!0,get:function(){if(c.isBuffer(this))return this.buffer}}),Object.defineProperty(c.prototype,"offset",{enumerable:!0,get:function(){if(c.isBuffer(this))return this.byteOffset}}),c.poolSize=8192,c.from=o,Object.setPrototypeOf(c.prototype,Uint8Array.prototype),Object.setPrototypeOf(c,Uint8Array),c.alloc=function(r,n,t){return n=n,t=t,s(r=r),!(r<=0)&&void 0!==n?"string"==typeof t?i(r).fill(n,t):i(r).fill(n):i(r)},c.allocUnsafe=l,c.allocUnsafeSlow=l,c.isBuffer=function(r){return null!=r&&!0===r._isBuffer&&r!==c.prototype},c.compare=function(r,n){if(U(r,Uint8Array)&&(r=c.from(r,r.offset,r.byteLength)),U(n,Uint8Array)&&(n=c.from(n,n.offset,n.byteLength)),!c.isBuffer(r)||!c.isBuffer(n))throw new TypeError('The "buf1", "buf2" arguments must be one of type Buffer or Uint8Array');if(r===n)return 0;for(var t=r.length,e=n.length,i=0,a=Math.min(t,e);i<a;++i)if(r[i]!==n[i]){t=r[i],e=n[i];break}return t<e?-1:e<t?1:0},c.isEncoding=function(r){switch(String(r).toLowerCase()){case"hex":case"utf8":case"utf-8":case"ascii":case"latin1":case"binary":case"base64":case"ucs2":case"ucs-2":case"utf16le":case"utf-16le":return !0;default:return !1}},c.concat=function(r,n){if(!Array.isArray(r))throw new TypeError('"list" argument must be an Array of Buffers');if(0===r.length)return c.alloc(0);if(void 0===n)for(i=n=0;i<r.length;++i)n+=r[i].length;for(var t=c.allocUnsafe(n),e=0,i=0;i<r.length;++i){var a=r[i];if(U(a,Uint8Array))e+a.length>t.length?c.from(a).copy(t,e):Uint8Array.prototype.set.call(t,a,e);else {if(!c.isBuffer(a))throw new TypeError('"list" argument must be an Array of Buffers');a.copy(t,e);}e+=a.length;}return t},c.byteLength=p,c.prototype._isBuffer=!0,c.prototype.swap16=function(){var r=this.length;if(r%2!=0)throw new RangeError("Buffer size must be a multiple of 16-bits");for(var n=0;n<r;n+=2)y(this,n,n+1);return this},c.prototype.swap32=function(){var r=this.length;if(r%4!=0)throw new RangeError("Buffer size must be a multiple of 32-bits");for(var n=0;n<r;n+=4)y(this,n,n+3),y(this,n+1,n+2);return this},c.prototype.swap64=function(){var r=this.length;if(r%8!=0)throw new RangeError("Buffer size must be a multiple of 64-bits");for(var n=0;n<r;n+=8)y(this,n,n+7),y(this,n+1,n+6),y(this,n+2,n+5),y(this,n+3,n+4);return this},c.prototype.toLocaleString=c.prototype.toString=function(){var r=this.length;return 0===r?"":0===arguments.length?m(this,0,r):g.apply(this,arguments)},c.prototype.equals=function(r){if(!c.isBuffer(r))throw new TypeError("Argument must be a Buffer");return this===r||0===c.compare(this,r)},c.prototype.inspect=function(){var r="",n=t.INSPECT_MAX_BYTES,r=this.toString("hex",0,n).replace(/(.{2})/g,"$1 ").trim();return this.length>n&&(r+=" ... "),"<Buffer "+r+">"},r&&(c.prototype[r]=c.prototype.inspect),c.prototype.compare=function(r,n,t,e,i){if(U(r,Uint8Array)&&(r=c.from(r,r.offset,r.byteLength)),!c.isBuffer(r))throw new TypeError('The "target" argument must be one of type Buffer or Uint8Array. Received type '+typeof r);if(void 0===t&&(t=r?r.length:0),void 0===e&&(e=0),void 0===i&&(i=this.length),(n=void 0===n?0:n)<0||t>r.length||e<0||i>this.length)throw new RangeError("out of range index");if(i<=e&&t<=n)return 0;if(i<=e)return -1;if(t<=n)return 1;if(this===r)return 0;for(var a=(i>>>=0)-(e>>>=0),o=(t>>>=0)-(n>>>=0),u=Math.min(a,o),s=this.slice(e,i),l=r.slice(n,t),f=0;f<u;++f)if(s[f]!==l[f]){a=s[f],o=l[f];break}return a<o?-1:o<a?1:0},c.prototype.includes=function(r,n,t){return -1!==this.indexOf(r,n,t)},c.prototype.indexOf=function(r,n,t){return v(this,r,n,t,!0)},c.prototype.lastIndexOf=function(r,n,t){return v(this,r,n,t,!1)},c.prototype.write=function(r,n,t,e){if(void 0===n)e="utf8",t=this.length,n=0;else if(void 0===t&&"string"==typeof n)e=n,t=this.length,n=0;else {if(!isFinite(n))throw new Error("Buffer.write(string, encoding, offset[, length]) is no longer supported");n>>>=0,isFinite(t)?(t>>>=0,void 0===e&&(e="utf8")):(e=t,t=void 0);}var i=this.length-n;if((void 0===t||i<t)&&(t=i),0<r.length&&(t<0||n<0)||n>this.length)throw new RangeError("Attempt to write outside buffer bounds");e=e||"utf8";for(var a,o,u,s=!1;;)switch(e){case"hex":return function(r,n,t,e){t=Number(t)||0;var i=r.length-t;(!e||i<(e=Number(e)))&&(e=i),(i=n.length)/2<e&&(e=i/2);for(var a=0;a<e;++a){var o=parseInt(n.substr(2*a,2),16);if(N(o))return a;r[t+a]=o;}return a}(this,r,n,t);case"utf8":case"utf-8":return o=n,u=t,S(B(r,(a=this).length-o),a,o,u);case"ascii":case"latin1":case"binary":return b(this,r,n,t);case"base64":return a=this,o=n,u=t,S(T(r),a,o,u);case"ucs2":case"ucs-2":case"utf16le":case"utf-16le":return w(this,r,n,t);default:if(s)throw new TypeError("Unknown encoding: "+e);e=(""+e).toLowerCase(),s=!0;}},c.prototype.toJSON=function(){return {type:"Buffer",data:Array.prototype.slice.call(this._arr||this,0)}};var A=4096;function j(r,n,t){if(r%1!=0||r<0)throw new RangeError("offset is not uint");if(t<r+n)throw new RangeError("Trying to access beyond buffer length")}function x(r,n,t,e,i,a){if(!c.isBuffer(r))throw new TypeError('"buffer" argument must be a Buffer instance');if(i<n||n<a)throw new RangeError('"value" argument is out of bounds');if(t+e>r.length)throw new RangeError("Index out of range")}function E(r,n,t,e){if(t+e>r.length)throw new RangeError("Index out of range");if(t<0)throw new RangeError("Index out of range")}function V(r,n,t,e,i){return n=+n,t>>>=0,i||E(r,0,t,4),a.write(r,n,t,e,23,4),t+4}function k(r,n,t,e,i){return n=+n,t>>>=0,i||E(r,0,t,8),a.write(r,n,t,e,52,8),t+8}c.prototype.slice=function(r,n){var t=this.length;(r=~~r)<0?(r+=t)<0&&(r=0):t<r&&(r=t),(n=void 0===n?t:~~n)<0?(n+=t)<0&&(n=0):t<n&&(n=t),n<r&&(n=r);n=this.subarray(r,n);return Object.setPrototypeOf(n,c.prototype),n},c.prototype.readUintLE=c.prototype.readUIntLE=function(r,n,t){r>>>=0,n>>>=0,t||j(r,n,this.length);for(var e=this[r],i=1,a=0;++a<n&&(i*=256);)e+=this[r+a]*i;return e},c.prototype.readUintBE=c.prototype.readUIntBE=function(r,n,t){r>>>=0,n>>>=0,t||j(r,n,this.length);for(var e=this[r+--n],i=1;0<n&&(i*=256);)e+=this[r+--n]*i;return e},c.prototype.readUint8=c.prototype.readUInt8=function(r,n){return r>>>=0,n||j(r,1,this.length),this[r]},c.prototype.readUint16LE=c.prototype.readUInt16LE=function(r,n){return r>>>=0,n||j(r,2,this.length),this[r]|this[r+1]<<8},c.prototype.readUint16BE=c.prototype.readUInt16BE=function(r,n){return r>>>=0,n||j(r,2,this.length),this[r]<<8|this[r+1]},c.prototype.readUint32LE=c.prototype.readUInt32LE=function(r,n){return r>>>=0,n||j(r,4,this.length),(this[r]|this[r+1]<<8|this[r+2]<<16)+16777216*this[r+3]},c.prototype.readUint32BE=c.prototype.readUInt32BE=function(r,n){return r>>>=0,n||j(r,4,this.length),16777216*this[r]+(this[r+1]<<16|this[r+2]<<8|this[r+3])},c.prototype.readIntLE=function(r,n,t){r>>>=0,n>>>=0,t||j(r,n,this.length);for(var e=this[r],i=1,a=0;++a<n&&(i*=256);)e+=this[r+a]*i;return (i*=128)<=e&&(e-=Math.pow(2,8*n)),e},c.prototype.readIntBE=function(r,n,t){r>>>=0,n>>>=0,t||j(r,n,this.length);for(var e=n,i=1,a=this[r+--e];0<e&&(i*=256);)a+=this[r+--e]*i;return (i*=128)<=a&&(a-=Math.pow(2,8*n)),a},c.prototype.readInt8=function(r,n){return r>>>=0,n||j(r,1,this.length),128&this[r]?-1*(255-this[r]+1):this[r]},c.prototype.readInt16LE=function(r,n){r>>>=0,n||j(r,2,this.length);r=this[r]|this[r+1]<<8;return 32768&r?4294901760|r:r},c.prototype.readInt16BE=function(r,n){r>>>=0,n||j(r,2,this.length);r=this[r+1]|this[r]<<8;return 32768&r?4294901760|r:r},c.prototype.readInt32LE=function(r,n){return r>>>=0,n||j(r,4,this.length),this[r]|this[r+1]<<8|this[r+2]<<16|this[r+3]<<24},c.prototype.readInt32BE=function(r,n){return r>>>=0,n||j(r,4,this.length),this[r]<<24|this[r+1]<<16|this[r+2]<<8|this[r+3]},c.prototype.readFloatLE=function(r,n){return r>>>=0,n||j(r,4,this.length),a.read(this,r,!0,23,4)},c.prototype.readFloatBE=function(r,n){return r>>>=0,n||j(r,4,this.length),a.read(this,r,!1,23,4)},c.prototype.readDoubleLE=function(r,n){return r>>>=0,n||j(r,8,this.length),a.read(this,r,!0,52,8)},c.prototype.readDoubleBE=function(r,n){return r>>>=0,n||j(r,8,this.length),a.read(this,r,!1,52,8)},c.prototype.writeUintLE=c.prototype.writeUIntLE=function(r,n,t,e){r=+r,n>>>=0,t>>>=0,e||x(this,r,n,t,Math.pow(2,8*t)-1,0);var i=1,a=0;for(this[n]=255&r;++a<t&&(i*=256);)this[n+a]=r/i&255;return n+t},c.prototype.writeUintBE=c.prototype.writeUIntBE=function(r,n,t,e){r=+r,n>>>=0,t>>>=0,e||x(this,r,n,t,Math.pow(2,8*t)-1,0);var i=t-1,a=1;for(this[n+i]=255&r;0<=--i&&(a*=256);)this[n+i]=r/a&255;return n+t},c.prototype.writeUint8=c.prototype.writeUInt8=function(r,n,t){return r=+r,n>>>=0,t||x(this,r,n,1,255,0),this[n]=255&r,n+1},c.prototype.writeUint16LE=c.prototype.writeUInt16LE=function(r,n,t){return r=+r,n>>>=0,t||x(this,r,n,2,65535,0),this[n]=255&r,this[n+1]=r>>>8,n+2},c.prototype.writeUint16BE=c.prototype.writeUInt16BE=function(r,n,t){return r=+r,n>>>=0,t||x(this,r,n,2,65535,0),this[n]=r>>>8,this[n+1]=255&r,n+2},c.prototype.writeUint32LE=c.prototype.writeUInt32LE=function(r,n,t){return r=+r,n>>>=0,t||x(this,r,n,4,4294967295,0),this[n+3]=r>>>24,this[n+2]=r>>>16,this[n+1]=r>>>8,this[n]=255&r,n+4},c.prototype.writeUint32BE=c.prototype.writeUInt32BE=function(r,n,t){return r=+r,n>>>=0,t||x(this,r,n,4,4294967295,0),this[n]=r>>>24,this[n+1]=r>>>16,this[n+2]=r>>>8,this[n+3]=255&r,n+4},c.prototype.writeIntLE=function(r,n,t,e){r=+r,n>>>=0,e||x(this,r,n,t,(e=Math.pow(2,8*t-1))-1,-e);var i=0,a=1,o=0;for(this[n]=255&r;++i<t&&(a*=256);)r<0&&0===o&&0!==this[n+i-1]&&(o=1),this[n+i]=(r/a>>0)-o&255;return n+t},c.prototype.writeIntBE=function(r,n,t,e){r=+r,n>>>=0,e||x(this,r,n,t,(e=Math.pow(2,8*t-1))-1,-e);var i=t-1,a=1,o=0;for(this[n+i]=255&r;0<=--i&&(a*=256);)r<0&&0===o&&0!==this[n+i+1]&&(o=1),this[n+i]=(r/a>>0)-o&255;return n+t},c.prototype.writeInt8=function(r,n,t){return r=+r,n>>>=0,t||x(this,r,n,1,127,-128),this[n]=255&(r=r<0?255+r+1:r),n+1},c.prototype.writeInt16LE=function(r,n,t){return r=+r,n>>>=0,t||x(this,r,n,2,32767,-32768),this[n]=255&r,this[n+1]=r>>>8,n+2},c.prototype.writeInt16BE=function(r,n,t){return r=+r,n>>>=0,t||x(this,r,n,2,32767,-32768),this[n]=r>>>8,this[n+1]=255&r,n+2},c.prototype.writeInt32LE=function(r,n,t){return r=+r,n>>>=0,t||x(this,r,n,4,2147483647,-2147483648),this[n]=255&r,this[n+1]=r>>>8,this[n+2]=r>>>16,this[n+3]=r>>>24,n+4},c.prototype.writeInt32BE=function(r,n,t){return r=+r,n>>>=0,t||x(this,r,n,4,2147483647,-2147483648),this[n]=(r=r<0?4294967295+r+1:r)>>>24,this[n+1]=r>>>16,this[n+2]=r>>>8,this[n+3]=255&r,n+4},c.prototype.writeFloatLE=function(r,n,t){return V(this,r,n,!0,t)},c.prototype.writeFloatBE=function(r,n,t){return V(this,r,n,!1,t)},c.prototype.writeDoubleLE=function(r,n,t){return k(this,r,n,!0,t)},c.prototype.writeDoubleBE=function(r,n,t){return k(this,r,n,!1,t)},c.prototype.copy=function(r,n,t,e){if(!c.isBuffer(r))throw new TypeError("argument should be a Buffer");if(t=t||0,e||0===e||(e=this.length),n>=r.length&&(n=r.length),(e=0<e&&e<t?t:e)===t)return 0;if(0===r.length||0===this.length)return 0;if((n=n||0)<0)throw new RangeError("targetStart out of bounds");if(t<0||t>=this.length)throw new RangeError("Index out of range");if(e<0)throw new RangeError("sourceEnd out of bounds");e>this.length&&(e=this.length);var i=(e=r.length-n<e-t?r.length-n+t:e)-t;return this===r&&"function"==typeof Uint8Array.prototype.copyWithin?this.copyWithin(n,t,e):Uint8Array.prototype.set.call(r,this.subarray(t,e),n),i},c.prototype.fill=function(r,n,t,e){if("string"==typeof r){if("string"==typeof n?(e=n,n=0,t=this.length):"string"==typeof t&&(e=t,t=this.length),void 0!==e&&"string"!=typeof e)throw new TypeError("encoding must be a string");if("string"==typeof e&&!c.isEncoding(e))throw new TypeError("Unknown encoding: "+e);var i;1===r.length&&(i=r.charCodeAt(0),("utf8"===e&&i<128||"latin1"===e)&&(r=i));}else "number"==typeof r?r&=255:"boolean"==typeof r&&(r=Number(r));if(n<0||this.length<n||this.length<t)throw new RangeError("Out of range index");if(t<=n)return this;var a;if(n>>>=0,t=void 0===t?this.length:t>>>0,"number"==typeof(r=r||0))for(a=n;a<t;++a)this[a]=r;else {var o=c.isBuffer(r)?r:c.from(r,e),u=o.length;if(0===u)throw new TypeError('The value "'+r+'" is invalid for argument "value"');for(a=0;a<t-n;++a)this[a+n]=o[a%u];}return this};var I=/[^+/0-9A-Za-z-_]/g;function B(r,n){var t;n=n||1/0;for(var e=r.length,i=null,a=[],o=0;o<e;++o){if(55295<(t=r.charCodeAt(o))&&t<57344){if(!i){if(56319<t){-1<(n-=3)&&a.push(239,191,189);continue}if(o+1===e){-1<(n-=3)&&a.push(239,191,189);continue}i=t;continue}if(t<56320){-1<(n-=3)&&a.push(239,191,189),i=t;continue}t=65536+(i-55296<<10|t-56320);}else i&&-1<(n-=3)&&a.push(239,191,189);if(i=null,t<128){if(--n<0)break;a.push(t);}else if(t<2048){if((n-=2)<0)break;a.push(t>>6|192,63&t|128);}else if(t<65536){if((n-=3)<0)break;a.push(t>>12|224,t>>6&63|128,63&t|128);}else {if(!(t<1114112))throw new Error("Invalid code point");if((n-=4)<0)break;a.push(t>>18|240,t>>12&63|128,t>>6&63|128,63&t|128);}}return a}function T(r){return u.toByteArray(function(r){if((r=(r=r.split("=")[0]).trim().replace(I,"")).length<2)return "";for(;r.length%4!=0;)r+="=";return r}(r))}function S(r,n,t,e){for(var i=0;i<e&&!(i+t>=n.length||i>=r.length);++i)n[i+t]=r[i];return i}function U(r,n){return r instanceof n||null!=r&&null!=r.constructor&&null!=r.constructor.name&&r.constructor.name===n.name}function N(r){return r!=r}var O=function(){for(var r="0123456789abcdef",n=new Array(256),t=0;t<16;++t)for(var e=16*t,i=0;i<16;++i)n[e+i]=r[t]+r[i];return n}();},{"base64-js":1,ieee754:9}],4:[function(r,n,t){var a=r("./lib/thunk.js");function o(){this.argTypes=[],this.shimArgs=[],this.arrayArgs=[],this.arrayBlockIndices=[],this.scalarArgs=[],this.offsetArgs=[],this.offsetArgIndex=[],this.indexArgs=[],this.shapeArgs=[],this.funcName="",this.pre=null,this.body=null,this.post=null,this.debug=!1;}n.exports=function(r){var n=new o;n.pre=r.pre,n.body=r.body,n.post=r.post;var t=r.args.slice(0);n.argTypes=t;for(var e=0;e<t.length;++e){var i=t[e];if("array"===i||"object"==typeof i&&i.blockIndices){if(n.argTypes[e]="array",n.arrayArgs.push(e),n.arrayBlockIndices.push(i.blockIndices||0),n.shimArgs.push("array"+e),e<n.pre.args.length&&0<n.pre.args[e].count)throw new Error("cwise: pre() block may not reference array args");if(e<n.post.args.length&&0<n.post.args[e].count)throw new Error("cwise: post() block may not reference array args")}else if("scalar"===i)n.scalarArgs.push(e),n.shimArgs.push("scalar"+e);else if("index"===i){if(n.indexArgs.push(e),e<n.pre.args.length&&0<n.pre.args[e].count)throw new Error("cwise: pre() block may not reference array index");if(e<n.body.args.length&&n.body.args[e].lvalue)throw new Error("cwise: body() block may not write to array index");if(e<n.post.args.length&&0<n.post.args[e].count)throw new Error("cwise: post() block may not reference array index")}else if("shape"===i){if(n.shapeArgs.push(e),e<n.pre.args.length&&n.pre.args[e].lvalue)throw new Error("cwise: pre() block may not write to array shape");if(e<n.body.args.length&&n.body.args[e].lvalue)throw new Error("cwise: body() block may not write to array shape");if(e<n.post.args.length&&n.post.args[e].lvalue)throw new Error("cwise: post() block may not write to array shape")}else {if("object"!=typeof i||!i.offset)throw new Error("cwise: Unknown argument type "+t[e]);n.argTypes[e]="offset",n.offsetArgs.push({array:i.array,offset:i.offset}),n.offsetArgIndex.push(e);}}if(n.arrayArgs.length<=0)throw new Error("cwise: No array arguments specified");if(n.pre.args.length>t.length)throw new Error("cwise: Too many arguments in pre() block");if(n.body.args.length>t.length)throw new Error("cwise: Too many arguments in body() block");if(n.post.args.length>t.length)throw new Error("cwise: Too many arguments in post() block");return n.debug=!!r.printCode||!!r.debug,n.funcName=r.funcName||"cwise",n.blockSize=r.blockSize||64,a(n)};},{"./lib/thunk.js":6}],5:[function(r,n,t){var m=r("uniq");function A(r,n,t){for(var e,i=r.length,a=n.arrayArgs.length,o=0<n.indexArgs.length,u=[],s=[],l=0,f=0,c=0;c<i;++c)s.push(["i",c,"=0"].join(""));for(e=0;e<a;++e)for(c=0;c<i;++c)f=l,l=r[c],0===c?s.push(["d",e,"s",c,"=t",e,"p",l].join("")):s.push(["d",e,"s",c,"=(t",e,"p",l,"-s",f,"*t",e,"p",f,")"].join(""));for(0<s.length&&u.push("var "+s.join(",")),c=i-1;0<=c;--c)l=r[c],u.push(["for(i",c,"=0;i",c,"<s",l,";++i",c,"){"].join(""));for(u.push(t),c=0;c<i;++c){for(f=l,l=r[c],e=0;e<a;++e)u.push(["p",e,"+=d",e,"s",c].join(""));o&&(0<c&&u.push(["index[",f,"]-=s",f].join("")),u.push(["++index[",l,"]"].join(""))),u.push("}");}return u.join("\n")}function j(r,n,t){for(var e=r.body,i=[],a=[],o=0;o<r.args.length;++o){var u=r.args[o];if(!(u.count<=0)){var s=new RegExp(u.name,"g"),l="",f=n.arrayArgs.indexOf(o);switch(n.argTypes[o]){case"offset":var c=n.offsetArgIndex.indexOf(o),f=n.offsetArgs[c].array,l="+q"+c;case"array":l="p"+f+l;var h="l"+o,c="a"+f;if(0===n.arrayBlockIndices[f])1===u.count?"generic"===t[f]?u.lvalue?(i.push(["var ",h,"=",c,".get(",l,")"].join("")),e=e.replace(s,h),a.push([c,".set(",l,",",h,")"].join(""))):e=e.replace(s,[c,".get(",l,")"].join("")):e=e.replace(s,[c,"[",l,"]"].join("")):"generic"===t[f]?(i.push(["var ",h,"=",c,".get(",l,")"].join("")),e=e.replace(s,h),u.lvalue&&a.push([c,".set(",l,",",h,")"].join(""))):(i.push(["var ",h,"=",c,"[",l,"]"].join("")),e=e.replace(s,h),u.lvalue&&a.push([c,"[",l,"]=",h].join("")));else {for(var _=[u.name],p=[l],g=0;g<Math.abs(n.arrayBlockIndices[f]);g++)_.push("\\s*\\[([^\\]]+)\\]"),p.push("$"+(g+1)+"*t"+f+"b"+g);if(s=new RegExp(_.join(""),"g"),l=p.join("+"),"generic"===t[f])throw new Error("cwise: Generic arrays not supported in combination with blocks!");e=e.replace(s,[c,"[",l,"]"].join(""));}break;case"scalar":e=e.replace(s,"Y"+n.scalarArgs.indexOf(o));break;case"index":e=e.replace(s,"index");break;case"shape":e=e.replace(s,"shape");}}}return [i.join("\n"),e,a.join("\n")].join("\n").trim()}n.exports=function(r,n){for(var t=n[1].length-Math.abs(r.arrayBlockIndices[0])|0,e=new Array(r.arrayArgs.length),i=new Array(r.arrayArgs.length),a=0;a<r.arrayArgs.length;++a)i[a]=n[2*a],e[a]=n[2*a+1];for(var o=[],u=[],s=[],l=[],f=[],a=0;a<r.arrayArgs.length;++a){r.arrayBlockIndices[a]<0?(s.push(0),l.push(t),o.push(t),u.push(t+r.arrayBlockIndices[a])):(s.push(r.arrayBlockIndices[a]),l.push(r.arrayBlockIndices[a]+t),o.push(0),u.push(r.arrayBlockIndices[a]));for(var c=[],h=0;h<e[a].length;h++)s[a]<=e[a][h]&&e[a][h]<l[a]&&c.push(e[a][h]-s[a]);f.push(c);}for(var _=["SS"],p=["'use strict'"],g=[],h=0;h<t;++h)g.push(["s",h,"=SS[",h,"]"].join(""));for(a=0;a<r.arrayArgs.length;++a){_.push("a"+a),_.push("t"+a),_.push("p"+a);for(h=0;h<t;++h)g.push(["t",a,"p",h,"=t",a,"[",s[a]+h,"]"].join(""));for(h=0;h<Math.abs(r.arrayBlockIndices[a]);++h)g.push(["t",a,"b",h,"=t",a,"[",o[a]+h,"]"].join(""));}for(a=0;a<r.scalarArgs.length;++a)_.push("Y"+a);if(0<r.shapeArgs.length&&g.push("shape=SS.slice(0)"),0<r.indexArgs.length){for(var y=new Array(t),a=0;a<t;++a)y[a]="0";g.push(["index=[",y.join(","),"]"].join(""));}for(a=0;a<r.offsetArgs.length;++a){for(var v=r.offsetArgs[a],d=[],h=0;h<v.offset.length;++h)0!==v.offset[h]&&(1===v.offset[h]?d.push(["t",v.array,"p",h].join("")):d.push([v.offset[h],"*t",v.array,"p",h].join("")));0===d.length?g.push("q"+a+"=0"):g.push(["q",a,"=",d.join("+")].join(""));}var b=m([].concat(r.pre.thisVars).concat(r.body.thisVars).concat(r.post.thisVars));for(0<(g=g.concat(b)).length&&p.push("var "+g.join(",")),a=0;a<r.arrayArgs.length;++a)p.push("p"+a+"|=0");3<r.pre.body.length&&p.push(j(r.pre,r,i));var w=j(r.body,r,i);return (b=function(r){for(var n=0,t=r[0].length;n<t;){for(var e=1;e<r.length;++e)if(r[e][n]!==r[0][n])return n;++n;}return n}(f))<t?p.push(function(r,n,t,e){for(var i=n.length,a=t.arrayArgs.length,o=t.blockSize,u=0<t.indexArgs.length,s=[],l=0;l<a;++l)s.push(["var offset",l,"=p",l].join(""));for(l=r;l<i;++l)s.push(["for(var j"+l+"=SS[",n[l],"]|0;j",l,">0;){"].join("")),s.push(["if(j",l,"<",o,"){"].join("")),s.push(["s",n[l],"=j",l].join("")),s.push(["j",l,"=0"].join("")),s.push(["}else{s",n[l],"=",o].join("")),s.push(["j",l,"-=",o,"}"].join("")),u&&s.push(["index[",n[l],"]=j",l].join(""));for(l=0;l<a;++l){for(var f=["offset"+l],c=r;c<i;++c)f.push(["j",c,"*t",l,"p",n[c]].join(""));s.push(["p",l,"=(",f.join("+"),")"].join(""));}for(s.push(A(n,t,e)),l=r;l<i;++l)s.push("}");return s.join("\n")}(b,f[0],r,w)):p.push(A(f[0],r,w)),3<r.post.body.length&&p.push(j(r.post,r,i)),r.debug&&console.log("-----Generated cwise routine for ",n,":\n"+p.join("\n")+"\n----------"),b=[r.funcName||"unnamed","_cwise_loop_",e[0].join("s"),"m",b,function(r){for(var n=new Array(r.length),t=!0,e=0;e<r.length;++e){var i=r[e],a=(a=i.match(/\d+/))?a[0]:"";0===i.charAt(0)?n[e]="u"+i.charAt(1)+a:n[e]=i.charAt(0)+a,0<e&&(t=t&&n[e]===n[e-1]);}return t?n[0]:n.join("")}(i)].join(""),new Function(["function ",b,"(",_.join(","),"){",p.join("\n"),"} return ",b].join(""))()};},{uniq:22}],6:[function(r,n,t){var c=r("./compile.js");n.exports=function(r){var n=["'use strict'","var CACHED={}"],t=[],e=r.funcName+"_cwise_thunk";n.push(["return function ",e,"(",r.shimArgs.join(","),"){"].join(""));for(var i=[],a=[],o=[["array",r.arrayArgs[0],".shape.slice(",Math.max(0,r.arrayBlockIndices[0]),r.arrayBlockIndices[0]<0?","+r.arrayBlockIndices[0]+")":")"].join("")],u=[],s=[],l=0;l<r.arrayArgs.length;++l){var f=r.arrayArgs[l];t.push(["t",f,"=array",f,".dtype,","r",f,"=array",f,".order"].join("")),i.push("t"+f),i.push("r"+f),a.push("t"+f),a.push("r"+f+".join()"),o.push("array"+f+".data"),o.push("array"+f+".stride"),o.push("array"+f+".offset|0"),0<l&&(u.push("array"+r.arrayArgs[0]+".shape.length===array"+f+".shape.length+"+(Math.abs(r.arrayBlockIndices[0])-Math.abs(r.arrayBlockIndices[l]))),s.push("array"+r.arrayArgs[0]+".shape[shapeIndex+"+Math.max(0,r.arrayBlockIndices[0])+"]===array"+f+".shape[shapeIndex+"+Math.max(0,r.arrayBlockIndices[l])+"]"));}for(1<r.arrayArgs.length&&(n.push("if (!("+u.join(" && ")+")) throw new Error('cwise: Arrays do not all have the same dimensionality!')"),n.push("for(var shapeIndex=array"+r.arrayArgs[0]+".shape.length-"+Math.abs(r.arrayBlockIndices[0])+"; shapeIndex--\x3e0;) {"),n.push("if (!("+s.join(" && ")+")) throw new Error('cwise: Arrays do not all have the same shape!')"),n.push("}")),l=0;l<r.scalarArgs.length;++l)o.push("scalar"+r.scalarArgs[l]);return t.push(["type=[",a.join(","),"].join()"].join("")),t.push("proc=CACHED[type]"),n.push("var "+t.join(",")),n.push(["if(!proc){","CACHED[type]=proc=compile([",i.join(","),"])}","return proc(",o.join(","),")}"].join("")),r.debug&&console.log("-----Generated thunk:\n"+n.join("\n")+"\n----------"),new Function("compile",n.join("\n"))(c.bind(void 0,r))};},{"./compile.js":5}],7:[function(r,n,t){n.exports=r("cwise-compiler");},{"cwise-compiler":4}],8:[function(r,n,t){n.exports=function(r,n){switch(void 0===n&&(n=0),typeof r){case"number":if(0<r)return function(r,n){for(var t=new Array(r),e=0;e<r;++e)t[e]=n;return t}(0|r,n);break;case"object":if("number"==typeof r.length)return function r(n,t,e){var i=0|n[e];if(i<=0)return [];var a,o=new Array(i);if(e===n.length-1)for(a=0;a<i;++a)o[a]=t;else for(a=0;a<i;++a)o[a]=r(n,t,e+1);return o}(r,n,0)}return []};},{}],9:[function(r,n,t){t.read=function(r,n,t,e,i){var a,o,u=8*i-e-1,s=(1<<u)-1,l=s>>1,f=-7,c=t?i-1:0,h=t?-1:1,t=r[n+c];for(c+=h,a=t&(1<<-f)-1,t>>=-f,f+=u;0<f;a=256*a+r[n+c],c+=h,f-=8);for(o=a&(1<<-f)-1,a>>=-f,f+=e;0<f;o=256*o+r[n+c],c+=h,f-=8);if(0===a)a=1-l;else {if(a===s)return o?NaN:1/0*(t?-1:1);o+=Math.pow(2,e),a-=l;}return (t?-1:1)*o*Math.pow(2,a-e)},t.write=function(r,n,t,e,i,a){var o,u,s=8*a-i-1,l=(1<<s)-1,f=l>>1,c=23===i?Math.pow(2,-24)-Math.pow(2,-77):0,h=e?0:a-1,_=e?1:-1,a=n<0||0===n&&1/n<0?1:0;for(n=Math.abs(n),isNaN(n)||n===1/0?(u=isNaN(n)?1:0,o=l):(o=Math.floor(Math.log(n)/Math.LN2),n*(e=Math.pow(2,-o))<1&&(o--,e*=2),2<=(n+=1<=o+f?c/e:c*Math.pow(2,1-f))*e&&(o++,e/=2),l<=o+f?(u=0,o=l):1<=o+f?(u=(n*e-1)*Math.pow(2,i),o+=f):(u=n*Math.pow(2,f-1)*Math.pow(2,i),o=0));8<=i;r[t+h]=255&u,h+=_,u/=256,i-=8);for(o=o<<i|u,s+=i;0<s;r[t+h]=255&o,h+=_,o/=256,s-=8);r[t+h-_]|=128*a;};},{}],10:[function(r,n,t){n.exports=function(r){for(var n=new Array(r),t=0;t<r;++t)n[t]=t;return n};},{}],11:[function(r,n,t){function e(r){return !!r.constructor&&"function"==typeof r.constructor.isBuffer&&r.constructor.isBuffer(r)}n.exports=function(r){return null!=r&&(e(r)||"function"==typeof(n=r).readFloatLE&&"function"==typeof n.slice&&e(n.slice(0,0))||!!r._isBuffer);var n;};},{}],12:[function(r,S,U){!function(T){!function(){var Da,Fa="Expected a function",Pa="__lodash_hash_undefined__",Wa="__lodash_placeholder__",$a=128,Ya=9007199254740991,Za=NaN,Ha=4294967295,Ga=[["ary",$a],["bind",1],["bindKey",2],["curry",8],["curryRight",16],["flip",512],["partial",32],["partialRight",64],["rearg",256]],Ja="[object Arguments]",Ka="[object Array]",Xa="[object Boolean]",Qa="[object Date]",ro="[object Error]",no="[object Function]",to="[object GeneratorFunction]",eo="[object Map]",io="[object Number]",ao="[object Object]",oo="[object Promise]",uo="[object RegExp]",so="[object Set]",lo="[object String]",fo="[object Symbol]",co="[object WeakMap]",ho="[object ArrayBuffer]",_o="[object DataView]",po="[object Float32Array]",go="[object Float64Array]",yo="[object Int8Array]",vo="[object Int16Array]",bo="[object Int32Array]",wo="[object Uint8Array]",mo="[object Uint8ClampedArray]",Ao="[object Uint16Array]",jo="[object Uint32Array]",xo=/\b__p \+= '';/g,Eo=/\b(__p \+=) '' \+/g,Vo=/(__e\(.*?\)|\b__t\)) \+\n'';/g,ko=/&(?:amp|lt|gt|quot|#39);/g,Io=/[&<>"']/g,Bo=RegExp(ko.source),To=RegExp(Io.source),So=/<%-([\s\S]+?)%>/g,Uo=/<%([\s\S]+?)%>/g,No=/<%=([\s\S]+?)%>/g,Oo=/\.|\[(?:[^[\]]*|(["'])(?:(?!\1)[^\\]|\\.)*?\1)\]/,zo=/^\w*$/,Mo=/[^.[\]]+|\[(?:(-?\d+(?:\.\d+)?)|(["'])((?:(?!\2)[^\\]|\\.)*?)\2)\]|(?=(?:\.|\[\])(?:\.|\[\]|$))/g,Co=/[\\^$.*+?()[\]{}|]/g,qo=RegExp(Co.source),Ro=/^\s+/,t=/\s/,Lo=/\{(?:\n\/\* \[wrapped with .+\] \*\/)?\n?/,Do=/\{\n\/\* \[wrapped with (.+)\] \*/,Fo=/,? & /,Po=/[^\x00-\x2f\x3a-\x40\x5b-\x60\x7b-\x7f]+/g,Wo=/[()=,{}\[\]\/\s]/,$o=/\\(\\)?/g,Yo=/\$\{([^\\}]*(?:\\.[^\\}]*)*)\}/g,Zo=/\w*$/,Ho=/^[-+]0x[0-9a-f]+$/i,Go=/^0b[01]+$/i,Jo=/^\[object .+?Constructor\]$/,Ko=/^0o[0-7]+$/i,Xo=/^(?:0|[1-9]\d*)$/,Qo=/[\xc0-\xd6\xd8-\xf6\xf8-\xff\u0100-\u017f]/g,ru=/($^)/,nu=/['\n\r\u2028\u2029\\]/g,r="\\ud800-\\udfff",n="\\u0300-\\u036f\\ufe20-\\ufe2f\\u20d0-\\u20ff",e="\\u2700-\\u27bf",i="a-z\\xdf-\\xf6\\xf8-\\xff",a="A-Z\\xc0-\\xd6\\xd8-\\xde",o="\\ufe0e\\ufe0f",u="\\xac\\xb1\\xd7\\xf7\\x00-\\x2f\\x3a-\\x40\\x5b-\\x60\\x7b-\\xbf\\u2000-\\u206f \\t\\x0b\\f\\xa0\\ufeff\\n\\r\\u2028\\u2029\\u1680\\u180e\\u2000\\u2001\\u2002\\u2003\\u2004\\u2005\\u2006\\u2007\\u2008\\u2009\\u200a\\u202f\\u205f\\u3000",s="['’]",l="["+r+"]",f="["+u+"]",c="["+n+"]",h="\\d+",_="["+e+"]",p="["+i+"]",g="[^"+r+u+h+e+i+a+"]",y="\\ud83c[\\udffb-\\udfff]",v="[^"+r+"]",d="(?:\\ud83c[\\udde6-\\uddff]){2}",b="[\\ud800-\\udbff][\\udc00-\\udfff]",w="["+a+"]",m="\\u200d",A="(?:"+p+"|"+g+")",u="(?:"+w+"|"+g+")",e="(?:['’](?:d|ll|m|re|s|t|ve))?",i="(?:['’](?:D|LL|M|RE|S|T|VE))?",a="(?:"+c+"|"+y+")"+"?",g="["+o+"]?",a=g+a+("(?:"+m+"(?:"+[v,d,b].join("|")+")"+g+a+")*"),_="(?:"+[_,d,b].join("|")+")"+a,l="(?:"+[v+c+"?",c,d,b,l].join("|")+")",tu=RegExp(s,"g"),eu=RegExp(c,"g"),j=RegExp(y+"(?="+y+")|"+l+a,"g"),iu=RegExp([w+"?"+p+"+"+e+"(?="+[f,w,"$"].join("|")+")",u+"+"+i+"(?="+[f,w+A,"$"].join("|")+")",w+"?"+A+"+"+e,w+"+"+i,"\\d*(?:1ST|2ND|3RD|(?![123])\\dTH)(?=\\b|[a-z_])","\\d*(?:1st|2nd|3rd|(?![123])\\dth)(?=\\b|[A-Z_])",h,_].join("|"),"g"),x=RegExp("["+m+r+n+o+"]"),au=/[a-z][A-Z]|[A-Z]{2}[a-z]|[0-9][a-zA-Z]|[a-zA-Z][0-9]|[^a-zA-Z0-9 ]/,ou=["Array","Buffer","DataView","Date","Error","Float32Array","Float64Array","Function","Int8Array","Int16Array","Int32Array","Map","Math","Object","Promise","RegExp","Set","String","Symbol","TypeError","Uint8Array","Uint8ClampedArray","Uint16Array","Uint32Array","WeakMap","_","clearTimeout","isFinite","parseInt","setTimeout"],uu=-1,su={};su[po]=su[go]=su[yo]=su[vo]=su[bo]=su[wo]=su[mo]=su[Ao]=su[jo]=!0,su[Ja]=su[Ka]=su[ho]=su[Xa]=su[_o]=su[Qa]=su[ro]=su[no]=su[eo]=su[io]=su[ao]=su[uo]=su[so]=su[lo]=su[co]=!1;var lu={};lu[Ja]=lu[Ka]=lu[ho]=lu[_o]=lu[Xa]=lu[Qa]=lu[po]=lu[go]=lu[yo]=lu[vo]=lu[bo]=lu[eo]=lu[io]=lu[ao]=lu[uo]=lu[so]=lu[lo]=lu[fo]=lu[wo]=lu[mo]=lu[Ao]=lu[jo]=!0,lu[ro]=lu[no]=lu[co]=!1;var E={"\\":"\\","'":"'","\n":"n","\r":"r","\u2028":"u2028","\u2029":"u2029"},fu=parseFloat,cu=parseInt,n="object"==typeof T&&T&&T.Object===Object&&T,o="object"==typeof self&&self&&self.Object===Object&&self,hu=n||o||Function("return this")(),o="object"==typeof U&&U&&!U.nodeType&&U,V=o&&"object"==typeof S&&S&&!S.nodeType&&S,_u=V&&V.exports===o,k=_u&&n.process,n=function(){try{var r=V&&V.require&&V.require("util").types;return r?r:k&&k.binding&&k.binding("util")}catch(r){}}(),pu=n&&n.isArrayBuffer,gu=n&&n.isDate,yu=n&&n.isMap,vu=n&&n.isRegExp,du=n&&n.isSet,bu=n&&n.isTypedArray;function wu(r,n,t){switch(t.length){case 0:return r.call(n);case 1:return r.call(n,t[0]);case 2:return r.call(n,t[0],t[1]);case 3:return r.call(n,t[0],t[1],t[2])}return r.apply(n,t)}function mu(r,n,t,e){for(var i=-1,a=null==r?0:r.length;++i<a;){var o=r[i];n(e,o,t(o),r);}return e}function Au(r,n){for(var t=-1,e=null==r?0:r.length;++t<e&&!1!==n(r[t],t,r););return r}function ju(r,n){for(var t=null==r?0:r.length;t--&&!1!==n(r[t],t,r););return r}function xu(r,n){for(var t=-1,e=null==r?0:r.length;++t<e;)if(!n(r[t],t,r))return !1;return !0}function Eu(r,n){for(var t=-1,e=null==r?0:r.length,i=0,a=[];++t<e;){var o=r[t];n(o,t,r)&&(a[i++]=o);}return a}function Vu(r,n){return !!(null==r?0:r.length)&&-1<zu(r,n,0)}function ku(r,n,t){for(var e=-1,i=null==r?0:r.length;++e<i;)if(t(n,r[e]))return !0;return !1}function Iu(r,n){for(var t=-1,e=null==r?0:r.length,i=Array(e);++t<e;)i[t]=n(r[t],t,r);return i}function Bu(r,n){for(var t=-1,e=n.length,i=r.length;++t<e;)r[i+t]=n[t];return r}function Tu(r,n,t,e){var i=-1,a=null==r?0:r.length;for(e&&a&&(t=r[++i]);++i<a;)t=n(t,r[i],i,r);return t}function Su(r,n,t,e){var i=null==r?0:r.length;for(e&&i&&(t=r[--i]);i--;)t=n(t,r[i],i,r);return t}function Uu(r,n){for(var t=-1,e=null==r?0:r.length;++t<e;)if(n(r[t],t,r))return !0;return !1}var I=Ru("length");function Nu(r,e,n){var i;return n(r,function(r,n,t){if(e(r,n,t))return i=n,!1}),i}function Ou(r,n,t,e){for(var i=r.length,a=t+(e?1:-1);e?a--:++a<i;)if(n(r[a],a,r))return a;return -1}function zu(r,n,t){return n==n?function(r,n,t){var e=t-1,i=r.length;for(;++e<i;)if(r[e]===n)return e;return -1}(r,n,t):Ou(r,Cu,t)}function Mu(r,n,t,e){for(var i=t-1,a=r.length;++i<a;)if(e(r[i],n))return i;return -1}function Cu(r){return r!=r}function qu(r,n){var t=null==r?0:r.length;return t?Du(r,n)/t:Za}function Ru(n){return function(r){return null==r?Da:r[n]}}function B(n){return function(r){return null==n?Da:n[r]}}function Lu(r,e,i,a,n){return n(r,function(r,n,t){i=a?(a=!1,r):e(i,r,n,t);}),i}function Du(r,n){for(var t,e=-1,i=r.length;++e<i;){var a=n(r[e]);a!==Da&&(t=t===Da?a:t+a);}return t}function Fu(r,n){for(var t=-1,e=Array(r);++t<r;)e[t]=n(t);return e}function Pu(r){return r&&r.slice(0,as(r)+1).replace(Ro,"")}function Wu(n){return function(r){return n(r)}}function $u(n,r){return Iu(r,function(r){return n[r]})}function Yu(r,n){return r.has(n)}function Zu(r,n){for(var t=-1,e=r.length;++t<e&&-1<zu(n,r[t],0););return t}function Hu(r,n){for(var t=r.length;t--&&-1<zu(n,r[t],0););return t}var Gu=B({"À":"A","Á":"A","Â":"A","Ã":"A","Ä":"A","Å":"A","à":"a","á":"a","â":"a","ã":"a","ä":"a","å":"a","Ç":"C","ç":"c","Ð":"D","ð":"d","È":"E","É":"E","Ê":"E","Ë":"E","è":"e","é":"e","ê":"e","ë":"e","Ì":"I","Í":"I","Î":"I","Ï":"I","ì":"i","í":"i","î":"i","ï":"i","Ñ":"N","ñ":"n","Ò":"O","Ó":"O","Ô":"O","Õ":"O","Ö":"O","Ø":"O","ò":"o","ó":"o","ô":"o","õ":"o","ö":"o","ø":"o","Ù":"U","Ú":"U","Û":"U","Ü":"U","ù":"u","ú":"u","û":"u","ü":"u","Ý":"Y","ý":"y","ÿ":"y","Æ":"Ae","æ":"ae","Þ":"Th","þ":"th","ß":"ss","Ā":"A","Ă":"A","Ą":"A","ā":"a","ă":"a","ą":"a","Ć":"C","Ĉ":"C","Ċ":"C","Č":"C","ć":"c","ĉ":"c","ċ":"c","č":"c","Ď":"D","Đ":"D","ď":"d","đ":"d","Ē":"E","Ĕ":"E","Ė":"E","Ę":"E","Ě":"E","ē":"e","ĕ":"e","ė":"e","ę":"e","ě":"e","Ĝ":"G","Ğ":"G","Ġ":"G","Ģ":"G","ĝ":"g","ğ":"g","ġ":"g","ģ":"g","Ĥ":"H","Ħ":"H","ĥ":"h","ħ":"h","Ĩ":"I","Ī":"I","Ĭ":"I","Į":"I","İ":"I","ĩ":"i","ī":"i","ĭ":"i","į":"i","ı":"i","Ĵ":"J","ĵ":"j","Ķ":"K","ķ":"k","ĸ":"k","Ĺ":"L","Ļ":"L","Ľ":"L","Ŀ":"L","Ł":"L","ĺ":"l","ļ":"l","ľ":"l","ŀ":"l","ł":"l","Ń":"N","Ņ":"N","Ň":"N","Ŋ":"N","ń":"n","ņ":"n","ň":"n","ŋ":"n","Ō":"O","Ŏ":"O","Ő":"O","ō":"o","ŏ":"o","ő":"o","Ŕ":"R","Ŗ":"R","Ř":"R","ŕ":"r","ŗ":"r","ř":"r","Ś":"S","Ŝ":"S","Ş":"S","Š":"S","ś":"s","ŝ":"s","ş":"s","š":"s","Ţ":"T","Ť":"T","Ŧ":"T","ţ":"t","ť":"t","ŧ":"t","Ũ":"U","Ū":"U","Ŭ":"U","Ů":"U","Ű":"U","Ų":"U","ũ":"u","ū":"u","ŭ":"u","ů":"u","ű":"u","ų":"u","Ŵ":"W","ŵ":"w","Ŷ":"Y","ŷ":"y","Ÿ":"Y","Ź":"Z","Ż":"Z","Ž":"Z","ź":"z","ż":"z","ž":"z","Ĳ":"IJ","ĳ":"ij","Œ":"Oe","œ":"oe","ŉ":"'n","ſ":"s"}),Ju=B({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"});function Ku(r){return "\\"+E[r]}function Xu(r){return x.test(r)}function Qu(r){var t=-1,e=Array(r.size);return r.forEach(function(r,n){e[++t]=[n,r];}),e}function rs(n,t){return function(r){return n(t(r))}}function ns(r,n){for(var t=-1,e=r.length,i=0,a=[];++t<e;){var o=r[t];o!==n&&o!==Wa||(r[t]=Wa,a[i++]=t);}return a}function ts(r){var n=-1,t=Array(r.size);return r.forEach(function(r){t[++n]=r;}),t}function es(r){return (Xu(r)?function(r){var n=j.lastIndex=0;for(;j.test(r);)++n;return n}:I)(r)}function is(r){return Xu(r)?r.match(j)||[]:r.split("")}function as(r){for(var n=r.length;n--&&t.test(r.charAt(n)););return n}var os=B({"&amp;":"&","&lt;":"<","&gt;":">","&quot;":'"',"&#39;":"'"});var us=function r(n){var j=(n=null==n?hu:us.defaults(hu.Object(),n,us.pick(hu,ou))).Array,t=n.Date,c=n.Error,h=n.Function,i=n.Math,g=n.Object,_=n.RegExp,f=n.String,d=n.TypeError,a=j.prototype,e=h.prototype,p=g.prototype,o=n["__core-js_shared__"],u=e.toString,b=p.hasOwnProperty,s=0,l=(Ua=/[^.]+$/.exec(o&&o.keys&&o.keys.IE_PROTO||""))?"Symbol(src)_1."+Ua:"",y=p.toString,v=u.call(g),w=hu._,m=_("^"+u.call(b).replace(Co,"\\$&").replace(/hasOwnProperty|(function).*?(?=\\\()| for .+?(?=\\\])/g,"$1.*?")+"$"),A=_u?n.Buffer:Da,x=n.Symbol,E=n.Uint8Array,V=A?A.allocUnsafe:Da,k=rs(g.getPrototypeOf,g),I=g.create,B=p.propertyIsEnumerable,T=a.splice,S=x?x.isConcatSpreadable:Da,U=x?x.iterator:Da,N=x?x.toStringTag:Da,O=function(){try{var r=Ft(g,"defineProperty");return r({},"",{}),r}catch(r){}}(),z=n.clearTimeout!==hu.clearTimeout&&n.clearTimeout,M=t&&t.now!==hu.Date.now&&t.now,C=n.setTimeout!==hu.setTimeout&&n.setTimeout,q=i.ceil,R=i.floor,L=g.getOwnPropertySymbols,D=A?A.isBuffer:Da,F=n.isFinite,P=a.join,W=rs(g.keys,g),$=i.max,Y=i.min,Z=t.now,H=n.parseInt,G=i.random,J=a.reverse,K=Ft(n,"DataView"),X=Ft(n,"Map"),Q=Ft(n,"Promise"),rr=Ft(n,"Set"),nr=Ft(n,"WeakMap"),tr=Ft(g,"create"),er=nr&&new nr,ir={},ar=ye(K),or=ye(X),ur=ye(Q),sr=ye(rr),lr=ye(nr),fr=x?x.prototype:Da,cr=fr?fr.valueOf:Da,hr=fr?fr.toString:Da;function _r(r){if(Ni(r)&&!Ai(r)&&!(r instanceof dr)){if(r instanceof vr)return r;if(b.call(r,"__wrapped__"))return ve(r)}return new vr(r)}var pr=function(r){if(!Ui(r))return {};if(I)return I(r);gr.prototype=r;r=new gr;return gr.prototype=Da,r};function gr(){}function yr(){}function vr(r,n){this.__wrapped__=r,this.__actions__=[],this.__chain__=!!n,this.__index__=0,this.__values__=Da;}function dr(r){this.__wrapped__=r,this.__actions__=[],this.__dir__=1,this.__filtered__=!1,this.__iteratees__=[],this.__takeCount__=Ha,this.__views__=[];}function br(r){var n=-1,t=null==r?0:r.length;for(this.clear();++n<t;){var e=r[n];this.set(e[0],e[1]);}}function wr(r){var n=-1,t=null==r?0:r.length;for(this.clear();++n<t;){var e=r[n];this.set(e[0],e[1]);}}function mr(r){var n=-1,t=null==r?0:r.length;for(this.clear();++n<t;){var e=r[n];this.set(e[0],e[1]);}}function Ar(r){var n=-1,t=null==r?0:r.length;for(this.__data__=new mr;++n<t;)this.add(r[n]);}function jr(r){r=this.__data__=new wr(r);this.size=r.size;}function xr(r,n){var t,e=Ai(r),i=!e&&mi(r),a=!e&&!i&&Vi(r),o=!e&&!i&&!a&&Di(r),u=e||i||a||o,s=u?Fu(r.length,f):[],l=s.length;for(t in r)!n&&!b.call(r,t)||u&&("length"==t||a&&("offset"==t||"parent"==t)||o&&("buffer"==t||"byteLength"==t||"byteOffset"==t)||Gt(t,l))||s.push(t);return s}function Er(r){var n=r.length;return n?r[jn(0,n-1)]:Da}function Vr(r,n){return ce(it(r),zr(n,0,r.length))}function kr(r){return ce(it(r))}function Ir(r,n,t){(t===Da||di(r[n],t))&&(t!==Da||n in r)||Nr(r,n,t);}function Br(r,n,t){var e=r[n];b.call(r,n)&&di(e,t)&&(t!==Da||n in r)||Nr(r,n,t);}function Tr(r,n){for(var t=r.length;t--;)if(di(r[t][0],n))return t;return -1}function Sr(r,e,i,a){return Lr(r,function(r,n,t){e(a,r,i(r),t);}),a}function Ur(r,n){return r&&at(n,la(n),r)}function Nr(r,n,t){"__proto__"==n&&O?O(r,n,{configurable:!0,enumerable:!0,value:t,writable:!0}):r[n]=t;}function Or(r,n){for(var t=-1,e=n.length,i=j(e),a=null==r;++t<e;)i[t]=a?Da:ia(r,n[t]);return i}function zr(r,n,t){return r==r&&(t!==Da&&(r=r<=t?r:t),n!==Da&&(r=n<=r?r:n)),r}function Mr(t,e,i,r,n,a){var o,u=1&e,s=2&e,l=4&e;if((o=i?n?i(t,r,n,a):i(t):o)!==Da)return o;if(!Ui(t))return t;var f,c,h=Ai(t);if(h){if(o=function(r){var n=r.length,t=new r.constructor(n);n&&"string"==typeof r[0]&&b.call(r,"index")&&(t.index=r.index,t.input=r.input);return t}(t),!u)return it(t,o)}else {var _=$t(t),r=_==no||_==to;if(Vi(t))return Xn(t,u);if(_==ao||_==Ja||r&&!n){if(o=s||r?{}:Zt(t),!u)return s?(r=f=t,c=(c=o)&&at(r,fa(r),c),at(f,Wt(f),c)):(c=Ur(o,f=t),at(f,Pt(f),c))}else {if(!lu[_])return n?t:{};o=function(r,n,t){var e=r.constructor;switch(n){case ho:return Qn(r);case Xa:case Qa:return new e(+r);case _o:return function(r,n){n=n?Qn(r.buffer):r.buffer;return new r.constructor(n,r.byteOffset,r.byteLength)}(r,t);case po:case go:case yo:case vo:case bo:case wo:case mo:case Ao:case jo:return rt(r,t);case eo:return new e;case io:case lo:return new e(r);case uo:return function(r){var n=new r.constructor(r.source,Zo.exec(r));return n.lastIndex=r.lastIndex,n}(r);case so:return new e;case fo:return function(r){return cr?g(cr.call(r)):{}}(r)}}(t,_,u);}}u=(a=a||new jr).get(t);if(u)return u;a.set(t,o),qi(t)?t.forEach(function(r){o.add(Mr(r,e,i,r,t,a));}):Oi(t)&&t.forEach(function(r,n){o.set(n,Mr(r,e,i,n,t,a));});var p=h?Da:(l?s?zt:Ot:s?fa:la)(t);return Au(p||t,function(r,n){p&&(r=t[n=r]),Br(o,n,Mr(r,e,i,n,t,a));}),o}function Cr(r,n,t){var e=t.length;if(null==r)return !e;for(r=g(r);e--;){var i=t[e],a=n[i],o=r[i];if(o===Da&&!(i in r)||!a(o))return !1}return !0}function qr(r,n,t){if("function"!=typeof r)throw new d(Fa);return ue(function(){r.apply(Da,t);},n)}function Rr(r,n,t,e){var i=-1,a=Vu,o=!0,u=r.length,s=[],l=n.length;if(!u)return s;t&&(n=Iu(n,Wu(t))),e?(a=ku,o=!1):200<=n.length&&(a=Yu,o=!1,n=new Ar(n));r:for(;++i<u;){var f=r[i],c=null==t?f:t(f),f=e||0!==f?f:0;if(o&&c==c){for(var h=l;h--;)if(n[h]===c)continue r;s.push(f);}else a(n,c,e)||s.push(f);}return s}_r.templateSettings={escape:So,evaluate:Uo,interpolate:No,variable:"",imports:{_:_r}},(_r.prototype=yr.prototype).constructor=_r,(vr.prototype=pr(yr.prototype)).constructor=vr,(dr.prototype=pr(yr.prototype)).constructor=dr,br.prototype.clear=function(){this.__data__=tr?tr(null):{},this.size=0;},br.prototype.delete=function(r){return r=this.has(r)&&delete this.__data__[r],this.size-=r?1:0,r},br.prototype.get=function(r){var n=this.__data__;if(tr){var t=n[r];return t===Pa?Da:t}return b.call(n,r)?n[r]:Da},br.prototype.has=function(r){var n=this.__data__;return tr?n[r]!==Da:b.call(n,r)},br.prototype.set=function(r,n){var t=this.__data__;return this.size+=this.has(r)?0:1,t[r]=tr&&n===Da?Pa:n,this},wr.prototype.clear=function(){this.__data__=[],this.size=0;},wr.prototype.delete=function(r){var n=this.__data__;return !((r=Tr(n,r))<0)&&(r==n.length-1?n.pop():T.call(n,r,1),--this.size,!0)},wr.prototype.get=function(r){var n=this.__data__;return (r=Tr(n,r))<0?Da:n[r][1]},wr.prototype.has=function(r){return -1<Tr(this.__data__,r)},wr.prototype.set=function(r,n){var t=this.__data__,e=Tr(t,r);return e<0?(++this.size,t.push([r,n])):t[e][1]=n,this},mr.prototype.clear=function(){this.size=0,this.__data__={hash:new br,map:new(X||wr),string:new br};},mr.prototype.delete=function(r){return r=Lt(this,r).delete(r),this.size-=r?1:0,r},mr.prototype.get=function(r){return Lt(this,r).get(r)},mr.prototype.has=function(r){return Lt(this,r).has(r)},mr.prototype.set=function(r,n){var t=Lt(this,r),e=t.size;return t.set(r,n),this.size+=t.size==e?0:1,this},Ar.prototype.add=Ar.prototype.push=function(r){return this.__data__.set(r,Pa),this},Ar.prototype.has=function(r){return this.__data__.has(r)},jr.prototype.clear=function(){this.__data__=new wr,this.size=0;},jr.prototype.delete=function(r){var n=this.__data__,r=n.delete(r);return this.size=n.size,r},jr.prototype.get=function(r){return this.__data__.get(r)},jr.prototype.has=function(r){return this.__data__.has(r)},jr.prototype.set=function(r,n){var t=this.__data__;if(t instanceof wr){var e=t.__data__;if(!X||e.length<199)return e.push([r,n]),this.size=++t.size,this;t=this.__data__=new mr(e);}return t.set(r,n),this.size=t.size,this};var Lr=st(Hr),Dr=st(Gr,!0);function Fr(r,e){var i=!0;return Lr(r,function(r,n,t){return i=!!e(r,n,t)}),i}function Pr(r,n,t){for(var e=-1,i=r.length;++e<i;){var a,o,u=r[e],s=n(u);null!=s&&(a===Da?s==s&&!Li(s):t(s,a))&&(a=s,o=u);}return o}function Wr(r,e){var i=[];return Lr(r,function(r,n,t){e(r,n,t)&&i.push(r);}),i}function $r(r,n,t,e,i){var a=-1,o=r.length;for(t=t||Ht,i=i||[];++a<o;){var u=r[a];0<n&&t(u)?1<n?$r(u,n-1,t,e,i):Bu(i,u):e||(i[i.length]=u);}return i}var Yr=lt(),Zr=lt(!0);function Hr(r,n){return r&&Yr(r,n,la)}function Gr(r,n){return r&&Zr(r,n,la)}function Jr(n,r){return Eu(r,function(r){return Bi(n[r])})}function Kr(r,n){for(var t=0,e=(n=Hn(n,r)).length;null!=r&&t<e;)r=r[ge(n[t++])];return t&&t==e?r:Da}function Xr(r,n,t){n=n(r);return Ai(r)?n:Bu(n,t(r))}function Qr(r){return null==r?r===Da?"[object Undefined]":"[object Null]":N&&N in g(r)?function(r){var n=b.call(r,N),t=r[N];try{r[N]=Da;var e=!0;}catch(r){}var i=y.call(r);e&&(n?r[N]=t:delete r[N]);return i}(r):y.call(r)}function rn(r,n){return n<r}function nn(r,n){return null!=r&&b.call(r,n)}function tn(r,n){return null!=r&&n in g(r)}function en(r,n,t){for(var e=t?ku:Vu,i=r[0].length,a=r.length,o=a,u=j(a),s=1/0,l=[];o--;){var f=r[o];o&&n&&(f=Iu(f,Wu(n))),s=Y(f.length,s),u[o]=!t&&(n||120<=i&&120<=f.length)?new Ar(o&&f):Da;}var f=r[0],c=-1,h=u[0];r:for(;++c<i&&l.length<s;){var _=f[c],p=n?n(_):_,_=t||0!==_?_:0;if(!(h?Yu(h,p):e(l,p,t))){for(o=a;--o;){var g=u[o];if(!(g?Yu(g,p):e(r[o],p,t)))continue r}h&&h.push(p),l.push(_);}}return l}function an(r,n,t){n=null==(r=ie(r,n=Hn(n,r)))?r:r[ge(Ie(n))];return null==n?Da:wu(n,r,t)}function on(r){return Ni(r)&&Qr(r)==Ja}function un(r,n,t,e,i){return r===n||(null==r||null==n||!Ni(r)&&!Ni(n)?r!=r&&n!=n:function(r,n,t,e,i,a){var o=Ai(r),u=Ai(n),s=o?Ka:$t(r),l=u?Ka:$t(n),f=(s=s==Ja?ao:s)==ao,u=(l=l==Ja?ao:l)==ao,l=s==l;if(l&&Vi(r)){if(!Vi(n))return !1;f=!(o=!0);}if(l&&!f)return a=a||new jr,o||Di(r)?Ut(r,n,t,e,i,a):function(r,n,t,e,i,a,o){switch(t){case _o:if(r.byteLength!=n.byteLength||r.byteOffset!=n.byteOffset)return !1;r=r.buffer,n=n.buffer;case ho:return r.byteLength==n.byteLength&&a(new E(r),new E(n))?!0:!1;case Xa:case Qa:case io:return di(+r,+n);case ro:return r.name==n.name&&r.message==n.message;case uo:case lo:return r==n+"";case eo:var u=Qu;case so:var s=1&e;if(u=u||ts,r.size!=n.size&&!s)return !1;s=o.get(r);if(s)return s==n;e|=2,o.set(r,n);u=Ut(u(r),u(n),e,i,a,o);return o.delete(r),u;case fo:if(cr)return cr.call(r)==cr.call(n)}return !1}(r,n,s,t,e,i,a);if(!(1&t)){f=f&&b.call(r,"__wrapped__"),u=u&&b.call(n,"__wrapped__");if(f||u){f=f?r.value():r,u=u?n.value():n;return a=a||new jr,i(f,u,t,e,a)}}return l&&(a=a||new jr,function(r,n,t,e,i,a){var o=1&t,u=Ot(r),s=u.length,l=Ot(n).length;if(s!=l&&!o)return !1;var f=s;for(;f--;){var c=u[f];if(!(o?c in n:b.call(n,c)))return !1}var h=a.get(r),l=a.get(n);if(h&&l)return h==n&&l==r;var _=!0;a.set(r,n),a.set(n,r);var p=o;for(;++f<s;){c=u[f];var g,y=r[c],v=n[c];if(!((g=e?o?e(v,y,c,n,r,a):e(y,v,c,r,n,a):g)===Da?y===v||i(y,v,t,e,a):g)){_=!1;break}p=p||"constructor"==c;}_&&!p&&(h=r.constructor,l=n.constructor,h!=l&&"constructor"in r&&"constructor"in n&&!("function"==typeof h&&h instanceof h&&"function"==typeof l&&l instanceof l)&&(_=!1));return a.delete(r),a.delete(n),_}(r,n,t,e,i,a))}(r,n,t,e,un,i))}function sn(r,n,t,e){var i=t.length,a=i,o=!e;if(null==r)return !a;for(r=g(r);i--;){var u=t[i];if(o&&u[2]?u[1]!==r[u[0]]:!(u[0]in r))return !1}for(;++i<a;){var s=(u=t[i])[0],l=r[s],f=u[1];if(o&&u[2]){if(l===Da&&!(s in r))return !1}else {var c,h=new jr;if(!((c=e?e(l,f,s,r,n,h):c)===Da?un(f,l,3,e,h):c))return !1}}return !0}function ln(r){return !(!Ui(r)||(n=r,l&&l in n))&&(Bi(r)?m:Jo).test(ye(r));var n;}function fn(r){return "function"==typeof r?r:null==r?Na:"object"==typeof r?Ai(r)?yn(r[0],r[1]):gn(r):Ca(r)}function cn(r){if(!re(r))return W(r);var n,t=[];for(n in g(r))b.call(r,n)&&"constructor"!=n&&t.push(n);return t}function hn(r){if(!Ui(r))return function(r){var n=[];if(null!=r)for(var t in g(r))n.push(t);return n}(r);var n,t=re(r),e=[];for(n in r)("constructor"!=n||!t&&b.call(r,n))&&e.push(n);return e}function _n(r,n){return r<n}function pn(r,e){var i=-1,a=xi(r)?j(r.length):[];return Lr(r,function(r,n,t){a[++i]=e(r,n,t);}),a}function gn(n){var t=Dt(n);return 1==t.length&&t[0][2]?te(t[0][0],t[0][1]):function(r){return r===n||sn(r,n,t)}}function yn(t,e){return Kt(t)&&ne(e)?te(ge(t),e):function(r){var n=ia(r,t);return n===Da&&n===e?aa(r,t):un(e,n,3)}}function vn(g,y,v,d,b){g!==y&&Yr(y,function(r,n){var t,e,i,a,o,u,s,l,f,c,h,_,p;b=b||new jr,Ui(r)?(e=y,a=v,o=vn,u=d,s=b,h=ae(t=g,i=n),_=ae(e,i),(p=s.get(_))?Ir(t,i,p):(l=u?u(h,_,i+"",t,e,s):Da,(f=l===Da)&&(c=Ai(_),p=!c&&Vi(_),e=!c&&!p&&Di(_),l=_,c||p||e?l=Ai(h)?h:Ei(h)?it(h):p?Xn(_,!(f=!1)):e?rt(_,!(f=!1)):[]:Mi(_)||mi(_)?mi(l=h)?l=Gi(h):Ui(h)&&!Bi(h)||(l=Zt(_)):f=!1),f&&(s.set(_,l),o(l,_,a,u,s),s.delete(_)),Ir(t,i,l))):(l=d?d(ae(g,n),r,n+"",g,y,b):Da,Ir(g,n,l=l===Da?r:l));},fa);}function dn(r,n){var t=r.length;if(t)return Gt(n+=n<0?t:0,t)?r[n]:Da}function bn(r,e,t){e=e.length?Iu(e,function(n){return Ai(n)?function(r){return Kr(r,1===n.length?n[0]:n)}:n}):[Na];var i=-1;return e=Iu(e,Wu(Rt())),function(r,n){var t=r.length;for(r.sort(n);t--;)r[t]=r[t].value;return r}(pn(r,function(n,r,t){return {criteria:Iu(e,function(r){return r(n)}),index:++i,value:n}}),function(r,n){return function(r,n,t){var e=-1,i=r.criteria,a=n.criteria,o=i.length,u=t.length;for(;++e<o;){var s=nt(i[e],a[e]);if(s){if(u<=e)return s;var l=t[e];return s*("desc"==l?-1:1)}}return r.index-n.index}(r,n,t)})}function wn(r,n,t){for(var e=-1,i=n.length,a={};++e<i;){var o=n[e],u=Kr(r,o);t(u,o)&&In(a,Hn(o,r),u);}return a}function mn(r,n,t,e){var i=e?Mu:zu,a=-1,o=n.length,u=r;for(r===n&&(n=it(n)),t&&(u=Iu(r,Wu(t)));++a<o;)for(var s=0,l=n[a],f=t?t(l):l;-1<(s=i(u,f,s,e));)u!==r&&T.call(u,s,1),T.call(r,s,1);return r}function An(r,n){for(var t=r?n.length:0,e=t-1;t--;){var i,a=n[t];t!=e&&a===i||(Gt(i=a)?T.call(r,a,1):Ln(r,a));}return r}function jn(r,n){return r+R(G()*(n-r+1))}function xn(r,n){var t="";if(!r||n<1||Ya<n)return t;for(;n%2&&(t+=r),(n=R(n/2))&&(r+=r),n;);return t}function En(r,n){return se(ee(r,n,Na),r+"")}function Vn(r){return Er(da(r))}function kn(r,n){r=da(r);return ce(r,zr(n,0,r.length))}function In(r,n,t,e){if(!Ui(r))return r;for(var i=-1,a=(n=Hn(n,r)).length,o=a-1,u=r;null!=u&&++i<a;){var s,l=ge(n[i]),f=t;if("__proto__"===l||"constructor"===l||"prototype"===l)return r;i!=o&&(s=u[l],(f=e?e(s,l,u):Da)===Da&&(f=Ui(s)?s:Gt(n[i+1])?[]:{})),Br(u,l,f),u=u[l];}return r}var Bn=er?function(r,n){return er.set(r,n),r}:Na,Tn=O?function(r,n){return O(r,"toString",{configurable:!0,enumerable:!1,value:Sa(n),writable:!0})}:Na;function Sn(r){return ce(da(r))}function Un(r,n,t){var e=-1,i=r.length;(t=i<t?i:t)<0&&(t+=i),i=t<(n=n<0?i<-n?0:i+n:n)?0:t-n>>>0,n>>>=0;for(var a=j(i);++e<i;)a[e]=r[e+n];return a}function Nn(r,e){var i;return Lr(r,function(r,n,t){return !(i=e(r,n,t))}),!!i}function On(r,n,t){var e=0,i=null==r?e:r.length;if("number"==typeof n&&n==n&&i<=2147483647){for(;e<i;){var a=e+i>>>1,o=r[a];null!==o&&!Li(o)&&(t?o<=n:o<n)?e=1+a:i=a;}return i}return zn(r,n,Na,t)}function zn(r,n,t,e){var i=0,a=null==r?0:r.length;if(0===a)return 0;for(var o=(n=t(n))!=n,u=null===n,s=Li(n),l=n===Da;i<a;){var f=R((i+a)/2),c=t(r[f]),h=c!==Da,_=null===c,p=c==c,g=Li(c),c=o?e||p:l?p&&(e||h):u?p&&h&&(e||!_):s?p&&h&&!_&&(e||!g):!_&&!g&&(e?c<=n:c<n);c?i=f+1:a=f;}return Y(a,4294967294)}function Mn(r,n){for(var t=-1,e=r.length,i=0,a=[];++t<e;){var o,u=r[t],s=n?n(u):u;t&&di(s,o)||(o=s,a[i++]=0===u?0:u);}return a}function Cn(r){return "number"==typeof r?r:Li(r)?Za:+r}function qn(r){if("string"==typeof r)return r;if(Ai(r))return Iu(r,qn)+"";if(Li(r))return hr?hr.call(r):"";var n=r+"";return "0"==n&&1/r==-1/0?"-0":n}function Rn(r,n,t){var e=-1,i=Vu,a=r.length,o=!0,u=[],s=u;if(t)o=!1,i=ku;else if(200<=a){var l=n?null:Vt(r);if(l)return ts(l);o=!1,i=Yu,s=new Ar;}else s=n?[]:u;r:for(;++e<a;){var f=r[e],c=n?n(f):f,f=t||0!==f?f:0;if(o&&c==c){for(var h=s.length;h--;)if(s[h]===c)continue r;n&&s.push(c),u.push(f);}else i(s,c,t)||(s!==u&&s.push(c),u.push(f));}return u}function Ln(r,n){return null==(r=ie(r,n=Hn(n,r)))||delete r[ge(Ie(n))]}function Dn(r,n,t,e){return In(r,n,t(Kr(r,n)),e)}function Fn(r,n,t,e){for(var i=r.length,a=e?i:-1;(e?a--:++a<i)&&n(r[a],a,r););return t?Un(r,e?0:a,e?a+1:i):Un(r,e?a+1:0,e?i:a)}function Pn(r,n){var t=r;return Tu(n,function(r,n){return n.func.apply(n.thisArg,Bu([r],n.args))},t=r instanceof dr?r.value():t)}function Wn(r,n,t){var e=r.length;if(e<2)return e?Rn(r[0]):[];for(var i=-1,a=j(e);++i<e;)for(var o=r[i],u=-1;++u<e;)u!=i&&(a[i]=Rr(a[i]||o,r[u],n,t));return Rn($r(a,1),n,t)}function $n(r,n,t){for(var e=-1,i=r.length,a=n.length,o={};++e<i;){var u=e<a?n[e]:Da;t(o,r[e],u);}return o}function Yn(r){return Ei(r)?r:[]}function Zn(r){return "function"==typeof r?r:Na}function Hn(r,n){return Ai(r)?r:Kt(r,n)?[r]:pe(Ji(r))}var Gn=En;function Jn(r,n,t){var e=r.length;return t=t===Da?e:t,!n&&e<=t?r:Un(r,n,t)}var Kn=z||function(r){return hu.clearTimeout(r)};function Xn(r,n){if(n)return r.slice();n=r.length,n=V?V(n):new r.constructor(n);return r.copy(n),n}function Qn(r){var n=new r.constructor(r.byteLength);return new E(n).set(new E(r)),n}function rt(r,n){n=n?Qn(r.buffer):r.buffer;return new r.constructor(n,r.byteOffset,r.length)}function nt(r,n){if(r!==n){var t=r!==Da,e=null===r,i=r==r,a=Li(r),o=n!==Da,u=null===n,s=n==n,l=Li(n);if(!u&&!l&&!a&&n<r||a&&o&&s&&!u&&!l||e&&o&&s||!t&&s||!i)return 1;if(!e&&!a&&!l&&r<n||l&&t&&i&&!e&&!a||u&&t&&i||!o&&i||!s)return -1}return 0}function tt(r,n,t,e){for(var i=-1,a=r.length,o=t.length,u=-1,s=n.length,l=$(a-o,0),f=j(s+l),c=!e;++u<s;)f[u]=n[u];for(;++i<o;)(c||i<a)&&(f[t[i]]=r[i]);for(;l--;)f[u++]=r[i++];return f}function et(r,n,t,e){for(var i=-1,a=r.length,o=-1,u=t.length,s=-1,l=n.length,f=$(a-u,0),c=j(f+l),h=!e;++i<f;)c[i]=r[i];for(var _=i;++s<l;)c[_+s]=n[s];for(;++o<u;)(h||i<a)&&(c[_+t[o]]=r[i++]);return c}function it(r,n){var t=-1,e=r.length;for(n=n||j(e);++t<e;)n[t]=r[t];return n}function at(r,n,t,e){var i=!t;t=t||{};for(var a=-1,o=n.length;++a<o;){var u=n[a],s=e?e(t[u],r[u],u,t,r):Da;(i?Nr:Br)(t,u,s=s===Da?r[u]:s);}return t}function ot(i,a){return function(r,n){var t=Ai(r)?mu:Sr,e=a?a():{};return t(r,i,Rt(n,2),e)}}function ut(u){return En(function(r,n){var t=-1,e=n.length,i=1<e?n[e-1]:Da,a=2<e?n[2]:Da,i=3<u.length&&"function"==typeof i?(e--,i):Da;for(a&&Jt(n[0],n[1],a)&&(i=e<3?Da:i,e=1),r=g(r);++t<e;){var o=n[t];o&&u(r,o,t,i);}return r})}function st(a,o){return function(r,n){if(null==r)return r;if(!xi(r))return a(r,n);for(var t=r.length,e=o?t:-1,i=g(r);(o?e--:++e<t)&&!1!==n(i[e],e,i););return r}}function lt(s){return function(r,n,t){for(var e=-1,i=g(r),a=t(r),o=a.length;o--;){var u=a[s?o:++e];if(!1===n(i[u],u,i))break}return r}}function ft(e){return function(r){var n=Xu(r=Ji(r))?is(r):Da,t=n?n[0]:r.charAt(0),r=n?Jn(n,1).join(""):r.slice(1);return t[e]()+r}}function ct(n){return function(r){return Tu(Ba(ma(r).replace(tu,"")),n,"")}}function ht(e){return function(){var r=arguments;switch(r.length){case 0:return new e;case 1:return new e(r[0]);case 2:return new e(r[0],r[1]);case 3:return new e(r[0],r[1],r[2]);case 4:return new e(r[0],r[1],r[2],r[3]);case 5:return new e(r[0],r[1],r[2],r[3],r[4]);case 6:return new e(r[0],r[1],r[2],r[3],r[4],r[5]);case 7:return new e(r[0],r[1],r[2],r[3],r[4],r[5],r[6])}var n=pr(e.prototype),t=e.apply(n,r);return Ui(t)?t:n}}function _t(a,o,u){var s=ht(a);return function r(){for(var n=arguments.length,t=j(n),e=n,i=qt(r);e--;)t[e]=arguments[e];i=n<3&&t[0]!==i&&t[n-1]!==i?[]:ns(t,i);return (n-=i.length)<u?xt(a,o,yt,r.placeholder,Da,t,i,Da,Da,u-n):wu(this&&this!==hu&&this instanceof r?s:a,this,t)}}function pt(a){return function(r,n,t){var e,i=g(r);xi(r)||(e=Rt(n,3),r=la(r),n=function(r){return e(i[r],r,i)});t=a(r,n,t);return -1<t?i[e?r[t]:t]:Da}}function gt(s){return Nt(function(i){var a=i.length,r=a,n=vr.prototype.thru;for(s&&i.reverse();r--;){var t=i[r];if("function"!=typeof t)throw new d(Fa);n&&!u&&"wrapper"==Ct(t)&&(u=new vr([],!0));}for(r=u?r:a;++r<a;)var e=Ct(t=i[r]),o="wrapper"==e?Mt(t):Da,u=o&&Xt(o[0])&&424==o[1]&&!o[4].length&&1==o[9]?u[Ct(o[0])].apply(u,o[3]):1==t.length&&Xt(t)?u[e]():u.thru(t);return function(){var r=arguments,n=r[0];if(u&&1==r.length&&Ai(n))return u.plant(n).value();for(var t=0,e=a?i[t].apply(this,r):n;++t<a;)e=i[t].call(this,e);return e}})}function yt(u,s,l,f,c,h,_,p,g,y){var v=s&$a,d=1&s,b=2&s,w=24&s,m=512&s,A=b?Da:ht(u);return function r(){for(var n,t=j(o=arguments.length),e=o;e--;)t[e]=arguments[e];if(w&&(n=function(r,n){for(var t=r.length,e=0;t--;)r[t]===n&&++e;return e}(t,a=qt(r))),f&&(t=tt(t,f,c,w)),h&&(t=et(t,h,_,w)),o-=n,w&&o<y){var i=ns(t,a);return xt(u,s,yt,r.placeholder,l,t,i,p,g,y-o)}var a=d?l:this,i=b?a[u]:u,o=t.length;return p?t=function(r,n){for(var t=r.length,e=Y(n.length,t),i=it(r);e--;){var a=n[e];r[e]=Gt(a,t)?i[a]:Da;}return r}(t,p):m&&1<o&&t.reverse(),v&&g<o&&(t.length=g),(i=this&&this!==hu&&this instanceof r?A||ht(i):i).apply(a,t)}}function vt(t,o){return function(r,n){return r=r,e=t,i=o(n),a={},Hr(r,function(r,n,t){e(a,i(r),n,t);}),a;var e,i,a;}}function dt(e,i){return function(r,n){var t;if(r===Da&&n===Da)return i;if(r!==Da&&(t=r),n!==Da){if(t===Da)return n;n="string"==typeof r||"string"==typeof n?(r=qn(r),qn(n)):(r=Cn(r),Cn(n)),t=e(r,n);}return t}}function bt(e){return Nt(function(r){return r=Iu(r,Wu(Rt())),En(function(n){var t=this;return e(r,function(r){return wu(r,t,n)})})})}function wt(r,n){var t=(n=n===Da?" ":qn(n)).length;if(t<2)return t?xn(n,r):n;t=xn(n,q(r/es(n)));return Xu(n)?Jn(is(t),0,r).join(""):t.slice(0,r)}function mt(u,r,s,l){var f=1&r,c=ht(u);return function r(){for(var n=-1,t=arguments.length,e=-1,i=l.length,a=j(i+t),o=this&&this!==hu&&this instanceof r?c:u;++e<i;)a[e]=l[e];for(;t--;)a[e++]=arguments[++n];return wu(o,f?s:this,a)}}function At(e){return function(r,n,t){return t&&"number"!=typeof t&&Jt(r,n,t)&&(n=t=Da),r=$i(r),n===Da?(n=r,r=0):n=$i(n),function(r,n,t,e){for(var i=-1,a=$(q((n-r)/(t||1)),0),o=j(a);a--;)o[e?a:++i]=r,r+=t;return o}(r,n,t=t===Da?r<n?1:-1:$i(t),e)}}function jt(t){return function(r,n){return "string"==typeof r&&"string"==typeof n||(r=Hi(r),n=Hi(n)),t(r,n)}}function xt(r,n,t,e,i,a,o,u,s,l){var f=8&n;n|=f?32:64,4&(n&=~(f?64:32))||(n&=-4);l=[r,n,i,f?a:Da,f?o:Da,f?Da:a,f?Da:o,u,s,l],t=t.apply(Da,l);return Xt(r)&&oe(t,l),t.placeholder=e,le(t,r,n)}function Et(r){var e=i[r];return function(r,n){if(r=Hi(r),(n=null==n?0:Y(Yi(n),292))&&F(r)){var t=(Ji(r)+"e").split("e");return +((t=(Ji(e(t[0]+"e"+(+t[1]+n)))+"e").split("e"))[0]+"e"+(+t[1]-n))}return e(r)}}var Vt=rr&&1/ts(new rr([,-0]))[1]==1/0?function(r){return new rr(r)}:Ma;function kt(a){return function(r){var n,t,e,i=$t(r);return i==eo?Qu(r):i==so?(i=r,n=-1,t=Array(i.size),i.forEach(function(r){t[++n]=[r,r];}),t):Iu(a(e=r),function(r){return [r,e[r]]})}}function It(r,n,t,e,i,a,o,u){var s=2&n;if(!s&&"function"!=typeof r)throw new d(Fa);var l,f,c=e?e.length:0;c||(n&=-97,e=i=Da),o=o===Da?o:$(Yi(o),0),u=u===Da?u:Yi(u),c-=i?i.length:0,64&n&&(l=e,f=i,e=i=Da);var h,_,p,g,y=s?Da:Mt(r),o=[r,n,t,e,i,l,f,a,o,u];y&&function(r,n){var t=r[1],e=n[1],i=t|e,a=i<131,o=e==$a&&8==t||e==$a&&256==t&&r[7].length<=n[8]||384==e&&n[7].length<=n[8]&&8==t;if(!a&&!o)return;1&e&&(r[2]=n[2],i|=1&t?0:4);t=n[3];{var u;t&&(u=r[3],r[3]=u?tt(u,t,n[4]):t,r[4]=u?ns(r[3],Wa):n[4]);}(t=n[5])&&(u=r[5],r[5]=u?et(u,t,n[6]):t,r[6]=u?ns(r[5],Wa):n[6]);(t=n[7])&&(r[7]=t);e&$a&&(r[8]=null==r[8]?n[8]:Y(r[8],n[8]));null==r[9]&&(r[9]=n[9]);r[0]=n[0],r[1]=i;}(o,y),r=o[0],n=o[1],t=o[2],e=o[3],i=o[4],!(u=o[9]=o[9]===Da?s?0:r.length:$(o[9]-c,0))&&24&n&&(n&=-25);t=n&&1!=n?8==n||16==n?_t(r,n,u):32!=n&&33!=n||i.length?yt.apply(Da,o):mt(r,n,t,e):(_=t,p=1&n,g=ht(h=r),function r(){return (this&&this!==hu&&this instanceof r?g:h).apply(p?_:this,arguments)});return le((y?Bn:oe)(t,o),r,n)}function Bt(r,n,t,e){return r===Da||di(r,p[t])&&!b.call(e,t)?n:r}function Tt(r,n,t,e,i,a){return Ui(r)&&Ui(n)&&(a.set(n,r),vn(r,n,Da,Tt,a),a.delete(n)),r}function St(r){return Mi(r)?Da:r}function Ut(r,n,t,e,i,a){var o=1&t,u=r.length,s=n.length;if(u!=s&&!(o&&u<s))return !1;var l=a.get(r),s=a.get(n);if(l&&s)return l==n&&s==r;var f=-1,c=!0,h=2&t?new Ar:Da;for(a.set(r,n),a.set(n,r);++f<u;){var _,p=r[f],g=n[f];if((_=e?o?e(g,p,f,n,r,a):e(p,g,f,r,n,a):_)!==Da){if(_)continue;c=!1;break}if(h){if(!Uu(n,function(r,n){return !Yu(h,n)&&(p===r||i(p,r,t,e,a))&&h.push(n)})){c=!1;break}}else if(p!==g&&!i(p,g,t,e,a)){c=!1;break}}return a.delete(r),a.delete(n),c}function Nt(r){return se(ee(r,Da,je),r+"")}function Ot(r){return Xr(r,la,Pt)}function zt(r){return Xr(r,fa,Wt)}var Mt=er?function(r){return er.get(r)}:Ma;function Ct(r){for(var n=r.name+"",t=ir[n],e=b.call(ir,n)?t.length:0;e--;){var i=t[e],a=i.func;if(null==a||a==r)return i.name}return n}function qt(r){return (b.call(_r,"placeholder")?_r:r).placeholder}function Rt(){var r=(r=_r.iteratee||Oa)===Oa?fn:r;return arguments.length?r(arguments[0],arguments[1]):r}function Lt(r,n){var t,e=r.__data__;return ("string"==(r=typeof(t=n))||"number"==r||"symbol"==r||"boolean"==r?"__proto__"!==t:null===t)?e["string"==typeof n?"string":"hash"]:e.map}function Dt(r){for(var n=la(r),t=n.length;t--;){var e=n[t],i=r[e];n[t]=[e,i,ne(i)];}return n}function Ft(r,n){n=n,n=null==(r=r)?Da:r[n];return ln(n)?n:Da}var Pt=L?function(n){return null==n?[]:(n=g(n),Eu(L(n),function(r){return B.call(n,r)}))}:qa,Wt=L?function(r){for(var n=[];r;)Bu(n,Pt(r)),r=k(r);return n}:qa,$t=Qr;function Yt(r,n,t){for(var e=-1,i=(n=Hn(n,r)).length,a=!1;++e<i;){var o=ge(n[e]);if(!(a=null!=r&&t(r,o)))break;r=r[o];}return a||++e!=i?a:!!(i=null==r?0:r.length)&&Si(i)&&Gt(o,i)&&(Ai(r)||mi(r))}function Zt(r){return "function"!=typeof r.constructor||re(r)?{}:pr(k(r))}function Ht(r){return Ai(r)||mi(r)||!!(S&&r&&r[S])}function Gt(r,n){var t=typeof r;return !!(n=null==n?Ya:n)&&("number"==t||"symbol"!=t&&Xo.test(r))&&-1<r&&r%1==0&&r<n}function Jt(r,n,t){if(Ui(t)){var e=typeof n;return ("number"==e?xi(t)&&Gt(n,t.length):"string"==e&&n in t)&&di(t[n],r)}}function Kt(r,n){if(!Ai(r)){var t=typeof r;return "number"==t||"symbol"==t||"boolean"==t||null==r||Li(r)||(zo.test(r)||!Oo.test(r)||null!=n&&r in g(n))}}function Xt(r){var n=Ct(r),t=_r[n];if("function"==typeof t&&n in dr.prototype){if(r===t)return 1;t=Mt(t);return t&&r===t[0]}}(K&&$t(new K(new ArrayBuffer(1)))!=_o||X&&$t(new X)!=eo||Q&&$t(Q.resolve())!=oo||rr&&$t(new rr)!=so||nr&&$t(new nr)!=co)&&($t=function(r){var n=Qr(r),r=n==ao?r.constructor:Da,r=r?ye(r):"";if(r)switch(r){case ar:return _o;case or:return eo;case ur:return oo;case sr:return so;case lr:return co}return n});var Qt=o?Bi:Ra;function re(r){var n=r&&r.constructor;return r===("function"==typeof n&&n.prototype||p)}function ne(r){return r==r&&!Ui(r)}function te(n,t){return function(r){return null!=r&&(r[n]===t&&(t!==Da||n in g(r)))}}function ee(a,o,u){return o=$(o===Da?a.length-1:o,0),function(){for(var r=arguments,n=-1,t=$(r.length-o,0),e=j(t);++n<t;)e[n]=r[o+n];for(var n=-1,i=j(o+1);++n<o;)i[n]=r[n];return i[o]=u(e),wu(a,this,i)}}function ie(r,n){return n.length<2?r:Kr(r,Un(n,0,-1))}function ae(r,n){if(("constructor"!==n||"function"!=typeof r[n])&&"__proto__"!=n)return r[n]}var oe=fe(Bn),ue=C||function(r,n){return hu.setTimeout(r,n)},se=fe(Tn);function le(r,n,t){var e,i,n=n+"";return se(r,function(r,n){var t=n.length;if(!t)return r;var e=t-1;return n[e]=(1<t?"& ":"")+n[e],n=n.join(2<t?", ":" "),r.replace(Lo,"{\n/* [wrapped with "+n+"] */\n")}(n,(e=(n=(n=n).match(Do))?n[1].split(Fo):[],i=t,Au(Ga,function(r){var n="_."+r[0];i&r[1]&&!Vu(e,n)&&e.push(n);}),e.sort())))}function fe(t){var e=0,i=0;return function(){var r=Z(),n=16-(r-i);if(i=r,0<n){if(800<=++e)return arguments[0]}else e=0;return t.apply(Da,arguments)}}function ce(r,n){var t=-1,e=r.length,i=e-1;for(n=n===Da?e:n;++t<n;){var a=jn(t,i),o=r[a];r[a]=r[t],r[t]=o;}return r.length=n,r}var he,_e,pe=(_e=(he=hi(he=function(r){var i=[];return 46===r.charCodeAt(0)&&i.push(""),r.replace(Mo,function(r,n,t,e){i.push(t?e.replace($o,"$1"):n||r);}),i},function(r){return 500===_e.size&&_e.clear(),r})).cache,he);function ge(r){if("string"==typeof r||Li(r))return r;var n=r+"";return "0"==n&&1/r==-1/0?"-0":n}function ye(r){if(null!=r){try{return u.call(r)}catch(r){}try{return r+""}catch(r){}}return ""}function ve(r){if(r instanceof dr)return r.clone();var n=new vr(r.__wrapped__,r.__chain__);return n.__actions__=it(r.__actions__),n.__index__=r.__index__,n.__values__=r.__values__,n}var de=En(function(r,n){return Ei(r)?Rr(r,$r(n,1,Ei,!0)):[]}),be=En(function(r,n){var t=Ie(n);return Ei(t)&&(t=Da),Ei(r)?Rr(r,$r(n,1,Ei,!0),Rt(t,2)):[]}),we=En(function(r,n){var t=Ie(n);return Ei(t)&&(t=Da),Ei(r)?Rr(r,$r(n,1,Ei,!0),Da,t):[]});function me(r,n,t){var e=null==r?0:r.length;if(!e)return -1;t=null==t?0:Yi(t);return t<0&&(t=$(e+t,0)),Ou(r,Rt(n,3),t)}function Ae(r,n,t){var e=null==r?0:r.length;if(!e)return -1;var i=e-1;return t!==Da&&(i=Yi(t),i=t<0?$(e+i,0):Y(i,e-1)),Ou(r,Rt(n,3),i,!0)}function je(r){return (null==r?0:r.length)?$r(r,1):[]}function xe(r){return r&&r.length?r[0]:Da}var Ee=En(function(r){var n=Iu(r,Yn);return n.length&&n[0]===r[0]?en(n):[]}),Ve=En(function(r){var n=Ie(r),t=Iu(r,Yn);return n===Ie(t)?n=Da:t.pop(),t.length&&t[0]===r[0]?en(t,Rt(n,2)):[]}),ke=En(function(r){var n=Ie(r),t=Iu(r,Yn);return (n="function"==typeof n?n:Da)&&t.pop(),t.length&&t[0]===r[0]?en(t,Da,n):[]});function Ie(r){var n=null==r?0:r.length;return n?r[n-1]:Da}var Be=En(Te);function Te(r,n){return r&&r.length&&n&&n.length?mn(r,n):r}var Se=Nt(function(r,n){var t=null==r?0:r.length,e=Or(r,n);return An(r,Iu(n,function(r){return Gt(r,t)?+r:r}).sort(nt)),e});function Ue(r){return null==r?r:J.call(r)}var Ne=En(function(r){return Rn($r(r,1,Ei,!0))}),Oe=En(function(r){var n=Ie(r);return Ei(n)&&(n=Da),Rn($r(r,1,Ei,!0),Rt(n,2))}),ze=En(function(r){var n="function"==typeof(n=Ie(r))?n:Da;return Rn($r(r,1,Ei,!0),Da,n)});function Me(n){if(!n||!n.length)return [];var t=0;return n=Eu(n,function(r){return Ei(r)&&(t=$(r.length,t),1)}),Fu(t,function(r){return Iu(n,Ru(r))})}function Ce(r,n){if(!r||!r.length)return [];r=Me(r);return null==n?r:Iu(r,function(r){return wu(n,Da,r)})}var qe=En(function(r,n){return Ei(r)?Rr(r,n):[]}),Re=En(function(r){return Wn(Eu(r,Ei))}),Le=En(function(r){var n=Ie(r);return Ei(n)&&(n=Da),Wn(Eu(r,Ei),Rt(n,2))}),De=En(function(r){var n="function"==typeof(n=Ie(r))?n:Da;return Wn(Eu(r,Ei),Da,n)}),Fe=En(Me);var Pe=En(function(r){var n=r.length,n="function"==typeof(n=1<n?r[n-1]:Da)?(r.pop(),n):Da;return Ce(r,n)});function We(r){r=_r(r);return r.__chain__=!0,r}function $e(r,n){return n(r)}var Ye=Nt(function(n){function r(r){return Or(r,n)}var t=n.length,e=t?n[0]:0,i=this.__wrapped__;return !(1<t||this.__actions__.length)&&i instanceof dr&&Gt(e)?((i=i.slice(e,+e+(t?1:0))).__actions__.push({func:$e,args:[r],thisArg:Da}),new vr(i,this.__chain__).thru(function(r){return t&&!r.length&&r.push(Da),r})):this.thru(r)});var Ze=ot(function(r,n,t){b.call(r,t)?++r[t]:Nr(r,t,1);});var He=pt(me),Ge=pt(Ae);function Je(r,n){return (Ai(r)?Au:Lr)(r,Rt(n,3))}function Ke(r,n){return (Ai(r)?ju:Dr)(r,Rt(n,3))}var Xe=ot(function(r,n,t){b.call(r,t)?r[t].push(n):Nr(r,t,[n]);});var Qe=En(function(r,n,t){var e=-1,i="function"==typeof n,a=xi(r)?j(r.length):[];return Lr(r,function(r){a[++e]=i?wu(n,r,t):an(r,n,t);}),a}),ri=ot(function(r,n,t){Nr(r,t,n);});function ni(r,n){return (Ai(r)?Iu:pn)(r,Rt(n,3))}var ti=ot(function(r,n,t){r[t?0:1].push(n);},function(){return [[],[]]});var ei=En(function(r,n){if(null==r)return [];var t=n.length;return 1<t&&Jt(r,n[0],n[1])?n=[]:2<t&&Jt(n[0],n[1],n[2])&&(n=[n[0]]),bn(r,$r(n,1),[])}),ii=M||function(){return hu.Date.now()};function ai(r,n,t){return n=t?Da:n,n=r&&null==n?r.length:n,It(r,$a,Da,Da,Da,Da,n)}function oi(r,n){var t;if("function"!=typeof n)throw new d(Fa);return r=Yi(r),function(){return 0<--r&&(t=n.apply(this,arguments)),r<=1&&(n=Da),t}}var ui=En(function(r,n,t){var e,i=1;return t.length&&(e=ns(t,qt(ui)),i|=32),It(r,i,n,t,e)}),si=En(function(r,n,t){var e,i=3;return t.length&&(e=ns(t,qt(si)),i|=32),It(n,i,r,t,e)});function li(e,t,r){var i,a,o,u,s,l,f=0,c=!1,h=!1,n=!0;if("function"!=typeof e)throw new d(Fa);function _(r){var n=i,t=a;return i=a=Da,f=r,u=e.apply(t,n)}function p(r){var n=r-l;return l===Da||t<=n||n<0||h&&o<=r-f}function g(){var r,n=ii();if(p(n))return y(n);s=ue(g,(n=t-((r=n)-l),h?Y(n,o-(r-f)):n));}function y(r){return s=Da,n&&i?_(r):(i=a=Da,u)}function v(){var r=ii(),n=p(r);if(i=arguments,a=this,l=r,n){if(s===Da)return f=n=l,s=ue(g,t),c?_(n):u;if(h)return Kn(s),s=ue(g,t),_(l)}return s===Da&&(s=ue(g,t)),u}return t=Hi(t)||0,Ui(r)&&(c=!!r.leading,h="maxWait"in r,o=h?$(Hi(r.maxWait)||0,t):o,n="trailing"in r?!!r.trailing:n),v.cancel=function(){s!==Da&&Kn(s),f=0,i=l=a=s=Da;},v.flush=function(){return s===Da?u:y(ii())},v}var fi=En(function(r,n){return qr(r,1,n)}),ci=En(function(r,n,t){return qr(r,Hi(n)||0,t)});function hi(e,i){if("function"!=typeof e||null!=i&&"function"!=typeof i)throw new d(Fa);function a(){var r=arguments,n=i?i.apply(this,r):r[0],t=a.cache;return t.has(n)?t.get(n):(r=e.apply(this,r),a.cache=t.set(n,r)||t,r)}return a.cache=new(hi.Cache||mr),a}function _i(n){if("function"!=typeof n)throw new d(Fa);return function(){var r=arguments;switch(r.length){case 0:return !n.call(this);case 1:return !n.call(this,r[0]);case 2:return !n.call(this,r[0],r[1]);case 3:return !n.call(this,r[0],r[1],r[2])}return !n.apply(this,r)}}hi.Cache=mr;var pi=Gn(function(e,i){var a=(i=1==i.length&&Ai(i[0])?Iu(i[0],Wu(Rt())):Iu($r(i,1),Wu(Rt()))).length;return En(function(r){for(var n=-1,t=Y(r.length,a);++n<t;)r[n]=i[n].call(this,r[n]);return wu(e,this,r)})}),gi=En(function(r,n){var t=ns(n,qt(gi));return It(r,32,Da,n,t)}),yi=En(function(r,n){var t=ns(n,qt(yi));return It(r,64,Da,n,t)}),vi=Nt(function(r,n){return It(r,256,Da,Da,Da,n)});function di(r,n){return r===n||r!=r&&n!=n}var bi=jt(rn),wi=jt(function(r,n){return n<=r}),mi=on(function(){return arguments}())?on:function(r){return Ni(r)&&b.call(r,"callee")&&!B.call(r,"callee")},Ai=j.isArray,ji=pu?Wu(pu):function(r){return Ni(r)&&Qr(r)==ho};function xi(r){return null!=r&&Si(r.length)&&!Bi(r)}function Ei(r){return Ni(r)&&xi(r)}var Vi=D||Ra,ki=gu?Wu(gu):function(r){return Ni(r)&&Qr(r)==Qa};function Ii(r){if(!Ni(r))return !1;var n=Qr(r);return n==ro||"[object DOMException]"==n||"string"==typeof r.message&&"string"==typeof r.name&&!Mi(r)}function Bi(r){if(!Ui(r))return !1;r=Qr(r);return r==no||r==to||"[object AsyncFunction]"==r||"[object Proxy]"==r}function Ti(r){return "number"==typeof r&&r==Yi(r)}function Si(r){return "number"==typeof r&&-1<r&&r%1==0&&r<=Ya}function Ui(r){var n=typeof r;return null!=r&&("object"==n||"function"==n)}function Ni(r){return null!=r&&"object"==typeof r}var Oi=yu?Wu(yu):function(r){return Ni(r)&&$t(r)==eo};function zi(r){return "number"==typeof r||Ni(r)&&Qr(r)==io}function Mi(r){if(!Ni(r)||Qr(r)!=ao)return !1;r=k(r);if(null===r)return !0;r=b.call(r,"constructor")&&r.constructor;return "function"==typeof r&&r instanceof r&&u.call(r)==v}var Ci=vu?Wu(vu):function(r){return Ni(r)&&Qr(r)==uo};var qi=du?Wu(du):function(r){return Ni(r)&&$t(r)==so};function Ri(r){return "string"==typeof r||!Ai(r)&&Ni(r)&&Qr(r)==lo}function Li(r){return "symbol"==typeof r||Ni(r)&&Qr(r)==fo}var Di=bu?Wu(bu):function(r){return Ni(r)&&Si(r.length)&&!!su[Qr(r)]};var Fi=jt(_n),Pi=jt(function(r,n){return r<=n});function Wi(r){if(!r)return [];if(xi(r))return (Ri(r)?is:it)(r);if(U&&r[U])return function(r){for(var n,t=[];!(n=r.next()).done;)t.push(n.value);return t}(r[U]());var n=$t(r);return (n==eo?Qu:n==so?ts:da)(r)}function $i(r){return r?(r=Hi(r))!==1/0&&r!==-1/0?r==r?r:0:17976931348623157e292*(r<0?-1:1):0===r?r:0}function Yi(r){var n=$i(r),r=n%1;return n==n?r?n-r:n:0}function Zi(r){return r?zr(Yi(r),0,Ha):0}function Hi(r){if("number"==typeof r)return r;if(Li(r))return Za;if("string"!=typeof(r=Ui(r)?Ui(n="function"==typeof r.valueOf?r.valueOf():r)?n+"":n:r))return 0===r?r:+r;r=Pu(r);var n=Go.test(r);return n||Ko.test(r)?cu(r.slice(2),n?2:8):Ho.test(r)?Za:+r}function Gi(r){return at(r,fa(r))}function Ji(r){return null==r?"":qn(r)}var Ki=ut(function(r,n){if(re(n)||xi(n))at(n,la(n),r);else for(var t in n)b.call(n,t)&&Br(r,t,n[t]);}),Xi=ut(function(r,n){at(n,fa(n),r);}),Qi=ut(function(r,n,t,e){at(n,fa(n),r,e);}),ra=ut(function(r,n,t,e){at(n,la(n),r,e);}),na=Nt(Or);var ta=En(function(r,n){r=g(r);var t=-1,e=n.length,i=2<e?n[2]:Da;for(i&&Jt(n[0],n[1],i)&&(e=1);++t<e;)for(var a=n[t],o=fa(a),u=-1,s=o.length;++u<s;){var l=o[u],f=r[l];(f===Da||di(f,p[l])&&!b.call(r,l))&&(r[l]=a[l]);}return r}),ea=En(function(r){return r.push(Da,Tt),wu(ha,Da,r)});function ia(r,n,t){n=null==r?Da:Kr(r,n);return n===Da?t:n}function aa(r,n){return null!=r&&Yt(r,n,tn)}var oa=vt(function(r,n,t){r[n=null!=n&&"function"!=typeof n.toString?y.call(n):n]=t;},Sa(Na)),ua=vt(function(r,n,t){null!=n&&"function"!=typeof n.toString&&(n=y.call(n)),b.call(r,n)?r[n].push(t):r[n]=[t];},Rt),sa=En(an);function la(r){return (xi(r)?xr:cn)(r)}function fa(r){return xi(r)?xr(r,!0):hn(r)}var ca=ut(function(r,n,t){vn(r,n,t);}),ha=ut(function(r,n,t,e){vn(r,n,t,e);}),_a=Nt(function(n,r){var t={};if(null==n)return t;var e=!1;r=Iu(r,function(r){return r=Hn(r,n),e=e||1<r.length,r}),at(n,zt(n),t),e&&(t=Mr(t,7,St));for(var i=r.length;i--;)Ln(t,r[i]);return t});var pa=Nt(function(r,n){return null==r?{}:wn(t=r,n,function(r,n){return aa(t,n)});var t;});function ga(r,t){if(null==r)return {};var n=Iu(zt(r),function(r){return [r]});return t=Rt(t),wn(r,n,function(r,n){return t(r,n[0])})}var ya=kt(la),va=kt(fa);function da(r){return null==r?[]:$u(r,la(r))}var ba=ct(function(r,n,t){return n=n.toLowerCase(),r+(t?wa(n):n)});function wa(r){return Ia(Ji(r).toLowerCase())}function ma(r){return (r=Ji(r))&&r.replace(Qo,Gu).replace(eu,"")}var Aa=ct(function(r,n,t){return r+(t?"-":"")+n.toLowerCase()}),ja=ct(function(r,n,t){return r+(t?" ":"")+n.toLowerCase()}),xa=ft("toLowerCase");var Ea=ct(function(r,n,t){return r+(t?"_":"")+n.toLowerCase()});var Va=ct(function(r,n,t){return r+(t?" ":"")+Ia(n)});var ka=ct(function(r,n,t){return r+(t?" ":"")+n.toUpperCase()}),Ia=ft("toUpperCase");function Ba(r,n,t){return r=Ji(r),(n=t?Da:n)===Da?(t=r,au.test(t)?r.match(iu)||[]:r.match(Po)||[]):r.match(n)||[]}var Ta=En(function(r,n){try{return wu(r,Da,n)}catch(r){return Ii(r)?r:new c(r)}}),e=Nt(function(n,r){return Au(r,function(r){r=ge(r),Nr(n,r,ui(n[r],n));}),n});function Sa(r){return function(){return r}}var Ua=gt(),A=gt(!0);function Na(r){return r}function Oa(r){return fn("function"==typeof r?r:Mr(r,1))}t=En(function(n,t){return function(r){return an(r,n,t)}}),n=En(function(n,t){return function(r){return an(n,r,t)}});function za(e,n,r){var t=la(n),i=Jr(n,t);null!=r||Ui(n)&&(i.length||!t.length)||(r=n,n=e,e=this,i=Jr(n,la(n)));var a=!(Ui(r)&&"chain"in r&&!r.chain),o=Bi(e);return Au(i,function(r){var t=n[r];e[r]=t,o&&(e.prototype[r]=function(){var r=this.__chain__;if(a||r){var n=e(this.__wrapped__);return (n.__actions__=it(this.__actions__)).push({func:t,args:arguments,thisArg:e}),n.__chain__=r,n}return t.apply(e,Bu([this.value()],arguments))});}),e}function Ma(){}x=bt(Iu),fr=bt(xu),z=bt(Uu);function Ca(r){return Kt(r)?Ru(ge(r)):(n=r,function(r){return Kr(r,n)});var n;}K=At(),Q=At(!0);function qa(){return []}function Ra(){return !1}nr=dt(function(r,n){return r+n},0),o=Et("ceil"),C=dt(function(r,n){return r/n},1),Tn=Et("floor");var La,M=dt(function(r,n){return r*n},1),Gn=Et("round"),D=dt(function(r,n){return r-n},0);return _r.after=function(r,n){if("function"!=typeof n)throw new d(Fa);return r=Yi(r),function(){if(--r<1)return n.apply(this,arguments)}},_r.ary=ai,_r.assign=Ki,_r.assignIn=Xi,_r.assignInWith=Qi,_r.assignWith=ra,_r.at=na,_r.before=oi,_r.bind=ui,_r.bindAll=e,_r.bindKey=si,_r.castArray=function(){if(!arguments.length)return [];var r=arguments[0];return Ai(r)?r:[r]},_r.chain=We,_r.chunk=function(r,n,t){n=(t?Jt(r,n,t):n===Da)?1:$(Yi(n),0);var e=null==r?0:r.length;if(!e||n<1)return [];for(var i=0,a=0,o=j(q(e/n));i<e;)o[a++]=Un(r,i,i+=n);return o},_r.compact=function(r){for(var n=-1,t=null==r?0:r.length,e=0,i=[];++n<t;){var a=r[n];a&&(i[e++]=a);}return i},_r.concat=function(){var r=arguments.length;if(!r)return [];for(var n=j(r-1),t=arguments[0],e=r;e--;)n[e-1]=arguments[e];return Bu(Ai(t)?it(t):[t],$r(n,1))},_r.cond=function(e){var i=null==e?0:e.length,n=Rt();return e=i?Iu(e,function(r){if("function"!=typeof r[1])throw new d(Fa);return [n(r[0]),r[1]]}):[],En(function(r){for(var n=-1;++n<i;){var t=e[n];if(wu(t[0],this,r))return wu(t[1],this,r)}})},_r.conforms=function(r){return n=Mr(r,1),t=la(n),function(r){return Cr(r,n,t)};var n,t;},_r.constant=Sa,_r.countBy=Ze,_r.create=function(r,n){return r=pr(r),null==n?r:Ur(r,n)},_r.curry=function r(n,t,e){t=It(n,8,Da,Da,Da,Da,Da,t=e?Da:t);return t.placeholder=r.placeholder,t},_r.curryRight=function r(n,t,e){t=It(n,16,Da,Da,Da,Da,Da,t=e?Da:t);return t.placeholder=r.placeholder,t},_r.debounce=li,_r.defaults=ta,_r.defaultsDeep=ea,_r.defer=fi,_r.delay=ci,_r.difference=de,_r.differenceBy=be,_r.differenceWith=we,_r.drop=function(r,n,t){var e=null==r?0:r.length;return e?Un(r,(n=t||n===Da?1:Yi(n))<0?0:n,e):[]},_r.dropRight=function(r,n,t){var e=null==r?0:r.length;return e?Un(r,0,(n=e-(n=t||n===Da?1:Yi(n)))<0?0:n):[]},_r.dropRightWhile=function(r,n){return r&&r.length?Fn(r,Rt(n,3),!0,!0):[]},_r.dropWhile=function(r,n){return r&&r.length?Fn(r,Rt(n,3),!0):[]},_r.fill=function(r,n,t,e){var i=null==r?0:r.length;return i?(t&&"number"!=typeof t&&Jt(r,n,t)&&(t=0,e=i),function(r,n,t,e){var i=r.length;for((t=Yi(t))<0&&(t=i<-t?0:i+t),(e=e===Da||i<e?i:Yi(e))<0&&(e+=i),e=e<t?0:Zi(e);t<e;)r[t++]=n;return r}(r,n,t,e)):[]},_r.filter=function(r,n){return (Ai(r)?Eu:Wr)(r,Rt(n,3))},_r.flatMap=function(r,n){return $r(ni(r,n),1)},_r.flatMapDeep=function(r,n){return $r(ni(r,n),1/0)},_r.flatMapDepth=function(r,n,t){return t=t===Da?1:Yi(t),$r(ni(r,n),t)},_r.flatten=je,_r.flattenDeep=function(r){return (null==r?0:r.length)?$r(r,1/0):[]},_r.flattenDepth=function(r,n){return (null==r?0:r.length)?$r(r,n=n===Da?1:Yi(n)):[]},_r.flip=function(r){return It(r,512)},_r.flow=Ua,_r.flowRight=A,_r.fromPairs=function(r){for(var n=-1,t=null==r?0:r.length,e={};++n<t;){var i=r[n];e[i[0]]=i[1];}return e},_r.functions=function(r){return null==r?[]:Jr(r,la(r))},_r.functionsIn=function(r){return null==r?[]:Jr(r,fa(r))},_r.groupBy=Xe,_r.initial=function(r){return (null==r?0:r.length)?Un(r,0,-1):[]},_r.intersection=Ee,_r.intersectionBy=Ve,_r.intersectionWith=ke,_r.invert=oa,_r.invertBy=ua,_r.invokeMap=Qe,_r.iteratee=Oa,_r.keyBy=ri,_r.keys=la,_r.keysIn=fa,_r.map=ni,_r.mapKeys=function(r,e){var i={};return e=Rt(e,3),Hr(r,function(r,n,t){Nr(i,e(r,n,t),r);}),i},_r.mapValues=function(r,e){var i={};return e=Rt(e,3),Hr(r,function(r,n,t){Nr(i,n,e(r,n,t));}),i},_r.matches=function(r){return gn(Mr(r,1))},_r.matchesProperty=function(r,n){return yn(r,Mr(n,1))},_r.memoize=hi,_r.merge=ca,_r.mergeWith=ha,_r.method=t,_r.methodOf=n,_r.mixin=za,_r.negate=_i,_r.nthArg=function(n){return n=Yi(n),En(function(r){return dn(r,n)})},_r.omit=_a,_r.omitBy=function(r,n){return ga(r,_i(Rt(n)))},_r.once=function(r){return oi(2,r)},_r.orderBy=function(r,n,t,e){return null==r?[]:bn(r,n=!Ai(n)?null==n?[]:[n]:n,t=!Ai(t=e?Da:t)?null==t?[]:[t]:t)},_r.over=x,_r.overArgs=pi,_r.overEvery=fr,_r.overSome=z,_r.partial=gi,_r.partialRight=yi,_r.partition=ti,_r.pick=pa,_r.pickBy=ga,_r.property=Ca,_r.propertyOf=function(n){return function(r){return null==n?Da:Kr(n,r)}},_r.pull=Be,_r.pullAll=Te,_r.pullAllBy=function(r,n,t){return r&&r.length&&n&&n.length?mn(r,n,Rt(t,2)):r},_r.pullAllWith=function(r,n,t){return r&&r.length&&n&&n.length?mn(r,n,Da,t):r},_r.pullAt=Se,_r.range=K,_r.rangeRight=Q,_r.rearg=vi,_r.reject=function(r,n){return (Ai(r)?Eu:Wr)(r,_i(Rt(n,3)))},_r.remove=function(r,n){var t=[];if(!r||!r.length)return t;var e=-1,i=[],a=r.length;for(n=Rt(n,3);++e<a;){var o=r[e];n(o,e,r)&&(t.push(o),i.push(e));}return An(r,i),t},_r.rest=function(r,n){if("function"!=typeof r)throw new d(Fa);return En(r,n=n===Da?n:Yi(n))},_r.reverse=Ue,_r.sampleSize=function(r,n,t){return n=(t?Jt(r,n,t):n===Da)?1:Yi(n),(Ai(r)?Vr:kn)(r,n)},_r.set=function(r,n,t){return null==r?r:In(r,n,t)},_r.setWith=function(r,n,t,e){return e="function"==typeof e?e:Da,null==r?r:In(r,n,t,e)},_r.shuffle=function(r){return (Ai(r)?kr:Sn)(r)},_r.slice=function(r,n,t){var e=null==r?0:r.length;return e?(t=t&&"number"!=typeof t&&Jt(r,n,t)?(n=0,e):(n=null==n?0:Yi(n),t===Da?e:Yi(t)),Un(r,n,t)):[]},_r.sortBy=ei,_r.sortedUniq=function(r){return r&&r.length?Mn(r):[]},_r.sortedUniqBy=function(r,n){return r&&r.length?Mn(r,Rt(n,2)):[]},_r.split=function(r,n,t){return t&&"number"!=typeof t&&Jt(r,n,t)&&(n=t=Da),(t=t===Da?Ha:t>>>0)?(r=Ji(r))&&("string"==typeof n||null!=n&&!Ci(n))&&!(n=qn(n))&&Xu(r)?Jn(is(r),0,t):r.split(n,t):[]},_r.spread=function(t,e){if("function"!=typeof t)throw new d(Fa);return e=null==e?0:$(Yi(e),0),En(function(r){var n=r[e],r=Jn(r,0,e);return n&&Bu(r,n),wu(t,this,r)})},_r.tail=function(r){var n=null==r?0:r.length;return n?Un(r,1,n):[]},_r.take=function(r,n,t){return r&&r.length?Un(r,0,(n=t||n===Da?1:Yi(n))<0?0:n):[]},_r.takeRight=function(r,n,t){var e=null==r?0:r.length;return e?Un(r,(n=e-(n=t||n===Da?1:Yi(n)))<0?0:n,e):[]},_r.takeRightWhile=function(r,n){return r&&r.length?Fn(r,Rt(n,3),!1,!0):[]},_r.takeWhile=function(r,n){return r&&r.length?Fn(r,Rt(n,3)):[]},_r.tap=function(r,n){return n(r),r},_r.throttle=function(r,n,t){var e=!0,i=!0;if("function"!=typeof r)throw new d(Fa);return Ui(t)&&(e="leading"in t?!!t.leading:e,i="trailing"in t?!!t.trailing:i),li(r,n,{leading:e,maxWait:n,trailing:i})},_r.thru=$e,_r.toArray=Wi,_r.toPairs=ya,_r.toPairsIn=va,_r.toPath=function(r){return Ai(r)?Iu(r,ge):Li(r)?[r]:it(pe(Ji(r)))},_r.toPlainObject=Gi,_r.transform=function(r,e,i){var n,t=Ai(r),a=t||Vi(r)||Di(r);return e=Rt(e,4),null==i&&(n=r&&r.constructor,i=a?t?new n:[]:Ui(r)&&Bi(n)?pr(k(r)):{}),(a?Au:Hr)(r,function(r,n,t){return e(i,r,n,t)}),i},_r.unary=function(r){return ai(r,1)},_r.union=Ne,_r.unionBy=Oe,_r.unionWith=ze,_r.uniq=function(r){return r&&r.length?Rn(r):[]},_r.uniqBy=function(r,n){return r&&r.length?Rn(r,Rt(n,2)):[]},_r.uniqWith=function(r,n){return n="function"==typeof n?n:Da,r&&r.length?Rn(r,Da,n):[]},_r.unset=function(r,n){return null==r||Ln(r,n)},_r.unzip=Me,_r.unzipWith=Ce,_r.update=function(r,n,t){return null==r?r:Dn(r,n,Zn(t))},_r.updateWith=function(r,n,t,e){return e="function"==typeof e?e:Da,null==r?r:Dn(r,n,Zn(t),e)},_r.values=da,_r.valuesIn=function(r){return null==r?[]:$u(r,fa(r))},_r.without=qe,_r.words=Ba,_r.wrap=function(r,n){return gi(Zn(n),r)},_r.xor=Re,_r.xorBy=Le,_r.xorWith=De,_r.zip=Fe,_r.zipObject=function(r,n){return $n(r||[],n||[],Br)},_r.zipObjectDeep=function(r,n){return $n(r||[],n||[],In)},_r.zipWith=Pe,_r.entries=ya,_r.entriesIn=va,_r.extend=Xi,_r.extendWith=Qi,za(_r,_r),_r.add=nr,_r.attempt=Ta,_r.camelCase=ba,_r.capitalize=wa,_r.ceil=o,_r.clamp=function(r,n,t){return t===Da&&(t=n,n=Da),t!==Da&&(t=(t=Hi(t))==t?t:0),n!==Da&&(n=(n=Hi(n))==n?n:0),zr(Hi(r),n,t)},_r.clone=function(r){return Mr(r,4)},_r.cloneDeep=function(r){return Mr(r,5)},_r.cloneDeepWith=function(r,n){return Mr(r,5,n="function"==typeof n?n:Da)},_r.cloneWith=function(r,n){return Mr(r,4,n="function"==typeof n?n:Da)},_r.conformsTo=function(r,n){return null==n||Cr(r,n,la(n))},_r.deburr=ma,_r.defaultTo=function(r,n){return null==r||r!=r?n:r},_r.divide=C,_r.endsWith=function(r,n,t){r=Ji(r),n=qn(n);var e=r.length,e=t=t===Da?e:zr(Yi(t),0,e);return 0<=(t-=n.length)&&r.slice(t,e)==n},_r.eq=di,_r.escape=function(r){return (r=Ji(r))&&To.test(r)?r.replace(Io,Ju):r},_r.escapeRegExp=function(r){return (r=Ji(r))&&qo.test(r)?r.replace(Co,"\\$&"):r},_r.every=function(r,n,t){return (Ai(r)?xu:Fr)(r,Rt(n=t&&Jt(r,n,t)?Da:n,3))},_r.find=He,_r.findIndex=me,_r.findKey=function(r,n){return Nu(r,Rt(n,3),Hr)},_r.findLast=Ge,_r.findLastIndex=Ae,_r.findLastKey=function(r,n){return Nu(r,Rt(n,3),Gr)},_r.floor=Tn,_r.forEach=Je,_r.forEachRight=Ke,_r.forIn=function(r,n){return null==r?r:Yr(r,Rt(n,3),fa)},_r.forInRight=function(r,n){return null==r?r:Zr(r,Rt(n,3),fa)},_r.forOwn=function(r,n){return r&&Hr(r,Rt(n,3))},_r.forOwnRight=function(r,n){return r&&Gr(r,Rt(n,3))},_r.get=ia,_r.gt=bi,_r.gte=wi,_r.has=function(r,n){return null!=r&&Yt(r,n,nn)},_r.hasIn=aa,_r.head=xe,_r.identity=Na,_r.includes=function(r,n,t,e){return r=xi(r)?r:da(r),t=t&&!e?Yi(t):0,e=r.length,t<0&&(t=$(e+t,0)),Ri(r)?t<=e&&-1<r.indexOf(n,t):!!e&&-1<zu(r,n,t)},_r.indexOf=function(r,n,t){var e=null==r?0:r.length;return e?(t=null==t?0:Yi(t),zu(r,n,t=t<0?$(e+t,0):t)):-1},_r.inRange=function(r,n,t){return n=$i(n),t===Da?(t=n,n=0):t=$i(t),(r=r=Hi(r))>=Y(n=n,t=t)&&r<$(n,t)},_r.invoke=sa,_r.isArguments=mi,_r.isArray=Ai,_r.isArrayBuffer=ji,_r.isArrayLike=xi,_r.isArrayLikeObject=Ei,_r.isBoolean=function(r){return !0===r||!1===r||Ni(r)&&Qr(r)==Xa},_r.isBuffer=Vi,_r.isDate=ki,_r.isElement=function(r){return Ni(r)&&1===r.nodeType&&!Mi(r)},_r.isEmpty=function(r){if(null==r)return !0;if(xi(r)&&(Ai(r)||"string"==typeof r||"function"==typeof r.splice||Vi(r)||Di(r)||mi(r)))return !r.length;var n,t=$t(r);if(t==eo||t==so)return !r.size;if(re(r))return !cn(r).length;for(n in r)if(b.call(r,n))return !1;return !0},_r.isEqual=function(r,n){return un(r,n)},_r.isEqualWith=function(r,n,t){var e=(t="function"==typeof t?t:Da)?t(r,n):Da;return e===Da?un(r,n,Da,t):!!e},_r.isError=Ii,_r.isFinite=function(r){return "number"==typeof r&&F(r)},_r.isFunction=Bi,_r.isInteger=Ti,_r.isLength=Si,_r.isMap=Oi,_r.isMatch=function(r,n){return r===n||sn(r,n,Dt(n))},_r.isMatchWith=function(r,n,t){return t="function"==typeof t?t:Da,sn(r,n,Dt(n),t)},_r.isNaN=function(r){return zi(r)&&r!=+r},_r.isNative=function(r){if(Qt(r))throw new c("Unsupported core-js use. Try https://npms.io/search?q=ponyfill.");return ln(r)},_r.isNil=function(r){return null==r},_r.isNull=function(r){return null===r},_r.isNumber=zi,_r.isObject=Ui,_r.isObjectLike=Ni,_r.isPlainObject=Mi,_r.isRegExp=Ci,_r.isSafeInteger=function(r){return Ti(r)&&-Ya<=r&&r<=Ya},_r.isSet=qi,_r.isString=Ri,_r.isSymbol=Li,_r.isTypedArray=Di,_r.isUndefined=function(r){return r===Da},_r.isWeakMap=function(r){return Ni(r)&&$t(r)==co},_r.isWeakSet=function(r){return Ni(r)&&"[object WeakSet]"==Qr(r)},_r.join=function(r,n){return null==r?"":P.call(r,n)},_r.kebabCase=Aa,_r.last=Ie,_r.lastIndexOf=function(r,n,t){var e=null==r?0:r.length;if(!e)return -1;var i=e;return t!==Da&&(i=(i=Yi(t))<0?$(e+i,0):Y(i,e-1)),n==n?function(r,n,t){for(var e=t+1;e--;)if(r[e]===n)return e;return e}(r,n,i):Ou(r,Cu,i,!0)},_r.lowerCase=ja,_r.lowerFirst=xa,_r.lt=Fi,_r.lte=Pi,_r.max=function(r){return r&&r.length?Pr(r,Na,rn):Da},_r.maxBy=function(r,n){return r&&r.length?Pr(r,Rt(n,2),rn):Da},_r.mean=function(r){return qu(r,Na)},_r.meanBy=function(r,n){return qu(r,Rt(n,2))},_r.min=function(r){return r&&r.length?Pr(r,Na,_n):Da},_r.minBy=function(r,n){return r&&r.length?Pr(r,Rt(n,2),_n):Da},_r.stubArray=qa,_r.stubFalse=Ra,_r.stubObject=function(){return {}},_r.stubString=function(){return ""},_r.stubTrue=function(){return !0},_r.multiply=M,_r.nth=function(r,n){return r&&r.length?dn(r,Yi(n)):Da},_r.noConflict=function(){return hu._===this&&(hu._=w),this},_r.noop=Ma,_r.now=ii,_r.pad=function(r,n,t){r=Ji(r);var e=(n=Yi(n))?es(r):0;return !n||n<=e?r:wt(R(e=(n-e)/2),t)+r+wt(q(e),t)},_r.padEnd=function(r,n,t){r=Ji(r);var e=(n=Yi(n))?es(r):0;return n&&e<n?r+wt(n-e,t):r},_r.padStart=function(r,n,t){r=Ji(r);var e=(n=Yi(n))?es(r):0;return n&&e<n?wt(n-e,t)+r:r},_r.parseInt=function(r,n,t){return n=t||null==n?0:n&&+n,H(Ji(r).replace(Ro,""),n||0)},_r.random=function(r,n,t){var e;if(t&&"boolean"!=typeof t&&Jt(r,n,t)&&(n=t=Da),t===Da&&("boolean"==typeof n?(t=n,n=Da):"boolean"==typeof r&&(t=r,r=Da)),r===Da&&n===Da?(r=0,n=1):(r=$i(r),n===Da?(n=r,r=0):n=$i(n)),n<r&&(e=r,r=n,n=e),t||r%1||n%1){t=G();return Y(r+t*(n-r+fu("1e-"+((t+"").length-1))),n)}return jn(r,n)},_r.reduce=function(r,n,t){var e=Ai(r)?Tu:Lu,i=arguments.length<3;return e(r,Rt(n,4),t,i,Lr)},_r.reduceRight=function(r,n,t){var e=Ai(r)?Su:Lu,i=arguments.length<3;return e(r,Rt(n,4),t,i,Dr)},_r.repeat=function(r,n,t){return n=(t?Jt(r,n,t):n===Da)?1:Yi(n),xn(Ji(r),n)},_r.replace=function(){var r=arguments,n=Ji(r[0]);return r.length<3?n:n.replace(r[1],r[2])},_r.result=function(r,n,t){var e=-1,i=(n=Hn(n,r)).length;for(i||(i=1,r=Da);++e<i;){var a=null==r?Da:r[ge(n[e])];a===Da&&(e=i,a=t),r=Bi(a)?a.call(r):a;}return r},_r.round=Gn,_r.runInContext=r,_r.sample=function(r){return (Ai(r)?Er:Vn)(r)},_r.size=function(r){if(null==r)return 0;if(xi(r))return Ri(r)?es(r):r.length;var n=$t(r);return n==eo||n==so?r.size:cn(r).length},_r.snakeCase=Ea,_r.some=function(r,n,t){return (Ai(r)?Uu:Nn)(r,Rt(n=t&&Jt(r,n,t)?Da:n,3))},_r.sortedIndex=function(r,n){return On(r,n)},_r.sortedIndexBy=function(r,n,t){return zn(r,n,Rt(t,2))},_r.sortedIndexOf=function(r,n){var t=null==r?0:r.length;if(t){var e=On(r,n);if(e<t&&di(r[e],n))return e}return -1},_r.sortedLastIndex=function(r,n){return On(r,n,!0)},_r.sortedLastIndexBy=function(r,n,t){return zn(r,n,Rt(t,2),!0)},_r.sortedLastIndexOf=function(r,n){if(null==r?0:r.length){var t=On(r,n,!0)-1;if(di(r[t],n))return t}return -1},_r.startCase=Va,_r.startsWith=function(r,n,t){return r=Ji(r),t=null==t?0:zr(Yi(t),0,r.length),n=qn(n),r.slice(t,t+n.length)==n},_r.subtract=D,_r.sum=function(r){return r&&r.length?Du(r,Na):0},_r.sumBy=function(r,n){return r&&r.length?Du(r,Rt(n,2)):0},_r.template=function(o,r,n){var t=_r.templateSettings;n&&Jt(o,r,n)&&(r=Da),o=Ji(o),r=Qi({},r,t,Bt);var u,s,e=la(t=Qi({},r.imports,t.imports,Bt)),i=$u(t,e),l=0,t=r.interpolate||ru,f="__p += '",t=_((r.escape||ru).source+"|"+t.source+"|"+(t===No?Yo:ru).source+"|"+(r.evaluate||ru).source+"|$","g"),a="//# sourceURL="+(b.call(r,"sourceURL")?(r.sourceURL+"").replace(/\s/g," "):"lodash.templateSources["+ ++uu+"]")+"\n";if(o.replace(t,function(r,n,t,e,i,a){return t=t||e,f+=o.slice(l,a).replace(nu,Ku),n&&(u=!0,f+="' +\n__e("+n+") +\n'"),i&&(s=!0,f+="';\n"+i+";\n__p += '"),t&&(f+="' +\n((__t = ("+t+")) == null ? '' : __t) +\n'"),l=a+r.length,r}),f+="';\n",r=b.call(r,"variable")&&r.variable){if(Wo.test(r))throw new c("Invalid `variable` option passed into `_.template`")}else f="with (obj) {\n"+f+"\n}\n";if(f=(s?f.replace(xo,""):f).replace(Eo,"$1").replace(Vo,"$1;"),f="function("+(r||"obj")+") {\n"+(r?"":"obj || (obj = {});\n")+"var __t, __p = ''"+(u?", __e = _.escape":"")+(s?", __j = Array.prototype.join;\nfunction print() { __p += __j.call(arguments, '') }\n":";\n")+f+"return __p\n}",(r=Ta(function(){return h(e,a+"return "+f).apply(Da,i)})).source=f,Ii(r))throw r;return r},_r.times=function(r,n){if((r=Yi(r))<1||Ya<r)return [];var t=Ha,e=Y(r,Ha);for(n=Rt(n),r-=Ha,e=Fu(e,n);++t<r;)n(t);return e},_r.toFinite=$i,_r.toInteger=Yi,_r.toLength=Zi,_r.toLower=function(r){return Ji(r).toLowerCase()},_r.toNumber=Hi,_r.toSafeInteger=function(r){return r?zr(Yi(r),-Ya,Ya):0===r?r:0},_r.toString=Ji,_r.toUpper=function(r){return Ji(r).toUpperCase()},_r.trim=function(r,n,t){return (r=Ji(r))&&(t||n===Da)?Pu(r):r&&(n=qn(n))?(r=is(r),n=is(n),Jn(r,Zu(r,n),Hu(r,n)+1).join("")):r},_r.trimEnd=function(r,n,t){return (r=Ji(r))&&(t||n===Da)?r.slice(0,as(r)+1):r&&(n=qn(n))?Jn(r=is(r),0,Hu(r,is(n))+1).join(""):r},_r.trimStart=function(r,n,t){return (r=Ji(r))&&(t||n===Da)?r.replace(Ro,""):r&&(n=qn(n))?Jn(r=is(r),Zu(r,is(n))).join(""):r},_r.truncate=function(r,n){var t,e=30,i="...";Ui(n)&&(t="separator"in n?n.separator:t,e="length"in n?Yi(n.length):e,i="omission"in n?qn(n.omission):i);var a,n=(r=Ji(r)).length;if((n=Xu(r)?(a=is(r)).length:n)<=e)return r;if((n=e-es(i))<1)return i;if(e=a?Jn(a,0,n).join(""):r.slice(0,n),t===Da)return e+i;if(a&&(n+=e.length-n),Ci(t)){if(r.slice(n).search(t)){var o,u=e;for((t=!t.global?_(t.source,Ji(Zo.exec(t))+"g"):t).lastIndex=0;o=t.exec(u);)var s=o.index;e=e.slice(0,s===Da?n:s);}}else r.indexOf(qn(t),n)==n||-1<(n=e.lastIndexOf(t))&&(e=e.slice(0,n));return e+i},_r.unescape=function(r){return (r=Ji(r))&&Bo.test(r)?r.replace(ko,os):r},_r.uniqueId=function(r){var n=++s;return Ji(r)+n},_r.upperCase=ka,_r.upperFirst=Ia,_r.each=Je,_r.eachRight=Ke,_r.first=xe,za(_r,(La={},Hr(_r,function(r,n){b.call(_r.prototype,n)||(La[n]=r);}),La),{chain:!1}),_r.VERSION="4.17.21",Au(["bind","bindKey","curry","curryRight","partial","partialRight"],function(r){_r[r].placeholder=_r;}),Au(["drop","take"],function(t,e){dr.prototype[t]=function(r){r=r===Da?1:$(Yi(r),0);var n=this.__filtered__&&!e?new dr(this):this.clone();return n.__filtered__?n.__takeCount__=Y(r,n.__takeCount__):n.__views__.push({size:Y(r,Ha),type:t+(n.__dir__<0?"Right":"")}),n},dr.prototype[t+"Right"]=function(r){return this.reverse()[t](r).reverse()};}),Au(["filter","map","takeWhile"],function(r,n){var t=n+1,e=1==t||3==t;dr.prototype[r]=function(r){var n=this.clone();return n.__iteratees__.push({iteratee:Rt(r,3),type:t}),n.__filtered__=n.__filtered__||e,n};}),Au(["head","last"],function(r,n){var t="take"+(n?"Right":"");dr.prototype[r]=function(){return this[t](1).value()[0]};}),Au(["initial","tail"],function(r,n){var t="drop"+(n?"":"Right");dr.prototype[r]=function(){return this.__filtered__?new dr(this):this[t](1)};}),dr.prototype.compact=function(){return this.filter(Na)},dr.prototype.find=function(r){return this.filter(r).head()},dr.prototype.findLast=function(r){return this.reverse().find(r)},dr.prototype.invokeMap=En(function(n,t){return "function"==typeof n?new dr(this):this.map(function(r){return an(r,n,t)})}),dr.prototype.reject=function(r){return this.filter(_i(Rt(r)))},dr.prototype.slice=function(r,n){r=Yi(r);var t=this;return t.__filtered__&&(0<r||n<0)?new dr(t):(r<0?t=t.takeRight(-r):r&&(t=t.drop(r)),n!==Da?(n=Yi(n))<0?t.dropRight(-n):t.take(n-r):t)},dr.prototype.takeRightWhile=function(r){return this.reverse().takeWhile(r).reverse()},dr.prototype.toArray=function(){return this.take(Ha)},Hr(dr.prototype,function(l,r){var f=/^(?:filter|find|map|reject)|While$/.test(r),c=/^(?:head|last)$/.test(r),h=_r[c?"take"+("last"==r?"Right":""):r],_=c||/^find/.test(r);h&&(_r.prototype[r]=function(){function r(r){return r=h.apply(_r,Bu([r],t)),c&&o?r[0]:r}var n=this.__wrapped__,t=c?[1]:arguments,e=n instanceof dr,i=t[0],a=e||Ai(n);a&&f&&"function"==typeof i&&1!=i.length&&(e=a=!1);var o=this.__chain__,u=!!this.__actions__.length,i=_&&!o,u=e&&!u;if(_||!a)return i&&u?l.apply(this,t):(s=this.thru(r),i?c?s.value()[0]:s.value():s);var n=u?n:new dr(this),s=l.apply(n,t);return s.__actions__.push({func:$e,args:[r],thisArg:Da}),new vr(s,o)});}),Au(["pop","push","shift","sort","splice","unshift"],function(r){var t=a[r],e=/^(?:push|sort|unshift)$/.test(r)?"tap":"thru",i=/^(?:pop|shift)$/.test(r);_r.prototype[r]=function(){var n=arguments;if(!i||this.__chain__)return this[e](function(r){return t.apply(Ai(r)?r:[],n)});var r=this.value();return t.apply(Ai(r)?r:[],n)};}),Hr(dr.prototype,function(r,n){var t,e=_r[n];e&&(t=e.name+"",b.call(ir,t)||(ir[t]=[]),ir[t].push({name:n,func:e}));}),ir[yt(Da,2).name]=[{name:"wrapper",func:Da}],dr.prototype.clone=function(){var r=new dr(this.__wrapped__);return r.__actions__=it(this.__actions__),r.__dir__=this.__dir__,r.__filtered__=this.__filtered__,r.__iteratees__=it(this.__iteratees__),r.__takeCount__=this.__takeCount__,r.__views__=it(this.__views__),r},dr.prototype.reverse=function(){var r;return this.__filtered__?((r=new dr(this)).__dir__=-1,r.__filtered__=!0):(r=this.clone()).__dir__*=-1,r},dr.prototype.value=function(){var r=this.__wrapped__.value(),n=this.__dir__,t=Ai(r),e=n<0,i=t?r.length:0,a=function(r,n,t){var e=-1,i=t.length;for(;++e<i;){var a=t[e],o=a.size;switch(a.type){case"drop":r+=o;break;case"dropRight":n-=o;break;case"take":n=Y(n,r+o);break;case"takeRight":r=$(r,n-o);}}return {start:r,end:n}}(0,i,this.__views__),o=a.start,u=(a=a.end)-o,s=e?a:o-1,l=this.__iteratees__,f=l.length,c=0,h=Y(u,this.__takeCount__);if(!t||!e&&i==u&&h==u)return Pn(r,this.__actions__);var _=[];r:for(;u--&&c<h;){for(var p=-1,g=r[s+=n];++p<f;){var y=l[p],v=y.iteratee,y=y.type,v=v(g);if(2==y)g=v;else if(!v){if(1==y)continue r;break r}}_[c++]=g;}return _},_r.prototype.at=Ye,_r.prototype.chain=function(){return We(this)},_r.prototype.commit=function(){return new vr(this.value(),this.__chain__)},_r.prototype.next=function(){this.__values__===Da&&(this.__values__=Wi(this.value()));var r=this.__index__>=this.__values__.length;return {done:r,value:r?Da:this.__values__[this.__index__++]}},_r.prototype.plant=function(r){for(var n,t=this;t instanceof yr;){var e=ve(t);e.__index__=0,e.__values__=Da,n?i.__wrapped__=e:n=e;var i=e,t=t.__wrapped__;}return i.__wrapped__=r,n},_r.prototype.reverse=function(){var r=this.__wrapped__;if(r instanceof dr){r=r;return (r=(r=this.__actions__.length?new dr(this):r).reverse()).__actions__.push({func:$e,args:[Ue],thisArg:Da}),new vr(r,this.__chain__)}return this.thru(Ue)},_r.prototype.toJSON=_r.prototype.valueOf=_r.prototype.value=function(){return Pn(this.__wrapped__,this.__actions__)},_r.prototype.first=_r.prototype.head,U&&(_r.prototype[U]=function(){return this}),_r}();V?((V.exports=us)._=us,o._=us):hu._=us;}.call(this);}.call(this,"undefined"!=typeof global?global:"undefined"!=typeof self?self:"undefined"!=typeof window?window:{});},{}],13:[function(r,n,t){var m=r("ndarray-ops"),A=r("ndarray"),j=r("typedarray-pool"),x=r("./lib/fft-matrix.js");n.exports=function(r,n,t){for(var e,i=n.shape,a=i.length,o=1,u=new Array(a),s=0,l=a-1;0<=l;--l)if(u[l]=o,o*=i[l],s=Math.max(s,x.scratchMemory(i[l])),n.shape[l]!==t.shape[l])throw new Error("Shape mismatch, real and imaginary arrays must have same size");var f,c,h,_,p=4*o+s,g="array"===n.dtype||"float64"===n.dtype||"custom"===n.dtype?j.mallocDouble(p):j.mallocFloat(p),y=A(g,i.slice(0),u,0),v=A(g,i.slice(0),u.slice(0),o),d=A(g,i.slice(0),u.slice(0),2*o),b=A(g,i.slice(0),u.slice(0),3*o),w=4*o;for(m.assign(y,n),m.assign(v,t),l=a-1;0<=l&&(x(r,o/i[l],i[l],g,y.offset,v.offset,w),0!==l);--l){for(h=d.stride,_=b.stride,e=l-(c=1);e<a;++e)_[e]=h[e]=c,c*=i[e];for(e=l-2;0<=e;--e)_[e]=h[e]=c,c*=i[e];m.assign(d,y),m.assign(b,v),f=y,y=d,d=f,f=v,v=b,b=f;}m.assign(n,y),m.assign(t,v),j.free(g);};},{"./lib/fft-matrix.js":14,ndarray:18,"ndarray-ops":17,"typedarray-pool":21}],14:[function(r,n,t){var B=r("bit-twiddle");function x(r,n,t,e,i,a){var o,u,s,l,f,c,h,_,p,g,y,v,d,b,w,m,A,j,x,E,V;for(r|=0,n|=0,i|=0,a|=0,o=t|=0,u=B.log2(o),w=0;w<n;++w){for(c=o>>1,I=l=0;I<o-1;I++){for(I<l&&(v=e[i+I],e[i+I]=e[i+l],e[i+l]=v,v=e[a+I],e[a+I]=e[a+l],e[a+l]=v),f=c;f<=l;)l-=f,f>>=1;l+=f;}for(g=-1,p=1,h=y=0;h<u;h++){for(_=p,p<<=1,d=1,l=b=0;l<_;l++){for(I=l;I<o;I+=p)m=e[i+(s=I+_)],A=e[a+s],j=e[i+I],x=e[a+I],m=(E=d*(m+A))+(V=m*(b-d)),e[i+s]=j-(A=E-A*(d+b)),e[a+s]=x-m,e[i+I]+=A,e[a+I]+=m;V=d*(y-g),d=(E=g*(d+b))-b*(g+y),b=E+V;}y=Math.sqrt((1-g)/2),r<0&&(y=-y),g=Math.sqrt((1+g)/2);}if(r<0)for(var k=1/o,I=0;I<o;I++)e[i+I]*=k,e[a+I]*=k;i+=t,a+=t;}}n.exports=function(r,n,t,e,i,a,o){r|=0,n|=0,i|=0,a|=0,B.isPow2(t|=0)?x(r,n,t,e,i,a):function(r,n,t,e,i,a,o){r|=0,n|=0,t|=0,i|=0,a|=0,o|=0;var u,s,l,f,c,h,_,p,g,y=B.nextPow2(2*t+1),v=o,d=v+t,b=d+t,w=b+y,m=w+y,A=m+y,j=-r*Math.PI/t;for(g=0;g<t;++g)s=j*(g*g%(2*t)),f=Math.cos(s),c=Math.sin(s),e[m+(y-g)]=e[m+g]=e[v+g]=f,e[A+(y-g)]=e[A+g]=e[d+g]=c;for(g=t;g<=y-t;++g)e[m+g]=0;for(g=t;g<=y-t;++g)e[A+g]=0;x(1,1,y,e,m,A),j=r<0?1/t:1;for(u=0;u<n;++u){for(g=0;g<t;++g)s=e[i+g],l=e[a+g],f=e[v+g],c=-e[d+g],h=f*(s+l),_=s*(c-f),p=l*(f+c),e[b+g]=h-p,e[w+g]=h+_;for(g=t;g<y;++g)e[b+g]=0;for(g=t;g<y;++g)e[w+g]=0;for(x(1,1,y,e,b,w),g=0;g<y;++g)s=e[b+g],l=e[w+g],f=e[m+g],c=e[A+g],h=f*(s+l),_=s*(c-f),p=l*(f+c),e[b+g]=h-p,e[w+g]=h+_;for(x(-1,1,y,e,b,w),g=0;g<t;++g)s=e[b+g],l=e[w+g],f=e[v+g],c=-e[d+g],h=f*(s+l),_=s*(c-f),p=l*(f+c),e[i+g]=j*(h-p),e[a+g]=j*(h+_);i+=t,a+=t;}}(r,n,t,e,i,a,o);},n.exports.scratchMemory=function(r){return B.isPow2(r)?0:2*r+4*B.nextPow2(2*r+1)};},{"bit-twiddle":2}],15:[function(r,n,t){n.exports=function(r,n,t,e,i){void 0===e&&(e=1);void 0===i&&(i=0);var a=1!==e,o=0!==i,u=p(r),s=p(n),l=p(t);!function(r,n,t){r=_(r),n=_(n),t=_(t);if(r[0]!==n[0]||r[1]!==t[1]||n[1]!==t[0])throw new Error("Mismatched array shapes for matrix product")}(r,n,t);var f=[u,s,l,a,o].join(":"),c=g[f];c=c||(g[f]=h(u,s,l,a,o));return c(r,n,t,e,i)};var h=r("./lib/planner.js");function _(r){return Array.isArray(r)?[r.length,r[0].length]:r.shape}function p(r){if(Array.isArray(r)){if(Array.isArray(r))return ["r","native"]}else if(r.shape&&2===r.shape.length)return r.order[0]?["r",r.dtype]:["c",r.dtype];throw new Error("Unrecognized data type")}var g={};},{"./lib/planner.js":16}],16:[function(r,n,t){n.exports=function(r,n,t,e,i){var a=["gemm",r[0],r[1],"a",n[0],n[1],"b",t[0],t[1],e?"alpha":"",i?"beta":""].join(""),o=["function ",a,"(o,a,b,A,B){","var ",u("o",r),u("a",n),u("b",t),"i,j,k;"];"r"===n[0]&&"c"===t[0]?o.push.apply(o,function(r,n,t,e,i){var a=[],o="r"===r[0]?[1,0]:[0,1],u=[1,0],s=[0,1],l=["i","j"];a.push.apply(a,h(o,"o",r)),o[1]?(a.push("for(j=0;j<od1;++j){"),a.push("for(i=0;i<od0;++i){")):(a.push("for(i=0;i<od0;++i){"),a.push("for(j=0;j<od1;++j){"));a.push.apply(a,h(u,"a",n,"i")),a.push.apply(a,h(s,"b",t,void 0,"j")),a.push("var r=0.0;","for(k=0;k<ad1;++k){","r+=",g(u,"a",n,"i","k"),"*",g(s,"b",t,"k","j"),";"),a.push.apply(a,_(u,"a",n,0,"k")),a.push.apply(a,_(s,"b",t,0,"k")),a.push("}"),e&&a.push("r*=A;");i&&a.push("r+=B*",g(o,"o",r,"i","j"),";");return a.push.apply(a,p(o,"o",r,"i","j","r")),a.push.apply(a,_(o,"o",r,0,l[1])),a.push("}"),a.push.apply(a,_(o,"o",r,1,l[0])),a.push("}"),a}(r,n,t,e,i)):o.push.apply(o,function(r,n,t,e,i){var a=[],o=["od0","od1","ad1"],u=[1,0],s=[1,0],l=[0,1];a.push.apply(a,function(r,n){var t,e=[],i="r"===r[0]?[1,0]:[0,1];n&&e.push("if(B!==1.0){");e.push.apply(e,h(i,"o",r)),t=i[0]?(e.push("for(i=0;i<od0;++i){for(j=0;j<od1;++j){"),["i","j"]):(e.push("for(j=0;j<od1;++j){for(i=0;i<od0;++i){"),["j","i"]);n?e.push.apply(e,p(i,"o",r,"i","j","B*"+g(i,"o",r,"i","j"))):e.push.apply(e,p(i,"o",r,"i","j","0"));e.push.apply(e,_(i,"o",r,0,t[1])),e.push("}"),e.push.apply(e,_(i,"o",r,1,t[0])),e.push("}"),n&&e.push("}");return e}(r,i));for(var f=0;f<3;++f)a.push("for(var i",f,"=",o[f],";i",f,">0;){","var w",f,"=",c,";","if(i",f,"<",c,"){","w",f,"=i",f,";","i",f,"=0;","}else{","i",f,"-=",c,";","}");a.push.apply(a,h(u,"o",r,"i0","i1","w1")),a.push("for(i=0;i<w0;++i){for(j=0;j<w1;++j){var r=0.0;"),a.push.apply(a,h(s,"a",n,"(i0+i)","i2")),a.push.apply(a,h(l,"b",t,"i2","(i1+j)")),a.push("for(k=0;k<w2;++k){"),a.push("r+=",g(s,"a",n,"(i0+i)","(i2+k)"),"*",g(l,"b",t,"(i2+k)","(i1+j)"),";"),a.push.apply(a,_(s,"a",n,0,"(i2+k)")),a.push.apply(a,_(l,"b",t,0,"(i2+k)")),a.push("}");t="r";e&&(t="A*r");return a.push.apply(a,p(u,"o",r,"(i0+i)","(i1+j)",t+"+"+g(u,"o",r,"(i0+i)","(i1+j)"))),a.push.apply(a,_(u,"o",r,0,"(i1+j)")),a.push("}"),a.push.apply(a,_(u,"o",r,1,"(i0+i)")),a.push("}}}}"),a}(r,n,t,e,i));return o.push("}return ",a),new Function(o.join(""))()};var c=32;function u(r,n){return ("native"===n[1]?[r,"d0=",r,".length,",r,"d1=",r,"[0].length,"]:[r,"d0=",r,".shape[0],",r,"d1=",r,".shape[1],",r,"s0=",r,".stride[0],",r,"s1=",r,".stride[1],",r,"o=",r,".offset,",r,"d=",r,".data,"]).join("")}function h(r,n,t,e,i,a){var o=[];return "native"===t[1]?r[0]&&(e?o.push("var ",n,"p=",n,"[",e,"];"):o.push("var ",n,"p=",n,"[0];")):e&&i?a?o.push("var ",n,"t0=",n,"s",r[0],",",n,"t1=",n,"s",r[1],"-",n,"s",r[0],"*",a,",",n,"p=",n,"o+",e,"*",n,"s0+",i,"*",n,"s1;"):o.push("var ",n,"t0=",n,"s",r[0],",",n,"p=",n,"o+",e,"*",n,"s0+",i,"*",n,"s1;"):e?o.push("var ",n,"t0=",n,"s",r[0],",",n,"p=",n,"o+",e,"*",n,"s0;"):i?o.push("var ",n,"t0=",n,"s",r[0],",",n,"p=",n,"o+",i,"*",n,"s1;"):o.push("var ",n,"t0=",n,"s",r[0],",",n,"t1=",n,"s",r[1],"-",n,"s",r[0],"*",n,"d",r[0],",",n,"p=",n,"o;"),o}function _(r,n,t,e,i){var a=[];return "native"===t[1]?r[0]&&1===e&&a.push(n,"p=",n,"[",i,"+1]"):a.push(n,"p+=",n,"t",e,";"),a}function p(r,n,t,e,i,a){var o=[];return "native"===t[1]?r[0]?o.push(n,"p[",i,"]=",a,";"):o.push(n,"[",e,"][",i,"]=",a,";"):"generic"===t[1]?o.push(n,"d.set(",n,"p,",a,");"):o.push(n,"d[",n,"p]=",a,";"),o}function g(r,n,t,e,i){var a=[];return "native"===t[1]?r[0]?a.push(n,"p[",i,"]"):a.push(n,"[",e,"][",i,"]"):"generic"===t[1]?a.push(n,"d.get(",n,"p)"):a.push(n,"d[",n,"p]"),a.join("")}},{}],17:[function(r,n,t){var i=r("cwise-compiler"),e={body:"",args:[],thisVars:[],localVars:[]};function a(r){if(!r)return e;for(var n=0;n<r.args.length;++n){var t=r.args[n];r.args[n]=0===n?{name:t,lvalue:!0,rvalue:!!r.rvalue,count:r.count||1}:{name:t,lvalue:!1,rvalue:!0,count:1};}return r.thisVars||(r.thisVars=[]),r.localVars||(r.localVars=[]),r}function o(r){for(var n,t=[],e=0;e<r.args.length;++e)t.push("a"+e);return new Function("P",["return function ",r.funcName,"_ndarrayops(",t.join(","),") {P(",t.join(","),");return a0}"].join(""))(i({args:(n=r).args,pre:a(n.pre),body:a(n.body),post:a(n.proc),funcName:n.funcName}))}var u={add:"+",sub:"-",mul:"*",div:"/",mod:"%",band:"&",bor:"|",bxor:"^",lshift:"<<",rshift:">>",rrshift:">>>"};!function(){for(var r in u){var n=u[r];t[r]=o({args:["array","array","array"],body:{args:["a","b","c"],body:"a=b"+n+"c"},funcName:r}),t[r+"eq"]=o({args:["array","array"],body:{args:["a","b"],body:"a"+n+"=b"},rvalue:!0,funcName:r+"eq"}),t[r+"s"]=o({args:["array","array","scalar"],body:{args:["a","b","s"],body:"a=b"+n+"s"},funcName:r+"s"}),t[r+"seq"]=o({args:["array","scalar"],body:{args:["a","s"],body:"a"+n+"=s"},rvalue:!0,funcName:r+"seq"});}}();var s={not:"!",bnot:"~",neg:"-",recip:"1.0/"};!function(){for(var r in s){var n=s[r];t[r]=o({args:["array","array"],body:{args:["a","b"],body:"a="+n+"b"},funcName:r}),t[r+"eq"]=o({args:["array"],body:{args:["a"],body:"a="+n+"a"},rvalue:!0,count:2,funcName:r+"eq"});}}();var l={and:"&&",or:"||",eq:"===",neq:"!==",lt:"<",gt:">",leq:"<=",geq:">="};!function(){for(var r in l){var n=l[r];t[r]=o({args:["array","array","array"],body:{args:["a","b","c"],body:"a=b"+n+"c"},funcName:r}),t[r+"s"]=o({args:["array","array","scalar"],body:{args:["a","b","s"],body:"a=b"+n+"s"},funcName:r+"s"}),t[r+"eq"]=o({args:["array","array"],body:{args:["a","b"],body:"a=a"+n+"b"},rvalue:!0,count:2,funcName:r+"eq"}),t[r+"seq"]=o({args:["array","scalar"],body:{args:["a","s"],body:"a=a"+n+"s"},rvalue:!0,count:2,funcName:r+"seq"});}}();var f=["abs","acos","asin","atan","ceil","cos","exp","floor","log","round","sin","sqrt","tan"];!function(){for(var r=0;r<f.length;++r){var n=f[r];t[n]=o({args:["array","array"],pre:{args:[],body:"this_f=Math."+n,thisVars:["this_f"]},body:{args:["a","b"],body:"a=this_f(b)",thisVars:["this_f"]},funcName:n}),t[n+"eq"]=o({args:["array"],pre:{args:[],body:"this_f=Math."+n,thisVars:["this_f"]},body:{args:["a"],body:"a=this_f(a)",thisVars:["this_f"]},rvalue:!0,count:2,funcName:n+"eq"});}}();var c=["max","min","atan2","pow"];!function(){for(var r=0;r<c.length;++r){var n=c[r];t[n]=o({args:["array","array","array"],pre:{args:[],body:"this_f=Math."+n,thisVars:["this_f"]},body:{args:["a","b","c"],body:"a=this_f(b,c)",thisVars:["this_f"]},funcName:n}),t[n+"s"]=o({args:["array","array","scalar"],pre:{args:[],body:"this_f=Math."+n,thisVars:["this_f"]},body:{args:["a","b","c"],body:"a=this_f(b,c)",thisVars:["this_f"]},funcName:n+"s"}),t[n+"eq"]=o({args:["array","array"],pre:{args:[],body:"this_f=Math."+n,thisVars:["this_f"]},body:{args:["a","b"],body:"a=this_f(a,b)",thisVars:["this_f"]},rvalue:!0,count:2,funcName:n+"eq"}),t[n+"seq"]=o({args:["array","scalar"],pre:{args:[],body:"this_f=Math."+n,thisVars:["this_f"]},body:{args:["a","b"],body:"a=this_f(a,b)",thisVars:["this_f"]},rvalue:!0,count:2,funcName:n+"seq"});}}();var h=["atan2","pow"];!function(){for(var r=0;r<h.length;++r){var n=h[r];t[n+"op"]=o({args:["array","array","array"],pre:{args:[],body:"this_f=Math."+n,thisVars:["this_f"]},body:{args:["a","b","c"],body:"a=this_f(c,b)",thisVars:["this_f"]},funcName:n+"op"}),t[n+"ops"]=o({args:["array","array","scalar"],pre:{args:[],body:"this_f=Math."+n,thisVars:["this_f"]},body:{args:["a","b","c"],body:"a=this_f(c,b)",thisVars:["this_f"]},funcName:n+"ops"}),t[n+"opeq"]=o({args:["array","array"],pre:{args:[],body:"this_f=Math."+n,thisVars:["this_f"]},body:{args:["a","b"],body:"a=this_f(b,a)",thisVars:["this_f"]},rvalue:!0,count:2,funcName:n+"opeq"}),t[n+"opseq"]=o({args:["array","scalar"],pre:{args:[],body:"this_f=Math."+n,thisVars:["this_f"]},body:{args:["a","b"],body:"a=this_f(b,a)",thisVars:["this_f"]},rvalue:!0,count:2,funcName:n+"opseq"});}}(),t.any=i({args:["array"],pre:e,body:{args:[{name:"a",lvalue:!1,rvalue:!0,count:1}],body:"if(a){return true}",localVars:[],thisVars:[]},post:{args:[],localVars:[],thisVars:[],body:"return false"},funcName:"any"}),t.all=i({args:["array"],pre:e,body:{args:[{name:"x",lvalue:!1,rvalue:!0,count:1}],body:"if(!x){return false}",localVars:[],thisVars:[]},post:{args:[],localVars:[],thisVars:[],body:"return true"},funcName:"all"}),t.sum=i({args:["array"],pre:{args:[],localVars:[],thisVars:["this_s"],body:"this_s=0"},body:{args:[{name:"a",lvalue:!1,rvalue:!0,count:1}],body:"this_s+=a",localVars:[],thisVars:["this_s"]},post:{args:[],localVars:[],thisVars:["this_s"],body:"return this_s"},funcName:"sum"}),t.prod=i({args:["array"],pre:{args:[],localVars:[],thisVars:["this_s"],body:"this_s=1"},body:{args:[{name:"a",lvalue:!1,rvalue:!0,count:1}],body:"this_s*=a",localVars:[],thisVars:["this_s"]},post:{args:[],localVars:[],thisVars:["this_s"],body:"return this_s"},funcName:"prod"}),t.norm2squared=i({args:["array"],pre:{args:[],localVars:[],thisVars:["this_s"],body:"this_s=0"},body:{args:[{name:"a",lvalue:!1,rvalue:!0,count:2}],body:"this_s+=a*a",localVars:[],thisVars:["this_s"]},post:{args:[],localVars:[],thisVars:["this_s"],body:"return this_s"},funcName:"norm2squared"}),t.norm2=i({args:["array"],pre:{args:[],localVars:[],thisVars:["this_s"],body:"this_s=0"},body:{args:[{name:"a",lvalue:!1,rvalue:!0,count:2}],body:"this_s+=a*a",localVars:[],thisVars:["this_s"]},post:{args:[],localVars:[],thisVars:["this_s"],body:"return Math.sqrt(this_s)"},funcName:"norm2"}),t.norminf=i({args:["array"],pre:{args:[],localVars:[],thisVars:["this_s"],body:"this_s=0"},body:{args:[{name:"a",lvalue:!1,rvalue:!0,count:4}],body:"if(-a>this_s){this_s=-a}else if(a>this_s){this_s=a}",localVars:[],thisVars:["this_s"]},post:{args:[],localVars:[],thisVars:["this_s"],body:"return this_s"},funcName:"norminf"}),t.norm1=i({args:["array"],pre:{args:[],localVars:[],thisVars:["this_s"],body:"this_s=0"},body:{args:[{name:"a",lvalue:!1,rvalue:!0,count:3}],body:"this_s+=a<0?-a:a",localVars:[],thisVars:["this_s"]},post:{args:[],localVars:[],thisVars:["this_s"],body:"return this_s"},funcName:"norm1"}),t.sup=i({args:["array"],pre:{body:"this_h=-Infinity",args:[],thisVars:["this_h"],localVars:[]},body:{body:"if(_inline_1_arg0_>this_h)this_h=_inline_1_arg0_",args:[{name:"_inline_1_arg0_",lvalue:!1,rvalue:!0,count:2}],thisVars:["this_h"],localVars:[]},post:{body:"return this_h",args:[],thisVars:["this_h"],localVars:[]}}),t.inf=i({args:["array"],pre:{body:"this_h=Infinity",args:[],thisVars:["this_h"],localVars:[]},body:{body:"if(_inline_1_arg0_<this_h)this_h=_inline_1_arg0_",args:[{name:"_inline_1_arg0_",lvalue:!1,rvalue:!0,count:2}],thisVars:["this_h"],localVars:[]},post:{body:"return this_h",args:[],thisVars:["this_h"],localVars:[]}}),t.argmin=i({args:["index","array","shape"],pre:{body:"{this_v=Infinity;this_i=_inline_0_arg2_.slice(0)}",args:[{name:"_inline_0_arg0_",lvalue:!1,rvalue:!1,count:0},{name:"_inline_0_arg1_",lvalue:!1,rvalue:!1,count:0},{name:"_inline_0_arg2_",lvalue:!1,rvalue:!0,count:1}],thisVars:["this_i","this_v"],localVars:[]},body:{body:"{if(_inline_1_arg1_<this_v){this_v=_inline_1_arg1_;for(var _inline_1_k=0;_inline_1_k<_inline_1_arg0_.length;++_inline_1_k){this_i[_inline_1_k]=_inline_1_arg0_[_inline_1_k]}}}",args:[{name:"_inline_1_arg0_",lvalue:!1,rvalue:!0,count:2},{name:"_inline_1_arg1_",lvalue:!1,rvalue:!0,count:2}],thisVars:["this_i","this_v"],localVars:["_inline_1_k"]},post:{body:"{return this_i}",args:[],thisVars:["this_i"],localVars:[]}}),t.argmax=i({args:["index","array","shape"],pre:{body:"{this_v=-Infinity;this_i=_inline_0_arg2_.slice(0)}",args:[{name:"_inline_0_arg0_",lvalue:!1,rvalue:!1,count:0},{name:"_inline_0_arg1_",lvalue:!1,rvalue:!1,count:0},{name:"_inline_0_arg2_",lvalue:!1,rvalue:!0,count:1}],thisVars:["this_i","this_v"],localVars:[]},body:{body:"{if(_inline_1_arg1_>this_v){this_v=_inline_1_arg1_;for(var _inline_1_k=0;_inline_1_k<_inline_1_arg0_.length;++_inline_1_k){this_i[_inline_1_k]=_inline_1_arg0_[_inline_1_k]}}}",args:[{name:"_inline_1_arg0_",lvalue:!1,rvalue:!0,count:2},{name:"_inline_1_arg1_",lvalue:!1,rvalue:!0,count:2}],thisVars:["this_i","this_v"],localVars:["_inline_1_k"]},post:{body:"{return this_i}",args:[],thisVars:["this_i"],localVars:[]}}),t.random=o({args:["array"],pre:{args:[],body:"this_f=Math.random",thisVars:["this_f"]},body:{args:["a"],body:"a=this_f()",thisVars:["this_f"]},funcName:"random"}),t.assign=o({args:["array","array"],body:{args:["a","b"],body:"a=b"},funcName:"assign"}),t.assigns=o({args:["array","scalar"],body:{args:["a","b"],body:"a=b"},funcName:"assigns"}),t.equals=i({args:["array","array"],pre:e,body:{args:[{name:"x",lvalue:!1,rvalue:!0,count:1},{name:"y",lvalue:!1,rvalue:!0,count:1}],body:"if(x!==y){return false}",localVars:[],thisVars:[]},post:{args:[],localVars:[],thisVars:[],body:"return true"},funcName:"equals"});},{"cwise-compiler":4}],18:[function(r,n,t){var _=r("iota-array"),l=r("is-buffer"),f="undefined"!=typeof Float64Array;function i(r,n){return r[0]-n[0]}function p(){for(var r=this.stride,n=new Array(r.length),t=0;t<n.length;++t)n[t]=[Math.abs(r[t]),t];n.sort(i);var e=new Array(n.length);for(t=0;t<e.length;++t)e[t]=n[t][1];return e}function c(r,n){var t=["View",n,"d",r].join("");n<0&&(t="View_Nil"+r);var e="generic"===r;if(-1===n){var i="function "+t+"(a){this.data=a;};var proto="+t+".prototype;proto.dtype='"+r+"';proto.index=function(){return -1};proto.size=0;proto.dimension=-1;proto.shape=proto.stride=proto.order=[];proto.lo=proto.hi=proto.transpose=proto.step=function(){return new "+t+"(this.data);};proto.get=proto.set=function(){};proto.pick=function(){return null};return function construct_"+t+"(a){return new "+t+"(a);}";return new Function(i)()}if(0===n){i="function "+t+"(a,d) {this.data = a;this.offset = d};var proto="+t+".prototype;proto.dtype='"+r+"';proto.index=function(){return this.offset};proto.dimension=0;proto.size=1;proto.shape=proto.stride=proto.order=[];proto.lo=proto.hi=proto.transpose=proto.step=function "+t+"_copy() {return new "+t+"(this.data,this.offset)};proto.pick=function "+t+"_pick(){return TrivialArray(this.data);};proto.valueOf=proto.get=function "+t+"_get(){return "+(e?"this.data.get(this.offset)":"this.data[this.offset]")+"};proto.set=function "+t+"_set(v){return "+(e?"this.data.set(this.offset,v)":"this.data[this.offset]=v")+"};return function construct_"+t+"(a,b,c,d){return new "+t+"(a,d)}";return new Function("TrivialArray",i)(g[r][0])}var i=["'use strict'"],a=_(n),o=a.map(function(r){return "i"+r}),u="this.offset+"+a.map(function(r){return "this.stride["+r+"]*i"+r}).join("+"),s=a.map(function(r){return "b"+r}).join(","),l=a.map(function(r){return "c"+r}).join(",");i.push("function "+t+"(a,"+s+","+l+",d){this.data=a","this.shape=["+s+"]","this.stride=["+l+"]","this.offset=d|0}","var proto="+t+".prototype","proto.dtype='"+r+"'","proto.dimension="+n),i.push("Object.defineProperty(proto,'size',{get:function "+t+"_size(){return "+a.map(function(r){return "this.shape["+r+"]"}).join("*"),"}})"),1===n?i.push("proto.order=[0]"):(i.push("Object.defineProperty(proto,'order',{get:"),n<4?(i.push("function "+t+"_order(){"),2===n?i.push("return (Math.abs(this.stride[0])>Math.abs(this.stride[1]))?[1,0]:[0,1]}})"):3===n&&i.push("var s0=Math.abs(this.stride[0]),s1=Math.abs(this.stride[1]),s2=Math.abs(this.stride[2]);if(s0>s1){if(s1>s2){return [2,1,0];}else if(s0>s2){return [1,2,0];}else{return [1,0,2];}}else if(s0>s2){return [2,0,1];}else if(s2>s1){return [0,1,2];}else{return [0,2,1];}}})")):i.push("ORDER})")),i.push("proto.set=function "+t+"_set("+o.join(",")+",v){"),e?i.push("return this.data.set("+u+",v)}"):i.push("return this.data["+u+"]=v}"),i.push("proto.get=function "+t+"_get("+o.join(",")+"){"),e?i.push("return this.data.get("+u+")}"):i.push("return this.data["+u+"]}"),i.push("proto.index=function "+t+"_index(",o.join(),"){return "+u+"}"),i.push("proto.hi=function "+t+"_hi("+o.join(",")+"){return new "+t+"(this.data,"+a.map(function(r){return ["(typeof i",r,"!=='number'||i",r,"<0)?this.shape[",r,"]:i",r,"|0"].join("")}).join(",")+","+a.map(function(r){return "this.stride["+r+"]"}).join(",")+",this.offset)}");e=a.map(function(r){return "a"+r+"=this.shape["+r+"]"}),u=a.map(function(r){return "c"+r+"=this.stride["+r+"]"});i.push("proto.lo=function "+t+"_lo("+o.join(",")+"){var b=this.offset,d=0,"+e.join(",")+","+u.join(","));for(var f=0;f<n;++f)i.push("if(typeof i"+f+"==='number'&&i"+f+">=0){d=i"+f+"|0;b+=c"+f+"*d;a"+f+"-=d}");i.push("return new "+t+"(this.data,"+a.map(function(r){return "a"+r}).join(",")+","+a.map(function(r){return "c"+r}).join(",")+",b)}"),i.push("proto.step=function "+t+"_step("+o.join(",")+"){var "+a.map(function(r){return "a"+r+"=this.shape["+r+"]"}).join(",")+","+a.map(function(r){return "b"+r+"=this.stride["+r+"]"}).join(",")+",c=this.offset,d=0,ceil=Math.ceil");for(f=0;f<n;++f)i.push("if(typeof i"+f+"==='number'){d=i"+f+"|0;if(d<0){c+=b"+f+"*(a"+f+"-1);a"+f+"=ceil(-a"+f+"/d)}else{a"+f+"=ceil(a"+f+"/d)}b"+f+"*=d}");i.push("return new "+t+"(this.data,"+a.map(function(r){return "a"+r}).join(",")+","+a.map(function(r){return "b"+r}).join(",")+",c)}");for(var c=new Array(n),h=new Array(n),f=0;f<n;++f)c[f]="a[i"+f+"]",h[f]="b[i"+f+"]";i.push("proto.transpose=function "+t+"_transpose("+o+"){"+o.map(function(r,n){return r+"=("+r+"===undefined?"+n+":"+r+"|0)"}).join(";"),"var a=this.shape,b=this.stride;return new "+t+"(this.data,"+c.join(",")+","+h.join(",")+",this.offset)}"),i.push("proto.pick=function "+t+"_pick("+o+"){var a=[],b=[],c=this.offset");for(f=0;f<n;++f)i.push("if(typeof i"+f+"==='number'&&i"+f+">=0){c=(c+this.stride["+f+"]*i"+f+")|0}else{a.push(this.shape["+f+"]);b.push(this.stride["+f+"])}");return i.push("var ctor=CTOR_LIST[a.length+1];return ctor(this.data,a,b,c)}"),i.push("return function construct_"+t+"(data,shape,stride,offset){return new "+t+"(data,"+a.map(function(r){return "shape["+r+"]"}).join(",")+","+a.map(function(r){return "stride["+r+"]"}).join(",")+",offset)}"),new Function("CTOR_LIST","ORDER",i.join("\n"))(g[r],p)}var g={float32:[],float64:[],int8:[],int16:[],int32:[],uint8:[],uint16:[],uint32:[],array:[],uint8_clamped:[],buffer:[],generic:[]};n.exports=function(r,n,t,e){if(void 0===r)return (0, g.array[0])([]);"number"==typeof r&&(r=[r]);var i=(n=void 0===n?[r.length]:n).length;if(void 0===t){t=new Array(i);for(var a=i-1,o=1;0<=a;--a)t[a]=o,o*=n[a];}if(void 0===e)for(a=e=0;a<i;++a)t[a]<0&&(e-=(n[a]-1)*t[a]);for(var u=function(r){if(l(r))return "buffer";if(f)switch(Object.prototype.toString.call(r)){case"[object Float64Array]":return "float64";case"[object Float32Array]":return "float32";case"[object Int8Array]":return "int8";case"[object Int16Array]":return "int16";case"[object Int32Array]":return "int32";case"[object Uint8Array]":return "uint8";case"[object Uint16Array]":return "uint16";case"[object Uint32Array]":return "uint32";case"[object Uint8ClampedArray]":return "uint8_clamped"}return Array.isArray(r)?"array":"generic"}(r),s=g[u];s.length<=i+1;)s.push(c(u,s.length-1));return (0, s[i+1])(r,n,t,e)};},{"iota-array":10,"is-buffer":11}],19:[function(r,n,l){!function(i){function a(r,n){for(var t=0,e=r.length-1;0<=e;e--){var i=r[e];"."===i?r.splice(e,1):".."===i?(r.splice(e,1),t++):t&&(r.splice(e,1),t--);}if(n)for(;t--;)r.unshift("..");return r}function t(r){return n.exec(r).slice(1)}var n=/^(\/?|)([\s\S]*?)((?:\.{1,2}|[^\/]+?|)(\.[^.\/]*|))(?:[\/]*)$/;function o(r,n){if(r.filter)return r.filter(n);for(var t=[],e=0;e<r.length;e++)n(r[e],e,r)&&t.push(r[e]);return t}l.resolve=function(){for(var r="",n=!1,t=arguments.length-1;-1<=t&&!n;t--){var e=0<=t?arguments[t]:i.cwd();if("string"!=typeof e)throw new TypeError("Arguments to path.resolve must be strings");e&&(r=e+"/"+r,n="/"===e.charAt(0));}return (n?"/":"")+(r=a(o(r.split("/"),function(r){return !!r}),!n).join("/"))||"."},l.normalize=function(r){var n=l.isAbsolute(r),t="/"===e(r,-1);return (r=!(r=a(o(r.split("/"),function(r){return !!r}),!n).join("/"))&&!n?".":r)&&t&&(r+="/"),(n?"/":"")+r},l.isAbsolute=function(r){return "/"===r.charAt(0)},l.join=function(){var r=Array.prototype.slice.call(arguments,0);return l.normalize(o(r,function(r,n){if("string"!=typeof r)throw new TypeError("Arguments to path.join must be strings");return r}).join("/"))},l.relative=function(r,n){function t(r){for(var n=0;n<r.length&&""===r[n];n++);for(var t=r.length-1;0<=t&&""===r[t];t--);return t<n?[]:r.slice(n,t-n+1)}r=l.resolve(r).substr(1),n=l.resolve(n).substr(1);for(var e=t(r.split("/")),i=t(n.split("/")),a=Math.min(e.length,i.length),o=a,u=0;u<a;u++)if(e[u]!==i[u]){o=u;break}for(var s=[],u=o;u<e.length;u++)s.push("..");return (s=s.concat(i.slice(o))).join("/")},l.sep="/",l.delimiter=":",l.dirname=function(r){var n=t(r),r=n[0],n=n[1];return r||n?r+(n=n&&n.substr(0,n.length-1)):"."},l.basename=function(r,n){r=t(r)[2];return r=n&&r.substr(-1*n.length)===n?r.substr(0,r.length-n.length):r},l.extname=function(r){return t(r)[3]};var e="b"==="ab".substr(-1)?function(r,n,t){return r.substr(n,t)}:function(r,n,t){return n<0&&(n=r.length+n),r.substr(n,t)};}.call(this,r("_process"));},{_process:20}],20:[function(r,n,t){var e,i,n=n.exports={};function a(){throw new Error("setTimeout has not been defined")}function o(){throw new Error("clearTimeout has not been defined")}function u(n){if(e===setTimeout)return setTimeout(n,0);if((e===a||!e)&&setTimeout)return e=setTimeout,setTimeout(n,0);try{return e(n,0)}catch(r){try{return e.call(null,n,0)}catch(r){return e.call(this,n,0)}}}!function(){try{e="function"==typeof setTimeout?setTimeout:a;}catch(r){e=a;}try{i="function"==typeof clearTimeout?clearTimeout:o;}catch(r){i=o;}}();var s,l=[],f=!1,c=-1;function h(){f&&s&&(f=!1,s.length?l=s.concat(l):c=-1,l.length&&_());}function _(){if(!f){var r=u(h);f=!0;for(var n=l.length;n;){for(s=l,l=[];++c<n;)s&&s[c].run();c=-1,n=l.length;}s=null,f=!1,function(n){if(i===clearTimeout)return clearTimeout(n);if((i===o||!i)&&clearTimeout)return i=clearTimeout,clearTimeout(n);try{i(n);}catch(r){try{return i.call(null,n)}catch(r){return i.call(this,n)}}}(r);}}function p(r,n){this.fun=r,this.array=n;}function g(){}n.nextTick=function(r){var n=new Array(arguments.length-1);if(1<arguments.length)for(var t=1;t<arguments.length;t++)n[t-1]=arguments[t];l.push(new p(r,n)),1!==l.length||f||u(_);},p.prototype.run=function(){this.fun.apply(null,this.array);},n.title="browser",n.browser=!0,n.env={},n.argv=[],n.version="",n.versions={},n.on=g,n.addListener=g,n.once=g,n.off=g,n.removeListener=g,n.removeAllListeners=g,n.emit=g,n.prependListener=g,n.prependOnceListener=g,n.listeners=function(r){return []},n.binding=function(r){throw new Error("process.binding is not supported")},n.cwd=function(){return "/"},n.chdir=function(r){throw new Error("process.chdir is not supported")},n.umask=function(){return 0};},{}],21:[function(m,r,A){!function(r,t){var e=m("bit-twiddle"),n=m("dup");r.__TYPEDARRAY_POOL||(r.__TYPEDARRAY_POOL={UINT8:n([32,0]),UINT16:n([32,0]),UINT32:n([32,0]),INT8:n([32,0]),INT16:n([32,0]),INT32:n([32,0]),FLOAT:n([32,0]),DOUBLE:n([32,0]),DATA:n([32,0]),UINT8C:n([32,0]),BUFFER:n([32,0])});var i="undefined"!=typeof Uint8ClampedArray,a=r.__TYPEDARRAY_POOL;a.UINT8C||(a.UINT8C=n([32,0])),a.BUFFER||(a.BUFFER=n([32,0]));var o=a.DATA,u=a.BUFFER;function s(r){var n;r&&(n=r.length||r.byteLength,n=e.log2(n),o[n].push(r));}function l(r){var r=e.nextPow2(r),n=e.log2(r),n=o[n];return 0<n.length?n.pop():new ArrayBuffer(r)}function f(r){return new Uint8Array(l(r),0,r)}function c(r){return new Uint16Array(l(2*r),0,r)}function h(r){return new Uint32Array(l(4*r),0,r)}function _(r){return new Int8Array(l(r),0,r)}function p(r){return new Int16Array(l(2*r),0,r)}function g(r){return new Int32Array(l(4*r),0,r)}function y(r){return new Float32Array(l(4*r),0,r)}function v(r){return new Float64Array(l(8*r),0,r)}function d(r){return i?new Uint8ClampedArray(l(r),0,r):f(r)}function b(r){return new DataView(l(r),0,r)}function w(r){r=e.nextPow2(r);var n=e.log2(r),n=u[n];return 0<n.length?n.pop():new t(r)}A.free=function(r){var n;t.isBuffer(r)?u[e.log2(r.length)].push(r):(r="[object ArrayBuffer]"!==Object.prototype.toString.call(r)?r.buffer:r)&&(n=r.length||r.byteLength,n=0|e.log2(n),o[n].push(r));},A.freeUint8=A.freeUint16=A.freeUint32=A.freeInt8=A.freeInt16=A.freeInt32=A.freeFloat32=A.freeFloat=A.freeFloat64=A.freeDouble=A.freeUint8Clamped=A.freeDataView=function(r){s(r.buffer);},A.freeArrayBuffer=s,A.freeBuffer=function(r){u[e.log2(r.length)].push(r);},A.malloc=function(r,n){if(void 0===n||"arraybuffer"===n)return l(r);switch(n){case"uint8":return f(r);case"uint16":return c(r);case"uint32":return h(r);case"int8":return _(r);case"int16":return p(r);case"int32":return g(r);case"float":case"float32":return y(r);case"double":case"float64":return v(r);case"uint8_clamped":return d(r);case"buffer":return w(r);case"data":case"dataview":return b(r);default:return null}return null},A.mallocArrayBuffer=l,A.mallocUint8=f,A.mallocUint16=c,A.mallocUint32=h,A.mallocInt8=_,A.mallocInt16=p,A.mallocInt32=g,A.mallocFloat32=A.mallocFloat=y,A.mallocFloat64=A.mallocDouble=v,A.mallocUint8Clamped=d,A.mallocDataView=b,A.mallocBuffer=w,A.clearCache=function(){for(var r=0;r<32;++r)a.UINT8[r].length=0,a.UINT16[r].length=0,a.UINT32[r].length=0,a.INT8[r].length=0,a.INT16[r].length=0,a.INT32[r].length=0,a.FLOAT[r].length=0,a.DOUBLE[r].length=0,a.UINT8C[r].length=0,o[r].length=0,u[r].length=0;};}.call(this,"undefined"!=typeof global?global:"undefined"!=typeof self?self:"undefined"!=typeof window?window:{},m("buffer").Buffer);},{"bit-twiddle":2,buffer:3,dup:8}],22:[function(r,n,t){n.exports=function(r,n,t){return 0===r.length?r:n?(t||r.sort(n),function(r,n){for(var t,e=1,i=r.length,a=r[0],o=(r[0],1);o<i;++o)t=a,n(a=r[o],t)&&(o!==e?r[e++]=a:e++);return r.length=e,r}(r,n)):(t||r.sort(),function(r){for(var n=1,t=r.length,e=r[0],i=r[0],a=1;a<t;++a,i=e)i=e,(e=r[a])!==i&&(a!==n?r[n++]=e:n++);return r.length=n,r}(r))};},{}],23:[function(r,n,t){n.exports={printThreshold:7,nFloatingValues:5};},{}],24:[function(r,n,t){n.exports={int8:Int8Array,int16:Int16Array,int32:Int32Array,uint8:Uint8Array,uint16:Uint16Array,uint32:Uint32Array,float32:Float32Array,float64:Float64Array,array:Array};},{}],25:[function(r,n,t){n.exports={ValueError:function(){var r=Error.apply(this,arguments);return r.name=this.constructor.name,r},ConfigError:function(){var r=Error.apply(this,arguments);return r.name=this.constructor.name,r},NotImplementedError:function(){var r=Error.apply(this,arguments);return r.name=this.constructor.name,r}};},{}],26:[function(r,n,t){n.exports=function(r,n,t,e,i){var a=n-1,o=n+e-1,u=r-1,s=r+t-1;return 0!==n&&0!==r?i.selection.get(u,a)-i.selection.get(s,a)-i.selection.get(u,o)+i.selection.get(s,o):0===n&&0===r?i.selection.get(r+t-1,n+e-1):0===n?-i.selection.get(u,n+e-1)+i.selection.get(r+t-1,n+e-1):-i.selection.get(s,a)+i.selection.get(s,o)};},{}],27:[function(r,n,t){var a=r("./area-sum");n.exports=function(r,n,t,e,i){return a(r,n,t,e,i)/(t*e)};},{"./area-sum":26}],28:[function(a,o,r){!function(r){var n=a("path"),t=a("./read"),e=n.join(n.resolve(r),"../../data");function i(r){return t(n.join(e,r))}r={};Object.defineProperty(r,"digit",{get:function(){return i("five.png")}}),Object.defineProperty(r,"five",{get:function(){return i("five.png")}}),Object.defineProperty(r,"node",{get:function(){return i("nodejs.png")}}),Object.defineProperty(r,"lena",{get:function(){return i("lenna.png")}}),Object.defineProperty(r,"lenna",{get:function(){return i("lenna.png")}}),Object.defineProperty(r,"moon",{get:function(){return i("moon.jpg")}}),o.exports=r;}.call(this,"/src/images");},{"./read":32,path:19}],29:[function(r,n,t){var e=r("../ndarray");n.exports=function(r){return new e(r.selection.step(null,-1))};},{"../ndarray":42}],30:[function(r,n,t){n.exports={data:r("./data"),read:r("./read"),save:r("./save"),resize:r("./resize"),sat:r("./sat"),ssat:r("./ssat"),sobel:r("./sobel"),scharr:r("./scharr"),areaSum:r("./area-sum"),areaValue:r("./area-value"),rgb2gray:r("./rgb2gray"),flip:r("./flip")};},{"./area-sum":26,"./area-value":27,"./data":28,"./flip":29,"./read":32,"./resize":33,"./rgb2gray":34,"./sat":35,"./save":36,"./scharr":37,"./sobel":38,"./ssat":39}],31:[function(r,n,t){var e=r("../ndarray"),i=r("cwise/lib/wrapper")({args:["array","array","array"],pre:{body:"{this_isgray=!0}",args:[],thisVars:["this_isgray"],localVars:[]},body:{body:"{_inline_82_arg0_===_inline_82_arg1_&&_inline_82_arg1_===_inline_82_arg2_||(this_isgray=!1)}",args:[{name:"_inline_82_arg0_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_82_arg1_",lvalue:!1,rvalue:!0,count:2},{name:"_inline_82_arg2_",lvalue:!1,rvalue:!0,count:1}],thisVars:["this_isgray"],localVars:[]},post:{body:"{return this_isgray}",args:[],thisVars:["this_isgray"],localVars:[]},debug:!1,funcName:"doCheckIsGrayscaleCwise",blockSize:64});n.exports=function(r){var n=(r=r instanceof e?r.selection:r).shape;return 1!==n.length&&(2===n.length||3===n.length&&1===n[2]||3===n.length&&(3===n[2]||4===n[2])&&i(r.pick(null,null,0),r.pick(null,null,1),r.pick(null,null,2)))};},{"../ndarray":42,"cwise/lib/wrapper":7}],32:[function(r,n,t){var e=r("ndarray"),i=r("../ndarray"),a=r("../errors"),o=r("./is-grayscale");n.exports=function(r){if(r instanceof HTMLCanvasElement)return function(r){var n=r.getContext("2d").getImageData(0,0,r.width,r.height),t=[r.width,r.height,4],r=[4,4*r.width,1],r=e(new Uint8Array(n.data),t,r,0).transpose(1,0);o(r)&&(r=r.pick(null,null,0));return new i(r)}(r);if(r instanceof HTMLImageElement)return function(r){var n=document.createElement("canvas");n.width=r.width,n.height=r.height;var t=n.getContext("2d");t.drawImage(r,0,0);n=t.getImageData(0,0,r.width,r.height),t=[r.width,r.height,4],r=[4,4*r.width,1],r=e(new Uint8Array(n.data),t,r,0).transpose(1,0);o(r)&&(r=r.pick(null,null,0));return new i(r)}(r);throw new a.ValueError("expect input to be either an HTML Canvas or a (loaded) Image")};},{"../errors":25,"../ndarray":42,"./is-grayscale":31,ndarray:18}],33:[function(r,n,t){var h=r("./utils"),_=r("ndarray"),p=r("../ndarray");n.exports=function(r,n,t){var e=r.shape,i=e[0],a=e[1],o=e[2]||1,u=document.createElement("canvas");u.height=i,u.width=a;var s=u.getContext("2d"),l=s.createImageData(a,i),f=h.setRawData(r.selection,l.data);if(f)throw f;var c=Math.min(i/n,a/t),r=n*c,f=t*c,i=(i-c*n)/2,c=(a-c*t)/2;s.putImageData(l,0,0),s.drawImage(u,c,i,f,r,0,0,t,n);s=s.getImageData(0,0,t,n),n=[0|t,0|n,4],t=[4,4*t|0,1],t=_(new Uint8Array(s.data),n,t,0).transpose(1,0);return (2===e.length||3===e.length&&1===o)&&(t=t.pick(null,null,0)),new p(t)};},{"../ndarray":42,"./utils":40,ndarray:18}],34:[function(r,n,t){var i=r("../ndarray"),a=r("../utils"),o=r("cwise/lib/wrapper")({args:["array","array","array","array"],pre:{body:"{}",args:[],thisVars:[],localVars:[]},body:{body:"{_inline_79_arg0_=4899*_inline_79_arg1_+9617*_inline_79_arg2_+1868*_inline_79_arg3_+8192>>14}",args:[{name:"_inline_79_arg0_",lvalue:!0,rvalue:!1,count:1},{name:"_inline_79_arg1_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_79_arg2_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_79_arg3_",lvalue:!1,rvalue:!0,count:1}],thisVars:[],localVars:[]},post:{body:"{}",args:[],thisVars:[],localVars:[]},debug:!1,funcName:"rgb2grayCwise",blockSize:64});n.exports=function(r){var n=(r=!(r instanceof i)?new i(r):r).shape,t=n[0],e=n[1];if(1===(n[2]||1))return r;n=[t,e],t=new i(new Uint8Array(a.shapeSize(n)),n),e=r.selection.pick(null,null,0),n=r.selection.pick(null,null,1),r=r.selection.pick(null,null,2);return o(t.selection,e,n,r),t};},{"../ndarray":42,"../utils":43,"cwise/lib/wrapper":7}],35:[function(r,n,t){var e=r("../ndarray"),i=r("./rgb2gray"),a=r("cwise/lib/wrapper")({args:["array","array","index",{offset:[-1,-1],array:0},{offset:[-1,0],array:0},{offset:[0,-1],array:0}],pre:{body:"{}",args:[],thisVars:[],localVars:[]},body:{body:"{_inline_67_arg0_=0!==_inline_67_arg2_[0]&&0!==_inline_67_arg2_[1]?_inline_67_arg1_+_inline_67_arg4_+_inline_67_arg5_-_inline_67_arg3_:0===_inline_67_arg2_[0]&&0===_inline_67_arg2_[1]?_inline_67_arg1_:0===_inline_67_arg2_[0]?_inline_67_arg1_+_inline_67_arg5_:_inline_67_arg1_+_inline_67_arg4_}",args:[{name:"_inline_67_arg0_",lvalue:!0,rvalue:!1,count:1},{name:"_inline_67_arg1_",lvalue:!1,rvalue:!0,count:4},{name:"_inline_67_arg2_",lvalue:!1,rvalue:!0,count:5},{name:"_inline_67_arg3_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_67_arg4_",lvalue:!1,rvalue:!0,count:2},{name:"_inline_67_arg5_",lvalue:!1,rvalue:!0,count:2}],thisVars:[],localVars:[]},post:{body:"{}",args:[],thisVars:[],localVars:[]},debug:!1,funcName:"doIntegrateBody",blockSize:64});n.exports=function(r){var n=i(r),t=n.shape,r=t[0],t=t[1],t=new e(new Uint32Array(r*t),[r,t]);return a(t.selection,n.selection),t};},{"../ndarray":42,"./rgb2gray":34,"cwise/lib/wrapper":7}],36:[function(r,n,t){var u=r("./utils"),s=r("../errors");n.exports=function(r,n){var t=r.shape,e=t[0],i=t[1];if(!(n instanceof HTMLCanvasElement))throw new s.ValueError("expect input to be either an HTML Canvas or a (loaded) Image");var a=document.createElement("canvas");a.height=e,a.width=i;var o=a.getContext("2d"),t=o.createImageData(i,e),r=u.setRawData(r.selection,t.data);if(r)throw r;o.putImageData(t,0,0),o.drawImage(a,i,e),n.getContext("2d").drawImage(a,0,0,i,e,0,0,n.width,n.height);};},{"../errors":25,"./utils":40}],37:[function(r,n,t){var i=r("ndarray-ops"),a=r("../ndarray"),o=r("../utils"),u=r("./rgb2gray"),s=r("cwise/lib/wrapper")({args:["array","array",{offset:[-1,-1],array:1},{offset:[-1,0],array:1},{offset:[-1,1],array:1},{offset:[0,-1],array:1},{offset:[0,1],array:1},{offset:[1,-1],array:1},{offset:[1,0],array:1},{offset:[1,1],array:1}],pre:{body:"{}",args:[],thisVars:[],localVars:[]},body:{body:"{var _inline_76_q=3*_inline_76_arg2_+10*_inline_76_arg3_+3*_inline_76_arg4_-3*_inline_76_arg7_-10*_inline_76_arg8_-3*_inline_76_arg9_,_inline_76_s=3*_inline_76_arg2_-3*_inline_76_arg4_+10*_inline_76_arg5_-10*_inline_76_arg6_+3*_inline_76_arg7_-3*_inline_76_arg9_;_inline_76_arg0_=Math.sqrt(_inline_76_s*_inline_76_s+_inline_76_q*_inline_76_q)}",args:[{name:"_inline_76_arg0_",lvalue:!0,rvalue:!1,count:1},{name:"_inline_76_arg1_",lvalue:!1,rvalue:!1,count:0},{name:"_inline_76_arg2_",lvalue:!1,rvalue:!0,count:2},{name:"_inline_76_arg3_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_76_arg4_",lvalue:!1,rvalue:!0,count:2},{name:"_inline_76_arg5_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_76_arg6_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_76_arg7_",lvalue:!1,rvalue:!0,count:2},{name:"_inline_76_arg8_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_76_arg9_",lvalue:!1,rvalue:!0,count:2}],thisVars:[],localVars:["_inline_76_q","_inline_76_s"]},post:{body:"{}",args:[],thisVars:[],localVars:[]},debug:!1,funcName:"doSobelBody",blockSize:64});n.exports=function(r){var n=u(r),t=n.shape,e=t[0],r=t[1],t=new a(new Float32Array(o.shapeSize(t)),t);return s(t.selection,n.selection),i.assigns(t.selection.pick(0,null),0),i.assigns(t.selection.pick(null,0),0),i.assigns(t.selection.pick(e-1,null),0),i.assigns(t.selection.pick(null,r-1),0),t.divide(16*Math.sqrt(2),!1)};},{"../ndarray":42,"../utils":43,"./rgb2gray":34,"cwise/lib/wrapper":7,"ndarray-ops":17}],38:[function(r,n,t){var i=r("ndarray-ops"),a=r("../ndarray"),o=r("../utils"),u=r("./rgb2gray"),s=r("cwise/lib/wrapper")({args:["array","array",{offset:[-1,-1],array:1},{offset:[-1,0],array:1},{offset:[-1,1],array:1},{offset:[0,-1],array:1},{offset:[0,1],array:1},{offset:[1,-1],array:1},{offset:[1,0],array:1},{offset:[1,1],array:1}],pre:{body:"{}",args:[],thisVars:[],localVars:[]},body:{body:"{var _inline_70_q=_inline_70_arg2_+2*_inline_70_arg3_+_inline_70_arg4_-_inline_70_arg7_-2*_inline_70_arg8_-_inline_70_arg9_,_inline_70_s=_inline_70_arg2_-_inline_70_arg4_+2*_inline_70_arg5_-2*_inline_70_arg6_+_inline_70_arg7_-_inline_70_arg9_;_inline_70_arg0_=Math.sqrt(_inline_70_s*_inline_70_s+_inline_70_q*_inline_70_q)}",args:[{name:"_inline_70_arg0_",lvalue:!0,rvalue:!1,count:1},{name:"_inline_70_arg1_",lvalue:!1,rvalue:!1,count:0},{name:"_inline_70_arg2_",lvalue:!1,rvalue:!0,count:2},{name:"_inline_70_arg3_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_70_arg4_",lvalue:!1,rvalue:!0,count:2},{name:"_inline_70_arg5_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_70_arg6_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_70_arg7_",lvalue:!1,rvalue:!0,count:2},{name:"_inline_70_arg8_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_70_arg9_",lvalue:!1,rvalue:!0,count:2}],thisVars:[],localVars:["_inline_70_q","_inline_70_s"]},post:{body:"{}",args:[],thisVars:[],localVars:[]},debug:!1,funcName:"doSobelBody",blockSize:64});n.exports=function(r){var n=u(r),t=n.shape,e=t[0],r=t[1],t=new a(new Float32Array(o.shapeSize(t)),t);return s(t.selection,n.selection),i.assigns(t.selection.pick(0,null),0),i.assigns(t.selection.pick(null,0),0),i.assigns(t.selection.pick(e-1,null),0),i.assigns(t.selection.pick(null,r-1),0),t.divide(4*Math.sqrt(2),!1)};},{"../ndarray":42,"../utils":43,"./rgb2gray":34,"cwise/lib/wrapper":7,"ndarray-ops":17}],39:[function(r,n,t){var e=r("../ndarray"),i=r("./rgb2gray"),a=r("cwise/lib/wrapper")({args:["array","array","index",{offset:[-1,-1],array:0},{offset:[-1,0],array:0},{offset:[0,-1],array:0}],pre:{body:"{}",args:[],thisVars:[],localVars:[]},body:{body:"{_inline_73_arg0_=0!==_inline_73_arg2_[0]&&0!==_inline_73_arg2_[1]?_inline_73_arg1_*_inline_73_arg1_+_inline_73_arg4_+_inline_73_arg5_-_inline_73_arg3_:0===_inline_73_arg2_[0]&&0===_inline_73_arg2_[1]?_inline_73_arg1_*_inline_73_arg1_:0===_inline_73_arg2_[0]?_inline_73_arg1_*_inline_73_arg1_+_inline_73_arg5_:_inline_73_arg1_*_inline_73_arg1_+_inline_73_arg4_}",args:[{name:"_inline_73_arg0_",lvalue:!0,rvalue:!1,count:1},{name:"_inline_73_arg1_",lvalue:!1,rvalue:!0,count:8},{name:"_inline_73_arg2_",lvalue:!1,rvalue:!0,count:5},{name:"_inline_73_arg3_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_73_arg4_",lvalue:!1,rvalue:!0,count:2},{name:"_inline_73_arg5_",lvalue:!1,rvalue:!0,count:2}],thisVars:[],localVars:[]},post:{body:"{}",args:[],thisVars:[],localVars:[]},debug:!1,funcName:"doIntegrateBody",blockSize:64});n.exports=function(r){var n=i(r),t=n.shape,r=t[0],t=t[1],t=new e(new Uint32Array(r*t),[r,t]);return a(t.selection,n.selection),t};},{"../ndarray":42,"./rgb2gray":34,"cwise/lib/wrapper":7}],40:[function(r,n,t){var s=r("../ndarray");n.exports.getRawData=function(r){var n,t,e=0,i=(r=r instanceof s?r.selection:r).shape,a=i[0],o=i[1],i=i[2]||1,u=new Uint8Array(a*o*i);if(3===r.shape.length)if(3===i)for(n=0;n<a;++n)for(t=0;t<o;++t)u[e++]=r.get(n,t,0),u[e++]=r.get(n,t,1),u[e++]=r.get(n,t,2);else if(4===i)for(n=0;n<a;++n)for(t=0;t<o;++t)u[e++]=r.get(n,t,0),u[e++]=r.get(n,t,1),u[e++]=r.get(n,t,2),u[e++]=r.get(n,t,3);else {if(1!==i)return new Error("Incompatible array shape");for(n=0;n<a;++n)for(t=0;t<o;++t)u[e++]=r.get(n,t,0);}else {if(2!==r.shape.length)return new Error("Invalid image");for(n=0;n<a;++n)for(t=0;t<o;++t)u[e++]=r.get(n,t);}return u},n.exports.setRawData=function(r,n){var t,e,i,a=0,o=r.shape[0],u=r.shape[1],s=r.shape[2]||1;if(3===r.shape.length)if(3===s)for(t=0;t<o;++t)for(e=0;e<u;++e)n[a++]=r.get(t,e,0),n[a++]=r.get(t,e,1),n[a++]=r.get(t,e,2),n[a++]=255;else if(4===s)for(t=0;t<o;++t)for(e=0;e<u;++e)n[a++]=r.get(t,e,0),n[a++]=r.get(t,e,1),n[a++]=r.get(t,e,2),n[a++]=r.get(t,e,3);else {if(1!==s)return new Error("Incompatible array shape");for(t=0;t<o;++t)for(e=0;e<u;++e)i=r.get(t,e,0),n[a++]=i,n[a++]=i,n[a++]=i,n[a++]=255;}else {if(2!==r.shape.length)return new Error("Invalid image");for(t=0;t<o;++t)for(e=0;e<u;++e)i=r.get(t,e),n[a++]=i,n[a++]=i,n[a++]=i,n[a++]=255;}};},{"../ndarray":42}],41:[function(r,n,t){var e=r("ndarray"),i=r("ndarray-ops"),a=r("ndarray-fft"),o=r("./config"),u=r("./dtypes"),f=r("./ndarray"),c=r("./utils"),h=r("./errors");function s(r,n){return f.new(r).mod(n)}function l(r,n){return f.new(r).transpose(n)}function _(r,n,t,e){if(1===arguments.length)return _(0,r,1,void 0);if(2===arguments.length&&c.isNumber(n))return _(r,n,1,void 0);if(2===arguments.length)return _(0,r,1,n);if(3===arguments.length&&!c.isNumber(t))return _(r,n,1,t);for(var i=[],a=0;r<n;)i[a++]=r,r+=t;return f.new(i,e)}function p(r,n){c.isNumber(r)&&0<=r&&(r=[r]);var t=c.shapeSize(r),n=c.getType(n),r=new f(new n(t),r);return "array"===r.dtype&&i.assigns(r.selection,0),r}function g(r,n){c.isNumber(r)&&0<=r&&(r=[r]);var t=c.shapeSize(r),n=c.getType(n),r=new f(new n(t),r);return i.assigns(r.selection,1),r}var y=r("cwise/lib/wrapper")({args:["array","scalar"],pre:{body:"{}",args:[],thisVars:[],localVars:[]},body:{body:"{_inline_43_arg0_=_inline_43_arg0_<-30?0:_inline_43_arg0_>30?1:1/(1+Math.exp(-1*_inline_43_arg1_*_inline_43_arg0_))}",args:[{name:"_inline_43_arg0_",lvalue:!0,rvalue:!0,count:4},{name:"_inline_43_arg1_",lvalue:!1,rvalue:!0,count:1}],thisVars:[],localVars:[]},post:{body:"{}",args:[],thisVars:[],localVars:[]},debug:!1,funcName:"sigmoidCwise",blockSize:64});var v=r("cwise/lib/wrapper")({args:["array","scalar","scalar"],pre:{body:"{}",args:[],thisVars:[],localVars:[]},body:{body:"{_inline_46_arg0_=Math.min(Math.max(_inline_46_arg1_,_inline_46_arg0_),_inline_46_arg2_)}",args:[{name:"_inline_46_arg0_",lvalue:!0,rvalue:!0,count:2},{name:"_inline_46_arg1_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_46_arg2_",lvalue:!1,rvalue:!0,count:1}],thisVars:[],localVars:[]},post:{body:"{}",args:[],thisVars:[],localVars:[]},debug:!1,funcName:"clipCwise",blockSize:64});var d=r("cwise/lib/wrapper")({args:["array","scalar"],pre:{body:"{}",args:[],thisVars:[],localVars:[]},body:{body:"{_inline_49_arg0_=Math.max(_inline_49_arg1_*_inline_49_arg0_,_inline_49_arg0_)}",args:[{name:"_inline_49_arg0_",lvalue:!0,rvalue:!0,count:3},{name:"_inline_49_arg1_",lvalue:!1,rvalue:!0,count:1}],thisVars:[],localVars:[]},post:{body:"{}",args:[],thisVars:[],localVars:[]},debug:!1,funcName:"leakyReluCwise",blockSize:64});var b=r("cwise/lib/wrapper")({args:["array"],pre:{body:"{}",args:[],thisVars:[],localVars:[]},body:{body:"{_inline_52_arg0_=(Math.exp(2*_inline_52_arg0_)-1)/(Math.exp(2*_inline_52_arg0_)+1)}",args:[{name:"_inline_52_arg0_",lvalue:!0,rvalue:!0,count:3}],thisVars:[],localVars:[]},post:{body:"{}",args:[],thisVars:[],localVars:[]},debug:!1,funcName:"tanhCwise",blockSize:64});function w(r){r=r instanceof f?r.clone():f.new(r);return i.abseq(r.selection),r}function m(r){for(1<arguments.length&&(r=[].slice.call(arguments)),t=0;t<r.length;t++)e=r[t],r[t]=e instanceof f?e.tolist():c.isNumber(e)?[e]:e;for(var n=r[0],t=1;t<r.length;t++){var e=r[t],i=c.getShape(n),a=c.getShape(e);if(i.length!==a.length)throw new h.ValueError("all the input arrays must have same number of dimensions");if(1===i.length&&1===a.length)n=n.concat(e);else if(2===i.length&&2===a.length&&i[0]===a[0]||1===i.length&&2===a.length&&i[0]===a[0]||2===i.length&&1===a.length&&i[0]===a[0])for(var o=0;o<i[0];o++)n[o]=n[o].concat(e[o]);else {if(!(3===i.length&&3===a.length&&i[0]===a[0]&&i[1]===a[1]||2===i.length&&3===a.length&&i[0]===a[0]&&i[1]===a[1]||3===i.length&&2===a.length&&i[0]===a[0]&&i[1]===a[1]))throw new h.ValueError('cannot concatenate  "'+i+'" with "'+a+'"');for(var u=0;u<i[0];u++){for(var s=new Array(i[1]),l=0;l<i[1];l++)s[l]=n[u][l].concat(e[u][l]);n[u]=s;}}}return f.new(n,r[0].dtype)}function A(r,n){for(var t=g((r=f.new(r)).ndim).tolist(),e=n;e<0;)e+=r.ndim;if(void 0===t[e])throw new h.ValueError("axis="+n+"invalid for the "+r.ndim+"-dimensional input array");return t[e]=-1,r.step.apply(r,t)}n.exports={config:o,dtypes:u,NdArray:f,ndarray:e,array:f.new,arange:_,reshape:function(r,n){return f.new(r).reshape(n)},zeros:p,ones:g,empty:function(r,n){c.isNumber(r)&&0<=r&&(r=[r]);var t=c.shapeSize(r),n=c.getType(n);return new f(new n(t),r)},flatten:function(r){return f.new(r).flatten()},flip:A,random:function(r){if(0===arguments.length)return f.new(Math.random());r=1===arguments.length?c.isNumber(r)?[0|r]:r:[].slice.call(arguments);var n=c.shapeSize(r),r=new f(new Float64Array(n),r);return i.random(r.selection),r},softmax:function(r){var n=f.new(r).exp(),r=n.sum();return i.divseq(n.selection,r),n},sigmoid:function(r,n){return r=f.new(r).clone(),y(r.selection,n=n||1),r},leakyRelu:function(r,n){return n=n||.001,r=r instanceof f?r.clone():f.new(r),d(r.selection,n),r},abs:w,arccos:function(r){return r=r instanceof f?r.clone():f.new(r),i.acoseq(r.selection),r},arcsin:function(r){return r=r instanceof f?r.clone():f.new(r),i.asineq(r.selection),r},arctan:function(r){return r=r instanceof f?r.clone():f.new(r),i.ataneq(r.selection),r},cos:function(r){return r=r instanceof f?r.clone():f.new(r),i.coseq(r.selection),r},sin:function(r){return r=r instanceof f?r.clone():f.new(r),i.sineq(r.selection),r},tan:function(r){return r=r instanceof f?r.clone():f.new(r),i.taneq(r.selection),r},tanh:function(r){return r=r instanceof f?r.clone():f.new(r),b(r.selection),r},clip:function(r,n,t){return 1===arguments.length?(n=0,t=1):2===arguments.length&&(t=1),r=r instanceof f?r.clone():f.new(r),v(r.selection,n,t),r},exp:function(r){return f.new(r).exp()},log:function(r){return f.new(r).log()},sqrt:function(r){return f.new(r).sqrt()},power:function(r,n){return f.new(r).pow(n)},sum:function(r){return f.new(r).sum()},mean:function(r){return f.new(r).mean()},std:function(r,n){return f.new(r).std(n)},dot:function(r,n){return f.new(r).dot(n)},add:function(r,n){return f.new(r).add(n)},subtract:function(r,n){return f.new(r).subtract(n)},multiply:function(r,n){return f.new(r).multiply(n)},divide:function(r,n){return f.new(r).divide(n)},negative:function(r){return f.new(r).negative()},equal:function(r,n){return f.new(r).equal(n)},max:function(r){return f.new(r).max()},min:function(r){return f.new(r).min()},mod:s,remainder:s,concatenate:m,transpose:l,errors:h,broadcast:function(r,n){if(0!==r.length&&0!==n.length){for(var t=r.slice().reverse(),e=n.slice().reverse(),i=Math.max(r.length,n.length),a=new Array(i),o=0;o<i;o++)if(t[o]&&1!==t[o])if(e[o]&&1!==e[o]){if(t[o]!==e[o])return;a[o]=t[o];}else a[o]=t[o];else a[o]=e[o];return a.reverse()}},round:function(r){return f.new(r).round()},convolve:function(r,n){return f.new(r).convolve(n)},fftconvolve:function(r,n){return f.new(r).fftconvolve(n)},fft:function(r){var n=(e=(r=r instanceof f?r.clone():f.new(r)).shape).length;if(2!==e[n-1])throw new h.ValueError("expect last dimension of the array to have 2 values (for both real and imaginary part)");var t=new Array(n),e=new Array(n);return t[n-1]=0,e[n-1]=1,a(1,r.selection.pick.apply(r.selection,t),r.selection.pick.apply(r.selection,e)),r},ifft:function(r){var n=(e=(r=r instanceof f?r.clone():f.new(r)).shape).length;if(2!==e[n-1])throw new h.ValueError("expect last dimension of the array to have 2 values (for both real and imaginary part)");var t=new Array(n),e=new Array(n);return t[n-1]=0,e[n-1]=1,a(-1,r.selection.pick.apply(r.selection,t),r.selection.pick.apply(r.selection,e)),r},diag:function(r){return f.new(r).diag()},identity:function(r,n){for(var t=p([r,r],n),e=0;e<r;e++)t.set(e,e,1);return t},stack:function(r,n){if(n=n||0,!r||0===r.length)throw new h.ValueError("need at least one array to stack");for(var t=(r=r.map(function(r){return c.isNumber(r)?r:f.new(r)}))[0].shape||[],e=1;e<r.length;e++)for(var i=r[e].shape||[],a=Math.max(t.length,i.length),o=0;o<a;o++)if(t[o]!==i[o])throw new h.ValueError("all input arrays must have the same shape");if(0===t.length)u=m(r);else for(var u=p([r.length].concat(t)),e=0;e<r.length;e++)u.pick(e).assign(r[e],!1);if(n){n<0&&(n=u.ndim+n);for(var s=u.ndim,l=new Array(s),e=0;e<s;e++)l[e]=e<n?e+1:e===n?0:e;return u.transpose(l)}return u},rot90:function(r,n,t){for(n=n||1;n<0;)n+=4;if(n%=4,r=f.new(r),1!==(t=f.new(t||[0,1])).shape.length||2!==t.shape[0])throw new h.ValueError("len(axes) must be 2");if((t=t.tolist())[0]===t[1]||w(t[0]-t[1])===r.ndim)throw new h.ValueError("Axes must be different.");if(0===n)return r;if(2===n)return A(A(r,t[0]),t[1]);var e=_(r.ndim).tolist(),i=e[t[0]];return e[t[0]]=e[t[1]],e[t[1]]=i,1===n?l(A(r,t[1]),e):A(l(r,e),t[1])},int8:function(r){return f.new(r,"int8")},uint8:function(r){return f.new(r,"uint8")},int16:function(r){return f.new(r,"int16")},uint16:function(r){return f.new(r,"uint16")},int32:function(r){return f.new(r,"int32")},uint32:function(r){return f.new(r,"uint32")},float32:function(r){return f.new(r,"float32")},float64:function(r){return f.new(r,"float64")},images:r("./images")};},{"./config":23,"./dtypes":24,"./errors":25,"./images":30,"./ndarray":42,"./utils":43,"cwise/lib/wrapper":7,ndarray:18,"ndarray-fft":13,"ndarray-ops":17}],42:[function(r,n,t){function m(){if(1===arguments.length)this.selection=arguments[0];else {if(0===arguments.length)throw new V.ValueError("Required argument 'data' not found");this.selection=A.apply(null,arguments);}Object.defineProperty(this,"size",{get:function(){return this.selection.size}.bind(this)}),Object.defineProperty(this,"shape",{get:function(){return this.selection.shape}.bind(this)}),Object.defineProperty(this,"ndim",{get:function(){return this.selection.shape.length}.bind(this)}),Object.defineProperty(this,"dtype",{get:function(){return this.selection.dtype}.bind(this),set:function(r){r=k.getType(r);r!==k.getType(this.dtype)&&(this.selection=A(new r(this.selection.data),this.selection.shape,this.selection.stride,this.selection.offset));}.bind(this)}),Object.defineProperty(this,"T",{get:function(){return this.transpose()}.bind(this)});}var A=r("ndarray"),j=r("ndarray-ops"),i=r("ndarray-gemm"),x=r("ndarray-fft"),E=r("typedarray-pool"),o=r("./config"),V=r("./errors"),k=r("./utils");m.prototype.get=function(){for(var r=arguments.length,n=0;n<r;n++)arguments[n]<0&&(arguments[n]+=this.shape[n]);return this.selection.get.apply(this.selection,arguments)},m.prototype.set=function(){return this.selection.set.apply(this.selection,arguments)},m.prototype.slice=function(){for(var r=this.ndim,n=new Array(r),t=new Array(r),e=new Array(r),i=this.shape,a=0;a<r;a++){var o,u,s=arguments[a];if(void 0===s)break;null!==s&&(k.isNumber(s)?(t[a]=s<0?s+i[a]:s,n[a]=null,e[a]=1):4===s.length&&null===s[1]&&null===s[2]?(u=s[0]<0?s[0]+i[a]:s[0],t[a]=u,n[a]=null,e[a]=s[3]||1):(o=s[0]<0?s[0]+i[a]:s[0],u=s[1]<0?s[1]+i[a]:s[1],t[a]=u?o:0,n[a]=u?u-o:o,e[a]=s[2]||1));}var l=this.selection.lo.apply(this.selection,t),l=l.hi.apply(l,n),l=l.step.apply(l,e);return new m(l)},m.prototype.pick=function(r){return new m(this.selection.pick.apply(this.selection,arguments))},m.prototype.lo=function(){return new m(this.selection.lo.apply(this.selection,arguments))},m.prototype.hi=function(){return new m(this.selection.hi.apply(this.selection,arguments))},m.prototype.step=function(){return new m(this.selection.step.apply(this.selection,arguments))},m.prototype.flatten=function(){if(1===this.ndim)return new m(this.selection);var r=k.getType(this.dtype),n=k.flatten(this.tolist(),!0);return n instanceof r||(n=new r(n)),new m(n,[this.size])},m.prototype.reshape=function(r){if(0===arguments.length)throw new V.ValueError("function takes at least one argument (0 given)");if(1===arguments.length&&k.isNumber(r)&&-1===r&&(r=[k.shapeSize(this.shape)]),1===arguments.length&&k.isNumber(r)&&(r=[r]),1<(r=1<arguments.length?[].slice.call(arguments):r).filter(function(r){return -1===r}).length)throw new V.ValueError("can only specify one unknown dimension");var n=k.shapeSize(r);if(r=r.map(function(r){return -1===r?-1*this.size/n:r}.bind(this)),this.size!==k.shapeSize(r))throw new V.ValueError("total size of new array must be unchanged");var t,e,i,a=this.selection.shape,o=this.selection.offset,u=this.selection.stride,s=a.length,l=r.length;if(s===l){for(var f=!0,c=0;c<l;++c)if(a[c]!==r[c]){f=!1;break}if(f)return new m(this.selection.data,a,u,o)}else if(1===s){for(t=new Array(l),c=l-1,i=1;0<=c;--c)t[c]=i,i*=r[c];for(e=o,c=0;c<l;++c)t[c]<0&&(e-=(r[c]-1)*t[c]);return new m(this.selection.data,r,t,e)}var h=Math.min(s,l),_=!0;for(c=0;c<h;c++)if(a[c]!==r[c]){_=!1;break}if(_){for(t=new Array(l),c=0;c<l;c++)t[c]=u[c]||1;return new m(this.selection.data,r,t,e=o)}return this.flatten().reshape(r)},m.prototype.transpose=function(r){if(0===arguments.length){var n=this.ndim;r=new Array(n);for(var t=0;t<n;t++)r[t]=n-t-1;}else 1<arguments.length&&(r=arguments);return new m(this.selection.transpose.apply(this.selection,r))},m.prototype.dot=function(r){r=r instanceof m?r:u(r,this.dtype);var n=this.shape,t=r.shape;if(2===n.length&&2===t.length&&n[1]===t[0]){var e=k.getType(this.dtype),e=new m(new e(n[0]*t[1]),[n[0],t[1]]);return i(e.selection,this.selection,r.selection),e}if(1===n.length&&2===t.length&&n[0]===t[0])return this.reshape([n[0],1]).T.dot(r).reshape(t[1]);if(2===n.length&&1===t.length&&n[1]===t[0])return this.dot(r.reshape([t[0],1])).reshape(n[0]);if(1===n.length&&1===t.length&&n[0]===t[0])return this.reshape([n[0],1]).T.dot(r.reshape([t[0],1])).reshape([1]);throw new V.ValueError("cannot compute the matrix product of given arrays")},m.prototype.assign=function(r,n){n=(n=1===arguments.length?!0:n)?this.clone():this;return k.isNumber(r)?j.assigns(n.selection,r):(r=u(r,this.dtype),j.assign(n.selection,r.selection)),n},m.prototype.add=function(r,n){n=(n=1===arguments.length?!0:n)?this.clone():this;return k.isNumber(r)?j.addseq(n.selection,r):(r=u(r,this.dtype),j.addeq(n.selection,r.selection)),n},m.prototype.subtract=function(r,n){n=(n=1===arguments.length?!0:n)?this.clone():this;return k.isNumber(r)?j.subseq(n.selection,r):(r=u(r,this.dtype),j.subeq(n.selection,r.selection)),n},m.prototype.multiply=function(r,n){n=(n=1===arguments.length?!0:n)?this.clone():this;return k.isNumber(r)?j.mulseq(n.selection,r):(r=u(r,this.dtype),j.muleq(n.selection,r.selection)),n},m.prototype.divide=function(r,n){n=(n=1===arguments.length?!0:n)?this.clone():this;return k.isNumber(r)?j.divseq(n.selection,r):(r=u(r,this.dtype),j.diveq(n.selection,r.selection)),n},m.prototype.pow=function(r,n){n=(n=1===arguments.length?!0:n)?this.clone():this;return k.isNumber(r)?j.powseq(n.selection,r):(r=u(r,this.dtype),j.poweq(n.selection,r.selection)),n},m.prototype.exp=function(r){r=(r=0===arguments.length?!0:r)?this.clone():this;return j.expeq(r.selection),r},m.prototype.log=function(r){r=(r=0===arguments.length?!0:r)?this.clone():this;return j.logeq(r.selection),r},m.prototype.sqrt=function(r){r=(r=0===arguments.length?!0:r)?this.clone():this;return j.sqrteq(r.selection),r},m.prototype.max=function(){return 0===this.selection.size?null:j.sup(this.selection)},m.prototype.min=function(){return 0===this.selection.size?null:j.inf(this.selection)},m.prototype.sum=function(){return j.sum(this.selection)},m.prototype.std=function(r){r=k.defaults(r,{ddof:0});var n=this.clone();j.powseq(n.selection,2);var t=this.mean(),e=k.shapeSize(this.shape),r=j.sum(n.selection)/(e-r.ddof)-t*t*e/(e-r.ddof);return 0<r?Math.sqrt(Math.abs(r)):0},m.prototype.mean=function(){return j.sum(this.selection)/k.shapeSize(this.shape)},m.prototype.mod=function(r,n){n=(n=1===arguments.length?!0:n)?this.clone():this;return k.isNumber(r)?j.modseq(n.selection,r):(r=u(r,this.dtype),j.modeq(n.selection,r.selection)),n},m.prototype.tolist=function(){return s(this.selection)},m.prototype.valueOf=function(){return this.tolist()},m.prototype.toString=function(){var a=l(this.max()).length,r=/\[\s+\[/g;r=JSON.stringify(this.tolist(),function t(e,r){if(k.isString(r))return r;if(k.isNumber(r)){var n=l(r);return new Array(Math.max(0,a-n.length+2)).join(" ")+n}e=e||0;var i=o.printThreshold,n=i/2|0,r=r.length>i?[].concat(r.slice(0,n),[" ..."],r.slice(r.length-n)):r;return new Array(e+1).join(" ")+"["+r.map(function(r,n){return t(0===n&&0===e?1:e+1,r)}).join(",")+"]"}).replace(/\]\,(\s*)\[/g,"],\n$1      [").replace(r,"[[").replace(r,"[[").replace(/\]\,(\s+)...\,(\s+)\[/g,"],\n$2       ...\n$2      [").slice(2,-1);return "array"!==this.dtype?"array(["+r+", dtype="+this.dtype+")":"array(["+r+")"},m.prototype.inspect=m.prototype.toString,m.prototype.toJSON=function(){return JSON.stringify(this.tolist())},m.prototype.clone=function(){var r=this.selection;return void 0===r.data.slice?new m(A([].slice.apply(r.data),r.shape,r.stride,r.offset)):new m(A(r.data.slice(),r.shape,r.stride,r.offset))},m.prototype.equal=function(r){if(r=u(r),this.size!==r.size||this.ndim!==r.ndim)return !1;for(var n=this.ndim,t=0;t<n;t++)if(this.shape[t]!==r.shape[t])return !1;return j.equals(this.selection,r.selection)},m.prototype.round=function(r){r=(r=0===arguments.length?!0:r)?this.clone():this;return j.roundeq(r.selection),r},m.prototype.negative=function(){var r=this.clone();return j.neg(r.selection,this.selection),r},m.prototype.diag=function(){var r=this.ndim;if(1===r){var n=k.getType(this.dtype),t=[this.shape[0],this.shape[0]],e=new m(new n(k.shapeSize(t)),t);"array"===e.dtype&&j.assigns(e.selection,0);for(var i=0;i<this.shape[0];i++)e.set(i,i,this.get(i));return e}for(var a=this.shape,o=this.selection.stride,u=1<<30,s=0,i=0;i<r;++i)u=0|Math.min(u,a[i]),s+=o[i];return new m(this.selection.data,[u],[s],this.selection.offset)},m.prototype.iteraxis=function(r,n){var t=this.shape;if((r=-1===r?t.length-1:r)<0||r>t.length-1)throw new V.ValueError("invalid axis");for(var e=0;e<t[r];e++){for(var i=new Array(r+1),a=0;a<r+1;a++)i[a]=a===r?e:null;n(u(s(this.selection.pick.apply(this.selection,i)),this.dtype),e);}};var I=r("cwise/lib/wrapper")({args:["array","array","array","array"],pre:{body:"{}",args:[],thisVars:[],localVars:[]},body:{body:"{var _inline_55_c=_inline_55_arg2_,_inline_55_f=_inline_55_arg3_,_inline_55_i=_inline_55_arg0_,_inline_55_o=_inline_55_arg1_,_inline_55_t=_inline_55_i*(_inline_55_c+_inline_55_f);_inline_55_arg0_=_inline_55_t-_inline_55_f*(_inline_55_i+_inline_55_o),_inline_55_arg1_=_inline_55_t+_inline_55_c*(_inline_55_o-_inline_55_i)}",args:[{name:"_inline_55_arg0_",lvalue:!0,rvalue:!0,count:2},{name:"_inline_55_arg1_",lvalue:!0,rvalue:!0,count:2},{name:"_inline_55_arg2_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_55_arg3_",lvalue:!1,rvalue:!0,count:1}],thisVars:[],localVars:["_inline_55_c","_inline_55_f","_inline_55_i","_inline_55_o","_inline_55_t"]},post:{body:"{}",args:[],thisVars:[],localVars:[]},debug:!1,funcName:"cwise",blockSize:64}),h=r("cwise/lib/wrapper")({args:["array","array","scalar","scalar","scalar","scalar","scalar","scalar","scalar","scalar","scalar",{offset:[-1,-1],array:1},{offset:[-1,0],array:1},{offset:[-1,1],array:1},{offset:[0,-1],array:1},{offset:[0,1],array:1},{offset:[1,-1],array:1},{offset:[1,0],array:1},{offset:[1,1],array:1}],pre:{body:"{}",args:[],thisVars:[],localVars:[]},body:{body:"{_inline_58_arg0_=_inline_58_arg11_*_inline_58_arg10_+_inline_58_arg12_*_inline_58_arg9_+_inline_58_arg13_*_inline_58_arg8_+_inline_58_arg14_*_inline_58_arg7_+_inline_58_arg1_*_inline_58_arg6_+_inline_58_arg15_*_inline_58_arg5_+_inline_58_arg16_*_inline_58_arg4_+_inline_58_arg17_*_inline_58_arg3_+_inline_58_arg18_*_inline_58_arg2_}",args:[{name:"_inline_58_arg0_",lvalue:!0,rvalue:!1,count:1},{name:"_inline_58_arg1_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_58_arg2_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_58_arg3_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_58_arg4_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_58_arg5_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_58_arg6_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_58_arg7_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_58_arg8_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_58_arg9_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_58_arg10_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_58_arg11_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_58_arg12_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_58_arg13_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_58_arg14_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_58_arg15_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_58_arg16_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_58_arg17_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_58_arg18_",lvalue:!1,rvalue:!0,count:1}],thisVars:[],localVars:[]},post:{body:"{}",args:[],thisVars:[],localVars:[]},debug:!1,funcName:"cwise",blockSize:64}),_=r("cwise/lib/wrapper")({args:["index","array","array","scalar","scalar","scalar","scalar","scalar","scalar","scalar","scalar","scalar","scalar","scalar","scalar","scalar","scalar","scalar","scalar","scalar","scalar","scalar","scalar","scalar","scalar","scalar","scalar","scalar",{offset:[-2,-2],array:1},{offset:[-2,-1],array:1},{offset:[-2,0],array:1},{offset:[-2,1],array:1},{offset:[-2,2],array:1},{offset:[-1,-2],array:1},{offset:[-1,-1],array:1},{offset:[-1,0],array:1},{offset:[-1,1],array:1},{offset:[-1,2],array:1},{offset:[0,-2],array:1},{offset:[0,-1],array:1},{offset:[0,1],array:1},{offset:[0,2],array:1},{offset:[1,-2],array:1},{offset:[1,-1],array:1},{offset:[1,0],array:1},{offset:[1,1],array:1},{offset:[1,2],array:1},{offset:[2,-2],array:1},{offset:[2,-1],array:1},{offset:[2,0],array:1},{offset:[2,1],array:1},{offset:[2,2],array:1}],pre:{body:"{}",args:[],thisVars:[],localVars:[]},body:{body:"{_inline_61_arg1_=_inline_61_arg0_[0]<2||_inline_61_arg0_[1]<2?0:_inline_61_arg28_*_inline_61_arg27_+_inline_61_arg29_*_inline_61_arg26_+_inline_61_arg30_*_inline_61_arg25_+_inline_61_arg31_*_inline_61_arg24_+_inline_61_arg32_*_inline_61_arg23_+_inline_61_arg33_*_inline_61_arg22_+_inline_61_arg34_*_inline_61_arg21_+_inline_61_arg35_*_inline_61_arg20_+_inline_61_arg36_*_inline_61_arg19_+_inline_61_arg37_*_inline_61_arg18_+_inline_61_arg38_*_inline_61_arg17_+_inline_61_arg39_*_inline_61_arg16_+_inline_61_arg2_*_inline_61_arg15_+_inline_61_arg40_*_inline_61_arg14_+_inline_61_arg41_*_inline_61_arg13_+_inline_61_arg42_*_inline_61_arg12_+_inline_61_arg43_*_inline_61_arg11_+_inline_61_arg44_*_inline_61_arg10_+_inline_61_arg45_*_inline_61_arg9_+_inline_61_arg46_*_inline_61_arg8_+_inline_61_arg47_*_inline_61_arg7_+_inline_61_arg48_*_inline_61_arg6_+_inline_61_arg49_*_inline_61_arg5_+_inline_61_arg50_*_inline_61_arg4_+_inline_61_arg51_*_inline_61_arg3_}",args:[{name:"_inline_61_arg0_",lvalue:!1,rvalue:!0,count:2},{name:"_inline_61_arg1_",lvalue:!0,rvalue:!1,count:1},{name:"_inline_61_arg2_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg3_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg4_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg5_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg6_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg7_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg8_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg9_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg10_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg11_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg12_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg13_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg14_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg15_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg16_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg17_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg18_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg19_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg20_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg21_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg22_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg23_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg24_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg25_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg26_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg27_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg28_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg29_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg30_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg31_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg32_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg33_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg34_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg35_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg36_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg37_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg38_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg39_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg40_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg41_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg42_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg43_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg44_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg45_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg46_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg47_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg48_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg49_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg50_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_61_arg51_",lvalue:!1,rvalue:!0,count:1}],thisVars:[],localVars:[]},post:{body:"{}",args:[],thisVars:[],localVars:[]},debug:!1,funcName:"cwise",blockSize:64});function u(r,n){if(r instanceof m)return r;var t=k.getType(n);if(k.isNumber(r))return t!==Array?new m(new t([r]),[1]):new m([r],[1]);n=k.getShape(r);return (r=1<n.length?k.flatten(r,!0):r)instanceof t||(r=new t(r)),new m(r,n)}m.prototype.convolve=function(r){r=m.new(r);var n=this.ndim;if(n!==r.ndim)throw new V.ValueError("arrays must have the same dimensions");for(var t=new Array(n),e=new Array(n),i=this.selection,a=this.shape,o=r.selection,u=r.shape,s=0;s<n;s++){var l=a[s]-u[s]+1;if(l<0)throw new V.ValueError("filter cannot be greater than the array");t[s]=l,e[s]=-1;}if(2===n&&3===u[0]&&3===u[1]){var f=new m(new Float32Array(k.shapeSize(a)),a);return h(f.selection,i,o.get(0,0),o.get(0,1),o.get(0,2),o.get(1,0),o.get(1,1),o.get(1,2),o.get(2,0),o.get(2,1),o.get(2,2)),f.lo(1,1).hi(t[0],t[1])}if(3===n&&1===u[2]&&1===a[2]&&3===u[0]&&3===u[1]){var c=new m(new Float32Array(k.shapeSize(a)),a);return h(c.selection.pick(null,null,0),i.pick(null,null,0),o.get(0,0,0),o.get(0,1,0),o.get(0,2,0),o.get(1,0,0),o.get(1,1,0),o.get(1,2,0),o.get(2,0,0),o.get(2,1,0),o.get(2,2,0)),c.lo(1,1).hi(t[0],t[1])}if(2===n&&5===u[0]&&5===u[1]){c=new m(new Float32Array(k.shapeSize(a)),a);return _(c.selection,i,o.get(0,0),o.get(0,1),o.get(0,2),o.get(0,3),o.get(0,4),o.get(1,0),o.get(1,1),o.get(1,2),o.get(1,3),o.get(1,4),o.get(2,0),o.get(2,1),o.get(2,2),o.get(2,3),o.get(2,4),o.get(3,0),o.get(3,1),o.get(3,2),o.get(3,3),o.get(3,4),o.get(4,0),o.get(4,1),o.get(4,2),o.get(4,3),o.get(4,4)),c.lo(2,2).hi(t[0],t[1])}if(3!==n||1!==u[2]||1!==a[2]||5!==u[0]||5!==u[1])return this.fftconvolve(r);r=new m(new Float32Array(k.shapeSize(a)),a);return _(r.selection,i,o.get(0,0,0),o.get(0,1,0),o.get(0,2,0),o.get(0,3,0),o.get(0,4,0),o.get(1,0,0),o.get(1,1,0),o.get(1,2,0),o.get(1,3,0),o.get(1,4,0),o.get(2,0,0),o.get(2,1,0),o.get(2,2,0),o.get(2,3,0),o.get(2,4,0),o.get(3,0,0),o.get(3,1,0),o.get(3,2,0),o.get(3,3,0),o.get(3,4,0),o.get(4,0,0),o.get(4,1,0),o.get(4,2,0),o.get(4,3,0),o.get(4,4,0)),r.lo(2,2).hi(t[0],t[1])},m.prototype.fftconvolve=function(r){if(r=m.new(r),this.ndim!==r.ndim)throw new V.ValueError("arrays must have the same dimensions");for(var n=this.selection,t=r.selection,e=this.ndim,i=1,a=new Array(e),o=new Array(e),u=new Array(e),s=e-1;0<=s;--s)o[s]=n.shape[s],a[s]=i,i*=o[s],u[s]=n.shape[s]-t.shape[s]+1;var l=k.getType(n.dtype),f=new m(new l(k.shapeSize(u)),u),c=f.selection,h=E.mallocDouble(i),_=A(h,o,a,0);j.assigns(_,0),j.assign(_.hi.apply(_,n.shape),n);var p=E.mallocDouble(i),g=A(p,o,a,0);j.assigns(g,0),x(1,_,g);var y=E.mallocDouble(i),v=A(y,o,a,0);j.assigns(v,0),j.assign(v.hi.apply(v,t.shape),t);r=E.mallocDouble(i),l=A(r,o,a,0);j.assigns(l,0),x(1,v,l),I(_,g,v,l),x(-1,_,g);var d=new Array(e),b=new Array(e),w=!1;for(s=0;s<e;++s)c.shape[s]>o[s]&&(w=!0),b[s]=t.shape[s]-1,d[s]=Math.min(c.shape[s],o[s]-b[s]);return w&&j.assign(c,0),_=(_=_.lo.apply(_,b)).hi.apply(_,d),j.assign(c.hi.apply(c,d),_),E.freeDouble(h),E.freeDouble(p),E.freeDouble(y),E.freeDouble(r),f},m.new=u,n.exports=m;var e=r("cwise/lib/wrapper")({args:["array","scalar","index"],pre:{body:"{}",args:[],thisVars:[],localVars:[]},body:{body:"{var _inline_64_a,_inline_64_e=_inline_64_arg1_;for(_inline_64_a=0;_inline_64_a<_inline_64_arg2_.length-1;++_inline_64_a)_inline_64_e=_inline_64_e[_inline_64_arg2_[_inline_64_a]];_inline_64_e[_inline_64_arg2_[_inline_64_arg2_.length-1]]=_inline_64_arg0_}",args:[{name:"_inline_64_arg0_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_64_arg1_",lvalue:!1,rvalue:!0,count:1},{name:"_inline_64_arg2_",lvalue:!1,rvalue:!0,count:4}],thisVars:[],localVars:["_inline_64_a","_inline_64_e"]},post:{body:"{}",args:[],thisVars:[],localVars:[]},debug:!1,funcName:"unpackCwise",blockSize:64});function s(r){var n=function r(n,t){var e=0|n[t=t||0];if(e<=0)return [];var i,a=new Array(e);if(t===n.length-1)for(i=0;i<e;++i)a[i]=0;else for(i=0;i<e;++i)a[i]=r(n,t+1);return a}(r.shape,0);return e(r,n),n}function l(r){return String(Number((r||0).toFixed(o.nFloatingValues)))}},{"./config":23,"./errors":25,"./utils":43,"cwise/lib/wrapper":7,ndarray:18,"ndarray-fft":13,"ndarray-gemm":15,"ndarray-ops":17,"typedarray-pool":21}],43:[function(r,n,t){var e=r("./dtypes"),r=r("lodash");function u(r){return "number"==typeof r}function i(r){return "function"==typeof r}n.exports={isNumber:u,isString:function(r){return "string"==typeof r},isFunction:i,flatten:function r(n,t,e){e=e||[];for(var i=-1,a=n.length;++i<a;){var o=n[i];u(o)?e[e.length]=o:t?r(o,t,e):e.push(o);}return e},shapeSize:function(r){for(var n=1,t=0;t<r.length;t++)n*=r[t];return n},getType:function(r){return i(r)?r:e[r]||Array},getShape:function(r){var n;return "object"==typeof r?"object"==typeof(n=r[0])?"object"==typeof n[0]?function(r){for(var n=[];"object"==typeof r;)n.push(r.length),r=r[0];return n}(r):[r.length,n.length]:[r.length]:[]},defaults:r.defaults};},{"./dtypes":24,lodash:12}]},{},[41])(41)});

!(function (global, factory) {
  "object" == typeof exports && "undefined" != typeof module
    ? factory(exports)
    : "function" == typeof define && define.amd
    ? define(["exports"], factory)
    : factory(
        ((global =
          "undefined" != typeof globalThis
            ? globalThis
            : global || self).loadPyodide = {})
      );
})(undefined, function (exports) {
  /*! *****************************************************************************
    Copyright (c) Microsoft Corporation.

    Permission to use, copy, modify, and/or distribute this software for any
    purpose with or without fee is hereby granted.

    THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
    REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
    AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
    INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
    LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
    OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
    PERFORMANCE OF THIS SOFTWARE.
    ***************************************************************************** */ function __awaiter(
    thisArg,
    _arguments,
    P,
    generator
  ) {
    return new (P || (P = Promise))(function (resolve, reject) {
      function fulfilled(value) {
        try {
          step(generator.next(value));
        } catch (e) {
          reject(e);
        }
      }
      function rejected(value) {
        try {
          step(generator.throw(value));
        } catch (e) {
          reject(e);
        }
      }
      function step(result) {
        var value;
        result.done
          ? resolve(result.value)
          : ((value = result.value),
            value instanceof P
              ? value
              : new P(function (resolve) {
                  resolve(value);
                })).then(fulfilled, rejected);
      }
      step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
  }
  var errorStackParser = { exports: {} },
    stackframe = { exports: {} };
  !(function (module, exports) {
    module.exports = (function () {
      function _isNumber(n) {
        return !isNaN(parseFloat(n)) && isFinite(n);
      }
      function _capitalize(str) {
        return str.charAt(0).toUpperCase() + str.substring(1);
      }
      function _getter(p) {
        return function () {
          return this[p];
        };
      }
      var booleanProps = ["isConstructor", "isEval", "isNative", "isToplevel"],
        numericProps = ["columnNumber", "lineNumber"],
        stringProps = ["fileName", "functionName", "source"],
        arrayProps = ["args"],
        objectProps = ["evalOrigin"],
        props = booleanProps.concat(
          numericProps,
          stringProps,
          arrayProps,
          objectProps
        );
      function StackFrame(obj) {
        if (obj)
          for (var i = 0; i < props.length; i++)
            void 0 !== obj[props[i]] &&
              this["set" + _capitalize(props[i])](obj[props[i]]);
      }
      (StackFrame.prototype = {
        getArgs: function () {
          return this.args;
        },
        setArgs: function (v) {
          if ("[object Array]" !== Object.prototype.toString.call(v))
            throw new TypeError("Args must be an Array");
          this.args = v;
        },
        getEvalOrigin: function () {
          return this.evalOrigin;
        },
        setEvalOrigin: function (v) {
          if (v instanceof StackFrame) this.evalOrigin = v;
          else {
            if (!(v instanceof Object))
              throw new TypeError(
                "Eval Origin must be an Object or StackFrame"
              );
            this.evalOrigin = new StackFrame(v);
          }
        },
        toString: function () {
          var fileName = this.getFileName() || "",
            lineNumber = this.getLineNumber() || "",
            columnNumber = this.getColumnNumber() || "",
            functionName = this.getFunctionName() || "";
          return this.getIsEval()
            ? fileName
              ? "[eval] (" +
                fileName +
                ":" +
                lineNumber +
                ":" +
                columnNumber +
                ")"
              : "[eval]:" + lineNumber + ":" + columnNumber
            : functionName
            ? functionName +
              " (" +
              fileName +
              ":" +
              lineNumber +
              ":" +
              columnNumber +
              ")"
            : fileName + ":" + lineNumber + ":" + columnNumber;
        },
      }),
        (StackFrame.fromString = function (str) {
          var argsStartIndex = str.indexOf("("),
            argsEndIndex = str.lastIndexOf(")"),
            functionName = str.substring(0, argsStartIndex),
            args = str.substring(argsStartIndex + 1, argsEndIndex).split(","),
            locationString = str.substring(argsEndIndex + 1);
          if (0 === locationString.indexOf("@"))
            var parts = /@(.+?)(?::(\d+))?(?::(\d+))?$/.exec(
                locationString,
                ""
              ),
              fileName = parts[1],
              lineNumber = parts[2],
              columnNumber = parts[3];
          return new StackFrame({
            functionName: functionName,
            args: args || void 0,
            fileName: fileName,
            lineNumber: lineNumber || void 0,
            columnNumber: columnNumber || void 0,
          });
        });
      for (var i = 0; i < booleanProps.length; i++)
        (StackFrame.prototype["get" + _capitalize(booleanProps[i])] = _getter(
          booleanProps[i]
        )),
          (StackFrame.prototype["set" + _capitalize(booleanProps[i])] =
            (function (p) {
              return function (v) {
                this[p] = Boolean(v);
              };
            })(booleanProps[i]));
      for (var j = 0; j < numericProps.length; j++)
        (StackFrame.prototype["get" + _capitalize(numericProps[j])] = _getter(
          numericProps[j]
        )),
          (StackFrame.prototype["set" + _capitalize(numericProps[j])] =
            (function (p) {
              return function (v) {
                if (!_isNumber(v)) throw new TypeError(p + " must be a Number");
                this[p] = Number(v);
              };
            })(numericProps[j]));
      for (var k = 0; k < stringProps.length; k++)
        (StackFrame.prototype["get" + _capitalize(stringProps[k])] = _getter(
          stringProps[k]
        )),
          (StackFrame.prototype["set" + _capitalize(stringProps[k])] =
            (function (p) {
              return function (v) {
                this[p] = String(v);
              };
            })(stringProps[k]));
      return StackFrame;
    })();
  })(stackframe),
    (function (module, exports) {
      var StackFrame,
        FIREFOX_SAFARI_STACK_REGEXP,
        CHROME_IE_STACK_REGEXP,
        SAFARI_NATIVE_CODE_REGEXP;
      module.exports =
        ((StackFrame = stackframe.exports),
        (FIREFOX_SAFARI_STACK_REGEXP = /(^|@)\S+:\d+/),
        (CHROME_IE_STACK_REGEXP = /^\s*at .*(\S+:\d+|\(native\))/m),
        (SAFARI_NATIVE_CODE_REGEXP = /^(eval@)?(\[native code])?$/),
        {
          parse: function (error) {
            if (
              void 0 !== error.stacktrace ||
              void 0 !== error["opera#sourceloc"]
            )
              return this.parseOpera(error);
            if (error.stack && error.stack.match(CHROME_IE_STACK_REGEXP))
              return this.parseV8OrIE(error);
            if (error.stack) return this.parseFFOrSafari(error);
            throw new Error("Cannot parse given Error object");
          },
          extractLocation: function (urlLike) {
            if (-1 === urlLike.indexOf(":")) return [urlLike];
            var parts = /(.+?)(?::(\d+))?(?::(\d+))?$/.exec(
              urlLike.replace(/[()]/g, "")
            );
            return [parts[1], parts[2] || void 0, parts[3] || void 0];
          },
          parseV8OrIE: function (error) {
            return error.stack
              .split("\n")
              .filter(function (line) {
                return !!line.match(CHROME_IE_STACK_REGEXP);
              }, this)
              .map(function (line) {
                line.indexOf("(eval ") > -1 &&
                  (line = line
                    .replace(/eval code/g, "eval")
                    .replace(/(\(eval at [^()]*)|(\),.*$)/g, ""));
                var sanitizedLine = line
                    .replace(/^\s+/, "")
                    .replace(/\(eval code/g, "("),
                  location = sanitizedLine.match(/ (\((.+):(\d+):(\d+)\)$)/),
                  tokens = (sanitizedLine = location
                    ? sanitizedLine.replace(location[0], "")
                    : sanitizedLine)
                    .split(/\s+/)
                    .slice(1),
                  locationParts = this.extractLocation(
                    location ? location[1] : tokens.pop()
                  ),
                  functionName = tokens.join(" ") || void 0,
                  fileName =
                    ["eval", "<anonymous>"].indexOf(locationParts[0]) > -1
                      ? void 0
                      : locationParts[0];
                return new StackFrame({
                  functionName: functionName,
                  fileName: fileName,
                  lineNumber: locationParts[1],
                  columnNumber: locationParts[2],
                  source: line,
                });
              }, this);
          },
          parseFFOrSafari: function (error) {
            return error.stack
              .split("\n")
              .filter(function (line) {
                return !line.match(SAFARI_NATIVE_CODE_REGEXP);
              }, this)
              .map(function (line) {
                if (
                  (line.indexOf(" > eval") > -1 &&
                    (line = line.replace(
                      / line (\d+)(?: > eval line \d+)* > eval:\d+:\d+/g,
                      ":$1"
                    )),
                  -1 === line.indexOf("@") && -1 === line.indexOf(":"))
                )
                  return new StackFrame({ functionName: line });
                var functionNameRegex = /((.*".+"[^@]*)?[^@]*)(?:@)/,
                  matches = line.match(functionNameRegex),
                  functionName = matches && matches[1] ? matches[1] : void 0,
                  locationParts = this.extractLocation(
                    line.replace(functionNameRegex, "")
                  );
                return new StackFrame({
                  functionName: functionName,
                  fileName: locationParts[0],
                  lineNumber: locationParts[1],
                  columnNumber: locationParts[2],
                  source: line,
                });
              }, this);
          },
          parseOpera: function (e) {
            return !e.stacktrace ||
              (e.message.indexOf("\n") > -1 &&
                e.message.split("\n").length > e.stacktrace.split("\n").length)
              ? this.parseOpera9(e)
              : e.stack
              ? this.parseOpera11(e)
              : this.parseOpera10(e);
          },
          parseOpera9: function (e) {
            for (
              var lineRE = /Line (\d+).*script (?:in )?(\S+)/i,
                lines = e.message.split("\n"),
                result = [],
                i = 2,
                len = lines.length;
              i < len;
              i += 2
            ) {
              var match = lineRE.exec(lines[i]);
              match &&
                result.push(
                  new StackFrame({
                    fileName: match[2],
                    lineNumber: match[1],
                    source: lines[i],
                  })
                );
            }
            return result;
          },
          parseOpera10: function (e) {
            for (
              var lineRE =
                  /Line (\d+).*script (?:in )?(\S+)(?:: In function (\S+))?$/i,
                lines = e.stacktrace.split("\n"),
                result = [],
                i = 0,
                len = lines.length;
              i < len;
              i += 2
            ) {
              var match = lineRE.exec(lines[i]);
              match &&
                result.push(
                  new StackFrame({
                    functionName: match[3] || void 0,
                    fileName: match[2],
                    lineNumber: match[1],
                    source: lines[i],
                  })
                );
            }
            return result;
          },
          parseOpera11: function (error) {
            return error.stack
              .split("\n")
              .filter(function (line) {
                return (
                  !!line.match(FIREFOX_SAFARI_STACK_REGEXP) &&
                  !line.match(/^Error created at/)
                );
              }, this)
              .map(function (line) {
                var argsRaw,
                  tokens = line.split("@"),
                  locationParts = this.extractLocation(tokens.pop()),
                  functionCall = tokens.shift() || "",
                  functionName =
                    functionCall
                      .replace(/<anonymous function(: (\w+))?>/, "$2")
                      .replace(/\([^)]*\)/g, "") || void 0;
                functionCall.match(/\(([^)]*)\)/) &&
                  (argsRaw = functionCall.replace(/^[^(]+\(([^)]*)\)$/, "$1"));
                var args =
                  void 0 === argsRaw || "[arguments not available]" === argsRaw
                    ? void 0
                    : argsRaw.split(",");
                return new StackFrame({
                  functionName: functionName,
                  args: args,
                  fileName: locationParts[0],
                  lineNumber: locationParts[1],
                  columnNumber: locationParts[2],
                  source: line,
                });
              }, this);
          },
        });
    })(errorStackParser);
  var ErrorStackParser = errorStackParser.exports;
  let Module = {
      noImageDecoding: !0,
      noAudioDecoding: !0,
      noWasmDecoding: !1,
      preloadedWasm: {},
      preRun: [],
    },
    API = {};
  Module.API = API;
  let Hiwire = {};
  Module.hiwire = Hiwire;
  let Tests = {};
  function setStandardStreams(stdin, stdout, stderr) {
    stdout && (Module.print = stdout),
      stderr && (Module.printErr = stderr),
      stdin &&
        Module.preRun.push(function () {
          Module.FS.init(
            (function (stdin) {
              const encoder = new TextEncoder();
              let input = new Uint8Array(0),
                inputIndex = -1;
              function stdinWrapper() {
                try {
                  if (-1 === inputIndex) {
                    let text = stdin();
                    if (null == text) return null;
                    if ("string" != typeof text)
                      throw new TypeError(
                        `Expected stdin to return string, null, or undefined, got type ${typeof text}.`
                      );
                    text.endsWith("\n") || (text += "\n"),
                      (input = encoder.encode(text)),
                      (inputIndex = 0);
                  }
                  if (inputIndex < input.length) {
                    let character = input[inputIndex];
                    return inputIndex++, character;
                  }
                  return (inputIndex = -1), null;
                } catch (e) {
                  throw (
                    (console.error("Error thrown in stdin:"),
                    console.error(e),
                    e)
                  );
                }
              }
              return stdinWrapper;
            })(stdin),
            null,
            null
          );
        });
  }
  API.tests = Tests;
  const IN_NODE =
    "undefined" != typeof process &&
    process.release &&
    "node" === process.release.name &&
    void 0 === process.browser;
  let nodePathMod,
    nodeFetch,
    nodeVmMod,
    nodeFsPromisesMod,
    _loadBinaryFile,
    loadScript;
  if (
    ((_loadBinaryFile = IN_NODE
      ? function (indexURL, path) {
          return __awaiter(this, void 0, void 0, function* () {
            if (path.includes("://")) {
              let response = yield nodeFetch(path);
              if (!response.ok)
                throw new Error(`Failed to load '${path}': request failed.`);
              return yield response.arrayBuffer();
            }
            {
              const data = yield nodeFsPromisesMod.readFile(
                `${indexURL}${path}`
              );
              return new Uint8Array(
                data.buffer,
                data.byteOffset,
                data.byteLength
              );
            }
          });
        }
      : function (indexURL, path) {
          return __awaiter(this, void 0, void 0, function* () {
            const base = new URL(indexURL, location),
              url = new URL(path, base);
            let response = yield fetch(url);
            if (!response.ok)
              throw new Error(`Failed to load '${url}': request failed.`);
            return new Uint8Array(yield response.arrayBuffer());
          });
        }),
    globalThis.document)
  )
    loadScript = (url) =>
      __awaiter(void 0, void 0, void 0, function* () {
        return yield import(url);
      });
  else if (globalThis.importScripts)
    loadScript = (url) =>
      __awaiter(void 0, void 0, void 0, function* () {
        try {
          globalThis.importScripts(url);
        } catch (e) {
          if (!(e instanceof TypeError)) throw e;
          yield import(url);
        }
      });
  else {
    if (!IN_NODE) throw new Error("Cannot determine runtime environment");
    loadScript = function (url) {
      return __awaiter(this, void 0, void 0, function* () {
        url.includes("://")
          ? nodeVmMod.runInThisContext(yield (yield nodeFetch(url)).text())
          : yield import(nodePathMod.resolve(url));
      });
    };
  }
  function isPyProxy(jsobj) {
    return !!jsobj && void 0 !== jsobj.$$ && "PyProxy" === jsobj.$$.type;
  }
  (API.isPyProxy = isPyProxy),
    globalThis.FinalizationRegistry
      ? (Module.finalizationRegistry = new FinalizationRegistry(
          ([ptr, cache]) => {
            (cache.leaked = !0), pyproxy_decref_cache(cache);
            try {
              Module._Py_DecRef(ptr);
            } catch (e) {
              API.fatal_error(e);
            }
          }
        ))
      : (Module.finalizationRegistry = { register() {}, unregister() {} });
  let trace_pyproxy_alloc,
    trace_pyproxy_dealloc,
    pyproxy_alloc_map = new Map();
  function _getPtr(jsobj) {
    let ptr = jsobj.$$.ptr;
    if (0 === ptr) throw new Error(jsobj.$$.destroyed_msg);
    return ptr;
  }
  (Module.pyproxy_alloc_map = pyproxy_alloc_map),
    (Module.enable_pyproxy_allocation_tracing = function () {
      (trace_pyproxy_alloc = function (proxy) {
        pyproxy_alloc_map.set(proxy, Error().stack);
      }),
        (trace_pyproxy_dealloc = function (proxy) {
          pyproxy_alloc_map.delete(proxy);
        });
    }),
    (Module.disable_pyproxy_allocation_tracing = function () {
      (trace_pyproxy_alloc = function (proxy) {}),
        (trace_pyproxy_dealloc = function (proxy) {});
    }),
    Module.disable_pyproxy_allocation_tracing(),
    (Module.pyproxy_new = function (ptrobj, cache) {
      let target,
        flags = Module._pyproxy_getflags(ptrobj),
        cls = Module.getPyProxyClass(flags);
      if (
        (256 & flags
          ? ((target = Reflect.construct(Function, [], cls)),
            delete target.length,
            delete target.name,
            (target.prototype = void 0))
          : (target = Object.create(cls.prototype)),
        !cache)
      ) {
        cache = { cacheId: Hiwire.new_value(new Map()), refcnt: 0 };
      }
      cache.refcnt++,
        Object.defineProperty(target, "$$", {
          value: { ptr: ptrobj, type: "PyProxy", cache: cache },
        }),
        Module._Py_IncRef(ptrobj);
      let proxy = new Proxy(target, PyProxyHandlers);
      return (
        trace_pyproxy_alloc(proxy),
        Module.finalizationRegistry.register(proxy, [ptrobj, cache], proxy),
        proxy
      );
    });
  let pyproxyClassMap = new Map();
  (Module.getPyProxyClass = function (flags) {
    const FLAG_TYPE_PAIRS = [
      [1, PyProxyLengthMethods],
      [2, PyProxyGetItemMethods],
      [4, PyProxySetItemMethods],
      [8, PyProxyContainsMethods],
      [16, PyProxyIterableMethods],
      [32, PyProxyIteratorMethods],
      [64, PyProxyAwaitableMethods],
      [128, PyProxyBufferMethods],
      [256, PyProxyCallableMethods],
    ];
    let result = pyproxyClassMap.get(flags);
    if (result) return result;
    let descriptors = {};
    for (let [feature_flag, methods] of FLAG_TYPE_PAIRS)
      flags & feature_flag &&
        Object.assign(
          descriptors,
          Object.getOwnPropertyDescriptors(methods.prototype)
        );
    (descriptors.constructor = Object.getOwnPropertyDescriptor(
      PyProxyClass.prototype,
      "constructor"
    )),
      Object.assign(
        descriptors,
        Object.getOwnPropertyDescriptors({ $$flags: flags })
      );
    let new_proto = Object.create(PyProxyClass.prototype, descriptors);
    function NewPyProxyClass() {}
    return (
      (NewPyProxyClass.prototype = new_proto),
      pyproxyClassMap.set(flags, NewPyProxyClass),
      NewPyProxyClass
    );
  }),
    (Module.PyProxy_getPtr = _getPtr);
  function pyproxy_decref_cache(cache) {
    if (cache && (cache.refcnt--, 0 === cache.refcnt)) {
      let cache_map = Hiwire.pop_value(cache.cacheId);
      for (let proxy_id of cache_map.values()) {
        const cache_entry = Hiwire.pop_value(proxy_id);
        cache.leaked ||
          Module.pyproxy_destroy(
            cache_entry,
            "This borrowed attribute proxy was automatically destroyed in the process of destroying the proxy it was borrowed from. Try using the 'copy' method."
          );
      }
    }
  }
  (Module.pyproxy_destroy = function (proxy, destroyed_msg) {
    if (0 === proxy.$$.ptr) return;
    let ptrobj = _getPtr(proxy);
    Module.finalizationRegistry.unregister(proxy),
      (destroyed_msg = destroyed_msg || "Object has already been destroyed");
    let proxy_repr,
      proxy_type = proxy.type;
    try {
      proxy_repr = proxy.toString();
    } catch (e) {
      if (e.pyodide_fatal_error) throw e;
    }
    (proxy.$$.ptr = 0),
      (destroyed_msg += `\nThe object was of type "${proxy_type}" and `),
      (destroyed_msg += proxy_repr
        ? `had repr "${proxy_repr}"`
        : "an error was raised when trying to generate its repr"),
      (proxy.$$.destroyed_msg = destroyed_msg),
      pyproxy_decref_cache(proxy.$$.cache);
    try {
      Module._Py_DecRef(ptrobj), trace_pyproxy_dealloc(proxy);
    } catch (e) {
      API.fatal_error(e);
    }
  }),
    (Module.callPyObjectKwargs = function (ptrobj, ...jsargs) {
      let kwargs = jsargs.pop(),
        num_pos_args = jsargs.length,
        kwargs_names = Object.keys(kwargs),
        kwargs_values = Object.values(kwargs),
        num_kwargs = kwargs_names.length;
      jsargs.push(...kwargs_values);
      let idresult,
        idargs = Hiwire.new_value(jsargs),
        idkwnames = Hiwire.new_value(kwargs_names);
      try {
        idresult = Module.__pyproxy_apply(
          ptrobj,
          idargs,
          num_pos_args,
          idkwnames,
          num_kwargs
        );
      } catch (e) {
        API.fatal_error(e);
      } finally {
        Hiwire.decref(idargs), Hiwire.decref(idkwnames);
      }
      0 === idresult && Module._pythonexc2js();
      let result = Hiwire.pop_value(idresult);
      return (
        result &&
          "coroutine" === result.type &&
          result._ensure_future &&
          result._ensure_future(),
        result
      );
    }),
    (Module.callPyObject = function (ptrobj, ...jsargs) {
      return Module.callPyObjectKwargs(ptrobj, ...jsargs, {});
    });
  class PyProxyClass {
    constructor() {
      throw new TypeError("PyProxy is not a constructor");
    }
    get [Symbol.toStringTag]() {
      return "PyProxy";
    }
    get type() {
      let ptrobj = _getPtr(this);
      return Hiwire.pop_value(Module.__pyproxy_type(ptrobj));
    }
    toString() {
      let jsref_repr,
        ptrobj = _getPtr(this);
      try {
        jsref_repr = Module.__pyproxy_repr(ptrobj);
      } catch (e) {
        API.fatal_error(e);
      }
      return (
        0 === jsref_repr && Module._pythonexc2js(), Hiwire.pop_value(jsref_repr)
      );
    }
    destroy(destroyed_msg) {
      Module.pyproxy_destroy(this, destroyed_msg);
    }
    copy() {
      let ptrobj = _getPtr(this);
      return Module.pyproxy_new(ptrobj, this.$$.cache);
    }
    toJs({
      depth: depth = -1,
      pyproxies: pyproxies,
      create_pyproxies: create_pyproxies = !0,
      dict_converter: dict_converter,
      default_converter: default_converter,
    } = {}) {
      let idresult,
        proxies_id,
        ptrobj = _getPtr(this),
        dict_converter_id = 0,
        default_converter_id = 0;
      (proxies_id = create_pyproxies
        ? pyproxies
          ? Hiwire.new_value(pyproxies)
          : Hiwire.new_value([])
        : 0),
        dict_converter &&
          (dict_converter_id = Hiwire.new_value(dict_converter)),
        default_converter &&
          (default_converter_id = Hiwire.new_value(default_converter));
      try {
        idresult = Module._python2js_custom(
          ptrobj,
          depth,
          proxies_id,
          dict_converter_id,
          default_converter_id
        );
      } catch (e) {
        API.fatal_error(e);
      } finally {
        Hiwire.decref(proxies_id),
          Hiwire.decref(dict_converter_id),
          Hiwire.decref(default_converter_id);
      }
      return (
        0 === idresult && Module._pythonexc2js(), Hiwire.pop_value(idresult)
      );
    }
    supportsLength() {
      return !!(1 & this.$$flags);
    }
    supportsGet() {
      return !!(2 & this.$$flags);
    }
    supportsSet() {
      return !!(4 & this.$$flags);
    }
    supportsHas() {
      return !!(8 & this.$$flags);
    }
    isIterable() {
      return !!(48 & this.$$flags);
    }
    isIterator() {
      return !!(32 & this.$$flags);
    }
    isAwaitable() {
      return !!(64 & this.$$flags);
    }
    isBuffer() {
      return !!(128 & this.$$flags);
    }
    isCallable() {
      return !!(256 & this.$$flags);
    }
  }
  class PyProxyLengthMethods {
    get length() {
      let length,
        ptrobj = _getPtr(this);
      try {
        length = Module._PyObject_Size(ptrobj);
      } catch (e) {
        API.fatal_error(e);
      }
      return -1 === length && Module._pythonexc2js(), length;
    }
  }
  class PyProxyGetItemMethods {
    get(key) {
      let idresult,
        ptrobj = _getPtr(this),
        idkey = Hiwire.new_value(key);
      try {
        idresult = Module.__pyproxy_getitem(ptrobj, idkey);
      } catch (e) {
        API.fatal_error(e);
      } finally {
        Hiwire.decref(idkey);
      }
      if (0 === idresult) {
        if (!Module._PyErr_Occurred()) return;
        Module._pythonexc2js();
      }
      return Hiwire.pop_value(idresult);
    }
  }
  class PyProxySetItemMethods {
    set(key, value) {
      let errcode,
        ptrobj = _getPtr(this),
        idkey = Hiwire.new_value(key),
        idval = Hiwire.new_value(value);
      try {
        errcode = Module.__pyproxy_setitem(ptrobj, idkey, idval);
      } catch (e) {
        API.fatal_error(e);
      } finally {
        Hiwire.decref(idkey), Hiwire.decref(idval);
      }
      -1 === errcode && Module._pythonexc2js();
    }
    delete(key) {
      let errcode,
        ptrobj = _getPtr(this),
        idkey = Hiwire.new_value(key);
      try {
        errcode = Module.__pyproxy_delitem(ptrobj, idkey);
      } catch (e) {
        API.fatal_error(e);
      } finally {
        Hiwire.decref(idkey);
      }
      -1 === errcode && Module._pythonexc2js();
    }
  }
  class PyProxyContainsMethods {
    has(key) {
      let result,
        ptrobj = _getPtr(this),
        idkey = Hiwire.new_value(key);
      try {
        result = Module.__pyproxy_contains(ptrobj, idkey);
      } catch (e) {
        API.fatal_error(e);
      } finally {
        Hiwire.decref(idkey);
      }
      return -1 === result && Module._pythonexc2js(), 1 === result;
    }
  }
  class PyProxyIterableMethods {
    [Symbol.iterator]() {
      let iterptr,
        ptrobj = _getPtr(this),
        token = {};
      try {
        iterptr = Module._PyObject_GetIter(ptrobj);
      } catch (e) {
        API.fatal_error(e);
      }
      0 === iterptr && Module._pythonexc2js();
      let result = (function* (iterptr, token) {
        try {
          let item;
          for (; (item = Module.__pyproxy_iter_next(iterptr)); )
            yield Hiwire.pop_value(item);
        } catch (e) {
          API.fatal_error(e);
        } finally {
          Module.finalizationRegistry.unregister(token),
            Module._Py_DecRef(iterptr);
        }
        Module._PyErr_Occurred() && Module._pythonexc2js();
      })(iterptr, token);
      return (
        Module.finalizationRegistry.register(result, [iterptr, void 0], token),
        result
      );
    }
  }
  class PyProxyIteratorMethods {
    [Symbol.iterator]() {
      return this;
    }
    next(arg) {
      let status,
        done,
        idarg = Hiwire.new_value(arg),
        stackTop = Module.stackSave(),
        res_ptr = Module.stackAlloc(4);
      try {
        status = Module.__pyproxyGen_Send(_getPtr(this), idarg, res_ptr);
      } catch (e) {
        API.fatal_error(e);
      } finally {
        Hiwire.decref(idarg);
      }
      let idresult = Module.HEAPU32[0 + (res_ptr >> 2)];
      return (
        Module.stackRestore(stackTop),
        -1 === status && Module._pythonexc2js(),
        (done = 0 === status),
        { done: done, value: Hiwire.pop_value(idresult) }
      );
    }
  }
  let PyProxyHandlers = {
    isExtensible: () => !0,
    has: (jsobj, jskey) =>
      !!Reflect.has(jsobj, jskey) ||
      ("symbol" != typeof jskey &&
        (jskey.startsWith("$") && (jskey = jskey.slice(1)),
        (function (jsobj, jskey) {
          let result,
            ptrobj = _getPtr(jsobj),
            idkey = Hiwire.new_value(jskey);
          try {
            result = Module.__pyproxy_hasattr(ptrobj, idkey);
          } catch (e) {
            API.fatal_error(e);
          } finally {
            Hiwire.decref(idkey);
          }
          return -1 === result && Module._pythonexc2js(), 0 !== result;
        })(jsobj, jskey))),
    get(jsobj, jskey) {
      if (jskey in jsobj || "symbol" == typeof jskey)
        return Reflect.get(jsobj, jskey);
      jskey.startsWith("$") && (jskey = jskey.slice(1));
      let idresult = (function (jsobj, jskey) {
        let idresult,
          ptrobj = _getPtr(jsobj),
          idkey = Hiwire.new_value(jskey),
          cacheId = jsobj.$$.cache.cacheId;
        try {
          idresult = Module.__pyproxy_getattr(ptrobj, idkey, cacheId);
        } catch (e) {
          API.fatal_error(e);
        } finally {
          Hiwire.decref(idkey);
        }
        return (
          0 === idresult && Module._PyErr_Occurred() && Module._pythonexc2js(),
          idresult
        );
      })(jsobj, jskey);
      return 0 !== idresult ? Hiwire.pop_value(idresult) : void 0;
    },
    set(jsobj, jskey, jsval) {
      let descr = Object.getOwnPropertyDescriptor(jsobj, jskey);
      if (descr && !descr.writable)
        throw new TypeError(`Cannot set read only field '${jskey}'`);
      return "symbol" == typeof jskey
        ? Reflect.set(jsobj, jskey, jsval)
        : (jskey.startsWith("$") && (jskey = jskey.slice(1)),
          (function (jsobj, jskey, jsval) {
            let errcode,
              ptrobj = _getPtr(jsobj),
              idkey = Hiwire.new_value(jskey),
              idval = Hiwire.new_value(jsval);
            try {
              errcode = Module.__pyproxy_setattr(ptrobj, idkey, idval);
            } catch (e) {
              API.fatal_error(e);
            } finally {
              Hiwire.decref(idkey), Hiwire.decref(idval);
            }
            -1 === errcode && Module._pythonexc2js();
          })(jsobj, jskey, jsval),
          !0);
    },
    deleteProperty(jsobj, jskey) {
      let descr = Object.getOwnPropertyDescriptor(jsobj, jskey);
      if (descr && !descr.writable)
        throw new TypeError(`Cannot delete read only field '${jskey}'`);
      return "symbol" == typeof jskey
        ? Reflect.deleteProperty(jsobj, jskey)
        : (jskey.startsWith("$") && (jskey = jskey.slice(1)),
          (function (jsobj, jskey) {
            let errcode,
              ptrobj = _getPtr(jsobj),
              idkey = Hiwire.new_value(jskey);
            try {
              errcode = Module.__pyproxy_delattr(ptrobj, idkey);
            } catch (e) {
              API.fatal_error(e);
            } finally {
              Hiwire.decref(idkey);
            }
            -1 === errcode && Module._pythonexc2js();
          })(jsobj, jskey),
          !descr || !!descr.configurable);
    },
    ownKeys(jsobj) {
      let idresult,
        ptrobj = _getPtr(jsobj);
      try {
        idresult = Module.__pyproxy_ownKeys(ptrobj);
      } catch (e) {
        API.fatal_error(e);
      }
      0 === idresult && Module._pythonexc2js();
      let result = Hiwire.pop_value(idresult);
      return result.push(...Reflect.ownKeys(jsobj)), result;
    },
    apply: (jsobj, jsthis, jsargs) => jsobj.apply(jsthis, jsargs),
  };
  class PyProxyAwaitableMethods {
    _ensure_future() {
      if (this.$$.promise) return this.$$.promise;
      let resolveHandle,
        rejectHandle,
        errcode,
        ptrobj = _getPtr(this),
        promise = new Promise((resolve, reject) => {
          (resolveHandle = resolve), (rejectHandle = reject);
        }),
        resolve_handle_id = Hiwire.new_value(resolveHandle),
        reject_handle_id = Hiwire.new_value(rejectHandle);
      try {
        errcode = Module.__pyproxy_ensure_future(
          ptrobj,
          resolve_handle_id,
          reject_handle_id
        );
      } catch (e) {
        API.fatal_error(e);
      } finally {
        Hiwire.decref(reject_handle_id), Hiwire.decref(resolve_handle_id);
      }
      return (
        -1 === errcode && Module._pythonexc2js(),
        (this.$$.promise = promise),
        this.destroy(),
        promise
      );
    }
    then(onFulfilled, onRejected) {
      return this._ensure_future().then(onFulfilled, onRejected);
    }
    catch(onRejected) {
      return this._ensure_future().catch(onRejected);
    }
    finally(onFinally) {
      return this._ensure_future().finally(onFinally);
    }
  }
  class PyProxyCallableMethods {
    apply(jsthis, jsargs) {
      return Module.callPyObject(_getPtr(this), ...jsargs);
    }
    call(jsthis, ...jsargs) {
      return Module.callPyObject(_getPtr(this), ...jsargs);
    }
    callKwargs(...jsargs) {
      if (0 === jsargs.length)
        throw new TypeError(
          "callKwargs requires at least one argument (the key word argument object)"
        );
      let kwargs = jsargs[jsargs.length - 1];
      if (void 0 !== kwargs.constructor && "Object" !== kwargs.constructor.name)
        throw new TypeError("kwargs argument is not an object");
      return Module.callPyObjectKwargs(_getPtr(this), ...jsargs);
    }
  }
  PyProxyCallableMethods.prototype.prototype = Function.prototype;
  let baseURL,
    type_to_array_map = new Map([
      ["i8", Int8Array],
      ["u8", Uint8Array],
      ["u8clamped", Uint8ClampedArray],
      ["i16", Int16Array],
      ["u16", Uint16Array],
      ["i32", Int32Array],
      ["u32", Uint32Array],
      ["i32", Int32Array],
      ["u32", Uint32Array],
      ["i64", globalThis.BigInt64Array],
      ["u64", globalThis.BigUint64Array],
      ["f32", Float32Array],
      ["f64", Float64Array],
      ["dataview", DataView],
    ]);
  class PyProxyBufferMethods {
    getBuffer(type) {
      let ArrayType;
      if (
        type &&
        ((ArrayType = type_to_array_map.get(type)), void 0 === ArrayType)
      )
        throw new Error(`Unknown type ${type}`);
      let errcode,
        HEAPU32 = Module.HEAPU32,
        orig_stack_ptr = Module.stackSave(),
        buffer_struct_ptr = Module.stackAlloc(
          HEAPU32[0 + (Module._buffer_struct_size >> 2)]
        ),
        this_ptr = _getPtr(this);
      try {
        errcode = Module.__pyproxy_get_buffer(buffer_struct_ptr, this_ptr);
      } catch (e) {
        API.fatal_error(e);
      }
      -1 === errcode && Module._pythonexc2js();
      let startByteOffset = HEAPU32[0 + (buffer_struct_ptr >> 2)],
        minByteOffset = HEAPU32[1 + (buffer_struct_ptr >> 2)],
        maxByteOffset = HEAPU32[2 + (buffer_struct_ptr >> 2)],
        readonly = !!HEAPU32[3 + (buffer_struct_ptr >> 2)],
        format_ptr = HEAPU32[4 + (buffer_struct_ptr >> 2)],
        itemsize = HEAPU32[5 + (buffer_struct_ptr >> 2)],
        shape = Hiwire.pop_value(HEAPU32[6 + (buffer_struct_ptr >> 2)]),
        strides = Hiwire.pop_value(HEAPU32[7 + (buffer_struct_ptr >> 2)]),
        view_ptr = HEAPU32[8 + (buffer_struct_ptr >> 2)],
        c_contiguous = !!HEAPU32[9 + (buffer_struct_ptr >> 2)],
        f_contiguous = !!HEAPU32[10 + (buffer_struct_ptr >> 2)],
        format = Module.UTF8ToString(format_ptr);
      Module.stackRestore(orig_stack_ptr);
      let success = !1;
      try {
        let bigEndian = !1;
        void 0 === ArrayType &&
          ([ArrayType, bigEndian] = Module.processBufferFormatString(
            format,
            " In this case, you can pass an explicit type argument."
          ));
        let alignment =
          parseInt(ArrayType.name.replace(/[^0-9]/g, "")) / 8 || 1;
        if (bigEndian && alignment > 1)
          throw new Error(
            "Javascript has no native support for big endian buffers. In this case, you can pass an explicit type argument. For instance, `getBuffer('dataview')` will return a `DataView`which has native support for reading big endian data. Alternatively, toJs will automatically convert the buffer to little endian."
          );
        let numBytes = maxByteOffset - minByteOffset;
        if (
          0 !== numBytes &&
          (startByteOffset % alignment != 0 ||
            minByteOffset % alignment != 0 ||
            maxByteOffset % alignment != 0)
        )
          throw new Error(
            `Buffer does not have valid alignment for a ${ArrayType.name}`
          );
        let data,
          numEntries = numBytes / alignment,
          offset = (startByteOffset - minByteOffset) / alignment;
        data =
          0 === numBytes
            ? new ArrayType()
            : new ArrayType(HEAPU32.buffer, minByteOffset, numEntries);
        for (let i of strides.keys()) strides[i] /= alignment;
        return (
          (success = !0),
          Object.create(
            PyBuffer.prototype,
            Object.getOwnPropertyDescriptors({
              offset: offset,
              readonly: readonly,
              format: format,
              itemsize: itemsize,
              ndim: shape.length,
              nbytes: numBytes,
              shape: shape,
              strides: strides,
              data: data,
              c_contiguous: c_contiguous,
              f_contiguous: f_contiguous,
              _view_ptr: view_ptr,
              _released: !1,
            })
          )
        );
      } finally {
        if (!success)
          try {
            Module._PyBuffer_Release(view_ptr), Module._PyMem_Free(view_ptr);
          } catch (e) {
            API.fatal_error(e);
          }
      }
    }
  }
  class PyBuffer {
    constructor() {
      throw new TypeError("PyBuffer is not a constructor");
    }
    release() {
      if (!this._released) {
        try {
          Module._PyBuffer_Release(this._view_ptr),
            Module._PyMem_Free(this._view_ptr);
        } catch (e) {
          API.fatal_error(e);
        }
        (this._released = !0), (this.data = null);
      }
    }
  }
  const package_uri_regexp = /^.*?([^\/]*)\.whl$/;
  function _uri_to_package_name(package_uri) {
    let match = package_uri_regexp.exec(package_uri);
    if (match) {
      return match[1].toLowerCase().split("-").slice(0, -4).join("-");
    }
  }
  function addPackageToLoad(name, toLoad, toLoadShared) {
    if (((name = name.toLowerCase()), toLoad.has(name))) return;
    const pkg_info = API.packages[name];
    if (!pkg_info) throw new Error(`No known package with name '${name}'`);
    if (
      (pkg_info.shared_library
        ? toLoadShared.set(name, "default channel")
        : toLoad.set(name, "default channel"),
      void 0 === loadedPackages[name])
    )
      for (let dep_name of pkg_info.depends)
        addPackageToLoad(dep_name, toLoad, toLoadShared);
  }
  function downloadPackage(name, channel) {
    return __awaiter(this, void 0, void 0, function* () {
      let file_name;
      if ("default channel" === channel) {
        if (!(name in API.packages))
          throw new Error(`Internal error: no entry for package named ${name}`);
        file_name = API.packages[name].file_name;
      } else file_name = channel;
      return yield _loadBinaryFile(baseURL, file_name);
    });
  }
  function installPackage(name, buffer) {
    return __awaiter(this, void 0, void 0, function* () {
      let pkg = API.packages[name];
      pkg ||
        (pkg = {
          file_name: ".whl",
          install_dir: "site",
          shared_library: !1,
          depends: [],
          imports: [],
        });
      const filename = pkg.file_name,
        dynlibs = API.package_loader.unpack_buffer.callKwargs({
          buffer: buffer,
          filename: filename,
          target: pkg.install_dir,
          calculate_dynlibs: !0,
        });
      for (const dynlib of dynlibs)
        yield loadDynlib(dynlib, pkg.shared_library);
      loadedPackages[name] = pkg;
    });
  }
  function createLock() {
    let _lock = Promise.resolve();
    return function () {
      return __awaiter(this, void 0, void 0, function* () {
        const old_lock = _lock;
        let releaseLock;
        return (
          (_lock = new Promise((resolve) => (releaseLock = resolve))),
          yield old_lock,
          releaseLock
        );
      });
    };
  }
  const acquireDynlibLock = createLock();
  function loadDynlib(lib, shared) {
    return __awaiter(this, void 0, void 0, function* () {
      let byteArray;
      byteArray =
        Module.FS.lookupPath(lib).node.mount.type == Module.FS.filesystems.MEMFS
          ? Module.FS.filesystems.MEMFS.getFileDataAsTypedArray(
              Module.FS.lookupPath(lib).node
            )
          : Module.FS.readFile(lib);
      const releaseDynlibLock = yield acquireDynlibLock();
      try {
        const module = yield Module.loadWebAssemblyModule(byteArray, {
          loadAsync: !0,
          nodelete: !0,
          allowUndefined: !0,
        });
        (Module.preloadedWasm[lib] = module),
          (Module.preloadedWasm[lib.split("/").pop()] = module),
          shared &&
            Module.loadDynamicLibrary(lib, { global: !0, nodelete: !0 });
      } catch (e) {
        if (e.message.includes("need to see wasm magic number"))
          return void console.warn(
            `Failed to load dynlib ${lib}. We probably just tried to load a linux .so file or something.`
          );
        throw e;
      } finally {
        releaseDynlibLock();
      }
    });
  }
  Tests.loadDynlib = loadDynlib;
  const acquirePackageLock = createLock();
  function loadPackage(names, messageCallback, errorCallback) {
    return __awaiter(this, void 0, void 0, function* () {
      (messageCallback = messageCallback || console.log),
        (errorCallback = errorCallback || console.error),
        isPyProxy(names) && (names = names.toJs()),
        Array.isArray(names) || (names = [names]);
      const [toLoad, toLoadShared] = (function (names, errorCallback) {
        const toLoad = new Map(),
          toLoadShared = new Map();
        for (let name of names) {
          const pkgname = _uri_to_package_name(name);
          void 0 !== pkgname
            ? toLoad.has(pkgname) && toLoad.get(pkgname) !== name
              ? errorCallback(
                  `Loading same package ${pkgname} from ${name} and ${toLoad.get(
                    pkgname
                  )}`
                )
              : toLoad.set(pkgname, name)
            : addPackageToLoad(name, toLoad, toLoadShared);
        }
        return [toLoad, toLoadShared];
      })(names, errorCallback);
      for (const [pkg, uri] of [...toLoad, ...toLoadShared]) {
        const loaded = loadedPackages[pkg];
        void 0 !== loaded &&
          (toLoad.delete(pkg),
          toLoadShared.delete(pkg),
          loaded === uri || "default channel" === uri
            ? messageCallback(`${pkg} already loaded from ${loaded}`)
            : errorCallback(
                `URI mismatch, attempting to load package ${pkg} from ${uri} while it is already loaded from ${loaded}. To override a dependency, load the custom package first.`
              ));
      }
      if (0 === toLoad.size && 0 === toLoadShared.size)
        return void messageCallback("No new packages to load");
      const packageNames = [...toLoad.keys(), ...toLoadShared.keys()].join(
          ", "
        ),
        releaseLock = yield acquirePackageLock();
      try {
        messageCallback(`Loading ${packageNames}`);
        const sharedLibraryLoadPromises = {},
          packageLoadPromises = {};
        for (const [name, channel] of toLoadShared)
          loadedPackages[name]
            ? toLoadShared.delete(name)
            : (sharedLibraryLoadPromises[name] = downloadPackage(
                name,
                channel
              ));
        for (const [name, channel] of toLoad)
          loadedPackages[name]
            ? toLoad.delete(name)
            : (packageLoadPromises[name] = downloadPackage(name, channel));
        const loaded = [],
          failed = {},
          sharedLibraryInstallPromises = {},
          packageInstallPromises = {};
        for (const [name, channel] of toLoadShared)
          sharedLibraryInstallPromises[name] = sharedLibraryLoadPromises[name]
            .then((buffer) =>
              __awaiter(this, void 0, void 0, function* () {
                yield installPackage(name, buffer),
                  loaded.push(name),
                  (loadedPackages[name] = channel);
              })
            )
            .catch((err) => {
              console.warn(err), (failed[name] = err);
            });
        yield Promise.all(Object.values(sharedLibraryInstallPromises));
        for (const [name, channel] of toLoad)
          packageInstallPromises[name] = packageLoadPromises[name]
            .then((buffer) =>
              __awaiter(this, void 0, void 0, function* () {
                yield installPackage(name, buffer),
                  loaded.push(name),
                  (loadedPackages[name] = channel);
              })
            )
            .catch((err) => {
              console.warn(err), (failed[name] = err);
            });
        if (
          (yield Promise.all(Object.values(packageInstallPromises)),
          Module.reportUndefinedSymbols(),
          loaded.length > 0)
        ) {
          const successNames = loaded.join(", ");
          messageCallback(`Loaded ${successNames}`);
        }
        if (Object.keys(failed).length > 0) {
          const failedNames = Object.keys(failed).join(", ");
          messageCallback(`Failed to load ${failedNames}`);
          for (const [name, err] of Object.entries(failed))
            console.warn(`The following error occurred while loading ${name}:`),
              console.error(err);
        }
        API.importlib.invalidate_caches();
      } finally {
        releaseLock();
      }
    });
  }
  let loadedPackages = {};
  function ensureCaughtObjectIsError(e) {
    if ("string" == typeof e) e = new Error(e);
    else if (
      "object" != typeof e ||
      null === e ||
      "string" != typeof e.stack ||
      "string" != typeof e.message
    ) {
      let msg = `A value of type ${typeof e} with tag ${Object.prototype.toString.call(
        e
      )} was thrown as an error!`;
      try {
        msg += `\nString interpolation of the thrown value gives """${e}""".`;
      } catch (e) {
        msg += "\nString interpolation of the thrown value fails.";
      }
      try {
        msg += `\nThe thrown value's toString method returns """${e.toString()}""".`;
      } catch (e) {
        msg += "\nThe thrown value's toString method fails.";
      }
      e = new Error(msg);
    }
    return e;
  }
  API.dump_traceback = function () {
    Module.__Py_DumpTraceback(1, Module._PyGILState_GetThisThreadState());
  };
  let fatal_error_occurred = !1;
  API.fatal_error = function (e) {
    if (!e || !e.pyodide_fatal_error) {
      if (fatal_error_occurred)
        return (
          console.error("Recursive call to fatal_error. Inner error was:"),
          void console.error(e)
        );
      ((e =
        "number" == typeof e
          ? convertCppException(e)
          : ensureCaughtObjectIsError(e)).pyodide_fatal_error = !0),
        (fatal_error_occurred = !0),
        console.error(
          "Pyodide has suffered a fatal error. Please report this to the Pyodide maintainers."
        ),
        console.error("The cause of the fatal error was:"),
        API.inTestHoist
          ? (console.error(e.toString()), console.error(e.stack))
          : console.error(e);
      try {
        API.dump_traceback();
        for (let key of Object.keys(API.public_api))
          key.startsWith("_") ||
            "version" === key ||
            Object.defineProperty(API.public_api, key, {
              enumerable: !0,
              configurable: !0,
              get: () => {
                throw new Error(
                  "Pyodide already fatally failed and can no longer be used."
                );
              },
            });
        API.on_fatal && API.on_fatal(e);
      } catch (err2) {
        console.error("Another error occurred while handling the fatal error:"),
          console.error(err2);
      }
      throw e;
    }
  };
  class CppException extends Error {
    constructor(ty, msg) {
      super(msg), (this.ty = ty);
    }
  }
  function convertCppException(ptr) {
    const [exc_type_name, is_exception_subclass, adjusted_ptr] = (function (
      ptr
    ) {
      const base_exception_type = Module._exc_type(),
        caught_exception_type = new Module.ExceptionInfo(ptr).get_type(),
        stackTop = Module.stackSave(),
        exceptionThrowBuf = Module.stackAlloc(4);
      Module.HEAP32[exceptionThrowBuf / 4] = ptr;
      const exc_type_name = Module.demangle(
          Module.UTF8ToString(Module._exc_typename(caught_exception_type))
        ),
        is_exception_subclass = !!Module.___cxa_can_catch(
          base_exception_type,
          caught_exception_type,
          exceptionThrowBuf
        ),
        adjusted_ptr = Module.HEAP32[exceptionThrowBuf / 4];
      return (
        Module.stackRestore(stackTop),
        [exc_type_name, is_exception_subclass, adjusted_ptr]
      );
    })(ptr);
    let msg;
    if (is_exception_subclass) {
      const msgPtr = Module._exc_what(adjusted_ptr);
      msg = Module.UTF8ToString(msgPtr);
    } else msg = `The exception is an object of type ${exc_type_name} at address ${ptr} which does not inherit from std::exception`;
    return new CppException(exc_type_name, msg);
  }
  function isPyodideFrame(frame) {
    const fileName = frame.fileName || "";
    if (fileName.includes("pyodide.asm")) return !0;
    if (fileName.includes("wasm-function")) return !0;
    if (!fileName.includes("pyodide.js")) return !1;
    let funcName = frame.functionName || "";
    return (
      funcName.startsWith("Object.") &&
        (funcName = funcName.slice("Object.".length)),
      !(funcName in API.public_api) ||
        "PythonError" === funcName ||
        ((frame.functionName = funcName), !1)
    );
  }
  Object.defineProperty(CppException.prototype, "name", {
    get() {
      return `${this.constructor.name} ${this.ty}`;
    },
  }),
    (Tests.convertCppException = convertCppException),
    (Module.handle_js_error = function (e) {
      if (e && e.pyodide_fatal_error) throw e;
      if (e instanceof Module._PropagatePythonError) return;
      let stack,
        weirdCatch,
        restored_error = !1;
      e instanceof API.PythonError &&
        (restored_error = Module._restore_sys_last_exception(
          e.__error_address
        ));
      try {
        stack = ErrorStackParser.parse(e);
      } catch (_) {
        weirdCatch = !0;
      }
      if ((weirdCatch && (e = ensureCaughtObjectIsError(e)), !restored_error)) {
        let eidx = Hiwire.new_value(e),
          err = Module._JsProxy_create(eidx);
        Module._set_error(err), Module._Py_DecRef(err), Hiwire.decref(eidx);
      }
      if (!weirdCatch) {
        if (
          (function (frame) {
            if (!isPyodideFrame(frame)) return !1;
            const funcName = frame.functionName;
            return "PythonError" === funcName || "new_error" === funcName;
          })(stack[0])
        )
          for (; isPyodideFrame(stack[0]); ) stack.shift();
        for (const frame of stack) {
          if (isPyodideFrame(frame)) break;
          const funcnameAddr = Module.stringToNewUTF8(
              frame.functionName || "???"
            ),
            fileNameAddr = Module.stringToNewUTF8(frame.fileName || "???.js");
          Module.__PyTraceback_Add(
            funcnameAddr,
            fileNameAddr,
            frame.lineNumber
          ),
            Module._free(funcnameAddr),
            Module._free(fileNameAddr);
        }
      }
    });
  class PythonError extends Error {
    constructor(message, error_address) {
      const oldLimit = Error.stackTraceLimit;
      (Error.stackTraceLimit = 1 / 0),
        super(message),
        (Error.stackTraceLimit = oldLimit),
        (this.__error_address = error_address);
    }
  }
  Object.defineProperty(PythonError.prototype, "name", {
    value: PythonError.name,
  }),
    (API.PythonError = PythonError);
  class _PropagatePythonError extends Error {
    constructor() {
      (API.fail_test = !0),
        super(
          "If you are seeing this message, an internal Pyodide error has occurred. Please report it to the Pyodide maintainers."
        );
    }
  }
  Object.defineProperty(_PropagatePythonError.prototype, "name", {
    value: _PropagatePythonError.name,
  }),
    (Module._PropagatePythonError = _PropagatePythonError);
  let runPythonPositionalGlobalsDeprecationWarned = !1;
  function runPython(code, options = {}) {
    return (
      API.isPyProxy(options) &&
        ((options = { globals: options }),
        runPythonPositionalGlobalsDeprecationWarned ||
          (console.warn(
            "Passing a PyProxy as the second argument to runPython is deprecated and will be removed in v0.21. Use 'runPython(code, {globals : some_dict})' instead."
          ),
          (runPythonPositionalGlobalsDeprecationWarned = !0))),
      options.globals || (options.globals = API.globals),
      API.pyodide_py.eval_code(code, options.globals)
    );
  }
  function loadPackagesFromImports(code, messageCallback, errorCallback) {
    return __awaiter(this, void 0, void 0, function* () {
      let imports,
        pyimports = API.pyodide_py.find_imports(code);
      try {
        imports = pyimports.toJs();
      } finally {
        pyimports.destroy();
      }
      if (0 === imports.length) return;
      let packageNames = API._import_name_to_package_name,
        packages = new Set();
      for (let name of imports)
        packageNames.has(name) && packages.add(packageNames.get(name));
      packages.size &&
        (yield loadPackage(
          Array.from(packages),
          messageCallback,
          errorCallback
        ));
    });
  }
  function runPythonAsync(code, options = {}) {
    return __awaiter(this, void 0, void 0, function* () {
      return (
        API.isPyProxy(options) &&
          ((options = { globals: options }),
          runPythonPositionalGlobalsDeprecationWarned ||
            (console.warn(
              "Passing a PyProxy as the second argument to runPythonAsync is deprecated and will be removed in v0.21. Use 'runPythonAsync(code, {globals : some_dict})' instead."
            ),
            (runPythonPositionalGlobalsDeprecationWarned = !0))),
        options.globals || (options.globals = API.globals),
        yield API.pyodide_py.eval_code_async(code, options.globals)
      );
    });
  }
  function registerJsModule(name, module) {
    API.pyodide_py.register_js_module(name, module);
  }
  function registerComlink(Comlink) {
    API._Comlink = Comlink;
  }
  function unregisterJsModule(name) {
    API.pyodide_py.unregister_js_module(name);
  }
  function toPy(
    obj,
    { depth: depth, defaultConverter: defaultConverter } = { depth: -1 }
  ) {
    switch (typeof obj) {
      case "string":
      case "number":
      case "boolean":
      case "bigint":
      case "undefined":
        return obj;
    }
    if (!obj || API.isPyProxy(obj)) return obj;
    let obj_id = 0,
      py_result = 0,
      result = 0;
    try {
      obj_id = Hiwire.new_value(obj);
      try {
        py_result = Module.js2python_convert(obj_id, {
          depth: depth,
          defaultConverter: defaultConverter,
        });
      } catch (e) {
        throw (
          (e instanceof Module._PropagatePythonError && Module._pythonexc2js(),
          e)
        );
      }
      if (Module._JsProxy_Check(py_result)) return obj;
      (result = Module._python2js(py_result)),
        0 === result && Module._pythonexc2js();
    } finally {
      Hiwire.decref(obj_id), Module._Py_DecRef(py_result);
    }
    return Hiwire.pop_value(result);
  }
  function pyimport(mod_name) {
    return API.importlib.import_module(mod_name);
  }
  (API.runPython = runPython), (API.runPythonAsync = runPythonAsync);
  let FS,
    runPythonInternal_dict,
    unpackArchivePositionalExtractDirDeprecationWarned = !1;
  function unpackArchive(buffer, format, options = {}) {
    "string" == typeof options &&
      (unpackArchivePositionalExtractDirDeprecationWarned ||
        (console.warn(
          "Passing a string as the third argument to unpackArchive is deprecated and will be removed in v0.21. Instead use { extract_dir : 'some_path' }"
        ),
        (unpackArchivePositionalExtractDirDeprecationWarned = !0)),
      (options = { extractDir: options }));
    let extract_dir = options.extractDir;
    API.package_loader.unpack_buffer.callKwargs({
      buffer: buffer,
      format: format,
      extract_dir: extract_dir,
    });
  }
  function setInterruptBuffer(interrupt_buffer) {
    (Module.HEAP8[Module._Py_EMSCRIPTEN_SIGNAL_HANDLING] = !!interrupt_buffer),
      (Module.Py_EmscriptenSignalBuffer = interrupt_buffer);
  }
  function checkInterrupt() {
    Module.__PyErr_CheckSignals() && Module._pythonexc2js();
  }
  function makePublicAPI() {
    FS = Module.FS;
    let namespace = {
      globals: undefined,
      FS: FS,
      pyodide_py: undefined,
      version: "",
      loadPackage: loadPackage,
      loadPackagesFromImports: loadPackagesFromImports,
      loadedPackages: loadedPackages,
      isPyProxy: isPyProxy,
      runPython: runPython,
      runPythonAsync: runPythonAsync,
      registerJsModule: registerJsModule,
      unregisterJsModule: unregisterJsModule,
      setInterruptBuffer: setInterruptBuffer,
      checkInterrupt: checkInterrupt,
      toPy: toPy,
      pyimport: pyimport,
      unpackArchive: unpackArchive,
      registerComlink: registerComlink,
      PythonError: PythonError,
      PyBuffer: PyBuffer,
      _module: Module,
      _api: API,
    };
    return (API.public_api = namespace), namespace;
  }
  function finalizeBootstrap(config) {
    (runPythonInternal_dict = API._pyodide._base.eval_code("{}")),
      (API.importlib = API.runPythonInternal("import importlib; importlib"));
    let import_module = API.importlib.import_module;
    (API.sys = import_module("sys")), API.sys.path.insert(0, config.homedir);
    let globals = API.runPythonInternal("import __main__; __main__.__dict__"),
      builtins = API.runPythonInternal("import builtins; builtins.__dict__");
    var builtins_dict;
    API.globals =
      ((builtins_dict = builtins),
      new Proxy(globals, {
        get: (target, symbol) =>
          "get" === symbol
            ? (key) => {
                let result = target.get(key);
                return (
                  void 0 === result && (result = builtins_dict.get(key)), result
                );
              }
            : "has" === symbol
            ? (key) => target.has(key) || builtins_dict.has(key)
            : Reflect.get(target, symbol),
      }));
    let importhook = API._pyodide._importhook;
    importhook.register_js_finder(),
      importhook.register_js_module("js", config.jsglobals);
    let pyodide = makePublicAPI();
    return (
      importhook.register_js_module("pyodide_js", pyodide),
      (API.pyodide_py = import_module("pyodide")),
      (API.package_loader = import_module("pyodide._package_loader")),
      (API.version = API.pyodide_py.__version__),
      (pyodide.pyodide_py = API.pyodide_py),
      (pyodide.version = API.version),
      (pyodide.globals = API.globals),
      pyodide
    );
  }
  function loadPyodide(options = {}) {
    return __awaiter(this, void 0, void 0, function* () {
      if (loadPyodide.inProgress)
        throw new Error("Pyodide is already loading.");
      options.indexURL ||
        (options.indexURL = (function () {
          let err;
          try {
            throw new Error();
          } catch (e) {
            err = e;
          }
          const fileName = ErrorStackParser.parse(err)[0].fileName;
          return fileName.slice(0, fileName.lastIndexOf("/"));
        })()),
        (loadPyodide.inProgress = !0);
      const default_config = {
        fullStdLib: !0,
        jsglobals: globalThis,
        stdin: globalThis.prompt ? globalThis.prompt : void 0,
        homedir: "/home/pyodide",
      };
      let config = Object.assign(default_config, options);
      config.indexURL.endsWith("/") || (config.indexURL += "/"),
        yield (function () {
          return __awaiter(this, void 0, void 0, function* () {
            IN_NODE &&
              ((nodePathMod = (yield import('path')).default),
              (nodeFsPromisesMod = yield import('fs/promises')),
              (nodeFetch = (yield import('node-fetch')).default),
              (nodeVmMod = (yield import('vm')).default));
          });
        })();
      let packageIndexReady = (function (indexURL) {
          return __awaiter(this, void 0, void 0, function* () {
            let package_json;
            if (((baseURL = indexURL), IN_NODE)) {
              const package_string = yield nodeFsPromisesMod.readFile(
                `${indexURL}packages.json`
              );
              package_json = JSON.parse(package_string);
            } else {
              let response = yield fetch(`${indexURL}packages.json`);
              package_json = yield response.json();
            }
            if (!package_json.packages)
              throw new Error(
                "Loaded packages.json does not contain the expected key 'packages'."
              );
            (API.packages = package_json.packages),
              (API._import_name_to_package_name = new Map());
            for (let name of Object.keys(API.packages))
              for (let import_name of API.packages[name].imports)
                API._import_name_to_package_name.set(import_name, name);
          });
        })(config.indexURL),
        pyodide_py_tar_promise = _loadBinaryFile(
          config.indexURL,
          "pyodide_py.tar"
        );
      var path;
      setStandardStreams(config.stdin, config.stdout, config.stderr),
        (path = config.homedir),
        Module.preRun.push(function () {
          try {
            Module.FS.mkdirTree(path);
          } catch (e) {
            console.error(
              `Error occurred while making a home directory '${path}':`
            ),
              console.error(e),
              console.error("Using '/' for a home directory instead"),
              (path = "/");
          }
          (Module.ENV.HOME = path), Module.FS.chdir(path);
        });
      let moduleLoaded = new Promise((r) => (Module.postRun = r));
      Module.locateFile = (path) => config.indexURL + path;
      const scriptSrc = `${config.indexURL}pyodide.asm.js`;
      yield loadScript(scriptSrc),
        yield _createPyodideModule(Module),
        yield moduleLoaded,
        (Module.locateFile = (path) => {
          throw new Error(
            "Didn't expect to load any more file_packager files!"
          );
        });
      !(function (pyodide_py_tar) {
        let stream = Module.FS.open("/pyodide_py.tar", "w");
        Module.FS.write(
          stream,
          pyodide_py_tar,
          0,
          pyodide_py_tar.byteLength,
          void 0,
          !0
        ),
          Module.FS.close(stream);
        const code_ptr = Module.stringToNewUTF8(
          '\nfrom sys import version_info\npyversion = f"python{version_info.major}.{version_info.minor}"\nimport shutil\nshutil.unpack_archive("/pyodide_py.tar", f"/lib/{pyversion}/site-packages/")\ndel shutil\nimport importlib\nimportlib.invalidate_caches()\ndel importlib\n    '
        );
        if (Module._PyRun_SimpleString(code_ptr)) throw new Error("OOPS!");
        Module._free(code_ptr), Module.FS.unlink("/pyodide_py.tar");
      })(yield pyodide_py_tar_promise),
        Module._pyodide_init();
      let pyodide = finalizeBootstrap(config);
      return (
        yield packageIndexReady,
        config.fullStdLib && (yield loadPackage(["distutils"])),
        pyodide.runPython("print('Python initialization complete')"),
        pyodide
      );
    });
  }
  (API.saveState = () => API.pyodide_py._state.save_state()),
    (API.restoreState = (state) => API.pyodide_py._state.restore_state(state)),
    (API.runPythonInternal = function (code) {
      return API._pyodide._base.eval_code(code, runPythonInternal_dict);
    }),
    (globalThis.loadPyodide = loadPyodide),
    (exports.loadPyodide = loadPyodide),
    Object.defineProperty(exports, "__esModule", { value: !0 });
});

class Detector {
  cameraWrap = document.createElement("div");
  loader = document.createElement("div");
  canvas = document.createElement("canvas");
  video = document.createElement("video");

  stream = null;
  model = null;
  videoWidth = 320;
  videoHeight = 320;
  rotate = "horizontal";
  section = {
    dx: 0,
    dy: 0,
    width: 0,
    height: 0,
  };

  isMobile = navigator.userAgent.toLocaleLowerCase().includes("mobile");
  isCapture = false;
  isLoading = false;
  isDetect = false;
  isAnimate = false;
  isWorker = true;
  isSafari = navigator.userAgent.toLocaleLowerCase().includes("safari");

  loaderCallback = null;

  square = [];

  worker = null;

  constructor() {
    this.isWorker = !this.isSafari;
    if (this.isWorker && window.Worker) {
      this.worker = new Worker("./module/worker.js", { type: "module" });
      this.worker.onmessage = async (e) => {
        switch (e.data.type) {
          case "setModel":
            this.isLoading = true;
            this.loader.style.display = "none";
            if (this.loaderCallback) {
              this.loaderCallback();
            }
            break;
          case "getCapture":
            this.setLine(e.data.square);
            if (e.data.square.length === 0) {
              this.square = [];
            }
            break;
          case "getAnimate":
            this.isDetect = false;

            if (this.isCapture) {
              return;
            }
            await this.clearCanvas();
            await this.setSection();
            await this.setLine(e.data.square);
            if (e.data.square.length === 0) {
              this.square = [];
            }
            this.animate();
            break;
        }
      };
    }

    this.setModel();
    this.setElement();
    this.setDevice();
    this.setSection();

    window.addEventListener("beforeunload", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.clearVideo();
    });
  }

  setElement() {
    this.cameraWrap.classList.add("camera-wrap");
    this.cameraWrap.style.position = "relative";
    this.cameraWrap.style.display = "flex";
    this.cameraWrap.style.alignItems = "center";
    this.cameraWrap.style.justifyContent = "center";
    this.cameraWrap.style.width = "100%";
    this.cameraWrap.style.height = "100%";
    this.cameraWrap.style.overflow = "hidden";
    this.cameraWrap.style.maxWidth = `${this.videoWidth}px`;
    this.cameraWrap.style.maxHeight = `${this.videoHeight}px`;

    this.loader.classList.add("loader");
    this.loader.innerText = "Loading...";
    this.loader.style.position = "absolute";
    this.loader.style.display = "flex";
    this.loader.style.justifyContent = "center";
    this.loader.style.alignItems = "center";
    this.loader.style.color = "white";
    this.loader.style.width = "100%";
    this.loader.style.height = "100%";
    this.loader.style.backgroundColor = "rgba(0, 0, 0, 0.8)";

    this.canvas.classList.add("canvas");
    this.canvas.style.position = "absolute";
    this.canvas.style.backgroundColor = "transparent";

    this.ctx = this.canvas.getContext("2d");

    this.video.classList.add("video");
    this.video.style.zIndex = "-1";
    this.video.autoplay = true;
    this.video.muted = true;
    this.video.playsInline = true;

    this.cameraWrap.appendChild(this.loader);
    this.cameraWrap.appendChild(this.video);
    this.cameraWrap.appendChild(this.canvas);
  }

  async setDevice() {
    try {
      const initalConstrains = {
        audio: false,
        video: {
          facingMode: "environment",
          width: this.videoWidth,
          height: this.videoHeight,
        },
      };
      const cameraConstrainsts = {
        audio: false,
        video: {
          width: this.videoWidth,
          height: this.videoHeight,
        },
      };
      if (!navigator.mediaDevices.getUserMedia) {
        return;
      }
      this.stream = await navigator.mediaDevices.getUserMedia(
        !this.isMobile ? cameraConstrainsts : initalConstrains
      );

      this.video.srcObject = this.stream;
    } catch (error) {
      console.error(error);
    }
  }

  async setSection() {
    this.clearCanvas();
    this.section.width = this.videoWidth - this.section.dx * 2;
    this.section.height = this.videoHeight - this.section.dy * 2;
    this.canvas.width = this.videoWidth;
    this.canvas.height = this.videoHeight;
    this.ctx.save();
    this.ctx.strokeStyle = "lightgoldenrodyellow";
    this.ctx.lineWidth = 3;
    this.ctx.strokeRect(10, 10, this.videoWidth - 20, this.videoHeight - 20);
    this.ctx.restore();
  }

  async setLine(square) {
    if (square.length === 0) {
      return;
    }
    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.moveTo(square[0][0], square[0][1]);
    this.ctx.lineTo(square[1][0], square[1][1]);
    this.ctx.lineTo(square[2][0], square[2][1]);
    this.ctx.lineTo(square[3][0], square[3][1]);
    this.ctx.lineTo(square[0][0], square[0][1]);
    this.ctx.strokeStyle = "red";
    this.ctx.lineWidth = 2;
    this.ctx.stroke();
    this.ctx.restore();
    this.square = square;
  }

  async setLoaderCallback(c) {
    this.loaderCallback = c;
  }

  async setModel() {
    if (this.isWorker && window.Worker) {
      this.worker.postMessage({ type: "setModel" });
    } else {
      // 모델 로드
      this.model = await load("./module/tfjs320f16/model.json");
      this.isLoading = true;
      this.loader.style.display = "none";
      if (this.loaderCallback) {
        this.loaderCallback();
      }
    }
  }

  async capture() {
    if (!this.isLoading) {
      return;
    }
    await this.setRealtimeDetect(false);
    this.isCapture = true;
    this.isAnimate = false;
    this.clearCanvas();

    this.canvas.width = this.videoWidth;
    this.canvas.height = this.videoHeight;

    this.ctx.drawImage(this.video, 0, 0, this.videoWidth, this.videoHeight);

    const dataUrl = await this.canvas.toDataURL();

    if (this.isWorker && window.Worker) {
      const { data } = this.ctx.getImageData(0, 0, 320, 320);
      this.worker.postMessage({ type: "getCapture", rgb: data });
    } else {
      const imgEl = new Image();
      imgEl.src = dataUrl;
      imgEl.onload = (async () => {
        imgEl.width = 320;
        imgEl.height = 320;
        const img = window.tf.browser.fromPixels(imgEl);
        const square = await detect(img, this.model);
        await this.setLine(square);
        if (square.length === 0) {
          this.square = [];
        }
      }).bind(this);
    }
  }

  async setRealtimeDetect(is = true) {
    this.isAnimate = is;

    if (is) {
      this.animate();
    } else {
      this.isDetect = false;
    }
  }

  async animate(t = 0) {
    if (!this.isAnimate || !this.isLoading) {
      return;
    }
    if (!this.isDetect) {
      this.isDetect = true;
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      canvas.width = this.videoWidth;
      canvas.height = this.videoHeight;

      ctx.drawImage(this.video, 0, 0, this.videoWidth, this.videoHeight);

      if (this.isWorker && window.Worker) {
        const { data } = ctx.getImageData(0, 0, 320, 320);
        this.worker.postMessage({ type: "getAnimate", rgb: data });
        return;
      } else {
        const dataUrl = await canvas.toDataURL();
        const imgEl = new Image();
        imgEl.src = dataUrl;
        imgEl.onload = (async () => {
          if (this.isCapture) {
            return;
          }
          imgEl.width = 320;
          imgEl.height = 320;
          const img = window.tf.browser.fromPixels(imgEl);
          const square = await detect(img, this.model);
          await this.clearCanvas();
          await this.setSection();
          await this.setLine(square);
          if (square.length === 0) {
            this.square = [];
          }
          this.isDetect = false;
        }).bind(this);
      }
    }

    requestAnimationFrame(this.animate.bind(this));
  }

  async resetCapture() {
    this.clearCanvas();
    this.setSection();
    this.isCapture = false;
  }

  getSquare() {
    return square;
  }

  clearCanvas() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  clearVideo() {
    this.video.pause();
    this.video.src = "";
    this.stream.getTracks()[0].stop();
  }

  getElement() {
    return this.cameraWrap;
  }
}

export { Detector as default };