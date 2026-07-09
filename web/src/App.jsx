import { useState, useRef } from 'react';
import OcrCanvas from './components/OcrCanvas';
import { fixText, translateText, extractEntities } from './utils/llm';
import { getTranslation } from './utils/i18n';
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

  // Settings States (Default to English UI to match native settings)
  const [uiLanguage, setUiLanguage] = useState('繁體中文');
  const [workerStatus, setWorkerStatus] = useState('Initializing...');

  // OCR Engine (local Tesseract vs cloud Gemini)
  const [ocrEngine, setOcrEngine] = useState(() => localStorage.getItem('ocr_engine') || 'local');
  const [geminiApiKey, setGeminiApiKey] = useState(() => localStorage.getItem('gemini_api_key') || '');
  const [geminiModel, setGeminiModel] = useState(() => localStorage.getItem('gemini_model') || 'gemini-2.5-flash');
  const [geminiApiUrl, setGeminiApiUrl] = useState(() => localStorage.getItem('gemini_api_url') || 'https://generativelanguage.googleapis.com');

  const handleOcrEngineChange = (engine) => {
    setOcrEngine(engine);
    localStorage.setItem('ocr_engine', engine);
  };

  const handleGeminiApiKeyChange = (key) => {
    setGeminiApiKey(key);
    localStorage.setItem('gemini_api_key', key);
  };

  const handleGeminiModelChange = (model) => {
    setGeminiModel(model);
    localStorage.setItem('gemini_model', model);
  };

  const handleGeminiApiUrlChange = (url) => {
    setGeminiApiUrl(url);
    localStorage.setItem('gemini_api_url', url);
  };

  // Preset Fonts
  const [chineseFont, setChineseFont] = useState('Microsoft JhengHei');
  const [englishFont, setEnglishFont] = useState('Century Gothic');
  const [forcePresetFont, setForcePresetFont] = useState(true);

  const presetFontFamily = `'${englishFont}', '${chineseFont}', sans-serif`;

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
        canvasRef.current.applyDefaultFontToAll(presetFontFamily);
        if (selectedRegion) {
          setSelectedRegion(prev => ({ ...prev, fontFamily: presetFontFamily }));
        }
     }
  };

  const handleApplyPresetFontSelected = () => {
     if (canvasRef.current && selectedRegion) {
        canvasRef.current.updateRegionStyle(selectedRegion.id, { fontFamily: presetFontFamily });
        setSelectedRegion(prev => ({ ...prev, fontFamily: presetFontFamily }));
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
                <div className={`dropdown-item ${!imageLoaded || !selectedRegion ? 'disabled' : ''}`} onClick={imageLoaded && selectedRegion ? handleApplyPresetFontSelected : null}>{t('applyFont')}</div>
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

                {/* OCR Engine Option */}
                <div className="dropdown-item" style={{ cursor: 'default', fontWeight: 'bold' }}>
                  <span>{t('ocrEngine')}</span>
                </div>
                <div className="dropdown-item" onClick={() => handleOcrEngineChange('local')}>
                  <span>{t('localEngine')}</span>
                  <span>{ocrEngine === 'local' ? '✓' : ''}</span>
                </div>
                <div className="dropdown-item" onClick={() => handleOcrEngineChange('cloud')}>
                  <span>{t('cloudEngine')}</span>
                  <span>{ocrEngine === 'cloud' ? '✓' : ''}</span>
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

            onWorkerStatusChange={setWorkerStatus}
            onRegionalOcrComplete={() => setIsRegionalOcrActive(false)}
            onRegionSelect={setSelectedRegion} 
            onLayersUpdate={setLayers}
            onImageLoaded={(loaded) => { setImageLoaded(loaded); if (loaded) setZoom(1); }}
            onOcrProcessing={setIsOcrProcessing}
            onHistoryStatusChange={handleHistoryStatusChange}
            presetFontFamily={presetFontFamily}
            forcePresetFont={forcePresetFont}
            ocrEngine={ocrEngine}
            geminiApiKey={geminiApiKey}
            geminiModel={geminiModel}
            geminiApiUrl={geminiApiUrl}
            t={t}
          />

          {/* ── Processing Overlay ── */}
          {isOcrProcessing && (
            <div style={{
              position: 'absolute',
              top: 0, left: 0, right: 0, bottom: 0,
              background: 'rgba(0, 0, 0, 0.65)',
              backdropFilter: 'blur(4px)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 900,
              gap: '16px',
              pointerEvents: 'none',
            }}>
              {/* Spinner */}
              <div style={{
                width: '48px', height: '48px',
                border: '4px solid rgba(96, 205, 255, 0.2)',
                borderTopColor: '#60CDFF',
                borderRadius: '50%',
                animation: 'ocr-spin 0.8s linear infinite',
              }} />

              {/* Status Text */}
              <div style={{
                color: '#60CDFF',
                fontSize: '16px',
                fontWeight: '600',
                textAlign: 'center',
                maxWidth: '80%',
                lineHeight: '1.6',
                animation: 'ocr-pulse 2s ease-in-out infinite',
              }}>
                {workerStatus}
              </div>

              {/* Sub-hint */}
              <div style={{
                color: 'rgba(255,255,255,0.5)',
                fontSize: '12px',
                textAlign: 'center',
              }}>
                {ocrEngine === 'cloud'
                  ? '圖片已分割為多區域，依序透過佇列進行辨識…'
                  : 'OCR 辨識中，請稍候…'}
              </div>
            </div>
          )}
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

          <div className="panel-subtitle">{t('ocrEngine')}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' }}>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button 
                className={`btn btn-secondary ${ocrEngine === 'local' ? 'active' : ''}`}
                style={{ flex: 1, padding: '6px 4px', fontSize: '11px' }}
                onClick={() => handleOcrEngineChange('local')}
              >
                {uiLanguage === '繁體中文' ? '本地 (Tesseract)' : 'Local (Tesseract)'}
              </button>
              <button 
                className={`btn btn-secondary ${ocrEngine === 'cloud' ? 'active' : ''}`}
                style={{ flex: 1, padding: '6px 4px', fontSize: '11px' }}
                onClick={() => handleOcrEngineChange('cloud')}
              >
                {uiLanguage === '繁體中文' ? '雲端 (Gemini 2.0)' : 'Cloud (Gemini 2.0)'}
              </button>
            </div>
            
            {ocrEngine === 'cloud' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '4px' }}>
                <span style={{ fontSize: '11px', opacity: 0.8 }}>{t('geminiKey')}:</span>
                <input 
                  type="password"
                  value={geminiApiKey}
                  onChange={(e) => handleGeminiApiKeyChange(e.target.value)}
                  placeholder="AI_zaSy..."
                  style={{
                    background: '#111111',
                    color: '#fff',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: '4px',
                    padding: '6px 8px',
                    fontSize: '12px',
                    width: '100%'
                  }}
                />

                <span style={{ fontSize: '11px', opacity: 0.8, marginTop: '4px' }}>
                  {uiLanguage === '繁體中文' ? '雲端模型:' : 'Cloud Model:'}
                </span>
                <select
                  value={geminiModel}
                  onChange={(e) => handleGeminiModelChange(e.target.value)}
                  style={{
                    background: '#2D2D2D',
                    color: '#fff',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: '4px',
                    padding: '6px 8px',
                    fontSize: '12px',
                    width: '100%',
                    cursor: 'pointer'
                  }}
                >
                  <option value="gemini-2.5-flash">Gemini 2.5 Flash (預設)</option>
                  <option value="gemini-2.0-flash">Gemini 2.0 Flash (相容)</option>
                  <option value="gemini-2.0-pro">Gemini 2.0 Pro (高精準度)</option>
                  <option value="gemini-1.5-flash">Gemini 1.5 Flash (備用)</option>
                </select>

                <span style={{ fontSize: '11px', opacity: 0.8, marginTop: '4px' }}>
                  {uiLanguage === '繁體中文' ? '自訂 API 節點 (選填):' : 'Custom Base URL (Optional):'}
                </span>
                <input 
                  type="text"
                  value={geminiApiUrl}
                  onChange={(e) => handleGeminiApiUrlChange(e.target.value)}
                  placeholder="https://generativelanguage.googleapis.com"
                  style={{
                    background: '#111111',
                    color: '#fff',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: '4px',
                    padding: '6px 8px',
                    fontSize: '12px',
                    width: '100%'
                  }}
                />

                <a 
                  href="https://aistudio.google.com/" 
                  target="_blank" 
                  rel="noreferrer"
                  style={{ fontSize: '11px', color: '#60CDFF', textDecoration: 'underline', marginTop: '4px', display: 'inline-block' }}
                >
                  {t('getKeyLink')}
                </a>
              </div>
            )}
          </div>

          <div className="panel-subtitle">{t('presetFonts')}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
              <span style={{ fontSize: '12px', opacity: 0.8 }}>{t('engFont')}:</span>
              <select 
                value={englishFont}
                onChange={(e) => setEnglishFont(e.target.value)}
                style={{
                  background: '#2D2D2D',
                  color: '#fff',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: '4px',
                  padding: '4px 8px',
                  fontSize: '12px',
                  width: '180px'
                }}
              >
                <option value="Century Gothic">Century Gothic</option>
                <option value="Arial">Arial</option>
                <option value="Segoe UI">Segoe UI</option>
                <option value="Courier New">Courier New</option>
                <option value="Times New Roman">Times New Roman</option>
              </select>
            </div>
            
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
              <span style={{ fontSize: '12px', opacity: 0.8 }}>{t('zhFont')}:</span>
              <select 
                value={chineseFont}
                onChange={(e) => setChineseFont(e.target.value)}
                style={{
                  background: '#2D2D2D',
                  color: '#fff',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: '4px',
                  padding: '4px 8px',
                  fontSize: '12px',
                  width: '180px'
                }}
              >
                <option value="Microsoft JhengHei">微軟正黑體 (JhengHei)</option>
                <option value="PingFang TC">蘋方 (PingFang TC)</option>
                <option value="DFKai-SB">標楷體 (DFKai-SB)</option>
                <option value="PMingLiU">新細明體 (PMingLiU)</option>
                <option value="sans-serif">通用無襯線字 (Sans-serif)</option>
              </select>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
              <input 
                type="checkbox" 
                id="forcePresetFontCheckbox"
                checked={forcePresetFont}
                onChange={(e) => setForcePresetFont(e.target.checked)}
                style={{ cursor: 'pointer' }}
              />
              <label 
                htmlFor="forcePresetFontCheckbox" 
                style={{ fontSize: '11px', opacity: 0.8, cursor: 'pointer', userSelect: 'none' }}
              >
                {t('forceFont')}
              </label>
            </div>
          </div>

          <button 
            className="btn btn-secondary" 
            style={{ width: '100%', marginBottom: '16px' }}
            disabled={!imageLoaded}
            onClick={handleApplyDefaultFontAll}
          >
            {t('applyFontAllPreset')}
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
