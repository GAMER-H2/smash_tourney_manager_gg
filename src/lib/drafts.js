// Locally-saved (not yet submitted) set results.
//
// Scores typed into a set editor are only on start.gg once someone presses
// submit, and a set can easily leave the editor before that happens - the
// quick-report modal gets dismissed, or a set is pulled off stream part-way
// through. Rather than losing that, the editor state is saved to disk keyed
// by set id and offered back the next time the same set is opened, with a
// reminder that start.gg still doesn't know about it.
//
// Everything here is pure data handling; persistence lives in api.js.

import { cloneEditorSet, hasResult } from "./set-utils";

export const DRAFT_STORE_VERSION = 1;

export function emptyDraftStore() {
  return { version: DRAFT_STORE_VERSION, drafts: {} };
}

// Tolerates anything the on-disk file might hold (including a store written
// by a future version, or junk) - a broken drafts file should never stop the
// app loading a tournament.
export function normalizeDraftStore(raw) {
  const drafts = raw && typeof raw === "object" ? raw.drafts : null;
  if (!drafts || typeof drafts !== "object") return emptyDraftStore();

  const valid = Object.entries(drafts).filter(
    ([setId, draft]) => setId && draft && typeof draft === "object" && draft.editorSet,
  );

  return { version: DRAFT_STORE_VERSION, drafts: Object.fromEntries(valid) };
}

export function makeDraft(editorSet, tournamentSlug, now = Date.now()) {
  return {
    setId: String(editorSet.setId),
    tournamentSlug: tournamentSlug || "",
    savedAt: now,
    editorSet: cloneEditorSet(editorSet),
  };
}

// Saves the editor state for a set, or clears any existing draft for it when
// there's nothing worth keeping (an untouched set, or one whose results were
// just cleared) - so backing out of a set you didn't score doesn't leave a
// permanent "unsubmitted" marker on the bracket.
export function putDraft(store, editorSet, tournamentSlug, now = Date.now()) {
  const base = normalizeDraftStore(store);
  if (!editorSet?.setId) return base;

  const setId = String(editorSet.setId);
  if (!hasResult(editorSet)) return removeDraft(base, setId);

  return {
    ...base,
    drafts: { ...base.drafts, [setId]: makeDraft(editorSet, tournamentSlug, now) },
  };
}

export function removeDraft(store, setId) {
  const base = normalizeDraftStore(store);
  if (!setId) return base;

  const { [String(setId)]: _removed, ...rest } = base.drafts;
  return { ...base, drafts: rest };
}

// Set ids are only unique within a tournament, so a draft is only offered
// back for the tournament it was saved against.
export function getDraft(store, setId, tournamentSlug) {
  if (!setId) return null;
  const draft = normalizeDraftStore(store).drafts[String(setId)];
  if (!draft) return null;
  if (tournamentSlug && draft.tournamentSlug && draft.tournamentSlug !== tournamentSlug) {
    return null;
  }
  return draft;
}

export function draftSetIds(store, tournamentSlug) {
  return Object.values(normalizeDraftStore(store).drafts)
    .filter((draft) => !tournamentSlug || !draft.tournamentSlug || draft.tournamentSlug === tournamentSlug)
    .map((draft) => draft.setId);
}

// Human-readable age for the "still not submitted" reminder - a TO glancing
// at it cares about "20 minutes ago", not a timestamp.
export function describeDraftAge(savedAt, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - (Number(savedAt) || 0)) / 1000));
  if (seconds < 60) return "just now";

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
