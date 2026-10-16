// One-line status overlay drawn on the terminal's bottom row, on top of the
// agent's UI. The agent repaints its screen often, so we redraw after its
// output settles, and only when its output isn't stopped mid escape sequence.

const ESC = '\x1b';
const SAVE = `${ESC}7`;
const RESTORE = `${ESC}8`;
const RESET = `${ESC}[0m`;
const LABEL = `${ESC}[1;30;46m`; // bold black on cyan
const LABEL_URGENT = `${ESC}[1;97;41m`; // bold white on red
const DIM = `${ESC}[2m`;
const OK = `${ESC}[32m`;

const TOAST_MS = 4000;

export class Overlay {
  /** @param {NodeJS.WriteStream} out */
  constructor(out) {
    this.out = out;
    /** @type {{urgency:string,text:string}|null} */
    this.input = null;
    /** @type {{text:string, until:number}|null} */
    this.toastMsg = null;
    this.pending = 0;
    this.visible = false;
    this.childState = 'text';
    this.timer = null;
    this.toastTimer = null;
  }

  editing(urgency, text) {
    this.input = { urgency, text };
    this.draw();
  }

  stopEditing() {
    this.input = null;
    this.draw();
  }

  toast(text) {
    this.toastMsg = { text, until: Date.now() + TOAST_MS };
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toastMsg = null;
      this.draw();
    }, TOAST_MS);
    this.toastTimer.unref?.();
    this.draw();
  }

  setPending(n) {
    this.pending = n;
    this.draw();
  }

  /** Call after forwarding agent output to the terminal. */
  afterOutput(chunk) {
    this.childState = scanEscapeState(chunk, this.childState);
    if (!this.visible && !this.content()) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.draw(), 30);
    this.timer.unref?.();
  }

  content() {
    const cols = this.out.columns || 80;
    if (this.input) {
      const urgent = this.input.urgency === 'urgent';
      const label = urgent ? `${LABEL_URGENT} inject! ${RESET}` : `${LABEL} inject ${RESET}`;
      const hint = `${DIM}  Enter send · Esc cancel${RESET}`;
      const room = Math.max(10, cols - 9 - 2 - 24);
      let text = this.input.text;
      if (text.length > room) text = '…' + text.slice(text.length - room + 1);
      return `${label} ${text}█${hint}`;
    }
    if (this.toastMsg) {
      return clip(this.toastMsg.text, cols - 1);
    }
    if (this.pending > 0) {
      const pill = `${LABEL} inject ${RESET}${DIM} ${this.pending} queued · delivers at next step${RESET}`;
      return pill;
    }
    return '';
  }

  draw() {
    if (this.childState !== 'text') {
      // Don't split the agent's escape sequence; afterOutput() retries.
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.draw(), 30);
      this.timer.unref?.();
      return;
    }
    const rows = this.out.rows || 24;
    const content = this.content();
    if (!content && !this.visible) return;
    this.out.write(`${SAVE}${ESC}[${rows};1H${ESC}[2K${content}${RESET}${RESTORE}`);
    this.visible = Boolean(content);
  }
}

export function queuedToast(urgency) {
  return urgency === 'urgent'
    ? `${LABEL_URGENT} inject! ${RESET} queued · will block the next tool call`
    : `${LABEL} inject ${RESET} queued · delivers at next step`;
}

export function deliveredToast(count, urgent, doing) {
  const what = urgent ? 'blocked the tool call and delivered' : 'delivered';
  const n = count === 1 ? '' : ` ${count} messages`;
  const where = doing ? `${DIM} (${doing})${RESET}` : '';
  return `${OK}✓${RESET} inject: ${what}${n}${where}`;
}

export function usageToast() {
  return `${LABEL} inject ${RESET} usage: /inject <note>   ·   /inject! <urgent: blocks the next tool call>`;
}

// Strip SGR codes for length math; content is short so a rough clip is fine.
function clip(s, max) {
  const plain = s.replace(/\x1b\[[0-9;]*m/g, '');
  if (plain.length <= max) return s;
  return plain.slice(0, Math.max(0, max - 1)) + '…';
}

/**
 * Tracks whether the agent's output stream is inside an escape sequence, so
 * the overlay never writes into the middle of one. Pass the returned state
 * back in with the next chunk. Covers CSI, two-byte escapes, and OSC/DCS/APC
 * strings terminated by BEL or ST.
 */
export function scanEscapeState(chunk, state = 'text') {
  for (let i = 0; i < chunk.length; i++) {
    const c = chunk.charCodeAt(i);
    switch (state) {
      case 'text':
        if (c === 0x1b) state = 'esc';
        break;
      case 'esc':
        if (c === 0x5b) state = 'csi'; // [
        else if (c === 0x5d || c === 0x50 || c === 0x5f || c === 0x5e) state = 'str'; // ] P _ ^
        else state = 'text';
        break;
      case 'csi':
        if (c >= 0x40 && c <= 0x7e) state = 'text';
        break;
      case 'str':
        if (c === 0x07) state = 'text';
        else if (c === 0x1b) state = 'strEsc';
        break;
      case 'strEsc':
        state = c === 0x5c ? 'text' : 'str';
        break;
    }
  }
  return state;
}
