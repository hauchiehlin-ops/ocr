/**
 * Gemini OCR Utility — Tiled + Queued + Auto-Retry + Model Cascade + Custom API Endpoints
 *
 * Strategies to survive the Free Tier quotas (15 RPM / 1 500 RPD):
 *   1. Sequential FIFO queue — only one Gemini call is in-flight at a time.
 *   2. Minimum 5 s gap between consecutive API calls (~12 RPM ≤ 15 RPM).
 *   3. On HTTP 429 → exponential back-off (60 s → 120 s → 240 s) with
 *      a real-time countdown shown in the status bar.
 *   4. Full-image OCR is split into horizontal tiles (default 3).
 *      Each tile becomes an independent queued request, so a transient
 *      429 only blocks that tile — completed tiles are never lost.
 *   5. Model Cascade Fallback: If 2.0-flash returns a quota error, automatically fallback
 *      to 1.5-flash or 1.5-pro to bypass regional constraints (like EU/UK limit: 0).
 *   6. Custom API Endpoints: Allow custom proxy base URLs to bypass geography-based blocks.
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

/** Fire a single Gemini generateContent request with model cascade and custom endpoint base URL. */
async function callGemini(base64Data, mimeType, prompt, apiKey, jsonMode = false, modelName = 'gemini-2.5-flash', apiUrl = 'https://generativelanguage.googleapis.com', onStatusChange = null) {
  // Build a cascade list of models to try if the primary model is blocked or limited (2026 specs)
  const fallbackChain = [
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-2.0-pro',
    'gemini-1.5-flash',
    'gemini-1.5-pro'
  ];
  const modelsToTry = [modelName, ...fallbackChain.filter(m => m !== modelName)];

  let lastError;
  const baseApiUrl = apiUrl.replace(/\/+$/, ''); // Strip trailing slashes

  let activeIndex = 0;
  for (const model of modelsToTry) {
    try {
      if (activeIndex > 0 && onStatusChange) {
        onStatusChange(`⚠️ 備用切換：正在嘗試 ${model} 模型…`);
      }
      activeIndex++;
      const url = `${baseApiUrl}/v1beta/models/${model}:generateContent?key=${apiKey}`;
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
        const errMsg = parsed?.error?.message || errText;
        throw new Error(`Gemini API error: ${res.status} - ${errMsg}`);
      }

      const json = await res.json();
      const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('No text response received from Gemini.');
      return text;
    } catch (err) {
      lastError = err;
      console.warn(`[Gemini Cascade] Model ${model} failed: ${err.message}. Trying next fallback model...`);
      // If the API key is completely invalid or unauthorized (400/403), throw immediately
      if (err.message.includes('API key') || err.message.includes('not valid') || err.message.includes('403')) {
        throw err;
      }
    }
  }
  throw lastError;
}

