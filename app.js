const video = document.getElementById("video");
const overlayCanvas = document.getElementById("overlay");
const overlayCtx = overlayCanvas.getContext("2d");
const previewEmpty = document.getElementById("previewEmpty");
const statusLabel = document.getElementById("statusLabel");
const processingStatus = document.getElementById("processingStatus");
const statusDot = document.getElementById("statusDot");
const helperText = document.getElementById("helperText");
const cameraSelect = document.getElementById("cameraSelect");
const annotationToggle = document.getElementById("annotationToggle");
const countButton = document.getElementById("countButton");
const confirmButton = document.getElementById("confirmButton");
const flipButton = document.getElementById("flipButton");
const logoutButton = document.getElementById("logoutButton");
const uploadTrigger = document.getElementById("uploadTrigger");
const uploadInput = document.getElementById("uploadInput");
const reviewFrameButton = document.getElementById("reviewFrameButton");
const modelAvailabilityBadge = document.getElementById("modelAvailabilityBadge");
const modelStatusText = document.getElementById("modelStatusText");
const analysisMeta = document.getElementById("analysisMeta");
const analysisPreview = document.getElementById("analysisPreview");
const analysisEmpty = document.getElementById("analysisEmpty");
const pillItems = document.getElementById("pillItems");

const countElements = {
  tablet: document.getElementById("tabletCount"),
  capsule: document.getElementById("capsuleCount"),
  needle: document.getElementById("needleCount"),
};

const modelCountElements = {
  tablet: document.getElementById("modelTabletCount"),
  capsule: document.getElementById("modelCapsuleCount"),
  needle: document.getElementById("modelNeedleCount"),
};

const workerCanvas = document.createElement("canvas");
const workerCtx = workerCanvas.getContext("2d", { willReadFrequently: true });
workerCanvas.width = 192;
workerCanvas.height = 144;

const snapshotCanvas = document.createElement("canvas");

const CLASS_STYLES = {
  tablet: { color: "#eca728", label: "錠劑" },
  capsule: { color: "#63c949", label: "膠囊" },
  needle: { color: "#ef6f74", label: "針頭" },
};

const state = {
  stream: null,
  deviceId: "",
  mirrored: false,
  counting: false,
  rafId: 0,
  lastFrameAt: 0,
  frameGap: 120,
  countHistory: [],
  displayCounts: { tablet: 0, capsule: 0, needle: 0 },
  detections: [],
  reviewBusy: false,
};

const DEFAULT_LOCAL_API_BASE = "http://127.0.0.1:8000";

function getApiBase() {
  if (window.location.protocol === "file:") {
    return DEFAULT_LOCAL_API_BASE;
  }

  return window.location.origin;
}

function apiUrl(path) {
  return `${getApiBase()}${path}`;
}

function isFileMode() {
  return window.location.protocol === "file:";
}

function buildLocalPageUrl() {
  const pathname = window.location.pathname || "";
  const filename = pathname.split("/").pop() || "index.html";
  if (!filename || filename === "index.html") {
    return `${DEFAULT_LOCAL_API_BASE}/`;
  }

  return `${DEFAULT_LOCAL_API_BASE}/${filename}`;
}

