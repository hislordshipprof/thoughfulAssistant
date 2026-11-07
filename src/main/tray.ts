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
    } catch {
      // Create a minimal 16x16 icon
      icon = nativeImage.createEmpty();
    }

    this.tray = new Tray(icon);
    this.tray.setToolTip('Thoughtful');

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Toggle Overlay',
        click: callbacks.onToggleOverlay,
        accelerator: 'Ctrl+Shift+H'
      },
      {
        label: 'Toggle Recording',
        click: callbacks.onToggleRecording,
        accelerator: 'Ctrl+Shift+R'
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
      isRecording ? 'Thoughtful (Recording)' : 'Thoughtful'
    );
  }
}
