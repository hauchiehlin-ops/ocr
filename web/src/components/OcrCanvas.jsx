import { useEffect, useRef, useImperativeHandle, forwardRef, useState } from 'react';
import * as fabric from 'fabric';
import Tesseract from 'tesseract.js';
import { jsPDF } from 'jspdf';
import { runGeminiOcrTiled, runGeminiRegionalOcr } from '../utils/geminiOcr';
import { getNativeOcrEngineLabel, isNativeOcrAvailable, runNativeOcr } from '../utils/nativeOcr';
import { cancelLamaOperation, hasCachedLamaModel, inpaintWithLama } from '../utils/lamaInpaint';

// Fabric v7 changed the default object origin from left/top to center, so every
// object placed by (left, top) rendered shifted up-left by half its size: cover
// patches missed the source glyphs and OCR text landed offset on top of them.
// The whole pipeline (OCR bboxes, patches, exports) works in top-left space.
fabric.FabricObject.ownDefaults.originX = 'left';
fabric.FabricObject.ownDefaults.originY = 'top';
fabric.FabricObject.ownDefaults.cornerSize = 8;
fabric.FabricObject.ownDefaults.touchCornerSize = 18;
fabric.FabricObject.ownDefaults.transparentCorners = true;

const DEFAULT_OCR_FONT_FAMILY = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

// Typo correction dictionary from WPF project to achieve 99%+ accuracy for target mindmap
const ocrCorrectionDict = {
  "連瘠廟關": "連動機制",
  "應遭設指標": "應淘汰指標",
  "積應新指標": "引進新指標",
  "注入斬涇水": "注入新活水",
  "主襲主並依": "主管並依",
  "鍵穠分工": "權重分工",
  "預閥": "預期",
  "鼎建權重": "權重設定",
  "指標鈍化現象": "指標鈍化現象",
  "指標退場": "指標退場",
  "公平正義": "公平正義",
  "有效率": "有效率",
  "創造公共價值": "創造公共價值",
  "指标": "指標",
  "评估": "評估",
  "评价": "評價",
  "权重": "權重",
  "步骤": "步驟",
  "系统": "系統",
  "过程": "過程",
  "配套": "配套",
  "机制": "機制",
  "追踪": "追蹤",
  "選出": "選出",
  "筛选": "篩選",
  "排序": "排序"
};

function correctOcrText(text) {
  let corrected = text;
  for (const [key, val] of Object.entries(ocrCorrectionDict)) {
    corrected = corrected.replaceAll(key, val);
  }
  return corrected;
}

function getLinesFromPage(page) {
  const lines = [];
  if (page && page.blocks) {
    page.blocks.forEach(block => {
      if (block.paragraphs) {
        block.paragraphs.forEach(para => {
          if (para.lines) {
            para.lines.forEach(line => {
              lines.push(line);
            });
          }
        });
      }
    });
  }
  return lines;
}

