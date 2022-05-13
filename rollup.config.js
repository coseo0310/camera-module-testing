import typescript from "rollup-plugin-typescript2";
import tslint from "rollup-plugin-tslint";
import { uglify } from "rollup-plugin-uglify";

export default {
  input: "src/app.ts",
  output: {
    file: "dist/main.js",
    format: "cjs",
  },
  plugins: [typescript(), tslint(), uglify()],
};
