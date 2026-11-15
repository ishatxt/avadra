# AVADRA

A small, self-contained reading room for the seven Harry Potter novels, built
with plain HTML, CSS, and JavaScript. Each book can be opened in either the
page-flip reader powered by a locally vendored copy of
[DearFlip](https://dearflip.com/) or the quieter
[Foliate-JS](https://github.com/johnfactotum/foliate-js) reader. All engines and
their dependencies are served locally; no request leaves the machine for a
third-party CDN. The site is static and deploys unchanged on GitHub Pages.

There is no framework, package manager, build step, or server-side code.

> This is an unofficial personal project. It is not affiliated with J. K. Rowling,
> Bloomsbury, Scholastic, Warner Bros., or any other rights holder. This
> deployment includes personal copies of the novels and cover art; they remain
> the property of their rights holders and are not offered for reuse.

## What is here

- **A seven-volume catalogue** — the novels in reading order, with series
  numbers, publication years, page counts, descriptions, and curator notes.
- **Two reading rooms** — every Read/Resume control opens a chooser with the
  existing **AVADRA Flipbook** (DearFlip) and the new **Foliate Reader**. Both
  options open in a new tab, so the library stays open, and the chooser appears
  every time rather than remembering a choice.
- **The AVADRA Flipbook** — the familiar DearFlip page-turn reader: two-page
  spreads, animated turns, zoom, search, thumbnails, and fullscreen, served from
  `assets/vendor/dearflip/` at the original `flipbook.html?book=<id>` URLs.
- **The Foliate Reader** — contents, search for reflowable EPUBs, page
  navigation, PDF zoom, themes, font/spacing/margin controls, fullscreen,
  keyboard shortcuts, and local-file opening. Foliate-JS is served from
  `assets/vendor/foliate/`.
- **One shared position** — both readers write one progress record per book, so
  a page left in the flipbook resumes on the same page in Foliate, and vice
  versa. Legacy saved positions keep working.
- **Reader-only appearance settings** — Foliate themes and text controls are
  stored separately from library progress and never inherit homepage state.
- **A plain fallback** — if the flipbook cannot start, it swaps in the browser's
  native PDF view. If a catalogue file is missing, both readers show a direct
  explanation and keep a route back to the library.
- **Local-only personal data** — progress and Foliate settings live in
  `localStorage`. Nothing is sent anywhere.

## Run it locally

The catalogue is loaded with `fetch`, so browsers block it on `file://` URLs.
Serve the folder over HTTP:

```bash
cd HP
python3 -m http.server 8000
```

Then visit:

- <http://localhost:8000/> — the library
- <http://localhost:8000/flipbook.html?book=harry-potter-01-philosophers-stone> — the first book in DearFlip
- <http://localhost:8000/foliate-reader.html?book=harry-potter-01-philosophers-stone> — the first book in Foliate
- <http://localhost:8000/notices.html> — software and rights notices

Any static server works, for example `npx serve .` or `php -S localhost:8000`.
Opening `index.html` by double-clicking shows an explanatory error instead of the
collection.

## Place the seven books

The catalogue expects these exact filenames. The working copy already contains
them; replace a file in place if you have a different edition.

| # | Title | PDF | Cover |
| --- | --- | --- | --- |
| 1 | Harry Potter and the Philosopher's Stone | `books/harry-potter-01-philosophers-stone.pdf` | `assets/covers/harry-potter-01-philosophers-stone.webp` |
| 2 | Harry Potter and the Chamber of Secrets | `books/harry-potter-02-chamber-of-secrets.pdf` | `assets/covers/harry-potter-02-chamber-of-secrets.webp` |
| 3 | Harry Potter and the Prisoner of Azkaban | `books/harry-potter-03-prisoner-of-azkaban.pdf` | `assets/covers/harry-potter-03-prisoner-of-azkaban.webp` |
| 4 | Harry Potter and the Goblet of Fire | `books/harry-potter-04-goblet-of-fire.pdf` | `assets/covers/harry-potter-04-goblet-of-fire.webp` |
| 5 | Harry Potter and the Order of the Phoenix | `books/harry-potter-05-order-of-the-phoenix.pdf` | `assets/covers/harry-potter-05-order-of-the-phoenix.webp` |
| 6 | Harry Potter and the Half-Blood Prince | `books/harry-potter-06-half-blood-prince.pdf` | `assets/covers/harry-potter-06-half-blood-prince.webp` |
| 7 | Harry Potter and the Deathly Hallows | `books/harry-potter-07-deathly-hallows.pdf` | `assets/covers/harry-potter-07-deathly-hallows.webp` |

Rules that keep the catalogue working:

1. **Every path is relative to the site root.** It must begin with `books/` or
   `assets/` and must not start with `/`.
2. **Keep the filename.** If you rename a file, update its `file` value in
   `data/catalogue.json`, or the reader will not find it.
3. **Use a real PDF.** Files with a `.pdf` extension that are not valid PDFs
   cannot be rendered.
4. **Covers are optional.** If a cover is missing, the card keeps its layout and
   shows a deliberate typographic cover instead.
5. **Covers are WebP here** (800 px wide, about 130 KB each). If yours are `.jpg`
   or `.png`, change the `cover` path in the catalogue; no code change is needed.
6. **Format is optional.** Add `"format": "pdf"` or `"format": "epub"` to make
   the chooser's capabilities explicit. Without it, the extension of `file` is
   used. The Foliate Reader can open either format; the flipbook is PDF-only.

This catalogue uses the UK title **Philosopher's Stone**. If your edition says
**Sorcerer's Stone**, change the `title` and the three `coverTitle` lines in the
first record; the PDF and cover filenames can stay as they are.

Do not rename the folders `books/` or `assets/covers/` without updating every
record.

## How the catalogue works

`data/catalogue.json` is the single source of truth for both the homepage and
the reader. Each record looks like this:

```json
{
  "id": "harry-potter-01-philosophers-stone",
  "title": "Harry Potter and the Philosopher's Stone",
  "coverTitle": ["Harry Potter", "and the", "Philosopher's Stone"],
  "author": "J. K. Rowling",
  "series": "Harry Potter",
  "seriesNumber": 1,
  "year": 1997,
  "category": "Harry Potter",
  "summary": "One or two sentences for the card.",
  "description": "A longer spoiler-light description for the details dialog.",
  "curatorNote": "A short editorial note.",
  "cover": "assets/covers/harry-potter-01-philosophers-stone.webp",
  "file": "books/harry-potter-01-philosophers-stone.pdf",
  "format": "pdf",
  "pages": 231,
  "readingMinutes": 350,
  "editionContents": "The complete novel",
  "source": { "name": "Personal copy", "ebook": null, "url": "" },
  "license": "Personal copy — not for redistribution",
  "addedAt": "2026-10-25",
  "featured": true
}
```

Required fields: `id`, `title`, `author`, `category`, and `file`. Everything
else is optional and is omitted gracefully if absent.

Useful details:

- **Reading order** uses `seriesNumber`; the default sort is reading order.
- **`coverTitle`** supplies the fallback tile's three lines. Keep each line short.
- **`pages`** and **`readingMinutes`** are optional. If omitted, the interface
  says the length is unlisted instead of printing `undefined`.
- **`format`** is optional. `pdf` enables both readers; `epub` enables Foliate
  only. If omitted, `catalogue.js` derives it from the `file` extension.
- **`featured`** puts one book on the night desk. If none is marked, the first
  record is used.
- **`nightShelf`** at the top of the JSON lists three IDs for the hero shelf.
- **`categories`** at the top of the JSON declares the filter chips. This copy
  uses one category, `Harry Potter`.

After editing the JSON, validate it before reloading:

```bash
python3 -m json.tool data/catalogue.json > /dev/null && echo "JSON OK"
```

## How the readers work

Every **Read** or **Resume** link opens the reader chooser. It shows both
options each time and is never remembered. Each option has
`target="_blank"`, so the library tab stays where it was.

### AVADRA Flipbook — DearFlip

`flipbook.html?book=<id>` is unchanged. It looks the book up in the catalogue
for the header title, then creates a DearFlip element pointed at
`books/<id>.pdf`.

- `window.dFlipLocation` must be set before `dflip.min.js` loads so DearFlip
  requests its own scripts, worker, and sound from `assets/vendor/dearflip/`
  rather than a CDN.
- The book element is created only after its `source` is set, because DearFlip
  caches the parsed state of an element and will not re-read a later source.
- A loading screen covers the first paint and disappears when the page counter
  appears. If that has not happened after about 25 seconds, the native PDF view
  is shown instead.
- The current page is written to the shared `localStorage` record the homepage
  reads, so resume links stay accurate across both readers.

### Foliate Reader — Foliate-JS

`foliate-reader.html?book=<id>` loads `data/catalogue.json`, finds the record,
derives its format from `format` or the file extension, and opens exactly that
file through Foliate's `view.open()`. The controller lives in
`assets/js/foliate-reader.js`; the shell and styling are in
`foliate-reader.html` and `assets/css/reader.css`.

- **Lazy by design.** Only the selected edition is fetched. Foliate imports its
  PDF.js adapter for PDFs and its EPUB/paginator modules for EPUBs on demand.
- **PDFs** use the fixed-layout renderer: contents, previous/next page, page
  slider, zoom (fit page, fit width, 100–200%), fullscreen, and night/sepia page
  filters. PDF themes are CSS filters over the page, so images are inverted in
  night mode rather than recoloured by the publisher.
- **Reflowable EPUBs** use the paginator: contents, search, font family, font
  size, line spacing, margins, justification, hyphenation, themes, paginated or
  scrolled layout, fullscreen, and keyboard navigation.
- **Search** is intentionally unavailable for PDFs. Foliate's PDF adapter has no
  `createDocument()`, so there is nothing safe to search. The panel says so and
  points to the flipbook's search. Reflowable EPUB search uses Foliate's real
  search engine and CFI results.
- **Fixed-layout EPUBs** keep their publisher's page colours; zoom remains
  available, while reflow-only controls are disabled with an explanatory note.
- **Local books** can be chosen from the empty state or dropped onto the reader
  (EPUB, PDF, MOBI, AZW3, FB2, CBZ). Local books are not added to the catalogue
  and do not write progress, because they have no catalogue identity.
- **Settings** are stored separately under `avadra-foliate:v1`. They are global
  to the Foliate reader, never inherited from the homepage, and never touch the
  shared reading position.

### Shared progress

Both readers write one record per book under `avadra-library:v1`:

```json
{
  "page": 42,
  "totalPages": 222,
  "fraction": 0.189,
  "kind": "pdf",
  "engine": "foliate",
  "updatedAt": "2026-11-15T12:00:00.000Z"
}
```

- **PDFs** use `page` and `totalPages`. The Foliate reader reports the first
  page of the current fixed-layout spread, which is the closest equivalent to
  DearFlip's counter when two pages are visible at once.
- **EPUBs** add `cfi` and `fraction`, set `kind: "epub"`, and clear stale PDF
  page fields. Reopening the same edition restores the CFI and falls back to
  the normalised fraction if the CFI no longer resolves.
- **Legacy records** containing only `page`, `totalPages`, and `updatedAt`
  remain valid. Writers preserve unknown fields and skip redundant writes.
- Saves are debounced during page turns and flushed on `pagehide` /
  `visibilitychange`, so closing the tab immediately still keeps the place.

### Security

`foliate-reader.html` sends a restrictive meta Content Security Policy:
scripts only from `'self'`, frames only from `blob:`/`data:`, workers only from
`'self'`/`blob:`, no objects, and no remote connections. EPUB bodies are
rendered in Foliate's iframes, which need `allow-scripts` for WebKit event
support; the CSP is the script boundary. EPUB scripted content is not executed.
No EPUB is trusted by default.

## Project structure

```text
HP/
├── index.html                 Homepage and catalogue shell
├── flipbook.html              DearFlip reader (reads ?book=<id>)
├── foliate-reader.html        Foliate reader shell (reads ?book=<id>)
├── notices.html               Third-party licences and rights
├── 404.html                   GitHub Pages not-found page
├── data/catalogue.json        Seven catalogue records
├── books/                     Seven PDFs served with the site
├── assets/
│   ├── covers/                Seven WebP cover images
│   ├── css/                   base.css, library.css, pages.css, reader.css
│   ├── fonts/                 Self-hosted WOFF2 subsets and licences
│   ├── js/                    app.js, catalogue.js, storage.js, foliate-reader.js
│   ├── vendor/dearflip/       Local DearFlip: css, js + libs, sound
│   ├── vendor/foliate/        Foliate-JS, PDF.js, zip.js, fflate, licences
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

Both readers use relative URLs, and Foliate's PDF.js worker, EPUB modules, and
fonts are served from the same origin. The CSP in `foliate-reader.html` allows
local module workers and blob-based EPUB frames but no remote scripts. GitHub
Pages does not send custom headers, so this page-level policy is the security
boundary for the Foliate reader.

**The books are part of this deployment.** The seven PDFs in `books/` and the
covers in `assets/covers/` are committed and served publicly by GitHub Pages. If
you fork or redeploy the site, make sure you have the right to redistribute
them. If a PDF is absent, both readers show a direct notice; if DearFlip fails
for another reason, it falls back to the browser's PDF viewer.

## Checks

With the local server running, these are the checks used for this copy:

```bash
cd HP
python3 -m http.server 8000
python3 -m json.tool data/catalogue.json > /dev/null && echo "JSON OK"
node --check assets/js/foliate-reader.js
```

Then in a browser:

1. Load the homepage and confirm the ledger says **Seven novels** and the
   collection shows exactly seven cards.
2. Search for `Azkaban`, filter by **Harry Potter**, and sort by **Reading
   order**.
3. Choose **Read** on any card. The chooser must appear every time, show both
   **AVADRA Flipbook** and **Foliate Reader**, and open the chosen reader in a
   new tab while leaving the library tab open. Close and reopen the chooser for
   another book to confirm it is not remembered.
4. In the flipbook, turn a page, return to the library, and confirm the resume
   label. Open the same book in the Foliate Reader: it must resume on the same
   PDF page (or the first page of the same spread).
5. Turn a page in Foliate, return to the library, and reopen the flipbook. The
   DearFlip page counter must show the page Foliate saved.
6. Open all seven PDFs in Foliate. Each should show its title, a contents list,
   a page count, the loading overlay should clear, and PDF search should be
   disabled with the explanatory note.
7. Open a reflowable EPUB through the catalogue (temporarily add a test record)
   or with **Open a local book**. Check contents, search, CFI/fraction
   persistence, font/spacing/margins/layout controls, themes, and scrolled
   layout. Local books should not write library progress.
8. Check a narrow window (390 px): the homepage navigation collapses, the
   chooser stacks, the Foliate sidebar stays within 88vw, the settings panel
   becomes a fixed sheet, and neither page scrolls sideways.
9. Check the keyboard: `←`/`→` and `h`/`l` turn pages, `t` opens contents, `s`
   opens search, `f` toggles fullscreen, and `Escape` closes panels.
10. Temporarily rename one PDF and open that book in both readers. Both should
    show a direct missing-file notice instead of hanging; Foliate should offer
    the flipbook fallback. Rename it back afterwards.
11. Keep the browser console open while testing. There should be no uncaught
    page errors, CSP violations, or failed local module requests. The expected
    warnings are Foliate's sandbox notice for EPUB iframes and intentional
    console errors for deliberately broken test routes.
12. Open `notices.html` and `404.html` (or any unknown path) to confirm both
    render with the site styling.

### GitHub Pages checklist

- `.nojekyll` is present at the repository root.
- All paths in `data/catalogue.json` are relative and begin with `books/` or
  `assets/`.
- `assets/vendor/foliate/` is uploaded in full, including `vendor/pdfjs/`,
  `vendor/zip.js`, `vendor/fflate.js`, and the licence files.
- The deployed site is opened over HTTPS (or localhost), so Web Crypto and
  module workers are available.
- Test one PDF URL and one EPUB URL on the project subpath, not just the root.
- The browser console is clean on the published URL; if it is not, check that
  `.mjs` and `.woff2` files were uploaded and that the host is not rewriting
  paths.
- The repository stays under GitHub Pages limits (1 GB recommended repository
  size, 100 MB per file).

## Performance notes

- Covers are WebP at 800 px wide; the catalogue's images are lazy-loaded except
  the featured card, which is eager and marked high priority.
- The homepage ships three small ES modules and two CSS files. Each reader is
  loaded only when chosen; neither reader fetches the other engine.
- The Foliate bundle is about 5.7 MB on disk, but its PDF.js adapter is imported
  only for PDFs and its EPUB/paginator modules only for EPUBs. Source maps were
  removed. Only the selected edition is fetched, and the reader keeps one book
  open at a time.
- Foliate releases the renderer, book, cached cover URL, and search overlays
  when switching editions. Progress writes are debounced; page turns do not
  trigger a synchronous storage write on every relocation.
- Fonts are self-hosted, preloaded where they matter, and reduced to the weights
  the design uses (400–500) and a Latin glyph set. All four faces together are
  about 90 KB, down from roughly 265 KB. No third-party connection is needed.
- The PDFs themselves are the largest transfer. Foliate's fixed-layout renderer
  draws pages on demand, so the first page can appear before the whole book has
  been rasterised. A missing or unoptimised PDF is the main thing that can make
  the reader feel slow.

## Rights and privacy

Reading progress lives in `localStorage` under `avadra-library:v1`. Foliate
appearance settings live under `avadra-foliate:v1`. There are no accounts, no
analytics, and no network calls except loading local site files.

The interface and editorial notes are original to this project. The novels and
cover art remain the property of their respective rights holders. See
`THIRD-PARTY-NOTICES.md` and `notices.html` for software and font licences.
