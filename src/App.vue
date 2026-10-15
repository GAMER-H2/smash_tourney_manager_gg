<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import WebcamPanel from "./components/WebcamPanel.vue";
import SetEditor from "./components/SetEditor.vue";
import BracketBoard from "./components/BracketBoard.vue";
import { collapseByeSets } from "./lib/bracket-utils";
import {
  fetchEntrantAvatars,
  fetchGameCharacters,
  fetchTournamentState,
  loadConfig,
  loadLocalResults,
  markSetInProgress,
  reportSetResult,
  resetSetResult,
  saveConfig,
  saveLocalResults,
  updateSetResult,
  writeStreamOverlay,
} from "./lib/api";
import {
  canonicalCharacterName,
  characterIconFile,
  RANDOM_CHARACTER,
  SMASH_ULTIMATE_CHARACTERS,
} from "./lib/characters";
import {
  canReportGame,
  clearResults,
  cloneEditorSet,
  createEditorSetFromTournamentSet,
  currentGameCharacter,
  DEFAULT_BEST_OF_OPTIONS,
  DEFAULT_BRACKET_BEST_OF,
  DEFAULT_POOL_BEST_OF,
  emptyEditorSet,
  hasResult,
  isSubmittable,
  normalizeBestOf,
  normalizeBestOfOptions,
  orientLike,
  scoreFor,
  slotScoresFor,
  swapScores,
  swapSides,
  toggleDq,
  winnerEntrantId,
  withBestOf,
} from "./lib/set-utils";
import {
  draftSetIds,
  emptyDraftStore,
  getDraft,
  normalizeDraftStore,
  putDraft,
  removeDraft,
} from "./lib/drafts";
import {
  createTimerState,
  elapsedMs,
  frozenTimer,
  isRunning,
  pauseTimer,
  resetTimer,
  startTimer,
  timerDisplay,
  timerFromServerStart,
  timerOverlayPayload,
} from "./lib/timer";

const config = reactive({
  apiToken: "",
  tournamentSlug: "",
  streamOutputPath: "",
  preferredCameraId: "",
  previewSourceMode: "auto",
  overlayLayoutUrl: "",
  perPage: 128,
  autoWriteOverlay: true,
  poolViewMode: "grid",
  poolBestOf: DEFAULT_POOL_BEST_OF,
  bracketBestOf: DEFAULT_BRACKET_BEST_OF,
  bestOfOptions: [...DEFAULT_BEST_OF_OPTIONS],
});

// The best-of options as typed into settings ("3, 5, 7"), parsed into
// config.bestOfOptions once the field is left.
const bestOfOptionsText = ref(DEFAULT_BEST_OF_OPTIONS.join(", "));

function applyBestOfOptionsText() {
  config.bestOfOptions = normalizeBestOfOptions(bestOfOptionsText.value);
  bestOfOptionsText.value = config.bestOfOptions.join(", ");
}

const bestOfDefaults = computed(() => ({
  poolBestOf: config.poolBestOf,
  bracketBestOf: config.bracketBestOf,
}));

const tournamentData = ref(null);
const activeBucketId = ref("");
const configPanelOpen = ref(true);
const configLoaded = ref(false);

const streamSet = ref(null);
const quickReportSet = ref(null);
const quickReportOpen = ref(false);

const loadingTournament = ref(false);
const submittingStream = ref(false);
const submittingQuickReport = ref(false);
const resettingStream = ref(false);
const resettingQuickReport = ref(false);
const writingOverlay = ref(false);
const savingConfig = ref(false);

const statusMessage = ref("");
const errorMessage = ref("");

// Character name -> start.gg characterId for the tournament's videogame, so
// game reports can include per-game character selections. Refetched only
// when the loaded tournament's videogame changes.
const characterIdByName = ref(new Map());
let loadedVideogameId = null;

// Profile picture URLs for whoever's currently loaded into the stream set
// editor - only ever needed for the overlay output, not shown in this app's
// own UI, so this is deliberately not part of the editor set model itself.
const streamAvatars = ref({ player1Avatar: null, player2Avatar: null });

// start.gg's API caches event/set data server-side for up to ~60s (visible
// as `cacheControl.maxAge: 60` in its own responses). Reporting the first
// set in a pool/bracket starts it on start.gg's side instantly, but that
// cache can make our very next fetch come back as if the pool/bracket
// doesn't exist at all for a while after. bucketSync tracks any bucket
// caught in that gap: bucketId -> { snapshot, queue, attempts, locked }.
//   snapshot: last-known bucket (plus any optimistic local reports), kept
//             displayed in place of the "missing" bucket so nothing
//             disappears out from under the user.
//   queue:    further reports made against this bucket while it's still
//             missing - held back rather than sent immediately, since we
//             don't yet know the real (post-restart) set ids to send them
//             against, and replayed once the bucket reappears.
//   attempts: retries so far (one every 10s, giving up at 90s).
//   locked:   true once retries are exhausted - reporting into this bucket
//             is blocked until a manual refresh brings it back.
const bucketSync = reactive(new Map());

// Results scored in an editor but never submitted to start.gg, persisted to
// disk by set id (see lib/drafts.js). Held here so the bracket view can flag
// which sets are carrying one, and so reopening such a set restores it.
const draftStore = ref(emptyDraftStore());

// Set timers, keyed by start.gg set id so a timer keeps running while its
// set moves between the stream editor, the quick-report modal and the
// bracket - plus one fixed key for the blank/manual stream set, which has no
// set id of its own. Only the derived `timerNow` ticks; the timers
// themselves are wall-clock anchored (see lib/timer.js).
const STREAM_TIMER_KEY = "__stream__";
const timers = reactive(new Map());
const timerNow = ref(Date.now());

let overlayTimer = null;
let bucketSyncRetryTimer = null;
let timerTickHandle = null;
let lastOverlayTimerSecond = null;

function setSuccess(message) {
  errorMessage.value = "";
  statusMessage.value = message;
}

function setError(message) {
  statusMessage.value = "";
  errorMessage.value = message;
}

function findBucketIdForSetId(buckets, setId) {
  return buckets?.find((bucket) => bucket.sets.some((set) => set.id === setId))?.id ?? null;
}

function cloneBucket(bucket) {
  return JSON.parse(JSON.stringify(bucket));
}

function matchesEntrantPair(set, entrantIdA, entrantIdB) {
  const a = set.player1?.entrantId;
  const b = set.player2?.entrantId;
  return (a === entrantIdA && b === entrantIdB) || (a === entrantIdB && b === entrantIdA);
}

// Marks a set within a (possibly stale, locally-held) bucket snapshot as
// reported, so the bracket view reflects it immediately rather than
// waiting on start.gg to confirm it - including advancing the winner (and
// loser, for a drop to losers bracket) into whatever slot sources from this
// set, so the bracket shows progression instead of "TBD" while we wait.
// Safe to guess at: if start.gg's real data disagrees once it comes back,
// that overwrites this regardless.
function applyOptimisticResult(bucket, setId, editorSet, winnerEntrantId) {
  const target = bucket?.sets.find((set) => String(set.id) === String(setId));
  if (!target) return;

  const winnerSlot = target.player1?.entrantId === winnerEntrantId ? target.player1 : target.player2;
  const loserSlot = target.player1?.entrantId === winnerEntrantId ? target.player2 : target.player1;

  // The editor may have its players the other way round from the bracket
  // (swapped on stream), so line its scores up with the bracket's slots.
  const oriented = orientLike(editorSet, target);

  target.state = 3;
  target.winnerId = winnerEntrantId ?? null;
  if (target.player1) target.player1.score = scoreFor(oriented, 1);
  if (target.player2) target.player2.score = scoreFor(oriented, 2);
  target.player1Character = currentGameCharacter(oriented, 1) || null;
  target.player2Character = currentGameCharacter(oriented, 2) || null;
  // Per-game results too, since that's what reopening the set reads back.
  target.games = oriented.dq
    ? []
    : oriented.games
        .map((game, index) => ({
          gameNum: index + 1,
          winnerEntrantId:
            game.winner === 1
              ? target.player1?.entrantId
              : game.winner === 2
                ? target.player2?.entrantId
                : null,
          player1Character: game.player1Character || null,
          player2Character: game.player2Character || null,
        }))
        .filter((game) => game.winnerEntrantId);

  // A double DQ completes the set without advancing anyone, so there's
  // nothing to route into the sets downstream of it.
  if (!winnerEntrantId) return;

  for (const nextSet of bucket.sets) {
    for (const slot of [nextSet.player1, nextSet.player2]) {
      if (slot?.sourceType !== "set" || slot?.sourceSetId !== setId) continue;
      const advancing = slot.sourcePlacement === 2 ? loserSlot : winnerSlot;
      if (!advancing?.entrantId) continue;
      slot.entrantId = advancing.entrantId;
      slot.name = advancing.name;
    }
  }
}

