// E2E harness for verifying that OCR cover patches actually hide the source
// glyphs, on screen and in the export path. Driven headlessly:
//   chrome --headless --dump-dom http://localhost:<port>/test-e2e.html?w=1200&h=800
// Requires the stub OCR server (web/test-e2e-stub-server.mjs) on :5001.
import { createRoot } from 'react-dom/client';
import { useEffect, useRef } from 'react';
import OcrCanvas from './components/OcrCanvas';
import './index.css';

const params = new URLSearchParams(location.search);
const W = Number(params.get('w') || 1200);
const H = Number(params.get('h') || 800);
const OCR_URL = params.get('ocrUrl') || 'http://localhost:5001/ocr';
const IMAGE_URL = params.get('imageUrl') || '';

const IMG_W = 1000;
const IMG_H = 700;
// Must match the stub server's bboxes ([ymin,xmin,ymax,xmax] normalized /1000):
// line1 -> x 100..420, y 100..150 ; line2 -> x 500..820, y 400..450
const LINES = [
  { name: 'line1', text: '評估指標系統', x: 100, y: 100, w: 320, h: 50 },
  { name: 'line2', text: '第二行文字測試', x: 500, y: 400, w: 320, h: 50 }
];

const resultsEl = () => document.getElementById('results');
window.__logs = [];
for (const level of ['error', 'warn']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    window.__logs.push(level + ': ' + args.map(a => (a && a.stack) || String(a)).join(' '));
    orig(...args);
  };
}
window.alert = (m) => { resultsEl().textContent = 'E2E_ALERT ' + m; };

async function makeTestImageBlob() {
  if (IMAGE_URL) {
    const response = await fetch(IMAGE_URL);
    if (!response.ok) throw new Error(`Unable to load E2E image: ${response.status}`);
    return response.blob();
  }
  const c = document.createElement('canvas');
  c.width = IMG_W;
  c.height = IMG_H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, IMG_W, IMG_H);
  ctx.fillStyle = '#000000';
  ctx.textBaseline = 'top';
  ctx.font = '42px sans-serif';
  for (const l of LINES) ctx.fillText(l.text, l.x, l.y + 2);
  return new Promise(res => c.toBlob(res, 'image/png'));
}

function darkStats(data) {
  let dark = 0, total = 0;
  for (let i = 0; i < data.length; i += 4) {
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    if (lum < 128) dark++;
    total++;
  }
  return { dark, total, darkRatio: total ? +(dark / total).toFixed(4) : 0 };
}

