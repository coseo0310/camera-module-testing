import { load, detect } from "./boundary_detector.js";

// Libary Loaded
import "../lib/tfjs@3.18.0/dist/tf.min.js";
import "../lib/tfjs-backend-wasm@3.18.0/dist/tf-backend-wasm.js";
import "../lib/numjs-master/dist/numjs.min.js";
import "../lib/pyodide@0.20.0/pyodide.js";

const worker = self;

let model = null;

worker.onmessage = async (e) => {
  let rgb = [];
  let cnt = 1;
  let tensor = null;
  switch (e.data.type) {
    case "setModel":
      try {
        if (!model) {
          model = await load("./tfjs320f16/model.json");
          postMessage({ type: "setModel" });
        }
      } catch (error) {
        console.error(error);
      } finally {
        postMessage({ type: "setModel" });
      }
      break;
    case "getSquare":
      try {
        for (const v of e.data.rgb) {
          if (cnt === 4) {
            cnt = 1;
            continue;
          }
          rgb.push(v);
          cnt += 1;
        }
        tensor = tf.tensor(rgb);
        tensor = tensor.reshape([320, 320, 3]);
        const square1 = await detect(tensor, model);
        postMessage({ type: "getCapture", square: square1 });
      } catch (error) {
        console.error(error);
        postMessage({ type: "getCapture", square: [] });
      }
      break;
    case "getAnimate":
      try {
        for (const v of e.data.rgb) {
          if (cnt === 4) {
            cnt = 1;
            continue;
          }
          rgb.push(v);
          cnt += 1;
        }
        tensor = tf.tensor(rgb);
        tensor = tensor.reshape([320, 320, 3]);
        const square2 = await detect(tensor, model);
        postMessage({ type: "getAnimate", square: square2 });
      } catch (error) {
        console.error(error);
        postMessage({ type: "getCapture", square: [] });
      }
      break;
    default:
      break;
  }
};
