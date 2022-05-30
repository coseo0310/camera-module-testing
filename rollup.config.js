// import typescript from "rollup-plugin-typescript2";
// import tslint from "rollup-plugin-tslint";
import { uglify } from "rollup-plugin-uglify";
// typescript({ clean: true, sourceMap: false }), tslint(),

const isWorker = true;

export default {
  input: isWorker ? "./src/worker.js" : "./module/detector.js",
  output: {
    file: isWorker ? "./src/worker.js" : "./example/module/detector.js",
    format: "esm",
  },
  plugins: [uglify()],
};
