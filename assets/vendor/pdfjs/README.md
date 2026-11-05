# PDF.js

A locally vendored copy of Mozilla PDF.js 3.11.174.

- `pdf.min.js` — the browser build, exposing `window.pdfjsLib`.
- `pdf.worker.min.js` — the worker script.
- `LICENSE` — the Apache License 2.0.

The reader resolves both script paths relative to `assets/js/reader.js`, so the
site works under a GitHub Pages project path without a build step or a CDN.

Upstream: <https://github.com/mozilla/pdf.js>
