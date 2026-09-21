import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every backend call the app makes goes through Tauri's invoke; this stands
// in for the Rust side so the whole frontend flow (fetch -> edit -> report)
// can be exercised without a start.gg token or a running app.
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args) => invokeMock(...args),
}));

const App = (await import("../src/App.vue")).default;

const BASE_CONFIG = {
  apiToken: "token",
  tournamentSlug: "tournament/test/event/ultimate-singles",
  streamOutputPath: "/tmp/program_state.json",
  preferredCameraId: "",
  perPage: 128,
  autoWriteOverlay: true,
};

function openSet(overrides = {}) {
  return {
    id: "101",
    identifier: "A",
    roundText: "Winners Round 1",
    round: 1,
    eventName: "Ultimate Singles",
    phaseName: "Bracket",
    state: 1,
    winnerId: null,
    bestOf: 3,
    games: [],
    player1: { entrantId: 1, name: "Alice", score: 0 },
    player2: { entrantId: 2, name: "Bob", score: 0 },
    ...overrides,
  };
}

function reportedSet() {
  return openSet({
    id: "202",
    identifier: "B",
    state: 3,
    winnerId: 1,
    player1: { entrantId: 1, name: "Alice", score: 2 },
    player2: { entrantId: 2, name: "Bob", score: 0 },
    games: [
      { gameNum: 1, winnerEntrantId: 1 },
      { gameNum: 2, winnerEntrantId: 1 },
    ],
  });
}

let backend;

function tournamentPayload() {
  return {
    tournamentName: "Test Tourney",
    slug: BASE_CONFIG.tournamentSlug,
    totalSets: backend.sets.length,
    videogameId: 1386,
    buckets: [{ id: "b1", name: "Bracket", sets: backend.sets }],
  };
}

beforeEach(() => {
  backend = {
    config: { ...BASE_CONFIG },
    sets: [openSet(), reportedSet()],
    localResults: { version: 1, drafts: {} },
    // What start.gg reports back as the set's own start time, in epoch
    // seconds (null = it didn't tell us one).
    serverStartedAt: null,
    markSetInProgressFails: false,
  };

  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command, payload) => {
    switch (command) {
      case "load_app_config":
        return backend.config;
      case "save_app_config":
        backend.config = payload.config;
        return null;
      case "fetch_tournament_state":
        return tournamentPayload();
      case "fetch_game_characters":
        return [{ id: 1, name: "Fox" }];
      case "fetch_entrant_avatars":
        return { player1Avatar: null, player2Avatar: null };
      case "load_local_results":
        return backend.localResults;
      case "save_local_results":
        backend.localResults = payload.results;
        return null;
      case "report_set_result":
        return { success: true, message: "ok" };
      case "reset_set_result":
        return { success: true, message: "reset" };
      case "mark_set_in_progress":
        if (backend.markSetInProgressFails) {
          throw new Error("start.gg rejected the start");
        }
        return {
          success: true,
          message: "started",
          startedAt: backend.serverStartedAt,
        };
      case "write_stream_overlay":
        return null;
      case "get_platform":
        return "linux";
      default:
        throw new Error(`unexpected command ${command}`);
    }
  });
});

// Mounted apps keep a window keydown listener and (once a set timer is
// running) an interval, so leaving one mounted lets a finished test keep
// reacting to the next one's fake-timer ticks and invoke mock.
const mounted = [];

afterEach(() => {
  while (mounted.length) mounted.pop().unmount();
  vi.useRealTimers();
});

