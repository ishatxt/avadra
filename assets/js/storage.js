/**
 * Reading state for AVADRA.
 *
 * Everything here is local to the browser: progress, last-read metadata,
 * bookmarks, reader preferences, and the small metadata records for PDFs the
 * reader keeps in IndexedDB. The PDF blobs themselves never pass through this
 * module; see pdf-store.js.
 *
 * The previous site wrote a single progress key. That key is read once during
 * migration and is never written again.
 */

const STORAGE_KEY = "avadra:library:v2";
const LEGACY_STORAGE_KEY = "wizarding-library:v1";

const THEMES = new Set(["midnight", "parchment", "dark"]);
const WIDTHS = new Set(["narrow", "comfortable", "wide", "full"]);
const FIT_MODES = new Set(["width", "page"]);
const PANELS = new Set(["pages", "search", "bookmarks", "settings"]);
const LAYOUTS = new Set(["single", "book"]);
const DIRECTIONS = new Set(["ltr", "rtl"]);
const EFFECTS = new Set(["3d", "2d"]);

const DEFAULT_PREFERENCES = Object.freeze({
  theme: "midnight",
  readingWidth: "comfortable",
  brightness: 95,
  fitMode: "width",
  focusMode: false,
  pageAnimations: true,
  layout: "book",
  direction: "ltr",
  effect: "3d",
  lastPanel: "pages",
});

let memoryState = null;

