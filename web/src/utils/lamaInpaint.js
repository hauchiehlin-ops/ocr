const MODEL_SIZE = 512;
const MODEL_URL = import.meta.env.VITE_LAMA_MODEL_URL ||
  'https://huggingface.co/Carve/LaMa-ONNX/resolve/c3c0c9e468934d62e79c329e35d82dd09ff8c444/lama_fp32.onnx';
const LOCAL_WASM_BASE_URL = `${(import.meta.env.BASE_URL || '/').replace(/\/?$/, '/')}ort/`;
const WASM_BASE_URL = import.meta.env.VITE_ORT_WASM_BASE_URL ||
  LOCAL_WASM_BASE_URL;
const MODEL_CACHE = 'ocr-ai-models-v1';
const MODEL_SHA256 = '1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6';
const DEFAULT_TIMEOUT = 120000;
let sessionPromise;
let activeController;
let runtimePromise;

async function getRuntime() {
  if (!runtimePromise) runtimePromise = import('onnxruntime-web').then(ort => {
    ort.env.wasm.wasmPaths = WASM_BASE_URL.endsWith('/') ? WASM_BASE_URL : `${WASM_BASE_URL}/`;
    return ort;
  });
  return runtimePromise;
}

function emit(callback, state) {
  callback?.({ provider: 'lama', ...state });
}

function combineSignals(controller, externalSignal) {
  if (!externalSignal) return;
  if (externalSignal.aborted) controller.abort(externalSignal.reason);
  else externalSignal.addEventListener('abort', () => controller.abort(externalSignal.reason), { once: true });
}

async function getCachedModel() {
  if (!('caches' in globalThis)) return null;
  return (await caches.open(MODEL_CACHE)).match(MODEL_URL);
}

export async function hasCachedLamaModel() {
  return Boolean(await getCachedModel());
}

export async function preloadLamaModel(options = {}) {
  await requestPersistentStorage();
  await fetchModel(options);
  emit(options?.onStatus, { phase: 'stored', progress: 1, message: 'AI 修補模型已下載、驗證並儲存；使用時才會載入推論引擎' });
  return true;
}

async function verifyBytes(bytes, expectedSha256, label) {
  if (!crypto?.subtle) return;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const actual = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  if (actual !== expectedSha256) throw new Error(`${label}校驗失敗，已拒絕載入可能損壞的檔案`);
}

async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return false;
  try { return await navigator.storage.persist(); } catch { return false; }
}

async function fetchModel({ signal, onStatus, timeoutMs = DEFAULT_TIMEOUT } = {}) {
  const cached = await getCachedModel();
  if (cached) {
    emit(onStatus, { phase: 'cache-hit', progress: 1, message: '使用已快取的 AI 修補模型' });
    const bytes = new Uint8Array(await cached.arrayBuffer());
    await verifyBytes(bytes, MODEL_SHA256, 'AI 模型');
    return bytes;
  }

  const controller = new AbortController();
  activeController = controller;
  combineSignals(controller, signal);
  const timer = setTimeout(() => controller.abort(new DOMException('模型下載逾時', 'TimeoutError')), timeoutMs);
  try {
    const response = await fetch(MODEL_URL, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`模型下載失敗：HTTP ${response.status}`);
    const total = Number(response.headers.get('content-length')) || 0;
    const reader = response.body?.getReader();
    if (!reader) return new Uint8Array(await response.arrayBuffer());
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      emit(onStatus, {
        phase: 'downloading',
        progress: total ? received / total : null,
        received,
        total,
        message: total
          ? `下載 AI 修補模型 ${Math.round(received / total * 100)}%`
          : `下載 AI 修補模型 ${(received / 1024 / 1024).toFixed(1)} MB`
      });
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    emit(onStatus, { phase: 'verifying', progress: 1, message: '驗證 AI 模型完整性…' });
    await verifyBytes(bytes, MODEL_SHA256, 'AI 模型');
    if ('caches' in globalThis) {
      const headers = new Headers(response.headers);
      headers.set('X-Model-SHA256', MODEL_SHA256);
      await (await caches.open(MODEL_CACHE)).put(MODEL_URL, new Response(bytes, { headers }));
      await requestPersistentStorage();
    }
    return bytes;
  } finally {
    clearTimeout(timer);
    if (activeController === controller) activeController = null;
  }
}

async function createSession(options) {
  await requestPersistentStorage();
  const [ort, bytes] = await Promise.all([getRuntime(), fetchModel(options)]);
  emit(options?.onStatus, { phase: 'loading', progress: 1, message: '載入 AI 修補引擎…' });
  return ort.InferenceSession.create(bytes, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all'
  });
}

async function getSession(options) {
  if (!sessionPromise) sessionPromise = createSession(options).catch(error => {
    sessionPromise = undefined;
    throw error;
  });
  return sessionPromise;
}

async function disposeSession(session) {
  sessionPromise = undefined;
  try { await session?.release?.(); } catch (error) { console.warn('Unable to release AI inference session.', error); }
}

export function cancelLamaOperation() {
  activeController?.abort(new DOMException('使用者取消模型下載', 'AbortError'));
}

