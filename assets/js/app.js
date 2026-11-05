/**
 * Homepage behaviour: catalogue rendering, search and filter, book details,
 * the continue-reading shelf, resume links, and the small mobile navigation.
 */

import {
  loadCatalogue,
  escapeHtml,
  getCategoryStyle,
  getBookById,
  getBookHref,
  getFeaturedBook,
  getOpenBooks,
  isPersonalBook,
  searchBooks,
  sortBooks,
  formatDate,
  formatMinutes,
  formatShortMinutes,
  formatPageCount,
} from "./catalogue.js";
import {
  getLastRead,
  getProgress,
  refreshStorage,
  STORAGE_KEY,
} from "./storage.js";

const ICONS = "assets/icons.svg";
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");

const state = {
  catalogue: null,
  query: "",
  category: "All",
  sort: "series",
  loading: false,
};

const dom = {
  body: document.body,
  header: document.querySelector(".site-header"),
  menuToggle: document.querySelector(".menu-toggle"),
  nav: document.querySelector("#site-nav"),
  feature: document.querySelector("#feature-panel"),
  recent: document.querySelector("#recent-list"),
  total: document.querySelector("[data-catalogue-total]"),
  searchForm: document.querySelector("[data-search-form]"),
  searchInput: document.querySelector("#catalogue-search"),
  searchClear: document.querySelector("[data-search-clear]"),
  filters: Array.from(document.querySelectorAll("[data-filter]")),
  sort: document.querySelector("[data-sort]"),
  status: document.querySelector("#catalogue-status"),
  region: document.querySelector("#catalogue-region"),
  footerFilters: Array.from(document.querySelectorAll("[data-footer-filter]")),
  footerReader: document.querySelector("[data-footer-reader]"),
  navResume: document.querySelector("[data-nav-resume]"),
  heroResume: document.querySelector("[data-hero-resume]"),
  heroResumeNote: document.querySelector("[data-hero-resume-note]"),
  continueSection: document.querySelector("#continue"),
  continueCover: document.querySelector("[data-continue-cover]"),
  continueTitle: document.querySelector("[data-continue-title]"),
  continueAuthor: document.querySelector("[data-continue-author]"),
  continueMeter: document.querySelector("[data-continue-meter]"),
  continueLink: document.querySelector("[data-continue-link]"),
  dialog: document.querySelector("#book-dialog"),
  dialogVisual: document.querySelector("#book-dialog-visual"),
  dialogBody: document.querySelector("#book-dialog-body"),
};

function icon(name, className = "") {
  const classAttribute = className ? ` class="${className}"` : "";
  return `<svg${classAttribute} aria-hidden="true"><use href="${ICONS}#icon-${name}"></use></svg>`;
}

function readHref(book) {
  return getBookHref(book);
}

function truncated(value, length = 64) {
  return value.length > length ? `${value.slice(0, length - 1).trimEnd()}…` : value;
}

function coverLines(book) {
  if (Array.isArray(book.coverTitle) && book.coverTitle.length) return book.coverTitle;
  return [book.title];
}

/* --------------------------------------------------------------------------
   Markup
   -------------------------------------------------------------------------- */

