/**
 * AVADRA reading room.
 *
 * A local-first PDF reader built on the vendored PDF.js 3.11 worker build.
 * The catalogue supplies open-shelf editions and private-edition records;
 * user PDFs live in IndexedDB and never leave the browser.
 *
 * The reader owns one document at a time. A monotonically increasing load
 * token invalidates every async job from a previous document so a fast
 * page turn, a cancelled download, or a replaced PDF cannot paint stale
 * output into the current canvas.
 */

import {
  loadCatalogue,
  getBookById,
  getOpenBooks,
  escapeHtml,
} from "./catalogue.js";
import {
  getPreferences,
  setPreferences,
  getProgress,
  getLastRead,
  setLastRead,
  getBookmarks,
  hasBookmark,
  addBookmark,
  removeBookmark,
  clearBookReadingData,
  forgetBook,
  addLocalBook,
} from "./storage.js";
import {
  getPdf,
  putPdf,
  listPdfs,
  deletePdf,
  isStorageAvailable,
} from "./pdf-store.js";

/* --------------------------------------------------------------------------
   Constants and DOM
   -------------------------------------------------------------------------- */

const PDFJS_BASE = new URL("../vendor/pdfjs/", import.meta.url);
const PDFJS_SCRIPT = new URL("pdf.min.js", PDFJS_BASE).href;
const PDFJS_WORKER = new URL("pdf.worker.min.js", PDFJS_BASE).href;

const MAX_FILE_BYTES = 160 * 1024 * 1024;
const MAX_SEARCH_RESULTS = 120;
const MAX_PAGE_TEXT_CACHE = 200;
const MAX_THUMB_CACHE = 80;
const MAX_OUTLINE_ENTRIES = 300;
const MAX_RENDER_PIXELS = 20_000_000;
const THUMB_WIDTH = 150;

const THEME_ORDER = ["midnight", "parchment", "dark"];
const THEME_LABELS = {
  midnight: "Midnight",
  parchment: "Parchment",
  dark: "Dark",
};
const THEME_META_COLORS = {
  midnight: "#070d14",
  parchment: "#d7cab1",
  dark: "#040506",
};
const THEME_ICONS = {
  midnight: "moon",
  parchment: "sun",
  dark: "contrast",
};

const WIDTH_LIMITS = {
  narrow: 680,
  comfortable: 900,
  wide: 1120,
  full: Number.POSITIVE_INFINITY,
};

const FIT_MODES = new Set(["width", "page"]);
const PANELS = new Set(["pages", "search", "bookmarks", "settings"]);
const LAYOUTS = new Set(["single", "book", "scroll"]);
const DIRECTIONS = new Set(["ltr", "rtl"]);
const EFFECTS = new Set(["3d", "2d"]);
const MOBILE_BOOK_BREAKPOINT = 760;
const LEAF_TURN_MS = 640;
const SCROLL_PAGE_GAP = 24;

const SEARCH_HINT =
  "Search the full text of this PDF. Results jump straight to the page.";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const dom = {
  stage: $("#reader-stage"),
  pageWrap: $("#reader-page-wrap"),
  canvas: $("#pdf-canvas"),
  leaf: $("#reader-leaf"),
  leafFront: $("#pdf-leaf-front"),
  leafBack: $("#pdf-leaf-back"),
  peel: $("#reader-peel"),
  peelFront: $("#pdf-peel-front"),
  peelBack: $("#pdf-peel-back"),
  scrollWrap: $("#reader-scroll-wrap"),
  renderLoading: $("#reader-render-loading"),
  loading: $("#reader-loading"),
  loadingTitle: $("#reader-loading-title"),
  loadingStatus: $("#reader-loading-status"),
  loadingBar: $("#reader-loading-bar"),
  loadingFill: $("#reader-loading-fill"),
  statePanel: $("#reader-state"),
  progressFill: $("#reader-progress-fill"),
  bookTitle: $("#reader-book-title"),
  bookAuthor: $("#reader-book-author"),
  pageInput: $("#page-input"),
  pageTotal: $("#page-total"),
  pageSlider: $("#page-slider"),
  zoomLabel: $("#zoom-label"),
  showControls: $("#reader-show-controls"),
  drawer: $("#reader-drawer"),
  drawerBody: $("#reader-drawer-body"),
  scrim: $("#reader-scrim"),
  tabs: $(".reader-tabs"),
  thumbs: $("#reader-thumbs"),
  outlineSection: $("#reader-outline-section"),
  outline: $("#reader-outline"),
  searchForm: $("#reader-search-form"),
  searchInput: $("#reader-search-input"),
  searchStatus: $("#reader-search-status"),
  searchResults: $("#reader-search-results"),
  bookmarks: $("#reader-bookmarks"),
  copyInfo: $("#reader-copy-info"),
  brightnessInput: $("#brightness-input"),
  brightnessValue: $("#brightness-value"),
  focusToggle: $("#focus-toggle"),
  animationsToggle: $("#animations-toggle"),
  toast: $("#reader-toast"),
  shortcutsDialog: $("#shortcuts-dialog"),
  confirmDialog: $("#confirm-dialog"),
  confirmTitle: $("#confirm-title"),
  confirmMessage: $("#confirm-message"),
  confirmOk: $("#confirm-ok"),
  fileInput: $("#reader-file-input"),
};

const state = {
  catalogue: null,
  catalogueError: null,
  book: null,

  pdf: null,
  loadingTask: null,
  renderTask: null,
  loadToken: 0,
  documentToken: -1,
  renderToken: 0,
  lastRenderedPage: 0,
  totalPages: 0,
  currentPage: 1,

  zoom: 1,
  fitMode: "width",
  readingWidth: "comfortable",
  theme: "midnight",
  brightness: 95,
  focusMode: false,
  pageAnimations: true,
  layout: "book",
  direction: "ltr",
  effect: "3d",
  controlsHidden: false,

  pageSize: null,
  spreadStart: 0,
  spreadPages: [],
  scrollPages: [],
  scrollRendered: new Set(),
  peel: null,

  drawerOpen: false,
  activePanel: "pages",
  lastFocus: null,

  localMode: false,
  storedRecord: null,
  pendingSave: null,
  lastSource: null,
  canPersist: false,
  suppressSaveOnce: false,

  saveTimer: null,
  toastTimer: null,
  viewTimer: null,
  resizeTimer: null,

  thumbObserver: null,
  thumbJobs: [],
  thumbActive: 0,
  thumbCache: new Map(),
  thumbsBuilt: false,
  thumbsToken: -1,

  textCache: new Map(),
  outlineEntries: [],
  searchToken: 0,

  pdfjsPromise: null,
  confirmCallback: null,
  resizeObserver: null,
  swipeStart: null,

  destroyed: false,
};

/* --------------------------------------------------------------------------
   Small helpers
   -------------------------------------------------------------------------- */

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function prefersReducedMotion() {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normaliseText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "Size unknown";
  const units = ["B", "KB", "MB", "GB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toFixed(amount >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function prettyFileName(name) {
  const base = String(name || "Local PDF")
    .replace(/\.pdf$/i, "")
    .replace(/_+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (base || "Local PDF").slice(0, 220);
}

function splitTitle(title) {
  const words = String(title || "Untitled").split(/\s+/);
  if (words.length <= 2) return [String(title || "Untitled")];
  const midpoint = Math.ceil(words.length / 2);
  return [words.slice(0, midpoint).join(" "), words.slice(midpoint).join(" ")];
}

function setReaderUrl(name, value) {
  try {
    const url = new URL(location.href);
    url.searchParams.delete("book");
    url.searchParams.delete("local");
    if (name && value) url.searchParams.set(name, value);
    history.replaceState(null, "", url);
  } catch (error) {
    /* History is unavailable on some file:// contexts. The reader still works. */
  }
}

function updateTitle(
  book,
  fallbackTitle = "Reading room",
  fallbackAuthor = "Choose a volume or open a PDF",
) {
  if (book) {
    dom.bookTitle.textContent = book.title;
    dom.bookAuthor.textContent = book.author;
    document.title = `${book.title} — AVADRA`;
  } else {
    dom.bookTitle.textContent = fallbackTitle;
    dom.bookAuthor.textContent = fallbackAuthor;
    document.title = `${fallbackTitle} — AVADRA`;
  }
}

/* --------------------------------------------------------------------------
   Boot
   -------------------------------------------------------------------------- */

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}

async function boot() {
  applyPreferences(getPreferences());
  bindEvents();
  setupResize();
  setupLifecycle();

  /* PDF.js rejects cancelled render tasks. Every cancel site in AVADRA
     handles that rejection, but a cancelled task can still surface as an
     unhandled rejection during fast navigation; cancelled renders are not
     errors, so silence them globally. */
  window.addEventListener("unhandledrejection", (event) => {
    if (event.reason?.name === "RenderingCancelledException") {
      event.preventDefault();
    }
  });

  updateThemeUI();
  updateWidthUI();
  updateFitUI();
  updateZoomUI();
  updateAnimationsUI();
  updateFullscreenUI();
  updateFocusUI(false);
  setBodyState("boot");

  try {
    state.catalogue = await loadCatalogue();
  } catch (error) {
    state.catalogueError = error;
    console.warn("AVADRA could not load the catalogue.", error);
  }

  const params = new URLSearchParams(location.search);
  const bookId = params.get("book");
  const localId = params.get("local");

  if (localId) {
    await openLocalById(localId);
    return;
  }

  if (bookId) {
    if (!state.catalogue) {
      showCatalogueError();
      return;
    }
    const book = getBookById(state.catalogue, bookId);
    if (!book) {
      showBookNotFound(bookId);
      return;
    }
    await openBook(book);
    return;
  }

  await showStartScreen();
}

function applyPreferences(prefs) {
  state.theme = THEME_ORDER.includes(prefs.theme) ? prefs.theme : "midnight";
  state.readingWidth = Object.prototype.hasOwnProperty.call(
    WIDTH_LIMITS,
    prefs.readingWidth,
  )
    ? prefs.readingWidth
    : "comfortable";
  state.fitMode = FIT_MODES.has(prefs.fitMode) ? prefs.fitMode : "width";
  state.brightness = clamp(Math.round(Number(prefs.brightness) || 95), 70, 110);
  state.focusMode = prefs.focusMode === true;
  state.pageAnimations = prefs.pageAnimations !== false;
  state.layout = LAYOUTS.has(prefs.layout) ? prefs.layout : "book";
  state.direction = DIRECTIONS.has(prefs.direction) ? prefs.direction : "ltr";
  state.effect = EFFECTS.has(prefs.effect) ? prefs.effect : "3d";
  state.activePanel = PANELS.has(prefs.lastPanel) ? prefs.lastPanel : "pages";
  state.zoom = 1;
  applyTheme();
  applyBrightness();
  applyLayoutUI();
  applyDirectionUI();
  applyEffectUI();
}

/* --------------------------------------------------------------------------
   Theme, width, fit, zoom, brightness
   -------------------------------------------------------------------------- */

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.style.colorScheme =
    state.theme === "parchment" ? "light" : "dark";

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", THEME_META_COLORS[state.theme]);

  applyCanvasFilter();
  updateThemeUI();
}

function applyCanvasFilter() {
  if (!dom.canvas) return;
  const base =
    state.theme === "parchment" ? 1 : state.theme === "midnight" ? 0.97 : 0.84;
  const tone =
    state.theme === "parchment"
      ? "sepia(0.16) saturate(0.92)"
      : state.theme === "midnight"
        ? "contrast(1.02)"
        : "contrast(1.07)";
  const filter = `brightness(${(state.brightness / 100) * base}) ${tone}`;
  dom.canvas.style.filter = filter;
  if (dom.leafFront) dom.leafFront.style.filter = filter;
  if (dom.leafBack) dom.leafBack.style.filter = filter;
}

function setTheme(theme, { persist = true } = {}) {
  if (!THEME_ORDER.includes(theme)) return;
  state.theme = theme;
  if (persist) setPreferences({ theme });
  applyTheme();
}

function cycleTheme() {
  const index = THEME_ORDER.indexOf(state.theme);
  setTheme(THEME_ORDER[(index + 1) % THEME_ORDER.length], { persist: true });
  showToast(`Theme: ${THEME_LABELS[state.theme]}`);
}

function updateThemeUI() {
  $$("[data-theme-option]").forEach((button) => {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.themeOption === state.theme),
    );
  });

  $$('[data-action="theme"]').forEach((button) => {
    const use = button.querySelector("use");
    if (use) {
      use.setAttribute(
        "href",
        `assets/icons.svg#icon-${THEME_ICONS[state.theme]}`,
      );
    }
    button.setAttribute(
      "aria-label",
      `Theme: ${THEME_LABELS[state.theme]}. Change theme`,
    );
    button.setAttribute("title", `Theme: ${THEME_LABELS[state.theme]} (M)`);
  });
}

function setReadingWidth(width, { persist = true } = {}) {
  if (!Object.prototype.hasOwnProperty.call(WIDTH_LIMITS, width)) return;
  state.readingWidth = width;
  if (persist) setPreferences({ readingWidth: width });
  updateWidthUI();
  scheduleRender(true);
}

function updateWidthUI() {
  $$("[data-width-option]").forEach((button) => {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.widthOption === state.readingWidth),
    );
  });
}

function setFitMode(mode, { persist = true } = {}) {
  if (!FIT_MODES.has(mode)) return;
  state.fitMode = mode;
  state.zoom = 1;
  if (persist) setPreferences({ fitMode: mode });
  updateFitUI();
  updateZoomUI();
  scheduleRender(true);
}

function updateFitUI() {
  $$("[data-fit-option]").forEach((button) => {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.fitOption === state.fitMode),
    );
  });
}

/* --------------------------------------------------------------------------
   Book layout, direction, and page effect
   -------------------------------------------------------------------------- */

function isNarrowViewport() {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia(`(max-width: ${MOBILE_BOOK_BREAKPOINT}px)`).matches
  );
}

function effectiveLayout() {
  if (state.layout === "scroll") return "scroll";
  if (state.layout !== "book") return "single";
  return isNarrowViewport() ? "single" : "book";
}

function updateBookToggle() {
  const button = $('[data-action="toggle-layout"]');
  if (!button) return;
  const book = state.layout === "book";
  button.setAttribute("aria-pressed", String(book));
  button.setAttribute(
    "aria-label",
    book ? "Switch to single-page view" : "Switch to two-page book view",
  );
  button.setAttribute(
    "title",
    book ? "Switch to single-page view (V)" : "Switch to two-page book view (V)",
  );
  const use = button.querySelector("use");
  if (use) {
    use.setAttribute(
      "href",
      `assets/icons.svg#icon-${book ? "book-open" : "book"}`,
    );
  }
}

function updateLayoutHint() {
  const hint = $("#layout-hint");
  if (!hint) return;
  if (state.layout === "single") {
    hint.textContent = "One page at a time, like a standard PDF viewer.";
    return;
  }
  if (state.layout === "scroll") {
    hint.textContent = "Pages flow continuously as you scroll.";
    return;
  }
  hint.textContent = isNarrowViewport()
    ? "Narrow screens show one page at a time; wide screens show the full open book."
    : "Cover, then facing pages side by side.";
}

function applyLayoutUI() {
  document.body.dataset.layout = state.layout;
  document.body.dataset.view = effectiveLayout();
  $$("[data-layout-option]").forEach((button) => {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.layoutOption === state.layout),
    );
  });
  updateBookToggle();
  updateLayoutHint();
}

function updateLayoutUI() {
  applyLayoutUI();
}

function setLayout(layout, { persist = true } = {}) {
  if (!LAYOUTS.has(layout)) return;
  if (state.layout === layout) {
    applyLayoutUI();
    return;
  }
  state.layout = layout;
  if (persist) setPreferences({ layout });
  state.lastRenderedPage = 0;
  state.spreadStart = 0;
  state.spreadPages = [];
  state.scrollPages = [];
  state.scrollRendered = new Set();
  hideLeaf();
  clearPageTurn();
  clearPageFade();
  clearScrollMode();
  applyLayoutUI();
  scheduleRender(true);
}

function toggleLayout() {
  setLayout(state.layout === "book" ? "single" : "book", { persist: true });
  showToast(
    state.layout === "book" ? "Two-page book view" : "Single-page view",
  );
}

function updateDirectionUI() {
  document.body.dataset.direction = state.direction;
  $$("[data-direction-option]").forEach((button) => {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.directionOption === state.direction),
    );
  });
}

function applyDirectionUI() {
  updateDirectionUI();
}

function setDirection(direction, { persist = true } = {}) {
  if (!DIRECTIONS.has(direction)) return;
  if (state.direction === direction) {
    applyDirectionUI();
    return;
  }
  state.direction = direction;
  if (persist) setPreferences({ direction });
  state.lastRenderedPage = 0;
  state.spreadStart = 0;
  state.spreadPages = [];
  hideLeaf();
  clearPageTurn();
  clearPageFade();
  applyDirectionUI();
  scheduleRender(true);
}

function toggleDirection() {
  setDirection(state.direction === "ltr" ? "rtl" : "ltr", { persist: true });
  showToast(
    state.direction === "rtl"
      ? "Reading direction: right to left"
      : "Reading direction: left to right",
  );
}

function updateEffectUI() {
  document.body.dataset.effect = state.effect;
  $$("[data-effect-option]").forEach((button) => {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.effectOption === state.effect),
    );
  });
}

