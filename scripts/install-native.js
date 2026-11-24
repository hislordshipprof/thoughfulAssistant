const { spawnSync } = require('child_process');

if (process.platform !== 'win32') {
  console.log('Skipping the Windows-only native addon on this platform.');
  process.exit(0);
}

const nodeGyp = require.resolve('node-gyp/bin/node-gyp.js');
const result = spawnSync(process.execPath, [nodeGyp, 'rebuild'], {
  stdio: 'inherit'
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