async function mountApp() {
  const wrapper = mount(App, {
    global: { stubs: { WebcamPanel: true } },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  await flushPromises();
  return wrapper;
}

function callsTo(command) {
  return invokeMock.mock.calls.filter(([name]) => name === command).map(([, payload]) => payload);
}

function lastCallTo(command) {
  return callsTo(command).at(-1);
}

function findButton(wrapper, text) {
  return wrapper.findAll("button").find((button) => button.text().includes(text));
}

function card(wrapper, index = 0) {
  return wrapper.findAll(".match-card")[index];
}

async function openQuickReport(wrapper, index = 0) {
  await card(wrapper, index).trigger("click");
  await flushPromises();
  return wrapper.find(".modal-card");
}

describe("App start-up and existing reporting flow", () => {
  it("loads settings and the tournament on mount", async () => {
    const wrapper = await mountApp();

    expect(lastCallTo("fetch_tournament_state").request).toMatchObject({
      apiToken: "token",
      tournamentSlug: BASE_CONFIG.tournamentSlug,
    });
    expect(wrapper.text()).toContain("Test Tourney");
    expect(wrapper.findAll(".match-card")).toHaveLength(2);
  });

  it("sends a set to the stream editor on right-click and writes the overlay", async () => {
    const wrapper = await mountApp();

    await card(wrapper).trigger("contextmenu");
    await flushPromises();

    expect(wrapper.find(".set-editor").text()).toContain("Winners Round 1");
    const overlay = lastCallTo("write_stream_overlay").request;
    expect(overlay.player1.name).toBe("Alice");
    expect(overlay.player2.name).toBe("Bob");
    expect(overlay.bestOf).toBe(3);
  });

  it("reports a played set with per-game data and closes the modal", async () => {
    const wrapper = await mountApp();
    const modal = await openQuickReport(wrapper);

    // Alice takes games 1 and 2.
    await modal.findAll(".win-btn")[0].trigger("click");
    await modal.findAll(".win-btn")[2].trigger("click");
    await findButton(modal, "Submit to start.gg").trigger("click");
    await flushPromises();

    const request = lastCallTo("report_set_result").request;
    expect(request).toMatchObject({ setId: "101", winnerId: 1, isDq: false });
    expect(request.gameData.map((game) => game.gameNum)).toEqual([1, 2]);
    expect(wrapper.find(".modal-card").exists()).toBe(false);
    expect(wrapper.text()).toContain("Reported set 101 to start.gg.");
  });

  it("refuses to report a set nobody has won", async () => {
    const wrapper = await mountApp();
    const modal = await openQuickReport(wrapper);

    await modal.findAll(".win-btn")[0].trigger("click");
    expect(findButton(modal, "Submit to start.gg").attributes("disabled")).toBeDefined();
    expect(callsTo("report_set_result")).toHaveLength(0);
  });
});

describe("App DQ reporting", () => {
  it("reports a DQ with the opponent as winner and no game data", async () => {
    const wrapper = await mountApp();
    const modal = await openQuickReport(wrapper);

    await modal.findAll(".dq-btn")[0].trigger("click");
    await findButton(modal, "Submit to start.gg").trigger("click");
    await flushPromises();

    expect(lastCallTo("report_set_result").request).toMatchObject({
      setId: "101",
      winnerId: 2,
      isDq: true,
      gameData: null,
    });
    expect(wrapper.text()).toContain("as a DQ");
  });

  it("reports a double DQ with no winner at all", async () => {
    const wrapper = await mountApp();
    const modal = await openQuickReport(wrapper);

    await modal.findAll(".dq-btn")[0].trigger("click");
    await modal.findAll(".dq-btn")[1].trigger("click");
    await findButton(modal, "Submit to start.gg").trigger("click");
    await flushPromises();

    expect(lastCallTo("report_set_result").request).toMatchObject({
      setId: "101",
      winnerId: null,
      isDq: true,
    });
  });

  it("ignores games already scored when a DQ is applied", async () => {
    const wrapper = await mountApp();
    const modal = await openQuickReport(wrapper);

    await modal.findAll(".win-btn")[0].trigger("click");
    await modal.findAll(".win-btn")[2].trigger("click");
    await modal.findAll(".dq-btn")[0].trigger("click");
    await findButton(modal, "Submit to start.gg").trigger("click");
    await flushPromises();

    expect(lastCallTo("report_set_result").request).toMatchObject({
      winnerId: 2,
      isDq: true,
      gameData: null,
    });
  });

  it("writes a DQ'd player's score to the overlay as start.gg's -1", async () => {
    const wrapper = await mountApp();

    await card(wrapper).trigger("contextmenu");
    await flushPromises();
    await wrapper.find(".set-editor").findAll(".dq-btn")[0].trigger("click");
    await findButton(wrapper, "Apply to Overlay").trigger("click");
    await flushPromises();

    const overlay = lastCallTo("write_stream_overlay").request;
    expect(overlay.player1.score).toBe(-1);
    expect(overlay.player2.score).toBe(0);
  });
});

describe("App editing and resetting reported results", () => {
  it("resets a reported set on start.gg and clears the editor", async () => {
    const wrapper = await mountApp();
    const modal = await openQuickReport(wrapper, 1);

    expect(modal.text()).toContain("Already reported on start.gg");

    await findButton(modal, "Reset result").trigger("click");
    await findButton(modal, "Confirm reset?").trigger("click");
    await flushPromises();

    expect(lastCallTo("reset_set_result").request).toMatchObject({
      setId: "202",
      resetDependentSets: false,
    });
    expect(wrapper.text()).toContain("Set 202 reset on start.gg.");
    // Scores are cleared, so the reopened set is no longer submittable.
    expect(wrapper.find(".modal-card").findAll(".score").map((n) => n.text())).toEqual(["0", "0"]);
  });

  it("keeps the existing scores when editing a reported result", async () => {
    const wrapper = await mountApp();
    const modal = await openQuickReport(wrapper, 1);

    await findButton(modal, "Edit result").trigger("click");
    await findButton(modal, "Confirm edit?").trigger("click");
    await flushPromises();

    expect(callsTo("reset_set_result")).toHaveLength(1);
    const card = wrapper.find(".modal-card");
    expect(card.findAll(".score").map((node) => node.text())).toEqual(["2", "0"]);
    // The reset reopened it, so the corrected result can be submitted again.
    expect(card.text()).not.toContain("Already reported on start.gg");
    expect(findButton(card, "Submit to start.gg").attributes("disabled")).toBeUndefined();
  });

  it("keeps the set reopened even if start.gg still serves the cached result", async () => {
    const wrapper = await mountApp();
    const modal = await openQuickReport(wrapper, 1);

    await findButton(modal, "Reset result").trigger("click");
    await findButton(modal, "Confirm reset?").trigger("click");
    await flushPromises();

    // The refetch above returned the set still marked complete (start.gg
    // caches for ~60s) - the editor must still show it as reopened.
    expect(wrapper.find(".modal-card").text()).not.toContain("Already reported on start.gg");
  });

  it("re-reports a corrected result after an edit", async () => {
    const wrapper = await mountApp();
    const modal = await openQuickReport(wrapper, 1);

    await findButton(modal, "Edit result").trigger("click");
    await findButton(modal, "Confirm edit?").trigger("click");
    await flushPromises();

    // Undo game 2 and give it to Bob instead - 1-1 isn't a finished set, so
    // it can't be submitted until a decider is scored.
    const reopened = wrapper.find(".modal-card");
    await reopened.findAll(".win-btn")[2].trigger("click");
    await reopened.findAll(".win-btn")[3].trigger("click");
    expect(findButton(reopened, "Submit to start.gg").attributes("disabled")).toBeDefined();

    await reopened.findAll(".win-btn")[5].trigger("click");
    await findButton(reopened, "Submit to start.gg").trigger("click");
    await flushPromises();

    const request = lastCallTo("report_set_result").request;
    expect(request).toMatchObject({ setId: "202", winnerId: 2, isDq: false });
    expect(request.gameData.map((game) => game.winnerId)).toEqual([1, 2, 2]);
  });
});

describe("App locally-saved results", () => {
  it("keeps a part-scored set when the modal is dismissed, and reminds the TO", async () => {
    const wrapper = await mountApp();
    const modal = await openQuickReport(wrapper);

    await modal.findAll(".win-btn")[0].trigger("click");
    await findButton(modal, "Close").trigger("click");
    await flushPromises();

    const saved = lastCallTo("save_local_results").results;
    expect(saved.drafts["101"].editorSet.games[0].winner).toBe(1);
    expect(saved.drafts["101"].tournamentSlug).toBe(BASE_CONFIG.tournamentSlug);
    expect(wrapper.text()).toContain("saved locally - remember to submit it to start.gg");
  });

  it("saves nothing for a set that was opened but never scored", async () => {
    const wrapper = await mountApp();
    const modal = await openQuickReport(wrapper);

    await findButton(modal, "Close").trigger("click");
    await flushPromises();

    expect(backend.localResults.drafts).toEqual({});
    expect(wrapper.text()).not.toContain("saved locally");
  });

  it("saves the result when the modal is clicked off", async () => {
    const wrapper = await mountApp();
    const modal = await openQuickReport(wrapper);

    await modal.findAll(".win-btn")[0].trigger("click");
    await wrapper.find(".modal-backdrop").trigger("click");
    await flushPromises();

    expect(backend.localResults.drafts["101"]).toBeDefined();
  });

  it("saves the result when the modal is dismissed with Escape", async () => {
    const wrapper = await mountApp();
    const modal = await openQuickReport(wrapper);

    await modal.findAll(".win-btn")[0].trigger("click");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flushPromises();

    expect(wrapper.find(".modal-card").exists()).toBe(false);
    expect(backend.localResults.drafts["101"]).toBeDefined();
  });

  it("flags the set on the bracket and restores it with a reminder on reopen", async () => {
    const wrapper = await mountApp();
    let modal = await openQuickReport(wrapper);

    await modal.findAll(".win-btn")[0].trigger("click");
    await findButton(modal, "Close").trigger("click");
    await flushPromises();

    expect(card(wrapper).classes()).toContain("drafted");
    expect(wrapper.find(".notice-draft").exists()).toBe(true);

    modal = await openQuickReport(wrapper);
    expect(modal.findAll(".score").map((node) => node.text())).toEqual(["1", "0"]);
    expect(modal.find(".notice-draft").text()).toContain("remember to submit to start.gg");
  });

  it("keeps a part-scored set when it is pulled off stream for another one", async () => {
    const wrapper = await mountApp();

    await card(wrapper).trigger("contextmenu");
    await flushPromises();
    await wrapper.find(".set-editor").findAll(".win-btn")[0].trigger("click");

    await card(wrapper, 1).trigger("contextmenu");
    await flushPromises();

    expect(backend.localResults.drafts["101"].editorSet.games[0].winner).toBe(1);
  });

  it("discards the local copy once the set is reported", async () => {
    const wrapper = await mountApp();
    let modal = await openQuickReport(wrapper);

    await modal.findAll(".win-btn")[0].trigger("click");
    await findButton(modal, "Close").trigger("click");
    await flushPromises();
    expect(backend.localResults.drafts["101"]).toBeDefined();

    modal = await openQuickReport(wrapper);
    await modal.findAll(".win-btn")[2].trigger("click");
    await findButton(modal, "Submit to start.gg").trigger("click");
    await flushPromises();

    expect(backend.localResults.drafts["101"]).toBeUndefined();
    expect(wrapper.find(".notice-draft").exists()).toBe(false);
  });

  it("reports locally-saved results left over from a previous session", async () => {
    backend.localResults = {
      version: 1,
      drafts: {
        "101": {
          setId: "101",
          tournamentSlug: BASE_CONFIG.tournamentSlug,
          savedAt: Date.now() - 60_000,
          editorSet: {
            setId: "101",
            bestOf: 3,
            dq: null,
            completed: false,
            player1: { entrantId: 1, name: "Alice" },
            player2: { entrantId: 2, name: "Bob" },
            games: [
              { winner: 1, player1Character: "", player2Character: "" },
              { winner: null, player1Character: "", player2Character: "" },
              { winner: null, player1Character: "", player2Character: "" },
            ],
          },
        },
      },
    };

    const wrapper = await mountApp();

    expect(wrapper.text()).toContain("1 locally-saved result not yet submitted to start.gg.");
    expect(card(wrapper).classes()).toContain("drafted");
  });

  it("drops a local result for a set start.gg has since completed", async () => {
    backend.localResults = {
      version: 1,
      drafts: {
        "202": {
          setId: "202",
          tournamentSlug: BASE_CONFIG.tournamentSlug,
          savedAt: Date.now() - 60_000,
          editorSet: {
            setId: "202",
            bestOf: 3,
            dq: null,
            completed: false,
            player1: { entrantId: 1, name: "Alice" },
            player2: { entrantId: 2, name: "Bob" },
            games: [{ winner: 2, player1Character: "", player2Character: "" }],
          },
        },
      },
    };

    const wrapper = await mountApp();
    const modal = await openQuickReport(wrapper, 1);
    await flushPromises();

    // start.gg's own 2-0 result wins over the stale local copy.
    expect(modal.findAll(".score").map((node) => node.text())).toEqual(["2", "0"]);
    expect(backend.localResults.drafts["202"]).toBeUndefined();
  });
});

describe("App set timers", () => {
  it("starts, pauses and resets the stream set's timer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const wrapper = await mountApp();

    await card(wrapper).trigger("contextmenu");
    await flushPromises();

    const editor = wrapper.find(".set-editor");
    expect(editor.find(".timer-clock").text()).toBe("0:00");

    await findButton(editor, "Start").trigger("click");
    vi.advanceTimersByTime(65_000);
    await flushPromises();
    expect(wrapper.find(".timer-clock").text()).toBe("1:05");

    await findButton(wrapper.find(".set-editor"), "Pause").trigger("click");
    vi.advanceTimersByTime(30_000);
    await flushPromises();
    expect(wrapper.find(".timer-clock").text()).toBe("1:05");

    // The set was started on start.gg, so clearing the clock un-starts it
    // there too - which takes a confirming second click.
    await findButton(wrapper.find(".set-editor"), "Reset").trigger("click");
    await findButton(wrapper.find(".set-editor"), "Confirm un-start?").trigger("click");
    await flushPromises();
    expect(wrapper.find(".timer-clock").text()).toBe("0:00");
  });

  it("keeps counting up for as long as the set runs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const wrapper = await mountApp();

    await card(wrapper).trigger("contextmenu");
    await flushPromises();

    await findButton(wrapper.find(".set-editor"), "Start").trigger("click");
    vi.advanceTimersByTime(23 * 60_000);
    await flushPromises();

    // No target length to run past - a set takes as long as it takes.
    expect(wrapper.find(".timer-clock").text()).toBe("23:00");
  });

  it("publishes the running clock to the overlay payload", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const wrapper = await mountApp();

    await card(wrapper).trigger("contextmenu");
    await flushPromises();
    await findButton(wrapper.find(".set-editor"), "Start").trigger("click");
    vi.advanceTimersByTime(65_000);
    await flushPromises();

    expect(lastCallTo("write_stream_overlay").request.timer).toEqual({
      display: "1:05",
      running: true,
      elapsedSeconds: 65,
    });
  });

  it("keeps a timer running while its set moves between editors", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const wrapper = await mountApp();

    await card(wrapper).trigger("contextmenu");
    await flushPromises();
    await findButton(wrapper.find(".set-editor"), "Start").trigger("click");
    vi.advanceTimersByTime(30_000);
    await flushPromises();

    const modal = await openQuickReport(wrapper);
    expect(modal.find(".timer-clock").text()).toBe("0:30");
  });
});

