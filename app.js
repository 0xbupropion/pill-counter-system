const video = document.getElementById("video");
const overlayCanvas = document.getElementById("overlay");
const overlayCtx = overlayCanvas.getContext("2d");
const previewEmpty = document.getElementById("previewEmpty");
const statusLabel = document.getElementById("statusLabel");
const processingStatus = document.getElementById("processingStatus");
const statusDot = document.getElementById("statusDot");
const helperText = document.getElementById("helperText");
const cameraSelect = document.getElementById("cameraSelect");
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
const totalCountElement = document.getElementById("totalCount");
const modelTotalCountElement = document.getElementById("modelTotalCount");

const workerCanvas = document.createElement("canvas");
const workerCtx = workerCanvas.getContext("2d", { willReadFrequently: true });
workerCanvas.width = 224;
workerCanvas.height = 168;

const snapshotCanvas = document.createElement("canvas");
const DEFAULT_LOCAL_API_BASE = "http://127.0.0.1:8000";

const state = {
  stream: null,
  deviceId: "",
  inverted: false,
  counting: false,
  rafId: 0,
  lastFrameAt: 0,
  frameGap: 140,
  countHistory: [],
  displayCount: 0,
  detections: [],
  reviewBusy: false,
};

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
  } catch {
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

function updateButtons() {
  if (!state.stream) {
    countButton.textContent = "啟動計數";
    confirmButton.disabled = true;
  } else {
    countButton.textContent = state.counting ? "停止計數" : "繼續計數";
    confirmButton.disabled = state.displayCount === 0;
  }

  reviewFrameButton.disabled = state.reviewBusy || !state.stream;
  uploadTrigger.disabled = state.reviewBusy;
}

function updateCountUI(count) {
  totalCountElement.textContent = String(count);
}

function updateModelCountUI(count = 0) {
  modelTotalCountElement.textContent = String(count);
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

function applyPreviewOrientation() {
  const transform = state.inverted ? "rotate(180deg)" : "rotate(0deg)";
  video.style.transform = transform;
  overlayCanvas.style.transform = transform;
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
  applyPreviewOrientation();

  const currentTrack = stream.getVideoTracks()[0];
  const settings = currentTrack.getSettings();
  state.deviceId = settings.deviceId || deviceId || state.deviceId;

  await enumerateCameras(state.deviceId);
  previewEmpty.classList.add("is-hidden");
  setStatus("鏡頭已開啟，正在分析", "即時計數中", true);
  setHelper("目前版本只統計同一畫面中的藥丸或藥品顆粒數。");
  startCounting();
}

function resetCounts() {
  state.countHistory = [];
  state.displayCount = 0;
  state.detections = [];
  updateCountUI(0);
  clearOverlay();
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
    const detections = detectGranules();
    state.detections = detections;

    const rawCount = detections.reduce((sum, detection) => sum + detection.pieces, 0);
    pushCountHistory(rawCount);
    state.displayCount = smoothCount();
    updateCountUI(state.displayCount);
    clearOverlay();
    updateButtons();

    if (state.displayCount > 0) {
      setHelper(`即時計數目前估計 ${state.displayCount} 顆，可用下方分析再做確認。`);
    } else {
      setHelper("目前尚未看到明顯的藥丸前景，請讓物件集中並和背景分開。");
    }
  }

  state.rafId = requestAnimationFrame(processFrame);
}

function pushCountHistory(count) {
  state.countHistory.push(count);
  if (state.countHistory.length > 5) {
    state.countHistory.shift();
  }
}

function smoothCount() {
  const values = [...state.countHistory].sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)] || 0;
}

function drawFrameToCanvas(targetCanvas, targetCtx, width, height) {
  targetCanvas.width = width;
  targetCanvas.height = height;
  targetCtx.save();
  targetCtx.clearRect(0, 0, width, height);
  if (state.inverted) {
    targetCtx.translate(width, height);
    targetCtx.rotate(Math.PI);
  }
  targetCtx.drawImage(video, 0, 0, width, height);
  targetCtx.restore();
}

function detectGranules() {
  drawFrameToCanvas(workerCanvas, workerCtx, workerCanvas.width, workerCanvas.height);
  const { data } = workerCtx.getImageData(0, 0, workerCanvas.width, workerCanvas.height);
  const mask = createForegroundMask(data, workerCanvas.width, workerCanvas.height);
  const refinedMask = refineMask(mask, workerCanvas.width, workerCanvas.height);
  const components = extractComponents(refinedMask, workerCanvas.width, workerCanvas.height);
  if (!components.length) {
    return [];
  }

  const filteredComponents = filterPillLikeComponents(components);
  if (!filteredComponents.length) {
    return [];
  }

  const referenceArea = median(
    filteredComponents.map((component) => component.area).filter((area) => area > 36),
  ) || 60;

  return filteredComponents.map((component) => buildDetection(component, referenceArea));
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
    r: sumR / Math.max(1, sampleCount),
    g: sumG / Math.max(1, sampleCount),
    b: sumB / Math.max(1, sampleCount),
    luma: sumLuma / Math.max(1, sampleCount),
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
    const redBalance = r - (g + b) * 0.5;
    mask[i] =
      colorDistance > 30 || luminanceDistance > 18 || Math.abs(redBalance) > 20 ? 1 : 0;
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

    while (queue.length) {
      const current = queue.pop();
      const x = current % width;
      const y = Math.floor(current / width);

      area += 1;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);

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

    const boxWidth = maxX - minX + 1;
    const boxHeight = maxY - minY + 1;
    const aspectRatio = Math.max(boxWidth, boxHeight) / Math.max(1, Math.min(boxWidth, boxHeight));
    const fillRatio = area / Math.max(1, boxWidth * boxHeight);

    components.push({
      area,
      minX,
      maxX,
      minY,
      maxY,
      width: boxWidth,
      height: boxHeight,
      aspectRatio,
      fillRatio,
    });
  }

  return components;
}

