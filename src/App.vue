<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import WebcamPanel from "./components/WebcamPanel.vue";
import SetEditor from "./components/SetEditor.vue";
import BracketBoard from "./components/BracketBoard.vue";
import {
  fetchTournamentState,
  loadConfig,
  reportSetResult,
  saveConfig,
  writeStreamOverlay,
} from "./lib/api";
import { SMASH_ULTIMATE_CHARACTERS } from "./lib/characters";
import {
  cloneEditorSet,
  createEditorSetFromTournamentSet,
  emptyEditorSet,
  winnerEntrantId,
  winsFor,
} from "./lib/set-utils";

const config = reactive({
  apiToken: "",
  tournamentSlug: "",
  streamOutputPath: "",
  preferredCameraId: "",
  perPage: 128,
  autoWriteOverlay: true,
});

const tournamentData = ref(null);
const activeBucketId = ref("all-sets");

const streamSet = ref(null);
const quickReportSet = ref(null);
const quickReportOpen = ref(false);

const loadingTournament = ref(false);
const submittingStream = ref(false);
const submittingQuickReport = ref(false);
const writingOverlay = ref(false);
const savingConfig = ref(false);

const statusMessage = ref("");
const errorMessage = ref("");

let overlayTimer = null;

function setSuccess(message) {
  errorMessage.value = "";
  statusMessage.value = message;
}

function setError(message) {
  statusMessage.value = "";
  errorMessage.value = message;
}

function updateEditorSet(targetRef, updater) {
  if (!targetRef.value) return;
  const next = cloneEditorSet(targetRef.value);
  updater(next);
  targetRef.value = next;
}

function applyBestOf(targetRef, value) {
  updateEditorSet(targetRef, (set) => {
    const bestOf = value === 3 ? 3 : 5;
    set.bestOf = bestOf;
    if (set.games.length > bestOf) {
      set.games = set.games.slice(0, bestOf);
      return;
    }
    while (set.games.length < bestOf) {
      set.games.push({ winner: null });
    }
  });
}

function applyPlayerName(targetRef, payload) {
  updateEditorSet(targetRef, (set) => {
    if (payload.player === 1) {
      set.player1.name = payload.value;
    } else {
      set.player2.name = payload.value;
    }
  });
}

function applyCharacter(targetRef, payload) {
  updateEditorSet(targetRef, (set) => {
    if (payload.player === 1) {
      set.player1.character = payload.value;
    } else {
      set.player2.character = payload.value;
    }
  });
}

function toggleWinner(targetRef, payload) {
  updateEditorSet(targetRef, (set) => {
    if (payload.index < 0 || payload.index >= set.games.length) return;
    const current = set.games[payload.index]?.winner;
    set.games[payload.index].winner = current === payload.winner ? null : payload.winner;
  });
}

function loadStreamSetFromTournamentSet(set) {
  streamSet.value = createEditorSetFromTournamentSet(set);
  setSuccess(`Set ${set.id} moved to stream editor.`);
}

function openQuickReport(set) {
  quickReportSet.value = createEditorSetFromTournamentSet(set);
  quickReportOpen.value = true;
}

function onStreamBestOf(value) {
  applyBestOf(streamSet, value);
}

function onStreamPlayerName(payload) {
  applyPlayerName(streamSet, payload);
}

function onStreamCharacter(payload) {
  applyCharacter(streamSet, payload);
}

function onStreamToggleWinner(payload) {
  toggleWinner(streamSet, payload);
}

function onQuickBestOf(value) {
  applyBestOf(quickReportSet, value);
}

function onQuickPlayerName(payload) {
  applyPlayerName(quickReportSet, payload);
}

function onQuickCharacter(payload) {
  applyCharacter(quickReportSet, payload);
}

function onQuickToggleWinner(payload) {
  toggleWinner(quickReportSet, payload);
}

function onStreamSubmit() {
  submitSet(streamSet.value, "stream");
}

function onQuickSubmit() {
  submitSet(quickReportSet.value, "quick");
}

function onBucketChange(value) {
  activeBucketId.value = value;
}

function closeQuickReport() {
  quickReportOpen.value = false;
  quickReportSet.value = null;
}

function overlayRequestFromEditorSet(editorSet) {
  if (!editorSet) return null;

  return {
    outputPath: config.streamOutputPath,
    tournamentName: tournamentData.value?.tournamentName || config.tournamentSlug,
    roundText: editorSet.roundText || "",
    eventName: editorSet.eventName || "",
    bestOf: editorSet.bestOf === 3 ? 3 : 5,
    player1: {
      name: editorSet.player1.name || "Player 1",
      character: editorSet.player1.character || null,
      score: winsFor(editorSet, 1),
    },
    player2: {
      name: editorSet.player2.name || "Player 2",
      character: editorSet.player2.character || null,
      score: winsFor(editorSet, 2),
    },
  };
}

