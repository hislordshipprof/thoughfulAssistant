import { desktopCapturer, screen } from 'electron';

export interface CapturedScreen {
  imageDataUrl: string;
  ocrDataUrl: string;
  width: number;
  height: number;
  timestamp: number;
}

// Reference to native addon — set by setNativeAddon()
let nativeAddon: any = null;

/** Called once at startup to provide the native addon reference */
export function setNativeAddon(addon: any): void {
  nativeAddon = addon;
  if (addon?.captureScreenNative) {
    console.log('[capture] Native screenshot (BitBlt) available');
  }
}

/**
 * Fast native screenshot using Win32 BitBlt + GDI+ JPEG encoding.
 * Falls back to Electron's desktopCapturer if native addon isn't available.
 */
export async function captureScreen(sourceId?: string, onBeforeCapture?: () => void, onAfterCapture?: () => void): Promise<CapturedScreen> {
  onBeforeCapture?.();

  // Try native capture first (much faster — ~30-80ms vs ~2500ms)
  if (nativeAddon?.captureScreenNative && !sourceId) {
    try {
      const t0 = performance.now();
      const result = nativeAddon.captureScreenNative();
      const t1 = performance.now();

      console.log(`[capture-timing] NATIVE BitBlt: ${result.msBitBlt.toFixed(0)}ms, encode: ${result.msEncode.toFixed(0)}ms, base64: ${result.msBase64.toFixed(0)}ms, total: ${result.msTotal.toFixed(0)}ms (${(result.jpegSize / 1024).toFixed(0)} KB) [JS wall: ${(t1 - t0).toFixed(0)}ms]`);

      onAfterCapture?.();
      return {
        imageDataUrl: result.dataUrl,
        ocrDataUrl: result.dataUrl,
        width: result.width,
        height: result.height,
        timestamp: Date.now()
      };
    } catch (err) {
      console.warn('[capture] Native screenshot failed, falling back to desktopCapturer:', err);
    }
  }

  // Fallback: Electron's desktopCapturer (slow ~2-3 seconds)
  const t0 = performance.now();
  const display = screen.getPrimaryDisplay();

  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: {
      width: display.workAreaSize.width,
      height: display.workAreaSize.height
    }
  });
  const t1 = performance.now();
  console.log(`[capture-timing] desktopCapturer.getSources (fallback): ${(t1 - t0).toFixed(0)}ms`);

  let source = sources[0];
  if (sourceId) {
    const found = sources.find(s => s.id === sourceId);
    if (found) source = found;
  }

  if (!source) {
    onAfterCapture?.();
    throw new Error('No screen source available');
  }

  const thumbnail = source.thumbnail;
  const size = thumbnail.getSize();

  const imageDataUrl = `data:image/jpeg;base64,${thumbnail.toJPEG(85).toString('base64')}`;
  const t2 = performance.now();
  console.log(`[capture-timing] TOTAL (fallback): ${(t2 - t0).toFixed(0)}ms (${(imageDataUrl.length / 1024).toFixed(0)} KB)`);

  onAfterCapture?.();

  return {
    imageDataUrl,
    ocrDataUrl: imageDataUrl,
    width: size.width,
    height: size.height,
    timestamp: Date.now()
  };
}

export async function listSources(): Promise<Array<{ id: string; name: string; type: string }>> {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 150, height: 150 }
  });

  return sources.map(s => ({
    id: s.id,
    name: s.name,
    type: s.id.startsWith('screen:') ? 'screen' : 'window'
  }));
}
