import { Capacitor, registerPlugin } from '@capacitor/core';

const NativeOcr = registerPlugin('NativeOcr');

export function getNativeOcrPlatform() {
  return Capacitor.getPlatform?.() || 'web';
}

export function isNativeOcrAvailable() {
  return Boolean(
    Capacitor.isNativePlatform?.() &&
    Capacitor.isPluginAvailable?.('NativeOcr')
  );
}

export function getNativeOcrEngineLabel() {
  const platform = getNativeOcrPlatform();
  if (platform === 'ios') return 'iOS Apple Vision';
  if (platform === 'android') return 'Android ML Kit';
  return 'Browser fallback';
}

function normalizeNativeResults(payload) {
  const rawItems = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.results)
      ? payload.results
      : [];

  return rawItems.flatMap((item) => {
    const bbox = Array.isArray(item?.bbox) ? item.bbox.map(Number) : null;
    if (!item?.text?.trim() || !bbox || bbox.length !== 4 || bbox.some(value => !Number.isFinite(value))) {
      return [];
    }
    const [ymin, xmin, ymax, xmax] = bbox;
    if (xmax <= xmin || ymax <= ymin) return [];
    return [{
      text: item.text.trim(),
      bbox: [ymin, xmin, ymax, xmax],
      confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : 0,
      source: item.source || getNativeOcrPlatform()
    }];
  });
}

export async function runNativeOcr(imageDataUrl) {
  if (!isNativeOcrAvailable()) {
    throw new Error('Native OCR is only available inside the packaged iOS/Android app.');
  }

  const payload = await NativeOcr.recognize({ image: imageDataUrl });
  return normalizeNativeResults(payload);
}
