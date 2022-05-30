export async function pred_squares(pyodide, pts, pts_score, vmap) {
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

export function pred_squares_numjs(pts_num, pts_score_num, vmap_num) {
  let input_shape = [320, 320];
  let image_shape = [320, 320];
  let params = {
    score: 0.1,
    outside_ratio: 0.1,
    inside_ratio: 0.5,
    w_overlap: 0.0,
    w_degree: 1.14,
    w_length: 0.03,
    w_area: 1.84,
    w_center: 1.46,
  };

  let segments = get_segments_list(
    pts_num,
    pts_score_num,
    vmap_num,
    params["score"]
  );

  ////// post processing for squares //////
  // 1. get unique lines
  const merged_segments = get_unique_lines(segments, pts_num.length);
  // 2. get intersections
  const get_intersections_result = get_intersections(merged_segments);
  // 3. get corner information
  return get_corner_information(
    get_intersections_result[0],
    get_intersections_result[1],
    get_intersections_result[2],
    get_intersections_result[3],
    get_intersections_result[4],
    get_intersections_result[5],
    input_shape,
    image_shape,
    params
  );
}

function get_segments_list(pts_num, pts_score_num, vmap_num, t_score) {
  const pts = nj.array(pts_num).reshape(-1, 2);
  const pts_score = nj.array(pts_score_num);
  const vmap = nj
    .array(vmap_num)
    .reshape(Math.sqrt(vmap_num.length / 4), Math.sqrt(vmap_num.length / 4), 4);
  const start = vmap.slice(null, null, [2]);
  const end = vmap.slice(null, null, 2);
  const dist_map_temp = start.subtract(end).pow(2);

  const new_dist_map = [];
  for (let i = 0; i < dist_map_temp.shape[0]; i++) {
    for (let y = 0; y < dist_map_temp.shape[1]; y++) {
      new_dist_map.push(
        nj.sqrt(dist_map_temp.get(i, y, 0) + dist_map_temp.get(i, y, 1)).get(0)
      );
    }
  }
  const dist_map = nj
    .array(new_dist_map)
    .reshape(dist_map_temp.shape[0], dist_map_temp.shape[1]);

  const junc_list = [];
  const segments_list = [];
  for (let i = 0; i < pts.shape[0]; i++) {
    const y = pts.get(i, 0);
    const x = pts.get(i, 1);
    const score = pts_score.get(i);
    const distance = dist_map.get(y, x);
    if (score > t_score && distance > 20.0) {
      junc_list.push([y, x]);
      const vmap_temp = vmap.slice([y, y + 1], [x, x + 1], null).reshape(4);
      const disp_x_start = vmap_temp.get(0);
      const disp_y_start = vmap_temp.get(1);
      const disp_x_end = vmap_temp.get(2);
      const disp_y_end = vmap_temp.get(3);
      const d_arrow = 1.0;
      const x_start = x + d_arrow * disp_x_start;
      const y_start = y + d_arrow * disp_y_start;
      const x_end = x + d_arrow * disp_x_end;
      const y_end = y + d_arrow * disp_y_end;
      segments_list.push(x_start, y_start, x_end, y_end);
    }
  }
  const segments = nj.array(segments_list).reshape(-1, 4);
  return segments;
}

function get_unique_lines(segments, pts_size) {
  const point = nj.array([0, 0]);
  const start = segments.slice(null, [2]);
  const end = segments.slice(null, 2);
  const diff = start.subtract(end);
  const a = diff.slice(null, [1, 2]);
  const b = diff.slice(null, [0, 1]).multiply(-1);
  const c = a
    .multiply(start.slice(null, [0, 1]))
    .add(b.multiply(start.slice(null, [1, 2])));

  const d = nj
    .abs(a.multiply(point.get(0)).add(b.multiply(point.get(1)).subtract(c)))
    .divide(nj.sqrt(a.pow(2).add(b.pow(2).add(1e-10))));

  const theta_temp = [];
  for (let i = 0; i < diff.shape[0]; i++) {
    theta_temp.push(
      (Math.atan2(diff.get(i, 0), diff.get(i, 1)) * 180) / Math.PI
    );
  }
  const theta = nj.array(theta_temp);

  for (let i = 0; i < theta.shape[0]; i++) {
    if (theta.get(i) < 0.0) {
      theta.set(i, theta.get(i) + 180);
    }
  }
  const hough = nj.concatenate(
    d.reshape(d.shape[0], 1),
    theta.reshape(theta.shape[0], 1)
  );
  const d_quant = 1;
  const theta_quant = 2;

  for (let i = 0; i < hough.shape[0]; i++) {
    hough.set(i, 0, parseInt(String(hough.get(i, 0) / d_quant)));
    hough.set(i, 1, parseInt(String(hough.get(i, 1) / theta_quant)));
  }
  let sorted_hough = hough.tolist().sort(function (a, b) {
    return parseInt(a[0]) - parseInt(b[0]);
  });
  sorted_hough = sorted_hough.filter((element, index) => {
    return (
      sorted_hough.findIndex(
        (item) => item[0] === element[0] && item[1] === element[1]
      ) === index
    );
  });
  let counts = [];
  let indices = [];
  for (let i = 0; i < sorted_hough.length; i++) {
    let cout = 0;
    let ind = 0;
    for (let y = 0; y < hough.shape[0]; y++) {
      if (
        sorted_hough[i][0] == hough.get(y, 0) &&
        sorted_hough[i][1] == hough.get(y, 1)
      ) {
        if (cout == 0) {
          ind = y;
        }
        cout += 1;
      }
    }
    counts.push(cout);
    indices.push(ind);
  }

  let acc_map = nj.float32(
    nj.zeros([
      parseInt(String(512 / d_quant + 1)),
      parseInt(String(360 / theta_quant + 1)),
    ])
  );
  const idx_map = nj
    .int32(
      nj.zeros([
        parseInt(String(512 / d_quant + 1)),
        parseInt(String(360 / theta_quant + 1)),
      ])
    )
    .subtract(1);

  const yx_indices_temp = [];
  for (let idx in indices) {
    yx_indices_temp.push(
      hough.get(indices[idx], 0),
      hough.get(indices[idx], 1)
    );
  }
  const yx_indices = nj
    .int32(yx_indices_temp)
    .reshape(yx_indices_temp.length / 2, 2);

  const yx_indices_0 = yx_indices
    .slice(null, [0, 1])
    .reshape(yx_indices.shape[0]);
  const yx_indices_1 = yx_indices
    .slice(null, [1, 2])
    .reshape(yx_indices.shape[0]);

  for (let i = 0; i < yx_indices_0.shape[0]; i++) {
    acc_map.set(yx_indices_0.get(i), yx_indices_1.get(i), counts[i]);
  }
  for (let i = 0; i < yx_indices_0.shape[0]; i++) {
    idx_map.set(yx_indices_0.get(i), yx_indices_1.get(i), indices[i]);
  }
  const acc_map_np = acc_map.clone();
  acc_map = acc_map.reshape(1, acc_map.shape[0], acc_map.shape[1], 1);

  /// fast suppression using tensorflow op
  acc_map = tf.tensor(acc_map.tolist());
  const max_acc_map = tf.layers
    .maxPool2d({ poolSize: [5, 5], strides: 1, padding: "same" })
    .apply(acc_map);
  acc_map = tf.mul(acc_map, tf.cast(tf.equal(acc_map, max_acc_map), "float32"));
  const flatten_acc_map = tf.reshape(acc_map, [1, -1]);

  const topk_result = tf.topk(flatten_acc_map, pts_size / 2);
  let topk_values = topk_result["values"];
  const topk_indices = topk_result["indices"];

  const h = acc_map.shape[1];
  const w = acc_map.shape[2];
  const y = tf.cast(topk_indices.div(w), "int32").expandDims(-1);
  const x = topk_indices.mod(w).expandDims(-1);
  let yx = tf.concat([y, x], -1);
  ///

  yx = nj.array(Array.from(yx.dataSync())).reshape(yx.shape[1], -1);
  const indices_xy_0 = yx.slice(null, [0, 1]).reshape(yx.shape[0]);
  const indices_xy_1 = yx.slice(null, [1, 2]).reshape(yx.shape[0]);
  const indices_temp = [];
  for (let [i, v] of Object.entries(indices_xy_0.tolist())) {
    indices_temp.push(idx_map.get(v, indices_xy_1.get(i)));
  }
  indices = nj.array(indices_temp);
  topk_values = nj.array(Array.from(topk_values.dataSync()));
  const basis = parseInt(String(5 / 2));

  const merged_segments = [];
  for (let i = 0; i < yx.shape[0]; i++) {
    const y = yx.get(i, 0);
    const x = yx.get(i, 1);
    const max_indice = indices.get(i);
    const value = topk_values.get(i);
    if (max_indice == -1 || value == 0) {
      continue;
    }
    const segment_list = [];
    for (let y_offset = -basis; y_offset < basis + 1; y_offset++) {
      for (let x_offset = -basis; x_offset < basis + 1; x_offset++) {
        const indice = idx_map.get(y + y_offset, x + x_offset);
        const cnt = parseInt(acc_map_np.get(y + y_offset, x + x_offset));
        if (indice != -1) {
          segment_list.push([
            segments.get(indice, 0),
            segments.get(indice, 1),
            segments.get(indice, 2),
            segments.get(indice, 3),
          ]);
        }
        if (cnt > 1) {
          let check_cnt = 1;
          let current_hough = [hough.get(indice, 0), hough.get(indice, 1)];
          for (let new_indice = 0; new_indice < hough.shape[0]; new_indice++) {
            const new_hough = [
              hough.get(new_indice, 0),
              hough.get(new_indice, 1),
            ];
            if (
              current_hough[0] == new_hough[0] &&
              current_hough[1] == new_hough[1] &&
              indice != new_indice
            ) {
              segment_list.push([
                segments.get(new_indice, 0),
                segments.get(new_indice, 1),
                segments.get(new_indice, 2),
                segments.get(new_indice, 3),
              ]);
              check_cnt += 1;
            }
            if (check_cnt == cnt) {
              break;
            }
          }
        }
      }
    }
    const group_segments = nj.array(segment_list).reshape(-1, 2);

    let sort_0 = [];
    let sort_1 = [];
    for (let i = 0; i < group_segments.shape[0]; i++) {
      sort_0.push([group_segments.get(i, 0)]);
      sort_1.push([group_segments.get(i, 1)]);
    }
    sort_0.sort((a, b) => a[0] - b[0]);
    sort_1.sort((a, b) => a[0] - b[0]);

    const sorted_group_segments = nj.array(nj.concatenate([sort_0, sort_1]));
    const min_value = sorted_group_segments
      .slice([0, 1], null)
      .reshape(sorted_group_segments.shape[1]);
    const max_value = sorted_group_segments
      .slice(-1, null)
      .reshape(sorted_group_segments.shape[1]);

    const x_min = min_value.get(0);
    const y_min = min_value.get(1);
    const x_max = max_value.get(0);
    const y_max = max_value.get(1);

    const deg = theta.get(max_indice);
    if (deg >= 90) {
      merged_segments.push([x_min, y_max, x_max, y_min]);
    } else {
      merged_segments.push([x_min, y_min, x_max, y_max]);
    }
  }
  return merged_segments;
}

function get_intersections(merged_segments) {
  const new_segments = nj.array(merged_segments); // (x1, y1, x2, y2)
  const start = new_segments.slice(null, [2]); // (x1, y1)
  const end = new_segments.slice(null, 2); // (x1, y1)
  const new_centers = start.add(end).divide(2.0);
  const diff = start.subtract(end);
  const diff_pow = diff.pow(2);
  const nj_sum = diff_pow.slice(null, [1]).add(diff_pow.slice(null, 1));
  const dist_segments = nj.sqrt(nj_sum);

  // // ax + by = c
  const a = diff.slice(null, [1, 2]);
  const b = diff.slice(null, [0, 1]).multiply(-1);
  const c = a
    .multiply(start.slice(null, [0, 1]))
    .add(b.multiply(start.slice(null, [1, 2])));
  const pre_det = a.dot(b.reshape(1, b.shape[0]));
  const det = pre_det.subtract(pre_det.T);

  const pre_inter_y = a.dot(c.reshape(1, c.shape[0]));
  const inter_y = pre_inter_y.subtract(pre_inter_y.T).divide(det.add(1e-10));
  const pre_inter_x = c.dot(b.reshape(1, b.shape[0]));
  const inter_x = pre_inter_x.subtract(pre_inter_x.T).divide(det.add(1e-10));
  const inter_pts_temp = nj.concatenate(
    inter_x.reshape(inter_x.shape[0], inter_x.shape[0], 1),
    inter_y.reshape(inter_y.shape[0], inter_y.shape[0], 1)
  );
  const inter_pts = nj.int32(inter_pts_temp.tolist());

  return [inter_pts, start, end, new_centers, dist_segments, new_segments];
}

function get_corner_information(
  inter_pts,
  start,
  end,
  new_centers,
  dist_segments,
  new_segments,
  input_shape,
  image_shape,
  params
) {
  // 3. get corner information
  // 3.1 get distance
  const get_distance_result = get_distance(inter_pts, start, end);
  // # 3.2 get degree
  return get_degree(
    get_distance_result[0],
    get_distance_result[1],
    new_centers,
    inter_pts,
    dist_segments,
    new_segments,
    input_shape,
    image_shape,
    params
  );
}

function get_distance(inter_pts, start, end) {
  // 3.1 get distance

  /** 
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
    **/
  inter_pts = nj.float32(inter_pts.tolist());

  let seg1_start_temp = nj.zeros(
    [inter_pts.shape[0], inter_pts.shape[0], 2],
    "float32"
  );
  for (let i = 0; i < inter_pts.shape[0]; i++) {
    for (let y = 0; y < inter_pts.shape[0]; y++) {
      seg1_start_temp.set(i, y, 0, start.get(i, 0));
      seg1_start_temp.set(i, y, 1, start.get(i, 1));
    }
  }
  seg1_start_temp = inter_pts.subtract(seg1_start_temp).pow(2);
  const seg1_start_sum = [];
  for (let i = 0; i < inter_pts.shape[0]; i++) {
    for (let y = 0; y < inter_pts.shape[0]; y++) {
      seg1_start_sum.push(
        nj
          .sqrt(seg1_start_temp.get(i, y, 0) + seg1_start_temp.get(i, y, 1))
          .get(0)
      );
    }
  }
  const dist_inter_to_segment1_start = nj
    .array(seg1_start_sum)
    .reshape(inter_pts.shape[0], inter_pts.shape[0], 1); // [n_batch, n_batch, 1]

  let seg1_end_temp = nj.zeros(
    [inter_pts.shape[0], inter_pts.shape[0], 2],
    "float32"
  );
  for (let i = 0; i < inter_pts.shape[0]; i++) {
    for (let y = 0; y < inter_pts.shape[0]; y++) {
      seg1_end_temp.set(i, y, 0, end.get(i, 0));
      seg1_end_temp.set(i, y, 1, end.get(i, 1));
    }
  }
  seg1_end_temp = inter_pts.subtract(seg1_end_temp).pow(2);
  const seg1_end_sum = [];
  for (let i = 0; i < inter_pts.shape[0]; i++) {
    for (let y = 0; y < inter_pts.shape[0]; y++) {
      seg1_end_sum.push(
        nj.sqrt(seg1_end_temp.get(i, y, 0) + seg1_end_temp.get(i, y, 1)).get(0)
      );
    }
  }
  const dist_inter_to_segment1_end = nj
    .array(seg1_end_sum)
    .reshape(inter_pts.shape[0], inter_pts.shape[0], 1); // [n_batch, n_batch, 1]

  let seg2_start_temp = nj.zeros(
    [inter_pts.shape[0], inter_pts.shape[0], 2],
    "float32"
  );
  for (let i = 0; i < inter_pts.shape[0]; i++) {
    for (let y = 0; y < inter_pts.shape[0]; y++) {
      seg2_start_temp.set(y, i, 0, start.get(i, 0));
      seg2_start_temp.set(y, i, 1, start.get(i, 1));
    }
  }
  seg2_start_temp = inter_pts.subtract(seg2_start_temp).pow(2);
  const seg2_start_sum = [];
  for (let i = 0; i < inter_pts.shape[0]; i++) {
    for (let y = 0; y < inter_pts.shape[0]; y++) {
      seg2_start_sum.push(
        nj
          .sqrt(seg2_start_temp.get(i, y, 0) + seg2_start_temp.get(i, y, 1))
          .get(0)
      );
    }
  }
  const dist_inter_to_segment2_start = nj
    .array(seg2_start_sum)
    .reshape(inter_pts.shape[0], inter_pts.shape[0], 1); // [n_batch, n_batch, 1]

  let seg2_end_temp = nj.zeros(
    [inter_pts.shape[0], inter_pts.shape[0], 2],
    "float32"
  );
  for (let i = 0; i < inter_pts.shape[0]; i++) {
    for (let y = 0; y < inter_pts.shape[0]; y++) {
      seg2_end_temp.set(y, i, 0, end.get(i, 0));
      seg2_end_temp.set(y, i, 1, end.get(i, 1));
    }
  }
  seg2_end_temp = inter_pts.subtract(seg2_end_temp).pow(2);
  const seg2_end_sum = [];
  for (let i = 0; i < inter_pts.shape[0]; i++) {
    for (let y = 0; y < inter_pts.shape[0]; y++) {
      seg2_end_sum.push(
        nj.sqrt(seg2_end_temp.get(i, y, 0) + seg2_end_temp.get(i, y, 1)).get(0)
      );
    }
  }
  const dist_inter_to_segment2_end = nj
    .array(seg2_end_sum)
    .reshape(inter_pts.shape[0], inter_pts.shape[0], 1); // [n_batch, n_batch, 1]

  // sort ascending
  const dist_inter_to_segment1 = nj.concatenate([
    dist_inter_to_segment1_start,
    dist_inter_to_segment1_end,
  ]); // [n_batch, n_batch, 2]
  const dist_inter_to_segment2 = nj.concatenate([
    dist_inter_to_segment2_start,
    dist_inter_to_segment2_end,
  ]); // [n_batch, n_batch, 2]

  for (let [i, v] of Object.entries([
    dist_inter_to_segment1,
    dist_inter_to_segment2,
  ])) {
    for (let i = 0; i < v.shape[0]; i++) {
      for (let y = 0; y < v.shape[0]; y++) {
        const get_0 = v.get(i, y, 0);
        const get_1 = v.get(i, y, 1);
        if (get_0 > get_1) {
          v.set(i, y, 0, get_1);
          v.set(i, y, 1, get_0);
        }
      }
    }
  }
  return [dist_inter_to_segment1, dist_inter_to_segment2];
}

function get_degree(
  dist_inter_to_segment1,
  dist_inter_to_segment2,
  new_centers,
  inter_pts,
  dist_segments,
  new_segments,
  input_shape,
  original_shape,
  params
) {
  dist_segments = dist_segments.reshape(dist_segments.shape[0]);
  const inter_to_start = mid_expansion(new_centers, inter_pts.shape).subtract(
    inter_pts
  );
  const deg_inter_to_start_temp = [];
  for (let i = 0; i < inter_to_start.shape[0]; i++) {
    for (let y = 0; y < inter_to_start.shape[1]; y++) {
      deg_inter_to_start_temp.push(
        (Math.atan2(inter_to_start.get(i, y, 1), inter_to_start.get(i, y, 0)) *
          180) /
          Math.PI
      );
    }
  }
  const deg_inter_to_start = nj
    .array(deg_inter_to_start_temp)
    .reshape(inter_to_start.shape[0], -1);
  for (let i = 0; i < deg_inter_to_start.shape[0]; i++) {
    for (let y = 0; y < deg_inter_to_start.shape[1]; y++) {
      if (deg_inter_to_start.get(i, y) < 0.0) {
        deg_inter_to_start.set(i, y, deg_inter_to_start.get(i, y) + 360);
      }
    }
  }
  const inter_to_end = front_expansion(new_centers, inter_pts.shape).subtract(
    inter_pts
  );
  const deg_inter_to_end_temp = [];
  for (let i = 0; i < inter_to_end.shape[0]; i++) {
    for (let y = 0; y < inter_to_end.shape[1]; y++) {
      deg_inter_to_end_temp.push(
        (Math.atan2(inter_to_end.get(i, y, 1), inter_to_end.get(i, y, 0)) *
          180) /
          Math.PI
      );
    }
  }
  const deg_inter_to_end = nj
    .array(deg_inter_to_end_temp)
    .reshape(inter_to_end.shape[0], -1);
  for (let i = 0; i < deg_inter_to_end.shape[0]; i++) {
    for (let y = 0; y < deg_inter_to_end.shape[1]; y++) {
      if (deg_inter_to_end.get(i, y) < 0.0) {
        deg_inter_to_end.set(i, y, deg_inter_to_end.get(i, y) + 360);
      }
    }
  }

  // rename variables
  const deg1_map = deg_inter_to_start;
  const deg2_map = deg_inter_to_end;
  // sort deg ascending
  const deg_sort = nj.concatenate([
    deg1_map.reshape(deg1_map.shape[0], deg1_map.shape[1], 1),
    deg2_map.reshape(deg2_map.shape[0], deg2_map.shape[1], 1),
  ]);

  for (let i = 0; i < deg_sort.shape[0]; i++) {
    for (let y = 0; y < deg_sort.shape[0]; y++) {
      const get_0 = deg_sort.get(i, y, 0);
      const get_1 = deg_sort.get(i, y, 1);
      if (get_0 > get_1) {
        deg_sort.set(i, y, 0, get_1);
        deg_sort.set(i, y, 1, get_0);
      }
    }
  }

  const deg_diff_map = nj.abs(deg1_map.subtract(deg2_map));
  // we only consider the smallest degree of intersect
  for (let i = 0; i < deg_diff_map.shape[0]; i++) {
    for (let j = 0; j < deg_diff_map.shape[1]; j++) {
      let v = deg_diff_map.get(i, j);
      if (v > 180) {
        deg_diff_map.set(i, j, 360 - v);
      }
    }
  }

  // define available degree range
  const deg_range = [60, 120];

  const corner_dict = { 0: [], 1: [], 2: [], 3: [] };
  let inter_points = [];
  for (let i = 0; i < inter_pts.shape[0]; i++) {
    for (let j = i + 1; j < inter_pts.shape[1]; j++) {
      // i, j > line index, always i < j
      const x_y = inter_pts.slice([i, i + 1], [j, j + 1], null);
      const x = x_y.get(0, 0, 0);
      const y = x_y.get(0, 0, 1);
      const deg1_2 = deg_sort.slice([i, i + 1], [j, j + 1], null);
      const deg1 = deg1_2.get(0, 0, 0);
      const deg2 = deg1_2.get(0, 0, 1);
      const deg_diff = deg_diff_map.get(i, j);

      const check_degree = deg_diff > deg_range[0] && deg_diff < deg_range[1];

      const outside_ratio = params["outside_ratio"]; // over ratio >>> drop it!
      const inside_ratio = params["inside_ratio"]; // over ratio >>> drop it!

      const check_distance =
        ((dist_inter_to_segment1.get(i, j, 1) >= dist_segments.get(i) &&
          dist_inter_to_segment1.get(i, j, 0) <=
            dist_segments.get(i) * outside_ratio) ||
          (dist_inter_to_segment1.get(i, j, 1) <= dist_segments.get(i) &&
            dist_inter_to_segment1.get(i, j, 0) <=
              dist_segments.get(i) * inside_ratio)) &&
        ((dist_inter_to_segment2.get(i, j, 1) >= dist_segments.get(j) &&
          dist_inter_to_segment2.get(i, j, 0) <=
            dist_segments.get(j) * outside_ratio) ||
          (dist_inter_to_segment2.get(i, j, 1) <= dist_segments.get(j) &&
            dist_inter_to_segment2.get(i, j, 0) <=
              dist_segments.get(j) * inside_ratio));

      if (check_degree && check_distance) {
        let corner_info = null;
        let color_info = null;

        if (
          (deg1 >= 0 && deg1 <= 45 && deg2 >= 45 && deg2 <= 120) ||
          (deg2 >= 315 && deg1 >= 45 && deg1 <= 120)
        ) {
          corner_info = 0;
          color_info = "blue";
        } else if (deg1 >= 45 && deg1 <= 125 && deg2 >= 125 && deg2 <= 225) {
          corner_info = 1;
          color_info = "green";
        } else if (deg1 >= 125 && deg1 <= 225 && deg2 >= 225 && deg2 <= 315) {
          corner_info = 2;
          color_info = "black";
        } else if (
          (deg1 >= 0 && deg1 <= 45 && deg2 >= 225 && deg2 <= 315) ||
          (deg2 >= 315 && deg1 >= 225 && deg1 <= 315)
        ) {
          corner_info = 3;
          color_info = "cyan";
        } else {
          corner_info = 4; // we don't use it
          continue;
        }

        corner_dict[corner_info].push([x, y, i, j]);
        inter_points.push([x, y]);
      }
    }
  }

  const square_list = [];
  const connect_list = [];
  const segments_list = [];
  let connect01 = null;
  let connect12 = null;
  let connect23 = null;
  let corner0_line = null;
  let corner1_line = null;
  let corner2_line = null;
  let corner3_line = null;
  for (let [i, corner0] of Object.entries(corner_dict[0])) {
    for (let [i, corner1] of Object.entries(corner_dict[1])) {
      connect01 = false;

      for (let [i, v0] of Object.entries(corner0.slice(2))) {
        corner0_line = v0;
        if (corner1.slice(2).includes(corner0_line)) {
          connect01 = true;
          break;
        }
      }
      if (connect01) {
        for (let [i, corner2] of Object.entries(corner_dict[2])) {
          connect12 = false;
          for (let [i, v1] of Object.entries(corner1.slice(2))) {
            corner1_line = v1;
            if (corner2.slice(2).includes(corner1_line)) {
              connect12 = true;
              break;
            }
          }
          if (connect12) {
            for (let [i, corner3] of Object.entries(corner_dict[3])) {
              connect23 = false;
              for (let [i, v2] of Object.entries(corner2.slice(2))) {
                corner2_line = v2;
                if (corner3.slice(2).includes(corner2_line)) {
                  connect23 = true;
                  break;
                }
              }
              if (connect23) {
                for (let [i, v3] of Object.entries(corner3.slice(2))) {
                  corner3_line = v3;
                  if (corner0.slice(2).includes(corner3_line)) {
                    // SQUARE!!!

                    /** 
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
                                        **/

                    square_list.push(
                      corner0
                        .slice(undefined, 2)
                        .concat(
                          corner1.slice(undefined, 2),
                          corner2.slice(undefined, 2),
                          corner3.slice(undefined, 2)
                        )
                    );
                    connect_list.push([
                      corner0_line,
                      corner1_line,
                      corner2_line,
                      corner3_line,
                    ]);
                    segments_list.push(
                      corner0
                        .slice(2)
                        .concat(
                          corner1.slice(2),
                          corner2.slice(2),
                          corner3.slice(2)
                        )
                    );
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  function check_outside_inside(segments_info, connect_idx) {
    // return 'outside or inside', min distance, cover_param, peri_param
    segments_info = segments_info.reshape(-1);
    let check_dist_mat = null;
    if (connect_idx == parseInt(segments_info.get(0))) {
      check_dist_mat = dist_inter_to_segment1;
    } else {
      check_dist_mat = dist_inter_to_segment2;
    }

    const i = segments_info.get(0);
    const j = segments_info.get(1);
    const min_dist = check_dist_mat.get(i, j, 0);
    const max_dist = check_dist_mat.get(i, j, 1);
    const connect_dist = dist_segments.get(connect_idx);

    if (max_dist > connect_dist) {
      return ["outside", min_dist, 0, 1];
    } else {
      return ["inside", min_dist, -1, -1];
    }
  }

  let top_square = null;
  let squares = nj.array();
  let score_arrays = null;
  try {
    let map_size = input_shape[0] / 2;
    squares = nj.array(square_list).reshape(-1, 4, 2);
    let score_array = [];
    let connect_array = nj.array(connect_list);
    let segments_array = nj.array(segments_list).reshape([-1, 4, 2]);

    // get degree of corners:
    let squares_rollup_temp = [];
    for (let i = 0; i < squares.shape[0]; i++) {
      for (let k = 0; k < squares.shape[2]; k++) {
        squares_rollup_temp.push(squares.get(i, squares.shape[1] - 1, k));
      }
      for (let j = 0; j < squares.shape[1] - 1; j++) {
        for (let k = 0; k < squares.shape[2]; k++) {
          squares_rollup_temp.push(squares.get(i, j, k));
        }
      }
    }
    let squares_rollup = nj.array(squares_rollup_temp).reshape(-1, 4, 2);
    let squares_rolldown_temp = [];
    for (let i = 0; i < squares.shape[0]; i++) {
      for (let j = 1; j < squares.shape[1]; j++) {
        for (let k = 0; k < squares.shape[2]; k++) {
          squares_rolldown_temp.push(squares.get(i, j, k));
        }
      }
      for (let k = 0; k < squares.shape[2]; k++) {
        squares_rolldown_temp.push(squares.get(i, 0, k));
      }
    }
    let squares_rolldown = nj.array(squares_rolldown_temp).reshape(-1, 4, 2);
    let vec1 = squares_rollup.subtract(squares);
    let vec1_tensor = tf.tensor(vec1.tolist());
    vec1_tensor = tf.norm(vec1_tensor, "euclidean", -1, true);
    let normalized_vec1 = nj
      .array(Array.from(vec1_tensor.dataSync()))
      .add(1e-10);
    normalized_vec1 = vec1.divide(
      nj.stack([normalized_vec1, normalized_vec1], -1).reshape(-1, 4, 2)
    );
    let vec2 = squares_rolldown.subtract(squares);
    let vec2_tensor = tf.tensor(vec2.tolist());
    vec2_tensor = tf.norm(vec2_tensor, "euclidean", -1, true);
    let normalized_vec2 = nj
      .array(Array.from(vec2_tensor.dataSync()))
      .add(1e-10);
    normalized_vec2 = vec2.divide(
      nj.stack([normalized_vec2, normalized_vec2], -1).reshape(-1, 4, 2)
    );
    let inner_products = normalized_vec1.multiply(normalized_vec2);
    let inner_products_temp = [];
    for (let i = 0; i < inner_products.shape[0]; i++) {
      for (let y = 0; y < inner_products.shape[1]; y++) {
        inner_products_temp.push(
          inner_products.get(i, y, 0) + inner_products.get(i, y, 1)
        );
      }
    }
    inner_products = nj.array(inner_products_temp).reshape(-1, 4);
    let squares_degree = nj
      .arccos(inner_products)
      .multiply(180)
      .divide(Math.PI);

    // get square score
    let overlap_scores = [];
    let degree_scores = [];
    let length_scores = [];

    for (let ii = 0; ii < connect_array.shape[0]; ii++) {
      let connects = connect_array.slice([ii, ii + 1], null).reshape(-1);
      let segments = segments_array
        .slice([ii, ii + 1], null, null)
        .reshape(-1, segments_array.shape[2]);
      let square = squares
        .slice([ii, ii + 1], null, null)
        .reshape(-1, squares.shape[2]);
      let degree = squares_degree.slice([ii, ii + 1], null).reshape(-1);

      /** 
            0 -- 1
            |    |
            3 -- 2
            
            # segments: [4, 2]
            # connects: [4]
            **/

      /////////////////////////////////////////// OVERLAP SCORES
      let cover = 0;
      let perimeter = 0;
      // check 0 > 1 > 2 > 3
      let square_length = [];

      for (let start_idx = 0; start_idx < 4; start_idx++) {
        let end_idx = (start_idx + 1) % 4;

        let connect_idx = connects.get(start_idx); // segment idx of segment01
        let start_segments = segments.slice([start_idx, start_idx + 1], null);
        let end_segments = segments.slice([end_idx, end_idx + 1], null);

        let start_point = square.slice([start_idx, start_idx + 1], null);
        let end_point = square.slice([end_idx, end_idx + 1], null);

        // check whether outside or inside
        const [start_position, start_min, start_cover_param, start_peri_param] =
          check_outside_inside(start_segments, connect_idx);
        const [end_position, end_min, end_cover_param, end_peri_param] =
          check_outside_inside(end_segments, connect_idx);

        cover +=
          dist_segments.get(connect_idx) +
          start_cover_param * start_min +
          end_cover_param * end_min;
        perimeter +=
          dist_segments.get(connect_idx) +
          start_peri_param * start_min +
          end_peri_param * end_min;

        square_length.push(
          dist_segments.get(connect_idx) +
            start_peri_param * start_min +
            end_peri_param * end_min
        );
      }

      overlap_scores.push(cover / perimeter);
      ///////////////////////////////////////////
      /////////////////////////////////////////// DEGREE SCORES
      /** 
            deg0 vs deg2
            deg1 vs deg3
            **/
      let deg0 = degree.get(0);
      let deg1 = degree.get(1);
      let deg2 = degree.get(2);
      let deg3 = degree.get(3);
      let deg_ratio1 = deg0 / deg2;
      if (deg_ratio1 > 1.0) {
        deg_ratio1 = 1 / deg_ratio1;
      }
      let deg_ratio2 = deg1 / deg3;
      if (deg_ratio2 > 1.0) {
        deg_ratio2 = 1 / deg_ratio2;
      }
      degree_scores.push((deg_ratio1 + deg_ratio2) / 2);
      ///////////////////////////////////////////
      /////////////////////////////////////////// LENGTH SCORES
      /** 
            len0 vs len2
            len1 vs len3
            **/
      let len0 = square_length[0];
      let len1 = square_length[1];
      let len2 = square_length[2];
      let len3 = square_length[3];
      let len_ratio1 = null;
      let len_ratio2 = null;
      if (len2 > len0) {
        len_ratio1 = len0 / len2;
      } else {
        len_ratio1 = len2 / len0;
      }
      if (len3 > len1) {
        len_ratio2 = len1 / len3;
      } else {
        len_ratio2 = len3 / len1;
      }
      length_scores.push((len_ratio1 + len_ratio2) / 2);
      ///////////////////////////////////////////
    }

    overlap_scores = nj.array(overlap_scores);
    overlap_scores = overlap_scores.divide(nj.max(overlap_scores));

    degree_scores = nj.array(degree_scores);
    // degree_scores /= np.max(degree_scores)

    length_scores = nj.array(length_scores);

    /////////////////////////////////////////// AREA SCORES
    let area_scores = squares.reshape(-1, 4, 2);
    let area_x = area_scores
      .slice(null, null, [0, 1])
      .reshape(area_scores.shape[0], area_scores.shape[1]);
    let area_y = area_scores
      .slice(null, null, [1, 2])
      .reshape(area_scores.shape[0], area_scores.shape[1]);
    let correction = area_x
      .slice(null, -1)
      .reshape(-1)
      .multiply(area_y.slice(null, [0, 1]).reshape(-1))
      .subtract(
        area_y
          .slice(null, -1)
          .reshape(-1)
          .multiply(area_x.slice(null, [0, 1]).reshape(-1))
      );
    let area_scores1 = area_x.slice(null, [-1]).multiply(area_y.slice(null, 1));
    let area_scores2 = area_y.slice(null, [-1]).multiply(area_x.slice(null, 1));
    let area_scores_sum = [];
    for (let i = 0; i < area_scores1.shape[0]; i++) {
      area_scores_sum.push(
        area_scores1.get(i, 0) +
          area_scores1.get(i, 1) +
          area_scores1.get(i, 2) -
          area_scores2.get(i, 0) -
          area_scores2.get(i, 1) -
          area_scores2.get(i, 2)
      );
    }
    area_scores = nj.array(area_scores_sum);
    area_scores = nj.abs(area_scores.add(correction)).multiply(0.5);
    area_scores = area_scores.divide(map_size * map_size); // np.max(area_scores)
    // ///////////////////////////////////////////

    // /////////////////////////////////////////// CENTER SCORES
    let centers = nj.float32([
      [parseInt(String(256 / 2)), parseInt(String(256 / 2))],
    ]); // [1, 2]
    // squares: [n, 4, 2]
    let squares_tensor = tf.tensor(squares.tolist());
    squares_tensor = tf.mean(squares_tensor, 1);
    let square_centers = nj
      .array(Array.from(squares_tensor.dataSync()))
      .reshape(-1, 2); // [n, 2]
    let concat_centers = centers.clone();
    for (let i = 0; i < square_centers.shape[0] - 1; i++) {
      concat_centers = nj.concatenate(concat_centers, centers);
    }
    concat_centers = concat_centers.reshape(-1, 2);
    let center2center_temp = concat_centers.subtract(square_centers).pow(2);
    let new_center2center = [];
    for (let i = 0; i < center2center_temp.shape[0]; i++) {
      new_center2center.push(
        Math.sqrt(center2center_temp.get(i, 0) + center2center_temp.get(i, 1))
      );
    }
    let center2center = nj.array(new_center2center);
    let center_scores = center2center.divide(map_size / Math.sqrt(2.0));

    // /**
    // score_w = [overlap, degree, area, center, length]
    // **/
    let score_w = [0.0, 1.0, 10.0, 0.5, 1.0];
    score_arrays = overlap_scores.multiply(params["w_overlap"]);
    score_arrays = score_arrays.add(degree_scores.multiply(params["w_degree"]));
    score_arrays = score_arrays.add(area_scores.multiply(params["w_area"]));
    score_arrays = score_arrays.subtract(
      center_scores.multiply(params["w_center"])
    );
    score_arrays = score_arrays.add(length_scores.multiply(params["w_length"]));

    let best_square = [];

    let decor = (v, i) => [v, i]; // set index to value
    let undecor = (a) => a[1]; // leave only index
    let argsort = (arr) => arr.map(decor).sort().map(undecor);
    let sorted_idx = argsort(score_arrays.tolist()).reverse();
    score_arrays = sorted_idx.map((i) => score_arrays.tolist()[i]);
    squares = sorted_idx.map((i) => squares.tolist()[i]);
  } catch (e) {}
  let result_segments = null;
  let result_squares = null;
  let result_inter_points = null;
  try {
    result_segments = new_segments.clone();
    let seg_value1 = result_segments
      .slice(null, [0, 1])
      .reshape(-1)
      .multiply((2 / input_shape[1]) * original_shape[1]);
    let seg_value2 = result_segments
      .slice(null, [1, 2])
      .reshape(-1)
      .multiply((2 / input_shape[0]) * original_shape[0]);
    let seg_value3 = result_segments
      .slice(null, [2, 3])
      .reshape(-1)
      .multiply((2 / input_shape[1]) * original_shape[1]);
    let seg_value4 = result_segments
      .slice(null, [3, 4])
      .reshape(-1)
      .multiply((2 / input_shape[0]) * original_shape[0]);
    result_segments = nj.stack(
      [seg_value1, seg_value2, seg_value3, seg_value4],
      -1
    );
  } catch (e) {
    result_segments = [];
  }
  try {
    result_squares = nj.array(squares).clone();
    let square_value1 = result_squares
      .slice(null, null, [0, 1])
      .reshape(-1)
      .multiply((2 / input_shape[1]) * original_shape[1]);
    let square_value2 = result_squares
      .slice(null, null, [1, 2])
      .reshape(-1)
      .multiply((2 / input_shape[0]) * original_shape[0]);
    result_squares = nj
      .stack([square_value1, square_value2], -1)
      .reshape(-1, 4, 2);
  } catch (e) {
    result_squares = [];
    score_arrays = [];
  }
  try {
    result_inter_points = nj.array(inter_points);
    let inter_value1 = result_inter_points
      .slice(null, [0, 1])
      .reshape(-1)
      .multiply((2 / input_shape[1]) * original_shape[1]);
    let inter_value2 = result_inter_points
      .slice(null, [1, 2])
      .reshape(-1)
      .multiply((2 / input_shape[0]) * original_shape[0]);
    result_inter_points = nj.stack([inter_value1, inter_value2], -1);
  } catch (e) {
    inter_points = [];
  }

  result_squares = result_squares.slice([1], null, null).reshape(4, 2).tolist();

  return result_squares;
}

function mid_expansion(arr, shape) {
  let new_arr = nj.zeros([shape[0], shape[1], shape[2]], "float32");
  for (let i = 0; i < shape[0]; i++) {
    for (let y = 0; y < shape[0]; y++) {
      new_arr.set(i, y, 0, arr.get(i, 0));
      new_arr.set(i, y, 1, arr.get(i, 1));
    }
  }
  return new_arr;
}
function front_expansion(arr, shape) {
  let new_arr = nj.zeros([shape[0], shape[1], shape[2]], "float32");
  for (let i = 0; i < shape[0]; i++) {
    for (let y = 0; y < shape[0]; y++) {
      new_arr.set(y, i, 0, arr.get(i, 0));
      new_arr.set(y, i, 1, arr.get(i, 1));
    }
  }
  return new_arr;
}
