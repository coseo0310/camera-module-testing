import { load, detect } from "./boundary_detector.js";

import "./lib/tfjs@3.18.0/dist/tf.min.js";
import "./lib/tfjs-backend-wasm@3.18.0/dist/tf-backend-wasm.js";
import "./lib/numjs-master/dist/numjs.min.js";
import "./lib/pyodide@0.20.0/pyodide.js";

async function start() {
  const start = Date.now();

  // 모델 로드
  let model = await load("./tfjs320f16/model.json");

  ele(".loading-msg").innerHTML = `모델 로드 완료 : ${Date.now() - start}ms`;
  eles(".trigger").forEach((ele) => {
    ele.classList.add("show");
  });
  removeClass(".imgs-container", "hide");

  // buttons trigger
  eles(".trigger").forEach((ele) => {
    ele.addEventListener("click", (event) => {
      const trigger = event.target;
      trigger.classList.add("processing");
      trigger.innerHTML = "Processing...";

      setTimeout(() => {
        handleClickTrigger(trigger, model);
        trigger.classList.add("hide");
      });
    });
  });
}

// click trigger
async function handleClickTrigger(trigger, model) {
  let all_time = Date.now();
  // Get the source media
  const imageContainer = trigger.closest(".img-container");
  let srcMedia = imageContainer.querySelector("img");
  if (!srcMedia) {
    srcMedia = imageContainer.querySelector("video");
    removeClass(".take-pic", "hide");
  }

  // Run inference and draw the result on the corresponding canvas.
  const canvas = imageContainer.querySelector("canvas");
  const ctx = canvas.getContext("2d");

  // Get pixels data.
  const img = tf.browser.fromPixels(srcMedia);
  let time_now = Date.now();
  let finish_time = 0;

  // 검출
  let square = await detect(img, model);

  finish_time = Date.now() - time_now;

  const rgb = Array.from(img.dataSync());
  const rgba = [];
  for (let i = 0; i < rgb.length / 3; i++) {
    for (let c = 0; c < 3; c++) {
      rgba.push(rgb[i * 3 + c]);
    }
    rgba.push(255);
  }

  const new_image = new ImageData(Uint8ClampedArray.from(rgba), 320, 320);

  ctx.putImageData(new_image, 0, 0);
  for (let [i, v] of Object.entries(square)) {
    let next_idx = parseInt(i) + 1;
    if (square.length - 1 == i) {
      next_idx = 0;
    }
    ctx.beginPath();
    ctx.arc(v[0], v[1], 10, 0, Math.PI * 2);
    ctx.fillStyle = "yellow";
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(v[0], v[1]);
    ctx.lineTo(square[next_idx][0], square[next_idx][1]);
    ctx.strokeStyle = "red";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  canvas.classList.add("show");

  // Show latency stat.
  const stats = trigger.closest(".img-container").querySelector(".stats");
  stats.classList.add("show");
  stats.innerHTML = finish_time / 1000 + " 초";
}

function ele(selector) {
  return document.querySelector(selector);
}

function eles(selector) {
  return document.querySelectorAll(selector);
}

function removeClass(selector, className) {
  return ele(selector).classList.remove(className);
}

start();
