/**
 * The Wizarding Library — reader.
 *
 * PDF.js renders only the pages near the reader's eye. Scroll mode keeps light
 * page placeholders in the document and swaps canvases in and out; Book mode
 * renders one spread at a time and releases the previous canvases.
 */

import { loadCatalogue, getBookById } from "./catalogue.js";
import {
  getProgress,
  setProgress,
  setLastBook,
  getBookmarks,
  isBookmarked,
  toggleBookmark,
  removeBookmark,
  getSettings,
  updateSettings,
} from "./storage.js";

const PDF_LIBRARY = new URL("../vendor/pdfjs/pdf.js", import.meta.url);
const PDF_WORKER = new URL("../vendor/pdfjs/pdf.worker.js", import.meta.url);
const ICONS = "assets/icons.svg";

const MIN_ZOOM = 0.75;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.1;
const BOOK_SINGLE_BREAKPOINT = 760;
const SCROLL_MAX_PAGE_WIDTH = 780;
const SCROLL_NEARBY_MARGIN = 1100;
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");
const requestedBookId = (new URLSearchParams(window.location.search).get("book") || "").trim();

const dom = {
  body: document.body,
  main: document.querySelector("#reader-main"),
  stage: document.querySelector("#reader-stage"),
  scrollView: document.querySelector("#scroll-view"),
  bookView: document.querySelector("#book-view"),
  bookSpread: document.querySelector("#book-spread"),
  turn: document.querySelector("#reader-turn"),
  loading: document.querySelector("#reader-loading"),
  loadingCover: document.querySelector("#reader-loading-cover"),
  loadingEyebrow: document.querySelector("#reader-loading-eyebrow"),
  loadingTitle: document.querySelector("#reader-loading-title"),
  loadingText: document.querySelector("#reader-loading-text"),
  loadingBar: document.querySelector("#reader-loading-bar"),
  error: document.querySelector("#reader-error"),
  errorTitle: document.querySelector("#reader-error-title"),
  errorMessage: document.querySelector("#reader-error-message"),
  errorHint: document.querySelector("#reader-error-hint"),
  errorEyebrow: document.querySelector(".reader-error__eyebrow"),
  retry: document.querySelector("[data-retry-reader]"),
  bookTitle: document.querySelector("#reader-book-title"),
  bookAuthor: document.querySelector("#reader-book-author"),
  progressBar: document.querySelector("#reader-progress-bar"),
  progressFill: document.querySelector("#reader-progress-fill"),
  pageInput: document.querySelector("#reader-page-input"),
  pageTotal: document.querySelector("#reader-page-total"),
  pageForm: document.querySelector("[data-page-form]"),
  prev: document.querySelector('[data-action="previous"]'),
  next: document.querySelector('[data-action="next"]'),
  modes: Array.from(document.querySelectorAll("[data-mode]")),
  bookmarkButton: document.querySelector('[data-action="bookmark"]'),
  bookmarksButton: document.querySelector('[data-open-dialog="bookmarks"]'),
  bookmarkCount: document.querySelector("[data-bookmark-count]"),
  zoomOut: document.querySelector('[data-action="zoom-out"]'),
  zoomIn: document.querySelector('[data-action="zoom-in"]'),
  zoomFit: document.querySelector('[data-action="fit"]'),
  zoomValue: document.querySelector(".reader-zoom__value"),
  fullscreenButton: document.querySelector('[data-action="fullscreen"]'),
  focusButton: document.querySelector('.reader-header [data-action="focus"]'),
  focusExit: document.querySelector(".reader-focus-exit"),
  musicButton: document.querySelector('[data-action="music"]'),
  musicPanel: document.querySelector("#reader-music"),
  musicToggle: document.querySelector("[data-music-toggle]"),
  musicSeek: document.querySelector("#music-seek"),
  musicCurrent: document.querySelector("#music-current"),
  musicDuration: document.querySelector("#music-duration"),
  musicVolume: document.querySelector("#music-volume"),
  musicVolumeValue: document.querySelector("#music-volume-value"),
  audio: document.querySelector("#reading-audio"),
  statusPages: document.querySelector("#reader-status-pages"),
  toast: document.querySelector("#reader-toast"),
  displayDialog: document.querySelector("#display-dialog"),
  shortcutsDialog: document.querySelector("#shortcuts-dialog"),
  bookmarksDialog: document.querySelector("#bookmarks-dialog"),
  bookmarkList: document.querySelector("#bookmark-list"),
  themeRadios: Array.from(document.querySelectorAll('input[name="reader-theme"]')),
  invertCheckbox: document.querySelector("#setting-invert-pages"),
  pageTurnCheckbox: document.querySelector("#setting-page-turn"),
  reducedMotionNote: document.querySelector("#reduced-motion-note"),
  metaTheme: document.querySelector('meta[name="theme-color"]'),
};

let settings = getSettings();
let pdfjs = null;
let pageCache = new Map();
let bookData = null;
let pdfDocument = null;
let scrollObserver = null;
let saveTimer = null;
let toastTimer = null;
let turnTimer = null;
let scrollFrame = null;
let resizeTimer = null;

const state = {
  ready: false,
  loading: false,
  total: 0,
  page: 1,
  mode: settings.mode === "book" ? "book" : "scroll",
  zoom: settings.zoom,
  baseWidth: 612,
  baseHeight: 792,
  pageRatio: 792 / 612,
  savedPage: null,
  lastSize: { width: 0, height: 0 },
  currentSpread: [1],
  scroll: {
    placeholders: [],
    offsets: [],
    tasks: new Map(),
    queue: new Set(),
    pumpRunning: false,
    generation: 0,
    pageWidth: 0,
  },
  book: {
    generation: 0,
    tasks: [],
  },
};

/* --------------------------------------------------------------------------
   Small utilities
   -------------------------------------------------------------------------- */

function icon(name, className = "") {
  const classAttribute = className ? ` class="${className}"` : "";
  return `<svg${classAttribute} aria-hidden="true"><use href="${ICONS}#icon-${name}"></use></svg>`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clampPage(value) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return state.page;
  return clamp(number, 1, Math.max(1, state.total));
}

function zoomFactor() {
  if (state.zoom === "fit") return 1;
  return clamp(Number(state.zoom) || 1, MIN_ZOOM, MAX_ZOOM);
}

function setIcon(button, name) {
  const use = button?.querySelector("use");
  if (use) use.setAttribute("href", `${ICONS}#icon-${name}`);
}

function isTypingTarget(target) {
  return (
    target instanceof HTMLElement &&
    Boolean(target.closest('input, textarea, select, [contenteditable="true"]'))
  );
}