const OCR_PROMPT = `Analyze the image and perform extremely high-precision document OCR.
Extract ALL text blocks, lines, labels, words, including very small text, vertically written text, and low-contrast background details.
Output the text in Traditional Chinese (繁體中文) or English exactly as it appears.
Rules for segmentation and bounding boxes:
- Create ONE object per visual text line or short standalone label. NEVER merge separate labels, nodes, or paragraphs into a single object.
- Each "bbox" must TIGHTLY enclose only its own text pixels — not the surrounding shape, icon, or whitespace.
- Do not output the same text twice.
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
  // Drop malformed entries early: empty text or degenerate/invalid bbox
  return arr.filter(b =>
    b && typeof b.text === 'string' && b.text.trim() !== '' &&
    Array.isArray(b.bbox) && b.bbox.length === 4 &&
    b.bbox.every(v => Number.isFinite(v)) &&
    b.bbox[2] > b.bbox[0] && b.bbox[3] > b.bbox[1]
  );
}

/** Normalize text for duplicate comparison: strip whitespace/punctuation, lowercase. */
function normalizeForCompare(text) {
  return text.replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase();
}

/** Whether two text strings are likely the same detection (equal or one contains the other). */
function textsSimilar(a, b) {
  const na = normalizeForCompare(a);
  const nb = normalizeForCompare(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
  return shorter.length >= 2 && longer.includes(shorter);
}

// ---------------------------------------------------------------------------
// Public API — Full-Image OCR  (single tile, goes through queue)
// ---------------------------------------------------------------------------

export async function runGeminiOcr(base64DataUrl, apiKey, onStatusChange, modelName = 'gemini-2.5-flash', apiUrl = 'https://generativelanguage.googleapis.com') {
  const m = base64DataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) throw new Error('Invalid image data format.');

  return geminiQueue.enqueue(async () => {
    if (onStatusChange) onStatusChange('Running Gemini AI OCR…');
    const raw = await callGemini(m[2], m[1], OCR_PROMPT, apiKey, true, modelName, apiUrl, onStatusChange);
    return parseOcrJson(raw);
  }, onStatusChange);
}

// ---------------------------------------------------------------------------
// Public API — Tiled Full-Image OCR  (split → queue each tile → merge)
// ---------------------------------------------------------------------------

/**
 * Splits the image into a 2x2 overlapping grid of quadrants (60% width/height each, 20% overlap).
 * Each quadrant is processed sequentially through the rate-limited queue at high resolution,
 * preventing downscaling. Bounding box coordinates are mapped back to original space,
 * and duplicate blocks in overlapping zones are merged using Non-Maximum Suppression (NMS).
 */
export async function runGeminiOcrTiled(
  base64DataUrl, apiKey, onStatusChange, tileCount = 3, modelName = 'gemini-2.5-flash', apiUrl = 'https://generativelanguage.googleapis.com'
) {
  const img = await loadImage(base64DataUrl);
  const fullW = img.width;
  const fullH = img.height;

  // 2x2 overlapping grid of quadrants
  const tilesConfig = [
    { name: 'Top-Left',     x: 0,                           y: 0,                           w: Math.round(fullW * 0.6), h: Math.round(fullH * 0.6) },
    { name: 'Top-Right',    x: Math.round(fullW * 0.4),     y: 0,                           w: Math.round(fullW * 0.6), h: Math.round(fullH * 0.6) },
    { name: 'Bottom-Left',  x: 0,                           y: Math.round(fullH * 0.4),     w: Math.round(fullW * 0.6), h: Math.round(fullH * 0.6) },
    { name: 'Bottom-Right', x: Math.round(fullW * 0.4),     y: Math.round(fullH * 0.4),     w: Math.round(fullW * 0.6), h: Math.round(fullH * 0.6) }
  ];

  const rawBlocks = [];
  const quadrantSucceeded = [false, false, false, false];
  let succeeded = 0;

  for (let i = 0; i < tilesConfig.length; i++) {
    const config = tilesConfig[i];
    const { name, x, y, w, h } = config;
    if (w <= 0 || h <= 0) continue;

    // Crop the quadrant canvas
    const tile = document.createElement('canvas');
    tile.width = w;
    tile.height = h;
    tile.getContext('2d').drawImage(img, x, y, w, h, 0, 0, w, h);
    const tileUrl = tile.toDataURL('image/png');
    const tm = tileUrl.match(/^data:([^;]+);base64,(.+)$/);

    try {
      if (onStatusChange) {
        onStatusChange(`📄 Quadrant ${i + 1}/4 (${name}): Queuing…`);
      }

      const blocks = await geminiQueue.enqueue(async () => {
        if (onStatusChange) {
          onStatusChange(`📄 Quadrant ${i + 1}/4 (${name}): Running Gemini AI OCR…`);
        }
        const raw = await callGemini(tm[2], tm[1], OCR_PROMPT, apiKey, true, modelName, apiUrl, onStatusChange);
        return parseOcrJson(raw);
      }, (status) => {
        if (onStatusChange) onStatusChange(`📄 Quadrant ${i + 1}/4 (${name}): ${status}`);
      });

      // Remap coordinates from quadrant space back to original full image space
      for (const block of blocks) {
        const [ymin, xmin, ymax, xmax] = block.bbox;
        
        // Bbox coordinates on quadrant in absolute pixels
        const yminPx = (ymin / 1000) * h + y;
        const xminPx = (xmin / 1000) * w + x;
        const ymaxPx = (ymax / 1000) * h + y;
        const xmaxPx = (xmax / 1000) * w + x;

        // Convert back to original image normalized coordinates [0, 1000]
        const yminNorm = Math.round((yminPx / fullH) * 1000);
        const xminNorm = Math.round((xminPx / fullW) * 1000);
        const ymaxNorm = Math.round((ymaxPx / fullH) * 1000);
        const xmaxNorm = Math.round((xmaxPx / fullW) * 1000);

        rawBlocks.push({
          text: block.text,
          bbox: [yminNorm, xminNorm, ymaxNorm, xmaxNorm],
          quadrant: i
        });
      }

      quadrantSucceeded[i] = true;
      succeeded++;
      if (onStatusChange) {
        onStatusChange(`✅ Quadrant ${i + 1}/4 (${name}) done (${blocks.length} blocks)`);
      }
    } catch (err) {
      console.error(`Quadrant ${i + 1}/4 (${name}) failed:`, err);
      if (onStatusChange) {
        onStatusChange(`⚠️ Quadrant ${i + 1}/4 (${name}) failed: ${err.message}. Continuing…`);
      }
    }
  }

  if (succeeded === 0) {
    throw new Error(
      'All quadrants failed — your daily API quota may be exhausted or model is restricted. Please wait or try choosing a fallback model (e.g. Gemini 1.5 Flash).'
    );
  }

  // -------------------------------------------------------------------------
  // Stage 1 — Ownership filtering (deterministic dedup for the overlap zones):
  // each block belongs to the quadrant whose half of the image contains the
  // block's center. Blocks reported by a non-owner quadrant are dropped,
  // unless the owner quadrant's request failed (then any detection is kept).
  // -------------------------------------------------------------------------
  const ownedBlocks = rawBlocks.filter(block => {
    const [ymin, xmin, ymax, xmax] = block.bbox;
    const cx = (xmin + xmax) / 2;
    const cy = (ymin + ymax) / 2;
    const ownerIndex = (cy < 500 ? 0 : 2) + (cx < 500 ? 0 : 1); // TL=0, TR=1, BL=2, BR=3
    return block.quadrant === ownerIndex || !quadrantSucceeded[ownerIndex];
  });

  // -------------------------------------------------------------------------
  // Stage 2 — Text-aware NMS for residual duplicates: two blocks are the same
  // detection only when their boxes overlap AND their texts match. A pure
  // geometric overlap no longer deletes distinct neighboring labels.
  // -------------------------------------------------------------------------
  ownedBlocks.sort((a, b) => b.text.length - a.text.length);
  const mergedBlocks = [];

  for (const block of ownedBlocks) {
    let isDuplicate = false;
    const [yminA, xminA, ymaxA, xmaxA] = block.bbox;
    const areaA = (xmaxA - xminA) * (ymaxA - yminA);

    for (const existing of mergedBlocks) {
      const [yminB, xminB, ymaxB, xmaxB] = existing.bbox;

      const interX = Math.max(0, Math.min(xmaxA, xmaxB) - Math.max(xminA, xminB));
      const interY = Math.max(0, Math.min(ymaxA, ymaxB) - Math.max(yminA, yminB));
      const interArea = interX * interY;
      if (interArea <= 0) continue;

      const areaB = (xmaxB - xminB) * (ymaxB - yminB);
      const overlap = interArea / Math.min(areaA, areaB);

      // Same text + slight overlap → duplicate (Gemini boxes drift between tiles).
      // Near-total containment (>85%) → duplicate even if OCR read it differently.
      if ((overlap > 0.15 && textsSimilar(block.text, existing.text)) || overlap > 0.85) {
        isDuplicate = true;
        break;
      }
    }

    if (!isDuplicate) {
      mergedBlocks.push({
        text: block.text,
        bbox: block.bbox
      });
    }
  }

  return mergedBlocks;
}

// ---------------------------------------------------------------------------
// Public API — Regional (Crop-Box) OCR
// ---------------------------------------------------------------------------

export async function runGeminiRegionalOcr(base64DataUrl, apiKey, onStatusChange, modelName = 'gemini-2.5-flash', apiUrl = 'https://generativelanguage.googleapis.com') {
  const m = base64DataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) throw new Error('Invalid image data format.');

  const prompt = `Analyze the cropped image segment and perform high-precision document OCR.
Extract all text content present in the image. Keep original line breaks if there are multiple lines.
Output the text in Traditional Chinese (繁體中文) or English exactly as it appears.
Return ONLY the raw recognized text content, nothing else. Do not include markdown, explanations, or JSON formatting.`;

  return geminiQueue.enqueue(async () => {
    if (onStatusChange) onStatusChange('Running Gemini Regional OCR…');
    const raw = await callGemini(m[2], m[1], prompt, apiKey, false, modelName, apiUrl, onStatusChange);
    return raw.trim();
  }, onStatusChange);
}