function applyEffectUI() {
  updateEffectUI();
}

function setEffect(effect, { persist = true } = {}) {
  if (!EFFECTS.has(effect)) return;
  state.effect = effect;
  if (persist) setPreferences({ effect });
  applyEffectUI();
}


function setZoom(value, { render = true } = {}) {
  const next = clamp(Math.round(Number(value) * 10) / 10, 0.5, 4);
  if (!Number.isFinite(next) || Math.abs(next - state.zoom) < 0.001) return;
  state.zoom = next;
  updateZoomUI();
  if (render) scheduleRender(true);
}

function updateZoomUI() {
  if (dom.zoomLabel) {
    dom.zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
  }
}

function setBrightness(value, { persist = true, updateSlider = true } = {}) {
  state.brightness = clamp(Math.round(Number(value) || 95), 70, 110);
  if (persist) setPreferences({ brightness: state.brightness });
  if (updateSlider && dom.brightnessInput) {
    dom.brightnessInput.value = String(state.brightness);
  }
  if (dom.brightnessValue) {
    dom.brightnessValue.textContent = `${state.brightness}%`;
  }
  applyCanvasFilter();
}

function applyBrightness() {
  if (dom.brightnessInput) {
    dom.brightnessInput.value = String(state.brightness);
  }
  if (dom.brightnessValue) {
    dom.brightnessValue.textContent = `${state.brightness}%`;
  }
  applyCanvasFilter();
}

function setAnimations(enabled, { persist = true } = {}) {
  state.pageAnimations = Boolean(enabled);
  if (persist) setPreferences({ pageAnimations: state.pageAnimations });
  updateAnimationsUI();
}

function updateAnimationsUI() {
  if (dom.animationsToggle) {
    dom.animationsToggle.checked = state.pageAnimations;
  }
}

function setFocusMode(enabled, { persist = true } = {}) {
  state.focusMode = Boolean(enabled);
  if (state.focusMode) state.controlsHidden = false;
  if (dom.focusToggle) dom.focusToggle.checked = state.focusMode;
  if (persist) setPreferences({ focusMode: state.focusMode });
  syncChromeVisibility();
}

function updateFocusUI(sync = true) {
  if (dom.focusToggle) dom.focusToggle.checked = state.focusMode;
  if (sync) syncChromeVisibility();
}

/* --------------------------------------------------------------------------
   Chrome visibility
   -------------------------------------------------------------------------- */

function setBodyState(name) {
  document.body.dataset.readerState = name;
  updateReaderControlState();
  syncChromeVisibility();
}

function updateReaderControlState() {
  const ready = Boolean(
    state.pdf &&
      state.totalPages > 0 &&
      document.body.dataset.readerState === "ready",
  );
  const layout = effectiveLayout();
  const atStart = state.currentPage <= 1;
  const atEnd = state.currentPage >= state.totalPages;

  $$("[data-reader-only]").forEach((element) => {
    const action = element.dataset.action;
    if (action === "prev") {
      element.disabled = !ready || atStart;
    } else if (action === "next") {
      element.disabled = !ready || atEnd;
    } else {
      element.disabled = !ready;
    }
  });

  const hideButton = $('.reader-top [data-action="hide-controls"]');
  if (hideButton) hideButton.disabled = !ready;
}

function syncChromeVisibility() {
  const ready = Boolean(state.pdf && state.totalPages > 0);
  const hide = ready && (state.controlsHidden || state.focusMode);

  document.body.classList.toggle("controls-hidden", hide);
  document.body.classList.toggle("focus-mode", ready && state.focusMode);

  if (dom.showControls) {
    dom.showControls.hidden = !hide;
    const label = dom.showControls.querySelector("span");
    if (label) {
      label.textContent = state.focusMode ? "Leave focus mode" : "Show controls";
    }
  }

  if (hide && state.drawerOpen) closeDrawer();
}

function hideControls() {
  if (!state.pdf) return;
  state.controlsHidden = true;
  syncChromeVisibility();
}

function showControls() {
  state.controlsHidden = false;
  if (state.focusMode) {
    state.focusMode = false;
    setPreferences({ focusMode: false });
    if (dom.focusToggle) dom.focusToggle.checked = false;
  }
  syncChromeVisibility();
}

async function toggleFullscreen() {
  try {
    if (!document.fullscreenElement) {
      if (!document.documentElement.requestFullscreen) {
        throw new Error("Fullscreen is not supported.");
      }
      await document.documentElement.requestFullscreen();
    } else if (document.exitFullscreen) {
      await document.exitFullscreen();
    }
  } catch (error) {
    console.warn("AVADRA fullscreen failed.", error);
    showToast("Fullscreen is not available in this browser.");
  }
}

function updateFullscreenUI() {
  const active = Boolean(document.fullscreenElement);
  $$('[data-action="fullscreen"]').forEach((button) => {
    const use = button.querySelector("use");
    if (use) {
      use.setAttribute(
        "href",
        `assets/icons.svg#icon-${active ? "fullscreen-exit" : "fullscreen"}`,
      );
    }
    button.setAttribute(
      "aria-label",
      active ? "Exit fullscreen" : "Enter fullscreen",
    );
    button.setAttribute("title", active ? "Exit fullscreen (F)" : "Fullscreen (F)");
  });
}

function scheduleRender(force = false) {
  if (!state.pdf) return;
  clearTimeout(state.viewTimer);
  state.viewTimer = setTimeout(() => {
    state.viewTimer = null;
    if (!state.pdf) return;
    void renderPage(state.currentPage, { animate: false, force });
  }, 80);
}

/* --------------------------------------------------------------------------
   Events
   -------------------------------------------------------------------------- */

function bindEvents() {
  document.addEventListener("click", (event) => {
    handleDocumentClick(event).catch((error) => {
      console.error("AVADRA action failed.", error);
      showToast("That action could not be completed. Try again.");
    });
  });

  document.addEventListener("keydown", handleKeyboard);

  if (dom.pageInput) {
    dom.pageInput.addEventListener("change", commitPageInput);
    dom.pageInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commitPageInput();
        dom.pageInput.blur();
      }
    });
  }

  if (dom.pageSlider) {
    dom.pageSlider.addEventListener("input", () => {
      if (dom.pageInput) dom.pageInput.value = dom.pageSlider.value;
    });
    dom.pageSlider.addEventListener("change", () => {
      if (!state.pdf) return;
      const target = clamp(
        Math.round(Number(dom.pageSlider.value) || 1),
        1,
        state.totalPages,
      );
      if (target !== state.currentPage) void goToPage(target);
    });
  }

  if (dom.brightnessInput) {
    dom.brightnessInput.addEventListener("input", () => {
      setBrightness(Number(dom.brightnessInput.value), { persist: false });
    });
    dom.brightnessInput.addEventListener("change", () => {
      setBrightness(Number(dom.brightnessInput.value), { persist: true });
    });
  }

  if (dom.focusToggle) {
    dom.focusToggle.addEventListener("change", () => {
      setFocusMode(dom.focusToggle.checked, { persist: true });
    });
  }

  if (dom.animationsToggle) {
    dom.animationsToggle.addEventListener("change", () => {
      setAnimations(dom.animationsToggle.checked, { persist: true });
    });
  }

  if (dom.searchForm) {
    dom.searchForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void runSearch(dom.searchInput.value);
    });
  }

  if (dom.searchInput) {
    dom.searchInput.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        clearSearch();
      }
    });
  }

  if (dom.fileInput) {
    dom.fileInput.addEventListener("change", (event) => {
      void handleFilePicked(event);
    });
  }

  if (dom.scrim) {
    dom.scrim.addEventListener("click", () => closeDrawer());
  }

  if (dom.shortcutsDialog) {
    dom.shortcutsDialog.addEventListener("click", (event) => {
      if (event.target === dom.shortcutsDialog) closeShortcuts();
    });
  }

  if (dom.confirmDialog) {
    dom.confirmDialog.addEventListener("cancel", () => {
      state.confirmCallback = null;
    });
  }

  if (dom.tabs) {
    dom.tabs.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      const tabs = $$(".reader-tab", dom.tabs);
      const index = tabs.indexOf(document.activeElement);
      if (index === -1) return;
      event.preventDefault();
      event.stopPropagation();
      const next =
        event.key === "ArrowRight"
          ? (index + 1) % tabs.length
          : (index - 1 + tabs.length) % tabs.length;
      tabs[next].focus();
      switchPanel(tabs[next].dataset.panel);
    });
  }

  if (dom.stage) {
    dom.stage.addEventListener(
      "wheel",
      (event) => {
        if (!event.ctrlKey || !state.pdf) return;
        event.preventDefault();
        setZoom(state.zoom + (event.deltaY < 0 ? 0.1 : -0.1));
      },
      { passive: false },
    );

    dom.stage.addEventListener(
      "touchstart",
      (event) => {
        if (!state.pdf || event.touches.length !== 1) return;
        const touch = event.touches[0];
        state.swipeStart = {
          x: touch.clientX,
          y: touch.clientY,
          time: Date.now(),
        };
      },
      { passive: true },
    );

    dom.stage.addEventListener(
      "touchend",
      (event) => {
        if (!state.swipeStart || !state.pdf) return;
        const touch = event.changedTouches[0];
        const dx = touch.clientX - state.swipeStart.x;
        const dy = touch.clientY - state.swipeStart.y;
        const elapsed = Date.now() - state.swipeStart.time;
        state.swipeStart = null;
        if (elapsed > 700 || Math.abs(dx) < 60) return;
        if (Math.abs(dx) < Math.abs(dy) * 1.2) return;
        if (dom.stage.scrollWidth > dom.stage.clientWidth + 8) return;
        const forward = state.direction === "rtl" ? dx > 0 : dx < 0;
        if (forward) void goToPage(nextPageTarget());
        else void goToPage(prevPageTarget());
      },
      { passive: true },
    );
  }

  /* Interactive corner drag to turn the page (DearFlip-style peel). */
  if (dom.canvas) {
    dom.canvas.addEventListener(
      "mousedown",
      (event) => {
        void startPeel(event.clientX, event.clientY);
      },
      { passive: false },
    );
    dom.canvas.addEventListener(
      "touchstart",
      (event) => {
        if (event.touches.length !== 1) return;
        const touch = event.touches[0];
        void startPeel(touch.clientX, touch.clientY);
      },
      { passive: false },
    );
  }

  window.addEventListener("mousemove", (event) => {
    if (state.peel?.active) {
      event.preventDefault();
      updatePeel(event.clientX, event.clientY);
    }
  });
  window.addEventListener("mouseup", (event) => {
    if (state.peel?.active) {
      event.preventDefault();
      void endPeel();
    }
  });
  window.addEventListener("mouseleave", () => {
    if (state.peel?.active) void endPeel();
  });
  window.addEventListener("touchmove", (event) => {
    if (state.peel?.active) {
      event.preventDefault();
      const touch = event.touches[0];
      updatePeel(touch.clientX, touch.clientY);
    }
  },
  { passive: false });
  window.addEventListener("touchend", () => {
    if (state.peel?.active) void endPeel();
  });

  /* Drag and drop: open a local PDF dropped onto the reader. */
  const dropZone = document.body;
  dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    document.body.classList.add("reader-drag-over");
  });
  dropZone.addEventListener("dragleave", () => {
    document.body.classList.remove("reader-drag-over");
  });
  dropZone.addEventListener("drop", async (event) => {
    event.preventDefault();
    document.body.classList.remove("reader-drag-over");
    const files = event.dataTransfer.files;
    if (!files || files.length === 0) return;
    const file = files[0];
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      showToast("That file does not look like a PDF.");
      return;
    }
    await openLocalFile(file);
  });

  document.addEventListener("fullscreenchange", () => {
    updateFullscreenUI();
    scheduleRender(true);
  });
}

async function handleDocumentClick(event) {
  const actionElement = event.target.closest("[data-action]");
  if (actionElement) {
    event.preventDefault();
    await handleAction(actionElement.dataset.action, actionElement);
    return;
  }

  const themeButton = event.target.closest("[data-theme-option]");
  if (themeButton) {
    setTheme(themeButton.dataset.themeOption, { persist: true });
    return;
  }

  const widthButton = event.target.closest("[data-width-option]");
  if (widthButton) {
    setReadingWidth(widthButton.dataset.widthOption, { persist: true });
    return;
  }

  const fitButton = event.target.closest("[data-fit-option]");
  if (fitButton) {
    setFitMode(fitButton.dataset.fitOption, { persist: true });
    return;
  }

  const layoutButton = event.target.closest("[data-layout-option]");
  if (layoutButton) {
    setLayout(layoutButton.dataset.layoutOption, { persist: true });
    return;
  }

  const directionButton = event.target.closest("[data-direction-option]");
  if (directionButton) {
    setDirection(directionButton.dataset.directionOption, { persist: true });
    return;
  }

  const effectButton = event.target.closest("[data-effect-option]");
  if (effectButton) {
    setEffect(effectButton.dataset.effectOption, { persist: true });
    return;
  }

  const openBookButton = event.target.closest("[data-open-book]");
  if (openBookButton) {
    await openCatalogueBookById(openBookButton.dataset.openBook);
    return;
  }

  const openLocalButton = event.target.closest("[data-open-local]");
  if (openLocalButton) {
    await openLocalById(openLocalButton.dataset.openLocal);
    return;
  }

  const thumbButton = event.target.closest("[data-thumb-page]");
  if (thumbButton) {
    const page = Number(thumbButton.dataset.thumbPage);
    if (Number.isFinite(page)) {
      closeDrawer();
      await goToPage(page);
    }
    return;
  }

  const resultButton = event.target.closest("[data-result-page]");
  if (resultButton) {
    const page = Number(resultButton.dataset.resultPage);
    if (Number.isFinite(page)) {
      closeDrawer();
      await goToPage(page);
    }
    return;
  }

  const bookmarkButton = event.target.closest("[data-bookmark-page]");
  if (bookmarkButton) {
    const page = Number(bookmarkButton.dataset.bookmarkPage);
    if (Number.isFinite(page)) {
      closeDrawer();
      await goToPage(page);
    }
    return;
  }

  const removeBookmarkButton = event.target.closest("[data-remove-bookmark]");
  if (removeBookmarkButton) {
    const page = Number(removeBookmarkButton.dataset.removeBookmark);
    if (state.book && Number.isFinite(page)) {
      removeBookmark(state.book.id, page);
      renderBookmarks();
      updateBookmarkButtons();
      showToast(`Bookmark removed from page ${page}.`);
    }
    return;
  }

  const outlineButton = event.target.closest("[data-outline-index]");
  if (outlineButton) {
    await jumpToOutline(Number(outlineButton.dataset.outlineIndex));
    return;
  }

  const tab = event.target.closest(".reader-tab[data-panel]");
  if (tab) {
    switchPanel(tab.dataset.panel);
    return;
  }

  const confirmButton = event.target.closest("[data-confirm]");
  if (confirmButton) {
    handleConfirmClick(confirmButton);
  }
}

async function handleAction(action, element) {
  switch (action) {
    case "prev":
      await goToPage(prevPageTarget());
      break;
    case "next":
      await goToPage(nextPageTarget());
      break;
    case "zoom-in":
      setZoom(state.zoom + 0.1);
      break;
    case "zoom-out":
      setZoom(state.zoom - 0.1);
      break;
    case "fit-width":
      setFitMode("width");
      break;
    case "fit-page":
      setFitMode("page");
      break;
    case "fullscreen":
      await toggleFullscreen();
      break;
    case "hide-controls":
      hideControls();
      break;
    case "show-controls":
      showControls();
      break;
    case "search":
      if (requirePdf()) openDrawer("search");
      break;
    case "pages":
      if (requirePdf()) openDrawer("pages");
      break;
    case "bookmark":
      if (requirePdf()) await toggleBookmarkForPage();
      break;
    case "theme":
      cycleTheme();
      break;
    case "settings":
      openDrawer("settings");
      break;
    case "close-drawer":
      closeDrawer();
      break;
    case "open-file":
      chooseFile();
      break;
    case "open-flipbook":
      setLayout("book", { persist: true });
      setEffect("3d", { persist: true });
      chooseFile();
      break;
    case "toggle-layout":
      toggleLayout();
      break;
    case "toggle-direction":
      toggleDirection();
      break;
    case "retry":
      await retryCurrent();
      break;
    case "cancel-load":
      await cancelLoad();
      break;
    case "show-shortcuts":
      openShortcuts();
      break;
    case "close-shortcuts":
      closeShortcuts();
      break;
    case "open-stored":
      await openPersonalStored();
      break;
    case "remove-stored":
      confirmRemoveStored();
      break;
    case "remove-local":
      confirmRemoveLocal();
      break;
    case "clear-progress":
      confirmClearProgress();
      break;
    case "show-start":
      await showStartScreen();
      break;
    case "clear-search":
      clearSearch();
      break;
    case "reload":
      location.reload();
      break;
    default:
      break;
  }
}

function requirePdf() {
  if (state.pdf && state.totalPages > 0) return true;
  showToast("Open a volume first.");
  return false;
}

function commitPageInput() {
  if (!state.pdf || !dom.pageInput) return;
  const value = Number(dom.pageInput.value);
  if (!Number.isFinite(value)) {
    dom.pageInput.value = String(state.currentPage);
    return;
  }
  const target = clamp(Math.round(value), 1, state.totalPages);
  if (target === state.currentPage) {
    dom.pageInput.value = String(state.currentPage);
    return;
  }
  void goToPage(target);
}

