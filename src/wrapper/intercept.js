// Keystroke interceptor. Pure logic, no I/O: feed() takes raw terminal input
// and returns what to forward to the agent plus UI events.
//
// The agent never sees "/inject ..." lines. To make that work without seeing
// the agent's input box, we keep a shadow copy of what the user typed since the
// last submit. When that copy is empty and the user starts typing a prefix of
// "/inject " or "/inject! ", we hold the keys back. If the prefix completes we
// switch to capture mode; if it diverges ("/init") we forward the held keys
// unchanged, so the agent sees exactly what was typed.
//
// Cursor keys, tab completion and other editing we can't model make the shadow
// copy unknown; detection then pauses until the next Enter or Ctrl+C. Things
// the terminal reports on its own (focus changes, mouse, replies to the
// agent's queries) are forwarded without affecting detection.

export const TRIGGERS = [
  { prefix: '/inject! ', urgency: 'urgent' },
  { prefix: '/inject ', urgency: 'normal' },
];
const BARE_WORDS = ['/inject', '/inject!'];

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

// ---------------------------------------------------------------------------
// Tokenizer

/**
 * @typedef {{kind:'char', ch:string, raw:string}
 *   | {kind:'key', key:string, raw:string}
 *   | {kind:'paste', text:string, raw:string}
 *   | {kind:'report', raw:string}
 *   | {kind:'other', raw:string}} Token
 */

// Keys reported through the kitty keyboard protocol (CSI <code>;<mods> u) or
// xterm modifyOtherKeys (CSI 27;<mods>;<code> ~), which terminals use when the
// agent turns them on.
function decodeModifiedKey(code, mods) {
  const m = (mods || 1) - 1; // bit 0 shift, bit 2 ctrl
  const shift = m & 1;
  const ctrl = m & 4;
  if (code === 13) return shift || ctrl ? 'newline' : m === 0 ? 'enter' : null;
  if (code === 27 && m === 0) return 'escape';
  if (code === 127 || code === 8) return m === 0 ? 'backspace' : null;
  if (ctrl && (code === 99 || code === 67)) return 'ctrl-c';
  if (ctrl && (code === 117 || code === 85)) return 'ctrl-u';
  return null;
}

function keyForControl(ch) {
  switch (ch) {
    case '\r': return 'enter';
    case '\n': return 'newline';
    case '\x7f':
    case '\b': return 'backspace';
    case '\x03': return 'ctrl-c';
    case '\x15': return 'ctrl-u';
    default: return null;
  }
}

class Tokenizer {
  constructor() {
    this.paste = null; // accumulated paste text while inside a bracketed paste
  }

  /** @returns {Token[]} */
  tokens(data) {
    const out = [];
    let i = 0;
    while (i < data.length) {
      if (this.paste !== null) {
        const end = data.indexOf(PASTE_END, i);
        if (end === -1) {
          this.paste += data.slice(i);
          break;
        }
        const text = this.paste + data.slice(i, end);
        this.paste = null;
        out.push({ kind: 'paste', text, raw: PASTE_START + text + PASTE_END });
        i = end + PASTE_END.length;
        continue;
      }
      if (data.startsWith(PASTE_START, i)) {
        this.paste = '';
        i += PASTE_START.length;
        continue;
      }
      const ch = data[i];
      if (ch === '\x1b') {
        const len = escapeLength(data, i);
        const raw = data.slice(i, i + len);
        out.push(classifyEscape(raw));
        i += len;
        continue;
      }
      const cp = data.codePointAt(i);
      const s = String.fromCodePoint(cp);
      i += s.length;
      const key = keyForControl(s);
      if (key) out.push({ kind: 'key', key, raw: s });
      else if (cp < 0x20) out.push({ kind: 'other', raw: s });
      else out.push({ kind: 'char', ch: s, raw: s });
    }
    return out;
  }
}