function makeDefaultState() {
  return {
    version: 2,
    lastBook: null,
    lastBookMeta: null,
    progress: {},
    bookmarks: {},
    preferences: { ...DEFAULT_PREFERENCES },
    localBooks: {},
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

function cleanId(value) {
  const id = cleanString(value, 120);
  return /^[a-z0-9][a-z0-9._:-]*$/i.test(id) ? id : "";
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

function normaliseMeta(entry) {
  if (!entry || typeof entry !== "object") return null;
  const id = cleanId(entry.id);
  if (!id) return null;
  const access = entry.access === "personal" ? "personal" : entry.access === "local" ? "local" : "open";
  return {
    id,
    title: cleanString(entry.title, 220) || "Untitled",
    author: cleanString(entry.author, 160) || "Unknown author",
    access,
    category: cleanString(entry.category, 60) || (access === "open" ? "Open Shelf" : "Private Editions"),
    totalPages: clampInteger(entry.totalPages, 1, 100000),
    updatedAt: cleanString(entry.updatedAt, 40) || new Date().toISOString(),
  };
}

function normalisePreferences(raw) {
  const next = { ...DEFAULT_PREFERENCES };
  if (!raw || typeof raw !== "object") return next;

  if (THEMES.has(raw.theme)) next.theme = raw.theme;
  if (WIDTHS.has(raw.readingWidth)) next.readingWidth = raw.readingWidth;
  if (FIT_MODES.has(raw.fitMode)) next.fitMode = raw.fitMode;
  if (PANELS.has(raw.lastPanel)) next.lastPanel = raw.lastPanel;
  if (LAYOUTS.has(raw.layout)) next.layout = raw.layout;
  if (DIRECTIONS.has(raw.direction)) next.direction = raw.direction;
  if (EFFECTS.has(raw.effect)) next.effect = raw.effect;

  const brightness = clampInteger(raw.brightness, 70, 110);
  if (brightness !== null) next.brightness = brightness;

  if (typeof raw.focusMode === "boolean") next.focusMode = raw.focusMode;
  if (typeof raw.pageAnimations === "boolean") next.pageAnimations = raw.pageAnimations;

  return next;
}

function normaliseBookmark(entry) {
  if (!entry || typeof entry !== "object") return null;
  const page = clampInteger(entry.page, 1, 100000);
  if (page === null) return null;
  return {
    page,
    label: cleanString(entry.label, 200) || `Page ${page}`,
    createdAt: cleanString(entry.createdAt, 40) || new Date().toISOString(),
  };
}

function normaliseState(raw) {
  const next = makeDefaultState();
  if (!raw || typeof raw !== "object") return next;

  if (typeof raw.lastBook === "string") {
    const lastBook = cleanId(raw.lastBook);
    if (lastBook) next.lastBook = lastBook;
  }

  if (raw.progress && typeof raw.progress === "object" && !Array.isArray(raw.progress)) {
    for (const [bookId, entry] of Object.entries(raw.progress)) {
      const id = cleanId(bookId);
      const progress = normaliseProgress(entry);
      if (id && progress) next.progress[id] = progress;
    }
  }

  if (raw.bookmarks && typeof raw.bookmarks === "object" && !Array.isArray(raw.bookmarks)) {
    for (const [bookId, entries] of Object.entries(raw.bookmarks)) {
      const id = cleanId(bookId);
      if (!id || !Array.isArray(entries)) continue;
      const seen = new Set();
      const list = [];
      for (const entry of entries) {
        const bookmark = normaliseBookmark(entry);
        if (!bookmark || seen.has(bookmark.page)) continue;
        seen.add(bookmark.page);
        list.push(bookmark);
        if (list.length >= 200) break;
      }
      if (list.length) {
        list.sort((a, b) => a.page - b.page);
        next.bookmarks[id] = list;
      }
    }
  }

  next.preferences = normalisePreferences(raw.preferences);
  next.lastBookMeta = normaliseMeta(raw.lastBookMeta);

  if (raw.localBooks && typeof raw.localBooks === "object" && !Array.isArray(raw.localBooks)) {
    for (const [bookId, entry] of Object.entries(raw.localBooks)) {
      const id = cleanId(bookId);
      if (!id || !entry || typeof entry !== "object") continue;
      next.localBooks[id] = {
        id,
        name: cleanString(entry.name, 240) || "Local PDF",
        size: clampInteger(entry.size, 0, 2_000_000_000) || 0,
        addedAt: cleanString(entry.addedAt, 40) || new Date().toISOString(),
      };
      if (Object.keys(next.localBooks).length >= 50) break;
    }
  }

  return next;
}

function readJson(key) {
  try {
    const stored = window.localStorage.getItem(key);
    if (!stored) return null;
    return JSON.parse(stored);
  } catch (error) {
    console.warn(`AVADRA could not read ${key}.`, error);
    return null;
  }
}

function readFromStorage() {
  const stored = readJson(STORAGE_KEY);
  if (stored) return normaliseState(stored);

  const legacy = readJson(LEGACY_STORAGE_KEY);
  if (legacy) return normaliseState({ ...legacy, version: 2 });

  return null;
}

function getState() {
  if (!memoryState) {
    memoryState = readFromStorage() || makeDefaultState();
  }
  return memoryState;
}

function saveState() {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(getState()));
    return true;
  } catch (error) {
    console.warn("AVADRA could not save reading data.", error);
    return false;
  }
}

/* --------------------------------------------------------------------------
   Reading progress
   -------------------------------------------------------------------------- */

export function getProgress(bookId) {
  const id = cleanId(bookId);
  if (!id) return null;
  const progress = getState().progress[id];
  return progress ? { ...progress } : null;
}

export function getLastRead() {
  const state = getState();
  if (!state.lastBook) return null;
  const progress = state.progress[state.lastBook] || null;
  return {
    bookId: state.lastBook,
    progress: progress ? { ...progress } : null,
    meta: state.lastBookMeta ? { ...state.lastBookMeta } : null,
  };
}

export function setProgress(bookId, page, totalPages) {
  const id = cleanId(bookId);
  const progress = normaliseProgress({
    page,
    totalPages,
    updatedAt: new Date().toISOString(),
  });
  if (!id || !progress) return null;

  const state = getState();
  state.progress[id] = progress;
  saveState();
  return { ...progress };
}

export function setLastRead(bookId, page, totalPages, meta = {}) {
  const id = cleanId(bookId);
  const progress = normaliseProgress({
    page,
    totalPages,
    updatedAt: new Date().toISOString(),
  });
  if (!id || !progress) return null;

  const state = getState();
  state.lastBook = id;
  state.progress[id] = progress;
  state.lastBookMeta = normaliseMeta({
    id,
    title: meta.title,
    author: meta.author,
    access: meta.access,
    category: meta.category,
    totalPages: progress.totalPages,
    updatedAt: progress.updatedAt,
  });
  saveState();
  return { ...progress };
}

export function clearBookReadingData(bookId) {
  const id = cleanId(bookId);
  if (!id) return;
  const state = getState();
  delete state.progress[id];
  delete state.bookmarks[id];
  if (state.lastBook === id) {
    state.lastBook = null;
    state.lastBookMeta = null;
  }
  saveState();
}

export function forgetBook(bookId) {
  const id = cleanId(bookId);
  if (!id) return;
  const state = getState();
  delete state.progress[id];
  delete state.bookmarks[id];
  delete state.localBooks[id];
  if (state.lastBook === id) {
    state.lastBook = null;
    state.lastBookMeta = null;
  }
  saveState();
}

/** Drop the in-memory copy so a bfcache return or another tab is picked up. */
export function refreshStorage() {
  memoryState = null;
  return getState();
}

/* --------------------------------------------------------------------------
   Bookmarks
   -------------------------------------------------------------------------- */

export function getBookmarks(bookId) {
  const id = cleanId(bookId);
  if (!id) return [];
  const list = getState().bookmarks[id] || [];
  return list.map((entry) => ({ ...entry })).sort((a, b) => a.page - b.page);
}

export function hasBookmark(bookId, page) {
  const id = cleanId(bookId);
  const target = clampInteger(page, 1, 100000);
  if (!id || target === null) return false;
  return (getState().bookmarks[id] || []).some((entry) => entry.page === target);
}

export function addBookmark(bookId, page, label = "") {
  const id = cleanId(bookId);
  const target = clampInteger(page, 1, 100000);
  if (!id || target === null) return null;

  const state = getState();
  const list = (state.bookmarks[id] || []).filter((entry) => entry.page !== target);
  const entry = {
    page: target,
    label: cleanString(label, 200) || `Page ${target}`,
    createdAt: new Date().toISOString(),
  };
  list.push(entry);
  list.sort((a, b) => a.page - b.page);
  state.bookmarks[id] = list.slice(0, 200);
  saveState();
  return { ...entry };
}

export function removeBookmark(bookId, page) {
  const id = cleanId(bookId);
  const target = clampInteger(page, 1, 100000);
  if (!id || target === null) return false;

  const state = getState();
  const list = state.bookmarks[id] || [];
  const next = list.filter((entry) => entry.page !== target);
  if (next.length === list.length) return false;
  if (next.length) state.bookmarks[id] = next;
  else delete state.bookmarks[id];
  saveState();
  return true;
}

export function toggleBookmark(bookId, page, label = "") {
  const target = clampInteger(page, 1, 100000);
  if (target === null) return { added: false, bookmark: null };
  if (hasBookmark(bookId, target)) {
    removeBookmark(bookId, target);
    return { added: false, bookmark: null };
  }
  return { added: true, bookmark: addBookmark(bookId, target, label) };
}

/* --------------------------------------------------------------------------
   Preferences
   -------------------------------------------------------------------------- */

export function getPreferences() {
  return { ...getState().preferences };
}

export function setPreferences(partial) {
  const state = getState();
  state.preferences = normalisePreferences({ ...state.preferences, ...partial });
  saveState();
  return { ...state.preferences };
}

/* --------------------------------------------------------------------------
   Local PDF metadata (blobs live in IndexedDB)
   -------------------------------------------------------------------------- */

export function getLocalBooks() {
  const state = getState();
  return Object.values(state.localBooks)
    .map((entry) => ({ ...entry }))
    .sort((a, b) => Date.parse(b.addedAt || 0) - Date.parse(a.addedAt || 0));
}

export function addLocalBook(entry) {
  const id = cleanId(entry?.id);
  if (!id) return null;
  const state = getState();
  state.localBooks[id] = {
    id,
    name: cleanString(entry.name, 240) || "Local PDF",
    size: clampInteger(entry.size, 0, 2_000_000_000) || 0,
    addedAt: cleanString(entry.addedAt, 40) || new Date().toISOString(),
  };
  saveState();
  return { ...state.localBooks[id] };
}

export function removeLocalBook(bookId) {
  const id = cleanId(bookId);
  if (!id) return;
  const state = getState();
  delete state.localBooks[id];
  saveState();
}

export function clearReadingData() {
  const state = getState();
  state.lastBook = null;
  state.lastBookMeta = null;
  state.progress = {};
  state.bookmarks = {};
  saveState();
  return getState();
}

export { STORAGE_KEY, LEGACY_STORAGE_KEY, DEFAULT_PREFERENCES };