async function writeOverlayFromStreamSet(silent = false) {
  if (!streamSet.value) return;
  if (!config.streamOutputPath.trim()) {
    if (!silent) setError("Set a stream output path first.");
    return;
  }

  const request = overlayRequestFromEditorSet(streamSet.value);

  writingOverlay.value = true;
  try {
    await writeStreamOverlay(request);
    if (!silent) {
      setSuccess(`Overlay data written to ${config.streamOutputPath}`);
    }
  } catch (err) {
    if (!silent) {
      setError(`Failed to write overlay: ${String(err)}`);
    }
  } finally {
    writingOverlay.value = false;
  }
}

function scheduleOverlayWrite() {
  if (!config.autoWriteOverlay) return;
  if (!streamSet.value) return;
  if (!config.streamOutputPath.trim()) return;

  if (overlayTimer) {
    clearTimeout(overlayTimer);
  }

  overlayTimer = setTimeout(() => {
    writeOverlayFromStreamSet(true);
  }, 350);
}

function requireStartggConfig() {
  if (!config.apiToken.trim()) {
    setError("Missing start.gg API token.");
    return false;
  }
  if (!config.tournamentSlug.trim()) {
    setError("Missing tournament slug.");
    return false;
  }
  return true;
}

async function refreshTournament() {
  if (!requireStartggConfig()) return;

  loadingTournament.value = true;
  try {
    const data = await fetchTournamentState({
      apiToken: config.apiToken,
      tournamentSlug: config.tournamentSlug,
      perPage: Number(config.perPage) || 128,
    });

    tournamentData.value = data;

    if (!data.buckets?.find((bucket) => bucket.id === activeBucketId.value)) {
      activeBucketId.value = data.buckets?.[0]?.id || "all-sets";
    }

    if (streamSet.value?.setId) {
      const allSets = data.buckets?.[0]?.sets || [];
      const matching = allSets.find((set) => set.id === streamSet.value.setId);
      if (matching) {
        const updated = createEditorSetFromTournamentSet(matching);
        updated.player1.character = streamSet.value.player1.character;
        updated.player2.character = streamSet.value.player2.character;
        streamSet.value = updated;
      }
    }

    setSuccess(`Loaded ${data.totalSets} sets from ${data.tournamentName}.`);
  } catch (err) {
    setError(`Failed to fetch tournament: ${String(err)}`);
  } finally {
    loadingTournament.value = false;
  }
}

async function persistConfig() {
  savingConfig.value = true;
  try {
    await saveConfig({
      apiToken: config.apiToken,
      tournamentSlug: config.tournamentSlug,
      streamOutputPath: config.streamOutputPath,
      preferredCameraId: config.preferredCameraId || null,
      perPage: Number(config.perPage) || 128,
      autoWriteOverlay: config.autoWriteOverlay,
    });
    setSuccess("Settings saved.");
  } catch (err) {
    setError(`Failed to save settings: ${String(err)}`);
  } finally {
    savingConfig.value = false;
  }
}

async function submitSet(editorSet, mode) {
  const winnerId = winnerEntrantId(editorSet);

  if (!editorSet?.setId) {
    setError("This set has no start.gg set ID.");
    return;
  }

  if (!winnerId) {
    setError("Set a winner first (more game wins than the opponent).");
    return;
  }

  if (!config.apiToken.trim()) {
    setError("Missing start.gg API token.");
    return;
  }

  if (mode === "stream") {
    submittingStream.value = true;
  } else {
    submittingQuickReport.value = true;
  }

  try {
    await reportSetResult({
      apiToken: config.apiToken,
      setId: editorSet.setId,
      winnerId,
    });

    setSuccess(`Reported set ${editorSet.setId} to start.gg.`);

    if (mode === "stream") {
      await writeOverlayFromStreamSet(true);
    }

    await refreshTournament();

    if (mode === "quick") {
      closeQuickReport();
    }
  } catch (err) {
    setError(`Failed to report set: ${String(err)}`);
  } finally {
    if (mode === "stream") {
      submittingStream.value = false;
    } else {
      submittingQuickReport.value = false;
    }
  }
}

watch(streamSet, scheduleOverlayWrite, { deep: true });
watch(
  () => config.streamOutputPath,
  () => scheduleOverlayWrite(),
);
watch(
  () => config.autoWriteOverlay,
  () => scheduleOverlayWrite(),
);

onMounted(async () => {
  try {
    const loaded = await loadConfig();
    config.apiToken = loaded.apiToken || "";
    config.tournamentSlug = loaded.tournamentSlug || "";
    config.streamOutputPath = loaded.streamOutputPath || "";
    config.preferredCameraId = loaded.preferredCameraId || "";
    config.perPage = loaded.perPage || 128;
    config.autoWriteOverlay = loaded.autoWriteOverlay ?? true;

    if (config.apiToken && config.tournamentSlug) {
      await refreshTournament();
    }
  } catch (err) {
    setError(`Could not load saved settings: ${String(err)}`);
  }

  if (!streamSet.value) {
    streamSet.value = emptyEditorSet();
  }
});

onBeforeUnmount(() => {
  if (overlayTimer) {
    clearTimeout(overlayTimer);
  }
});

const showStatus = computed(() => Boolean(statusMessage.value));
const showError = computed(() => Boolean(errorMessage.value));
</script>

