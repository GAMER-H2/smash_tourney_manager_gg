import { describe, expect, it } from "vitest";
import {
  createTimerState,
  elapsedMs,
  formatClock,
  frozenTimer,
  isRunning,
  pauseTimer,
  resetTimer,
  startTimer,
  timerDisplay,
  timerFromServerStart,
  timerOverlayPayload,
  toggleTimer,
} from "../src/lib/timer";

const T0 = 1_700_000_000_000;

describe("set timer", () => {
  it("starts stopped at zero", () => {
    const state = createTimerState();
    expect(isRunning(state)).toBe(false);
    expect(elapsedMs(state, T0)).toBe(0);
    expect(timerDisplay(state, T0)).toBe("0:00");
  });

  it("accumulates elapsed time from the wall clock while running", () => {
    const running = startTimer(createTimerState(), T0);
    expect(isRunning(running)).toBe(true);
    expect(elapsedMs(running, T0 + 30_000)).toBe(30_000);
  });

  it("banks elapsed time across pause/resume cycles", () => {
    let state = startTimer(createTimerState(), T0);
    state = pauseTimer(state, T0 + 30_000);
    expect(isRunning(state)).toBe(false);
    // Time passing while paused doesn't count.
    expect(elapsedMs(state, T0 + 90_000)).toBe(30_000);

    state = startTimer(state, T0 + 90_000);
    expect(elapsedMs(state, T0 + 100_000)).toBe(40_000);
  });

  it("ignores a redundant start or pause", () => {
    const running = startTimer(createTimerState(), T0);
    expect(startTimer(running, T0 + 5_000).startedAt).toBe(T0);

    const paused = createTimerState();
    expect(pauseTimer(paused, T0).accumulatedMs).toBe(0);
  });

  it("toggles between running and paused", () => {
    const started = toggleTimer(createTimerState(), T0);
    expect(isRunning(started)).toBe(true);
    const paused = toggleTimer(started, T0 + 5_000);
    expect(isRunning(paused)).toBe(false);
    expect(elapsedMs(paused, T0 + 60_000)).toBe(5_000);
  });

  it("resets to zero and stopped", () => {
    let state = startTimer(createTimerState(), T0);
    state = resetTimer(pauseTimer(state, T0 + 60_000));
    expect(elapsedMs(state, T0 + 60_000)).toBe(0);
    expect(isRunning(state)).toBe(false);
  });

  it("counts up for as long as the set needs, with no target to run past", () => {
    const state = startTimer(createTimerState(), T0);
    expect(timerDisplay(state, T0 + 65_000)).toBe("1:05");
    expect(timerDisplay(state, T0 + 20 * 60_000)).toBe("20:00");
    expect(timerDisplay(state, T0 + 70 * 60_000)).toBe("1:10:00");
  });

  it("formats clocks as mm:ss, rolling over to h:mm:ss past an hour", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(9)).toBe("0:09");
    expect(formatClock(485)).toBe("8:05");
    expect(formatClock(3725)).toBe("1:02:05");
    // Elapsed time can't be negative; anything odd reads as zero.
    expect(formatClock(-65)).toBe("0:00");
  });

  it("omits an untouched timer from the overlay payload", () => {
    expect(timerOverlayPayload(createTimerState(), T0)).toBeNull();
    expect(timerOverlayPayload(null, T0)).toBeNull();
  });

  it("describes a running timer for the overlay", () => {
    const state = startTimer(createTimerState(), T0);
    expect(timerOverlayPayload(state, T0 + 65_000)).toEqual({
      display: "1:05",
      running: true,
      elapsedSeconds: 65,
    });
  });

  it("still reports a paused timer that has time on it", () => {
    const state = pauseTimer(startTimer(createTimerState(), T0), T0 + 12_000);
    expect(timerOverlayPayload(state, T0 + 99_000)).toEqual({
      display: "0:12",
      running: false,
      elapsedSeconds: 12,
    });
  });

  it("carries the start.gg link through start, pause and resume", () => {
    const started = { ...createTimerState(), startedOnStartgg: true };
    const running = startTimer(started, T0);
    expect(running.startedOnStartgg).toBe(true);
    expect(pauseTimer(running, T0 + 1_000).startedOnStartgg).toBe(true);
  });

  it("drops the start.gg link on reset - the set is no longer started", () => {
    expect(resetTimer().startedOnStartgg).toBe(false);
  });
});

describe("anchoring to start.gg's own set clock", () => {
  it("counts from start.gg's startedAt rather than from zero", () => {
    const state = timerFromServerStart(T0 / 1000 - 120, T0);

    expect(isRunning(state)).toBe(true);
    expect(state.startedOnStartgg).toBe(true);
    expect(elapsedMs(state, T0)).toBe(120_000);
    expect(timerDisplay(state, T0)).toBe("2:00");
  });

  it("clamps a startedAt in the future back to now", () => {
    // start.gg's timestamps come from its servers, so a machine whose clock
    // is behind would otherwise render a set as counting backwards.
    const state = timerFromServerStart(T0 / 1000 + 3_600, T0);
    expect(elapsedMs(state, T0)).toBe(0);
    expect(timerDisplay(state, T0)).toBe("0:00");
  });

  it("refuses to anchor to a missing or nonsensical timestamp", () => {
    expect(timerFromServerStart(null, T0)).toBeNull();
    expect(timerFromServerStart(0, T0)).toBeNull();
    expect(timerFromServerStart(-5, T0)).toBeNull();
    expect(timerFromServerStart("not a time", T0)).toBeNull();
  });

  it("freezes a finished set at the duration it actually took", () => {
    const state = frozenTimer(9 * 60_000);

    expect(isRunning(state)).toBe(false);
    expect(state.startedOnStartgg).toBe(false);
    expect(elapsedMs(state, T0)).toBe(540_000);
    expect(timerDisplay(state, T0)).toBe("9:00");
  });

  it("treats a negative or junk duration as zero", () => {
    expect(elapsedMs(frozenTimer(-500), T0)).toBe(0);
    expect(elapsedMs(frozenTimer(undefined), T0)).toBe(0);
  });
});
