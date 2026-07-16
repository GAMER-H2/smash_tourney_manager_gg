<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = defineProps({
  cameraId: {
    type: String,
    default: "",
  },
});

const emit = defineEmits(["update:cameraId"]);

const cameras = ref([]);
const videoEl = ref(null);
const stream = ref(null);
const error = ref("");
const loading = ref(false);

function stopStream() {
  if (!stream.value) return;
  for (const track of stream.value.getTracks()) {
    track.stop();
  }
  stream.value = null;
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

  console.log("[webcam] refreshCameras start, current cameraId =", props.cameraId);

  try {
    // Only probe-and-immediately-close a throwaway stream when we don't
    // already know which camera to open. When we do (a persisted
    // selection), startPreview below grants permission itself; doing both
    // back-to-back closes and reopens the same physical device in quick
    // succession, which can transiently fail on some camera stacks and is
    // why the last-used camera used to need a manual reselect to appear.
    if (!props.cameraId) {
      await requestPermissionIfNeeded();
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    cameras.value = devices
      .filter((device) => device.kind === "videoinput")
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `Camera ${index + 1}`,
      }));

    console.log(
      "[webcam] enumerated",
      cameras.value.map((c) => c.deviceId),
    );

    if (!props.cameraId && cameras.value.length > 0) {
      console.log("[webcam] auto-selecting", cameras.value[0].deviceId);
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

// The very first capture pipeline built right after app launch can silently
// negotiate to a stalled state (no error, no frames) on some camera/driver
// combos; a stream restart reliably clears it, so detect the stall instead
// of leaving the preview blank until the user reselects the camera by hand.
// Polling decoded frame dimensions is used instead of the "loadeddata" event
// since that event doesn't fire reliably for live MediaStream video in every
// WebKit build.
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

    console.log(`[webcam] attempt ${attempt} opening`, deviceId);

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

      console.log(
        "[webcam] getUserMedia resolved",
        next.getVideoTracks().map((track) => track.getSettings()),
      );

      stream.value = next;

      console.log("[webcam] videoEl.value truthy?", !!videoEl.value);

      if (videoEl.value) {
        videoEl.value.srcObject = next;
        console.log("[webcam] srcObject assigned, calling play()");
        await videoEl.value.play();
        console.log("[webcam] play() resolved, readyState", videoEl.value.readyState);

        const gotFrame = await waitForFirstFrame(videoEl.value, 1500);
        console.log(
          "[webcam] waitForFirstFrame",
          gotFrame,
          videoEl.value.videoWidth,
          videoEl.value.videoHeight,
        );

        if (!gotFrame) {
          lastError = new Error("Camera opened but never produced a frame");
          continue;
        }
      }

      return;
    } catch (err) {
      console.error("[webcam] attempt failed", err?.name, err?.message);
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
  const el = videoEl.value;
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
  (deviceId) => {
    console.log("[webcam] watcher firing for", deviceId);
    startPreview(deviceId);
  },
);

onMounted(async () => {
  await refreshCameras();
  if (props.cameraId) {
    console.log("[webcam] onMounted follow-up calling startPreview for", props.cameraId);
    await startPreview(props.cameraId);
  }
});

onBeforeUnmount(() => {
  stopStream();
});
</script>

<template>
  <section class="panel webcam-panel">
    <header class="panel-header">
      <h2>Video Source</h2>
      <div class="controls">
        <select
          :value="cameraId"
          @change="
            console.log('[webcam] select change event fired, value =', $event.target.value);
            emit('update:cameraId', $event.target.value);
          "
        >
          <option value="">Select a camera…</option>
          <option v-for="camera in cameras" :key="camera.deviceId" :value="camera.deviceId">
            {{ camera.label }}
          </option>
        </select>

        <button type="button" @click="refreshCameras">Refresh</button>
        <button type="button" @click="goFullscreen">Fullscreen</button>
      </div>
    </header>

    <div class="preview-wrapper">
      <video ref="videoEl" muted playsinline autoplay class="preview cover" />

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

.controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.controls select,
.controls button {
  font-size: 12px;
}

.preview-wrapper {
  position: relative;
  min-height: 240px;
  display: grid;
  place-items: center;
  background: #111;
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
