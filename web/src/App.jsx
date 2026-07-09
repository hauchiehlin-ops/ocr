import { useState, useRef } from 'react';
import OcrCanvas from './components/OcrCanvas';
import { fixText, translateText, extractEntities } from './utils/llm';
import './index.css';

function App() {
  const [selectedRegion, setSelectedRegion] = useState(null);
  const [layers, setLayers] = useState([]);
  const canvasRef = useRef(null);

  const [imageLoaded, setImageLoaded] = useState(false);
  const [isOcrProcessing, setIsOcrProcessing] = useState(false);
  const [isRegionalOcrActive, setIsRegionalOcrActive] = useState(false);

  const [isLoadingLLM, setIsLoadingLLM] = useState(false);
  const [llmProgress, setLlmProgress] = useState('');
  const [zoom, setZoom] = useState(1);

  const handleFixText = async () => {
    if (!selectedRegion) return;
    setIsLoadingLLM(true);
    setLlmProgress('Initializing AI Engine (first launch will download ~950MB)...');
    try {
      const fixed = await fixText(selectedRegion.text, (prog) => {
         setLlmProgress(prog);
      });
      setSelectedRegion(prev => ({ ...prev, text: fixed }));
      if (canvasRef.current) canvasRef.current.updateRegionText(selectedRegion.id, fixed);
      setLlmProgress('Text corrected successfully!');
    } catch (e) {
      alert("Error fixing text: " + e.message);
      setLlmProgress('AI operation failed.');
    } finally {
      setIsLoadingLLM(false);
    }
  };

  const handleTranslate = async () => {
    if (!selectedRegion) return;
    setIsLoadingLLM(true);
    setLlmProgress('Initializing AI Engine...');
    try {
      const translated = await translateText(selectedRegion.text, (prog) => {
         setLlmProgress(prog);
      });
      setSelectedRegion(prev => ({ ...prev, text: translated }));
      if (canvasRef.current) canvasRef.current.updateRegionText(selectedRegion.id, translated);
      setLlmProgress('Translated successfully!');
    } catch (e) {
      alert("Error translating text: " + e.message);
      setLlmProgress('AI operation failed.');
    } finally {
      setIsLoadingLLM(false);
    }
  };

  const handleExtractEntities = async () => {
    if (!selectedRegion) return;
    setIsLoadingLLM(true);
    setLlmProgress('Initializing AI Engine...');
    try {
      const entities = await extractEntities(selectedRegion.text, (prog) => {
         setLlmProgress(prog);
      });
      const combined = `【Entities】\n${entities}\n\n【Original】\n${selectedRegion.text}`;
      setSelectedRegion(prev => ({ ...prev, text: combined }));
      if (canvasRef.current) canvasRef.current.updateRegionText(selectedRegion.id, combined);
      setLlmProgress('Entities extracted!');
    } catch (e) {
      alert("Error extracting entities: " + e.message);
      setLlmProgress('AI operation failed.');
    } finally {
      setIsLoadingLLM(false);
    }
  };

  const handleRemoveText = () => {
     if (!selectedRegion) return;
     if (canvasRef.current) {
        canvasRef.current.removeActiveObject();
        setSelectedRegion(null);
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
          <h1 style={{ fontWeight: 'bold', letterSpacing: '0.5px' }}>OCR Visual Editor Pro</h1>
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
          <button className="btn btn-primary" onClick={handleExport} style={{marginLeft: '8px'}} disabled={!imageLoaded}>
            Export Image
          </button>
        </div>
      </header>
      
      {/* --- Main 3-Pane Layout --- */}
      <div className="main-content">
        
        {/* Left Sidebar */}
        <aside className="sidebar left-sidebar">
          <h2 className="panel-title">Document Status</h2>
          <div className="status-box" style={{ minHeight: '50px', display: 'flex', alignItems: 'center' }}>
            {isOcrProcessing ? (
              <div style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
                 <div style={{ color: '#60CDFF', fontWeight: 'bold', marginBottom: '4px' }}>Processing Local OCR...</div>
                 <div style={{ fontSize: '10px', opacity: 0.6 }}>Running Tesseract.js (chi_tra+eng)</div>
              </div>
            ) : imageLoaded ? (
              <span style={{ color: '#4ADE80', fontWeight: 'bold' }}>✓ Image Loaded & Processed</span>
            ) : (
              <span style={{ opacity: 0.5 }}>No Image Loaded</span>
            )}
          </div>

          <h2 className="panel-title" style={{ marginTop: '16px' }}>Interactive Layers</h2>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {layers.map(layer => (
              <div 
                key={layer.id} 
                className={`layer-item ${selectedRegion?.id === layer.id ? 'active' : ''}`}
                onClick={() => {
                  if (canvasRef.current) canvasRef.current.selectRegion(layer.id);
                }}
              >
                <span>📄</span>
                <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', width: '180px' }}>
                  {layer.text || "[Empty Layer]"}
                </span>
              </div>
            ))}
            {layers.length === 0 && <div style={{ opacity: 0.5, fontSize: '12px', padding: '8px' }}>No layers detected yet.</div>}
          </div>
        </aside>

        {/* Center Workspace (Canvas) */}
        <main className="workspace">
          <OcrCanvas 
            ref={canvasRef} 
            zoomLevel={zoom}
            isRegionalOcrActive={isRegionalOcrActive}
            onRegionalOcrComplete={() => setIsRegionalOcrActive(false)}
            onRegionSelect={setSelectedRegion} 
            onLayersUpdate={setLayers}
            onImageLoaded={setImageLoaded}
            onOcrProcessing={setIsOcrProcessing}
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
                style={{ backgroundColor: color, border: selectedRegion?.fill === color ? '2px solid #60CDFF' : '1px solid rgba(255,255,255,0.2)' }} 
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
            <button 
              className="btn btn-secondary" 
              style={{flex: 1}} 
              disabled={!selectedRegion || isLoadingLLM} 
              onClick={handleFixText}
            >
              Fix Text
            </button>
            <button 
              className="btn btn-secondary" 
              style={{flex: 1}} 
              disabled={!selectedRegion || isLoadingLLM}
              onClick={handleExtractEntities}
            >
              Extract Entities
            </button>
          </div>
          <button 
            className="btn btn-secondary" 
            style={{width: '100%', marginBottom: '8px'}} 
            disabled={!selectedRegion || isLoadingLLM} 
            onClick={handleTranslate}
          >
            Translate to ZH
          </button>

          {/* WebLLM Load Progress Output */}
          {llmProgress && (
            <div style={{
              padding: '10px',
              background: 'rgba(96, 205, 255, 0.1)',
              border: '1px solid rgba(96, 205, 255, 0.3)',
              borderRadius: '4px',
              fontSize: '11px',
              color: '#60CDFF',
              wordBreak: 'break-all',
              marginTop: '4px',
              lineHeight: '1.4'
            }}>
              💡 {llmProgress}
            </div>
          )}
          
          <h2 className="panel-title" style={{marginTop: '24px'}}>Operations</h2>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button 
              className={`btn btn-secondary ${isRegionalOcrActive ? 'active' : ''}`} 
              style={{flex: 1}} 
              disabled={!imageLoaded}
              onClick={() => setIsRegionalOcrActive(!isRegionalOcrActive)}
            >
              {isRegionalOcrActive ? 'Drawing Mode' : 'Regional OCR'}
            </button>
            <button 
              className="btn btn-secondary" 
              style={{flex: 1}} 
              disabled={!selectedRegion}
              onClick={handleRemoveText}
            >
              Remove Text
            </button>
          </div>
        </aside>

      </div>
    </div>
  );
}

export default App;
