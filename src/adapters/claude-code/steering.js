// Logs messages typed into Claude Code's own queue mid-turn, so plain
// `claude` sessions (not started with inject) still record steering in
// .steer/fixes.jsonl.
//
// Claude Code fires UserPromptSubmit as soon as you press Enter, including on
// a message it queues while Claude is working. A queued message carries the
// running turn's prompt_id; a new turn gets a new one. So we remember the last
// prompt_id per session and log a prompt that repeats it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendFix } from '../../core/log.js';
import { describeTool } from './output.js';

const TAIL_BYTES = 512 * 1024;

export function stateDir() {
  return path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), 'inject-turns');
}

/**
 * @param {{session_id?:string, prompt_id?:string, prompt?:string,
 *          transcript_path?:string, cwd?:string}} input UserPromptSubmit input
 * @returns {boolean} whether a mid-turn message was logged
 */
export function recordPrompt(input, { dir = stateDir(), projectDir, now = new Date() } = {}) {
  const { session_id: sessionId, prompt_id: promptId, prompt } = input;
  if (!sessionId || !promptId || typeof prompt !== 'string') return false;
  if (!/^[\w-]+$/.test(sessionId)) return false;

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, sessionId);
  let current = null;
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch {
    // First prompt of this session.
  }
  if (current !== promptId) {
    fs.writeFileSync(file, promptId);
    return false;
  }

  const text = prompt.trim();
  if (!text) return false;
  const ts = now.toISOString();
  return appendFix(projectDir || input.cwd || process.cwd(), { text, urgency: 'normal', queuedAt: ts }, {
    agent: 'claude-code',
    deliveredAt: null,
    event: 'claude-code-queue',
    doing: lastToolActivity(input.transcript_path),
    sessionId,
  });
}

/** "running Bash: npm test" / "just ran Edit: src/a.ts", from the transcript tail. */
export function lastToolActivity(transcriptPath) {
  if (!transcriptPath) return null;
  let lines;
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const { size } = fs.fstatSync(fd);
      const len = Math.min(size, TAIL_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      lines = buf.toString('utf8').split('\n');
      if (len < size) lines.shift(); // partial first line
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }

  const finished = new Set();
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'tool_result') finished.add(block.tool_use_id);
    }
    const uses = content.filter((b) => b?.type === 'tool_use');
    if (entry.message.role === 'assistant' && uses.length) {
      const use = uses[uses.length - 1];
      const tool = describeTool(use.name, use.input);
      return `${finished.has(use.id) ? 'just ran' : 'running'} ${tool}`;
    }
  }
  return null;
}
