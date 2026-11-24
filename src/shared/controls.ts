export interface ShortcutBinding {
  vkCodes: number[];
  label: string;
}

export const controlNames: Record<string, string> = {
  toggleOverlay: 'Show / hide overlay', chat: 'Open chat / send question',
  askAi: 'Get answer from screen', captureScreen: 'Capture screen',
  toggleRecording: 'Toggle recording', toggleInteract: 'Toggle click-through',
  cancelStream: 'Stop answer', resetAll: 'New conversation',
  scrollUp: 'Scroll up', scrollDown: 'Scroll down', quitApp: 'Quit app',
  moveWindowUp: 'Move up', moveWindowDown: 'Move down',
  moveWindowLeft: 'Move left', moveWindowRight: 'Move right',
  hideApp: 'Show / hide (alternate)', toggleTypingMode: 'Toggle typing focus'
};

export function acceleratorFor(codes: number[], platform: string): string | null {
  const keys: Record<number, string> = {
    0x0D: 'Enter', 0x1B: 'Escape', 0x25: 'Left', 0x26: 'Up',
    0x27: 'Right', 0x28: 'Down', 0xDC: '\\'
  };
  const parts: string[] = [];
  let key: string | undefined;
  for (const code of codes) {
    if ([0x11, 0xA2, 0xA3].includes(code)) parts.push(platform === 'darwin' ? 'Command' : 'Control');
    else if ([0x10, 0xA0, 0xA1].includes(code)) parts.push('Shift');
    else if ([0x12, 0xA4, 0xA5].includes(code)) parts.push('Alt');
    else {
      if (key) return null;
      key = code >= 0x41 && code <= 0x5A ? String.fromCharCode(code) : keys[code];
      if (!key) return null;
    }
  }
  return key ? [...parts, key].join('+') : null;
}

export function shortcutLabel(codes: number[], platform: string): string {
  const accelerator = acceleratorFor(codes, platform);
  if (!accelerator) return 'Unassigned';
  if (platform !== 'darwin') return accelerator.replace('Control', 'Ctrl');
  const symbols: Record<string, string> = {
    Command: '⌘', Shift: '⇧', Alt: '⌥', Enter: '↵', Escape: 'Esc',
    Up: '↑', Down: '↓', Left: '←', Right: '→'
  };
  return accelerator.split('+').map(key => symbols[key] || key).join('');
}

export function defaultHotkeys(platform: string): Record<string, ShortcutBinding> {
  const mac = platform === 'darwin';
  const bindings: Record<string, number[]> = {
    toggleOverlay: mac ? [0x11, 0xDC] : [0x11, 0x10, 0x48],
    chat: [0x11, 0x0D],
    askAi: mac ? [0x11, 0x10, 0x0D] : [0x11, 0x10, 0x41],
    captureScreen: [0x11, 0x10, 0x53], toggleRecording: [0x11, 0x10, 0x52],
    toggleInteract: [0x11, 0x10, 0x49],
    cancelStream: mac ? [0x11, 0x10, 0x58] : [0x1B],
    resetAll: [0x11, 0x10, 0x4E], scrollUp: [0x11, 0x10, 0x26],
    scrollDown: [0x11, 0x10, 0x28],
    quitApp: mac ? [0x11, 0x12, 0x51] : [0x11, 0x10, 0x51],
    moveWindowUp: [0x11, 0x12, 0x26], moveWindowDown: [0x11, 0x12, 0x28],
    moveWindowLeft: [0x11, 0x12, 0x25], moveWindowRight: [0x11, 0x12, 0x27],
    hideApp: mac ? [0x11, 0x10, 0x48] : [0x11, 0x48],
    toggleTypingMode: [0x11, 0x10, 0x57]
  };
  return Object.fromEntries(Object.entries(bindings).map(([name, vkCodes]) => [name, {
    vkCodes, label: shortcutLabel(vkCodes, platform)
  }]));
}

/** Migrate only unchanged legacy defaults; never overwrite a customized binding. */
export function migrateControls(saved: Record<string, ShortcutBinding>, platform: string, version: number) {
  const defaults = defaultHotkeys(platform);
  const legacy = defaultHotkeys('win32');
  const normalized = Object.fromEntries(Object.entries(saved).map(([name, binding]) => [name, {
    ...binding,
    vkCodes: binding.vkCodes.map(code => ({
      0xA0: 0x10, 0xA1: 0x10, 0xA2: 0x11, 0xA3: 0x11, 0xA4: 0x12, 0xA5: 0x12
    }[code] ?? code))
  }]));
  const result = { ...defaults, ...normalized };
  for (const [name, binding] of Object.entries(result)) {
    if (platform === 'darwin' && version < 1 && legacy[name] &&
        [...binding.vkCodes].sort().join(',') === [...legacy[name].vkCodes].sort().join(',')) {
      result[name] = defaults[name];
    }
    result[name] = { ...result[name], label: shortcutLabel(result[name].vkCodes, platform) };
  }
  return result;
}

export interface WindowState {
  visible: boolean;
  passthrough: boolean;
  contentProtection: 'requested' | 'off' | 'unavailable';
  protectionNote: string;
}
