# AVADRA

A quiet, cinematic reading room for a seven-volume collection, built with plain
HTML, CSS, and vanilla ES modules. Books open in a custom PDF reader with a 3D
page-turn, three themes, search, thumbnails, bookmarks, and a place that
remembers where you stopped.

There is no framework, package manager, build step, CDN, or server-side code.
Everything is served as static files and works unchanged on GitHub Pages.

> This is an unofficial personal project. It is not affiliated with J. K.
> Rowling, Bloomsbury, Scholastic, Warner Bros., or any other rights holder.
> The PDFs in `books/` remain the property of their rights holders and are not
> offered for reuse or redistribution. See `notices.html` and
> `THIRD-PARTY-NOTICES.md`.

## What is here

- **A seven-volume catalogue** — the novels in reading order, with series
  numbers, publication years, page counts, descriptions, and curator notes.
- **A custom reader** — `flipbook.html?book=<id>` loads the PDF with a locally
  vendored PDF.js 3.11.174. Pages render to a canvas with a 3D page-turn, zoom,
  fit-to-width/page, fullscreen, in-book search, thumbnails, bookmarks, and
  keyboard shortcuts.
- **Three themes** — Midnight, Parchment, and Dark, plus adjustable reading
  width, brightness, and a distraction-free mode.
- **Resume reading** — the page you last viewed is saved locally, and the
  homepage and reader top bar reopen that page.
- **Local-only data** — progress, bookmarks, and preferences stay in
  `localStorage`. User-supplied PDFs stay in IndexedDB and are never uploaded.
- **A resilient catalogue** — a missing cover falls back to a typographic tile,
  and a missing or broken PDF shows an explanatory error with a retry action
  rather than silently failing.
- **A cinematic homepage** — a painted castle hero, film-grain particles,
  responsive type, and no external requests.

## Run it locally

The catalogue is loaded with `fetch`, so browsers block it on `file://` URLs.
Serve the folder over HTTP:

```bash
cd HP
python3 -m http.server 8000
```

Then visit:

- <http://localhost:8000/> — the library
- <http://localhost:8000/flipbook.html?book=harry-potter-01-philosophers-stone> — the first book

Any static server works, for example `npx serve .` or `php -S localhost:8000`.
Opening `index.html` by double-clicking shows an explanatory error instead of the
collection.

## The seven books

The catalogue expects these exact filenames. Replace a file in place if you have
a different edition.

| # | Title | PDF |
| --- | --- | --- |
| 1 | Harry Potter and the Philosopher's Stone | `books/harry-potter-01-philosophers-stone.pdf` |
| 2 | Harry Potter and the Chamber of Secrets | `books/harry-potter-02-chamber-of-secrets.pdf` |
| 3 | Harry Potter and the Prisoner of Azkaban | `books/harry-potter-03-prisoner-of-azkaban.pdf` |
| 4 | Harry Potter and the Goblet of Fire | `books/harry-potter-04-goblet-of-fire.pdf` |
| 5 | Harry Potter and the Order of the Phoenix | `books/harry-potter-05-order-of-the-phoenix.pdf` |
| 6 | Harry Potter and the Half-Blood Prince | `books/harry-potter-06-half-blood-prince.pdf` |
| 7 | Harry Potter and the Deathly Hallows | `books/harry-potter-07-deathly-hallows.pdf` |

Rules that keep the catalogue working:

1. **Every path is relative to the site root.** It must begin with `books/` or
   `assets/` and must not start with `/`.
2. **Keep the filename.** If you rename a file, update its `file` value in
   `data/catalogue.json`, or the reader will not find it.
3. **Use a real PDF.** Files with a `.pdf` extension that are not valid PDFs
   cannot be rendered.
4. **Covers are optional.** The current catalogue uses typographic covers, so
   no cover images are required. Add a `cover` path if you have art you may use.
5. **One catalogue, one source of truth.** Both the homepage and the reader read
   `data/catalogue.json`.

## How the catalogue works

`data/catalogue.json` is the single source of truth for both the homepage and
the reader. Each record looks like this:

```json
{
  "id": "harry-potter-01-philosophers-stone",
  "title": "Harry Potter and the Philosopher's Stone",
  "coverTitle": "",
  "author": "J. K. Rowling",
  "series": "Harry Potter",
  "seriesNumber": 1,
  "year": 1997,
  "category": "Open Shelf",
  "access": "open",
  "summary": "One or two sentences for the card.",
  "description": "A longer spoiler-light description for the details dialog.",
  "curatorNote": "A short editorial note.",
  "cover": "",
  "file": "books/harry-potter-01-philosophers-stone.pdf",
  "pages": 222,
  "readingMinutes": 350,
  "editionContents": "The complete novel",
  "source": { "name": "Served with AVADRA", "ebook": null, "url": "" },
  "license": "Served with this site. Harry Potter and related names belong to their respective rights holders.",
  "addedAt": "2026-10-25",
  "featured": true
}
```

Required fields: `id`, `title`, `author`, `category`, and `file` when
`access` is `"open"`. Everything else is optional and is omitted gracefully if
absent.

Useful details:

- **Reading order** uses `seriesNumber`; the default sort is shelf order.
- **`coverTitle`** supplies the fallback tile's lines when `cover` is empty.
- **`pages`** and **`readingMinutes`** drive the length labels. If omitted, the
  interface says the length is unlisted instead of printing `undefined`.
