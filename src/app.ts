const canvas = document.querySelector("#canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const video = document.createElement("video");
video.autoplay = true;

let width = window.innerWidth;
let height = window.innerHeight;
let stream;

video.addEventListener("canplaythrough", () => {
  canvas.width = width;
  canvas.height = height;
  render();
});
window.addEventListener("resize", (e) => {
  console.log("resize", window.innerWidth, window.innerHeight);
  setDevice();
});

async function setDevice() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: true,
    });
    video.srcObject = stream;
    const settings = stream.getVideoTracks()[0].getSettings();
    width = settings.width;
    height = settings.height;
    console.log("stream", width, height);
  } catch (error) {
    console.error(error);
  }
}

let time = 0;
let fps = 60;
let fpsTime = 1000 / fps;

function render(t = 0) {
  if (!time) {
    time = t;
  }

  const now = t - time;

  if (now > fpsTime) {
    time = t;
    ctx.save();
    ctx.drawImage(video, 0, 0, width, height);
    ctx.restore();
  }

  requestAnimationFrame(render);
}

function test() {
  const a = canvas.captureStream(60);
}

window.onload = () => {
  setDevice();
};
