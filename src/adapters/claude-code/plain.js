// Plain-`claude` mode: `/inject <msg>` in a session that was not started with
// the inject wrapper (normal urgency only).
//
// There is no wrapper process to hold a queue. The /inject command, registered
// by the mod in mod/ with immediate: true, appends each message to a per-session
// file in pendingDir(). The PostToolUse hooks claim that file at the next tool
// boundary. Claiming renames the file first, which is atomic, so parallel tool
// calls can't deliver a message twice.
//
// (A hook can't catch "/inject": in an interactive session Claude Code answers
// "Unknown command" before UserPromptSubmit fires.)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Under the user's Claude config dir, not /tmp: another local user must not be
// able to plant messages for this user's sessions. Keep in sync with the mod
// (mod/hooks/register.js) and plainGuard() in install.js.
export function pendingDir() {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'inject-pending');
}

const validId = (id) => typeof id === 'string' && /^[\w-]+$/.test(id);

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
