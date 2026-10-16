// Per-session runtime directory shared by the wrapper and the agent's hooks.
//
// The wrapper creates the directory, listens on <dir>/sock and passes the path
// to the agent through the INJECT_DIR environment variable. Hooks inherit the
// agent's environment, so each hook knows which wrapper (terminal) it belongs to.
//
// Two empty flag files mirror the queue so a hook can skip starting Node when
// there is nothing to deliver:
//   <dir>/normal  exists while at least one normal note is queued
//   <dir>/urgent  exists while at least one urgent message is queued

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ENV_DIR = 'INJECT_DIR';
export const ENV_NODE = 'INJECT_NODE';

export function createSessionDir() {
  // XDG_RUNTIME_DIR is per-user and private on most Linux systems; macOS has
  // a per-user TMPDIR. mkdtemp creates the directory with mode 0700.
  const base = process.env.XDG_RUNTIME_DIR || os.tmpdir();
  return fs.mkdtempSync(path.join(base, 'inject-'));
}

export function socketPath(dir) {
  return path.join(dir, 'sock');
}

export function flagPath(dir, urgency) {
  return path.join(dir, urgency === 'urgent' ? 'urgent' : 'normal');
}

export function setFlag(dir, urgency, on) {
  const file = flagPath(dir, urgency);
  try {
    if (on) fs.writeFileSync(file, '');
    else fs.rmSync(file, { force: true });
  } catch {
    // The directory may already be gone during shutdown.
  }
}

export function removeSessionDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort.
  }
}