async function canReachLocalApi(timeoutMs = 1200) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(apiUrl("/api/health"), {
      method: "GET",
      signal: controller.signal,
    });
    return response.ok;
  } catch (error) {
    return false;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function autoRedirectToLocalServerIfAvailable() {
  if (!isFileMode()) {
    return false;
  }

  const reachable = await canReachLocalApi();
  if (!reachable) {
    return false;
  }

  window.location.replace(buildLocalPageUrl());
  return true;
}

function setStatus(message, label = message, live = false) {
  processingStatus.textContent = message;
  statusLabel.textContent = label;
  statusDot.classList.toggle("is-live", live);
}

function setHelper(message) {
  helperText.textContent = message;
}

function totalCount(counts) {
  return counts.tablet + counts.capsule + counts.needle;
}

function updateButtons() {
  if (!state.stream) {
    countButton.textContent = "啟動計數";
    confirmButton.disabled = true;
  } else {
    countButton.textContent = state.counting ? "停止計數" : "繼續計數";
    confirmButton.disabled = totalCount(state.displayCounts) === 0;
  }

  reviewFrameButton.disabled = state.reviewBusy || !state.stream;
  uploadTrigger.disabled = state.reviewBusy;
}

function updateCountUI(counts) {
  Object.entries(counts).forEach(([key, value]) => {
    countElements[key].textContent = String(value);
  });
}

function updateModelCountUI(counts = { tablet: 0, capsule: 0, needle: 0 }) {
  Object.entries(counts).forEach(([key, value]) => {
    modelCountElements[key].textContent = String(value);
  });
}

async function enumerateCameras(selectedDeviceId = "") {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cameras = devices.filter((device) => device.kind === "videoinput");

  cameraSelect.innerHTML = "";
  if (!cameras.length) {
    cameraSelect.innerHTML = '<option value="">找不到鏡頭</option>';
    return;
  }

  cameras.forEach((camera, index) => {
    const option = document.createElement("option");
    option.value = camera.deviceId;
    option.textContent = camera.label || `攝影鏡頭 ${index + 1}`;
    cameraSelect.appendChild(option);
  });

  const preferred =
    selectedDeviceId && cameras.some((camera) => camera.deviceId === selectedDeviceId)
      ? selectedDeviceId
      : findRearCamera(cameras)?.deviceId || cameras[0].deviceId;

  cameraSelect.value = preferred;
  state.deviceId = preferred;
}

function findRearCamera(cameras) {
  return cameras.find((camera) => /back|rear|environment|後/i.test(camera.label));
}

function stopStream() {
  if (!state.stream) {
    return;
  }

  state.stream.getTracks().forEach((track) => track.stop());
  state.stream = null;
  video.srcObject = null;
}

async function startCamera(deviceId = "") {
  stopStream();
  setStatus("正在連接鏡頭", "正在連接鏡頭...", false);
  setHelper("鏡頭一連上就會進入即時計數。");

  const constraints = {
    audio: false,
    video: deviceId
      ? { deviceId: { exact: deviceId } }
      : { facingMode: { ideal: "environment" } },
  };

  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  state.stream = stream;
  video.srcObject = stream;
  await video.play();

  const currentTrack = stream.getVideoTracks()[0];
  const settings = currentTrack.getSettings();
  state.deviceId = settings.deviceId || deviceId || state.deviceId;

  await enumerateCameras(state.deviceId);
  previewEmpty.classList.add("is-hidden");
  setStatus("鏡頭已開啟，正在分析", "即時計數中", true);
  setHelper("即時計數使用前端快速偵測；下方可用正式模型做覆核。");
  startCounting();
}

function resetCounts() {
  state.countHistory = [];
  state.displayCounts = { tablet: 0, capsule: 0, needle: 0 };
  state.detections = [];
  updateCountUI(state.displayCounts);
  drawOverlay([]);
  updateButtons();
}

function startCounting() {
  state.counting = true;
  state.lastFrameAt = 0;
  cancelAnimationFrame(state.rafId);
  state.rafId = requestAnimationFrame(processFrame);
  updateButtons();
}

function pauseCounting() {
  state.counting = false;
  cancelAnimationFrame(state.rafId);
  updateButtons();
}

function processFrame(timestamp) {
  if (!state.counting || !state.stream) {
    return;
  }

  if (timestamp - state.lastFrameAt >= state.frameGap) {
    state.lastFrameAt = timestamp;
    const detections = detectPills();
    state.detections = detections;

    const rawCounts = countDetections(detections);
    pushCountHistory(rawCounts);
    state.displayCounts = smoothCounts();
    updateCountUI(state.displayCounts);
    drawOverlay(detections);
    updateButtons();

    const total = totalCount(state.displayCounts);
    if (total > 0) {
      setHelper(`即時計數目前估計 ${total} 個物件，可用下方正式模型覆核。`);
    } else {
      setHelper("目前尚未看到清楚的前景物件，請讓藥丸和背景有明顯對比。");
    }
  }

  state.rafId = requestAnimationFrame(processFrame);
}

function pushCountHistory(counts) {
  state.countHistory.push(counts);
  if (state.countHistory.length > 5) {
    state.countHistory.shift();
  }
}

function smoothCounts() {
  const keys = ["tablet", "capsule", "needle"];
  const smoothed = { tablet: 0, capsule: 0, needle: 0 };

  keys.forEach((key) => {
    const values = state.countHistory.map((counts) => counts[key]).sort((a, b) => a - b);
    smoothed[key] = values[Math.floor(values.length / 2)] || 0;
  });

  return smoothed;
}

function countDetections(detections) {
  return detections.reduce(
    (acc, detection) => {
      acc[detection.type] += detection.pieces;
      return acc;
    },
    { tablet: 0, capsule: 0, needle: 0 },
  );
}

function detectPills() {
  const width = workerCanvas.width;
  const height = workerCanvas.height;

  workerCtx.save();
  workerCtx.clearRect(0, 0, width, height);
  if (state.mirrored) {
    workerCtx.translate(width, 0);
    workerCtx.scale(-1, 1);
  }
  workerCtx.drawImage(video, 0, 0, width, height);
  workerCtx.restore();

  const { data } = workerCtx.getImageData(0, 0, width, height);
  const mask = createForegroundMask(data, width, height);
  const refinedMask = refineMask(mask, width, height);
  const components = extractComponents(refinedMask, width, height);

  if (!components.length) {
    return [];
  }

  const validAreas = components
    .map((component) => component.area)
    .filter((area) => area > 40)
    .sort((a, b) => a - b);
  const referenceArea = validAreas[Math.floor(validAreas.length / 2)] || 60;

  return components
    .filter((component) => component.area > 40)
    .map((component) => classifyComponent(component, referenceArea, width, height))
    .filter(Boolean);
}

function createForegroundMask(data, width, height) {
  const border = 8;
  let sampleCount = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumLuma = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const isBorder = x < border || y < border || x >= width - border || y >= height - border;
      if (!isBorder) {
        continue;
      }

      const index = (y * width + x) * 4;
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      sumR += r;
      sumG += g;
      sumB += b;
      sumLuma += luma;
      sampleCount += 1;
    }
  }

  const bg = {
    r: sumR / sampleCount,
    g: sumG / sampleCount,
    b: sumB / sampleCount,
    luma: sumLuma / sampleCount,
  };

  const mask = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i += 1) {
    const index = i * 4;
    const r = data[index];
    const g = data[index + 1];
    const b = data[index + 2];
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    const colorDistance = Math.sqrt(
      (r - bg.r) ** 2 + (g - bg.g) ** 2 + (b - bg.b) ** 2,
    );
    const luminanceDistance = Math.abs(luma - bg.luma);

    mask[i] = colorDistance > 36 || luminanceDistance > 22 ? 1 : 0;
  }

  return mask;
}

