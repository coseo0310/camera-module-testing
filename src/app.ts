const container = document.querySelector(".container") as HTMLDivElement;
const canvas = document.querySelector("#canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const video = document.querySelector("#video") as HTMLVideoElement;
const btn1 = document.querySelector(".capture") as HTMLButtonElement;

let width = container.clientWidth;
let height = container.clientHeight;
let videoWidth = 1920;
let videoHeight = 1080;
let rotate: "vertical" | "horizontal" = "horizontal";
let cnt = 0;
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
  let now: "vertical" | "horizontal";
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

let time = 0;
let fps = 60;
let fpsTime = 1000 / fps;

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
  let now: "vertical" | "horizontal";
  if (width > height) {
    now = "horizontal";
  } else {
    now = "vertical";
  }
  rotate = now;
  setSection();
  setDevice();
};
