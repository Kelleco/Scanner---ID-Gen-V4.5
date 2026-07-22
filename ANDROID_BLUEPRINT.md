# Android Build Blueprint — Scanner & ID Gen V4.5 (Native Kotlin Clone)

> **Purpose of this document.** This is a complete, self-contained specification
> for an AI (or engineer) to build a **native Android** app that behaves
> **identically** to the existing web SPA in this repo (`index.html`). Hand this
> whole file to a coding agent. The web app is the source of truth; every
> algorithm below is transcribed verbatim from its JavaScript and annotated with
> the edge case it preserves.
>
> **The golden rule:** this app's value is in ~11 small algorithms, **not** the
> UI. The UI can be rebuilt idiomatically; the *logic* must match to the
> character. If you change any algorithm in §4, you have broken the clone.
>
> **Target stack:** Kotlin + Jetpack Compose (Material 3), ML Kit Barcode
> Scanning + CameraX, Room (log) + DataStore Preferences (config/CSV/sort).
> Min SDK 24+, target latest. Single-activity, single-screen scroll.

---

## 1. What the app does (one paragraph)

A technician points the phone camera at a QR code / install number or a Code 39
barcode. The app assigns a sequential ID ("Tag"), looks the scanned value up in a
user-loaded reference CSV (in one of two directions depending on mode), and
appends a row to a scan log. The log is editable, reorderable, sortable, and
exportable to CSV. Everything is stored locally on the device — no network, no
account, no backend. It must work fully offline (which native Android is, by
default).

---

## 2. Web → Android stack mapping

| Web concern (in `index.html`) | Native Android replacement |
|---|---|
| html5-qrcode live camera scan | **CameraX** `Preview` + `ImageAnalysis`, feeding **ML Kit Barcode Scanning** |
| Format detection (`format.formatName === 'CODE_39'`) | `Barcode.format == Barcode.FORMAT_CODE_39`; decoded string from `barcode.rawValue` |
| QR mode (any QR / typed value) | ML Kit configured with `FORMAT_QR_CODE` **and** `FORMAT_CODE_39`; the active scan mode decides how a result is handled |
| Tailwind + HTML DOM | Jetpack Compose, Material 3 |
| `localStorage` log array (`qrtag_log`) | **Room** entity `LogRow` in table `log_rows`, ordered by a `position` column |
| `localStorage` config (`qrtag_config`) | **DataStore Preferences** |
| `localStorage` CSV text + name (`qrtag_csv_text`, `qrtag_csv_name`) | **DataStore Preferences** (store the raw CSV text + filename) |
| `localStorage` sort (`qrtag_sort`) | **DataStore Preferences** |
| CSV file picker (`<input type=file>`) | Storage Access Framework: `ActivityResultContracts.OpenDocument(arrayOf("text/*", "text/csv", "text/comma-separated-values"))` |
| Export (`showSaveFilePicker` → anchor fallback) | `ActivityResultContracts.CreateDocument("text/csv")`, write via `ContentResolver.openOutputStream` |
| PapaParse | A small CSV reader (hand-rolled, ~40 lines) or `com.github.doyaaaaaken:kotlin-csv-jvm`. **Must replicate the quirks in §4.6.** |
| Vibration API `navigator.vibrate(50)` | `Vibrator`/`VibratorManager`, `vibrate(VibrationEffect.createOneShot(50, DEFAULT_AMPLITUDE))` |
| Page Visibility → stop camera | Lifecycle: bind CameraX to the Activity/Composable lifecycle; it auto-stops in `onStop`. Reflect Start/Stop button state accordingly. |
| Zoom slider 1×–4× | `CameraControl.setZoomRatio(z)`, clamped to `cameraInfo.zoomState.value.maxZoomRatio` |
| Colored toasts | A Compose overlay (a `Box` stack of cards) or `SnackbarHost` with custom colors; **keep the colors and the 3 s / 9 s durations** (see §7) |

### Explicitly DROP these (web-only, no Android analog — do not port)

- **Service worker (`sw.js`), `manifest.webmanifest`, PWA install** — native apps
  are offline and installable by nature.
- **CSP `<meta>` tag** — irrelevant outside a browser.
- **`escHtml()` / `innerText` XSS mitigation** — Compose `Text` renders plain
  strings, not HTML. Store and display user values as-is. *Do not* introduce HTML
  escaping; it would corrupt values like `A&B`.