function refineMask(mask, width, height) {
  const next = new Uint8Array(mask.length);

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      let neighbors = 0;
      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          if (ox === 0 && oy === 0) {
            continue;
          }
          neighbors += mask[(y + oy) * width + (x + ox)];
        }
      }

      if (mask[index] === 1) {
        next[index] = neighbors >= 2 ? 1 : 0;
      } else {
        next[index] = neighbors >= 6 ? 1 : 0;
      }
    }
  }

  return next;
}

function extractComponents(mask, width, height) {
  const visited = new Uint8Array(mask.length);
  const components = [];
  const neighbors = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] === 0 || visited[index] === 1) {
      continue;
    }

    const queue = [index];
    visited[index] = 1;

    let area = 0;
    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;
    let sumX = 0;
    let sumY = 0;

    while (queue.length) {
      const current = queue.pop();
      const x = current % width;
      const y = Math.floor(current / width);

      area += 1;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      sumX += x;
      sumY += y;

      neighbors.forEach(([dx, dy]) => {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
          return;
        }

        const nextIndex = ny * width + nx;
        if (mask[nextIndex] === 1 && visited[nextIndex] === 0) {
          visited[nextIndex] = 1;
          queue.push(nextIndex);
        }
      });
    }

    components.push({
      area,
      minX,
      maxX,
      minY,
      maxY,
      centroidX: sumX / area,
      centroidY: sumY / area,
    });
  }

  return components;
}

