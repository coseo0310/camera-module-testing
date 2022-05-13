"use strict";var __awaiter=function(e,a,c,d){return new(c=c||Promise)(function(i,t){function n(e){try{r(d.next(e))}catch(e){t(e)}}function o(e){try{r(d.throw(e))}catch(e){t(e)}}function r(e){var t;e.done?i(e.value):((t=e.value)instanceof c?t:new c(function(e){e(t)})).then(n,o)}r((d=d.apply(e,a||[])).next())})};const canvas=document.querySelector("#canvas"),ctx=canvas.getContext("2d"),video=document.createElement("video");video.autoplay=!0;let width=window.innerWidth,height=window.innerHeight;function setDevice(){return __awaiter(this,void 0,void 0,function*(){try{const t=yield navigator.mediaDevices.getUserMedia({audio:!1,video:!0});var e=(video.srcObject=t).getVideoTracks()[0].getSettings();width=e.width,height=e.height,console.log("stream",width,height)}catch(e){console.error(e)}})}video.addEventListener("canplaythrough",()=>{canvas.width=width,canvas.height=height,render()}),window.addEventListener("resize",e=>{console.log("resize",window.innerWidth,window.innerHeight),setDevice()});let time=0,fps=60,fpsTime=1e3/fps;function render(e=0){e-(time=time||e)>fpsTime&&(time=e,ctx.save(),ctx.drawImage(video,0,0,width,height),ctx.restore()),requestAnimationFrame(render)}window.onload=()=>{setDevice()};
