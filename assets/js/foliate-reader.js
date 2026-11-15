/**
 * AVADRA — Foliate Reader controller.
 *
 * The reading engine is Foliate-JS (vendored under assets/vendor/foliate).
 * This module supplies the AVADRA shell around it:
 *
 *   - resolve `?book=<id>` against data/catalogue.json
 *   - open exactly one edition, lazily (Foliate loads PDF.js/EPUB modules on
 *     demand and fetches only the selected file)
 *   - restore and save the shared AVADRA reading position
 *   - table of contents, EPUB search, PDF zoom, themes, fullscreen, keyboard
 *   - persistent, reader-only appearance settings
 *
 * Shared progress lives in storage.js. PDFs use a page number so the DearFlip
 * flipbook and this reader continue from the same place. Reflowable EPUBs use
 * a CFI plus a normalised fraction.
 */

import {
  View,
  ResponseError,
  NotFoundError,
  UnsupportedTypeError,
} from "../vendor/foliate/view.js";
import { createTOCView } from "../vendor/foliate/ui/tree.js";
import { Overlayer } from "../vendor/foliate/overlayer.js";
import { loadCatalogue } from "./catalogue.js";
import { getProgressFresh, refreshStorage, saveProgress } from "./storage.js";

const SETTINGS_KEY = "avadra-foliate:v1";

const THEMES = ["book", "paper", "sepia", "night"];
const FONTS = ["publisher", "literata", "serif", "sans"];
const MARGIN_VALUES = { narrow: "24px", standard: "48px", wide: "88px" };
const LAYOUTS = ["paginated", "scrolled"];
const ZOOMS = ["fit-page", "fit-width", "1", "1.25", "1.5", "2"];

const DEFAULT_SETTINGS = Object.freeze({
  theme: "book",
  font: "publisher",
  fontSize: 100,
  spacing: 1.4,
  margins: "standard",
  layout: "paginated",
  zoom: "fit-page",
  justify: true,
  hyphenate: true,
});

const SAVE_DELAY = 240;
const SUPPORTED_CATALOGUE_FORMATS = new Set(["pdf", "epub"]);

const $ = (selector) => document.querySelector(selector);

const dom = {
  stage: $("#reader-stage"),
  viewContainer: $("#view-container"),
  bookTitle: $("#book-title"),

  sideBar: $("#side-bar"),
  sideBarButton: $("#side-bar-button"),
  dimming: $("#dimming-overlay"),
  cover: $("#side-bar-cover"),
  sideBarTitle: $("#side-bar-title"),
  sideBarAuthor: $("#side-bar-author"),
  tocTab: $("#toc-tab"),
  searchTab: $("#search-tab"),
  tocPanel: $("#toc-panel"),
  searchPanel: $("#search-panel"),
  tocView: $("#toc-view"),
  tocEmpty: $("#toc-empty"),

  searchButton: $("#search-button"),
  searchForm: $("#search-form"),
  searchInput: $("#search-input"),
  searchWhole: $("#search-whole"),
  searchSubmit: $(".search-submit"),
  searchStatus: $("#search-status"),
  searchResults: $("#search-results"),

  headerBar: $("#header-bar"),
  navBar: $("#nav-bar"),
  fullscreenButton: $("#fullscreen-button"),
  slider: $("#progress-slider"),
  locationLabel: $("#location-label"),
  leftButton: $("#left-button"),
  rightButton: $("#right-button"),

  settingsButton: $("#settings-button"),
  settingsPanel: $("#settings-panel"),
  settingTheme: $("#setting-theme"),
  settingFont: $("#setting-font"),
  settingFontSize: $("#setting-fontsize"),
  settingFontSizeValue: $("#setting-fontsize-value"),
  settingSpacing: $("#setting-spacing"),
  settingSpacingValue: $("#setting-spacing-value"),
  settingMargins: $("#setting-margins"),
  settingLayout: $("#setting-layout"),
  settingZoom: $("#setting-zoom"),
  settingJustify: $("#setting-justify"),
  settingHyphenate: $("#setting-hyphenate"),
  settingsNote: $("#settings-note"),
  settingsReset: $("#settings-reset"),

  loading: $("#loading"),
  loadingMessage: $("#loading-message"),
  loadingHint: $(".loading-hint"),
  errorPanel: $("#error-panel"),
  errorTitle: $("#error-title"),
  errorText: $("#error-text"),
  retryButton: $("#retry-button"),
  flipbookFallback: $("#flipbook-fallback"),
  emptyState: $("#empty-state"),
  fileButton: $("#file-button"),
  fileInput: $("#file-input"),
};

/* --------------------------------------------------------------------------
   Small utilities
   -------------------------------------------------------------------------- */

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function cleanString(value, max = 240) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function validBookId(value) {
  const id = cleanString(value, 120).toLowerCase();
  return /^[a-z0-9][a-z0-9-]*$/.test(id) ? id : "";
}

function truncate(value, max = 44) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatLanguageMap(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = formatLanguageMap(item);
      if (text) return text;
    }
    return "";
  }
  if (typeof value === "object") {
    for (const key of Object.keys(value)) {
      const text = formatLanguageMap(value[key]);
      if (text) return text;
    }
  }
  return "";
}

function formatOneContributor(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    return formatLanguageMap(value.name) || formatLanguageMap(value);
  }
  return "";
}

function formatContributor(value) {
  if (!value) return "";
  if (Array.isArray(value)) {
    const list = value.map(formatOneContributor).filter(Boolean);
    if (!list.length) return "";
    if (list.length === 1) return list[0];
    return `${list.slice(0, -1).join(", ")} & ${list[list.length - 1]}`;
  }
  return formatOneContributor(value);
}