function classifyComponent(component, referenceArea, frameWidth, frameHeight) {
  const width = component.maxX - component.minX + 1;
  const height = component.maxY - component.minY + 1;
  const aspectRatio = Math.max(width, height) / Math.max(1, Math.min(width, height));
  const density = component.area / (width * height);
  const pieces =
    component.area > referenceArea * 1.9
      ? Math.min(4, Math.round(component.area / referenceArea))
      : 1;

  let type = "tablet";
  if (aspectRatio >= 3.2 || density <= 0.2) {
    type = "needle";
  } else if (aspectRatio >= 1.55) {
    type = "capsule";
  }

  return {
    type,
    pieces,
    x: component.minX / frameWidth,
    y: component.minY / frameHeight,
    width: width / frameWidth,
    height: height / frameHeight,
    centroidX: component.centroidX / frameWidth,
    centroidY: component.centroidY / frameHeight,
  };
}

function drawOverlay(detections) {
  const rect = video.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width));
  const height = Math.max(1, Math.floor(rect.height));

  if (overlayCanvas.width !== width || overlayCanvas.height !== height) {
    overlayCanvas.width = width;
    overlayCanvas.height = height;
  }

  overlayCtx.clearRect(0, 0, width, height);

  if (!annotationToggle.checked) {
    return;
  }

  overlayCtx.lineWidth = 3;
  overlayCtx.font = "600 14px 'Noto Sans TC', sans-serif";
  overlayCtx.textBaseline = "top";

  detections.forEach((detection) => {
    const style = CLASS_STYLES[detection.type];
    const boxX = detection.x * width;
    const boxY = detection.y * height;
    const boxWidth = detection.width * width;
    const boxHeight = detection.height * height;
    const label = `${style.label}${detection.pieces > 1 ? ` x${detection.pieces}` : ""}`;

    overlayCtx.strokeStyle = style.color;
    overlayCtx.fillStyle = `${style.color}22`;
    overlayCtx.fillRect(boxX, boxY, boxWidth, boxHeight);
    overlayCtx.strokeRect(boxX, boxY, boxWidth, boxHeight);

    const textWidth = overlayCtx.measureText(label).width;
    overlayCtx.fillStyle = style.color;
    overlayCtx.fillRect(boxX, Math.max(0, boxY - 24), textWidth + 18, 22);
    overlayCtx.fillStyle = "#fff";
    overlayCtx.fillText(label, boxX + 9, Math.max(2, boxY - 22));
  });
}

function announceConfirmation() {
  const counts = state.displayCounts;
  if (totalCount(counts) === 0) {
    return;
  }

  setHelper(`已確認目前標記：錠劑 ${counts.tablet}、膠囊 ${counts.capsule}、針頭 ${counts.needle}。`);
}

function resetAnalysisPane() {
  updateModelCountUI();
  analysisPreview.src = "";
  analysisPreview.classList.remove("is-visible");
  analysisEmpty.classList.remove("is-hidden");
  modelStatusText.textContent = "正在檢查後端模型狀態...";
  analysisMeta.innerHTML = "<p>尚未上傳圖片或覆核鏡頭畫面。</p>";
  pillItems.innerHTML = `
    <article class="pill-item empty-pill-item">
      <p>尚未產生辨識結果。</p>
    </article>
  `;
}

