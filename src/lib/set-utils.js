export function emptyGame() {
  return { winner: null, player1Character: "", player2Character: "" };
}

// start.gg records a disqualified entrant's score as -1 (that's what its own
// UI renders as "DQ"), so that's the value used here too - both when reading
// an already-reported DQ back out of a fetched set and when telling the
// overlay what to display.
export const DQ_SCORE = -1;

// Best-of formats are always odd (a set needs a majority of its games) and
// capped well past anything a bracket actually runs.
export const DEFAULT_BEST_OF_OPTIONS = [3, 5];
export const DEFAULT_POOL_BEST_OF = 3;
export const DEFAULT_BRACKET_BEST_OF = 5;
const MAX_BEST_OF = 15;

export function normalizeBestOf(value, fallback = DEFAULT_BRACKET_BEST_OF) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < 1 || n > MAX_BEST_OF || n % 2 === 0) return fallback;
  return n;
}

// The best-of choices offered in the editors and settings. Accepts either an
// array or the comma-separated text the settings field holds, and drops
// anything that isn't a usable format rather than failing on it.
export function normalizeBestOfOptions(raw) {
  const parts = Array.isArray(raw) ? raw : String(raw ?? "").split(/[\s,]+/);
  const valid = parts.map((part) => normalizeBestOf(part, null)).filter(Boolean);
  const unique = [...new Set(valid)].sort((a, b) => a - b);
  return unique.length ? unique : [...DEFAULT_BEST_OF_OPTIONS];
}

// Games needed to take a set: 2 of a best of 3, 3 of a best of 5, ...
export function targetWinsFor(bestOf) {
  return Math.floor(normalizeBestOf(bestOf) / 2) + 1;
}

// Round-robin pool sets carry no bracket round, and start.gg's own phase
// naming convention for them is "Pools"/"Groups" - the same two signals
// bracket-utils uses to decide a whole bucket is a pool.
export function isPoolSet(set) {
  const phaseName = String(set?.phaseName || "").toLowerCase();
  return Number(set?.round) === 0 || phaseName.includes("pool") || phaseName.includes("group");
}

// The format to open a fetched set with. A completed set's real score is
// the best evidence there is (whoever won reached the target, so a 2-1 was a
// best of 3 and a 4-2 a best of 7); otherwise it's the TO's configured
// default for pools or bracket. Without defaults (older callers, tests) the
// set's own bestOf is used as-is.
export function resolveBestOf(set, defaults) {
  if (!defaults) return normalizeBestOf(set?.bestOf);

  const p1 = Number(set?.player1?.score);
  const p2 = Number(set?.player2?.score);
  const reported = Number(set?.state) === 3 || Boolean(set?.winnerId);
  const isDqResult = p1 === DQ_SCORE || p2 === DQ_SCORE;
  const maxScore = Math.max(Number.isFinite(p1) ? p1 : 0, Number.isFinite(p2) ? p2 : 0);

  if (reported && !isDqResult && maxScore >= 2) {
    return normalizeBestOf(maxScore * 2 - 1);
  }

  return isPoolSet(set)
    ? normalizeBestOf(defaults.poolBestOf, DEFAULT_POOL_BEST_OF)
    : normalizeBestOf(defaults.bracketBestOf, DEFAULT_BRACKET_BEST_OF);
}