function escapeLength(data, i) {
  const next = data[i + 1];
  if (next === undefined) return 1; // lone Esc
  if (next === '[') {
    let j = i + 2;
    while (j < data.length) {
      const c = data.charCodeAt(j);
      if (c >= 0x40 && c <= 0x7e) return j - i + 1;
      j++;
    }
    return data.length - i;
  }
  if (next === 'O') return Math.min(3, data.length - i);
  if (next === ']' || next === 'P' || next === '_' || next === '^') {
    // OSC / DCS / APC / PM string, ended by BEL or ST (ESC \)
    for (let j = i + 2; j < data.length; j++) {
      if (data[j] === '\x07') return j - i + 1;
      if (data[j] === '\x1b' && data[j + 1] === '\\') return j - i + 2;
    }
    return data.length - i;
  }
  if (next === '\x1b') return 1; // Esc followed by another escape sequence
  // Alt+<char>: one code point after Esc
  return 1 + String.fromCodePoint(data.codePointAt(i + 1)).length;
}

// Input the terminal sends on its own rather than because a key was pressed.
function isReport(raw) {
  const intro = raw[1];
  if (intro === ']' || intro === 'P' || intro === '_' || intro === '^') return true; // query replies
  if (intro !== '[') return false;
  if (raw === '\x1b[I' || raw === '\x1b[O') return true; // focus in / out
  if (/^\x1b\[<[\d;]*[Mm]$/.test(raw)) return true; // SGR mouse
  if (/^\x1b\[\?[\d;]*[uc]$/.test(raw)) return true; // keyboard-flags / device-attributes replies
  if (/^\x1b\[[\d;?]*\$y$/.test(raw)) return true; // mode report
  if (/^\x1b\[\d+;\d+R$/.test(raw)) return true; // cursor position report
  if (/^\x1b\[\d*n$/.test(raw)) return true; // status report
  return false;
}

// A printable character sent as an escape code (kitty protocol or
// modifyOtherKeys), with no modifier other than Shift.
function printable(code, mods, shifted) {
  const m = (mods || 1) - 1;
  if (m & ~1) return null;
  const cp = m === 1 && shifted ? shifted : code;
  if (cp < 0x20 || cp === 0x7f || cp > 0x10ffff) return null;
  const ch = String.fromCodePoint(cp);
  return m === 1 && !shifted && /^[a-z]$/.test(ch) ? ch.toUpperCase() : ch;
}

function classifyEscape(raw) {
  if (raw === '\x1b') return { kind: 'key', key: 'escape', raw };
  if (isReport(raw)) return { kind: 'report', raw };
  // kitty: CSI code[:shifted[:base]] [;mods[:event]] [;text] u
  let m = /^\x1b\[(\d+)(?::(\d*))?(?::\d*)?(?:;(\d+)(?::\d+)?)?(?:;[\d:]*)?u$/.exec(raw);
  if (m) {
    const code = Number(m[1]);
    const mods = Number(m[3] || 1);
    const key = decodeModifiedKey(code, mods);
    if (key) return { kind: 'key', key, raw };
    const ch = printable(code, mods, m[2] ? Number(m[2]) : 0);
    if (ch) return { kind: 'char', ch, raw };
  }
  // xterm modifyOtherKeys: CSI 27 ; mods ; code ~
  m = /^\x1b\[27;(\d+);(\d+)~$/.exec(raw);
  if (m) {
    const key = decodeModifiedKey(Number(m[2]), Number(m[1]));
    if (key) return { kind: 'key', key, raw };
    const ch = printable(Number(m[2]), 1, 0);
    if (ch && Number(m[1]) <= 2) return { kind: 'char', ch, raw };
  }
  if (raw === '\x1b\r') return { kind: 'key', key: 'newline', raw }; // Alt+Enter
  return { kind: 'other', raw };
}

function oneLine(text) {
  return text.replace(/\r\n|\r|\n/g, ' ');
}

// ---------------------------------------------------------------------------
// Interceptor

/**
 * @typedef {{type:'capture', urgency:string, text:string}
 *   | {type:'submit', urgency:string, text:string}
 *   | {type:'cancel'}
 *   | {type:'usage'}} InterceptEvent
 */

export class Interceptor {
  constructor() {
    this.tokenizer = new Tokenizer();
    /** Shadow of the agent's input since the last submit; null when unknown. */
    this.line = '';
    /** Keys held back because they could still become a trigger. */
    this.heldToks = [];
    /** @type {{urgency:string, text:string} | null} */
    this.capture = null;
  }

  get capturing() {
    return this.capture !== null;
  }

  get held() {
    return this.heldToks.map((t) => (t.kind === 'paste' ? t.text : t.ch)).join('');
  }

  /** @returns {{forward:string, events:InterceptEvent[]}} */
  feed(data) {
    const res = { forward: '', events: [] };
    for (const tok of this.tokenizer.tokens(data)) {
      // Always pass terminal reports through: the agent may be waiting on them.
      if (tok.kind === 'report') res.forward += tok.raw;
      else if (this.capture) this.captureToken(tok, res);
      else this.passToken(tok, res);
    }
    return res;
  }

  passToken(tok, res) {
    const held = this.held;
    if (held || this.line === '') {
      if (tok.kind === 'char' || tok.kind === 'paste') {
        // A pasted "/inject ..." (e.g. copied from docs) is captured just like
        // a typed one; the rest of the paste lands in the one-line editor.
        const cand = held + (tok.kind === 'paste' ? tok.text : tok.ch);
        const trigger = TRIGGERS.find((t) => cand.startsWith(t.prefix));
        if (trigger) {
          this.heldToks = [];
          const text = oneLine(cand.slice(trigger.prefix.length));
          this.capture = { urgency: trigger.urgency, text };
          res.events.push({ type: 'capture', urgency: trigger.urgency, text });
          return;
        }
        if (TRIGGERS.some((t) => t.prefix.startsWith(cand))) {
          this.heldToks.push(tok);
          return;
        }
      }
      if (held && tok.kind === 'key') {
        if (tok.key === 'enter' && BARE_WORDS.includes(held)) {
          this.heldToks = [];
          res.events.push({ type: 'usage' });
          return;
        }
        if (tok.key === 'backspace') {
          const last = this.heldToks.pop();
          if (last.kind === 'paste' && last.text.length > 1) {
            const text = last.text.slice(0, -1);
            this.heldToks.push({ kind: 'paste', text, raw: text });
          }
          return;
        }
        if (tok.key === 'escape' || tok.key === 'ctrl-c') {
          // The agent never saw the held keys, so dropping them is the whole
          // cancel. Don't forward: Esc / Ctrl+C would interrupt the agent.
          this.heldToks = [];
          return;
        }
      }
      // Not a trigger: release the held keys exactly as they were typed.
      for (const t of this.heldToks) {
        res.forward += t.raw;
        this.track(t);
      }
      this.heldToks = [];
    }

    res.forward += tok.raw;
    this.track(tok);
  }

  track(tok) {
    if (tok.kind === 'key') {
      switch (tok.key) {
        case 'enter':
        case 'ctrl-c':
        case 'ctrl-u':
          this.line = '';
          return;
        case 'newline':
          if (this.line !== null) this.line += '\n';
          return;
        case 'backspace':
          if (this.line !== null) this.line = this.line.slice(0, -1);
          return;
        default:
          this.line = null; // Esc may clear, recall or interrupt; we can't tell
          return;
      }
    }
    if (this.line === null) return;
    if (tok.kind === 'char') this.line += tok.ch;
    else if (tok.kind === 'paste') this.line += tok.text;
    else this.line = null;
  }

  captureToken(tok, res) {
    const c = this.capture;
    if (tok.kind === 'char') c.text += tok.ch;
    else if (tok.kind === 'paste') c.text += oneLine(tok.text);
    else if (tok.kind === 'key') {
      switch (tok.key) {
        case 'enter': {
          this.capture = null;
          this.line = '';
          const text = c.text.trim();
          res.events.push(text ? { type: 'submit', urgency: c.urgency, text } : { type: 'cancel' });
          return;
        }
        case 'newline':
          c.text += ' ';
          break;
        case 'backspace':
          if (c.text === '') return this.cancel(res);
          c.text = Array.from(c.text).slice(0, -1).join('');
          break;
        case 'ctrl-u':
          c.text = '';
          break;
        case 'escape':
        case 'ctrl-c':
          return this.cancel(res);
        default:
          return;
      }
    } else {
      return; // cursor keys etc. are ignored in the one-line editor
    }
    res.events.push({ type: 'capture', urgency: c.urgency, text: c.text });
  }

  cancel(res) {
    this.capture = null;
    this.line = '';
    res.events.push({ type: 'cancel' });
  }
}