function coverMarkup(book, { eager = false } = {}) {
  const lines = coverLines(book);
  const missingClass = book.cover ? "" : " book-cover--missing";
  return `
    <span class="book-cover${missingClass}" data-lines="${lines.length}">
      ${
        book.cover
          ? `<img
        class="book-cover__art"
        src="${escapeHtml(book.cover)}"
        alt=""
        width="600"
        height="900"
        loading="${eager ? "eager" : "lazy"}"
        fetchpriority="${eager ? "high" : "low"}"
        decoding="async"
      >`
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

function volumeLabel(book) {
  if (book.seriesNumber) return `Volume ${book.seriesNumber}`;
  return book.category;
}

function accessLabel(book) {
  return book.access === "personal" ? "Personal copy" : "Open access";
}

function lengthLabel(book) {
  if (book.readingMinutes) return `${formatShortMinutes(book.readingMinutes)} read`;
  if (book.pages) return formatPageCount(book.pages);
  return "Length unlisted";
}

function progressMarkup(book) {
  const progress = getProgress(book.id);
  if (!progress) return "";
  const percent = Math.max(1, Math.min(100, Math.round((progress.page / progress.totalPages) * 100)));
  return `
    <div class="book-card__progress">
      <div class="book-card__progress-track" aria-hidden="true">
        <span class="book-card__progress-fill" style="width:${percent}%"></span>
      </div>
      <span class="book-card__progress-label">Page ${progress.page} of ${progress.totalPages} · ${percent}% read</span>
    </div>`;
}

function bookCardMarkup(book) {
  const progress = getProgress(book.id);
  const meta = [book.year, book.pages ? formatPageCount(book.pages) : ""].filter(Boolean).join(" · ");
  const personal = isPersonalBook(book);
  return `
    <li class="book-card${personal ? " book-card--personal" : ""}" data-access="${book.access}" style="${getCategoryStyle(book.category)}">
      <button
        class="book-card__cover-button"
        type="button"
        data-book-id="${escapeHtml(book.id)}"
        aria-label="Open details for ${escapeHtml(book.title)} by ${escapeHtml(book.author)}"
      >${coverMarkup(book)}</button>
      <div class="book-card__body">
        <p class="book-card__meta">
          <span class="book-card__category">${escapeHtml(volumeLabel(book))}</span>
          <span>${meta}</span>
        </p>
        <h3 class="book-card__title">
          <button type="button" data-book-id="${escapeHtml(book.id)}">${escapeHtml(book.title)}</button>
        </h3>
        <p class="book-card__author">${escapeHtml(book.author)}</p>
        <p class="book-card__summary">${escapeHtml(book.summary)}</p>
        ${progressMarkup(book)}
        <div class="book-card__foot">
          <span class="book-card__access">${accessLabel(book)}</span>
          <span>${lengthLabel(book)}</span>
          <a
            class="book-card__read"
            href="${readHref(book)}"
            aria-label="${progress ? "Resume" : "Read"} ${escapeHtml(book.title)}"
          ><span>${progress ? "Resume" : "Read"}</span>${icon("arrow-right")}</a>
        </div>
      </div>
    </li>`;
}

function featureMarkup(book) {
  const progress = getProgress(book.id);
  const quote =
    book.featuredQuote ||
    (book.curatorNote ? { text: book.curatorNote, attribution: "A note from the curator" } : null);
  const meta = [volumeLabel(book), book.year].filter(Boolean).join(" · ");
  const action = progress ? `Continue at page ${progress.page}` : "Start reading";
  const contents = book.editionContents
    ? `${book.editionContents} · ${lengthLabel(book)}`
    : lengthLabel(book);

  return `
    <div class="feature-panel__visual">
      <button
        class="feature-panel__cover"
        type="button"
        data-book-id="${escapeHtml(book.id)}"
        aria-label="Open details for ${escapeHtml(book.title)} by ${escapeHtml(book.author)}"
      >${coverMarkup(book, { eager: true })}</button>
    </div>
    <div class="feature-panel__content">
      <p class="feature-panel__meta">${escapeHtml(meta)}</p>
      <h3>
        <button type="button" data-book-id="${escapeHtml(book.id)}">${escapeHtml(book.title)}</button>
      </h3>
      <p class="feature-panel__author">${escapeHtml(book.author)}</p>
      ${
        quote
          ? `<blockquote>
              “${escapeHtml(quote.text)}”
              <footer>${escapeHtml(quote.attribution || "From the edition")}</footer>
            </blockquote>`
          : ""
      }
      <p class="feature-panel__summary">${escapeHtml(book.description || book.summary)}</p>
      <div class="feature-panel__actions">
        <a class="btn btn--gold" href="${readHref(book)}">
          ${action}
          ${icon("arrow-right")}
        </a>
        <button class="text-link" type="button" data-book-id="${escapeHtml(book.id)}">Edition notes</button>
      </div>
      <p class="feature-panel__footnote">
        ${escapeHtml(book.series || "The collection")} · ${escapeHtml(contents)} · ${escapeHtml(book.license)}
      </p>
    </div>`;
}

function recentItemMarkup(book) {
  return `
    <article class="recent-item" style="${getCategoryStyle(book.category)}">
      <a class="recent-item__cover-link" href="${readHref(book)}" aria-label="Read ${escapeHtml(book.title)}">
        ${coverMarkup(book)}
      </a>
      <div class="recent-item__body">
        <p class="recent-item__meta">
          <span class="recent-item__category">${escapeHtml(volumeLabel(book))}</span>
          ${book.year ? `<span>${book.year}</span>` : ""}
          <span>${escapeHtml(book.editionContents || "Full edition")}</span>
        </p>
        <h3><a href="${readHref(book)}">${escapeHtml(book.title)}</a></h3>
        <p class="recent-item__author">${escapeHtml(book.author)}</p>
        <p class="recent-item__summary">${escapeHtml(book.summary)}</p>
      </div>
      <div class="recent-item__action">
        <a class="text-link" href="${readHref(book)}">Start reading ${icon("arrow-right")}</a>
      </div>
    </article>`;
}

const SORT_LABELS = {
  series: "shelf order",
  curated: "shelf order",
  title: "title, A–Z",
  author: "author, A–Z",
  newest: "recently added",
  oldest: "publication year",
  shortest: "shortest read",
};

function skeletonMarkup() {
  return `
    <div class="skeleton-grid" aria-hidden="true">
      ${Array.from(
        { length: 4 },
        () => `
        <div class="skeleton-card">
          <div class="skeleton-card__cover"></div>
          <div class="skeleton-card__line"></div>
          <div class="skeleton-card__line skeleton-card__line--short"></div>
        </div>`,
      ).join("")}
    </div>`;
}

function emptyStateMarkup() {
  return `
    <div class="collection-state">
      ${icon("book-open", "collection-state__seal")}
      <h3>No editions answer that description.</h3>
      <p>Try a different title, author, or mood — or clear the search and filters to see the whole shelf.</p>
      <button class="btn btn--ghost" type="button" data-clear-filters>Clear search and filters</button>
    </div>`;
}

/* --------------------------------------------------------------------------
   Rendering
   -------------------------------------------------------------------------- */

function renderFeature() {
  if (!state.catalogue) return;
  const book = getFeaturedBook(state.catalogue);
  if (!book) {
    dom.feature.innerHTML = `<p class="feature-panel__placeholder">The desk is empty.</p>`;
    return;
  }
  dom.feature.innerHTML = featureMarkup(book);
}

function renderRecent() {
  if (!state.catalogue) return;
  const books = getOpenBooks(state.catalogue).slice(0, 3);
  dom.recent.innerHTML = books.map(recentItemMarkup).join("");
}

function renderFilters() {
  for (const button of dom.filters) {
    button.setAttribute("aria-pressed", String(button.dataset.filter === state.category));
  }
}

function renderCollection() {
  if (!state.catalogue) return;
  const query = state.query.trim();
  const allBooks = state.catalogue.books;
  const base =
    state.category === "All"
      ? allBooks
      : allBooks.filter((book) => book.category === state.category);
  const results = sortBooks(searchBooks(base, query), state.sort);

  if (!query && state.category === "All") {
    dom.total.textContent = `${allBooks.length} editions on the shelf`;
  } else {
    dom.total.textContent = `${results.length} of ${allBooks.length} editions shown`;
  }

  const sortLabel = SORT_LABELS[state.sort] || SORT_LABELS.curated;
  if (!results.length) {
    dom.status.innerHTML = `
      <span>No editions match this request.</span>
      <span class="catalogue-status__hint">Try fewer words or another category.</span>`;
  } else if (query || state.category !== "All") {
    const categoryClause = state.category !== "All" ? ` in ${escapeHtml(state.category)}` : "";
    const queryClause = query ? ` for “${escapeHtml(query)}”` : "";
    dom.status.innerHTML = `
      <span>Showing <strong>${results.length}</strong> of ${allBooks.length} editions${categoryClause}${queryClause}.</span>
      <span class="catalogue-status__hint">Sorted by ${escapeHtml(sortLabel)}.</span>`;
  } else {
    dom.status.innerHTML = `
      <span>All <strong>${allBooks.length}</strong> editions are on the shelf.</span>
      <span class="catalogue-status__hint">Sorted by ${escapeHtml(sortLabel)}.</span>`;
  }

  dom.region.setAttribute("aria-busy", "false");
  if (!results.length) {
    dom.region.innerHTML = emptyStateMarkup();
    return;
  }

  dom.region.innerHTML = `<ul class="collection-grid" role="list">${results
    .map(bookCardMarkup)
    .join("")}</ul>`;
}

function renderLoadingState() {
  dom.total.textContent = "Opening the shelves…";
  dom.status.innerHTML = `<span>Opening the catalogue…</span><span class="catalogue-status__hint">One moment.</span>`;
  dom.feature.innerHTML = `<p class="feature-panel__placeholder">Lighting the desk…</p>`;
  dom.recent.innerHTML = `<p class="recent-list__loading">Opening the first editions…</p>`;
  dom.region.setAttribute("aria-busy", "true");
  dom.region.innerHTML = skeletonMarkup();
}

function renderAll() {
  if (!state.catalogue) return;
  renderFeature();
  renderRecent();
  renderFilters();
  renderCollection();
  refreshResumeLinks();
  renderContinueSection();
}

function showCatalogueError(error) {
  console.error("AVADRA catalogue error:", error);

  const isFile = error?.code === "file-protocol";
  const isHttp = error?.code === "http-error";
  const explanation = isFile
    ? `<p>This site must be opened through a local web server rather than by double-clicking the HTML file. From the project folder, run <code>python3 -m http.server 8000</code>, then open <code>http://localhost:8000</code>.</p>`
    : isHttp
      ? `<p>The catalogue request returned HTTP ${escapeHtml(error.status || "")}. Check that <code>data/catalogue.json</code> is present and reachable.</p>`
      : `<p>Check that <code>data/catalogue.json</code> exists and is valid JSON, then try again.</p>`;

  dom.region.setAttribute("aria-busy", "false");
  dom.region.innerHTML = `
    <div class="collection-state" role="alert">
      ${icon("alert", "collection-state__seal")}
      <h3>The catalogue could not be opened.</h3>
      ${explanation}
      <button class="btn btn--ghost" type="button" data-retry-catalogue>Try again</button>
    </div>`;

  dom.status.innerHTML = `
    <span>The shelves are unavailable.</span>
    <span class="catalogue-status__hint">The open shelf is still reachable from the reader.</span>`;
  dom.total.textContent = "Catalogue unavailable";
  dom.feature.innerHTML = `
    <p class="feature-panel__placeholder">
      The desk is dark until the catalogue opens. You can still open a PDF in the reader.
    </p>`;
  dom.recent.innerHTML = `
    <p class="recent-list__loading">The first editions could not be listed. See the catalogue notes below.</p>`;

  renderContinueSection();
}