- **File System Access API fallback chain** — replaced by SAF (`CreateDocument`).
- **Google Fonts CDN / system-font fallback** — use the platform font or bundle a
  font; the monospace cells map to a `FontFamily.Monospace` style.

Porting any of the above is wasted effort and a sign the spec was misread.

---

## 3. Data model & persistence

### 3.1 LogRow (Room entity, table `log_rows`)

```kotlin
@Entity(tableName = "log_rows")
data class LogRow(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val time: String,      // "HH:MM:SS", local 24h, zero-padded
    val tag: String,       // the generated/overridden ID — unique among rows
    val qr: String,        // Install No (QR mode) or looked-up value / "NOT FOUND"
    val barcode: String,   // looked-up barcode (QR mode) or scanned barcode / "NOT FOUND"
    val position: Int      // display order; newest row has the SMALLEST position
)
```

- The web prepends new rows (`log.unshift`). Mirror this: **newest first.** On
  insert, shift existing positions up by one (or use a descending insert index).
  Simplest faithful approach: keep an in-memory `List<LogRow>` that *is* the
  display order (index 0 = newest), and persist the whole list with `position =
  index` whenever it changes. This matches the web's "the array is the order."
- `tag` is the logical key used by reorder and delete (the web keys by
  `row.tag`). Tags are guaranteed unique by validation, so this is safe.

### 3.2 Config (DataStore Preferences)

| Key | Type | Default | Notes |
|---|---|---|---|
| `prefix` | String | `"RS"` | auto-uppercased, max 10 chars |
| `start` | String | `"1"` | **String**, because it holds *either* an integer *or* a lowercase alpha sequence |
| `minDigits` | Int | `3` | clamp 1–10; forced to 0 and field disabled in alpha mode |
| `descending` | Bool | `false` | the "DEC" checkbox |

> Keep `start` as a String end-to-end. Alpha mode is detected by inspecting the
> string (§4.2). Do not split into two fields.

### 3.3 Sort state (DataStore)

| Key | Type | Default |
|---|---|---|
| `sortCol` | String? (`"tag"`/`"qr"`/`"barcode"` or null) | null |
| `sortDir` | String (`"asc"`/`"desc"`) | `"asc"` |

### 3.4 CSV (DataStore)

| Key | Type |
|---|---|
| `csvText` | String (raw file contents) |
| `csvName` | String (filename for the status badge) |

On app launch, re-parse `csvText` to rebuild the in-memory indexes — exactly like
the web's `loadState()` re-ingests the stored CSV text. Do **not** persist the
parsed maps; persist the raw text and rebuild.

### 3.5 In-memory derived state (rebuilt, never persisted directly)

```kotlin
val byInstall  = HashMap<String, String>()   // install -> barcode
val byBarcode  = HashMap<String, String>()   // barcode -> install
val scannedSet = HashSet<String>()           // normalizeInstall(qr), excl. NOT FOUND
val mappedSet  = HashSet<String>()           // raw barcode, excl. NOT FOUND
val tagSet     = HashSet<String>()           // tags in use
```

`byInstall`/`byBarcode` come from CSV ingest (§4.6). The three sets come from
`rebuildSets()` (§4.10) over the log, run on load **and after every mutation**.

---

## 4. Exact algorithms (the heart — transcribe, do not "improve")

Each algorithm is given as the web behavior + a Kotlin reference + the edge case
it guards. Match the behavior, including the weird parts.

### 4.1 `normalizeInstall(v)` — leading-zero canonicalization

Used on **every** QR-side comparison and as a second index key, so install
numbers `"007"` and `"7"` are treated as the same item.

```kotlin
fun normalizeInstall(v: String?): String {
    val s = (v ?: "").trim()
    return if (Regex("^\\d+\$").matches(s)) s.toLong().toString() else s
}
```

- Guards: `"007" → "7"`, `"  42 " → "42"`, `"A12" → "A12"` (non-numeric passes
  through untouched). Use `Long`/`BigInteger` parse to avoid overflow on long
  numeric strings — the web uses `parseInt` which would lose precision past 2^53;
  prefer not reproducing that bug. If you want byte-exact JS parity, parse the
  digits and strip leading zeros via string ops instead of integer parsing.

### 4.2 `isAlphaMode()`

```kotlin
fun isAlphaMode(start: String): Boolean = Regex("^[a-z]+\$").matches(start)
```

