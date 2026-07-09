import { useState, useRef } from 'react';
import OcrCanvas from './components/OcrCanvas';
import { fixText, translateText, extractEntities } from './utils/llm';
import { getTranslation } from './utils/i18n';
import { jsPDF } from 'jspdf';
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

  // Panel visible states to align with View Menu in WPF
  const [showLeftPanel, setShowLeftPanel] = useState(true);
  const [showRightPanel, setShowRightPanel] = useState(true);

  // Settings States (Default to English UI and Auto OCR to match native settings)
  const [ocrLanguage, setOcrLanguage] = useState('auto');
  const [uiLanguage, setUiLanguage] = useState('繁體中文');
  const [workerStatus, setWorkerStatus] = useState('Initializing...');

  // Undo/Redo states
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const handleHistoryStatusChange = (status) => {
    setCanUndo(status.canUndo);
    setCanRedo(status.canRedo);
  };

  const handleFixText = async () => {
    if (!selectedRegion) return;
    setIsLoadingLLM(true);
    setLlmProgress(uiLanguage === '繁體中文' ? '初始化 AI 引擎中 (首次載入需下載 ~950MB)...' : 'Initializing AI Engine (first launch downloads ~950MB)...');
    try {
      const fixed = await fixText(selectedRegion.text, (prog) => {
         setLlmProgress(prog);
      });
      setSelectedRegion(prev => ({ ...prev, text: fixed }));
      if (canvasRef.current) canvasRef.current.updateRegionText(selectedRegion.id, fixed);
      setLlmProgress(uiLanguage === '繁體中文' ? '文字校對完成！' : 'Text corrected successfully!');
    } catch (e) {
      alert("Error fixing text: " + e.message);
      setLlmProgress(uiLanguage === '繁體中文' ? 'AI 協同處理失敗。' : 'AI operation failed.');
    } finally {
      setIsLoadingLLM(false);
    }
  };

  const handleTranslate = async () => {
    if (!selectedRegion) return;
    setIsLoadingLLM(true);
    setLlmProgress(uiLanguage === '繁體中文' ? '初始化 AI 引擎中...' : 'Initializing AI Engine...');
    try {
      const translated = await translateText(selectedRegion.text, (prog) => {
         setLlmProgress(prog);
      });
      setSelectedRegion(prev => ({ ...prev, text: translated }));
      if (canvasRef.current) canvasRef.current.updateRegionText(selectedRegion.id, translated);
      setLlmProgress(uiLanguage === '繁體中文' ? '翻譯完成！' : 'Translated successfully!');
    } catch (e) {
      alert("Error translating text: " + e.message);
      setLlmProgress(uiLanguage === '繁體中文' ? 'AI 協同處理失敗。' : 'AI operation failed.');
    } finally {
      setIsLoadingLLM(false);
    }
  };

  const handleExtractEntities = async () => {
    if (!selectedRegion) return;
    setIsLoadingLLM(true);
    setLlmProgress(uiLanguage === '繁體中文' ? '初始化 AI 引擎中...' : 'Initializing AI Engine...');
    try {
      const entities = await extractEntities(selectedRegion.text, (prog) => {
         setLlmProgress(prog);
      });
      const combined = `【Entities】\n${entities}\n\n【Original】\n${selectedRegion.text}`;
      setSelectedRegion(prev => ({ ...prev, text: combined }));
      if (canvasRef.current) canvasRef.current.updateRegionText(selectedRegion.id, combined);
      setLlmProgress(uiLanguage === '繁體中文' ? '實體擷取完成！' : 'Entities extracted!');
    } catch (e) {
      alert("Error extracting entities: " + e.message);
      setLlmProgress(uiLanguage === '繁體中文' ? 'AI 協同處理失敗。' : 'AI operation failed.');
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

  const handleApplyDefaultFontAll = () => {
     if (canvasRef.current) {
        canvasRef.current.applyDefaultFontToAll();
        if (selectedRegion) {
          setSelectedRegion(prev => ({ ...prev, fontFamily: 'Inter' }));
        }
     }
  };

  const handleExport = () => {
    if (canvasRef.current) {
      canvasRef.current.exportImage();
    }
  };

  const handleExportPDF = () => {
    if (canvasRef.current) {
      canvasRef.current.exportPDF();
    }
  };

  const handleExportCSV = () => {
    if (layers.length === 0) {
      alert(uiLanguage === '繁體中文' ? "無圖層可供匯出。" : "No layers to export.");
      return;
    }
    let csv = "ID,Text\n";
    layers.forEach(layer => {
      csv += `"${layer.id}","${layer.text.replace(/"/g, '""')}"\n`;
    });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "ocr-exported.csv";
    link.click();
  };

  const triggerImageUpload = () => {
     canvasRef.current?.triggerUpload();
  };

  const handleCloseImage = () => {
     canvasRef.current?.clearCanvas();
  };

  const handleInsertText = () => {
     if (!imageLoaded) return alert(uiLanguage === '繁體中文' ? "請先載入一張圖片。" : "Please load an image first.");
     canvasRef.current?.insertText();
  };

  const t = (key) => getTranslation(uiLanguage, key);

  return (
    <div className="app-container">
      {/* --- TitleBar & MenuBar --- */}
      <header className="header">
        <div className="header-left">
          <h1 style={{ fontWeight: 'bold', letterSpacing: '0.5px' }}>{t('title')}</h1>
          <div className="menu-bar">
            {/* File Menu */}
            <div className="menu-container">
              <div className="menu-item">{t('file')}</div>
              <div className="dropdown-menu">
                <div className="dropdown-item" onClick={triggerImageUpload}>{t('loadImage')}</div>
                <div className={`dropdown-item ${!imageLoaded ? 'disabled' : ''}`} onClick={imageLoaded ? handleCloseImage : null}>{t('closeImage')}</div>
                <div className="dropdown-separator"></div>
                <div className={`dropdown-item ${!imageLoaded ? 'disabled' : ''}`} onClick={imageLoaded ? handleExport : null}>{t('saveImage')}</div>
                <div className={`dropdown-item ${!imageLoaded ? 'disabled' : ''}`} onClick={imageLoaded ? handleExportCSV : null}>{t('exportCsv')}</div>
                <div className={`dropdown-item ${!imageLoaded ? 'disabled' : ''}`} onClick={imageLoaded ? handleExportPDF : null}>{t('exportPdf')}</div>
              </div>
            </div>

            {/* Edit Menu */}
            <div className="menu-container">
              <div className="menu-item">{t('edit')}</div>
              <div className="dropdown-menu">
                <div className={`dropdown-item ${!imageLoaded ? 'disabled' : ''}`} onClick={handleInsertText}>{t('insertText')}</div>
                <div className="dropdown-separator"></div>
                <div className={`dropdown-item ${!imageLoaded ? 'disabled' : ''}`} onClick={imageLoaded ? handleApplyDefaultFontAll : null}>{t('applyFont')}</div>
                <div className="dropdown-separator"></div>
                <div className={`dropdown-item ${!canUndo ? 'disabled' : ''}`} onClick={canUndo ? () => canvasRef.current?.undo() : null}>{t('undo')}</div>
                <div className={`dropdown-item ${!canRedo ? 'disabled' : ''}`} onClick={canRedo ? () => canvasRef.current?.redo() : null}>{t('redo')}</div>
              </div>
            </div>

            {/* View Menu */}
            <div className="menu-container">
              <div className="menu-item">{t('view')}</div>
              <div className="dropdown-menu">
                <div className="dropdown-item" onClick={() => setShowLeftPanel(!showLeftPanel)}>
                  <span>{t('showLeft')}</span>
                  <span>{showLeftPanel ? '✓' : ''}</span>
                </div>
                <div className="dropdown-item" onClick={() => setShowRightPanel(!showRightPanel)}>
                  <span>{t('showRight')}</span>
                  <span>{showRightPanel ? '✓' : ''}</span>
                </div>
              </div>
            </div>

            {/* Settings Menu */}
            <div className="menu-container">
              <div className="menu-item">{t('settings')}</div>
              <div className="dropdown-menu">
                {/* UI Language Option */}
                <div className="dropdown-item" style={{ cursor: 'default', fontWeight: 'bold' }}>
                  <span>{t('uiLang')}</span>
                </div>
                <div className="dropdown-item" onClick={() => setUiLanguage('繁體中文')}>
                  <span>繁體中文</span>
                  <span>{uiLanguage === '繁體中文' ? '✓' : ''}</span>
                </div>
                <div className="dropdown-item" onClick={() => setUiLanguage('English')}>
                  <span>English</span>
                  <span>{uiLanguage === 'English' ? '✓' : ''}</span>
                </div>

                <div className="dropdown-separator"></div>

                {/* OCR Language Option */}
                <div className="dropdown-item" style={{ cursor: 'default', fontWeight: 'bold' }}>
                  <span>{t('ocrLang')}</span>
                </div>
                <div className="dropdown-item" onClick={() => setOcrLanguage('auto')}>
                  <span>Auto (繁中 + English)</span>
                  <span>{ocrLanguage === 'auto' ? '✓' : ''}</span>
                </div>
                <div className="dropdown-item" onClick={() => setOcrLanguage('zh-Hant')}>
                  <span>繁體中文 (chi_tra)</span>
                  <span>{ocrLanguage === 'zh-Hant' ? '✓' : ''}</span>
                </div>
                <div className="dropdown-item" onClick={() => setOcrLanguage('en')}>
                  <span>English (eng)</span>
                  <span>{ocrLanguage === 'en' ? '✓' : ''}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="header-right">
          <div className="zoom-controls">
            {/* Undo/Redo Controls */}
            <button className="btn btn-secondary" style={{padding: '2px 8px', marginRight: '8px'}} disabled={!canUndo} onClick={() => canvasRef.current?.undo()}>
              {t('undo')}
            </button>
            <button className="btn btn-secondary" style={{padding: '2px 8px', marginRight: '16px'}} disabled={!canRedo} onClick={() => canvasRef.current?.redo()}>
              {t('redo')}
            </button>

            <span>{t('zoom')}:</span>
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
        <aside className="sidebar left-sidebar" style={{ display: showLeftPanel ? 'flex' : 'none' }}>
          <h2 className="panel-title">{t('docStatus')}</h2>
          <div className="status-box" style={{ minHeight: '65px', display: 'flex', alignItems: 'center' }}>
            {isOcrProcessing ? (
              <div style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
                 <div style={{ color: '#60CDFF', fontWeight: 'bold', marginBottom: '4px' }}>{t('processingOcr')}</div>
                 <div style={{ fontSize: '11px', opacity: 0.8, color: '#60CDFF' }}>{workerStatus}</div>
              </div>
            ) : imageLoaded ? (
              <span style={{ color: '#4ADE80', fontWeight: 'bold' }}>{t('loaded')}</span>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
                 <span style={{ opacity: 0.5 }}>{t('noImage')}</span>
                 <span style={{ fontSize: '11px', opacity: 0.6, marginTop: '4px', color: '#60CDFF' }}>⚙ {workerStatus}</span>
              </div>
            )}
          </div>

          <h2 className="panel-title" style={{ marginTop: '16px' }}>{t('layers')}</h2>
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
            {layers.length === 0 && <div style={{ opacity: 0.5, fontSize: '12px', padding: '8px' }}>{t('noLayers')}</div>}
          </div>
        </aside>

        {/* Center Workspace (Canvas) */}
        <main className="workspace">
          <OcrCanvas 
            ref={canvasRef} 
            zoomLevel={zoom}
            isRegionalOcrActive={isRegionalOcrActive}
            ocrLanguage={ocrLanguage}
            onWorkerStatusChange={setWorkerStatus}
            onRegionalOcrComplete={() => setIsRegionalOcrActive(false)}
            onRegionSelect={setSelectedRegion} 
            onLayersUpdate={setLayers}
            onImageLoaded={setImageLoaded}
            onOcrProcessing={setIsOcrProcessing}
            onHistoryStatusChange={handleHistoryStatusChange}
          />
        </main>

        {/* Right Inspector */}
        <aside className="sidebar right-sidebar" style={{ display: showRightPanel ? 'flex' : 'none' }}>
          <h2 className="panel-title">{t('formatting')}</h2>
          
          <div className="panel-subtitle">{t('editContent')}</div>
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
            placeholder={selectedRegion ? t('placeholderActive') : t('placeholder')}
          />

          <div className="panel-subtitle">{t('paragraph')}</div>
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
              {t('bold')}
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
              {t('italic')}
            </button>
          </div>

          <div className="panel-subtitle">{t('color')}</div>
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

            {/* Custom Color Palette Picker */}
            <label 
              className="color-btn" 
              style={{
                background: 'linear-gradient(45deg, red, orange, yellow, green, blue, purple)',
                display: 'inline-block',
                cursor: selectedRegion ? 'pointer' : 'not-allowed',
                position: 'relative',
                opacity: selectedRegion ? 1 : 0.5
              }}
              title="Custom Color"
            >
              <input 
                type="color" 
                style={{ opacity: 0, position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', cursor: selectedRegion ? 'pointer' : 'not-allowed' }}
                disabled={!selectedRegion}
                value={selectedRegion?.fill || '#000000'}
                onChange={(e) => {
                  const color = e.target.value;
                  setSelectedRegion(prev => ({...prev, fill: color}));
                  canvasRef.current?.updateRegionStyle(selectedRegion.id, { fill: color });
                }}
              />
            </label>
          </div>

          <button 
            className="btn btn-secondary" 
            style={{ width: '100%', marginBottom: '16px' }}
            disabled={!imageLoaded}
            onClick={handleApplyDefaultFontAll}
          >
            {t('applyFontAll')}
          </button>

          <h2 className="panel-title" style={{marginTop: '24px'}}>{t('aiOps')}</h2>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
            <button 
              className="btn btn-secondary" 
              style={{flex: 1}} 
              disabled={!selectedRegion || isLoadingLLM} 
              onClick={handleFixText}
            >
              {t('fixText')}
            </button>
            <button 
              className="btn btn-secondary" 
              style={{flex: 1}} 
              disabled={!selectedRegion || isLoadingLLM}
              onClick={handleExtractEntities}
            >
              {t('extract')}
            </button>
          </div>
          <button 
            className="btn btn-secondary" 
            style={{width: '100%', marginBottom: '8px'}} 
            disabled={!selectedRegion || isLoadingLLM} 
            onClick={handleTranslate}
          >
            {t('translate')}
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
          
          <h2 className="panel-title" style={{marginTop: '24px'}}>{t('ops')}</h2>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button 
              className={`btn btn-secondary ${isRegionalOcrActive ? 'active' : ''}`} 
              style={{flex: 1}} 
              disabled={!imageLoaded}
              onClick={() => setIsRegionalOcrActive(!isRegionalOcrActive)}
            >
              {isRegionalOcrActive ? t('drawingMode') : t('regionalOcr')}
            </button>
            <button 
              className="btn btn-secondary" 
              style={{flex: 1}} 
              disabled={!selectedRegion}
              onClick={handleRemoveText}
            >
              {t('removeText')}
            </button>
          </div>
        </aside>

      </div>
    </div>
  );
}

export default App;
