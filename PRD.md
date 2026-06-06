# Product Requirements Document: Scanner & ID Gen V4.5

## Overview

**Scanner & ID Gen** is a browser-based, zero-backend inventory scanning and sequential tagging application. It enables technicians or warehouse staff to scan physical items via a device camera, auto-assign sequential ID tags, look up items in a reference CSV database, and export a complete scan log as CSV. All data stays in the browser — no server, no login required.

**Platform:** Single-page application (HTML + vanilla JS + Tailwind CSS)  
**Deployment:** GitHub Pages (static hosting)  
**Source file:** `index.html` (monolithic SPA, ~1,950 lines)

---

## Problem Statement

Field technicians need to rapidly tag physical assets (e.g., equipment with install numbers) with unique sequential IDs, cross-reference them against a known barcode database, and produce a clean CSV for downstream systems. Existing tools require server infrastructure, native apps, or manual spreadsheet entry. This tool runs entirely in the browser with camera access.

---

## User Personas

| Persona | Role | Environment |
|---|---|---|
| Primary | Warehouse / inventory technician | Mobile device on-site, camera available |
| Secondary | Asset tagging specialist | Laptop with webcam, office/field |

---

## Core User Flow

```
Load CSV database → Configure ID format → Start camera → Scan item
→ Auto-generate Tag ID → Look up barcode in CSV → Log row added
→ Repeat → Review / reorder log → Export CSV
```

---

## Feature Requirements

### 1. QR / Barcode Scanner

- Real-time camera scanning via HTML5 QrCode library
- **Dual scan-destination modes** (toggle button):
  - **QR Mode (→ Install No):** Scans QR codes or install numbers; auto-looks up matching barcode in loaded CSV. Values **not found in the CSV are rejected** — no row is added and no sequential ID is consumed (orange toast)
  - **Mapped Barcode Mode (→ Mapped Barcode):** Scans barcodes directly; uses an N-consecutive-read confirmation buffer (currently 2 identical reads, format-filtered to CODE 39) before accepting — error-correction against single-frame misreads. A non-matching read resets the buffer
- Manual text input fallback (Enter to submit), with an optional **Tag** override field positioned directly above it (see §2)
- Zoom slider (1×–4×); uses hardware zoom on Android Chrome
- Haptic feedback (Vibration API) on successful scan
- 1.5–3s cooldown between scan events to prevent duplicate triggers
- Camera auto-stops when tab is hidden (Page Visibility API)
- Dot-progress indicator (filled/empty indigo circles, one per required read) shown during error-correction accumulation; resets if a non-matching read interrupts the buffer or on scan-mode change

### 2. Sequential ID Generation

- Configurable fields:
  - **Prefix** — 0–10 characters, auto-uppercased
  - **Start #** — either an integer ≥ 0 (numeric mode, default: 1) **or** a lowercase letter sequence (alpha mode)
  - **Min Digits** — zero-padding width 1–10 (default: 1); auto-set to 0 and disabled while in alpha mode
  - **DEC** — checkbox justified right of the ID Format heading; when checked, the sequence counts *down* toward its floor instead of up
- Live preview of next ID to be generated (e.g., `RS001`)
- **Numeric vs. alpha mode:** if Start # is a lowercase letter, IDs increment alphabetically Excel-style (`a → b → … → z → aa → ab …`); any letters typed into Start # are forced lowercase. Otherwise IDs increment numerically with zero-padding
- **Descending (DEC):** when enabled, the sequence decrements toward its floor — `1` in numeric mode, `'a'` in alpha mode — and stays at the floor once reached
- Auto-increments (or decrements) on each accepted scan
- Skips any ID already present in the log (no duplicates)
- **Manual Tag override:** an optional Tag input (shown above the manual value input). When a value is entered, it is used as the Tag for the next entry instead of an auto-generated ID, and **no sequential number is consumed** (the next-ID preview is unaffected, so the following normal entry still gets the expected sequential ID). Applies to manual Add **and** live camera scans in both QR and Mapped Barcode modes. The field is cleared after each entry; a typed Tag that duplicates an existing one is rejected (orange toast)

### 3. CSV Database Integration

- Load reference data via **local file picker** (native `<input type="file">`)
- Required CSV columns: `Install No.` and `Barcode` (case-insensitive, handles trailing commas and BOM)
- On QR scan: looks up Install No → retrieves Barcode
- On Barcode scan: looks up Barcode → retrieves Install No
- Status badge shows: `Loaded: X Records (filename)` or error description
- CSV data persisted to `localStorage` and auto-restored on reload

### 4. Activity Log (Scan Results Table)

**Columns:** Tag (ID) · QR (Install No) · Mapped Barcode · Delete

- Rows prepended (newest first)
- All data cells are **inline-editable** (`contenteditable`)
- **Duplicate validation on edit:**
  - Tag ID: must be unique; reverts if duplicate detected
  - Mapped Barcode: must be unique (except `NOT FOUND` placeholder)
- **Drag-and-drop reordering** (mouse on desktop, touch on mobile)
- **Column sorting:** click header to sort ascending/descending; numeric-aware comparison
- **Soft delete:** inline "Sure?" confirmation, auto-cancels after 3 seconds
- In **Mapped Barcode mode**, items with no CSV match are logged with `NOT FOUND` (styled red italic); in **QR mode** a value with no CSV match is rejected instead (no row added — see §1)
- Empty state: "No items scanned yet." sentinel row
- All changes auto-saved to `localStorage`

### 5. Export

