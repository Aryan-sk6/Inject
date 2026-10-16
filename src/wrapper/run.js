// Runs the agent under a pseudo-terminal, forwarding everything unchanged
// except "/inject ..." lines, which go to the queue instead.

import { spawnSync } from 'node:child_process';
import { Queue } from '../core/queue.js';
import { listen } from '../core/ipc.js';
import { appendFix } from '../core/log.js';
import { ENV_DIR, ENV_NODE, createSessionDir, removeSessionDir, socketPath } from '../core/session.js';
import { Interceptor } from './intercept.js';
import { Overlay, deliveredToast, queuedToast, usageToast } from './overlay.js';
import { loadPty } from './pty.js';

/**
 * @param {import('../adapters/types.js').Adapter} adapter
 * @param {string[]} args passed to the agent unchanged
 */
export async function run(adapter, args) {
  const command = process.env.INJECT_COMMAND || adapter.command;

  // Piped or scripted use (e.g. `inject -p "..."`): nothing to intercept.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const r = spawnSync(command, args, { stdio: 'inherit' });
    if (r.error) fail(`could not start ${command}: ${r.error.message}`);
    process.exit(r.status ?? 1);
  }

  let pty;
  try {
    pty = loadPty();
  } catch (err) {
    fail(err.message);
  }

  const dir = createSessionDir();
  const queue = new Queue(dir);
  const overlay = new Overlay(process.stdout);
  const cwd = process.cwd();

  const server = await listen(socketPath(dir), (req) => {
    if (req.op !== 'claim') return { messages: [] };
    const messages = queue.claim(req.boundary);
    if (messages.length) {
      const deliveredAt = new Date().toISOString();
      for (const m of messages) {
        appendFix(req.projectDir || cwd, m, {
          agent: req.agent,
          deliveredAt,
          event: req.event,
          doing: req.doing,
          sessionId: req.sessionId,
        });
      }
      const urgent = messages.some((m) => m.urgency === 'urgent');
      overlay.setPending(queue.size);
      overlay.toast(deliveredToast(messages.length, urgent, req.doing));
    }
    return { messages };
  });

  let child;
  try {
    child = pty.spawn(command, args, {
      name: process.env.TERM || 'xterm-256color',
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
      cwd,
      env: { ...process.env, [ENV_DIR]: dir, [ENV_NODE]: process.execPath },
    });
  } catch (err) {
    server.close();
    removeSessionDir(dir);
    fail(`could not start ${command}: ${err.message}. Is it installed and on your PATH?`);
  }

  const interceptor = new Interceptor();
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.resume();

  process.stdin.on('data', (data) => {
    const { forward, events } = interceptor.feed(data);
    if (forward) child.write(forward);
    for (const ev of events) {
      if (ev.type === 'capture') overlay.editing(ev.urgency, ev.text);
      else if (ev.type === 'cancel') overlay.stopEditing();
      else if (ev.type === 'usage') overlay.toast(usageToast());
      else if (ev.type === 'submit') {
        queue.add(ev.text, ev.urgency);
        overlay.stopEditing();
        overlay.pending = queue.size;
        overlay.toast(queuedToast(ev.urgency));
      }
    }
  });

  child.onData((data) => {
    process.stdout.write(data);
    overlay.afterOutput(data);
  });

  process.stdout.on('resize', () => {
    child.resize(process.stdout.columns, process.stdout.rows);
    overlay.draw();
  });

  for (const sig of ['SIGTERM', 'SIGHUP']) {
    process.on(sig, () => child.kill(sig));
  }

  child.onExit(({ exitCode, signal }) => {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    server.close();
    const leftover = queue.claim('before-tool').concat(queue.claim('after-tool'));
    for (const m of leftover) appendFix(cwd, m, { agent: adapter.id });
    removeSessionDir(dir);
    if (leftover.length) {
      process.stderr.write(
        `\ninject: ${leftover.length} message(s) were not delivered (logged to .steer/fixes.jsonl):\n` +
          leftover.map((m) => `  - ${m.urgency === 'urgent' ? '[urgent] ' : ''}${m.text}\n`).join(''),
      );
    }
    process.exit(signal ? 128 + signal : exitCode);
  });
}

function fail(msg) {
  process.stderr.write(`inject: ${msg}\n`);
  process.exit(1);
}
