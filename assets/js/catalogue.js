/**
 * Catalogue loading, validation, and presentation helpers.
 *
 * The JSON file is the single source of truth for the homepage and reader.
 * A malformed record should never reach the DOM, so every field is checked
 * and normalised here.
 */

const CATALOGUE_URL = new URL("../../data/catalogue.json", import.meta.url);

const CATEGORY_META = Object.freeze({
  "Harry Potter": {
    color: "var(--cat-harry-potter)",
    ink: "var(--cat-harry-potter-ink)",
    blurb: "Seven volumes, one long story, read in order.",
  },
});

export class CatalogueError extends Error {
  constructor(message, { code = "catalogue-error", status = 0 } = {}) {
    super(message);
    this.name = "CatalogueError";
    this.code = code;
    this.status = status;
  }
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function cleanText(value, max = 5000) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

function cleanId(value) {
  const id = cleanText(value, 120).toLowerCase();
  return /^[a-z0-9][a-z0-9-]*$/.test(id) ? id : "";
}

function safeLocalAsset(value) {
  const path = cleanText(value, 300);
  if (!path || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("/") || path.includes("\\")) {
    return "";
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "..")) return "";
  return path;
}

function safeHttpUrl(value) {
  const text = cleanText(value, 500);
  if (!text) return "";
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
}

function parseYear(value) {
  const year = Number(value);
  return Number.isInteger(year) && year >= 1 && year <= 2100 ? year : null;
}

function parsePositiveInteger(value, fallback = null) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number <= 10000 ? number : fallback;
}

function parseDate(value) {
  const text = cleanText(value, 40);
  if (!text) return null;
  const time = Date.parse(text);
  return Number.isNaN(time) ? null : text;
}

function normaliseSource(source) {
  if (!source || typeof source !== "object") {
    return { name: "Unlisted source", ebook: null, url: "" };
  }
  const ebook = cleanText(source.ebook, 30);
  return {
    name: cleanText(source.name, 120) || "Unlisted source",
    ebook: ebook || null,
    url: safeHttpUrl(source.url),
  };
}

function normaliseQuote(quote) {
  if (!quote || typeof quote !== "object") return null;
  const text = cleanText(quote.text, 500);
  if (!text) return null;
  return {
    text,
    attribution: cleanText(quote.attribution, 200),
  };
}

function normaliseCoverTitle(value, title) {
  if (Array.isArray(value)) {
    const lines = value
      .map((line) => cleanText(line, 80))
      .filter(Boolean)
      .slice(0, 3);
    if (lines.length) return lines;
  }
  const words = title.split(/\s+/);
  if (words.length <= 2) return [title];
  const midpoint = Math.ceil(words.length / 2);
  return [words.slice(0, midpoint).join(" "), words.slice(midpoint).join(" ")];
}

function normaliseBook(raw) {
  if (!raw || typeof raw !== "object") return null;

  const id = cleanId(raw.id);
  const title = cleanText(raw.title, 220);
  const author = cleanText(raw.author, 160);
  const category = cleanText(raw.category, 60);
  const summary = cleanText(raw.summary, 700);
  const description = cleanText(raw.description, 2400);
  const cover = safeLocalAsset(raw.cover);
  const file = safeLocalAsset(raw.file);
  const pages = parsePositiveInteger(raw.pages);

  if (!id || !title || !author || !category || !file) {
    return null;
  }

  return {
    id,
    title,
    coverTitle: normaliseCoverTitle(raw.coverTitle, title),
    author,
    series: cleanText(raw.series, 120),
    seriesNumber: parsePositiveInteger(raw.seriesNumber),
    year: parseYear(raw.year),
    category,
    summary,
    description,
    curatorNote: cleanText(raw.curatorNote, 400),
    cover,
    file,
    pages,
    readingMinutes: parsePositiveInteger(raw.readingMinutes),
    editionContents: cleanText(raw.editionContents, 240),
    source: normaliseSource(raw.source),
    license: cleanText(raw.license, 240) || "See the source record for rights information.",
    addedAt: parseDate(raw.addedAt),
    featured: raw.featured === true,
    featuredQuote: normaliseQuote(raw.featuredQuote),
  };
}