function hasOpenDialog() {
  return Boolean(document.querySelector("dialog[open]"));
}

function setLoading(eyebrow, title, text, percent = null) {
  dom.loadingEyebrow.textContent = eyebrow;
  dom.loadingTitle.textContent = title;
  dom.loadingText.textContent = text;
  if (percent !== null) setLoadingProgress(percent);
}

function setLoadingProgress(percent) {
  const value = clamp(Math.round(Number(percent) || 0), 0, 100);
  dom.loadingBar.style.width = `${value}%`;
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  dom.toast.textContent = message;
  dom.toast.classList.add("is-visible");
  toastTimer = window.setTimeout(() => {
    dom.toast.classList.remove("is-visible");
  }, 2800);
}

function setControlsEnabled(enabled) {
  const controls = [
    ...dom.modes,
    dom.prev,
    dom.next,
    dom.pageInput,
    dom.bookmarkButton,
    dom.bookmarksButton,
    dom.zoomOut,
    dom.zoomIn,
    dom.zoomFit,
    dom.fullscreenButton,
    dom.focusButton,
  ];
  for (const control of controls) {
    if (control) control.disabled = !enabled;
  }

  if (dom.fullscreenButton) {
    dom.fullscreenButton.disabled = !enabled || !document.fullscreenEnabled;
  }
  dom.main.setAttribute("aria-busy", enabled ? "false" : "true");
}

function showError({ eyebrow = "Reading room closed", title, message, hint = "", retry = false }) {
  dom.loading.hidden = true;
  dom.stage.hidden = true;
  dom.error.hidden = false;
  dom.errorEyebrow.textContent = eyebrow;
  dom.errorTitle.textContent = title;
  dom.errorMessage.textContent = message;
  dom.errorHint.textContent = hint;
  dom.errorHint.hidden = !hint;
  dom.retry.hidden = !retry;
  dom.errorTitle.tabIndex = -1;
  setControlsEnabled(false);
  dom.main.setAttribute("aria-busy", "false");
  document.title = `${title} — The Wizarding Library`;
  window.setTimeout(() => dom.errorTitle.focus(), 30);
}

/* --------------------------------------------------------------------------
   Display settings
   -------------------------------------------------------------------------- */

function updateReducedMotionNote() {
  dom.reducedMotionNote.hidden = !REDUCED_MOTION.matches;
}

function applyDisplaySettings() {
  document.body.dataset.theme = settings.theme;
  document.body.classList.toggle("invert-pages", settings.invertPages);
  for (const radio of dom.themeRadios) {
    radio.checked = radio.value === settings.theme;
  }
  dom.invertCheckbox.checked = settings.invertPages;
  dom.pageTurnCheckbox.checked = settings.pageTurn;
  updateReducedMotionNote();
  if (dom.metaTheme) {
    dom.metaTheme.content = settings.theme === "study" ? "#f4ede0" : "#070d12";
  }
}

function saveSettings(patch) {
  settings = updateSettings(patch);
  applyDisplaySettings();
}

/* --------------------------------------------------------------------------
   Book chrome and loading presentation
   -------------------------------------------------------------------------- */

function setBookChrome(book) {
  bookData = book;
  dom.bookTitle.textContent = book.title;
  dom.bookTitle.title = book.title;
  dom.bookAuthor.textContent = book.author;
  dom.bookAuthor.title = book.author;
  document.title = `${book.title} — The Wizarding Library`;

  if (book.cover) {
    const image = document.createElement("img");
    image.src = book.cover;
    image.alt = "";
    image.decoding = "async";
    image.addEventListener("error", () => {
      dom.loadingCover.hidden = true;
      dom.loading.classList.remove("has-cover");
    });
    dom.loadingCover.replaceChildren(image);
    dom.loadingCover.hidden = false;
    dom.loading.classList.add("has-cover");
  }

  setLoading("Opening edition", book.title, `Fetching the pages of ${book.author}'s edition.`, 20);
}

/* --------------------------------------------------------------------------
   PDF loading
   -------------------------------------------------------------------------- */

async function importPdfJs() {
  const module = await import(PDF_LIBRARY.href);
  module.GlobalWorkerOptions.workerSrc = PDF_WORKER.href;
  return module;
}

async function openPdf(url) {
  const loadingTask = pdfjs.getDocument({
    url,
    isEvalSupported: false,
    useSystemFonts: true,
  });
  state.loadingTask = loadingTask;

  loadingTask.onProgress = ({ loaded, total }) => {
    if (!total) {
      setLoadingProgress(38);
      return;
    }
    const ratio = loaded / total;
    setLoadingProgress(28 + ratio * 52);
    dom.loadingText.textContent = `Receiving the edition… ${Math.round(ratio * 100)}%`;
  };

  let timeoutId = null;
  const timeout = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => {
      const error = new Error("The edition took too long to load.");
      error.name = "LoadTimeoutError";
      reject(error);
    }, 45000);
  });

  try {
    const document = await Promise.race([loadingTask.promise, timeout]);
    window.clearTimeout(timeoutId);
    state.loadingTask = null;
    return document;
  } catch (error) {
    window.clearTimeout(timeoutId);
    try {
      await loadingTask.destroy();
    } catch {
      // The loading task may already be gone.
    }
    state.loadingTask = null;
    throw error;
  }
}

async function getPage(number) {
  if (!pageCache.has(number)) {
    pageCache.set(number, pdfDocument.getPage(number));
  }
  return pageCache.get(number);
}

function getOutputScale(width, height) {
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  return Math.max(0.4, Math.min(dpr, 1600 / width, 2400 / height));
}

async function drawPage(pageNumber, cssWidth, registerTask) {
  const page = await getPage(pageNumber);
  const scale = cssWidth / state.baseWidth;
  const viewport = page.getViewport({ scale });
  const outputScale = getOutputScale(viewport.width, viewport.height);

  const canvas = document.createElement("canvas");
  canvas.className = "page-canvas";
  canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
  canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.setAttribute("aria-hidden", "true");

  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("This browser could not prepare a canvas for the page.");

  context.fillStyle = "#f2e9d8";
  context.fillRect(0, 0, canvas.width, canvas.height);

  const renderTask = page.render({
    canvasContext: context,
    viewport,
    transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null,
  });
  registerTask?.(renderTask);
  await renderTask.promise;

  return { page, canvas, viewport, scale };
}