export async function clearLamaModelCache() {
  sessionPromise = undefined;
  if ('caches' in globalThis) await caches.delete(MODEL_CACHE);
}

export function shouldConfirmLargeDownload() {
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || Boolean(connection?.saveData) ||
    ['slow-2g', '2g', '3g'].includes(connection?.effectiveType);
}

export async function inpaintWithLama(source, mask, width, height, options = {}) {
  if (!source?.length || !mask?.length || width < 2 || height < 2) return null;
  const [ort, session] = await Promise.all([getRuntime(), getSession(options)]);
  emit(options.onStatus, { phase: 'inference', progress: null, message: 'AI 正在重建背景…' });
  const scale = Math.min(MODEL_SIZE / width, MODEL_SIZE / height);
  const scaledWidth = Math.max(1, Math.round(width * scale));
  const scaledHeight = Math.max(1, Math.round(height * scale));
  const offsetX = Math.floor((MODEL_SIZE - scaledWidth) / 2);
  const offsetY = Math.floor((MODEL_SIZE - scaledHeight) / 2);
  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = width; sourceCanvas.height = height;
  const sourceContext = sourceCanvas.getContext('2d');
  const sourceData = sourceContext.createImageData(width, height);
  sourceData.data.set(source); sourceContext.putImageData(sourceData, 0, 0);
  const inputCanvas = document.createElement('canvas');
  inputCanvas.width = MODEL_SIZE; inputCanvas.height = MODEL_SIZE;
  const inputContext = inputCanvas.getContext('2d', { willReadFrequently: true });
  inputContext.fillStyle = '#000'; inputContext.fillRect(0, 0, MODEL_SIZE, MODEL_SIZE);
  inputContext.drawImage(sourceCanvas, offsetX, offsetY, scaledWidth, scaledHeight);
  const resized = inputContext.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE).data;
  const plane = MODEL_SIZE * MODEL_SIZE;
  const imageTensor = new Float32Array(3 * plane);
  const maskTensor = new Float32Array(plane);
  for (let y = 0; y < MODEL_SIZE; y++) for (let x = 0; x < MODEL_SIZE; x++) {
    const p = y * MODEL_SIZE + x, rgba = p * 4;
    imageTensor[p] = resized[rgba] / 255; imageTensor[plane + p] = resized[rgba + 1] / 255; imageTensor[2 * plane + p] = resized[rgba + 2] / 255;
    if (x >= offsetX && x < offsetX + scaledWidth && y >= offsetY && y < offsetY + scaledHeight) {
      const sx = Math.min(width - 1, Math.floor((x - offsetX) / scale));
      const sy = Math.min(height - 1, Math.floor((y - offsetY) / scale));
      maskTensor[p] = mask[sy * width + sx] ? 1 : 0;
    }
  }
  const feeds = {
    [session.inputNames.find(name => /image/i.test(name)) || session.inputNames[0]]: new ort.Tensor('float32', imageTensor, [1, 3, MODEL_SIZE, MODEL_SIZE]),
    [session.inputNames.find(name => /mask/i.test(name)) || session.inputNames[1]]: new ort.Tensor('float32', maskTensor, [1, 1, MODEL_SIZE, MODEL_SIZE])
  };
  let results;
  try {
    results = await session.run(feeds);
  } catch (error) {
    await disposeSession(session);
    throw error;
  }
  const tensor = results[session.outputNames[0]];
  if (!tensor?.data) {
    await disposeSession(session);
    return null;
  }
  const outputCanvas = document.createElement('canvas'); outputCanvas.width = MODEL_SIZE; outputCanvas.height = MODEL_SIZE;
  const outputContext = outputCanvas.getContext('2d'); const outputData = outputContext.createImageData(MODEL_SIZE, MODEL_SIZE);
  let max = 0; for (let i = 0; i < tensor.data.length; i += 384) max = Math.max(max, Math.abs(tensor.data[i]));
  const multiplier = max <= 2 ? 255 : 1;
  for (let p = 0; p < plane; p++) {
    outputData.data[p * 4] = Math.max(0, Math.min(255, Math.round(tensor.data[p] * multiplier)));
    outputData.data[p * 4 + 1] = Math.max(0, Math.min(255, Math.round(tensor.data[plane + p] * multiplier)));
    outputData.data[p * 4 + 2] = Math.max(0, Math.min(255, Math.round(tensor.data[2 * plane + p] * multiplier)));
    outputData.data[p * 4 + 3] = 255;
  }
  outputContext.putImageData(outputData, 0, 0);
  const restored = document.createElement('canvas'); restored.width = width; restored.height = height;
  const restoredContext = restored.getContext('2d', { willReadFrequently: true });
  restoredContext.drawImage(outputCanvas, offsetX, offsetY, scaledWidth, scaledHeight, 0, 0, width, height);
  emit(options.onStatus, { phase: 'complete', progress: 1, message: 'AI 背景修補完成' });
  const restoredData = restoredContext.getImageData(0, 0, width, height).data;
  await disposeSession(session);
  return restoredData;
}
