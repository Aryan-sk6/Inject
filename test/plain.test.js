import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseInjectPrompt, enqueue, claim } from '../src/adapters/claude-code/plain.js';
import { handlePrompt } from '../src/adapters/claude-code/prompt.js';
import { hookCommand } from '../src/adapters/claude-code/install.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'inject-plain-test-'));

test('parseInjectPrompt', () => {
  assert.deepEqual(parseInjectPrompt('/inject use pnpm'), { urgent: false, text: 'use pnpm' });
  assert.deepEqual(parseInjectPrompt('  /inject   a\n b '), { urgent: false, text: 'a b' });
  assert.deepEqual(parseInjectPrompt('/inject! stop'), { urgent: true, text: 'stop' });
  assert.deepEqual(parseInjectPrompt('/inject'), { urgent: false, text: '' });
  for (const p of ['/injector x', '/init', 'please /inject x', 'inject x', '']) assert.equal(parseInjectPrompt(p), null, p);
});

test('enqueue / claim delivers each message once, per session', () => {
  const dir = tmp();
  try {
    enqueue('s1', 'one', { dir, projectDir: '/p' });
    enqueue('s1', 'two', { dir });
    enqueue('s2', 'other', { dir });
    assert.deepEqual(claim('s1', { dir }).map((m) => m.text), ['one', 'two']);
    assert.deepEqual(claim('s1', { dir }), []);
    assert.deepEqual(claim('s2', { dir }).map((m) => m.text), ['other']);
    assert.equal(enqueue('../evil', 'x', { dir }), false, 'session ids are validated');
    assert.deepEqual(claim('../evil', { dir }), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('prompt hook: plain mode blocks /inject, queues it, and refuses /inject!', () => {
  const xdg = tmp();
  const old = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = xdg;
  try {
    const base = { session_id: 'sess', prompt_id: 'p1', cwd: '/proj' };
    const queued = JSON.parse(handlePrompt({ ...base, prompt: '/inject use pnpm' }, { wrapped: false }));
    assert.equal(queued.decision, 'block');
    assert.match(queued.reason, /queued/);
    assert.deepEqual(claim('sess').map((m) => m.text), ['use pnpm']);

    const urgent = JSON.parse(handlePrompt({ ...base, prompt: '/inject! stop' }, { wrapped: false }));
    assert.equal(urgent.decision, 'block');
    assert.match(urgent.reason, /only works when you start Claude with `inject`/);
    assert.deepEqual(claim('sess'), [], 'urgent is not downgraded to a note');

    const bare = JSON.parse(handlePrompt({ ...base, prompt: '/inject' }, { wrapped: false }));
    assert.match(bare.reason, /usage/);

    assert.equal(handlePrompt({ ...base, prompt: 'hello' }, { wrapped: false, projectDir: xdg }), null);
    assert.equal(handlePrompt({ ...base, prompt: '/inject x' }, { wrapped: true }), null, 'wrapper sessions are left alone');
  } finally {
    old === undefined ? delete process.env.XDG_RUNTIME_DIR : (process.env.XDG_RUNTIME_DIR = old);
    fs.rmSync(xdg, { recursive: true, force: true });
  }
});

test('installed hook commands deliver plain-mode messages, only to the right session', () => {
  const xdg = tmp();
  const project = tmp();
  const old = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = xdg;
  const env = { ...process.env, CLAUDE_PROJECT_DIR: project };
  delete env.INJECT_DIR;
  delete env.INJECT_NODE;
  const run = (event, flag, input) => {
    const r = spawnSync('/bin/sh', ['-c', hookCommand(event, flag)], { env, input: JSON.stringify(input), encoding: 'utf8' });
    return { code: r.status, out: r.stdout };
  };
  const post = (sid, extra = {}) => ({ hook_event_name: 'PostToolUse', session_id: sid, cwd: project, tool_name: 'Bash', tool_input: { command: 'npm test' }, ...extra });
  try {
    assert.deepEqual(run('PostToolUse', 'normal', post('a')), { code: 0, out: '' }, 'nothing pending');

    handlePrompt({ session_id: 'a', prompt_id: 'p', prompt: '/inject use pnpm', cwd: project }, { wrapped: false, projectDir: project });
    assert.deepEqual(run('PostToolUse', 'normal', post('b')), { code: 0, out: '' }, 'other session gets nothing');
    assert.deepEqual(run('PreToolUse', 'urgent', { ...post('a'), hook_event_name: 'PreToolUse' }), { code: 0, out: '' }, 'plain mode never blocks tools');

    const r = run('PostToolUse', 'normal', post('a'));
    const out = JSON.parse(r.out).hookSpecificOutput;
    assert.equal(out.hookEventName, 'PostToolUse');
    assert.match(out.additionalContext, /use pnpm/);
    assert.deepEqual(run('PostToolUse', 'normal', post('a')), { code: 0, out: '' }, 'delivered once');

    const [fix] = fs.readFileSync(path.join(project, '.steer', 'fixes.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(fix.text, 'use pnpm');
    assert.equal(fix.delivered_via, 'PostToolUse');
    assert.equal(fix.doing, 'just ran Bash: npm test');
    assert.equal(fix.session_id, 'a');
  } finally {
    old === undefined ? delete process.env.XDG_RUNTIME_DIR : (process.env.XDG_RUNTIME_DIR = old);
    fs.rmSync(xdg, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});
