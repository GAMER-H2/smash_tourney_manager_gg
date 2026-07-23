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
    // Set ids are usually numeric, but start.gg gives sets in a "preview"
    // bracket (seeded but not yet started) non-numeric ids like
    // "preview_3393165_1_0" - compare as strings so those still sort
    // consistently instead of every pair coming out NaN.
    return naturalCompare(a.id, b.id);
  });
}

// Two independent signals, since neither is guaranteed alone: round-robin
// pool sets don't carry a bracket round, and start.gg's own phase naming
// convention for these is "Pools"/"Pool"/"Groups".
function looksLikePool(sets) {
  const allRoundsZero = sets.every((set) => Number(set.round) === 0);
  const phaseName = (sets.find((set) => set.phaseName)?.phaseName || "").toLowerCase();
  return allRoundsZero || phaseName.includes("pool") || phaseName.includes("group");
}

function columnLabel(sets, fallback) {
  const withText = sets.find((set) => set.roundText);
  return withText?.roundText || fallback;
}

function slotIsBye(slot) {
  return slot?.sourceType === "bye";
}

// A "bye set" is start.gg's structural passthrough: a real entrant (or
// another passthrough) versus an empty bye slot, so it just forwards one
// player onward without ever being a played match. They only appear in the
// payload when fetched with showByes, and we never want to render them as
// their own (empty) columns.
function isByeSet(set) {
  return slotIsBye(set?.player1) || slotIsBye(set?.player2);
}

// start.gg brackets with byes route the meaningful drop links *through* these
// passthrough sets - e.g. a Winners Round 1 loser only reaches the first real
// Losers Round 1 match via a couple of bye sets in between. This collapses
// that: every real (non-bye) set is kept, but any slot that sources a bye set
// is rewritten to point straight at the nearest real ancestor match and its
// winner/loser placement, and the bye sets themselves are dropped. The result
// is that a real card can say "Loser of Match A" instead of a vague
// placeholder, and optimistic routing during a desync can advance that loser
// straight into the right slot - both using the same source pointers they
// already rely on, so no other logic changes.
export function collapseByeSets(rawSets) {
  const sets = rawSets || [];
  if (!sets.some(isByeSet)) return sets;

  const byId = new Map(sets.map((set) => [set.id, set]));

  // Resolve a (sourceSetId, placement) reference down to the nearest real
  // match. Walks through bye sets by following whichever of their slots
  // carries a real "set" source (a bye's winner is just that lone entrant).
  // Returns the original reference for a real/missing source, or null when the
  // chain dead-ends in a fixed seed / empty bye (nothing real to point at).
  function resolveReal(sourceSetId, placement, guard = 0) {
    const source = byId.get(sourceSetId);
    if (!source || !isByeSet(source)) return { sourceSetId, placement };
    if (guard > 64) return null; // guard against a malformed cycle
    const feeder = [source.player1, source.player2].find(
      (slot) => slot?.sourceType === "set" && slot?.sourceSetId,
    );
    if (!feeder) return null;
    return resolveReal(feeder.sourceSetId, feeder.sourcePlacement, guard + 1);
  }

  function rewriteSlot(slot) {
    if (slot?.sourceType !== "set" || !slot?.sourceSetId) return slot;
    const resolved = resolveReal(slot.sourceSetId, slot.sourcePlacement);
    if (!resolved || resolved.sourceSetId === slot.sourceSetId) return slot;
    return { ...slot, sourceSetId: resolved.sourceSetId, sourcePlacement: resolved.placement };
  }

  return sets
    .filter((set) => !isByeSet(set))
    .map((set) => ({
      ...set,
      player1: rewriteSlot(set.player1),
      player2: rewriteSlot(set.player2),
    }));
}

function buildSlotLookups(sets) {
  const byId = new Map(sets.map((set) => [set.id, set]));

  function describeSlot(set, slot, slotNumber) {
    if (slot?.entrantId || slot?.name) {
      return { ...slot, placeholder: null };
    }

    if (slot?.sourceType === "set" && slot?.sourceSetId) {
      const verb = slot.sourcePlacement === 2 ? "Loser" : "Winner";
      const source = byId.get(slot.sourceSetId);
      // The source set is sometimes missing from this same bucket's data
      // (seen specifically for losers round 1, which drops in from winners
      // round 1) - we still know it's a winner/loser drop even without a
      // specific match to name, so say that instead of a bare "TBD".
      const sourceLabel = source ? (source.identifier ? `Match ${source.identifier}` : `Set ${source.id}`) : null;
      return { ...slot, placeholder: sourceLabel ? `${verb} of ${sourceLabel}` : `${verb} of an earlier match` };
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
      // Only draw "winner advances" connectors. Drop lines showing where a
      // set's loser falls to (sourcePlacement === 2) - with winners and
      // losers rounds stacked in separate rows, those lines mostly just
      // crisscross the whole board without adding much clarity.
      if (slot?.sourceType === "set" && slot?.sourceSetId && slot.sourcePlacement !== 2) {
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
  const sets = collapseByeSets(rawSets || []);
  const isBracket = sets.length > 0 && !looksLikePool(sets);

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

  const byId = new Map(enrichedSets.map((set) => [set.id, set]));
  const gf1 = grandFinalSets.find((set) => !isReset(set));
  const gfReset = grandFinalSets.find((set) => isReset(set));

  // start.gg always allocates a slot for the bracket reset, whether or not
  // it ends up needed - only show it once the entrant who came from losers
  // has actually won the first grand final (or the reset was already played,
  // e.g. after a DQ where the heuristic below might not hold).
  const resetIsNeeded =
    Boolean(gfReset) &&
    (Boolean(gfReset.winnerId) ||
      (Boolean(gf1?.winnerId) &&
        [gf1.player1, gf1.player2].some((slot) => {
          if (slot?.sourceType !== "set" || !slot?.sourceSetId) return false;
          const source = byId.get(slot.sourceSetId);
          return Number(source?.round) < 0 && slot.entrantId === gf1.winnerId;
        })));

  const visibleGrandFinalSets = [gf1, resetIsNeeded ? gfReset : null].filter(Boolean);

  const grandFinal = visibleGrandFinalSets.map((set, index) => ({
    key: `gf-${index}`,
    round: set.round,
    label: set.roundText || (index === 0 ? "Grand Final" : "Grand Final Reset"),
    sets: [set],
  }));

  // Losers Finals feeds into Grand Final, but the two live in different rows
  // (losers bracket renders in its own row below winners+GF), so that
  // connector is a long line crossing the whole board for something already
  // obvious once GF's card shows the entrant's name - drop it. Winners
  // Finals -> Grand Final stays: it's a short connector within the same row
  // and is still useful there.
  const lastLosersColumn = losers[losers.length - 1];
  const terminalSetIds = new Set(lastLosersColumn?.sets.map((set) => set.id) ?? []);

  const edges = buildEdges(enrichedSets).filter((edge) => !terminalSetIds.has(edge.fromSetId));

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
