<script setup>
import { computed } from "vue";
import { characterIconLabel, characterIconSrc } from "../lib/characters";

const props = defineProps({
  set: {
    type: Object,
    required: true,
  },
  locked: {
    type: Boolean,
    default: false,
  },
  drafted: {
    type: Boolean,
    default: false,
  },
  // { display, running } - the set's clock, when it has one.
  timer: {
    type: Object,
    default: null,
  },
  // { player1, player2 } - a score typed into an editor (the stream set, or
  // a locally-saved result) that start.gg doesn't have yet, in this set's own
  // slot order. Shown in place of start.gg's score until the set is reported.
  liveScore: {
    type: Object,
    default: null,
  },
  // Whether to offer the quick start/pause timer button on this card.
  showTimerButton: {
    type: Boolean,
    default: false,
  },
  // Connector drawing in BracketBoard measures the rendered card and slots.
  registerCard: {
    type: Function,
    default: null,
  },
  registerSlot: {
    type: Function,
    default: null,
  },
});

const emit = defineEmits(["quick-report", "set-on-stream", "toggle-timer"]);

const isReported = computed(() => Number(props.set.state) === 3);
const showLive = computed(() => Boolean(props.liveScore) && !isReported.value);

function slot(playerNum) {
  return playerNum === 1 ? props.set.player1 : props.set.player2;
}

function isWinnerSlot(playerNum) {
  const entrantId = slot(playerNum)?.entrantId;
  return Boolean(props.set.winnerId && entrantId && entrantId === props.set.winnerId);
}

// start.gg scores a disqualified entrant -1; show that as "DQ" rather than
// as a negative number nobody would read as a forfeit.
function scoreText(playerNum) {
  const value = showLive.value
    ? props.liveScore[playerNum === 1 ? "player1" : "player2"]
    : slot(playerNum)?.score;
  return Number(value) === -1 ? "DQ" : value;
}

// Character picks only mean anything once games have actually been played,
// so only show an icon for a reported (completed) set. Characters with no
// artwork (Random, or anything we don't recognize) still get a fallback
// badge rather than silently showing nothing.
function slotCharacter(playerNum) {
  if (!isReported.value || !props.set.winnerId) return null;
  const name = playerNum === 1 ? props.set.player1Character : props.set.player2Character;
  if (!name) return null;
  return { name, src: characterIconSrc(name), label: characterIconLabel(name) };
}

const cardTitle = computed(() => {
  if (props.drafted) return "Has a locally-saved result not yet submitted to start.gg";
  if (showLive.value) return "Score from the set editor - not yet submitted to start.gg";
  return "";
});

const timerButtonLabel = computed(() => {
  if (props.timer?.running) return "Pause this set's timer";
  if (props.timer) return "Resume this set's timer";
  return "Start this set (starts its timer and marks it in progress on start.gg)";
});

function onCard(event) {
  if (props.locked) return;
  emit(event, props.set);
}
</script>

