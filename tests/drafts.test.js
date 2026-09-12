import { describe, expect, it } from "vitest";
import {
  describeDraftAge,
  draftSetIds,
  emptyDraftStore,
  getDraft,
  makeDraft,
  normalizeDraftStore,
  putDraft,
  removeDraft,
} from "../src/lib/drafts";
import { emptyEditorSet, emptyGame } from "../src/lib/set-utils";

const T0 = 1_700_000_000_000;

function editorSet({ setId = "101", games = [null, null, null], dq = null } = {}) {
  const set = emptyEditorSet();
  set.setId = setId;
  set.bestOf = 3;
  set.dq = dq;
  set.player1 = { entrantId: 1, name: "Alice" };
  set.player2 = { entrantId: 2, name: "Bob" };
  set.games = games.map((winner) => ({ ...emptyGame(), winner }));
  return set;
}

describe("locally-saved results", () => {
  it("stores a scored set under its set id", () => {
    const store = putDraft(emptyDraftStore(), editorSet({ games: [1, null, null] }), "slug", T0);

    const draft = getDraft(store, "101", "slug");
    expect(draft.setId).toBe("101");
    expect(draft.savedAt).toBe(T0);
    expect(draft.editorSet.games[0].winner).toBe(1);
    expect(draftSetIds(store, "slug")).toEqual(["101"]);
  });

  it("keeps a DQ-only result", () => {
    const store = putDraft(emptyDraftStore(), editorSet({ dq: 2 }), "slug", T0);
    expect(getDraft(store, "101", "slug").editorSet.dq).toBe(2);
  });

  it("does not store a set nothing was scored into", () => {
    const store = putDraft(emptyDraftStore(), editorSet(), "slug", T0);
    expect(getDraft(store, "101", "slug")).toBeNull();
    expect(draftSetIds(store, "slug")).toEqual([]);
  });

  it("drops an existing draft once its result is cleared", () => {
    const scored = putDraft(emptyDraftStore(), editorSet({ games: [1, null, null] }), "slug", T0);
    const cleared = putDraft(scored, editorSet(), "slug", T0 + 1000);
    expect(getDraft(cleared, "101", "slug")).toBeNull();
  });

  it("ignores sets with no start.gg id", () => {
    const store = putDraft(emptyDraftStore(), editorSet({ setId: null, games: [1] }), "slug", T0);
    expect(draftSetIds(store, "slug")).toEqual([]);
  });

  it("snapshots the editor set rather than aliasing it", () => {
    const set = editorSet({ games: [1, null, null] });
    const store = putDraft(emptyDraftStore(), set, "slug", T0);
    set.games[1].winner = 2;
    expect(getDraft(store, "101", "slug").editorSet.games[1].winner).toBeNull();
  });

  it("only offers a draft back for the tournament it was saved against", () => {
    const store = putDraft(emptyDraftStore(), editorSet({ games: [1, null, null] }), "slug-a", T0);
    expect(getDraft(store, "101", "slug-b")).toBeNull();
    expect(draftSetIds(store, "slug-b")).toEqual([]);
    expect(getDraft(store, "101", "slug-a")).not.toBeNull();
  });

  it("removes a draft once it has been submitted", () => {
    const store = putDraft(emptyDraftStore(), editorSet({ games: [1, null, null] }), "slug", T0);
    expect(getDraft(removeDraft(store, "101"), "101", "slug")).toBeNull();
    // Removing something that isn't there is a no-op, not an error.
    expect(draftSetIds(removeDraft(store, "999"), "slug")).toEqual(["101"]);
  });

  it("keeps other sets' drafts when one is removed", () => {
    let store = putDraft(emptyDraftStore(), editorSet({ games: [1, null, null] }), "slug", T0);
    store = putDraft(store, editorSet({ setId: "102", games: [2, null, null] }), "slug", T0);
    store = removeDraft(store, "101");
    expect(draftSetIds(store, "slug")).toEqual(["102"]);
  });

  it("survives a corrupted or unknown store on disk", () => {
    expect(normalizeDraftStore(null)).toEqual(emptyDraftStore());
    expect(normalizeDraftStore("nonsense")).toEqual(emptyDraftStore());
    expect(normalizeDraftStore({ drafts: { "1": { junk: true } } }).drafts).toEqual({});

    const valid = makeDraft(editorSet({ games: [1, null, null] }), "slug", T0);
    expect(normalizeDraftStore({ drafts: { "101": valid } }).drafts["101"]).toEqual(valid);
  });

  it("describes how long ago a result was saved", () => {
    expect(describeDraftAge(T0, T0 + 5_000)).toBe("just now");
    expect(describeDraftAge(T0, T0 + 60_000)).toBe("1 minute ago");
    expect(describeDraftAge(T0, T0 + 20 * 60_000)).toBe("20 minutes ago");
    expect(describeDraftAge(T0, T0 + 3 * 3_600_000)).toBe("3 hours ago");
    expect(describeDraftAge(T0, T0 + 48 * 3_600_000)).toBe("2 days ago");
  });
});
