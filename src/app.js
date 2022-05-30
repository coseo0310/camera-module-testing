import Detector from "./module/detector.js";

const container = document.querySelector(".container");
const btn1 = document.querySelector(".capture");
const btn2 = document.querySelector(".realtime");

const detector = new Detector();

let isCapture = false;
let isRealtime = false;

container.appendChild(detector.getElement());

btn1.addEventListener("click", () => {
  btn1.classList.toggle("on");
  isRealtime = false;
  if (isCapture) {
    isCapture = false;
    detector.resetCapture();
    return;
  }
  isCapture = true;
  detector.capture();
});

btn2.addEventListener("click", () => {
  if (isCapture) {
    return;
  }
  btn2.classList.toggle("on");
  if (isRealtime) {
    isRealtime = false;
    detector.setRealtimeDetect(isRealtime);
  } else {
    isRealtime = true;
    detector.setRealtimeDetect(isRealtime);
  }
});