describe("App set timers against start.gg's set clock", () => {
  const NOW = new Date("2026-01-01T00:00:00Z");

  function useClock() {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  }

  async function startStreamSetTimer(wrapper, index = 0) {
    await card(wrapper, index).trigger("contextmenu");
    await flushPromises();
    await findButton(wrapper.find(".set-editor"), "Start set").trigger("click");
    await flushPromises();
  }

  it("starts the set on start.gg when the timer is started", async () => {
    useClock();
    const wrapper = await mountApp();

    await startStreamSetTimer(wrapper);

    expect(lastCallTo("mark_set_in_progress").request).toEqual({
      apiToken: "token",
      setId: "101",
    });
    expect(wrapper.text()).toContain("Set 101 started on start.gg");
    expect(wrapper.find(".timer-note").text()).toContain("In progress on start.gg");
  });

  it("anchors the clock to start.gg's own start time", async () => {
    useClock();
    // start.gg says the set actually started two minutes ago.
    backend.serverStartedAt = Math.floor(NOW.getTime() / 1000) - 120;
    const wrapper = await mountApp();

    await startStreamSetTimer(wrapper);

    expect(wrapper.find(".timer-clock").text()).toBe("2:00");
  });

  it("does not start the set again when a paused timer is resumed", async () => {
    useClock();
    const wrapper = await mountApp();

    await startStreamSetTimer(wrapper);
    await findButton(wrapper.find(".set-editor"), "Pause").trigger("click");
    await flushPromises();
    await findButton(wrapper.find(".set-editor"), "Resume").trigger("click");
    await flushPromises();

    expect(callsTo("mark_set_in_progress")).toHaveLength(1);
  });

  it("keeps pausing local - start.gg has no paused state", async () => {
    useClock();
    const wrapper = await mountApp();

    await startStreamSetTimer(wrapper);
    await findButton(wrapper.find(".set-editor"), "Pause").trigger("click");
    await flushPromises();

    expect(callsTo("reset_set_result")).toHaveLength(0);
    expect(wrapper.find(".timer-note").text()).toContain("Paused here only");
  });

  it("keeps the local clock running when start.gg rejects the start", async () => {
    useClock();
    backend.markSetInProgressFails = true;
    const wrapper = await mountApp();

    await startStreamSetTimer(wrapper);
    vi.advanceTimersByTime(10_000);
    await flushPromises();

    expect(wrapper.text()).toContain("start.gg didn't accept the start");
    expect(wrapper.find(".timer-clock").text()).toBe("0:10");
    // Not marked as started there, so a later retry is still possible.
    expect(wrapper.find(".timer-note").exists()).toBe(false);
  });

  it("runs locally without calling start.gg for a set that doesn't exist there yet", async () => {
    useClock();
    backend.sets = [openSet({ id: "preview_123_1_0" }), reportedSet()];
    const wrapper = await mountApp();

    await startStreamSetTimer(wrapper);

    expect(callsTo("mark_set_in_progress")).toHaveLength(0);
    expect(wrapper.text()).toContain("hasn't been started on start.gg yet");
    expect(wrapper.find(".timer-clock").text()).toBe("0:00");
  });

  it("stops the timer once the result has been submitted", async () => {
    useClock();
    const wrapper = await mountApp();

    await startStreamSetTimer(wrapper);
    vi.advanceTimersByTime(65_000);
    await flushPromises();

    const editor = wrapper.find(".set-editor");
    await editor.findAll(".win-btn")[0].trigger("click");
    await editor.findAll(".win-btn")[2].trigger("click");
    await findButton(wrapper.find(".set-editor"), "Submit to start.gg").trigger("click");
    await flushPromises();

    // Frozen at the time the set took, and no longer ticking.
    expect(wrapper.find(".timer-clock").text()).toBe("1:05");
    vi.advanceTimersByTime(30_000);
    await flushPromises();
    expect(wrapper.find(".timer-clock").text()).toBe("1:05");
  });

  it("stops the timer when the result is a DQ", async () => {
    useClock();
    const wrapper = await mountApp();

    await startStreamSetTimer(wrapper);
    vi.advanceTimersByTime(20_000);
    await flushPromises();

    await wrapper.find(".set-editor").findAll(".dq-btn")[0].trigger("click");
    await findButton(wrapper.find(".set-editor"), "Submit to start.gg").trigger("click");
    await flushPromises();

    vi.advanceTimersByTime(30_000);
    await flushPromises();
    expect(wrapper.find(".timer-clock").text()).toBe("0:20");
  });

  it("un-starts the set on start.gg when its timer is reset", async () => {
    useClock();
    const wrapper = await mountApp();

    await startStreamSetTimer(wrapper);

    // Touching start.gg takes a confirming second click.
    await findButton(wrapper.find(".set-editor"), "Reset").trigger("click");
    await flushPromises();
    expect(callsTo("reset_set_result")).toHaveLength(0);

    await findButton(wrapper.find(".set-editor"), "Confirm un-start?").trigger("click");
    await flushPromises();

    expect(lastCallTo("reset_set_result").request).toMatchObject({ setId: "101" });
    expect(wrapper.find(".timer-clock").text()).toBe("0:00");
    expect(wrapper.text()).toContain("no longer in progress on start.gg");
  });

  it("leaves start.gg alone when resetting a purely local timer", async () => {
    useClock();
    backend.markSetInProgressFails = true;
    const wrapper = await mountApp();

    await startStreamSetTimer(wrapper);
    await findButton(wrapper.find(".set-editor"), "Reset").trigger("click");
    await flushPromises();

    expect(callsTo("reset_set_result")).toHaveLength(0);
    expect(wrapper.find(".timer-clock").text()).toBe("0:00");
  });

  it("adopts the elapsed time of a set start.gg already has in progress", async () => {
    useClock();
    backend.sets = [
      openSet({ state: 2, startedAt: Math.floor(NOW.getTime() / 1000) - 180 }),
      reportedSet(),
    ];
    const wrapper = await mountApp();

    await card(wrapper).trigger("contextmenu");
    await flushPromises();

    // Three minutes in, still running - and not started a second time.
    expect(wrapper.find(".timer-clock").text()).toBe("3:00");
    expect(wrapper.find(".timer-state").text()).toBe("Running");
    expect(callsTo("mark_set_in_progress")).toHaveLength(0);
  });

  it("shows a completed set's timer as the duration start.gg recorded", async () => {
    useClock();
    const started = Math.floor(NOW.getTime() / 1000) - 3_600;
    backend.sets = [
      openSet(),
      { ...reportedSet(), startedAt: started, completedAt: started + 432 },
    ];
    const wrapper = await mountApp();

    const modal = await openQuickReport(wrapper, 1);

    expect(modal.find(".timer-clock").text()).toBe("7:12");
    expect(modal.find(".timer-state").text()).toBe("Final");
    expect(findButton(modal, "Start set")).toBeUndefined();
  });

  it("does not stomp a running local timer with start.gg's start time", async () => {
    useClock();
    const wrapper = await mountApp();

    await startStreamSetTimer(wrapper);
    vi.advanceTimersByTime(30_000);
    await flushPromises();

    // A refresh brings back the same set, now in progress per start.gg with
    // a start time an hour ago - the live local clock must survive it.
    backend.sets = [
      openSet({ state: 2, startedAt: Math.floor(NOW.getTime() / 1000) - 3_600 }),
      reportedSet(),
    ];
    await findButton(wrapper, "Refresh Tournament").trigger("click");
    await flushPromises();

    expect(wrapper.find(".timer-clock").text()).toBe("0:30");
  });

  it("clears timers when the app is pointed at a different tournament", async () => {
    useClock();
    const wrapper = await mountApp();

    await startStreamSetTimer(wrapper);
    vi.advanceTimersByTime(30_000);
    await flushPromises();
    expect(wrapper.find(".timer-clock").text()).toBe("0:30");

    await wrapper.findAll('input[type="text"]')[0].setValue("tournament/other/event/singles");
    await flushPromises();

    expect(wrapper.find(".timer-clock").text()).toBe("0:00");
  });
});

