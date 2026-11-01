# The Wizarding Library

A small, self-contained reading room for the seven Harry Potter novels, built
with plain HTML, CSS, and JavaScript. Books open in a page-flip reader powered by
a locally vendored copy of [DearFlip](https://dearflip.com/) (which bundles
Mozilla PDF.js and three.js), and the site deploys as a static site on GitHub
Pages. No request leaves the machine for a third-party CDN.

There is no framework, package manager, build step, or server-side code.

> This is an unofficial personal project. It is not affiliated with J. K. Rowling,
> Bloomsbury, Scholastic, Warner Bros., or any other rights holder. The PDFs and
> cover images are personal copies; do not publish or redistribute them unless you
> have the right to do so.

## What is here

- **A seven-volume catalogue** — the novels in reading order, with series
  numbers, publication years, page counts, descriptions, and curator notes.
- **A page-flip reader** — every catalogue link opens `flipbook.html`, which
  builds a DearFlip book for that PDF: two-page spread, animated page turns,
  zoom, search, thumbnails, and fullscreen. All DearFlip assets (scripts, worker,
  page-turn sound) are served from `assets/vendor/dearflip/`.
- **Resume reading** — the flipbook stores the page it last showed, and the
  homepage's resume links reopen that page.
- **A plain fallback** — if the flipbook fails to start, the reader swaps in the
  browser's native PDF view for the same file.
- **Optional reading music** — *Hegwid’s Theme* loops from the legacy reader
  header, with play/pause, a seek bar, and a saved volume level.
- **A resilient catalogue** — a missing cover falls back to a typographic tile,
  and a missing PDF falls back to the browser's native viewer rather than
  failing silently.
- **Local-only personal data** — progress, bookmarks, and display preferences
  are kept in one `localStorage` key. Nothing is sent anywhere.

## Run it locally

The catalogue is loaded with `fetch`, and the reader is an ES module. Browsers
block both on `file://` URLs, so serve the folder over HTTP:

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
| 1 | Harry Potter and the Philosopher's Stone | `books/harry-potter-01-philosophers-stone.pdf` | `assets/covers/harry-potter-01-philosophers-stone.jpg` |
| 2 | Harry Potter and the Chamber of Secrets | `books/harry-potter-02-chamber-of-secrets.pdf` | `assets/covers/harry-potter-02-chamber-of-secrets.jpg` |
| 3 | Harry Potter and the Prisoner of Azkaban | `books/harry-potter-03-prisoner-of-azkaban.pdf` | `assets/covers/harry-potter-03-prisoner-of-azkaban.jpg` |
| 4 | Harry Potter and the Goblet of Fire | `books/harry-potter-04-goblet-of-fire.pdf` | `assets/covers/harry-potter-04-goblet-of-fire.jpg` |
| 5 | Harry Potter and the Order of the Phoenix | `books/harry-potter-05-order-of-the-phoenix.pdf` | `assets/covers/harry-potter-05-order-of-the-phoenix.jpg` |
| 6 | Harry Potter and the Half-Blood Prince | `books/harry-potter-06-half-blood-prince.pdf` | `assets/covers/harry-potter-06-half-blood-prince.jpg` |
| 7 | Harry Potter and the Deathly Hallows | `books/harry-potter-07-deathly-hallows.pdf` | `assets/covers/harry-potter-07-deathly-hallows.jpg` |

Rules that keep the catalogue working:

1. **The PDF path is relative to the site root.** It must begin with `books/`
   and must not start with `/`.
2. **Keep the filename.** If you rename a file, update its `file` value in
   `data/catalogue.json`, or the reader will report that the book has not been
   added yet.
3. **Use a real PDF.** Files with a `.pdf` extension that are not valid PDFs
   produce a readable error in the reader.
4. **Covers are optional.** If a cover is missing, the card keeps its layout and
   shows a deliberate typographic cover instead.
5. **Covers use `.jpg` here.** If yours are `.png` or `.webp`, change the `cover`
   path in the catalogue; no code change is needed.