function normaliseCatalogue(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.books)) {
    throw new CatalogueError("The catalogue file is not in the expected format.", {
      code: "invalid-catalogue",
    });
  }

  const seen = new Set();
  const books = [];
  for (const record of raw.books) {
    const book = normaliseBook(record);
    if (!book) {
      console.warn("Skipped an incomplete catalogue record.", record?.id || record);
      continue;
    }
    if (seen.has(book.id)) {
      console.warn(`Skipped a duplicate catalogue id: ${book.id}`);
      continue;
    }
    seen.add(book.id);
    books.push(book);
  }

  if (!books.length) {
    throw new CatalogueError("The catalogue contains no readable editions.", {
      code: "empty-catalogue",
    });
  }

  const declaredCategories = Array.isArray(raw.categories)
    ? raw.categories.map((category) => cleanText(category, 60)).filter(Boolean)
    : [];
  const categories = [...new Set([...declaredCategories, ...books.map((book) => book.category)])];

  const nightShelf = Array.isArray(raw.nightShelf)
    ? raw.nightShelf.map((id) => cleanId(id)).filter((id) => seen.has(id))
    : [];

  return {
    version: parsePositiveInteger(raw.version, 1),
    updatedAt: parseDate(raw.updatedAt),
    categories,
    books,
    nightShelf,
  };
}

export async function loadCatalogue() {
  if (window.location.protocol === "file:") {
    throw new CatalogueError("The catalogue cannot be opened from a file:// page.", {
      code: "file-protocol",
    });
  }

  let response;
  try {
    response = await fetch(CATALOGUE_URL, {
      headers: { Accept: "application/json" },
      cache: "no-cache",
    });
  } catch (error) {
    throw new CatalogueError("The catalogue could not be reached.", {
      code: "network-error",
    });
  }

  if (!response.ok) {
    throw new CatalogueError(`The catalogue returned an HTTP ${response.status} response.`, {
      code: "http-error",
      status: response.status,
    });
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new CatalogueError("The catalogue file could not be read as JSON.", {
      code: "invalid-json",
    });
  }

  return normaliseCatalogue(payload);
}

export function getCategoryMeta(category) {
  return CATEGORY_META[category] || { color: "var(--gold)", ink: "var(--gold-deep)", blurb: "" };
}

export function getCategoryStyle(category) {
  const meta = getCategoryMeta(category);
  return `--category-color:${meta.color};--category-ink:${meta.ink}`;
}

export function getBookById(catalogue, bookId) {
  return catalogue?.books.find((book) => book.id === bookId) || null;
}

export function getFeaturedBook(catalogue) {
  return catalogue?.books.find((book) => book.featured) || catalogue?.books[0] || null;
}

export function normaliseSearch(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function searchBooks(books, query) {
  const terms = normaliseSearch(query).split(" ").filter(Boolean);
  if (!terms.length) return books.slice();
  return books.filter((book) => {
    const haystack = normaliseSearch(
      [
        book.title,
        book.author,
        book.category,
        book.series,
        book.seriesNumber,
        book.year,
        book.summary,
        book.description,
        book.curatorNote,
        book.editionContents,
      ].join(" "),
    );
    return terms.every((term) => haystack.includes(term));
  });
}

export function sortBooks(books, sort) {
  const list = books.slice();
  const byTitle = (a, b) => a.title.localeCompare(b.title, "en", { sensitivity: "base" });

  switch (sort) {
    case "title":
      return list.sort(byTitle);
    case "author":
      return list.sort(
        (a, b) =>
          a.author.localeCompare(b.author, "en", { sensitivity: "base" }) || byTitle(a, b),
      );
    case "series":
      return list.sort(
        (a, b) => (a.seriesNumber || 9999) - (b.seriesNumber || 9999) || byTitle(a, b),
      );
    case "newest":
      return list.sort((a, b) => Date.parse(b.addedAt || 0) - Date.parse(a.addedAt || 0));
    case "oldest":
      return list.sort((a, b) => (a.year || 9999) - (b.year || 9999));
    case "shortest":
      return list.sort(
        (a, b) => (a.readingMinutes || 9999) - (b.readingMinutes || 9999) || byTitle(a, b),
      );
    case "curated":
    default:
      return list;
  }
}

export function getRecentlyAdded(books, limit = 3) {
  return books
    .slice()
    .sort((a, b) => Date.parse(b.addedAt || 0) - Date.parse(a.addedAt || 0))
    .slice(0, limit);
}

export function formatMinutes(minutes) {
  if (!minutes) return "Reading time unlisted";
  if (minutes < 60) return `About ${minutes} minutes`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `About ${hours} ${hours === 1 ? "hour" : "hours"}`;
}

export function formatShortMinutes(minutes) {
  if (!minutes) return "—";
  return minutes < 60 ? `${minutes} min` : `${Math.round((minutes / 60) * 10) / 10} hr`;
}

export function formatDate(value) {
  if (!value) return "";
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return cleanText(value, 40);
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

export function formatPageCount(pages) {
  if (!pages) return "Page count unlisted";
  return `${pages} ${pages === 1 ? "page" : "pages"}`;
}