<template>
  <main class="app">
    <section class="config-panel">
      <h1>Tournament Stream Manager (start.gg + Tauri)</h1>
      <div class="config-grid">
        <label>
          start.gg API token
          <input v-model="config.apiToken" type="password" placeholder="Bearer token" />
        </label>

        <label>
          Tournament or event slug
          <input
            v-model="config.tournamentSlug"
            type="text"
            placeholder="tournament/your-tourney/event/ultimate-singles"
          />
        </label>

        <label>
          Stream output JSON path
          <input
            v-model="config.streamOutputPath"
            type="text"
            placeholder="/path/to/TSH/program_state.json"
          />
        </label>

        <label>
          Sets per event fetch
          <input v-model.number="config.perPage" type="number" min="10" max="500" />
        </label>

        <label class="checkbox-field">
          <input v-model="config.autoWriteOverlay" type="checkbox" />
          Auto-write overlay on stream set changes
        </label>
      </div>

      <div class="top-actions">
        <button type="button" :disabled="savingConfig" @click="persistConfig">
          {{ savingConfig ? "Saving…" : "Save Settings" }}
        </button>
        <button type="button" :disabled="loadingTournament" @click="refreshTournament">
          {{ loadingTournament ? "Loading…" : "Refresh Tournament" }}
        </button>
      </div>

      <p v-if="showStatus" class="message success">{{ statusMessage }}</p>
      <p v-if="showError" class="message error">{{ errorMessage }}</p>
    </section>

    <section class="top-grid">
      <WebcamPanel v-model="config.preferredCameraId" />

      <SetEditor
        title="On Stream Set"
        :set-data="streamSet"
        :characters="SMASH_ULTIMATE_CHARACTERS"
        :submitting="submittingStream"
        :writing-overlay="writingOverlay"
        @set-best-of="onStreamBestOf"
        @set-player-name="onStreamPlayerName"
        @set-character="onStreamCharacter"
        @toggle-game-winner="onStreamToggleWinner"
        @apply-overlay="writeOverlayFromStreamSet(false)"
        @submit="onStreamSubmit"
      />
    </section>

    <BracketBoard
      :tournament-data="tournamentData"
      :active-bucket-id="activeBucketId"
      @update:activeBucketId="onBucketChange"
      @set-on-stream="loadStreamSetFromTournamentSet"
      @quick-report="openQuickReport"
    />

    <div v-if="quickReportOpen" class="modal-backdrop" @click.self="closeQuickReport">
      <div class="modal-card">
        <SetEditor
          title="Quick Report"
          :set-data="quickReportSet"
          :characters="SMASH_ULTIMATE_CHARACTERS"
          :submitting="submittingQuickReport"
          :show-overlay-button="false"
          :show-close="true"
          @close="closeQuickReport"
          @set-best-of="onQuickBestOf"
          @set-player-name="onQuickPlayerName"
          @set-character="onQuickCharacter"
          @toggle-game-winner="onQuickToggleWinner"
          @submit="onQuickSubmit"
        />
      </div>
    </div>
  </main>
</template>

<style>
:root {
  --panel-bg: #ffffff;
  --panel-border: #d9d9de;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
  background: #f4f5f8;
  color: #1a1a1a;
}

button,
input,
select {
  font: inherit;
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  padding: 6px 10px;
  background: #fff;
}

button {
  cursor: pointer;
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.7;
}

.app {
  display: grid;
  gap: 12px;
  padding: 12px;
  min-height: 100vh;
}

.config-panel {
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  background: var(--panel-bg);
  padding: 12px;
}

.config-panel h1 {
  margin: 0 0 10px;
  font-size: 18px;
}

.config-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(220px, 1fr));
  gap: 8px;
}

.config-grid label {
  display: grid;
  gap: 4px;
  font-size: 12px;
  font-weight: 600;
}

.config-grid label input {
  font-size: 13px;
}

.checkbox-field {
  display: flex;
  align-items: center;
  gap: 8px;
}

.top-actions {
  margin-top: 10px;
  display: flex;
  gap: 8px;
}

.message {
  margin: 10px 0 0;
  font-size: 13px;
}

.message.success {
  color: #0e6b2f;
}

.message.error {
  color: #a11e1e;
}

.top-grid {
  display: grid;
  gap: 12px;
  grid-template-columns: 1.1fr 1fr;
}

.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: grid;
  place-items: center;
  z-index: 20;
}

.modal-card {
  width: min(860px, calc(100vw - 24px));
  max-height: calc(100vh - 24px);
  overflow: auto;
}

@media (max-width: 1080px) {
  .top-grid,
  .config-grid {
    grid-template-columns: 1fr;
  }
}

@media (prefers-color-scheme: dark) {
  :root {
    --panel-bg: #1f2025;
    --panel-border: #373a43;
  }

  body {
    background: #111318;
    color: #ededf0;
  }

  button,
  input,
  select {
    background: #16181e;
    color: #ededf0;
  }

  .message.success {
    color: #67d58e;
  }

  .message.error {
    color: #ff8d8d;
  }
}
</style>