- True only for **lowercase** a–z sequences. `"1"`, `"0"`, `"12"`, `""`, `"A"`
  are all numeric mode (note: empty string is not alpha; numeric path treats it
  as 0).

### 4.3 `nextAlpha(seq)` — Excel-style increment (`a→b…z→aa→ab…`)

```kotlin
fun nextAlpha(seq: String): String {
    val chars = seq.toCharArray()
    var i = chars.lastIndex
    while (i >= 0) {
        if (chars[i] < 'z') { chars[i] = chars[i] + 1; return String(chars) }
        chars[i] = 'a'; i--
    }
    return "a" + String(chars)   // all carried (e.g. "zz" -> "aaa")
}
```

### 4.4 `prevAlpha(seq)` — Excel-style decrement, floored at `"a"`

```kotlin
fun prevAlpha(seq: String): String {
    if (seq == "a") return "a"
    val chars = seq.toCharArray()
    var i = chars.lastIndex
    while (i >= 0) {
        if (chars[i] > 'a') { chars[i] = chars[i] - 1; return String(chars) }
        chars[i] = 'z'; i--
    }
    val tail = String(chars).substring(1)   // drop the underflowed leading char
    return if (tail.isEmpty()) "a" else tail
}
```

- Guards: `"a" → "a"` (floor), `"ba" → "az"`, `"aa" → "z"` (length shrinks),
  `"b" → "a"`.

### 4.5 `nextTagId()` — THE critical function (4 corner cases)

Returns the next ID to assign. Auto-skips any ID already in `tagSet`, and
clamps to a floor in descending mode.

```kotlin
fun nextTagId(cfg: Config, tagSet: Set<String>): String {
    val prefix = cfg.prefix.uppercase()
    val desc = cfg.descending

    if (isAlphaMode(cfg.start)) {
        var seq = cfg.start
        var id: String
        do {
            id = prefix + seq
            if (desc) { if (seq == "a") break; seq = prevAlpha(seq) }
            else seq = nextAlpha(seq)
        } while (tagSet.contains(id))
        return id
    }

    val minDigits = cfg.minDigits.coerceIn(1, 10).let { if (it == 0) 1 else it }
    val startInt = cfg.start.toIntOrNull() ?: 0
    var n = if (desc) maxOf(1, startInt) else maxOf(0, startInt)
    var id: String
    do {
        id = prefix + n.toString().padStart(minDigits, '0')
        if (desc) { if (n <= 1) break; n-- }
        else n++
    } while (tagSet.contains(id))
    return id
}
```

Corner cases this MUST preserve (verify all four in testing):

1. **Numeric ascending:** floor 0, `n++`, zero-padded to `minDigits`. Skips
   used IDs — if `RS002` already exists, `RS001 → RS003`.
2. **Numeric descending:** floor **1** (not 0). At `n <= 1` it **breaks and
   returns the floor ID even if it's a duplicate** (the sequence "stays at the
   floor once reached").
3. **Alpha ascending:** `nextAlpha`, skips used IDs.
4. **Alpha descending:** floor **`"a"`**. At `seq == "a"` it breaks and returns
   `prefix + "a"` even if duplicate (floor clamp).

> Note the loop builds the ID *before* advancing the counter, so the returned ID
> is the first non-duplicate at/after the start — except at the floor in
> descending mode, where the floor is returned unconditionally.

### 4.6 CSV ingest (`ingestCsvText`) — replicate PapaParse quirks

```
parse with: header row = first line, skip empty lines, and for each header cell:
    strip a leading BOM (U+FEFF), trim, lowercase.
require: the header set contains BOTH "install no." AND "barcode"
         (after the transform above) — else throw "CSV must contain
         \"Install No.\" and \"Barcode\" columns".
for each data row:
    inst = trim(row["install no."]); bar = trim(row["barcode"])
    if inst is empty AND bar is empty: skip
    if inst not empty:
        byInstall[inst] = bar
        ninst = normalizeInstall(inst)
        if ninst != inst: byInstall[ninst] = bar     // dual key
    if bar not empty:
        byBarcode[bar] = inst
    count this row as "kept"
record: count = kept rows; name = filename
```

Quirks that are **load-bearing** (real Excel/Sheets exports hit all three):

- **Case-insensitive** header match (`Install No.`, `INSTALL NO.`, `barcode` all
  work) — achieved by lowercasing in the transform.
