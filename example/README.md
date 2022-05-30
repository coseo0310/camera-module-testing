# API documentation

## 📙 인스턴스 생성 및 Canvas Element 반환

---

```html
<body>
  <div class="container"></div>
</body>
```

```ts
import Detector from "./detector.js";

const container = document.querySelector(".container");

const detector = new Detector();

container.appendChild(detector.getElement());
```

## 📙 Methods

---

인스턴스 전역 메소드

### 📬 getElement

---

생성된 ELEMENT를 반환합니다.

```ts
const el: HTMLDivElement = detector.getCanvas();
```

### 📬 capture

---

현재 비디오를 캡쳐 및 디텍트 합니다.

```ts
detector.capture();
```

### 📬 resetCapture

---

캡쳐된 이미지를 리셋합니다.

```ts
detector.resetCapture();
```

### 📬 setRealtimeDetect

---

실시간 디텍트된 라인을 on/off 합니다.

```ts
type isRealtime = boolean;

const isRealtime = true; // datault true
detector.setRealtimeDetect(isRealtime);
```
