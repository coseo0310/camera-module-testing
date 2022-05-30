import { load, detect } from "./boundary_detector.js";

// Libary Loaded
import "../lib/tfjs@3.18.0/dist/tf.min.js";
import "../lib/tfjs-backend-wasm@3.18.0/dist/tf-backend-wasm.js";
import "../lib/numjs-master/dist/numjs.min.js";
import "../lib/pyodide@0.20.0/pyodide.js";

const worker = self;

let model = null;

worker.onmessage = (e) => {
  console.log("worker", e.data);

  switch (e.data.type) {
    case "getModel":
    default:
      break;
  }
};