describe("App in-progress indicator on the bracket view", () => {
  const NOW = new Date("2026-01-01T00:00:00Z");

  it("shows a live clock on the bracket for a set that has been started", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const wrapper = await mountApp();

    await card(wrapper).trigger("contextmenu");
    await flushPromises();
    await findButton(wrapper.find(".set-editor"), "Start set").trigger("click");
    vi.advanceTimersByTime(95_000);
    await flushPromises();

    const started = card(wrapper);
    expect(started.find(".match-timer").text()).toContain("1:35");
    expect(started.classes()).toContain("in-progress");
    expect(wrapper.find(".summary-live").text()).toContain("1 in progress");

    // The other set on the board hasn't been started, so it has no clock.
    expect(card(wrapper, 1).find(".match-timer").exists()).toBe(false);
  });

  it("shows clocks for sets start.gg already has in progress, without opening them", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    backend.sets = [
      openSet({ state: 2, startedAt: Math.floor(NOW.getTime() / 1000) - 240 }),
      reportedSet(),
    ];

    const wrapper = await mountApp();

    expect(card(wrapper).find(".match-timer").text()).toContain("4:00");
    expect(callsTo("mark_set_in_progress")).toHaveLength(0);
  });

  it("drops the clock off the board once the set is reported", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const wrapper = await mountApp();

    await card(wrapper).trigger("contextmenu");
    await flushPromises();
    await findButton(wrapper.find(".set-editor"), "Start set").trigger("click");
    vi.advanceTimersByTime(30_000);
    await flushPromises();
    expect(card(wrapper).find(".match-timer").exists()).toBe(true);

    // Reporting it completes the set, so the card goes back to showing the
    // score rather than a clock.
    const editor = wrapper.find(".set-editor");
    await editor.findAll(".win-btn")[0].trigger("click");
    await editor.findAll(".win-btn")[2].trigger("click");
    backend.sets = [{ ...openSet(), state: 3, winnerId: 1 }, reportedSet()];
    await findButton(wrapper.find(".set-editor"), "Submit to start.gg").trigger("click");
    await flushPromises();

    expect(card(wrapper).find(".match-timer").exists()).toBe(false);
    expect(wrapper.find(".summary-live").exists()).toBe(false);
  });

  it("shows the clock in the pool grid as well", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    backend.sets = [
      openSet({
        round: 0,
        roundText: "",
        phaseName: "Pools",
        state: 2,
        startedAt: Math.floor(NOW.getTime() / 1000) - 90,
      }),
    ];

    const wrapper = await mountApp();

    const cell = wrapper.findAll(".pool-cell").find((node) => node.find(".pool-timer").exists());
    expect(cell.find(".pool-timer").text()).toContain("1:30");
    expect(cell.classes()).toContain("in-progress");
  });
});
