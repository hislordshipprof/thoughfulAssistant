import { BrowserWindow, screen } from 'electron';
import path from 'path';

let nativeAddon: any;
try {
  nativeAddon = require('../../build/Release/native_addon.node');
} catch {
  try {
    nativeAddon = require(path.join(process.resourcesPath, 'native', 'native_addon.node'));
  } catch {
    console.warn('Native addon not available — stealth features disabled');
    nativeAddon = null;
  }
}

export class WindowManager {
  private mainWindow: BrowserWindow | null = null;
  private isStealthActive = false;
  private isFullPassthrough = false;
  private isVisible = true;

  createOverlayWindow(config: {
    width: number;
    height: number;
    x: number;
    y: number;
    opacity: number;
  }): BrowserWindow {
    const display = screen.getPrimaryDisplay();
    const { width: screenW, height: screenH } = display.workAreaSize;

    this.mainWindow = new BrowserWindow({
      width: Math.min(config.width, screenW),
      height: Math.min(config.height, screenH),
      x: config.x,
      y: config.y,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: true,
      hasShadow: false,
      opacity: config.opacity,
      focusable: false,
      webPreferences: {
        preload: path.join(__dirname, '../preload/preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });

    // Set always on top with highest level
    this.mainWindow.setAlwaysOnTop(true, 'screen-saver');
    this.mainWindow.setVisibleOnAllWorkspaces(true);

    // Apply stealth mode via native addon
    this.applyStealthMode();

    // Subclass window so clicks on overlay never steal focus from other apps
    this.subclassForNoActivate();

    // Start in smart hit-test mode: preload toggles setIgnoreMouseEvents
    // dynamically based on whether mouse is over a UI element or transparent area
    this.mainWindow.setIgnoreMouseEvents(true, { forward: true });

    // Reapply display affinity safely on restore (uses safeShow path)
    this.mainWindow.on('restore', () => {
      this.stealthShow();
    });

    this.mainWindow.on('closed', () => {
      this.mainWindow = null;
    });

    return this.mainWindow;
  }

  applyStealthMode(): void {
    if (!this.mainWindow || !nativeAddon) return;

    const hwnd = this.mainWindow.getNativeWindowHandle();
    nativeAddon.applyStealthMode(hwnd);
    this.isStealthActive = true;
  }

  private subclassForNoActivate(): void {
    if (!this.mainWindow || !nativeAddon) return;

    const hwnd = this.mainWindow.getNativeWindowHandle();
    const ok = nativeAddon.subclassForNoActivate(hwnd);
    console.log(`[window] Subclass for no-activate: ${ok ? 'OK' : 'FAILED'}`);
  }

  removeStealthMode(): void {
    if (!this.mainWindow || !nativeAddon) return;

    const hwnd = this.mainWindow.getNativeWindowHandle();
    nativeAddon.removeStealthMode(hwnd);
    this.isStealthActive = false;
  }

  reapplyDisplayAffinity(): void {
    if (!this.mainWindow || !nativeAddon) return;

    const hwnd = this.mainWindow.getNativeWindowHandle();
    nativeAddon.reapplyDisplayAffinity(hwnd);
  }

  /**
   * Toggle full-passthrough mode.
   * When enabled: ALL clicks pass through (even over UI elements).
   * When disabled: smart hit-test in preload controls per-pixel click-through.
   */
  setFullPassthrough(enable: boolean): void {
    if (!this.mainWindow) return;

    if (nativeAddon) {
      const hwnd = this.mainWindow.getNativeWindowHandle();
      nativeAddon.setClickThrough(hwnd, enable);
    }

    if (enable) {
      this.mainWindow.setIgnoreMouseEvents(true, { forward: true });
    }
    // When disabling, the preload smart hit-test resumes toggling dynamically

    this.isFullPassthrough = enable;
    console.log(`[window] Full passthrough: ${enable}`);
  }

  /**
   * Called by preload's smart hit-test (via IPC) to dynamically toggle
   * click-through based on whether the mouse is over a UI element.
   */
  handleSmartHitTest(ignore: boolean, options?: { forward: boolean }): void {
    if (!this.mainWindow || this.isFullPassthrough) return;

    if (ignore) {
      this.mainWindow.setIgnoreMouseEvents(true, options || { forward: true });
    } else {
      this.mainWindow.setIgnoreMouseEvents(false);
    }
  }

  /** Temporarily enable focus for typing (settings modal). Call with false when done. */
  setFocusableForInput(enable: boolean): void {
    if (!this.mainWindow) return;
    this.mainWindow.setFocusable(enable);
    if (enable) {
      this.mainWindow.focus();
    }
    console.log(`[window] Focusable for input: ${enable}`);
  }

  /**
   * Show the window without flashing on screen share.
   * Sets opacity to 0 before showing so the window is invisible while
   * display affinity (WDA_EXCLUDEFROMCAPTURE) is reapplied, then restores opacity.
   */
  stealthShow(): void {
    if (!this.mainWindow) return;

    const savedOpacity = this.mainWindow.getOpacity();
    this.mainWindow.setOpacity(0);
    this.mainWindow.show();
    this.reapplyDisplayAffinity();
    this.mainWindow.setOpacity(savedOpacity);
  }

  toggleVisibility(): void {
    if (!this.mainWindow) return;

    if (this.isVisible) {
      this.mainWindow.hide();
    } else {
      this.stealthShow();
    }
    this.isVisible = !this.isVisible;
  }

  toggleInteractMode(): void {
    this.setFullPassthrough(!this.isFullPassthrough);
  }

  isFullPassthroughEnabled(): boolean {
    return this.isFullPassthrough;
  }

  setOpacity(opacity: number): void {
    this.mainWindow?.setOpacity(Math.max(0.1, Math.min(1, opacity)));
  }

  setPosition(x: number, y: number): void {
    this.mainWindow?.setPosition(x, y);
  }

  moveBy(dx: number, dy: number): void {
    if (!this.mainWindow) return;
    const [x, y] = this.mainWindow.getPosition();
    this.mainWindow.setPosition(x + dx, y + dy);
  }

  setSize(width: number, height: number): void {
    this.mainWindow?.setSize(width, height);
  }

  getWindow(): BrowserWindow | null {
    return this.mainWindow;
  }

  isStealthEnabled(): boolean {
    return this.isStealthActive;
  }

  getNativeAddon(): any {
    return nativeAddon;
  }
}