/* --------------------------------------------------------------------------
   Continue reading
   -------------------------------------------------------------------------- */

function getResumeTarget() {
  const lastRead = getLastRead();
  if (!lastRead?.progress) return null;

  const book = state.catalogue ? getBookById(state.catalogue, lastRead.bookId) : null;
  if (book) {
    return { book, progress: lastRead.progress, href: readHref(book), meta: lastRead.meta };
  }

  if (lastRead.meta?.access === "local") {
    return {
      book: {
        id: lastRead.meta.id,
        title: lastRead.meta.title,
        author: lastRead.meta.author,
        category: "Local document",
        access: "local",
        cover: "",
        coverTitle: [lastRead.meta.title],
      },
      progress: lastRead.progress,
      href: `flipbook.html?local=${encodeURIComponent(lastRead.meta.id)}`,
      meta: lastRead.meta,
    };
  }

  return null;
}

function renderContinueSection() {
  if (!dom.continueSection) return;
  const target = getResumeTarget();
  if (!target) {
    dom.continueSection.hidden = true;
    return;
  }

  const { book, progress, href } = target;
  const percent = Math.max(1, Math.min(100, Math.round((progress.page / progress.totalPages) * 100)));
  dom.continueCover.innerHTML = coverMarkup(book, { eager: true });
  dom.continueTitle.textContent = book.title;
  dom.continueAuthor.textContent = book.author;
  dom.continueMeter.innerHTML = `
    <div class="continue-card__track" aria-hidden="true">
      <span class="continue-card__fill" style="width:${percent}%"></span>
    </div>
    <p class="continue-card__label">
      Page ${progress.page} of ${progress.totalPages} · ${percent}% read
      <span>Saved in this browser</span>
    </p>`;
  dom.continueLink.href = href;
  dom.continueLink.innerHTML = `Continue reading ${icon("arrow-right")}`;
  dom.continueLink.setAttribute("aria-label", `Continue ${book.title} at page ${progress.page}`);
  dom.continueSection.hidden = false;
}

