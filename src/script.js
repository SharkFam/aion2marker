const mapBounds = [
  [0, 0],
  [4361, 4392],
];

const map = L.map("map-container", {
  crs: L.CRS.Simple,
  minZoom: -2,
  maxZoom: 1,
  zoomSnap: 0.25,
  attributionControl: false,
  doubleClickZoom: false,
});

const imageOverlay = L.imageOverlay("back.png", mapBounds).addTo(map);
map.fitBounds(mapBounds);

const counterDisplay = document.getElementById("counter-display");
const shareButton = document.getElementById("generate-share-link");
const resetButton = document.getElementById("reset-markers");
const exportButton = document.getElementById("export-markers");
const importButton = document.getElementById("import-markers");
const importFileInput = document.getElementById("import-file-input");
const recenterButton = document.getElementById("recenter-map");
const helpToggleButton = document.getElementById("help-toggle");
const helpModal = document.getElementById("help-modal");
const helpCloseButton = document.getElementById("help-close");

let markerCoords = [];
const markersById = new Map();
let nextMarkerId = 1;

const ENCODING_PREFIX = "b.";
const ENCODING_VERSION = 1;
const BASE_MARKER_SIZE = 26;
const MIN_MARKER_SIZE = 12;
const MAX_MARKER_SIZE = 30;

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function encodeMarkerDataBinary(data) {
  const count = data.length;
  const buffer = new ArrayBuffer(6 + count * 10);
  const view = new DataView(buffer);
  view.setUint16(0, ENCODING_VERSION);
  view.setUint16(2, count);
  view.setUint16(4, Math.min(nextMarkerId, 65535));
  let offset = 6;
  data.forEach((entry) => {
    view.setUint16(offset, entry.id);
    offset += 2;
    view.setFloat32(offset, entry.lat);
    offset += 4;
    view.setFloat32(offset, entry.lng);
    offset += 4;
  });
  return buffer;
}

function decodeMarkerDataBinary(encoded) {
  if (!encoded.startsWith(ENCODING_PREFIX)) return null;
  try {
    const payload = encoded.slice(ENCODING_PREFIX.length);
    const buffer = base64ToArrayBuffer(payload);
    const view = new DataView(buffer);
    if (buffer.byteLength < 6) return null;
    const version = view.getUint16(0);
    if (version !== ENCODING_VERSION) return null;
    const count = view.getUint16(2);
    const storedNextId = view.getUint16(4) || 1;
    const expectedLength = 6 + count * 10;
    if (buffer.byteLength !== expectedLength) return null;
    let offset = 6;
    const entries = [];
    let maxId = 0;
    for (let i = 0; i < count; i += 1) {
      const id = view.getUint16(offset);
      offset += 2;
      const lat = view.getFloat32(offset);
      offset += 4;
      const lng = view.getFloat32(offset);
      offset += 4;
      entries.push({ id, lat, lng });
      if (id > maxId) maxId = id;
    }
    return {
      entries,
      nextId: Math.max(storedNextId, maxId + 1),
    };
  } catch (err) {
    console.error("Binary decode failed:", err);
    return null;
  }
}

function decodeMarkerDataLegacy(encoded) {
  if (
    window.LZString &&
    typeof window.LZString.decompressFromEncodedURIComponent === "function"
  ) {
    try {
      const json = window.LZString.decompressFromEncodedURIComponent(encoded);
      if (json) {
        return JSON.parse(json);
      }
    } catch (err) {
      console.error("LZString decode failed:", err);
    }
  }
  try {
    return JSON.parse(decodeURIComponent(encoded));
  } catch (err) {
    console.error("Legacy decode failed:", err);
    return null;
  }
}

function encodeMarkerData(data) {
  const buffer = encodeMarkerDataBinary(data);
  return `${ENCODING_PREFIX}${arrayBufferToBase64(buffer)}`;
}

function decodeMarkerData(encoded) {
  if (!encoded) return null;
  const binaryDecoded = decodeMarkerDataBinary(encoded);
  if (binaryDecoded) {
    return binaryDecoded;
  }

  const legacy = decodeMarkerDataLegacy(encoded);
  if (!Array.isArray(legacy)) return null;
  const entries = legacy
    .filter(
      (entry) =>
        entry &&
        typeof entry.lat === "number" &&
        typeof entry.lng === "number"
    )
    .map((entry, index) => ({
      id:
        typeof entry.id === "number"
          ? entry.id
          : Number.parseInt(`${entry.id}`.replace(/\D/g, ""), 10) ||
            index + 1,
      lat: entry.lat,
      lng: entry.lng,
    }));
  const maxId = entries.reduce((max, entry) => Math.max(max, entry.id), 0);
  return {
    entries,
    nextId: maxId + 1,
  };
}

function updateCounter() {
  counterDisplay.textContent = `${markerCoords.length} / 560`;
}

