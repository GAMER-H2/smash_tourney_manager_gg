export function emptyEditorSet() {
  return {
    setId: null,
    identifier: "",
    roundText: "",
    eventName: "",
    phaseName: "",
    bestOf: 5,
    player1: {
      entrantId: null,
      name: "Player 1",
      character: "",
    },
    player2: {
      entrantId: null,
      name: "Player 2",
      character: "",
    },
    games: Array.from({ length: 5 }, () => ({ winner: null })),
  };
}

export function cloneEditorSet(value) {
  if (!value) return emptyEditorSet();
  return JSON.parse(JSON.stringify(value));
}

export function createEditorSetFromTournamentSet(set) {
  const bestOf = set?.bestOf === 3 ? 3 : 5;
  const targetWins = bestOf === 3 ? 2 : 3;
  const p1Score = Math.max(0, Number(set?.player1?.score ?? 0));
  const p2Score = Math.max(0, Number(set?.player2?.score ?? 0));

  const games = Array.from({ length: bestOf }, () => ({ winner: null }));
  let index = 0;

  for (let i = 0; i < Math.min(p1Score, targetWins); i += 1) {
    games[index].winner = 1;
    index += 1;
  }

  for (let i = 0; i < Math.min(p2Score, targetWins); i += 1) {
    if (index >= games.length) break;
    games[index].winner = 2;
    index += 1;
  }

  return {
    setId: set.id,
    identifier: set.identifier ?? "",
    roundText: set.roundText ?? "",
    eventName: set.eventName ?? "",
    phaseName: set.phaseName ?? "",
    bestOf,
    player1: {
      entrantId: set.player1?.entrantId ?? null,
      name: set.player1?.name || "Player 1",
      character: "",
    },
    player2: {
      entrantId: set.player2?.entrantId ?? null,
      name: set.player2?.name || "Player 2",
      character: "",
    },
    games,
  };
}

export function winsFor(editorSet, player) {
  if (!editorSet?.games) return 0;
  return editorSet.games.reduce(
    (acc, game) => acc + (game?.winner === player ? 1 : 0),
    0,
  );
}

export function winnerEntrantId(editorSet) {
  const p1Wins = winsFor(editorSet, 1);
  const p2Wins = winsFor(editorSet, 2);

  if (p1Wins === p2Wins) return null;
  if (p1Wins > p2Wins) return editorSet?.player1?.entrantId ?? null;
  return editorSet?.player2?.entrantId ?? null;
}