- **BOM tolerance** — the leading `U+FEFF` on the first header must be stripped.
- **Trailing-comma / ragged rows** — extra empty trailing fields are ignored;
  blank lines are skipped.

The status badge then reads `Loaded: <count> records (<name>)` on success, or the
thrown error message on failure (red).

### 4.7 Scan acceptance & the mode asymmetry — the single most important contract

Two scan modes, two lookup *directions*, and **different not-found behavior in
each**. This is the easiest thing to get wrong.

**Cooldown:** a *camera* scan is ignored if `now - lastScanAt < 1500 ms`. A
*manual* entry (typed value + Add/Enter) **bypasses** the cooldown.

#### QR mode (`scanMode == "qr"`)

```
value = trim(scanned/typed)
if value is empty: ignore
DUP CHECK: if scannedSet.contains(normalizeInstall(value)):
    orange toast "Duplicate: <value>" (9 s); STOP (no row, no ID)
barcode = byInstall[value] ?? byInstall[normalizeInstall(value)] ?? "NOT FOUND"
if barcode == "NOT FOUND":
    orange toast "Not in CSV: <value>" (9 s); STOP  ← REJECT: no row, NO ID consumed
else:
    qr = value
    tag = override or nextTagId()      // see §4.8
    append row {time, tag, qr, barcode}
    blue toast "+ <tag> → <barcode>"
    vibrate(50)
```

#### Mapped Barcode mode (`scanMode == "barcode"`)

```
value = trim(confirmed barcode)        // came through the §4.9 buffer for camera
DUP CHECK: if mappedSet.contains(value):   // RAW value, NOT normalized
    orange toast "Duplicate barcode: <value>" (9 s); STOP
barcode = value
qr = byBarcode[value] ?? "NOT FOUND"
tag = override or nextTagId()
append row {time, tag, qr, barcode}        ← ALWAYS appended, even if qr == NOT FOUND
purple toast:  qr == "NOT FOUND" ? "+ <tag> (barcode, not in CSV)"
                                 : "+ <tag> ← <qr>"
vibrate(50)
```

> **THE ASYMMETRY, in one line:** In QR mode a value not in the CSV is
> **rejected** (no row, no ID). In Barcode mode a value not in the CSV is
> **logged** with `qr = "NOT FOUND"`. Get this backwards and the app is wrong.

Also note: QR dup check normalizes (`normalizeInstall`); barcode dup check uses
the **raw** value. `mappedSet` and `scannedSet` are keyed accordingly (§4.10).

When a row is appended, update the in-memory sets immediately (don't wait for a
full rebuild): add `normalizeInstall(qr)` to `scannedSet` (unless NOT FOUND), add
`barcode` to `mappedSet` (unless NOT FOUND), add `tag` to `tagSet`. Then persist.

#### `time`

`time = "HH:MM:SS"` local, zero-padded, 24-hour (the web uses
`getHours/Minutes/Seconds`).

### 4.8 Manual Tag override

A "Tag (optional)" text field sits above the manual-value input.

- If non-empty when an entry is committed, its trimmed value becomes the row's
  `tag` and **`nextTagId()` is NOT called** — so no sequential number is consumed
  and the "Next ID" preview is unchanged. The following normal entry still gets
  the expected sequential ID.
- If the override duplicates an existing tag (`tagSet.contains(override)`):
  orange toast `Duplicate tag: <override>` (9 s) and the entry is **rejected**.
- The field is **cleared after every committed entry** (manual and camera, both
  modes).
- Applies to: manual Add/Enter, QR-mode camera scans, and Barcode-mode confirmed
  scans.

### 4.9 Code 39 two-read confirmation buffer (`handleCode39Scan`)

Only used for **camera** scans in **Barcode mode**. A single camera read is
unreliable, so accept only after **2 identical consecutive reads**.

