import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('install merges into existing settings, is idempotent, and uninstall restores', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inject-install-'));
  process.env.CLAUDE_CONFIG_DIR = tmp;
  const { install, uninstall, isInstalled, settingsPath } = await import('../src/adapters/claude-code/install.js');
  try {
    const existing = {
      model: 'opus',
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine.sh' }] }] },
    };
    fs.writeFileSync(settingsPath(), JSON.stringify(existing));

    assert.equal(isInstalled(), false);
    assert.equal(install().changed, true);
    assert.equal(isInstalled(), true);
    assert.equal(install().changed, false, 'second install is a no-op');

    const s = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    assert.equal(s.model, 'opus');
    assert.equal(s.hooks.PreToolUse.length, 2);
    assert.equal(s.hooks.PreToolUse[0].hooks[0].command, 'mine.sh');
    assert.ok(s.hooks.PostToolUse && s.hooks.PostToolUseFailure);

    assert.equal(uninstall().changed, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath(), 'utf8')), existing);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('install refuses to overwrite invalid JSON', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inject-install-'));
  process.env.CLAUDE_CONFIG_DIR = tmp;
  const { install, settingsPath } = await import('../src/adapters/claude-code/install.js');
  try {
    fs.writeFileSync(settingsPath(), '{ broken');
    assert.throws(() => install(), /not valid JSON/);
    assert.equal(fs.readFileSync(settingsPath(), 'utf8'), '{ broken');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