async function createTextLayer(page, viewport, scale) {
  try {
    const textContent = await page.getTextContent();
    const layer = document.createElement("div");
    layer.className = "textLayer";
    layer.style.setProperty("--scale-factor", String(scale));
    const textLayer = new pdfjs.TextLayer({
      textContentSource: textContent,
      container: layer,
      viewport,
    });
    await textLayer.render();
    return layer;
  } catch (error) {
    console.warn("The selectable text layer could not be prepared for this page.", error);
    return null;
  }
}

/* --------------------------------------------------------------------------
   Scroll mode
   -------------------------------------------------------------------------- */

function isSingleBookMode() {
  const width = dom.stage.clientWidth || window.innerWidth;
  return width < BOOK_SINGLE_BREAKPOINT;
}

function getSpreadForPage(page, total, single) {
  const target = clamp(Number(page) || 1, 1, Math.max(1, total));
  if (single) return [target];
  if (target <= 1) return [1];
  if (target % 2 === 0) {
    return target + 1 <= total ? [target, target + 1] : [target];
  }
  return [target - 1, target];
}

function getScrollPageWidth() {
  const horizontalPadding = 32;
  const available = Math.max(240, dom.stage.clientWidth - horizontalPadding);
  return Math.min(available, SCROLL_MAX_PAGE_WIDTH) * zoomFactor();
}

function buildScrollView() {
  destroyScrollWork();
  dom.scrollView.replaceChildren();

  const pageWidth = getScrollPageWidth();
  state.scroll.pageWidth = pageWidth;
  dom.scrollView.style.setProperty("--page-width", `${pageWidth}px`);
  dom.scrollView.style.setProperty(
    "--page-ratio",
    `${state.baseWidth} / ${state.baseHeight}`,
  );

  const fragment = document.createDocumentFragment();
  const placeholders = [];
  for (let number = 1; number <= state.total; number += 1) {
    const page = document.createElement("div");
    page.className = "scroll-page";
    page.dataset.page = String(number);
    page.setAttribute("role", "group");
    page.setAttribute("aria-label", `Page ${number} of ${state.total}`);
    placeholders.push(page);
    fragment.append(page);
  }
  dom.scrollView.append(fragment);
  state.scroll.placeholders = placeholders;
  state.scroll.offsets = placeholders.map((page) => page.offsetTop);

  scrollObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const number = Number(entry.target.dataset.page);
        if (entry.isIntersecting) {
          queueScrollPage(number);
        } else if (state.scroll.tasks.has(number) || entry.target.querySelector(".scroll-page__content")) {
          cleanupScrollPage(number);
        }
      }
    },
    { root: dom.stage, rootMargin: `${SCROLL_NEARBY_MARGIN}px 0px` },
  );

  for (const placeholder of placeholders) {
    scrollObserver.observe(placeholder);
  }
}

function destroyScrollWork() {
  state.scroll.generation += 1;
  if (scrollObserver) {
    scrollObserver.disconnect();
    scrollObserver = null;
  }
  for (const task of state.scroll.tasks.values()) {
    try {
      task.cancel();
    } catch {
      // The task may already have finished.
    }
  }
  state.scroll.tasks.clear();
  state.scroll.queue.clear();
  for (const placeholder of state.scroll.placeholders) {
    releasePageContent(placeholder);
    placeholder.classList.remove("is-rendered");
  }
  state.scroll.placeholders = [];
  state.scroll.offsets = [];
}

function releasePageContent(container) {
  const content = container.querySelector(".scroll-page__content, .book-page__content");
  if (!content) return;
  for (const canvas of content.querySelectorAll("canvas")) {
    canvas.width = 1;
    canvas.height = 1;
  }
  content.remove();
}

function cleanupScrollPage(number) {
  const placeholder = state.scroll.placeholders[number - 1];
  if (!placeholder) return;

  const task = state.scroll.tasks.get(number);
  if (task) {
    try {
      task.cancel();
    } catch {
      // Ignore late cancellations.
    }
    state.scroll.tasks.delete(number);
  }
  state.scroll.queue.delete(number);
  releasePageContent(placeholder);
  placeholder.classList.remove("is-rendered");
}

function isPageNear(number, margin = SCROLL_NEARBY_MARGIN + 200) {
  const placeholder = state.scroll.placeholders[number - 1];
  if (!placeholder) return false;
  const stageBounds = dom.stage.getBoundingClientRect();
  const pageBounds = placeholder.getBoundingClientRect();
  return pageBounds.bottom >= stageBounds.top - margin && pageBounds.top <= stageBounds.bottom + margin;
}

function queueScrollPage(number) {
  if (number < 1 || number > state.total) return;
  const placeholder = state.scroll.placeholders[number - 1];
  if (!placeholder || placeholder.querySelector(".scroll-page__content")) return;
  if (state.scroll.tasks.has(number) || state.scroll.queue.has(number)) return;
  state.scroll.queue.add(number);
  pumpScrollQueue();
}

async function pumpScrollQueue() {
  if (state.scroll.pumpRunning) return;
  state.scroll.pumpRunning = true;

  try {
    while (state.scroll.queue.size) {
      const nextNumber = Array.from(state.scroll.queue)
        .sort((a, b) => Math.abs(a - state.page) - Math.abs(b - state.page))
        .at(0);
      state.scroll.queue.delete(nextNumber);
      if (!isPageNear(nextNumber)) continue;
      await renderScrollPage(nextNumber);
    }
  } finally {
    state.scroll.pumpRunning = false;
    if (state.scroll.queue.size) pumpScrollQueue();
  }
}

async function renderScrollPage(number) {
  const placeholder = state.scroll.placeholders[number - 1];
  if (!placeholder || placeholder.querySelector(".scroll-page__content")) return;

  const generation = state.scroll.generation;
  const content = document.createElement("div");
  content.className = "scroll-page__content";
  placeholder.append(content);

  try {
    const cssWidth = placeholder.getBoundingClientRect().width;
    const { page, canvas, viewport, scale } = await drawPage(number, cssWidth, (task) => {
      state.scroll.tasks.set(number, task);
    });

    if (generation !== state.scroll.generation || !placeholder.isConnected) return;
    if (!isPageNear(number)) {
      canvas.width = 1;
      canvas.height = 1;
      content.remove();
      return;
    }

    content.append(canvas);
    placeholder.classList.add("is-rendered");

    const textLayer = await createTextLayer(page, viewport, scale);
    if (textLayer && generation === state.scroll.generation && content.isConnected) {
      content.append(textLayer);
    }
  } catch (error) {
    if (generation !== state.scroll.generation) return;
    if (error?.name === "RenderingCancelledException") return;
    console.error(`Page ${number} could not be drawn.`, error);
    if (placeholder.isConnected) {
      const message = document.createElement("p");
      message.className = "scroll-page__error";
      message.textContent = "This page could not be drawn.";
      content.replaceChildren(message);
      placeholder.classList.add("is-rendered");
    }
  } finally {
    const task = state.scroll.tasks.get(number);
    if (task) state.scroll.tasks.delete(number);
  }
}

