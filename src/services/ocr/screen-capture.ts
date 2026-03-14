import { desktopCapturer, screen, nativeImage } from 'electron';

export interface CapturedScreen {
  imageDataUrl: string;
  ocrDataUrl: string;
  width: number;
  height: number;
  timestamp: number;
}

// OCR target width — 960px is plenty for text recognition and 4x faster than 1920px
const OCR_WIDTH = 960;

export async function captureScreen(sourceId?: string, onBeforeCapture?: () => void, onAfterCapture?: () => void): Promise<CapturedScreen> {
  onBeforeCapture?.();
  const display = screen.getPrimaryDisplay();
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: {
      width: display.workAreaSize.width,
      height: display.workAreaSize.height
    }
  });

  let source = sources[0]; // Default to primary screen
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

  // Full-res JPEG for display (smaller than PNG)
  const imageDataUrl = `data:image/jpeg;base64,${thumbnail.toJPEG(85).toString('base64')}`;

  // Scaled-down version for OCR (much faster processing)
  const scaleFactor = OCR_WIDTH / size.width;
  const ocrHeight = Math.round(size.height * scaleFactor);
  const ocrImage = thumbnail.resize({ width: OCR_WIDTH, height: ocrHeight });
  const ocrDataUrl = `data:image/jpeg;base64,${ocrImage.toJPEG(90).toString('base64')}`;

  onAfterCapture?.();

  return {
    imageDataUrl,
    ocrDataUrl,
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