function detectCatalogueFormat(record) {
  if (record?.format === "pdf" || record?.format === "epub") return record.format;
  const path = cleanString(record?.file, 500).split(/[?#]/)[0].toLowerCase();
  if (path.endsWith(".pdf")) return "pdf";
  if (path.endsWith(".epub")) return "epub";
  return "";
}

function detectLocalFormat(file) {
  const name = cleanString(file?.name, 300).toLowerCase();
  if (name.endsWith(".pdf")) return "pdf";
  if (name.endsWith(".epub")) return "epub";
  return "other";
}

function isPdfKind(kind) {
  return kind === "pdf";
}

function pageLabel(page, total) {
  return `Page ${page} of ${total}`;
}

/* --------------------------------------------------------------------------
   Reader-only appearance settings
   -------------------------------------------------------------------------- */

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normaliseSettings(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    theme: THEMES.includes(source.theme) ? source.theme : DEFAULT_SETTINGS.theme,
    font: FONTS.includes(source.font) ? source.font : DEFAULT_SETTINGS.font,
    fontSize: Math.round(
      clampNumber(source.fontSize, 80, 160, DEFAULT_SETTINGS.fontSize) / 10,
    ) * 10,
    spacing: Math.round(
      clampNumber(source.spacing, 1.1, 2, DEFAULT_SETTINGS.spacing) * 100,
    ) / 100,
    margins: Object.hasOwn(MARGIN_VALUES, source.margins)
      ? source.margins
      : DEFAULT_SETTINGS.margins,
    layout: LAYOUTS.includes(source.layout) ? source.layout : DEFAULT_SETTINGS.layout,
    zoom: ZOOMS.includes(source.zoom) ? source.zoom : DEFAULT_SETTINGS.zoom,
    justify:
      typeof source.justify === "boolean" ? source.justify : DEFAULT_SETTINGS.justify,
    hyphenate:
      typeof source.hyphenate === "boolean"
        ? source.hyphenate
        : DEFAULT_SETTINGS.hyphenate,
  };
}

function readSettings() {
  try {
    const stored = window.localStorage.getItem(SETTINGS_KEY);
    return normaliseSettings(stored ? JSON.parse(stored) : null);
  } catch (error) {
    console.warn("AVADRA could not read the Foliate settings.", error);
    return { ...DEFAULT_SETTINGS };
  }
}

let settings = readSettings();
let settingsSaveTimer = 0;
let settingsFrame = 0;

function writeSettings() {
  window.clearTimeout(settingsSaveTimer);
  settingsSaveTimer = 0;
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (error) {
    console.warn("AVADRA could not save the Foliate settings.", error);
  }
}

function scheduleWriteSettings() {
  window.clearTimeout(settingsSaveTimer);
  settingsSaveTimer = window.setTimeout(writeSettings, 280);
}

function syncSettingsControls() {
  dom.settingTheme.value = settings.theme;
  dom.settingFont.value = settings.font;
  dom.settingFontSize.value = String(settings.fontSize);
  dom.settingFontSizeValue.textContent = `${settings.fontSize}%`;
  dom.settingSpacing.value = String(settings.spacing);
  dom.settingSpacingValue.textContent = String(settings.spacing);
  dom.settingMargins.value = settings.margins;
  dom.settingLayout.value = settings.layout;
  dom.settingZoom.value = settings.zoom;
  dom.settingJustify.checked = settings.justify;
  dom.settingHyphenate.checked = settings.hyphenate;
}

function readSettingsControls() {
  settings = normaliseSettings({
    theme: dom.settingTheme.value,
    font: dom.settingFont.value,
    fontSize: dom.settingFontSize.value,
    spacing: dom.settingSpacing.value,
    margins: dom.settingMargins.value,
    layout: dom.settingLayout.value,
    zoom: dom.settingZoom.value,
    justify: dom.settingJustify.checked,
    hyphenate: dom.settingHyphenate.checked,
  });
  dom.settingFontSizeValue.textContent = `${settings.fontSize}%`;
  dom.settingSpacingValue.textContent = String(settings.spacing);
}

/* --------------------------------------------------------------------------
   Theme and EPUB stylesheet
   -------------------------------------------------------------------------- */

function applyChromeTheme() {
  document.body.dataset.readerTheme = settings.theme;
}

const THEME_COLOURS = {
  book: { background: "", ink: "", link: "", line: "" },
  paper: { background: "#f4efe5", ink: "#252019", link: "#8d6d3c", line: "#d8b98a" },
  sepia: { background: "#f4e8ce", ink: "#3a2f22", link: "#7a5a2a", line: "#cdb489" },
  night: { background: "#0a1118", ink: "#e7ddcc", link: "#e1c78e", line: "#43515a" },
};

function fontFamilyRule() {
  switch (settings.font) {
    case "literata": {
      const normal = new URL("../fonts/literata-normal.woff2", import.meta.url).href;
      const italic = new URL("../fonts/literata-italic.woff2", import.meta.url).href;
      return `
        @font-face {
          font-family: "AVADRA Literata";
          src: url("${normal}") format("woff2");
          font-style: normal;
          font-weight: 400 500;
          font-display: swap;
        }
        @font-face {
          font-family: "AVADRA Literata";
          src: url("${italic}") format("woff2");
          font-style: italic;
          font-weight: 400 500;
          font-display: swap;
        }
        body, p, li, blockquote, dd, dt, h1, h2, h3, h4, h5, h6 {
          font-family: "AVADRA Literata", Georgia, serif !important;
        }`;
    }
    case "serif":
      return `
        body, p, li, blockquote, dd, dt, h1, h2, h3, h4, h5, h6 {
          font-family: Georgia, "Iowan Old Style", "Palatino Linotype", serif !important;
        }`;
    case "sans":
      return `
        body, p, li, blockquote, dd, dt, h1, h2, h3, h4, h5, h6 {
          font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif !important;
        }`;
    case "publisher":
    default:
      return "";
  }
}

function buildEpubStyles() {
  const theme = THEME_COLOURS[settings.theme] || THEME_COLOURS.book;
  const dark = settings.theme === "night";
  const parts = [
    `@namespace epub "http://www.idpf.org/2007/ops";`,
    `html { color-scheme: ${dark ? "dark" : "light"}; }`,
  ];

  if (theme.background) {
    parts.push(`
      html, body {
        background: ${theme.background} !important;
        color: ${theme.ink} !important;
      }
      body *:not(img):not(svg):not(image):not(video):not(canvas) {
        color: ${theme.ink} !important;
        background-color: transparent !important;
        border-color: ${theme.line} !important;
      }
      a, a * { color: ${theme.link} !important; }
      mark { background: ${theme.line} !important; color: ${theme.ink} !important; }
      ::selection { background: ${theme.link}; color: ${theme.background}; }
    `);
  }

  parts.push(fontFamilyRule());
  parts.push(`
    html { font-size: ${settings.fontSize}% !important; }
    p, li, blockquote, dd, dt {
      line-height: ${settings.spacing};
      text-align: ${settings.justify ? "justify" : "start"};
      -webkit-hyphens: ${settings.hyphenate ? "auto" : "manual"};
      hyphens: ${settings.hyphenate ? "auto" : "manual"};
      -webkit-hyphenate-limit-before: 3;
      -webkit-hyphenate-limit-after: 2;
      -webkit-hyphenate-limit-lines: 2;
      hanging-punctuation: allow-end last;
      widows: 2;
    }
    [align="left"] { text-align: left; }
    [align="right"] { text-align: right; }
    [align="center"] { text-align: center; }
    [align="justify"] { text-align: justify; }
    pre { white-space: pre-wrap !important; }
    aside[epub|type~="endnote"],
    aside[epub|type~="footnote"],
    aside[epub|type~="note"],
    aside[epub|type~="rearnote"] { display: none; }
  `);

  return parts.join("\n");
}

function applyReaderSettings() {
  applyChromeTheme();
  updateSettingsAvailability();

  const view = current?.view;
  const renderer = view?.renderer;
  if (!renderer) return;

  if (current.fixed) {
    renderer.setAttribute("zoom", settings.zoom);
    return;
  }

  renderer.setAttribute("flow", settings.layout);
  renderer.setAttribute("margin", MARGIN_VALUES[settings.margins] || MARGIN_VALUES.standard);
  if (typeof renderer.setStyles === "function") renderer.setStyles(buildEpubStyles());
}

function scheduleApplySettings() {
  if (settingsFrame) return;
  settingsFrame = window.requestAnimationFrame(() => {
    settingsFrame = 0;
    applyReaderSettings();
  });
}

function updateSettingsAvailability() {
  const fixed = current?.fixed === true;
  const pdf = current?.kind === "pdf";

  for (const group of document.querySelectorAll(".settings-reflow")) {
    group.classList.toggle("is-disabled", fixed);
    for (const control of group.querySelectorAll("input, select, button")) {
      control.disabled = fixed;
    }
  }

  const zoomGroup = document.querySelector(".settings-zoom");
  if (zoomGroup) {
    zoomGroup.classList.toggle("is-disabled", !fixed);
    for (const control of zoomGroup.querySelectorAll("input, select, button")) {
      control.disabled = !fixed;
    }
  }

  if (!current) {
    dom.settingsNote.textContent =
      "Appearance settings belong to the Foliate Reader and are remembered separately from the library.";
  } else if (pdf) {
    dom.settingsNote.textContent =
      "This PDF keeps its fixed page layout. Theme tints the page and Zoom scales it. Text settings and search are for reflowable EPUBs — use the flipbook to search this PDF.";
  } else if (current.fixed) {
    dom.settingsNote.textContent =
      "This edition uses a fixed page layout. Zoom scales the pages; text settings apply to reflowable EPUBs only.";
  } else {
    dom.settingsNote.textContent =
      "Theme, font, spacing, margins, and layout apply to this reflowable edition. Zoom is for fixed-layout PDFs.";
  }
}

/* --------------------------------------------------------------------------
   Reader state
   -------------------------------------------------------------------------- */

let current = null;
let ready = false;
let restoring = false;
let lastRelocate = null;
let saveTimer = 0;
let pendingProgress = null;
let searchToken = 0;
let loadingTimer = 0;
let retryHandler = null;
let uiReady = false;
let openToken = 0;

function currentBookId() {
  return current?.record?.id || "";
}

function queueProgress(patch) {
  if (!currentBookId() || !patch) return;
  pendingProgress = patch;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(flushProgress, SAVE_DELAY);
}

function flushProgress() {
  window.clearTimeout(saveTimer);
  saveTimer = 0;
  const patch = pendingProgress;
  pendingProgress = null;
  const id = currentBookId();
  if (!id || !patch) return;
  saveProgress(id, patch);
}

function progressPatch(detail) {
  if (!current?.view?.book) return null;
  const total = current.view.book.sections?.length || 0;
  if (!total) return null;

  if (current.kind === "pdf") {
    const rawIndex = Number(detail?.section?.current);
    if (!Number.isFinite(rawIndex) || rawIndex < 0) return null;
    const page = Math.min(total, Math.max(1, Math.round(rawIndex) + 1));
    return {
      page,
      totalPages: total,
      fraction: page / total,
      kind: "pdf",
      engine: "foliate",
      cfi: null,
    };
  }

  const fraction = Number(detail?.fraction);
  const cfi = typeof detail?.cfi === "string" ? detail.cfi : null;
  if (!cfi && !Number.isFinite(fraction)) return null;
  return {
    cfi,
    fraction: Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : null,
    kind: "epub",
    engine: "foliate",
    page: null,
    totalPages: null,
  };
}

function pickLastLocation(saved) {
  if (!saved || !current?.view?.book) return null;
  const total = current.view.book.sections?.length || 0;

  if (current.kind === "pdf") {
    const page = Number(saved.page);
    if (Number.isFinite(page) && page >= 1 && total) {
      return Math.min(total - 1, Math.max(0, Math.round(page) - 1));
    }
    if (typeof saved.fraction === "number") return { fraction: saved.fraction };
    return null;
  }

  if (saved.cfi) return saved.cfi;
  if (typeof saved.fraction === "number") return { fraction: saved.fraction };
  return null;
}

/* --------------------------------------------------------------------------
   Chrome, loading, and messages
   -------------------------------------------------------------------------- */

function showChrome(show) {
  const visibility = show ? "visible" : "hidden";
  dom.headerBar.style.visibility = visibility;
  dom.navBar.style.visibility = visibility;
  dom.slider.style.visibility = show ? "visible" : "hidden";
}

function showLoading(message) {
  window.clearTimeout(loadingTimer);
  dom.loading.hidden = false;
  dom.loading.classList.remove("is-hidden");
  dom.loadingMessage.textContent = message;
  dom.loadingHint.textContent = "Only the selected edition is loaded.";
  dom.stage.setAttribute("aria-busy", "true");
  loadingTimer = window.setTimeout(() => {
    if (!dom.loading.hidden) {
      dom.loadingHint.textContent =
        "Large editions can take a moment on slower devices. Nothing else is loading.";
    }
  }, 2600);
}

function hideLoading(immediate = false) {
  window.clearTimeout(loadingTimer);
  dom.stage.setAttribute("aria-busy", "false");
  if (immediate) {
    dom.loading.classList.add("is-hidden");
    dom.loading.hidden = true;
    return;
  }
  dom.loading.classList.add("is-hidden");
  window.setTimeout(() => {
    dom.loading.hidden = true;
  }, 280);
}

function hideMessages() {
  dom.errorPanel.hidden = true;
  dom.emptyState.hidden = true;
}

function showError({ title, text, retry = null, retryLabel = "Try again", flipbookHref = "" }) {
  hideLoading(true);
  showChrome(false);
  closeSidebar();
  setSettingsOpen(false);
  hideMessages();
  dom.errorTitle.textContent = title;
  dom.errorText.textContent = text;
  dom.retryButton.hidden = typeof retry !== "function";
  dom.retryButton.textContent = retryLabel;
  retryHandler = typeof retry === "function" ? retry : null;
  if (flipbookHref) {
    dom.flipbookFallback.href = flipbookHref;
    dom.flipbookFallback.hidden = false;
  } else {
    dom.flipbookFallback.hidden = true;
  }
  dom.errorPanel.hidden = false;
  dom.bookTitle.textContent = "Reader unavailable";
  document.title = "Reader unavailable — AVADRA";
}

function showEmptyState() {
  hideLoading(true);
  hideMessages();
  showChrome(false);
  closeSidebar();
  setSettingsOpen(false);
  document.body.dataset.bookKind = "";
  dom.emptyState.hidden = false;
  dom.bookTitle.textContent = "Choose a volume";
  dom.sideBarTitle.textContent = "";
  dom.sideBarAuthor.textContent = "";
  dom.cover.removeAttribute("src");
  dom.cover.alt = "";
  document.title = "Foliate Reader — AVADRA";
}

function setBookHeader(title, author, cover) {
  const safeTitle = cleanString(title, 300) || "Untitled book";
  dom.bookTitle.textContent = safeTitle;
  dom.sideBarTitle.textContent = safeTitle;
  dom.sideBarAuthor.textContent = author ? `by ${author}` : "";
  if (cover) {
    dom.cover.src = cover;
    dom.cover.alt = `Cover of ${safeTitle}`;
  } else {
    dom.cover.removeAttribute("src");
    dom.cover.alt = "";
  }
  document.title = `${safeTitle} — Foliate Reader — AVADRA`;
}

/* --------------------------------------------------------------------------
   Sidebar and search panel
   -------------------------------------------------------------------------- */

function selectSideTab(name) {
  const search = name === "search";
  dom.tocTab.setAttribute("aria-selected", String(!search));
  dom.searchTab.setAttribute("aria-selected", String(search));
  dom.tocPanel.hidden = search;
  dom.searchPanel.hidden = !search;
  if (search) {
    window.requestAnimationFrame(() => {
      if (!dom.searchInput.disabled) dom.searchInput.focus();
    });
  }
}

function openSidebar(tab = "toc") {
  selectSideTab(tab);
  dom.sideBar.classList.add("show");
  dom.dimming.classList.add("show");
  dom.sideBarButton.setAttribute("aria-expanded", "true");
}

function closeSidebar() {
  const wasOpen = dom.sideBar.classList.contains("show");
  const focusInside = dom.sideBar.contains(document.activeElement);
  dom.sideBar.classList.remove("show");
  dom.dimming.classList.remove("show");
  dom.sideBarButton.setAttribute("aria-expanded", "false");
  if (wasOpen && focusInside) dom.sideBarButton.focus();
}

function toggleSidebar() {
  if (dom.sideBar.classList.contains("show")) closeSidebar();
  else openSidebar("toc");
}

function configureSearch() {
  const available = current?.supportsSearch === true;
  dom.searchInput.disabled = !available;
  dom.searchSubmit.disabled = !available;
  dom.searchWhole.disabled = !available;
  dom.searchForm.classList.toggle("is-disabled", !available);

  if (!available) {
    dom.searchInput.placeholder = "Unavailable for this edition";
    dom.searchResults.replaceChildren();
    if (current?.kind === "pdf") {
      dom.searchStatus.textContent =
        "Foliate cannot search PDF editions. Use the AVADRA Flipbook for full-text search in this book.";
    } else {
      dom.searchStatus.textContent =
        "Search is available for reflowable EPUB editions.";
    }
    return;
  }

  dom.searchInput.placeholder = "A word or phrase";
  dom.searchStatus.textContent = "Search inside this book.";
}

function makeSearchResult(item, token) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "search-result";
  const excerpt = item?.excerpt || {};
  button.innerHTML =
    `${escapeHtml(excerpt.pre || "")}<mark>${escapeHtml(excerpt.match || "")}</mark>` +
    `${escapeHtml(excerpt.post || "")}`;
  button.addEventListener("click", () => {
    if (token !== searchToken || !current?.view) return;
    current.view.goTo(item.cfi).catch((error) => console.error(error));
    closeSidebar();
  });
  return button;
}

