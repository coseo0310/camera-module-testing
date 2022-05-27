import { load, detect } from "./boundary_detector.js";
// Libary Loaded
import "./lib/tfjs@3.18.0/dist/tf.min.js";
import "./lib/tfjs-backend-wasm@3.18.0/dist/tf-backend-wasm.js";
import "./lib/numjs-master/dist/numjs.min.js";
import "./lib/pyodide@0.20.0/pyodide.js";

const container = document.querySelector(".container");
const canvas = document.querySelector("#canvas");
const ctx = canvas.getContext("2d");
const video = document.querySelector("#video");
const btn1 = document.querySelector(".capture");

let model = null;
let width = container.clientWidth;
let height = container.clientHeight;
let videoWidth = 1920;
let videoHeight = 1080;
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

getModel();

async function getModel () {
// 모델 로드
 model = await load("./tfjs320f16/model.json");
}

async function setDevice() {
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

    if (rotate === "horizontal") {
      video.width = width;
      video.height = width * 0.5625;
    } else {
      video.width = height / 0.5625;
      video.height = height;
    }

    video.srcObject = stream;
  } catch (error) {
    console.error(error);
  }
}

function capture() {
  btn1.classList.toggle("on");
  setSection();
  if (isCapture) {
    isCapture = false;
    return;
  }
  canvas.width = video.clientWidth;
  canvas.height = video.clientHeight;
  ctx.drawImage(video, 0, 0, video.width, video.height);
  isCapture = true;
  const dataUrl = canvas.toDataURL();
  const imgEl = new Image();
  imgEl.src = dataUrl;
  getDetection(imgEl);
}

function getDetection(imgEl) {
  const img = window.tf.browser.fromPixels(imgEl);
  const square = await detect(img, model);
  console.log('>>', square)
}

function clear() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function setSection() {
  clear();
  if (rotate === "horizontal") {
    section.dx = 100;
    section.dy = 20;
  } else {
    section.dx = 20;
    section.dy = 100;
  }

  section.width = width - section.dx * 2;
  section.height = height - section.dy * 2;

  canvas.width = width;
  canvas.height = height;
  ctx.save();
  ctx.strokeStyle = "lightgoldenrodyellow";
  ctx.lineWidth = 3;
  ctx.strokeRect(section.dx, section.dy, section.width, section.height);
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