function resetSession() {
  pauseCounting();
  stopStream();
  resetCounts();
  resetAnalysisPane();
  previewEmpty.classList.remove("is-hidden");
  setStatus("工作階段已清空", "工作階段已清空", false);
  setHelper("已關閉鏡頭並清空計數，按下啟動計數可重新開啟。");
  updateButtons();
}

async function syncHealthStatus() {
  try {
    const response = await fetch(apiUrl("/api/health"));
    const health = await response.json();
    modelStatusText.textContent = health.modelStatus;
    if (health.modelReady) {
      modelAvailabilityBadge.textContent = "模型已接入";
      modelAvailabilityBadge.classList.add("is-ready");
      modelAvailabilityBadge.classList.remove("is-fallback");
    } else {
      modelAvailabilityBadge.textContent = "強化分割模式";
      modelAvailabilityBadge.classList.add("is-fallback");
      modelAvailabilityBadge.classList.remove("is-ready");
    }
  } catch (error) {
    console.error(error);
    modelAvailabilityBadge.textContent = "後端未連線";
    modelStatusText.textContent = isFileMode()
      ? `無法取得後端狀態。你目前是直接用檔案開啟頁面，請先啟動 Flask，並確認 ${DEFAULT_LOCAL_API_BASE} 可連線。`
      : "無法取得後端狀態，請確認 Flask 伺服器已啟動。";
  }
}

function setReviewBusy(isBusy, message = "") {
  state.reviewBusy = isBusy;
  if (isBusy && message) {
    setHelper(message);
  }
  updateButtons();
}

async function analyzeBlob(blob, filename) {
  const formData = new FormData();
  formData.append("image", blob, filename);

  setReviewBusy(true, "正式模型分析中，正在切割與辨識單顆藥丸...");
  try {
    const response = await fetch(apiUrl("/api/analyze-image"), {
      method: "POST",
      body: formData,
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || "分析失敗");
    }

    renderAnalysisResult(payload);
    setHelper(
      `正式模型完成分析，共找到 ${payload.totalCount} 個物件。背景接近與重疊問題已用加強分割處理。`,
    );
  } catch (error) {
    console.error(error);
    const detail = isFileMode()
      ? `${error.message}。目前頁面是 file:// 模式，請先啟動 Flask 並保持 ${DEFAULT_LOCAL_API_BASE} 可連線。`
      : error.message;
    analysisMeta.innerHTML = `<p>分析失敗：${detail}</p>`;
    setHelper(`正式模型分析失敗：${detail}`);
  } finally {
    setReviewBusy(false);
  }
}

function renderAnalysisResult(result) {
  updateModelCountUI(result.counts);
  modelStatusText.textContent = result.modelStatus;
  analysisPreview.src = result.annotatedImage;
  analysisPreview.classList.add("is-visible");
  analysisEmpty.classList.add("is-hidden");

  analysisMeta.innerHTML = `
    <p>來源：${result.sourceFile}</p>
    <p>總數：${result.totalCount} 顆</p>
    <p>${result.notes.join(" ")}</p>
  `;

  if (!result.items.length) {
    pillItems.innerHTML = `
      <article class="pill-item empty-pill-item">
        <p>這張圖沒有找到可計數的藥丸。</p>
      </article>
    `;
    return;
  }

  pillItems.innerHTML = result.items
    .map((item) => {
      const confidence =
        typeof item.confidence === "number"
          ? `${(item.confidence * 100).toFixed(1)}%`
          : "未使用正式分類模型";
      const title = item.pillName || `第 ${item.index} 顆 ${CLASS_STYLES[item.type].label}`;
      return `
        <article class="pill-item">
          <h3>${title}</h3>
          <span class="pill-tag ${item.type}">${CLASS_STYLES[item.type].label}</span>
          <div class="pill-meta">
            <p>信心度：${confidence}</p>
            <p>長寬比：${item.shapeSummary.aspectRatio}</p>
            <p>solidity：${item.shapeSummary.solidity}</p>
          </div>
        </article>
      `;
    })
    .join("");
}

