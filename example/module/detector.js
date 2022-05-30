function inference_tfjs(e,t){let n=tf.expandDims(e),r=(n=n.toFloat(),t.predict(n));return[Array.from(r[9].dataSync()),Array.from(r[15].dataSync()),Array.from(r[13].dataSync())]}async function pred_squares(e,t,n,r){return e.globals.set("pts",t),e.globals.set("pts_score",n),e.globals.set("vmap",r),e.runPython(`
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
                    check_distance = ((dist_inter_to_segment1[i,j,1] >= dist_segments[i] and                                         dist_inter_to_segment1[i,j,0] <= dist_segments[i] * outside_ratio) or                                         (dist_inter_to_segment1[i,j,1] <= dist_segments[i] and                                         dist_inter_to_segment1[i,j,0] <= dist_segments[i] * inside_ratio)) and                                     ((dist_inter_to_segment2[i,j,1] >= dist_segments[j] and                                         dist_inter_to_segment2[i,j,0] <= dist_segments[j] * outside_ratio) or                                         (dist_inter_to_segment2[i,j,1] <= dist_segments[j] and                                         dist_inter_to_segment2[i,j,0] <= dist_segments[j] * inside_ratio))

                    if check_degree and check_distance:
                        corner_info = None

                        if (deg1 >= 0 and deg1 <= 45 and deg2 >=45 and deg2 <= 120) or                             (deg2 >= 315 and deg1 >= 45 and deg1 <= 120):
                            corner_info, color_info = 0, 'blue'
                        elif (deg1 >= 45 and deg1 <= 125 and deg2 >= 125 and deg2 <= 225):
                            corner_info, color_info = 1, 'green'
                        elif (deg1 >= 125 and deg1 <= 225 and deg2 >= 225 and deg2 <= 315):
                            corner_info, color_info = 2, 'black'
                        elif (deg1 >= 0 and deg1 <= 45 and deg2 >= 225 and deg2 <= 315) or                             (deg2 >= 315 and deg1 >= 225 and deg1 <= 315):
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
                score_array = params['w_overlap'] * overlap_scores                                 + params['w_degree'] * degree_scores                                 + params['w_area'] * area_scores                                 - params['w_center'] * center_scores                                 + params['w_length'] * length_scores

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
    `),e.globals.get("square").toJs()}async function load(e){let t=await tf.loadGraphModel(e);e=tf.zeros([1,320,320,3]).toFloat();t.predict(e);let n=await loadPyodide();return await n.loadPackage("numpy"),await n.runPythonAsync(`
            import os
            import numpy as np
The object was of type "${t}" and `)+(e?`had repr "${e}"`:"an error was raised when trying to generate its repr"),n.$$.destroyed_msg=r,b(n.$$.cache);try{C._Py_DecRef(a),g(n)}catch(e){A.fatal_error(e)}}},C.callPyObjectKwargs=function(e,...t){var n=t.pop(),r=t.length,a=Object.keys(n),n=Object.values(n),i=a.length;t.push(...n);let o,s=N.new_value(t),u=N.new_value(a);try{o=C.__pyproxy_apply(e,s,r,u,i)}catch(e){A.fatal_error(e)}finally{N.decref(s),N.decref(u)}0===o&&C._pythonexc2js();let l=N.pop_value(o);return l&&"coroutine"===l.type&&l._ensure_future&&l._ensure_future(),l},C.callPyObject=function(e,...t){return C.callPyObjectKwargs(e,...t,{})};class x{constructor(){throw new TypeError("PyProxy is not a constructor")}get[Symbol.toStringTag](){return"PyProxy"}get type(){var e=T(this);return N.pop_value(C.__pyproxy_type(e))}toString(){let e,t=T(this);try{e=C.__pyproxy_repr(t)}catch(e){A.fatal_error(e)}return 0===e&&C._pythonexc2js(),N.pop_value(e)}destroy(e){C.pyproxy_destroy(this,e)}copy(){var e=T(this);return C.pyproxy_new(e,this.$$.cache)}toJs({depth:e=-1,pyproxies:t,create_pyproxies:n=!0,dict_converter:r,default_converter:a}={}){let i,o,s=T(this),u=0,l=0;o=n?t?N.new_value(t):N.new_value([]):0,r&&(u=N.new_value(r)),a&&(l=N.new_value(a));try{i=C._python2js_custom(s,e,o,u,l)}catch(e){A.fatal_error(e)}finally{N.decref(o),N.decref(u),N.decref(l)}return 0===i&&C._pythonexc2js(),N.pop_value(i)}supportsLength(){return!!(1&this.$$flags)}supportsGet(){return!!(2&this.$$flags)}supportsSet(){return!!(4&this.$$flags)}supportsHas(){return!!(8&this.$$flags)}isIterable(){return!!(48&this.$$flags)}isIterator(){return!!(32&this.$$flags)}isAwaitable(){return!!(64&this.$$flags)}isBuffer(){return!!(128&this.$$flags)}isCallable(){return!!(256&this.$$flags)}}class z{get length(){let e,t=T(this);try{e=C._PyObject_Size(t)}catch(e){A.fatal_error(e)}return-1===e&&C._pythonexc2js(),e}}class P{get(e){let t,n=T(this),r=N.new_value(e);try{t=C.__pyproxy_getitem(n,r)}catch(e){A.fatal_error(e)}finally{N.decref(r)}if(0===t){if(!C._PyErr_Occurred())return;C._pythonexc2js()}return N.pop_value(t)}}class B{set(e,t){let n,r=T(this),a=N.new_value(e),i=N.new_value(t);try{n=C.__pyproxy_setitem(r,a,i)}catch(e){A.fatal_error(e)}finally{N.decref(a),N.decref(i)}-1===n&&C._pythonexc2js()}delete(e){let t,n=T(this),r=N.new_value(e);try{t=C.__pyproxy_delitem(n,r)}catch(e){A.fatal_error(e)}finally{N.decref(r)}-1===t&&C._pythonexc2js()}}class W{has(e){let t,n=T(this),r=N.new_value(e);try{t=C.__pyproxy_contains(n,r)}catch(e){A.fatal_error(e)}finally{N.decref(r)}return-1===t&&C._pythonexc2js(),1===t}}class V{[Symbol.iterator](){let e,t=T(this),n={};try{e=C._PyObject_GetIter(t)}catch(e){A.fatal_error(e)}0===e&&C._pythonexc2js();var r=function*(e,t){try{for(var n;n=C.__pyproxy_iter_next(e);)yield N.pop_value(n)}catch(e){A.fatal_error(e)}finally{C.finalizationRegistry.unregister(t),C._Py_DecRef(e)}C._PyErr_Occurred()&&C._pythonexc2js()}(e,n);return C.finalizationRegistry.register(r,[e,void 0],n),r}}class U{[Symbol.iterator](){return this}next(e){let t,n=N.new_value(e),r=C.stackSave(),a=C.stackAlloc(4);try{t=C.__pyproxyGen_Send(T(this),n,a)}catch(e){A.fatal_error(e)}finally{N.decref(n)}e=C.HEAPU32[a>>2];return C.stackRestore(r),-1===t&&C._pythonexc2js(),{done:0===t,value:N.pop_value(e)}}}let j={isExtensible:()=>!0,has:(a,e)=>!!Reflect.has(a,e)||"symbol"!=typeof e&&function(e){let t,n=T(a),r=N.new_value(e);try{t=C.__pyproxy_hasattr(n,r)}catch(e){A.fatal_error(e)}finally{N.decref(r)}return-1===t&&C._pythonexc2js(),0!==t}(e=e.startsWith("$")?e.slice(1):e),get(e,t){if(t in e||"symbol"==typeof t)return Reflect.get(e,t);e=function(e,t){let n,r=T(e),a=N.new_value(t),i=e.$$.cache.cacheId;try{n=C.__pyproxy_getattr(r,a,i)}catch(e){A.fatal_error(e)}finally{N.decref(a)}return 0===n&&C._PyErr_Occurred()&&C._pythonexc2js(),n}(e,t=t.startsWith("$")?t.slice(1):t);return 0!==e?N.pop_value(e):void 0},set(a,i,o){var s=Object.getOwnPropertyDescriptor(a,i);if(s&&!s.writable)throw new TypeError(`Cannot set read only field '${i}'`);{if("symbol"==typeof i)return Reflect.set(a,i,o);i.startsWith("$")&&(i=i.slice(1));{s=i,i=o;let e,t=T(a),n=N.new_value(s),r=N.new_value(i);try{e=C.__pyproxy_setattr(t,n,r)}catch(e){A.fatal_error(e)}finally{N.decref(n),N.decref(r)}-1===e&&C._pythonexc2js()}return!0}},deleteProperty(r,a){var e=Object.getOwnPropertyDescriptor(r,a);if(e&&!e.writable)throw new TypeError(`Cannot delete read only field '${a}'`);{if("symbol"==typeof a)return Reflect.deleteProperty(r,a);a.startsWith("$")&&(a=a.slice(1));{let e,t=T(r),n=N.new_value(a);try{e=C.__pyproxy_delattr(t,n)}catch(e){A.fatal_error(e)}finally{N.decref(n)}-1===e&&C._pythonexc2js()}return!e||!!e.configurable}},ownKeys(e){let t,n=T(e);try{t=C.__pyproxy_ownKeys(n)}catch(e){A.fatal_error(e)}0===t&&C._pythonexc2js();let r=N.pop_value(t);return r.push(...Reflect.ownKeys(e)),r},apply:(e,t,n)=>e.apply(t,n)};class G{_ensure_future(){if(this.$$.promise)return this.$$.promise;let n,r,e,t=T(this),a=new Promise((e,t)=>{n=e,r=t}),i=N.new_value(n),o=N.new_value(r);try{e=C.__pyproxy_ensure_future(t,i,o)}catch(e){A.fatal_error(e)}finally{N.decref(o),N.decref(i)}return-1===e&&C._pythonexc2js(),this.$$.promise=a,this.destroy(),a}then(e,t){return this._ensure_future().then(e,t)}catch(e){return this._ensure_future().catch(e)}finally(e){return this._ensure_future().finally(e)}}class w{apply(e,t){return C.callPyObject(T(this),...t)}call(e,...t){return C.callPyObject(T(this),...t)}callKwargs(...e){if(0===e.length)throw new TypeError("callKwargs requires at least one argument (the key word argument object)");var t=e[e.length-1];if(void 0!==t.constructor&&"Object"!==t.constructor.name)throw new TypeError("kwargs argument is not an object");return C.callPyObjectKwargs(T(this),...e)}}w.prototype.prototype=Function.prototype;let _,H=new Map([["i8",Int8Array],["u8",Uint8Array],["u8clamped",Uint8ClampedArray],["i16",Int16Array],["u16",Uint16Array],["i32",Int32Array],["u32",Uint32Array],["i32",Int32Array],["u32",Uint32Array],["i64",globalThis.BigInt64Array],["u64",globalThis.BigUint64Array],["f32",Float32Array],["f64",Float64Array],["dataview",DataView]]);class q{getBuffer(e){let t;if(e&&void 0===(t=H.get(e)))throw new Error("Unknown type "+e);let n,r=C.HEAPU32,a=C.stackSave(),i=C.stackAlloc(r[C._buffer_struct_size>>2]),o=T(this);try{n=C.__pyproxy_get_buffer(i,o)}catch(e){A.fatal_error(e)}-1===n&&C._pythonexc2js();let s=r[i>>2],u=r[1+(i>>2)],l=r[2+(i>>2)],c=!!r[3+(i>>2)],p=r[4+(i>>2)],d=r[5+(i>>2)],h=N.pop_value(r[6+(i>>2)]),f=N.pop_value(r[7+(i>>2)]),m=r[8+(i>>2)],g=!!r[9+(i>>2)],v=!!r[10+(i>>2)],y=C.UTF8ToString(p),b=(C.stackRestore(a),!1);try{let e=!1;void 0===t&&([t,e]=C.processBufferFormatString(y," In this case, you can pass an explicit type argument."));var x=parseInt(t.name.replace(/[^0-9]/g,""))/8||1;if(e&&1<x)throw new Error("Javascript has no native support for big endian buffers. In this case, you can pass an explicit type argument. For instance, `getBuffer('dataview')` will return a `DataView`which has native support for reading big endian data. Alternatively, toJs will automatically convert the buffer to little endian.");var w=l-u;if(0!=w&&(s%x!=0||u%x!=0||l%x!=0))throw new Error("Buffer does not have valid alignment for a "+t.name);var _,k=w/x,I=(s-u)/x,S=0==w?new t:new t(r.buffer,u,k);for(_ of f.keys())f[_]/=x;return b=!0,Object.create(K.prototype,Object.getOwnPropertyDescriptors({offset:I,readonly:c,format:y,itemsize:d,ndim:h.length,nbytes:w,shape:h,strides:f,data:S,c_contiguous:g,f_contiguous:v,_view_ptr:m,_released:!1}))}finally{if(!b)try{C._PyBuffer_Release(m),C._PyMem_Free(m)}catch(e){A.fatal_error(e)}}}}class K{constructor(){throw new TypeError("PyBuffer is not a constructor")}release(){if(!this._released){try{C._PyBuffer_Release(this._view_ptr),C._PyMem_Free(this._view_ptr)}catch(e){A.fatal_error(e)}this._released=!0,this.data=null}}}const X=/^.*?([^\/]*)\.whl$/;function Y(t,n){return E(this,void 0,void 0,function*(){let e;if("default channel"===n){if(!(t in A.packages))throw new Error("Internal error: no entry for package named "+t);e=A.packages[t].file_name}else e=n;return yield f(_,e)})}function $(r,a){return E(this,void 0,void 0,function*(){let e=A.packages[r];var t=(e=e||{file_name:".whl",install_dir:"site",shared_library:!1,depends:[],imports:[]}).file_name;for(const n of A.package_loader.unpack_buffer.callKwargs({buffer:a,filename:t,target:e.install_dir,calculate_dynlibs:!0}))yield Q(n,e.shared_library);F[r]=e})}function J(){let n=Promise.resolve();return function(){return E(this,void 0,void 0,function*(){var e=n;let t;return n=new Promise(e=>t=e),yield e,t})}}const Z=J();function Q(r,a){return E(this,void 0,void 0,function*(){var e=C.FS.lookupPath(r).node.mount.type==C.FS.filesystems.MEMFS?C.FS.filesystems.MEMFS.getFileDataAsTypedArray(C.FS.lookupPath(r).node):C.FS.readFile(r);const t=yield Z();try{var n=yield C.loadWebAssemblyModule(e,{loadAsync:!0,nodelete:!0,allowUndefined:!0});C.preloadedWasm[r]=n,C.preloadedWasm[r.split("/").pop()]=n,a&&C.loadDynamicLibrary(r,{global:!0,nodelete:!0})}catch(e){if(e.message.includes("need to see wasm magic number"))return void console.warn(`Failed to load dynlib ${r}. We probably just tried to load a linux .so file or something.`);throw e}finally{t()}})}i.loadDynlib=Q;const ee=J();function k(S,N,T){return E(this,void 0,void 0,function*(){N=N||console.log,T=T||console.error,R(S)&&(S=S.toJs());const[e,t]=function(e,t){const n=new Map,r=new Map;for(var a of e){var i=function(e){let t=X.exec(e);if(t)return t[1].toLowerCase().split("-").slice(0,-4).join("-")}(a);void 0!==i?n.has(i)&&n.get(i)!==a?t(`Loading same package ${i} from ${a} and `+n.get(i)):n.set(i,a):function e(t,n,r){if(t=t.toLowerCase(),!n.has(t)){var a=A.packages[t];if(!a)throw new Error(`No known package with name '${t}'`);if((a.shared_library?r:n).set(t,"default channel"),void 0===F[t])for(var i of a.depends)e(i,n,r)}}(a,n,r)}return[n,r]}(S=Array.isArray(S)?S:[S],T);for(var[n,r]of[...e,...t]){var a=F[n];void 0!==a&&(e.delete(n),t.delete(n),a===r||"default channel"===r?N(n+" already loaded from "+a):T(`URI mismatch, attempting to load package ${n} from ${r} while it is already loaded from ${a}. To override a dependency, load the custom package first.`))}if(0===e.size&&0===t.size)N("No new packages to load");else{const h=[...e.keys(),...t.keys()].join(", "),f=yield ee();try{N("Loading "+h);const m={},g={};for(var[i,o]of t)F[i]?t.delete(i):m[i]=Y(i,o);for(var[s,u]of e)F[s]?e.delete(s):g[s]=Y(s,u);const v=[],y={},b={},x={};for(const[w,_]of t)b[w]=m[w].then(e=>E(this,void 0,void 0,function*(){yield $(w,e),v.push(w),F[w]=_})).catch(e=>{console.warn(e),y[w]=e});yield Promise.all(Object.values(b));for(const[k,I]of e)x[k]=g[k].then(e=>E(this,void 0,void 0,function*(){yield $(k,e),v.push(k),F[k]=I})).catch(e=>{console.warn(e),y[k]=e});var l;if(yield Promise.all(Object.values(x)),C.reportUndefinedSymbols(),0<v.length&&(l=v.join(", "),N("Loaded "+l)),0<Object.keys(y).length){var c,p,d=Object.keys(y).join(", ");N("Failed to load "+d);for([c,p]of Object.entries(y))console.warn(`The following error occurred while loading ${c}:`),console.error(p)}A.importlib.invalidate_caches()}finally{f()}}})}let F={};function te(t){if("string"==typeof t)t=new Error(t);else if("object"!=typeof t||null===t||"string"!=typeof t.stack||"string"!=typeof t.message){let e=`A value of type ${typeof t} with tag ${Object.prototype.toString.call(t)} was thrown as an error!`;try{e+=`
String interpolation of the thrown value gives """${t}""".`}catch(t){e+="\nString interpolation of the thrown value fails."}try{e+=`
The thrown value's toString method returns """${t.toString()}""".`}catch(t){e+="\nThe thrown value's toString method fails."}t=new Error(e)}return t}let ne=!(A.dump_traceback=function(){C.__Py_DumpTraceback(1,C._PyGILState_GetThisThreadState())});A.fatal_error=function(e){if(!e||!e.pyodide_fatal_error){if(ne)return console.error("Recursive call to fatal_error. Inner error was:"),void console.error(e);(e=("number"==typeof e?ae:te)(e)).pyodide_fatal_error=!0,ne=!0,console.error("Pyodide has suffered a fatal error. Please report this to the Pyodide maintainers."),console.error("The cause of the fatal error was:"),A.inTestHoist?(console.error(e.toString()),console.error(e.stack)):console.error(e);try{A.dump_traceback();for(var t of Object.keys(A.public_api))t.startsWith("_")||"version"===t||Object.defineProperty(A.public_api,t,{enumerable:!0,configurable:!0,get:()=>{throw new Error("Pyodide already fatally failed and can no longer be used.")}});A.on_fatal&&A.on_fatal(e)}catch(e){console.error("Another error occurred while handling the fatal error:"),console.error(e)}throw e}};class re extends Error{constructor(e,t){super(t),this.ty=e}}function ae(e){i=e,n=C._exc_type(),t=new C.ExceptionInfo(i).get_type(),a=C.stackSave(),r=C.stackAlloc(4),C.HEAP32[r/4]=i,i=C.demangle(C.UTF8ToString(C._exc_typename(t))),n=!!C.___cxa_can_catch(n,t,r),t=C.HEAP32[r/4],C.stackRestore(a);var t,n,[r,a,i]=[i,n,t];let o;return o=a?(n=C._exc_what(i),C.UTF8ToString(n)):`The exception is an object of type ${r} at address ${e} which does not inherit from std::exception`,new re(r,o)}function I(t){const e=t.fileName||"";if(e.includes("pyodide.asm"))return 1;if(e.includes("wasm-function"))return 1;if(e.includes("pyodide.js")){let e=t.functionName||"";return!((e=e.startsWith("Object.")?e.slice("Object.".length):e)in A.public_api)||"PythonError"===e||(t.functionName=e,0)}}Object.defineProperty(re.prototype,"name",{get(){return this.constructor.name+" "+this.ty}}),i.convertCppException=ae,C.handle_js_error=function(r){if(r&&r.pyodide_fatal_error)throw r;if(!(r instanceof C._PropagatePythonError)){let e,t,n=!1;r instanceof A.PythonError&&(n=C._restore_sys_last_exception(r.__error_address));try{e=u.parse(r)}catch(e){t=!0}var a;if(t&&(r=te(r)),n||(r=N.new_value(r),a=C._JsProxy_create(r),C._set_error(a),C._Py_DecRef(a),N.decref(r)),!t){if(function(e){if(I(e))return e=e.functionName,"PythonError"===e||"new_error"===e}(e[0]))for(;I(e[0]);)e.shift();for(const s of e){if(I(s))break;var i=C.stringToNewUTF8(s.functionName||"???"),o=C.stringToNewUTF8(s.fileName||"???.js");C.__PyTraceback_Add(i,o,s.lineNumber),C._free(i),C._free(o)}}}};class S extends Error{constructor(e,t){var n=Error.stackTraceLimit;Error.stackTraceLimit=1/0,super(e),Error.stackTraceLimit=n,this.__error_address=t}}Object.defineProperty(S.prototype,"name",{value:S.name}),A.PythonError=S;class O extends Error{constructor(){A.fail_test=!0,super("If you are seeing this message, an internal Pyodide error has occurred. Please report it to the Pyodide maintainers.")}}Object.defineProperty(O.prototype,"name",{value:O.name}),C._PropagatePythonError=O;let M=!1;function ie(e,t={}){return A.isPyProxy(t)&&(t={globals:t},M||(console.warn("Passing a PyProxy as the second argument to runPython is deprecated and will be removed in v0.21. Use 'runPython(code, {globals : some_dict})' instead."),M=!0)),t.globals||(t.globals=A.globals),A.pyodide_py.eval_code(e,t.globals)}function oe(t,a,i){return E(this,void 0,void 0,function*(){let n,e=A.pyodide_py.find_imports(t);try{n=e.toJs()}finally{e.destroy()}if(0!==n.length){let e=A._import_name_to_package_name,t=new Set;for(var r of n)e.has(r)&&t.add(e.get(r));t.size&&(yield k(Array.from(t),a,i))}})}function se(e,t={}){return E(this,void 0,void 0,function*(){return A.isPyProxy(t)&&(t={globals:t},M||(console.warn("Passing a PyProxy as the second argument to runPythonAsync is deprecated and will be removed in v0.21. Use 'runPythonAsync(code, {globals : some_dict})' instead."),M=!0)),t.globals||(t.globals=A.globals),yield A.pyodide_py.eval_code_async(e,t.globals)})}function ue(e,t){A.pyodide_py.register_js_module(e,t)}function le(e){A._Comlink=e}function ce(e){A.pyodide_py.unregister_js_module(e)}function pe(e,{depth:t,defaultConverter:n}={depth:-1}){switch(typeof e){case"string":case"number":case"boolean":case"bigint":case"undefined":return e}if(!e||A.isPyProxy(e))return e;let r=0,a=0,i=0;try{r=N.new_value(e);try{a=C.js2python_convert(r,{depth:t,defaultConverter:n})}catch(e){throw e instanceof C._PropagatePythonError&&C._pythonexc2js(),e}if(C._JsProxy_Check(a))return e;0===(i=C._python2js(a))&&C._pythonexc2js()}finally{N.decref(r),C._Py_DecRef(a)}return N.pop_value(i)}function de(e){return A.importlib.import_module(e)}A.runPython=ie,A.runPythonAsync=se;let he,fe,me=!1;function ge(e,t,n={}){"string"==typeof n&&(me||(console.warn("Passing a string as the third argument to unpackArchive is deprecated and will be removed in v0.21. Instead use { extract_dir : 'some_path' }"),me=!0),n={extractDir:n});n=n.extractDir;A.package_loader.unpack_buffer.callKwargs({buffer:e,format:t,extract_dir:n})}function ve(e){C.HEAP8[C._Py_EMSCRIPTEN_SIGNAL_HANDLING]=!!e,C.Py_EmscriptenSignalBuffer=e}function ye(){C.__PyErr_CheckSignals()&&C._pythonexc2js()}function be(e){fe=A._pyodide._base.eval_code("{}"),A.importlib=A.runPythonInternal("import importlib; importlib");let t=A.importlib.import_module;A.sys=t("sys"),A.sys.path.insert(0,e.homedir);var r,n=A.runPythonInternal("import __main__; __main__.__dict__"),a=A.runPythonInternal("import builtins; builtins.__dict__");A.globals=(r=a,new Proxy(n,{get:(n,e)=>"get"===e?e=>{let t=n.get(e);return t=void 0===t?r.get(e):t}:"has"===e?e=>n.has(e)||r.has(e):Reflect.get(n,e)}));let i=A._pyodide._importhook,o=(i.register_js_finder(),i.register_js_module("js",e.jsglobals),a={globals:void 0,FS:he=C.FS,pyodide_py:void 0,version:"",loadPackage:k,loadPackagesFromImports:oe,loadedPackages:F,isPyProxy:R,runPython:ie,runPythonAsync:se,registerJsModule:ue,unregisterJsModule:ce,setInterruptBuffer:ve,checkInterrupt:ye,toPy:pe,pyimport:de,unpackArchive:ge,registerComlink:le,PythonError:S,PyBuffer:K,_module:C,_api:A},A.public_api=a);return i.register_js_module("pyodide_js",o),A.pyodide_py=t("pyodide"),A.package_loader=t("pyodide._package_loader"),A.version=A.pyodide_py.__version__,o.pyodide_py=A.pyodide_py,o.version=A.version,o.globals=A.globals,o}function D(s={}){return E(this,void 0,void 0,function*(){if(D.inProgress)throw new Error("Pyodide is already loading.");s.indexURL||(s.indexURL=function(){let t;try{throw new Error}catch(e){t=e}const e=u.parse(t)[0].fileName;return e.slice(0,e.lastIndexOf("/"))}());var e={fullStdLib:D.inProgress=!0,jsglobals:globalThis,stdin:globalThis.prompt||void 0,homedir:"/home/pyodide"};let t=Object.assign(e,s);t.indexURL.endsWith("/")||(t.indexURL+="/"),yield function(){return E(this,void 0,void 0,function*(){l&&(c=(yield import("path")).default,h=yield import("fs/promises"),p=(yield import("node-fetch")).default,d=(yield import("vm")).default)})}();var n,e=function(a){return E(this,void 0,void 0,function*(){let t;if(_=a,l){var e=yield h.readFile(a+"packages.json");t=JSON.parse(e)}else{let e=yield fetch(a+"packages.json");t=yield e.json()}if(!t.packages)throw new Error("Loaded packages.json does not contain the expected key 'packages'.");A.packages=t.packages,A._import_name_to_package_name=new Map;for(var n of Object.keys(A.packages))for(var r of A.packages[n].imports)A._import_name_to_package_name.set(r,n)})}(t.indexURL),r=f(t.indexURL,"pyodide_py.tar"),a=(L(t.stdin,t.stdout,t.stderr),n=t.homedir,C.preRun.push(function(){try{C.FS.mkdirTree(n)}catch(e){console.error(`Error occurred while making a home directory '${n}':`),console.error(e),console.error("Using '/' for a home directory instead"),n="/"}C.ENV.HOME=n,C.FS.chdir(n)}),new Promise(e=>C.postRun=e)),i=(C.locateFile=e=>t.indexURL+e,t.indexURL+"pyodide.asm.js"),i=(yield m(i),yield _createPyodideModule(C),yield a,C.locateFile=e=>{throw new Error("Didn't expect to load any more file_packager files!")},yield r),a=C.FS.open("/pyodide_py.tar","w"),i=(C.FS.write(a,i,0,i.byteLength,void 0,!0),C.FS.close(a),C.stringToNewUTF8('\nfrom sys import version_info\npyversion = f"python{version_info.major}.{version_info.minor}"\nimport shutil\nshutil.unpack_archive("/pyodide_py.tar", f"/lib/{pyversion}/site-packages/")\ndel shutil\nimport importlib\nimportlib.invalidate_caches()\ndel importlib\n    '));if(C._PyRun_SimpleString(i))throw new Error("OOPS!");C._free(i),C.FS.unlink("/pyodide_py.tar"),C._pyodide_init();let o=be(t);return yield e,t.fullStdLib&&(yield k(["distutils"])),o.runPython("print('Python initialization complete')"),o})}A.saveState=()=>A.pyodide_py._state.save_state(),A.restoreState=e=>A.pyodide_py._state.restore_state(e),A.runPythonInternal=function(e){return A._pyodide._base.eval_code(e,fe)},globalThis.loadPyodide=D,e.loadPyodide=D,Object.defineProperty(e,"__esModule",{value:!0})});class Detector{cameraWrap=document.createElement("div");loader=document.createElement("div");canvas=document.createElement("canvas");video=document.createElement("video");stream=null;model=null;videoWidth=320;videoHeight=320;rotate="horizontal";section={dx:0,dy:0,width:0,height:0};isMobile=navigator.userAgent.toLocaleLowerCase().includes("mobile");isCapture=!1;isLoading=!1;isDetect=!1;isAnimate=!1;loaderCallback=null;constructor(){this.setModel(),this.setElement(),this.setDevice(),this.setSection(),window.addEventListener("beforeunload",e=>{e.preventDefault(),e.stopPropagation(),this.clearVideo()})}setElement(){this.cameraWrap.classList.add("camera-wrap"),this.cameraWrap.style.position="relative",this.cameraWrap.style.display="flex",this.cameraWrap.style.alignItems="center",this.cameraWrap.style.justifyContent="center",this.cameraWrap.style.width="100%",this.cameraWrap.style.height="100%",this.cameraWrap.style.overflow="hidden",this.cameraWrap.style.maxWidth=this.videoWidth+"px",this.cameraWrap.style.maxHeight=this.videoHeight+"px",this.loader.classList.add("loader"),this.loader.innerText="Loading...",this.loader.style.position="absolute",this.loader.style.display="flex",this.loader.style.justifyContent="center",this.loader.style.alignItems="center",this.loader.style.color="white",this.loader.style.width="100%",this.loader.style.height="100%",this.loader.style.backgroundColor="rgba(0, 0, 0, 0.8)",this.canvas.classList.add("canvas"),this.canvas.style.position="absolute",this.canvas.style.backgroundColor="transparent",this.ctx=this.canvas.getContext("2d"),this.video.classList.add("video"),this.video.style.zIndex="-1",this.video.autoplay=!0,this.video.muted=!0,this.video.playsInline=!0,this.cameraWrap.appendChild(this.loader),this.cameraWrap.appendChild(this.video),this.cameraWrap.appendChild(this.canvas)}async setDevice(){try{var e={audio:!1,video:{facingMode:"environment",width:this.videoWidth,height:this.videoHeight}},t={audio:!1,video:{width:this.videoWidth,height:this.videoHeight}};this.stream=await navigator.mediaDevices.getUserMedia(this.isMobile?e:t),this.video.srcObject=this.stream}catch(e){console.error(e)}}async setSection(){this.clearCanvas(),this.section.width=this.videoWidth-2*this.section.dx,this.section.height=this.videoHeight-2*this.section.dy,this.canvas.width=this.videoWidth,this.canvas.height=this.videoHeight,this.ctx.save(),this.ctx.strokeStyle="lightgoldenrodyellow",this.ctx.lineWidth=3,this.ctx.strokeRect(10,10,this.videoWidth-20,this.videoHeight-20),this.ctx.restore()}async setLine(e){this.ctx.save(),this.ctx.beginPath(),this.ctx.moveTo(e[0][0],e[0][1]),this.ctx.lineTo(e[1][0],e[1][1]),this.ctx.lineTo(e[2][0],e[2][1]),this.ctx.lineTo(e[3][0],e[3][1]),this.ctx.lineTo(e[0][0],e[0][1]),this.ctx.strokeStyle="red",this.ctx.lineWidth=2,this.ctx.stroke(),this.ctx.restore()}async setLoaderCallback(e){this.loaderCallback=e}async setModel(){this.model=await load("./module/tfjs320f16/model.json"),this.isLoading=!0,this.loader.style.display="none",this.loaderCallback&&this.loaderCallback()}async capture(){if(this.isLoading){this.isAnimate=!1,this.clearCanvas(),this.canvas.width=this.videoWidth,this.canvas.height=this.videoHeight,this.ctx.drawImage(this.video,0,0,this.videoWidth,this.videoHeight);var e=await this.canvas.toDataURL();const t=new Image;t.src=e,t.onload=(async()=>{t.width=320,t.height=320;var e=await detect(window.tf.browser.fromPixels(t),this.model);0<e.length&&await this.setLine(e)}).bind(this)}}async setRealtimeDetect(e=!0){this.isAnimate=e,this.animate(),await this.clearCanvas(),await this.setSection()}async animate(e=0){if(this.isAnimate&&this.isLoading){if(!this.isDetect){this.isDetect=!0;const n=document.createElement("canvas"),r=n.getContext("2d");n.width=this.videoWidth,n.height=this.videoHeight,r.drawImage(this.video,0,0,this.videoWidth,this.videoHeight);var t=await n.toDataURL();const a=new Image;a.src=t,a.onload=(async()=>{a.width=320,a.height=320;var e=await detect(window.tf.browser.fromPixels(a),this.model);await this.clearCanvas(),await this.setSection(),0<e.length&&await this.setLine(e),this.isDetect=!1}).bind(this)}requestAnimationFrame(this.animate.bind(this))}}async resetCapture(){this.clearCanvas(),this.setSection()}clearCanvas(){this.ctx.clearRect(0,0,this.canvas.width,this.canvas.height)}clearVideo(){this.video.pause(),this.video.src="",this.stream.getTracks()[0].stop()}getElement(){return this.cameraWrap}}export{Detector as default};