function scrollOffsetsForPage() {
  return state.scroll.offsets;
}

function getVisibleScrollPage() {
  if (!state.scroll.offsets.length) return state.page;
  const probe = dom.stage.scrollTop + dom.stage.clientHeight * 0.36 - dom.scrollView.offsetTop;
  let page = 1;
  for (let index = 0; index < state.scroll.offsets.length; index += 1) {
    if (state.scroll.offsets[index] <= probe) page = index + 1;
    else break;
  }
  return page;
}

function scrollToPage(number) {
  const target = state.scroll.placeholders[number - 1];
  if (!target) return;
  dom.stage.scrollTo({
    top: Math.max(0, target.offsetTop - 12),
    left: dom.stage.scrollLeft,
    behavior: "auto",
  });
}

function updateScrollPosition() {
  if (!state.ready || state.mode !== "scroll" || !pdfDocument) return;
  const page = getVisibleScrollPage();
  if (page !== state.page) {
    state.page = page;
    updateChrome();
    queueScrollPage(page + 1);
    schedulePersist();
  }
}

function queueVisibleScrollPages() {
  for (let offset = 0; offset <= 2; offset += 1) {
    queueScrollPage(state.page + offset);
  }
}

/* --------------------------------------------------------------------------
   Book mode
   -------------------------------------------------------------------------- */

function getBookPageSize() {
  const single = isSingleBookMode();
  const style = getComputedStyle(dom.bookView);
  const paddingX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const paddingY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const availableWidth = Math.max(160, dom.stage.clientWidth - paddingX);
  const availableHeight = Math.max(160, dom.stage.clientHeight - paddingY);
  const gap = 2;
  const widthLimit = single ? availableWidth : (availableWidth - gap) / 2;
  const width = Math.min(widthLimit, availableHeight / state.pageRatio) * zoomFactor();
  return {
    single,
    width: Math.max(120, width),
    height: Math.max(120, width * state.pageRatio),
  };
}

function makeBookPageShell(number, width, height) {
  const page = document.createElement("div");
  page.className = "book-page";
  page.dataset.page = String(number);
  page.style.width = `${width}px`;
  page.style.height = `${height}px`;
  page.setAttribute("role", "group");
  page.setAttribute("aria-label", `Page ${number} of ${state.total}`);

  const content = document.createElement("div");
  content.className = "book-page__content";
  page.append(content);

  return page;
}

function cancelBookRender() {
  state.book.generation += 1;
  for (const task of state.book.tasks) {
    try {
      task.cancel();
    } catch {
      // Ignore tasks that already finished.
    }
  }
  state.book.tasks = [];
  window.clearTimeout(turnTimer);
  dom.turn.hidden = true;
}

async function buildBookPage(number, width, height, generation) {
  const pageElement = makeBookPageShell(number, width, height);
  const content = pageElement.querySelector(".book-page__content");

  try {
    const { page, canvas, viewport, scale } = await drawPage(number, width, (task) => {
      state.book.tasks.push(task);
    });
    if (generation !== state.book.generation) return pageElement;

    content.append(canvas);
    pageElement.classList.add("is-rendered");

    const textLayer = await createTextLayer(page, viewport, scale);
    if (textLayer && generation === state.book.generation) {
      content.append(textLayer);
    }
  } catch (error) {
    if (generation !== state.book.generation) return pageElement;
    if (error?.name !== "RenderingCancelledException") {
      console.error(`Page ${number} could not be drawn.`, error);
      const message = document.createElement("p");
      message.className = "book-page__error";
      message.textContent = "This page could not be drawn.";
      content.replaceChildren(message);
      pageElement.classList.add("is-rendered");
    }
  }
  return pageElement;
}

async function renderBookSpread(targetPage, { animate = false, direction = "next" } = {}) {
  if (!pdfDocument) return;

  const generation = ++state.book.generation;
  state.book.tasks = [];
  window.clearTimeout(turnTimer);
  dom.turn.hidden = true;

  const single = isSingleBookMode();
  const spread = getSpreadForPage(clampPage(targetPage), state.total, single);
  const { width, height } = getBookPageSize();
  state.currentSpread = spread;
  state.page = spread[0];
  updateChrome();

  const spreadElement = document.createElement("div");
  spreadElement.className = `book-spread${spread.length > 1 ? " book-spread--double" : ""}`;

  for (const number of spread) {
    const pageElement = await buildBookPage(number, width, height, generation);
    if (generation !== state.book.generation) return;
    spreadElement.append(pageElement);
  }

  if (generation !== state.book.generation) return;

  const oldChildren = Array.from(dom.bookSpread.childNodes);
  dom.bookSpread.replaceChildren(...Array.from(spreadElement.childNodes));
  dom.bookSpread.className = spreadElement.className;
  for (const old of oldChildren) {
    for (const canvas of old.querySelectorAll?.("canvas") || []) {
      canvas.width = 1;
      canvas.height = 1;
    }
  }

  updateChrome();
  schedulePersist();
  if (animate) playPageTurn(direction);
}

function playPageTurn(direction) {
  if (!settings.pageTurn || REDUCED_MOTION.matches) return;
  window.clearTimeout(turnTimer);
  dom.turn.hidden = true;
  dom.turn.className = "reader-turn";
  void dom.turn.offsetWidth;
  dom.turn.hidden = false;
  dom.turn.classList.add(direction === "previous" ? "reader-turn--previous" : "reader-turn--next");
  turnTimer = window.setTimeout(() => {
    dom.turn.hidden = true;
    dom.turn.className = "reader-turn";
  }, 520);
}

/* --------------------------------------------------------------------------
   Navigation and chrome
   -------------------------------------------------------------------------- */

function canGoPrevious() {
  if (!state.ready) return false;
  if (state.mode === "scroll") return state.page > 1;
  const spread = getSpreadForPage(state.page, state.total, isSingleBookMode());
  return spread[0] > 1;
}

function canGoNext() {
  if (!state.ready) return false;
  if (state.mode === "scroll") return state.page < state.total;
  const spread = getSpreadForPage(state.page, state.total, isSingleBookMode());
  return spread[spread.length - 1] < state.total;
}

function updateModeButtons() {
  for (const button of dom.modes) {
    const active = button.dataset.mode === state.mode;
    button.setAttribute("aria-pressed", String(active));
  }
}

