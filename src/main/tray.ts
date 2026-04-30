import { Tray, Menu, nativeImage, app } from 'electron';
import path from 'path';

export class TrayManager {
  private tray: Tray | null = null;

  create(callbacks: {
    onToggleOverlay: () => void;
    onToggleRecording: () => void;
    onSettings: () => void;
    onQuit: () => void;
  }): Tray {
    // Try to load custom icon, fallback to a simple one
    let icon: Electron.NativeImage;
    try {
      icon = nativeImage.createFromPath(
        path.join(__dirname, '../../assets/icons/tray-icon.ico')
      );
      if (icon.isEmpty()) throw new Error('Icon file empty or not found');
    } catch {
      // Create a minimal 16x16 blue square as fallback
      icon = nativeImage.createFromBuffer(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMklEQVQ4T2N0' +
          'TKn5n4EKgJGYIINmMFADC9UCYQSMIDZ1XDC4woCqYUCrfEDNMKBmPgAAo3gZ' +
          'Ef2XHIAAAAAASUVORK5CYII=',
          'base64'
        ),
        { width: 16, height: 16 }
      );
    }

    this.tray = new Tray(icon);
    this.tray.setToolTip('Audio Device Helper');

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Toggle Overlay',
        click: callbacks.onToggleOverlay
      },
      {
        label: 'Toggle Recording',
        click: callbacks.onToggleRecording
      },
      { type: 'separator' },
      {
        label: 'Settings',
        click: callbacks.onSettings
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          callbacks.onQuit();
          app.quit();
        }
      }
    ]);

    this.tray.setContextMenu(contextMenu);

    this.tray.on('click', () => {
      callbacks.onToggleOverlay();
    });

    return this.tray;
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }

  setRecordingState(isRecording: boolean): void {
    this.tray?.setToolTip(
      isRecording ? 'Audio Device Helper (Recording)' : 'Audio Device Helper'
    );
  }
}