async function runSearch(event) {
  event?.preventDefault();
  if (!current?.view || !current.supportsSearch) {
    configureSearch();
    return;
  }

  const query = dom.searchInput.value.trim();
  if (!query) {
    dom.searchStatus.textContent = "Type a word or phrase to search.";
    dom.searchResults.replaceChildren();
    return;
  }

  const token = ++searchToken;
  dom.searchResults.replaceChildren();
  const progress = document.createElement("div");
  progress.className = "search-progress";
  const bar = document.createElement("span");
  bar.style.width = "0%";
  progress.append(bar);
  dom.searchResults.append(progress);
  dom.searchStatus.textContent = `Searching for “${truncate(query, 60)}”…`;

  let count = 0;
  try {
    const iterator = current.view.search({
      query,
      matchWholeWords: dom.searchWhole.checked,
      draw: Overlayer.outline,
      drawOptions: { color: "#c6a15b", width: 2, radius: 3 },
    });

    for await (const result of iterator) {
      if (token !== searchToken) return;
      if (result === "done") break;

      if (typeof result?.progress === "number") {
        bar.style.width = `${Math.round(result.progress * 100)}%`;
        continue;
      }

      if (result?.subitems) {
        const group = document.createElement("p");
        group.className = "search-group-label";
        group.textContent = truncate(result.label || "Section", 60);
        dom.searchResults.append(group);
        for (const item of result.subitems) {
          count += 1;
          dom.searchResults.append(makeSearchResult(item, token));
        }
      }
    }

    if (token !== searchToken) return;
    progress.remove();

    if (count) {
      dom.searchStatus.textContent =
        `${count} ${count === 1 ? "match" : "matches"} for “${truncate(query, 60)}”.`;
    } else {
      dom.searchStatus.textContent = `No matches for “${truncate(query, 60)}”.`;
      const empty = document.createElement("p");
      empty.className = "search-empty";
      empty.textContent = "No matching passages were found in this edition.";
      dom.searchResults.append(empty);
    }
  } catch (error) {
    if (token !== searchToken) return;
    console.error(error);
    progress.remove();
    dom.searchStatus.textContent = "Search could not be completed for this book.";
  }
}

