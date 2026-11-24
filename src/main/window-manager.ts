import { BrowserWindow, screen } from 'electron';
import path from 'path';
import { EventEmitter } from 'events';
import type { WindowState } from '../shared/controls';

let nativeAddon: any;
try {
  nativeAddon = require('../../build/Release/native_addon.node');
} catch {
  try {
    nativeAddon = require(path.join(process.resourcesPath, 'native', 'native_addon.node'));
  } catch {
    console.warn('Native addon unavailable — using Electron window privacy controls');
    nativeAddon = null;
  }
}

export class WindowManager extends EventEmitter {
  private mainWindow: BrowserWindow | null = null;
  private protectionRequested = true;
  private protectionState: WindowState['contentProtection'] = 'unavailable';
  private isFullPassthrough = false;
  private visibilityRevision = 0;

  createOverlayWindow(config: {
    width: number;
    height: number;
    x: number;
    y: number;
    opacity: number;
    captureProtection?: boolean;
    clickThrough?: boolean;
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
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '../preload/preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });

    // Set always on top with highest level
    this.mainWindow.setAlwaysOnTop(true, 'screen-saver');
    this.mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    // Request platform capture protection before the first visible frame.
    this.setContentProtection(config.captureProtection ?? true);

    // Subclass window so clicks on overlay never steal focus from other apps
    this.subclassForNoActivate();

    // Start in smart hit-test mode: preload toggles setIgnoreMouseEvents
    // dynamically based on whether mouse is over a UI element or transparent area
    this.setFullPassthrough(config.clickThrough ?? false);
    this.setPosition(config.x, config.y);
    this.mainWindow.on('show', () => this.emitState());
    this.mainWindow.on('hide', () => {
      this.setFocusableForInput(false);
      this.emitState();
    });
    this.mainWindow.once('ready-to-show', () => this.stealthShow());

    // Reapply the user's requested protection state on restore.
    this.mainWindow.on('restore', () => {
      this.reapplyDisplayAffinity();
    });

    this.mainWindow.on('closed', () => {
      this.mainWindow = null;
    });

    return this.mainWindow;
  }

  applyStealthMode(): void {
    this.setContentProtection(true);
  }

  setContentProtection(enabled: boolean): void {
    this.protectionRequested = enabled;
    if (!this.mainWindow) return;
    try {
      this.mainWindow.setContentProtection(enabled);
      if (process.platform === 'win32' && nativeAddon) {
        const hwnd = this.mainWindow.getNativeWindowHandle();
        if (enabled) nativeAddon.applyStealthMode(hwnd);
        else nativeAddon.removeStealthMode(hwnd);
      }
      // Electron 33 has the setter but no getter. Successful submission still
      // only means "requested", never verified exclusion by a capture app.
      const getter = (this.mainWindow as BrowserWindow & { isContentProtected?: () => boolean }).isContentProtected;
      const supported = getter ? getter.call(this.mainWindow) : ['darwin', 'win32'].includes(process.platform);
      this.protectionState = !enabled ? 'off' : supported ? 'requested' : 'unavailable';
    } catch (error) {
      this.protectionState = 'unavailable';
      console.warn('[window] Content protection unavailable:', error);
    }
    this.emitState();
  }

  private subclassForNoActivate(): void {
    if (!this.mainWindow || !nativeAddon) return;

    const hwnd = this.mainWindow.getNativeWindowHandle();
    const ok = nativeAddon.subclassForNoActivate(hwnd);
    console.log(`[window] Subclass for no-activate: ${ok ? 'OK' : 'FAILED'}`);
  }

  removeStealthMode(): void {
    this.setContentProtection(false);
  }

  reapplyDisplayAffinity(): void {
    this.setContentProtection(this.protectionRequested);
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

    this.mainWindow.setIgnoreMouseEvents(enable, { forward: true });
    if (enable) this.setFocusableForInput(false);

    this.isFullPassthrough = enable;
    this.mainWindow.webContents.send('window:hit-test-reset');
    this.emitState();
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
      if (!this.mainWindow.isVisible()) this.stealthShow();
      if (this.isFullPassthrough) this.setFullPassthrough(false);
      this.mainWindow.focus();
    } else if (this.mainWindow.isFocused()) this.mainWindow.blur();
    console.log(`[window] Focusable for input: ${enable}`);
  }

  /**
   * Reapply the requested capture flag before showing without stealing focus.
   * This is not a guarantee that third-party capture software excludes it.
   */
  stealthShow(): void {
    if (!this.mainWindow) return;
    this.visibilityRevision++;

    this.reapplyDisplayAffinity();
    this.mainWindow.showInactive();
  }

  toggleVisibility(): void {
    if (!this.mainWindow) return;

    if (this.mainWindow.isVisible()) {
      this.hide();
    } else {
      this.stealthShow();
    }
  }

  hide(): void {
    this.visibilityRevision++;
    this.mainWindow?.hide();
  }

  async withoutOverlay<T>(take: () => Promise<T>): Promise<T> {
    const win = this.mainWindow;
    const visible = win?.isVisible();
    const revision = this.visibilityRevision;
    // Hide only for our own screenshot, not as a third-party capture bypass.
    if (visible) win?.hide();
    try {
      if (visible) await new Promise(resolve => setTimeout(resolve, 180));
      return await take();
    } finally {
      // A user Hide/Quit during capture wins over automatic restoration.
      if (visible && win && !win.isDestroyed() && revision === this.visibilityRevision) this.stealthShow();
    }
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
    if (!this.mainWindow) return;
    const bounds = this.mainWindow.getBounds();
    const area = screen.getDisplayMatching({ ...bounds, x, y }).workArea;
    // Keep the drag handle and recovery buttons reachable on the target display.
    this.mainWindow.setPosition(
      Math.round(Math.max(area.x, Math.min(x, area.x + area.width - bounds.width))),
      Math.round(Math.max(area.y, Math.min(y, area.y + area.height - Math.min(bounds.height, area.height))))
    );
  }

  moveBy(dx: number, dy: number): void {
    if (!this.mainWindow) return;
    const [x, y] = this.mainWindow.getPosition();
    this.setPosition(x + dx, y + dy);
  }

  setSize(width: number, height: number): void {
    this.mainWindow?.setSize(width, height);
  }

  getWindow(): BrowserWindow | null {
    return this.mainWindow;
  }

  isStealthEnabled(): boolean {
    return this.protectionState === 'requested';
  }

  getState(): WindowState {
    return {
      visible: this.mainWindow?.isVisible() ?? false,
      passthrough: this.isFullPassthrough,
      contentProtection: this.protectionState,
      protectionNote: process.platform === 'darwin'
        ? 'Best effort only: macOS ScreenCaptureKit apps can still capture this overlay. Test your sharing setup. The app remains visible in Activity Monitor.'
        : 'Capture exclusion is requested from the OS, not verified for your recording software. Test before sharing.'
    };
  }

  private emitState(): void {
    const state = this.getState();
    this.emit('state', state);
    if (this.mainWindow && !this.mainWindow.webContents.isDestroyed()) {
      this.mainWindow.webContents.send('window:state', state);
    }
  }

  getNativeAddon(): any {
    return nativeAddon;
  }
}
