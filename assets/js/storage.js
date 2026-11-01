/**
 * Read-only view of the reading state shared with the flipbook.
 *
 * `flipbook.html` writes progress under STORAGE_KEY; the homepage only reads
 * it. Malformed or hand-edited values are ignored rather than trusted.
 */

const STORAGE_KEY = "wizarding-library:v1";

let memoryState = null;

function makeDefaultState() {
  return { version: 1, lastBook: null, progress: {} };
}

function clampInteger(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function cleanString(value, max = 240) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

function normaliseProgress(entry) {
  if (!entry || typeof entry !== "object") return null;
  const page = clampInteger(entry.page, 1, 100000);
  const totalPages = clampInteger(entry.totalPages, 1, 100000);
  if (page === null || totalPages === null) return null;
  return {
    page: Math.min(page, totalPages),
    totalPages,
    updatedAt: cleanString(entry.updatedAt, 40) || new Date().toISOString(),
  };
}

function normaliseState(raw) {
  const next = makeDefaultState();
  if (!raw || typeof raw !== "object") return next;

  if (typeof raw.lastBook === "string" && raw.lastBook.trim()) {
    next.lastBook = cleanString(raw.lastBook, 120);
  }

  if (raw.progress && typeof raw.progress === "object" && !Array.isArray(raw.progress)) {
    for (const [bookId, entry] of Object.entries(raw.progress)) {
      const id = cleanString(bookId, 120);
      const progress = normaliseProgress(entry);
      if (id && progress) next.progress[id] = progress;
    }
  }

  return next;
}

function readFromStorage() {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return null;
    return normaliseState(JSON.parse(stored));
  } catch (error) {
    console.warn("The Wizarding Library could not read saved reading data.", error);
    return null;
  }
}

function getState() {
  if (!memoryState) {
    memoryState = readFromStorage() || makeDefaultState();
  }
  return memoryState;
}

/* --------------------------------------------------------------------------
   Reading progress
   -------------------------------------------------------------------------- */

export function getProgress(bookId) {
  const progress = getState().progress[bookId];
  return progress ? { ...progress } : null;
}

export function getLastRead() {
  const state = getState();
  if (!state.lastBook) return null;
  const progress = state.progress[state.lastBook] || null;
  return { bookId: state.lastBook, progress: progress ? { ...progress } : null };
}

/** Drop the in-memory copy so a bfcache return or another tab is picked up. */
export function refreshStorage() {
  memoryState = null;
  return getState();
}

export { STORAGE_KEY };
