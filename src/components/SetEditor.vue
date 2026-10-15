<script setup>
import { computed, ref, watch } from "vue";
import CharacterPicker from "./CharacterPicker.vue";
import { canReportGame, isDq, isSubmittable, normalizeBestOf, scoreFor } from "../lib/set-utils";
import { describeDraftAge } from "../lib/drafts";

const props = defineProps({
  title: {
    type: String,
    default: "Set Editor",
  },
  setData: {
    type: Object,
    default: null,
  },
  characters: {
    type: Array,
    default: () => [],
  },
  showClose: {
    type: Boolean,
    default: false,
  },
  showOverlayButton: {
    type: Boolean,
    default: true,
  },
  allowSwap: {
    type: Boolean,
    default: false,
  },
  submitting: {
    type: Boolean,
    default: false,
  },
  resetting: {
    type: Boolean,
    default: false,
  },
  writingOverlay: {
    type: Boolean,
    default: false,
  },
  // { display, running, startedOnStartgg, final } - the set timer for
  // whichever set is loaded here, owned by App so it keeps running while the
  // set moves between this editor and the bracket view. `startedOnStartgg`
  // means start.gg has the set in progress (its own clock is running);
  // `final` means the set is reported, so the clock is a duration rather
  // than a live timer.
  timer: {
    type: Object,
    default: null,
  },
  // { savedAt } when this set has a locally-saved result that was never
  // submitted to start.gg, so the editor can say so on reopen.
  draft: {
    type: Object,
    default: null,
  },
  // Best-of formats to offer, from settings.
  bestOfOptions: {
    type: Array,
    default: () => [3, 5],
  },
});

const emit = defineEmits([
  "close",
  "set-best-of",
  "set-player-name",
  "set-game-character",
  "toggle-game-winner",
  "toggle-dq",
  "swap-players",
  "swap-scores",
  "apply-overlay",
  "submit",
  "reset-result",
  "toggle-timer",
  "reset-timer",
]);

const gameCount = computed(() => normalizeBestOf(props.setData?.bestOf));

// The configured formats, plus whatever this set is already using (e.g. a
// best of 7 reported before the option was removed from settings) so the
// select never shows a blank.
const formatOptions = computed(() => {
  const options = new Set(props.bestOfOptions);
  if (props.setData?.bestOf) options.add(props.setData.bestOf);
  return [...options].sort((a, b) => a - b);
});

const p1Wins = computed(() => scoreFor(props.setData, 1));
const p2Wins = computed(() => scoreFor(props.setData, 2));

const gameIndices = computed(() =>
  Array.from({ length: gameCount.value }, (_, index) => index),
);

const canSubmit = computed(() => isSubmittable(props.setData));

const dqLabel = computed(() => {
  const dq = props.setData?.dq;
  if (!dq) return "";
  if (dq === "both") return "Double DQ - neither player advances.";
  const loser = dq === 1 ? props.setData.player1.name : props.setData.player2.name;
  const winner = dq === 1 ? props.setData.player2.name : props.setData.player1.name;
  return `${loser} DQ'd - ${winner} advances.`;
});

const draftNotice = computed(() =>
  props.draft
    ? `Saved locally ${describeDraftAge(props.draft.savedAt)} and not yet submitted - remember to submit to start.gg.`
    : "",
);

const timerStateLabel = computed(() => {
  if (!props.timer) return "";
  if (props.timer.final) return "Final";
  return props.timer.running ? "Running" : "Paused";
});

// Starting the timer is also what starts the set on start.gg, so the first
// press says so; resuming after a local pause doesn't start anything again.
const startButtonLabel = computed(() => {
  if (props.timer?.running) return "Pause";
  return props.timer?.startedOnStartgg ? "Resume" : "Start set";
});

const timerNote = computed(() => {
  if (!props.timer?.startedOnStartgg) return "";
  if (props.timer.final) return "";
  return props.timer.running
    ? "In progress on start.gg - submitting the result stops its clock there."
    : "Paused here only - start.gg still has this set in progress.";
});

// Resetting a set on start.gg undoes a result the TO already reported, so it
// takes a deliberate second click rather than firing straight off one.
const pendingReset = ref(false);

// Same for resetting a timer that started the set on start.gg: that un-starts
// it there, which anyone watching the bracket sees. A purely local timer
// (nothing started on start.gg) resets on the first click as before.
const pendingTimerReset = ref(false);

watch(
  () => props.setData?.setId,
  () => {
    pendingReset.value = false;
    pendingTimerReset.value = false;
  },
);