function captureCurrentFrameBlob() {
  return new Promise((resolve, reject) => {
    if (!state.stream || video.videoWidth === 0 || video.videoHeight === 0) {
      reject(new Error("鏡頭尚未準備好"));
      return;
    }

    snapshotCanvas.width = video.videoWidth;
    snapshotCanvas.height = video.videoHeight;
    const ctx = snapshotCanvas.getContext("2d");
    ctx.save();
    if (state.mirrored) {
      ctx.translate(snapshotCanvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, snapshotCanvas.width, snapshotCanvas.height);
    ctx.restore();

    snapshotCanvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("無法建立影像快照"));
        return;
      }
      resolve(blob);
    }, "image/png");
  });
}

async function initialize() {
  resetAnalysisPane();
  const redirected = await autoRedirectToLocalServerIfAvailable();
  if (redirected) {
    return;
  }

  if (isFileMode()) {
    setHelper(
      `你目前是直接用檔案開啟頁面。即時計數可先使用，但正式模型分析會改連 ${DEFAULT_LOCAL_API_BASE}。`,
    );
  }
  await syncHealthStatus();

  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("此瀏覽器不支援鏡頭", "瀏覽器不支援鏡頭", false);
    setHelper("請改用支援 camera API 的瀏覽器。");
    return;
  }

  try {
    await startCamera();
  } catch (error) {
    console.error(error);
    setStatus("鏡頭開啟失敗", "鏡頭授權失敗", false);
    setHelper("請允許相機權限，再重新啟動計數。");
    updateButtons();
  }
}

cameraSelect.addEventListener("change", async (event) => {
  const nextDeviceId = event.target.value;
  if (!nextDeviceId) {
    return;
  }

  try {
    await startCamera(nextDeviceId);
  } catch (error) {
    console.error(error);
    setHelper("切換鏡頭失敗，請再試一次。");
  }
});

annotationToggle.addEventListener("change", () => {
  drawOverlay(state.detections);
});

countButton.addEventListener("click", async () => {
  if (!state.stream) {
    try {
      await startCamera(state.deviceId);
    } catch (error) {
      console.error(error);
      setHelper("目前無法重新連上鏡頭。");
    }
    return;
  }

  if (state.counting) {
    pauseCounting();
    setStatus("鏡頭已開啟，計數已暫停", "計數已暫停", true);
    setHelper("按一次即可從目前鏡頭畫面繼續。");
  } else {
    startCounting();
    setStatus("鏡頭已開啟，正在分析", "即時計數中", true);
  }
});

confirmButton.addEventListener("click", announceConfirmation);

flipButton.addEventListener("click", () => {
  state.mirrored = !state.mirrored;
  const transform = state.mirrored ? "scaleX(-1)" : "scaleX(1)";
  video.style.transform = transform;
  overlayCanvas.style.transform = transform;
  setHelper(state.mirrored ? "畫面已顛倒，方便對應前鏡頭視角。" : "畫面已恢復正常方向。");
});

logoutButton.addEventListener("click", resetSession);

uploadTrigger.addEventListener("click", () => {
  uploadInput.click();
});

uploadInput.addEventListener("change", async (event) => {
  const [file] = event.target.files || [];
  if (!file) {
    return;
  }

  await analyzeBlob(file, file.name);
  uploadInput.value = "";
});

reviewFrameButton.addEventListener("click", async () => {
  try {
    const blob = await captureCurrentFrameBlob();
    await analyzeBlob(blob, "camera-frame.png");
  } catch (error) {
    console.error(error);
    setHelper(`覆核目前畫面失敗：${error.message}`);
  }
});

window.addEventListener("resize", () => drawOverlay(state.detections));
window.addEventListener("beforeunload", stopStream);

initialize();
