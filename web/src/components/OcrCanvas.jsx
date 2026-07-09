import { useEffect, useRef, useImperativeHandle, forwardRef, useState } from 'react';
import * as fabric from 'fabric';
import Tesseract from 'tesseract.js';

const OcrCanvas = forwardRef(({ 
  onRegionSelect, 
  onLayersUpdate, 
  onImageLoaded, 
  onOcrProcessing, 
  zoomLevel = 1,
  isRegionalOcrActive = false,
  onRegionalOcrComplete
}, ref) => {
  const containerRef = useRef(null);
  const canvasEl = useRef(null);
  const fabricCanvas = useRef(null);
  const bgImage = useRef(null);
  
  const [imageLoaded, setImageLoaded] = useState(false);

  // Drawing state for Regional OCR
  const isDrawing = useRef(false);
  const startPoint = useRef({ x: 0, y: 0 });
  const activeRect = useRef(null);

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

    canvas.on('object:modified', syncLayers);

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

  // Handle Mouse Events for Regional OCR Rectangle drawing
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
    
    // Perform Regional OCR
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

      result.data.lines.forEach((line, index) => {
        if (!line.text.trim()) return;
        const text = new fabric.Textbox(line.text.trim(), {
          left: left + line.bbox.x0 * scale,
          top: top + line.bbox.y0 * scale,
          width: (line.bbox.x1 - line.bbox.x0) * scale,
          fontSize: (line.bbox.y1 - line.bbox.y0) * scale || 16,
          fill: '#000000',
          backgroundColor: 'rgba(255, 255, 255, 0.8)',
          id: `layer_${Date.now()}_${index}`,
          fontFamily: 'Inter',
          padding: 4,
          cornerColor: '#60CDFF',
          borderColor: '#60CDFF',
          transparentCorners: false
        });
        canvas.add(text);
      });

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

  const renderOcrResults = (blocks) => {
    const canvas = fabricCanvas.current;
    if (!canvas) return;

    blocks.forEach(block => {
      const text = new fabric.Textbox(block.text, {
        left: block.bbox.x,
        top: block.bbox.y,
        width: block.bbox.w,
        fontSize: Math.max(12, block.bbox.h),
        fill: '#000000',
        backgroundColor: 'rgba(255, 255, 255, 0.8)',
        id: block.id || `layer_${Date.now()}_${Math.random()}`,
        fontFamily: 'Inter',
        padding: 4,
        cornerColor: '#60CDFF',
        borderColor: '#60CDFF',
        transparentCorners: false
      });
      canvas.add(text);
    });
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
        syncLayers();
      }
    },
    updateRegionStyle: (id, styleObject) => {
      const canvas = fabricCanvas.current;
      if (!canvas) return;
      const obj = canvas.getObjects().find(o => o.id === id);
      if (obj) {
        obj.set(styleObject);
        canvas.renderAll();
        syncLayers();
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
        syncLayers();
      }
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
        
        // Scale to fit within container container
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
        canvas.clear(); // Clear any previous blocks
        canvas.renderAll();
        
        setImageLoaded(true);
        if (onImageLoaded) onImageLoaded(true);

        if (onOcrProcessing) onOcrProcessing(true);

        // Run full Tesseract OCR
        const result = await Tesseract.recognize(file, 'chi_tra+eng');
        
        const blocks = result.data.lines.map((line, index) => {
          return {
            id: `layer_${Date.now()}_${index}`,
            text: line.text.trim(),
            confidence: line.confidence / 100,
            bbox: {
              x: line.bbox.x0 * scale,
              y: line.bbox.y0 * scale,
              w: (line.bbox.x1 - line.bbox.x0) * scale,
              h: (line.bbox.y1 - line.bbox.y0) * scale
            }
          };
        });

        renderOcrResults(blocks);
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
