import { load, detect } from "./boundary_detector.js";

// Libary Loaded
import "./lib/tfjs@3.18.0/dist/tf.min.js";
import "./lib/tfjs-backend-wasm@3.18.0/dist/tf-backend-wasm.js";
import "./lib/numjs-master/dist/numjs.min.js";
import "./lib/pyodide@0.20.0/pyodide.js";

const container = document.querySelector(".container");
const cameraWrap = document.createElement("camera-wrap");
const canvas = document.querySelector("#canvas");
const ctx = canvas.getContext("2d");
const video = document.querySelector("#video");
const btn1 = document.querySelector(".capture");

let model = null;
let width = cameraWrap.clientWidth;
let height = cameraWrap.clientHeight;
let videoWidth = 320;
let videoHeight = 320;
let rotate = "horizontal";
let isCapture = false;
let section = {
  dx: 0,
  dy: 0,
  width: 0,
  height: 0,
};

window.addEventListener("resize", async (e) => {
  width = container.clientWidth;
  height = container.clientHeight;
  let now;
  if (width > height) {
    now = "horizontal";
  } else {
    now = "vertical";
  }

  if (now !== rotate) {
    rotate = now;

    setSection();
    setDevice();
  }
});

btn1.addEventListener("click", () => {
  capture();
});

const isMobile = navigator.userAgent.toLocaleLowerCase().includes("mobile");

async function getModel() {
  // 모델 로드
  model = await load("./tfjs320f16/model.json");
}

async function setDevice() {
  await getModel();
  try {
    const initalConstrains = {
      audio: false,
      video: {
        facingMode: "environment",
        width: videoWidth,
        height: videoHeight,
      },
    };
    const cameraConstrainsts = {
      audio: false,
      video: {
        width: videoWidth,
        height: videoHeight,
      },
    };
    const stream = await navigator.mediaDevices.getUserMedia(
      !isMobile ? cameraConstrainsts : initalConstrains
    );

    // if (rotate === "horizontal") {
    //   video.width = videoWidth;
    //   video.height = videoWidth * 0.5625;
    // } else {
    //   video.width = videoHeight / 0.5625;
    //   video.height = videoHeight;
    // }

    video.srcObject = stream;
  } catch (error) {
    console.error(error);
  }
}

async function capture() {
  clear();
  setSection();
  btn1.classList.toggle("on");

  if (isCapture) {
    isCapture = false;
    return;
  }

  canvas.width = videoWidth;
  canvas.height = videoHeight;

  ctx.drawImage(video, 0, 0, videoWidth, videoHeight);
  isCapture = true;
  const dataUrl = canvas.toDataURL();
  const imgEl = new Image();
  imgEl.src = dataUrl;
  await getDetection(imgEl);
}

async function getDetection(imgEl) {
  imgEl.width = 320;
  imgEl.height = 320;
  const img = window.tf.browser.fromPixels(imgEl);
  const square = await detect(img, model);
  const di = document.createElement("div");
  di.innerText = `data:::: ${JSON.stringify(square)}`;
  document.body.appendChild(di);
}

function clear() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function setSection() {
  clear();

  section.width = videoWidth - section.dx * 2;
  section.height = videoHeight - section.dy * 2;

  canvas.width = videoWidth;
  canvas.height = videoHeight;
  ctx.save();
  ctx.strokeStyle = "lightgoldenrodyellow";
  ctx.lineWidth = 3;
  ctx.strokeRect(20, 20, videoWidth - 40, videoHeight - 40);
  ctx.restore();
}

window.onload = async () => {
  width = container.clientWidth;
  height = container.clientHeight;
  let now;
  if (width > height) {
    now = "horizontal";
  } else {
    now = "vertical";
  }
  rotate = now;
  setSection();
  setDevice();
};
