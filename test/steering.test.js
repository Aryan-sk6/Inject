import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { recordPrompt, lastToolActivity } from '../src/adapters/claude-code/steering.js';
import { promptHookCommand } from '../src/adapters/claude-code/install.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'inject-steer-'));
}

function readFixes(project) {
  const file = path.join(project, '.steer', 'fixes.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

function transcript(dir, entries) {
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

const use = (id, name, input) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const result = (id) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: '' }] } });

test('logs only messages that arrive during a running turn', () => {
  const root = tmp();
  try {
    const opts = { dir: path.join(root, 'state'), projectDir: root };
    const base = { session_id: 's1', cwd: root };
    assert.equal(recordPrompt({ ...base, prompt_id: 'p1', prompt: 'build the thing' }, opts), false, 'new turn');
    assert.equal(recordPrompt({ ...base, prompt_id: 'p1', prompt: ' use pnpm ' }, opts), true, 'mid-turn');
    assert.equal(recordPrompt({ ...base, prompt_id: 'p2', prompt: 'next task' }, opts), false, 'next turn');
    assert.equal(recordPrompt({ session_id: 's2', cwd: root, prompt_id: 'p2', prompt: 'other session' }, opts), false);

    const fixes = readFixes(root);
    assert.equal(fixes.length, 1);
    assert.deepEqual(
      [fixes[0].text, fixes[0].urgency, fixes[0].delivered_via, fixes[0].delivered_at, fixes[0].session_id],
      ['use pnpm', 'normal', 'claude-code-queue', null, 's1'],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('records what Claude was doing from the transcript', () => {
  const root = tmp();
  try {
    let t = transcript(root, [use('a', 'Edit', { file_path: 'src/x.ts' }), result('a'), use('b', 'Bash', { command: 'npm test' })]);
    assert.equal(lastToolActivity(t), 'running Bash: npm test');
    t = transcript(root, [use('b', 'Bash', { command: 'npm test' }), result('b')]);
    assert.equal(lastToolActivity(t), 'just ran Bash: npm test');
    assert.equal(lastToolActivity(path.join(root, 'missing.jsonl')), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('installed hook command logs mid-turn messages, prints nothing, exits 0', () => {
  const root = tmp();
  try {
    const env = { ...process.env, XDG_RUNTIME_DIR: path.join(root, 'run'), CLAUDE_PROJECT_DIR: root };
    delete env.INJECT_DIR;
    const run = (input) => spawnSync('/bin/sh', ['-c', promptHookCommand()], { env, input, encoding: 'utf8' });
    const t = transcript(root, [use('a', 'Bash', { command: 'sleep 8' })]);
    const msg = (prompt) => JSON.stringify({ session_id: 'sx', prompt_id: 'p1', prompt, transcript_path: t, cwd: root });

    for (const r of [run(msg('start')), run(msg('also say KIWI')), run('not json')]) {
      assert.deepEqual([r.status, r.stdout], [0, '']);
    }
    const fixes = readFixes(root);
    assert.deepEqual(fixes.map((f) => [f.text, f.doing]), [['also say KIWI', 'running Bash: sleep 8']]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
