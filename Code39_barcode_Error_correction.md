# Code 39 Barcode Error-Correction: Consecutive-Read Buffer Pattern

## The Problem

A single barcode read from a live camera feed is not reliable enough to act on
immediately. Camera-based barcode decoders (including html5-qrcode) can produce
stray mis-reads caused by:

- Motion blur as the user positions the device
- Partial frames where the barcode is only half in view
- Environmental noise — glare, shadows, low contrast
- Codec artefacts at lower resolutions or framerates

The symptom is a plausible-looking but wrong value being decoded once, then never
again. Accepting on the first read means silently committing bad data.

---

## The Pattern: N Consecutive Identical Reads

**Accept a barcode only after the same decoded value is seen `REQUIRED_READS`
times in a row.** Any read that differs from the previous one resets the buffer
and starts again.

This is not a majority-vote or checksum scheme — it is purely a run-length check
on the decoded string. It is cheap, stateless between scans, and requires zero
changes to the underlying scanner library.

---

## State Variables

Declare these alongside your scanner state:

```js
// Tune to suit scanning conditions.
// 2 = fast, acceptable in good lighting at close range.
// 3 = safer for harsh environments (bright sunlight, distance, damaged barcodes).
const REQUIRED_READS = 2;

let barcodeReadBuffer = []; // successive identical reads accumulate here
let lastScannedTime   = 0;  // timestamp of the last processed scan frame

// Debounce windows (milliseconds).
// DEBOUNCE_C39 must be SHORT so that REQUIRED_READS accumulate within a
// natural hold of the camera — too long and the user has to re-aim each time.
// A good rule of thumb: DEBOUNCE_C39 < (1000 / scanner_fps) * 1.5
const DEBOUNCE_C39 = 300;  // ms between Code 39 buffer reads
const DEBOUNCE_QR  = 1500; // ms between QR / other format reads (not used here)
```

---

## The Buffer Logic

This is the drop-in scan-callback handler. Wire it as the `onScanSuccess` callback
for your html5-qrcode instance, or adapt it to whichever scanner library you use.

**What the caller must supply:**
- `decodedText` — the string the scanner decoded
- `decodedResult` — the result object from html5-qrcode (for format detection)
- `onConfirmed(value)` — your callback, called once the read is confirmed
- `onProgress(readCount, required, lastValue)` — optional UI update callback
- `onMismatch(previous, current)` — optional callback when the buffer resets

```js
function handleCode39Scan(decodedText, decodedResult, { onConfirmed, onProgress, onMismatch }) {
    const now = Date.now();

    // Throttle: ignore frames that arrive faster than DEBOUNCE_C39
    if (now - lastScannedTime < DEBOUNCE_C39) return;

    // Format guard — only process Code 39 frames
    const formatInt  = decodedResult?.result?.format?.format;
    const isCode39   = formatInt === Html5QrcodeSupportedFormats.CODE_39;
    if (!isCode39) return;

    // ── Error-correction buffer ───────────────────────────────────────────
    const lastBuffered = barcodeReadBuffer[barcodeReadBuffer.length - 1];

    if (lastBuffered !== undefined && lastBuffered !== decodedText) {
        // A different value arrived — discard the buffer and start fresh.
        // The new value becomes the first entry of the new run.
        if (onMismatch) onMismatch(lastBuffered, decodedText);
        barcodeReadBuffer = [];
    }

    barcodeReadBuffer.push(decodedText);
    lastScannedTime = now;

    if (onProgress) onProgress(barcodeReadBuffer.length, REQUIRED_READS, decodedText);

    if (barcodeReadBuffer.length >= REQUIRED_READS) {
        // Confirmed — every buffered read was identical.
        const confirmed = decodedText;
        barcodeReadBuffer = []; // reset for the next barcode
        onConfirmed(confirmed);
    }
}
```

**Reset the buffer** whenever the user cancels, moves to a new barcode, or your
app changes context:

```js
function resetBarcodeBuffer() {
    barcodeReadBuffer = [];
    lastScannedTime   = 0;
}
```

---

## Optional: Dot-Progress UI

Give the user visual feedback as reads accumulate. Render one dot per required
read; fill in dots as the buffer grows. This removes the "is it working?" anxiety
during the hold.

```js
// Call this from your onProgress callback.
// containerEl: the DOM element to render dots into.
function renderBufferProgress(containerEl, readCount, required) {
    containerEl.innerHTML = Array.from({ length: required }, (_, i) =>
        i < readCount
            ? `<span style="display:inline-block;width:1.25rem;height:1.25rem;border-radius:50%;background:#6366f1;margin:0 2px;box-shadow:0 1px 3px rgba(0,0,0,.3)"></span>`
            : `<span style="display:inline-block;width:1.25rem;height:1.25rem;border-radius:50%;background:#c7d2fe;margin:0 2px"></span>`
    ).join('');
}
```

Status label to accompany the dots:

```js
function bufferStatusLabel(readCount, required) {
    if (readCount === 0)        return 'Point camera at Code 39 barcode';
    if (readCount < required)   return `Reading… (${readCount}/${required} confirmed)`;
    return 'Confirmed!';
}
```

---

## Tuning Notes

| Scenario | Recommended `REQUIRED_READS` | Notes |
|---|---|---|
| Good indoor lighting, close range | 2 | Fast UX, minimal false negatives |
| Mixed or outdoor lighting | 3 | One extra confirmation, still feels responsive |
| Damaged / low-contrast barcodes | 3–4 | May need to lower scanner fps and widen qrbox |
| High-volume scanning (many per minute) | 2 | Speed matters; trust the environment |

**`DEBOUNCE_C39` sizing:** The scanner runs at a fixed fps (e.g. 10 fps = one
frame every 100 ms). `DEBOUNCE_C39 = 300` means the decoder accepts one read
every 3 frames. At `REQUIRED_READS = 2` that is 6 frames ≈ 0.6 s to confirm —
fast enough to feel instant. If you raise `REQUIRED_READS`, keep `DEBOUNCE_C39`
low or confirmation will feel sluggish.

**Timestamp vs frame-count:** The `lastScannedTime` approach (used here) is
clock-based and works regardless of scanner fps. A frame-count approach
(skip N frames between reads) is equally valid but couples your debounce to the
scanner fps setting, making it brittle if fps ever changes.

---

## Integration Checklist

- [ ] Declare `REQUIRED_READS`, `barcodeReadBuffer`, `lastScannedTime`, `DEBOUNCE_C39`
- [ ] Wire `handleCode39Scan` as your scan callback (or inline the buffer logic into an existing callback)
- [ ] Call `resetBarcodeBuffer()` on cancel, context change, or confirmed acceptance
- [ ] (Optional) call `renderBufferProgress` and `bufferStatusLabel` from `onProgress`
- [ ] Set `formatsToSupport: [Html5QrcodeSupportedFormats.CODE_39]` in your scanner config (or include additional formats if scanning multiple types)
- [ ] Verify `DEBOUNCE_C39 < (1000 / fps) * 1.5` for your chosen scanner fps

---

## Source

Pattern extracted from `Scan2Sheet-V2/index.html` — the `onScanSuccess` step-2
branch and `updateWorkflowUI` step-2 branch.
GitHub: https://github.com/Kelleco/Scan2Sheet-V2
