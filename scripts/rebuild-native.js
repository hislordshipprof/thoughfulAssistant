const { rebuild } = require('@electron/rebuild');
const path = require('path');

async function main() {
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
    console.error('Failed to rebuild native modules:', err);
    process.exit(1);
  }
}

main();
