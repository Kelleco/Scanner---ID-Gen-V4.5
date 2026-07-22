# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project context

**Scanner & ID Gen V4** is a zero-backend, single-page web app for camera-based barcode/QR scanning and sequential ID tagging. See `PRD.md` for the full spec — it is the source of truth for behavior and is more current than any inline comments will be.

At the time of writing, the repo contains only `PRD.md` and this file. The implementation target is a single `index.html` (vanilla JS + Tailwind, no build step, no package manager, deployed to GitHub Pages) plus vendored libraries and PWA assets (`vendor/`, `sw.js`, `manifest.webmanifest`). If you find yourself reaching for a bundler, a framework, or a `package.json`, stop and re-read the PRD — the monolithic-SPA shape is deliberate.

## Architecture notes that aren't obvious from a single file

- **No backend, no build.** All persistence is `localStorage`. The three offline-critical libraries (Tailwind, PapaParse, html5-qrcode) are **vendored under `vendor/`** so the app works offline as a PWA; only Google Fonts still loads from CDN (with a system-font fallback). There is no dev server beyond opening `index.html` (or `python -m http.server` for camera-API testing, since `getUserMedia` requires a secure context — `file://` will not work for camera).
- **PWA / offline support is load-bearing.** `sw.js` precaches the app shell and `manifest.webmanifest` makes it installable; an installed PWA keeps the `https://` origin so the camera works offline. The CSP must keep `manifest-src 'self'` and `worker-src 'self'` (both fall back to `default-src 'none'` and would otherwise block the manifest and service worker). Bump the `CACHE` version in `sw.js` when changing any precached asset, or stale files will be served.
- **Three in-memory tracking Sets are the duplicate-detection contract.** `scannedSet` (QR/Install No), `mappedBarcodeSet` (barcodes), `tagSet` (generated IDs). These are rebuilt from the log on page load and must stay synchronized with the DOM table on every mutation path: scan, manual edit, drag-reorder, delete, clear. The known-issues table in `PRD.md` calls out that edits currently bypass `scannedSet` — be careful not to replicate that pattern elsewhere.
- **Two scan modes, two lookup directions.** QR mode looks up Install No → Barcode in the loaded CSV. Mapped Barcode mode does the reverse and requires two consecutive matching reads before accepting. A scan-mode change must clear any in-flight pending-read state.
- **Editable cells use `innerText`, not `innerHTML`.** This is a load-bearing XSS mitigation, not a style choice. Same for `escHtml()` on any user-controlled value going into the DOM via `innerHTML`/template strings.
- **CSV header matching is case-insensitive and tolerates BOM + trailing commas.** Don't tighten this — real-world CSVs from Excel/Sheets exports hit all three quirks.

## Commands

No build/test/lint tooling is configured yet. When adding any, prefer zero-install options (a single `python -m http.server 8000` for local serving over HTTPS-via-tunnel for camera testing) before introducing Node tooling, and update this section in the same change.

The `PRD.md` "Known Issues" table has no open bugs — it documents the six V2 code-review issues and how each was resolved in V3. Don't reintroduce those patterns; the table is the record of what was deliberately fixed.

---

# Behavioral guidelines

Generic guidelines to reduce common LLM coding mistakes. Merge with the project-specific context above.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
