<script setup>
import { computed } from "vue";
import CharacterPicker from "./CharacterPicker.vue";

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
  submitting: {
    type: Boolean,
    default: false,
  },
  writingOverlay: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits([
  "close",
  "set-best-of",
  "set-player-name",
  "set-game-character",
  "toggle-game-winner",
  "apply-overlay",
  "submit",
]);

const gameCount = computed(() => (props.setData?.bestOf === 3 ? 3 : 5));

const p1Wins = computed(() => {
  if (!props.setData?.games) return 0;
  return props.setData.games.reduce(
    (acc, game) => acc + (game?.winner === 1 ? 1 : 0),
    0,
  );
});

const p2Wins = computed(() => {
  if (!props.setData?.games) return 0;
  return props.setData.games.reduce(
    (acc, game) => acc + (game?.winner === 2 ? 1 : 0),
    0,
  );
});

const gameIndices = computed(() =>
  Array.from({ length: gameCount.value }, (_, index) => index),
);
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
      <div class="best-of-row">
        <span>Format:</span>
        <select
          :value="setData.bestOf"
          @change="emit('set-best-of', Number($event.target.value))"
        >
          <option :value="3">Best of 3</option>
          <option :value="5">Best of 5</option>
        </select>
      </div>

      <div class="player-grid">
        <div class="player-box">
          <label>Player 1</label>
          <input
            :value="setData.player1.name"
            @input="emit('set-player-name', { player: 1, value: $event.target.value })"
          />
          <p class="score">{{ p1Wins }}</p>
        </div>

        <div class="player-box">
          <label>Player 2</label>
          <input
            :value="setData.player2.name"
            @input="emit('set-player-name', { player: 2, value: $event.target.value })"
          />
          <p class="score">{{ p2Wins }}</p>
        </div>
      </div>

      <div class="games-list">
        <div v-for="index in gameIndices" :key="index" class="game-row">
          <div class="game-controls">
            <button
              type="button"
              class="win-btn"
              :class="{ active: setData.games[index]?.winner === 1 }"
              @click="emit('toggle-game-winner', { index, winner: 1 })"
            >
              W
            </button>
            <span class="game-label">Game {{ index + 1 }}</span>
            <button
              type="button"
              class="win-btn"
              :class="{ active: setData.games[index]?.winner === 2 }"
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
          v-if="showOverlayButton"
          type="button"
          :disabled="writingOverlay"
          @click="emit('apply-overlay')"
        >
          {{ writingOverlay ? "Writing overlay…" : "Apply to Overlay" }}
        </button>
        <button type="button" :disabled="submitting" @click="emit('submit')">
          {{ submitting ? "Submitting…" : "Submit to start.gg" }}
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

.best-of-row {
  display: flex;
  align-items: center;
  gap: 8px;
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

.player-box label {
  font-size: 12px;
  font-weight: 600;
}

.score {
  margin: 0;
  font-size: 26px;
  font-weight: 800;
  line-height: 1;
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
  gap: 8px;
  justify-content: flex-end;
}
</style>
