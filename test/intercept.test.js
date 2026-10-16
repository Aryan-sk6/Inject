import test from 'node:test';
import assert from 'node:assert/strict';
import { Interceptor } from '../src/wrapper/intercept.js';

function feedAll(chunks, it = new Interceptor()) {
  let forward = '';
  const events = [];
  for (const c of chunks) {
    const r = it.feed(c);
    forward += r.forward;
    events.push(...r.events);
  }
  return { forward, events, it };
}

const keys = (s) => Array.from(s); // one keystroke per chunk, like a real terminal

test('ordinary typing passes through unchanged', () => {
  const { forward, events } = feedAll(keys('fix the bug\r'));
  assert.equal(forward, 'fix the bug\r');
  assert.deepEqual(events, []);
});

test('/inject line is captured and never forwarded', () => {
  const { forward, events } = feedAll(keys('/inject use pnpm\r'));
  assert.equal(forward, '');
  assert.deepEqual(events.at(-1), { type: 'submit', urgency: 'normal', text: 'use pnpm' });
});

test('/inject! is urgent', () => {
  const { forward, events } = feedAll(keys('/inject! stop\r'));
  assert.equal(forward, '');
  assert.deepEqual(events.at(-1), { type: 'submit', urgency: 'urgent', text: 'stop' });
});

test('other slash commands that share a prefix are forwarded intact', () => {
  for (const cmd of ['/init\r', '/install-github-app\r', '/i\r', '/injector\r', '/help\r']) {
    const { forward, events } = feedAll(keys(cmd));
    assert.equal(forward, cmd, cmd);
    assert.deepEqual(events, [], cmd);
  }
});

test('whole line in one chunk (fast paste without bracketed paste)', () => {
  const { forward, events } = feedAll(['/inject hello there\r']);
  assert.equal(forward, '');
  assert.equal(events.at(-1).text, 'hello there');
});

test('/inject mid-line is just text', () => {
  const { forward, events } = feedAll(keys('see /inject docs\r'));
  assert.equal(forward, 'see /inject docs\r');
  assert.deepEqual(events, []);
});

test('detection resumes after Enter and after backspacing to empty', () => {
  const { forward, events } = feedAll(keys('ab\x7f\x7f/inject x\r'));
  assert.equal(forward, 'ab\x7f\x7f');
  assert.equal(events.at(-1).text, 'x');
});

test('unknown editing (arrow keys) pauses detection until Enter', () => {
  const it = new Interceptor();
  let r = feedAll(['\x1b[A', ...keys('/inject x')], it);
  assert.equal(r.forward, '\x1b[A/inject x');
  r = feedAll(keys('\r/inject y\r'), it);
  assert.equal(r.forward, '\r');
  assert.equal(r.events.at(-1).text, 'y');
});

test('Esc while capturing cancels without forwarding Esc', () => {
  const { forward, events } = feedAll([...keys('/inject abc'), '\x1b']);
  assert.equal(forward, '');
  assert.deepEqual(events.at(-1), { type: 'cancel' });
});

test('Ctrl+C on a held prefix is swallowed, not sent to the agent', () => {
  const { forward } = feedAll([...keys('/inj'), '\x03', ...keys('ok\r')]);
  assert.equal(forward, 'ok\r');
});

test('backspace inside capture edits; backspace on empty cancels', () => {
  const { forward, events } = feedAll([...keys('/inject ab\x7f'), '\r']);
  assert.equal(forward, '');
  assert.equal(events.at(-1).text, 'a');
  const r2 = feedAll(keys('/inject \x7f'));
  assert.deepEqual(r2.events.at(-1), { type: 'cancel' });
});

test('bare /inject + Enter shows usage instead of reaching the agent', () => {
  const { forward, events } = feedAll(keys('/inject\r'));
  assert.equal(forward, '');
  assert.deepEqual(events, [{ type: 'usage' }]);
});

test('bracketed paste inside capture becomes one line', () => {
  const { events } = feedAll([...keys('/inject '), '\x1b[200~line1\nline2\x1b[201~', '\r']);
  assert.equal(events.at(-1).text, 'line1 line2');
});

