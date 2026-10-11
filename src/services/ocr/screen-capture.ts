import { BrowserWindow, desktopCapturer, nativeImage, screen } from 'electron';

export interface CapturedScreen {
  imageDataUrl: string;
  ocrDataUrl: string;
  width: number;
  height: number;
  timestamp: number;
}

/** Per-provider vision-input profile. Each entry is the optimal target the
 *  provider will not downscale further server-side (so we save TTFT) without
 *  costing model quality. Verified against 2026 docs:
 *    Anthropic: 1568px is their officially-recommended sweet spot. Larger
 *      images get downscaled server-side for free latency cost.
 *      https://docs.claude.com/en/docs/build-with-claude/vision
 *    OpenAI: vision uses 512px tiles in "high" detail mode. 1280px = ~6 tiles
 *      and preserves enough detail for dense MCQ pages with small option text
 *      and small symbols (pattern recognition). 1024px caused mis-reads on
 *      assessment pages with 5-option MCQ — bumped to 1280 for a modest cost
 *      increase (~6 tiles vs ~3) in exchange for materially better accuracy.
 *      https://developers.openai.com/api/docs/guides/images-vision
 *    Groq Llama 4 Scout: Meta's explicit recommendation is ≤1024px to avoid
 *      inflating the ViT encoder visual-token count. */
const VISION_PROFILES: Record<string, { maxDim: number; quality: number }> = {
  anthropic: { maxDim: 1568, quality: 82 },
  openai:    { maxDim: 1280, quality: 85 },
  groq:      { maxDim: 1024, quality: 82 },
};
const DEFAULT_VISION_PROFILE = VISION_PROFILES.anthropic;

/** Downscale + recompress for the AI vision payload, targeted at the provider
 *  about to receive it. Keeps the original full-res JPEG for the OCR pipeline.
 *  Adds ~30-80ms in JS, saves ~500-1500ms TTFT on the API side depending on
 *  provider. Falls back to the original on any error. */
export function compactForVision(originalDataUrl: string, provider?: string): string {
  const profile = (provider && VISION_PROFILES[provider]) || DEFAULT_VISION_PROFILE;
  try {
    const img = nativeImage.createFromDataURL(originalDataUrl);
    const { width, height } = img.getSize();
    const longer = Math.max(width, height);
    if (longer <= profile.maxDim) {
      // Already within target — just recompress at the profile's quality
      return `data:image/jpeg;base64,${img.toJPEG(profile.quality).toString('base64')}`;
    }
    const scale = profile.maxDim / longer;
    const resized = img.resize({
      width: Math.round(width * scale),
      height: Math.round(height * scale),
      quality: 'best',  // bicubic — preserves text edges better than 'good' (bilinear)
    });
    return `data:image/jpeg;base64,${resized.toJPEG(profile.quality).toString('base64')}`;
  } catch (err) {
    console.warn(`[capture] vision downscale failed for provider=${provider}, sending original:`, err);
    return originalDataUrl;
  }
}

// Reference to native addon — set by setNativeAddon()
let nativeAddon: any = null;
// Reference to main window — used to determine which monitor to capture
let mainWindow: BrowserWindow | null = null;

/** Called once at startup to provide the native addon reference */
export function setNativeAddon(addon: any): void {
  nativeAddon = addon;
  if (addon?.captureScreenNative) {
    console.log('[capture] Native screenshot (BitBlt) available');
  }
}

/** Called once at startup to provide the main window reference for multi-monitor capture */
export function setMainWindow(win: BrowserWindow): void {
  mainWindow = win;
  console.log('[capture] Main window reference set for multi-monitor capture');
}

/**
 * Fast native screenshot using Win32 BitBlt + GDI+ JPEG encoding.
 * Falls back to Electron's desktopCapturer if native addon isn't available.
 */
export async function captureScreen(
  sourceId?: string,
  onBeforeCapture?: () => void,
  onAfterCapture?: () => void,
  provider?: string,
): Promise<CapturedScreen> {
  onBeforeCapture?.();

  // Try native capture first (much faster — ~30-80ms vs ~2500ms)
  if (nativeAddon?.captureScreenNative && !sourceId) {
    try {
      const t0 = performance.now();
      // Pass window handle so native code captures the monitor the overlay is on
      const hwndBuf = mainWindow?.getNativeWindowHandle();
      const result = hwndBuf
        ? nativeAddon.captureScreenNative(hwndBuf)
        : nativeAddon.captureScreenNative();
      const t1 = performance.now();

      console.log(`[capture-timing] NATIVE BitBlt: ${result.msBitBlt.toFixed(0)}ms, encode: ${result.msEncode.toFixed(0)}ms, base64: ${result.msBase64.toFixed(0)}ms, total: ${result.msTotal.toFixed(0)}ms (${(result.jpegSize / 1024).toFixed(0)} KB) [JS wall: ${(t1 - t0).toFixed(0)}ms]`);

      // Per-provider downscale for vision API; full-res kept for OCR pipeline
      const t2 = performance.now();
      const visionDataUrl = compactForVision(result.dataUrl, provider);
      const t3 = performance.now();
      console.log(`[capture-timing] vision downscale (provider=${provider ?? 'default'}): ${(t3 - t2).toFixed(0)}ms (${(result.dataUrl.length / 1024).toFixed(0)}KB → ${(visionDataUrl.length / 1024).toFixed(0)}KB)`);

      onAfterCapture?.();
      return {
        imageDataUrl: visionDataUrl,    // optimised for the active vision model
        ocrDataUrl: result.dataUrl,     // full-res for OCR (Tesseract benefits from higher DPI)
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

  // Find the display the overlay window is currently on
  let display;
  if (mainWindow && !mainWindow.isDestroyed()) {
    const bounds = mainWindow.getBounds();
    const centerX = bounds.x + Math.round(bounds.width / 2);
    const centerY = bounds.y + Math.round(bounds.height / 2);
    display = screen.getDisplayNearestPoint({ x: centerX, y: centerY });
  } else {
    display = screen.getPrimaryDisplay();
  }

  let sources;
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: {
        width: display.size.width,
        height: display.size.height
      }
    });
  } catch (err) {
    onAfterCapture?.();
    throw err;
  }
  const t1 = performance.now();
  console.log(`[capture-timing] desktopCapturer.getSources (fallback): ${(t1 - t0).toFixed(0)}ms`);

  let source = sources[0];
  if (sourceId) {
    const found = sources.find(s => s.id === sourceId);
    if (found) source = found;
  } else {
    // Match source to the display the overlay is on
    const displayMatch = sources.find(s => s.display_id === String(display.id));
    if (displayMatch) source = displayMatch;
  }

  if (!source) {
    onAfterCapture?.();
    throw new Error('No screen source available');
  }

  const thumbnail = source.thumbnail;
  const size = thumbnail.getSize();

  const fullResDataUrl = `data:image/jpeg;base64,${thumbnail.toJPEG(85).toString('base64')}`;
  const visionDataUrl = compactForVision(fullResDataUrl, provider);
  const t2 = performance.now();
  console.log(`[capture-timing] TOTAL (fallback, provider=${provider ?? 'default'}): ${(t2 - t0).toFixed(0)}ms (${(fullResDataUrl.length / 1024).toFixed(0)}KB → ${(visionDataUrl.length / 1024).toFixed(0)}KB)`);

  onAfterCapture?.();

  return {
    imageDataUrl: visionDataUrl,    // optimised for the active vision model
    ocrDataUrl: fullResDataUrl,     // full-res for OCR
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