```kotlin
val REQUIRED_READS = 2
val DEBOUNCE_C39_MS = 300L
var buffer = mutableListOf<String>()
var lastReadAt = 0L      // ms

// called for each ML Kit barcode result while in Barcode mode:
fun onCameraBarcode(decoded: String, format: Int, nowMs: Long,
                    onProgress: (n: Int, required: Int) -> Unit,
                    onConfirmed: (String) -> Unit) {
    if (nowMs - lastReadAt < DEBOUNCE_C39_MS) return    // throttle
    lastReadAt = nowMs
    if (format != Barcode.FORMAT_CODE_39) return         // format guard
    if (buffer.isNotEmpty() && buffer[0] != decoded) buffer.clear()  // mismatch resets
    buffer.add(decoded)
    onProgress(buffer.size, REQUIRED_READS)
    if (buffer.size >= REQUIRED_READS) {
        val confirmed = decoded
        buffer.clear(); lastReadAt = 0
        onConfirmed(confirmed)   // -> run the §4.7 Barcode-mode commit
    }
}
```

- **Throttle** drops frames arriving faster than 300 ms apart (≈ 2 reads in
  ~0.6 s at 10 fps — feels instant).
- **Format guard:** non–Code 39 frames are ignored entirely in this mode.
- **Mismatch reset:** if a different value arrives mid-buffer, the buffer is
  cleared (the new value does *not* seed a fresh run in the web version — it
  clears, then the same frame is pushed, so effectively the new value becomes
  read #1).
- On confirm, run the §4.7 Barcode-mode path (which re-checks the dup set), apply
  any tag override, then **reset the buffer**.
- **Reset the buffer on scan-mode change** and whenever the camera stops.

**Dot-progress UI:** show `REQUIRED_READS` dots; fill `n` of them indigo
(`#6366f1`) as reads accumulate, empties are `#c7d2fe`. Label: `""` at 0,
`Reading… (n/2)` while `0 < n < 2`, `Confirmed!` at `n >= 2`. Hide the whole
indicator when `n == 0`.

> QR mode does **not** use this buffer — QR/typed values commit on the first read
> (subject only to the 1500 ms cooldown).

### 4.10 `rebuildSets()` — run on load AND after every mutation

```kotlin
fun rebuildSets(log: List<LogRow>) {
    scannedSet.clear(); tagSet.clear(); mappedSet.clear()
    for (r in log) {
        if (r.qr.isNotEmpty() && r.qr != "NOT FOUND") scannedSet.add(normalizeInstall(r.qr))
        if (r.tag.isNotEmpty()) tagSet.add(r.tag)
        if (r.barcode.isNotEmpty() && r.barcode != "NOT FOUND") mappedSet.add(r.barcode)
    }
}
```

Mutations that must trigger a rebuild (or an equivalent incremental update):
**scan/commit, cell edit, delete, clear-all, drag-reorder, CSV change, app
load.** The web's V2 bug was an edit path that bypassed this — don't repeat it.

### 4.11 Export (`buildCsvText`)

```kotlin
fun buildCsvText(rows: List<LogRow>): String {
    fun q(v: String) = "\"" + v.replace("\"", "\"\"") + "\""
    val sb = StringBuilder("Tag,QR,Barcode")
    for (r in rows) sb.append("\r\n").append(listOf(r.tag, r.qr, r.barcode).joinToString(",") { q(it) })
    return sb.toString() + "\r\n"
}
```

- Header literally `Tag,QR,Barcode`. Every field **double-quoted**, inner `"`
  doubled. Lines joined by **CRLF**, with a **trailing CRLF**.
- Filename: `scan_log_YYYY-MM-DD.csv` using the **local** date
  (`year-month-day`, month/day zero-padded).
- Export the rows **in current display order** (after any active sort/reorder).
- Rows are written for the whole log including `NOT FOUND` values.
- On success: green toast `Downloaded <n> row(s)`.

---

## 5. UI / interaction parity (rebuild idiomatically in Compose)

One vertical scroll, four cards. Use Material 3; the exact pixel layout need not
match, but every control and behavior below must exist.

### 5.1 Scanner card
- **Mode toggle** button. QR mode label `QR Mode → Install No` (blue);
  Barcode mode label `Mapped Barcode Mode → Mapped Barcode` (purple). Toggling
  resets the Code 39 buffer (§4.9).
- **Camera preview** (CameraX `PreviewView`/`Preview`). **Start/Stop** button —
  red while running, blue while stopped. Stopping is also triggered when the app
  goes to background (lifecycle `onStop`); the button state must reflect it.
- **Zoom slider** 1.0×–4.0× (step 0.1), live `setZoomRatio` clamped to camera
  max; show the numeric value (`2.5×`).
- **Tag (optional)** monospace text field (the override, §4.8) — placed **above**
  the manual input.
- **Manual value** text field + **Add** button; Enter submits. Submitting runs
  the §4.7 path with `source = manual` (bypasses cooldown) and clears both the
  manual field and the Tag field.
- **Buffer dots + label** (§4.9), visible only mid-confirmation in Barcode mode.

### 5.2 Scan Log card
- Header: title + live row count (`N rows` / `1 row`), **Download** (green),
  **Clear History** (opens confirm dialog).
- Table columns: **drag handle · Tag (mono) · QR (Install No) · Mapped Barcode ·
  delete (×)**. Empty state row: `No items scanned yet.`
- **Inline-editable** Tag / QR / Barcode cells. Validate on commit (§5.4).
- `NOT FOUND` in the Barcode cell renders **red italic** (`#b91c1c`).
- **Drag-to-reorder** (long-press/handle drag on a `LazyColumn`). On drop:
  persist the new order, and **clear any active sort** (set sortCol = null).
- **Sortable headers**: tap a header to sort by that column; tap again to flip
  asc/desc. Comparison is **numeric-aware natural sort** (equivalent to JS
  `localeCompare(…, {numeric:true, sensitivity:'base'})` — e.g. `RS2 < RS10`).
  Persist sort state; restore on launch. (Sorting reorders the underlying list,
  same as the web.)
- **Soft delete**: tap × → button shows `Sure?`; auto-reverts after **3 s**;
  a second tap within the window commits the delete (fade the row out, then
  persist + rebuild sets).

### 5.3 ID Format card
- **DEC** checkbox (descending) at the right of the heading.
- **Prefix** (max 10, auto-uppercase), **Start #** (string; if it matches
  `[a-zA-Z]+` force lowercase and switch to alpha mode, else numeric ≥ 0),
  **Min Digits** (1–10). In alpha mode, Min Digits is **disabled and shows 0**.