function handleKeyboard(event) {
  if (event.defaultPrevented) return;

  const target = event.target;
  const isField =
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

  if (dom.shortcutsDialog?.open || dom.confirmDialog?.open) return;

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
    if (!state.pdf) return;
    event.preventDefault();
    openDrawer("search");
    return;
  }

  if (event.ctrlKey || event.metaKey || event.altKey) return;

  if (state.drawerOpen) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDrawer();
    }
    return;
  }

  if (isField) {
    if (event.key === "Escape") target.blur();
    return;
  }

  if (event.key === "Escape") {
    if (state.controlsHidden || state.focusMode) {
      event.preventDefault();
      showControls();
    } else if (state.drawerOpen) {
      event.preventDefault();
      closeDrawer();
    }
    return;
  }

  if (!state.pdf) return;

  const navigation = [
    "ArrowRight",
    "ArrowLeft",
    "PageDown",
    "PageUp",
    "Home",
    "End",
    " ",
  ].includes(event.key);

  if (event.repeat && !navigation) return;

  switch (event.key) {
    case "ArrowRight":
      event.preventDefault();
      if (state.direction === "rtl") void goToPage(prevPageTarget());
      else void goToPage(nextPageTarget());
      break;
    case "PageDown":
      event.preventDefault();
      void goToPage(nextPageTarget());
      break;
    case " ":
      event.preventDefault();
      if (event.shiftKey) void goToPage(prevPageTarget());
      else void goToPage(nextPageTarget());
      break;
    case "ArrowLeft":
      event.preventDefault();
      if (state.direction === "rtl") void goToPage(nextPageTarget());
      else void goToPage(prevPageTarget());
      break;
    case "PageUp":
      event.preventDefault();
      void goToPage(prevPageTarget());
      break;
    case "Home":
      event.preventDefault();
      void goToPage(1);
      break;
    case "End":
      event.preventDefault();
      void goToPage(state.totalPages);
      break;
    case "+":
    case "=":
      event.preventDefault();
      setZoom(state.zoom + 0.1);
      break;
    case "-":
    case "_":
      event.preventDefault();
      setZoom(state.zoom - 0.1);
      break;
    case "0":
      event.preventDefault();
      setFitMode("width");
      break;
    case "f":
    case "F":
      event.preventDefault();
      void toggleFullscreen();
      break;
    case "b":
    case "B":
      event.preventDefault();
      void toggleBookmarkForPage();
      break;
    case "s":
    case "S":
      event.preventDefault();
      openDrawer("settings");
      break;
    case "t":
    case "T":
      event.preventDefault();
      openDrawer("pages");
      break;
    case "/":
      event.preventDefault();
      openDrawer("search");
      break;
    case "?":
      event.preventDefault();
      openShortcuts();
      break;
    case "c":
    case "C":
      event.preventDefault();
      if (state.focusMode || state.controlsHidden) showControls();
      else hideControls();
      break;
    case "d":
    case "D":
      event.preventDefault();
      setFocusMode(!state.focusMode, { persist: true });
      break;
    case "m":
    case "M":
      event.preventDefault();
      cycleTheme();
      break;
    case "v":
    case "V":
      event.preventDefault();
      toggleLayout();
      break;
    case "r":
    case "R":
      event.preventDefault();
      toggleDirection();
      break;
    default:
      break;
  }
}

function setupResize() {
  const onResize = () => {
    if (!state.pdf) return;
    clearTimeout(state.resizeTimer);
    state.resizeTimer = setTimeout(() => {
      state.resizeTimer = null;
      scheduleRender(true);
    }, 180);
  };

  if ("ResizeObserver" in window && dom.stage) {
    state.resizeObserver = new ResizeObserver(onResize);
    state.resizeObserver.observe(dom.stage);
  }

  window.addEventListener("resize", onResize);
}

function setupLifecycle() {
  const save = () => saveProgressNow();
  window.addEventListener("pagehide", save);
  window.addEventListener("beforeunload", save);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") save();
  });
}

function showToast(message, duration = 2800) {
  if (!dom.toast) return;
  dom.toast.textContent = message;
  dom.toast.classList.add("is-visible");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    state.toastTimer = null;
    dom.toast.classList.remove("is-visible");
  }, duration);
}

function confirmAction({ title, message, confirmLabel = "Continue", onConfirm }) {
  if (!dom.confirmDialog) {
    if (window.confirm(`${title}\n\n${message}`) && typeof onConfirm === "function") {
      onConfirm();
    }
    return;
  }

  state.confirmCallback = onConfirm;
  dom.confirmTitle.textContent = title;
  dom.confirmMessage.textContent = message;
  dom.confirmOk.textContent = confirmLabel;
  if (!dom.confirmDialog.open) dom.confirmDialog.showModal();
}

function handleConfirmClick(button) {
  const ok = button.dataset.confirm === "ok";
  const callback = state.confirmCallback;
  state.confirmCallback = null;
  if (dom.confirmDialog?.open) dom.confirmDialog.close();
  if (ok && typeof callback === "function") {
    Promise.resolve()
      .then(callback)
      .catch((error) => {
        console.error("AVADRA confirmed action failed.", error);
        showToast("That action could not be completed. Try again.");
      });
  }
}

function openShortcuts() {
  if (!dom.shortcutsDialog) return;
  if (!dom.shortcutsDialog.open) dom.shortcutsDialog.showModal();
}

function closeShortcuts() {
  if (dom.shortcutsDialog?.open) dom.shortcutsDialog.close();
}

/* --------------------------------------------------------------------------
   Page state and rendering
   -------------------------------------------------------------------------- */

function getSpreadStart(pageNumber, total = state.totalPages) {
  const totalPages = Math.max(1, Number(total) || 0);
  const page = clamp(Math.round(Number(pageNumber) || 1), 1, totalPages);
  if (page <= 1) return 1;
  return Math.min(totalPages, 2 + Math.floor((page - 2) / 2) * 2);
}

function getSpreadPages(pageNumber, total = state.totalPages) {
  const totalPages = Math.max(1, Number(total) || 0);
  const start = getSpreadStart(pageNumber, totalPages);
  if (start <= 1) return [1];
  const pages = [start];
  if (start + 1 <= totalPages) pages.push(start + 1);
  return pages;
}

function nextPageTarget() {
  if (effectiveLayout() !== "book") {
    return Math.min(state.totalPages, state.currentPage + 1);
  }
  const pages = getSpreadPages(state.currentPage);
  return Math.min(state.totalPages, pages[pages.length - 1] + 1);
}

function prevPageTarget() {
  if (effectiveLayout() !== "book") {
    return Math.max(1, state.currentPage - 1);
  }
  const start = getSpreadStart(state.currentPage);
  if (start <= 1) return 1;
  return getSpreadStart(start - 1);
}

function updatePageUI() {
  const total = state.totalPages || 0;
  const page = total ? clamp(state.currentPage, 1, total) : 1;
  const spread = effectiveLayout() === "book" ? getSpreadPages(page, total) : [page];

  if (dom.pageInput) {
    dom.pageInput.value = String(page);
    dom.pageInput.max = String(total || 1);
    const spreadLabel =
      spread.length > 1
        ? `Pages ${spread[0]} to ${spread[spread.length - 1]} of ${total}`
        : `Page ${page} of ${total || 0}`;
    dom.pageInput.setAttribute("aria-label", spreadLabel);
    dom.pageInput.title =
      spread.length > 1
        ? `Pages ${spread[0]}–${spread[spread.length - 1]}`
        : `Page ${page}`;
  }
  if (dom.pageTotal) dom.pageTotal.textContent = String(total || 0);
  if (dom.pageSlider) {
    dom.pageSlider.max = String(total || 1);
    dom.pageSlider.value = String(page);
    const spreadText =
      spread.length > 1
        ? `Pages ${spread[0]} to ${spread[spread.length - 1]}`
        : `Page ${spread[0]}`;
    dom.pageSlider.setAttribute(
      "aria-valuetext",
      total ? `${spreadText} of ${total}` : "No book open",
    );
  }

  if (dom.progressFill) {
    const percent = total ? (page / total) * 100 : 0;
    dom.progressFill.style.width = `${percent}%`;
  }

  document.body.dataset.page = String(page);
  document.body.dataset.spread = spread.join("-");
  updateReaderControlState();
  updateBookmarkButtons();
  updateActiveThumb();
}

function updateBookmarkButtons() {
  const ready = Boolean(state.pdf && state.book);
  const marked =
    ready && state.book && hasBookmark(state.book.id, state.currentPage);
  const label = marked
    ? "Remove bookmark from this page"
    : "Bookmark this page";

  $$('[data-action="bookmark"]').forEach((button) => {
    button.setAttribute("aria-pressed", String(Boolean(marked)));
    button.classList.toggle("is-active", Boolean(marked));
    const use = button.querySelector("use");
    if (use) {
      use.setAttribute(
        "href",
        `assets/icons.svg#icon-${marked ? "bookmark-solid" : "bookmark"}`,
      );
    }
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
    if (button.classList.contains("text-link")) {
      button.textContent = label;
    }
  });
}

function updateActiveThumb() {
  if (!dom.thumbs) return;
  const spread =
    effectiveLayout() === "book"
      ? getSpreadPages(state.currentPage)
      : [state.currentPage];
  const activePages = new Set(spread);
  $$("[data-thumb-page]", dom.thumbs).forEach((button) => {
    const page = Number(button.dataset.thumbPage);
    const active = activePages.has(page);
    button.classList.toggle("is-active", active);
    if (page === state.currentPage) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
}

async function goToPage(pageNumber, { animate = true, force = false } = {}) {
  if (!state.pdf || state.peel?.active) return;
  const target = clamp(
    Math.round(Number(pageNumber) || 1),
    1,
    state.totalPages,
  );
  const layout = effectiveLayout();

  if (layout === "scroll") {
    state.currentPage = target;
    updatePageUI();
    await renderScrollMode(target, { animate: false });
    return;
  }

  const targetSpread =
    layout === "book" ? getSpreadStart(target) : target;

  if (
    !force &&
    layout === "book" &&
    targetSpread === state.spreadStart &&
    targetSpread === state.lastRenderedPage
  ) {
    state.currentPage = target;
    updatePageUI();
    return;
  }

  if (
    !force &&
    layout === "single" &&
    target === state.currentPage &&
    target === state.lastRenderedPage
  ) {
    updatePageUI();
    return;
  }

  state.currentPage = target;
  updatePageUI();
  await renderPage(target, { animate, force });
}

function beginPageFade(direction) {
  dom.pageWrap.classList.remove("is-fading--next", "is-fading--prev");
  dom.pageWrap.classList.add(
    "is-fading",
    direction === "prev" ? "is-fading--prev" : "is-fading--next",
  );
}

function clearPageFade() {
  dom.pageWrap.classList.remove(
    "is-fading",
    "is-fading--next",
    "is-fading--prev",
  );
}

function stageMetrics() {
  const style = getComputedStyle(dom.pageWrap);
  const padX =
    (parseFloat(style.paddingLeft) || 0) +
    (parseFloat(style.paddingRight) || 0);
  const padY =
    (parseFloat(style.paddingTop) || 0) +
    (parseFloat(style.paddingBottom) || 0);

  const stageWidth = Math.max(
    200,
    dom.stage.clientWidth || window.innerWidth,
  );
  const stageHeight = Math.max(
    220,
    dom.stage.clientHeight || window.innerHeight,
  );
  const widthLimit =
    state.readingWidth === "full"
      ? stageWidth
      : Math.min(stageWidth, WIDTH_LIMITS[state.readingWidth] || 900);

  return {
    availableWidth: Math.max(180, widthLimit - padX),
    availableHeight: Math.max(200, stageHeight - padY),
  };
}

function computeBookLayout() {
  const size = state.pageSize;
  if (!size) return null;
  const { availableWidth, availableHeight } = stageMetrics();
  const frameWidth = size.width * 2;
  const frameHeight = size.height;

  let scale = availableWidth / frameWidth;
  scale = Math.min(scale, availableHeight / frameHeight);
  scale = Math.max(0.05, scale * state.zoom);

  const cssWidth = frameWidth * scale;
  const cssHeight = frameHeight * scale;
  let dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pixels = cssWidth * cssHeight * dpr * dpr;
  if (pixels > MAX_RENDER_PIXELS) {
    dpr = Math.max(0.75, Math.sqrt(MAX_RENDER_PIXELS / (cssWidth * cssHeight)));
  }

  return {
    scale,
    dpr,
    cssWidth,
    cssHeight,
    pixelWidth: Math.max(1, Math.floor(cssWidth * dpr)),
    pixelHeight: Math.max(1, Math.floor(cssHeight * dpr)),
  };
}

/** Assign page numbers to the left and right halves of the open book. */
function bookSlots(pages) {
  const left = { page: null };
  const right = { page: null };
  if (pages.length >= 2) {
    if (state.direction === "rtl") {
      left.page = pages[1];
      right.page = pages[0];
    } else {
      left.page = pages[0];
      right.page = pages[1];
    }
    return { left: left.page, right: right.page };
  }

  const page = pages[0];
  const odd = page % 2 === 1;
  if (state.direction === "rtl") {
    if (odd) left.page = page;
    else right.page = page;
  } else if (odd) {
    right.page = page;
  } else {
    left.page = page;
  }
  return { left: left.page, right: right.page };
}

function drawSpineShadow(ctx, width, height, dpr) {
  const center = width / 2;
  const spread = Math.max(8, Math.min(42, width * 0.035));
  const gradient = ctx.createLinearGradient(
    center - spread,
    0,
    center + spread,
    0,
  );
  gradient.addColorStop(0, "rgba(0, 0, 0, 0)");
  gradient.addColorStop(0.4, "rgba(0, 0, 0, 0.14)");
  gradient.addColorStop(0.5, "rgba(0, 0, 0, 0.3)");
  gradient.addColorStop(0.6, "rgba(0, 0, 0, 0.14)");
  gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(center - spread, 0, spread * 2, height);

  ctx.fillStyle = "rgba(0, 0, 0, 0.2)";
  ctx.fillRect(
    center - Math.max(0.5, dpr * 0.5),
    0,
    Math.max(1, dpr),
    height,
  );
}

async function paintBookCanvas(canvas, pdf, pages, layout, { token = null } = {}) {
  const width = Math.max(1, Math.floor(layout.pixelWidth));
  const height = Math.max(1, Math.floor(layout.pixelHeight));
  canvas.width = width;
  canvas.height = height;
  if (canvas === dom.canvas) {
    canvas.style.width = `${layout.cssWidth}px`;
    canvas.style.height = `${layout.cssHeight}px`;
  }

  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) {
    throw new Error("The browser could not create a 2D canvas context.");
  }
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  const slots = bookSlots(pages);
  const halfPixel = width / 2;
  const halfCss = layout.cssWidth / 2;
  const isCover = pages.length === 1 && pages[0] === 1;

  if (isCover) {
    const coverSide = slots.right === 1 ? "right" : "left";
    const blankX = coverSide === "right" ? 0 : halfPixel;
    const gradient = ctx.createLinearGradient(blankX, 0, blankX + halfPixel, 0);
    gradient.addColorStop(0, "#0b1219");
    gradient.addColorStop(0.55, "#172530");
    gradient.addColorStop(1, "#0a1016");
    ctx.fillStyle = gradient;
    ctx.fillRect(blankX, 0, halfPixel, height);
  }

  for (const side of ["left", "right"]) {
    const pageNumber = slots[side];
    if (!pageNumber) continue;
    if (token !== null && token !== state.renderToken) return false;

    const pdfPage = await pdf.getPage(pageNumber);
    if (token !== null && token !== state.renderToken) return false;

    const base = pdfPage.getViewport({ scale: 1 });
    const pageScale = Math.min(
      halfCss / base.width,
      layout.cssHeight / base.height,
    );
    const viewport = pdfPage.getViewport({
      scale: pageScale * layout.dpr,
    });

    const temp = document.createElement("canvas");
    temp.width = Math.max(1, Math.ceil(viewport.width));
    temp.height = Math.max(1, Math.ceil(viewport.height));
    const tempContext = temp.getContext("2d", { alpha: false });
    if (!tempContext) {
      throw new Error("The browser could not create a 2D canvas context.");
    }
    tempContext.fillStyle = "#ffffff";
    tempContext.fillRect(0, 0, temp.width, temp.height);

    const task = pdfPage.render({
      canvasContext: tempContext,
      viewport,
      background: "#ffffff",
    });
    state.renderTask = task;
    await task.promise;
    state.renderTask = null;

    if (token !== null && token !== state.renderToken) return false;

    const slotX = side === "left" ? 0 : halfPixel;
    const offsetX = (halfPixel - viewport.width) / 2;
    const offsetY = (height - viewport.height) / 2;
    ctx.drawImage(temp, slotX + offsetX, offsetY);
  }

  if (token !== null && token !== state.renderToken) return false;
  drawSpineShadow(ctx, width, height, layout.dpr);
  return true;
}

function hideLeaf() {
  if (!dom.leaf) return;
  dom.leaf.hidden = true;
  dom.leaf.style.transition = "none";
  dom.leaf.style.transform = "";
}

function positionLeaf(side) {
  if (!dom.leaf) return;
  const canvasRect = dom.canvas.getBoundingClientRect();
  const wrapRect = dom.pageWrap.getBoundingClientRect();
  const left =
    canvasRect.left -
    wrapRect.left +
    (side === "right" ? canvasRect.width / 2 : 0);
  dom.leaf.style.left = `${left}px`;
  dom.leaf.style.top = `${canvasRect.top - wrapRect.top}px`;
  dom.leaf.style.width = `${canvasRect.width / 2}px`;
  dom.leaf.style.height = `${canvasRect.height}px`;
  dom.leaf.style.transformOrigin =
    side === "right" ? "left center" : "right center";
  dom.leaf.dataset.side = side;
}

function animateLeaf(angle, token) {
  return new Promise((resolve) => {
    const leaf = dom.leaf;
    if (!leaf) {
      resolve(false);
      return;
    }

    let timer = null;
    let finished = false;
    const finish = (ok) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      leaf.removeEventListener("transitionend", onEnd);
      resolve(ok && token === state.renderToken);
    };
    const onEnd = (event) => {
      if (event.target !== leaf || event.propertyName !== "transform") return;
      finish(true);
    };

    leaf.style.transition = "none";
    leaf.style.transform = "rotateY(0deg)";
    leaf.hidden = false;
    void leaf.offsetWidth;
    if (prefersReducedMotion()) {
      leaf.style.transition = "none";
      leaf.style.transform = `rotateY(${angle}deg)`;
      finish(true);
      return;
    }
    leaf.style.transition = `transform ${LEAF_TURN_MS}ms cubic-bezier(0.4, 0.04, 0.2, 1)`;
    leaf.addEventListener("transitionend", onEnd);
    timer = setTimeout(() => finish(true), LEAF_TURN_MS + 140);

    requestAnimationFrame(() => {
      if (token !== state.renderToken) {
        finish(false);
        return;
      }
      leaf.style.transform = `rotateY(${angle}deg)`;
    });
  });
}