This catalogue uses the UK title **Philosopher's Stone**. If your edition says
**Sorcerer's Stone**, change the `title` and the three `coverTitle` lines in the
first record; the PDF and cover filenames can stay as they are.

Do not rename the folders `books/` or `assets/covers/` without updating every
record and the fallback instructions in the README.

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
  "cover": "assets/covers/harry-potter-01-philosophers-stone.jpg",
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

## Reading music

The legacy reader (`reader.html`) includes an optional, looping background track
at `assets/music/hegwids-theme.mp3`. Open the music note in that reader's header
to play or pause it, drag the timeline to seek, and adjust the volume slider. The
volume is remembered with the other reader settings.

Browsers do not allow audio to start before a user gesture, so the track never
autoplays. Press `P` once a book is open to toggle playback. To use a different
track, either replace that file or update the `<audio>` source in
`reader.html`. The DearFlip reader does not use this track; it plays its own
page-turn sound from `assets/vendor/dearflip/sound/`.

## Missing covers and PDFs

The homepage does not check that files exist before rendering. This keeps it
fast. Instead:

- A broken or absent cover image is hidden, and the card switches to the
  typographic fallback tile.
- A PDF is only requested when a volume is opened. If it is missing, DearFlip
  cannot start; after roughly 25 seconds the reader swaps in the browser's
  native PDF view, which reports the missing file in the usual browser way.
- A file:// page and an unreachable catalogue each have their own plain-language
  error state.

## Publish on GitHub Pages

The site uses relative paths and includes `.nojekyll`, so it can be served from a
repository root or a project subpath.

1. Push the site files to a repository.
2. In **Settings → Pages**, choose the branch and the root folder.
3. Open the published URL.

**Before publishing, decide about the books.** GitHub Pages is public. The
repository includes a `.gitignore` that keeps `books/*.pdf` out of Git by default,
so the published site will not have the novels until you add the PDFs privately
or accept that they will be public. Do not commit or publish the novels or cover
art unless you have the right to do so.

## Project structure

```text
HP/
├── index.html                 Homepage and catalogue shell
├── flipbook.html              Default DearFlip reader (reads ?book=<id>)
├── reader.html                Legacy custom PDF.js reader
├── data/catalogue.json        Seven catalogue records
├── books/                     Seven personal PDFs (ignored by Git)
├── assets/
│   ├── covers/                Seven cover images
│   ├── music/                 hegwids-theme.mp3 (legacy reader music)
│   ├── css/                   base.css, library.css, reader.css
│   ├── fonts/                 Self-hosted WOFF2 files and licences
│   ├── js/                    app.js, catalogue.js, reader.js, storage.js
│   ├── vendor/pdfjs/          Local PDF.js 4.10.38 (legacy reader)
│   ├── vendor/dearflip/       Local DearFlip: css, js + libs, sound
│   ├── favicon.svg
│   └── icons.svg
├── README.md
├── THIRD-PARTY-NOTICES.md
└── .nojekyll
```

## Checks

With the local server running:

1. Load the homepage and confirm the ledger says **Seven novels** and the
   collection shows exactly seven cards.
2. Search for `Azkaban`, filter by **Harry Potter**, and sort by **Reading order**.
3. Open a details dialog and start reading. The flipbook should show the cover
   with a `1/…` page counter; turn a page, try search and fullscreen, and return
   to the library with the back link.
4. Open `reader.html?book=harry-potter-01-philosophers-stone` for the legacy
   reader, press play in the music panel, and confirm the volume is remembered
   after a reload.
5. Temporarily rename one PDF and open that book. The flipbook cannot start, so
   after about 25 seconds the native PDF view appears with the browser's own
   missing-file message. Rename it back afterwards.
6. Check a narrow window: the navigation collapses, the cards stack, and the
   flipbook toolbar remains usable.

## Rights and privacy

Reading progress, bookmarks, and display preferences live in
`localStorage` under a single key owned by this site. There are no accounts, no
analytics, and no network calls except loading local site files.

The interface and editorial notes are original to this project. The novels and
cover art remain the property of their respective rights holders. See
`THIRD-PARTY-NOTICES.md` for software and font licences.
