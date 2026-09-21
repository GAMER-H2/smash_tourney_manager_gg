<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { convertFileSrc } from "@tauri-apps/api/core";
import { allowOverlayLayoutPath, getPlatform } from "../lib/api";

const props = defineProps({
  cameraId: {
    type: String,
    default: "",
  },
  sourceMode: {
    type: String,
    default: "auto",
    validator: (value) => ["auto", "virtualcam", "overlay"].includes(value),
  },
  overlayUrl: {
    type: String,
    default: "",
  },
});

const emit = defineEmits(["update:cameraId"]);

const cameras = ref([]);
const videoEl = ref(null);
const stageEl = ref(null);
const overlayFrameEl = ref(null);
const stream = ref(null);
const error = ref("");
const loading = ref(false);
const isLinux = ref(false);
const overlaySrc = ref("");
const overlayError = ref("");
const stageWidth = ref(0);
const overlayReloadKey = ref(0);

// OBS names its virtual camera device consistently across platforms, and it is
// the only device whose picture is already the finished program feed. Matching
// on the label is the only signal available - getUserMedia deviceIds are
// opaque and rotate per origin.
const VIRTUAL_CAMERA_LABEL = /obs\s*virtual/i;

// Layouts are authored against OBS's canvas, so the iframe renders at a fixed
// 1920x1080 and gets scaled down to whatever width the panel has. Scaling the
// iframe rather than resizing it keeps the layout's own absolute positioning
// intact.
const LAYOUT_WIDTH = 1920;
const LAYOUT_HEIGHT = 1080;

const virtualCamera = computed(() =>
  cameras.value.find((camera) => VIRTUAL_CAMERA_LABEL.test(camera.label)),
);

// "auto" is a preference for the virtual camera, not a hard requirement: if
// the no-admin registration didn't take on this machine, no virtual camera is
// enumerated and the capture-card-plus-overlay preview takes over without
// anyone having to change a setting at the venue.
const effectiveMode = computed(() => {
  if (props.sourceMode !== "auto") return props.sourceMode;
  return virtualCamera.value ? "virtualcam" : "overlay";
});

const showOverlay = computed(() => effectiveMode.value === "overlay" && Boolean(overlaySrc.value));

const overlayStyle = computed(() => ({
  width: `${LAYOUT_WIDTH}px`,
  height: `${LAYOUT_HEIGHT}px`,
  transform: `scale(${stageWidth.value ? stageWidth.value / LAYOUT_WIDTH : 0})`,
}));

const modeLabel = computed(() => {
  if (effectiveMode.value === "virtualcam") return "OBS Virtual Camera";
  return "Capture card + overlay";
});

function stopStream() {
  if (!stream.value) return;
  const current = stream.value;
  for (const track of current.getTracks()) {
    track.stop();
  }
  stream.value = null;
  if (videoEl.value?.srcObject === current) videoEl.value.srcObject = null;
}

async function requestPermissionIfNeeded() {
  try {
    const temp = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: false,
    });
    temp.getTracks().forEach((track) => track.stop());
  } catch (err) {
    error.value = `Could not access webcam: ${err?.message || err}`;
  }
}

