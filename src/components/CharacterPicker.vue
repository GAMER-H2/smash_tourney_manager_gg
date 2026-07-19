<script setup>
import { computed, nextTick, onBeforeUnmount, reactive, ref } from "vue";
import { characterIconLabel, characterIconSrc } from "../lib/characters";

const props = defineProps({
  modelValue: {
    type: String,
    default: "",
  },
  characters: {
    type: Array,
    default: () => [],
  },
  label: {
    type: String,
    default: "Character",
  },
});

const emit = defineEmits(["update:modelValue"]);

const open = ref(false);
const triggerEl = ref(null);
const panelEl = ref(null);
const searchInputEl = ref(null);
const searchQuery = ref("");
const panelStyle = reactive({ top: "0px", left: "0px", maxHeight: "320px" });
const failedIcons = reactive({});

const entries = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  const filtered = query
    ? props.characters.filter((name) => name.toLowerCase().includes(query))
    : props.characters;

  const sorted = [...filtered].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );

  let lastLetter = "";
  return sorted.map((name) => {
    const letter = name.charAt(0).toUpperCase();
    const isNewLetter = letter !== lastLetter;
    lastLetter = letter;
    return { name, letter, isNewLetter };
  });
});

function onIconError(name) {
  failedIcons[name] = true;
}

function onSearchEnter() {
  if (entries.value.length === 1) {
    selectCharacter(entries.value[0].name);
  }
}

async function positionPanel() {
  await nextTick();
  const trigger = triggerEl.value;
  const panel = panelEl.value;
  if (!trigger || !panel) return;

  const triggerRect = trigger.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  const margin = 6;

  const spaceBelow = window.innerHeight - triggerRect.bottom;
  const spaceAbove = triggerRect.top;
  const openUpward = spaceBelow < panelRect.height + margin && spaceAbove > spaceBelow;

  panelStyle.maxHeight = `${Math.max(160, (openUpward ? spaceAbove : spaceBelow) - margin * 2)}px`;
  panelStyle.top = openUpward
    ? `${Math.max(margin, triggerRect.top - panelRect.height - margin)}px`
    : `${triggerRect.bottom + margin}px`;

  let left = triggerRect.left;
  const overflowRight = left + panelRect.width - (window.innerWidth - margin);
  if (overflowRight > 0) left -= overflowRight;
  left = Math.max(margin, left);
  panelStyle.left = `${left}px`;
}

function onDocumentPointerDown(event) {
  if (panelEl.value?.contains(event.target) || triggerEl.value?.contains(event.target)) {
    return;
  }
  closePicker();
}

function onDocumentKeydown(event) {
  if (event.key === "Escape") closePicker();
}

function onScrollOrResize(event) {
  // Scrolling inside the picker itself (the panel is its own scroll
  // container) shouldn't dismiss it - only scrolling of whatever is
  // behind/around it should, since the panel is position:fixed and would
  // otherwise drift away from its trigger button.
  if (event?.target && panelEl.value?.contains(event.target)) {
    return;
  }
  closePicker();
}

function togglePicker() {
  if (open.value) {
    closePicker();
  } else {
    openPicker();
  }
}

async function openPicker() {
  open.value = true;
  searchQuery.value = "";
  await positionPanel();
  searchInputEl.value?.focus();
  document.addEventListener("mousedown", onDocumentPointerDown, true);
  document.addEventListener("keydown", onDocumentKeydown, true);
  window.addEventListener("scroll", onScrollOrResize, true);
  window.addEventListener("resize", onScrollOrResize);
}

function closePicker() {
  if (!open.value) return;
  open.value = false;
  document.removeEventListener("mousedown", onDocumentPointerDown, true);
  document.removeEventListener("keydown", onDocumentKeydown, true);
  window.removeEventListener("scroll", onScrollOrResize, true);
  window.removeEventListener("resize", onScrollOrResize);
}

function selectCharacter(name) {
  emit("update:modelValue", name);
  closePicker();
}

onBeforeUnmount(() => {
  closePicker();
});
</script>