function updateChrome() {
  if (!pdfDocument || !bookData) return;

  const total = state.total;
  const spread =
    state.mode === "book"
      ? getSpreadForPage(state.page, total, isSingleBookMode())
      : [state.page];
  const progressPage = state.mode === "book" ? spread[spread.length - 1] : state.page;
  const percent = clamp(Math.round((progressPage / total) * 100), 0, 100);

  dom.pageInput.value = String(state.page);
  dom.pageInput.max = String(total);
  dom.pageTotal.textContent = String(total);
  dom.progressFill.style.width = `${percent}%`;
  dom.progressBar.setAttribute("aria-valuenow", String(percent));
  dom.progressBar.setAttribute(
    "aria-valuetext",
    `${percent}% of ${total} pages read`,
  );

  updateModeButtons();

  const bookmarked = isBookmarked(bookData.id, state.page);
  dom.bookmarkButton.setAttribute("aria-pressed", String(bookmarked));
  dom.bookmarkButton.setAttribute(
    "aria-label",
    bookmarked ? `Remove bookmark from page ${state.page}` : `Bookmark page ${state.page}`,
  );
  setIcon(dom.bookmarkButton, bookmarked ? "bookmark-filled" : "bookmark");

  const bookmarks = getBookmarks(bookData.id);
  dom.bookmarkCount.textContent = String(bookmarks.length);
  dom.bookmarksButton.setAttribute(
    "aria-label",
    `${bookmarks.length} bookmark${bookmarks.length === 1 ? "" : "s"}. View bookmarks`,
  );

  const factor = zoomFactor();
  dom.zoomValue.textContent =
    state.zoom === "fit" ? "Fit" : `${Math.round(factor * 100)}%`;
  dom.zoomValue.setAttribute(
    "aria-label",
    state.zoom === "fit"
      ? "Zoom set to fit pages. Activate to keep fitting the window."
      : `Zoom ${Math.round(factor * 100)} percent. Activate to fit the window.`,
  );

  dom.prev.disabled = !canGoPrevious();
  dom.next.disabled = !canGoNext();

  if (state.mode === "book" && spread.length > 1) {
    dom.statusPages.textContent = `Pages ${spread[0]}–${spread[spread.length - 1]} of ${total} · ${percent}% read`;
  } else {
    dom.statusPages.textContent = `Page ${state.page} of ${total} · ${percent}% read`;
  }
}

function jumpToPage(value, { focusStage = false } = {}) {
  if (!state.ready) return;
  const target = clampPage(value);
  state.page = target;
  dom.turn.hidden = true;

  if (state.mode === "scroll") {
    scrollToPage(target);
    queueScrollPage(target);
    queueScrollPage(target + 1);
    updateChrome();
  } else {
    renderBookSpread(target, { animate: false });
  }

  schedulePersist();
  if (focusStage) dom.main.focus({ preventScroll: true });
}

function goPrevious() {
  if (!state.ready) return;
  if (state.mode === "scroll") {
    if (state.page > 1) jumpToPage(state.page - 1);
    return;
  }
  const spread = getSpreadForPage(state.page, state.total, isSingleBookMode());
  if (spread[0] > 1) {
    renderBookSpread(spread[0] - 1, { animate: true, direction: "previous" });
  }
}

function goNext() {
  if (!state.ready) return;
  if (state.mode === "scroll") {
    if (state.page < state.total) jumpToPage(state.page + 1);
    return;
  }
  const spread = getSpreadForPage(state.page, state.total, isSingleBookMode());
  if (spread[spread.length - 1] < state.total) {
    renderBookSpread(spread[spread.length - 1] + 1, { animate: true, direction: "next" });
  }
}

async function setMode(mode) {
  if (!state.ready || !pdfDocument || mode === state.mode) return;
  const page =
    state.mode === "scroll" ? getVisibleScrollPage() : state.page;

  state.mode = mode;
  saveSettings({ mode });
  updateModeButtons();

  if (mode === "scroll") {
    cancelBookRender();
    dom.bookView.hidden = true;
    dom.scrollView.hidden = false;
    buildScrollView();
    scrollToPage(page);
    updateChrome();
    queueVisibleScrollPages();
    schedulePersist();
    return;
  }

  destroyScrollWork();
  dom.scrollView.hidden = true;
  dom.bookView.hidden = false;
  state.page = page;
  dom.stage.scrollTo({ top: 0, left: 0 });
  await renderBookSpread(page, { animate: false });
  schedulePersist();
}

function activateInitialMode(startPage) {
  if (state.mode === "scroll") {
    dom.bookView.hidden = true;
    dom.scrollView.hidden = false;
    buildScrollView();
    scrollToPage(startPage);
    state.page = startPage;
    updateChrome();
    queueVisibleScrollPages();
  } else {
    dom.scrollView.hidden = true;
    dom.bookView.hidden = false;
    renderBookSpread(startPage, { animate: false });
  }
}

/* --------------------------------------------------------------------------
   Zoom
   -------------------------------------------------------------------------- */

function setZoom(nextZoom) {
  if (!pdfDocument) return;
  const page = state.mode === "scroll" ? getVisibleScrollPage() : state.page;
  state.zoom = nextZoom;
  settings = updateSettings({ zoom: nextZoom });
  updateChrome();

  if (state.mode === "scroll") {
    buildScrollView();
    scrollToPage(page);
    state.page = page;
    updateChrome();
    queueVisibleScrollPages();
  } else {
    renderBookSpread(page, { animate: false });
  }
  schedulePersist();
}

function zoomIn() {
  const current = zoomFactor();
  setZoom(Math.min(MAX_ZOOM, Math.round((current + ZOOM_STEP) * 100) / 100));
}

function zoomOut() {
  const current = zoomFactor();
  setZoom(Math.max(MIN_ZOOM, Math.round((current - ZOOM_STEP) * 100) / 100));
}

function fitPages() {
  setZoom("fit");
}

/* --------------------------------------------------------------------------
   Bookmarks
   -------------------------------------------------------------------------- */

function formatBookmarkDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

