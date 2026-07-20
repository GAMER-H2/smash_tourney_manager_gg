<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { buildBracketLayout, buildRoundRobinGrid } from "../lib/bracket-utils";
import { characterIconLabel, characterIconSrc } from "../lib/characters";

const props = defineProps({
  tournamentData: {
    type: Object,
    default: null,
  },
  activeBucketId: {
    type: String,
    default: "",
  },
});

const emit = defineEmits(["update:activeBucketId", "set-on-stream", "quick-report"]);

const buckets = computed(() => props.tournamentData?.buckets ?? []);

const activeBucket = computed(() => {
  if (!buckets.value.length) return null;
  return (
    buckets.value.find((bucket) => bucket.id === props.activeBucketId) ||
    buckets.value[0]
  );
});

const layout = computed(() => buildBracketLayout(activeBucket.value?.sets ?? []));

const winnersColumns = computed(() => [...layout.value.winners, ...layout.value.grandFinal]);

const poolGrid = computed(() => buildRoundRobinGrid(activeBucket.value?.sets ?? []));

function isWinnerSlot(set, slot) {
  return Boolean(set.winnerId && slot?.entrantId && slot.entrantId === set.winnerId);
}

// Character picks only mean anything once games have actually been played,
// so only show an icon for a reported (completed) set. Characters with no
// artwork (Random, or anything we don't recognize) still get a fallback
// badge rather than silently showing nothing.
function slotCharacter(set, playerNum) {
  if (set.state !== 3 || !set.winnerId) return null;
  const name = playerNum === 1 ? set.player1Character : set.player2Character;
  if (!name) return null;
  return { name, src: characterIconSrc(name), label: characterIconLabel(name) };
}

// --- Connector line drawing ---
// Match cards register themselves so we can measure real rendered positions
// (rather than guessing coordinates) and draw SVG connectors between the
// matches that the start.gg API tells us actually feed into each other.
const canvasEl = ref(null);
const cardEls = new Map();
const slotEls = new Map();

function setCardRef(setId, el) {
  if (el) cardEls.set(setId, el);
  else cardEls.delete(setId);
}

function setSlotRef(setId, slotNumber, el) {
  const key = `${setId}:${slotNumber}`;
  if (el) slotEls.set(key, el);
  else slotEls.delete(key);
}

const connectors = reactive([]);

function recomputeConnectors() {
  const canvas = canvasEl.value;
  if (!canvas) {
    connectors.length = 0;
    return;
  }

  const canvasRect = canvas.getBoundingClientRect();
  const paths = [];

  for (const edge of layout.value.edges) {
    const fromCard = cardEls.get(edge.fromSetId);
    const toSlot = slotEls.get(`${edge.toSetId}:${edge.toSlot}`);
    if (!fromCard || !toSlot) continue;

    const fromRect = fromCard.getBoundingClientRect();
    const toRect = toSlot.getBoundingClientRect();

    const x1 = fromRect.right - canvasRect.left;
    const y1 = fromRect.top + fromRect.height / 2 - canvasRect.top;
    const x2 = toRect.left - canvasRect.left;
    const y2 = toRect.top + toRect.height / 2 - canvasRect.top;
    const midX = x1 + Math.max(16, (x2 - x1) / 2);

    paths.push({
      id: `${edge.fromSetId}-${edge.toSetId}-${edge.toSlot}`,
      d: `M ${x1} ${y1} H ${midX} V ${y2} H ${x2}`,
    });
  }

  connectors.length = 0;
  connectors.push(...paths);
}

let resizeObserver = null;
let rafHandle = null;

function scheduleRecompute() {
  if (rafHandle) cancelAnimationFrame(rafHandle);
  rafHandle = requestAnimationFrame(() => {
    rafHandle = null;
    recomputeConnectors();
  });
}

