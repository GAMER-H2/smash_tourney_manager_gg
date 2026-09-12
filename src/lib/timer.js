// Set timers.
//
// These mirror start.gg's own set clock: a set is started, the clock counts
// up from zero for as long as the set needs, and reporting the result stops
// it. There's deliberately no target length or countdown - a set takes as
// long as it takes.
//
// A timer is stored as plain data - when it was last started and how much
// time had already accumulated before that - rather than as a ticking
// counter. Elapsed time is derived from the wall clock on read, so a timer
// stays correct across a paused/throttled webview (Tauri backgrounds the
// renderer when the window is hidden, which would otherwise silently drop
// seconds from a ticking counter) and is trivially testable by passing a
// `now`.

export function createTimerState() {
  return {
    // Epoch ms of the most recent start, or null while paused/never started.
    startedAt: null,
    // Time banked by earlier start/pause cycles, in ms.
    accumulatedMs: 0,
    // True once start.gg has this set marked in progress - i.e. its own set
    // clock is running too, and only reporting the result stops it. Pausing
    // here doesn't clear this, because pausing is local to this app.
    startedOnStartgg: false,
  };
}

// A timer for a set start.gg already has in progress, anchored to start.gg's
// own `startedAt` (epoch seconds) so both clocks read the same rather than
// restarting from zero whenever this app happens to look at the set.
//
// start.gg's timestamp comes from its servers, so it can disagree with the
// local clock: a timestamp in the future (clock skew) would otherwise render
// as a set that hasn't started yet and count backwards, so it's clamped to
// "just started". Anything non-numeric or non-positive is no anchor at all.
export function timerFromServerStart(startedAtSeconds, now = Date.now()) {
  const seconds = Number(startedAtSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;

  return {
    ...createTimerState(),
    startedAt: Math.min(seconds * 1000, now),
    startedOnStartgg: true,
  };
}

// A stopped timer showing a fixed duration - used for a set start.gg has
// already completed, where the set's real length is the gap between its
// start and completion rather than anything this app measured.
export function frozenTimer(elapsed) {
  return {
    ...createTimerState(),
    accumulatedMs: Math.max(0, Number(elapsed) || 0),
  };
}

export function isRunning(state) {
  return Boolean(state?.startedAt);
}

export function elapsedMs(state, now = Date.now()) {
  if (!state) return 0;
  const banked = Math.max(0, state.accumulatedMs || 0);
  if (!state.startedAt) return banked;
  return banked + Math.max(0, now - state.startedAt);
}

export function startTimer(state, now = Date.now()) {
  if (isRunning(state)) return { ...state };
  return { ...state, startedAt: now };
}

export function pauseTimer(state, now = Date.now()) {
  if (!isRunning(state)) return { ...state };
  return { ...state, startedAt: null, accumulatedMs: elapsedMs(state, now) };
}

export function toggleTimer(state, now = Date.now()) {
  return isRunning(state) ? pauseTimer(state, now) : startTimer(state, now);
}

// Back to zero and stopped, and no longer considered started on start.gg -
// resetting a timer means the set hasn't started after all, which is only
// truthful if the set is un-started there too (see App's reset handling).
export function resetTimer() {
  return createTimerState();
}

// mm:ss, or h:mm:ss once a set passes an hour.
export function formatClock(totalSeconds) {
  const rounded = Math.max(0, Math.trunc(Number(totalSeconds) || 0));

  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const seconds = rounded % 60;
  const pad = (value) => String(value).padStart(2, "0");

  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  return `${minutes}:${pad(seconds)}`;
}

export function timerDisplay(state, now = Date.now()) {
  return formatClock(Math.floor(elapsedMs(state, now) / 1000));
}

// The timer block handed to the overlay writer (and so on to stream
// layouts). Returns null when the timer has never been started and has no
// time on it, so an untouched timer doesn't clutter the overlay payload.
export function timerOverlayPayload(state, now = Date.now()) {
  if (!state) return null;
  const elapsed = elapsedMs(state, now);
  if (!isRunning(state) && elapsed === 0) return null;

  return {
    display: timerDisplay(state, now),
    running: isRunning(state),
    elapsedSeconds: Math.floor(elapsed / 1000),
  };
}
