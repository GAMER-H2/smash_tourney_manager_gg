<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import MatchCard from "./MatchCard.vue";
import { buildBracketLayout, buildRoundRobinGrid } from "../lib/bracket-utils";

const props = defineProps({
  tournamentData: {
    type: Object,
    default: null,
  },
  activeBucketId: {
    type: String,
    default: "",
  },
  // Map<bucketId, { locked, attempts }> - buckets currently waiting on
  // start.gg to catch up after a report started them, per App.vue's
  // bucket-sync queue. Absent/no entry means "synced normally".
  bucketSyncState: {
    type: Object,
    default: () => new Map(),
  },
  // Set<setId> of sets holding a locally-saved result that hasn't been
  // submitted to start.gg yet, so they can be flagged on the bracket.
  draftedSetIds: {
    type: Object,
    default: () => new Set(),
  },
  // Map<setId, { display, running }> - live set clocks for sets that are
  // under way, so the board shows which matches are in progress and how long
  // they've been going, the way start.gg's own bracket does.
  setTimers: {
    type: Object,
    default: () => new Map(),
  },
  // Map<setId, { player1, player2 }> - scores entered in an editor (the
  // stream set, or a locally-saved result) that start.gg doesn't have yet,
  // in each set's own slot order, so the board never disagrees with what's
  // being played on stream.
  liveScores: {
    type: Object,
    default: () => new Map(),
  },
  // "grid" (round-robin table) or "list" (just the sets still to play).
  poolViewMode: {
    type: String,
    default: "grid",
  },
});

const emit = defineEmits([
  "update:activeBucketId",
  "set-on-stream",
  "quick-report",
  "toggle-timer",
]);

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

const activeBucketSync = computed(() =>
  activeBucket.value ? props.bucketSyncState.get(activeBucket.value.id) : null,
);

const activeBucketLocked = computed(() => Boolean(activeBucketSync.value?.locked));

// Pools (round-robin, not the elimination bracket) don't need a "finalize
// placements" reminder until every set in them has actually been reported.
// Checked against poolGrid's own cells - the exact same data the grid
// renders its won/lost coloring from - rather than the raw bucket.sets
// list, so this always agrees with what's actually showing on screen.
const activeBucketPoolComplete = computed(() => {
  if (!activeBucket.value || layout.value.isBracket) return false;
  const cells = poolGrid.value.rows
    .flatMap((row) => row.cells)
    .filter((cell) => cell.kind === "set");
  return cells.length > 0 && cells.every((cell) => cell.isComplete);
});

function onSetClick(set, event) {
  if (activeBucketLocked.value) return;
  emit(event, set);
}

function liveScore(set) {
  if (Number(set?.state) === 3) return null;
  return props.liveScores.get?.(String(set?.id)) ?? null;
}

// The quick start button is for sets that can actually be played right now:
// both players known, not already reported, and not in a bucket that's
// blocked waiting on start.gg.
function canToggleTimer(set) {
  if (activeBucketLocked.value) return false;
  if (Number(set?.state) === 3) return false;
  return Boolean(set?.player1?.entrantId && set?.player2?.entrantId);
}

// A pool cell's score from its row player's point of view, preferring an
// unsubmitted editor score over start.gg's (still empty) one.
function poolCellScores(row, cell) {
  const live = liveScore(cell.set);
  if (!live) return { row: cell.rowScore, col: cell.colScore, live: false };
  const rowIsPlayer1 = cell.set.player1?.entrantId === row.entrant.id;
  return {
    row: rowIsPlayer1 ? live.player1 : live.player2,
    col: rowIsPlayer1 ? live.player2 : live.player1,
    live: true,
  };
}

function scoreLabel(value) {
  return Number(value) === -1 ? "DQ" : value;
}

const isPoolList = computed(() => props.poolViewMode === "list");
const showCompletedPoolSets = ref(false);

function byIdentifier(a, b) {
  return (
    String(a.identifier ?? "").localeCompare(String(b.identifier ?? ""), undefined, { numeric: true }) ||
    String(a.id).localeCompare(String(b.id), undefined, { numeric: true })
  );
}

// The pool list view: every set still to be played (ones already under way
// first, since those are the ones someone's likely to need next), then - on
// request - the ones already reported.
const poolRemainingSets = computed(() =>
  (activeBucket.value?.sets ?? [])
    .filter((set) => Number(set.state) !== 3 && set.player1?.entrantId && set.player2?.entrantId)
    .sort((a, b) => Number(Boolean(setTimer(b))) - Number(Boolean(setTimer(a))) || byIdentifier(a, b)),
);