- **Next ID** live preview = `nextTagId()` recomputed on every config/log change.

### 5.4 Cell-edit validation (on commit / focus-loss)
- **Tag:** must be non-empty (revert + orange `Tag is required` if blank) and
  unique (revert + orange `Duplicate Tag: <v>` if in `tagSet`). On success update
  the row + its drag key.
- **QR:** free text; just store the trimmed value.
- **Barcode:** must be unique **except** the literal `NOT FOUND` (revert + orange
  `Duplicate Barcode: <v>` if in `mappedSet`). Empty → store as `NOT FOUND`
  (and render red italic).
- After any successful commit: **rebuild sets, persist, refresh the Next-ID
  preview.**
- Escape cancels an in-progress edit (restore original); Enter commits.

### 5.5 Reference CSV card
- **Load CSV** (SAF open) and **Clear** (hidden until a CSV is loaded).
- Status: `Loaded: <count> records (<name>)` in green when loaded; otherwise
  `No CSV loaded — scans will log as NOT FOUND.` in gray. Parse error → red toast
  with the thrown message.

### 5.6 Clear History
- Confirmation dialog: "Clear scan log? All scanned rows will be removed. The
  loaded CSV and ID-format settings are preserved." Cancel / Clear (red).
- On confirm: empty the log + all three sets + persisted log; **keep CSV and
  config**. Orange toast `Scan log cleared`.

---

## 6. Validation rules (copy verbatim from the web behavior)

| Field | Rule |
|---|---|
| Tag ID (cell edit) | Non-empty and not already in `tagSet` (else revert + orange) |
| Tag override (entry) | Unique; rejected if already in `tagSet` (orange, no row, no ID) |
| Mapped Barcode (cell edit) | Unique except `NOT FOUND` (else revert + orange) |
| QR scan/entry | Rejected if in `scannedSet` (normalized) **or** value not found in CSV (no row, no ID) |
| Barcode scan/entry | Rejected if in `mappedSet` (raw); not-found values are logged as `NOT FOUND` |
| Prefix | Max 10 chars, auto-uppercased |
| Start # | Integer ≥ 0 (numeric) or lowercase `a–z` letters (alpha) |
| Min Digits | 1–10 (forced to 0 and disabled in alpha mode) |
| CSV columns | Must contain `install no.` and `barcode` headers (case-insensitive) |

---

## 7. Toast / feedback semantics