// Sends every queued report for a bucket that's just reappeared, matching
// each one to its real set by entrant pair (set ids change once a
// preview-format pool/bracket actually starts, but who's playing whom
// doesn't). Anything start.gg already has a result for wins over our queued
// guess, and anything we can't match is just dropped rather than guessed at.
async function drainBucketSyncQueue(state, freshBucket) {
  for (const item of state.queue) {
    const target = freshBucket.sets.find((set) =>
      matchesEntrantPair(set, item.player1EntrantId, item.player2EntrantId),
    );
    if (!target || target.winnerId) continue;

    try {
      await reportSetResult({
        apiToken: config.apiToken,
        setId: target.id,
        winnerId: item.winnerEntrantId,
        gameData: item.gameData,
        isDq: Boolean(item.isDq),
      });
    } catch (err) {
      console.error("Failed to replay a queued report", err);
    }
  }
}

// Registers a just-vanished bucket as pending and reinjects its snapshot
// immediately - callers must do this *before* resolving the active tab
// (see finishTournamentRefresh), or the tab fallback runs against a bucket
// list that still looks like it's missing and jumps away right as this
// reinjects it.
function registerPendingBucket(bucketId, snapshot) {
  bucketSync.set(bucketId, { snapshot, queue: [], attempts: 0, locked: false });
  reinjectPendingSnapshots();
  scheduleBucketSyncRetry();
}

function reinjectPendingSnapshots() {
  for (const state of bucketSync.values()) {
    const stillMissing = !tournamentData.value?.buckets?.some((bucket) => bucket.id === state.snapshot.id);
    if (stillMissing) {
      tournamentData.value.buckets.push(state.snapshot);
    }
  }
}

function scheduleBucketSyncRetry() {
  const hasUnlockedPending = [...bucketSync.values()].some((state) => !state.locked);
  if (!hasUnlockedPending || bucketSyncRetryTimer) return;

  bucketSyncRetryTimer = setTimeout(async () => {
    bucketSyncRetryTimer = null;
    await refreshTournament({ silent: true });
  }, 10_000);
}

// Runs on every tournament fetch (manual, submit-triggered, or one of this
// mechanism's own retries) - checks whether any bucket we're waiting on has
// reappeared yet, drains its queue if so, and otherwise counts the attempt
// (locking it after ~90s) and keeps its last-known snapshot visible.
// Returns true if a bucket just got locked (in which case the caller
// shouldn't immediately overwrite that error with a generic success
// message).
async function reconcileBucketSync() {
  if (bucketSync.size === 0) return false;

  let newlyLocked = false;
  let anyDrained = false;

  for (const [bucketId, state] of [...bucketSync.entries()]) {
    if (state.locked) continue;

    // Excludes our own reinjected snapshot - it has the same id but isn't
    // real data, so it would otherwise always look "found" the moment we
    // inject it, short-circuiting the wait before it's even started.
    const freshBucket = tournamentData.value?.buckets?.find(
      (bucket) => bucket.id === bucketId && bucket !== state.snapshot,
    );
    if (freshBucket) {
      if (state.queue.length) {
        await drainBucketSyncQueue(state, freshBucket);
        anyDrained = true;
      }
      bucketSync.delete(bucketId);
      continue;
    }

    state.attempts += 1;
    if (state.attempts * 10 >= 90) {
      state.locked = true;
      newlyLocked = true;
      setError(
        `"${state.snapshot.name}" hasn't synced with start.gg yet - refresh the tournament manually to continue reporting there.`,
      );
    }
  }

  if (anyDrained) {
    // Replaying the queue just changed start.gg's data out from under the
    // fetch we're reconciling against - re-fetch once more so what we just
    // sent actually shows up, instead of leaving the pre-drain ("still
    // unreported") view on screen and risking someone re-reporting it.
    await fetchAndApplyTournamentData();
  }

  reinjectPendingSnapshots();
  scheduleBucketSyncRetry();
  return newlyLocked;
}

// Every edit goes through here. `dirty` marks the editor as holding changes
// start.gg doesn't have, which is what lets a refresh tell an already-reported
// set that's being corrected apart from one that's just being looked at.
function updateEditorSet(targetRef, updater) {
  if (!targetRef.value) return;
  const next = cloneEditorSet(targetRef.value);
  const result = updater(next) ?? next;
  result.dirty = true;
  targetRef.value = result;
}

