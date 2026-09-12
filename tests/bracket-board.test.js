import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import BracketBoard from "../src/components/BracketBoard.vue";

function bracketSet(overrides = {}) {
  return {
    id: "w1",
    identifier: "A",
    roundText: "Winners Round 1",
    round: 1,
    state: 1,
    winnerId: null,
    player1: { entrantId: 1, name: "Alice", score: 0 },
    player2: { entrantId: 2, name: "Bob", score: 0 },
    ...overrides,
  };
}

function tournamentData(sets, bucket = {}) {
  return {
    tournamentName: "Test Tourney",
    totalSets: sets.length,
    buckets: [{ id: "b1", name: "Bracket", sets, ...bucket }],
  };
}

function mountBoard(props = {}) {
  return mount(BracketBoard, {
    props: { tournamentData: tournamentData([bracketSet()]), activeBucketId: "b1", ...props },
  });
}

describe("BracketBoard basics", () => {
  it("prompts to load a tournament when there is none", () => {
    const wrapper = mount(BracketBoard, { props: { tournamentData: null } });
    expect(wrapper.text()).toContain("Load a tournament to view sets.");
  });

  it("renders a card per set with both players", () => {
    const wrapper = mountBoard();
    expect(wrapper.findAll(".match-card")).toHaveLength(1);
    expect(wrapper.text()).toContain("Alice");
    expect(wrapper.text()).toContain("Bob");
  });

  it("left-click quick-reports and right-click sends to the stream editor", async () => {
    const wrapper = mountBoard();

    await wrapper.find(".match-card").trigger("click");
    expect(wrapper.emitted("quick-report")[0][0].id).toBe("w1");

    await wrapper.find(".match-card").trigger("contextmenu");
    expect(wrapper.emitted("set-on-stream")[0][0].id).toBe("w1");
  });

  it("highlights the winning slot of a reported set", () => {
    const wrapper = mountBoard({
      tournamentData: tournamentData([
        bracketSet({
          state: 3,
          winnerId: 2,
          player1: { entrantId: 1, name: "Alice", score: 1 },
          player2: { entrantId: 2, name: "Bob", score: 2 },
        }),
      ]),
    });

    const slots = wrapper.findAll(".slot-row");
    expect(slots[0].classes()).not.toContain("winner");
    expect(slots[1].classes()).toContain("winner");
  });

  it("blocks interaction with a bucket that hasn't synced", async () => {
    const wrapper = mountBoard({
      bucketSyncState: new Map([["b1", { locked: true, attempts: 9, snapshot: { name: "Bracket" } }]]),
    });

    expect(wrapper.find(".notice-locked").exists()).toBe(true);
    await wrapper.find(".match-card").trigger("click");
    expect(wrapper.emitted("quick-report")).toBeUndefined();
  });

  it("switches buckets via the tabs", async () => {
    const data = tournamentData([bracketSet()]);
    data.buckets.push({ id: "b2", name: "Pool 1", sets: [] });
    const wrapper = mountBoard({ tournamentData: data });

    await wrapper.findAll(".tab")[1].trigger("click");
    expect(wrapper.emitted("update:activeBucketId")[0]).toEqual(["b2"]);
  });
});

describe("BracketBoard DQ and locally-saved results", () => {
  it("shows a DQ'd entrant's -1 score as DQ", () => {
    const wrapper = mountBoard({
      tournamentData: tournamentData([
        bracketSet({
          state: 3,
          winnerId: 2,
          player1: { entrantId: 1, name: "Alice", score: -1 },
          player2: { entrantId: 2, name: "Bob", score: 0 },
        }),
      ]),
    });

    expect(wrapper.findAll(".slot-score").map((node) => node.text())).toEqual(["DQ", "0"]);
  });

  it("flags sets carrying an unsubmitted local result", () => {
    const wrapper = mountBoard({ draftedSetIds: new Set(["w1"]) });

    expect(wrapper.find(".match-card").classes()).toContain("drafted");
    expect(wrapper.find(".draft-badge").exists()).toBe(true);
    expect(wrapper.find(".notice-draft").text()).toContain(
      "1 set here has a locally-saved result",
    );
  });

  it("leaves sets without a local result unflagged", () => {
    const wrapper = mountBoard({ draftedSetIds: new Set(["other"]) });
    expect(wrapper.find(".match-card").classes()).not.toContain("drafted");
    expect(wrapper.find(".notice-draft").exists()).toBe(false);
  });

  it("marks pool cells with a local result and shows pool DQ scores", () => {
    const poolSet = bracketSet({
      id: "p1",
      round: 0,
      roundText: "",
      state: 3,
      winnerId: 2,
      player1: { entrantId: 1, name: "Alice", score: -1 },
      player2: { entrantId: 2, name: "Bob", score: 0 },
    });

    const wrapper = mountBoard({
      tournamentData: tournamentData([poolSet]),
      draftedSetIds: new Set(["p1"]),
    });

    const cells = wrapper.findAll(".pool-cell").filter((cell) => cell.classes().includes("drafted"));
    expect(cells.length).toBeGreaterThan(0);
    expect(wrapper.find(".pool-score").text().replace(/\s+/g, " ")).toBe("DQ - 0");
  });
});

describe("BracketBoard in-progress set timers", () => {
  it("shows no timer on a set that hasn't started", () => {
    const wrapper = mountBoard();
    expect(wrapper.find(".match-timer").exists()).toBe(false);
    expect(wrapper.find(".match-card").classes()).not.toContain("in-progress");
    expect(wrapper.find(".summary-live").exists()).toBe(false);
  });

  it("shows a running clock on an in-progress set", () => {
    const wrapper = mountBoard({
      setTimers: new Map([["w1", { display: "3:20", running: true }]]),
    });

    const badge = wrapper.find(".match-timer");
    expect(badge.text()).toContain("3:20");
    expect(badge.classes()).toContain("running");
    expect(wrapper.find(".match-card").classes()).toContain("in-progress");
    expect(wrapper.find(".summary-live").text()).toContain("1 in progress");
  });

  it("distinguishes a started set whose clock is paused", () => {
    const wrapper = mountBoard({
      setTimers: new Map([["w1", { display: "3:20", running: false }]]),
    });

    expect(wrapper.find(".match-timer").classes()).not.toContain("running");
    expect(wrapper.find(".match-card").classes()).not.toContain("in-progress");
    // A paused set isn't "in progress" for the header count.
    expect(wrapper.find(".summary-live").exists()).toBe(false);
  });

  it("only puts a clock on the sets that have one", () => {
    const data = tournamentData([
      bracketSet({ id: "w1", identifier: "A" }),
      bracketSet({ id: "w2", identifier: "B" }),
    ]);
    const wrapper = mountBoard({
      tournamentData: data,
      setTimers: new Map([["w2", { display: "0:45", running: true }]]),
    });

    const cards = wrapper.findAll(".match-card");
    expect(cards[0].find(".match-timer").exists()).toBe(false);
    expect(cards[1].find(".match-timer").text()).toContain("0:45");
  });

  it("shows clocks in the pool grid too", () => {
    const poolSet = bracketSet({ id: "p1", round: 0, roundText: "" });
    const wrapper = mountBoard({
      tournamentData: tournamentData([poolSet]),
      setTimers: new Map([["p1", { display: "5:05", running: true }]]),
    });

    const cell = wrapper.findAll(".pool-cell").find((node) => node.find(".pool-timer").exists());
    expect(cell.find(".pool-timer").text()).toContain("5:05");
    expect(cell.classes()).toContain("in-progress");
  });
});
