const canvas = document.querySelector("#canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const video = document.querySelector("#video") as HTMLVideoElement;
const btn1 = document.querySelector(".capture") as HTMLButtonElement;
const btn2 = document.querySelector(".clear") as HTMLButtonElement;

let width = window.innerWidth;
let height = window.innerHeight;
let videoWidth = 1920;
let videoHeight = 1080;
let rotate: "vertical" | "horizontal" = "horizontal";
let cnt = 0;

video.addEventListener("canplaythrough", () => {
  canvas.width = width;
  canvas.height = height;
});
window.addEventListener("resize", async (e) => {
  console.log(width, height);
  width = window.innerWidth;
  height = window.innerHeight;
  let now: "vertical" | "horizontal";
  if (width > height) {
    now = "horizontal";
  } else {
    now = "vertical";
  }

  if (now !== rotate) {
    rotate = now;
    setDevice();
  }
});

btn1.addEventListener("click", () => {
  console.log("clcik?");
  capture();
});
btn2.addEventListener("click", () => {
  console.log("clcik?");
  clear();
});

const isMobile = navigator.userAgent.toLocaleLowerCase().includes("mobile");

async function setDevice() {
  try {
    const initalConstrains = {
      audio: false,
      video: { facingMode: "environment", width: 1280, height: 720 },
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

    console.log(">>", rotate);
    if (rotate === "horizontal") {
      video.width = width;
      video.height = width * 0.5625;
      console.log(video, "w", width);
    } else {
      video.width = height / 0.5625;
      video.height = height;
      console.log(video, "h", height);
    }

    video.srcObject = stream;
    const v = stream.getVideoTracks()[0];
  } catch (error) {
    console.error(error);
  }
}

let time = 0;
let fps = 60;
let fpsTime = 1000 / fps;

function capture() {
  canvas.width = video.clientWidth;
  canvas.height = video.clientHeight;
  ctx.drawImage(video, 0, 0, video.width, video.height);
}

function clear() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

window.onload = async () => {
  width = window.innerWidth;
  height = window.innerHeight;
  let now: "vertical" | "horizontal";
  if (width > height) {
    now = "horizontal";
  } else {
    now = "vertical";
  }
  rotate = now;
  setDevice();
};