onMounted(() => {
  scheduleRecompute();
  window.addEventListener("resize", scheduleRecompute);

  if (typeof ResizeObserver !== "undefined" && canvasEl.value) {
    resizeObserver = new ResizeObserver(() => scheduleRecompute());
    resizeObserver.observe(canvasEl.value);
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", scheduleRecompute);
  if (resizeObserver) resizeObserver.disconnect();
  if (rafHandle) cancelAnimationFrame(rafHandle);
});

watch(
  () => layout.value,
  async () => {
    cardEls.clear();
    slotEls.clear();
    await nextTick();
    scheduleRecompute();
  },
);
</script>

<template>
  <section class="panel bracket-board">
    <header class="panel-header">
      <div>
        <h2>Tournament View</h2>
        <p class="sub">
          Left click = quick report • Right click = send set to stream editor
        </p>
      </div>
      <p class="summary" v-if="tournamentData">
        {{ tournamentData.tournamentName }} • {{ tournamentData.totalSets }} sets
      </p>
    </header>

    <div class="tabs" v-if="buckets.length">
      <button
        v-for="bucket in buckets"
        :key="bucket.id"
        type="button"
        class="tab"
        :class="{ active: bucket.id === activeBucket?.id }"
        @click="emit('update:activeBucketId', bucket.id)"
      >
        {{ bucket.name }}
      </button>
    </div>

    <div v-if="!activeBucket" class="empty-state">Load a tournament to view sets.</div>

    <div v-else-if="!activeBucket.sets.length" class="empty-state">
      No sets returned for this view.
    </div>

    <div v-else-if="layout.isBracket" class="bracket-scroll">
      <div class="bracket-canvas" ref="canvasEl">
        <div class="bracket-row">
          <div v-for="col in winnersColumns" :key="col.key" class="bracket-col">
            <h3>{{ col.label }}</h3>
            <div v-for="set in col.sets" :key="set.id" class="match-row">
              <span v-if="set.identifier" class="identifier-badge">{{ set.identifier }}</span>
              <article
                class="match-card"
                :ref="(el) => setCardRef(set.id, el)"
                @click="emit('quick-report', set)"
                @contextmenu.prevent="emit('set-on-stream', set)"
              >
                <div
                  class="slot-row"
                  :class="{ winner: isWinnerSlot(set, set.player1), placeholder: set.player1.placeholder }"
                  :ref="(el) => setSlotRef(set.id, 1, el)"
                >
                  <span class="slot-main">
                    <template v-if="slotCharacter(set, 1)">
                      <img
                        v-if="slotCharacter(set, 1).src"
                        class="slot-char-icon"
                        :src="slotCharacter(set, 1).src"
                        :alt="slotCharacter(set, 1).name"
                      />
                      <span v-else class="slot-char-icon slot-char-fallback">{{ slotCharacter(set, 1).label }}</span>
                    </template>
                    <span class="slot-name">{{ set.player1.placeholder || set.player1.name }}</span>
                  </span>
                  <span v-if="!set.player1.placeholder" class="slot-score">{{ set.player1.score }}</span>
                </div>
                <div
                  class="slot-row"
                  :class="{ winner: isWinnerSlot(set, set.player2), placeholder: set.player2.placeholder }"
                  :ref="(el) => setSlotRef(set.id, 2, el)"
                >
                  <span class="slot-main">
                    <template v-if="slotCharacter(set, 2)">
                      <img
                        v-if="slotCharacter(set, 2).src"
                        class="slot-char-icon"
                        :src="slotCharacter(set, 2).src"
                        :alt="slotCharacter(set, 2).name"
                      />
                      <span v-else class="slot-char-icon slot-char-fallback">{{ slotCharacter(set, 2).label }}</span>
                    </template>
                    <span class="slot-name">{{ set.player2.placeholder || set.player2.name }}</span>
                  </span>
                  <span v-if="!set.player2.placeholder" class="slot-score">{{ set.player2.score }}</span>
                </div>
              </article>
            </div>
          </div>
        </div>

        <div v-if="layout.losers.length" class="bracket-row losers-row">
          <div v-for="col in layout.losers" :key="col.key" class="bracket-col">
            <h3>{{ col.label }}</h3>
            <div v-for="set in col.sets" :key="set.id" class="match-row">
              <span v-if="set.identifier" class="identifier-badge">{{ set.identifier }}</span>
              <article
                class="match-card"
                :ref="(el) => setCardRef(set.id, el)"
                @click="emit('quick-report', set)"
                @contextmenu.prevent="emit('set-on-stream', set)"
              >
                <div
                  class="slot-row"
                  :class="{ winner: isWinnerSlot(set, set.player1), placeholder: set.player1.placeholder }"
                  :ref="(el) => setSlotRef(set.id, 1, el)"
                >
                  <span class="slot-main">
                    <template v-if="slotCharacter(set, 1)">
                      <img
                        v-if="slotCharacter(set, 1).src"
                        class="slot-char-icon"
                        :src="slotCharacter(set, 1).src"
                        :alt="slotCharacter(set, 1).name"
                      />
                      <span v-else class="slot-char-icon slot-char-fallback">{{ slotCharacter(set, 1).label }}</span>
                    </template>
                    <span class="slot-name">{{ set.player1.placeholder || set.player1.name }}</span>
                  </span>
                  <span v-if="!set.player1.placeholder" class="slot-score">{{ set.player1.score }}</span>
                </div>
                <div
                  class="slot-row"
                  :class="{ winner: isWinnerSlot(set, set.player2), placeholder: set.player2.placeholder }"
                  :ref="(el) => setSlotRef(set.id, 2, el)"
                >
                  <span class="slot-main">
                    <template v-if="slotCharacter(set, 2)">
                      <img
                        v-if="slotCharacter(set, 2).src"
                        class="slot-char-icon"
                        :src="slotCharacter(set, 2).src"
                        :alt="slotCharacter(set, 2).name"
                      />
                      <span v-else class="slot-char-icon slot-char-fallback">{{ slotCharacter(set, 2).label }}</span>
                    </template>
                    <span class="slot-name">{{ set.player2.placeholder || set.player2.name }}</span>
                  </span>
                  <span v-if="!set.player2.placeholder" class="slot-score">{{ set.player2.score }}</span>
                </div>
              </article>
            </div>
          </div>
        </div>

        <svg class="connector-svg">
          <path
            v-for="connector in connectors"
            :key="connector.id"
            :d="connector.d"
            fill="none"
          />
        </svg>
      </div>
    </div>

    <div v-else-if="!poolGrid.entrants.length" class="empty-state">
      No entrants found for this pool.
    </div>

    <div v-else class="pool-grid-scroll">
      <table class="pool-grid">
        <thead>
          <tr>
            <th class="corner-cell"></th>
            <th v-for="col in poolGrid.entrants" :key="col.id" class="col-header">
              {{ col.name }}
            </th>
            <th class="record-header"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in poolGrid.rows" :key="row.entrant.id">
            <th class="row-header">{{ row.entrant.name }}</th>
            <td
              v-for="(cell, index) in row.cells"
              :key="index"
              class="pool-cell"
              :class="{
                self: cell.kind === 'self',
                empty: cell.kind === 'empty',
                won: cell.kind === 'set' && cell.rowWon,
                lost: cell.kind === 'set' && cell.rowLost,
              }"
              @click="cell.kind === 'set' && emit('quick-report', cell.set)"
              @contextmenu.prevent="cell.kind === 'set' && emit('set-on-stream', cell.set)"
            >
              <span v-if="cell.kind === 'set'" class="pool-score">
                {{ cell.rowScore }} - {{ cell.colScore }}
              </span>
            </td>
            <td class="record-cell">
              <div class="set-record">{{ row.record.setWins }} - {{ row.record.setLosses }}</div>
              <div class="game-record">{{ row.record.gameWins }} - {{ row.record.gameLosses }}</div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.panel {
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  background: var(--panel-bg);
  min-width: 0;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
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

.summary {
  margin: 0;
  font-size: 12px;
  opacity: 0.85;
}

.tabs {
  display: flex;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--panel-border);
  overflow-x: auto;
}