- "Download" button — exports the current scan log as a CSV in a single click (no dialog)
- Default filename: `scan_log_YYYY-MM-DD.csv`
- Modern browsers (Chrome/Edge): native Save dialog via File System Access API (`showSaveFilePicker`)
- Fallback: standard anchor download (Firefox/Safari/mobile)
- CSV format: quoted fields, comma-separated, header row (`Tag,QR,Barcode`)

### 6. Data Persistence

| Key | Contents |
|---|---|
| `qrtag_log` | JSON array of scan log rows |
| `qrtag_csv_text` | Raw CSV text of loaded database |
| `qrtag_csv_name` | Filename of loaded CSV |

- Data restored automatically on page reload
- Order of rows (including drag-and-drop sequence) preserved

### 7. Clear History

- Button with confirmation modal
- Clears all log rows, in-memory tracking sets, and `localStorage` log entry
- Preserves loaded CSV database and ID settings

### 8. Offline Support (PWA)

- Installable as a Progressive Web App ("Add to Home screen") on Android Chrome
- A service worker (`sw.js`) precaches the full app shell on first visit:
  `index.html`, the manifest, the three vendored libraries, and the app icons
- After install, the app launches and runs **fully offline** — including the
  camera, because the installed PWA keeps the `https://` origin (a secure
  context required by `getUserMedia`)
- The offline-critical libraries (Tailwind, PapaParse, html5-qrcode) are
  **vendored under `vendor/`** rather than loaded from a CDN, so the cache is
  same-origin and the install fails loudly rather than caching broken assets
- Google Fonts remain on CDN; offline they degrade gracefully to system fonts
- Cache is versioned (`scanner-id-v1`); bump the version to ship a shell update

---

## Validation Rules

| Field | Rule |
|---|---|
| Tag ID (edit) | Must not already exist in log |
| Tag override (manual) | Must be unique; rejected if already in `tagSet` |
| Mapped Barcode (edit) | Must not already exist in log (except `NOT FOUND`) |
| QR scan | Rejected if already in `scannedSet`, or if the value is not found in the loaded CSV (no row, no ID) |
| Barcode scan | Rejected if already in `mappedBarcodeSet` |
| Prefix | Max 10 characters |
| Start # | Integer ≥ 0 (numeric mode) or lowercase letters a–z (alpha mode) |
| Min Digits | 1–10 (forced to 0 and disabled in alpha mode) |
| CSV columns | Must contain `install no.` and `barcode` headers |

---

## User Feedback / Toast Notifications

| Color | Trigger |
|---|---|
| Blue | Successful QR-mode scan with CSV match |
| Purple | Mapped Barcode mode scan accepted |
| Orange | Warn-and-reject: duplicate scan, duplicate Tag, or QR value not found in CSV |
| Red | Error (camera permission, CSV parse failure) |
| Green | Successful export |

Most toasts auto-dismiss after 3 seconds; warn-and-reject (orange) toasts persist for 9 seconds for visibility. (Note: the vendored Tailwind build lacks `bg-orange-500`, so the orange background is supplied by a rule in the inline stylesheet.)

---

## Data Model

```json
// Log row (stored in localStorage array)
{
  "time": "14:32:01",
  "tag": "RS001",
  "qr": "12345",
  "barcode": "ABC-789"
}
```

**In-memory tracking sets** (rebuilt from log on reload):
- `scannedSet` — QR/Install No values already logged
- `mappedBarcodeSet` — Barcode values already logged
- `tagSet` — Tag IDs in use

---

## Security Requirements

- **XSS:** All user-controlled values HTML-escaped via `escHtml()` before DOM insertion; editable cells read via `innerText` not `innerHTML`
- **CSP:** Meta tag restricts scripts/styles/connections to approved CDNs; no `unsafe-eval`
- **Referrer policy:** `strict-origin-when-cross-origin`
- **Secret scanning:** gitleaks pre-commit hook configured locally; GitHub secret scanning enabled

---

## External Dependencies

| Library | Purpose | Source |
|---|---|---|
| Tailwind CSS | Responsive utility-first styling | Vendored (`vendor/`) |
| html5-qrcode | Camera QR/barcode scanning | Vendored (`vendor/`) |
| PapaParse | CSV parsing | Vendored (`vendor/`) |
| Google Fonts (Inter, JetBrains Mono) | Typography | CDN (system-font fallback offline) |

The three offline-critical libraries are vendored locally so the app works
offline and the service-worker cache stays same-origin (see §8).

**Built-in browser APIs used:** Camera, Fetch, File System Access, localStorage, Vibration, Page Visibility, Service Worker, Cache Storage

---

## Known Issues

No open issues. All six issues from the V2 code review were resolved in the V3 implementation:

| Severity | Issue (V2) | Resolution (V3) |
|---|---|---|
| Medium | `visibilitychange` stopped the camera without resetting the Start/Stop button UI | `stopScanner()` always calls `setStartButtonState(false)`; the `visibilitychange` handler routes through it |
| Medium | Append export mode unreachable — modal existed but Save button bypassed it | Append + Save As modal removed entirely; export is a single Download button (see §5) |
| Medium | `scannedSet` not updated on cell edit — duplicate check bypassed for manual edits | `commitEdit()` calls `rebuildSets()` after every committed edit |
| Low | Sort state lost on page reload | Sort state persisted to `localStorage` under `qrtag_sort` |
| Low | `getCSVBarcodes()` was dead code | Function omitted entirely |
| Low | `deleteTimer` stored as a `dataset` string | Stored in a `WeakMap` keyed by the row element |

---

## Out of Scope

- No backend, database, or user accounts
- No multi-user collaboration
- No native mobile app
- No barcode printing or label generation