async function turnBookLeaf(previousStart, newStart, newPages, token) {
  const pdf = state.pdf;
  if (!pdf || !dom.leaf || !dom.leafFront || !dom.leafBack) return false;

  const oldPages =
    state.spreadPages.length > 0
      ? state.spreadPages
      : getSpreadPages(previousStart);
  if (!oldPages.length) return false;

  const layout = computeBookLayout();
  if (!layout) return false;
  if (
    Math.abs(dom.canvas.width - layout.pixelWidth) > 1 ||
    Math.abs(dom.canvas.height - layout.pixelHeight) > 1
  ) {
    return false;
  }

  const isNext = newStart > previousStart;
  const turningSide =
    state.direction === "rtl"
      ? isNext
        ? "left"
        : "right"
      : isNext
        ? "right"
        : "left";
  const landingSide = turningSide === "left" ? "right" : "left";
  const oldSlots = bookSlots(oldPages);
  const newSlots = bookSlots(newPages);
  if (!oldSlots[turningSide]) return false;

  /* Snapshot the spread before the underlying canvas is changed. */
  const oldSnapshot = document.createElement("canvas");
  oldSnapshot.width = dom.canvas.width;
  oldSnapshot.height = dom.canvas.height;
  const oldContext = oldSnapshot.getContext("2d");
  if (!oldContext) return false;
  oldContext.drawImage(dom.canvas, 0, 0);

  /* Render the incoming spread offscreen while the old spread stays visible. */
  const newCanvas = document.createElement("canvas");
  const loadingTimer = setTimeout(() => {
    if (token === state.renderToken) dom.renderLoading.hidden = false;
  }, 260);
  const rendered = await paintBookCanvas(newCanvas, pdf, newPages, layout, {
    token,
  });
  clearTimeout(loadingTimer);
  dom.renderLoading.hidden = true;
  if (!rendered || token !== state.renderToken) return false;

  const halfPixel = Math.max(1, Math.floor(layout.pixelWidth / 2));
  const pixelHeight = layout.pixelHeight;
  const front = dom.leafFront;
  const back = dom.leafBack;
  front.width = halfPixel;
  front.height = pixelHeight;
  back.width = halfPixel;
  back.height = pixelHeight;

  const frontContext = front.getContext("2d", { alpha: false });
  const backContext = back.getContext("2d", { alpha: false });
  if (!frontContext || !backContext) return false;

  const sourceWidth = (canvas, side) =>
    side === "right"
      ? canvas.width - Math.floor(canvas.width / 2)
      : Math.floor(canvas.width / 2);
  const sourceX = (canvas, side) =>
    side === "right" ? Math.floor(canvas.width / 2) : 0;

  frontContext.fillStyle = "#ffffff";
  frontContext.fillRect(0, 0, front.width, front.height);
  frontContext.drawImage(
    oldSnapshot,
    sourceX(oldSnapshot, turningSide),
    0,
    sourceWidth(oldSnapshot, turningSide),
    oldSnapshot.height,
    0,
    0,
    front.width,
    front.height,
  );

  backContext.fillStyle = "#ffffff";
  backContext.fillRect(0, 0, back.width, back.height);
  backContext.drawImage(
    newCanvas,
    sourceX(newCanvas, landingSide),
    0,
    sourceWidth(newCanvas, landingSide),
    newCanvas.height,
    0,
    0,
    back.width,
    back.height,
  );

  /* Keep the old spread, but reveal the incoming page under the lifting leaf. */
  const ctx = dom.canvas.getContext("2d", { alpha: false });
  if (!ctx) return false;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, dom.canvas.width, dom.canvas.height);
  ctx.drawImage(oldSnapshot, 0, 0);

  const turnSourceX = sourceX(newCanvas, turningSide);
  const turnSourceWidth = sourceWidth(newCanvas, turningSide);
  const turnDestX =
    turningSide === "right" ? Math.floor(dom.canvas.width / 2) : 0;
  const turnDestWidth =
    turningSide === "right"
      ? dom.canvas.width - Math.floor(dom.canvas.width / 2)
      : Math.floor(dom.canvas.width / 2);
  ctx.drawImage(
    newCanvas,
    turnSourceX,
    0,
    turnSourceWidth,
    newCanvas.height,
    turnDestX,
    0,
    turnDestWidth,
    dom.canvas.height,
  );
  drawSpineShadow(ctx, dom.canvas.width, dom.canvas.height, layout.dpr);

  positionLeaf(turningSide);
  const angle =
    state.direction === "rtl"
      ? isNext
        ? 180
        : -180
      : isNext
        ? -180
        : 180;

  const done = await animateLeaf(angle, token);
  if (!done || token !== state.renderToken) {
    hideLeaf();
    return false;
  }

  ctx.drawImage(newCanvas, 0, 0, dom.canvas.width, dom.canvas.height);
  hideLeaf();
  return true;
}

/* --------------------------------------------------------------------------
   Continuous scroll mode
   -------------------------------------------------------------------------- */

function clearScrollPages() {
  if (!dom.scrollWrap) return;
  dom.scrollWrap.innerHTML = "";
  state.scrollRendered = new Set();
  state.scrollPages = [];
}

async function renderScrollPage(pageNumber, token) {
  if (!state.pdf || token !== state.renderToken) return null;
  if (state.scrollRendered.has(pageNumber)) return null;

  const pdfPage = await state.pdf.getPage(pageNumber);
  if (token !== state.renderToken) return null;

  const base = pdfPage.getViewport({ scale: 1 });
  const { availableWidth } = stageMetrics();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const scale = Math.min(availableWidth / base.width, 2);
  const viewport = pdfPage.getViewport({ scale: scale * dpr });

  const img = document.createElement("img");
  img.className = "reader-scroll__page";
  img.alt = "";
  img.style.width = `${availableWidth}px`;
  img.style.height = "auto";
  img.style.display = "block";
  img.style.marginInline = "auto";
  img.style.marginBottom = `${SCROLL_PAGE_GAP}px`;
  img.style.background = "#ffffff";

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return null;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await pdfPage.render({ canvasContext: ctx, viewport, background: "#ffffff" }).promise;

  if (token !== state.renderToken) return null;

  img.src = canvas.toDataURL("image/jpeg", 0.82);
  state.scrollRendered.add(pageNumber);
  return img;
}

function setupScrollObserver() {
  if (!dom.scrollWrap || !("IntersectionObserver" in window)) return;

  disconnectScrollObserver();
  state.scrollObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const img = entry.target;
        const page = Number(img.dataset.scrollPage);
        if (Number.isFinite(page) && !state.scrollRendered.has(page)) {
          state.scrollObserver?.unobserve(img);
          void renderScrollPage(page, state.renderToken).then((renderedImg) => {
            if (renderedImg && renderedImg !== img) {
              img.src = renderedImg.src;
              img.style.width = renderedImg.style.width;
              img.style.height = renderedImg.style.height;
            }
          });
        }
      }
    },
    { root: dom.stage || null, rootMargin: "300px 0px" },
  );
}

function disconnectScrollObserver() {
  if (!state.scrollObserver) return;
  try {
    state.scrollObserver.disconnect();
  } catch {
    /* Already disconnected. */
  }
  state.scrollObserver = null;
}

async function renderScrollMode(pageNumber, { initial = false } = {}) {
  if (!state.pdf) return;
  const target = clamp(Math.round(Number(pageNumber) || 1), 1, state.totalPages);

  hideLeaf();
  clearPageTurn();
  clearPageFade();

  if (!dom.scrollWrap) return;

  dom.canvas.hidden = true;
  if (dom.leaf) dom.leaf.hidden = true;
  if (dom.peel) dom.peel.hidden = true;
  dom.pageWrap.style.display = "none";
  dom.scrollWrap.hidden = false;
  dom.pageWrap.classList.remove("reader-page-wrap--book");

  const token = ++state.renderToken;
  state.currentPage = target;
  state.lastRenderedPage = target;
  updatePageUI();

  /* Build page placeholders if not already built. */
  if (dom.scrollWrap.children.length === 0) {
    const fragment = document.createDocumentFragment();
    for (let page = 1; page <= state.totalPages; page += 1) {
      const wrapper = document.createElement("div");
      wrapper.className = "reader-scroll__page-wrap";
      wrapper.style.height = "auto";
      wrapper.style.display = "flex";
      wrapper.style.flexDirection = "column";
      wrapper.style.alignItems = "center";

      const placeholder = document.createElement("div");
      placeholder.className = "reader-scroll__placeholder";
      placeholder.style.width = "100%";
      placeholder.style.paddingBottom = "140%";
      placeholder.style.background = "var(--r-bg-soft)";
      placeholder.style.borderRadius = "1px";

      const img = document.createElement("img");
      img.className = "reader-scroll__page";
      img.dataset.scrollPage = String(page);
      img.alt = "";
      img.style.width = "100%";
      img.style.height = "auto";
      img.style.display = "block";
      img.style.marginInline = "auto";
      img.style.marginBottom = `${SCROLL_PAGE_GAP}px`;
      img.style.opacity = "0";
      img.style.transition = "opacity 220ms var(--ease)";

      wrapper.append(placeholder, img);
      fragment.append(wrapper);
    }
    dom.scrollWrap.innerHTML = "";
    dom.scrollWrap.append(fragment);
    setupScrollObserver();
  }

  const imgs = dom.scrollWrap.querySelectorAll(".reader-scroll__page");
  const targets = new Set([target]);
  for (let offset = 1; offset <= 3; offset += 1) {
    if (target + offset <= state.totalPages) targets.add(target + offset);
    if (target - offset >= 1) targets.add(target - offset);
  }

  for (const img of imgs) {
    const page = Number(img.dataset.scrollPage);
    if (!targets.has(page)) continue;
    if (state.scrollRendered.has(page)) continue;
    void renderScrollPage(page, token).then((renderedImg) => {
      if (renderedImg && token === state.renderToken && img.src !== renderedImg.src) {
        img.src = renderedImg.src;
        img.style.opacity = "1";
      }
    });
  }

  /* Scroll to the current page. */
  const currentImg = dom.scrollWrap.querySelector(
    `.reader-scroll__page[data-scroll-page="${target}"]`,
  );
  if (currentImg) {
    currentImg.scrollIntoView({ block: "center", behavior: initial ? "auto" : "smooth" });
  }

  attachScrollProgressListener();

  if (!initial) setBodyState("ready");
  saveProgressDebounced();
  prefetchNeighbors(target);
}

function updateScrollProgress() {
  if (!dom.scrollWrap || !state.pdf) return;
  const imgs = dom.scrollWrap.querySelectorAll(".reader-scroll__page");
  if (!imgs.length) return;

  const rect = dom.stage.getBoundingClientRect();
  const stageCenterY = rect.top + rect.height / 2;

  let nearestPage = 1;
  let nearestDistance = Infinity;

  for (const img of imgs) {
    const pageRect = img.getBoundingClientRect();
    const pageCenterY = pageRect.top + pageRect.height / 2;
    const distance = Math.abs(pageCenterY - stageCenterY);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestPage = Number(img.dataset.scrollPage) || 1;
    }
  }

  if (nearestPage !== state.currentPage) {
    state.currentPage = nearestPage;
    updatePageUI();
  }
}

function attachScrollProgressListener() {
  if (!dom.stage) return;
  dom.stage.removeEventListener("scroll", handleScrollProgress);
  dom.stage.addEventListener("scroll", handleScrollProgress, { passive: true });
}

let scrollProgressFrame = null;
function handleScrollProgress() {
  if (scrollProgressFrame) return;
  scrollProgressFrame = requestAnimationFrame(() => {
    scrollProgressFrame = null;
    updateScrollProgress();
  });
}

function detachScrollProgressListener() {
  if (!dom.stage) return;
  dom.stage.removeEventListener("scroll", handleScrollProgress);
  if (scrollProgressFrame) {
    cancelAnimationFrame(scrollProgressFrame);
    scrollProgressFrame = null;
  }
}

function clearScrollMode() {
  detachScrollProgressListener();
  disconnectScrollObserver();
  clearScrollPages();
  if (dom.scrollWrap) dom.scrollWrap.hidden = true;
  if (dom.canvas) dom.canvas.hidden = false;
  if (dom.pageWrap) {
    dom.pageWrap.style.display = "";
    dom.pageWrap.classList.add("reader-page-wrap--book");
  }
}

  if (token !== state.renderToken) return false;
  clearTimeout(loadingTimer);
  dom.renderLoading.hidden = true;
  clearPageTurn();
  clearPageFade();
  hideLeaf();
  if (dom.pageWrap) dom.pageWrap.classList.remove("is-turning-leaf");

  state.lastRenderedPage = start;
  state.spreadStart = start;
  state.spreadPages = pages;
  dom.canvas.setAttribute(
    "aria-label",
    pages.length > 1
      ? `Pages ${pages[0]} and ${pages[pages.length - 1]} of ${state.totalPages}`
      : `Page ${pages[0]} of ${state.totalPages}`,
  );

  if (!initial) setBodyState("ready");
  saveProgressDebounced();
  prefetchNeighbors(target);
  return true;
}

/* --------------------------------------------------------------------------
   Page peel: interactive corner drag to turn the page (DearFlip-style)
   -------------------------------------------------------------------------- */

function peelTargetPage(direction) {
  const pages = state.spreadPages;
  if (!pages || !pages.length) return null;
  const isLtr = state.direction === "ltr";
  const rightPage =
    pages.length >= 2 ? pages[1] : pages[0];
  const leftPage = isLtr ? pages[0] : pages.length >= 2 ? pages[1] : pages[0];

  if (direction === "next") {
    return isLtr
      ? { page: rightPage, side: "right", corner: "bottom-right", target: nextPageTarget() }
      : { page: leftPage, side: "left", corner: "bottom-left", target: nextPageTarget() };
  }
  return isLtr
    ? { page: leftPage, side: "left", corner: "bottom-left", target: prevPageTarget() }
    : { page: rightPage, side: "right", corner: "bottom-right", target: prevPageTarget() };
}

function pageCssRect(side) {
  const rect = dom.canvas.getBoundingClientRect();
  const wrap = dom.pageWrap.getBoundingClientRect();
  const x = rect.left - wrap.left;
  const y = rect.top - wrap.top;
  const w = rect.width / 2;
  const h = rect.height;
  if (side === "right") return { x: x + w, y, w, h };
  return { x, y, w, h };
}

async function snapshotPage(pageNumber, canvas, cssW, cssH) {
  if (!state.pdf) return false;
  const pdfPage = await state.pdf.getPage(pageNumber);
  const base = pdfPage.getViewport({ scale: 1 });
  const scale = Math.min(cssW / base.width, cssH / base.height);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const viewport = pdfPage.getViewport({ scale: scale * dpr });
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return false;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await pdfPage.render({ canvasContext: ctx, viewport, background: "#ffffff" }).promise;
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  return true;
}

function showPeel(side, corner) {
  if (!dom.peel) return;
  const r = pageCssRect(side);
  dom.peel.style.left = `${r.x}px`;
  dom.peel.style.top = `${r.y}px`;
  dom.peel.style.width = `${r.w}px`;
  dom.peel.style.height = `${r.h}px`;
  dom.peel.style.transformOrigin =
    corner === "bottom-right" ? "right bottom" : "left bottom";
  dom.peel.hidden = false;
  dom.peel.style.transition = "none";
  dom.peel.style.transform = "";
}

function hidePeel() {
  if (!dom.peel) return;
  dom.peel.hidden = true;
  dom.peel.style.transition = "none";
  dom.peel.style.transform = "";
}

