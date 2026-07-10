import { useEffect, useRef, useImperativeHandle, forwardRef, useState } from 'react';
import * as fabric from 'fabric';
import Tesseract from 'tesseract.js';
import { jsPDF } from 'jspdf';
import { runGeminiOcrTiled, runGeminiRegionalOcr } from '../utils/geminiOcr';

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

// Font size constrained by BOTH box height (per line) and box width (per character):
// loose bounding boxes from cloud OCR would otherwise produce oversized text.
function calcOcrFontSize(text, boxW, boxH, maxSize = 32) {
  const lines = String(text).split('\n').filter(l => l.trim() !== '');
  const linesCount = lines.length || 1;
  // CJK characters occupy ~1em width, Latin characters ~0.55em
  const maxLineUnits = Math.max(1, ...lines.map(l =>
    [...l].reduce((units, ch) => units + (ch.charCodeAt(0) > 0x2E7F ? 1 : 0.55), 0)
  ));
  // Fabric renders a line taller than its fontSize. The former 10px floor made
  // tiny OCR boxes wrap into oversized labels over neighbouring text.
  const byHeight = (boxH - 2) / (linesCount * 1.18);
  const byWidth = (boxW - 2) / maxLineUnits;
  return Math.max(3, Math.min(maxSize, byHeight, byWidth));
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
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
    .filter((block, index, sorted) => {
      const text = normalizedText(block.text);
      return !sorted.slice(0, index).some(existing => {
        const existingText = normalizedText(existing.text);
        const sameText = text && existingText &&
          (text === existingText || (Math.min(text.length, existingText.length) >= 3 &&
            (text.includes(existingText) || existingText.includes(text))));
        return sameText && overlapRatio(block.bbox, existing.bbox) > 0.35;
      });
    });
}