function refreshResumeLinks() {
  const target = getResumeTarget();
  const firstBook = state.catalogue ? getOpenBooks(state.catalogue)[0] : null;

  if (!target) {
    if (dom.navResume) dom.navResume.hidden = true;
    if (dom.heroResume) {
      dom.heroResume.href = "#collection";
      dom.heroResume.removeAttribute("aria-label");
      dom.heroResume.dataset.state = "empty";
    }
    if (dom.heroResumeNote) {
      dom.heroResumeNote.textContent = "Choose a volume to begin";
    }
    if (dom.footerReader) {
      dom.footerReader.href = firstBook ? readHref(firstBook) : "flipbook.html";
    }
    return;
  }

  const { book, progress, href } = target;
  if (dom.navResume) {
    const navLabel = dom.navResume.querySelector("[data-nav-resume-label]");
    dom.navResume.href = href;
    dom.navResume.hidden = false;
    if (navLabel) navLabel.textContent = "Resume reading";
    dom.navResume.setAttribute("aria-label", `Resume ${book.title} at page ${progress.page}`);
  }
  if (dom.heroResume) {
    dom.heroResume.href = href;
    dom.heroResume.dataset.state = "resume";
    dom.heroResume.setAttribute(
      "aria-label",
      `Continue ${book.title} at page ${progress.page} of ${progress.totalPages}`,
    );
  }
  if (dom.heroResumeNote) {
    dom.heroResumeNote.textContent = `“${truncated(book.title, 42)}” · page ${progress.page}`;
  }
  if (dom.footerReader) dom.footerReader.href = href;
}

