"use strict";var __awaiter=function(e,c,h,a){return new(h=h||Promise)(function(t,i){function o(e){try{d(a.next(e))}catch(e){i(e)}}function n(e){try{d(a.throw(e))}catch(e){i(e)}}function d(e){var i;e.done?t(e.value):((i=e.value)instanceof h?i:new h(function(e){e(i)})).then(o,n)}d((a=a.apply(e,c||[])).next())})};const canvas=document.querySelector("#canvas"),ctx=canvas.getContext("2d"),video=document.querySelector("#video"),btn1=document.querySelector(".capture"),btn2=document.querySelector(".clear");let width=window.innerWidth,height=window.innerHeight,videoWidth=1980,videoHeight=1080,rotate="horizontal";video.addEventListener("canplaythrough",()=>{canvas.width=width,canvas.height=height}),window.addEventListener("resize",e=>__awaiter(void 0,void 0,void 0,function*(){console.log(width,height),width=window.innerWidth,height=window.innerHeight;let e;(e=width>height?"horizontal":"vertical")!==rotate&&(rotate=e,setDevice())})),btn1.addEventListener("click",()=>{console.log("clcik?"),capture()}),btn2.addEventListener("click",()=>{console.log("clcik?"),clear()});const isMobile=navigator.userAgent.toLocaleLowerCase().includes("mobile");function setDevice(){return __awaiter(this,void 0,void 0,function*(){try{var e={audio:!1,video:{facingMode:"environment",width:1280,height:720}},i={audio:!1,video:{width:videoWidth,height:videoHeight}};const t=yield navigator.mediaDevices.getUserMedia(isMobile?e:i);console.log(">>",rotate),"horizontal"===rotate?(video.width=width,video.height=.5625*width,console.log(video,"w",width)):(video.width=height/.5625,video.height=height,console.log(video,"h",height));(video.srcObject=t).getVideoTracks()[0]}catch(e){console.error(e)}})}function capture(){canvas.width=video.clientWidth,canvas.height=video.clientHeight,ctx.drawImage(video,0,0,video.width,video.height)}function clear(){ctx.clearRect(0,0,canvas.width,canvas.height)}window.onload=()=>__awaiter(void 0,void 0,void 0,function*(){width=window.innerWidth,height=window.innerHeight;let e;e=width>height?"horizontal":"vertical",rotate=e,setDevice()});