function renderBookmarkList() {
  dom.bookmarkList.replaceChildren();

  if (!bookData) {
    return;
  }

  const bookmarks = getBookmarks(bookData.id);
  if (!bookmarks.length) {
    const empty = document.createElement("div");
    empty.className = "bookmark-empty";
    empty.innerHTML = `
      ${icon("bookmark", "")}
      <p>No bookmarks yet. While you read, use the ribbon button or press <kbd>B</kbd> to keep a page.</p>`;
    dom.bookmarkList.append(empty);
    return;
  }

  for (const bookmark of bookmarks) {
    const item = document.createElement("div");
    item.className = "bookmark-item";

    const jump = document.createElement("button");
    jump.type = "button";
    jump.className = "bookmark-item__jump";
    jump.dataset.bookmarkJump = String(bookmark.page);
    const pageLabel = document.createElement("span");
    pageLabel.className = "bookmark-item__page";
    pageLabel.textContent = `Page ${bookmark.page}`;
    const dateLabel = document.createElement("span");
    dateLabel.className = "bookmark-item__date";
    dateLabel.textContent = bookmark.createdAt ? formatBookmarkDate(bookmark.createdAt) : "";
    jump.append(pageLabel, dateLabel);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "bookmark-item__remove";
    remove.dataset.bookmarkRemove = String(bookmark.page);
    remove.setAttribute("aria-label", `Remove bookmark on page ${bookmark.page}`);
    remove.innerHTML = icon("trash", "");
    item.append(jump, remove);
    dom.bookmarkList.append(item);
  }
}

function toggleCurrentBookmark() {
  if (!state.ready || !bookData) return;
  const page = state.page;
  const result = toggleBookmark(bookData.id, page, `Page ${page}`);
  updateChrome();
  if (dom.bookmarksDialog.open) renderBookmarkList();
  showToast(
    result.bookmarked
      ? `Bookmark kept on page ${page}.`
      : `Bookmark removed from page ${page}.`,
  );
}

/* --------------------------------------------------------------------------
   Focus, fullscreen, dialogs
   -------------------------------------------------------------------------- */

function toggleFocusMode(force) {
  const next =
    typeof force === "boolean" ? force : !dom.body.classList.contains("focus-mode");
  if (next === dom.body.classList.contains("focus-mode")) return;

  dom.body.classList.toggle("focus-mode", next);
  dom.focusButton.setAttribute("aria-pressed", String(next));
  dom.focusButton.setAttribute("aria-label", next ? "Leave focus mode" : "Enter focus mode");
  dom.focusButton.title = next ? "Leave focus mode (F)" : "Focus mode (F)";

  if (next) {
    window.requestAnimationFrame(() => dom.focusExit.focus());
    showToast("Focus mode. Press Esc or F to bring the controls back.");
  } else {
    dom.focusButton.focus();
  }
}

function updateFullscreenButton() {
  const fullscreen = Boolean(document.fullscreenElement);
  dom.fullscreenButton.setAttribute(
    "aria-label",
    fullscreen ? "Exit fullscreen" : "Enter fullscreen",
  );
  dom.fullscreenButton.title = fullscreen ? "Exit fullscreen (Shift+F)" : "Fullscreen (Shift+F)";
  setIcon(dom.fullscreenButton, fullscreen ? "collapse" : "expand");
}

async function toggleFullscreen() {
  try {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen();
    } else {
      await document.exitFullscreen();
    }
  } catch {
    showToast("Fullscreen is not available in this browser.");
  }
}

const dialogByName = {
  display: () => dom.displayDialog,
  shortcuts: () => dom.shortcutsDialog,
  bookmarks: () => dom.bookmarksDialog,
};

function openDialog(name) {
  const dialog = dialogByName[name]?.();
  if (!dialog) return;
  if (name === "bookmarks") {
    if (!state.ready) return;
    renderBookmarkList();
  }
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
  } else {
    dialog.setAttribute("open", "");
  }
}

function closeDialog(dialog) {
  if (dialog?.open && typeof dialog.close === "function") dialog.close();
  else dialog?.removeAttribute("open");
}

/* --------------------------------------------------------------------------
   Progress persistence
   -------------------------------------------------------------------------- */

function persistProgress() {
  if (!state.ready || !bookData || !pdfDocument) return;
  const page = state.mode === "scroll" ? getVisibleScrollPage() : state.page;
  state.page = page;
  setProgress(bookData.id, page, state.total);
}

function schedulePersist() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(persistProgress, 650);
}

/* --------------------------------------------------------------------------
   Layout changes
   -------------------------------------------------------------------------- */

function handleRelayout() {
  if (!state.ready || !pdfDocument) return;
  const page = state.mode === "scroll" ? getVisibleScrollPage() : state.page;
  if (state.mode === "scroll") {
    buildScrollView();
    scrollToPage(page);
    state.page = page;
    updateChrome();
    queueVisibleScrollPages();
  } else {
    renderBookSpread(page, { animate: false });
  }
}

function scheduleRelayout() {
  if (!state.ready) return;
  const width = dom.stage.clientWidth;
  const height = dom.stage.clientHeight;
  if (
    Math.abs(width - state.lastSize.width) < 6 &&
    Math.abs(height - state.lastSize.height) < 6
  ) {
    return;
  }
  state.lastSize = { width, height };
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(handleRelayout, 180);
}

/* --------------------------------------------------------------------------
   Reading music
   -------------------------------------------------------------------------- */

