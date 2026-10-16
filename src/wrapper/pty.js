import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Loads node-pty, repairing its macOS helper's permissions if needed. */
export function loadPty() {
  ensureSpawnHelperExecutable();
  try {
    return require('node-pty');
  } catch (err) {
    // Linux has no prebuilt binary; node-pty compiles at install time, which
    // needs build tools and an install script npm may have skipped.
    const dir = path.dirname(path.dirname(require.resolve('node-pty/package.json')));
    throw new Error(
      `could not load node-pty (${err.message.split('\n')[0]}).\n` +
        `  Install build tools (python3, make, a C++ compiler), then run:\n` +
        `  cd "${dir}/.." && npm rebuild node-pty`,
    );
  }
}

// npm 11 skips dependency install scripts unless approved, and node-pty's
// postinstall is what marks its macOS prebuilt spawn-helper executable.
function ensureSpawnHelperExecutable() {
  if (process.platform !== 'darwin') return;
  const root = path.dirname(require.resolve('node-pty/package.json'));
  const candidates = [
    path.join(root, 'prebuilds', `darwin-${process.arch}`, 'spawn-helper'),
    path.join(root, 'build', 'Release', 'spawn-helper'),
  ];
  for (const file of candidates) {
    try {
      const { mode } = fs.statSync(file);
      if ((mode & 0o111) === 0) fs.chmodSync(file, 0o755);
    } catch (err) {
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        throw new Error(`node-pty's spawn-helper is not executable and can't be fixed automatically. Run:\n  chmod +x "${file}"`);
      }
    }
  }
}