async function refreshCameras() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    error.value = "Media device enumeration is not available in this environment.";
    return;
  }

  loading.value = true;
  error.value = "";

  try {
    await requestPermissionIfNeeded();
    const devices = await navigator.mediaDevices.enumerateDevices();
    cameras.value = devices
      .filter((device) => device.kind === "videoinput")
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `Camera ${index + 1}`,
      }));

    // In auto mode the virtual camera is the whole point, so select it when
    // it shows up - unless the operator has already picked something else by
    // hand this session, in which case leave their choice alone.
    const preferred =
      props.sourceMode === "auto" && !userPickedCamera.value
        ? virtualCamera.value
        : undefined;
    const stillPresent = cameras.value.some((camera) => camera.deviceId === props.cameraId);

    if (preferred && props.cameraId !== preferred.deviceId) {
      emit("update:cameraId", preferred.deviceId);
    } else if (!stillPresent && cameras.value.length > 0) {
      emit("update:cameraId", cameras.value[0].deviceId);
    }
  } catch (err) {
    error.value = `Failed to list cameras: ${err?.message || err}`;
  } finally {
    loading.value = false;
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const userPickedCamera = ref(false);

function onCameraPicked(deviceId) {
  userPickedCamera.value = true;
  emit("update:cameraId", deviceId);
}

// An http(s) layout URL can be framed as-is. A local path - which is what an
// OBS browser source pointed at a file actually holds - cannot: the webview
// document has an http origin and is not allowed to frame file://. Tauri's
// asset protocol re-serves the layout's directory over a real origin instead,
// which also keeps the layout's relative CSS/JS and its program_state.json
// polling working.
async function resolveOverlaySrc() {
  const raw = props.overlayUrl.trim();
  overlayError.value = "";

  if (!raw) {
    overlaySrc.value = "";
    return;
  }

  if (/^https?:\/\//i.test(raw)) {
    overlaySrc.value = raw;
    return;
  }

  let path = raw;
  if (/^file:\/\//i.test(raw)) {
    try {
      path = decodeURIComponent(new URL(raw).pathname);
      // file:///C:/... parses to a pathname with a leading slash Windows
      // rejects; drop it when what follows looks like a drive letter.
      if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
    } catch {
      overlaySrc.value = "";
      overlayError.value = `Overlay layout URL is not valid: ${raw}`;
      return;
    }
  }

  try {
    const canonical = await allowOverlayLayoutPath(path);
    overlaySrc.value = convertFileSrc(canonical);
  } catch (err) {
    overlaySrc.value = "";
    overlayError.value = `Could not load overlay layout: ${String(err)}`;
  }
}

function reloadOverlay() {
  overlayReloadKey.value++;
}

let stageObserver = null;

function measureStage() {
  stageWidth.value = stageEl.value?.clientWidth || 0;
}

// The very first capture pipeline built right after app launch can silently
// negotiate to a stalled state (no error, no frames) on some camera/driver
// combos; a stream restart reliably clears it, so detect the stall instead
// of leaving the preview blank forever with no feedback. Polling decoded
// frame dimensions is used instead of the "loadeddata" event since that
// event doesn't fire reliably for live MediaStream video in every WebKit
// build.
function waitForFirstFrame(videoElement, timeoutMs) {
  if (videoElement.videoWidth > 0 && videoElement.videoHeight > 0) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (videoElement.videoWidth > 0 && videoElement.videoHeight > 0) {
        clearInterval(interval);
        resolve(true);
      } else if (Date.now() - start >= timeoutMs) {
        clearInterval(interval);
        resolve(false);
      }
    }, 100);
  });
}

// Transient failure modes worth a retry: rapid-reopen of the same device
// (the permission probe right before this closes it, then we reopen it
// right away) can abort or briefly fail as "not readable" on some camera
// stacks. Anything else (permission denied, bad constraints) won't be
// fixed by retrying, so fail fast on those.
const RETRYABLE_ERROR_NAMES = new Set(["AbortError", "NotReadableError"]);
const MAX_PREVIEW_ATTEMPTS = 3;

// On mount, refreshCameras() auto-selecting a camera (via emit) and
// onMounted's own follow-up call both end up calling startPreview for the
// same device almost simultaneously. Only the most recently issued call
// should touch shared state or the shared device; stale ones quietly stop
// whatever they opened and get out of the way.
let latestRequestId = 0;

async function startPreview(deviceId) {
  if (!navigator.mediaDevices?.getUserMedia) {
    error.value = "getUserMedia is not supported in this environment.";
    return;
  }

  const requestId = ++latestRequestId;

  if (!deviceId) {
    stopStream();
    return;
  }

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_PREVIEW_ATTEMPTS; attempt++) {
    if (requestId !== latestRequestId) return;

    try {
      error.value = "";
      stopStream();
      if (attempt > 1) await wait(300);

      const next = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: {
            exact: deviceId,
          },
          // This app only ever needs a 1920x1080@60 preview; stating it
          // explicitly (as "ideal", not "exact") avoids relying on
          // whatever implicit default resolution/frame rate the engine
          // would otherwise assume, while still letting a device that
          // can't hit it (e.g. the C920 tops out around 5fps at 1080p)
          // fall back instead of hard-failing.
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 60 },
        },
        audio: false,
      });

      if (requestId !== latestRequestId) {
        next.getTracks().forEach((track) => track.stop());
        return;
      }

      stream.value = next;

      if (videoEl.value) {
        videoEl.value.srcObject = next;
        await videoEl.value.play();

        if (!(await waitForFirstFrame(videoEl.value, 1500))) {
          lastError = new Error("Camera opened but never produced a frame");
          continue;
        }
      }

      return;
    } catch (err) {
      lastError = err;
      if (!RETRYABLE_ERROR_NAMES.has(err?.name)) {
        break;
      }
    }
  }

  if (requestId === latestRequestId) {
    error.value = `Failed to start camera preview: ${lastError?.message || lastError}`;
  }
}

async function goFullscreen() {
  // With the overlay composited on top, the video element alone is not the
  // picture - the stage wrapper holding both is.
  const el = showOverlay.value ? stageEl.value : videoEl.value;
  if (!el) return;

  if (document.fullscreenElement || document.webkitFullscreenElement) {
    if (document.exitFullscreen) {
      await document.exitFullscreen();
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    }
    return;
  }

  try {
    if (el.requestFullscreen) {
      await el.requestFullscreen();
    } else if (el.webkitRequestFullscreen) {
      el.webkitRequestFullscreen();
    } else if (el.webkitEnterFullscreen) {
      el.webkitEnterFullscreen();
    } else {
      error.value = "Fullscreen is not supported in this environment.";
    }
  } catch (err) {
    error.value = `Failed to enter fullscreen: ${err?.message || err}`;
  }
}