<template>
  <div class="match-row">
    <span v-if="set.identifier" class="identifier-badge">{{ set.identifier }}</span>
    <span v-if="drafted" class="draft-badge" title="Saved locally, not submitted">●</span>
    <button
      v-if="showTimerButton"
      type="button"
      class="card-timer-btn"
      :class="{ running: timer?.running }"
      :title="timerButtonLabel"
      :aria-label="timerButtonLabel"
      @click.stop="emit('toggle-timer', set)"
    >
      {{ timer?.running ? "⏸" : "▶" }}
    </button>
    <article
      class="match-card"
      :class="{
        locked,
        drafted,
        live: showLive,
        'in-progress': timer?.running,
      }"
      :title="cardTitle"
      :ref="(el) => registerCard?.(set.id, el)"
      @click="onCard('quick-report')"
      @contextmenu.prevent="onCard('set-on-stream')"
    >
      <div
        v-for="playerNum in [1, 2]"
        :key="playerNum"
        class="slot-row"
        :class="{ winner: isWinnerSlot(playerNum), placeholder: slot(playerNum).placeholder }"
        :ref="(el) => registerSlot?.(set.id, playerNum, el)"
      >
        <span class="slot-main">
          <template v-if="slotCharacter(playerNum)">
            <img
              v-if="slotCharacter(playerNum).src"
              class="slot-char-icon"
              :src="slotCharacter(playerNum).src"
              :alt="slotCharacter(playerNum).name"
            />
            <span v-else class="slot-char-icon slot-char-fallback">{{ slotCharacter(playerNum).label }}</span>
          </template>
          <span class="slot-name">{{ slot(playerNum).placeholder || slot(playerNum).name }}</span>
        </span>
        <span
          v-if="!slot(playerNum).placeholder"
          class="slot-score"
          :class="{ live: showLive }"
        >{{ scoreText(playerNum) }}</span>
      </div>
      <div
        v-if="timer"
        class="match-timer"
        :class="{ running: timer.running }"
        :title="timer.running ? 'Set in progress' : 'Set started, timer paused'"
      >
        {{ timer.running ? "▶" : "⏸" }} {{ timer.display }}
      </div>
    </article>
  </div>
</template>

<style scoped>
.match-row {
  position: relative;
}

.match-card {
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  background: var(--panel-bg);
  cursor: pointer;
  position: relative;
  z-index: 1;
  overflow: hidden;
}

.match-card.locked {
  cursor: not-allowed;
  opacity: 0.55;
}

.match-card:hover {
  border-color: #2366d1;
}

.match-card.drafted {
  border-color: #d8a300;
}

.match-card.live {
  border-style: dashed;
}

.match-card.in-progress {
  border-color: #1a6b3c;
}

.identifier-badge {
  position: absolute;
  left: -10px;
  top: 50%;
  transform: translateY(-50%);
  background: #2c2f36;
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  padding: 4px 6px;
  border-radius: 999px;
  z-index: 2;
}

.draft-badge {
  color: #d8a300;
  font-size: 10px;
  line-height: 1;
}

.card-timer-btn {
  position: absolute;
  top: -8px;
  right: -8px;
  z-index: 2;
  width: 20px;
  height: 20px;
  padding: 0;
  border-radius: 999px;
  font-size: 9px;
  line-height: 1;
  display: grid;
  place-items: center;
}

.card-timer-btn:hover {
  border-color: #1a6b3c;
  color: #1a6b3c;
}

.card-timer-btn.running {
  background: #1a6b3c;
  border-color: #1a6b3c;
  color: #fff;
}

.slot-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  font-size: 13px;
  border-bottom: 1px solid var(--panel-border);
}

.slot-row + .slot-row {
  border-bottom: none;
}

.slot-row.placeholder {
  opacity: 0.6;
  font-style: italic;
}

.slot-main {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.slot-char-icon {
  width: 16px;
  height: 16px;
  border-radius: 3px;
  flex-shrink: 0;
  object-fit: cover;
}

.slot-char-fallback {
  display: grid;
  place-items: center;
  font-size: 9px;
  font-weight: 700;
  background: #2366d1;
  color: #fff;
}

.slot-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.slot-score {
  min-width: 20px;
  text-align: center;
  font-weight: 700;
  font-size: 12px;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.06);
}

.slot-score.live {
  font-style: italic;
  outline: 1px dashed #2366d1;
}

.slot-row.winner {
  background: rgba(35, 143, 79, 0.12);
}

.slot-row.winner .slot-name {
  font-weight: 700;
}

.slot-row.winner .slot-score {
  background: #238f4f;
  color: #fff;
}

.match-timer {
  padding: 2px 6px;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  border-top: 1px solid var(--panel-border);
  opacity: 0.75;
}

.match-timer.running {
  color: #1a6b3c;
  background: rgba(35, 143, 79, 0.12);
  opacity: 1;
}

@media (prefers-color-scheme: dark) {
  .slot-score {
    background: rgba(255, 255, 255, 0.12);
  }

  .match-timer.running {
    color: #6fd99a;
  }
}
</style>