function applyBestOf(targetRef, value) {
  updateEditorSet(targetRef, (set) => withBestOf(set, value));
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

function applyGameCharacter(targetRef, payload) {
  updateEditorSet(targetRef, (set) => {
    const game = set.games[payload.index];
    if (!game) return;
    const key = payload.player === 1 ? "player1Character" : "player2Character";
    game[key] = payload.value;

    // Carry the pick forward: later games default to the same character
    // until someone explicitly sets a different one for that game.
    for (let i = payload.index + 1; i < set.games.length; i += 1) {
      if (!set.games[i][key]) {
        set.games[i][key] = payload.value;
      }
    }
  });
}

function toggleWinner(targetRef, payload) {
  updateEditorSet(targetRef, (set) => {
    if (payload.index < 0 || payload.index >= set.games.length) return;
    const current = set.games[payload.index]?.winner;
    const next = current === payload.winner ? null : payload.winner;

    // Games must be reported in order, so "the next unreported game" always
    // matches whichever row is actually being played on stream.
    if (current === null && next !== null && !canReportGame(set, payload.index)) {
      return;
    }

    set.games[payload.index].winner = next;

    if (next === null) {
      for (let i = payload.index + 1; i < set.games.length; i += 1) {
        set.games[i].winner = null;
      }
    }
  });
}

function swapPlayers(targetRef) {
  updateEditorSet(targetRef, swapSides);
}

function applySwapScores(targetRef) {
  updateEditorSet(targetRef, swapScores);
}

// --- Set timers ---------------------------------------------------------

function timerKey(editorSet) {
  return editorSet?.setId ? String(editorSet.setId) : STREAM_TIMER_KEY;
}

function ensureTimer(key) {
  if (!timers.has(key)) {
    timers.set(key, createTimerState());
  }
  return timers.get(key);
}

// The clock as the editors render it. Reads timerNow (not Date.now()) so
// Vue re-renders it on every tick rather than only when something else in
// the set changes.
function timerViewFor(editorSet) {
  if (!editorSet) return null;
  const state = timers.get(timerKey(editorSet)) ?? createTimerState();

  return {
    display: timerDisplay(state, timerNow.value),
    running: isRunning(state),
    // start.gg has this set in progress: its own clock is running too, and
    // only reporting the result stops it.
    startedOnStartgg: Boolean(state.startedOnStartgg),
    // The set is reported, so this is how long it took, not a live clock.
    final: Boolean(editorSet.completed),
  };
}

const tournamentSetsById = computed(() => {
  const out = new Map();
  for (const bucket of tournamentData.value?.buckets ?? []) {
    for (const set of bucket.sets ?? []) {
      out.set(String(set.id), set);
    }
  }
  return out;
});

// Live clocks for the bracket/pool view, so a set that's under way is
// visible as such without having to open it - the same thing start.gg's own
// bracket does. Sets that have been reported are left out: their card shows
// the score, which is the more useful thing once a set is over.
const liveSetTimers = computed(() => {
  const now = timerNow.value;
  const out = new Map();

  for (const [key, state] of timers.entries()) {
    if (key === STREAM_TIMER_KEY) continue;
    if (Number(tournamentSetsById.value.get(key)?.state) === 3) continue;

    const running = isRunning(state);
    if (!running && elapsedMs(state, now) === 0) continue;

    out.set(key, { display: timerDisplay(state, now), running });
  }

  return out;
});

const streamTimer = computed(() => timerViewFor(streamSet.value));
const quickReportTimer = computed(() => timerViewFor(quickReportSet.value));

// Scores the bracket view should show for sets start.gg doesn't have a
// result for yet: anything held as a locally-saved result, and - newest of
// all - whatever's being scored on stream right now. Keyed by set id and
// lined up with each set's own slots, since the stream editor may have its
// players swapped.
const liveSetScores = computed(() => {
  const out = new Map();
  const setsById = tournamentSetsById.value;

  for (const setId of draftSetIds(draftStore.value, config.tournamentSlug)) {
    const set = setsById.get(String(setId));
    const draft = getDraft(draftStore.value, setId, config.tournamentSlug);
    if (set && draft && hasResult(draft.editorSet)) {
      out.set(String(setId), slotScoresFor(draft.editorSet, set));
    }
  }

  const stream = streamSet.value;
  const streamTournamentSet = stream?.setId ? setsById.get(String(stream.setId)) : null;
  if (streamTournamentSet && !stream.completed && hasResult(stream)) {
    out.set(String(stream.setId), slotScoresFor(stream, streamTournamentSet));
  }

  return out;
});

// One interval for every timer, running only while at least one of them is,
// so an idle app isn't waking up four times a second forever.
function startTimerTick() {
  if (timerTickHandle) return;
  timerTickHandle = setInterval(() => {
    timerNow.value = Date.now();
    if (![...timers.values()].some(isRunning)) {
      stopTimerTick();
      return;
    }
    writeOverlayOnTimerSecond();
  }, 250);
}

function stopTimerTick() {
  if (!timerTickHandle) return;
  clearInterval(timerTickHandle);
  timerTickHandle = null;
}

// Keeps the overlay's clock moving while the stream set's timer runs, but
// only once per whole second - the UI ticks four times as often, and there's
// no point rewriting the overlay file for a change no viewer can see.
function writeOverlayOnTimerSecond() {
  if (!config.autoWriteOverlay || !streamSet.value) return;

  const state = timers.get(timerKey(streamSet.value));
  if (!isRunning(state)) return;

  const second = Math.floor(elapsedMs(state, timerNow.value) / 1000);
  if (second === lastOverlayTimerSecond) return;

  lastOverlayTimerSecond = second;
  writeOverlayFromStreamSet(true);
}

// Whether this set can be started/un-started on start.gg at all. A blank
// stream set has nothing to start; a set in a bracket start.gg hasn't
// actually started yet only has a synthetic "preview_..." id that no
// mutation accepts; and a bucket that's mid-desync is about to have its set
// ids replaced, so anything sent against them now would hit the wrong set.
function startggSetClockBlocker(editorSet) {
  if (!editorSet?.setId) return "local";
  if (!config.apiToken.trim()) return "no-token";
  if (String(editorSet.setId).startsWith("preview")) return "preview";

  const bucketId = findBucketIdForSetId(tournamentData.value?.buckets, editorSet.setId);
  if (bucketId && bucketSync.get(bucketId)) return "desynced";

  return null;
}

// Starting the timer is how a set gets started on start.gg, mirroring its
// own bracket UI: the set moves to in-progress there and start.gg begins
// timing it, and reporting the result is what stops that clock again.
// Pausing and resuming here are deliberately local-only - start.gg has no
// concept of a paused set, so the alternative would be repeatedly
// starting/resetting the set out from under anyone watching the bracket.
async function onToggleTimer(editorSet) {
  const key = timerKey(editorSet);
  const previous = ensureTimer(key);
  const wasRunning = isRunning(previous);

  timers.set(key, wasRunning ? pauseTimer(previous, Date.now()) : startTimer(previous, Date.now()));
  timerNow.value = Date.now();
  if (!wasRunning) startTimerTick();
  scheduleOverlayWrite();

  if (wasRunning || previous.startedOnStartgg) return;
  await startSetOnStartgg(editorSet, key);
}

// The quick start/pause button on a bracket or pool card - the same timer the
// set editors drive, without having to open the set first.
function onBracketToggleTimer(set) {
  const bucketId = findBucketIdForSetId(tournamentData.value?.buckets, set.id);
  if (bucketSync.get(bucketId)?.locked) {
    setError("This pool/bracket hasn't synced with start.gg yet - refresh manually before continuing.");
    return;
  }

  syncTimerFromTournamentSet(set);
  onToggleTimer(createEditorSetFromTournamentSet(set, bestOfDefaults.value));
}

async function startSetOnStartgg(editorSet, key) {
  // A set already reported has been timed and closed out on start.gg
  // already; starting it again would need a reset first.
  if (editorSet?.completed) return;

  switch (startggSetClockBlocker(editorSet)) {
    case null:
      break;
    case "preview":
      setSuccess(
        "Timer started here only - this set's pool/bracket hasn't been started on start.gg yet.",
      );
      return;
    case "desynced":
      setSuccess(
        "Timer started here only - this pool/bracket is still syncing with start.gg.",
      );
      return;
    default:
      // A blank stream set or a missing token: purely local, nothing to say.
      return;
  }

  try {
    const result = await markSetInProgress({
      apiToken: config.apiToken,
      setId: editorSet.setId,
    });

    const current = timers.get(key);
    // Anchor to start.gg's own start time so both clocks agree - but never
    // resurrect a timer that was paused while the request was in flight.
    const anchored = isRunning(current)
      ? timerFromServerStart(result?.startedAt, Date.now())
      : null;

    timers.set(key, anchored ?? { ...current, startedOnStartgg: true });
    setSuccess(
      `Set ${editorSet.setId} started on start.gg - reporting the result will stop its clock.`,
    );
  } catch (err) {
    // The local clock is already running and the set is being played either
    // way, so this is a warning, not a failure to undo.
    setError(`Timer started here, but start.gg didn't accept the start: ${String(err)}`);
  }
}

// Resetting the timer says the set hasn't started after all, so a set this
// app started on start.gg is un-started there too (start.gg's only way back
// out of in-progress is a reset). Guarded to sets with no reported result -
// SetEditor asks for a confirming click before this can touch start.gg.
async function onResetTimer(editorSet) {
  const key = timerKey(editorSet);
  const previous = ensureTimer(key);

  timers.set(key, resetTimer());
  timerNow.value = Date.now();
  lastOverlayTimerSecond = null;
  scheduleOverlayWrite();

  if (!previous.startedOnStartgg || editorSet?.completed) return;
  if (startggSetClockBlocker(editorSet)) return;

  try {
    await resetSetResult({
      apiToken: config.apiToken,
      setId: editorSet.setId,
      resetDependentSets: false,
    });
    setSuccess(`Set ${editorSet.setId} is no longer in progress on start.gg.`);
  } catch (err) {
    setError(`Timer reset here, but start.gg didn't accept un-starting the set: ${String(err)}`);
  }
}

// Reporting a result is what ends a set's clock on start.gg, so the app's
// own timer stops with it - frozen at the final time rather than cleared, so
// the length of the set stays readable afterwards.
function stopTimerForSet(setId) {
  if (!setId) return;
  const key = String(setId);
  const state = timers.get(key);
  if (!state) return;

  timers.set(key, { ...pauseTimer(state, Date.now()), startedOnStartgg: false });
  timerNow.value = Date.now();
}

// Brings a set's timer in line with what start.gg says about it: adopting
// the server's start time for a set that's in progress (so a set started on
// another device, or before this app was restarted, shows the right elapsed
// time), and freezing a completed set at the duration start.gg recorded.
// Never stomps a timer the TO is actively running or has deliberately
// paused - that would yank the clock out from under a live set.
// Adopts start.gg's clock for every set it currently has in progress, so the
// bracket view can show a running timer on each of them the way start.gg's
// own does - including sets started from another device or by another TO.
// Completed sets are deliberately skipped: their duration is only needed
// when one is actually opened, and freezing a timer for every finished set
// in the tournament would be a lot of state for something nothing renders.
function syncTimersFromTournamentData(data) {
  for (const bucket of data?.buckets ?? []) {
    for (const set of bucket.sets ?? []) {
      if (Number(set.state) === 2) syncTimerFromTournamentSet(set);
    }
  }
}

function syncTimerFromTournamentSet(set) {
  if (!set?.id) return;

  const key = String(set.id);
  const existing = timers.get(key);
  const state = Number(set.state);

  if (state === 3) {
    const started = Number(set.startedAt);
    const completed = Number(set.completedAt);
    if (started > 0 && completed > started) {
      timers.set(key, frozenTimer((completed - started) * 1000));
    } else if (existing) {
      timers.set(key, { ...pauseTimer(existing, Date.now()), startedOnStartgg: false });
    }
    return;
  }

  if (state !== 2 || !set.startedAt) return;

  if (existing && (isRunning(existing) || elapsedMs(existing, Date.now()) > 0)) {
    // Keep the local clock, but record that start.gg already has this set in
    // progress so the timer isn't started there a second time.
    if (!existing.startedOnStartgg) {
      timers.set(key, { ...existing, startedOnStartgg: true });
    }
    return;
  }

  const adopted = timerFromServerStart(set.startedAt, Date.now());
  if (!adopted) return;

  timers.set(key, adopted);
  timerNow.value = Date.now();
  startTimerTick();
}

// --- Locally-saved (unsubmitted) results --------------------------------

async function persistDrafts(nextStore) {
  draftStore.value = nextStore;
  try {
    await saveLocalResults(nextStore);
  } catch (err) {
    // Non-fatal: the draft still exists in memory for this session.
    console.error("Failed to save local results", err);
  }
}

function draftFor(editorSet) {
  return getDraft(draftStore.value, editorSet?.setId, config.tournamentSlug);
}

const streamDraft = computed(() => draftFor(streamSet.value));
const quickReportDraft = computed(() => draftFor(quickReportSet.value));
const draftedSetIds = computed(
  () => new Set(draftSetIds(draftStore.value, config.tournamentSlug)),
);

// Keeps whatever was scored into an editor when the set leaves it without
// being submitted. Sets with nothing scored (or whose result was cleared)
// drop any existing draft instead, so the bracket doesn't keep flagging a
// set nobody actually reported anything for.
async function stashResultLocally(editorSet, { notify = false } = {}) {
  if (!editorSet?.setId) return false;

  const next = putDraft(draftStore.value, editorSet, config.tournamentSlug, Date.now());
  const kept = Boolean(getDraft(next, editorSet.setId, config.tournamentSlug));
  await persistDrafts(next);

  if (notify && kept) {
    setSuccess(
      `Result for ${editorSet.player1.name} vs ${editorSet.player2.name} saved locally - remember to submit it to start.gg.`,
    );
  }
  return kept;
}

async function discardDraft(setId) {
  if (!setId || !getDraft(draftStore.value, setId, config.tournamentSlug)) return;
  await persistDrafts(removeDraft(draftStore.value, setId));
}

// The editor state to open a bracket set with: its locally-saved result if
// there is one, otherwise whatever start.gg has. A draft for a set start.gg
// has since completed is stale by definition - drop it rather than offering
// to re-report over a finished set.
function editorSetForTournamentSet(set) {
  const fresh = createEditorSetFromTournamentSet(set, bestOfDefaults.value);
  const draft = getDraft(draftStore.value, set.id, config.tournamentSlug);
  if (!draft) return fresh;

  if (fresh.completed) {
    discardDraft(set.id);
    return fresh;
  }

  const restored = cloneEditorSet(draft.editorSet);
  restored.setId = fresh.setId;
  restored.completed = false;
  return restored;
}

async function refreshStreamAvatars(editorSet) {
  streamAvatars.value = { player1Avatar: null, player2Avatar: null };

  const player1EntrantId = editorSet?.player1?.entrantId ?? null;
  const player2EntrantId = editorSet?.player2?.entrantId ?? null;
  if (!config.apiToken.trim() || (!player1EntrantId && !player2EntrantId)) return;

  try {
    streamAvatars.value = await fetchEntrantAvatars({
      apiToken: config.apiToken,
      player1EntrantId,
      player2EntrantId,
    });
  } catch (err) {
    // Non-fatal: the overlay just goes out without a profile picture.
    console.error("Failed to load player avatars", err);
  }
}

async function loadStreamSetFromTournamentSet(set) {
  const bucketId = findBucketIdForSetId(tournamentData.value?.buckets, set.id);
  if (bucketSync.get(bucketId)?.locked) {
    setError("This pool/bracket hasn't synced with start.gg yet - refresh manually before continuing.");
    return;
  }

  // Whatever was on stream is about to be replaced - keep anything scored
  // into it that never made it to start.gg.
  const outgoing = streamSet.value;
  if (outgoing?.setId && outgoing.setId !== set.id && hasResult(outgoing) && !outgoing.completed) {
    await stashResultLocally(outgoing);
  }

  syncTimerFromTournamentSet(set);
  streamSet.value = editorSetForTournamentSet(set);
  setSuccess(
    streamDraft.value
      ? `Set ${set.id} moved to stream editor with its locally-saved result - remember to submit it to start.gg.`
      : `Set ${set.id} moved to stream editor.`,
  );

  // Setting streamSet above already schedules a debounced overlay write,
  // but that's a fixed 350ms timer racing an actual network fetch here - the
  // avatar frequently wasn't back yet when it fired, writing the overlay
  // without one (only fixed by re-selecting the set, which just re-rolled
  // the same race). Write again, explicitly, once the avatar fetch settles.
  await refreshStreamAvatars(streamSet.value);
  if (config.autoWriteOverlay) {
    await writeOverlayFromStreamSet(true);
  }
}

function openQuickReport(set) {
  const bucketId = findBucketIdForSetId(tournamentData.value?.buckets, set.id);
  if (bucketSync.get(bucketId)?.locked) {
    setError("This pool/bracket hasn't synced with start.gg yet - refresh manually before continuing.");
    return;
  }

  syncTimerFromTournamentSet(set);
  // The set on stream is already being scored in the stream editor, which is
  // newer than anything start.gg or a saved draft has - open that, so the
  // two editors can't end up reporting different results for one set.
  quickReportSet.value = isOnStream(set.id)
    ? cloneEditorSet(streamSet.value)
    : editorSetForTournamentSet(set);
  quickReportOpen.value = true;
}

function isOnStream(setId) {
  return Boolean(setId) && String(streamSet.value?.setId) === String(setId);
}

function onStreamBestOf(value) {
  applyBestOf(streamSet, value);
}

function onStreamPlayerName(payload) {
  applyPlayerName(streamSet, payload);
}

function onStreamGameCharacter(payload) {
  applyGameCharacter(streamSet, payload);
}

function onStreamToggleWinner(payload) {
  toggleWinner(streamSet, payload);
}

function onStreamSwapScores() {
  applySwapScores(streamSet);
}

function onQuickSwapScores() {
  applySwapScores(quickReportSet);
}

function onStreamSwapPlayers() {
  swapPlayers(streamSet);
  streamAvatars.value = {
    player1Avatar: streamAvatars.value.player2Avatar,
    player2Avatar: streamAvatars.value.player1Avatar,
  };
}

function onQuickBestOf(value) {
  applyBestOf(quickReportSet, value);
}

function onQuickPlayerName(payload) {
  applyPlayerName(quickReportSet, payload);
}

function onQuickGameCharacter(payload) {
  applyGameCharacter(quickReportSet, payload);
}

function onQuickToggleWinner(payload) {
  toggleWinner(quickReportSet, payload);
}

function applyDq(targetRef, player) {
  updateEditorSet(targetRef, (set) => {
    set.dq = toggleDq(set.dq, player);
  });
}

function onStreamToggleDq(player) {
  applyDq(streamSet, player);
}

function onQuickToggleDq(player) {
  applyDq(quickReportSet, player);
}

function onStreamToggleTimer() {
  onToggleTimer(streamSet.value);
}

function onStreamResetTimer() {
  onResetTimer(streamSet.value);
}

function onQuickToggleTimer() {
  onToggleTimer(quickReportSet.value);
}

function onQuickResetTimer() {
  onResetTimer(quickReportSet.value);
}

function onStreamReset() {
  resetSetOnStartgg(streamSet, "stream");
}

function onQuickReset() {
  resetSetOnStartgg(quickReportSet, "quick");
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

function toggleConfigPanel() {
  configPanelOpen.value = !configPanelOpen.value;
}

// Dismissing the modal (Close, backdrop click or Escape) is treated as
// "keep this for later", not "throw it away" - a set part-way through when
// the modal gets clicked off would otherwise silently lose its games.
async function closeQuickReport({ keepLocalResult = true } = {}) {
  const closing = quickReportSet.value;
  quickReportOpen.value = false;
  quickReportSet.value = null;

  if (keepLocalResult && closing?.setId && !closing.completed) {
    await stashResultLocally(closing, { notify: true });
  }
}

function overlayRequestFromEditorSet(editorSet) {
  if (!editorSet) return null;

  return {
    outputPath: config.streamOutputPath,
    tournamentName: tournamentData.value?.tournamentName || config.tournamentSlug,
    roundText: editorSet.roundText || "",
    eventName: editorSet.eventName || "",
    bestOf: normalizeBestOf(editorSet.bestOf),
    player1: {
      name: editorSet.player1.name || "Player 1",
      character: currentGameCharacter(editorSet, 1) || null,
      characterIcon: characterIconFile(currentGameCharacter(editorSet, 1)),
      score: scoreFor(editorSet, 1),
      avatarUrl: streamAvatars.value.player1Avatar || null,
    },
    player2: {
      name: editorSet.player2.name || "Player 2",
      character: currentGameCharacter(editorSet, 2) || null,
      characterIcon: characterIconFile(currentGameCharacter(editorSet, 2)),
      score: scoreFor(editorSet, 2),
      avatarUrl: streamAvatars.value.player2Avatar || null,
    },
    timer: timerOverlayPayload(timers.get(timerKey(editorSet)), Date.now()),
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

async function ensureCharacterIdMap(videogameId) {
  if (!videogameId || videogameId === loadedVideogameId) return;

  try {
    const characters = await fetchGameCharacters({
      apiToken: config.apiToken,
      videogameId,
    });
    // Keyed by OUR canonical name (not start.gg's raw name, e.g. "Pyra &
    // Mythra") so a pick made via our own CharacterPicker - which only ever
    // offers our canonical spelling - resolves to the right characterId.
    characterIdByName.value = new Map(
      characters.map((c) => [canonicalCharacterName(c.name), c.id]),
    );
    loadedVideogameId = videogameId;
  } catch (err) {
    // Non-fatal: game reports just go out without character selections.
    console.error("Failed to load character list for videogame", videogameId, err);
  }
}

// start.gg doesn't always spell split character names the same way our own
// picker does (e.g. "Pyra & Mythra" vs our "Pyra/Mythra") - canonicalize
// every character name pulled in from a tournament fetch so icon lookups,
// picker highlighting, and character-id resolution on submit all agree.
function canonicalizeFetchedCharacters(data) {
  for (const bucket of data?.buckets ?? []) {
    for (const set of bucket.sets ?? []) {
      if (set.player1Character) set.player1Character = canonicalCharacterName(set.player1Character);
      if (set.player2Character) set.player2Character = canonicalCharacterName(set.player2Character);
      for (const game of set.games ?? []) {
        if (game.player1Character) game.player1Character = canonicalCharacterName(game.player1Character);
        if (game.player2Character) game.player2Character = canonicalCharacterName(game.player2Character);
      }
    }
  }
  return data;
}

// start.gg serves cached set data for up to ~60s, so the fetch straight
// after reporting (or resetting, or correcting) a set routinely comes back
// describing it as it was *before* - the bracket would show the old result,
// and the stream editor would offer to report the set all over again. Every
// change this app makes is remembered here for a little longer than that
// cache lives, and laid over each fetch until start.gg's data agrees.
const RECENT_RESULT_TTL_MS = 90_000;
const recentResults = new Map();

function rememberRecentResult(setId, entry) {
  recentResults.set(String(setId), { ...entry, expiresAt: Date.now() + RECENT_RESULT_TTL_MS });
}

function fetchedSetMatchesReport(set, entry) {
  if (Number(set.state) !== 3) return false;
  if ((set.winnerId ?? null) !== (entry.winnerId ?? null)) return false;
  const expected = slotScoresFor(entry.editorSet, set);
  return (
    Number(set.player1?.score) === expected.player1 &&
    Number(set.player2?.score) === expected.player2
  );
}

function applyRecentResults(data) {
  const now = Date.now();

  for (const [setId, entry] of [...recentResults.entries()]) {
    if (entry.expiresAt <= now) {
      recentResults.delete(setId);
      continue;
    }

    const bucket = data?.buckets?.find((b) => b.sets?.some((set) => String(set.id) === setId));
    const target = bucket?.sets.find((set) => String(set.id) === setId);
    if (!target) continue;

    if (entry.kind === "reset") {
      if (Number(target.state) !== 3 && !target.winnerId) {
        recentResults.delete(setId);
        continue;
      }
      target.state = 1;
      target.winnerId = null;
      target.startedAt = null;
      target.completedAt = null;
      target.games = [];
      target.player1Character = null;
      target.player2Character = null;
      if (target.player1) target.player1.score = null;
      if (target.player2) target.player2.score = null;
      continue;
    }

    if (fetchedSetMatchesReport(target, entry)) {
      recentResults.delete(setId);
      continue;
    }
    applyOptimisticResult(bucket, setId, entry.editorSet, entry.winnerId);
  }

  return data;
}

async function fetchAndApplyTournamentData() {
  const data = await fetchTournamentState({
    apiToken: config.apiToken,
    tournamentSlug: config.tournamentSlug,
    perPage: Number(config.perPage) || 128,
  });

  canonicalizeFetchedCharacters(data);
  collapseBucketByes(data);
  applyRecentResults(data);
  tournamentData.value = data;
  return data;
}

// Fold start.gg's structural bye/passthrough sets out of every bracket bucket
// up front, rewriting drop links to point at real matches (see collapseByeSets
// in bracket-utils). Doing it here, on the stored data, means the bracket view
// *and* optimistic routing during a desync both see the same collapsed graph -
// so a reported Winners Round 1 result advances its loser straight into the
// real Losers Round 1 slot instead of a bye set that never renders. Pools
// (all-round-0) carry no such sets, so they pass through untouched.
function collapseBucketByes(data) {
  for (const bucket of data?.buckets ?? []) {
    if ((bucket.sets ?? []).some((set) => Number(set.round) !== 0)) {
      bucket.sets = collapseByeSets(bucket.sets);
    }
  }
  return data;
}

// The rest of a refresh, once tournamentData holds a fetch's raw result:
// reconciling bucket sync, resolving the active tab, the character-id map,
// and the stream editor's character carry-over. Split out from the fetch
// so submitSet can reinject a just-vanished bucket in between fetching and
// this running - otherwise the active-tab fallback below runs first and
// jumps away before there's anything to find it again.
async function finishTournamentRefresh({ silent = false } = {}) {
  const bucketJustLocked = await reconcileBucketSync();
  const data = tournamentData.value;

  syncTimersFromTournamentData(data);

  if (!data?.buckets?.find((bucket) => bucket.id === activeBucketId.value)) {
    activeBucketId.value = data?.buckets?.[0]?.id || "";
  }

  await ensureCharacterIdMap(data?.videogameId);

  if (streamSet.value?.setId) {
    const allSets = (data?.buckets || []).flatMap((bucket) => bucket.sets || []);
    const matching = allSets.find((set) => String(set.id) === String(streamSet.value.setId));
    if (matching) {
      syncTimerFromTournamentSet(matching);
      streamSet.value = mergeFetchedIntoEditorSet(streamSet.value, matching);
    }
  }

  // Don't stomp the "hasn't synced" error reconcileBucketSync just set.
  if (!silent && !bucketJustLocked) {
    setSuccess(`Loaded ${data?.totalSets ?? 0} sets from ${data?.tournamentName ?? ""}.`);
  }
}

// Folds a fresh start.gg copy of a set into the editor already holding it.
// The editor's own state wins wherever it's newer than start.gg can be:
//  - its player order, so a swap made on stream survives the refresh (and
//    the scores and characters stay with the right player);
//  - its score, format and DQ, unless start.gg has a result the editor
//    doesn't (reported from elsewhere, or just submitted from here) - and
//    even then not while a reported result is being corrected here;
//  - names typed in for the same entrant, and character picks.
function mergeFetchedIntoEditorSet(current, tournamentSet) {
  const fetched = orientLike(
    createEditorSetFromTournamentSet(tournamentSet, bestOfDefaults.value),
    current,
  );

  const keepLocalResult = fetched.completed
    ? Boolean(current.completed && current.dirty)
    : hasResult(current) || !hasResult(fetched);

  const merged = keepLocalResult
    ? {
        ...fetched,
        bestOf: current.bestOf,
        dq: current.dq,
        games: cloneEditorSet(current).games,
        dirty: Boolean(current.dirty),
      }
    : fetched;

  if (!keepLocalResult) {
    merged.games.forEach((game, index) => {
      const previousGame = current.games?.[index];
      if (!previousGame) return;
      game.player1Character = previousGame.player1Character || game.player1Character;
      game.player2Character = previousGame.player2Character || game.player2Character;
    });
  }

  for (const key of ["player1", "player2"]) {
    if (current[key]?.entrantId && current[key].entrantId === merged[key]?.entrantId) {
      merged[key] = { ...merged[key], name: current[key].name };
    }
  }

  return merged;
}

async function refreshTournament({ silent = false } = {}) {
  if (!requireStartggConfig()) return;

  loadingTournament.value = true;
  try {
    await fetchAndApplyTournamentData();
    await finishTournamentRefresh({ silent });
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
      previewSourceMode: config.previewSourceMode,
      overlayLayoutUrl: config.overlayLayoutUrl.trim(),
      perPage: Number(config.perPage) || 128,
      autoWriteOverlay: config.autoWriteOverlay,
      poolViewMode: config.poolViewMode,
      poolBestOf: normalizeBestOf(config.poolBestOf, DEFAULT_POOL_BEST_OF),
      bracketBestOf: normalizeBestOf(config.bracketBestOf, DEFAULT_BRACKET_BEST_OF),
      bestOfOptions: normalizeBestOfOptions(config.bestOfOptions),
    });
    setSuccess("Settings saved.");
  } catch (err) {
    setError(`Failed to save settings: ${String(err)}`);
  } finally {
    savingConfig.value = false;
  }
}

// Per-game winner + character selections for the games that have actually
// been played, in the shape start.gg's reportBracketSet gameData expects.
// Random or unrecognized character picks are just left out of selections -
// there's no start.gg characterId for those.
function buildGameData(editorSet) {
  const games = editorSet?.games ?? [];

  return games
    .map((game, index) => {
      if (!game?.winner) return null;

      const winner =
        game.winner === 1 ? editorSet.player1.entrantId : editorSet.player2.entrantId;

      const selections = [];
      const addSelection = (entrantId, characterName) => {
        if (!entrantId || !characterName || characterName === RANDOM_CHARACTER) return;
        const characterId = characterIdByName.value.get(characterName);
        if (!characterId) return;
        selections.push({ entrantId, characterId });
      };

      addSelection(editorSet.player1.entrantId, game.player1Character);
      addSelection(editorSet.player2.entrantId, game.player2Character);

      return { gameNum: index + 1, winnerId: winner || null, selections };
    })
    .filter(Boolean);
}

async function submitSet(editorSet, mode) {
  const dq = editorSet?.dq ?? null;
  const winnerId = winnerEntrantId(editorSet);

  if (!editorSet?.setId) {
    setError("This set has no start.gg set ID.");
    return;
  }

  if (!isSubmittable(editorSet)) {
    setError("Set a winner first (more game wins than the opponent), or mark a DQ.");
    return;
  }

  // Every report except a double DQ (where nobody advances) needs a winner.
  if (!winnerId && dq !== "both") {
    setError("This set has no winner to report.");
    return;
  }

  if (!config.apiToken.trim()) {
    setError("Missing start.gg API token.");
    return;
  }

  const bucketId = findBucketIdForSetId(tournamentData.value?.buckets, editorSet.setId);
  const pending = bucketId ? bucketSync.get(bucketId) : null;

  if (pending?.locked) {
    setError(
      `"${pending.snapshot.name}" hasn't synced with start.gg yet - refresh the tournament manually before reporting more results there.`,
    );
    return;
  }

  // A set start.gg already has a result for is corrected in place rather
  // than reported again.
  const resubmitting = Boolean(editorSet.completed);
  if (resubmitting && pending) {
    setError(
      `"${pending.snapshot.name}" is still syncing with start.gg - wait for it to reload before correcting a result there.`,
    );
    return;
  }

  if (mode === "stream") {
    submittingStream.value = true;
  } else {
    submittingQuickReport.value = true;
  }

  try {
    // A DQ isn't a played set, so it never carries per-game data - start.gg
    // derives the -1 score from the DQ flag itself.
    const gameData = dq ? [] : buildGameData(editorSet);
    const gameDataPayload = gameData.length ? gameData : null;

    if (pending) {
      // Still waiting on start.gg to reflect whatever started this
      // pool/bracket - queue this one instead of sending it against a set
      // id that's about to be replaced, and apply it locally so everything
      // else (characters, the overlay, further edits) keeps working.
      pending.queue.push({
        player1EntrantId: editorSet.player1.entrantId,
        player2EntrantId: editorSet.player2.entrantId,
        winnerEntrantId: winnerId,
        gameData: gameDataPayload,
        isDq: Boolean(dq),
      });
      applyOptimisticResult(pending.snapshot, editorSet.setId, editorSet, winnerId);

      // Queued for start.gg, so there's nothing left for the TO to remember
      // to submit by hand, and the set is over either way.
      await discardDraft(editorSet.setId);
      stopTimerForSet(editorSet.setId);

      setSuccess(`Saved locally - will sync to start.gg once "${pending.snapshot.name}" reloads.`);

      if (mode === "stream") {
        await writeOverlayFromStreamSet(true);
      }

      if (mode === "quick") {
        await closeQuickReport({ keepLocalResult: false });
      }
      return;
    }

    const request = {
      apiToken: config.apiToken,
      setId: editorSet.setId,
      winnerId,
      gameData: gameDataPayload,
      isDq: Boolean(dq),
    };

    if (resubmitting) {
      await resubmitSetResult(request, mode);
    } else {
      await reportSetResult(request);
    }

    // It's on start.gg now, so the locally-held copy has served its purpose,
    // and start.gg has stopped timing the set - so this timer stops too.
    rememberRecentResult(editorSet.setId, {
      kind: "reported",
      editorSet: cloneEditorSet(editorSet),
      winnerId,
    });
    await discardDraft(editorSet.setId);
    stopTimerForSet(editorSet.setId);

    // What's in the editor is now exactly what start.gg has.
    if (isOnStream(editorSet.setId)) {
      streamSet.value = { ...cloneEditorSet(streamSet.value), dirty: false };
    }

    const done = resubmitting
      ? `Updated set ${editorSet.setId} on start.gg`
      : `Reported set ${editorSet.setId} to start.gg`;
    setSuccess(dq ? `${done} as a DQ.` : `${done}.`);

    if (mode === "stream") {
      await writeOverlayFromStreamSet(true);
    }

    const bucketBeforeRefresh = bucketId
      ? tournamentData.value.buckets.find((bucket) => bucket.id === bucketId)
      : null;

    await fetchAndApplyTournamentData();

    // The bucket this set belonged to has vanished from the fresh fetch -
    // start.gg's cache hasn't caught up with the pool/bracket this report
    // just started. Keep showing it (with this result applied) and start
    // retrying in the background instead of letting it just disappear. This
    // has to happen *before* finishTournamentRefresh resolves the active
    // tab below, or that fallback runs against a bucket list that still
    // looks like it's missing and jumps away right as this reinjects it.
    if (
      bucketId &&
      bucketBeforeRefresh &&
      !tournamentData.value?.buckets?.some((bucket) => bucket.id === bucketId)
    ) {
      const snapshot = cloneBucket(bucketBeforeRefresh);
      applyOptimisticResult(snapshot, editorSet.setId, editorSet, winnerId);
      registerPendingBucket(bucketId, snapshot);
    }

    // Silent: the refresh is a side effect of reporting, and its generic
    // "Loaded N sets" message would immediately bury the confirmation that
    // this set actually made it to start.gg.
    await finishTournamentRefresh({ silent: true });

    if (mode === "quick") {
      await closeQuickReport({ keepLocalResult: false });
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

// Corrects an already-reported set's result. start.gg's updateBracketSet
// does that in place; if it refuses (it can, e.g. for some changes of
// winner), fall back to what used to be the manual route - reset the set,
// then report it again.
async function resubmitSetResult(request, mode) {
  try {
    await updateSetResult(request);
    return;
  } catch (updateErr) {
    console.warn("updateBracketSet was rejected, falling back to reset + report", updateErr);
  }

  await resetSetResult({
    apiToken: request.apiToken,
    setId: request.setId,
    resetDependentSets: false,
  });

  try {
    await reportSetResult(request);
  } catch (err) {
    // The set is now reset on start.gg with no result - make sure the
    // editor says so, so the next submit reports rather than corrects.
    const targetRef = mode === "stream" ? streamSet : quickReportSet;
    if (String(targetRef.value?.setId) === String(request.setId)) {
      targetRef.value = { ...cloneEditorSet(targetRef.value), completed: false };
    }
    rememberRecentResult(request.setId, { kind: "reset" });
    throw new Error(`the set was reset on start.gg but re-reporting it failed (${String(err)}) - submit it again`);
  }
}

// Un-reports a set on start.gg and clears its score here, for a set that
// shouldn't have been reported at all. (Correcting a score doesn't need
// this - just change it and resubmit.)
async function resetSetOnStartgg(targetRef, mode) {
  const editorSet = targetRef.value;

  if (!editorSet?.setId) {
    setError("This set has no start.gg set ID.");
    return;
  }

  if (!config.apiToken.trim()) {
    setError("Missing start.gg API token.");
    return;
  }

  const bucketId = findBucketIdForSetId(tournamentData.value?.buckets, editorSet.setId);
  if (bucketSync.get(bucketId)?.locked) {
    setError("This pool/bracket hasn't synced with start.gg yet - refresh manually before continuing.");
    return;
  }

  if (mode === "stream") {
    resettingStream.value = true;
  } else {
    resettingQuickReport.value = true;
  }

  try {
    await resetSetResult({
      apiToken: config.apiToken,
      setId: editorSet.setId,
      resetDependentSets: false,
    });

    const reopened = { ...clearResults(editorSet), dirty: false };
    rememberRecentResult(editorSet.setId, { kind: "reset" });

    targetRef.value = reopened;
    // resetSet clears start.gg's own start time as well as the result, so
    // the set really is back to "not started" - including its clock.
    if (timers.has(timerKey(editorSet))) timers.set(timerKey(editorSet), resetTimer());

    setSuccess(`Set ${editorSet.setId} reset on start.gg.`);

    await fetchAndApplyTournamentData();
    await finishTournamentRefresh({ silent: true });

    // start.gg serves cached set data for up to ~60s, so the refresh above
    // can still describe this set as completed - the reset we just made is
    // the newer truth, so put the reopened editor state back either way.
    targetRef.value = cloneEditorSet(reopened);
  } catch (err) {
    setError(`Failed to reset set: ${String(err)}`);
  } finally {
    if (mode === "stream") {
      resettingStream.value = false;
    } else {
      resettingQuickReport.value = false;
    }
  }
}

watch(streamSet, scheduleOverlayWrite, { deep: true });

// The quick-report modal can be opened on the set that's on stream (it then
// starts from the stream editor's state - see openQuickReport); anything
// changed there is mirrored straight back, keeping the stream's own player
// order, so the two never disagree about one set.
watch(quickReportSet, (quick) => {
  if (!quick?.setId || !isOnStream(quick.setId)) return;
  streamSet.value = orientLike(quick, streamSet.value);
});
watch(
  () => config.streamOutputPath,
  () => scheduleOverlayWrite(),
);
watch(
  () => config.autoWriteOverlay,
  () => scheduleOverlayWrite(),
);

// Pending bucket-sync state (and its retry timer) is only meaningful for
// whichever tournament it was created against - drop it if the user points
// this app at a different tournament or token, so a stale snapshot/retry
// from the old one can't leak into the new one's data.
watch(
  () => [config.apiToken, config.tournamentSlug],
  () => {
    bucketSync.clear();
    recentResults.clear();
    timers.clear();
    stopTimerTick();
    if (bucketSyncRetryTimer) {
      clearTimeout(bucketSyncRetryTimer);
      bucketSyncRetryTimer = null;
    }
  },
);

function onGlobalKeydown(event) {
  if (event.key === "Escape" && quickReportOpen.value) {
    closeQuickReport();
  }
}

onMounted(async () => {
  window.addEventListener("keydown", onGlobalKeydown);

  try {
    const loaded = await loadConfig();
    config.apiToken = loaded.apiToken || "";
    config.tournamentSlug = loaded.tournamentSlug || "";
    config.streamOutputPath = loaded.streamOutputPath || "";
    config.preferredCameraId = loaded.preferredCameraId || "";
    config.previewSourceMode = ["auto", "virtualcam", "overlay"].includes(
      loaded.previewSourceMode,
    )
      ? loaded.previewSourceMode
      : "auto";
    config.overlayLayoutUrl = loaded.overlayLayoutUrl || "";
    config.perPage = loaded.perPage || 128;
    config.autoWriteOverlay = loaded.autoWriteOverlay ?? true;
    config.poolViewMode = loaded.poolViewMode === "list" ? "list" : "grid";
    config.poolBestOf = normalizeBestOf(loaded.poolBestOf, DEFAULT_POOL_BEST_OF);
    config.bracketBestOf = normalizeBestOf(loaded.bracketBestOf, DEFAULT_BRACKET_BEST_OF);
    config.bestOfOptions = normalizeBestOfOptions(loaded.bestOfOptions);
    bestOfOptionsText.value = config.bestOfOptions.join(", ");
    configLoaded.value = true;

    configPanelOpen.value = !(config.apiToken && config.tournamentSlug);

    if (config.apiToken && config.tournamentSlug) {
      await refreshTournament();
    }
  } catch (err) {
    setError(`Could not load saved settings: ${String(err)}`);
    configLoaded.value = true;
  }

  try {
    draftStore.value = normalizeDraftStore(await loadLocalResults());
    const pendingDrafts = draftSetIds(draftStore.value, config.tournamentSlug).length;
    if (pendingDrafts) {
      setSuccess(
        `${pendingDrafts} locally-saved result${pendingDrafts === 1 ? "" : "s"} not yet submitted to start.gg.`,
      );
    }
  } catch (err) {
    // Non-fatal: drafts are a convenience, not something to block start-up on.
    console.error("Failed to load locally-saved results", err);
  }

  if (!streamSet.value) {
    streamSet.value = emptyEditorSet();
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onGlobalKeydown);
  if (overlayTimer) {
    clearTimeout(overlayTimer);
  }
  if (bucketSyncRetryTimer) {
    clearTimeout(bucketSyncRetryTimer);
  }
  stopTimerTick();
});

// The configured best-of options plus whatever's currently selected, so a
// default doesn't vanish from its own dropdown when its option is removed.
function bestOfChoices(selected) {
  return [...new Set([...config.bestOfOptions, selected])].sort((a, b) => a - b);
}

const showStatus = computed(() => Boolean(statusMessage.value));
const showError = computed(() => Boolean(errorMessage.value));
</script>

<template>
  <main class="app">
    <section class="config-panel">
      <header class="config-panel-header">
        <h1>Tournament Stream Manager</h1>
        <div class="header-actions">
          <button
            v-if="!configPanelOpen"
            type="button"
            :disabled="loadingTournament"
            @click="refreshTournament"
          >
            {{ loadingTournament ? "Loading…" : "Refresh Tournament" }}
          </button>
          <button type="button" class="collapse-toggle" @click="toggleConfigPanel">
            {{ configPanelOpen ? "Hide settings ▲" : "Show settings ▼" }}
          </button>
        </div>
      </header>

      <div v-show="configPanelOpen">
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

          <label>
            Preview source
            <select v-model="config.previewSourceMode">
              <option value="auto">Auto (prefer OBS Virtual Camera)</option>
              <option value="virtualcam">OBS Virtual Camera only</option>
              <option value="overlay">Capture card + overlay</option>
            </select>
          </label>

          <label>
            Pool view
            <select v-model="config.poolViewMode">
              <option value="grid">Grid (round-robin table)</option>
              <option value="list">List (sets left to play)</option>
            </select>
          </label>

          <label>
            Best-of options (comma separated)
            <input
              v-model="bestOfOptionsText"
              type="text"
              placeholder="3, 5, 7"
              @change="applyBestOfOptionsText"
            />
          </label>

          <label>
            Default format for pools
            <select v-model.number="config.poolBestOf">
              <option v-for="option in bestOfChoices(config.poolBestOf)" :key="option" :value="option">
                Best of {{ option }}
              </option>
            </select>
          </label>

          <label>
            Default format for bracket
            <select v-model.number="config.bracketBestOf">
              <option v-for="option in bestOfChoices(config.bracketBestOf)" :key="option" :value="option">
                Best of {{ option }}
              </option>
            </select>
          </label>

          <label>
            Overlay layout URL or file
            <input
              v-model="config.overlayLayoutUrl"
              type="text"
              placeholder="The same index.html the OBS browser source uses"
            />
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
      </div>

      <p v-if="showStatus" class="message success">{{ statusMessage }}</p>
      <p v-if="showError" class="message error">{{ errorMessage }}</p>
    </section>

    <section class="top-grid">
      <WebcamPanel
        v-if="configLoaded"
        v-model:camera-id="config.preferredCameraId"
        :source-mode="config.previewSourceMode"
        :overlay-url="config.overlayLayoutUrl"
      />

      <SetEditor
        title="On Stream Set"
        :set-data="streamSet"
        :characters="SMASH_ULTIMATE_CHARACTERS"
        :submitting="submittingStream"
        :resetting="resettingStream"
        :writing-overlay="writingOverlay"
        :allow-swap="true"
        :timer="streamTimer"
        :draft="streamDraft"
        :best-of-options="config.bestOfOptions"
        @set-best-of="onStreamBestOf"
        @set-player-name="onStreamPlayerName"
        @set-game-character="onStreamGameCharacter"
        @toggle-game-winner="onStreamToggleWinner"
        @toggle-dq="onStreamToggleDq"
        @swap-players="onStreamSwapPlayers"
        @swap-scores="onStreamSwapScores"
        @apply-overlay="writeOverlayFromStreamSet(false)"
        @reset-result="onStreamReset"
        @toggle-timer="onStreamToggleTimer"
        @reset-timer="onStreamResetTimer"
        @submit="onStreamSubmit"
      />
    </section>

    <BracketBoard
      :tournament-data="tournamentData"
      :active-bucket-id="activeBucketId"
      :bucket-sync-state="bucketSync"
      :drafted-set-ids="draftedSetIds"
      :set-timers="liveSetTimers"
      :live-scores="liveSetScores"
      :pool-view-mode="config.poolViewMode"
      @update:activeBucketId="onBucketChange"
      @set-on-stream="loadStreamSetFromTournamentSet"
      @quick-report="openQuickReport"
      @toggle-timer="onBracketToggleTimer"
    />

    <div v-if="quickReportOpen" class="modal-backdrop" @click.self="closeQuickReport()">
      <div class="modal-card">
        <SetEditor
          title="Quick Report"
          :set-data="quickReportSet"
          :characters="SMASH_ULTIMATE_CHARACTERS"
          :submitting="submittingQuickReport"
          :resetting="resettingQuickReport"
          :show-overlay-button="false"
          :show-close="true"
          :timer="quickReportTimer"
          :draft="quickReportDraft"
          :best-of-options="config.bestOfOptions"
          @close="closeQuickReport()"
          @set-best-of="onQuickBestOf"
          @set-player-name="onQuickPlayerName"
          @set-game-character="onQuickGameCharacter"
          @toggle-game-winner="onQuickToggleWinner"
          @toggle-dq="onQuickToggleDq"
          @swap-scores="onQuickSwapScores"
          @reset-result="onQuickReset"
          @toggle-timer="onQuickToggleTimer"
          @reset-timer="onQuickResetTimer"
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
  color-scheme: light;
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
  grid-template-columns: minmax(0, 1fr);
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

.config-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.config-panel h1 {
  margin: 0;
  font-size: 18px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.header-actions button {
  font-size: 12px;
  white-space: nowrap;
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

.config-grid label input,
.config-grid label select {
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
    color-scheme: dark;
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
