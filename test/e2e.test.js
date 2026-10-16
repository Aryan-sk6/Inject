// Drives the real wrapper under a pty with a fake agent, then runs the exact
// hook commands that `inject --install` writes, the way Claude Code would.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPty } from '../src/wrapper/pty.js';

const pty = loadPty();
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bin = path.join(root, 'bin', 'inject.js');
const fake = path.join(root, 'test', 'fixtures', 'fake-agent.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(20);
  }
}

function readLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function runHook(command, env, input) {
  const r = spawnSync('/bin/sh', ['-c', command], { env, input: JSON.stringify(input), encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('end to end: intercept, queue, deliver through installed hooks, log', async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'inject-e2e-')));
  const config = path.join(tmp, 'config');
  const project = path.join(tmp, 'project');
  fs.mkdirSync(project);
  const fakeLog = path.join(tmp, 'fake.log');
  const baseEnv = { ...process.env, CLAUDE_CONFIG_DIR: config };

  execFileSync(process.execPath, [bin, '--install'], { env: baseEnv });
  const settings = JSON.parse(fs.readFileSync(path.join(config, 'settings.json'), 'utf8'));
  const cmd = (event) => settings.hooks[event][0].hooks[0].command;

  const term = pty.spawn(process.execPath, [bin, fake], {
    cols: 100,
    rows: 30,
    cwd: project,
    env: { ...baseEnv, INJECT_COMMAND: process.execPath, FAKE_LOG: fakeLog },
  });
  let screen = '';
  term.onData((d) => (screen += d));
  const exited = new Promise((r) => term.onExit(r));

  try {
    const { dir, node } = await until(() => readLog(fakeLog)[0]);
    assert.ok(dir && fs.existsSync(path.join(dir, 'sock')), 'agent got INJECT_DIR with a live socket');
    await until(() => screen.includes('fake agent ready'));

    const inputs = () => readLog(fakeLog).slice(1).map((r) => r.input).join('');
    const type = async (s) => {
      for (const ch of s) {
        term.write(ch);
        await sleep(2);
      }
    };

    await type('hello\r');
    await until(() => inputs() === 'hello\r');

    await type('/inject use pnpm, not npm\r');
    await until(() => screen.includes('queued'));
    await type('/init\r');
    await until(() => inputs().endsWith('/init\r'));
    assert.equal(inputs(), 'hello\r/init\r', '/inject line never reached the agent');

    const hookEnv = { ...process.env, INJECT_DIR: dir, INJECT_NODE: node, CLAUDE_PROJECT_DIR: project };
    const pre = { hook_event_name: 'PreToolUse', session_id: 's1', cwd: project, tool_name: 'Bash', tool_input: { command: 'npm install' } };

    let r = runHook(cmd('PreToolUse'), hookEnv, pre);
    assert.equal(r.code, 0);
    assert.equal(r.out, '', 'a normal note does not block a tool call');

    r = runHook(cmd('PostToolUse'), hookEnv, { ...pre, hook_event_name: 'PostToolUse', tool_response: {} });
    assert.equal(r.code, 0);
    const post = JSON.parse(r.out);
    assert.equal(post.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.match(post.hookSpecificOutput.additionalContext, /use pnpm, not npm/);

    r = runHook(cmd('PostToolUse'), hookEnv, { ...pre, hook_event_name: 'PostToolUse' });
    assert.equal(r.out, '', 'delivered once');
    await until(() => screen.includes('delivered'));

    await type('/inject! stop touching v1 routes\r');
    await until(() => fs.existsSync(path.join(dir, 'urgent')));
    r = runHook(cmd('PreToolUse'), hookEnv, { ...pre, tool_name: 'Edit', tool_input: { file_path: 'src/v1/routes.ts' } });
    const deny = JSON.parse(r.out).hookSpecificOutput;
    assert.equal(deny.permissionDecision, 'deny');
    assert.match(deny.permissionDecisionReason, /stop touching v1 routes/);

    const fixes = readLog(path.join(project, '.steer', 'fixes.jsonl'));
    assert.equal(fixes.length, 2);
    assert.deepEqual(
      fixes.map((f) => [f.text, f.urgency, f.delivered_via, f.doing, f.session_id]),
      [
        ['use pnpm, not npm', 'normal', 'PostToolUse', 'just ran Bash: npm install', 's1'],
        ['stop touching v1 routes', 'urgent', 'PreToolUse', 'about to run Edit: src/v1/routes.ts', 's1'],
      ],
    );

    // Undelivered messages are reported and logged when the agent exits.
    await type('/inject never delivered\r');
    await until(() => fs.existsSync(path.join(dir, 'normal')));
    term.write('\x04');
    const { exitCode } = await exited;
    assert.equal(exitCode, 7, 'wrapper exits with the agent exit code');
    assert.match(screen, /1 message\(s\) were not delivered/);
    const last = readLog(path.join(project, '.steer', 'fixes.jsonl')).at(-1);
    assert.equal(last.text, 'never delivered');
    assert.equal(last.delivered_at, null);
    assert.ok(!fs.existsSync(dir), 'session dir cleaned up');
  } finally {
    try { term.kill(); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('hooks are a no-op outside inject and when the wrapper is gone', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inject-noop-'));
  try {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: tmp };
    execFileSync(process.execPath, [bin, '--install'], { env });
    const settings = JSON.parse(fs.readFileSync(path.join(tmp, 'settings.json'), 'utf8'));
    const cmd = settings.hooks.PreToolUse[0].hooks[0].command;
    const clean = { ...process.env };
    delete clean.INJECT_DIR;
    let r = runHook(cmd, clean, { tool_name: 'Bash' });
    assert.deepEqual([r.code, r.out], [0, '']);

    // Flag present but no socket (wrapper crashed): still silent, exit 0.
    fs.writeFileSync(path.join(tmp, 'urgent'), '');
    r = runHook(cmd, { ...process.env, INJECT_DIR: tmp, INJECT_NODE: process.execPath }, { tool_name: 'Bash' });
    assert.deepEqual([r.code, r.out], [0, '']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
