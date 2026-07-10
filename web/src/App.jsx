import { useState, useRef, useEffect } from 'react';
import OcrCanvas from './components/OcrCanvas';
import { fixText, extractEntities } from './utils/llm';
import { getTranslation, SUPPORTED_UI_LANGUAGES } from './utils/i18n';
import { getNativeOcrEngineLabel, isNativeOcrAvailable } from './utils/nativeOcr';
import './index.css';

const FALLBACK_FONT_FAMILIES = [
  'Century Gothic', 'Arial', 'Segoe UI', 'Courier New', 'Times New Roman',
  'Helvetica Neue', 'Helvetica', 'Avenir Next', 'Avenir', 'Futura', 'Menlo', 'Monaco',
  'Microsoft JhengHei', 'PingFang TC', 'PingFang SC', 'PingFang HK', 'Heiti TC',
  'Songti TC', 'Kaiti TC', 'Hiragino Sans', 'Noto Sans TC', 'Noto Serif TC',
  'Apple SD Gothic Neo', 'PMingLiU', 'DFKai-SB', 'sans-serif', 'serif', 'monospace'
];
const OCR_ENGINE_CONFIG_VERSION = 'native-primary-v1';

function App() {
  const nativeOcrAvailableAtStartup = isNativeOcrAvailable();
  const [selectedRegion, setSelectedRegion] = useState(null);
  const [layers, setLayers] = useState([]);
  const canvasRef = useRef(null);

  const [imageLoaded, setImageLoaded] = useState(false);
  const [isOcrProcessing, setIsOcrProcessing] = useState(false);
  const [isRegionalOcrActive, setIsRegionalOcrActive] = useState(false);
  const [regionalAction, setRegionalAction] = useState('ocr');

  const [isLoadingLLM, setIsLoadingLLM] = useState(false);
  const [llmProgress, setLlmProgress] = useState('');
  const [zoom, setZoom] = useState(1);

  // Panel visible states to align with View Menu in WPF
  const [showLeftPanel, setShowLeftPanel] = useState(true);
  const [showRightPanel, setShowRightPanel] = useState(true);

  // Settings States. Keep the selected language between visits and use the
  // same eleven-language list as the native editor.
  const [uiLanguage, setUiLanguage] = useState(() => {
    const saved = localStorage.getItem('ui_language');
    return SUPPORTED_UI_LANGUAGES.includes(saved) ? saved : '繁體中文';
  });
  const [workerStatus, setWorkerStatus] = useState('Initializing...');

  // OCR Engine: native OS OCR is the main path; browser/cloud engines remain fallback only.
  const [ocrEngine, setOcrEngine] = useState(() => {
    const savedVersion = localStorage.getItem('ocr_engine_config_version');
    const savedEngine = localStorage.getItem('ocr_engine');
    if (savedVersion !== OCR_ENGINE_CONFIG_VERSION) {
      localStorage.setItem('ocr_engine_config_version', OCR_ENGINE_CONFIG_VERSION);
      localStorage.setItem('ocr_engine', 'custom');
      return 'custom';
    }
    return savedEngine || 'custom';
  });
  const [geminiApiKey, setGeminiApiKey] = useState(() => localStorage.getItem('gemini_api_key') || '');
  const [geminiModel, setGeminiModel] = useState(() => localStorage.getItem('gemini_model') || 'gemini-2.5-flash');
  const [geminiApiUrl, setGeminiApiUrl] = useState(() => localStorage.getItem('gemini_api_url') || 'https://generativelanguage.googleapis.com');
  const [localServerUrl, setLocalServerUrl] = useState(() => {
    const saved = localStorage.getItem('local_server_url');
    // Migrate the old default: port 5000 is occupied by macOS AirPlay Receiver
    if (!saved || saved === 'http://localhost:5000/ocr') {
      localStorage.setItem('local_server_url', 'http://localhost:5001/ocr');
      return 'http://localhost:5001/ocr';
    }
    return saved;
  });

  const handleOcrEngineChange = (engine) => {
    setOcrEngine(engine);
    localStorage.setItem('ocr_engine', engine);
    localStorage.setItem('ocr_engine_config_version', OCR_ENGINE_CONFIG_VERSION);
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

  const handleLocalServerUrlChange = (url) => {
    setLocalServerUrl(url);
    localStorage.setItem('local_server_url', url);
  };

  const handleUiLanguageChange = (language) => {
    setUiLanguage(language);
    localStorage.setItem('ui_language', language);
  };

  const [localServerStatus, setLocalServerStatus] = useState(() => nativeOcrAvailableAtStartup ? 'connected' : 'disconnected');
  const [localServerEngine, setLocalServerEngine] = useState(() => nativeOcrAvailableAtStartup ? getNativeOcrEngineLabel() : '');
  const [mobileNativeOcrAvailable] = useState(nativeOcrAvailableAtStartup);

  const testLocalServerConnection = async () => {
    if (mobileNativeOcrAvailable) {
      setLocalServerStatus('connected');
      setLocalServerEngine(getNativeOcrEngineLabel());
      return;
    }

    setLocalServerStatus('checking');
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);

      const baseUrl = localServerUrl.replace(/\/ocr$/, '');
      const response = await fetch(`${baseUrl}/status`, {
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        if (data.status === 'running') {
          setLocalServerStatus('connected');
          setLocalServerEngine(data.engine || '');
          return;
        }
      }
      setLocalServerStatus('disconnected');
    } catch {
      setLocalServerStatus('disconnected');
    }
  };

  useEffect(() => {
    if (ocrEngine === 'custom') {
      testLocalServerConnection();
    }
  }, [ocrEngine, localServerUrl, mobileNativeOcrAvailable]);

  // The default is now deliberately simple: native OCR is the primary workflow.
  // Tesseract/Gemini are kept as opt-in fallback engines when localhost native
  // OCR is unavailable or the user explicitly wants to compare engines.

  // Preset Fonts
  const [chineseFont, setChineseFont] = useState('Microsoft JhengHei');
  const [englishFont, setEnglishFont] = useState('Century Gothic');
  const [forcePresetFont, setForcePresetFont] = useState(() => localStorage.getItem('force_preset_font') === 'true');
  const [availableFontFamilies, setAvailableFontFamilies] = useState(FALLBACK_FONT_FAMILIES);
  const [fontLoadStatus, setFontLoadStatus] = useState('');
  const [fontApplyStatus, setFontApplyStatus] = useState('');

  const mergeFontFamilies = (fonts = []) => {
    const families = new Set(FALLBACK_FONT_FAMILIES);
    fonts.forEach((font) => {
      if (font?.family) families.add(font.family);
      if (font?.fullName) families.add(font.fullName);
    });
    return [...families].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  };

  const queryDeviceFonts = async ({ requireGrantedPermission = false } = {}) => {
    if (typeof window === 'undefined' || typeof window.queryLocalFonts !== 'function') {
      return { supported: false, fonts: [] };
    }

    if (requireGrantedPermission && navigator.permissions?.query) {
      try {
        const permission = await navigator.permissions.query({ name: 'local-fonts' });
        if (permission?.state !== 'granted') {
          return { supported: true, fonts: [] };
        }
      } catch {
        // Some Chromium builds do not expose the permission descriptor yet.
      }
    }

    const fonts = await window.queryLocalFonts();
    return { supported: true, fonts };
  };

  const handleLoadLocalFonts = async () => {
    setFontLoadStatus('fontLoading');
    try {
      const result = await queryDeviceFonts();
      if (!result.supported) {
        setFontLoadStatus('fontUnsupported');
        setAvailableFontFamilies(mergeFontFamilies());
        return;
      }
      const merged = mergeFontFamilies(result.fonts);
      setAvailableFontFamilies(merged);
      setFontLoadStatus(result.fonts.length > 0 ? 'fontLoaded' : 'fontPermissionNeeded');
    } catch (error) {
      console.info('Local font enumeration unavailable:', error);
      setAvailableFontFamilies(mergeFontFamilies());
      setFontLoadStatus('fontPermissionDenied');
    }
  };

  // Chromium exposes the Local Font Access API behind a permission prompt.
  // On first render, only enumerate when permission is already granted; the
  // explicit button below provides the required user gesture for the full list.
  useEffect(() => {
    let cancelled = false;
    const loadLocalFonts = async () => {
      let merged = mergeFontFamilies();
      try {
        const result = await queryDeviceFonts({ requireGrantedPermission: true });
        if (result.supported && result.fonts.length > 0) merged = mergeFontFamilies(result.fonts);
      } catch (error) {
        console.info('Initial local font enumeration unavailable:', error);
      }
      if (!cancelled) {
        setAvailableFontFamilies(merged);
      }
    };
    loadLocalFonts();
    return () => { cancelled = true; };
  }, []);

  // Each choice carries cross-platform equivalents: the Windows names
  // (JhengHei/DFKai-SB/PMingLiU) don't exist on macOS and vice versa,
  // so a bare name silently falls back and font switching looks broken.
  const CJK_FONT_STACKS = {
    'Microsoft JhengHei': `'Microsoft JhengHei', '微軟正黑體', 'PingFang TC', 'Heiti TC'`,
    'PingFang TC': `'PingFang TC', 'Microsoft JhengHei', 'Heiti TC'`,
    'DFKai-SB': `'DFKai-SB', '標楷體', 'BiauKai', 'Kaiti TC', 'KaiTi'`,
    'PMingLiU': `'PMingLiU', '新細明體', 'Songti TC', 'LiSong Pro', 'SimSun'`,
    'sans-serif': 'sans-serif'
  };
  const EN_FONT_STACKS = {
    'Century Gothic': `'Century Gothic', 'Avenir Next', 'Futura'`,
    'Segoe UI': `'Segoe UI', 'Helvetica Neue', 'Arial'`,
    'Arial': `'Arial', 'Helvetica'`,
    'Courier New': `'Courier New', 'Courier', monospace`,
    'Times New Roman': `'Times New Roman', 'Times', serif`
  };
  const quoteFontFamily = (family) => `'${String(family).replace(/'/g, "\\'")}'`;
  const presetFontFamily = `${EN_FONT_STACKS[englishFont] || quoteFontFamily(englishFont)}, ${CJK_FONT_STACKS[chineseFont] || quoteFontFamily(chineseFont)}, sans-serif`;

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
    setLlmProgress(t('initializingAi'));
    try {
      const fixed = await fixText(selectedRegion.text, (prog) => {
         setLlmProgress(prog);
      });
      setSelectedRegion(prev => ({ ...prev, text: fixed }));
      if (canvasRef.current) canvasRef.current.updateRegionText(selectedRegion.id, fixed);
      setLlmProgress(t('textCorrected'));
    } catch (e) {
      alert(`${t('fixText')}: ${e.message}`);
      setLlmProgress(t('aiFailed'));
    } finally {
      setIsLoadingLLM(false);
    }
  };

  const handleExtractEntities = async () => {
    if (!selectedRegion) return;
    setIsLoadingLLM(true);
    setLlmProgress(t('initializingAiShort'));
    try {
      const entities = await extractEntities(selectedRegion.text, (prog) => {
         setLlmProgress(prog);
      });
      const combined = `【Entities】\n${entities}\n\n【Original】\n${selectedRegion.text}`;
      setSelectedRegion(prev => ({ ...prev, text: combined }));
      if (canvasRef.current) canvasRef.current.updateRegionText(selectedRegion.id, combined);
      setLlmProgress(t('entitiesExtracted'));
    } catch (e) {
      alert(`${t('extract')}: ${e.message}`);
      setLlmProgress(t('aiFailed'));
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
        setFontApplyStatus('fontAppliedAll');
        if (selectedRegion) {
          setSelectedRegion(prev => ({ ...prev, fontFamily: presetFontFamily }));
        }
     }
  };

  const handleApplyPresetFontSelected = () => {
     if (canvasRef.current && selectedRegion) {
        canvasRef.current.updateRegionStyle(selectedRegion.id, { fontFamily: presetFontFamily });
        setSelectedRegion(prev => ({ ...prev, fontFamily: presetFontFamily }));
        setFontApplyStatus('fontAppliedSelected');
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
      alert(t('noLayersExport'));
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
     if (!imageLoaded) return alert(t('loadImageFirst'));
     canvasRef.current?.insertText();
  };

  const handleRegionTool = (action) => {
    if (!imageLoaded) return;
    const shouldTurnOff = isRegionalOcrActive && regionalAction === action;
    setRegionalAction(action);
    setIsRegionalOcrActive(!shouldTurnOff);
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
                {SUPPORTED_UI_LANGUAGES.map((language) => (
                  <div className="dropdown-item" key={language} onClick={() => handleUiLanguageChange(language)}>
                    <span>{language}</span>
                    <span>{uiLanguage === language ? '✓' : ''}</span>
                  </div>
                ))}

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
            {t('exportImage')}
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
                  {layer.text || t('emptyLayer')}
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
            regionalAction={regionalAction}

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
            localServerUrl={localServerUrl}
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
                {ocrEngine === 'cloud' ? t('cloudOcrHint') : t('ocrHint')}
              </div>
            </div>
          )}
        </main>

        {/* Right Inspector */}
        <aside className="sidebar right-sidebar" style={{ display: showRightPanel ? 'flex' : 'none' }}>
          <h2 className="panel-title">{t('formatting')}</h2>

          <div className="panel-subtitle">{t('editContent')}</div>
          <textarea
            className="textarea inspector-textarea"
            rows={3}
            aria-label={t('editContent')}
            value={selectedRegion?.text || ''}
            disabled={!selectedRegion}
            onChange={(e) => {
              const newText = e.target.value;
              setSelectedRegion(prev => ({ ...prev, text: newText }));
              if (canvasRef.current && selectedRegion?.id) {
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
              title={t('customColor')}
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
          <div className="ocr-engine-panel">
            {ocrEngine !== 'custom' && (
              <div className="fallback-active-notice">
                <span>{t('fallbackEngineActive')}</span>
                <button className="btn btn-secondary" onClick={() => handleOcrEngineChange('custom')}>
                  {t('switchToNativeOcr')}
                </button>
              </div>
            )}

            <div className={`native-ocr-card ${ocrEngine === 'custom' ? 'active' : ''}`}>
              <div className="native-ocr-header">
                <div>
                  <strong>{t('nativeOcrPrimary')}</strong>
                  <div>{t('nativeOcrMainDescription')}</div>
                </div>
                <button
                  className={`btn btn-secondary ${ocrEngine === 'custom' ? 'active' : ''}`}
                  onClick={() => handleOcrEngineChange('custom')}
                >
                  {ocrEngine === 'custom' ? t('nativeOcrActive') : t('useNativeOcr')}
                </button>
              </div>

              {!mobileNativeOcrAvailable && (
                <>
                  <span style={{ fontSize: '11px', opacity: 0.8 }}>
                    {t('localServerUrl')}:
                  </span>
                  <input
                    type="text"
                    value={localServerUrl}
                    onChange={(e) => handleLocalServerUrlChange(e.target.value)}
                    placeholder="http://localhost:5001/ocr"
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
                </>
              )}

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginTop: '4px' }}>
                <span style={{ fontSize: '11px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    background: localServerStatus === 'connected' ? '#4ADE80' : localServerStatus === 'checking' ? '#FBBF24' : '#EF4444',
                    display: 'inline-block'
                  }} />
                  <span style={{ opacity: 0.85 }}>
                    {localServerStatus === 'connected'
                      ? `${t('connected')} (${localServerEngine || 'OCR'})`
                      : localServerStatus === 'checking'
                      ? t('checking')
                      : t('serverNotFound')}
                  </span>
                </span>
                <button
                  onClick={testLocalServerConnection}
                  disabled={mobileNativeOcrAvailable}
                  style={{
                    background: 'rgba(255,255,255,0.08)',
                    border: '1px solid rgba(255,255,255,0.12)',
                    borderRadius: '4px',
                    color: '#fff',
                    padding: '2px 6px',
                    fontSize: '10px',
                    cursor: mobileNativeOcrAvailable ? 'default' : 'pointer',
                    opacity: mobileNativeOcrAvailable ? 0.55 : 1
                  }}
                >
                  {t('testConnection')}
                </button>
              </div>

              <details className="native-ocr-purpose">
                <summary>{mobileNativeOcrAvailable ? t('onDeviceOcrPurpose') : t('localServerPurpose')}</summary>
                <div className="native-ocr-purpose-body">
                  <div>
                    {mobileNativeOcrAvailable ? t('onDeviceOcrPurposeDescription') : t('localServerPurposeDescription')}
                  </div>
                  <div className="native-ocr-warning">
                    {mobileNativeOcrAvailable ? t('onDeviceOcrOfflineNote') : t('mobileNativeOcrNote')}
                  </div>
                  <div className="native-ocr-current">
                    {mobileNativeOcrAvailable
                      ? `${t('onDeviceOcrCurrentEngine')} ${localServerEngine || getNativeOcrEngineLabel()}`
                      : t('localServerCurrentDescription')}
                  </div>
                </div>
              </details>
            </div>

            <button
              className="btn btn-primary"
              style={{ width: '100%', padding: '8px', fontSize: '12px', fontWeight: 'bold' }}
              disabled={!imageLoaded || isOcrProcessing}
              onClick={() => canvasRef.current?.rerunOcr()}
            >
              {isOcrProcessing ? t('recognizing') : t('rerunOcr')}
            </button>

            <details className="fallback-engine-panel">
              <summary>{t('fallbackEngines')}</summary>
              <div className="fallback-engine-description">{t('fallbackEnginesDescription')}</div>
              <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '8px' }}>
                <button
                  className={`btn btn-secondary ${ocrEngine === 'local' ? 'active' : ''}`}
                  style={{ flex: 1, minWidth: '90px', padding: '6px 2px', fontSize: '11px' }}
                  title={t('localEngineHelp')}
                  onClick={() => handleOcrEngineChange('local')}
                >
                  {t('localEngine')}
                </button>
                <button
                  className={`btn btn-secondary ${ocrEngine === 'cloud' ? 'active' : ''}`}
                  style={{ flex: 1, minWidth: '90px', padding: '6px 2px', fontSize: '11px' }}
                  title={t('cloudEngineHelp')}
                  onClick={() => handleOcrEngineChange('cloud')}
                >
                  {t('cloudEngine')}
                </button>
              </div>

              {ocrEngine === 'cloud' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '8px' }}>
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
                    {t('cloudModel')}:
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
                    {t('customBaseUrl')}:
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
            </details>
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
                {availableFontFamilies.map((family) => (
                  <option value={family} key={`english-${family}`}>{family}</option>
                ))}
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
                {availableFontFamilies.map((family) => (
                  <option value={family} key={`cjk-${family}`}>{family}</option>
                ))}
              </select>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
              <input
                type="checkbox"
                id="forcePresetFontCheckbox"
                checked={forcePresetFont}
                onChange={(e) => {
                  setForcePresetFont(e.target.checked);
                  localStorage.setItem('force_preset_font', String(e.target.checked));
                }}
                style={{ cursor: 'pointer' }}
              />
              <label
                htmlFor="forcePresetFontCheckbox"
                style={{ fontSize: '11px', opacity: 0.8, cursor: 'pointer', userSelect: 'none' }}
              >
                {t('forceFont')}
              </label>
            </div>

            <div style={{ fontSize: '10px', opacity: 0.65, lineHeight: '1.4' }}>
              {t('localFontsHint')}
            </div>
            <details className="font-workflow-panel">
              <summary>{t('presetFontWorkflowTitle')}</summary>
              <ol>
                <li>{t('presetFontWorkflowStep1')}</li>
                <li>{t('presetFontWorkflowStep2')}</li>
                <li>{t('presetFontWorkflowStep3')}</li>
                <li>{t('presetFontWorkflowStep4')}</li>
              </ol>
            </details>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ width: '100%', padding: '6px', fontSize: '11px' }}
              onClick={handleLoadLocalFonts}
            >
              {t('loadDeviceFonts')} ({availableFontFamilies.length})
            </button>
            {fontLoadStatus && (
              <div className="font-load-status">
                {t(fontLoadStatus)}
              </div>
            )}
            {fontApplyStatus && (
              <div className="font-load-status">
                {t(fontApplyStatus)}
              </div>
            )}
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
          <div className="ai-operation-row">
            <div className="ai-operation-item">
              <button
                className="btn btn-secondary"
                disabled={!selectedRegion || isLoadingLLM}
                onClick={handleFixText}
              >
                {t('fixText')}
              </button>
              <button
                type="button"
                className="ai-help-icon"
                aria-label={t('fixTextHelp')}
                title={t('fixTextHelp')}
                data-tooltip={t('fixTextHelp')}
              >
                ⓘ
              </button>
            </div>
            <div className="ai-operation-item">
              <button
                className="btn btn-secondary"
                disabled={!selectedRegion || isLoadingLLM}
                onClick={handleExtractEntities}
              >
                {t('extract')}
              </button>
              <button
                type="button"
                className="ai-help-icon"
                aria-label={t('extractHelp')}
                title={t('extractHelp')}
                data-tooltip={t('extractHelp')}
              >
                ⓘ
              </button>
            </div>
          </div>
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
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button
              className={`btn btn-secondary ${isRegionalOcrActive && regionalAction === 'ocr' ? 'active' : ''}`}
              style={{flex: 1}}
              disabled={!imageLoaded}
              onClick={() => handleRegionTool('ocr')}
            >
              {isRegionalOcrActive && regionalAction === 'ocr' ? t('drawingMode') : t('regionalOcr')}
            </button>
            <button
              className={`btn btn-secondary ${isRegionalOcrActive && regionalAction === 'erase' ? 'active' : ''}`}
              style={{flex: 1}}
              disabled={!imageLoaded}
              onClick={() => handleRegionTool('erase')}
            >
              {isRegionalOcrActive && regionalAction === 'erase' ? t('eraseDrawingMode') : t('eraseRegion')}
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
