<script setup>
import { computed } from "vue";

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

const groupedByRound = computed(() => {
  const sets = activeBucket.value?.sets ?? [];
  const map = new Map();

  for (const set of sets) {
    const key = set.roundText || "Other";
    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key).push(set);
  }

  return Array.from(map.entries()).map(([round, roundSets]) => ({
    round,
    sets: roundSets,
  }));
});

function stateLabel(state) {
  if (state === 3) return "Completed";
  if (state === 2) return "In Progress";
  if (state === 1) return "Ready";
  return "Pending";
}
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

    <div v-else class="round-lane">
      <div v-for="group in groupedByRound" :key="group.round" class="round-col">
        <h3>{{ group.round }}</h3>
        <article
          v-for="set in group.sets"
          :key="set.id"
          class="set-card"
          @click="emit('quick-report', set)"
          @contextmenu.prevent="emit('set-on-stream', set)"
        >
          <div class="set-head">
            <strong>#{{ set.id }}</strong>
            <span>{{ stateLabel(set.state) }}</span>
          </div>
          <p>{{ set.player1.name }} <strong>{{ set.player1.score }}</strong></p>
          <p>{{ set.player2.name }} <strong>{{ set.player2.score }}</strong></p>
        </article>
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

.round-lane {
  display: flex;
  gap: 12px;
  overflow-x: auto;
  padding: 12px;
  min-height: 250px;
}

.round-col {
  min-width: 240px;
}

.round-col h3 {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 700;
}

.set-card {
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  padding: 8px;
  margin-bottom: 8px;
  cursor: pointer;
}

.set-card:hover {
  border-color: #2366d1;
}

.set-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
  font-size: 12px;
}

.set-card p {
  display: flex;
  justify-content: space-between;
  margin: 0;
  font-size: 13px;
  line-height: 1.35;
}
</style>