| Color | Hex | Trigger | Duration |
|---|---|---|---|
| Blue | `#2563eb` | QR-mode scan committed with CSV match | 3 s |
| Purple | `#9333ea` | Barcode-mode scan committed | 3 s |
| Orange | `#f97316` | Warn-and-reject: duplicate scan / duplicate Tag / QR value not in CSV / clear | **9 s** for rejects, 3 s for "cleared" |
| Red | `#dc2626` | Error (camera permission, CSV parse failure) | 3 s |
| Green | `#16a34a` | Successful export / CSV load | 3 s |

Default toast duration 3 s; warn-and-reject (orange dup/not-found) persists **9 s**
for visibility. Haptic `vibrate(50)` fires on each successful commit.

---

## 8. Acceptance checklist (build is correct iff all pass)

Run these against the finished app. They target the corner cases above.

1. **Numeric ascending + skip:** prefix `RS`, start `1`, minDigits `3`,
   DEC off → preview `RS001`. Commit two entries → `RS001`, `RS002`. Manually
   edit a row's Tag to `RS004`; next entry → `RS003`, then **`RS005`** (skips the
   in-use `RS004`).
2. **Numeric descending floor:** start `3`, DEC on → `RS003, RS002, RS001,
   RS001, …` (clamps and stays at the floor `1`).
3. **Alpha ascending rollover:** start `z` → `RSz, RSaa, RSab`. Any uppercase
   typed into Start # is forced lowercase; Min Digits shows 0 and is disabled.
4. **Alpha descending floor:** start `c`, DEC on → `RSc, RSb, RSa, RSa, …`
   (floor `a`).
5. **Tag override:** type `X9` in the Tag field, Add a value → row tagged `X9`,
   and the Next-ID preview is **unchanged**; the next normal entry uses the
   expected sequential ID. A second override of `X9` is rejected (orange).
6. **CSV quirks:** load a CSV that has a UTF-8 BOM, mixed-case headers
   (`Install No.`, `BARCODE`), and trailing commas → status shows the correct
   record count. A CSV missing a required column → red error toast.
7. **Install-number normalization:** CSV has install `7`; scanning/typing `007`
   in QR mode matches it (and vice-versa). Re-scanning `7` after `007` is logged
   is rejected as a duplicate.
8. **Mode asymmetry:** in **QR mode**, scan/type a value absent from the CSV →
   **no row added, no ID consumed**, orange "Not in CSV". In **Barcode mode**,
   scan a barcode absent from the CSV → a row **is** added with `QR` =
   red-italic `NOT FOUND`.
9. **Code 39 buffer:** hold one Code 39 barcode steady → dots fill to 2/2 →
   one row committed. Move to a different barcode mid-fill → dots reset. A
   non–Code 39 symbology in Barcode mode is ignored.
10. **Edit validation:** editing a Tag to an existing Tag reverts + orange;
    editing a Barcode to an existing barcode reverts + orange; clearing a Barcode
    cell stores `NOT FOUND` (red italic).
11. **Reorder & sort:** drag a row to reorder → order persists and any active
    sort indicator clears. Sort by Tag → `RS2` sorts before `RS10` (natural
    order). Sort state survives relaunch.
12. **Export:** Download → file named `scan_log_<today>.csv`, header
    `Tag,QR,Barcode`, every field quoted, **CRLF** line endings, trailing CRLF,
    rows in current display order.
13. **Persistence:** force-quit and relaunch → log rows, their order, the sort
    state, ID config, and the loaded CSV are all restored. Clear History wipes
    the log but **keeps** the CSV and config.
14. **Lifecycle:** background the app while scanning → camera stops and the
    Start/Stop button returns to "Start".

---

## 9. Suggested module layout (non-binding)

```
:app
  data/        Room (LogRow, LogDao, AppDb), DataStore wrappers
  core/        IdGen.kt (§4.1–4.5), Csv.kt (§4.6), ScanLogic.kt (§4.7–4.10),
               Export.kt (§4.11)   ← pure Kotlin, UNIT-TESTED against §8
  scan/        CameraX + ML Kit wiring, Code39Buffer (§4.9)
  ui/          Compose screens (§5), toast host, theme/colors (§7)
```

> Put §4 entirely in pure-Kotlin files with **no Android imports** and cover them
> with unit tests mirroring §8 items 1–5, 7, 8, 12. Those tests are the real
> guarantee that the clone matches; the UI is comparatively easy to verify by
> hand.

---

*Source app: `index.html` (V4.5) in this repo. When this blueprint and the web
app disagree, the web app wins — re-read its `<script>` block.*