function clearSearch() {
  searchToken += 1;
  try {
    current?.view?.clearSearch?.();
  } catch (error) {
    console.warn("AVADRA could not clear the search highlights.", error);
  }
  dom.searchResults.replaceChildren();
  configureSearch();
}

/* --------------------------------------------------------------------------
   Table of contents, location, and progress controls
   -------------------------------------------------------------------------- */

function buildToc() {
  dom.tocView.replaceChildren();
  dom.tocEmpty.hidden = true;
  if (current) current.tocView = null;

  const toc = current?.view?.book?.toc;
  if (!Array.isArray(toc) || !toc.length) {
    dom.tocEmpty.hidden = false;
    return;
  }

  try {
    current.tocView = createTOCView(toc, (href) => {
      current?.view?.goTo(href).catch((error) => console.error(error));
      closeSidebar();
    });
    dom.tocView.append(current.tocView.element);
    dom.tocView.scrollTop = 0;
  } catch (error) {
    console.error(error);
    dom.tocEmpty.hidden = false;
  }
}

function updateProgressUi(detail) {
  const book = current?.view?.book;
  if (!book) return;
  const total = book.sections?.length || 0;
  dom.slider.dir = book.dir === "rtl" ? "rtl" : "ltr";

  if (current.kind === "pdf") {
    const rawIndex = Number(detail?.section?.current);
    const index = Number.isFinite(rawIndex) ? rawIndex : 0;
    const page = Math.min(total, Math.max(1, index + 1));
    dom.slider.min = "0";
    dom.slider.max = String(Math.max(0, total - 1));
    dom.slider.step = "1";
    dom.slider.value = String(page - 1);
    const text = pageLabel(page, total);
    dom.slider.setAttribute("aria-valuetext", text);
    dom.slider.title = text;
    dom.locationLabel.textContent = `${page} / ${total}`;
  } else {
    const raw = Number(detail?.fraction);
    const fraction = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
    const percent = Math.round(fraction * 100);
    dom.slider.min = "0";
    dom.slider.max = "1";
    dom.slider.step = "any";
    dom.slider.value = String(fraction);
    const tocLabel = detail?.tocItem?.label;
    const text = tocLabel
      ? `${percent}% · ${truncate(tocLabel, 34)}`
      : `${percent}% read`;
    dom.slider.setAttribute("aria-valuetext", text);
    dom.slider.title = text;
    dom.locationLabel.textContent = tocLabel
      ? `${percent}% · ${truncate(tocLabel, 24)}`
      : `${percent}%`;
  }

  if (detail?.tocItem?.href) {
    try {
      current.tocView?.setCurrentHref?.(detail.tocItem.href);
    } catch (error) {
      console.warn("AVADRA could not mark the current contents entry.", error);
    }
  }
}

