function naturalCompare(a, b) {
  return String(a ?? "").localeCompare(String(b ?? ""), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function isGrandFinal(set) {
  return /grand final/i.test(set.roundText || "");
}

function isReset(set) {
  return /reset/i.test(set.roundText || "");
}

function sortColumn(sets) {
  return [...sets].sort((a, b) => {
    const byIdentifier = naturalCompare(a.identifier, b.identifier);
    if (byIdentifier !== 0) return byIdentifier;
    return a.id - b.id;
  });
}

function columnLabel(sets, fallback) {
  const withText = sets.find((set) => set.roundText);
  return withText?.roundText || fallback;
}

function buildSlotLookups(sets) {
  const byId = new Map(sets.map((set) => [set.id, set]));

  function describeSlot(set, slot, slotNumber) {
    if (slot?.entrantId || slot?.name) {
      return { ...slot, placeholder: null };
    }

    if (slot?.sourceType === "set" && slot?.sourceSetId && byId.has(slot.sourceSetId)) {
      const source = byId.get(slot.sourceSetId);
      const sourceLabel = source.identifier ? `Match ${source.identifier}` : `Set ${source.id}`;
      const verb = slot.sourcePlacement === 2 ? "Loser" : "Winner";
      return { ...slot, placeholder: `${verb} of ${sourceLabel}` };
    }

    if (slot?.sourceType === "bye") {
      return { ...slot, placeholder: "Bye" };
    }

    return { ...slot, placeholder: "TBD" };
  }

  return sets.map((set) => ({
    ...set,
    player1: describeSlot(set, set.player1, 1),
    player2: describeSlot(set, set.player2, 2),
  }));
}

function buildEdges(sets) {
  const edges = [];

  for (const set of sets) {
    [set.player1, set.player2].forEach((slot, index) => {
      if (slot?.sourceType === "set" && slot?.sourceSetId) {
        edges.push({
          fromSetId: slot.sourceSetId,
          toSetId: set.id,
          toSlot: index + 1,
        });
      }
    });
  }

  return edges;
}

export function buildBracketLayout(rawSets) {
  const sets = rawSets || [];
  const isBracket = sets.some((set) => Number(set.round) !== 0);

  if (!isBracket) {
    return { isBracket: false, winners: [], losers: [], grandFinal: [], edges: [] };
  }

  const enrichedSets = buildSlotLookups(sets);

  const winnersMap = new Map();
  const losersMap = new Map();
  const otherSets = [];
  const grandFinalSets = [];

  for (const set of enrichedSets) {
    if (isGrandFinal(set)) {
      grandFinalSets.push(set);
      continue;
    }

    const round = Number(set.round) || 0;

    if (round > 0) {
      if (!winnersMap.has(round)) winnersMap.set(round, []);
      winnersMap.get(round).push(set);
    } else if (round < 0) {
      const absRound = Math.abs(round);
      if (!losersMap.has(absRound)) losersMap.set(absRound, []);
      losersMap.get(absRound).push(set);
    } else {
      otherSets.push(set);
    }
  }

  const winners = [];

  if (otherSets.length) {
    winners.push({
      key: "other",
      round: 0,
      label: columnLabel(otherSets, "Other"),
      sets: sortColumn(otherSets),
    });
  }

  for (const round of [...winnersMap.keys()].sort((a, b) => a - b)) {
    const roundSets = winnersMap.get(round);
    winners.push({
      key: `w-${round}`,
      round,
      label: columnLabel(roundSets, `Winners Round ${round}`),
      sets: sortColumn(roundSets),
    });
  }

  const losers = [];
  for (const absRound of [...losersMap.keys()].sort((a, b) => a - b)) {
    const roundSets = losersMap.get(absRound);
    losers.push({
      key: `l-${absRound}`,
      round: -absRound,
      label: columnLabel(roundSets, `Losers Round ${absRound}`),
      sets: sortColumn(roundSets),
    });
  }

  const sortedGrandFinal = [...grandFinalSets].sort((a, b) => {
    const resetDiff = Number(isReset(a)) - Number(isReset(b));
    if (resetDiff !== 0) return resetDiff;
    if (a.round !== b.round) return a.round - b.round;
    return a.id - b.id;
  });

  const grandFinal = sortedGrandFinal.map((set, index) => ({
    key: `gf-${index}`,
    round: set.round,
    label: set.roundText || (index === 0 ? "Grand Final" : "Grand Final Reset"),
    sets: [set],
  }));

  const edges = buildEdges(enrichedSets);

  return { isBracket: true, winners, losers, grandFinal, edges };
}

// Builds a start.gg-style pool round-robin grid: every entrant against
// every other entrant, with the head-to-head result in each cell and a
// running set/game record per entrant.
export function buildRoundRobinGrid(rawSets) {
  const sets = rawSets || [];

  const entrantNames = new Map();
  for (const set of sets) {
    if (set.player1?.entrantId) entrantNames.set(set.player1.entrantId, set.player1.name);
    if (set.player2?.entrantId) entrantNames.set(set.player2.entrantId, set.player2.name);
  }

  const entrants = [...entrantNames.entries()].map(([id, name]) => ({ id, name }));

  const pairMap = new Map();
  for (const set of sets) {
    const a = set.player1?.entrantId;
    const b = set.player2?.entrantId;
    if (!a || !b) continue;
    pairMap.set(`${a}:${b}`, { set, perspective: 1 });
    pairMap.set(`${b}:${a}`, { set, perspective: 2 });
  }

  const records = new Map(
    entrants.map((entrant) => [
      entrant.id,
      { setWins: 0, setLosses: 0, gameWins: 0, gameLosses: 0 },
    ]),
  );

  for (const set of sets) {
    const a = set.player1?.entrantId;
    const b = set.player2?.entrantId;
    if (!a || !b) continue;

    const aScore = Number(set.player1.score) || 0;
    const bScore = Number(set.player2.score) || 0;

    const aRecord = records.get(a);
    const bRecord = records.get(b);
    if (aRecord) {
      aRecord.gameWins += aScore;
      aRecord.gameLosses += bScore;
    }
    if (bRecord) {
      bRecord.gameWins += bScore;
      bRecord.gameLosses += aScore;
    }

    if (set.winnerId && aRecord && bRecord) {
      if (set.winnerId === a) {
        aRecord.setWins += 1;
        bRecord.setLosses += 1;
      } else if (set.winnerId === b) {
        bRecord.setWins += 1;
        aRecord.setLosses += 1;
      }
    }
  }

  const rows = entrants.map((rowEntrant) => {
    const cells = entrants.map((colEntrant) => {
      if (rowEntrant.id === colEntrant.id) {
        return { kind: "self" };
      }

      const match = pairMap.get(`${rowEntrant.id}:${colEntrant.id}`);
      if (!match) {
        return { kind: "empty" };
      }

      const { set, perspective } = match;
      const rowSlot = perspective === 1 ? set.player1 : set.player2;
      const colSlot = perspective === 1 ? set.player2 : set.player1;
      const isComplete = set.state === 3 && Boolean(set.winnerId);
      const rowWon = isComplete && set.winnerId === rowSlot.entrantId;
      const rowLost = isComplete && set.winnerId && set.winnerId !== rowSlot.entrantId;

      return {
        kind: "set",
        setId: set.id,
        rowScore: rowSlot.score,
        colScore: colSlot.score,
        isComplete,
        rowWon,
        rowLost,
        set,
      };
    });

    return { entrant: rowEntrant, cells, record: records.get(rowEntrant.id) };
  });

  return { entrants, rows };
}
