# The Wizarding Library

A small, self-contained reading room for the seven Harry Potter novels, built
with plain HTML, CSS, and JavaScript. Books open in a page-flip reader powered
by a locally vendored copy of [DearFlip](https://dearflip.com/), which bundles
Mozilla PDF.js and three.js. The site is static and deploys unchanged on GitHub
Pages; no request leaves the machine for a third-party CDN.

There is no framework, package manager, build step, or server-side code.

> This is an unofficial personal project. It is not affiliated with J. K. Rowling,
> Bloomsbury, Scholastic, Warner Bros., or any other rights holder. This
> deployment includes personal copies of the novels and cover art; they remain
> the property of their rights holders and are not offered for reuse.

## What is here

- **A seven-volume catalogue** — the novels in reading order, with series
  numbers, publication years, page counts, descriptions, and curator notes.
- **A page-flip reader** — every catalogue link opens `flipbook.html`, which
  builds a DearFlip book for that PDF: two-page spread, animated page turns,
  zoom, search, thumbnails, and fullscreen. All DearFlip assets are served from
  `assets/vendor/dearflip/`.
- **Resume reading** — the flipbook stores the page it last showed, and the
  homepage's resume links reopen that page.
- **A plain fallback** — if the flipbook cannot start, the reader swaps in the
  browser's native PDF view for the same file.
- **A resilient catalogue** — a missing cover falls back to a typographic tile,
  and a missing PDF falls back to the browser's native viewer instead of failing
  silently.
- **Local-only personal data** — reading progress lives in one `localStorage`
  key. Nothing is sent anywhere.

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
- **`featured`** puts one book on the night desk. If none is marked, the first
  record is used.
- **`nightShelf`** at the top of the JSON lists three IDs for the hero shelf.
- **`categories`** at the top of the JSON declares the filter chips. This copy
  uses one category, `Harry Potter`.

After editing the JSON, validate it before reloading:

```bash
python3 -m json.tool data/catalogue.json > /dev/null && echo "JSON OK"
```

## How the reader works

`flipbook.html?book=<id>` looks the book up in the catalogue for the header
title, then creates a DearFlip element pointed at `books/<id>.pdf`.

- `window.dFlipLocation` must be set before `dflip.min.js` loads so DearFlip
  requests its own scripts, worker, and sound from `assets/vendor/dearflip/`
  rather than a CDN.
- The book element is created only after its `source` is set, because DearFlip
  caches the parsed state of an element and will not re-read a later source.
- A loading screen covers the first paint and disappears when the page counter
  appears. If that has not happened after about 25 seconds, the native PDF view
  is shown instead.
- The current page is written to the same `localStorage` key the homepage reads,
  so the resume links stay accurate.

## Project structure

```text
HP/
├── index.html                 Homepage and catalogue shell
├── flipbook.html              Default DearFlip reader (reads ?book=<id>)
├── notices.html               Third-party licences and rights
├── 404.html                   GitHub Pages not-found page
├── data/catalogue.json        Seven catalogue records
├── books/                     Seven PDFs served with the site
├── assets/
│   ├── covers/                Seven WebP cover images
│   ├── css/                   base.css, library.css, pages.css
│   ├── fonts/                 Self-hosted WOFF2 subsets and licences
│   ├── js/                    app.js, catalogue.js, storage.js
│   ├── vendor/dearflip/       Local DearFlip: css, js + libs, sound
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

**The books are part of this deployment.** The seven PDFs in `books/` and the
covers in `assets/covers/` are committed and served publicly by GitHub Pages. If
you fork or redeploy the site, make sure you have the right to redistribute
them. If a PDF is absent, the reader shows a direct notice; if DearFlip fails for
another reason, it falls back to the browser's PDF viewer.

## Checks

With the local server running:

1. Load the homepage and confirm the ledger says **Seven novels** and the
   collection shows exactly seven cards.
2. Search for `Azkaban`, filter by **Harry Potter**, and sort by **Reading order**.
3. Open a details dialog and start reading. The flipbook should show the cover
   with a `1/…` page counter; turn a page and return to the library.
4. Reload the homepage and confirm the resume link returns to the page you left.
5. Temporarily rename one PDF and open that book. After about 25 seconds the
   native PDF view appears with the browser's own missing-file message. Rename it
   back afterwards.
6. Check a narrow window: the navigation collapses, the cards stack, and the
   flipbook toolbar remains usable.
7. Open `notices.html` and `404.html` (or any unknown path) to confirm both render
   with the site styling.

## Performance notes

- Covers are WebP at 800 px wide; the catalogue's images are lazy-loaded except
  the featured card, which is eager and marked high priority.
- The homepage ships three small ES modules and two CSS files. The reader is the
  only page that loads the DearFlip engine, and its vendor scripts are preloaded
  from the page head.
- Fonts are self-hosted, preloaded where they matter, and reduced to the weights
  the design uses (400–500) and a Latin glyph set. All four faces together are
  about 90 KB, down from roughly 265 KB. No third-party connection is needed.
- The PDFs themselves are the largest transfer. A missing or unoptimised PDF is
  the main thing that can make the reader feel slow.

## Rights and privacy

Reading progress lives in `localStorage` under a single key owned by this site.
There are no accounts, no analytics, and no network calls except loading local
site files.

The interface and editorial notes are original to this project. The novels and
cover art remain the property of their respective rights holders. See
`THIRD-PARTY-NOTICES.md` and `notices.html` for software and font licences.
