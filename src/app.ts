const canvas = document.querySelector("#canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const video = document.querySelector("#video") as HTMLVideoElement;
const btn1 = document.querySelector(".capture") as HTMLButtonElement;
const btn2 = document.querySelector(".clear") as HTMLButtonElement;

let width = window.innerWidth;
let height = window.innerHeight;
let rotate: "vertical" | "horizontal" = "horizontal";
let cnt = 0;

video.addEventListener("canplaythrough", () => {
  canvas.width = width;
  canvas.height = height;
});
window.addEventListener("resize", async (e) => {
  width = window.innerWidth;
  height = window.innerHeight;
  let now: "vertical" | "horizontal";
  if (width > height) {
    now = "horizontal";
  } else {
    now = "vertical";
  }

  if (now !== rotate) {
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
        width: 1920,
        height: 1080,
      },
    };
    const stream = await navigator.mediaDevices.getUserMedia(
      !isMobile ? cameraConstrainsts : initalConstrains
    );

    video.height = height;
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
  // if (!time) {
  //   time = t;
  // }

  // const now = t - time;

  // if (now > fpsTime) {
  //   time = t;
  //   ctx.save();
  //   ctx.drawImage(video, 0, 0, width, height);
  //   ctx.restore();
  // }
  console.log(video.width, height);

  canvas.width = height / 0.5625;
  canvas.height = height;
  ctx.drawImage(video, 0, 0, height / 0.5625, height);
}

function clear() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

window.onload = async () => {
  setDevice();
};