function requestTimerReset() {
  if (!props.timer?.startedOnStartgg || pendingTimerReset.value) {
    pendingTimerReset.value = false;
    emit("reset-timer");
    return;
  }
  pendingTimerReset.value = true;
}

function requestReset() {
  if (pendingReset.value) {
    pendingReset.value = false;
    emit("reset-result");
    return;
  }
  pendingReset.value = true;
}

const submitLabel = computed(() => {
  if (props.submitting) return props.setData?.completed ? "Resubmitting…" : "Submitting…";
  return props.setData?.completed ? "Resubmit to start.gg" : "Submit to start.gg";
});

function reportLocked(index) {
  return !props.setData?.games[index]?.winner && !canReportGame(props.setData, index);
}
</script>

<template>
  <section class="panel set-editor">
    <header class="panel-header">
      <div>
        <h2>{{ title }}</h2>
        <p v-if="setData?.roundText" class="sub">
          {{ setData.roundText }}
          <span v-if="setData?.eventName">• {{ setData.eventName }}</span>
        </p>
      </div>
      <button v-if="showClose" type="button" @click="emit('close')">Close</button>
    </header>

    <div v-if="!setData" class="empty-state">No set selected yet.</div>

    <div v-else class="editor-content">
      <p v-if="draftNotice" class="notice notice-draft">{{ draftNotice }}</p>
      <p v-if="setData.completed" class="notice notice-reported">
        Already reported on start.gg - change the score and resubmit to correct it.
      </p>

      <div v-if="timer" class="timer-block">
        <div class="timer-row" :class="{ running: timer.running }">
          <span class="timer-clock">{{ timer.display }}</span>
          <span class="timer-state">{{ timerStateLabel }}</span>
          <button
            v-if="!timer.final"
            type="button"
            class="timer-btn timer-start-btn"
            @click="emit('toggle-timer')"
          >
            {{ startButtonLabel }}
          </button>
          <button
            v-if="!timer.final"
            type="button"
            class="timer-btn"
            @click="requestTimerReset"
          >
            {{ pendingTimerReset ? "Confirm un-start?" : "Reset" }}
          </button>
        </div>
        <p v-if="timerNote" class="timer-note">{{ timerNote }}</p>
      </div>

      <div class="best-of-row">
        <span>Format:</span>
        <select
          :value="setData.bestOf"
          @change="emit('set-best-of', Number($event.target.value))"
        >
          <option v-for="option in formatOptions" :key="option" :value="option">
            Best of {{ option }}
          </option>
        </select>
        <span class="swap-group">
          <button
            type="button"
            class="swap-btn"
            title="Give each game (and any DQ) to the other player, keeping names and characters in place"
            @click="emit('swap-scores')"
          >
            ⇅ Swap Scores
          </button>
          <button
            v-if="allowSwap"
            type="button"
            class="swap-btn"
            title="Swap which side each player is on - their scores and characters move with them"
            @click="emit('swap-players')"
          >
            ⇄ Swap Players
          </button>
        </span>
      </div>

      <div class="player-grid">
        <div class="player-box" :class="{ dq: isDq(setData, 1) }">
          <label>Player 1</label>
          <input
            :value="setData.player1.name"
            @input="emit('set-player-name', { player: 1, value: $event.target.value })"
          />
          <div class="player-score-row">
            <p class="score">{{ isDq(setData, 1) ? "DQ" : p1Wins }}</p>
            <button
              type="button"
              class="dq-btn"
              :class="{ active: isDq(setData, 1) }"
              title="Report this player as disqualified"
              @click="emit('toggle-dq', 1)"
            >
              DQ
            </button>
          </div>
        </div>

        <div class="player-box" :class="{ dq: isDq(setData, 2) }">
          <label>Player 2</label>
          <input
            :value="setData.player2.name"
            @input="emit('set-player-name', { player: 2, value: $event.target.value })"
          />
          <div class="player-score-row">
            <p class="score">{{ isDq(setData, 2) ? "DQ" : p2Wins }}</p>
            <button
              type="button"
              class="dq-btn"
              :class="{ active: isDq(setData, 2) }"
              title="Report this player as disqualified"
              @click="emit('toggle-dq', 2)"
            >
              DQ
            </button>
          </div>
        </div>
      </div>

      <p v-if="dqLabel" class="notice notice-dq">{{ dqLabel }}</p>

      <div class="games-list">
        <div v-for="index in gameIndices" :key="index" class="game-row" :class="{ locked: reportLocked(index) }">
          <div class="game-controls">
            <button
              type="button"
              class="win-btn"
              :class="{ active: setData.games[index]?.winner === 1 }"
              :disabled="reportLocked(index)"
              @click="emit('toggle-game-winner', { index, winner: 1 })"
            >
              W
            </button>
            <span class="game-label">Game {{ index + 1 }}</span>
            <button
              type="button"
              class="win-btn"
              :class="{ active: setData.games[index]?.winner === 2 }"
              :disabled="reportLocked(index)"
              @click="emit('toggle-game-winner', { index, winner: 2 })"
            >
              W
            </button>
          </div>
          <div class="game-characters">
            <CharacterPicker
              :model-value="setData.games[index]?.player1Character"
              :characters="characters"
              label="P1 character"
              @update:model-value="(value) => emit('set-game-character', { index, player: 1, value })"
            />
            <CharacterPicker
              :model-value="setData.games[index]?.player2Character"
              :characters="characters"
              label="P2 character"
              @update:model-value="(value) => emit('set-game-character', { index, player: 2, value })"
            />
          </div>
        </div>
      </div>

      <div class="action-row">
        <button
          v-if="setData.completed"
          type="button"
          class="reset-btn"
          :disabled="resetting"
          title="Un-report this set on start.gg and clear its score"
          @click="requestReset"
        >
          {{ pendingReset ? "Confirm reset?" : "Reset result" }}
        </button>
        <span class="action-spacer"></span>
        <button
          v-if="showOverlayButton"
          type="button"
          :disabled="writingOverlay"
          @click="emit('apply-overlay')"
        >
          {{ writingOverlay ? "Writing overlay…" : "Apply to Overlay" }}
        </button>
        <button
          type="button"
          class="submit-btn"
          :disabled="submitting || !canSubmit"
          :title="canSubmit ? '' : 'Report a winner or a DQ first'"
          @click="emit('submit')"
        >
          {{ submitLabel }}
        </button>
      </div>
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

