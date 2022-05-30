// tensorflowJS
export function inference_tfjs(image, tfjsModel) {
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

// tensorflowLite
function inference_tflite(image, tfliteModel, input_size) {
  const input = tf.expandDims(image);

  // RGB 2 RGBA
  const input_rgb = Array.from(input.dataSync());
  const input_rgba = [];
  for (let i = 0; i < input_rgb.length / 3; i++) {
    for (let c = 0; c < 3; c++) {
      input_rgba.push(input_rgb[i * 3 + c]);
    }
    input_rgba.push(255);
  }
  let real_input = tf.tensor(input_rgba);
  real_input = tf.reshape(real_input, [1, input_size[0], input_size[1], 4]);

  // Run the inference.
  const outputTensor = tfliteModel.predict(real_input);
  const pts = Array.from(outputTensor["Identity"].dataSync());
  const pts_score = Array.from(outputTensor["Identity_1"].dataSync());
  const vmap = Array.from(outputTensor["Identity_2"].dataSync());
  return [pts, pts_score, vmap];
}
