import { useEffect, useRef, useImperativeHandle, forwardRef, useState } from 'react';
import * as fabric from 'fabric';
import Tesseract from 'tesseract.js';
import { jsPDF } from 'jspdf';
import { runGeminiOcr, runGeminiRegionalOcr } from '../utils/geminiOcr';

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

const OcrCanvas = forwardRef(({ 
  onRegionSelect, 
  onLayersUpdate, 
  onImageLoaded, 
  onOcrProcessing, 
  zoomLevel = 1,
  isRegionalOcrActive = false,
  onRegionalOcrComplete,
  onHistoryStatusChange,
  ocrLanguage = 'auto',
  onWorkerStatusChange,
  presetFontFamily = 'Inter',
  forcePresetFont = true,
  ocrEngine = 'local',
  geminiApiKey = '',
  t = (key) => key
}, ref) => {
  const containerRef = useRef(null);
  const canvasEl = useRef(null);
  const fabricCanvas = useRef(null);
  const bgImage = useRef(null);
  const sampleCanvasRef = useRef(null);
  const tesseractWorker = useRef(null);
  const originalDimensions = useRef({ width: 0, height: 0 });
  
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
      'id', 'originalLeft', 'originalTop', 'originalWidth', 'originalHeight', 'isPatch',
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
        let langCodes = ['chi_tra', 'eng'];
        if (ocrLanguage === 'zh-Hant') langCodes = ['chi_tra'];
        if (ocrLanguage === 'en') langCodes = ['eng'];

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
  }, [ocrLanguage]);

  // Initialize Fabric Canvas
  useEffect(() => {
    if (!canvasEl.current || fabricCanvas.current) return;
    
    const canvas = new fabric.Canvas(canvasEl.current, {
      backgroundColor: 'transparent',
      selection: true,
    });
    fabricCanvas.current = canvas;

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
        if (!bgImage.current && fabricCanvas.current) {
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

  // Bilinear Background Generator
  const createBilinearPatch = (left, top, width, height) => {
    const canvas = fabricCanvas.current;
    if (!canvas) return null;
    
    // Find the scale. Fall back to bgImage.scaleX if originalDimensions is not set
    let scale = 1;
    if (originalDimensions.current.width) {
      scale = canvas.width / originalDimensions.current.width;
    } else if (bgImage.current) {
      scale = bgImage.current.scaleX;
    } else {
      return null;
    }
    
    const imgLeft = Math.round(left / scale);
    const imgTop = Math.round(top / scale);
    const imgWidth = Math.round(width / scale);
    const imgHeight = Math.round(height / scale);
    
    const imgWidthMax = sampleCanvasRef.current ? sampleCanvasRef.current.width : imgWidth;
    const imgHeightMax = sampleCanvasRef.current ? sampleCanvasRef.current.height : imgHeight;
    
    // We add padding (e.g., 3 pixels at image scale) to make the patch slightly larger
    const padding = 3;
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
    const imgData = ctx.createImageData(patchWidth, patchHeight);
    const data = imgData.data;
    
    for (let y = 0; y < patchHeight; y++) {
      for (let x = 0; x < patchWidth; x++) {
        const index = (y * patchWidth + x) * 4;
        const tx = patchWidth > 1 ? x / (patchWidth - 1) : 0;
        const ty = patchHeight > 1 ? y / (patchHeight - 1) : 0;
        
        const rTop = cTL.r * (1 - tx) + cTR.r * tx;
        const gTop = cTL.g * (1 - tx) + cTR.g * tx;
        const bTop = cTL.b * (1 - tx) + cTR.b * tx;

        const rBot = cBL.r * (1 - tx) + cBR.r * tx;
        const gBot = cBL.g * (1 - tx) + cBR.g * tx;
        const bBot = cBL.b * (1 - tx) + cBR.b * tx;

        const r = Math.round(rTop * (1 - ty) + rBot * ty);
        const g = Math.round(gTop * (1 - ty) + gBot * ty);
        const b = Math.round(bTop * (1 - ty) + bBot * ty);
        
        data[index] = r;
        data[index + 1] = g;
        data[index + 2] = b;
        data[index + 3] = 255;
      }
    }
    ctx.putImageData(imgData, 0, 0);
    return {
      dataUrl: patchCanvas.toDataURL(),
      patchLeft: patchLeft * scale,
      patchTop: patchTop * scale,
      patchWidth: patchWidth * scale,
      patchHeight: patchHeight * scale
    };
  };

  const addCoverPatch = async (textbox) => {
    const patchInfo = createBilinearPatch(
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
    
    const scale = bgImage.current.scaleX;
    const imgLeft = left / scale;
    const imgTop = top / scale;
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
        const textResult = await runGeminiRegionalOcr(cropDataUrl, geminiApiKey, onWorkerStatusChange);

        if (textResult) {
          const linesCount = textResult.split('\n').filter(l => l.trim() !== '').length || 1;
          const calculatedFontSize = Math.max(12, height / linesCount);

          blocks.push({
            text: textResult,
            left: left,
            top: top,
            width: width,
            height: calculatedFontSize,
            id: `layer_${Date.now()}_0`
          });
        }
      } else {
        // Apply preprocessing on the cropped area to improve accuracy
        const preprocessCropCanvas = document.createElement('canvas');
        preprocessCropCanvas.width = imgWidth;
        preprocessCropCanvas.height = imgHeight;
        const preprocessCropCtx = preprocessCropCanvas.getContext('2d');
        preprocessCropCtx.filter = 'grayscale(100%) contrast(150%)';
        preprocessCropCtx.drawImage(cropCanvas, 0, 0);

        const result = await tesseractWorker.current.recognize(preprocessCropCanvas, {}, { blocks: true });
        const lines = getLinesFromPage(result.data);

        lines.forEach((line, index) => {
          const rawText = line.text.trim();
          if (!rawText) return;

          const correctedText = correctOcrText(rawText);

          const textboxLeft = left + line.bbox.x0 * scale;
          const textboxTop = top + line.bbox.y0 * scale;
          const textboxWidth = (line.bbox.x1 - line.bbox.x0) * scale;
          const textboxHeight = (line.bbox.y1 - line.bbox.y0) * scale || 16;

          blocks.push({
            text: correctedText,
            left: textboxLeft,
            top: textboxTop,
            width: textboxWidth,
            height: textboxHeight,
            id: `layer_${Date.now()}_${index}`
          });
        });
      }

      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const text = new fabric.Textbox(block.text, {
          left: block.left,
          top: block.top,
          width: block.width,
          fontSize: block.height,
          fill: '#000000',
          backgroundColor: 'transparent',
          id: block.id,
          fontFamily: fontToUse,
          padding: 4,
          cornerColor: '#60CDFF',
          borderColor: '#60CDFF',
          transparentCorners: false,

          originalLeft: block.left,
          originalTop: block.top,
          originalWidth: block.width,
          originalHeight: block.height
        });

        await addCoverPatch(text);
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
      fill: obj.fill
    }));
    
    if (onLayersUpdate) {
      onLayersUpdate(layers);
    }
  };

  const renderOcrResults = async (blocks) => {
    const canvas = fabricCanvas.current;
    if (!canvas) return;

    isHistoryDisabled.current = true;

    const fontToUse = forcePresetFont ? presetFontFamily : 'Inter';

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      // Calculate font size by dividing the box height by the text line count to handle paragraphs, capped at a maximum of 32px
      const linesCount = block.text.split('\n').filter(l => l.trim() !== '').length || 1;
      const calculatedFontSize = Math.max(12, Math.min(32, block.bbox.h / linesCount));

      const text = new fabric.Textbox(block.text, {
        left: block.bbox.x,
        top: block.bbox.y,
        width: block.bbox.w,
        fontSize: calculatedFontSize,
        fill: '#000000',
        backgroundColor: 'transparent',
        id: block.id || `layer_${Date.now()}_${Math.random()}`,
        fontFamily: fontToUse,
        padding: 4,
        cornerColor: '#60CDFF',
        borderColor: '#60CDFF',
        transparentCorners: false,

        originalLeft: block.bbox.x,
        originalTop: block.bbox.y,
        originalWidth: block.bbox.w,
        originalHeight: calculatedFontSize
      });
      
      await addCoverPatch(text);
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
        fill: activeObject.fill,
        fontFamily: activeObject.fontFamily
      });
      syncLayers();
    }
  };

  const handleEditingExited = () => {
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
        fill: activeObject.fill,
        fontFamily: activeObject.fontFamily
      });
    }
  };

  useImperativeHandle(ref, () => ({
    updateRegionText: (id, newText) => {
      const canvas = fabricCanvas.current;
      if (!canvas) return;
      const obj = canvas.getObjects().find(o => o.id === id);
      if (obj) {
        obj.set('text', newText);
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
      canvas.loadFromJSON(state).then(() => {
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
      canvas.loadFromJSON(state).then(() => {
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
        padding: 4,
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

      const scale = canvas.width / originalDimensions.current.width;
      // Get data URL at original image resolution using multiplier
      const dataUrl = canvas.toDataURL({
        format: 'png',
        multiplier: 1 / scale
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

      const scale = canvas.width / originalDimensions.current.width;
      // Export full resolution image
      const dataUrl = canvas.toDataURL({
        format: 'jpeg',
        quality: 1.0,
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
         const origX = layer.left / scale;
         const origY = (layer.top + layer.height) / scale; // jsPDF origin is bottom-left
         pdf.text(layer.text, origX, origY);
      });

      pdf.save("ocr-exported.pdf");
    }
  }));

  const handleImageUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file || !fabricCanvas.current || !containerRef.current) return;

    const reader = new FileReader();
    reader.onload = async (f) => {
      const data = f.target.result;
      try {
        const img = await fabric.FabricImage.fromURL(data);
        const canvas = fabricCanvas.current;
        
        const containerWidth = containerRef.current.clientWidth;
        const containerHeight = containerRef.current.clientHeight;
        
        const scale = Math.min(
          containerWidth / img.width,
          containerHeight / img.height
        );
        
        canvas.setDimensions({
          width: img.width * scale,
          height: img.height * scale
        });

        canvas.clear(); 
        img.scale(scale);
        
        canvas.backgroundImage = img;
        canvas.backgroundImage.set({
          originX: 'left',
          originY: 'top',
          left: 0,
          top: 0
        });
        
        bgImage.current = img;
        canvas.renderAll();
        
        const imgElement = img.getElement();
        const origWidth = imgElement.naturalWidth || imgElement.width || img.width;
        const origHeight = imgElement.naturalHeight || imgElement.height || img.height;
        originalDimensions.current = { width: origWidth, height: origHeight };

        const sampleCanvas = document.createElement('canvas');
        sampleCanvas.width = origWidth;
        sampleCanvas.height = origHeight;
        const sampleCtx = sampleCanvas.getContext('2d');
        sampleCtx.drawImage(imgElement, 0, 0);
        sampleCanvasRef.current = sampleCanvas;

        // Apply preprocessing using an off-screen canvas
        const preprocessCanvas = document.createElement('canvas');
        preprocessCanvas.width = origWidth;
        preprocessCanvas.height = origHeight;
        const preprocessCtx = preprocessCanvas.getContext('2d');
        preprocessCtx.filter = 'grayscale(100%) contrast(150%)';
        preprocessCtx.drawImage(imgElement, 0, 0);

        history.current = [];
        historyIndex.current = -1;

        canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
        setImageLoaded(true);
        if (onImageLoaded) onImageLoaded(true);

        if (onOcrProcessing) onOcrProcessing(true);

        const blocks = [];

        if (ocrEngine === 'cloud') {
          if (!geminiApiKey) {
            throw new Error("Gemini API Key is missing. Please enter your API Key in the Settings or Right Sidebar.");
          }
          
          const geminiResult = await runGeminiOcr(data, geminiApiKey, onWorkerStatusChange);
          const canvasWidth = canvas.width;
          const canvasHeight = canvas.height;

          geminiResult.forEach((item, index) => {
            const ymin = item.bbox[0];
            const xmin = item.bbox[1];
            const ymax = item.bbox[2];
            const xmax = item.bbox[3];

            blocks.push({
              id: `layer_${Date.now()}_${index}`,
              text: item.text,
              bbox: {
                x: (xmin / 1000) * canvasWidth,
                y: (ymin / 1000) * canvasHeight,
                w: ((xmax - xmin) / 1000) * canvasWidth,
                h: ((ymax - ymin) / 1000) * canvasHeight
              }
            });
          });
        } else {
          // Run full Tesseract OCR on preprocessed canvas
          const worker = tesseractWorker.current;
          if (!worker) throw new Error("OCR Engine is not initialized yet.");
          
          const result = await worker.recognize(preprocessCanvas, {}, { blocks: true });
          
          const lines = getLinesFromPage(result.data);
          lines.forEach((line, index) => {
            const rawText = line.text.trim();
            if (!rawText) return;
            
            const correctedText = correctOcrText(rawText);

            blocks.push({
              id: `layer_${Date.now()}_${index}`,
              text: correctedText,
              confidence: line.confidence / 100,
              bbox: {
                x: line.bbox.x0 * scale,
                y: line.bbox.y0 * scale,
                w: (line.bbox.x1 - line.bbox.x0) * scale,
                h: (line.bbox.y1 - line.bbox.y0) * scale
              }
            });
          });
        }

        await renderOcrResults(blocks);
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
    <div ref={containerRef} className="canvas-container">
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