.sub {
  margin: 2px 0 0;
  font-size: 12px;
  opacity: 0.75;
}

.empty-state {
  padding: 24px;
  text-align: center;
  opacity: 0.8;
}

.editor-content {
  padding: 12px;
  display: grid;
  gap: 12px;
}

.notice {
  margin: 0;
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 12px;
  border: 1px solid var(--panel-border);
}

.notice-draft {
  border-color: #d8a300;
  background: rgba(216, 163, 0, 0.12);
}

.notice-reported {
  border-color: #2366d1;
  background: rgba(35, 102, 209, 0.12);
}

.notice-dq {
  border-color: #a11e1e;
  background: rgba(161, 30, 30, 0.12);
}

.timer-block {
  display: grid;
  gap: 4px;
}

.timer-note {
  margin: 0;
  font-size: 11px;
  opacity: 0.75;
}

.timer-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid var(--panel-border);
  border-radius: 6px;
}

.timer-clock {
  font-size: 24px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

.timer-row.running .timer-clock {
  color: #0e6b2f;
}

.timer-state {
  font-size: 12px;
  opacity: 0.75;
}

.timer-btn {
  font-size: 12px;
}

.timer-start-btn {
  margin-left: auto;
}

.best-of-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.swap-group {
  margin-left: auto;
  display: flex;
  gap: 6px;
}

.swap-btn {
  font-size: 12px;
}

.player-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.player-box {
  display: grid;
  gap: 6px;
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  padding: 8px;
}

.player-box.dq {
  border-color: #a11e1e;
}

.player-box label {
  font-size: 12px;
  font-weight: 600;
}

.player-score-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.score {
  margin: 0;
  font-size: 26px;
  font-weight: 800;
  line-height: 1;
}

.dq-btn {
  font-size: 12px;
  padding: 4px 10px;
}

.dq-btn.active {
  background: #a11e1e;
  border-color: #a11e1e;
  color: #fff;
}

.games-list {
  display: grid;
  gap: 10px;
}

.game-row {
  display: grid;
  gap: 6px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--panel-border);
}

.game-row:last-child {
  padding-bottom: 0;
  border-bottom: none;
}

.game-row.locked {
  opacity: 0.5;
}

.game-controls {
  display: grid;
  grid-template-columns: 56px 1fr 56px;
  align-items: center;
  gap: 8px;
}

.game-characters {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}

.game-label {
  text-align: center;
  font-size: 12px;
}

.win-btn {
  height: 34px;
  border-radius: 6px;
}

.win-btn.active {
  background: #2366d1;
  color: #fff;
  border-color: #2366d1;
}

.action-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.action-spacer {
  flex: 1;
}
</style>
