import { describe, expect, it } from "vitest";
import {
  DQ_SCORE,
  canReportGame,
  clearResults,
  cloneEditorSet,
  createEditorSetFromTournamentSet,
  currentGameCharacter,
  currentGameIndex,
  dqFromTournamentSet,
  emptyEditorSet,
  emptyGame,
  hasResult,
  isDq,
  isSubmittable,
  scoreFor,
  toggleDq,
  winnerEntrantId,
  winsFor,
} from "../src/lib/set-utils";

function tournamentSet(overrides = {}) {
  return {
    id: "101",
    identifier: "A",
    roundText: "Winners Round 1",
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

function editorSetWith(games, overrides = {}) {
  const set = emptyEditorSet();
  set.setId = "101";
  set.bestOf = 3;
  set.player1.entrantId = 1;
  set.player2.entrantId = 2;
  set.games = games.map((winner) => ({ ...emptyGame(), winner }));
  return { ...set, ...overrides };
}

describe("existing set editor behaviour", () => {
  it("counts wins per player", () => {
    const set = editorSetWith([1, 2, 1]);
    expect(winsFor(set, 1)).toBe(2);
    expect(winsFor(set, 2)).toBe(1);
  });

  it("derives the set winner from game wins", () => {
    expect(winnerEntrantId(editorSetWith([1, 2, 1]))).toBe(1);
    expect(winnerEntrantId(editorSetWith([2, 2]))).toBe(2);
    expect(winnerEntrantId(editorSetWith([1, 2]))).toBeNull();
  });

  it("only allows reporting games in order, and not past a decided set", () => {
    const set = editorSetWith([null, null, null]);
    expect(canReportGame(set, 0)).toBe(true);
    expect(canReportGame(set, 1)).toBe(false);

    const started = editorSetWith([1, null, null]);
    expect(canReportGame(started, 1)).toBe(true);

    const decided = editorSetWith([1, 1, null]);
    expect(canReportGame(decided, 2)).toBe(false);
  });

  it("uses start.gg's per-game winners when the set carries them", () => {
    const set = createEditorSetFromTournamentSet(
      tournamentSet({
        bestOf: 5,
        state: 3,
        winnerId: 1,
        player1: { entrantId: 1, name: "Alice", score: 3 },
        player2: { entrantId: 2, name: "Bob", score: 2 },
        games: [
          { gameNum: 1, winnerEntrantId: 2, player1Character: "Fox", player2Character: "Mario" },
          { gameNum: 2, winnerEntrantId: 1 },
          { gameNum: 3, winnerEntrantId: 2 },
          { gameNum: 4, winnerEntrantId: 1 },
          { gameNum: 5, winnerEntrantId: 1 },
        ],
      }),
    );

    expect(set.games.map((game) => game.winner)).toEqual([2, 1, 2, 1, 1]);
    expect(set.games[0].player1Character).toBe("Fox");
    expect(set.games[0].player2Character).toBe("Mario");
  });

  it("front-loads wins when no per-game data exists", () => {
    const set = createEditorSetFromTournamentSet(
      tournamentSet({
        player1: { entrantId: 1, name: "Alice", score: 2 },
        player2: { entrantId: 2, name: "Bob", score: 1 },
      }),
    );

    expect(set.games.map((game) => game.winner)).toEqual([1, 1, 2]);
  });

  it("points currentGameIndex at the next unplayed game, or the last played one", () => {
    expect(currentGameIndex(editorSetWith([1, null, null]))).toBe(1);
    expect(currentGameIndex(editorSetWith([1, 1, null]))).toBe(1);
  });

  it("reads the character of the current game", () => {
    const set = editorSetWith([1, null, null]);
    set.games[1].player1Character = "Pyra/Mythra";
    expect(currentGameCharacter(set, 1)).toBe("Pyra/Mythra");
  });

  it("clones editor sets deeply", () => {
    const set = editorSetWith([1, null, null]);
    const copy = cloneEditorSet(set);
    copy.games[0].winner = 2;
    expect(set.games[0].winner).toBe(1);
  });
});

describe("DQ support", () => {
  it("toggles a DQ on, off, and into a double DQ", () => {
    expect(toggleDq(null, 1)).toBe(1);
    expect(toggleDq(1, 1)).toBeNull();
    expect(toggleDq(1, 2)).toBe("both");
    expect(toggleDq("both", 1)).toBe(2);
    expect(toggleDq("both", 2)).toBe(1);
    expect(toggleDq(null, 3)).toBeNull();
  });

  it("advances the player who was not DQ'd", () => {
    expect(winnerEntrantId(editorSetWith([], { dq: 1 }))).toBe(2);
    expect(winnerEntrantId(editorSetWith([], { dq: 2 }))).toBe(1);
  });

  it("has no winner for a double DQ", () => {
    expect(winnerEntrantId(editorSetWith([], { dq: "both" }))).toBeNull();
  });

  it("overrides game wins - a DQ is not a played set", () => {
    // Player 1 won both games but is the one being DQ'd: the DQ decides the
    // set regardless, and their score reads as start.gg's -1 rather than 2.
    const set = editorSetWith([1, 1], { dq: 1 });
    expect(winnerEntrantId(set)).toBe(2);
    expect(scoreFor(set, 1)).toBe(DQ_SCORE);
    expect(scoreFor(set, 2)).toBe(winsFor(set, 2));
  });

  it("locks game reporting while a DQ is set", () => {
    expect(canReportGame(editorSetWith([null, null, null], { dq: 2 }), 0)).toBe(false);
  });

  it("reports isDq per player, including both for a double DQ", () => {
    expect(isDq(editorSetWith([], { dq: "both" }), 1)).toBe(true);
    expect(isDq(editorSetWith([], { dq: "both" }), 2)).toBe(true);
    expect(isDq(editorSetWith([], { dq: 1 }), 2)).toBe(false);
  });

  it("reads an already-reported DQ back out of a fetched set", () => {
    const dqSet = tournamentSet({
      state: 3,
      winnerId: 2,
      player1: { entrantId: 1, name: "Alice", score: -1 },
      player2: { entrantId: 2, name: "Bob", score: 0 },
    });

    expect(dqFromTournamentSet(dqSet)).toBe(1);
    expect(createEditorSetFromTournamentSet(dqSet).dq).toBe(1);

    const doubleDq = tournamentSet({
      player1: { entrantId: 1, name: "Alice", score: -1 },
      player2: { entrantId: 2, name: "Bob", score: -1 },
    });
    expect(dqFromTournamentSet(doubleDq)).toBe("both");
    expect(dqFromTournamentSet(tournamentSet())).toBeNull();
  });

  it("is submittable on a DQ alone, even with no games played", () => {
    expect(isSubmittable(editorSetWith([null, null, null], { dq: 1 }))).toBe(true);
    expect(isSubmittable(editorSetWith([null, null, null], { dq: "both" }))).toBe(true);
  });
});

describe("submittability and clearing results", () => {
  it("only allows submitting a decided set with a set id", () => {
    expect(isSubmittable(editorSetWith([1, null, null]))).toBe(false);
    expect(isSubmittable(editorSetWith([1, 1, null]))).toBe(true);
    expect(isSubmittable({ ...editorSetWith([1, 1, null]), setId: null })).toBe(false);
  });

  it("knows whether anything has been scored yet", () => {
    expect(hasResult(editorSetWith([null, null, null]))).toBe(false);
    expect(hasResult(editorSetWith([1, null, null]))).toBe(true);
    expect(hasResult(editorSetWith([null, null, null], { dq: 2 }))).toBe(true);
  });

  it("clears games and DQ while keeping players, format and characters", () => {
    const set = editorSetWith([1, 1, null], { dq: 2, completed: true });
    set.games[0].player1Character = "Fox";

    const cleared = clearResults(set);

    expect(cleared.games.every((game) => game.winner === null)).toBe(true);
    expect(cleared.dq).toBeNull();
    expect(cleared.completed).toBe(false);
    expect(cleared.games[0].player1Character).toBe("Fox");
    expect(cleared.player1.entrantId).toBe(1);
    expect(cleared.bestOf).toBe(3);
    // The original is untouched.
    expect(set.games[0].winner).toBe(1);
  });

  it("can drop characters too when asked", () => {
    const set = editorSetWith([1, null, null]);
    set.games[0].player1Character = "Fox";
    expect(clearResults(set, { keepCharacters: false }).games[0].player1Character).toBe("");
  });

  it("marks fetched sets that start.gg has already completed", () => {
    expect(createEditorSetFromTournamentSet(tournamentSet()).completed).toBe(false);
    expect(
      createEditorSetFromTournamentSet(tournamentSet({ state: 3, winnerId: 1 })).completed,
    ).toBe(true);
  });
});
