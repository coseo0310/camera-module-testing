// import typescript from "rollup-plugin-typescript2";
// import tslint from "rollup-plugin-tslint";
import { uglify } from "rollup-plugin-uglify";
// typescript({ clean: true, sourceMap: false }), tslint(),

const isWorker = false;

export default {
  input: isWorker ? "./src/worker.js" : "./src/detector.js",
  output: {
    file: isWorker ? "./module/worker.js" : "./module/detector.js",
    format: "esm",
  },
  plugins: [],
};
