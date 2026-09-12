import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import SetEditor from "../src/components/SetEditor.vue";
import { emptyEditorSet, emptyGame } from "../src/lib/set-utils";

function setData({ games = [null, null, null], ...overrides } = {}) {
  const set = emptyEditorSet();
  set.setId = "101";
  set.bestOf = 3;
  set.player1 = { entrantId: 1, name: "Alice" };
  set.player2 = { entrantId: 2, name: "Bob" };
  set.games = games.map((winner) => ({ ...emptyGame(), winner }));
  return { ...set, ...overrides };
}

function mountEditor(props = {}) {
  return mount(SetEditor, {
    props: { setData: setData(), characters: ["Fox", "Mario"], ...props },
  });
}

function buttonWithText(wrapper, text) {
  return wrapper.findAll("button").find((button) => button.text().includes(text));
}

describe("SetEditor basics", () => {
  it("shows an empty state with no set", () => {
    const wrapper = mount(SetEditor, { props: { setData: null } });
    expect(wrapper.text()).toContain("No set selected yet.");
  });

  it("renders one row per game of the format and the running score", () => {
    const wrapper = mountEditor({ setData: setData({ games: [1, 2, 1] }) });
    expect(wrapper.findAll(".game-row")).toHaveLength(3);
    expect(wrapper.findAll(".score").map((node) => node.text())).toEqual(["2", "1"]);

    const bo5 = mountEditor({ setData: setData({ bestOf: 5, games: [null, null, null, null, null] }) });
    expect(bo5.findAll(".game-row")).toHaveLength(5);
  });

  it("emits game winners, names, characters and format changes", async () => {
    const wrapper = mountEditor();

    await wrapper.findAll(".win-btn")[0].trigger("click");
    expect(wrapper.emitted("toggle-game-winner")[0]).toEqual([{ index: 0, winner: 1 }]);

    await wrapper.findAll("input")[0].setValue("Carol");
    expect(wrapper.emitted("set-player-name")[0]).toEqual([{ player: 1, value: "Carol" }]);

    await wrapper.find("select").setValue("5");
    expect(wrapper.emitted("set-best-of")[0]).toEqual([5]);
  });

  it("locks games that can't be reported yet", () => {
    const wrapper = mountEditor();
    const rows = wrapper.findAll(".game-row");
    expect(rows[0].classes()).not.toContain("locked");
    expect(rows[1].classes()).toContain("locked");
  });

  it("only shows swap and overlay controls when asked to", () => {
    const plain = mountEditor({ allowSwap: false, showOverlayButton: false, showClose: false });
    expect(buttonWithText(plain, "Swap Players")).toBeUndefined();
    expect(buttonWithText(plain, "Apply to Overlay")).toBeUndefined();
    expect(buttonWithText(plain, "Close")).toBeUndefined();

    const full = mountEditor({ allowSwap: true, showOverlayButton: true, showClose: true });
    expect(buttonWithText(full, "Swap Players")).toBeDefined();
    expect(buttonWithText(full, "Apply to Overlay")).toBeDefined();
    expect(buttonWithText(full, "Close")).toBeDefined();
  });

  it("disables submit until the set is decided", async () => {
    const undecided = mountEditor({ setData: setData({ games: [1, null, null] }) });
    expect(buttonWithText(undecided, "Submit to start.gg").attributes("disabled")).toBeDefined();

    const decided = mountEditor({ setData: setData({ games: [1, 1, null] }) });
    const submit = buttonWithText(decided, "Submit to start.gg");
    expect(submit.attributes("disabled")).toBeUndefined();
    await submit.trigger("click");
    expect(decided.emitted("submit")).toHaveLength(1);
  });
});

describe("SetEditor DQ controls", () => {
  it("emits a DQ toggle per player", async () => {
    const wrapper = mountEditor();
    const dqButtons = wrapper.findAll(".dq-btn");
    expect(dqButtons).toHaveLength(2);

    await dqButtons[1].trigger("click");
    expect(wrapper.emitted("toggle-dq")[0]).toEqual([2]);
  });

  it("shows the DQ outcome and marks the DQ'd player's score", () => {
    const wrapper = mountEditor({ setData: setData({ dq: 1 }) });
    expect(wrapper.text()).toContain("Alice DQ'd - Bob advances.");
    expect(wrapper.findAll(".score")[0].text()).toBe("DQ");
    expect(wrapper.findAll(".player-box")[0].classes()).toContain("dq");
    expect(wrapper.findAll(".dq-btn")[0].classes()).toContain("active");
  });

  it("describes a double DQ", () => {
    const wrapper = mountEditor({ setData: setData({ dq: "both" }) });
    expect(wrapper.text()).toContain("Double DQ - neither player advances.");
  });

  it("allows submitting a DQ with no games played", () => {
    const wrapper = mountEditor({ setData: setData({ dq: 2 }) });
    expect(buttonWithText(wrapper, "Submit to start.gg").attributes("disabled")).toBeUndefined();
  });

  it("locks every game row while a DQ is set", () => {
    const wrapper = mountEditor({ setData: setData({ dq: 2 }) });
    expect(wrapper.findAll(".game-row").every((row) => row.classes().includes("locked"))).toBe(true);
  });
});

