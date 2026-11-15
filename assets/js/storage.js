/**
 * Shared reading state for AVADRA.
 *
 * Both readers write to one localStorage record per book, under STORAGE_KEY:
 *
 *   {
 *     version: 1,
 *     lastBook: "<book id>",
 *     progress: {
 *       "<book id>": {
 *         page, totalPages,          // PDF page position (DearFlip / Foliate)
 *         fraction,                  // normalised 0–1 position (EPUB / fallback)
 *         cfi,                       // EPUB persistent location, when available
 *         kind: "pdf" | "epub",
 *         engine: "dearflip" | "foliate",
 *         updatedAt
 *       }
 *     }
 *   }
 *
 * Older records contain only `page`, `totalPages`, and `updatedAt`; they remain
 * valid and are read without migration. Unknown fields written by older copies
 * of the site are preserved when a reader saves a new position.
 */

const STORAGE_KEY = "avadra-library:v1";
const MAX_PAGE = 100000;
const MAX_CFI = 2000;

let memoryState = null;

function makeDefaultState() {
  return { version: 1, lastBook: null, progress: {} };
}

function clampInteger(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function clampFraction(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(1, Math.max(0, number));
}

function cleanString(value, max = 240) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

function normaliseProgress(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;

  const page = clampInteger(entry.page, 1, MAX_PAGE);
  const totalPages = clampInteger(entry.totalPages, 1, MAX_PAGE);
  const fraction = clampFraction(entry.fraction);
  const cfi = cleanString(entry.cfi, MAX_CFI);
  const kind = cleanString(entry.kind, 20).toLowerCase();
  const engine = cleanString(entry.engine, 30);

  // A record needs at least one kind of position. A bare timestamp is not a
  // reading position and is ignored.
  if (page === null && fraction === null && !cfi) return null;

  const progress = {};
  if (page !== null && totalPages !== null) {
    progress.page = Math.min(page, totalPages);
    progress.totalPages = totalPages;
  }
  if (fraction !== null) progress.fraction = fraction;
  if (cfi) progress.cfi = cfi;
  if (kind) progress.kind = kind;
  if (engine) progress.engine = engine;
  progress.updatedAt = cleanString(entry.updatedAt, 40) || new Date().toISOString();
  return progress;
}

function normaliseState(raw) {
  const next = makeDefaultState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return next;

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

/** Raw, forgiving read used by the writers. Keeps unknown fields intact. */
function readRawState() {
  let stored;
  try {
    stored = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return makeDefaultState();
  }
  if (!stored) return makeDefaultState();

  try {
    const parsed = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return makeDefaultState();
    }
    if (!parsed.progress || typeof parsed.progress !== "object" || Array.isArray(parsed.progress)) {
      parsed.progress = {};
    }
    return parsed;
  } catch (error) {
    console.warn("AVADRA could not read saved reading data.", error);
    return makeDefaultState();
  }
}

function writeRawState(state) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    // The homepage keeps a normalised in-memory copy. Invalidate it so a
    // reader tab and the library tab never disagree after a save.
    memoryState = null;
    return true;
  } catch (error) {
    // Storage can be unavailable (private mode, quota). Reading must never
    // depend on it.
    console.warn("AVADRA could not save the reading position.", error);
    return false;
  }
}

function readFromStorage() {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return null;
    return normaliseState(JSON.parse(stored));
  } catch (error) {
    console.warn("AVADRA could not read saved reading data.", error);
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
  const id = cleanString(bookId, 120);
  if (!id) return null;
  const progress = getState().progress[id];
  return progress ? { ...progress } : null;
}

/**
 * Read a position straight from localStorage, bypassing the homepage cache.
 * Readers use this when they open so a position saved in another tab is seen
 * immediately.
 */
export function getProgressFresh(bookId) {
  memoryState = null;
  return getProgress(bookId);
}

export function getLastRead() {
  const state = getState();
  if (!state.lastBook) return null;
  const progress = state.progress[state.lastBook] || null;
  return { bookId: state.lastBook, progress: progress ? { ...progress } : null };
}

/**
 * Merge a reading position into the shared record. Explicit nulls remove a
 * field (for example, a PDF save clears a stale EPUB CFI). Returns true only
 * when localStorage actually changed.
 */
export function saveProgress(bookId, patch = {}) {
  const id = cleanString(bookId, 120);
  if (!id || !patch || typeof patch !== "object" || Array.isArray(patch)) return false;

  const state = readRawState();
  const existing = state.progress[id];
  const current =
    existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
  const next = { ...current };
  let changed = false;

  const set = (key, value) => {
    if (next[key] !== value) {
      next[key] = value;
      changed = true;
    }
  };
  const remove = (key) => {
    if (key in next) {
      delete next[key];
      changed = true;
    }
  };

  if ("page" in patch) {
    if (patch.page === null) remove("page");
    else {
      const page = clampInteger(patch.page, 1, MAX_PAGE);
      if (page !== null) set("page", page);
    }
  }

  if ("totalPages" in patch) {
    if (patch.totalPages === null) remove("totalPages");
    else {
      const total = clampInteger(patch.totalPages, 1, MAX_PAGE);
      if (total !== null) set("totalPages", total);
    }
  }

  if ("fraction" in patch) {
    if (patch.fraction === null) remove("fraction");
    else {
      const fraction = clampFraction(patch.fraction);
      if (fraction !== null) set("fraction", fraction);
    }
  }

  if ("cfi" in patch) {
    if (patch.cfi === null || patch.cfi === "") remove("cfi");
    else {
      const cfi = cleanString(patch.cfi, MAX_CFI);
      if (cfi) set("cfi", cfi);
    }
  }

  if ("kind" in patch) {
    if (patch.kind === null || patch.kind === "") remove("kind");
    else set("kind", cleanString(patch.kind, 20).toLowerCase());
  }

  if ("engine" in patch) {
    if (patch.engine === null || patch.engine === "") remove("engine");
    else set("engine", cleanString(patch.engine, 30));
  }

  // PDF locations are page numbers, never EPUB CFIs. Clear any stale CFI left
  // by an earlier edition of the same catalogue record.
  if (patch.kind === "pdf") remove("cfi");

  if (next.page !== undefined && next.totalPages !== undefined) {
    const page = clampInteger(next.page, 1, MAX_PAGE);
    const total = clampInteger(next.totalPages, 1, MAX_PAGE);
    if (page === null || total === null) {
      remove("page");
      remove("totalPages");
    } else if (page > total) {
      set("page", total);
    }
  }

  // Avoid pointless writes (and needless cross-tab events) when the reader
  // reports the position it already saved.
  if (!changed && state.lastBook === id) return false;

  next.updatedAt = new Date().toISOString();
  state.progress[id] = next;
  state.lastBook = id;
  if (state.version === undefined) state.version = 1;

  return writeRawState(state);
}

/** Drop the in-memory copy so a bfcache return or another tab is picked up. */
export function refreshStorage() {
  memoryState = null;
  return getState();
}

export { STORAGE_KEY };
