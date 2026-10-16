// Plain-`claude` mode: `/inject <msg>` in a session that was not started with
// the inject wrapper (normal urgency only).
//
// There is no wrapper process to hold a queue, so the UserPromptSubmit hook
// blocks the "/inject ..." prompt and appends the message to a per-session file
// in pendingDir(). The PostToolUse hooks claim that file at the next tool
// boundary. Claiming renames the file first, which is atomic, so parallel tool
// calls can't deliver a message twice.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STALE_MS = 24 * 60 * 60 * 1000;

// Keep in sync with plainGuard() in install.js, which checks this directory
// from the shell before starting Node.
export function pendingDir() {
  return path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), 'inject-plain');
}

const validId = (id) => typeof id === 'string' && /^[\w-]+$/.test(id);

/** Returns 'normal' | 'urgent' | 'bare' for "/inject..." prompts, else null. */
export function parseInjectPrompt(prompt) {
  const m = /^\s*\/inject(!?)(?:\s+([\s\S]*))?$/.exec(prompt);
  if (!m) return null;
  const text = (m[2] || '').replace(/\s+/g, ' ').trim();
  return { urgent: m[1] === '!', text };
}

export function enqueue(sessionId, text, { projectDir, dir = pendingDir(), now = new Date() } = {}) {
  if (!validId(sessionId)) return false;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  prune(dir, now.getTime());
  const record = { text, queuedAt: now.toISOString(), projectDir: projectDir || null };
  fs.appendFileSync(path.join(dir, `${sessionId}.jsonl`), JSON.stringify(record) + '\n');
  return true;
}

/** Takes all pending messages for a session. */
export function claim(sessionId, { dir = pendingDir() } = {}) {
  if (!validId(sessionId)) return [];
  const file = path.join(dir, `${sessionId}.jsonl`);
  const mine = `${file}.claimed-${process.pid}`;
  try {
    fs.renameSync(file, mine);
  } catch {
    return [];
  }
  try {
    return fs
      .readFileSync(mine, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => ({ ...JSON.parse(l), urgency: 'normal' }));
  } catch {
    return [];
  } finally {
    fs.rmSync(mine, { force: true });
  }
}

// Sessions that ended with messages still pending would otherwise keep the
// shell guard open for every later session.
function prune(dir, nowMs) {
  try {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (nowMs - fs.statSync(file).mtimeMs > STALE_MS) fs.rmSync(file, { force: true });
    }
  } catch {
    // Best effort.
  }
}