function onRelocate({ detail }) {
  if (!current?.view) return;
  lastRelocate = detail;
  updateProgressUi(detail);

  if (!ready || restoring) return;
  const patch = progressPatch(detail);
  if (patch) queueProgress(patch);
}

function onLoad({ detail }) {
  const doc = detail?.doc;
  if (!doc) return;
  doc.addEventListener("keydown", onKeydown, { passive: false });
}

/* --------------------------------------------------------------------------
   Navigation and keyboard
   -------------------------------------------------------------------------- */

function goLeft() {
  current?.view?.goLeft?.().catch((error) => console.error(error));
}

function goRight() {
  current?.view?.goRight?.().catch((error) => console.error(error));
}

function isTypingTarget(target) {
  return Boolean(
    target?.closest?.("input, textarea, select, [contenteditable='true']"),
  );
}

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen?.().catch((error) => console.warn(error));
  } else {
    document.documentElement.requestFullscreen?.().catch((error) => {
      console.warn("Fullscreen is not available in this browser.", error);
    });
  }
}

function updateFullscreenButton() {
  const active = Boolean(document.fullscreenElement);
  dom.fullscreenButton.setAttribute(
    "aria-label",
    active ? "Exit fullscreen" : "Enter fullscreen",
  );
  dom.fullscreenButton.title = active ? "Exit fullscreen (f)" : "Fullscreen (f)";
}

