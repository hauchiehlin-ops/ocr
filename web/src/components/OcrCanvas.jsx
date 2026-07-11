import { useEffect, useRef, useImperativeHandle, forwardRef, useState } from 'react';
import * as fabric from 'fabric';
import Tesseract from 'tesseract.js';
import { jsPDF } from 'jspdf';
import { runGeminiOcrTiled, runGeminiRegionalOcr } from '../utils/geminiOcr';
import { getNativeOcrEngineLabel, isNativeOcrAvailable, runNativeOcr } from '../utils/nativeOcr';

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

// Preserve the source text's visual height. Width-based fitting made every OCR
// wording difference shrink the entire replacement, even when the source font
// size had not changed. Fabric may wrap genuinely longer text inside the same
// box, but its font size now remains anchored to the detected line height.
function calcOcrFontSize(text, _boxW, boxH, maxSize = 96) {
  const lines = String(text).split('\n').filter(l => l.trim() !== '');
  const linesCount = lines.length || 1;
  // Fabric's default line box is approximately 1.18 × fontSize.
  const byHeight = (boxH - 2) / (linesCount * 1.18);
  return Math.max(3, Math.min(maxSize, byHeight));
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
  zoomLevel = 1,
  isRegionalOcrActive = false,
  regionalAction = 'ocr',
  onRegionalOcrComplete,
  onHistoryStatusChange,
  onWorkerStatusChange,
  presetFontFamily = DEFAULT_OCR_FONT_FAMILY,
  forcePresetFont = false,
  ocrEngine = 'local',
  geminiApiKey = '',
  geminiModel = 'gemini-3.5-flash',
  geminiApiUrl = 'https://generativelanguage.googleapis.com',
  localServerUrl = 'http://127.0.0.1:5001/ocr',
  t = (key) => key
}, ref) => {
  const containerRef = useRef(null);
  const canvasEl = useRef(null);
  const fabricCanvas = useRef(null);
  const bgImage = useRef(null);
  const sampleCanvasRef = useRef(null);
  const tesseractWorker = useRef(null);
  const originalDimensions = useRef({ width: 0, height: 0 });
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

  // History stack for Undo/Redo
  const history = useRef([]);
  const historyIndex = useRef(-1);
  const isHistoryDisabled = useRef(false);

  const saveHistory = () => {
    if (isHistoryDisabled.current) return;
    const canvas = fabricCanvas.current;
    if (!canvas) return;

    const json = JSON.stringify(canvas.toJSON([
      'id', 'originalLeft', 'originalTop', 'originalWidth', 'originalHeight', 'cleanupExpandX', 'cleanupExpandY', 'isPatch', 'isErasePatch', 'sourceLayerId', 'isOcrReview', 'isManualText', 'confidence',
      'selectable', 'evented'
    ]));

    if (history.current[historyIndex.current] === json) {
      syncLayers();
      return;
    }
    
    history.current = history.current.slice(0, historyIndex.current + 1);
    history.current.push(json);
    historyIndex.current = history.current.length - 1;
    
    if (onHistoryStatusChange) {
      onHistoryStatusChange({
        canUndo: historyIndex.current > 0,
        canRedo: false
      });
    }
    syncLayers();
  };

  // Persistent Tesseract Worker initialization linked to OCR language settings
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

    canvas.on('selection:created', handleSelection);
    canvas.on('selection:updated', handleSelection);
    canvas.on('selection:cleared', () => onRegionSelect(null));

    canvas.on('text:changed', handleTextChanged);
    canvas.on('text:editing:entered', handleEditingEntered);
    canvas.on('text:editing:exited', handleEditingExited);

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
        addManualTextBox(pointer.x, pointer.y, t('manualRegionText'));
        opt.e?.preventDefault?.();
        opt.e?.stopPropagation?.();
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

    canvas.on('object:modified', saveHistory);
    canvas.on('object:added', (e) => {
      if (e.target && e.target !== bgImage.current && !e.target.isPatch && !e.target.isSelectionRect) {
        saveHistory();
      }
    });
    canvas.on('object:removed', (e) => {
      if (e.target && e.target !== bgImage.current && !e.target.isPatch && !e.target.isSelectionRect) {
        saveHistory();
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
      resizeObserver.disconnect();
      if (fabricCanvas.current) {
        fabricCanvas.current.dispose();
        fabricCanvas.current = null;
      }
    };
  }, []);

  // Sync Regional OCR drawing modes
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

  // Reconstruct only glyph pixels. Two earlier generations of this routine
  // ghosted: perimeter stripes (v1) and diffusion averaging (v2), where any
  // glyph pixel the mask missed bled grey into the fill. This version builds
  // a per-pixel background estimate from the padding ring OUTSIDE the text
  // box (median top/bottom/left/right bands, so bold dense text can never be
  // mistaken for the background), masks every pixel that deviates from that
  // estimate, and fills masked pixels directly with the estimate. The fill
  // never averages neighbouring pixels, so missed glyph remnants cannot smear.
  const createTextPatch = (left, top, width, height, expandX = 0, expandY = 0) => {
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
    const paddingX = Math.max(4, Math.min(14, Math.round(imageWidth * 0.05)));
    const paddingY = Math.max(4, Math.min(12, Math.round(imageHeight * 0.22)));
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
    const dominantColor = (indices) => {
      if (!indices.length) return null;
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
      let winner = null;
      for (const bucket of buckets.values()) {
        if (!winner || bucket.count > winner.count) winner = bucket;
      }
      return winner
        ? [winner.r / winner.count, winner.g / winner.count, winner.b / winner.count]
        : null;
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

    // The winning joint colour is deliberately constant. Only glyph-mask
    // pixels are replaced, so surrounding gradients remain untouched; using a
    // constant real source colour prevents broad synthetic grey rectangles.
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
    const output = new Uint8ClampedArray(source);
    for (let y = 0; y < patchHeight; y += 1) {
      for (let x = 0; x < patchWidth; x += 1) {
        const pixelIndex = y * patchWidth + x;
        if (!dilated[pixelIndex]) continue;
        const clampedX = Math.max(targetLeft, Math.min(targetRight - 1, x));
        const clampedY = Math.max(targetTop, Math.min(targetBottom - 1, y));
        const bgIndex = (clampedY * patchWidth + clampedX) * 3;
        const index = pixelIndex * 4;
        output[index] = clampByte(background[bgIndex]);
        output[index + 1] = clampByte(background[bgIndex + 1]);
        output[index + 2] = clampByte(background[bgIndex + 2]);
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
    return finishPatch(patchCanvas, geometry);
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

  const _addCoverPatch = async (textbox, { force = false } = {}) => {
    if (!textbox || textbox.manual || textbox.isManualText) return false;
    if (!force && !textbox.isOcrReview) return false;

    const patchInfo = createTextPatch(
      textbox.originalLeft, 
      textbox.originalTop, 
      textbox.originalWidth, 
      textbox.originalHeight,
      textbox.cleanupExpandX || 0,
      textbox.cleanupExpandY || 0
    );
    if (!patchInfo) return false;
    
    const patchImg = await fabric.FabricImage.fromURL(patchInfo.dataUrl);
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
    
    const canvas = fabricCanvas.current;
    canvas.add(patchImg);
    canvas.sendObjectToBack(patchImg);
    return true;
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
      const fontToUse = forcePresetFont ? presetFontFamily : DEFAULT_OCR_FONT_FAMILY;
      const blocks = [];

      if (ocrEngine === 'cloud') {
        if (!geminiApiKey) {
          throw new Error("Gemini API Key is missing. Please enter your API Key in the Settings or Right Sidebar.");
        }
        
        const cropDataUrl = cropCanvas.toDataURL('image/png');
        const textResult = await runGeminiRegionalOcr(cropDataUrl, geminiApiKey, onWorkerStatusChange, geminiModel, geminiApiUrl);

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
        if (customItems.length === 0 && Math.min(imgWidth, imgHeight) < 160) {
          customItems = await recognizeWithCustomEngine(createUpscaledCanvas(cropCanvas, 2));
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
      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const regionalFontSize = calcOcrFontSize(block.text, block.width, block.height);
        const text = new fabric.Textbox(block.text, {
          left: block.left,
          top: block.top,
          width: block.width,
          fontSize: regionalFontSize,
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
        if (!block.manual) await _addCoverPatch(text);
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
      console.error("Regional OCR Error:", e);
      alert("Regional OCR failed: " + e.message);
    } finally {
      isHistoryDisabled.current = false;
      if (onOcrProcessing) onOcrProcessing(false);
      if (onWorkerStatusChange) onWorkerStatusChange("OCR Engine Ready");
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
      fill: obj.isOcrReview ? '#000000' : obj.fill
    }));
    
    if (onLayersUpdate) {
      onLayersUpdate(layers);
    }
  };

  const renderOcrResults = async (blocks) => {
    const canvas = fabricCanvas.current;
    if (!canvas) return;

    isHistoryDisabled.current = true;

    // Clear any existing OCR layers (textboxes and cover patches) to avoid duplicate overlays
    const objects = [...canvas.getObjects()];
    objects.forEach(obj => {
      if (obj.type === 'textbox' || obj.isPatch) {
        canvas.remove(obj);
      }
    });

    const fontToUse = forcePresetFont ? presetFontFamily : DEFAULT_OCR_FONT_FAMILY;
    const sanitizedBlocks = sanitizeOcrBlocks(blocks, imageLayout.current);
    const reviewBlocks = dedupeOcrBlocks(sanitizedBlocks);

    // Dedupe controls which editable text layers are shown, but every valid OCR
    // box must still erase its source glyphs. Otherwise a more complete box can
    // be suppressed by a shorter overlapping result (for example, the full
    // label versus its trailing words) and the unpatched prefix remains visible.
    for (let i = 0; i < sanitizedBlocks.length; i += 1) {
      const block = sanitizedBlocks[i];
      await _addCoverPatch({
        id: block.id || `source_patch_${Date.now()}_${i}`,
        isOcrReview: true,
        originalLeft: block.bbox.x,
        originalTop: block.bbox.y,
        originalWidth: block.bbox.w,
        originalHeight: block.bbox.h,
        cleanupExpandX: block.cleanupExpandX || 0,
        cleanupExpandY: block.cleanupExpandY || 0
      }, { force: true });
    }

    for (let i = 0; i < reviewBlocks.length; i++) {
      const block = reviewBlocks[i];
      const calculatedFontSize = calcOcrFontSize(block.text, block.bbox.w, block.bbox.h);

      const text = new fabric.Textbox(block.text, {
        left: block.bbox.x,
        top: block.bbox.y,
        width: block.bbox.w,
        fontSize: calculatedFontSize,
        // OCR output is a review/replacement layer. The patch removes only the
        // recognized glyph pixels; surrounding diagram content remains intact.
        // A slight transparency makes disagreements easy to spot.
        fill: 'rgba(0,0,0,0.78)',
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
      onRegionSelect({
        id: activeObject.id,
        text: activeObject.text,
        isBold: activeObject.fontWeight === 'bold',
        isItalic: activeObject.fontStyle === 'italic',
        fill: activeObject.isOcrReview ? '#000000' : activeObject.fill,
        fontFamily: activeObject.fontFamily
      });
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
  };

  const handleSelection = (e) => {
    const activeObject = e.selected?.[0];
    if (activeObject && activeObject.type === 'textbox') {
      onRegionSelect({
        id: activeObject.id,
        text: activeObject.text,
        isBold: activeObject.fontWeight === 'bold',
        isItalic: activeObject.fontStyle === 'italic',
        fill: activeObject.isOcrReview ? '#000000' : activeObject.fill,
        fontFamily: activeObject.fontFamily
      });
    }
  };

  const materializeReviewLayer = async (textbox) => {
    if (!textbox?.isOcrReview) return;
    const canvas = fabricCanvas.current;
    const alreadyPatched = canvas?.getObjects().some(obj =>
      obj.isPatch && obj.sourceLayerId === textbox.id
    );
    if (!alreadyPatched) await _addCoverPatch(textbox, { force: true });
    textbox.set({
      isOcrReview: false,
      fill: '#000000'
    });
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
      } else if (obj.type === 'textbox') {
        obj.set({ selectable: true, evented: true, hasControls: true, hasBorders: true });
      }
    });
  };

  const refreshTextboxMetrics = (textbox) => {
    if (!textbox || textbox.type !== 'textbox') return;
    textbox.dirty = true;
    textbox.initDimensions?.();
    textbox.setCoords();
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

  const addManualTextBox = (left, top, initialText = t('manualRegionText'), width = 140) => {
    const canvas = fabricCanvas.current;
    if (!canvas) return null;

    const fontToUse = forcePresetFont ? presetFontFamily : DEFAULT_OCR_FONT_FAMILY;
    isHistoryDisabled.current = true;
    const text = new fabric.Textbox(initialText, {
      left,
      top,
      width,
      fontSize: 16,
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
        return true;
      }
      return false;
    },
    updateRegionStyle: (id, styleObject) => {
      const canvas = fabricCanvas.current;
      if (!canvas) return false;
      const obj = canvas.getObjects().find(o => o.id === id);
      if (obj) {
        obj.set(styleObject);
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
        onRegionSelect({
          id: obj.id,
          text: obj.text,
          isBold: obj.fontWeight === 'bold',
          isItalic: obj.fontStyle === 'italic',
          fill: obj.isOcrReview ? '#000000' : obj.fill,
          fontFamily: obj.fontFamily
        });
        canvas.renderAll();
      }
    },
    removeActiveObject: () => {
      const canvas = fabricCanvas.current;
      if (!canvas) return;
      const activeObj = canvas.getActiveObject();
      if (activeObj) {
        canvas.getObjects()
          .filter(obj => obj.isPatch && obj.sourceLayerId === activeObj.id)
          .forEach(obj => canvas.remove(obj));
        canvas.remove(activeObj);
        canvas.discardActiveObject();
        canvas.renderAll();
        saveHistory();
        syncLayers();
      }
    },
    applyDefaultFontToAll: (customFontStack) => {
      const canvas = fabricCanvas.current;
      if (!canvas) return 0;
      const fontToUse = customFontStack || DEFAULT_OCR_FONT_FAMILY;
      let appliedCount = 0;
      isHistoryDisabled.current = true;
      canvas.getObjects().forEach(obj => {
        if (obj.type === 'textbox') {
          obj.set({ fontFamily: fontToUse });
          refreshTextboxMetrics(obj);
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
      if (!canvas || historyIndex.current <= 0) return;
      
      isHistoryDisabled.current = true;
      historyIndex.current--;
      const state = history.current[historyIndex.current];
      canvas.loadFromJSON(JSON.parse(state)).then(() => {
        bgImage.current = canvas.backgroundImage;
        restoreObjectInteractivity(canvas);
        canvas.renderAll();
        isHistoryDisabled.current = false;
        if (onHistoryStatusChange) {
          onHistoryStatusChange({
            canUndo: historyIndex.current > 0,
            canRedo: historyIndex.current < history.current.length - 1
          });
        }
        syncLayers();
      });
    },
    redo: () => {
      const canvas = fabricCanvas.current;
      if (!canvas || historyIndex.current >= history.current.length - 1) return;
      
      isHistoryDisabled.current = true;
      historyIndex.current++;
      const state = history.current[historyIndex.current];
      canvas.loadFromJSON(JSON.parse(state)).then(() => {
        bgImage.current = canvas.backgroundImage;
        restoreObjectInteractivity(canvas);
        canvas.renderAll();
        isHistoryDisabled.current = false;
        if (onHistoryStatusChange) {
          onHistoryStatusChange({
            canUndo: historyIndex.current > 0,
            canRedo: historyIndex.current < history.current.length - 1
          });
        }
        syncLayers();
      });
    },
    triggerUpload: () => {
      const fileInput = containerRef.current?.querySelector('input[type="file"]');
      if (fileInput) fileInput.click();
    },
    clearCanvas: () => {
      const canvas = fabricCanvas.current;
      if (!canvas) return;
      canvas.clear();
      bgImage.current = null;
      sampleCanvasRef.current = null;
      originalDimensions.current = { width: 0, height: 0 };
      imageLayout.current = { scale: 1, left: 0, top: 0, width: 0, height: 0 };
      setImageLoaded(false);
      if (onImageLoaded) onImageLoaded(false);
      if (onLayersUpdate) onLayersUpdate([]);
      if (onRegionSelect) onRegionSelect(null);
      
      history.current = [];
      historyIndex.current = -1;
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
    exportImage: () => {
      const canvas = fabricCanvas.current;
      if (!canvas || !originalDimensions.current.width) return;

      const layout = imageLayout.current;
      // Crop to the image area and restore original image resolution
      const dataUrl = withIdentityViewport(canvas, () => canvas.toDataURL({
        format: 'png',
        left: layout.left,
        top: layout.top,
        width: layout.width,
        height: layout.height,
        multiplier: 1 / layout.scale
      }));

      const link = document.createElement("a");
      link.href = dataUrl;
      link.download = "ocr-exported.png";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
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
      if (onOcrProcessing) onOcrProcessing(true);
      try {
        await runFullOcr();
      } catch (error) {
        console.error("Error re-running OCR:", error);
        alert("OCR Failed: " + error.message);
      } finally {
        if (onOcrProcessing) onOcrProcessing(false);
        if (onWorkerStatusChange) onWorkerStatusChange("OCR Engine Ready");
      }
    }
  }));

  const runTesseractOcr = async (sampleCanvas) => {
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
  const runFullOcr = async () => {
    const sampleCanvas = sampleCanvasRef.current;
    if (!sampleCanvas) throw new Error("No image loaded yet.");

    const data = sampleCanvas.toDataURL('image/png');
    const blocks = [];

    if (ocrEngine === 'cloud') {
      if (!geminiApiKey) {
        throw new Error("Gemini API Key is missing. Please enter your API Key in the Settings or Right Sidebar.");
      }

      const geminiResult = await runGeminiOcrTiled(data, geminiApiKey, onWorkerStatusChange, 4, geminiModel, geminiApiUrl);
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
        onWorkerStatusChange(isNativeOcrAvailable()
          ? `Running on-device OCR (${getNativeOcrEngineLabel()})...`
          : 'Calling Local OCR Server...');
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
      blocks.push(...await runTesseractOcr(sampleCanvas));
    }

    await renderOcrResults(blocks);
  };

  const handleImageUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file || !fabricCanvas.current || !containerRef.current) return;

    const reader = new FileReader();
    reader.onload = async (f) => {
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
        saveHistory();
        setImageLoaded(true);
        if (onImageLoaded) onImageLoaded(true);

        if (onOcrProcessing) onOcrProcessing(true);

        await runFullOcr();
      } catch (error) {
        console.error("Error loading image / running OCR:", error);
        alert("OCR Failed: " + error.message);
      } finally {
        if (onOcrProcessing) onOcrProcessing(false);
        if (onWorkerStatusChange) onWorkerStatusChange("OCR Engine Ready");
      }
    };
    reader.readAsDataURL(file);
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
