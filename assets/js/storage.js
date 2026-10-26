/**
 * Small, defensive wrapper around localStorage.
 *
 * Everything lives under one namespaced key so the library can be cleared in
 * one action. All values are validated on read: a hand-edited localStorage
 * entry must never be able to break the reader.
 */

const STORAGE_KEY = "wizarding-library:v1";
const MAX_BOOKMARKS_PER_BOOK = 200;

const DEFAULT_SETTINGS = Object.freeze({
  mode: "scroll",
  theme: "midnight",
  invertPages: false,
  pageTurn: true,
  zoom: "fit",
  musicVolume: 0.55,
});

let memoryState = null;
let storageAvailable = null;

function makeDefaultState() {
  return {
    version: 1,
    lastBook: null,
    progress: {},
    bookmarks: {},
    settings: { ...DEFAULT_SETTINGS },
  };
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

function normaliseBookmark(entry) {
  if (!entry || typeof entry !== "object") return null;
  const page = clampInteger(entry.page, 1, 100000);
  if (page === null) return null;
  return {
    page,
    label: cleanString(entry.label, 140),
    createdAt: cleanString(entry.createdAt, 40) || new Date().toISOString(),
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

  if (raw.bookmarks && typeof raw.bookmarks === "object" && !Array.isArray(raw.bookmarks)) {
    for (const [bookId, entries] of Object.entries(raw.bookmarks)) {
      const id = cleanString(bookId, 120);
      if (!id || !Array.isArray(entries)) continue;
      const seen = new Set();
      const bookmarks = entries
        .map(normaliseBookmark)
        .filter((bookmark) => {
          if (!bookmark || seen.has(bookmark.page)) return false;
          seen.add(bookmark.page);
          return true;
        })
        .sort((a, b) => a.page - b.page)
        .slice(0, MAX_BOOKMARKS_PER_BOOK);
      if (bookmarks.length) next.bookmarks[id] = bookmarks;
    }
  }

  const settings = raw.settings;
  if (settings && typeof settings === "object") {
    if (settings.mode === "scroll" || settings.mode === "book") {
      next.settings.mode = settings.mode;
    }
    if (settings.theme === "midnight" || settings.theme === "study") {
      next.settings.theme = settings.theme;
    }
    next.settings.invertPages = settings.invertPages === true;
    next.settings.pageTurn = settings.pageTurn !== false;
    if (settings.zoom === "fit" || (typeof settings.zoom === "number" && settings.zoom >= 0.5 && settings.zoom <= 2.5)) {
      next.settings.zoom = settings.zoom;
    }
    if (typeof settings.musicVolume === "number" && settings.musicVolume >= 0 && settings.musicVolume <= 1) {
      next.settings.musicVolume = settings.musicVolume;
    }
  }

  return next;
}

function readFromStorage() {
  if (!isStorageAvailable()) return null;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return null;
    return normaliseState(JSON.parse(stored));
  } catch (error) {
    console.warn("The Wizarding Library could not read saved reading data.", error);
    return null;
  }
}

function writeToStorage(state) {
  if (!isStorageAvailable()) return false;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch (error) {
    console.warn("The Wizarding Library could not save reading data.", error);
    return false;
  }
}

function isStorageAvailable() {
  if (storageAvailable !== null) return storageAvailable;
  try {
    const probe = `${STORAGE_KEY}:probe`;
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    storageAvailable = true;
  } catch {
    storageAvailable = false;
  }
  return storageAvailable;
}

function getState() {
  if (!memoryState) {
    memoryState = readFromStorage() || makeDefaultState();
  }
  return memoryState;
}

function commit() {
  const state = getState();
  writeToStorage(state);
  return state;
}

/* --------------------------------------------------------------------------
   Reading progress
   -------------------------------------------------------------------------- */

export function getProgress(bookId) {
  const progress = getState().progress[bookId];
  return progress ? { ...progress } : null;
}

export function setProgress(bookId, page, totalPages) {
  const cleanId = cleanString(bookId, 120);
  const cleanPage = clampInteger(page, 1, 100000);
  const cleanTotal = clampInteger(totalPages, 1, 100000);
  if (!cleanId || cleanPage === null || cleanTotal === null) return null;

  const state = getState();
  const progress = {
    page: Math.min(cleanPage, cleanTotal),
    totalPages: cleanTotal,
    updatedAt: new Date().toISOString(),
  };
  state.progress[cleanId] = progress;
  state.lastBook = cleanId;
  commit();
  return { ...progress };
}

export function clearProgress(bookId) {
  const state = getState();
  if (state.progress[bookId]) {
    delete state.progress[bookId];
    if (state.lastBook === bookId) state.lastBook = null;
    commit();
  }
}

export function getLastBookId() {
  return getState().lastBook;
}

export function setLastBook(bookId) {
  const cleanId = cleanString(bookId, 120);
  if (!cleanId) return;
  const state = getState();
  if (state.lastBook !== cleanId) {
    state.lastBook = cleanId;
    commit();
  }
}

export function getLastRead() {
  const state = getState();
  if (!state.lastBook) return null;
  const progress = state.progress[state.lastBook] || null;
  return { bookId: state.lastBook, progress: progress ? { ...progress } : null };
}

/* --------------------------------------------------------------------------
   Bookmarks
   -------------------------------------------------------------------------- */

export function getBookmarks(bookId) {
  const bookmarks = getState().bookmarks[bookId];
  return Array.isArray(bookmarks) ? bookmarks.map((bookmark) => ({ ...bookmark })) : [];
}

export function isBookmarked(bookId, page) {
  const cleanPage = clampInteger(page, 1, 100000);
  if (cleanPage === null) return false;
  return getBookmarks(bookId).some((bookmark) => bookmark.page === cleanPage);
}

export function toggleBookmark(bookId, page, label = "") {
  const cleanId = cleanString(bookId, 120);
  const cleanPage = clampInteger(page, 1, 100000);
  if (!cleanId || cleanPage === null) {
    return { bookmarked: false, bookmarks: [] };
  }

  const state = getState();
  const bookmarks = Array.isArray(state.bookmarks[cleanId]) ? state.bookmarks[cleanId] : [];
  const existingIndex = bookmarks.findIndex((bookmark) => bookmark.page === cleanPage);
  let bookmarked = false;

  if (existingIndex >= 0) {
    bookmarks.splice(existingIndex, 1);
  } else {
    bookmarks.push({
      page: cleanPage,
      label: cleanString(label, 140),
      createdAt: new Date().toISOString(),
    });
    bookmarked = true;
  }

  bookmarks.sort((a, b) => a.page - b.page);
  if (bookmarks.length) {
    state.bookmarks[cleanId] = bookmarks.slice(0, MAX_BOOKMARKS_PER_BOOK);
  } else {
    delete state.bookmarks[cleanId];
  }
  if (state.lastBook !== cleanId) state.lastBook = cleanId;
  commit();
  return { bookmarked, bookmarks: getBookmarks(cleanId) };
}

export function removeBookmark(bookId, page) {
  const cleanPage = clampInteger(page, 1, 100000);
  if (cleanPage === null) return getBookmarks(bookId);
  const bookmarks = getBookmarks(bookId).filter((bookmark) => bookmark.page !== cleanPage);
  const state = getState();
  if (bookmarks.length) {
    state.bookmarks[bookId] = bookmarks;
  } else {
    delete state.bookmarks[bookId];
  }
  commit();
  return bookmarks;
}

/* --------------------------------------------------------------------------
   Display settings
   -------------------------------------------------------------------------- */

export function getSettings() {
  return { ...getState().settings };
}

export function updateSettings(patch) {
  if (!patch || typeof patch !== "object") return getSettings();
  const state = getState();
  const next = { ...state.settings };

  if (patch.mode === "scroll" || patch.mode === "book") next.mode = patch.mode;
  if (patch.theme === "midnight" || patch.theme === "study") next.theme = patch.theme;
  if (typeof patch.invertPages === "boolean") next.invertPages = patch.invertPages;
  if (typeof patch.pageTurn === "boolean") next.pageTurn = patch.pageTurn;
  if (patch.zoom === "fit" || (typeof patch.zoom === "number" && patch.zoom >= 0.5 && patch.zoom <= 2.5)) {
    next.zoom = patch.zoom;
  }
  if (typeof patch.musicVolume === "number" && patch.musicVolume >= 0 && patch.musicVolume <= 1) {
    next.musicVolume = patch.musicVolume;
  }

  state.settings = next;
  commit();
  return { ...next };
}

export function isPersistentStorageAvailable() {
  return isStorageAvailable();
}

/** Drop the in-memory copy so a bfcache return or another tab is picked up. */
export function refreshStorage() {
  memoryState = null;
  storageAvailable = null;
  return getState();
}

export { DEFAULT_SETTINGS, STORAGE_KEY };