function syncMarkerData() {
  markerCoords = markerCoords.filter((entry) => markersById.has(entry.id));
}

function saveAndShare() {
  syncMarkerData();
  const encoded = encodeMarkerData(markerCoords);
  const base = `${window.location.origin}${window.location.pathname}`;
  const newUrl = `${base}?data=${encoded}`;
  window.history.replaceState(null, "", newUrl);
  localStorage.setItem("markerShareURL", newUrl);
  localStorage.setItem("markerData", encoded);
  return newUrl;
}

function clearAllMarkers() {
  markersById.forEach((marker) => map.removeLayer(marker));
  markersById.clear();
  markerCoords = [];
  nextMarkerId = 1;
  updateCounter();
}

function computeMarkerSize() {
  const minZoom = map.getMinZoom();
  const maxZoom = map.getMaxZoom();
  const zoomRange = maxZoom - minZoom;
  if (zoomRange <= 0) return BASE_MARKER_SIZE;
  const normalized = Math.min(1, Math.max(0, (map.getZoom() - minZoom) / zoomRange));
  return MIN_MARKER_SIZE + normalized * (MAX_MARKER_SIZE - MIN_MARKER_SIZE);
}

function applyMarkerSize(marker) {
  const element = marker.getElement();
  if (!element) {
    requestAnimationFrame(() => applyMarkerSize(marker));
    return;
  }

  const wrapper = element.querySelector(".custom-marker");
  if (!wrapper) return;

  const size = computeMarkerSize();
  element.style.width = `${size}px`;
  element.style.height = `${size}px`;
  element.style.marginLeft = `${-size / 2}px`;
  element.style.marginTop = `${-size / 2}px`;
  wrapper.style.width = `${size}px`;
  wrapper.style.height = `${size}px`;
  wrapper.style.borderWidth = `${Math.max(1.5, size * 0.08)}px`;

  const button = wrapper.querySelector(".remove-btn");
  if (button) {
    const innerSize = Math.max(size * 0.55, 10);
    button.style.width = `${innerSize}px`;
    button.style.height = `${innerSize}px`;
    button.style.fontSize = `${Math.max(innerSize * 0.45, 8)}px`;
  }
}

function updateAllMarkerSizes() {
  markersById.forEach((marker) => applyMarkerSize(marker));
}

function isCenterWithinImage(latlng) {
  const [[minLat, minLng], [maxLat, maxLng]] = mapBounds;
  return (
    latlng.lat >= minLat &&
    latlng.lat <= maxLat &&
    latlng.lng >= minLng &&
    latlng.lng <= maxLng
  );
}

function updateRecenterButtonVisibility() {
  if (!recenterButton) return;
  const center = map.getCenter();
  if (isCenterWithinImage(center)) {
    recenterButton.classList.remove("visible");
  } else {
    recenterButton.classList.add("visible");
  }
}

function openHelpModal() {
  if (!helpModal) return;
  helpModal.classList.add("visible");
  helpModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
}

function closeHelpModal() {
  if (!helpModal) return;
  helpModal.classList.remove("visible");
  helpModal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
}

async function downloadBackup() {
  syncMarkerData();
  const encoded = encodeMarkerData(markerCoords);
  const blob = new Blob([encoded], { type: "text/plain" });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `aion2-markers-${timestamp}.a2mk`;

  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [
          {
            description: "아이온2 마커 백업",
            accept: { "text/plain": [".a2mk", ".txt"] },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      alert("백업 파일이 저장되었습니다.");
      return;
    } catch (err) {
      if (err && err.name === "AbortError") {
        return;
      }
      console.error("showSaveFilePicker failed:", err);
      alert("파일 저장 중 오류가 발생했습니다. 기본 다운로드 방식으로 진행합니다.");
    }
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  setTimeout(() => {
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, 0);
}

function handleImportContent(raw) {
  const content = typeof raw === "string" ? raw.trim() : "";
  if (!content) {
    alert("유효한 백업 파일이 아닙니다.");
    return;
  }
  const restored = restoreMarkers(content, { resetExisting: true });
  if (restored) {
    saveAndShare();
    alert("백업이 복원되었습니다.");
  } else {
    alert("백업 파일을 읽을 수 없습니다.");
  }
}

function handleImportFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (event) => {
    const text = event.target?.result;
    handleImportContent(typeof text === "string" ? text : "");
  };
  reader.onerror = () => {
    alert("파일을 읽는 중 문제가 발생했습니다.");
  };
  reader.readAsText(file);
}

function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text);
  }

  return new Promise((resolve, reject) => {
    const tempInput = document.createElement("textarea");
    tempInput.value = text;
    tempInput.style.position = "fixed";
    tempInput.style.top = "-9999px";
    document.body.appendChild(tempInput);
    tempInput.focus();
    tempInput.select();

    try {
      document.execCommand("copy");
      resolve();
    } catch (err) {
      reject(err);
    } finally {
      document.body.removeChild(tempInput);
    }
  });
}