watch(
  () => props.cameraId,
  (deviceId) => startPreview(deviceId),
);

watch(() => props.overlayUrl, resolveOverlaySrc);

watch(showOverlay, async () => {
  await nextTick();
  measureStage();
});

onMounted(async () => {
  try {
    isLinux.value = (await getPlatform()) === "linux";
  } catch {
    isLinux.value = false;
  }

  await resolveOverlaySrc();
  await refreshCameras();
  if (props.cameraId) {
    await startPreview(props.cameraId);
  }

  if (typeof ResizeObserver !== "undefined") {
    stageObserver = new ResizeObserver(measureStage);
    if (stageEl.value) stageObserver.observe(stageEl.value);
  }
  measureStage();
});

onBeforeUnmount(() => {
  ++latestRequestId;
  stageObserver?.disconnect();
  stageObserver = null;
  stopStream();
});
</script>

<template>
  <section class="panel webcam-panel">
    <header class="panel-header">
      <h2>Video Source</h2>
      <div class="controls">
        <span class="source-label">{{ modeLabel }}</span>

        <select :value="cameraId" @change="onCameraPicked($event.target.value)">
          <option value="">Select a camera…</option>
          <option v-for="camera in cameras" :key="camera.deviceId" :value="camera.deviceId">
            {{ camera.label }}
          </option>
        </select>

        <button type="button" @click="refreshCameras">Refresh</button>
        <button v-if="showOverlay" type="button" @click="reloadOverlay">Reload overlay</button>
        <button type="button" @click="goFullscreen">Fullscreen</button>
      </div>
    </header>

    <p v-if="isLinux" class="linux-note">
      On Linux, OBS Virtual Camera preview doesn't work due to a WebKitGTK bug (filed upstream).
      Physical cameras work normally.
    </p>

    <p v-if="effectiveMode === 'overlay' && overlayError" class="linux-note">
      {{ overlayError }}
    </p>
    <p
      v-else-if="effectiveMode === 'overlay' && !overlayUrl.trim()"
      class="linux-note"
    >
      No OBS Virtual Camera found. Set an overlay layout URL in settings to
      composite the stream layout over the capture card feed.
    </p>

    <div ref="stageEl" class="preview-wrapper" :class="{ composited: showOverlay }">
      <video ref="videoEl" muted playsinline autoplay class="preview cover" />

      <!-- pointer-events are off so the layout never swallows clicks meant for
           the app, and the iframe is keyed on a counter so "Reload overlay"
           picks up edits to the layout without restarting the app. -->
      <iframe
        v-if="showOverlay"
        :key="overlayReloadKey"
        ref="overlayFrameEl"
        class="overlay-frame"
        :src="overlaySrc"
        :style="overlayStyle"
        scrolling="no"
        title="Stream overlay layout"
      />

      <p v-if="loading" class="status">Loading cameras…</p>
      <p v-else-if="error" class="status error">{{ error }}</p>
      <p v-else-if="!cameraId" class="status">Select a camera to start preview.</p>
    </div>
  </section>
</template>

<style scoped>
.panel {
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  background: var(--panel-bg);
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--panel-border);
}

.panel-header h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
}

.linux-note {
  margin: 0;
  padding: 6px 12px;
  font-size: 12px;
  color: #a8761c;
  background: rgba(168, 118, 28, 0.12);
  border-bottom: 1px solid var(--panel-border);
}

.controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.controls select,
.controls button,
.source-label {
  font-size: 12px;
}

.source-label {
  color: var(--text-muted, #aaa);
}

.preview-wrapper {
  position: relative;
  min-height: 240px;
  display: grid;
  place-items: center;
  background: #111;
  overflow: hidden;
}

/* Pinning the stage to 16:9 is what makes the overlay line up: the capture
   card's picture fills it exactly, so scaling the layout to the stage's width
   puts every element where OBS would put it. */
.preview-wrapper.composited {
  aspect-ratio: 16 / 9;
  min-height: 0;
}

.overlay-frame {
  position: absolute;
  top: 0;
  left: 0;
  border: 0;
  transform-origin: top left;
  pointer-events: none;
  background: transparent;
}

.preview {
  width: 100%;
  height: 100%;
  min-height: 240px;
}

.preview.cover {
  object-fit: cover;
}

.status {
  position: absolute;
  margin: 0;
  padding: 6px 10px;
  border-radius: 6px;
  color: #fff;
  background: rgba(0, 0, 0, 0.6);
  font-size: 12px;
}

.status.error {
  background: rgba(146, 21, 21, 0.75);
}
</style>
