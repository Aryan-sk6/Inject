// In-memory message queue owned by the wrapper process.
//
// Node runs the socket handlers one at a time, so a claim is atomic: when the
// agent fires several hooks at once (parallel tool calls), exactly one of them
// receives a given message.

import { setFlag } from './session.js';

let nextId = 1;

export class Queue {
  /** @param {string} dir session directory whose flag files mirror the queue */
  constructor(dir) {
    this.dir = dir;
    /** @type {{id:number,text:string,urgency:'normal'|'urgent',queuedAt:string}[]} */
    this.items = [];
  }

  add(text, urgency) {
    const msg = { id: nextId++, text, urgency, queuedAt: new Date().toISOString() };
    this.items.push(msg);
    this.syncFlags();
    return msg;
  }

  /**
   * 'before-tool': if any urgent message is queued, take everything (the tool
   *   call is about to be denied, so pending notes ride along with the reason).
   *   Otherwise take nothing.
   * 'after-tool': take the normal notes; urgent messages wait for the next
   *   tool call so they can block it.
   */
  claim(boundary) {
    let taken;
    if (boundary === 'before-tool') {
      taken = this.items.some((m) => m.urgency === 'urgent') ? this.items : [];
    } else {
      taken = this.items.filter((m) => m.urgency === 'normal');
    }
    if (taken.length) {
      const ids = new Set(taken.map((m) => m.id));
      this.items = this.items.filter((m) => !ids.has(m.id));
      this.syncFlags();
    }
    return taken;
  }

  get size() {
    return this.items.length;
  }

  syncFlags() {
    setFlag(this.dir, 'normal', this.items.some((m) => m.urgency === 'normal'));
    setFlag(this.dir, 'urgent', this.items.some((m) => m.urgency === 'urgent'));
  }
}