function onKeydown(event) {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;

  if (event.key === "Escape") {
    if (!dom.settingsPanel.hidden) {
      event.preventDefault();
      setSettingsOpen(false);
      return;
    }
    if (dom.sideBar.classList.contains("show")) {
      event.preventDefault();
      closeSidebar();
      return;
    }
    return;
  }

  if (isTypingTarget(event.target)) return;

  switch (event.key) {
    case "ArrowLeft":
    case "h":
      event.preventDefault();
      goLeft();
      break;
    case "ArrowRight":
    case "l":
      event.preventDefault();
      goRight();
      break;
    case "t":
    case "T":
      event.preventDefault();
      toggleSidebar();
      break;
    case "s":
    case "S":
      event.preventDefault();
      openSidebar("search");
      break;
    case "f":
    case "F":
      event.preventDefault();
      toggleFullscreen();
      break;
    default:
      break;
  }
}

/* --------------------------------------------------------------------------
   Settings panel
   -------------------------------------------------------------------------- */

function setSettingsOpen(open) {
  const wasOpen = !dom.settingsPanel.hidden;
  const focusInside = dom.settingsPanel.contains(document.activeElement);
  dom.settingsPanel.hidden = !open;
  dom.settingsButton.setAttribute("aria-expanded", String(open));
  if (open) {
    const first = dom.settingsPanel.querySelector("select, button");
    window.requestAnimationFrame(() => first?.focus?.());
  } else if (wasOpen && focusInside) {
    dom.settingsButton.focus();
  }
}

function toggleSettings() {
  setSettingsOpen(dom.settingsPanel.hidden);
}

/* --------------------------------------------------------------------------
   Book lifecycle
   -------------------------------------------------------------------------- */

async function checkAvailable(url) {
  try {
    const response = await fetch(url, { method: "HEAD", cache: "no-store" });
    if (response.status === 404 || response.status === 403) {
      const error = new Error(`The edition file returned HTTP ${response.status}.`);
      error.code = "missing-file";
      throw error;
    }
  } catch (error) {
    if (error?.code === "missing-file") throw error;
    // Some static hosts do not answer HEAD. Let Foliate's own fetch decide.
    console.warn("AVADRA could not check the edition file before opening it.", error);
  }
}

async function closeCurrent() {
  flushProgress();
  window.clearTimeout(saveTimer);
  saveTimer = 0;
  pendingProgress = null;
  searchToken += 1;
  openToken += 1;

  const closing = current;
  current = null;
  ready = false;
  restoring = false;
  lastRelocate = null;
  document.body.dataset.bookKind = "";

  closeSidebar();
  setSettingsOpen(false);

  if (closing?.view) {
    try {
      closing.view.clearSearch?.();
    } catch (error) {
      console.warn(error);
    }
    try {
      closing.view.close?.();
    } catch (error) {
      console.warn("AVADRA could not close the renderer cleanly.", error);
    }
    try {
      await closing.view.book?.destroy?.();
    } catch (error) {
      console.warn("AVADRA could not release the book file.", error);
    }
    try {
      closing.view.remove();
    } catch {
      /* already detached */
    }
  }

  if (closing?.coverUrl) URL.revokeObjectURL(closing.coverUrl);

  dom.viewContainer.replaceChildren();
  dom.tocView.replaceChildren();
  dom.tocEmpty.hidden = true;
  dom.searchResults.replaceChildren();
  dom.slider.value = "0";
  dom.slider.removeAttribute("aria-valuetext");
  dom.locationLabel.textContent = "";
  configureSearch();
  updateSettingsAvailability();
}

