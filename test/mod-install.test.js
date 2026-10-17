import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('installMod runs the two claude plugin commands, and says what to run if claude is missing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inject-mod-'));
  const log = path.join(dir, 'calls.log');
  const fake = path.join(dir, 'claude');
  fs.writeFileSync(fake, `#!/bin/sh\necho "$@" >> "${log}"\n`);
  fs.chmodSync(fake, 0o755);
  process.env.CLAUDE_CONFIG_DIR = dir;
  const { installMod, uninstallMod, modInstalled } = await import('../src/adapters/claude-code/install.js');
  const old = process.env.INJECT_COMMAND;
  try {
    process.env.INJECT_COMMAND = fake;
    const r = installMod();
    assert.equal(r.ok, true);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
    assert.match(calls[0], /^plugin marketplace add .*\/$/);
    assert.equal(calls[1], 'plugin install inject@inject');

    assert.equal(modInstalled(), false);
    fs.mkdirSync(path.join(dir, 'plugins'));
    fs.writeFileSync(path.join(dir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'inject@inject': [{ scope: 'user' }] } }));
    assert.equal(modInstalled(), true);
    assert.equal(uninstallMod().ok, true);
    assert.match(fs.readFileSync(log, 'utf8'), /plugin uninstall inject@inject\nplugin marketplace remove inject/);

    process.env.INJECT_COMMAND = path.join(dir, 'does-not-exist');
    const missing = installMod();
    assert.equal(missing.ok, false);
    assert.match(missing.message, /couldn't find the `claude` command/);
    assert.match(missing.message, /claude plugin install inject@inject/);
  } finally {
    old === undefined ? delete process.env.INJECT_COMMAND : (process.env.INJECT_COMMAND = old);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