<template>
  <div class="character-picker">
    <button
      type="button"
      class="picker-trigger"
      ref="triggerEl"
      :title="label"
      @click="togglePicker"
    >
      <span v-if="modelValue" class="trigger-icon">
        <img
          v-if="characterIconSrc(modelValue) && !failedIcons[modelValue]"
          :src="characterIconSrc(modelValue)"
          :alt="modelValue"
          @error="onIconError(modelValue)"
        />
        <span v-else class="icon-fallback small">{{ characterIconLabel(modelValue) }}</span>
      </span>
      <span class="trigger-label">{{ modelValue || label }}</span>
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        class="picker-panel"
        ref="panelEl"
        :style="{ top: panelStyle.top, left: panelStyle.left, maxHeight: panelStyle.maxHeight }"
      >
        <div class="picker-search">
          <input
            ref="searchInputEl"
            v-model="searchQuery"
            type="text"
            placeholder="Search characters…"
            class="picker-search-input"
            @keydown.enter="onSearchEnter"
          />
        </div>

        <div v-if="!entries.length" class="picker-empty">No characters match.</div>
        <div v-else class="picker-grid">
          <template v-for="entry in entries" :key="entry.name">
            <div v-if="entry.isNewLetter" class="letter-divider">
              <span class="letter-badge">{{ entry.letter }}</span>
            </div>
            <button
              type="button"
              class="character-cell"
              :class="{ active: entry.name === modelValue }"
              @click="selectCharacter(entry.name)"
            >
              <span class="cell-icon">
                <img
                  v-if="characterIconSrc(entry.name) && !failedIcons[entry.name]"
                  :src="characterIconSrc(entry.name)"
                  :alt="entry.name"
                  loading="lazy"
                  @error="onIconError(entry.name)"
                />
                <span v-else class="icon-fallback">{{ characterIconLabel(entry.name) }}</span>
              </span>
              <span class="cell-name">{{ entry.name }}</span>
            </button>
          </template>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.character-picker {
  display: inline-flex;
}

.picker-trigger {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px 3px 3px;
  font-size: 11px;
  max-width: 120px;
}

.trigger-icon {
  width: 20px;
  height: 20px;
  border-radius: 5px;
  overflow: hidden;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.06);
}

.trigger-icon img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.trigger-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.icon-fallback {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  font-weight: 700;
  font-size: 11px;
  background: #2366d1;
  color: #fff;
}

.icon-fallback.small {
  font-size: 10px;
}

.picker-panel {
  position: fixed;
  width: 280px;
  overflow-y: auto;
  overscroll-behavior: contain;
  background: var(--panel-bg, #fff);
  border: 1px solid var(--panel-border, #d9d9de);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  padding: 8px;
  z-index: 1000;
}

.picker-search {
  position: sticky;
  top: -8px;
  margin: -8px -8px 8px;
  padding: 8px;
  background: var(--panel-bg, #fff);
  z-index: 1;
}

.picker-search-input {
  width: 100%;
  font-size: 12px;
  padding: 5px 8px;
}

.picker-empty {
  padding: 16px 4px;
  text-align: center;
  font-size: 12px;
  opacity: 0.7;
}

.picker-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
}

.letter-divider {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 4px 0 0;
}

.letter-divider:first-child {
  margin-top: 0;
}

.letter-badge {
  display: inline-grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #2c2f36;
  color: #fff;
  font-size: 9px;
  font-weight: 700;
  flex-shrink: 0;
}

.letter-divider::after {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--panel-border, #d9d9de);
}

.character-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 6px 2px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
}

.character-cell:hover {
  background: rgba(35, 102, 209, 0.1);
}

.character-cell.active {
  border-color: #2366d1;
  background: rgba(35, 102, 209, 0.14);
}

.cell-icon {
  width: 18px;
  height: 18px;
  border-radius: 4px;
  overflow: hidden;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.06);
}

.cell-icon img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.cell-icon .icon-fallback {
  font-size: 9px;
}

.cell-name {
  font-size: 10px;
  text-align: center;
  line-height: 1.15;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

@media (prefers-color-scheme: dark) {
  .trigger-icon,
  .cell-icon {
    background: rgba(255, 255, 255, 0.08);
  }
}
</style>
