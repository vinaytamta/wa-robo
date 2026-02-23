/**
 * Test the unpacked Windows build before packaging into installer.
 * Verifies dist/win-unpacked exists and launches GroupIQ.exe.
 * Run after: npm run build:win:unpacked
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const projectRoot = path.join(__dirname, '..');
const unpackedDir = path.join(projectRoot, 'dist', 'win-unpacked');
const exePath = path.join(unpackedDir, 'GroupIQ.exe');

if (!fs.existsSync(exePath)) {
  console.error('Unpacked build not found. Run first: npm run build:win:unpacked');
  process.exit(1);
}

console.log('Unpacked build found:', exePath);
console.log('Launching GroupIQ for manual testing...');
console.log('Close the app when done, then run: npm run build:win:installer');
console.log('');

const child = spawn(exePath, [], {
  cwd: unpackedDir,
  stdio: 'inherit',
  detached: true,
});
child.unref();