function formatClock(value) {
  const total = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function setMusicPanel(open) {
  if (!dom.musicPanel || !dom.musicButton) return;
  dom.musicPanel.hidden = !open;
  dom.musicButton.setAttribute("aria-expanded", String(open));
  if (open) dom.musicToggle?.focus({ preventScroll: true });
}

function updateMusicButton() {
  if (!dom.audio || !dom.musicToggle) return;
  const playing = !dom.audio.paused && !dom.audio.ended;
  setIcon(dom.musicToggle, playing ? "pause" : "play");
  dom.musicToggle.setAttribute("aria-pressed", String(playing));
  dom.musicToggle.setAttribute("aria-label", playing ? "Pause music" : "Play music");
  dom.musicButton?.classList.toggle("is-playing", playing);
}

function applyMusicVolume(value, { persist = false } = {}) {
  if (!dom.audio || !dom.musicVolume) return;
  const numeric = Number(value);
  const volume = Number.isFinite(numeric) ? clamp(numeric, 0, 1) : 0.55;
  dom.audio.volume = volume;
  dom.musicVolume.value = String(volume);
  if (dom.musicVolumeValue) dom.musicVolumeValue.textContent = `${Math.round(volume * 100)}%`;
  if (persist) settings = updateSettings({ musicVolume: volume });
}

async function toggleMusicPlayback() {
  if (!dom.audio) return;
  try {
    if (dom.audio.paused) await dom.audio.play();
    else dom.audio.pause();
  } catch {
    showToast("The music could not start. Check that the audio file is present.");
  }
}

function setupMusic() {
  if (!dom.audio || !dom.musicPanel || !dom.musicButton) return;

  applyMusicVolume(settings.musicVolume);

  dom.musicButton.addEventListener("click", () => {
    setMusicPanel(dom.musicPanel.hidden);
  });

  dom.musicToggle?.addEventListener("click", toggleMusicPlayback);

  dom.audio.addEventListener("play", updateMusicButton);
  dom.audio.addEventListener("pause", updateMusicButton);
  dom.audio.addEventListener("ended", updateMusicButton);

  const syncDuration = () => {
    const duration = dom.audio.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    if (dom.musicSeek) {
      dom.musicSeek.max = String(duration);
      dom.musicSeek.disabled = false;
    }
    if (dom.musicDuration) dom.musicDuration.textContent = formatClock(duration);
  };
  dom.audio.addEventListener("loadedmetadata", syncDuration);
  dom.audio.addEventListener("durationchange", syncDuration);

  let seeking = false;
  dom.musicSeek?.addEventListener("input", () => {
    seeking = true;
    if (dom.musicCurrent) dom.musicCurrent.textContent = formatClock(dom.musicSeek.value);
  });
  dom.musicSeek?.addEventListener("change", () => {
    if (Number.isFinite(dom.audio.duration)) {
      dom.audio.currentTime = clamp(Number(dom.musicSeek.value), 0, dom.audio.duration);
    }
    seeking = false;
  });
  dom.audio.addEventListener("timeupdate", () => {
    if (seeking) return;
    if (dom.musicSeek) dom.musicSeek.value = String(dom.audio.currentTime);
    if (dom.musicCurrent) dom.musicCurrent.textContent = formatClock(dom.audio.currentTime);
  });

  dom.musicVolume?.addEventListener("input", () => {
    applyMusicVolume(dom.musicVolume.value);
  });
  dom.musicVolume?.addEventListener("change", () => {
    applyMusicVolume(dom.musicVolume.value, { persist: true });
  });

  document.addEventListener("click", (event) => {
    if (dom.musicPanel.hidden) return;
    if (event.target.closest("#reader-music") || event.target.closest('[data-action="music"]')) return;
    setMusicPanel(false);
  });

  updateMusicButton();
}

/* --------------------------------------------------------------------------
   Events
   -------------------------------------------------------------------------- */

function setupEvents() {
  for (const modeButton of dom.modes) {
    modeButton.addEventListener("click", () => setMode(modeButton.dataset.mode));
  }

  dom.prev.addEventListener("click", goPrevious);
  dom.next.addEventListener("click", goNext);
  dom.bookmarkButton.addEventListener("click", toggleCurrentBookmark);
  dom.zoomIn.addEventListener("click", zoomIn);
  dom.zoomOut.addEventListener("click", zoomOut);
  dom.zoomFit.addEventListener("click", fitPages);
  dom.fullscreenButton.addEventListener("click", toggleFullscreen);

  dom.pageForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = Number.parseInt(dom.pageInput.value, 10);
    if (!Number.isFinite(value)) {
      dom.pageInput.value = String(state.page);
      return;
    }
    jumpToPage(value);
  });

  dom.pageInput.addEventListener("focus", () => dom.pageInput.select());
  dom.pageInput.addEventListener("blur", () => {
    dom.pageInput.value = String(state.page);
  });

  dom.stage.addEventListener(
    "scroll",
    () => {
      if (scrollFrame) return;
      scrollFrame = window.requestAnimationFrame(() => {
        scrollFrame = null;
        updateScrollPosition();
      });
    },
    { passive: true },
  );

  for (const button of document.querySelectorAll("[data-action='focus']")) {
    button.addEventListener("click", () => toggleFocusMode());
  }

  for (const button of document.querySelectorAll("[data-open-dialog]")) {
    button.addEventListener("click", () => openDialog(button.dataset.openDialog));
  }

  for (const dialog of document.querySelectorAll(".reader-dialog")) {
    dialog.addEventListener("click", (event) => {
      if (event.target.closest("[data-close-dialog]")) {
        closeDialog(dialog);
        return;
      }
      if (event.target === dialog) closeDialog(dialog);
    });
  }

  dom.bookmarksDialog.addEventListener("click", (event) => {
    const jump = event.target.closest("[data-bookmark-jump]");
    if (jump) {
      const page = Number(jump.dataset.bookmarkJump);
      closeDialog(dom.bookmarksDialog);
      jumpToPage(page, { focusStage: true });
      return;
    }

    const remove = event.target.closest("[data-bookmark-remove]");
    if (remove && bookData) {
      const page = Number(remove.dataset.bookmarkRemove);
      removeBookmark(bookData.id, page);
      renderBookmarkList();
      updateChrome();
      showToast(`Bookmark removed from page ${page}.`);
      dom.bookmarksDialog.querySelector(".reader-dialog__close")?.focus();
    }
  });

  for (const radio of dom.themeRadios) {
    radio.addEventListener("change", () => {
      if (radio.checked) saveSettings({ theme: radio.value });
    });
  }

  dom.invertCheckbox.addEventListener("change", () => {
    saveSettings({ invertPages: dom.invertCheckbox.checked });
  });

  dom.pageTurnCheckbox.addEventListener("change", () => {
    saveSettings({ pageTurn: dom.pageTurnCheckbox.checked });
  });

  dom.retry.addEventListener("click", () => window.location.reload());

  document.addEventListener("fullscreenchange", updateFullscreenButton);

  REDUCED_MOTION.addEventListener("change", updateReducedMotionNote);

  const resizeObserver = new ResizeObserver(scheduleRelayout);
  resizeObserver.observe(dom.stage);

  window.addEventListener("pagehide", () => {
    window.clearTimeout(saveTimer);
    persistProgress();
  });

  window.addEventListener("beforeunload", () => {
    persistProgress();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      window.clearTimeout(saveTimer);
      persistProgress();
    }
  });

  document.addEventListener("keydown", handleKeydown);
}

