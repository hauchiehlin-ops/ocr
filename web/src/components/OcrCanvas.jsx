import { useEffect, useRef, useImperativeHandle, forwardRef, useState } from 'react';
import * as fabric from 'fabric';

const OcrCanvas = forwardRef(({ onRegionSelect, onLayersUpdate, zoomLevel = 1 }, ref) => {
  const containerRef = useRef(null);
  const canvasEl = useRef(null);
  const fabricCanvas = useRef(null);
  const worker = useRef(null);
  const bgImage = useRef(null);
  
  const [imageLoaded, setImageLoaded] = useState(false);
  const [isOcrProcessing, setIsOcrProcessing] = useState(false);

  // Initialize Web Worker
  useEffect(() => {
    worker.current = new Worker(new URL('../workers/ocr.worker.js', import.meta.url), { type: 'module' });
    worker.current.postMessage({ type: 'INIT' });

    worker.current.onmessage = (e) => {
      const { type, payload } = e.data;
      if (type === 'RECOGNIZE_DONE') {
        setIsOcrProcessing(false);
        renderOcrResults(payload.blocks);
      }
    };

    return () => worker.current?.terminate();
  }, []);

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

    const resizeObserver = new ResizeObserver((entries) => {
      for (let entry of entries) {
        if (!bgImage.current) {
           canvas.setDimensions({
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
        fontSize: block.bbox.h || 16,
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
        
        // Calculate scale to fit within container
        const containerWidth = containerRef.current.clientWidth;
        const containerHeight = containerRef.current.clientHeight;
        
        const scale = Math.min(
          containerWidth / img.width,
          containerHeight / img.height
        );
        
        // Set canvas dimensions to match the scaled image exactly
        canvas.setDimensions({
          width: img.width * scale,
          height: img.height * scale
        });

        img.scale(scale);
        
        // Use background image instead of adding to canvas objects array
        // to prevent it from being selectable/movable
        canvas.backgroundImage = img;
        canvas.backgroundImage.set({
          originX: 'left',
          originY: 'top',
          left: 0,
          top: 0
        });
        
        bgImage.current = img;
        canvas.renderAll();
        setImageLoaded(true);

        setIsOcrProcessing(true);
        worker.current.postMessage({
           type: 'RECOGNIZE',
           payload: { imageInfo: { width: img.width, height: img.height } }
        });
      } catch (error) {
        console.error("Error loading image into fabric:", error);
        alert("Failed to load image. Please try a different file.");
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
      
      {/* Centering wrapper for the canvas */}
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

export default OcrCanvas;