async function measure() {
  const canvas = window.__fabricCanvas;
  const objs = canvas.getObjects();
  const textboxes = objs.filter(o => o.type === 'textbox');
  const patches = objs.filter(o => o.isPatch);

  const scale = Math.min(W / IMG_W, H / IMG_H);
  const left = (W - IMG_W * scale) / 2;
  const top = (H - IMG_H * scale) / 2;

  // --- On-screen check: hide OCR text, look for surviving source glyphs ---
  textboxes.forEach(t => { t.visible = false; });
  canvas.renderAll();
  const el = canvas.lowerCanvasEl;
  const ratio = el.width / canvas.getWidth();
  const ctx2 = el.getContext('2d');
  const screenCoverage = LINES.map(b => {
    const bx = Math.round((left + b.x * scale) * ratio);
    const by = Math.round((top + b.y * scale) * ratio);
    const bw = Math.max(1, Math.round(b.w * scale * ratio));
    const bh = Math.max(1, Math.round(b.h * scale * ratio));
    return { name: b.name, ...darkStats(ctx2.getImageData(bx, by, bw, bh).data) };
  });

  // --- Export check: same crop/multiplier as exportImage() ---
  const dataUrl = canvas.toDataURL({
    format: 'png',
    left, top,
    width: IMG_W * scale,
    height: IMG_H * scale,
    multiplier: 1 / scale
  });
  const exportImg = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = dataUrl;
  });
  const ec = document.createElement('canvas');
  ec.width = exportImg.width;
  ec.height = exportImg.height;
  const ectx = ec.getContext('2d');
  ectx.drawImage(exportImg, 0, 0);
  const exportCoverage = LINES.map(b =>
    ({ name: b.name, ...darkStats(ectx.getImageData(b.x, b.y, b.w, b.h).data) }));

  textboxes.forEach(t => { t.visible = true; });
  canvas.renderAll();

  return {
    viewport: { W, H },
    scale: +scale.toFixed(4),
    exportSize: { w: exportImg.width, h: exportImg.height },
    textboxCount: textboxes.length,
    textboxes: textboxes.map(t => ({
      id: t.id,
      text: t.text,
      fill: t.fill,
      left: +t.left.toFixed(1),
      top: +t.top.toFixed(1),
      width: +t.width.toFixed(1),
      height: +t.height.toFixed(1)
    })),
    patchCount: patches.length,
    patches: patches.map(p => {
      // sample the patch bitmap itself
      let bitmapCenter = null;
      try {
        const pc = document.createElement('canvas');
        const ew = p._element.naturalWidth || p._element.width;
        const eh = p._element.naturalHeight || p._element.height;
        pc.width = ew; pc.height = eh;
        const pctx = pc.getContext('2d');
        pctx.drawImage(p._element, 0, 0);
        const px = pctx.getImageData(Math.floor(ew / 2), Math.floor(eh / 2), 1, 1).data;
        bitmapCenter = [...px];
      } catch (e) { bitmapCenter = 'ERR ' + e.message; }
      return {
        left: +p.left.toFixed(1),
        top: +p.top.toFixed(1),
        width: +p.width.toFixed(1),
        height: +p.height.toFixed(1),
        scaleX: +p.scaleX.toFixed(4),
        scaleY: +p.scaleY.toFixed(4),
        visible: p.visible,
        opacity: p.opacity,
        stackIndex: canvas.getObjects().indexOf(p),
        naturalW: p._element?.naturalWidth || p._element?.width,
        naturalH: p._element?.naturalHeight || p._element?.height,
        boundingRect: (() => { const r = p.getBoundingRect(); return { l: +r.left.toFixed(1), t: +r.top.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; })(),
        bitmapCenter
      };
    }),
    // live canvas pixels at a known glyph location (image px 110,120 = inside line1 text)
    glyphPixelWithPatches: (() => {
      const gx = Math.round((left + 110 * scale) * ratio);
      const gy = Math.round((top + 120 * scale) * ratio);
      return [...ctx2.getImageData(gx, gy, 1, 1).data];
    })(),
    consoleErrors: window.__logs || [],
    // darkRatio ≈ 0 means the source glyphs are fully covered
    screenCoverage,
    exportCoverage
  };
}

function App() {
  const canvasRef = useRef(null);
  useEffect(() => { window.__ocrCanvasRef = canvasRef; }, []);
  useEffect(() => {
    (async () => {
      await new Promise(r => setTimeout(r, 400));
      const blob = await makeTestImageBlob();
      const file = new File([blob], 'test.png', { type: 'image/png' });
      const input = document.querySelector('input[type="file"]');
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })();
  }, []);

  return (
    <div style={{ width: W + 'px', height: H + 'px', position: 'relative' }}>
      <OcrCanvas
        ref={canvasRef}
        onRegionSelect={() => {}}
        onLayersUpdate={() => {}}
        onImageLoaded={() => {}}
        onOcrProcessing={(busy) => {
          if (busy) window.__sawBusy = true;
          else if (window.__sawBusy) window.__ocrDone = true;
        }}
        onWorkerStatusChange={() => {}}
        onHistoryStatusChange={() => {}}
        ocrEngine="custom"
        localServerUrl={OCR_URL}
      />
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);

const iv = setInterval(async () => {
  if (window.__ocrDone && !window.__measuring) {
    window.__measuring = true;
    clearInterval(iv);
    // let the final renderAll settle
    await new Promise(r => setTimeout(r, 300));
    try {
      const result = await measure();
      window.__ocrCanvasRef?.current?.clearCanvas();
      await new Promise(r => setTimeout(r, 100));
      result.closeImage = {
        objectCount: window.__fabricCanvas?.getObjects()?.length,
        backgroundCleared: !window.__fabricCanvas?.backgroundImage
      };
      resultsEl().textContent = 'E2E_RESULTS ' + JSON.stringify(result, null, 1);
    } catch (e) {
      resultsEl().textContent = 'E2E_ERROR ' + (e.stack || e.message);
    }
  }
}, 200);

setTimeout(() => {
  if (!window.__ocrDone) {
    resultsEl().textContent = 'E2E_TIMEOUT sawBusy=' + !!window.__sawBusy;
  }
}, 20000);
