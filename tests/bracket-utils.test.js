import { describe, expect, it } from "vitest";
import {
  buildBracketLayout,
  buildRoundRobinGrid,
  collapseByeSets,
} from "../src/lib/bracket-utils";

function bracketSet(overrides = {}) {
  return {
    id: "1",
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

describe("bye collapsing", () => {
  it("leaves a bracket with no byes untouched", () => {
    const sets = [bracketSet()];
    expect(collapseByeSets(sets)).toBe(sets);
  });

  it("drops bye sets and routes drop links through to the real match", () => {
    const sets = [
      bracketSet({ id: "w1", identifier: "A", round: 1 }),
      // Structural passthrough: the loser of w1 walks through this bye.
      bracketSet({
        id: "bye1",
        identifier: "B",
        round: -1,
        player1: { sourceType: "set", sourceSetId: "w1", sourcePlacement: 2 },
        player2: { sourceType: "bye" },
      }),
      bracketSet({
        id: "l1",
        identifier: "C",
        round: -2,
        roundText: "Losers Round 1",
        player1: { sourceType: "set", sourceSetId: "bye1", sourcePlacement: 1 },
        player2: { entrantId: 3, name: "Cara", score: 0 },
      }),
    ];

    const collapsed = collapseByeSets(sets);

    expect(collapsed.map((set) => set.id)).toEqual(["w1", "l1"]);
    expect(collapsed[1].player1).toMatchObject({
      sourceSetId: "w1",
      sourcePlacement: 2,
    });
  });
});

describe("bracket layout", () => {
  it("splits winners, losers and grand finals into columns", () => {
    const layout = buildBracketLayout([
      bracketSet({ id: "w1", round: 1, roundText: "Winners Round 1" }),
      bracketSet({ id: "w2", round: 2, roundText: "Winners Final" }),
      bracketSet({ id: "l1", round: -1, roundText: "Losers Round 1" }),
      bracketSet({ id: "gf", round: 3, roundText: "Grand Final" }),
    ]);

    expect(layout.isBracket).toBe(true);
    expect(layout.winners.map((col) => col.label)).toEqual([
      "Winners Round 1",
      "Winners Final",
    ]);
    expect(layout.losers.map((col) => col.label)).toEqual(["Losers Round 1"]);
    expect(layout.grandFinal[0].sets.map((set) => set.id)).toEqual(["gf"]);
  });

  it("labels slots that source another match", () => {
    const layout = buildBracketLayout([
      bracketSet({ id: "w1", identifier: "A", round: 1 }),
      bracketSet({
        id: "w2",
        identifier: "B",
        round: 2,
        roundText: "Winners Final",
        player1: { sourceType: "set", sourceSetId: "w1", sourcePlacement: 1 },
        player2: { sourceType: null },
      }),
    ]);

    const final = layout.winners[1].sets[0];
    expect(final.player1.placeholder).toBe("Winner of Match A");
    expect(final.player2.placeholder).toBe("TBD");
  });

  it("draws connectors only for winner advancement", () => {
    const layout = buildBracketLayout([
      bracketSet({ id: "w1", round: 1 }),
      bracketSet({
        id: "w2",
        round: 2,
        roundText: "Winners Final",
        player1: { sourceType: "set", sourceSetId: "w1", sourcePlacement: 1 },
        player2: { sourceType: "set", sourceSetId: "w1", sourcePlacement: 2 },
      }),
    ]);

    expect(layout.edges).toEqual([{ fromSetId: "w1", toSetId: "w2", toSlot: 1 }]);
  });

  it("treats all-round-zero sets as a pool rather than a bracket", () => {
    const layout = buildBracketLayout([bracketSet({ round: 0, roundText: "" })]);
    expect(layout.isBracket).toBe(false);
  });
});

describe("round robin pool grid", () => {
  const sets = [
    bracketSet({
      id: "p1",
      round: 0,
      state: 3,
      winnerId: 1,
      player1: { entrantId: 1, name: "Alice", score: 2 },
      player2: { entrantId: 2, name: "Bob", score: 1 },
    }),
    bracketSet({
      id: "p2",
      round: 0,
      state: 1,
      player1: { entrantId: 1, name: "Alice", score: 0 },
      player2: { entrantId: 3, name: "Cara", score: 0 },
    }),
  ];

  it("builds a cell per head-to-head from both perspectives", () => {
    const grid = buildRoundRobinGrid(sets);
    const alice = grid.rows.find((row) => row.entrant.id === 1);
    const bob = grid.rows.find((row) => row.entrant.id === 2);

    expect(grid.entrants.map((entrant) => entrant.name)).toEqual(["Alice", "Bob", "Cara"]);
    expect(alice.cells[0]).toEqual({ kind: "self" });
    expect(alice.cells[1]).toMatchObject({ kind: "set", rowScore: 2, colScore: 1, rowWon: true });
    expect(bob.cells[0]).toMatchObject({ kind: "set", rowScore: 1, colScore: 2, rowLost: true });
    expect(bob.cells[2]).toEqual({ kind: "empty" });
  });

  it("tracks set and game records", () => {
    const grid = buildRoundRobinGrid(sets);
    const alice = grid.rows.find((row) => row.entrant.id === 1);

    expect(alice.record).toEqual({ setWins: 1, setLosses: 0, gameWins: 2, gameLosses: 1 });
  });

  it("marks only reported sets complete", () => {
    const grid = buildRoundRobinGrid(sets);
    const alice = grid.rows.find((row) => row.entrant.id === 1);
    expect(alice.cells[1].isComplete).toBe(true);
    expect(alice.cells[2].isComplete).toBe(false);
  });
});