function refreshPersonalisation() {
  refreshResumeLinks();
  renderContinueSection();
  if (state.catalogue) {
    renderFeature();
    renderCollection();
  }
}

/* --------------------------------------------------------------------------
   Catalogue loading
   -------------------------------------------------------------------------- */

async function loadCatalogueIntoPage() {
  if (state.loading) return;
  state.loading = true;
  renderLoadingState();

  try {
    state.catalogue = await loadCatalogue();
    state.loading = false;
    renderAll();
  } catch (error) {
    state.loading = false;
    state.catalogue = null;
    showCatalogueError(error);
  }
}

/* --------------------------------------------------------------------------
   Controls
   -------------------------------------------------------------------------- */

function setCategory(category) {
  state.category = category;
  renderFilters();
  renderCollection();
}

function clearFilters({ returnFocus = false } = {}) {
  state.query = "";
  state.category = "All";
  dom.searchInput.value = "";
  dom.searchClear.hidden = true;
  renderFilters();
  renderCollection();
  if (returnFocus) dom.searchInput.focus();
}

function setupCollectionControls() {
  dom.searchForm.addEventListener("submit", (event) => event.preventDefault());

  dom.searchInput.addEventListener("input", () => {
    state.query = dom.searchInput.value;
    dom.searchClear.hidden = state.query.length === 0;
    renderCollection();
  });

  dom.searchClear.addEventListener("click", () => {
    state.query = "";
    dom.searchInput.value = "";
    dom.searchClear.hidden = true;
    renderCollection();
    dom.searchInput.focus();
  });

  for (const button of dom.filters) {
    button.addEventListener("click", () => {
      setCategory(button.dataset.filter || "All");
    });
  }

  dom.sort.addEventListener("change", () => {
    state.sort = dom.sort.value;
    renderCollection();
  });

  for (const link of dom.footerFilters) {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      state.query = "";
      dom.searchInput.value = "";
      dom.searchClear.hidden = true;
      setCategory(link.dataset.footerFilter || "All");
      document.querySelector("#collection")?.scrollIntoView({
        behavior: REDUCED_MOTION.matches ? "auto" : "smooth",
        block: "start",
      });
    });
  }
}

