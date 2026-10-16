import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Queue } from '../src/core/queue.js';
import { createSessionDir, removeSessionDir, flagPath } from '../src/core/session.js';

test('claims route by urgency and keep flag files in sync', () => {
  const dir = createSessionDir();
  try {
    const q = new Queue(dir);
    q.add('note 1', 'normal');
    assert.ok(fs.existsSync(flagPath(dir, 'normal')));
    assert.ok(!fs.existsSync(flagPath(dir, 'urgent')));

    assert.deepEqual(q.claim('before-tool'), [], 'notes do not block tools');

    q.add('stop', 'urgent');
    assert.ok(fs.existsSync(flagPath(dir, 'urgent')));
    assert.deepEqual(q.claim('after-tool').map((m) => m.text), ['note 1']);
    assert.ok(!fs.existsSync(flagPath(dir, 'normal')));

    q.add('note 2', 'normal');
    const taken = q.claim('before-tool');
    assert.deepEqual(taken.map((m) => m.text), ['stop', 'note 2'], 'urgent takes pending notes along');
    assert.equal(q.size, 0);
    assert.ok(!fs.existsSync(flagPath(dir, 'urgent')));
    assert.deepEqual(q.claim('before-tool'), [], 'each message is delivered once');
  } finally {
    removeSessionDir(dir);
  }
});
