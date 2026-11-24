const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);

export function shortcut(key: string, options: { shift?: boolean; option?: boolean } = {}): string {
  if (isMac) {
    return `⌘${options.shift ? '⇧' : ''}${options.option ? '⌥' : ''}${key}`;
  }

  return [
    'Ctrl',
    options.shift ? 'Shift' : '',
    options.option ? 'Alt' : '',
    key
  ].filter(Boolean).join('+');
}