function updatePeel(clientX, clientY) {
  const p = state.peel;
  if (!p || !p.active || !dom.peel || dom.peel.hidden) return;
  const wrap = dom.pageWrap.getBoundingClientRect();
  const x = clientX - wrap.left;
  const y = clientY - wrap.top;
  const dx = x - p.cornerX;
  const dy = y - p.cornerY;
  const pull = p.corner === "bottom-right" ? -dx : dx;
  const angleY = Math.min(150, Math.max(0, pull / Math.max(1, p.pageW) * 150));
  const signed = p.corner === "bottom-right" ? angleY : -angleY;
  dom.peel.style.transform = `translate(${dx}px, ${dy}px) rotateY(${signed}deg)`;
}

async function startPeel(clientX, clientY) {
  if (
    state.peel?.active ||
    !state.pdf ||
    effectiveLayout() !== "book" ||
    state.effect !== "3d"
  ) {
    return;
  }
  const rect = dom.canvas.getBoundingClientRect();
  const cx = clientX - rect.left;
  const cy = clientY - rect.top;
  const isRight = cx > rect.width / 2;
  const nearBottom = cy > rect.height * 0.66;
  const nearRight = cx > rect.width * 0.66;
  const nearLeft = cx < rect.width * 0.34;

  let direction, side, corner;
  if (state.direction === "ltr") {
    if (isRight && nearBottom && nearRight) {
      direction = "next";
      side = "right";
      corner = "bottom-right";
    } else if (!isRight && nearBottom && nearLeft) {
      direction = "prev";
      side = "left";
      corner = "bottom-left";
    } else {
      return;
    }
  } else {
    if (!isRight && nearBottom && nearLeft) {
      direction = "next";
      side = "left";
      corner = "bottom-left";
    } else if (isRight && nearBottom && nearRight) {
      direction = "prev";
      side = "right";
      corner = "bottom-right";
    } else {
      return;
    }
  }

  const target = peelTargetPage(direction);
  if (!target || target.page === null) return;
  const newSpread = getSpreadPages(target.target);
  if (!newSpread.length) return;
  const layout = computeBookLayout();
  if (!layout) return;

  const r = pageCssRect(side);
  try {
    await paintBookCanvas(dom.canvas, state.pdf, newSpread, layout, {
      token: state.renderToken,
    });
    await snapshotPage(target.page, dom.peelFront, r.w, r.h);
  } catch (error) {
    state.peel = null;
    hidePeel();
    return;
  }
  state.peel = {
    active: true,
    side,
    corner,
    page: target.page,
    target: target.target,
    cornerX: cx,
    cornerY: cy,
    pageW: rect.width / 2,
    pageH: rect.height,
    peelRect: r,
    layout,
  };
  if (state.peel && state.peel.active) {
    dom.peelBack.style.background = "#ffffff";
    showPeel(side, corner);
  }
}

async function endPeel() {
  const p = state.peel;
  if (!p || !p.active) return;
  state.peel = null;
  if (!dom.peel) return;
  const match = dom.peel.style.transform.match(/rotateY\(([-.\d]+)deg\)/);
  const angle = Math.abs(Number(match ? match[1] : 0)) || 0;

  if (angle > 80) {
    state.currentPage = p.target;
    finishBookRender({
      start: p.target,
      pages: getSpreadPages(p.target),
      target: p.target,
      token: state.renderToken,
      initial: false,
      loadingTimer: null,
    });
  } else {
    state.currentPage = p.page;
    const oldSpread = getSpreadPages(p.page);
    const layout = computeBookLayout();
    if (layout) {
      await paintBookCanvas(
        dom.canvas,
        state.pdf,
        oldSpread,
        layout,
        { token: state.renderToken },
      );
    }
    finishBookRender({
      start: p.page,
      pages: oldSpread,
      target: p.page,
      token: state.renderToken,
      initial: false,
      loadingTimer: null,
    });
  }
  updatePageUI();
  hidePeel();
}

function cancelPeel() {
  if (!state.peel?.active) return;
  state.peel = null;
  hidePeel();
}

async function renderBookSpread(
  pageNumber,
  { animate = false, force = false, initial = false } = {},
) {
  if (!state.pdf) return;

  const target = clamp(
    Math.round(Number(pageNumber) || 1),
    1,
    state.totalPages,
  );
  const pages = getSpreadPages(target);
  const start = pages[0];

  if (!force && start === state.lastRenderedPage && start === state.spreadStart) {
    state.currentPage = target;
    updatePageUI();
    return;
  }

  const token = ++state.renderToken;
  if (state.renderTask) {
    try {
      state.renderTask.cancel();
    } catch (error) {
      /* A render task already settled; nothing to cancel. */
    }
    state.renderTask.promise.catch(() => {
      /* Cancelled renders reject; nothing to report. */
    });
    state.renderTask = null;
  }

  hideLeaf();
  clearPageTurn();
  clearPageFade();

  state.currentPage = target;
  updatePageUI();

  const animatePage =
    animate && state.pageAnimations && !prefersReducedMotion();
  const previousStart = Number(state.lastRenderedPage) || 0;

  if (
    animatePage &&
    previousStart &&
    previousStart !== start &&
    state.effect === "3d"
  ) {
    const direction = start > previousStart ? "next" : "prev";
    beginPageTurn(direction);
    dom.pageWrap.classList.add("is-turning-leaf");
    const turned = await turnBookLeaf(previousStart, start, pages, token);
    if (token !== state.renderToken) {
      hideLeaf();
      return;
    }
    if (turned) {
      finishBookRender({
        start,
        pages,
        target,
        token,
        initial,
        loadingTimer: null,
      });
      return;
    }
    /* The leaf turn could not complete; fall back to a clean render. */
    hideLeaf();
    clearPageFade();
  }

  if (
    animatePage &&
    previousStart &&
    previousStart !== start &&
    state.effect === "2d"
  ) {
    beginPageFade(start > previousStart ? "next" : "prev");
    await delay(170);
    if (token !== state.renderToken) {
      clearPageFade();
      return;
    }
  }

  const loadingTimer = setTimeout(() => {
    if (token === state.renderToken) dom.renderLoading.hidden = false;
  }, 260);

  try {
    const layout = computeBookLayout();
    if (!layout) throw new Error("The book layout could not be measured.");
    const rendered = await paintBookCanvas(
      dom.canvas,
      state.pdf,
      pages,
      layout,
      { token },
    );
    if (!rendered || token !== state.renderToken) return;
    finishBookRender({ start, pages, target, token, initial, loadingTimer });
  } catch (error) {
    clearTimeout(loadingTimer);
    dom.renderLoading.hidden = true;
    clearPageFade();
    hideLeaf();

    if (
      error?.name === "RenderingCancelledException" ||
      token !== state.renderToken
    ) {
      return;
    }

    console.error(`AVADRA could not render pages ${pages.join("–")}.`, error);
    if (initial) showErrorForDocument(error, state.book);
    else showToast("That spread could not be rendered. Try another page.");
  }
}

function computeViewport(page) {
  const style = getComputedStyle(dom.pageWrap);
  const padX =
    (parseFloat(style.paddingLeft) || 0) +
    (parseFloat(style.paddingRight) || 0);
  const padY =
    (parseFloat(style.paddingTop) || 0) +
    (parseFloat(style.paddingBottom) || 0);

  const stageWidth = Math.max(
    200,
    dom.stage.clientWidth || window.innerWidth,
  );
  const stageHeight = Math.max(
    220,
    dom.stage.clientHeight || window.innerHeight,
  );
  const widthLimit =
    state.readingWidth === "full"
      ? stageWidth
      : Math.min(stageWidth, WIDTH_LIMITS[state.readingWidth] || 900);

  const availableWidth = Math.max(180, widthLimit - padX);
  const availableHeight = Math.max(200, stageHeight - padY);
  const base = page.getViewport({ scale: 1 });

  let scale = availableWidth / base.width;
  if (state.fitMode === "page") {
    scale = Math.min(scale, availableHeight / base.height);
  }
  scale = Math.max(0.05, scale * state.zoom);

  let dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssWidth = base.width * scale;
  const cssHeight = base.height * scale;
  const pixels = cssWidth * cssHeight * dpr * dpr;
  if (pixels > MAX_RENDER_PIXELS) {
    dpr = Math.max(
      0.75,
      Math.sqrt(MAX_RENDER_PIXELS / (cssWidth * cssHeight)),
    );
  }

  const viewport = page.getViewport({ scale: scale * dpr });
  return {
    viewport,
    cssWidth: viewport.width / dpr,
    cssHeight: viewport.height / dpr,
  };
}

function clearPageTurn() {
  dom.pageWrap.classList.remove(
    "is-turning",
    "is-turning--next",
    "is-turning--prev",
    "is-turning-leaf",
  );
}

function beginPageTurn(direction) {
  dom.pageWrap.classList.remove("is-turning--next", "is-turning--prev");
  dom.pageWrap.classList.add(
    "is-turning",
    direction === "prev" ? "is-turning--prev" : "is-turning--next",
  );
}

async function renderPage(pageNumber, options = {}) {
  if (!state.pdf || state.peel?.active) return;
  const layout = effectiveLayout();
  if (layout === "scroll") {
    return renderScrollMode(pageNumber, options);
  }
  if (layout === "book" && state.pageSize) {
    return renderBookSpread(pageNumber, options);
  }
  return renderSinglePage(pageNumber, options);
}

async function renderSinglePage(
  pageNumber,
  { animate = false, force = false, initial = false } = {},
) {
  if (!state.pdf) return;

  const target = clamp(
    Math.round(Number(pageNumber) || 1),
    1,
    state.totalPages,
  );

  if (
    !force &&
    target === state.lastRenderedPage &&
    target === state.currentPage
  ) {
    updatePageUI();
    return;
  }

  const token = ++state.renderToken;
  if (state.renderTask) {
    try {
      state.renderTask.cancel();
    } catch (error) {
      /* A render task already settled; nothing to cancel. */
    }
    state.renderTask.promise.catch(() => {
      /* Cancelled renders reject; nothing to report. */
    });
    state.renderTask = null;
  }

  hideLeaf();
  state.currentPage = target;
  updatePageUI();

  const animatePage =
    animate && state.pageAnimations && !prefersReducedMotion();
  const previousPage = Number(state.lastRenderedPage) || target;
  const turningBack = target < previousPage;
  if (animatePage && state.effect === "3d") {
    beginPageTurn(turningBack ? "prev" : "next");
    await delay(300);
    if (token !== state.renderToken) return;
  } else if (animatePage) {
    beginPageFade(turningBack ? "prev" : "next");
    await delay(170);
    if (token !== state.renderToken) {
      clearPageFade();
      return;
    }
  }

  const loadingTimer = setTimeout(() => {
    if (token === state.renderToken) dom.renderLoading.hidden = false;
  }, 260);

  try {
    const page = await state.pdf.getPage(target);
    if (token !== state.renderToken) return;

    const { viewport, cssWidth, cssHeight } = computeViewport(page);
    dom.canvas.width = Math.max(1, Math.floor(viewport.width));
    dom.canvas.height = Math.max(1, Math.floor(viewport.height));
    dom.canvas.style.width = `${cssWidth}px`;
    dom.canvas.style.height = `${cssHeight}px`;

    const context = dom.canvas.getContext("2d", { alpha: false });
    if (!context) {
      throw new Error("The browser could not create a 2D canvas context.");
    }
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, dom.canvas.width, dom.canvas.height);

    const task = page.render({
      canvasContext: context,
      viewport,
      background: "#ffffff",
    });
    state.renderTask = task;
    await task.promise;

    if (token !== state.renderToken) return;
    state.renderTask = null;
    state.lastRenderedPage = target;
    state.spreadStart = target;
    state.spreadPages = [target];

    clearTimeout(loadingTimer);
    dom.renderLoading.hidden = true;
    clearPageTurn();
    clearPageFade();
    dom.canvas.setAttribute(
      "aria-label",
      `Page ${target} of ${state.totalPages}`,
    );

    if (!initial) setBodyState("ready");
    saveProgressDebounced();
    prefetchNeighbors(target);
  } catch (error) {
    clearTimeout(loadingTimer);
    dom.renderLoading.hidden = true;
    clearPageTurn();
    clearPageFade();

    if (
      error?.name === "RenderingCancelledException" ||
      token !== state.renderToken
    ) {
      return;
    }

    console.error(`AVADRA could not render page ${target}.`, error);
    if (initial) showErrorForDocument(error, state.book);
    else showToast(`Page ${target} could not be rendered. Try another page.`);
  }
}

function prefetchNeighbors(page) {
  if (!state.pdf) return;
  const token = state.documentToken;
  const pdf = state.pdf;
  setTimeout(() => {
    if (!state.pdf || state.documentToken !== token || state.pdf !== pdf) return;
    const targets =
      effectiveLayout() === "book"
        ? [page - 3, page - 2, page - 1, page + 1, page + 2, page + 3]
        : [page + 1, page - 1];
    for (const target of new Set(targets)) {
      if (target >= 1 && target <= state.totalPages) {
        pdf.getPage(target).catch(() => {});
      }
    }
  }, 300);
}

/* --------------------------------------------------------------------------
   Progress
   -------------------------------------------------------------------------- */

function saveProgressDebounced() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => {
    state.saveTimer = null;
    saveProgressNow();
  }, 350);
}

function saveProgressNow() {
  if (state.suppressSaveOnce) {
    state.suppressSaveOnce = false;
    return;
  }
  if (
    !state.book ||
    !state.pdf ||
    !state.totalPages ||
    state.currentPage < 1 ||
    !state.canPersist
  ) {
    return;
  }

  setLastRead(state.book.id, state.currentPage, state.totalPages, {
    title: state.book.title,
    author: state.book.author,
    access: state.book.access,
    category:
      state.book.category ||
      (state.book.access === "local" ? "Local document" : "Open Shelf"),
  });
}

/* --------------------------------------------------------------------------
   Text extraction
   -------------------------------------------------------------------------- */

async function getPageText(pageNumber) {
  const key = `${state.documentToken}:${pageNumber}`;
  if (state.textCache.has(key)) return state.textCache.get(key);

  const pdf = state.pdf;
  if (!pdf) return "";

  try {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = (content.items || [])
      .map((item) => (typeof item.str === "string" ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    if (state.pdf === pdf) {
      state.textCache.set(key, text);
      if (state.textCache.size > MAX_PAGE_TEXT_CACHE) {
        const first = state.textCache.keys().next().value;
        state.textCache.delete(first);
      }
    }

    return text;
  } catch (error) {
    if (error?.name === "RenderingCancelledException") return "";
    throw error;
  }
}

async function getPageSnippet(page) {
  try {
    const text = await getPageText(page);
    const cleaned = text.replace(/\s+/g, " ").trim();
    if (!cleaned) return `Page ${page}`;
    const snippet = cleaned.slice(0, 110).trim();
    return snippet.length < cleaned.length ? `${snippet}…` : snippet;
  } catch (error) {
    return `Page ${page}`;
  }
}

function buildSearchSnippet(text, terms) {
  const lower = text.toLowerCase();
  let index = -1;
  for (const term of terms) {
    const found = lower.indexOf(term.toLowerCase());
    if (found !== -1 && (index === -1 || found < index)) index = found;
  }
  if (index === -1) index = 0;

  const start = Math.max(0, index - 70);
  const end = Math.min(text.length, index + 160);
  let snippet = text.slice(start, end).trim();
  if (start > 0) snippet = `… ${snippet}`;
  if (end < text.length) snippet = `${snippet} …`;
  return snippet;
}

function highlightSnippet(snippet, terms) {
  const safe = escapeHtml(snippet);
  const patterns = terms
    .filter(Boolean)
    .map((term) => escapeRegExp(term))
    .sort((a, b) => b.length - a.length);
  if (!patterns.length) return safe;
  try {
    return safe.replace(
      new RegExp(`(${patterns.join("|")})`, "gi"),
      "<mark>$1</mark>",
    );
  } catch (error) {
    return safe;
  }
}

/* --------------------------------------------------------------------------
   PDF.js and document lifecycle
   -------------------------------------------------------------------------- */

function configurePdfJs() {
  if (window.pdfjsLib?.GlobalWorkerOptions) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  }
}

function loadPdfJs() {
  if (window.pdfjsLib) {
    configurePdfJs();
    return Promise.resolve(window.pdfjsLib);
  }
  if (state.pdfjsPromise) return state.pdfjsPromise;

  state.pdfjsPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = PDFJS_SCRIPT;
    script.async = true;
    script.dataset.avadraPdfjs = "true";
    script.onload = () => {
      if (!window.pdfjsLib) {
        reject(new Error("PDF.js loaded but did not expose its API."));
        return;
      }
      configurePdfJs();
      resolve(window.pdfjsLib);
    };
    script.onerror = () => {
      reject(
        new Error(
          `The PDF engine could not be loaded from ${PDFJS_SCRIPT}. Check that the vendored file is deployed.`,
        ),
      );
    };
    document.head.append(script);
  }).catch((error) => {
    state.pdfjsPromise = null;
    document.querySelector('script[data-avadra-pdfjs="true"]')?.remove();
    throw error;
  });

  return state.pdfjsPromise;
}

function showLoading(title, status) {
  if (!dom.loading) return;
  dom.loading.hidden = false;
  dom.loadingTitle.textContent = title;
  dom.loadingStatus.textContent = status;
  dom.loadingBar.classList.add("is-indeterminate");
  dom.loadingFill.style.width = "0%";
}