function filterPillLikeComponents(components) {
  const base = components.filter((component) => component.area > 36 && component.area < 5000);
  if (!base.length) {
    return [];
  }

  const medianArea = median(base.map((component) => component.area)) || 80;
  const medianAspect = median(base.map((component) => component.aspectRatio)) || 1.4;

  return base.filter((component) => {
    const areaRatio = component.area / Math.max(1, medianArea);
    const aspectGap = Math.abs(component.aspectRatio - medianAspect);
    const looksPillLike =
      component.fillRatio >= 0.2 &&
      component.fillRatio <= 0.95 &&
      component.aspectRatio >= 1 &&
      component.aspectRatio <= 4.8;
    const fitsScene =
      areaRatio >= 0.35 &&
      areaRatio <= 3.8 &&
      aspectGap <= Math.max(1.4, medianAspect * 0.9);
    return looksPillLike && fitsScene;
  });
}

function buildDetection(component, referenceArea) {
  const pieces =
    component.area > referenceArea * 2.15
      ? Math.min(4, Math.max(1, Math.round(component.area / Math.max(1, referenceArea))))
      : 1;

  return {
    pieces,
    x: component.minX / workerCanvas.width,
    y: component.minY / workerCanvas.height,
    width: component.width / workerCanvas.width,
    height: component.height / workerCanvas.height,
    aspectRatio: component.aspectRatio,
    fillRatio: component.fillRatio,
  };
}

function median(values) {
  if (!values.length) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function clearOverlay() {
  const rect = video.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width));
  const height = Math.max(1, Math.floor(rect.height));
  if (overlayCanvas.width !== width || overlayCanvas.height !== height) {
    overlayCanvas.width = width;
    overlayCanvas.height = height;
  }
  overlayCtx.clearRect(0, 0, width, height);
}

function announceConfirmation() {
  if (state.displayCount === 0) {
    return;
  }

  setHelper(`已確認目前畫面，共 ${state.displayCount} 顆。`);
}

function resetAnalysisPane() {
  updateModelCountUI(0);
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
      modelAvailabilityBadge.textContent = "同場一致性辨識";
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

  setReviewBusy(true, "分析中，正在找出同一畫面內像藥丸或藥品的顆粒...");
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
    setHelper(`分析完成，共找到 ${payload.totalCount} 顆候選物件。`);
  } catch (error) {
    console.error(error);
    const detail = isFileMode()
      ? `${error.message}。目前頁面是 file:// 模式，請先啟動 Flask 並保持 ${DEFAULT_LOCAL_API_BASE} 可連線。`
      : error.message;
    analysisMeta.innerHTML = `<p>分析失敗：${detail}</p>`;
    setHelper(`分析失敗：${detail}`);
  } finally {
    setReviewBusy(false);
  }
}

function renderAnalysisResult(result) {
  updateModelCountUI(result.totalCount);
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
        <p>這張圖沒有找到可計數的藥丸或藥品顆粒。</p>
      </article>
    `;
    return;
  }

  pillItems.innerHTML = result.items
    .map((item) => {
      const confidence =
        typeof item.confidence === "number"
          ? `${(item.confidence * 100).toFixed(1)}%`
          : "規則式辨識";
      const piecesText = item.pieces > 1 ? `，推估含 ${item.pieces} 顆` : "";
      return `
        <article class="pill-item">
          <h3>第 ${item.index} 個候選物件${piecesText}</h3>
          <span class="pill-tag">候選顆粒</span>
          <div class="pill-meta">
            <p>信心或模式：${confidence}</p>
            <p>長寬比：${item.shapeSummary.aspectRatio}</p>
            <p>填滿率：${item.shapeSummary.solidity}</p>
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

    const ctx = snapshotCanvas.getContext("2d");
    drawFrameToCanvas(snapshotCanvas, ctx, video.videoWidth, video.videoHeight);
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
  clearOverlay();
  const redirected = await autoRedirectToLocalServerIfAvailable();
  if (redirected) {
    return;
  }

  if (isFileMode()) {
    setHelper(
      `你目前是直接用檔案開啟頁面。即時計數可先使用，但上傳分析會改連 ${DEFAULT_LOCAL_API_BASE}。`,
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
  state.inverted = !state.inverted;
  applyPreviewOrientation();
  setHelper(state.inverted ? "畫面已旋轉 180 度。" : "畫面已恢復正常方向。");
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

window.addEventListener("resize", clearOverlay);
window.addEventListener("beforeunload", stopStream);

initialize();
