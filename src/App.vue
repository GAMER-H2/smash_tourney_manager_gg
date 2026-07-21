<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import WebcamPanel from "./components/WebcamPanel.vue";
import SetEditor from "./components/SetEditor.vue";
import BracketBoard from "./components/BracketBoard.vue";
import {
  fetchEntrantAvatars,
  fetchGameCharacters,
  fetchTournamentState,
  loadConfig,
  reportSetResult,
  saveConfig,
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
  cloneEditorSet,
  createEditorSetFromTournamentSet,
  currentGameCharacter,
  emptyEditorSet,
  emptyGame,
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
const activeBucketId = ref("");
const configPanelOpen = ref(true);
const configLoaded = ref(false);

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

let overlayTimer = null;
let bucketSyncRetryTimer = null;

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
  const target = bucket?.sets.find((set) => set.id === setId);
  if (!target) return;

  const winnerSlot = target.player1?.entrantId === winnerEntrantId ? target.player1 : target.player2;
  const loserSlot = target.player1?.entrantId === winnerEntrantId ? target.player2 : target.player1;

  target.state = 3;
  target.winnerId = winnerEntrantId;
  if (target.player1) target.player1.score = winsFor(editorSet, 1);
  if (target.player2) target.player2.score = winsFor(editorSet, 2);

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
      set.games.push(emptyGame());
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
  updateEditorSet(targetRef, (set) => {
    [set.player1, set.player2] = [set.player2, set.player1];
    set.games = set.games.map((game) => ({
      winner: game.winner === 1 ? 2 : game.winner === 2 ? 1 : null,
      player1Character: game.player2Character,
      player2Character: game.player1Character,
    }));
  });
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

  streamSet.value = createEditorSetFromTournamentSet(set);
  setSuccess(`Set ${set.id} moved to stream editor.`);

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

  quickReportSet.value = createEditorSetFromTournamentSet(set);
  quickReportOpen.value = true;
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
      character: currentGameCharacter(editorSet, 1) || null,
      characterIcon: characterIconFile(currentGameCharacter(editorSet, 1)),
      score: winsFor(editorSet, 1),
      avatarUrl: streamAvatars.value.player1Avatar || null,
    },
    player2: {
      name: editorSet.player2.name || "Player 2",
      character: currentGameCharacter(editorSet, 2) || null,
      characterIcon: characterIconFile(currentGameCharacter(editorSet, 2)),
      score: winsFor(editorSet, 2),
      avatarUrl: streamAvatars.value.player2Avatar || null,
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

async function fetchAndApplyTournamentData() {
  const data = await fetchTournamentState({
    apiToken: config.apiToken,
    tournamentSlug: config.tournamentSlug,
    perPage: Number(config.perPage) || 128,
  });

  canonicalizeFetchedCharacters(data);
  tournamentData.value = data;
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

  if (!data?.buckets?.find((bucket) => bucket.id === activeBucketId.value)) {
    activeBucketId.value = data?.buckets?.[0]?.id || "";
  }

  await ensureCharacterIdMap(data?.videogameId);

  if (streamSet.value?.setId) {
    const allSets = (data?.buckets || []).flatMap((bucket) => bucket.sets || []);
    const matching = allSets.find((set) => set.id === streamSet.value.setId);
    if (matching) {
      const updated = createEditorSetFromTournamentSet(matching);
      updated.games.forEach((game, index) => {
        const previousGame = streamSet.value.games[index];
        if (!previousGame) return;
        game.player1Character = previousGame.player1Character;
        game.player2Character = previousGame.player2Character;
      });
      streamSet.value = updated;
    }
  }

  // Don't stomp the "hasn't synced" error reconcileBucketSync just set.
  if (!silent && !bucketJustLocked) {
    setSuccess(`Loaded ${data?.totalSets ?? 0} sets from ${data?.tournamentName ?? ""}.`);
  }
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

  const bucketId = findBucketIdForSetId(tournamentData.value?.buckets, editorSet.setId);
  const pending = bucketId ? bucketSync.get(bucketId) : null;

  if (pending?.locked) {
    setError(
      `"${pending.snapshot.name}" hasn't synced with start.gg yet - refresh the tournament manually before reporting more results there.`,
    );
    return;
  }

  if (mode === "stream") {
    submittingStream.value = true;
  } else {
    submittingQuickReport.value = true;
  }

  try {
    const gameData = buildGameData(editorSet);
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
      });
      applyOptimisticResult(pending.snapshot, editorSet.setId, editorSet, winnerId);

      setSuccess(`Saved locally - will sync to start.gg once "${pending.snapshot.name}" reloads.`);

      if (mode === "stream") {
        await writeOverlayFromStreamSet(true);
      }

      if (mode === "quick") {
        closeQuickReport();
      }
      return;
    }

    await reportSetResult({
      apiToken: config.apiToken,
      setId: editorSet.setId,
      winnerId,
      gameData: gameDataPayload,
    });

    setSuccess(`Reported set ${editorSet.setId} to start.gg.`);

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

    await finishTournamentRefresh();

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

// Pending bucket-sync state (and its retry timer) is only meaningful for
// whichever tournament it was created against - drop it if the user points
// this app at a different tournament or token, so a stale snapshot/retry
// from the old one can't leak into the new one's data.
watch(
  () => [config.apiToken, config.tournamentSlug],
  () => {
    bucketSync.clear();
    if (bucketSyncRetryTimer) {
      clearTimeout(bucketSyncRetryTimer);
      bucketSyncRetryTimer = null;
    }
  },
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
    configLoaded.value = true;

    configPanelOpen.value = !(config.apiToken && config.tournamentSlug);

    if (config.apiToken && config.tournamentSlug) {
      await refreshTournament();
    }
  } catch (err) {
    setError(`Could not load saved settings: ${String(err)}`);
    configLoaded.value = true;
  }

  if (!streamSet.value) {
    streamSet.value = emptyEditorSet();
  }
});

onBeforeUnmount(() => {
  if (overlayTimer) {
    clearTimeout(overlayTimer);
  }
  if (bucketSyncRetryTimer) {
    clearTimeout(bucketSyncRetryTimer);
  }
});

const showStatus = computed(() => Boolean(statusMessage.value));
const showError = computed(() => Boolean(errorMessage.value));
</script>

<template>
  <main class="app">
    <section class="config-panel">
      <header class="config-panel-header">
        <h1>Tournament Stream Manager</h1>
        <button type="button" class="collapse-toggle" @click="toggleConfigPanel">
          {{ configPanelOpen ? "Hide settings ▲" : "Show settings ▼" }}
        </button>
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
      <WebcamPanel v-if="configLoaded" v-model:camera-id="config.preferredCameraId" />

      <SetEditor
        title="On Stream Set"
        :set-data="streamSet"
        :characters="SMASH_ULTIMATE_CHARACTERS"
        :submitting="submittingStream"
        :writing-overlay="writingOverlay"
        :allow-swap="true"
        @set-best-of="onStreamBestOf"
        @set-player-name="onStreamPlayerName"
        @set-game-character="onStreamGameCharacter"
        @toggle-game-winner="onStreamToggleWinner"
        @swap-players="onStreamSwapPlayers"
        @apply-overlay="writeOverlayFromStreamSet(false)"
        @submit="onStreamSubmit"
      />
    </section>

    <BracketBoard
      :tournament-data="tournamentData"
      :active-bucket-id="activeBucketId"
      :bucket-sync-state="bucketSync"
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
          @set-game-character="onQuickGameCharacter"
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

.collapse-toggle {
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