function hideLoading() {
  if (dom.loading) dom.loading.hidden = true;
}

function setLoadingStatus(status) {
  if (dom.loadingStatus) dom.loadingStatus.textContent = status;
}

function updateLoadingProgress(loaded, total) {
  if (!dom.loading || dom.loading.hidden) return;
  if (Number.isFinite(total) && total > 0) {
    const percent = clamp(Math.round((loaded / total) * 100), 0, 100);
    dom.loadingBar.classList.remove("is-indeterminate");
    dom.loadingFill.style.width = `${percent}%`;
    dom.loadingStatus.textContent =
      loaded > 0 ? `Downloading the file… ${percent}%` : "Requesting the file…";
  } else {
    dom.loadingBar.classList.add("is-indeterminate");
    dom.loadingFill.style.width = "0%";
    dom.loadingStatus.textContent = "Downloading the file…";
  }
}

function hideStatePanel() {
  if (dom.statePanel) dom.statePanel.hidden = true;
}

async function destroyPdf() {
  state.loadToken += 1;
  state.renderToken += 1;
  state.documentToken = -1;

  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  clearTimeout(state.viewTimer);
  state.viewTimer = null;

  if (state.renderTask) {
    try {
      state.renderTask.cancel();
    } catch (error) {
      /* Already settled. */
    }
    state.renderTask.promise.catch(() => {
      /* Cancelled renders reject; nothing to report. */
    });
    state.renderTask = null;
  }

  if (state.loadingTask) {
    try {
      await state.loadingTask.destroy();
    } catch (error) {
      /* The task already failed; nothing to release. */
    }
    state.loadingTask = null;
  }

  if (state.pdf) {
    try {
      await state.pdf.destroy();
    } catch (error) {
      /* A failed document may already be destroyed. */
    }
    state.pdf = null;
  }

  if (state.blobUrl) {
    try {
      URL.revokeObjectURL(state.blobUrl);
    } catch (error) {
      /* Already revoked. */
    }
    state.blobUrl = null;
  }

  state.totalPages = 0;
  state.currentPage = 1;
  state.lastRenderedPage = 0;
  state.pageSize = null;
  state.spreadStart = 0;
  state.spreadPages = [];
  state.thumbsBuilt = false;
  state.thumbsToken = -1;
  state.thumbJobs = [];
  state.thumbActive = 0;
  state.thumbCache.clear();
  state.textCache.clear();
  state.outlineEntries = [];
  state.searchToken += 1;

  disconnectThumbObserver();
  resetThumbs();
  resetOutline();
  clearScrollMode();

  if (dom.renderLoading) dom.renderLoading.hidden = true;
  if (dom.pageWrap) clearPageTurn();
  clearPageFade();
  hideLeaf();
  cancelPeel();
  state.peel = null;
  if (dom.canvas) {
    dom.canvas.width = 1;
    dom.canvas.height = 1;
    dom.canvas.style.width = "";
    dom.canvas.style.height = "";
    dom.canvas.setAttribute("aria-label", "No page loaded");
  }

  document.body.dataset.pdfReady = "false";
  updatePageUI();
  updateBookmarkButtons();
  syncChromeVisibility();
}

async function loadDocument({
  url = "",
  blob = null,
  book = state.book,
  existingLocal = false,
  pendingSave = null,
} = {}) {
  if (!book) return;

  await destroyPdf();
  const token = state.loadToken;

  state.book = book;
  state.localMode = book.access === "local";
  state.pendingSave = pendingSave;
  state.lastSource = blob ? { blob } : { url };
  state.canPersist = book.access !== "local" || existingLocal;

  if (!url && !blob) {
    showErrorForDocument(
      new Error("No file source was provided for this book."),
      book,
    );
    return;
  }

  updateTitle(book);
  closeDrawer();
  clearSearch();
  hideStatePanel();
  if (dom.renderLoading) dom.renderLoading.hidden = true;
  setBodyState("loading");
  showLoading("Opening the volume…", "Connecting to the file…");

  let createdUrl = null;

  try {
    const pdfjs = await loadPdfJs();
    if (token !== state.loadToken) return;

    let source = url;
    if (blob) {
      createdUrl = URL.createObjectURL(blob);
      state.blobUrl = createdUrl;
      source = createdUrl;
    }

    updateLoadingProgress(0, 0);

    const task = pdfjs.getDocument({ url: source, withCredentials: false });
    state.loadingTask = task;
    task.onProgress = ({ loaded, total }) => {
      if (token !== state.loadToken) return;
      updateLoadingProgress(loaded, total);
    };

    const pdf = await task.promise;
    if (token !== state.loadToken) {
      pdf.destroy().catch(() => {});
      if (createdUrl && state.blobUrl === createdUrl) {
        try {
          URL.revokeObjectURL(createdUrl);
        } catch (error) {
          /* Already revoked. */
        }
        state.blobUrl = null;
      }
      return;
    }

    state.loadingTask = null;
    setLoadingStatus("Preparing the pages…");
    dom.loadingBar.classList.add("is-indeterminate");
    await onDocumentReady(pdf, book, token);
  } catch (error) {
    if (token !== state.loadToken || error?.name === "AbortException") return;

    console.error("AVADRA could not load the PDF.", error);
    if (state.loadingTask) {
      try {
        await state.loadingTask.destroy();
      } catch (destroyError) {
        /* Already closed. */
      }
      state.loadingTask = null;
    }
    if (createdUrl && state.blobUrl === createdUrl) {
      try {
        URL.revokeObjectURL(createdUrl);
      } catch (revokeError) {
        /* Already revoked. */
      }
      state.blobUrl = null;
    }

    hideLoading();
    showErrorForDocument(error, book);
  }
}

async function onDocumentReady(pdf, book, token) {
  if (token !== state.loadToken) {
    pdf.destroy().catch(() => {});
    return;
  }

  state.pdf = pdf;
  state.documentToken = token;
  state.totalPages = pdf.numPages;
  state.currentPage = 1;
  state.lastRenderedPage = 0;
  state.pageSize = null;
  state.spreadStart = 0;
  state.spreadPages = [];
  state.scrollPages = [];
  state.scrollRendered = new Set();
  state.thumbsBuilt = false;
  state.thumbsToken = -1;
  state.thumbCache.clear();
  state.textCache.clear();
  state.outlineEntries = [];
  state.searchToken += 1;

  /* Measure a few pages so the open-book frame stays stable across spreads. */
  try {
    let maxWidth = 0;
    let maxHeight = 0;
    const sampleCount = Math.min(pdf.numPages, 3);
    for (let index = 1; index <= sampleCount; index += 1) {
      const samplePage = await pdf.getPage(index);
      const base = samplePage.getViewport({ scale: 1 });
      maxWidth = Math.max(maxWidth, base.width);
      maxHeight = Math.max(maxHeight, base.height);
    }
    if (maxWidth > 0 && maxHeight > 0) {
      state.pageSize = { width: maxWidth, height: maxHeight };
    }
  } catch (error) {
    console.warn("AVADRA could not measure the page size.", error);
  }
  if (token !== state.loadToken) return;

  const saved = getProgress(book.id);
  const startPage = saved
    ? clamp(saved.page, 1, state.totalPages)
    : 1;

  state.currentPage = startPage;
  updateTitle(book);
  if (dom.statePanel) dom.statePanel.hidden = true;
  updatePageUI();
  updateBookmarkButtons();
  updateSettingsUI();

  await renderPage(startPage, {
    animate: false,
    force: true,
    initial: true,
  });

  const startSpread =
    effectiveLayout() === "book" ? getSpreadStart(startPage) : startPage;
  if (token !== state.loadToken || state.lastRenderedPage !== startSpread) {
    return;
  }

  hideLoading();
  setBodyState("ready");
  document.body.dataset.pdfReady = "true";
  syncChromeVisibility();

  renderOutline().catch((error) => {
    console.warn("AVADRA could not build the outline.", error);
  });

  if (state.pendingSave) void handlePendingSave();
  saveProgressNow();

  if (saved && saved.page > 1 && startPage > 1) {
    showToast(`Resumed at page ${startPage}.`);
  }
}

async function handlePendingSave() {
  const pending = state.pendingSave;
  if (!pending || !state.book) return;
  state.pendingSave = null;

  const { id, file, personal } = pending;

  if (!isStorageAvailable()) {
    state.canPersist = Boolean(personal);
    showToast(
      personal
        ? "The PDF is open, but this browser cannot store a copy. You may need to choose it again next time."
        : "The PDF is open, but this browser cannot store local files. It will not be remembered after you leave.",
    );
    saveProgressNow();
    return;
  }

  try {
    const meta = await putPdf(id, file, {
      name: file.name,
      access: personal ? "personal" : "local",
    });

    if (personal) {
      state.storedRecord = { ...meta, blob: file };
    } else {
      addLocalBook({
        id,
        name: file.name,
        size: file.size,
        addedAt: meta.addedAt,
      });
      state.canPersist = true;
    }

    saveProgressNow();
    updateCopyInfo();
  } catch (error) {
    console.warn("AVADRA could not store the PDF.", error);
    state.canPersist = Boolean(personal);
    showToast(
      personal
        ? "The PDF is open, but this browser could not store the copy. Storage may be full; you may need to choose it again next time."
        : "The PDF is open, but it could not be stored. Storage may be full; it will not appear in local documents later.",
    );
  }
}

async function cancelLoad() {
  if (!dom.loading || dom.loading.hidden) return;
  const book = state.book;
  await destroyPdf();
  if (book?.access === "personal") {
    await showPersonalScreen(book);
    return;
  }
  await showStartScreen();
}

async function retryCurrent() {
  const book = state.book;
  if (!book) {
    location.reload();
    return;
  }

  if (state.lastSource?.blob) {
    await loadDocument({
      blob: state.lastSource.blob,
      book,
      existingLocal: book.access === "local",
      pendingSave: state.pendingSave,
    });
    return;
  }

  if (state.lastSource?.url) {
    await loadDocument({ url: state.lastSource.url, book });
    return;
  }

  if (book.access === "personal") {
    await openPersonalStored();
    return;
  }
  if (book.access === "local") {
    await openLocalById(book.id);
    return;
  }
  if (book.access === "open") {
    await openBook(book);
    return;
  }
  await showStartScreen();
}

function showErrorForDocument(error, book = state.book) {
  const name = error?.name || "";
  let title = "The file could not be opened";
  let message =
    "The PDF engine could not open this file. The file may be incomplete, damaged, or not a PDF.";

  if (name === "MissingPDFException") {
    title = "The edition file is missing";
    message =
      "The catalogue record was found, but its PDF file could not be located. The deployment may be incomplete, or the file may have moved.";
  } else if (name === "InvalidPDFException") {
    title = "This file is not a readable PDF";
    message =
      "The PDF engine rejected the file. Try another copy, or choose a different PDF from your device.";
  } else if (name === "PasswordException") {
    title = "This PDF is password-protected";
    message =
      "The reader cannot open encrypted PDFs that require a password. Choose an unlocked copy.";
  } else if (
    name === "UnexpectedResponseException" ||
    /HTTP|fetch|network/i.test(error?.message || "")
  ) {
    const status = error?.status;
    title = status === 404 ? "The edition file was not found" : "The file could not be downloaded";
    message =
      status === 404
        ? "The reader asked for the PDF at its catalogue path and the server returned 404. Check that the file is present and that the site paths are correct."
        : "The PDF could not be downloaded. This is usually a path, network, or server configuration problem. Check the file path and try again.";
  }

  const detail = [error?.name, error?.message].filter(Boolean).join(": ");
  const retry = Boolean(
    book &&
      (book.access !== "personal" ||
        state.storedRecord ||
        state.lastSource?.blob),
  );

  showErrorScreen({
    kicker: "The reader could not open this file",
    title,
    message,
    detail,
    book,
    retry,
  });
}

function showErrorScreen({
  kicker = "The reader could not open this file",
  title,
  message,
  detail = "",
  book = null,
  retry = true,
}) {
  state.book = book;
  updateTitle(book, title || "Unavailable", message || "The reader could not open this file");
  hideLoading();
  closeDrawer();
  setBodyState("error");

  if (!dom.statePanel) return;
  dom.statePanel.hidden = false;
  dom.statePanel.scrollTop = 0;

  const fileUrl =
    book?.access === "open" && book.file
      ? new URL(book.file, document.baseURI).href
      : "";

  const actions = [];
  if (retry) {
    actions.push(
      '<button class="btn btn--gold" type="button" data-action="retry">Try again</button>',
    );
  }
  actions.push(
    '<button class="btn btn--ghost" type="button" data-action="open-file">Open a PDF from your device</button>',
  );
  if (book?.access === "personal" && state.storedRecord) {
    actions.push(
      '<button class="text-link reader-danger" type="button" data-action="remove-stored">Remove stored copy</button>',
    );
  }
  if (book?.access === "local") {
    actions.push(
      '<button class="text-link reader-danger" type="button" data-action="remove-local">Remove from this browser</button>',
    );
  }
  if (fileUrl) {
    actions.push(
      `<a class="text-link" href="${escapeHtml(fileUrl)}" target="_blank" rel="noopener">Open the PDF in a new tab</a>`,
    );
  }
  if (!book) {
    actions.push(
      '<button class="text-link" type="button" data-action="show-start">Open the reading room</button>',
    );
  }
  actions.push('<a class="text-link" href="index.html#collection">Back to the library</a>');

  dom.statePanel.innerHTML = `
    <div class="reader-state-panel__inner reader-state-panel__inner--narrow">
      <p class="reader-state-panel__kicker">${escapeHtml(kicker)}</p>
      <h1 class="reader-state-panel__title reader-state-panel__title--book">${escapeHtml(title)}</h1>
      <p class="reader-state-panel__lede">${escapeHtml(message)}</p>
      <div class="reader-error">
        <svg class="reader-error__icon" aria-hidden="true"><use href="assets/icons.svg#icon-alert"></use></svg>
        <div class="reader-error__body">
          <h2>${escapeHtml(book?.title || "No file opened")}</h2>
          <p>${escapeHtml(
            book
              ? "The rest of the library is unaffected. Try again, open a different PDF, or return to the catalogue."
              : "The reading room can still open a PDF from your device. Local files never leave this browser.",
          )}</p>
          ${detail ? `<pre class="reader-error__detail">${escapeHtml(detail)}</pre>` : ""}
        </div>
      </div>
      <div class="reader-error__actions">${actions.join("")}</div>
    </div>`;
}

function showCatalogueError() {
  const error = state.catalogueError;
  showErrorScreen({
    kicker: "The reading room could not load",
    title: "The catalogue could not be opened",
    message:
      "The reading room needs the catalogue to find a catalogued edition. The request failed, which usually means a path or connection problem.",
    detail: error?.message || "",
    book: null,
    retry: true,
  });
}

function showBookNotFound(bookId) {
  showErrorScreen({
    kicker: "The reading room could not find this edition",
    title: "Edition not found",
    message: `The catalogue has no edition with the identifier “${bookId}”. The link may be old, or the catalogue may have changed.`,
    detail: "",
    book: null,
    retry: false,
  });
}

function showMissingLocal(bookId) {
  forgetBook(bookId);
  showErrorScreen({
    kicker: "The reading room could not find this local file",
    title: "Local document unavailable",
    message:
      "This browser no longer has that PDF stored. It may have been removed, or browser storage may have been cleared.",
    detail: "",
    book: null,
    retry: false,
  });
}

/* --------------------------------------------------------------------------
   Start screen and opening documents
   -------------------------------------------------------------------------- */

async function showStartScreen() {
  await destroyPdf();

  state.book = null;
  state.localMode = false;
  state.storedRecord = null;
  state.pendingSave = null;
  state.lastSource = null;
  state.canPersist = false;

  updateTitle(null);
  setReaderUrl(null, null);
  hideLoading();
  closeDrawer();
  setBodyState("start");

  if (!dom.statePanel) return;
  dom.statePanel.hidden = false;
  dom.statePanel.scrollTop = 0;

  const storageAvailable = isStorageAvailable();
  let localRecords = [];
  if (storageAvailable) {
    try {
      localRecords = (await listPdfs()).filter(
        (record) => record.access !== "personal",
      );
    } catch (error) {
      console.warn("AVADRA could not list local PDFs.", error);
    }
  }

  const last = getLastRead();
  const lastBook = resolveLastBook(last, localRecords);
  const openBooks = getOpenBooks(state.catalogue);

  const continueHtml = lastBook
    ? buildContinueCard(lastBook, last.progress)
    : "";

  const shelfHtml = openBooks.length
    ? `<div class="reader-start__grid">${openBooks
        .map((book) => readerBookCard(book))
        .join("")}</div>`
    : `<p class="reader-start__empty">${
        state.catalogueError
          ? `The open shelf could not be loaded. ${escapeHtml(state.catalogueError.message)}`
          : "The open shelf is empty. You can still open a PDF from your device."
      }</p>`;

  const localHtml = localRecords.length
    ? `<div class="reader-start__local-list">${localRecords
        .map((record) => localRow(record))
        .join("")}</div>`
    : `<p class="reader-start__empty">${
        storageAvailable
          ? "No local PDFs yet. Choose a PDF from your device to add one. It stays in this browser."
          : "This browser does not provide local PDF storage. You can still open a PDF for this session."
      }</p>`;

  dom.statePanel.innerHTML = `
    <div class="reader-state-panel__inner">
      <p class="reader-state-panel__kicker">AVADRA · reading room</p>
      <h1 class="reader-state-panel__title">The reading room</h1>
      <p class="reader-state-panel__lede">Choose a volume from the shelf, continue where you stopped, or open a PDF from your device. Reading progress, bookmarks, and local files stay in this browser.</p>
      ${continueHtml}
      <section class="reader-start__section">
        <div class="reader-start__section-head">
          <h2>Open shelf</h2>
          <p>${openBooks.length} ${openBooks.length === 1 ? "edition" : "editions"} ready to read</p>
        </div>
        ${shelfHtml}
      </section>
      <section class="reader-start__section">
        <div class="reader-start__section-head">
          <h2>From your device</h2>
          <p>${storageAvailable ? "Stored locally, never uploaded" : "Storage unavailable in this browser"}</p>
        </div>
        ${localHtml}
      </section>
      <div class="reader-start__footer">
        <button class="btn btn--gold" type="button" data-action="open-file">
          <svg aria-hidden="true"><use href="assets/icons.svg#icon-upload"></use></svg>
          Open a PDF
        </button>
        <button class="btn reader-start__flipbook" type="button" data-action="open-flipbook">
          <svg aria-hidden="true"><use href="assets/icons.svg#icon-book-open"></use></svg>
          Open PDF as 3D flipbook
        </button>
        <a class="text-link" href="index.html">Back to the library
          <svg aria-hidden="true"><use href="assets/icons.svg#icon-arrow-right"></use></svg>
        </a>
      </div>
      ${
        state.catalogueError
          ? '<p class="reader-state-panel__note">The catalogue is unavailable. You can still open a PDF from your device.</p>'
          : ""
      }
    </div>`;
}