export function emptyEditorSet() {
  return {
    setId: null,
    identifier: "",
    roundText: "",
    eventName: "",
    phaseName: "",
    bestOf: 5,
    // null | 1 | 2 | "both" - which player (if any) is being reported as a
    // no-show/disqualification. A DQ replaces the per-game result entirely
    // rather than sitting alongside it.
    dq: null,
    // True once start.gg has a completed result for this set, i.e. it can't
    // be reported again without being reset first.
    completed: false,
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

// Which player, if any, a fetched set was already DQ'd against - start.gg
// reports that as a -1 score for whoever didn't show.
export function dqFromTournamentSet(set) {
  const p1Dq = Number(set?.player1?.score) === DQ_SCORE;
  const p2Dq = Number(set?.player2?.score) === DQ_SCORE;
  if (p1Dq && p2Dq) return "both";
  if (p1Dq) return 1;
  if (p2Dq) return 2;
  return null;
}

export function createEditorSetFromTournamentSet(set, bestOfDefaults = null) {
  const bestOf = resolveBestOf(set, bestOfDefaults);
  const targetWins = targetWinsFor(bestOf);
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
    dq: dqFromTournamentSet(set),
    completed: Number(set?.state) === 3 || Boolean(set?.winnerId),
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
  const targetWins = targetWinsFor(editorSet?.bestOf);
  return winsFor(editorSet, 1) >= targetWins || winsFor(editorSet, 2) >= targetWins;
}

// A game can only be reported once every earlier game in the set already has
// a winner, so "the next unreported game" (currentGameIndex) is always
// unambiguous regardless of what order rows were clicked in. Once the set
// itself is already decided, no further (never-played) game is reportable.
export function canReportGame(editorSet, index) {
  const games = editorSet?.games ?? [];
  // A DQ isn't a played set - individual games stop being meaningful (and
  // are never sent to start.gg) for as long as one is set.
  if (editorSet?.dq) return false;
  if (isSetDecided(editorSet)) return false;
  if (index <= 0) return true;
  return Boolean(games[index - 1]?.winner);
}

// Toggles a DQ against a player: clicking the same player again clears it,
// and DQ-ing both players is the double-DQ case (neither advances).
export function toggleDq(currentDq, player) {
  if (player !== 1 && player !== 2) return currentDq;
  const other = player === 1 ? 2 : 1;

  if (currentDq === player) return null;
  if (currentDq === "both") return other;
  if (currentDq === other) return "both";
  return player;
}

export function isDq(editorSet, player) {
  return editorSet?.dq === player || editorSet?.dq === "both";
}

// The score to show for a player, which is their game wins except when
// they've been DQ'd - matching how start.gg itself scores a DQ.
export function scoreFor(editorSet, player) {
  if (isDq(editorSet, player)) return DQ_SCORE;
  return winsFor(editorSet, player);
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
  // A DQ decides the set on its own: whoever wasn't DQ'd advances, and a
  // double DQ has no winner at all.
  if (editorSet?.dq === "both") return null;
  if (editorSet?.dq === 1) return editorSet?.player2?.entrantId ?? null;
  if (editorSet?.dq === 2) return editorSet?.player1?.entrantId ?? null;

  const p1Wins = winsFor(editorSet, 1);
  const p2Wins = winsFor(editorSet, 2);

  if (p1Wins === p2Wins) return null;
  if (p1Wins > p2Wins) return editorSet?.player1?.entrantId ?? null;
  return editorSet?.player2?.entrantId ?? null;
}

// Whether this editor set holds something worth sending to start.gg - either
// a DQ, or at least one game with a winner. Used both to gate submitting and
// to decide whether closing a modal has anything worth keeping locally.
export function hasResult(editorSet) {
  if (editorSet?.dq) return true;
  return (editorSet?.games ?? []).some((game) => game?.winner);
}

// True once the editor holds a complete, submittable outcome: a DQ (single
// or double), or enough game wins for one player to have taken the set.
export function isSubmittable(editorSet) {
  if (!editorSet?.setId) return false;
  if (editorSet.dq) return true;
  return Boolean(winnerEntrantId(editorSet)) && isSetDecided(editorSet);
}

// Clears every reported outcome (games and DQ) while keeping the players,
// format and character picks - what "reset this set and start over" means
// locally, independent of resetting it on start.gg.
export function clearResults(editorSet, { keepCharacters = true } = {}) {
  const next = cloneEditorSet(editorSet);
  next.dq = null;
  next.completed = false;
  next.games = next.games.map((game) => ({
    winner: null,
    player1Character: keepCharacters ? game.player1Character : "",
    player2Character: keepCharacters ? game.player2Character : "",
  }));
  return next;
}

// Resizes a set to a new format, keeping whatever games it already has and
// dropping any that no longer fit.
export function withBestOf(editorSet, bestOf) {
  const next = cloneEditorSet(editorSet);
  next.bestOf = normalizeBestOf(bestOf, next.bestOf);
  next.games = next.games.slice(0, next.bestOf);
  while (next.games.length < next.bestOf) next.games.push(emptyGame());
  return next;
}

function flipSide(value) {
  if (value === 1) return 2;
  if (value === 2) return 1;
  return value;
}

// Swaps which side each game (and any DQ) was won/given on, leaving players
// and character picks where they are - for when the scores went in against
// the wrong player.
export function swapScores(editorSet) {
  const next = cloneEditorSet(editorSet);
  next.dq = flipSide(next.dq);
  next.games = next.games.map((game) => ({ ...game, winner: flipSide(game.winner) }));
  return next;
}

// Swaps the two players' sides entirely - names, entrants, characters, game
// winners and DQ all move together, so the result itself is unchanged.
export function swapSides(editorSet) {
  const next = cloneEditorSet(editorSet);
  [next.player1, next.player2] = [next.player2, next.player1];
  next.dq = flipSide(next.dq);
  next.games = next.games.map((game) => ({
    winner: flipSide(game.winner),
    player1Character: game.player2Character,
    player2Character: game.player1Character,
  }));
  return next;
}

// Whether the editor set has its players the other way round from `set`
// (a fetched start.gg set, or another editor set) - e.g. because the TO
// swapped them on stream to match who's sitting on which side.
export function isSwappedRelativeTo(editorSet, set) {
  const a1 = editorSet?.player1?.entrantId;
  const a2 = editorSet?.player2?.entrantId;
  const b1 = set?.player1?.entrantId;
  const b2 = set?.player2?.entrantId;
  if (!a1 && !a2) return false;
  return (a1 ?? null) === (b2 ?? null) && (a2 ?? null) === (b1 ?? null) && a1 !== a2;
}

// The same editor set, turned to have its players the same way round as
// `set`. A copy either way.
export function orientLike(editorSet, set) {
  return isSwappedRelativeTo(editorSet, set) ? swapSides(editorSet) : cloneEditorSet(editorSet);
}

// The score an editor set currently holds, in the slot order of the fetched
// set it belongs to - so a score typed into a (possibly swapped) editor can
// be shown on the right rows of that set's bracket card.
export function slotScoresFor(editorSet, set) {
  const oriented = orientLike(editorSet, set);
  return { player1: scoreFor(oriented, 1), player2: scoreFor(oriented, 2) };
}
