import { useState, useRef } from 'react';
import OcrCanvas from './components/OcrCanvas';
import { fixText, translateText } from './utils/llm';
import './index.css';

function App() {
  const [selectedRegion, setSelectedRegion] = useState(null);
  const [layers, setLayers] = useState([]);
  const canvasRef = useRef(null);

  const [isLoadingLLM, setIsLoadingLLM] = useState(false);
  const [zoom, setZoom] = useState(1);

  const handleFixText = async () => {
    if (!selectedRegion) return;
    setIsLoadingLLM(true);
    try {
      const fixed = await fixText(selectedRegion.text);
      setSelectedRegion(prev => ({ ...prev, text: fixed }));
      if (canvasRef.current) canvasRef.current.updateRegionText(selectedRegion.id, fixed);
    } catch (e) {
      alert("Error fixing text: " + e.message);
    } finally {
      setIsLoadingLLM(false);
    }
  };

  const handleTranslate = async () => {
    if (!selectedRegion) return;
    setIsLoadingLLM(true);
    try {
      const translated = await translateText(selectedRegion.text);
      setSelectedRegion(prev => ({ ...prev, text: translated }));
      if (canvasRef.current) canvasRef.current.updateRegionText(selectedRegion.id, translated);
    } catch (e) {
      alert("Error translating text: " + e.message);
    } finally {
      setIsLoadingLLM(false);
    }
  };

  const handleExport = () => {
    if (!canvasRef.current) return;
    
    const canvasElement = document.querySelector('canvas.lower-canvas');
    if (!canvasElement) {
       alert("No canvas found to export!");
       return;
    }
    
    const dataUrl = canvasElement.toDataURL("image/png");
    const link = document.createElement("a");
    link.href = dataUrl;
    link.download = "ocr-exported.png";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="app-container">
      {/* --- TitleBar & MenuBar --- */}
      <header className="header">
        <div className="header-left">
          <h1>OCR Editor Web</h1>
          <div className="menu-bar">
            <div className="menu-item">File</div>
            <div className="menu-item">Edit</div>
            <div className="menu-item">View</div>
            <div className="menu-item">Settings</div>
          </div>
        </div>

        <div className="header-right">
          <div className="zoom-controls">
            <span>Zoom:</span>
            <button className="btn btn-secondary" style={{padding: '2px 8px'}} onClick={() => setZoom(Math.max(0.1, zoom - 0.1))}>-</button>
            <span style={{width: '40px', textAlign: 'center'}}>{Math.round(zoom * 100)}%</span>
            <button className="btn btn-secondary" style={{padding: '2px 8px'}} onClick={() => setZoom(Math.min(5, zoom + 0.1))}>+</button>
            <button className="btn btn-secondary" style={{padding: '2px 8px'}} onClick={() => setZoom(1)}>100%</button>
          </div>
          <button className="btn btn-primary" onClick={handleExport} style={{marginLeft: '8px'}}>
            Export Image
          </button>
        </div>
      </header>
      
      {/* --- Main 3-Pane Layout --- */}
      <div className="main-content">
        
        {/* Left Sidebar */}
        <aside className="sidebar left-sidebar">
          <h2 className="panel-title">Document Status</h2>
          <div className="status-box">
            {layers.length > 0 ? "Image Loaded & Processed" : "No Image Loaded"}
          </div>

          <h2 className="panel-title">Interactive Layers</h2>
          <div style={{flex: 1, overflowY: 'auto'}}>
            {layers.map(layer => (
              <div 
                key={layer.id} 
                className={`layer-item ${selectedRegion?.id === layer.id ? 'active' : ''}`}
                onClick={() => {
                  if (canvasRef.current) canvasRef.current.selectRegion(layer.id);
                }}
              >
                <span>📄</span>
                <span style={{whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}}>
                  {layer.text || "[Empty Layer]"}
                </span>
              </div>
            ))}
            {layers.length === 0 && <div style={{opacity: 0.5, fontSize: '12px'}}>No layers yet.</div>}
          </div>
        </aside>

        {/* Center Workspace (Canvas) */}
        <main className="workspace">
          {/* We pass the zoom level down so the canvas can scale properly */}
          <OcrCanvas 
            ref={canvasRef} 
            zoomLevel={zoom}
            onRegionSelect={setSelectedRegion} 
            onLayersUpdate={setLayers}
          />
        </main>

        {/* Right Inspector */}
        <aside className="sidebar right-sidebar">
          <h2 className="panel-title">Text Formatting</h2>
          
          <div className="panel-subtitle">Edit Content</div>
          <textarea
            className="textarea"
            value={selectedRegion?.text || ''}
            disabled={!selectedRegion}
            onChange={(e) => {
              const newText = e.target.value;
              setSelectedRegion(prev => ({ ...prev, text: newText }));
              if (canvasRef.current) {
                canvasRef.current.updateRegionText(selectedRegion.id, newText);
              }
            }}
            placeholder={selectedRegion ? "Edit text here..." : "Select a region first"}
          />

          <div className="panel-subtitle">Paragraph Format</div>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
            <button 
              className={`btn btn-secondary ${selectedRegion?.isBold ? 'active' : ''}`} 
              style={{ flex: 1 }} 
              disabled={!selectedRegion}
              onClick={() => {
                 const isBold = !selectedRegion.isBold;
                 setSelectedRegion(prev => ({...prev, isBold}));
                 canvasRef.current?.updateRegionStyle(selectedRegion.id, { fontWeight: isBold ? 'bold' : 'normal' });
              }}
            >
              Bold
            </button>
            <button 
              className={`btn btn-secondary ${selectedRegion?.isItalic ? 'active' : ''}`} 
              style={{ flex: 1 }} 
              disabled={!selectedRegion}
              onClick={() => {
                 const isItalic = !selectedRegion.isItalic;
                 setSelectedRegion(prev => ({...prev, isItalic}));
                 canvasRef.current?.updateRegionStyle(selectedRegion.id, { fontStyle: isItalic ? 'italic' : 'normal' });
              }}
            >
              Italic
            </button>
          </div>

          <div className="panel-subtitle">Color Presets</div>
          <div className="color-presets">
            {['#000000', '#FFFFFF', '#FF0000', '#0000FF', '#008000'].map(color => (
              <button 
                key={color} 
                className="color-btn" 
                style={{ backgroundColor: color }} 
                disabled={!selectedRegion}
                onClick={() => {
                  setSelectedRegion(prev => ({...prev, fill: color}));
                  canvasRef.current?.updateRegionStyle(selectedRegion.id, { fill: color });
                }}
              />
            ))}
          </div>

          <h2 className="panel-title" style={{marginTop: '24px'}}>AI Operations</h2>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
            <button className="btn btn-secondary" style={{flex: 1}} disabled={!selectedRegion || isLoadingLLM} onClick={handleFixText}>
              Fix Text
            </button>
            <button className="btn btn-secondary" style={{flex: 1}} disabled={!selectedRegion || isLoadingLLM}>
              Extract Entities
            </button>
          </div>
          <button className="btn btn-secondary" style={{width: '100%', marginBottom: '16px'}} disabled={!selectedRegion || isLoadingLLM} onClick={handleTranslate}>
            Translate to ZH
          </button>
          
          <h2 className="panel-title">Operations</h2>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="btn btn-secondary" style={{flex: 1}} disabled={!selectedRegion}>Regional OCR</button>
            <button className="btn btn-secondary" style={{flex: 1}} disabled={!selectedRegion}>Remove Text</button>
          </div>
        </aside>

      </div>
    </div>
  );
}

export default App;
