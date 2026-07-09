/**
 * Gemini OCR Utility — Tiled + Queued + Auto-Retry
 *
 * Strategies to survive the Free Tier quotas (15 RPM / 1 500 RPD):
 *   1. Sequential FIFO queue — only one Gemini call is in-flight at a time.
 *   2. Minimum 5 s gap between consecutive API calls (~12 RPM ≤ 15 RPM).
 *   3. On HTTP 429 → exponential back-off (60 s → 120 s → 240 s) with
 *      a real-time countdown shown in the status bar.
 *   4. Full-image OCR is split into horizontal tiles (default 3).
 *      Each tile becomes an independent queued request, so a transient
 *      429 only blocks that tile — completed tiles are never lost.
 */

// ---------------------------------------------------------------------------
// Request Queue with retry + exponential back-off
// ---------------------------------------------------------------------------
class GeminiRequestQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.lastRequestTime = 0;
    this.minDelayMs = 5000;   // 5 s gap → ~12 RPM (safely under 15 RPM)
    this.maxRetries = 3;
    this.retryBaseMs = 60000; // first retry waits 60 s
  }

  enqueue(fn, onStatusChange) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject, onStatusChange });
      this.processNext();
    });
  }

  async processNext() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    const { fn, resolve, reject, onStatusChange } = this.queue.shift();

    try {
      // ---- rate-limit cool-down ----
      const elapsed = Date.now() - this.lastRequestTime;
      if (elapsed < this.minDelayMs) {
        const wait = this.minDelayMs - elapsed;
        await this.countdown(wait, onStatusChange, '⏳ Rate-limit cooldown');
      }

      // ---- execute with retries ----
      let lastError;
      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        try {
          this.lastRequestTime = Date.now();
          const result = await fn();
          resolve(result);
          return; // success — exit
        } catch (err) {
          lastError = err;
          const is429 = err.message?.includes('429');
          if (is429 && attempt < this.maxRetries) {
            const backoff = this.retryBaseMs * Math.pow(2, attempt);
            await this.countdown(
              backoff,
              onStatusChange,
              `⚠️ Quota exceeded — auto-retry ${attempt + 1}/${this.maxRetries}`
            );
          } else {
            break; // non-retryable or exhausted retries
          }
        }
      }
      reject(lastError);
    } finally {
      this.processing = false;
      this.processNext();
    }
  }

  /** Show a live countdown in the status bar, then resolve. */
  countdown(totalMs, onStatusChange, prefix) {
    return new Promise(resolve => {
      const end = Date.now() + totalMs;
      const tick = () => {
        const remaining = Math.max(0, end - Date.now());
        if (remaining <= 0) { resolve(); return; }
        if (onStatusChange) {
          onStatusChange(`${prefix}: ${Math.ceil(remaining / 1000)}s remaining…`);
        }
        setTimeout(tick, 1000);
      };
      tick();
    });
  }
}

const geminiQueue = new GeminiRequestQueue();

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Load an HTMLImageElement from a data-URL (async). */
function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

/** Fire a single Gemini generateContent request and return the raw text. */
async function callGemini(base64Data, mimeType, prompt, apiKey, jsonMode = false) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  const body = {
    contents: [{ parts: [
      { text: prompt },
      { inlineData: { mimeType, data: base64Data } }
    ]}],
  };
  if (jsonMode) {
    body.generationConfig = { responseMimeType: 'application/json' };
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    let parsed;
    try { parsed = JSON.parse(errText); } catch { parsed = null; }
    throw new Error(`Gemini API error: ${res.status} - ${parsed?.error?.message || errText}`);
  }

  const json = await res.json();
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('No text response received from Gemini.');
  return text;
}

const OCR_PROMPT = `Analyze the image and perform extremely high-precision document OCR.
Extract ALL text blocks, lines, labels, words, including very small text, vertically written text, and low-contrast background details.
Output the text in Traditional Chinese (繁體中文) or English exactly as it appears.
For each text segment/line, detect its bounding box coordinates precisely.
Return ONLY a valid JSON array of objects conforming EXACTLY to this schema (no markdown, no quotes, no explanations, no text wrapping block):
[
  {
    "text": "detected text content",
    "bbox": [ymin, xmin, ymax, xmax]
  }
]
Use normalized coordinates in the range [0, 1000] (where 0 is top/left, 1000 is bottom/right). Use [ymin, xmin, ymax, xmax] mapping.
Only return the raw JSON array.`;

/** Parse Gemini's response text into an array of {text, bbox} blocks. */
function parseOcrJson(raw) {
  let s = raw.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }
  const arr = JSON.parse(s.trim());
  if (!Array.isArray(arr)) throw new Error('Response is not a valid array.');
  return arr;
}