const poolCompletedSets = computed(() =>
  (activeBucket.value?.sets ?? []).filter((set) => Number(set.state) === 3).sort(byIdentifier),
);

function hasDraft(set) {
  return props.draftedSetIds.has?.(String(set?.id)) ?? false;
}

function setTimer(set) {
  return props.setTimers.get?.(String(set?.id)) ?? null;
}

const runningSetCount = computed(
  () => (activeBucket.value?.sets ?? []).filter((set) => setTimer(set)?.running).length,
);

const draftCount = computed(
  () =>
    (activeBucket.value?.sets ?? []).filter((set) => hasDraft(set)).length,
);

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
        <span v-if="runningSetCount" class="summary-live">
          • {{ runningSetCount }} in progress
        </span>
      </p>
    </header>

    <p v-if="activeBucketLocked" class="notice notice-locked">
      "{{ activeBucket.name }}" hasn't synced with start.gg yet after several attempts - refresh
      the tournament manually to continue reporting sets here.
    </p>
    <p v-else-if="activeBucketSync" class="notice notice-syncing">
      Waiting for start.gg to catch up on "{{ activeBucket.name }}" - reports made here are being
      saved locally and will sync automatically once it reloads.
    </p>
    <p v-if="draftCount" class="notice notice-draft">
      {{ draftCount }} set{{ draftCount === 1 ? "" : "s" }} here
      {{ draftCount === 1 ? "has" : "have" }} a locally-saved result that hasn't been submitted to
      start.gg yet - open {{ draftCount === 1 ? "it" : "them" }} and submit when ready.
    </p>
    <p v-else-if="activeBucketPoolComplete" class="notice notice-info">
      This pool is complete - remember to finalize placements on start.gg when convenient.
    </p>

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
            <MatchCard
              v-for="set in col.sets"
              :key="set.id"
              :set="set"
              :locked="activeBucketLocked"
              :drafted="hasDraft(set)"
              :timer="setTimer(set)"
              :live-score="liveScore(set)"
              :show-timer-button="canToggleTimer(set)"
              :register-card="setCardRef"
              :register-slot="setSlotRef"
              @quick-report="onSetClick($event, 'quick-report')"
              @set-on-stream="onSetClick($event, 'set-on-stream')"
              @toggle-timer="onSetClick($event, 'toggle-timer')"
            />
          </div>
        </div>

        <div v-if="layout.losers.length" class="bracket-row losers-row">
          <div v-for="col in layout.losers" :key="col.key" class="bracket-col">
            <h3>{{ col.label }}</h3>
            <MatchCard
              v-for="set in col.sets"
              :key="set.id"
              :set="set"
              :locked="activeBucketLocked"
              :drafted="hasDraft(set)"
              :timer="setTimer(set)"
              :live-score="liveScore(set)"
              :show-timer-button="canToggleTimer(set)"
              :register-card="setCardRef"
              :register-slot="setSlotRef"
              @quick-report="onSetClick($event, 'quick-report')"
              @set-on-stream="onSetClick($event, 'set-on-stream')"
              @toggle-timer="onSetClick($event, 'toggle-timer')"
            />
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

    <div v-else-if="isPoolList" class="pool-list">
      <p class="pool-list-summary">
        {{ poolRemainingSets.length }} set{{ poolRemainingSets.length === 1 ? "" : "s" }} left to play
        <template v-if="poolCompletedSets.length">
          • {{ poolCompletedSets.length }} done
          <button type="button" class="link-btn" @click="showCompletedPoolSets = !showCompletedPoolSets">
            {{ showCompletedPoolSets ? "Hide completed" : "Show completed" }}
          </button>
        </template>
      </p>
      <div v-if="poolRemainingSets.length" class="pool-list-row">
        <MatchCard
          v-for="set in poolRemainingSets"
          :key="set.id"
          class="pool-list-card"
          :set="set"
          :locked="activeBucketLocked"
          :drafted="hasDraft(set)"
          :timer="setTimer(set)"
          :live-score="liveScore(set)"
          :show-timer-button="canToggleTimer(set)"
          @quick-report="onSetClick($event, 'quick-report')"
          @set-on-stream="onSetClick($event, 'set-on-stream')"
          @toggle-timer="onSetClick($event, 'toggle-timer')"
        />
      </div>
      <div v-if="showCompletedPoolSets && poolCompletedSets.length" class="pool-list-row completed">
        <MatchCard
          v-for="set in poolCompletedSets"
          :key="set.id"
          class="pool-list-card"
          :set="set"
          :locked="activeBucketLocked"
          :drafted="hasDraft(set)"
          @quick-report="onSetClick($event, 'quick-report')"
          @set-on-stream="onSetClick($event, 'set-on-stream')"
        />
      </div>
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
                locked: cell.kind === 'set' && activeBucketLocked,
                drafted: cell.kind === 'set' && hasDraft(cell.set),
                'in-progress': cell.kind === 'set' && setTimer(cell.set)?.running,
                live: cell.kind === 'set' && poolCellScores(row, cell).live,
              }"
              @click="cell.kind === 'set' && onSetClick(cell.set, 'quick-report')"
              @contextmenu.prevent="cell.kind === 'set' && onSetClick(cell.set, 'set-on-stream')"
            >
              <button
                v-if="cell.kind === 'set' && canToggleTimer(cell.set)"
                type="button"
                class="pool-timer-btn"
                :class="{ running: setTimer(cell.set)?.running }"
                :title="setTimer(cell.set)?.running ? 'Pause this set’s timer' : 'Start this set’s timer'"
                @click.stop="onSetClick(cell.set, 'toggle-timer')"
                @contextmenu.stop.prevent
              >
                {{ setTimer(cell.set)?.running ? "⏸" : "▶" }}
              </button>
              <span v-if="cell.kind === 'set'" class="pool-score">
                {{ scoreLabel(poolCellScores(row, cell).row) }} -
                {{ scoreLabel(poolCellScores(row, cell).col) }}
              </span>
              <span
                v-if="cell.kind === 'set' && setTimer(cell.set)"
                class="pool-timer"
                :class="{ running: setTimer(cell.set).running }"
              >
                {{ setTimer(cell.set).running ? "▶" : "⏸" }} {{ setTimer(cell.set).display }}
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