function loadGeneratedCover() {
  if (!current || current.record?.cover) return;
  const owner = current;
  Promise.resolve(owner.view.book?.getCover?.())
    .then((cover) => {
      if (!cover || owner !== current) return;
      if (typeof cover === "string") {
        dom.cover.src = cover;
      } else {
        const url = URL.createObjectURL(cover);
        owner.coverUrl = url;
        dom.cover.src = url;
      }
      dom.cover.alt = `Cover of ${dom.sideBarTitle.textContent}`;
    })
    .catch((error) => {
      console.warn("AVADRA could not generate a cover for this book.", error);
    });
}

async function openBook({ record, kind, source, localName = "" }) {
  await closeCurrent();
  const token = ++openToken;
  hideMessages();
  showChrome(false);
  document.body.dataset.bookKind =
    kind === "pdf" ? "pdf" : kind === "epub" ? "epub" : "other";

  const view = document.createElement("foliate-view");
  current = {
    record: record || null,
    kind,
    source,
    localName,
    view,
    fixed: false,
    supportsSearch: false,
    tocView: null,
    coverUrl: "",
  };
  dom.viewContainer.replaceChildren(view);
  view.addEventListener("load", onLoad);
  view.addEventListener("relocate", onRelocate);

  showLoading(
    record?.title
      ? `Opening ${record.title}…`
      : `Opening ${localName || "your book"}…`,
  );

  try {
    await view.open(source);
  } catch (error) {
    if (token !== openToken) return;
    await closeCurrent();
    throw error;
  }

  // A second local file may have replaced this one while it was opening.
  if (token !== openToken || !current || current.view !== view) return;

  current.fixed = view.isFixedLayout === true;
  current.supportsSearch = (view.book.sections || []).some(
    (section) => typeof section.createDocument === "function",
  );

  const metadataTitle = formatLanguageMap(view.book.metadata?.title);
  const metadataAuthor = formatContributor(view.book.metadata?.author);
  setBookHeader(
    record?.title || metadataTitle || localName || "Untitled book",
    record?.author || metadataAuthor,
    record?.cover || "",
  );

  const saved = record ? getProgressFresh(record.id) : null;
  const lastLocation = pickLastLocation(saved);
  const resuming = Boolean(
    saved &&
      (Number(saved.page) > 1 ||
        saved.cfi ||
        Number(saved.fraction) > 0.001),
  );
  if (resuming) {
    const place =
      kind === "pdf" && Number(saved.page) >= 1
        ? `page ${Math.round(Number(saved.page))}`
        : "your saved place";
    dom.loadingMessage.textContent = `Returning to ${place}…`;
  } else {
    dom.loadingMessage.textContent = "Laying out the first page…";
  }

  applyReaderSettings();
  configureSearch();
  buildToc();
  loadGeneratedCover();

  restoring = true;
  ready = false;
  try {
    await view.init({ lastLocation });
  } catch (error) {
    restoring = false;
    if (token !== openToken) return;
    await closeCurrent();
    throw error;
  } finally {
    if (token === openToken) restoring = false;
  }
  if (token !== openToken) return;
  ready = true;

  // Some renderers report their location only on the first user move.
  if (!lastRelocate && view.lastLocation) onRelocate({ detail: view.lastLocation });

  showChrome(true);
  hideLoading();
  updateSettingsAvailability();
}

function handleOpenError(error, record, kind) {
  console.error(error);
  const message = String(error?.message || "");
  const missing =
    error?.code === "missing-file" ||
    error instanceof ResponseError ||
    error instanceof NotFoundError ||
    /\b(404|not found)\b/i.test(message);
  const unsupported =
    error instanceof UnsupportedTypeError || /unsupported|not supported/i.test(message);

  let title = "The book could not be opened.";
  let text =
    "The selected edition could not be loaded. The file may be incomplete or use a feature this browser cannot render.";
  let flipbookHref = "";

  if (missing) {
    title = "This edition is not in this copy.";
    text =
      "The catalogue lists this book, but its file is missing. Add the edition to the books/ folder to read it here, or open the flipbook for the PDF.";
  } else if (unsupported) {
    title = "This file type is not supported.";
    text =
      "Foliate Reader opens PDF, EPUB, MOBI, AZW3, FB2, and CBZ editions. This file does not appear to be one of those formats.";
  } else if (/catalogue/i.test(message)) {
    title = "The catalogue could not be read.";
    text =
      "AVADRA could not reach data/catalogue.json. Check that the site was uploaded with its data folder, then try again.";
  }

  if (record && kind === "pdf") {
    flipbookHref = `flipbook.html?book=${encodeURIComponent(record.id)}`;
  }

  const retry = record
    ? () => window.location.reload()
    : () => dom.fileInput.click();

  showError({
    title,
    text,
    retry,
    retryLabel: record ? "Try again" : "Choose another book",
    flipbookHref,
  });
}

async function openLocal(file) {
  const kind = detectLocalFormat(file);
  setBookHeader(file.name || "Local book", "", "");
  try {
    await openBook({
      record: null,
      kind,
      source: file,
      localName: file.name || "Local book",
    });
  } catch (error) {
    await closeCurrent();
    handleOpenError(error, null, kind);
  }
}

/* --------------------------------------------------------------------------
   Event wiring
   -------------------------------------------------------------------------- */