describe("SetEditor reset/edit of a reported result", () => {
  it("offers no reset controls for a set start.gg hasn't completed", () => {
    const wrapper = mountEditor();
    expect(buttonWithText(wrapper, "Reset result")).toBeUndefined();
    expect(buttonWithText(wrapper, "Edit result")).toBeUndefined();
  });

  it("says when a set is already reported", () => {
    const wrapper = mountEditor({ setData: setData({ games: [1, 1, null], completed: true }) });
    expect(wrapper.text()).toContain("Already reported on start.gg");
  });

  it("requires a second click to confirm a reset", async () => {
    const wrapper = mountEditor({ setData: setData({ games: [1, 1, null], completed: true }) });

    await buttonWithText(wrapper, "Reset result").trigger("click");
    expect(wrapper.emitted("reset-result")).toBeUndefined();
    expect(wrapper.text()).toContain("Confirm reset?");

    await buttonWithText(wrapper, "Confirm reset?").trigger("click");
    expect(wrapper.emitted("reset-result")[0]).toEqual([{ keepScores: false }]);
  });

  it("keeps the existing scores when editing rather than resetting", async () => {
    const wrapper = mountEditor({ setData: setData({ games: [1, 1, null], completed: true }) });

    await buttonWithText(wrapper, "Edit result").trigger("click");
    await buttonWithText(wrapper, "Confirm edit?").trigger("click");
    expect(wrapper.emitted("reset-result")[0]).toEqual([{ keepScores: true }]);
  });

  it("drops a pending confirmation when a different set is loaded", async () => {
    const wrapper = mountEditor({ setData: setData({ games: [1, 1, null], completed: true }) });
    await buttonWithText(wrapper, "Reset result").trigger("click");

    await wrapper.setProps({
      setData: setData({ setId: "202", games: [1, 1, null], completed: true }),
    });
    expect(wrapper.text()).not.toContain("Confirm reset?");
  });
});

describe("SetEditor timer and local-result reminder", () => {
  const timer = { display: "1:05", running: false };

  it("renders no timer block when the editor isn't given one", () => {
    expect(mountEditor().find(".timer-row").exists()).toBe(false);
  });

  it("shows the clock and emits start/pause and reset", async () => {
    const wrapper = mountEditor({ timer });
    expect(wrapper.find(".timer-clock").text()).toBe("1:05");

    await buttonWithText(wrapper, "Start").trigger("click");
    expect(wrapper.emitted("toggle-timer")).toHaveLength(1);

    await buttonWithText(wrapper, "Reset").trigger("click");
    expect(wrapper.emitted("reset-timer")).toHaveLength(1);
  });

  it("labels the first press as starting the set, and a resume as a resume", async () => {
    const fresh = mountEditor({ timer });
    expect(buttonWithText(fresh, "Start set")).toBeDefined();

    const paused = mountEditor({ timer: { ...timer, startedOnStartgg: true } });
    expect(buttonWithText(paused, "Resume")).toBeDefined();
    expect(buttonWithText(paused, "Start set")).toBeUndefined();
  });

  it("says what start.gg knows while a set is in progress there", () => {
    const running = mountEditor({ timer: { ...timer, running: true, startedOnStartgg: true } });
    expect(running.find(".timer-note").text()).toContain("In progress on start.gg");

    const paused = mountEditor({ timer: { ...timer, startedOnStartgg: true } });
    expect(paused.find(".timer-note").text()).toContain("Paused here only");

    // A purely local timer makes no claims about start.gg.
    expect(mountEditor({ timer }).find(".timer-note").exists()).toBe(false);
  });

  it("resets a purely local timer on the first click", async () => {
    const wrapper = mountEditor({ timer });
    await buttonWithText(wrapper, "Reset").trigger("click");
    expect(wrapper.emitted("reset-timer")).toHaveLength(1);
  });

  it("confirms before un-starting a set that start.gg has in progress", async () => {
    const wrapper = mountEditor({ timer: { ...timer, running: true, startedOnStartgg: true } });

    await buttonWithText(wrapper, "Reset").trigger("click");
    expect(wrapper.emitted("reset-timer")).toBeUndefined();

    await buttonWithText(wrapper, "Confirm un-start?").trigger("click");
    expect(wrapper.emitted("reset-timer")).toHaveLength(1);
  });

  it("drops a pending un-start confirmation when a different set is loaded", async () => {
    const wrapper = mountEditor({ timer: { ...timer, startedOnStartgg: true } });
    await buttonWithText(wrapper, "Reset").trigger("click");

    await wrapper.setProps({ setData: setData({ setId: "202" }) });
    expect(wrapper.text()).not.toContain("Confirm un-start?");
  });

  it("shows a reported set's timer as a final duration with no controls", () => {
    const wrapper = mountEditor({
      setData: setData({ games: [1, 1, null], completed: true }),
      timer: { ...timer, display: "7:12", final: true },
    });

    expect(wrapper.find(".timer-clock").text()).toBe("7:12");
    expect(wrapper.find(".timer-state").text()).toBe("Final");
    expect(buttonWithText(wrapper, "Start set")).toBeUndefined();
    expect(wrapper.find(".timer-note").exists()).toBe(false);
  });

  it("shows Pause while running", () => {
    const running = mountEditor({ timer: { ...timer, running: true } });
    expect(buttonWithText(running, "Pause")).toBeDefined();
    expect(running.find(".timer-row").classes()).toContain("running");
  });

  it("reminds the TO about a result saved locally but never submitted", () => {
    const wrapper = mountEditor({ draft: { savedAt: Date.now() - 20 * 60_000 } });
    expect(wrapper.find(".notice-draft").text()).toContain("Saved locally 20 minutes ago");
    expect(wrapper.find(".notice-draft").text()).toContain("remember to submit to start.gg");
  });
});
