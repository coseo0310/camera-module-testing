import Detector from "./module/detector.js";

const container = document.querySelector(".container");
const btn1 = document.querySelector(".capture");
const btn2 = document.querySelector(".realtime");

const detector = new Detector();

let isCapture = false;
let isRealtime = false;

container.appendChild(detector.getElement());

console.log(navigator.userAgent);

btn1.addEventListener("click", () => {
  if (!detector.isLoading) {
    return;
  }
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
  if (isCapture || !detector.isLoading) {
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
