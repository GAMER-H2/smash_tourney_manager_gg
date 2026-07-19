export function emptyGame() {
  return { winner: null, player1Character: "", player2Character: "" };
}

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
    },
    player2: {
      entrantId: null,
      name: "Player 2",
    },
    games: Array.from({ length: 5 }, emptyGame),
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

  const games = Array.from({ length: bestOf }, emptyGame);
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
    },
    player2: {
      entrantId: set.player2?.entrantId ?? null,
      name: set.player2?.name || "Player 2",
    },
    games,
  };
}

// A game can only be reported once every earlier game in the set already has
// a winner, so "the next unreported game" (currentGameIndex) is always
// unambiguous regardless of what order rows were clicked in.
export function canReportGame(editorSet, index) {
  const games = editorSet?.games ?? [];
  if (index <= 0) return true;
  return Boolean(games[index - 1]?.winner);
}

export function winsFor(editorSet, player) {
  if (!editorSet?.games) return 0;
  return editorSet.games.reduce(
    (acc, game) => acc + (game?.winner === player ? 1 : 0),
    0,
  );
}

// The game whose character selection should represent the set "right now":
// the next game without a decided winner, or the last game once the set is over.
export function currentGameIndex(editorSet) {
  const games = editorSet?.games ?? [];
  if (!games.length) return -1;
  const nextUnplayed = games.findIndex((game) => !game?.winner);
  return nextUnplayed === -1 ? games.length - 1 : nextUnplayed;
}

export function currentGameCharacter(editorSet, player) {
  const index = currentGameIndex(editorSet);
  if (index === -1) return "";
  const game = editorSet.games[index];
  return (player === 1 ? game?.player1Character : game?.player2Character) || "";
}

export function winnerEntrantId(editorSet) {
  const p1Wins = winsFor(editorSet, 1);
  const p2Wins = winsFor(editorSet, 2);

  if (p1Wins === p2Wins) return null;
  if (p1Wins > p2Wins) return editorSet?.player1?.entrantId ?? null;
  return editorSet?.player2?.entrantId ?? null;
}