.tab {
  white-space: nowrap;
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 12px;
}

.tab.active {
  background: #2366d1;
  border-color: #2366d1;
  color: #fff;
}

.empty-state {
  padding: 24px;
  text-align: center;
  opacity: 0.8;
}

/* --- Pool round-robin grid --- */
.pool-grid-scroll {
  overflow-x: auto;
  min-width: 0;
  padding: 16px;
}

.pool-grid {
  border-collapse: separate;
  border-spacing: 6px;
}

.corner-cell,
.record-header {
  border: none;
}

.col-header {
  min-width: 110px;
  max-width: 160px;
  padding: 4px 8px;
  font-size: 12px;
  font-weight: 700;
  text-align: left;
}

.row-header {
  padding: 4px 10px 4px 0;
  font-size: 12px;
  font-weight: 700;
  text-align: left;
  white-space: nowrap;
}

.pool-cell {
  min-width: 90px;
  height: 40px;
  padding: 0 6px;
  text-align: center;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.04);
}

.pool-cell.self {
  background: rgba(0, 0, 0, 0.08);
}

.pool-cell:not(.self):not(.empty) {
  cursor: pointer;
  border: 1px solid var(--panel-border);
}

.pool-cell.won {
  border-color: #238f4f;
  background: rgba(35, 143, 79, 0.12);
}

.pool-cell.lost {
  border-color: #a11e1e;
  background: rgba(161, 30, 30, 0.1);
}

.pool-score {
  font-size: 13px;
  font-weight: 700;
}

.pool-cell.won .pool-score {
  color: #238f4f;
}

.pool-cell.lost .pool-score {
  color: #a11e1e;
}

.record-cell {
  padding-left: 10px;
  text-align: left;
  white-space: nowrap;
}

.set-record {
  font-size: 13px;
  font-weight: 700;
}

.game-record {
  font-size: 11px;
  font-style: italic;
  opacity: 0.7;
}

@media (prefers-color-scheme: dark) {
  .pool-cell {
    background: rgba(255, 255, 255, 0.06);
  }

  .pool-cell.self {
    background: rgba(255, 255, 255, 0.1);
  }
}

/* --- Bracket tree view --- */
.bracket-scroll {
  overflow-x: auto;
  min-width: 0;
  padding: 16px;
}

.bracket-canvas {
  position: relative;
  width: max-content;
  min-width: 100%;
}

.bracket-row {
  display: flex;
  gap: 36px;
}

.losers-row {
  margin-top: 32px;
  padding-top: 20px;
  border-top: 1px dashed var(--panel-border);
}

.bracket-col {
  display: flex;
  flex-direction: column;
  justify-content: space-around;
  gap: 24px;
  min-width: 200px;
}

.bracket-col h3 {
  margin: 0 0 4px;
  font-size: 12px;
  font-weight: 700;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--panel-border);
}

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

.match-card:hover {
  border-color: #2366d1;
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

.slot-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  font-size: 13px;
  border-bottom: 1px solid var(--panel-border);
}

.slot-row:last-child {
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

.connector-svg {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  overflow: visible;
  z-index: 0;
}

.connector-svg path {
  stroke: var(--panel-border);
  stroke-width: 2;
}

@media (prefers-color-scheme: dark) {
  .slot-score {
    background: rgba(255, 255, 255, 0.12);
  }
}
</style>