/* --------------------------------------------------------------------------
   Book details dialog
   -------------------------------------------------------------------------- */

function openBookDialog(bookId) {
  if (!state.catalogue || !dom.dialog) return;
  const book = getBookById(state.catalogue, bookId);
  if (!book) return;

  const progress = getProgress(book.id);
  const action = progress ? `Continue at page ${progress.page}` : "Open the reader";
  const source = book.source;
  const sourceMarkup = source.url
    ? `<a href="${escapeHtml(source.url)}" target="_blank" rel="noopener">${escapeHtml(
        source.name,
      )}${source.ebook ? ` · eBook ${escapeHtml(source.ebook)}` : ""} ${icon("external")}</a>`
    : `${escapeHtml(source.name)}${source.ebook ? ` · eBook ${escapeHtml(source.ebook)}` : ""}`;
  const personal = isPersonalBook(book);
  const editionNote = personal
    ? `<div class="book-dialog__notice">
        <strong>Private edition</strong>
        <p>This record does not include a book file. The reader will ask you to choose a PDF from your device. The file stays in this browser and is never uploaded.</p>
      </div>`
    : `<div class="book-dialog__notice book-dialog__notice--open">
        <strong>Ready to read</strong>
        <p>This edition is served with this site and opens directly in the reader. Your place is remembered in this browser.</p>
      </div>`;

  dom.dialogVisual.innerHTML = coverMarkup(book, { eager: true });
  dom.dialogBody.setAttribute("style", getCategoryStyle(book.category));
  dom.dialogBody.innerHTML = `
    <p class="book-dialog__eyebrow">
      <span>${escapeHtml(volumeLabel(book))}</span>
      ${book.year ? `<span>${book.year}</span>` : ""}
      <span>${escapeHtml(formatPageCount(book.pages))}</span>
    </p>
    <h2 class="book-dialog__title" id="book-dialog-title">${escapeHtml(book.title)}</h2>
    <p class="book-dialog__author">${escapeHtml(book.author)}</p>
    <p class="book-dialog__description">${escapeHtml(book.description || book.summary)}</p>
    ${
      book.curatorNote
        ? `<blockquote class="book-dialog__quote">
            “${escapeHtml(book.curatorNote)}”
            <footer>A note from the curator</footer>
          </blockquote>`
        : ""
    }
    ${editionNote}
    <dl class="book-dialog__facts">
      ${
        book.series
          ? `<div>
        <dt>Shelf</dt>
        <dd>${escapeHtml(book.series)}${
          book.seriesNumber ? ` · Volume ${book.seriesNumber}` : ""
        }</dd>
      </div>`
          : ""
      }
      <div>
        <dt>Contents</dt>
        <dd>${escapeHtml(book.editionContents || "The complete edition")}</dd>
      </div>
      <div>
        <dt>Reading time</dt>
        <dd>${escapeHtml(formatMinutes(book.readingMinutes))}</dd>
      </div>
      <div>
        <dt>Copy</dt>
        <dd>${sourceMarkup}</dd>
      </div>
      <div>
        <dt>Licence</dt>
        <dd>${escapeHtml(book.license)}</dd>
      </div>
      <div>
        <dt>Added</dt>
        <dd>${escapeHtml(book.addedAt ? formatDate(book.addedAt) : "Unlisted")}</dd>
      </div>
      <div>
        <dt>Your place</dt>
        <dd>${
          progress
            ? `Page ${progress.page} of ${progress.totalPages}`
            : "Not started yet"
        }</dd>
      </div>
    </dl>
    <div class="book-dialog__actions">
      <a class="btn btn--ink" href="${readHref(book)}">
        ${action}
        ${icon("arrow-right")}
      </a>
      <button class="text-link" type="button" data-close-dialog>Back to the shelf</button>
    </div>
    <p class="book-dialog__footnote">
      ${
        personal
          ? "A catalogue record for a personal copy. No book file is distributed with this site. This is an unofficial, independent project; the underlying work belongs to its rights holders."
          : `An edition served with AVADRA. This is an unofficial, independent project; the underlying work belongs to its rights holders.${
              source.url
                ? ` <a href="${escapeHtml(source.url)}" target="_blank" rel="noopener">View the source text</a>.`
                : ""
            }`
      }
    </p>`;

  dom.dialog.scrollTop = 0;
  document.body.classList.add("has-dialog");
  if (!dom.dialog.open) {
    if (typeof dom.dialog.showModal === "function") {
      dom.dialog.showModal();
    } else {
      dom.dialog.setAttribute("open", "");
    }
  }
}