function resolveLastBook(last, localRecords) {
  if (!last?.meta || !last?.progress) return null;
  const meta = last.meta;

  if (meta.access === "local") {
    const record = localRecords.find((item) => item.id === last.bookId);
    if (!record) return null;
    const title = prettyFileName(record.name);
    return {
      id: record.id,
      title,
      author: "Local document",
      access: "local",
      cover: "",
      coverTitle: splitTitle(title),
      category: "Local document",
      file: "",
      pages: null,
      size: record.size,
    };
  }

  if (!state.catalogue) return null;
  return getBookById(state.catalogue, last.bookId);
}

function buildContinueCard(book, progress) {
  if (!book || !progress) return "";
  const percent = clamp(
    Math.round((progress.page / Math.max(1, progress.totalPages)) * 100),
    0,
    100,
  );
  const action =
    book.access === "local"
      ? `data-open-local="${escapeHtml(book.id)}"`
      : `data-open-book="${escapeHtml(book.id)}"`;

  return `<button class="reader-start__continue" type="button" ${action} aria-label="Continue ${escapeHtml(
    book.title,
  )} at page ${progress.page}">
    ${readerCover(book)}
    <span class="reader-start__continue-body">
      <span class="reader-start__continue-kicker">Continue reading</span>
      <span class="reader-start__continue-title">${escapeHtml(book.title)}</span>
      <span class="reader-start__continue-meta">${escapeHtml(
        book.author,
      )} · Page ${progress.page} of ${progress.totalPages} · ${percent}%</span>
    </span>
    <span class="btn btn--gold">Continue</span>
  </button>`;
}

function readerBookCard(book) {
  return `<button class="reader-start__card" type="button" data-open-book="${escapeHtml(
    book.id,
  )}" aria-label="Open ${escapeHtml(book.title)}">
    ${readerCover(book)}
    <span class="reader-start__card-title">${escapeHtml(book.title)}</span>
    <span class="reader-start__card-author">${escapeHtml(book.author)}</span>
  </button>`;
}

function readerCover(book, { eager = false } = {}) {
  const rawLines =
    Array.isArray(book.coverTitle) && book.coverTitle.length
      ? book.coverTitle
      : splitTitle(book.title);
  const lines = rawLines.slice(0, 3);
  const missingClass = book.cover ? "" : " book-cover--missing";

  return `<span class="book-cover${missingClass}" data-lines="${lines.length}">
    ${
      book.cover
        ? `<img class="book-cover__art" src="${escapeHtml(
            book.cover,
          )}" alt="" width="600" height="900" loading="${
            eager ? "eager" : "lazy"
          }" decoding="async">`
        : ""
    }
    <span class="book-cover__overlay" aria-hidden="true">
      <span class="book-cover__title">${lines
        .map((line) => `<span>${escapeHtml(line)}</span>`)
        .join("")}</span>
      <span class="book-cover__author">${escapeHtml(book.author)}</span>
    </span>
  </span>`;
}

function localRow(record) {
  const title = prettyFileName(record.name);
  return `<button class="reader-start__local" type="button" data-open-local="${escapeHtml(
    record.id,
  )}" aria-label="Open ${escapeHtml(title)}">
    <svg aria-hidden="true"><use href="assets/icons.svg#icon-file"></use></svg>
    <span class="reader-start__local-body">
      <span class="reader-start__local-name">${escapeHtml(title)}</span>
      <span class="reader-start__local-meta">${formatBytes(
        record.size,
      )} · Local PDF</span>
    </span>
    <svg aria-hidden="true"><use href="assets/icons.svg#icon-chevron-right"></use></svg>
  </button>`;
}

async function openCatalogueBookById(bookId) {
  if (!state.catalogue) {
    showCatalogueError();
    return;
  }
  const book = getBookById(state.catalogue, bookId);
  if (!book) {
    showBookNotFound(bookId);
    return;
  }
  await openBook(book);
}

async function openBook(book) {
  if (!book) return;

  state.book = book;
  state.localMode = book.access === "local";
  state.storedRecord = null;
  state.pendingSave = null;
  state.lastSource = null;
  state.canPersist = book.access !== "local";

  closeDrawer();
  updateTitle(book);

  if (book.access === "personal") {
    setReaderUrl("book", book.id);
    let stored = null;
    if (isStorageAvailable()) {
      try {
        stored = await getPdf(book.id);
      } catch (error) {
        console.warn("AVADRA could not read the stored copy.", error);
      }
    }
    if (stored) {
      state.storedRecord = stored;
      await loadDocument({ blob: stored.blob, book });
      return;
    }
    await showPersonalScreen(book);
    return;
  }

  if (book.access === "local") {
    await openLocalById(book.id);
    return;
  }

  setReaderUrl("book", book.id);

  if (!book.file) {
    await destroyPdf();
    showErrorForDocument(
      new Error("This catalogue record does not include a PDF file."),
      book,
    );
    return;
  }

  const url = new URL(book.file, document.baseURI).href;
  await loadDocument({ url, book });
}

async function openLocalFile(file) {
  const id = await makeLocalId(file);
  const title = prettyFileName(file.name);
  const book = {
    id,
    title,
    author: "Local document",
    access: "local",
    cover: "",
    coverTitle: splitTitle(title),
    category: "Local document",
    file: "",
    pages: null,
    size: file.size,
  };

  state.book = book;
  state.localMode = true;
  state.canPersist = false;
  state.storedRecord = null;
  setReaderUrl("local", id);
  updateTitle(book);

  await loadDocument({
    blob: file,
    book,
    existingLocal: false,
    pendingSave: { id, file, personal: false },
  });
}

async function openLocalById(bookId) {
  if (!bookId) {
    await showStartScreen();
    return;
  }
  if (!isStorageAvailable()) {
    showMissingLocal(bookId);
    return;
  }

  let record = null;
  try {
    record = await getPdf(bookId);
  } catch (error) {
    console.warn("AVADRA could not read the local PDF.", error);
  }
  if (!record) {
    showMissingLocal(bookId);
    return;
  }

  const title = prettyFileName(record.name);
  const book = {
    id: bookId,
    title,
    author: "Local document",
    access: "local",
    cover: "",
    coverTitle: splitTitle(title),
    category: "Local document",
    file: "",
    pages: null,
    size: record.size,
  };

  state.book = book;
  state.localMode = true;
  state.canPersist = true;
  state.storedRecord = null;
  setReaderUrl("local", bookId);
  updateTitle(book);

  await loadDocument({ blob: record.blob, book, existingLocal: true });
}

async function openPersonalStored() {
  if (!state.book || state.book.access !== "personal") return;

  let stored = state.storedRecord;
  if (!stored && isStorageAvailable()) {
    try {
      stored = await getPdf(state.book.id);
    } catch (error) {
      stored = null;
    }
  }
  if (!stored) {
    await showPersonalScreen(state.book);
    return;
  }

  state.storedRecord = stored;
  closeDrawer();
  await loadDocument({ blob: stored.blob, book: state.book });
}

async function showPersonalScreen(book) {
  if (!book) return;

  await destroyPdf();
  state.book = book;
  state.localMode = false;
  state.canPersist = true;
  state.pendingSave = null;
  state.lastSource = null;
  setReaderUrl("book", book.id);

  updateTitle(book);
  setBodyState("personal");
  hideLoading();
  closeDrawer();

  if (!dom.statePanel) return;
  dom.statePanel.hidden = false;
  dom.statePanel.scrollTop = 0;

  let stored = null;
  if (isStorageAvailable()) {
    try {
      stored = await getPdf(book.id);
    } catch (error) {
      stored = null;
    }
  }
  if (state.book !== book) return;
  state.storedRecord = stored;

  const coverLines = (
    Array.isArray(book.coverTitle) && book.coverTitle.length
      ? book.coverTitle
      : [book.title]
  )
    .map((line) => escapeHtml(line))
    .join("<br>");

  const storedMeta = stored
    ? `<div class="reader-personal__meta">
        <span><strong>Stored:</strong> ${escapeHtml(stored.name)}</span>
        <span>${formatBytes(stored.size)}</span>
      </div>`
    : "";

  dom.statePanel.innerHTML = `
    <div class="reader-state-panel__inner reader-state-panel__inner--narrow">
      <p class="reader-state-panel__kicker">Edition</p>
      <h1 class="reader-state-panel__title reader-state-panel__title--book">${escapeHtml(
        book.title,
      )}</h1>
      <p class="reader-state-panel__author">${escapeHtml(book.author)}</p>
      <div class="reader-personal">
        <div class="reader-personal__cover">
          <span class="reader-personal__cover-title">${coverLines}</span>
          <span class="reader-personal__cover-author">${escapeHtml(book.author)}</span>
        </div>
        <div class="reader-personal__body">
          <h2>Bring your own copy</h2>
          <p>This catalogue record does not include a book file. Choose a PDF of this edition from your device. The file is stored only in this browser and is never uploaded.</p>
          ${book.summary ? `<p>${escapeHtml(book.summary)}</p>` : ""}
          <div class="reader-personal__actions">
            <button class="btn btn--gold" type="button" data-action="open-file">Choose a PDF</button>
            ${
              stored
                ? '<button class="btn btn--ghost" type="button" data-action="open-stored">Open stored copy</button>'
                : ""
            }
          </div>
          ${storedMeta}
          ${
            stored
              ? '<button class="text-link reader-danger reader-personal__remove" type="button" data-action="remove-stored">Remove stored copy</button>'
              : ""
          }
          <p class="reader-state-panel__note">Read only a copy you have the right to read. No upload, no account, no server.</p>
        </div>
      </div>
      <div class="reader-state-panel__actions">
        <button class="text-link" type="button" data-action="show-start">Browse the collection</button>
        <a class="text-link" href="index.html#collection">Back to the library</a>
      </div>
    </div>`;

  updateCopyInfo();
}

async function makeLocalId(file) {
  const fingerprint = `${file.name || "pdf"}:${file.size || 0}:${file.lastModified || 0}`;

  if (window.crypto?.subtle && window.isSecureContext) {
    try {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(fingerprint),
      );
      const bytes = new Uint8Array(digest).slice(0, 10);
      return `local:${Array.from(bytes, (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("")}`;
    } catch (error) {
      /* Fall through to the small non-cryptographic hash. */
    }
  }

  let hash = 2166136261;
  for (let index = 0; index < fingerprint.length; index += 1) {
    hash ^= fingerprint.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `local:${(hash >>> 0).toString(16)}`;
}

/* --------------------------------------------------------------------------
   Drawer
   -------------------------------------------------------------------------- */

function openDrawer(panel = state.activePanel) {
  if (!dom.drawer) return;
  if (!state.pdf && panel !== "settings") {
    showToast("Open a volume first.");
    return;
  }
  if (!state.drawerOpen) state.lastFocus = document.activeElement;

  state.drawerOpen = true;
  state.activePanel = PANELS.has(panel) ? panel : "settings";

  dom.drawer.classList.add("is-open");
  dom.drawer.setAttribute("aria-hidden", "false");
  dom.drawer.removeAttribute("inert");
  dom.drawer.inert = false;
  if (dom.scrim) dom.scrim.hidden = false;

  switchPanel(state.activePanel);
  setPreferences({ lastPanel: state.activePanel });

  requestAnimationFrame(() => {
    if (state.activePanel === "search" && dom.searchInput) {
      dom.searchInput.focus();
      return;
    }
    const tab = $(`.reader-tab[data-panel="${state.activePanel}"]`, dom.drawer);
    tab?.focus({ preventScroll: true });
  });
}

function closeDrawer() {
  const lastFocus = state.lastFocus;
  state.lastFocus = null;

  state.drawerOpen = false;

  if (dom.drawer) {
    dom.drawer.classList.remove("is-open");
    dom.drawer.setAttribute("aria-hidden", "true");
    dom.drawer.setAttribute("inert", "");
    dom.drawer.inert = true;
  }
  if (dom.scrim) dom.scrim.hidden = true;

  if (
    lastFocus &&
    document.contains(lastFocus) &&
    !lastFocus.closest("[inert]") &&
    typeof lastFocus.focus === "function"
  ) {
    try {
      lastFocus.focus({ preventScroll: true });
    } catch (error) {
      lastFocus.focus();
    }
  }
}

function switchPanel(panel) {
  if (!PANELS.has(panel)) return;
  state.activePanel = panel;

  if (dom.tabs) {
    $$(".reader-tab", dom.tabs).forEach((tab) => {
      const selected = tab.dataset.panel === panel;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
  }

  $$("[data-panel-section]").forEach((section) => {
    section.hidden = section.dataset.panelSection !== panel;
  });

  if (panel === "pages") {
    ensureThumbnails();
    requestAnimationFrame(() => {
      const active = dom.thumbs?.querySelector(".reader-thumb.is-active");
      if (active) active.scrollIntoView({ block: "nearest" });
    });
  } else if (panel === "bookmarks") {
    renderBookmarks();
  } else if (panel === "settings") {
    updateSettingsUI();
  } else if (panel === "search") {
    requestAnimationFrame(() => dom.searchInput?.focus());
  }

  setPreferences({ lastPanel: panel });
}

function updateSettingsUI() {
  updateThemeUI();
  updateWidthUI();
  updateFitUI();
  updateZoomUI();
  updateLayoutUI();
  updateDirectionUI();
  updateEffectUI();

  if (dom.brightnessInput) {
    dom.brightnessInput.value = String(state.brightness);
  }
  if (dom.brightnessValue) {
    dom.brightnessValue.textContent = `${state.brightness}%`;
  }
  if (dom.focusToggle) dom.focusToggle.checked = state.focusMode;
  if (dom.animationsToggle) {
    dom.animationsToggle.checked = state.pageAnimations;
  }

  const clearButton = document.querySelector('[data-action="clear-progress"]');
  if (clearButton) clearButton.disabled = !state.book;

  updateCopyInfo();
}

async function updateCopyInfo() {
  if (!dom.copyInfo) return;

  const book = state.book;
  if (!book) {
    dom.copyInfo.innerHTML = `
      <div class="reader-copy-info__name">No volume open</div>
      <div class="reader-copy-info__meta">Choose a book or open a PDF from your device.</div>`;
    return;
  }

  if (book.access === "personal") {
    let record = state.storedRecord;
    if (!record && isStorageAvailable()) {
      try {
        record = await getPdf(book.id);
      } catch (error) {
        record = null;
      }
      if (state.book !== book) return;
      state.storedRecord = record;
    }

    dom.copyInfo.innerHTML = record
      ? `<div class="reader-copy-info__name">${escapeHtml(
          record.name || "Stored PDF",
        )}</div>
         <div class="reader-copy-info__meta">${formatBytes(
           record.size,
         )} · Stored in this browser</div>
         <div class="reader-copy-info__actions">
           <button class="text-link" type="button" data-action="open-file">Replace PDF</button>
           <button class="text-link reader-danger" type="button" data-action="remove-stored">Remove stored copy</button>
         </div>`
      : `<div class="reader-copy-info__name">No copy stored yet</div>
         <div class="reader-copy-info__meta">Choose a PDF from your device. It stays in this browser.</div>
         <div class="reader-copy-info__actions">
           <button class="text-link" type="button" data-action="open-file">Choose a PDF</button>
         </div>`;
    return;
  }

  if (book.access === "local") {
    dom.copyInfo.innerHTML = `
      <div class="reader-copy-info__name">${escapeHtml(book.title)}</div>
      <div class="reader-copy-info__meta">${formatBytes(
        book.size || 0,
      )} · Local document</div>
      <div class="reader-copy-info__actions">
        <button class="text-link" type="button" data-action="open-file">Open a different PDF</button>
        <button class="text-link reader-danger" type="button" data-action="remove-local">Remove from this browser</button>
      </div>`;
    return;
  }

  const source = book.source?.url
    ? `<a class="text-link" href="${escapeHtml(
        book.source.url,
      )}" target="_blank" rel="noopener">${escapeHtml(
        book.source.name || "Source",
      )} <svg aria-hidden="true"><use href="assets/icons.svg#icon-external"></use></svg></a>`
    : "";

  dom.copyInfo.innerHTML = `
    <div class="reader-copy-info__name">${escapeHtml(book.title)}</div>
    <div class="reader-copy-info__meta">Open shelf edition · served with AVADRA</div>
    <div class="reader-copy-info__actions">
      ${source}
      <button class="text-link" type="button" data-action="open-file">Open a PDF from your device</button>
    </div>`;
}

/* --------------------------------------------------------------------------
   Bookmarks
   -------------------------------------------------------------------------- */

function renderBookmarks() {
  if (!dom.bookmarks) return;
  if (!state.book) {
    dom.bookmarks.innerHTML =
      '<p class="reader-bookmarks-empty">Open a book to see its bookmarks.</p>';
    return;
  }

  const list = getBookmarks(state.book.id);
  if (!list.length) {
    dom.bookmarks.innerHTML =
      '<p class="reader-bookmarks-empty">No bookmarks yet. Use the bookmark button, or press <kbd>B</kbd>, to mark the page you are on.</p>';
    return;
  }

  dom.bookmarks.innerHTML = list
    .map((entry) => {
      const date = formatBookmarkDate(entry.createdAt);
      return `<div class="reader-bookmark-row">
        <button class="reader-bookmark" type="button" data-bookmark-page="${
          entry.page
        }" aria-label="Go to bookmarked page ${entry.page}">
          <span class="reader-bookmark__page">Page ${entry.page}</span>
          <span class="reader-bookmark__label">${escapeHtml(
            entry.label || `Page ${entry.page}`,
          )}</span>
          ${
            date
              ? `<span class="reader-bookmark__date">${escapeHtml(
                  date,
                )}</span>`
              : ""
          }
        </button>
        <button class="reader-icon-btn" type="button" data-remove-bookmark="${
          entry.page
        }" aria-label="Remove bookmark at page ${entry.page}">
          <svg aria-hidden="true"><use href="assets/icons.svg#icon-trash"></use></svg>
        </button>
      </div>`;
    })
    .join("");
}

function formatBookmarkDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const options = { month: "short", day: "numeric" };
  if (date.getFullYear() !== now.getFullYear()) options.year = "numeric";
  try {
    return new Intl.DateTimeFormat(undefined, options).format(date);
  } catch (error) {
    return "";
  }
}

async function toggleBookmarkForPage() {
  if (!state.book || !state.pdf) return;
  const book = state.book;
  const page = state.currentPage;

  if (hasBookmark(book.id, page)) {
    removeBookmark(book.id, page);
    showToast(`Bookmark removed from page ${page}.`);
  } else {
    const label = await getPageSnippet(page);
    if (state.book !== book || !state.pdf) return;
    addBookmark(book.id, page, label);
    showToast(`Bookmarked page ${page}.`);
  }

  updateBookmarkButtons();
  if (state.drawerOpen && state.activePanel === "bookmarks") renderBookmarks();
}

/* --------------------------------------------------------------------------
   Search
   -------------------------------------------------------------------------- */

async function runSearch(rawQuery) {
  if (!state.pdf) return;

  const query = String(rawQuery || "").trim();
  const button = dom.searchForm?.querySelector('button[type="submit"]');
  const token = ++state.searchToken;

  dom.searchResults.innerHTML = "";

  if (query.length < 2) {
    dom.searchStatus.textContent =
      "Type at least two characters to search this book.";
    if (button) {
      button.textContent = "Search";
      button.disabled = false;
    }
    return;
  }

  const normalisedTerms = normaliseText(query).split(" ").filter(Boolean);
  const highlightTerms = query.split(/\s+/).filter(Boolean);
  const documentToken = state.documentToken;

  dom.searchStatus.textContent = "Searching…";
  if (button) {
    button.textContent = "Searching…";
    button.disabled = true;
  }

  const results = [];

  for (let page = 1; page <= state.totalPages; page += 1) {
    if (token !== state.searchToken || documentToken !== state.documentToken) {
      return;
    }

    let text = "";
    try {
      text = await getPageText(page);
    } catch (error) {
      continue;
    }

    if (token !== state.searchToken) return;

    const haystack = normaliseText(text);
    if (normalisedTerms.every((term) => haystack.includes(term))) {
      results.push({
        page,
        snippet: buildSearchSnippet(text, highlightTerms),
      });
      if (results.length >= MAX_SEARCH_RESULTS) break;
    }

    if (page % 8 === 0 || page === state.totalPages) {
      dom.searchStatus.textContent = `Searching page ${page} of ${state.totalPages}…`;
      await delay(0);
    }
  }

  if (token !== state.searchToken) return;

  if (button) {
    button.textContent = "Search";
    button.disabled = false;
  }

  if (!results.length) {
    dom.searchStatus.textContent = `No matches for “${query}”.`;
    dom.searchResults.innerHTML =
      '<p class="reader-search-empty">Try a shorter word or check the spelling. Scanned PDFs without a text layer return no matches.</p>';
    return;
  }

  const limited = results.length >= MAX_SEARCH_RESULTS;
  dom.searchStatus.textContent = `${results.length}${
    limited ? "+" : ""
  } ${results.length === 1 ? "match" : "matches"} in ${
    state.totalPages
  } pages.${limited ? " Showing the first results." : ""}`;

  dom.searchResults.innerHTML = results
    .map(
      (result) => `<button class="reader-result" type="button" data-result-page="${
        result.page
      }">
        <span class="reader-result__page">Page ${result.page}</span>
        <span class="reader-result__snippet">${highlightSnippet(
          result.snippet,
          highlightTerms,
        )}</span>
      </button>`,
    )
    .join("");
}

function clearSearch() {
  state.searchToken += 1;
  if (dom.searchInput) dom.searchInput.value = "";
  if (dom.searchResults) dom.searchResults.innerHTML = "";
  if (dom.searchStatus) dom.searchStatus.textContent = SEARCH_HINT;
  const button = dom.searchForm?.querySelector('button[type="submit"]');
  if (button) {
    button.textContent = "Search";
    button.disabled = false;
  }
}

/* --------------------------------------------------------------------------
   Outline
   -------------------------------------------------------------------------- */

async function renderOutline() {
  if (!state.pdf || !dom.outline || !dom.outlineSection) return;

  const token = state.documentToken;
  state.outlineEntries = [];
  dom.outline.innerHTML = "";
  dom.outlineSection.hidden = true;

  let outline = null;
  try {
    outline = await state.pdf.getOutline();
  } catch (error) {
    console.warn("AVADRA could not read the PDF outline.", error);
    return;
  }

  if (
    !state.pdf ||
    token !== state.documentToken ||
    !Array.isArray(outline) ||
    !outline.length
  ) {
    return;
  }

  const html = buildOutlineHtml(outline, 0);
  if (!state.outlineEntries.length) return;

  dom.outline.innerHTML = html;
  dom.outlineSection.hidden = false;
}

function buildOutlineHtml(items, level) {
  if (
    !Array.isArray(items) ||
    !items.length ||
    level > 6 ||
    state.outlineEntries.length >= MAX_OUTLINE_ENTRIES
  ) {
    return "";
  }

  let html = "<ul>";
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if (state.outlineEntries.length >= MAX_OUTLINE_ENTRIES) break;

    const index = state.outlineEntries.length;
    state.outlineEntries.push(item.dest ?? null);
    const title =
      typeof item.title === "string" && item.title.trim()
        ? item.title.trim()
        : "Untitled section";

    html += `<li><button type="button" data-outline-index="${index}" style="--level:${Math.min(
      level,
      5,
    )}">${escapeHtml(title)}</button>`;

    if (Array.isArray(item.items) && item.items.length) {
      html += buildOutlineHtml(item.items, level + 1);
    }
    html += "</li>";
  }
  html += "</ul>";
  return html;
}