test('kitty keyboard protocol Enter and Esc are understood', () => {
  let r = feedAll([...keys('/inject hi'), '\x1b[13u']);
  assert.equal(r.events.at(-1).text, 'hi');
  r = feedAll([...keys('/inject hi'), '\x1b[27u']);
  assert.deepEqual(r.events.at(-1), { type: 'cancel' });
});

test('emoji and multibyte text survive', () => {
  const { events } = feedAll([...'/inject 用 pnpm 🚀'.split(''), '\r']);
  assert.equal(events.at(-1).text, '用 pnpm 🚀');
});

const paste = (s) => `\x1b[200~${s}\x1b[201~`;

test('pasted /inject line is captured, then Enter submits it', () => {
  const { forward, events } = feedAll([paste('/inject make every line rhyme'), '\r']);
  assert.equal(forward, '');
  assert.deepEqual(events.at(-1), { type: 'submit', urgency: 'normal', text: 'make every line rhyme' });
});

test('pasted /inject! with a trailing newline is urgent and trimmed', () => {
  const { forward, events } = feedAll([paste('/inject! stop now\n'), '\r']);
  assert.equal(forward, '');
  assert.deepEqual(events.at(-1), { type: 'submit', urgency: 'urgent', text: 'stop now' });
});

test('pasted "/inject" alone waits for the rest to be typed', () => {
  const { forward, events } = feedAll([paste('/inject'), ...keys(' x\r')]);
  assert.equal(forward, '');
  assert.equal(events.at(-1).text, 'x');
});

test('other pastes still go to the agent untouched', () => {
  for (const p of [paste('/init'), paste('fix the bug'), paste('see /inject docs')]) {
    const { forward, events } = feedAll([p, '\r']);
    assert.equal(forward, p + '\r');
    assert.deepEqual(events, []);
  }
});

test('focus changes (switching windows to copy text) do not stop detection', () => {
  const { forward, events } = feedAll(['\x1b[O', '\x1b[I', ...keys('/inject x'), '\x1b[O', '\x1b[I', '\r']);
  assert.equal(forward, '\x1b[O\x1b[I\x1b[O\x1b[I', 'focus reports still reach the agent');
  assert.deepEqual(events.at(-1), { type: 'submit', urgency: 'normal', text: 'x' });
});

test('focus change then paste, the exact sequence from a real session', () => {
  const { forward, events } = feedAll(['\x1b[I', '\x1b[200~/inject! stop now\x1b[201~', '\r']);
  assert.equal(forward, '\x1b[I');
  assert.deepEqual(events.at(-1), { type: 'submit', urgency: 'urgent', text: 'stop now' });
});

test('mouse events and terminal query replies do not stop detection', () => {
  const replies = ['\x1b[<64;10;5M', '\x1b[?0u', '\x1b[?62;22c', '\x1b]11;rgb:0000/0000/0000\x1b\\', '\x1b[?2026;2$y', '\x1b[12;40R'];
  const { forward, events } = feedAll([...replies, ...keys('/inject y\r')]);
  assert.equal(forward, replies.join(''));
  assert.equal(events.at(-1).text, 'y');
});

test('printable keys sent as kitty or modifyOtherKeys codes are understood', () => {
  // "/inject! hi" with "/" as kitty CSI 47u and "!" as Shift+1 in both encodings
  const kittySlash = '\x1b[47u';
  let r = feedAll([kittySlash, ...keys('inject'), '\x1b[49:33;2u', ...keys(' hi\r')]);
  assert.equal(r.forward, '');
  assert.deepEqual(r.events.at(-1), { type: 'submit', urgency: 'urgent', text: 'hi' });
  r = feedAll([...keys('/inject'), '\x1b[27;2;33~', ...keys(' hi\r')]);
  assert.deepEqual(r.events.at(-1), { type: 'submit', urgency: 'urgent', text: 'hi' });
});

test('held keys are released byte-for-byte when they turn out not to be /inject', () => {
  const { forward } = feedAll(['\x1b[47u', ...keys('init\r')]);
  assert.equal(forward, '\x1b[47uinit\r');
});