function closeDialog() {
  if (!dom.dialog) return;
  if (dom.dialog.open && typeof dom.dialog.close === "function") {
    dom.dialog.close();
  } else {
    dom.dialog.removeAttribute("open");
    document.body.classList.remove("has-dialog");
  }
}

function setupDialog() {
  if (!dom.dialog) return;

  document.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-book-id]");
    if (trigger) {
      event.preventDefault();
      openBookDialog(trigger.dataset.bookId);
      return;
    }

    if (event.target.closest("[data-close-dialog]")) {
      event.preventDefault();
      closeDialog();
      return;
    }

    if (event.target.closest("[data-clear-filters]")) {
      clearFilters({ returnFocus: true });
      return;
    }

    if (event.target.closest("[data-retry-catalogue]")) {
      loadCatalogueIntoPage();
    }
  });

  dom.dialog.addEventListener("click", (event) => {
    if (event.target === dom.dialog) closeDialog();
  });

  dom.dialog.addEventListener("close", () => {
    document.body.classList.remove("has-dialog");
  });
}

/* --------------------------------------------------------------------------
   Navigation
   -------------------------------------------------------------------------- */

function setMenu(open) {
  dom.body.classList.toggle("nav-open", open);
  dom.menuToggle.setAttribute("aria-expanded", String(open));
  const label = dom.menuToggle.querySelector(".visually-hidden");
  if (label) label.textContent = open ? "Close menu" : "Open menu";
}

function setupHeaderScroll() {
  if (!dom.header) return;
  let ticking = false;
  const update = () => {
    dom.header.classList.toggle("is-scrolled", window.scrollY > 24);
    ticking = false;
  };
  window.addEventListener(
    "scroll",
    () => {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(update);
    },
    { passive: true },
  );
  update();
}

function setupNavigation() {
  dom.menuToggle.addEventListener("click", () => {
    setMenu(dom.menuToggle.getAttribute("aria-expanded") !== "true");
  });

  dom.nav.addEventListener("click", (event) => {
    if (event.target.closest("a")) setMenu(false);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (dom.body.classList.contains("nav-open")) {
      setMenu(false);
      dom.menuToggle.focus();
    }
  });

  document.addEventListener("click", (event) => {
    if (
      dom.body.classList.contains("nav-open") &&
      !event.target.closest(".site-header")
    ) {
      setMenu(false);
    }
  });

  const desktopQuery = window.matchMedia("(min-width: 861px)");
  desktopQuery.addEventListener("change", (event) => {
    if (event.matches) setMenu(false);
  });

  setupHeaderScroll();
}

/* --------------------------------------------------------------------------
   Image fallback and lifecycle
   -------------------------------------------------------------------------- */

function setupImageFallback() {
  document.addEventListener(
    "error",
    (event) => {
      const image = event.target;
      if (image instanceof HTMLImageElement && image.classList.contains("book-cover__art")) {
        image.hidden = true;
        image.closest(".book-cover")?.classList.add("book-cover--missing");
      }
    },
    true,
  );
}

function setupStorageSync() {
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    refreshStorage();
    refreshPersonalisation();
  });

  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    refreshStorage();
    refreshPersonalisation();
  });
}

setupNavigation();
setupCollectionControls();
setupDialog();
setupImageFallback();
setupStorageSync();
loadCatalogueIntoPage();
