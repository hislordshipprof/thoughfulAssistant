const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
if (process.platform !== 'darwin') process.exit(0);
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'build/mac/overlay-audio');
fs.mkdirSync(path.dirname(output), { recursive: true });
const result = spawnSync('xcrun', ['swiftc', '-swift-version', '5', '-O', '-target', 'arm64-apple-macos13.0',
  '-module-cache-path', path.join(root, 'build/mac/module-cache'),
  path.join(root, 'src/native/mac/AudioCapture.swift'), '-o', output,
  '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist',
  '-Xlinker', path.join(root, 'src/native/mac/Info.plist')], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status || 1);
const signed = spawnSync('codesign', ['--force', '--sign', '-', output], { stdio: 'inherit' });
process.exit(signed.status || 0);