.notice {
  margin: 0;
  padding: 8px 12px;
  font-size: 12px;
  border-bottom: 1px solid var(--panel-border);
}

.notice-info {
  color: #1a6b3c;
  background: rgba(35, 143, 79, 0.12);
}

.notice-syncing {
  color: #8a5a00;
  background: rgba(255, 179, 0, 0.15);
}

.notice-locked {
  color: #a11e1e;
  background: rgba(161, 30, 30, 0.12);
}

.notice-draft {
  color: #8a5a00;
  background: rgba(216, 163, 0, 0.15);
}

.pool-cell.drafted {
  outline: 1px solid #d8a300;
  outline-offset: -1px;
}

.pool-timer {
  display: block;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  opacity: 0.75;
}

.pool-timer.running {
  color: #1a6b3c;
  opacity: 1;
}

.pool-cell.in-progress {
  outline: 1px solid #1a6b3c;
  outline-offset: -1px;
}

.summary-live {
  color: #1a6b3c;
  font-weight: 600;
}

@media (prefers-color-scheme: dark) {
  .notice-info {
    color: #6fd99a;
  }
  .notice-syncing {
    color: #ffcc66;
  }
  .notice-locked {
    color: #ff8a8a;
  }
  .notice-draft {
    color: #ffcc66;
  }
  .pool-timer.running,
  .summary-live {
    color: #6fd99a;
  }
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

.pool-cell {
  position: relative;
}

.pool-cell.locked {
  cursor: not-allowed;
  opacity: 0.55;
}

.pool-cell.live .pool-score {
  font-style: italic;
}

.pool-timer-btn {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 16px;
  height: 16px;
  padding: 0;
  border-radius: 999px;
  font-size: 8px;
  line-height: 1;
  display: grid;
  place-items: center;
}

.pool-timer-btn.running {
  background: #1a6b3c;
  border-color: #1a6b3c;
  color: #fff;
}

/* --- Pool list view --- */
.pool-list {
  padding: 12px 16px 16px;
  display: grid;
  gap: 12px;
}

.pool-list-summary {
  margin: 0;
  font-size: 12px;
  opacity: 0.85;
}

.link-btn {
  border: none;
  background: none;
  padding: 0 4px;
  font-size: 12px;
  color: #2366d1;
  text-decoration: underline;
}

.pool-list-row {
  display: flex;
  flex-wrap: wrap;
  gap: 16px 20px;
  padding: 8px 10px;
}

.pool-list-row.completed {
  opacity: 0.7;
  border-top: 1px dashed var(--panel-border);
  padding-top: 16px;
}

.pool-list-card {
  width: 200px;
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

</style>
