import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { claim, pendingDir } from '../src/adapters/claude-code/plain.js';
import { handlePrompt } from '../src/adapters/claude-code/prompt.js';
import { hookCommand } from '../src/adapters/claude-code/install.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'inject-plain-test-'));

// What the mod writes: one JSON line per message, in <config dir>/inject-pending/<session>.jsonl.
function modWrites(config, sessionId, text, projectDir) {
  const dir = path.join(config, 'inject-pending');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${sessionId}.jsonl`), JSON.stringify({ text, queuedAt: new Date().toISOString(), projectDir }) + '\n');
}

test('pendingDir lives under the Claude config dir, not /tmp', () => {
  const old = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = '/x/cfg';
  assert.equal(pendingDir(), '/x/cfg/inject-pending');
  old === undefined ? delete process.env.CLAUDE_CONFIG_DIR : (process.env.CLAUDE_CONFIG_DIR = old);
});

test('claim delivers each message once, per session, and validates ids', () => {
  const config = tmp();
  const dir = path.join(config, 'inject-pending');
  try {
    modWrites(config, 's1', 'one');
    modWrites(config, 's1', 'two');
    modWrites(config, 's2', 'other');
    assert.deepEqual(claim('s1', { dir }).map((m) => m.text), ['one', 'two']);
    assert.deepEqual(claim('s1', { dir }), []);
    assert.deepEqual(claim('s2', { dir }).map((m) => m.text), ['other']);
    assert.deepEqual(claim('../evil', { dir }), []);
  } finally {
    fs.rmSync(config, { recursive: true, force: true });
  }
});

test('the prompt hook never blocks or rewrites a prompt, and ignores /inject lines', () => {
  const project = tmp();
  // The hook keeps per-session state in a temp dir, so use ids no earlier run has used.
  const sid = `sess-${process.pid}-${Date.now()}`;
  try {
    for (const prompt of ['/inject use pnpm', '/inject! stop', 'hello']) {
      assert.equal(handlePrompt({ session_id: sid, prompt_id: 'p', prompt, cwd: project }, { projectDir: project }), null);
    }
    // The same prompt_id twice would normally log a queued message; /inject lines are skipped.
    handlePrompt({ session_id: `${sid}-b`, prompt_id: 'p', prompt: 'first', cwd: project }, { projectDir: project });
    handlePrompt({ session_id: `${sid}-b`, prompt_id: 'p', prompt: '/inject x', cwd: project }, { projectDir: project });
    assert.equal(fs.existsSync(path.join(project, '.steer', 'fixes.jsonl')), false);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('installed hook commands deliver plain-mode messages, only to the right session', () => {
  const config = tmp();
  const project = tmp();
  const env = { ...process.env, CLAUDE_CONFIG_DIR: config, CLAUDE_PROJECT_DIR: project };
  delete env.INJECT_DIR;
  delete env.INJECT_NODE;
  const run = (event, flag, input) => {
    const r = spawnSync('/bin/sh', ['-c', hookCommand(event, flag)], { env, input: JSON.stringify(input), encoding: 'utf8' });
    return { code: r.status, out: r.stdout };
  };
  const post = (sid) => ({ hook_event_name: 'PostToolUse', session_id: sid, cwd: project, tool_name: 'Bash', tool_input: { command: 'npm test' } });
  try {
    assert.deepEqual(run('PostToolUse', 'normal', post('a')), { code: 0, out: '' }, 'nothing pending');

    modWrites(config, 'a', 'use pnpm', project);
    assert.deepEqual(run('PostToolUse', 'normal', post('b')), { code: 0, out: '' }, 'other session gets nothing');
    assert.deepEqual(run('PreToolUse', 'urgent', { ...post('a'), hook_event_name: 'PreToolUse' }), { code: 0, out: '' }, 'plain mode never blocks tools');

    const out = JSON.parse(run('PostToolUse', 'normal', post('a')).out).hookSpecificOutput;
    assert.equal(out.hookEventName, 'PostToolUse');
    assert.match(out.additionalContext, /use pnpm/);
    assert.deepEqual(run('PostToolUse', 'normal', post('a')), { code: 0, out: '' }, 'delivered once');

    const [fix] = fs.readFileSync(path.join(project, '.steer', 'fixes.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(fix.text, 'use pnpm');
    assert.equal(fix.delivered_via, 'PostToolUse');
    assert.equal(fix.doing, 'just ran Bash: npm test');
    assert.equal(fix.session_id, 'a');
  } finally {
    fs.rmSync(config, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});