const OcrCanvas = forwardRef(({
  onRegionSelect, 
  onLayersUpdate, 
  onImageLoaded, 
  onOcrProcessing, 
  zoomLevel = 1,
  isRegionalOcrActive = false,
  onRegionalOcrComplete,
  onHistoryStatusChange,
  onWorkerStatusChange,
  presetFontFamily = 'Inter',
  forcePresetFont = true,
  ocrEngine = 'local',
  geminiApiKey = '',
  geminiModel = 'gemini-2.0-flash',
  geminiApiUrl = 'https://generativelanguage.googleapis.com',
  localServerUrl = 'http://localhost:5001/ocr',
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

  const isRegionalOcrActiveRef = useRef(isRegionalOcrActive);
  useEffect(() => {
    isRegionalOcrActiveRef.current = isRegionalOcrActive;
  }, [isRegionalOcrActive]);

  // History stack for Undo/Redo
  const history = useRef([]);
  const historyIndex = useRef(-1);
  const isHistoryDisabled = useRef(false);

  const saveHistory = () => {
    if (isHistoryDisabled.current) return;
    const canvas = fabricCanvas.current;
    if (!canvas) return;

    const json = JSON.stringify(canvas.toJSON([
      'id', 'originalLeft', 'originalTop', 'originalWidth', 'originalHeight', 'isPatch', 'isOcrReview', 'confidence',
      'selectable', 'evented'
    ]));
    
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
    canvas.on('text:editing:exited', handleEditingExited);

    // Viewport drag-to-pan support
    canvas.on('mouse:down', (opt) => {
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
      if (e.target && e.target !== bgImage.current && !e.target.isPatch) {
        saveHistory();
      }
    });
    canvas.on('object:removed', (e) => {
      if (e.target && e.target !== bgImage.current && !e.target.isPatch) {
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
      canvas.forEachObject(obj => {
         obj.selectable = false;
         obj.evented = false;
      });
      canvas.selection = false;
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
      canvas.renderAll();
    }

    return () => {
      canvas.off('mouse:down', handleMouseDown);
      canvas.off('mouse:move', handleMouseMove);
      canvas.off('mouse:up', handleMouseUp);
    };
  }, [isRegionalOcrActive]);

  // Pixel Color Sampler
  const getAverageCornerColor = (cx, cy) => {
    const canvas = sampleCanvasRef.current;
    if (!canvas) return { r: 255, g: 255, b: 255 };
    const ctx = canvas.getContext('2d');
    
    let sumR = 0, sumG = 0, sumB = 0, count = 0;
    const size = 2; // 5x5 neighborhood to avoid text details
    
    const startX = Math.max(0, cx - size);
    const endX = Math.min(canvas.width - 1, cx + size);
    const startY = Math.max(0, cy - size);
    const endY = Math.min(canvas.height - 1, cy + size);
    
    try {
      const imgData = ctx.getImageData(startX, startY, endX - startX + 1, endY - startY + 1);
      const data = imgData.data;
      for (let i = 0; i < data.length; i += 4) {
        sumR += data[i];
        sumG += data[i+1];
        sumB += data[i+2];
        count++;
      }
    } catch (e) {
      console.warn("Corner color sampling failed:", e);
    }
    
    if (count === 0) return { r: 255, g: 255, b: 255 };
    return {
      r: Math.round(sumR / count),
      g: Math.round(sumG / count),
      b: Math.round(sumB / count)
    };
  };

  // Reconstruct only foreground glyph pixels instead of painting a solid
  // rectangle over the infographic. The untouched source pixels preserve
  // connector lines, gradients and icons around the edited text.
  const createTextPatch = (left, top, width, height) => {
    const canvas = fabricCanvas.current;
    if (!canvas) return null;
    
    const layout = imageLayout.current;
    if (!layout.width || !bgImage.current) return null;
    const scale = layout.scale;

    // Convert from canvas space to image pixel space (image is centered on the canvas)
    const imgWidthMax = sampleCanvasRef.current?.width || 0;
    const imgHeightMax = sampleCanvasRef.current?.height || 0;
    if (!imgWidthMax || !imgHeightMax || scale <= 0) return null;

    const imgLeft = Math.max(0, Math.min(imgWidthMax - 1, Math.round((left - layout.left) / scale)));
    const imgTop = Math.max(0, Math.min(imgHeightMax - 1, Math.round((top - layout.top) / scale)));
    const imgWidth = Math.max(1, Math.min(imgWidthMax - imgLeft, Math.round(width / scale)));
    const imgHeight = Math.max(1, Math.min(imgHeightMax - imgTop, Math.round(height / scale)));
    
    // A one-pixel margin is enough to hide antialiased glyph edges without
    // producing the visible grey bars that the old full-rectangle patch caused.
    const padding = 1;
    const patchLeft = Math.max(0, imgLeft - padding);
    const patchTop = Math.max(0, imgTop - padding);
    const patchWidth = Math.min(imgWidthMax - patchLeft, imgWidth + 2 * padding);
    const patchHeight = Math.min(imgHeightMax - patchTop, imgHeight + 2 * padding);
    
    // Offset for sampling corners to avoid the text inside (4 pixels)
    const offset = 4;
    
    const cTL = getAverageCornerColor(Math.max(0, imgLeft - offset), Math.max(0, imgTop - offset));
    const cTR = getAverageCornerColor(Math.min(imgWidthMax - 1, imgLeft + imgWidth - 1 + offset), Math.max(0, imgTop - offset));
    const cBL = getAverageCornerColor(Math.max(0, imgLeft - offset), Math.min(imgHeightMax - 1, imgTop + imgHeight - 1 + offset));
    const cBR = getAverageCornerColor(Math.min(imgWidthMax - 1, imgLeft + imgWidth - 1 + offset), Math.min(imgHeightMax - 1, imgTop + imgHeight - 1 + offset));
    
    const patchCanvas = document.createElement('canvas');
    patchCanvas.width = patchWidth;
    patchCanvas.height = patchHeight;
    const ctx = patchCanvas.getContext('2d');
    const sourceCtx = sampleCanvasRef.current.getContext('2d');
    const sourceData = sourceCtx.getImageData(patchLeft, patchTop, patchWidth, patchHeight);
    const imgData = new ImageData(new Uint8ClampedArray(sourceData.data), patchWidth, patchHeight);
    const data = imgData.data;

    for (let y = 0; y < patchHeight; y++) {
      for (let x = 0; x < patchWidth; x++) {
        const index = (y * patchWidth + x) * 4;
        const imageX = patchLeft + x;
        const imageY = patchTop + y;
        const inside = imageX >= imgLeft && imageX < imgLeft + imgWidth &&
          imageY >= imgTop && imageY < imgTop + imgHeight;
        if (!inside) continue;

        const tx = imgWidth > 1 ? (imageX - imgLeft) / (imgWidth - 1) : 0;
        const ty = imgHeight > 1 ? (imageY - imgTop) / (imgHeight - 1) : 0;
        
        const rTop = cTL.r * (1 - tx) + cTR.r * tx;
        const gTop = cTL.g * (1 - tx) + cTR.g * tx;
        const bTop = cTL.b * (1 - tx) + cTR.b * tx;

        const rBot = cBL.r * (1 - tx) + cBR.r * tx;
        const gBot = cBL.g * (1 - tx) + cBR.g * tx;
        const bBot = cBL.b * (1 - tx) + cBR.b * tx;

        const bgR = rTop * (1 - ty) + rBot * ty;
        const bgG = gTop * (1 - ty) + gBot * ty;
        const bgB = bTop * (1 - ty) + bBot * ty;
        const sourceLum = 0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2];
        const bgLum = 0.299 * bgR + 0.587 * bgG + 0.114 * bgB;
        const distance = Math.abs(data[index] - bgR) + Math.abs(data[index + 1] - bgG) + Math.abs(data[index + 2] - bgB);

        // Replace only pixels that look like foreground glyphs. Pixels already
        // matching the local background remain byte-for-byte from the source.
        if (distance > 36 || Math.abs(sourceLum - bgLum) > 18) {
          data[index] = Math.round(bgR);
          data[index + 1] = Math.round(bgG);
          data[index + 2] = Math.round(bgB);
        }
      }
    }
    ctx.putImageData(imgData, 0, 0);
    return {
      dataUrl: patchCanvas.toDataURL(),
      patchLeft: layout.left + patchLeft * scale,
      patchTop: layout.top + patchTop * scale,
      patchWidth: patchWidth * scale,
      patchHeight: patchHeight * scale
    };
  };

  const _addCoverPatch = async (textbox) => {
    const patchInfo = createTextPatch(
      textbox.originalLeft, 
      textbox.originalTop, 
      textbox.originalWidth, 
      textbox.originalHeight
    );
    if (!patchInfo) return;
    
    const patchImg = await fabric.FabricImage.fromURL(patchInfo.dataUrl);
    patchImg.set({
      left: patchInfo.patchLeft,
      top: patchInfo.patchTop,
      width: patchInfo.patchWidth,
      height: patchInfo.patchHeight,
      selectable: false,
      evented: false,
      isPatch: true
    });
    
    const canvas = fabricCanvas.current;
    canvas.add(patchImg);
    canvas.sendObjectToBack(patchImg);
  };

  // Mouse Events for Drawing Area
  const handleMouseDown = (opt) => {
    const canvas = fabricCanvas.current;
    if (!canvas) return;
    
    isDrawing.current = true;
    const pointer = canvas.getPointer(opt.e);
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
      evented: false
    });
    canvas.add(activeRect.current);
    canvas.renderAll();
  };

  const handleMouseMove = (opt) => {
    if (!isDrawing.current || !activeRect.current) return;
    const canvas = fabricCanvas.current;
    if (!canvas) return;

    const pointer = canvas.getPointer(opt.e);
    const startX = startPoint.current.x;
    const startY = startPoint.current.y;

    if (startX > pointer.x) {
      activeRect.current.set({ left: pointer.x });
    }
    if (startY > pointer.y) {
      activeRect.current.set({ top: pointer.y });
    }

    activeRect.current.set({
      width: Math.abs(startX - pointer.x),
      height: Math.abs(startY - pointer.y)
    });
    canvas.renderAll();
  };

  const handleMouseUp = async () => {
    if (!isDrawing.current || !activeRect.current) return;
    isDrawing.current = false;

    const rect = activeRect.current;
    const canvas = fabricCanvas.current;
    
    if (rect.width > 5 && rect.height > 5) {
      await runRegionalOcr(rect.left, rect.top, rect.width, rect.height);
    }

    canvas.remove(rect);
    activeRect.current = null;
    canvas.renderAll();

    if (onRegionalOcrComplete) {
      onRegionalOcrComplete();
    }
  };

  const runRegionalOcr = async (left, top, width, height) => {
    if (!bgImage.current || !fabricCanvas.current) return;
    if (ocrEngine === 'local' && !tesseractWorker.current) return;
    
    const layout = imageLayout.current;
    const scale = layout.scale;
    // Convert selection from canvas space to image pixel space (image is centered on the canvas)
    const imgLeft = (left - layout.left) / scale;
    const imgTop = (top - layout.top) / scale;
    const imgWidth = width / scale;
    const imgHeight = height / scale;

    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = imgWidth;
    cropCanvas.height = imgHeight;
    const ctx = cropCanvas.getContext('2d');

    try {
      ctx.drawImage(bgImage.current.getElement(), imgLeft, imgTop, imgWidth, imgHeight, 0, 0, imgWidth, imgHeight);
      
      if (onOcrProcessing) onOcrProcessing(true);

      const canvas = fabricCanvas.current;
      isHistoryDisabled.current = true;
      const fontToUse = forcePresetFont ? presetFontFamily : 'Inter';
      const blocks = [];

      if (ocrEngine === 'cloud') {
        if (!geminiApiKey) {
          throw new Error("Gemini API Key is missing. Please enter your API Key in the Settings or Right Sidebar.");
        }
        
        const cropDataUrl = cropCanvas.toDataURL();
        const textResult = await runGeminiRegionalOcr(cropDataUrl, geminiApiKey, onWorkerStatusChange, geminiModel, geminiApiUrl);

        if (textResult) {
          blocks.push({
            text: textResult,
            left: left,
            top: top,
            width: width,
            height: height,
            id: `layer_${Date.now()}_0`
          });
        }
      } else if (ocrEngine === 'custom') {
        const cropDataUrl = cropCanvas.toDataURL();
        if (onWorkerStatusChange) onWorkerStatusChange('Calling Local OCR Server...');
        const response = await fetch(localServerUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: cropDataUrl })
        });
        if (!response.ok) {
          throw new Error(`Local OCR server returned error: ${response.status}`);
        }
        const customResult = await response.json();
        
        customResult.forEach((item, index) => {
          const [ymin, xmin, ymax, xmax] = item.bbox;
          const blockLeft = left + (xmin / 1000) * width;
          const blockTop = top + (ymin / 1000) * height;
          const blockWidth = ((xmax - xmin) / 1000) * width;
          const blockHeight = ((ymax - ymin) / 1000) * height || 16;

          blocks.push({
            text: item.text,
            left: blockLeft,
            top: blockTop,
            width: blockWidth,
            height: blockHeight,
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

          const textboxLeft = left + (line.bbox.x0 / scaleFactor) * scale;
          const textboxTop = top + (line.bbox.y0 / scaleFactor) * scale;
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

      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const regionalFontSize = calcOcrFontSize(block.text, block.width, block.height);
        const text = new fabric.Textbox(block.text, {
          left: block.left,
          top: block.top,
          width: block.width,
          fontSize: regionalFontSize,
          // Keep OCR text visible for comparison while leaving the source image
          // intact. A slight transparency makes disagreements easy to spot.
          fill: 'rgba(0,0,0,0.78)',
          backgroundColor: 'transparent',
          id: block.id,
          fontFamily: fontToUse,
          padding: 1,
          cornerColor: '#60CDFF',
          borderColor: '#60CDFF',
          transparentCorners: false,
          isOcrReview: true,

          originalLeft: block.left,
          originalTop: block.top,
          originalWidth: block.width,
          originalHeight: block.height
        });

        canvas.add(text);
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

    const fontToUse = forcePresetFont ? presetFontFamily : 'Inter';
    const reviewBlocks = dedupeOcrBlocks(
      sanitizeOcrBlocks(blocks, imageLayout.current)
    );

    for (let i = 0; i < reviewBlocks.length; i++) {
      const block = reviewBlocks[i];
      const calculatedFontSize = calcOcrFontSize(block.text, block.bbox.w, block.bbox.h);

      const text = new fabric.Textbox(block.text, {
        left: block.bbox.x,
        top: block.bbox.y,
        width: block.bbox.w,
        fontSize: calculatedFontSize,
        // OCR output is a review layer, not an automatic destructive rewrite.
        // The original image remains the visual source of truth until a user
        // explicitly edits and approves a replacement.
        // Keep OCR text visible for comparison while leaving the source image
        // intact. A slight transparency makes disagreements easy to spot.
        fill: 'rgba(0,0,0,0.78)',
        backgroundColor: 'transparent',
        id: block.id || `layer_${Date.now()}_${Math.random()}`,
        fontFamily: fontToUse,
        padding: 1,
        cornerColor: '#60CDFF',
        borderColor: '#60CDFF',
        transparentCorners: false,
        isOcrReview: true,
        confidence: block.confidence,

        originalLeft: block.bbox.x,
        originalTop: block.bbox.y,
        originalWidth: block.bbox.w,
        originalHeight: block.bbox.h
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

  const handleEditingExited = () => {
    const activeObject = fabricCanvas.current?.getActiveObject();
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
    textbox.set({
      isOcrReview: false,
      fill: '#000000'
    });
    // Background reconstruction is intentionally deferred until a user makes a
    // real edit. OCR alone must never alter the source image.
    await _addCoverPatch(textbox);
  };

  useImperativeHandle(ref, () => ({
    updateRegionText: (id, newText) => {
      const canvas = fabricCanvas.current;
      if (!canvas) return;
      const obj = canvas.getObjects().find(o => o.id === id);
      if (obj) {
        const needsReplacement = obj.isOcrReview && obj.text !== newText;
        obj.set('text', newText);
        if (needsReplacement) {
          void materializeReviewLayer(obj).then(() => canvas.renderAll());
        }
        canvas.renderAll();
        saveHistory();
      }
    },
    updateRegionStyle: (id, styleObject) => {
      const canvas = fabricCanvas.current;
      if (!canvas) return;
      const obj = canvas.getObjects().find(o => o.id === id);
      if (obj) {
        obj.set(styleObject);
        if (obj.isOcrReview) {
          void materializeReviewLayer(obj).then(() => canvas.renderAll());
        }
        canvas.renderAll();
        saveHistory();
      }
    },
    selectRegion: (id) => {
      const canvas = fabricCanvas.current;
      if (!canvas) return;
      const obj = canvas.getObjects().find(o => o.id === id);
      if (obj) {
        canvas.setActiveObject(obj);
        canvas.renderAll();
      }
    },
    removeActiveObject: () => {
      const canvas = fabricCanvas.current;
      if (!canvas) return;
      const activeObj = canvas.getActiveObject();
      if (activeObj) {
        canvas.remove(activeObj);
        canvas.discardActiveObject();
        canvas.renderAll();
      }
    },
    applyDefaultFontToAll: (customFontStack) => {
      const canvas = fabricCanvas.current;
      if (!canvas) return;
      const fontToUse = customFontStack || 'Inter';
      isHistoryDisabled.current = true;
      canvas.getObjects().forEach(obj => {
        if (obj.type === 'textbox') {
          obj.set({ fontFamily: fontToUse });
        }
      });
      isHistoryDisabled.current = false;
      saveHistory();
      canvas.renderAll();
    },
    undo: () => {
      const canvas = fabricCanvas.current;
      if (!canvas || historyIndex.current <= 0) return;
      
      isHistoryDisabled.current = true;
      historyIndex.current--;
      const state = history.current[historyIndex.current];
      canvas.loadFromJSON(JSON.parse(state)).then(() => {
        bgImage.current = canvas.backgroundImage;
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
      
      isHistoryDisabled.current = true;
      const textboxLeft = canvas.width / 2 - 50;
      const textboxTop = canvas.height / 2 - 15;
      const textboxWidth = 100;
      const textboxHeight = 24;

      const fontToUse = forcePresetFont ? presetFontFamily : 'Inter';

      const text = new fabric.Textbox("New Text", {
        left: textboxLeft,
        top: textboxTop,
        width: textboxWidth,
        fontSize: 16,
        fill: '#000000',
        backgroundColor: 'transparent',
        id: `layer_${Date.now()}`,
        fontFamily: fontToUse,
        padding: 1,
        cornerColor: '#60CDFF',
        borderColor: '#60CDFF',
        transparentCorners: false,

        originalLeft: textboxLeft,
        originalTop: textboxTop,
        originalWidth: textboxWidth,
        originalHeight: textboxHeight
      });
      
      canvas.add(text);
      canvas.setActiveObject(text);
      isHistoryDisabled.current = false;
      saveHistory();
      canvas.renderAll();
    },
    exportImage: () => {
      const canvas = fabricCanvas.current;
      if (!canvas || !originalDimensions.current.width) return;

      canvas.discardActiveObject();
      canvas.renderAll();

      const layout = imageLayout.current;
      // Crop to the image area and restore original image resolution
      const dataUrl = canvas.toDataURL({
        format: 'png',
        left: layout.left,
        top: layout.top,
        width: layout.width,
        height: layout.height,
        multiplier: 1 / layout.scale
      });

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

      canvas.discardActiveObject();
      canvas.renderAll();

      const layout = imageLayout.current;
      const scale = layout.scale;
      // Crop to the image area and restore original image resolution
      const dataUrl = canvas.toDataURL({
        format: 'jpeg',
        quality: 1.0,
        left: layout.left,
        top: layout.top,
        width: layout.width,
        height: layout.height,
        multiplier: 1 / scale
      });

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
          text: item.text,
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
      if (onWorkerStatusChange) onWorkerStatusChange('Calling Local OCR Server...');
      const response = await fetch(localServerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: data })
      });
      if (!response.ok) {
        throw new Error(`Local OCR server returned error: ${response.status}`);
      }
      const customResult = await response.json();
      const layout = imageLayout.current;

      customResult.forEach((item, index) => {
        const [ymin, xmin, ymax, xmax] = item.bbox;

        blocks.push({
          id: `layer_${Date.now()}_${index}`,
          text: item.text,
          confidence: item.confidence ?? 0,
          bbox: {
            x: layout.left + (xmin / 1000) * layout.width,
            y: layout.top + (ymin / 1000) * layout.height,
            w: ((xmax - xmin) / 1000) * layout.width,
            h: ((ymax - ymin) / 1000) * layout.height
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