function onSettingsInput() {
  readSettingsControls();
  scheduleApplySettings();
  scheduleWriteSettings();
}

function setupInterface() {
  if (uiReady) return;
  uiReady = true;

  dom.sideBarButton.addEventListener("click", toggleSidebar);
  dom.dimming.addEventListener("click", closeSidebar);
  dom.tocTab.addEventListener("click", () => selectSideTab("toc"));
  dom.searchTab.addEventListener("click", () => selectSideTab("search"));
  dom.searchButton.addEventListener("click", () => openSidebar("search"));
  dom.searchForm.addEventListener("submit", runSearch);

  dom.leftButton.addEventListener("click", goLeft);
  dom.rightButton.addEventListener("click", goRight);
  dom.slider.addEventListener("input", () => {
    if (!current?.view) return;
    const value = Number(dom.slider.value);
    if (!Number.isFinite(value)) return;
    if (current.kind === "pdf") {
      current.view.goTo(Math.round(value)).catch((error) => console.error(error));
    } else {
      current.view.goToFraction(value).catch((error) => console.error(error));
    }
  });

  dom.fullscreenButton.addEventListener("click", toggleFullscreen);
  document.addEventListener("fullscreenchange", updateFullscreenButton);
  updateFullscreenButton();

  dom.settingsButton.addEventListener("click", toggleSettings);
  dom.settingsReset.addEventListener("click", () => {
    settings = { ...DEFAULT_SETTINGS };
    syncSettingsControls();
    applyReaderSettings();
    writeSettings();
  });

  for (const control of [
    dom.settingTheme,
    dom.settingFont,
    dom.settingFontSize,
    dom.settingSpacing,
    dom.settingMargins,
    dom.settingLayout,
    dom.settingZoom,
    dom.settingJustify,
    dom.settingHyphenate,
  ]) {
    control.addEventListener("input", onSettingsInput);
    control.addEventListener("change", onSettingsInput);
  }

  document.addEventListener("click", (event) => {
    if (dom.settingsPanel.hidden) return;
    if (event.target.closest("#menu-button")) return;
    setSettingsOpen(false);
  });

  dom.retryButton.addEventListener("click", () => {
    const handler = retryHandler;
    if (handler) handler();
  });

  dom.cover.addEventListener("error", () => {
    dom.cover.removeAttribute("src");
    dom.cover.alt = "";
  });

  dom.fileButton.addEventListener("click", () => dom.fileInput.click());
  dom.fileInput.addEventListener("change", () => {
    const file = dom.fileInput.files?.[0];
    dom.fileInput.value = "";
    if (file) openLocal(file);
  });

  let dragDepth = 0;
  dom.stage.addEventListener("dragenter", (event) => {
    if (!event.dataTransfer?.types?.includes("Files")) return;
    event.preventDefault();
    dragDepth += 1;
    dom.stage.classList.add("is-dragging");
  });
  dom.stage.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types?.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  });
  dom.stage.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dom.stage.classList.remove("is-dragging");
  });
  dom.stage.addEventListener("drop", (event) => {
    event.preventDefault();
    dragDepth = 0;
    dom.stage.classList.remove("is-dragging");
    const file = event.dataTransfer?.files?.[0];
    if (file) openLocal(file);
  });

  document.addEventListener("keydown", onKeydown);

  window.addEventListener("pagehide", () => {
    flushProgress();
    if (settingsSaveTimer) writeSettings();
    dom.stage.classList.remove("is-dragging");
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushProgress();
  });

  window.addEventListener("pageshow", (event) => {
    if (event.persisted) refreshStorage();
  });
}

/* --------------------------------------------------------------------------
   Boot
   -------------------------------------------------------------------------- */

async function boot() {
  setupInterface();
  syncSettingsControls();
  applyChromeTheme();
  configureSearch();
  updateSettingsAvailability();

  const params = new URLSearchParams(window.location.search);
  if (!params.has("book")) {
    showEmptyState();
    return;
  }

  const rawId = params.get("book");
  const bookId = validBookId(rawId);
  if (!bookId) {
    showError({
      title: "That book could not be found.",
      text:
        "The link does not contain a valid book identifier. Return to the library and choose an edition.",
    });
    return;
  }

  showLoading("Reading the catalogue…");
  let catalogue;
  try {
    catalogue = await loadCatalogue();
  } catch (error) {
    console.error(error);
    showError({
      title: "The catalogue could not be read.",
      text:
        "AVADRA could not reach data/catalogue.json. Check that the site was uploaded with its data folder, then try again.",
      retry: () => window.location.reload(),
    });
    return;
  }

  const record = catalogue.books.find((book) => book.id === bookId);
  if (!record) {
    showError({
      title: "That book is not in the catalogue.",
      text:
        "The link points to an edition that is not listed in data/catalogue.json. Return to the library to choose a book.",
    });
    return;
  }

  const kind = detectCatalogueFormat(record);
  if (!SUPPORTED_CATALOGUE_FORMATS.has(kind)) {
    showError({
      title: "This edition cannot open in Foliate.",
      text:
        "Foliate Reader supports the catalogue's PDF and EPUB editions. This record points to a different file type.",
      retry: () => window.location.reload(),
    });
    return;
  }

  setBookHeader(record.title, record.author, record.cover);
  const source = new URL(record.file, document.baseURI).href;

  try {
    await checkAvailable(source);
    await openBook({ record, kind, source });
  } catch (error) {
    await closeCurrent();
    handleOpenError(error, record, kind);
  }
}

boot().catch((error) => {
  console.error(error);
  handleOpenError(error, null, "");
});
