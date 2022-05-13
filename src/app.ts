const canvas = document.querySelector("#canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const video = document.querySelector("#video") as HTMLVideoElement;
const label1 = document.querySelector("#label1") as HTMLDivElement;
const label2 = document.querySelector("#label2") as HTMLDivElement;
const label3 = document.querySelector("#label3") as HTMLDivElement;
const label4 = document.querySelector("#label4") as HTMLDivElement;
const label5 = document.querySelector("#label5") as HTMLDivElement;
const label6 = document.querySelector("#label6") as HTMLDivElement;

let width = window.innerWidth;
let height = window.innerHeight;
let stream;

video.addEventListener("canplaythrough", () => {
  canvas.width = width;
  canvas.height = height;
  // render();
});
window.addEventListener("resize", async (e) => {
  setDevice(await getCameras());
});

const isMobile = navigator.userAgent.toLocaleLowerCase().includes("mobile");
label1.innerText = ` ${navigator.userAgent}, ${isMobile}`;

async function getCameras() {
  try {
    let option;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter((device) => device.kind === "videoinput");
    cameras.forEach((camera) => {
      option = document.createElement("option");
      option.value = camera.deviceId;
      option.innerText = camera.label;
    });
    label3.innerHTML = JSON.stringify(cameras);
    label4.innerHTML = `${option.value} - ${option.innerText}`;
    return cameras[0].deviceId;
  } catch (error) {
    console.error(error);
  }
}
async function setDevice(deviceId: string) {
  console.log(getCameras());
  try {
    const initalConstrains = {
      audio: false,
      video: { facingMode: "environment" },
      // video: true,
    };
    const cameraConstrainsts = {
      audio: false,
      video: { deviceId: { exact: deviceId } },
    };
    const stream = await navigator.mediaDevices.getUserMedia(
      !!deviceId ? cameraConstrainsts : initalConstrains
    );
    label5.innerHTML = `diviceID:: ${deviceId}, ${!!deviceId}`;
    video.srcObject = stream;
    const v = stream.getVideoTracks()[0];

    label6.innerHTML = `ID: ${v.id} label: ${v.label}`;
    console.log(v);
    const settings = stream.getVideoTracks()[0].getSettings();
    width = settings.width;
    height = settings.height;
    label2.innerText = `${width}, ${height}`;
    console.log("stream", width, height);
  } catch (error) {
    console.error(error);
    label5.innerHTML = error;
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

window.onload = async () => {
  setDevice(await getCameras());
};
