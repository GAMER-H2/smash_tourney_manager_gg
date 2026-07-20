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
  const p1EntrantId = set?.player1?.entrantId ?? null;
  const p2EntrantId = set?.player2?.entrantId ?? null;

  const games = Array.from({ length: bestOf }, emptyGame);
  const reportedByGameNum = new Map((set.games ?? []).map((g) => [g.gameNum, g]));
  const hasReportedWinners = [...reportedByGameNum.values()].some((g) => g.winnerEntrantId);

  if (hasReportedWinners) {
    // start.gg has the actual per-game results - use those instead of
    // guessing, since a set's wins don't always happen in a simple
    // front-loaded order (e.g. a 3-2 set where the winners alternated
    // rather than one player sweeping the first three games).
    games.forEach((game, i) => {
      const winnerEntrantId = reportedByGameNum.get(i + 1)?.winnerEntrantId;
      if (winnerEntrantId && winnerEntrantId === p1EntrantId) game.winner = 1;
      else if (winnerEntrantId && winnerEntrantId === p2EntrantId) game.winner = 2;
    });
  } else {
    // No per-game data available for this set - best-effort guess: front-
    // load each player's wins in score order.
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
  }

  // Prefill each already-played game's own reported character (by game
  // number) rather than leaving it blank - start.gg already has this data
  // for any set that was reported with character selections.
  games.forEach((game, i) => {
    const reported = reportedByGameNum.get(i + 1);
    if (reported?.player1Character) game.player1Character = reported.player1Character;
    if (reported?.player2Character) game.player2Character = reported.player2Character;
  });

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

// True once either player has already won enough games to take the set, so
// no further games need (or should) be reportable - e.g. a 2-0 best of 3.
function isSetDecided(editorSet) {
  const targetWins = editorSet?.bestOf === 3 ? 2 : 3;
  return winsFor(editorSet, 1) >= targetWins || winsFor(editorSet, 2) >= targetWins;
}

// A game can only be reported once every earlier game in the set already has
// a winner, so "the next unreported game" (currentGameIndex) is always
// unambiguous regardless of what order rows were clicked in. Once the set
// itself is already decided, no further (never-played) game is reportable.
export function canReportGame(editorSet, index) {
  const games = editorSet?.games ?? [];
  if (isSetDecided(editorSet)) return false;
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
// the next game without a decided winner, or - once the set is already
// decided - the last game that was actually played (not a trailing unplayed
// slot, e.g. game 3 of a 2-0 best of 3, which never happened).
export function currentGameIndex(editorSet) {
  const games = editorSet?.games ?? [];
  if (!games.length) return -1;

  if (isSetDecided(editorSet)) {
    for (let i = games.length - 1; i >= 0; i -= 1) {
      if (games[i]?.winner) return i;
    }
  }

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
