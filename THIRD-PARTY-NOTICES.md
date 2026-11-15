# Third-party notices

AVADRA combines original interface code with third-party
open-source software. This file records the licences for that software. It is
not legal advice. The Harry Potter novels and their cover art are not covered by
any licence granted by this project.

The same notices are published as `notices.html`.

## Software

### DearFlip 2.5.172 — page-flip engine

- Files: `assets/vendor/dearflip/` (`css/dflip.min.css`, `js/dflip.min.js`,
  `js/jquery.min.js`, `js/libs/pdf.min.js`, `js/libs/pdf.worker.min.js`,
  `js/libs/three.min.js`, `sound/turn2.mp3`)
- Copyright: DearFlip and its authors
- Licence: commercial licence from <https://dearflip.com/> (free for personal,
  non-commercial use); see the terms published by DearFlip. This project does
  not relicense DearFlip.
- Project: <https://dearflip.com/>

The AVADRA Flipbook in `flipbook.html` loads these files locally via
`window.dFlipLocation`.

### Foliate-JS — EPUB and PDF reading engine

- Files: `assets/vendor/foliate/` (including `view.js`, `epub.js`,
  `epubcfi.js`, `paginator.js`, `fixed-layout.js`, `pdf.js`, `search.js`,
  `progress.js`, `overlayer.js`, `ui/`, and the vendored dependencies listed
  below)
- Copyright: John Factotum and contributors
- Licence: MIT
- Full text: `assets/vendor/foliate/LICENSE`
- Project: <https://github.com/johnfactotum/foliate-js>

Foliate-JS is vendored from upstream and used by `foliate-reader.html`. The
AVADRA controller in `assets/js/foliate-reader.js` is original project code.
The vendored PDF adapter contains a small null-destination guard for PDFs whose
outlines include headings without links; no other functional changes were made.

### Mozilla PDF.js

Two separate copies are served:

- DearFlip's bundled copy: `assets/vendor/dearflip/js/libs/pdf.min.js` and
  `pdf.worker.min.js`.
- Foliate's copy: `assets/vendor/foliate/vendor/pdfjs/` (`pdf.mjs`,
  `pdf.worker.mjs`, `cmaps/`, `standard_fonts/`, and layer stylesheets).
- Copyright: Mozilla Foundation and contributors
- Licence: Apache License 2.0
- Full text: `assets/vendor/foliate/vendor/pdfjs/LICENSE` (Foliate copy); the
  DearFlip copy carries its own bundled notice.
- Project: <https://github.com/mozilla/pdf.js>

### zip.js

- File: `assets/vendor/foliate/vendor/zip.js`
- Copyright: Gildas Lormeau
- Licence: BSD 3-Clause
- Full text: `assets/vendor/foliate/vendor/LICENSE-zip.js.txt`
- Project: <https://github.com/gildas-lormeau/zip.js>

Used by Foliate to read EPUB, FBZ, and CBZ archives locally.

### fflate

- File: `assets/vendor/foliate/vendor/fflate.js`
- Copyright: Arjun Barrett
- Licence: MIT
- Full text: `assets/vendor/foliate/vendor/LICENSE-fflate.txt`
- Project: <https://github.com/101arrowz/fflate>

Used by Foliate's MOBI/AZW3 support.

### three.js

- File: `assets/vendor/dearflip/js/libs/three.min.js`
- Copyright: three.js authors
- Licence: MIT
- Project: <https://threejs.org/>

### jQuery

- File: `assets/vendor/dearflip/js/jquery.min.js`
- Copyright: OpenJS Foundation and other contributors
- Licence: MIT
- Project: <https://jquery.com/>

## Typefaces

Both font families are self-hosted as WOFF2 files and are used under the SIL
Open Font License 1.1. The full licence texts are included under
`assets/fonts/`. The files are reduced subsets of the original families (Latin
glyphs, weights 400–500) and remain under the same licence.

### Ibarra Real Nova

- Files: `assets/fonts/ibarra-real-nova-normal.woff2`,
  `assets/fonts/ibarra-real-nova-italic.woff2`
- Copyright: The Ibarra Real Nova Project Authors
- Licence: SIL Open Font License 1.1
- Full text: `assets/fonts/OFL-IbarraRealNova.txt`
- Source: <https://github.com/googlefonts/ibarrareal>

### Literata

- Files: `assets/fonts/literata-normal.woff2`,
  `assets/fonts/literata-italic.woff2`
- Copyright: The Literata Project Authors / TypeTogether
- Licence: SIL Open Font License 1.1
- Full text: `assets/fonts/OFL-Literata.txt`
- Source: <https://github.com/googlefonts/literata>

## Book files and cover images

The seven PDFs and seven cover images served with this site are personal copies.
They are not covered by the open-source software above and are not offered for
reuse or redistribution.

Harry Potter and all related names, characters, publications, and artwork belong
to J. K. Rowling, Bloomsbury, Scholastic, Warner Bros., and their respective
rights holders. This site is an unofficial, non-commercial fan project. It is not
endorsed by or affiliated with any of those rights holders.

If you copy or redeploy this site, do not republish the novels or cover art
unless you have the right to do so. The site's code, layout, and editorial notes
are original to this project.