function handleKeydown(event) {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;

  if (event.key === "Escape") {
    if (hasOpenDialog()) return;
    if (isTypingTarget(event.target)) {
      event.target.blur();
      return;
    }
    if (dom.body.classList.contains("focus-mode")) {
      event.preventDefault();
      toggleFocusMode(false);
      return;
    }
    if (!dom.musicPanel.hidden) {
      event.preventDefault();
      setMusicPanel(false);
      dom.musicButton?.focus({ preventScroll: true });
    }
    return;
  }

  if (hasOpenDialog() || isTypingTarget(event.target)) return;

  if (event.code === "Space" && event.target instanceof HTMLElement) {
    if (event.target.closest("button, a")) return;
  }

  if (!state.ready) return;

  let handled = true;
  switch (event.key) {
    case "ArrowRight":
    case "PageDown":
    case " ":
      if (event.shiftKey && event.key === " ") goPrevious();
      else goNext();
      break;
    case "ArrowLeft":
    case "PageUp":
      goPrevious();
      break;
    case "Home":
      jumpToPage(1);
      break;
    case "End":
      jumpToPage(state.total);
      break;
    case "b":
    case "B":
      toggleCurrentBookmark();
      break;
    case "l":
    case "L":
      openDialog("bookmarks");
      break;
    case "m":
    case "M":
      setMode(state.mode === "scroll" ? "book" : "scroll");
      break;
    case "p":
    case "P":
      toggleMusicPlayback();
      break;
    case "d":
    case "D":
      openDialog("display");
      break;
    case "f":
    case "F":
      if (event.shiftKey) toggleFullscreen();
      else toggleFocusMode();
      break;
    case "+":
    case "=":
      zoomIn();
      break;
    case "-":
    case "_":
      zoomOut();
      break;
    case "0":
      fitPages();
      break;
    case "?":
      openDialog("shortcuts");
      break;
    default:
      handled = false;
  }

  if (handled) event.preventDefault();
}

/* --------------------------------------------------------------------------
   Boot
   -------------------------------------------------------------------------- */

function catalogueFailure(error) {
  const isFile = error?.code === "file-protocol";
  showError({
    eyebrow: "Reading room closed",
    title: "The catalogue could not be opened.",
    message:
      "The reader needs the library catalogue before it can find an edition.",
    hint: isFile
      ? "Open the site through a local web server rather than a file:// page. From the project folder, run python3 -m http.server 8000, then visit http://localhost:8000."
      : "If you are working locally, serve the folder over HTTP. Check that data/catalogue.json exists and is valid JSON.",
    retry: true,
  });
  console.error("Catalogue error:", error);
}

function pdfFailure(error) {
  console.error("PDF error:", error);
  const name = error?.name || "";
  let title = "The edition could not be opened.";
  let message = "The PDF pages could not be prepared in this browser.";
  let hint =
    "Check that the edition file is present and that assets/vendor/pdfjs/pdf.worker.js can be reached. Serving the site over HTTP usually resolves local loading problems.";

  if (name === "MissingPDFException" || name === "UnexpectedResponseException") {
    const file = bookData?.file || "the catalogue path";
    title = "This book has not been added yet.";
    message = `The catalogue points to ${file}, but the file could not be found.`;
    hint = `Place the PDF at ${file} inside the project folder, then reload. The filename must match the path in data/catalogue.json.`;
  } else if (name === "InvalidPDFException") {
    title = "The book file is not a readable PDF.";
    message = `${bookData?.file || "The file"} may be incomplete or damaged.`;
    hint = "Replace it with a complete PDF, then try again.";
  } else if (name === "LoadTimeoutError") {
    title = "The book is taking too long to arrive.";
    message = "The connection may have stalled. Try opening the volume again.";
  } else if (error instanceof TypeError || /import|fetch|module/i.test(error?.message || "")) {
    title = "The PDF renderer could not be started.";
    message = "The local PDF.js files may be missing or blocked.";
  }

  showError({
    eyebrow: "Reading room closed",
    title,
    message,
    hint,
    retry: true,
  });
}

async function boot() {
  setControlsEnabled(false);
  applyDisplaySettings();
  updateFullscreenButton();
  setupEvents();

  if (!requestedBookId) {
    showError({
      eyebrow: "The reading room",
      title: "No volume has been chosen.",
      message:
        "Choose a novel from the collection to open it here. The seven volumes are read in order, but any volume can be opened directly.",
      hint: "Open a book's details and choose Start reading.",
      retry: false,
    });
    return;
  }

  dom.main.setAttribute("aria-busy", "true");
  setLoading("Opening the library", "Finding your place…", "Fetching the catalogue.", 8);

  let catalogue;
  try {
    catalogue = await loadCatalogue();
  } catch (error) {
    catalogueFailure(error);
    return;
  }

  const book = getBookById(catalogue, requestedBookId);
  if (!book) {
    showError({
      eyebrow: "The reading room",
      title: "That volume is not on the shelf.",
      message: "There is no edition in the catalogue with this address.",
      hint: "Return to the collection and choose a volume from the shelf.",
      retry: false,
    });
    return;
  }

  setBookChrome(book);
  setLoadingProgress(16);

  try {
    setLoading("Opening the edition", book.title, "Unpacking the reading room…", 24);
    pdfjs = await importPdfJs();
  } catch (error) {
    pdfFailure(error);
    return;
  }

  let loadedDocument;
  try {
    setLoading("Opening the edition", book.title, "Fetching the pages…", 28);
    const pdfUrl = new URL(book.file, document.baseURI).href;
    loadedDocument = await openPdf(pdfUrl);
  } catch (error) {
    pdfFailure(error);
    return;
  }

  pdfDocument = loadedDocument;
  pageCache = new Map();
  state.total = pdfDocument.numPages;

  if (!state.total) {
    showError({
      eyebrow: "Reading room closed",
      title: "This edition has no pages.",
      message: "The PDF opened, but it does not contain a readable page.",
      hint: "Try another volume from the collection.",
      retry: false,
    });
    return;
  }

  try {
    const firstPage = await getPage(1);
    const firstViewport = firstPage.getViewport({ scale: 1 });
    state.baseWidth = firstViewport.width;
    state.baseHeight = firstViewport.height;
    state.pageRatio = firstViewport.height / firstViewport.width;
  } catch (error) {
    pdfFailure(error);
    return;
  }

  const saved = getProgress(book.id);
  const startPage = saved ? clampPage(saved.page) : 1;
  state.savedPage = saved?.page || null;
  state.page = startPage;
  state.mode = settings.mode === "book" ? "book" : "scroll";
  state.ready = true;

  setLastBook(book.id);
  dom.loading.hidden = true;
  dom.stage.hidden = false;
  dom.error.hidden = true;
  setControlsEnabled(true);
  updateModeButtons();
  setLoadingProgress(100);
  dom.main.setAttribute("aria-busy", "false");
  state.lastSize = {
    width: dom.stage.clientWidth,
    height: dom.stage.clientHeight,
  };

  activateInitialMode(startPage);
  persistProgress();

  if (state.savedPage && state.savedPage > 1) {
    window.setTimeout(() => {
      showToast(`Returned to page ${state.page}.`);
    }, 450);
  }
}

setupMusic();
boot();
