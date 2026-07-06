<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = defineProps({
  modelValue: {
    type: String,
    default: "",
  },
});

const emit = defineEmits(["update:modelValue"]);

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

  try {
    await requestPermissionIfNeeded();
    const devices = await navigator.mediaDevices.enumerateDevices();
    cameras.value = devices
      .filter((device) => device.kind === "videoinput")
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `Camera ${index + 1}`,
      }));

    if (!props.modelValue && cameras.value.length > 0) {
      emit("update:modelValue", cameras.value[0].deviceId);
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

async function goFullscreen() {
  if (!videoEl.value) return;
  if (videoEl.value.requestFullscreen) {
    await videoEl.value.requestFullscreen();
  }
}

watch(
  () => props.modelValue,
  (deviceId) => {
    startPreview(deviceId);
  },
);

onMounted(async () => {
  await refreshCameras();
  if (props.modelValue) {
    await startPreview(props.modelValue);
  }
});

onBeforeUnmount(() => {
  stopStream();
});
</script>

<template>
  <section class="panel webcam-panel">
    <header class="panel-header">
      <h2>Webcam / OBS Virtual Cam</h2>
      <div class="controls">
        <select
          :value="modelValue"
          @change="emit('update:modelValue', $event.target.value)"
        >
          <option value="">Select a camera…</option>
          <option
            v-for="camera in cameras"
            :key="camera.deviceId"
            :value="camera.deviceId"
          >
            {{ camera.label }}
          </option>
        </select>
        <button type="button" @click="refreshCameras">Refresh</button>
        <button type="button" @click="goFullscreen">Fullscreen</button>
      </div>
    </header>

    <div class="preview-wrapper">
      <video ref="videoEl" muted playsinline autoplay class="preview" />
      <p v-if="loading" class="status">Loading cameras…</p>
      <p v-else-if="error" class="status error">{{ error }}</p>
      <p
        v-else-if="!modelValue"
        class="status"
      >
        Select a camera to start preview.
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
