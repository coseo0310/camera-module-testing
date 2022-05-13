const canvas = document.querySelector("#canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const video = document.querySelector("#video") as HTMLVideoElement;
const label1 = document.querySelector("#label1") as HTMLDivElement;
const label2 = document.querySelector("#label2") as HTMLDivElement;

let width = window.innerWidth;
let height = window.innerHeight;
let stream;

video.addEventListener("canplaythrough", () => {
  canvas.width = width;
  canvas.height = height;
  // render();
});
window.addEventListener("resize", (e) => {
  // setDevice();
});

const isMobile = navigator.userAgent.toLocaleLowerCase().includes("mobile");
label1.innerText = ` ${navigator.userAgent}, ${isMobile}`;
async function setDevice() {
  try {
    const isMobile = navigator.userAgent.toLocaleLowerCase().includes("mobile");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: isMobile ? { facingMode: { exact: "environment" } } : true,
    });
    video.srcObject = stream;
    const settings = stream.getVideoTracks()[0].getSettings();
    width = settings.width;
    height = settings.height;
    label2.innerText = `${width}, ${height}`;
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
    // ctx.drawImage(video, 0, 0, width, height);
    ctx.restore();
  }

  requestAnimationFrame(render);
}

window.onload = () => {
  setDevice();
};
