// Embedded menu-bar / tray icon so it survives packaging (buildResources
// assets/ aren't copied into the app bundle). The 1x/2x PNGs are template
// images — fully black + alpha — so macOS recolors them for light/dark
// menu bars automatically.
import { nativeImage } from 'electron';

const TRAY_1X = 'iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAYAAADEtGw7AAAAbElEQVR4nM2UQQ4AEAwE8f8/c5IIpTuJhr1IGmZXNVL6RFXdWKISEHCd1mtgJBUs95aCsRSwlda9QVjivKmTnpqMXsSP45nMbtcMdq2gJgvnBPYMjmefzrGVzL3p879ilPIucYmJ0Ix/kRipAbtiDBz13I2uAAAAAElFTkSuQmCC';
const TRAY_2X = 'iVBORw0KGgoAAAANSUhEUgAAACwAAAAsCAYAAAAehFoBAAAAvUlEQVR4nO2WzQ6AMAiD0fd/53kyMYth6Focwnfxsp9SCypSFG40xqE741AmLMGte8Ioh9kwBFOa7cTDYWgB6SNBjYOIn8OwQpCC6e6KVIb5oARb4gCJTDiHt4m9s469uvvJJuYUMOsYLXQZVReGwvsF3gI1bsVrFS0p3pqdZaLxtFM/b7xfjzUNq/jp+8J96VCCLc5B3mZah93wEoxqbqhgmCgND4ehhaTPMD0WbIfhBaSPRFhov6HlcBGdA7gEFDwgkW6pAAAAAElFTkSuQmCC';

export function createTrayIcon(): Electron.NativeImage {
  try {
    const img = nativeImage.createFromDataURL('data:image/png;base64,' + TRAY_1X);
    const hi = nativeImage.createFromDataURL('data:image/png;base64,' + TRAY_2X);
    // Attach the @2x representation for Retina menu bars.
    img.addRepresentation({ scaleFactor: 2, dataURL: 'data:image/png;base64,' + TRAY_2X });
    if (img.isEmpty() && !hi.isEmpty()) return hi;
    // macOS: mark as template so the OS tints it for the menu bar.
    if (process.platform === 'darwin') {
      img.setTemplateImage(true);
    }
    return img;
  } catch {
    return nativeImage.createEmpty();
  }
}