async function jumpToOutline(index) {
  if (!state.pdf || !Number.isInteger(index)) return;

  const destination = state.outlineEntries[index];
  if (!destination) {
    showToast("That section has no page destination.");
    return;
  }

  try {
    let resolved = destination;
    if (typeof resolved === "string") {
      resolved = await state.pdf.getDestination(resolved);
    }
    if (!Array.isArray(resolved) || !resolved.length) {
      showToast("That section has no page destination.");
      return;
    }

    const reference = resolved[0];
    let page = null;
    if (reference && typeof reference === "object") {
      page = (await state.pdf.getPageIndex(reference)) + 1;
    } else if (Number.isInteger(reference)) {
      page = reference + 1;
    }

    if (!Number.isInteger(page) || page < 1 || page > state.totalPages) {
      showToast("That section has no page destination.");
      return;
    }

    closeDrawer();
    await goToPage(page);
  } catch (error) {
    console.warn("AVADRA could not resolve that outline destination.", error);
    showToast("That section could not be opened.");
  }
}

/* --------------------------------------------------------------------------
   Thumbnails
   -------------------------------------------------------------------------- */

function ensureThumbnails() {
  if (!state.pdf || !dom.thumbs) return;
  if (
    state.thumbsBuilt &&
    state.thumbsToken === state.documentToken
  ) {
    return;
  }

  state.thumbsBuilt = true;
  state.thumbsToken = state.documentToken;
  dom.thumbs.innerHTML = "";

  const limit = Math.min(state.totalPages, 800);
  const fragment = document.createDocumentFragment();
  const eagerFrames = [];

  for (let page = 1; page <= limit; page += 1) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "reader-thumb";
    button.dataset.thumbPage = String(page);
    button.setAttribute("aria-label", `Go to page ${page}`);

    const frame = document.createElement("span");
    frame.className = "reader-thumb__frame";
    const placeholder = document.createElement("span");
    placeholder.className = "reader-thumb__placeholder";
    frame.append(placeholder);

    const number = document.createElement("span");
    number.className = "reader-thumb__num";
    number.textContent = String(page);

    button.append(frame, number);
    fragment.append(button);

    if (page <= 12) eagerFrames.push({ page, frame });
  }

  dom.thumbs.append(fragment);

  if (state.totalPages > limit) {
    const note = document.createElement("p");
    note.className = "reader-thumbs__note";
    note.textContent = `Showing the first ${limit} of ${state.totalPages} pages. Use the page field or slider for later pages.`;
    dom.thumbs.append(note);
  }

  setupThumbObserver();
  updateActiveThumb();

  for (const { page, frame } of eagerFrames) queueThumb(page, frame);
}

function setupThumbObserver() {
  disconnectThumbObserver();
  if (!dom.thumbs || !("IntersectionObserver" in window)) return;

  state.thumbObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const button = entry.target;
        state.thumbObserver?.unobserve(button);
        const frame = button.querySelector(".reader-thumb__frame");
        if (frame) queueThumb(Number(button.dataset.thumbPage), frame);
      }
    },
    {
      root: dom.drawerBody || null,
      rootMargin: "600px 0px",
    },
  );

  $$("[data-thumb-page]", dom.thumbs).forEach((button) => {
    state.thumbObserver.observe(button);
  });
}

function disconnectThumbObserver() {
  if (!state.thumbObserver) return;
  try {
    state.thumbObserver.disconnect();
  } catch (error) {
    /* Already disconnected. */
  }
  state.thumbObserver = null;
}

function queueThumb(page, frame) {
  if (!state.pdf || !frame || !Number.isFinite(page)) return;

  const cached = state.thumbCache.get(page);
  if (cached) {
    setThumbImage(frame, cached);
    return;
  }
  if (frame.dataset.thumbLoading === "true") return;

  frame.dataset.thumbLoading = "true";
  state.thumbJobs.push({ page, frame, token: state.documentToken });
  pumpThumbJobs();
}

function pumpThumbJobs() {
  if (state.thumbActive >= 2) return;
  const job = state.thumbJobs.shift();
  if (!job) return;

  if (job.token !== state.documentToken || !state.pdf) {
    pumpThumbJobs();
    return;
  }

  state.thumbActive += 1;
  renderThumb(job).finally(() => {
    state.thumbActive = Math.max(0, state.thumbActive - 1);
    pumpThumbJobs();
  });
}

async function renderThumb({ page, frame, token }) {
  if (!state.pdf || token !== state.documentToken) return;

  const pdf = state.pdf;

  try {
    const pdfPage = await pdf.getPage(page);
    if (token !== state.documentToken || state.pdf !== pdf) return;

    const base = pdfPage.getViewport({ scale: 1 });
    const scale = THUMB_WIDTH / base.width;
    const viewport = pdfPage.getViewport({ scale });

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));

    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return;

    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await pdfPage.render({
      canvasContext: context,
      viewport,
      background: "#ffffff",
    }).promise;

    if (token !== state.documentToken || state.pdf !== pdf) return;

    const url = canvas.toDataURL("image/jpeg", 0.72);
    state.thumbCache.set(page, url);
    if (state.thumbCache.size > MAX_THUMB_CACHE) {
      const first = state.thumbCache.keys().next().value;
      state.thumbCache.delete(first);
    }

    if (frame.isConnected) setThumbImage(frame, url);
  } catch (error) {
    if (error?.name === "RenderingCancelledException") return;
    if (frame.isConnected) {
      frame.textContent = "—";
      frame.classList.add("reader-thumb__frame--failed");
    }
  } finally {
    if (frame.isConnected) delete frame.dataset.thumbLoading;
  }
}

function setThumbImage(frame, url) {
  frame.textContent = "";
  frame.classList.remove("reader-thumb__frame--failed");
  const image = document.createElement("img");
  image.src = url;
  image.alt = "";
  image.loading = "lazy";
  image.decoding = "async";
  frame.append(image);
}

function resetThumbs() {
  disconnectThumbObserver();
  if (dom.thumbs) dom.thumbs.innerHTML = "";
  state.thumbsBuilt = false;
  state.thumbsToken = -1;
  state.thumbJobs = [];
}

function resetOutline() {
  state.outlineEntries = [];
  if (dom.outline) dom.outline.innerHTML = "";
  if (dom.outlineSection) dom.outlineSection.hidden = true;
}

/* --------------------------------------------------------------------------
   File input and destructive actions
   -------------------------------------------------------------------------- */

function chooseFile() {
  dom.fileInput?.click();
}

async function handleFilePicked(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;

  if (file.size > MAX_FILE_BYTES) {
    showToast(
      `That PDF is ${formatBytes(file.size)}. The reader accepts files up to 160 MB.`,
    );
    return;
  }

  let header = "";
  try {
    const buffer = await file.slice(0, 1024).arrayBuffer();
    header = new TextDecoder("latin1").decode(buffer);
  } catch (error) {
    showToast("The start of that file could not be read.");
    return;
  }

  if (!header.includes("%PDF-")) {
    showToast("That file does not look like a PDF.");
    return;
  }

  closeDrawer();

  if (state.book?.access === "personal") {
    const book = state.book;
    state.storedRecord = null;
    updateTitle(book);
    await loadDocument({
      blob: file,
      book,
      existingLocal: false,
      pendingSave: { id: book.id, file, personal: true },
    });
    return;
  }

  await openLocalFile(file);
}

function confirmRemoveStored() {
  const book = state.book;
  if (!book || book.access !== "personal") return;

  confirmAction({
    title: "Remove the stored copy?",
    message:
      "The PDF will be deleted from this browser. Your progress and bookmarks stay. You can choose the file again later.",
    confirmLabel: "Remove copy",
    onConfirm: async () => {
      try {
        await deletePdf(book.id);
      } catch (error) {
        console.warn("AVADRA could not remove the stored copy.", error);
        showToast("The stored copy could not be removed.");
        return;
      }

      state.storedRecord = null;
      state.lastSource = null;
      const wasCurrent = state.book?.id === book.id && Boolean(state.pdf);

      if (wasCurrent) {
        await showPersonalScreen(book);
      } else {
        updateCopyInfo();
      }
      showToast("Stored copy removed.");
    },
  });
}

function confirmRemoveLocal() {
  const book = state.book;
  if (!book || book.access !== "local") return;

  confirmAction({
    title: "Remove this local PDF?",
    message:
      "The file, its saved page, and its bookmarks will be deleted from this browser. This cannot be undone.",
    confirmLabel: "Remove PDF",
    onConfirm: async () => {
      try {
        await deletePdf(book.id);
      } catch (error) {
        console.warn("AVADRA could not remove the local PDF.", error);
        showToast("The file could not be removed from browser storage.");
        return;
      }

      forgetBook(book.id);
      state.lastSource = null;
      state.storedRecord = null;

      if (state.book?.id === book.id) {
        await showStartScreen();
      } else {
        updateCopyInfo();
      }
      showToast("Local PDF removed.");
    },
  });
}

function confirmClearProgress() {
  const book = state.book;
  if (!book) return;

  confirmAction({
    title: "Clear progress and bookmarks?",
    message:
      "This clears the saved page and all bookmarks for this book in this browser. The book itself stays.",
    confirmLabel: "Clear data",
    onConfirm: () => {
      clearBookReadingData(book.id);
      clearTimeout(state.saveTimer);
      state.saveTimer = null;
      state.suppressSaveOnce = true;
      updateBookmarkButtons();
      if (state.drawerOpen && state.activePanel === "bookmarks") {
        renderBookmarks();
      }
      showToast("Progress and bookmarks cleared.");
    },
  });
}