// ---------------------------------------------------------------------------
// Public API — Full-Image OCR  (single tile, goes through queue)
// ---------------------------------------------------------------------------

export async function runGeminiOcr(base64DataUrl, apiKey, onStatusChange) {
  const m = base64DataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) throw new Error('Invalid image data format.');

  return geminiQueue.enqueue(async () => {
    if (onStatusChange) onStatusChange('Running Gemini AI OCR…');
    const raw = await callGemini(m[2], m[1], OCR_PROMPT, apiKey, true);
    return parseOcrJson(raw);
  }, onStatusChange);
}

// ---------------------------------------------------------------------------
// Public API — Tiled Full-Image OCR  (split → queue each tile → merge)
// ---------------------------------------------------------------------------

/**
 * Splits the image into `tileCount` horizontal strips, processes each one
 * through the rate-limited queue, and merges the results with corrected
 * bounding-box coordinates mapped back to the original full-image space.
 *
 * @param {string}   base64DataUrl  Full image as data-URL
 * @param {string}   apiKey         Gemini API key
 * @param {function} onStatusChange Status bar callback
 * @param {number}   tileCount      Number of horizontal strips (default 3)
 * @returns {Promise<Array>}        Merged array of {text, bbox} blocks
 */
export async function runGeminiOcrTiled(
  base64DataUrl, apiKey, onStatusChange, tileCount = 3,
) {
  const img = await loadImage(base64DataUrl);
  const fullW = img.width;
  const fullH = img.height;
  const stripH = Math.ceil(fullH / tileCount);

  const allBlocks = [];
  let succeeded = 0;

  for (let i = 0; i < tileCount; i++) {
    const yStart = i * stripH;
    const h = Math.min(stripH, fullH - yStart);
    if (h <= 0) break;

    // --- crop this strip ---
    const tile = document.createElement('canvas');
    tile.width = fullW;
    tile.height = h;
    tile.getContext('2d').drawImage(img, 0, yStart, fullW, h, 0, 0, fullW, h);
    const tileUrl = tile.toDataURL('image/png');
    const tm = tileUrl.match(/^data:([^;]+);base64,(.+)$/);

    try {
      if (onStatusChange) {
        onStatusChange(`📄 Tile ${i + 1}/${tileCount}: Queuing…`);
      }

      const blocks = await geminiQueue.enqueue(async () => {
        if (onStatusChange) {
          onStatusChange(`📄 Tile ${i + 1}/${tileCount}: Running Gemini AI OCR…`);
        }
        const raw = await callGemini(tm[2], tm[1], OCR_PROMPT, apiKey, true);
        return parseOcrJson(raw);
      }, (status) => {
        if (onStatusChange) onStatusChange(`📄 Tile ${i + 1}/${tileCount}: ${status}`);
      });

      // --- remap coordinates from tile space → full-image space ---
      for (const block of blocks) {
        const [ymin, xmin, ymax, xmax] = block.bbox;
        const yminPx = (ymin / 1000) * h + yStart;
        const ymaxPx = (ymax / 1000) * h + yStart;
        block.bbox = [
          Math.round((yminPx / fullH) * 1000),
          xmin,                                   // x stays the same
          Math.round((ymaxPx / fullH) * 1000),
          xmax,
        ];
      }

      allBlocks.push(...blocks);
      succeeded++;

      if (onStatusChange) {
        onStatusChange(`✅ Tile ${i + 1}/${tileCount} done (${blocks.length} blocks)`);
      }
    } catch (err) {
      console.error(`Tile ${i + 1}/${tileCount} failed:`, err);
      if (onStatusChange) {
        onStatusChange(`⚠️ Tile ${i + 1}/${tileCount} failed: ${err.message}. Continuing…`);
      }
      // Keep going — don't let one tile block the rest.
    }
  }

  if (succeeded === 0) {
    throw new Error(
      'All tiles failed — your daily API quota may be exhausted. Please wait and try again later.'
    );
  }

  return allBlocks;
}

// ---------------------------------------------------------------------------
// Public API — Regional (Crop-Box) OCR
// ---------------------------------------------------------------------------

export async function runGeminiRegionalOcr(base64DataUrl, apiKey, onStatusChange) {
  const m = base64DataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) throw new Error('Invalid image data format.');

  const prompt = `Analyze the cropped image segment and perform high-precision document OCR.
Extract all text content present in the image. Keep original line breaks if there are multiple lines.
Output the text in Traditional Chinese (繁體中文) or English exactly as it appears.
Return ONLY the raw recognized text content, nothing else. Do not include markdown, explanations, or JSON formatting.`;

  return geminiQueue.enqueue(async () => {
    if (onStatusChange) onStatusChange('Running Gemini Regional OCR…');
    const raw = await callGemini(m[2], m[1], prompt, apiKey, false);
    return raw.trim();
  }, onStatusChange);
}