function attachRemovalHandler(markerId, marker) {
  const element = marker.getElement();
  if (!element) {
    requestAnimationFrame(() => attachRemovalHandler(markerId, marker));
    return;
  }

  const btn = element.querySelector(".remove-btn");
  if (!btn) return;

  const handleClick = (event) => {
    event.stopPropagation();
    removeMarker(markerId);
  };

  btn.addEventListener("click", handleClick, { once: true });
}

function createMarker(latlng, existingId) {
  const markerId = existingId || nextMarkerId++;
  const marker = L.marker(latlng, {
    draggable: false,
    icon: L.divIcon({
      className: "",
      html: `<div class="custom-marker"><button class="remove-btn" type="button">X</button></div>`,
      iconSize: [BASE_MARKER_SIZE, BASE_MARKER_SIZE],
      iconAnchor: [BASE_MARKER_SIZE / 2, BASE_MARKER_SIZE / 2],
    }),
  });

  marker.on("add", () => attachRemovalHandler(markerId, marker));
  marker.addTo(map);
  applyMarkerSize(marker);

  markersById.set(markerId, marker);

  if (!existingId) {
    markerCoords.push({ id: markerId, lat: latlng.lat, lng: latlng.lng });
    updateCounter();
    saveAndShare();
  }

  return markerId;
}

function removeMarker(markerId) {
  const marker = markersById.get(markerId);
  if (!marker) return;

  map.removeLayer(marker);
  markersById.delete(markerId);
  markerCoords = markerCoords.filter((entry) => entry.id !== markerId);
  updateCounter();
  saveAndShare();
}

function handleMapDoubleClick(event) {
  const latlng = event.latlng;
  createMarker(latlng);
}

function restoreMarkers(encodedData, { resetExisting = false } = {}) {
  const parsed = decodeMarkerData(encodedData);
  if (!parsed || !Array.isArray(parsed.entries)) return false;

  if (resetExisting) {
    clearAllMarkers();
  }

  nextMarkerId = Math.max(parsed.nextId || 1, nextMarkerId);
  parsed.entries.forEach((entry) => {
    markerCoords.push({ id: entry.id, lat: entry.lat, lng: entry.lng });
    createMarker({ lat: entry.lat, lng: entry.lng }, entry.id);
  });
  updateCounter();
  return true;
}

function loadInitialMarkers() {
  const urlParams = new URLSearchParams(window.location.search);
  const urlData = urlParams.get("data");
  if (urlData) {
    restoreMarkers(urlData);
    return;
  }

  const storedData = localStorage.getItem("markerData");
  if (storedData) {
    restoreMarkers(storedData);
  }
}

shareButton.addEventListener("click", async () => {
  const url = saveAndShare();
  try {
    await copyToClipboard(url);
    shareButton.textContent = "복사 완료!";
  } catch (err) {
    console.error("Clipboard copy failed:", err);
    shareButton.textContent = "복사 실패";
  } finally {
    setTimeout(() => {
      shareButton.textContent = "링크 저장";
    }, 1500);
  }
});

resetButton.addEventListener("click", () => {
  if (!markersById.size) return;
  const firstConfirm = confirm("모든 마커를 초기화하시겠습니까?");
  if (!firstConfirm) return;
  const secondConfirm = confirm("정말로 모든 마커를 삭제합니다. 계속할까요?");
  if (!secondConfirm) return;

  clearAllMarkers();
  saveAndShare();
});

exportButton.addEventListener("click", () => {
  downloadBackup();
});

importButton.addEventListener("click", () => {
  importFileInput.value = "";
  importFileInput.click();
});

importFileInput.addEventListener("change", (event) => {
  const file = event.target.files && event.target.files[0];
  if (file) {
    handleImportFile(file);
  }
  importFileInput.value = "";
});

if (recenterButton) {
  recenterButton.addEventListener("click", () => {
    map.fitBounds(mapBounds, { animate: true });
    updateRecenterButtonVisibility();
  });
}

if (helpToggleButton) {
  helpToggleButton.addEventListener("click", openHelpModal);
}

if (helpCloseButton) {
  helpCloseButton.addEventListener("click", closeHelpModal);
}

if (helpModal) {
  helpModal.addEventListener("click", (event) => {
    if (event.target === helpModal) {
      closeHelpModal();
    }
  });
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && helpModal?.classList.contains("visible")) {
    closeHelpModal();
  }
});

map.on("dblclick", handleMapDoubleClick);
map.on("zoom", updateAllMarkerSizes);
map.on("moveend", updateRecenterButtonVisibility);
map.once("load", () => {
  updateAllMarkerSizes();
  updateRecenterButtonVisibility();
});
loadInitialMarkers();
updateCounter();
updateAllMarkerSizes();
updateRecenterButtonVisibility();

