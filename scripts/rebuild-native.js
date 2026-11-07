const { rebuild } = require('@electron/rebuild');
const path = require('path');

async function main() {
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';

  // On macOS the native addon is optional — stealth, hotkeys and panel
  // behavior all work through Electron APIs. Only rebuild if the user
  // explicitly opts in (ENABLE_NATIVE_MAC=1), because many macOS SDK
  // combinations (particularly beta SDKs) can't link the TBD files the
  // bundled node-gyp ships with.
  if (isMac && process.env.ENABLE_NATIVE_MAC !== '1') {
    console.log('[rebuild] Skipping native addon build on macOS — set ENABLE_NATIVE_MAC=1 to opt in.');
    return;
  }

  if (!isWin && !isMac) {
    console.log(`[rebuild] Skipping native addon build on ${process.platform} — unsupported.`);
    return;
  }

  const electronPath = path.dirname(require.resolve('electron/package.json'));
  const electronPkg = require(path.join(electronPath, 'package.json'));

  console.log(`Rebuilding native modules for Electron ${electronPkg.version}...`);

  try {
    await rebuild({
      buildPath: path.resolve(__dirname, '..'),
      electronVersion: electronPkg.version,
      arch: process.arch,
      force: true,
      onlyModules: [] // rebuild all native modules
    });
    console.log('Native modules rebuilt successfully.');
  } catch (err) {
    if (isMac) {
      console.warn('[rebuild] Native addon build failed on macOS, continuing without it:');
      console.warn(err.message || err);
      return;
    }
    console.error('Failed to rebuild native modules:', err);
    process.exit(1);
  }
}

main();
