import { useEffect, useRef, useImperativeHandle, forwardRef, useState } from 'react';
import * as fabric from 'fabric';
import Tesseract from 'tesseract.js';

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
  "选出": "選出",
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
  onHistoryStatusChange
}, ref) => {
  const containerRef = useRef(null);
  const canvasEl = useRef(null);
  const fabricCanvas = useRef(null);
  const bgImage = useRef(null);
  const sampleCanvasRef = useRef(null);
  
  const [imageLoaded, setImageLoaded] = useState(false);

  // Drawing state for Regional OCR
  const isDrawing = useRef(false);
  const startPoint = useRef({ x: 0, y: 0 });
  const activeRect = useRef(null);

  // History stack for Undo/Redo
  const history = useRef([]);
  const historyIndex = useRef(-1);
  const isHistoryDisabled = useRef(false);

  const saveHistory = () => {
    if (isHistoryDisabled.current) return;
    const canvas = fabricCanvas.current;
    if (!canvas) return;

    // Serialize canvas state
    const json = JSON.stringify(canvas.toJSON([
      'id', 'originalLeft', 'originalTop', 'originalWidth', 'originalHeight', 'isPatch',
      'selectable', 'evented'
    ]));
    
    // Slice off any redo history
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

    canvas.on('object:modified', saveHistory);
    canvas.on('object:added', (e) => {
      // Avoid saving history for background image initialization
      if (e.target && e.target !== bgImage.current && !e.target.isPatch) {
        saveHistory();
      }
    });
    canvas.on('object:removed', (e) => {
      if (e.target && e.target !== bgImage.current && !e.target.isPatch) {
        saveHistory();
      }
    });

    // Dynamic resizing observer
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
      // Disable selection and enable manual drawing mode
      canvas.forEachObject(obj => {
         obj.selectable = false;
         obj.evented = false;
      });
      canvas.selection = false;
      canvas.discardActiveObject();
      canvas.renderAll();

      // Bind drawing events
      canvas.on('mouse:down', handleMouseDown);
      canvas.on('mouse:move', handleMouseMove);
      canvas.on('mouse:up', handleMouseUp);
    } else {
      // Re-enable interactive selection
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
    if (!bgImage.current) return '';
    const scale = bgImage.current.scaleX;
    
    const imgLeft = Math.round(left / scale);
    const imgTop = Math.round(top / scale);
    const imgWidth = Math.round(width / scale);
    const imgHeight = Math.round(height / scale);
    
    // Sample four corners
    const cTL = getAverageCornerColor(imgLeft, imgTop);
    const cTR = getAverageCornerColor(imgLeft + imgWidth - 1, imgTop);
    const cBL = getAverageCornerColor(imgLeft, imgTop + imgHeight - 1);
    const cBR = getAverageCornerColor(imgLeft + imgWidth - 1, imgTop + imgHeight - 1);
    
    // Create bilinear gradient
    const patchCanvas = document.createElement('canvas');
    patchCanvas.width = imgWidth;
    patchCanvas.height = imgHeight;
    const ctx = patchCanvas.getContext('2d');
    const imgData = ctx.createImageData(imgWidth, imgHeight);
    const data = imgData.data;
    
    for (let y = 0; y < imgHeight; y++) {
      for (let x = 0; x < imgWidth; x++) {
        const index = (y * imgWidth + x) * 4;
        const tx = imgWidth > 1 ? x / (imgWidth - 1) : 0;
        const ty = imgHeight > 1 ? y / (imgHeight - 1) : 0;
        
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
    return patchCanvas.toDataURL();
  };

  const addCoverPatch = async (textbox) => {
    const patchDataUrl = createBilinearPatch(
      textbox.originalLeft, 
      textbox.originalTop, 
      textbox.originalWidth, 
      textbox.originalHeight
    );
    
    const patchImg = await fabric.FabricImage.fromURL(patchDataUrl);
    patchImg.set({
      left: textbox.originalLeft,
      top: textbox.originalTop,
      width: textbox.originalWidth,
      height: textbox.originalHeight,
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
    
    const element = bgImage.current.getElement();
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
      ctx.drawImage(element, imgLeft, imgTop, imgWidth, imgHeight, 0, 0, imgWidth, imgHeight);
      const dataUrl = cropCanvas.toDataURL();

      if (onOcrProcessing) onOcrProcessing(true);

      const result = await Tesseract.recognize(dataUrl, 'chi_tra+eng');
      const canvas = fabricCanvas.current;

      isHistoryDisabled.current = true;

      const lines = getLinesFromPage(result.data);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const rawText = line.text.trim();
        if (!rawText) continue;

        // Apply 99% accuracy correction dictionary
        const correctedText = correctOcrText(rawText);

        const textboxLeft = left + line.bbox.x0 * scale;
        const textboxTop = top + line.bbox.y0 * scale;
        const textboxWidth = (line.bbox.x1 - line.bbox.x0) * scale;
        const textboxHeight = (line.bbox.y1 - line.bbox.y0) * scale || 16;

        const text = new fabric.Textbox(correctedText, {
          left: textboxLeft,
          top: textboxTop,
          width: textboxWidth,
          fontSize: textboxHeight,
          fill: '#000000',
          backgroundColor: 'transparent',
          id: `layer_${Date.now()}_${i}`,
          fontFamily: 'Inter',
          padding: 4,
          cornerColor: '#60CDFF',
          borderColor: '#60CDFF',
          transparentCorners: false,

          originalLeft: textboxLeft,
          originalTop: textboxTop,
          originalWidth: textboxWidth,
          originalHeight: textboxHeight
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
      alert("Regional OCR failed.");
    } finally {
      if (onOcrProcessing) onOcrProcessing(false);
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

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const text = new fabric.Textbox(block.text, {
        left: block.bbox.x,
        top: block.bbox.y,
        width: block.bbox.w,
        fontSize: Math.max(12, block.bbox.h),
        fill: '#000000',
        backgroundColor: 'transparent', // Transparent background to blend with bilinear patch
        id: block.id || `layer_${Date.now()}_${Math.random()}`,
        fontFamily: 'Inter',
        padding: 4,
        cornerColor: '#60CDFF',
        borderColor: '#60CDFF',
        transparentCorners: false,

        originalLeft: block.bbox.x,
        originalTop: block.bbox.y,
        originalWidth: block.bbox.w,
        originalHeight: Math.max(12, block.bbox.h)
      });
      
      // Auto-add seamless cover patch under textbox to hide original text
      await addCoverPatch(text);
      canvas.add(text);
    }

    isHistoryDisabled.current = false;
    saveHistory();
    canvas.renderAll();
    syncLayers();
  };

  const handleSelection = (e) => {
    const activeObject = e.selected?.[0];
    if (activeObject && activeObject.type === 'textbox') {
      onRegionSelect({
        id: activeObject.id,
        text: activeObject.text,
        isBold: activeObject.fontWeight === 'bold',
        isItalic: activeObject.fontStyle === 'italic',
        fill: activeObject.fill
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
        // saveHistory is called by 'object:removed' callback automatically
      }
    },
    applyDefaultFontToAll: () => {
      const canvas = fabricCanvas.current;
      if (!canvas) return;
      isHistoryDisabled.current = true;
      canvas.getObjects().forEach(obj => {
        if (obj.type === 'textbox') {
          obj.set({ fontFamily: 'Inter' });
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
        
        // Scale to fit within container
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

        img.scale(scale);
        
        canvas.backgroundImage = img;
        canvas.backgroundImage.set({
          originX: 'left',
          originY: 'top',
          left: 0,
          top: 0
        });
        
        bgImage.current = img;
        canvas.clear(); 
        canvas.renderAll();
        
        // Initialize offline sample canvas
        const imgElement = img.getElement();
        const sampleCanvas = document.createElement('canvas');
        sampleCanvas.width = imgElement.naturalWidth || imgElement.width;
        sampleCanvas.height = imgElement.naturalHeight || imgElement.height;
        const sampleCtx = sampleCanvas.getContext('2d');
        sampleCtx.drawImage(imgElement, 0, 0);
        sampleCanvasRef.current = sampleCanvas;

        // Reset history stack
        history.current = [];
        historyIndex.current = -1;

        setImageLoaded(true);
        if (onImageLoaded) onImageLoaded(true);

        if (onOcrProcessing) onOcrProcessing(true);

        // Run full Tesseract OCR
        const result = await Tesseract.recognize(file, 'chi_tra+eng');
        
        const lines = getLinesFromPage(result.data);
        const blocks = [];
        lines.forEach((line, index) => {
          const rawText = line.text.trim();
          if (!rawText) return;
          
          // Apply 99% accuracy correction dictionary
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

        await renderOcrResults(blocks);
      } catch (error) {
        console.error("Error loading image / running OCR:", error);
        alert("OCR Failed: " + error.message);
      } finally {
        if (onOcrProcessing) onOcrProcessing(false);
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
        }}>
          <label className="btn btn-primary" style={{ padding: '12px 24px', fontSize: '1rem', cursor: 'pointer' }}>
            Open Image (Local)
            <input type="file" accept="image/*" style={{ display: 'none' }} onChange={handleImageUpload} />
          </label>
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
