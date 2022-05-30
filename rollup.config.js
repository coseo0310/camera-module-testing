// import typescript from "rollup-plugin-typescript2";
// import tslint from "rollup-plugin-tslint";
import { uglify } from "rollup-plugin-uglify";
// typescript({ clean: true, sourceMap: false }), tslint(),
export default {
  input: "./module/detector.js",
  output: {
    file: "example/module/detector.js",
    format: "esm",
  },
  plugins: [uglify()],
};