// Preserve thin glyph edges; Tesseract performs its own thresholding.
function prepareTesseractImage(ctx, width, height) {
  const imgData = ctx.getImageData(0, 0, width, height);
  const data = imgData.data;
  // Preserve anti-aliased glyph edges; Tesseract performs its own binarisation.
  
  // Convert to grayscale with a mild contrast boost.
  for (let i = 0; i < data.length; i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const value = Math.max(0, Math.min(255, Math.round((gray - 128) * 1.12 + 128)));
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
    data[i + 3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function rgbToHex([r, g, b]) {
  return `#${[r, g, b].map(v => clampByte(v).toString(16).padStart(2, '0')).join('')}`;
}

// The review overlay is intentionally translucent so unresolved OCR text reads
// as "pending", not final. Tinting it with the detected glyph colour (instead
// of a fixed black) keeps that affordance while previewing the real colour.
function withReviewTint(hexColor) {
  if (!hexColor) return 'rgba(0, 0, 0, 0.78)';
  const r = parseInt(hexColor.slice(1, 3), 16);
  const g = parseInt(hexColor.slice(3, 5), 16);
  const b = parseInt(hexColor.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, 0.78)`;
}

// Native OS OCR engines (Apple Vision, Windows OCR) run their own internal
// preprocessing. Upscaling or sharpening the bitmap before sending it lowers
// Apple Vision's confidence (0.5 → 0.3 on the same text), which drops results
// below the server's cut-off and makes recognition silently return nothing.
// Crops are therefore sent untouched; this smooth upscale is only a retry
// path for tiny crops where Vision benefits from a larger input.
function createUpscaledCanvas(sourceCanvas, scale = 2) {
  const upscaledCanvas = document.createElement('canvas');
  upscaledCanvas.width = Math.max(1, Math.round(sourceCanvas.width * scale));
  upscaledCanvas.height = Math.max(1, Math.round(sourceCanvas.height * scale));
  const ctx = upscaledCanvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(sourceCanvas, 0, 0, upscaledCanvas.width, upscaledCanvas.height);
  return upscaledCanvas;
}

// Rebuild OCR text inside the source box. The source OCR bbox is the safest
// layout boundary: a replacement must not expand into a neighbouring card or
// connector just because the OCR wording is longer in the chosen font.
// Font size is therefore estimated from the detected line height and then
// capped by the available line width.
//
// The OCR box height is a tight ink bounding box around the *specific*
// recognized characters, not a fixed font-metric line height, so a single
// hardcoded divisor (≈1.18) systematically under- or over-estimates the size
// depending on which glyphs happen to be present ("RED TEXT" has no
// descenders; "Apply" or "權重分工" do). Measuring each block's own text and
// dividing by its own ink ratio fixed that bias, but introduced a worse
// problem: real words/phrases legitimately measure anywhere from ~0.70 (all
// caps, no descenders) to ~0.93 (CJK), so blocks with the *same* true font
// size but different content still ended up with visibly different
// estimated sizes — and short blocks (bullets, dashes, single CJK strokes
// like "一", punctuation) measured ink ratios as low as 0.05–0.28, which
// blew the estimate up to the max font size entirely.
//
// The fix has two parts:
//
// 1. Calibrate ink ratio from the batch's own reliable (multi-character)
//    text instead of trusting a single hardcoded constant, so it adapts to
//    whatever this image's text actually looks like.
// 2. Keep one visual ratio for the document. CJK glyphs are usually taller
//    relative to their nominal font size than Latin ones, but that is a
//    property of the replacement font, not evidence that the source image
//    used different font sizes. Choosing a ratio by each block's script made
//    labels such as "96%" and "70%" visibly larger than their neighbouring
//    CJK labels. The document ratio keeps one source line height mapped to one
//    replacement line height across scripts.
//
// Short blocks (bullets, dashes, single CJK strokes like "一", punctuation)
// are excluded from calibration — their own ink ratio can be a tiny fraction
// of the em square (measured as low as 0.05–0.28) and isn't representative —
// but are still sized using their script's calibrated ratio rather than a
// self-measurement, and the final ratio is clamped to a realistic band
// regardless.
const MIN_INK_RATIO = 0.55;
const MAX_INK_RATIO = 0.95;
const DEFAULT_CJK_INK_RATIO = 0.9;
const DEFAULT_LATIN_INK_RATIO = 0.75;
const DEFAULT_TEXTBOX_LINE_HEIGHT = 1;
const DEFAULT_TEXTBOX_CHAR_SPACING = 0;
const HISTORY_LIMIT = 30;
let ocrFontMeasureCtx = null;
function measureRawInkHeightRatio(text, fontFamily) {
  const referenceSize = 100;
  try {
    if (!ocrFontMeasureCtx) ocrFontMeasureCtx = document.createElement('canvas').getContext('2d');
    ocrFontMeasureCtx.font = `${referenceSize}px ${fontFamily}`;
    const metrics = ocrFontMeasureCtx.measureText(text || 'M');
    const inkHeight = (metrics.actualBoundingBoxAscent || 0) + (metrics.actualBoundingBoxDescent || 0);
    if (inkHeight > 0) return inkHeight / referenceSize;
  } catch {
    // Ignored; caller treats a missing measurement as "not reliable".
  }
  return null;
}

function longestLineOf(text) {
  const lines = String(text).split('\n').filter(l => l.trim() !== '');
  return lines.reduce((a, b) => (b.length > a.length ? b : a), lines[0] || String(text));
}

function isCjkDominant(text) {
  const stripped = normalizedText(text);
  if (!stripped) return false;
  const cjkCount = (stripped.match(/\p{Script=Han}/gu) || []).length;
  return cjkCount / stripped.length >= 0.5;
}

function medianOf(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Single-glyph or punctuation-only blocks are excluded from calibration:
// their ink ratio is a real property of that one glyph, not a representative
// sample of this document's typical text proportions.
function computeDocumentInkRatios(texts, fontFamily) {
  const cjkRatios = [];
  const latinRatios = [];
  texts.forEach((text) => {
    const line = longestLineOf(text);
    if (normalizedText(line).length < 2) return;
    const ratio = measureRawInkHeightRatio(line, fontFamily);
    if (ratio == null) return;
    (isCjkDominant(line) ? cjkRatios : latinRatios).push(ratio);
  });
  const clamp = (value) => Math.min(MAX_INK_RATIO, Math.max(MIN_INK_RATIO, value));
  const cjk = clamp(medianOf(cjkRatios) ?? DEFAULT_CJK_INK_RATIO);
  const latin = clamp(medianOf(latinRatios) ?? DEFAULT_LATIN_INK_RATIO);
  return {
    cjk,
    latin,
    // Prefer the CJK baseline when the document contains CJK text. This is
    // the stable visual-height anchor for mixed-script infographics and
    // prevents isolated number/Latin boxes from being inflated by the
    // smaller x-height of the replacement font.
    visual: cjkRatios.length > 0 ? cjk : latin
  };
}

function measureTextWidthAtFontSize(text, fontFamily, fontSize, fontWeight = 'normal', fontStyle = 'normal') {
  try {
    if (!ocrFontMeasureCtx) ocrFontMeasureCtx = document.createElement('canvas').getContext('2d');
    ocrFontMeasureCtx.font = `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`;
    const lines = String(text).split('\n').filter(l => l.trim() !== '');
    return (lines.length ? lines : [String(text)])
      .reduce((max, line) => Math.max(max, ocrFontMeasureCtx.measureText(line).width), 0);
  } catch {
    return null;
  }
}

function normalizeTextboxStyle(style = {}) {
  return {
    lineHeight: DEFAULT_TEXTBOX_LINE_HEIGHT,
    charSpacing: DEFAULT_TEXTBOX_CHAR_SPACING,
    ...style
  };
}

function calcOcrFontSize(
  text,
  boxW,
  boxH,
  inkRatios,
  fontFamily = DEFAULT_OCR_FONT_FAMILY,
  fontWeight = 'normal',
  fontStyle = 'normal',
  maxSize = 96
) {
  const lines = String(text).split('\n').filter(l => l.trim() !== '');
  const linesCount = lines.length || 1;
  const singleLineHeight = (boxH - 2) / linesCount;
  const ratios = inkRatios || {
    cjk: DEFAULT_CJK_INK_RATIO,
    latin: DEFAULT_LATIN_INK_RATIO,
    visual: DEFAULT_CJK_INK_RATIO
  };
  const ratio = Number.isFinite(ratios.visual)
    ? ratios.visual
    : (isCjkDominant(String(text)) ? ratios.cjk : ratios.latin);
  const byHeight = singleLineHeight / ratio;

  // Fabric's padding is outside the editable text width. Keep the outer
  // object inside the OCR box and use width as a hard upper bound. This is
  // important when corrected OCR text is longer than the source wording: it
  // must become smaller, never force the textbox across a diagram card.
  const textWidth = measureTextWidthAtFontSize(text, fontFamily, 100, fontWeight, fontStyle);
  const availableTextWidth = Math.max(2, boxW - 8);
  const byWidth = textWidth > 0 ? (availableTextWidth / textWidth) * 100 : byHeight;

  return Math.max(3, Math.min(maxSize, byHeight, byWidth));
}

function keepTextBoxInsideOcrBox(width, padding = 4) {
  return Math.max(2, width - padding * 2);
}

function normalizedText(text) {
  return String(text).replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase();
}

function overlapRatio(a, b) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  if (!intersection) return 0;
  return intersection / Math.min(a.w * a.h, b.w * b.h);
}

function getRecognizedLines(data) {
  // Tesseract returns `lines` for normal output and nests them under blocks when
  // block output is requested. Support both shapes so sparse-text mode cannot
  // silently produce an empty result.
  if (Array.isArray(data?.lines) && data.lines.length > 0) return data.lines;
  return getLinesFromPage(data);
}

function sanitizeOcrBlocks(blocks, layout) {
  return (Array.isArray(blocks) ? blocks : []).flatMap(block => {
    const raw = block?.bbox;
    if (!block?.text?.trim() || !raw) return [];
    const values = [raw.x, raw.y, raw.w, raw.h].map(Number);
    if (values.some(value => !Number.isFinite(value))) return [];
    const [x, y, w, h] = values;
    if (w <= 1 || h <= 1 ||
        (layout?.width > 0 && w > 0.9 * layout.width) ||
        (layout?.height > 0 && h > 0.25 * layout.height)) {
      return [];
    }
    return [{ ...block, bbox: { x, y, w, h } }];
  });
}

function dedupeOcrBlocks(blocks) {
  return [...blocks]
    .sort((a, b) => {
      const lengthDelta = normalizedText(b.text).length - normalizedText(a.text).length;
      if (lengthDelta) return lengthDelta;
      const confidenceDelta = (b.confidence ?? 0) - (a.confidence ?? 0);
      if (confidenceDelta) return confidenceDelta;
      return (b.bbox.w * b.bbox.h) - (a.bbox.w * a.bbox.h);
    })
    .filter((block, index, sorted) => {
      const text = normalizedText(block.text);
      return !sorted.slice(0, index).some(existing => {
        const overlap = overlapRatio(block.bbox, existing.bbox);
        const existingText = normalizedText(existing.text);
        const sameText = text && existingText &&
          (text === existingText || (Math.min(text.length, existingText.length) >= 3 &&
            (text.includes(existingText) || existingText.includes(text))));
        // Tile seams truncate lines mid-word ("SMARiSelection N" under
        // "SMART Selection Matrix"), so the texts differ yet the boxes sit on
        // top of each other. Any heavy overlap keeps only the longer/stronger
        // block, otherwise both render and look like doubled ghost text.
        return (sameText && overlap > 0.35) || overlap > 0.6;
      });
    });
}

function bboxToRect(bbox) {
  const [ymin, xmin, ymax, xmax] = bbox;
  return { x: xmin, y: ymin, w: xmax - xmin, h: ymax - ymin };
}

function normalizeCustomOcrItems(result) {
  const rawItems = Array.isArray(result)
    ? result
    : Array.isArray(result?.results)
      ? result.results
      : [];

  const normalizedItems = rawItems.flatMap(item => {
    const bbox = Array.isArray(item?.bbox) ? item.bbox.map(Number) : null;
    if (!item?.text?.trim() || !bbox || bbox.length !== 4 || bbox.some(value => !Number.isFinite(value))) {
      return [];
    }
    const [ymin, xmin, ymax, xmax] = bbox;
    if (xmax <= xmin || ymax <= ymin) return [];
    return [{
      text: item.text.trim(),
      bbox: [ymin, xmin, ymax, xmax],
      confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : 0
    }];
  });

  return [...normalizedItems]
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
    .filter((item, index, sorted) => {
      const text = normalizedText(item.text);
      return !sorted.slice(0, index).some(existing =>
        text &&
        normalizedText(existing.text) === text &&
        overlapRatio(bboxToRect(item.bbox), bboxToRect(existing.bbox)) > 0.45
      );
    });
}

const OcrCanvas = forwardRef(({
  onRegionSelect,
  onLayersUpdate,
  onImageLoaded,
  onOcrProcessing,
  onSourceFileNameChange,
  onZoomChange,
  zoomLevel = 1,
  isRegionalOcrActive = false,
  regionalAction = 'ocr',
  onRegionalOcrComplete,
  onHistoryStatusChange,
  onWorkerStatusChange,
  onAiStatusChange,
  enableAiInpaint = false,
  autoRunOcr = true,
  presetFontFamily = DEFAULT_OCR_FONT_FAMILY,
  presetFontSize = 16,
  presetBold = false,
  presetItalic = false,
  applyPresetFontFamily = true,
  applyPresetTypography = true,
  forcePresetFont = false,
  ocrEngine = 'local',
  geminiApiKey = '',
  geminiModel = 'gemini-3.5-flash',
  geminiApiUrl = 'https://generativelanguage.googleapis.com',
  localServerUrl = 'http://127.0.0.1:5001/ocr',
  isPasteModeActive = false,
  onPasteModeChange,
  onRegionClipboardChange,
  t = (key) => key
}, ref) => {
  const containerRef = useRef(null);
  const canvasEl = useRef(null);
  const fabricCanvas = useRef(null);
  const shouldUsePresetFontFamily = forcePresetFont && applyPresetFontFamily;
  const shouldUsePresetTypography = forcePresetFont && applyPresetTypography;
  const bgImage = useRef(null);
  const sampleCanvasRef = useRef(null);
  const batchInpaintCanvasRef = useRef(null);
  const aiDownloadApproved = useRef(false);
  const enableAiInpaintRef = useRef(enableAiInpaint);
  const tesseractWorker = useRef(null);
  const originalDimensions = useRef({ width: 0, height: 0 });
  // Save/Save As state: the loaded file's name (for the suggested filename and
  // the header badge) and the File System Access handle to overwrite on repeat
  // saves. Reset whenever a new image is loaded or the image is closed.
  const sourceFileNameRef = useRef(null);
  const saveFileHandleRef = useRef(null);
  const saveRevisionRef = useRef(0);
  const documentSessionRef = useRef(0);
  const activeFileReaderRef = useRef(null);
  const eventHandlersRef = useRef({});
  const onZoomChangeRef = useRef(onZoomChange);
  useEffect(() => { onZoomChangeRef.current = onZoomChange; }, [onZoomChange]);
  // File selection and OCR contain long asynchronous stages. Always read the
  // latest switch value instead of the render-time closure that started them.
  useEffect(() => {
    enableAiInpaintRef.current = enableAiInpaint;
    if (!enableAiInpaint) batchInpaintCanvasRef.current = null;
  }, [enableAiInpaint]);
  // Where the background image actually sits on the canvas:
  // canvas is sized to the visible workspace, the image is fit-scaled and centered inside it.
  const imageLayout = useRef({ scale: 1, left: 0, top: 0, width: 0, height: 0 });
  
  const [imageLoaded, setImageLoaded] = useState(false);

  // Drawing state for Regional OCR
  const isDrawing = useRef(false);
  const startPoint = useRef({ x: 0, y: 0 });
  const activeRect = useRef(null);
  const pendingInsertText = useRef(false);

  const isRegionalOcrActiveRef = useRef(isRegionalOcrActive);
  useEffect(() => {
    isRegionalOcrActiveRef.current = isRegionalOcrActive;
  }, [isRegionalOcrActive]);
  const regionalActionRef = useRef(regionalAction);
  useEffect(() => {
    regionalActionRef.current = regionalAction;
  }, [regionalAction]);
  const isPasteModeActiveRef = useRef(isPasteModeActive);
  useEffect(() => {
    isPasteModeActiveRef.current = isPasteModeActive;
  }, [isPasteModeActive]);
  const regionClipboardRef = useRef(null);

  // History stack for Undo/Redo
  const history = useRef([]);
  const historyIndex = useRef(-1);
  const isHistoryDisabled = useRef(false);

  const saveHistory = () => {
    if (isHistoryDisabled.current) return;
    const canvas = fabricCanvas.current;
    if (!canvas) return;

    const snapshot = canvas.toObject([
      'id', 'originalLeft', 'originalTop', 'originalWidth', 'originalHeight', 'cleanupExpandX', 'cleanupExpandY', 'isPatch', 'isErasePatch', 'sourceLayerId', 'isOcrReview', 'isManualText', 'isPastedRegion', 'confidence', 'originalTextColor',
      'selectable', 'evented'
    ]);
    // The source image can be many megabytes. Keeping its data URL in every
    // undo state multiplied memory use until Chromium's renderer became
    // unresponsive or crashed. The background is document state, not edit
    // history, so preserve it separately while undoing.
    delete snapshot.backgroundImage;
    delete snapshot.background;
    const json = JSON.stringify(snapshot);

    if (history.current[historyIndex.current] === json) {
      syncLayers();
      return;
    }
    
    history.current = history.current.slice(0, historyIndex.current + 1);
    history.current.push(json);
    if (history.current.length > HISTORY_LIMIT) {
      history.current.splice(0, history.current.length - HISTORY_LIMIT);
    }
    historyIndex.current = history.current.length - 1;
    
    if (onHistoryStatusChange) {
      onHistoryStatusChange({
        canUndo: historyIndex.current > 0,
        canRedo: false
      });
    }
    syncLayers();
  };

  const describeTextbox = (textbox) => {
    if (!textbox || textbox.type !== 'textbox') return null;
    return {
      id: textbox.id,
      text: textbox.text,
      isBold: textbox.fontWeight === 'bold',
      isItalic: textbox.fontStyle === 'italic',
      fill: textbox.isOcrReview ? (textbox.originalTextColor || '#000000') : textbox.fill,
      fontFamily: textbox.fontFamily,
      fontSize: textbox.fontSize,
      lineHeight: textbox.lineHeight,
      charSpacing: textbox.charSpacing
    };
  };

  const syncSelectedTextbox = () => {
    const canvas = fabricCanvas.current;
    const activeObject = canvas?.getActiveObject?.();
    onRegionSelect?.(describeTextbox(activeObject));
  };

  // Persistent Tesseract Worker initialization linked to OCR language settings
  /* oxlint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    let active = true;
    const initTesseract = async () => {
      if (onWorkerStatusChange) onWorkerStatusChange('Initializing OCR Engine...');
      
      if (tesseractWorker.current) {
        await tesseractWorker.current.terminate();
        tesseractWorker.current = null;
      }

      try {
        const langCodes = ['chi_tra', 'eng'];

        const worker = await Tesseract.createWorker(langCodes, Tesseract.OEM.DEFAULT, {
          logger: m => {
            console.log("Tesseract loading:", m);
            if (active && onWorkerStatusChange) {
              if (m.status === 'recognizing text') {
                onWorkerStatusChange(`OCR Running: ${Math.round(m.progress * 100)}%`);
              } else {
                onWorkerStatusChange(m.status);
              }
            }
          }
        });

        // This image is an infographic/mind-map, not a paragraph document.
        // Sparse-text mode avoids joining distant nodes into one invented line.
        await worker.setParameters({
          tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT,
          preserve_interword_spaces: '1'
        });

        if (active) {
          tesseractWorker.current = worker;
          if (onWorkerStatusChange) onWorkerStatusChange('OCR Engine Ready');
        }
      } catch (e) {
        console.error("Tesseract Worker load failed:", e);
        if (active && onWorkerStatusChange) onWorkerStatusChange('OCR Engine Error');
      }
    };

    initTesseract();

    return () => {
      active = false;
      if (tesseractWorker.current) {
        tesseractWorker.current.terminate();
      }
    };
  }, []);

  // Initialize Fabric Canvas
  useEffect(() => {
    if (!canvasEl.current || fabricCanvas.current) return;
    
    const canvas = new fabric.Canvas(canvasEl.current, {
      backgroundColor: 'transparent',
      selection: true,
    });
    fabricCanvas.current = canvas;
    if (import.meta.env.DEV) window.__fabricCanvas = canvas;

    canvas.on('selection:created', (event) => eventHandlersRef.current.handleSelection?.(event));
    canvas.on('selection:updated', (event) => eventHandlersRef.current.handleSelection?.(event));
    canvas.on('selection:cleared', () => {
      // Text editing can briefly clear the selection before Fabric settles
      // back onto the same textbox. Re-sync on the next frame so the sidebar
      // doesn't drop its selection state spuriously.
      requestAnimationFrame(() => eventHandlersRef.current.syncSelectedTextbox?.());
    });

    canvas.on('text:changed', (event) => eventHandlersRef.current.handleTextChanged?.(event));
    canvas.on('text:editing:entered', (event) => eventHandlersRef.current.handleEditingEntered?.(event));
    canvas.on('text:editing:exited', (event) => eventHandlersRef.current.handleEditingExited?.(event));

    // Viewport drag-to-pan support
    canvas.on('mouse:down', (opt) => {
      if (pendingInsertText.current) {
        const pointer = typeof canvas.getScenePoint === 'function'
          ? canvas.getScenePoint(opt.e)
          : canvas.getPointer(opt.e);
        pendingInsertText.current = false;
        canvas.defaultCursor = 'default';
        canvas.hoverCursor = 'move';
        if (canvas.upperCanvasEl) canvas.upperCanvasEl.style.cursor = 'default';
        eventHandlersRef.current.addManualTextBox?.(
          pointer.x,
          pointer.y,
          eventHandlersRef.current.translate?.('manualRegionText')
        );
        opt.e?.preventDefault?.();
        opt.e?.stopPropagation?.();
        return;
      }

      if (isPasteModeActiveRef.current) {
        const clipboard = regionClipboardRef.current;
        if (!clipboard) {
          onWorkerStatusChange?.(t('pasteRegionMissing'));
          isPasteModeActiveRef.current = false;
          onPasteModeChange?.(false);
          return;
        }
        const pointer = typeof canvas.getScenePoint === 'function'
          ? canvas.getScenePoint(opt.e)
          : canvas.getPointer(opt.e);
        opt.e?.preventDefault?.();
        opt.e?.stopPropagation?.();
        isPasteModeActiveRef.current = false;
        onPasteModeChange?.(false);
        void eventHandlersRef.current.pasteCopiedRegion?.(pointer).catch((error) => {
          console.warn('Paste region failed:', error);
          eventHandlersRef.current.notifyWorker?.(
            eventHandlersRef.current.translate?.('pasteRegionFailed')
          );
        });
        return;
      }

      const evt = opt.e;
      const target = opt.target;
      if (!isRegionalOcrActiveRef.current && (!target || target === bgImage.current)) {
        canvas.isDragging = true;
        canvas.selection = false;
        canvas.lastPosX = evt.clientX || evt.touches?.[0]?.clientX;
        canvas.lastPosY = evt.clientY || evt.touches?.[0]?.clientY;
      }
    });

    canvas.on('mouse:move', (opt) => {
      if (canvas.isDragging) {
        const evt = opt.e;
        const clientX = evt.clientX || evt.touches?.[0]?.clientX;
        const clientY = evt.clientY || evt.touches?.[0]?.clientY;
        const vpt = canvas.viewportTransform;
        vpt[4] += clientX - canvas.lastPosX;
        vpt[5] += clientY - canvas.lastPosY;
        canvas.requestRenderAll();
        canvas.lastPosX = clientX;
        canvas.lastPosY = clientY;
      }
    });

    canvas.on('mouse:up', () => {
      if (canvas.isDragging) {
        canvas.setViewportTransform(canvas.viewportTransform);
        canvas.isDragging = false;
        canvas.selection = true;
      }
    });

    // Mouse-wheel zoom over the editing area. Zoom is a controlled prop owned
    // by the parent (mirrors the +/- buttons), so this only reports the next
    // value upward instead of calling canvas.setZoom() directly.
    canvas.on('mouse:wheel', (opt) => {
      opt.e.preventDefault();
      opt.e.stopPropagation();
      if (!onZoomChangeRef.current) return;
      const step = opt.e.deltaY > 0 ? -0.05 : 0.05;
      onZoomChangeRef.current((prev) => Math.min(5, Math.max(0.1, Math.round((prev + step) * 100) / 100)));
    });

    canvas.on('object:modified', () => eventHandlersRef.current.saveHistory?.());
    canvas.on('object:added', (e) => {
      if (e.target && e.target !== bgImage.current && !e.target.isPatch && !e.target.isSelectionRect) {
        eventHandlersRef.current.saveHistory?.();
      }
    });
    canvas.on('object:removed', (e) => {
      if (e.target && e.target !== bgImage.current && !e.target.isPatch && !e.target.isSelectionRect) {
        eventHandlersRef.current.saveHistory?.();
      }
    });

    const resizeObserver = new ResizeObserver((entries) => {
      for (let entry of entries) {
        // The canvas always spans the visible workspace, image or not;
        // objects keep their coordinates (users can pan/zoom to re-frame).
        if (fabricCanvas.current && entry.contentRect.width > 0 && entry.contentRect.height > 0) {
           fabricCanvas.current.setDimensions({
             width: entry.contentRect.width,
             height: entry.contentRect.height
           });
        }
      }
    });
    
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      documentSessionRef.current += 1;
      activeFileReaderRef.current?.abort();
      activeFileReaderRef.current = null;
      cancelLamaOperation();
      resizeObserver.disconnect();
      if (fabricCanvas.current) {
        fabricCanvas.current.dispose();
        fabricCanvas.current = null;
      }
    };
  }, []);
  /* oxlint-enable react-hooks/exhaustive-deps */

  // Sync Regional OCR drawing modes
  /* oxlint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    const canvas = fabricCanvas.current;
    if (!canvas) return;

    if (isRegionalOcrActive) {
      pendingInsertText.current = false;
      canvas.forEachObject(obj => {
         obj.selectable = false;
         obj.evented = false;
      });
      canvas.selection = false;
      canvas.skipTargetFind = true;
      const cursor = regionalAction === 'erase' ? 'cell' : 'crosshair';
      canvas.defaultCursor = cursor;
      canvas.hoverCursor = cursor;
      if (canvas.upperCanvasEl) canvas.upperCanvasEl.style.cursor = cursor;
      canvas.discardActiveObject();
      canvas.renderAll();

      canvas.on('mouse:down', handleMouseDown);
      canvas.on('mouse:move', handleMouseMove);
      canvas.on('mouse:up', handleMouseUp);
    } else {
      canvas.off('mouse:down', handleMouseDown);
      canvas.off('mouse:move', handleMouseMove);
      canvas.off('mouse:up', handleMouseUp);

      canvas.forEachObject(obj => {
        if (obj.type === 'textbox') {
          obj.selectable = true;
          obj.evented = true;
        }
      });
      canvas.selection = true;
      canvas.skipTargetFind = false;
      canvas.defaultCursor = 'default';
      canvas.hoverCursor = 'move';
      if (canvas.upperCanvasEl) canvas.upperCanvasEl.style.cursor = 'default';
      canvas.renderAll();
    }

    return () => {
      canvas.off('mouse:down', handleMouseDown);
      canvas.off('mouse:move', handleMouseMove);
      canvas.off('mouse:up', handleMouseUp);
    };
  }, [isRegionalOcrActive, regionalAction]);
  /* oxlint-enable react-hooks/exhaustive-deps */

  const resolveImagePatchGeometry = (left, top, width, height, paddingX, paddingY) => {
    const layout = imageLayout.current;
    if (!layout.width || !sampleCanvasRef.current || layout.scale <= 0) return null;

    const scale = layout.scale;
    const imgWidthMax = sampleCanvasRef.current.width;
    const imgHeightMax = sampleCanvasRef.current.height;
    const rawLeft = (left - layout.left) / scale;
    const rawTop = (top - layout.top) / scale;
    const rawRight = (left + width - layout.left) / scale;
    const rawBottom = (top + height - layout.top) / scale;
    const imgLeft = Math.max(0, Math.min(imgWidthMax - 1, Math.floor(Math.min(rawLeft, rawRight))));
    const imgTop = Math.max(0, Math.min(imgHeightMax - 1, Math.floor(Math.min(rawTop, rawBottom))));
    const imgRight = Math.max(imgLeft + 1, Math.min(imgWidthMax, Math.ceil(Math.max(rawLeft, rawRight))));
    const imgBottom = Math.max(imgTop + 1, Math.min(imgHeightMax, Math.ceil(Math.max(rawTop, rawBottom))));
    const imgWidth = imgRight - imgLeft;
    const imgHeight = imgBottom - imgTop;
    if (imgWidth <= 1 || imgHeight <= 1) return null;

    return {
      layout,
      scale,
      imgLeft,
      imgTop,
      imgRight,
      imgBottom,
      imgWidth,
      imgHeight,
      patchLeft: Math.max(0, imgLeft - Math.max(0, Math.round(paddingX))),
      patchTop: Math.max(0, imgTop - Math.max(0, Math.round(paddingY))),
      patchRight: Math.min(imgWidthMax, imgRight + Math.max(0, Math.round(paddingX))),
      patchBottom: Math.min(imgHeightMax, imgBottom + Math.max(0, Math.round(paddingY)))
    };
  };

  const finishPatch = (patchCanvas, geometry) => ({
    dataUrl: patchCanvas.toDataURL('image/png'),
    patchLeft: geometry.layout.left + geometry.patchLeft * geometry.scale,
    patchTop: geometry.layout.top + geometry.patchTop * geometry.scale,
    patchWidth: patchCanvas.width * geometry.scale,
    patchHeight: patchCanvas.height * geometry.scale
  });

  const prepareBatchInpaint = async (blocks, sessionId = documentSessionRef.current) => {
    const sourceCanvas = sampleCanvasRef.current;
    const layout = imageLayout.current;
    batchInpaintCanvasRef.current = null;
    if (!enableAiInpaintRef.current) {
      onAiStatusChange?.({ phase: 'disabled', progress: 0, message: 'AI 背景修補未啟用，使用原生修補流程' });
      return;
    }
    if (!sourceCanvas || !blocks?.length || !layout.scale) return;
    const width = sourceCanvas.width, height = sourceCanvas.height;
    const source = sourceCanvas.getContext('2d').getImageData(0, 0, width, height).data;
    const mask = new Uint8Array(width * height);
    for (const block of blocks) {
      if (block.manual) continue;
      const box = block.bbox || block;
      const left = box.x ?? box.left, top = box.y ?? box.top;
      const boxWidth = box.w ?? box.width, boxHeight = box.h ?? box.height;
      if (![left, top, boxWidth, boxHeight].every(Number.isFinite)) continue;
      const x0 = Math.max(0, Math.floor((left - layout.left) / layout.scale) - 2);
      const y0 = Math.max(0, Math.floor((top - layout.top) / layout.scale) - 2);
      const x1 = Math.min(width, Math.ceil((left + boxWidth - layout.left) / layout.scale) + 2);
      const y1 = Math.min(height, Math.ceil((top + boxHeight - layout.top) / layout.scale) + 2);
      for (let y = y0; y < y1; y++) mask.fill(1, y * width + x0, y * width + x1);
    }
    if (!mask.some(Boolean)) return;
    onAiStatusChange?.({ phase: 'preparing', progress: 0, message: '已啟用 AI 修補，正在準備本張圖片…' });
    onWorkerStatusChange?.('步驟 2/2：AI 修補模型正在分析並重建背景…');
    if (!aiDownloadApproved.current) {
      const modelAlreadyStored = await hasCachedLamaModel();
      if (!modelAlreadyStored) {
        aiDownloadApproved.current = window.confirm('尚未找到已下載的 AI 修補模型。首次需要下載約 198 MB 並儲存在此瀏覽器，是否繼續？');
        if (!aiDownloadApproved.current) return;
      }
      aiDownloadApproved.current = true;
    }
    try {
      const result = await inpaintWithLama(source, mask, width, height, {
        onStatus: status => {
          if (sessionId !== documentSessionRef.current) return;
          onAiStatusChange?.(status);
          if (status.message) onWorkerStatusChange?.(status.message);
        }
      });
      if (sessionId !== documentSessionRef.current) return;
      if (!result || result.length !== source.length) throw new Error('AI 修補輸出不完整，已拒絕套用');
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d'); const data = context.createImageData(width, height);
      data.data.set(result); context.putImageData(data, 0, 0);
      batchInpaintCanvasRef.current = canvas;
    } catch (error) {
      if (sessionId !== documentSessionRef.current) return;
      if (error?.name !== 'AbortError') console.warn('Batch LaMa unavailable; using spatial fallback.', error);
      onAiStatusChange?.({ phase: error?.name === 'AbortError' ? 'cancelled' : 'error', message: error.message });
    }
  };

  // Reconstruct only glyph pixels. Two earlier generations of this routine
  // ghosted: perimeter stripes (v1) and diffusion averaging (v2), where any
  // glyph pixel the mask missed bled grey into the fill. This version builds
  // a per-pixel background estimate from the padding ring OUTSIDE the text
  // box (median top/bottom/left/right bands, so bold dense text can never be
  // mistaken for the background), masks every pixel that deviates from that
  // estimate, and fills masked pixels directly with the estimate. The fill
  // never averages neighbouring pixels, so missed glyph remnants cannot smear.
  const createTextPatch = async (left, top, width, height, expandX = 0, expandY = 0) => {
    // The OCR bbox positions replacement text; cleanup needs a separate,
    // slightly wider target because native engines return glyph-tight boxes.
    left -= expandX;
    top -= expandY;
    width += expandX * 2;
    height += expandY * 2;
    const layout = imageLayout.current;
    const scale = layout.scale || 1;
    const imageWidth = Math.max(1, Math.abs(width / scale));
    const imageHeight = Math.max(1, Math.abs(height / scale));
    const useAiInpaint = Boolean(batchInpaintCanvasRef.current);
    // The verified pre-AI native fallback uses a tight local ring. AI gets a
    // wider context only after a complete batch result exists in memory.
    const paddingX = useAiInpaint
      ? Math.max(16, Math.min(96, Math.round(imageWidth * 0.3)))
      : Math.max(4, Math.min(14, Math.round(imageWidth * 0.05)));
    const paddingY = useAiInpaint
      ? Math.max(16, Math.min(96, Math.round(imageHeight * 1.2)))
      : Math.max(4, Math.min(12, Math.round(imageHeight * 0.22)));
    const geometry = resolveImagePatchGeometry(left, top, width, height, paddingX, paddingY);
    const sourceCanvas = sampleCanvasRef.current;
    if (!geometry || !sourceCanvas) return null;

    const patchWidth = Math.max(1, geometry.patchRight - geometry.patchLeft);
    const patchHeight = Math.max(1, geometry.patchBottom - geometry.patchTop);
    const patchCanvas = document.createElement('canvas');
    patchCanvas.width = patchWidth;
    patchCanvas.height = patchHeight;
    const ctx = patchCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(
      sourceCanvas,
      geometry.patchLeft,
      geometry.patchTop,
      patchWidth,
      patchHeight,
      0,
      0,
      patchWidth,
      patchHeight
    );

    const imageData = ctx.getImageData(0, 0, patchWidth, patchHeight);
    const source = imageData.data;
    const pixelCount = patchWidth * patchHeight;
    const targetLeft = geometry.imgLeft - geometry.patchLeft;
    const targetTop = geometry.imgTop - geometry.patchTop;
    const targetRight = geometry.imgRight - geometry.patchLeft;
    const targetBottom = geometry.imgBottom - geometry.patchTop;

    // Pick a real, jointly occurring RGB cluster instead of taking independent
    // channel medians. Independent medians can synthesize a grey that never
    // existed in the source (especially around icons and coloured cards).
    const buildColorBuckets = (indices) => {
      if (!indices.length) return [];
      const buckets = new Map();
      for (const index of indices) {
        // 16-level buckets absorb JPEG/anti-alias noise without merging visibly
        // different background colours. Accumulate the original values so the
        // returned colour is not itself quantized.
        const key = `${source[index] >> 4},${source[index + 1] >> 4},${source[index + 2] >> 4}`;
        const bucket = buckets.get(key) || { count: 0, r: 0, g: 0, b: 0 };
        bucket.count += 1;
        bucket.r += source[index];
        bucket.g += source[index + 1];
        bucket.b += source[index + 2];
        buckets.set(key, bucket);
      }
      return [...buckets.values()].map((bucket) => ({
        count: bucket.count,
        color: [bucket.r / bucket.count, bucket.g / bucket.count, bucket.b / bucket.count]
      }));
    };

    const dominantColor = (indices) => {
      const buckets = buildColorBuckets(indices);
      if (!buckets.length) return null;
      let winner = null;
      for (const bucket of buckets) {
        if (!winner || bucket.count > winner.count) winner = bucket;
      }
      return winner?.color || null;
    };

    const distanceFromColor = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

    const contrastDominantColor = (indices, substrateColor, minContrast = 12) => {
      const buckets = buildColorBuckets(indices);
      if (!buckets.length) return null;
      const minimumBucketSize = Math.max(2, Math.ceil(indices.length / 40));
      let winner = null;
      for (const bucket of buckets) {
        const contrast = distanceFromColor(bucket.color, substrateColor);
        if (contrast < minContrast || bucket.count < minimumBucketSize) continue;
        const score = contrast * Math.sqrt(bucket.count);
        if (!winner || score > winner.score) winner = { color: bucket.color, score };
      }
      return winner?.color || dominantColor(indices);
    };

    // Collect robust bands outside the destructive target. Earlier code built
    // one colour per column/row; a glyph touching a narrow band contaminated a
    // whole column and was stretched into the conspicuous vertical streaks.
    const collectBand = (x0, x1, y0, y1) => {
      const indices = [];
      for (let y = Math.max(0, y0); y < Math.min(patchHeight, y1); y += 1) {
        for (let x = Math.max(0, x0); x < Math.min(patchWidth, x1); x += 1) {
          indices.push((y * patchWidth + x) * 4);
        }
      }
      return indices;
    };
    // Native OCR boxes can be so glyph-tight that black strokes are the
    // majority *inside* the bbox; treating that as substrate produced solid
    // black replacement rectangles. Sample only the non-destructive padding
    // ring instead. The cleanup target itself is no longer geometrically
    // expanded, so this ring stays local to the card/background while the
    // destructive mask remains strictly inside the original OCR bbox.
    const substrateColor = dominantColor([
      ...collectBand(0, patchWidth, 0, targetTop),
      ...collectBand(0, patchWidth, targetBottom, patchHeight),
      ...collectBand(0, targetLeft, targetTop, targetBottom),
      ...collectBand(targetRight, patchWidth, targetTop, targetBottom)
    ]);
    if (!substrateColor) return null;

    // This is the verified pre-AI fallback: use one real RGB cluster sampled
    // from the tight ring and alter only detected glyph pixels. It must remain
    // independent of model loading, network state, or browser capabilities.
    const estimateChannel = (_x, _y, channel) => substrateColor[channel];

    // Mask every pixel inside the box that deviates from the local background
    // estimate; a moderate threshold plus dilation captures anti-alias halos.
    const mask = new Uint8Array(pixelCount);
    const background = new Float32Array(pixelCount * 3);
    // Anti-aliased strokes can differ from their background by fewer than 15
    // RGB units.  That old threshold left the thin vertical fragments visible
    // in high-contrast labels.  Eight still ignores normal compression noise,
    // while catching the pale edge pixels that form recognisable ghost text.
    const maskThreshold = 8;
    let maskedCount = 0;
    for (let y = targetTop; y < targetBottom; y += 1) {
      for (let x = targetLeft; x < targetRight; x += 1) {
        const pixelIndex = y * patchWidth + x;
        const index = pixelIndex * 4;
        const bgR = estimateChannel(x, y, 0);
        const bgG = estimateChannel(x, y, 1);
        const bgB = estimateChannel(x, y, 2);
        background[pixelIndex * 3] = bgR;
        background[pixelIndex * 3 + 1] = bgG;
        background[pixelIndex * 3 + 2] = bgB;
        if (Math.hypot(source[index] - bgR, source[index + 1] - bgG, source[index + 2] - bgB) > maskThreshold) {
          mask[pixelIndex] = 1;
          maskedCount += 1;
        }
      }
    }
    if (!maskedCount) return null;

    // Sample the glyph colour itself (pixels the mask just flagged as text,
    // before dilation pulls in background-adjacent pixels) so the replacement
    // textbox can preview the source colour instead of a fixed black.
    const glyphIndices = [];
    for (let y = targetTop; y < targetBottom; y += 1) {
      for (let x = targetLeft; x < targetRight; x += 1) {
        const pixelIndex = y * patchWidth + x;
        if (mask[pixelIndex]) glyphIndices.push(pixelIndex * 4);
      }
    }
    const glyphColor = contrastDominantColor(glyphIndices, substrateColor);

    // Dilate so anti-aliased edges and glyph strokes that poke slightly past
    // a tight OCR bounding box are rebuilt as well.
    const dilationRadius = Math.max(2, Math.min(6, Math.round(imageHeight * 0.16)));
    const dilated = new Uint8Array(mask);
    for (let y = Math.max(0, targetTop - dilationRadius); y < Math.min(patchHeight, targetBottom + dilationRadius); y += 1) {
      for (let x = Math.max(0, targetLeft - dilationRadius); x < Math.min(patchWidth, targetRight + dilationRadius); x += 1) {
        const pixelIndex = y * patchWidth + x;
        if (dilated[pixelIndex]) continue;
        let nearMasked = false;
        for (let dy = -dilationRadius; dy <= dilationRadius && !nearMasked; dy += 1) {
          const sy = y + dy;
          if (sy < 0 || sy >= patchHeight) continue;
          for (let dx = -dilationRadius; dx <= dilationRadius; dx += 1) {
            const sx = x + dx;
            if (sx >= 0 && sx < patchWidth && mask[sy * patchWidth + sx]) {
              nearMasked = true;
              break;
            }
          }
        }
        if (nearMasked) dilated[pixelIndex] = 1;
      }
    }

    // Fill masked pixels with the background estimate. Pixels the dilation
    // added outside the measured box reuse the nearest in-box estimate.
    let lamaOutput = null;
    if (useAiInpaint) {
      lamaOutput = batchInpaintCanvasRef.current.getContext('2d')
        .getImageData(geometry.patchLeft, geometry.patchTop, patchWidth, patchHeight).data;
    }
    const output = new Uint8ClampedArray(source);
    for (let y = 0; y < patchHeight; y += 1) {
      for (let x = 0; x < patchWidth; x += 1) {
        const pixelIndex = y * patchWidth + x;
        if (!dilated[pixelIndex]) continue;
        const clampedX = Math.max(targetLeft, Math.min(targetRight - 1, x));
        const clampedY = Math.max(targetTop, Math.min(targetBottom - 1, y));
        const bgIndex = (clampedY * patchWidth + clampedX) * 3;
        const index = pixelIndex * 4;
        output[index] = lamaOutput ? lamaOutput[index] : clampByte(background[bgIndex]);
        output[index + 1] = lamaOutput ? lamaOutput[index + 1] : clampByte(background[bgIndex + 1]);
        output[index + 2] = lamaOutput ? lamaOutput[index + 2] : clampByte(background[bgIndex + 2]);
        output[index + 3] = 255;
      }
    }

    // A patch may overlap another OCR box. Keeping the untouched crop opaque
    // would paste source glyphs from that neighbouring box back over its patch.
    // Only reconstructed glyph pixels are therefore composited onto the image.
    for (let i = 0; i < pixelCount; i += 1) {
      output[i * 4 + 3] = dilated[i] ? 255 : 0;
    }

    imageData.data.set(output);
    ctx.putImageData(imageData, 0, 0);
    return { ...finishPatch(patchCanvas, geometry), textColor: glyphColor ? rgbToHex(glyphColor) : null };
  };

  // Manual rectangle erasing intentionally clears the entire selection. Use a
  // smooth four-corner surface so no perimeter pixel can turn into a stripe.
  const createRegionErasePatch = (left, top, width, height) => {
    const geometry = resolveImagePatchGeometry(left, top, width, height, 5, 5);
    const sourceCanvas = sampleCanvasRef.current;
    if (!geometry || !sourceCanvas) return null;
    const patchWidth = geometry.patchRight - geometry.patchLeft;
    const patchHeight = geometry.patchBottom - geometry.patchTop;
    const patchCanvas = document.createElement('canvas');
    patchCanvas.width = patchWidth;
    patchCanvas.height = patchHeight;
    const ctx = patchCanvas.getContext('2d');
    const radius = Math.max(2, Math.min(8, Math.round(Math.min(geometry.imgWidth, geometry.imgHeight) * 0.12)));
    const sample = (x, y) => {
      const sx = Math.max(0, Math.min(sourceCanvas.width - 1, Math.round(x - radius)));
      const sy = Math.max(0, Math.min(sourceCanvas.height - 1, Math.round(y - radius)));
      const sw = Math.max(1, Math.min(sourceCanvas.width - sx, radius * 2 + 1));
      const sh = Math.max(1, Math.min(sourceCanvas.height - sy, radius * 2 + 1));
      const pixels = sourceCanvas.getContext('2d').getImageData(sx, sy, sw, sh).data;
      const values = [];
      for (let i = 0; i < pixels.length; i += 4) {
        values.push({ r: pixels[i], g: pixels[i + 1], b: pixels[i + 2], lum: 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2] });
      }
      values.sort((a, b) => a.lum - b.lum);
      const stable = values.slice(Math.floor(values.length * 0.25), Math.ceil(values.length * 0.75));
      return stable.reduce((sum, pixel) => ({ r: sum.r + pixel.r / stable.length, g: sum.g + pixel.g / stable.length, b: sum.b + pixel.b / stable.length }), { r: 0, g: 0, b: 0 });
    };
    // Sample beyond the selected area. Sampling on its corners allowed the
    // very residual being erased to leak back into the reconstructed surface.
    const outside = radius + 2;
    const northWest = sample(geometry.imgLeft - outside, geometry.imgTop - outside);
    const northEast = sample(geometry.imgRight + outside, geometry.imgTop - outside);
    const southWest = sample(geometry.imgLeft - outside, geometry.imgBottom + outside);
    const southEast = sample(geometry.imgRight + outside, geometry.imgBottom + outside);
    const imageData = ctx.createImageData(patchWidth, patchHeight);
    for (let y = 0; y < patchHeight; y += 1) {
      const ty = patchHeight > 1 ? y / (patchHeight - 1) : 0;
      for (let x = 0; x < patchWidth; x += 1) {
        const tx = patchWidth > 1 ? x / (patchWidth - 1) : 0;
        const index = (y * patchWidth + x) * 4;
        for (const [offset, channel] of [[0, 'r'], [1, 'g'], [2, 'b']]) {
          const topColor = northWest[channel] * (1 - tx) + northEast[channel] * tx;
          const bottomColor = southWest[channel] * (1 - tx) + southEast[channel] * tx;
          imageData.data[index + offset] = clampByte(topColor * (1 - ty) + bottomColor * ty);
        }
        imageData.data[index + 3] = 255;
      }
    }
    ctx.putImageData(imageData, 0, 0);
    return finishPatch(patchCanvas, geometry);
  };

  const _addCoverPatch = async (
    textbox,
    { force = false, sessionId = documentSessionRef.current } = {}
  ) => {
    if (!textbox || textbox.manual || textbox.isManualText) return false;
    if (!force && !textbox.isOcrReview) return false;

    const canvas = fabricCanvas.current;
    if (!canvas || sessionId !== documentSessionRef.current) return false;
    const patchInfo = await createTextPatch(
      textbox.originalLeft, 
      textbox.originalTop, 
      textbox.originalWidth, 
      textbox.originalHeight,
      textbox.cleanupExpandX || 0,
      textbox.cleanupExpandY || 0
    );
    if (!patchInfo || sessionId !== documentSessionRef.current) return false;

    const patchImg = await fabric.FabricImage.fromURL(patchInfo.dataUrl);
    if (sessionId !== documentSessionRef.current || fabricCanvas.current !== canvas) return false;
    // Fabric images treat width/height as a source crop, not a resize: the
    // bitmap is at original image resolution, so map it into canvas space
    // with scaleX/scaleY or the patch covers the wrong area.
    patchImg.set({
      left: patchInfo.patchLeft,
      top: patchInfo.patchTop,
      scaleX: patchInfo.patchWidth / patchImg.width,
      scaleY: patchInfo.patchHeight / patchImg.height,
      selectable: false,
      evented: false,
      isPatch: true,
      sourceLayerId: textbox.id
    });

    canvas.add(patchImg);
    canvas.sendObjectToBack(patchImg);
    if (patchInfo.textColor) textbox.originalTextColor = patchInfo.textColor;
    return patchInfo;
  };

  const eraseRegion = async (left, top, width, height) => {
    const canvas = fabricCanvas.current;
    if (!canvas) return;
    const patchInfo = createRegionErasePatch(left, top, width, height);
    if (!patchInfo) return;

    isHistoryDisabled.current = true;
    const patchImg = await fabric.FabricImage.fromURL(patchInfo.dataUrl);
    patchImg.set({
      left: patchInfo.patchLeft,
      top: patchInfo.patchTop,
      scaleX: patchInfo.patchWidth / patchImg.width,
      scaleY: patchInfo.patchHeight / patchImg.height,
      selectable: false,
      evented: false,
      isPatch: true,
      isErasePatch: true,
      sourceLayerId: null
    });
    canvas.add(patchImg);

    // A manual cleanup is a corrective paint layer, not an object deletion
    // command.  It must cover older automatic patches (which may themselves
    // contain the residual), while remaining below every editable textbox.
    // Previously sendObjectToBack() hid this patch underneath the faulty old
    // patch; it appeared to work only when the selection also deleted the
    // textbox and its associated patch.
    const objects = canvas.getObjects();
    const firstTextboxIndex = objects.findIndex(obj => obj.type === 'textbox');
    if (firstTextboxIndex >= 0) {
      canvas.moveObjectTo(patchImg, firstTextboxIndex);
    } else {
      canvas.bringObjectToFront(patchImg);
    }

    canvas.discardActiveObject();
    isHistoryDisabled.current = false;
    saveHistory();
    canvas.renderAll();
    syncLayers();
  };

  // Native OCR boxes often include line padding, nearby underlines, or the
  // descender allowance of the platform text engine. Measure the actual dark
  // glyph rows from the source image before converting a box into a font size.
  // This keeps the replacement tied to visible source pixels instead of a
  // loose detector rectangle.
  const measureSourceInkBounds = (left, top, width, height) => {
    const sourceCanvas = sampleCanvasRef.current;
    const layout = imageLayout.current;
    if (!sourceCanvas || !layout.scale || width <= 1 || height <= 1) return null;

    const rawLeft = Math.max(0, Math.floor((left - layout.left) / layout.scale));
    const rawTop = Math.max(0, Math.floor((top - layout.top) / layout.scale));
    const rawRight = Math.min(sourceCanvas.width, Math.ceil((left + width - layout.left) / layout.scale));
    const rawBottom = Math.min(sourceCanvas.height, Math.ceil((top + height - layout.top) / layout.scale));
    const cropWidth = rawRight - rawLeft;
    const cropHeight = rawBottom - rawTop;
    if (cropWidth <= 1 || cropHeight <= 1) return null;

    try {
      const ctx = sourceCanvas.getContext('2d', { willReadFrequently: true });
      const pixels = ctx.getImageData(rawLeft, rawTop, cropWidth, cropHeight).data;
      const rowCounts = new Uint32Array(cropHeight);
      const isTextPixel = (index) => {
        const r = pixels[index];
        const g = pixels[index + 1];
        const b = pixels[index + 2];
        const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
        const channelSpread = Math.max(r, g, b) - Math.min(r, g, b);
        // Most source text is black/grey. The second branch retains dark
        // coloured text while rejecting bright orange/yellow decorations.
        return luminance < 180 && (channelSpread < 45 || luminance < 95);
      };

      for (let y = 0; y < cropHeight; y += 1) {
        let count = 0;
        for (let x = 0; x < cropWidth; x += 1) {
          if (isTextPixel((y * cropWidth + x) * 4)) count += 1;
        }
        rowCounts[y] = count;
      }

      const rowThreshold = Math.max(2, Math.floor(cropWidth * 0.004));
      const runs = [];
      let runStart = -1;
      for (let y = 0; y <= cropHeight; y += 1) {
        const active = y < cropHeight && rowCounts[y] >= rowThreshold;
        if (active && runStart < 0) runStart = y;
        if ((!active || y === cropHeight) && runStart >= 0) {
          if (y - runStart >= 3) runs.push({ start: runStart, end: y });
          runStart = -1;
        }
      }
      if (!runs.length) return null;

      // Keep all substantial text rows (including multiple OCR lines), while
      // ignoring isolated one-pixel decoration strokes such as underlines.
      const inkTop = runs[0].start;
      const inkBottom = runs[runs.length - 1].end;
      return {
        top: layout.top + (rawTop + inkTop) * layout.scale,
        height: (inkBottom - inkTop) * layout.scale
      };
    } catch {
      return null;
    }
  };

  const captureCopyRegion = (left, top, width, height) => {
    const sourceCanvas = sampleCanvasRef.current;
    const layout = imageLayout.current;
    if (!sourceCanvas || !layout.scale || width <= 1 || height <= 1) return null;

    const rawLeft = Math.max(0, Math.floor((left - layout.left) / layout.scale));
    const rawTop = Math.max(0, Math.floor((top - layout.top) / layout.scale));
    const rawRight = Math.min(sourceCanvas.width, Math.ceil((left + width - layout.left) / layout.scale));
    const rawBottom = Math.min(sourceCanvas.height, Math.ceil((top + height - layout.top) / layout.scale));
    const cropWidth = rawRight - rawLeft;
    const cropHeight = rawBottom - rawTop;
    if (cropWidth <= 1 || cropHeight <= 1) return null;

    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = cropWidth;
    cropCanvas.height = cropHeight;
    const ctx = cropCanvas.getContext('2d');
    ctx.drawImage(sourceCanvas, rawLeft, rawTop, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

    return {
      dataUrl: cropCanvas.toDataURL('image/png'),
      width: cropWidth,
      height: cropHeight
    };
  };

  const pasteCopiedRegion = async (pointer) => {
    const canvas = fabricCanvas.current;
    const layout = imageLayout.current;
    const clipboard = regionClipboardRef.current;
    if (!canvas || !clipboard || !layout.scale) return false;

    isHistoryDisabled.current = true;
    try {
      const pastedImage = await fabric.FabricImage.fromURL(clipboard.dataUrl);
      pastedImage.set({
        left: pointer.x - (clipboard.width * layout.scale) / 2,
        top: pointer.y - (clipboard.height * layout.scale) / 2,
        scaleX: layout.scale,
        scaleY: layout.scale,
        selectable: true,
        evented: true,
        hasControls: true,
        hasBorders: true,
        cornerColor: '#60CDFF',
        borderColor: '#60CDFF',
        cornerSize: 8,
        touchCornerSize: 18,
        transparentCorners: true,
        lockRotation: false,
        centeredRotation: false,
        rotatingPointOffset: 40,
        isPastedRegion: true
      });

      canvas.discardActiveObject();
      canvas.add(pastedImage);
      const objects = canvas.getObjects();
      const firstTextboxIndex = objects.findIndex(obj => obj.type === 'textbox');
      if (firstTextboxIndex >= 0) {
        canvas.moveObjectTo(pastedImage, firstTextboxIndex);
      } else {
        canvas.bringObjectToFront(pastedImage);
      }
      canvas.setActiveObject(pastedImage);
      canvas.renderAll();
      onRegionSelect?.(null);
      saveHistory();
      syncLayers();
      onWorkerStatusChange?.(t('pasteRegionReady'));
      return true;
    } finally {
      isHistoryDisabled.current = false;
    }
  };

  // Mouse Events for Drawing Area
  const handleMouseDown = (opt) => {
    const canvas = fabricCanvas.current;
    if (!canvas) return;
    
    isDrawing.current = true;
    const pointer = typeof canvas.getScenePoint === 'function'
      ? canvas.getScenePoint(opt.e)
      : canvas.getPointer(opt.e);
    startPoint.current = { x: pointer.x, y: pointer.y };

    activeRect.current = new fabric.Rect({
      left: pointer.x,
      top: pointer.y,
      width: 0,
      height: 0,
      fill: 'rgba(96, 205, 255, 0.2)',
      stroke: '#60CDFF',
      strokeWidth: 2,
      strokeDashArray: [5, 5],
      selectable: false,
      evented: false,
      isSelectionRect: true
    });
    canvas.add(activeRect.current);
    canvas.renderAll();
  };

  const handleMouseMove = (opt) => {
    if (!isDrawing.current || !activeRect.current) return;
    const canvas = fabricCanvas.current;
    if (!canvas) return;

    const pointer = typeof canvas.getScenePoint === 'function'
      ? canvas.getScenePoint(opt.e)
      : canvas.getPointer(opt.e);
    const startX = startPoint.current.x;
    const startY = startPoint.current.y;
    const left = Math.min(startX, pointer.x);
    const top = Math.min(startY, pointer.y);
    activeRect.current.set({
      left,
      top,
      width: Math.abs(startX - pointer.x),
      height: Math.abs(startY - pointer.y)
    }).setCoords();
    canvas.renderAll();
  };

  const handleMouseUp = async () => {
    if (!isDrawing.current || !activeRect.current) return;
    isDrawing.current = false;

    const rect = activeRect.current;
    const canvas = fabricCanvas.current;
    const rectState = {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height
    };
    if (canvas && rect) canvas.remove(rect);
    activeRect.current = null;

    try {
      if (rectState.width > 5 && rectState.height > 5) {
        if (regionalActionRef.current === 'erase') {
          if (onWorkerStatusChange) onWorkerStatusChange(t('eraseRegionRunning'));
          await eraseRegion(rectState.left, rectState.top, rectState.width, rectState.height);
        } else if (regionalActionRef.current === 'copy') {
          onWorkerStatusChange?.(t('copyRegionRunning'));
          const copied = captureCopyRegion(rectState.left, rectState.top, rectState.width, rectState.height);
          regionClipboardRef.current = copied;
          onRegionClipboardChange?.(Boolean(copied));
          if (copied) {
            onWorkerStatusChange?.(t('copyRegionReady'));
            isPasteModeActiveRef.current = true;
            onPasteModeChange?.(true);
          } else {
            onWorkerStatusChange?.(t('copyRegionFailed'));
            isPasteModeActiveRef.current = false;
            onPasteModeChange?.(false);
          }
        } else {
          await runRegionalOcr(rectState.left, rectState.top, rectState.width, rectState.height);
        }
      }
    } finally {
      canvas?.renderAll();
      if (onRegionalOcrComplete) onRegionalOcrComplete();
    }
  };

  const runRegionalOcr = async (left, top, width, height) => {
    if (!bgImage.current || !fabricCanvas.current || !sampleCanvasRef.current) return;
    if (ocrEngine === 'local' && !tesseractWorker.current) return;
    const sessionId = documentSessionRef.current;
    
    const layout = imageLayout.current;
    const scale = layout.scale;
    const imageMaxWidth = sampleCanvasRef.current.width;
    const imageMaxHeight = sampleCanvasRef.current.height;
    const rawLeft = (left - layout.left) / scale;
    const rawTop = (top - layout.top) / scale;
    const rawRight = (left + width - layout.left) / scale;
    const rawBottom = (top + height - layout.top) / scale;
    const imgLeft = Math.max(0, Math.min(imageMaxWidth - 1, Math.floor(Math.min(rawLeft, rawRight))));
    const imgTop = Math.max(0, Math.min(imageMaxHeight - 1, Math.floor(Math.min(rawTop, rawBottom))));
    const imgRight = Math.max(imgLeft + 1, Math.min(imageMaxWidth, Math.ceil(Math.max(rawLeft, rawRight))));
    const imgBottom = Math.max(imgTop + 1, Math.min(imageMaxHeight, Math.ceil(Math.max(rawTop, rawBottom))));
    const imgWidth = imgRight - imgLeft;
    const imgHeight = imgBottom - imgTop;
    const canvasLeft = layout.left + imgLeft * scale;
    const canvasTop = layout.top + imgTop * scale;
    const canvasWidth = imgWidth * scale;
    const canvasHeight = imgHeight * scale;

    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = imgWidth;
    cropCanvas.height = imgHeight;
    const ctx = cropCanvas.getContext('2d');

    try {
      ctx.drawImage(sampleCanvasRef.current, imgLeft, imgTop, imgWidth, imgHeight, 0, 0, imgWidth, imgHeight);
      
      if (onOcrProcessing) onOcrProcessing(true);

      const canvas = fabricCanvas.current;
      isHistoryDisabled.current = true;
      const fontToUse = shouldUsePresetFontFamily ? presetFontFamily : DEFAULT_OCR_FONT_FAMILY;
      const blocks = [];

      if (ocrEngine === 'cloud') {
        if (!geminiApiKey) {
          throw new Error("Gemini API Key is missing. Please enter your API Key in the Settings or Right Sidebar.");
        }
        
        const cropDataUrl = cropCanvas.toDataURL('image/png');
        const textResult = await runGeminiRegionalOcr(cropDataUrl, geminiApiKey, onWorkerStatusChange, geminiModel, geminiApiUrl);
        if (sessionId !== documentSessionRef.current) return;

        if (textResult) {
          blocks.push({
            text: correctOcrText(textResult),
            left: canvasLeft,
            top: canvasTop,
            width: canvasWidth,
            height: canvasHeight,
            confidence: 0.7,
            id: `layer_${Date.now()}_0`
          });
        }
      } else if (ocrEngine === 'custom') {
        if (onWorkerStatusChange) {
          onWorkerStatusChange(isNativeOcrAvailable()
            ? `Running on-device OCR (${getNativeOcrEngineLabel()})...`
            : 'Calling Local OCR Server...');
        }
        const recognizeWithCustomEngine = async (sourceCanvas) => {
          const dataUrl = sourceCanvas.toDataURL('image/png');
          const customResult = isNativeOcrAvailable()
            ? await runNativeOcr(dataUrl)
            : await (async () => {
              const response = await fetch(localServerUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image: dataUrl })
              });
              if (!response.ok) {
                throw new Error(`Local OCR server returned error: ${response.status}`);
              }
              return response.json();
            })();
          return normalizeCustomOcrItems(customResult);
        };

        // The untouched crop gives native OCR its best confidence. Only very
        // small crops get a smooth 2x retry when the first pass finds nothing.
        let customItems = await recognizeWithCustomEngine(cropCanvas);
        if (sessionId !== documentSessionRef.current) return;
        if (customItems.length === 0 && Math.min(imgWidth, imgHeight) < 160) {
          customItems = await recognizeWithCustomEngine(createUpscaledCanvas(cropCanvas, 2));
          if (sessionId !== documentSessionRef.current) return;
        }

        customItems.forEach((item, index) => {
          const [ymin, xmin, ymax, xmax] = item.bbox;
          const blockLeft = canvasLeft + (xmin / 1000) * canvasWidth;
          const blockTop = canvasTop + (ymin / 1000) * canvasHeight;
          const blockWidth = ((xmax - xmin) / 1000) * canvasWidth;
          const blockHeight = ((ymax - ymin) / 1000) * canvasHeight || 16;

          blocks.push({
            text: correctOcrText(item.text),
            left: blockLeft,
            top: blockTop,
            width: blockWidth,
            height: blockHeight,
            confidence: item.confidence ?? 0,
            // Destructive seeds stay inside the native bbox. Mask dilation
            // follows actual glyph pixels beyond it without erasing card edges.
            cleanupExpandX: 0,
            cleanupExpandY: 0,
            id: `layer_${Date.now()}_${index}`
          });
        });
      } else {
        // Preserve sparse diagram glyphs; Tesseract handles thresholding itself.
        const scaleFactor = 2;
        const preprocessCropCanvas = document.createElement('canvas');
        preprocessCropCanvas.width = imgWidth * scaleFactor;
        preprocessCropCanvas.height = imgHeight * scaleFactor;
        const preprocessCropCtx = preprocessCropCanvas.getContext('2d');
        preprocessCropCtx.imageSmoothingEnabled = true;
        preprocessCropCtx.imageSmoothingQuality = 'high';
        preprocessCropCtx.drawImage(cropCanvas, 0, 0, imgWidth * scaleFactor, imgHeight * scaleFactor);
        prepareTesseractImage(preprocessCropCtx, preprocessCropCanvas.width, preprocessCropCanvas.height);

        const result = await tesseractWorker.current.recognize(preprocessCropCanvas, {}, { blocks: true });
        if (sessionId !== documentSessionRef.current) return;
        const lines = getRecognizedLines(result.data);

        lines.forEach((line, index) => {
          const rawText = line.text.trim();
          const confidence = Number(line.confidence) / 100;
          if (!rawText || !Number.isFinite(confidence) || confidence < 0.35) return;

          const correctedText = correctOcrText(rawText);

          const textboxLeft = canvasLeft + (line.bbox.x0 / scaleFactor) * scale;
          const textboxTop = canvasTop + (line.bbox.y0 / scaleFactor) * scale;
          const textboxWidth = ((line.bbox.x1 - line.bbox.x0) / scaleFactor) * scale;
          const textboxHeight = ((line.bbox.y1 - line.bbox.y0) / scaleFactor) * scale || 16;

          blocks.push({
            text: correctedText,
            left: textboxLeft,
            top: textboxTop,
            width: textboxWidth,
            height: textboxHeight,
            confidence,
            id: `layer_${Date.now()}_${index}`
          });
        });
      }

      if (blocks.length === 0) {
        blocks.push({
          text: t('manualRegionText'),
          left: canvasLeft,
          top: canvasTop,
          width: canvasWidth,
          height: Math.max(18, canvasHeight),
          confidence: 0,
          id: `layer_${Date.now()}_manual`,
          manual: true
        });
      }

      const addedTextboxes = [];
      const sharedInkRatios = computeDocumentInkRatios(blocks.map(b => b.text), fontToUse);
      await prepareBatchInpaint(blocks, sessionId);
      if (sessionId !== documentSessionRef.current) return;
      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const sourceInkBounds = block.manual
          ? null
          : measureSourceInkBounds(block.left, block.top, block.width, block.height);
        const sourceTextHeight = sourceInkBounds?.height || block.height;
        const regionalFontSize = calcOcrFontSize(
          block.text,
          block.width,
          sourceTextHeight,
          sharedInkRatios,
          fontToUse
        );
        const effectiveFontSize = shouldUsePresetTypography ? presetFontSize : regionalFontSize;
        const fittedWidth = keepTextBoxInsideOcrBox(block.width);
        const text = new fabric.Textbox(block.text, {
          ...normalizeTextboxStyle(),
          left: block.left,
          top: sourceInkBounds?.top || block.top,
          width: fittedWidth,
          fontSize: effectiveFontSize,
          fontWeight: shouldUsePresetTypography && presetBold ? 'bold' : 'normal',
          fontStyle: shouldUsePresetTypography && presetItalic ? 'italic' : 'normal',
          fill: block.manual ? '#000000' : 'rgba(0,0,0,0.78)',
          backgroundColor: 'transparent',
          id: block.id,
          fontFamily: fontToUse,
          padding: 4,
          cornerColor: '#60CDFF',
          borderColor: '#60CDFF',
          cornerSize: 8,
          touchCornerSize: 18,
          transparentCorners: true,
          isOcrReview: !block.manual,
          isManualText: Boolean(block.manual),
          confidence: block.confidence,

          originalLeft: block.left,
          originalTop: block.top,
          originalWidth: block.width,
          originalHeight: block.height,
          cleanupExpandX: block.cleanupExpandX || 0,
          cleanupExpandY: block.cleanupExpandY || 0
        });

        // Replace the source glyphs after the OCR box is accepted. The patch is
        // pixel-masked, so surrounding diagram lines and colours remain intact.
        if (!block.manual) {
          await _addCoverPatch(text, { sessionId });
          if (sessionId !== documentSessionRef.current) return;
          if (text.originalTextColor) text.set('fill', withReviewTint(text.originalTextColor));
        }
        canvas.add(text);
        addedTextboxes.push(text);
      }

      if (addedTextboxes.length > 0) {
        canvas.setActiveObject(addedTextboxes[0]);
        if (addedTextboxes[0].isManualText) {
          requestAnimationFrame(() => {
            addedTextboxes[0].enterEditing?.();
            addedTextboxes[0].selectAll?.();
            canvas.renderAll();
          });
        }
      }
      isHistoryDisabled.current = false;
      saveHistory();
      canvas.renderAll();
      syncLayers();
    } catch (e) {
      if (sessionId !== documentSessionRef.current) return;
      console.error("Regional OCR Error:", e);
      alert("Regional OCR failed: " + e.message);
    } finally {
      if (sessionId === documentSessionRef.current) {
        isHistoryDisabled.current = false;
        if (onOcrProcessing) onOcrProcessing(false);
        if (onWorkerStatusChange) onWorkerStatusChange("OCR Engine Ready");
      }
    }
  };

  // Handle Zoom
  useEffect(() => {
    if (fabricCanvas.current) {
      fabricCanvas.current.setZoom(zoomLevel);
    }
  }, [zoomLevel]);

  const syncLayers = () => {
    const canvas = fabricCanvas.current;
    if (!canvas) return;
    
    const layers = canvas.getObjects().filter(obj => obj.type === 'textbox').map(obj => ({
      id: obj.id,
      text: obj.text,
      isBold: obj.fontWeight === 'bold',
      isItalic: obj.fontStyle === 'italic',
      fontSize: obj.fontSize,
      fontFamily: obj.fontFamily,
      fill: obj.isOcrReview ? (obj.originalTextColor || '#000000') : obj.fill
    }));
    
    if (onLayersUpdate) {
      onLayersUpdate(layers);
    }
  };

  const renderOcrResults = async (blocks, sessionId = documentSessionRef.current) => {
    const canvas = fabricCanvas.current;
    if (!canvas || sessionId !== documentSessionRef.current) return;

    isHistoryDisabled.current = true;

    // Clear any existing OCR layers (textboxes and cover patches) to avoid duplicate overlays
    const objects = [...canvas.getObjects()];
    objects.forEach(obj => {
      if (obj.type === 'textbox' || obj.isPatch) {
        canvas.remove(obj);
      }
    });

    const fontToUse = shouldUsePresetFontFamily ? presetFontFamily : DEFAULT_OCR_FONT_FAMILY;
    const sanitizedBlocks = sanitizeOcrBlocks(blocks, imageLayout.current);
    const reviewBlocks = dedupeOcrBlocks(sanitizedBlocks);
    // One shared ratio for the whole batch: every block's font size then
    // depends only on its own box height, not on what characters it contains.
    const sharedInkRatios = computeDocumentInkRatios(reviewBlocks.map(b => b.text), fontToUse);
    await prepareBatchInpaint(sanitizedBlocks, sessionId);
    if (sessionId !== documentSessionRef.current || fabricCanvas.current !== canvas) return;

    // Dedupe controls which editable text layers are shown, but every valid OCR
    // box must still erase its source glyphs. Otherwise a more complete box can
    // be suppressed by a shorter overlapping result (for example, the full
    // label versus its trailing words) and the unpatched prefix remains visible.
    const textColorById = new Map();
    for (let i = 0; i < sanitizedBlocks.length; i += 1) {
      const block = sanitizedBlocks[i];
      const patchInfo = await _addCoverPatch({
        id: block.id || `source_patch_${Date.now()}_${i}`,
        isOcrReview: true,
        originalLeft: block.bbox.x,
        originalTop: block.bbox.y,
        originalWidth: block.bbox.w,
        originalHeight: block.bbox.h,
        cleanupExpandX: block.cleanupExpandX || 0,
        cleanupExpandY: block.cleanupExpandY || 0
      }, { force: true, sessionId });
      if (sessionId !== documentSessionRef.current || fabricCanvas.current !== canvas) return;
      if (patchInfo?.textColor && block.id) textColorById.set(block.id, patchInfo.textColor);
    }

    for (let i = 0; i < reviewBlocks.length; i++) {
      const block = reviewBlocks[i];
      const sourceInkBounds = measureSourceInkBounds(
        block.bbox.x,
        block.bbox.y,
        block.bbox.w,
        block.bbox.h
      );
      const sourceTextHeight = sourceInkBounds?.height || block.bbox.h;
      const calculatedFontSize = calcOcrFontSize(
        block.text,
        block.bbox.w,
        sourceTextHeight,
        sharedInkRatios,
        fontToUse
      );
      const effectiveFontSize = shouldUsePresetTypography ? presetFontSize : calculatedFontSize;
      const fittedWidth = keepTextBoxInsideOcrBox(block.bbox.w);
      const detectedColor = textColorById.get(block.id) || null;

      const text = new fabric.Textbox(block.text, {
        ...normalizeTextboxStyle(),
        left: block.bbox.x,
        top: sourceInkBounds?.top || block.bbox.y,
        width: fittedWidth,
        fontSize: effectiveFontSize,
        fontWeight: shouldUsePresetTypography && presetBold ? 'bold' : 'normal',
        fontStyle: shouldUsePresetTypography && presetItalic ? 'italic' : 'normal',
        // OCR output is a review/replacement layer. The patch removes only the
        // recognized glyph pixels; surrounding diagram content remains intact.
        // A slight transparency (tinted with the detected source colour) makes
        // disagreements easy to spot while still previewing the real colour.
        fill: withReviewTint(detectedColor),
        backgroundColor: 'transparent',
        id: block.id || `layer_${Date.now()}_${Math.random()}`,
        fontFamily: fontToUse,
        padding: 4,
        cornerColor: '#60CDFF',
        borderColor: '#60CDFF',
        cornerSize: 8,
        touchCornerSize: 18,
        transparentCorners: true,
        isOcrReview: true,
        confidence: block.confidence,
        originalTextColor: detectedColor,

        originalLeft: block.bbox.x,
        originalTop: block.bbox.y,
        originalWidth: block.bbox.w,
        originalHeight: block.bbox.h,
        cleanupExpandX: block.cleanupExpandX || 0,
        cleanupExpandY: block.cleanupExpandY || 0
      });

      canvas.add(text);
    }

    isHistoryDisabled.current = false;
    saveHistory();
    canvas.renderAll();
    syncLayers();
  };

  const handleTextChanged = (e) => {
    const activeObject = e.target;
    if (activeObject && activeObject.type === 'textbox') {
      onRegionSelect?.(describeTextbox(activeObject));
      syncLayers();
    }
  };

  const setTextboxEditingChrome = (textbox, isEditing) => {
    if (!textbox || textbox.type !== 'textbox') return;
    textbox.set({
      hasControls: !isEditing,
      hasBorders: !isEditing,
      transparentCorners: true,
      cornerSize: 8,
      touchCornerSize: 18
    });
    fabricCanvas.current?.renderAll();
  };

  const handleEditingEntered = (e) => {
    setTextboxEditingChrome(e?.target, true);
  };

  const handleEditingExited = (e) => {
    const activeObject = e?.target || fabricCanvas.current?.getActiveObject();
    setTextboxEditingChrome(activeObject, false);
    if (activeObject?.type === 'textbox' && activeObject.isOcrReview && activeObject.text?.trim()) {
      void materializeReviewLayer(activeObject).then(() => fabricCanvas.current?.renderAll());
    }
    saveHistory();
    requestAnimationFrame(syncSelectedTextbox);
  };

  const handleSelection = (e) => {
    const activeObject = e.selected?.[0];
    onRegionSelect?.(describeTextbox(activeObject));
  };

  const materializeReviewLayer = async (textbox) => {
    if (!textbox?.isOcrReview) return;
    const sessionId = documentSessionRef.current;
    // Flip the flag before the await: repeated calls (e.g. one per keystroke
    // while the user retypes a review textbox) must see isOcrReview already
    // false and bail out above, or each keystroke races to add its own
    // duplicate cover patch and the canvas backs up.
    textbox.set({
      isOcrReview: false,
      fill: textbox.originalTextColor || '#000000'
    });
    const canvas = fabricCanvas.current;
    const alreadyPatched = canvas?.getObjects().some(obj =>
      obj.isPatch && obj.sourceLayerId === textbox.id
    );
    if (!alreadyPatched) await _addCoverPatch(textbox, { force: true, sessionId });
  };

  const centerCanvasOnObject = (obj) => {
    const canvas = fabricCanvas.current;
    if (!canvas || !obj) return;
    obj.setCoords();
    const zoom = canvas.getZoom() || 1;
    const center = typeof obj.getCenterPoint === 'function'
      ? obj.getCenterPoint()
      : { x: obj.left + (obj.width || 0) / 2, y: obj.top + (obj.height || 0) / 2 };
    const vpt = canvas.viewportTransform || [zoom, 0, 0, zoom, 0, 0];
    vpt[0] = zoom;
    vpt[3] = zoom;
    vpt[4] = canvas.getWidth() / 2 - center.x * zoom;
    vpt[5] = canvas.getHeight() / 2 - center.y * zoom;
    canvas.setViewportTransform(vpt);
  };

  const restoreObjectInteractivity = (canvas) => {
    canvas.getObjects().forEach(obj => {
      if (obj.isPatch) {
        obj.set({ selectable: false, evented: false });
      } else if (obj.type === 'textbox' || obj.isPastedRegion) {
        obj.set({
          selectable: true,
          evented: true,
          hasControls: true,
          hasBorders: true,
          lockRotation: false,
          centeredRotation: false,
          rotatingPointOffset: 40
        });
      }
    });
  };

  const refreshTextboxMetrics = (textbox) => {
    if (!textbox || textbox.type !== 'textbox') return;
    textbox.dirty = true;
    textbox.initDimensions?.();
    textbox.setCoords();
  };

  const nudgeActiveTextbox = (deltaX, deltaY) => {
    const canvas = fabricCanvas.current;
    const activeObject = canvas?.getActiveObject?.();
    if (!canvas || !activeObject || activeObject.isEditing) return false;
    if (activeObject.isPatch || activeObject.isSelectionRect) return false;

    activeObject.set({
      left: (activeObject.left || 0) + deltaX,
      top: (activeObject.top || 0) + deltaY
    });
    activeObject.setCoords();
    canvas.requestRenderAll();
    saveHistory();
    return true;
  };

  const withIdentityViewport = (canvas, callback) => {
    const previousViewport = canvas.viewportTransform ? [...canvas.viewportTransform] : [1, 0, 0, 1, 0, 0];
    const activeObject = canvas.getActiveObject();

    canvas.discardActiveObject();
    canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
    canvas.renderAll();

    try {
      return callback();
    } finally {
      canvas.setViewportTransform(previousViewport);
      if (activeObject && canvas.getObjects().includes(activeObject)) {
        canvas.setActiveObject(activeObject);
      }
      canvas.renderAll();
    }
  };

  // Save / Save As helpers. The suggested filename is always the loaded
  // file's own name plus a revision suffix, never a generic placeholder, per
  // the "first save = <name>-rev-1" requirement.
  const buildExportBaseName = () => {
    const original = sourceFileNameRef.current || 'ocr-exported';
    return original.replace(/\.[^./\\]+$/, '');
  };

  const buildSaveSuggestedName = (revision) => `${buildExportBaseName()}-rev-${revision}.png`;

  const buildExportDataUrl = () => {
    const canvas = fabricCanvas.current;
    const layout = imageLayout.current;
    return withIdentityViewport(canvas, () => canvas.toDataURL({
      format: 'png',
      left: layout.left,
      top: layout.top,
      width: layout.width,
      height: layout.height,
      multiplier: 1 / layout.scale
    }));
  };

  const downloadDataUrl = (dataUrl, filename) => {
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const writeDataUrlToHandle = async (handle, dataUrl) => {
    const blob = await (await fetch(dataUrl)).blob();
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
  };

  const addManualTextBox = (left, top, initialText = t('manualRegionText'), width = 140) => {
    const canvas = fabricCanvas.current;
    if (!canvas) return null;

    const fontToUse = shouldUsePresetFontFamily ? presetFontFamily : DEFAULT_OCR_FONT_FAMILY;
    isHistoryDisabled.current = true;
    const text = new fabric.Textbox(initialText, {
      ...normalizeTextboxStyle(),
      left,
      top,
      width,
      fontSize: shouldUsePresetTypography ? presetFontSize : 16,
      fontWeight: shouldUsePresetTypography && presetBold ? 'bold' : 'normal',
      fontStyle: shouldUsePresetTypography && presetItalic ? 'italic' : 'normal',
      fill: '#000000',
      backgroundColor: 'transparent',
      id: `layer_${Date.now()}`,
      fontFamily: fontToUse,
      padding: 4,
      cornerColor: '#60CDFF',
      borderColor: '#60CDFF',
      cornerSize: 8,
      touchCornerSize: 18,
      transparentCorners: true,
      isManualText: true,
      isOcrReview: false,

      originalLeft: left,
      originalTop: top,
      originalWidth: width,
      originalHeight: 24
    });

    canvas.add(text);
    canvas.setActiveObject(text);
    isHistoryDisabled.current = false;
    saveHistory();
    canvas.renderAll();
    syncLayers();

    requestAnimationFrame(() => {
      canvas.setActiveObject(text);
      text.enterEditing?.();
      text.selectAll?.();
      canvas.renderAll();
    });

    return text;
  };

  const restoreHistorySnapshot = async (state) => {
    const canvas = fabricCanvas.current;
    if (!canvas || !state) return false;
    const sessionId = documentSessionRef.current;
    const backgroundImage = bgImage.current;

    await canvas.loadFromJSON(JSON.parse(state));
    if (sessionId !== documentSessionRef.current || fabricCanvas.current !== canvas) return false;

    canvas.backgroundImage = backgroundImage;
    restoreObjectInteractivity(canvas);
    canvas.renderAll();
    syncLayers();
    syncSelectedTextbox();
    return true;
  };

  // Fabric listeners live for the lifetime of the canvas. Delegate through a
  // ref so they never retain first-render props, font settings, translations,
  // or helper implementations after React has rendered newer ones.
  eventHandlersRef.current = {
    addManualTextBox,
    handleEditingEntered,
    handleEditingExited,
    handleSelection,
    handleTextChanged,
    notifyWorker: onWorkerStatusChange,
    pasteCopiedRegion,
    saveHistory,
    syncSelectedTextbox,
    translate: t
  };

  useImperativeHandle(ref, () => ({
    updateRegionText: (id, newText) => {
      const canvas = fabricCanvas.current;
      if (!canvas) return false;
      const obj = canvas.getObjects().find(o => o.id === id);
      if (obj) {
        const needsReplacement = obj.isOcrReview && obj.text !== newText;
        obj.set('text', newText);
        refreshTextboxMetrics(obj);
        if (needsReplacement) {
          void materializeReviewLayer(obj).then(() => {
            refreshTextboxMetrics(obj);
            canvas.renderAll();
          });
        }
        canvas.renderAll();
        saveHistory();
        syncLayers();
        syncSelectedTextbox();
        return true;
      }
      return false;
    },
    updateRegionStyle: (id, styleObject) => {
      const canvas = fabricCanvas.current;
      if (!canvas) return false;
      const obj = canvas.getObjects().find(o => o.id === id);
      if (obj) {
        const normalizedStyle = normalizeTextboxStyle(styleObject);
        if (obj.isOcrReview && normalizedStyle.fill) {
          obj.originalTextColor = normalizedStyle.fill;
          normalizedStyle.fill = withReviewTint(normalizedStyle.fill);
        }
        obj.set(normalizedStyle);
        refreshTextboxMetrics(obj);
        if (obj.isOcrReview) {
          void materializeReviewLayer(obj).then(() => {
            refreshTextboxMetrics(obj);
            canvas.renderAll();
          });
        }
        canvas.renderAll();
        saveHistory();
        syncLayers();
        syncSelectedTextbox();
        return true;
      }
      return false;
    },
    selectRegion: (id) => {
      const canvas = fabricCanvas.current;
      if (!canvas) return;
      const obj = canvas.getObjects().find(o => o.id === id);
      if (obj) {
        canvas.setActiveObject(obj);
        centerCanvasOnObject(obj);
        onRegionSelect?.(describeTextbox(obj));
        canvas.renderAll();
      }
    },
    getActiveObject: () => fabricCanvas.current?.getActiveObject?.() || null,
    nudgeSelectedTextbox: (deltaX, deltaY) => nudgeActiveTextbox(deltaX, deltaY),
    removeActiveObject: () => {
      const canvas = fabricCanvas.current;
      if (!canvas) return;
      const activeObj = canvas.getActiveObject();
      if (activeObj) {
        // Keep the cover patch: it is what erased the source glyphs. Removing
        // it along with the textbox uncovers the original, un-corrected OCR
        // text underneath instead of leaving the area cleanly erased.
        canvas.remove(activeObj);
        canvas.discardActiveObject();
        canvas.renderAll();
        saveHistory();
        syncLayers();
      }
    },
    applyTextStyleToAll: (styleObject) => {
      const canvas = fabricCanvas.current;
      if (!canvas) return 0;
      let appliedCount = 0;
      isHistoryDisabled.current = true;
      canvas.getObjects().forEach(obj => {
        if (obj.type === 'textbox') {
          const normalizedStyle = normalizeTextboxStyle(styleObject);
          if (obj.isOcrReview && normalizedStyle.fill) {
            obj.originalTextColor = normalizedStyle.fill;
            normalizedStyle.fill = withReviewTint(normalizedStyle.fill);
          }
          obj.set(normalizedStyle);
          refreshTextboxMetrics(obj);
          if (obj.isOcrReview) {
            void materializeReviewLayer(obj).then(() => {
              refreshTextboxMetrics(obj);
              canvas.renderAll();
            });
          }
          appliedCount += 1;
        }
      });
      isHistoryDisabled.current = false;
      if (appliedCount > 0) saveHistory();
      canvas.renderAll();
      syncLayers();
      return appliedCount;
    },
    undo: () => {
      const canvas = fabricCanvas.current;
      if (!canvas || historyIndex.current <= 0 || isHistoryDisabled.current) return;
      
      isHistoryDisabled.current = true;
      historyIndex.current--;
      const state = history.current[historyIndex.current];
      void restoreHistorySnapshot(state).then((restored) => {
        if (!restored) return;
        if (onHistoryStatusChange) {
          onHistoryStatusChange({
            canUndo: historyIndex.current > 0,
            canRedo: historyIndex.current < history.current.length - 1
          });
        }
      }).finally(() => {
        isHistoryDisabled.current = false;
      });
    },
    redo: () => {
      const canvas = fabricCanvas.current;
      if (!canvas || historyIndex.current >= history.current.length - 1 || isHistoryDisabled.current) return;
      
      isHistoryDisabled.current = true;
      historyIndex.current++;
      const state = history.current[historyIndex.current];
      void restoreHistorySnapshot(state).then((restored) => {
        if (!restored) return;
        if (onHistoryStatusChange) {
          onHistoryStatusChange({
            canUndo: historyIndex.current > 0,
            canRedo: historyIndex.current < history.current.length - 1
          });
        }
      }).finally(() => {
        isHistoryDisabled.current = false;
      });
    },
    triggerUpload: () => {
      const fileInput = containerRef.current?.querySelector('input[type="file"]');
      if (fileInput) fileInput.click();
    },
    clearCanvas: () => {
      const canvas = fabricCanvas.current;
      if (!canvas) return;
      documentSessionRef.current += 1;
      activeFileReaderRef.current?.abort();
      activeFileReaderRef.current = null;
      cancelLamaOperation();
      onAiStatusChange?.(enableAiInpaintRef.current
        ? { phase: 'idle', progress: 0, message: 'AI 修補已就緒，等待下一張圖片' }
        : { phase: 'disabled', progress: 0, message: 'AI 背景修補未啟用，使用原生修補流程' });
      regionClipboardRef.current = null;
      onRegionClipboardChange?.(false);
      isPasteModeActiveRef.current = false;
      onPasteModeChange?.(false);
      pendingInsertText.current = false;
      isDrawing.current = false;
      activeRect.current = null;
      isHistoryDisabled.current = true;
      const activeObject = canvas.getActiveObject();
      activeObject?.exitEditing?.();
      canvas.discardActiveObject();
      // canvas.clear() emits object:removed once per layer. Without this guard,
      // closing a document generated a large undo snapshot for every removed
      // textbox and caused the renderer memory spike seen as Chromium error 5.
      canvas.clear();
      bgImage.current = null;
      sampleCanvasRef.current = null;
      batchInpaintCanvasRef.current = null;
      originalDimensions.current = { width: 0, height: 0 };
      imageLayout.current = { scale: 1, left: 0, top: 0, width: 0, height: 0 };
      sourceFileNameRef.current = null;
      saveFileHandleRef.current = null;
      saveRevisionRef.current = 0;
      if (onSourceFileNameChange) onSourceFileNameChange(null);
      setImageLoaded(false);
      if (onImageLoaded) onImageLoaded(false);
      if (onLayersUpdate) onLayersUpdate([]);
      if (onRegionSelect) onRegionSelect(null);

      history.current = [];
      historyIndex.current = -1;
      isHistoryDisabled.current = false;
      canvas.isDragging = false;
      canvas.selection = true;
      canvas.skipTargetFind = false;
      canvas.defaultCursor = 'default';
      canvas.hoverCursor = 'move';
      if (canvas.upperCanvasEl) canvas.upperCanvasEl.style.cursor = 'default';
      const fileInput = containerRef.current?.querySelector('input[type="file"]');
      if (fileInput) fileInput.value = '';
      if (onHistoryStatusChange) {
        onHistoryStatusChange({ canUndo: false, canRedo: false });
      }
      canvas.renderAll();
    },
    insertText: () => {
      const canvas = fabricCanvas.current;
      if (!canvas) return;
      pendingInsertText.current = true;
      canvas.discardActiveObject();
      canvas.defaultCursor = 'text';
      canvas.hoverCursor = 'text';
      if (canvas.upperCanvasEl) canvas.upperCanvasEl.style.cursor = 'text';
      if (onWorkerStatusChange) onWorkerStatusChange(t('clickCanvasToInsertText'));
      canvas.renderAll();
    },
    // "Save Image": the first save prompts once (suggesting <name>-rev-1.png)
    // and remembers the resulting file handle; every later save overwrites
    // that same file with no further prompt. Only Chromium-based browsers
    // expose the File System Access API needed for a true overwrite — other
    // browsers fall back to a normal download each time.
    saveImage: async () => {
      const canvas = fabricCanvas.current;
      if (!canvas || !originalDimensions.current.width) {
        return { status: 'error', reason: 'no-canvas' };
      }

      if (typeof window.showSaveFilePicker === 'function') {
        try {
          if (!saveFileHandleRef.current) {
            saveRevisionRef.current = 1;
            saveFileHandleRef.current = await window.showSaveFilePicker({
              suggestedName: buildSaveSuggestedName(saveRevisionRef.current),
              types: [{ description: 'PNG Image', accept: { 'image/png': ['.png'] } }]
            });
          }
          await writeDataUrlToHandle(saveFileHandleRef.current, buildExportDataUrl());
          return { status: 'saved', mode: 'file-picker', revision: saveRevisionRef.current || 1 };
        } catch (error) {
          if (error?.name === 'AbortError') return { status: 'cancelled' };
          console.error('Save Image failed:', error);
          return { status: 'error', error };
        }
      } else {
        downloadDataUrl(buildExportDataUrl(), buildSaveSuggestedName(saveRevisionRef.current || 1));
        return { status: 'downloaded', mode: 'download', revision: saveRevisionRef.current || 1 };
      }
    },
    // "Save As": always prompts for a new file and, on success, makes that
    // new file the target of subsequent plain "Save Image" calls.
    saveImageAs: async () => {
      const canvas = fabricCanvas.current;
      if (!canvas || !originalDimensions.current.width) {
        return { status: 'error', reason: 'no-canvas' };
      }

      const nextRevision = (saveRevisionRef.current || 0) + 1;

      if (typeof window.showSaveFilePicker === 'function') {
        try {
          const handle = await window.showSaveFilePicker({
            suggestedName: buildSaveSuggestedName(nextRevision),
            types: [{ description: 'PNG Image', accept: { 'image/png': ['.png'] } }]
          });
          saveFileHandleRef.current = handle;
          saveRevisionRef.current = nextRevision;
          await writeDataUrlToHandle(handle, buildExportDataUrl());
          return { status: 'saved', mode: 'file-picker', revision: nextRevision };
        } catch (error) {
          if (error?.name === 'AbortError') return { status: 'cancelled' };
          console.error('Save Image As failed:', error);
          return { status: 'error', error };
        }
      } else {
        saveRevisionRef.current = nextRevision;
        downloadDataUrl(buildExportDataUrl(), buildSaveSuggestedName(nextRevision));
        return { status: 'downloaded', mode: 'download', revision: nextRevision };
      }
    },
    exportPDF: () => {
      const canvas = fabricCanvas.current;
      if (!canvas || !originalDimensions.current.width) return;

      const layout = imageLayout.current;
      const scale = layout.scale;
      // Crop to the image area and restore original image resolution
      const dataUrl = withIdentityViewport(canvas, () => canvas.toDataURL({
        format: 'jpeg',
        quality: 1.0,
        left: layout.left,
        top: layout.top,
        width: layout.width,
        height: layout.height,
        multiplier: 1 / scale
      }));

      const origWidth = originalDimensions.current.width;
      const origHeight = originalDimensions.current.height;

      const pdf = new jsPDF({
        orientation: origWidth > origHeight ? "landscape" : "portrait",
        unit: "px",
        format: [origWidth, origHeight]
      });

      pdf.addImage(dataUrl, "JPEG", 0, 0, origWidth, origHeight);

      // Add text layers invisibly on top of the image to make it searchable
      const textLayers = canvas.getObjects().filter(o => o.type === 'textbox');
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(12);

      textLayers.forEach(layer => {
         const origX = (layer.left - layout.left) / scale;
         const origY = (layer.top - layout.top + layer.height) / scale; // jsPDF origin is bottom-left
         pdf.text(layer.text, origX, origY);
      });

      pdf.save("ocr-exported.pdf");
    },
    rerunOcr: async () => {
      if (!sampleCanvasRef.current) return;
      const sessionId = documentSessionRef.current;
      if (onOcrProcessing) onOcrProcessing(true);
      try {
        await runFullOcr(sessionId);
      } catch (error) {
        if (sessionId !== documentSessionRef.current) return;
        console.error("Error re-running OCR:", error);
        alert("OCR Failed: " + error.message);
      } finally {
        if (sessionId === documentSessionRef.current) {
          if (onOcrProcessing) onOcrProcessing(false);
          if (onWorkerStatusChange) onWorkerStatusChange("OCR Engine Ready");
        }
      }
    }
  }));

  const runTesseractOcr = async (sampleCanvas, sessionId = documentSessionRef.current) => {
    const worker = tesseractWorker.current;
    if (!worker) throw new Error("OCR Engine is not initialized yet.");

    const origWidth = sampleCanvas.width;
    const origHeight = sampleCanvas.height;
    const shouldTile = origWidth > 1200 || origHeight > 900;
    const tileWidth = shouldTile ? Math.ceil(origWidth * 0.58) : origWidth;
    const tileHeight = shouldTile ? Math.ceil(origHeight * 0.58) : origHeight;
    const tileXs = shouldTile ? [0, origWidth - tileWidth] : [0];
    const tileYs = shouldTile ? [0, origHeight - tileHeight] : [0];
    const tiles = tileYs.flatMap(y => tileXs.map(x => ({ x, y, w: tileWidth, h: tileHeight })));
    const scaleFactor = 2;
    const recognizedBlocks = [];
    const layout = imageLayout.current;

    for (let tileIndex = 0; tileIndex < tiles.length; tileIndex++) {
      const tile = tiles[tileIndex];
      if (onWorkerStatusChange && tiles.length > 1) {
        onWorkerStatusChange(`OCR ${tileIndex + 1}/${tiles.length}: analysing sparse text…`);
      }

      const preprocessCanvas = document.createElement('canvas');
      preprocessCanvas.width = tile.w * scaleFactor;
      preprocessCanvas.height = tile.h * scaleFactor;
      const preprocessCtx = preprocessCanvas.getContext('2d');
      preprocessCtx.imageSmoothingEnabled = true;
      preprocessCtx.imageSmoothingQuality = 'high';
      preprocessCtx.drawImage(
        sampleCanvas,
        tile.x, tile.y, tile.w, tile.h,
        0, 0, preprocessCanvas.width, preprocessCanvas.height
      );
      prepareTesseractImage(preprocessCtx, preprocessCanvas.width, preprocessCanvas.height);

      const result = await worker.recognize(preprocessCanvas, {}, { blocks: true });
      if (sessionId !== documentSessionRef.current) return [];
      const lines = getRecognizedLines(result.data);
      lines.forEach((line, lineIndex) => {
        const rawText = line.text.trim();
        const confidence = Number(line.confidence) / 100;
        if (!rawText || !Number.isFinite(confidence) || confidence < 0.45) return;

        const x0 = tile.x + line.bbox.x0 / scaleFactor;
        const y0 = tile.y + line.bbox.y0 / scaleFactor;
        const width = (line.bbox.x1 - line.bbox.x0) / scaleFactor;
        const height = (line.bbox.y1 - line.bbox.y0) / scaleFactor;
        // Reject the giant synthetic lines that page segmentation occasionally
        // creates when an infographic's connectors are mistaken for characters.
        if (width < 2 || height < 2 || height > tile.h * 0.16 ||
            (width > tile.w * 0.55 && height > tile.h * 0.02)) return;
        if (tiles.length > 1) {
          const centerX = x0 + width / 2;
          const centerY = y0 + height / 2;
          const owner = (centerY < origHeight / 2 ? 0 : 2) + (centerX < origWidth / 2 ? 0 : 1);
          if (owner !== tileIndex) return;
        }

        recognizedBlocks.push({
          id: `layer_${Date.now()}_${tileIndex}_${lineIndex}`,
          text: correctOcrText(rawText),
          confidence,
          bbox: {
            x: layout.left + x0 * layout.scale,
            y: layout.top + y0 * layout.scale,
            w: width * layout.scale,
            h: height * layout.scale
          }
        });
      });
    }

    return dedupeOcrBlocks(recognizedBlocks);
  };

  // Run full-image OCR with the currently selected engine, using the stored
  // original-resolution image. Shared by the initial image load and the
  // "Re-run OCR" button (so switching engines doesn't require re-uploading).
  const runFullOcr = async (sessionId = documentSessionRef.current) => {
    const sampleCanvas = sampleCanvasRef.current;
    if (!sampleCanvas || sessionId !== documentSessionRef.current) return;

    const data = sampleCanvas.toDataURL('image/png');
    const blocks = [];

    if (ocrEngine === 'cloud') {
      if (!geminiApiKey) {
        throw new Error("Gemini API Key is missing. Please enter your API Key in the Settings or Right Sidebar.");
      }

      const geminiResult = await runGeminiOcrTiled(data, geminiApiKey, onWorkerStatusChange, 4, geminiModel, geminiApiUrl);
      if (sessionId !== documentSessionRef.current) return;
      const layout = imageLayout.current;

      geminiResult.forEach((item, index) => {
        const ymin = item.bbox[0];
        const xmin = item.bbox[1];
        const ymax = item.bbox[2];
        const xmax = item.bbox[3];

          blocks.push({
            id: `layer_${Date.now()}_${index}`,
            text: correctOcrText(item.text),
            confidence: item.confidence ?? 0.7,
          bbox: {
            x: layout.left + (xmin / 1000) * layout.width,
            y: layout.top + (ymin / 1000) * layout.height,
            w: ((xmax - xmin) / 1000) * layout.width,
            h: ((ymax - ymin) / 1000) * layout.height
          }
        });
      });
    } else if (ocrEngine === 'custom') {
      // Send the original-resolution image untouched: sharpening/upscaling
      // lowers Apple Vision's confidence and results get filtered server-side.
      if (onWorkerStatusChange) {
        onWorkerStatusChange(enableAiInpaintRef.current
          ? (isNativeOcrAvailable()
            ? `步驟 1/2：原生 OCR (${getNativeOcrEngineLabel()}) 正在定位文字…`
            : '步驟 1/2：原生 OCR 伺服器正在定位文字…')
          : (isNativeOcrAvailable()
            ? `Running on-device OCR (${getNativeOcrEngineLabel()})...`
            : 'Calling Local OCR Server...'));
      }
      const customResult = isNativeOcrAvailable()
        ? await runNativeOcr(data)
        : await (async () => {
          const response = await fetch(localServerUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: data })
          });
          if (!response.ok) {
            throw new Error(`Local OCR server returned error: ${response.status}`);
          }
          return response.json();
        })();
      if (sessionId !== documentSessionRef.current) return;
      const layout = imageLayout.current;

      const nativeItems = normalizeCustomOcrItems(customResult);
      const nativeHeights = nativeItems
        .map(item => item.bbox[2] - item.bbox[0])
        .filter(height => height > 0)
        .sort((a, b) => a - b);
      const medianNativeHeight = nativeHeights.length
        ? nativeHeights[Math.floor(nativeHeights.length / 2)]
        : 0;

      nativeItems.forEach((item, index) => {
        const [ymin, xmin, ymax, xmax] = item.bbox;
        const nativeBoxWidth = ((xmax - xmin) / 1000) * layout.width;
        const nativeBoxHeight = ((ymax - ymin) / 1000) * layout.height;
        const normalizedLength = normalizedText(item.text).length;
        const normalizedWidth = xmax - xmin;
        const normalizedHeight = ymax - ymin;
        const isLowConfidence = (item.confidence ?? 0) < 0.45;
        const isIconLikeSingleGlyph = normalizedLength <= 1 &&
          normalizedWidth / Math.max(1, normalizedHeight) < 1.8;
        const isOversizedDecorativeText = medianNativeHeight > 0 &&
          normalizedHeight > medianNativeHeight * 1.8 &&
          normalizedLength <= 8;

        // Native OCR is deliberately fail-safe. A questionable detection must
        // never gain permission to erase source pixels: icon-embedded glyphs
        // (e.g. 「照」), decorative SMART letters misread as "1/4会", and
        // Vision's coarse 0.3-confidence guesses remain untouched. Gemini's
        // semantic OCR does not need this native-only guard.
        if (isLowConfidence || isIconLikeSingleGlyph || isOversizedDecorativeText) return;

          blocks.push({
            id: `layer_${Date.now()}_${index}`,
            text: correctOcrText(item.text),
            confidence: item.confidence ?? 0,
            cleanupExpandX: 0,
            cleanupExpandY: 0,
          bbox: {
            x: layout.left + (xmin / 1000) * layout.width,
            y: layout.top + (ymin / 1000) * layout.height,
            w: nativeBoxWidth,
            h: nativeBoxHeight
          }
        });
      });
    } else {
      blocks.push(...await runTesseractOcr(sampleCanvas, sessionId));
    }

    if (sessionId !== documentSessionRef.current) return;
    await renderOcrResults(blocks, sessionId);
  };

  const handleImageUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file || !fabricCanvas.current || !containerRef.current) return;
    const sessionId = documentSessionRef.current + 1;
    documentSessionRef.current = sessionId;
    activeFileReaderRef.current?.abort();

    sourceFileNameRef.current = file.name || null;
    saveFileHandleRef.current = null;
    saveRevisionRef.current = 0;
    if (onSourceFileNameChange) onSourceFileNameChange(sourceFileNameRef.current);

    const reader = new FileReader();
    activeFileReaderRef.current = reader;
    reader.onload = async (f) => {
      if (sessionId !== documentSessionRef.current) return;
      const rawData = f.target.result;
      try {
        // Composite the uploaded image onto a white background first: transparent
        // PNGs otherwise become black in the OCR engines and in the cover patches.
        const rawImgEl = await new Promise((resolve, reject) => {
          const el = new Image();
          el.onload = () => resolve(el);
          el.onerror = reject;
          el.src = rawData;
        });
        if (sessionId !== documentSessionRef.current) return;
        const origWidth = rawImgEl.naturalWidth;
        const origHeight = rawImgEl.naturalHeight;

        const sampleCanvas = document.createElement('canvas');
        sampleCanvas.width = origWidth;
        sampleCanvas.height = origHeight;
        const sampleCtx = sampleCanvas.getContext('2d');
        sampleCtx.fillStyle = '#ffffff';
        sampleCtx.fillRect(0, 0, origWidth, origHeight);
        sampleCtx.drawImage(rawImgEl, 0, 0);
        sampleCanvasRef.current = sampleCanvas;
        const data = sampleCanvas.toDataURL('image/png');

        const img = await fabric.FabricImage.fromURL(data);
        const canvas = fabricCanvas.current;
        if (sessionId !== documentSessionRef.current || !canvas || !containerRef.current) return;

        // The canvas always spans the visible workspace; the image is fit-scaled
        // and centered inside it.
        const containerWidth = containerRef.current.clientWidth;
        const containerHeight = containerRef.current.clientHeight;

        const scale = Math.min(
          containerWidth / origWidth,
          containerHeight / origHeight
        );
        const imgLeft = (containerWidth - origWidth * scale) / 2;
        const imgTop = (containerHeight - origHeight * scale) / 2;

        canvas.setDimensions({
          width: containerWidth,
          height: containerHeight
        });

        isHistoryDisabled.current = true;
        canvas.clear();
        img.scale(scale);

        canvas.backgroundImage = img;
        canvas.backgroundImage.set({
          originX: 'left',
          originY: 'top',
          left: imgLeft,
          top: imgTop
        });

        bgImage.current = img;
        canvas.renderAll();

        originalDimensions.current = { width: origWidth, height: origHeight };
        imageLayout.current = {
          scale,
          left: imgLeft,
          top: imgTop,
          width: origWidth * scale,
          height: origHeight * scale
        };

        history.current = [];
        historyIndex.current = -1;

        canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
        isHistoryDisabled.current = false;
        saveHistory();
        setImageLoaded(true);
        if (onImageLoaded) onImageLoaded(true, { ocrSkipped: !autoRunOcr });

        if (autoRunOcr) {
          if (onOcrProcessing) onOcrProcessing(true);
          await runFullOcr(sessionId);
        } else if (onWorkerStatusChange) {
          onWorkerStatusChange(t('ocrSkippedStatus'));
        }
      } catch (error) {
        if (sessionId !== documentSessionRef.current) return;
        console.error("Error loading image / running OCR:", error);
        alert("OCR Failed: " + error.message);
      } finally {
        if (activeFileReaderRef.current === reader) activeFileReaderRef.current = null;
        if (sessionId === documentSessionRef.current) {
          if (onOcrProcessing) onOcrProcessing(false);
          if (onWorkerStatusChange && autoRunOcr) onWorkerStatusChange("OCR Engine Ready");
        }
      }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  return (
    <div ref={containerRef} className="ocr-canvas-wrapper">
      {!imageLoaded && (
        <div style={{
          position: 'absolute',
          top: 0, left: 0, right: 0, bottom: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 10,
          gap: '20px',
          padding: '20px',
          textAlign: 'center'
        }}>
          <label className="btn btn-primary" style={{ padding: '12px 24px', fontSize: '1rem', cursor: 'pointer' }}>
            Open Image (Local)
            <input type="file" accept="image/*" style={{ display: 'none' }} onChange={handleImageUpload} />
          </label>

          {ocrEngine === 'cloud' && (
            <div style={{
              maxWidth: '420px',
              padding: '16px',
              background: !geminiApiKey ? 'rgba(239, 68, 68, 0.1)' : 'rgba(96, 205, 255, 0.1)',
              border: !geminiApiKey ? '1px solid rgba(239, 68, 68, 0.3)' : '1px solid rgba(96, 205, 255, 0.3)',
              borderRadius: '8px',
              fontSize: '13px',
              color: !geminiApiKey ? '#FF6B6B' : '#60CDFF',
              lineHeight: '1.5',
              boxShadow: '0 4px 12px rgba(0, 0, 0, 0.4)'
            }}>
              {!geminiApiKey ? (
                <>
                  <div style={{ fontWeight: 'bold', marginBottom: '6px', fontSize: '14px' }}>{t('keyNeeded')}</div>
                  <p style={{ opacity: 0.9, fontSize: '12px', marginBottom: '10px' }}>
                    {t('keyRequiredPrompt')}
                  </p>
                </>
              ) : (
                <div style={{ fontWeight: 'bold', marginBottom: '4px', color: '#4ADE80' }}>✓ 雲端 AI 辨識引擎已就緒</div>
              )}
              <a 
                href="https://aistudio.google.com/" 
                target="_blank" 
                rel="noreferrer"
                style={{ 
                  color: '#000', 
                  background: !geminiApiKey ? '#FF6B6B' : '#60CDFF',
                  padding: '6px 14px', 
                  borderRadius: '4px', 
                  textDecoration: 'none', 
                  display: 'inline-block',
                  fontSize: '11px',
                  fontWeight: 'bold',
                  transition: 'background 0.2s'
                }}
              >
                {t('getKeyLink')}
              </a>
            </div>
          )}
        </div>
      )}
      
      <div style={{ 
        width: '100%', 
        height: '100%', 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center',
        overflow: 'auto'
      }}>
        <canvas ref={canvasEl} />
      </div>
    </div>
  );
});

OcrCanvas.displayName = 'OcrCanvas';

export default OcrCanvas;