- **`featured`** puts one book on the night desk. If none is marked, the first
  record is used.
- **`access`** is `"open"` for editions served with the site and `"personal"`
  for catalogue-only records that ask the reader for a local PDF.
- **`categories`** at the top of the JSON declares the filter chips.
- **`version`** is `3` for the current schema.

After editing the JSON, validate it before reloading:

```bash
python3 -m json.tool data/catalogue.json > /dev/null && echo "JSON OK"
```

## How the reader works

`flipbook.html?book=<id>` looks the book up in the catalogue for the header
title, then loads the PDF with PDF.js:

- PDF.js and its worker are served from `assets/vendor/pdfjs/`. The worker is
  configured with a relative URL so the reader works on a GitHub Pages project
  subpath.
- Pages render to a single `<canvas>` sized for the current zoom, fit mode, and
  device pixel ratio. Large pages are capped so modest GPUs stay responsive.
- Page navigation uses a 3D CSS page-turn: the current sheet swings away around
  its spine and the freshly painted page unfolds back into place. The effect is
  disabled when the reader's animations toggle is off or the operating system
  requests reduced motion.
- Page keys, zoom, fit, fullscreen, search, thumbnails, bookmarks, theme,
  settings, and distraction-free mode all have keyboard shortcuts, shown in the
  reader's shortcuts dialog (`?`).
- Progress is written to `localStorage` under `avadra:library:v2`; bookmarks and
  preferences use the same store. Legacy `wizarding-library:v1` data is migrated
  on first load.
- PDFs opened from the device are stored in IndexedDB (`avadra-library`) by
  book id, so a personal copy can be reopened later. They are never uploaded.

If a PDF is missing, the reader shows the document error with an "Open a PDF
from your device" action and a retry path. It never falls back silently to the
browser's native viewer.

## Project structure

```text
HP/
├── index.html                 Homepage, hero, and collection
├── flipbook.html              Reader shell (reads ?book=<id> or ?local=<id>)
├── notices.html               Third-party licences and rights
├── 404.html                   GitHub Pages not-found page
├── data/catalogue.json        Seven catalogue records
├── books/                     Seven PDFs served with the site
├── assets/
│   ├── art/                   Source SVGs for the hero
│   ├── css/                   base.css, library.css, hero.css, pages.css, reader.css
│   ├── fonts/                 Self-hosted WOFF2 subsets and licences
│   ├── js/                    app.js, catalogue.js, reader.js, storage.js, pdf-store.js
│   ├── vendor/pdfjs/          Local PDF.js 3.11.174 + worker
│   ├── hero-castle.webp       Desktop hero art
│   ├── hero-castle-mobile.webp
│   ├── favicon.svg
│   └── icons.svg
├── README.md
├── THIRD-PARTY-NOTICES.md
└── .nojekyll
```

`THIRD-PARTY-NOTICES.md` is the repository copy of the licences shown on
`notices.html`.

## Publish on GitHub Pages

The site uses relative paths, lowercase filenames, and includes `.nojekyll`, so
GitHub Pages serves it from either a user site (`username.github.io`) or a
project subpath (`username.github.io/repo/`) without changes.

1. Push the site files to a repository.
2. In **Settings → Pages**, choose the branch and the root folder.
3. Open the published URL. Missing paths are handled by `404.html`.

GitHub Pages is a static host: there is no server code, no environment
variables, and no custom headers. Everything here works within those limits.

**The books are part of this deployment.** The seven PDFs in `books/` are
committed and served publicly by GitHub Pages. If you fork or redeploy the site,
make sure you have the right to redistribute them.

## Checks

With the local server running:

1. Load the homepage and confirm the ledger says **The Collection** and the
   collection shows exactly seven cards.
2. Search for `Azkaban`, filter by **Open Shelf**, and sort by **Shelf order**.
3. Open a details dialog and start reading. The reader should show page `1` of
   the PDF's page count; turn a page and confirm the 3D turn and the page
   counter update.
4. Reload the homepage and confirm the resume link returns to the page you left.
5. Open each of the seven books and confirm the title and page count load with
   no console errors.
6. Check a narrow window: the navigation collapses, the cards stack, and the
   reader toolbar remains usable.
7. Open `notices.html` and `404.html` (or any unknown path) to confirm both
   render with the site styling.

## Performance notes

- The homepage ships a few small ES modules and CSS files. The reader is the
  only page that loads PDF.js.
- The hero art is WebP and preloaded per viewport; the entrance animations are
  CSS-only and respect reduced motion.
- Fonts are self-hosted, preloaded where they matter, and reduced to the weights
  the design uses (400–500) and a Latin glyph set.
- The PDFs themselves are the largest transfer. A large or unoptimised PDF is
  the main thing that can make the reader feel slow.
- Canvas rendering caps total pixels and caps device pixel ratio at 2, which
  keeps memory use reasonable on low-power machines.

## Rights and privacy

Reading progress, bookmarks, and preferences live in `localStorage` under
`avadra:library:v2`. User-supplied PDFs live in IndexedDB. There are no accounts,
no analytics, and no network calls except loading local site files.

The interface and editorial notes are original to this project. The novels
remain the property of their respective rights holders. See
`THIRD-PARTY-NOTICES.md` and `notices.html` for software and font licences.
