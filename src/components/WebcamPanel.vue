<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { listen } from "@tauri-apps/api/event";
import { listCaptureTargets, startWindowCapture, stopWindowCapture } from "../lib/api";

const props = defineProps({
  cameraId: {
    type: String,
    default: "",
  },
  mode: {
    type: String,
    default: "webcam",
  },
  captureWindowTitle: {
    type: String,
    default: "",
  },
});

const emit = defineEmits(["update:cameraId", "update:mode", "update:captureWindowTitle"]);

const cameras = ref([]);
const videoEl = ref(null);
const stream = ref(null);
const error = ref("");
const loading = ref(false);

const captureTargets = ref([]);
const selectedCaptureKey = ref("");
const capturedFrameUrl = ref("");
const captureImgEl = ref(null);
const captureActive = ref(false);
let unlistenCaptureFrame = null;

function targetKey(target) {
  return `${target.kind}:${target.id}`;
}

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

  try {
    await requestPermissionIfNeeded();
    const devices = await navigator.mediaDevices.enumerateDevices();
    cameras.value = devices
      .filter((device) => device.kind === "videoinput")
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `Camera ${index + 1}`,
      }));

    if (!props.cameraId && cameras.value.length > 0) {
      emit("update:cameraId", cameras.value[0].deviceId);
    }
  } catch (err) {
    error.value = `Failed to list cameras: ${err?.message || err}`;
  } finally {
    loading.value = false;
  }
}

async function startPreview(deviceId) {
  if (!navigator.mediaDevices?.getUserMedia) {
    error.value = "getUserMedia is not supported in this environment.";
    return;
  }

  if (!deviceId) {
    stopStream();
    return;
  }

  try {
    error.value = "";
    stopStream();

    const next = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: {
          exact: deviceId,
        },
      },
      audio: false,
    });

    stream.value = next;

    if (videoEl.value) {
      videoEl.value.srcObject = next;
      await videoEl.value.play();
    }
  } catch (err) {
    error.value = `Failed to start camera preview: ${err?.message || err}`;
  }
}

async function refreshCaptureTargets() {
  loading.value = true;
  error.value = "";

  try {
    const targets = await listCaptureTargets();
    captureTargets.value = targets;

    if (!selectedCaptureKey.value && props.captureWindowTitle) {
      const match = targets.find(
        (target) => target.kind === "window" && target.title === props.captureWindowTitle,
      );
      if (match) {
        selectedCaptureKey.value = targetKey(match);
        await beginCapture(match);
      }
    }
  } catch (err) {
    error.value = `Failed to list capture targets: ${err?.message || err}`;
  } finally {
    loading.value = false;
  }
}

async function beginCapture(target) {
  try {
    error.value = "";
    capturedFrameUrl.value = "";
    await startWindowCapture(target.id, target.kind);
    captureActive.value = true;
    if (target.kind === "window") {
      emit("update:captureWindowTitle", target.title);
    }
  } catch (err) {
    captureActive.value = false;
    error.value = `Failed to start capture: ${err?.message || err}`;
  }
}

async function endCapture() {
  captureActive.value = false;
  capturedFrameUrl.value = "";
  try {
    await stopWindowCapture();
  } catch {
    // best-effort; nothing the user can act on if this fails
  }
}

function onCaptureTargetChange(event) {
  selectedCaptureKey.value = event.target.value;
  const target = captureTargets.value.find((candidate) => targetKey(candidate) === selectedCaptureKey.value);
  if (target) {
    beginCapture(target);
  } else {
    endCapture();
  }
}

async function applyMode(mode) {
  if (mode === "window") {
    stopStream();
    await refreshCaptureTargets();
  } else {
    await endCapture();
    if (props.cameraId) {
      await startPreview(props.cameraId);
    }
  }
}

async function goFullscreen() {
  const el = props.mode === "window" ? captureImgEl.value : videoEl.value;
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
    if (props.mode === "webcam") {
      startPreview(deviceId);
    }
  },
);

watch(
  () => props.mode,
  (mode) => {
    applyMode(mode);
  },
);

onMounted(async () => {
  unlistenCaptureFrame = await listen("capture-frame", (event) => {
    capturedFrameUrl.value = event.payload.dataUrl;
  });

  if (props.mode === "window") {
    await refreshCaptureTargets();
  } else {
    await refreshCameras();
    if (props.cameraId) {
      await startPreview(props.cameraId);
    }
  }
});

onBeforeUnmount(() => {
  stopStream();
  if (captureActive.value) {
    stopWindowCapture().catch(() => {});
  }
  if (unlistenCaptureFrame) {
    unlistenCaptureFrame();
  }
});
</script>

<template>
  <section class="panel webcam-panel">
    <header class="panel-header">
      <h2>Video Source</h2>
      <div class="controls">
        <div class="mode-toggle">
          <button
            type="button"
            class="mode-btn"
            :class="{ active: mode === 'webcam' }"
            @click="emit('update:mode', 'webcam')"
          >
            Webcam
          </button>
          <button
            type="button"
            class="mode-btn"
            :class="{ active: mode === 'window' }"
            @click="emit('update:mode', 'window')"
          >
            Window Capture
          </button>
        </div>

        <select
          v-if="mode === 'webcam'"
          :value="cameraId"
          @change="emit('update:cameraId', $event.target.value)"
        >
          <option value="">Select a camera…</option>
          <option v-for="camera in cameras" :key="camera.deviceId" :value="camera.deviceId">
            {{ camera.label }}
          </option>
        </select>

        <select v-else :value="selectedCaptureKey" @change="onCaptureTargetChange">
          <option value="">Select a window…</option>
          <option v-for="target in captureTargets" :key="targetKey(target)" :value="targetKey(target)">
            {{ target.kind === "window" ? "Window" : "Display" }}: {{ target.title }}
          </option>
        </select>

        <button type="button" @click="mode === 'webcam' ? refreshCameras() : refreshCaptureTargets()">
          Refresh
        </button>
        <button type="button" @click="goFullscreen">Fullscreen</button>
      </div>
    </header>

    <div class="preview-wrapper">
      <video v-show="mode === 'webcam'" ref="videoEl" muted playsinline autoplay class="preview cover" />
      <img
        v-show="mode === 'window'"
        ref="captureImgEl"
        class="preview contain"
        :src="capturedFrameUrl || null"
        alt="Captured window preview"
      />

      <p v-if="loading" class="status">
        {{ mode === "webcam" ? "Loading cameras…" : "Loading windows…" }}
      </p>
      <p v-else-if="error" class="status error">{{ error }}</p>
      <p v-else-if="mode === 'webcam' && !cameraId" class="status">
        Select a camera to start preview.
      </p>
      <p v-else-if="mode === 'window' && !selectedCaptureKey" class="status">
        Select a window to capture (e.g. an OBS Projector).
      </p>
      <p v-else-if="mode === 'window' && captureActive && !capturedFrameUrl" class="status">
        Waiting for first frame…
      </p>
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

.mode-toggle {
  display: flex;
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  overflow: hidden;
}

.mode-btn {
  border: none;
  border-radius: 0;
  font-size: 12px;
  padding: 6px 10px;
  background: transparent;
}

.mode-btn.active {
  background: #2366d1;
  color: #fff;
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

.preview.contain {
  object-fit: contain;
  background: #000;
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
