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

const MIN_OPACITY = 0.1;
const MAX_OPACITY = 1;
const EMERGENCY_HIDE_OPACITY = 0.01;
const EMERGENCY_HIDE_DURATION_MS = 2000;

export class WindowManager {
  private mainWindow: BrowserWindow | null = null;
  private isStealthActive = false;
  private isFullPassthrough = false;
  private isVisible = true;
  private emergencyHideTimer: NodeJS.Timeout | null = null;
  private savedOpacityBeforeHide = 0;
  /** Track intended size to prevent Electron's DPI rounding from compounding (+1px per setBounds call) */
  private intendedSize: { width: number; height: number } = { width: 800, height: 600 };

  createOverlayWindow(config: {
    width: number;
    height: number;
    x: number;
    y: number;
    opacity: number;
  }): BrowserWindow {
    const display = screen.getPrimaryDisplay();
    const { width: screenW, height: screenH } = display.workAreaSize;

    this.intendedSize = {
      width: Math.min(config.width, screenW),
      height: Math.min(config.height, screenH)
    };

    this.mainWindow = new BrowserWindow({
      width: this.intendedSize.width,
      height: this.intendedSize.height,
      x: config.x,
      y: config.y,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
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
      if (this.emergencyHideTimer) {
        clearTimeout(this.emergencyHideTimer);
        this.emergencyHideTimer = null;
      }
      this.mainWindow = null;
    });

    return this.mainWindow;
  }

  applyStealthMode(): void {
    if (!this.mainWindow || !nativeAddon) return;

    try {
      const hwnd = this.mainWindow.getNativeWindowHandle();
      nativeAddon.applyStealthMode(hwnd);
      this.isStealthActive = true;
    } catch (err) {
      console.error('[window] applyStealthMode failed:', err);
    }
  }

  private subclassForNoActivate(): void {
    if (!this.mainWindow || !nativeAddon) return;

    try {
      const hwnd = this.mainWindow.getNativeWindowHandle();
      const ok = nativeAddon.subclassForNoActivate(hwnd);
      console.log(`[window] Subclass for no-activate: ${ok ? 'OK' : 'FAILED'}`);
    } catch (err) {
      console.error('[window] subclassForNoActivate failed:', err);
    }
  }

  removeStealthMode(): void {
    if (!this.mainWindow || !nativeAddon) return;

    try {
      const hwnd = this.mainWindow.getNativeWindowHandle();
      nativeAddon.removeStealthMode(hwnd);
      this.isStealthActive = false;
    } catch (err) {
      console.error('[window] removeStealthMode failed:', err);
    }
  }

  reapplyDisplayAffinity(): void {
    if (!this.mainWindow || !nativeAddon) return;

    try {
      const hwnd = this.mainWindow.getNativeWindowHandle();
      nativeAddon.reapplyDisplayAffinity(hwnd);
    } catch (err) {
      console.error('[window] reapplyDisplayAffinity failed:', err);
    }
  }

  /**
   * Toggle full-passthrough mode.
   * When enabled: ALL clicks pass through (even over UI elements).
   * When disabled: smart hit-test in preload controls per-pixel click-through.
   */
  setFullPassthrough(enable: boolean): void {
    if (!this.mainWindow) return;

    if (nativeAddon) {
      try {
        const hwnd = this.mainWindow.getNativeWindowHandle();
        nativeAddon.setClickThrough(hwnd, enable);
      } catch (err) {
        console.error('[window] setClickThrough failed:', err);
      }
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

    // If emergency hide is active, cancel it and use saved opacity
    if (this.emergencyHideTimer) {
      clearTimeout(this.emergencyHideTimer);
      this.emergencyHideTimer = null;
    }

    const currentOpacity = this.mainWindow.getOpacity();
    // If opacity is near-zero (emergency hide), restore from saved value
    const restoreOpacity = currentOpacity <= 0.02
      ? (this.savedOpacityBeforeHide || 0.85)
      : currentOpacity;

    this.mainWindow.setOpacity(0);
    this.mainWindow.show();
    this.reapplyDisplayAffinity();
    this.mainWindow.setOpacity(restoreOpacity);
  }

  /**
   * Emergency hide — drop opacity to near-zero for 2 seconds, then auto-restore.
   * Pressing again while hidden cancels the timer and restores immediately.
   */
  emergencyHide(): void {
    if (!this.mainWindow) return;

    if (this.emergencyHideTimer) {
      // Already hidden — restore immediately
      clearTimeout(this.emergencyHideTimer);
      this.emergencyHideTimer = null;
      this.mainWindow.setOpacity(this.savedOpacityBeforeHide);
      console.log('[window] Emergency hide cancelled — restored');
      return;
    }

    this.savedOpacityBeforeHide = this.mainWindow.getOpacity();
    this.mainWindow.setOpacity(EMERGENCY_HIDE_OPACITY);
    console.log('[window] Emergency hide — opacity set to near-zero');

    this.emergencyHideTimer = setTimeout(() => {
      this.emergencyHideTimer = null;
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.setOpacity(this.savedOpacityBeforeHide);
        console.log('[window] Emergency hide expired — restored');
      }
    }, EMERGENCY_HIDE_DURATION_MS);
  }

  toggleVisibility(): void {
    if (!this.mainWindow) return;

    if (this.mainWindow.isVisible() && this.mainWindow.getOpacity() > 0.02) {
      this.mainWindow.hide();
    } else {
      this.stealthShow();
    }
    this.isVisible = this.mainWindow.isVisible();
  }

  toggleInteractMode(): void {
    this.setFullPassthrough(!this.isFullPassthrough);
  }

  isFullPassthroughEnabled(): boolean {
    return this.isFullPassthrough;
  }

  setOpacity(opacity: number): void {
    this.mainWindow?.setOpacity(Math.max(MIN_OPACITY, Math.min(MAX_OPACITY, opacity)));
  }

  setPosition(x: number, y: number): void {
    this.mainWindow?.setPosition(x, y);
  }

  moveBy(dx: number, dy: number): void {
    if (!this.mainWindow) return;
    const pos = this.mainWindow.getPosition();
    // Use intendedSize (not getBounds()) to prevent Electron DPI rounding drift
    this.mainWindow.setBounds({
      x: pos[0] + dx,
      y: pos[1] + dy,
      width: this.intendedSize.width,
      height: this.intendedSize.height
    });
  }

  setSize(width: number, height: number): void {
    if (!this.mainWindow) return;
    this.intendedSize = { width, height };
    this.mainWindow.setSize(width, height);
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
