# Third-party notices

The Wizarding Library combines original interface code with third-party
open-source software. This file records the licences for that software. It is
not legal advice. The Harry Potter novels and their cover art are not covered by
any licence granted by this project.

## Software

### Mozilla PDF.js 4.10.38

- Files: `assets/vendor/pdfjs/pdf.js`, `assets/vendor/pdfjs/pdf.worker.js`
- Copyright: Mozilla Foundation and contributors
- Licence: Apache License 2.0
- Full text: `assets/vendor/pdfjs/LICENSE`
- Project: <https://github.com/mozilla/pdf.js>

The files are the "legacy" ESM distribution of PDF.js, vendored without
modification. They are loaded locally by `assets/js/reader.js`.

### DearFlip 2.5.172 (reader engine)

- Files: `assets/vendor/dearflip/` (`css/dflip.min.css`, `js/dflip.min.js`,
  `js/jquery.min.js`, `js/libs/pdf.min.js`, `js/libs/pdf.worker.min.js`,
  `js/libs/three.min.js`, `sound/turn2.mp3`)
- Copyright: DearFlip / its authors
- Licence: Commercial licence from <https://dearflip.com/> (free for personal,
  non-commercial use); see the terms published by DearFlip. This project does not
  relicense DearFlip.
- Project: <https://dearflip.com/>

The reader in `flipbook.html` loads these files locally via
`window.dFlipLocation`. The bundled `pdf.min.js` is Mozilla PDF.js (Apache 2.0)
and `three.min.js` is three.js (MIT); their upstream notices apply as well.

## Typefaces

Both font families are self-hosted as WOFF2 files and are used under the SIL
Open Font License 1.1. The full licence texts are included under
`assets/fonts/`.

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

The seven PDFs and seven cover images in this working copy are personal files.
They are not part of the open-source software above and are not licensed for
redistribution by this project.

Harry Potter and all related names, characters, publications, and artwork belong
to J. K. Rowling, Bloomsbury, Scholastic, Warner Bros., and their respective
rights holders. This site is an unofficial, non-commercial fan project. It is not
endorsed by or affiliated with any of those rights holders.

Do not publish the PDFs or cover art unless you have the right to do so. The
site's code, layout, and editorial notes are original to this project.
