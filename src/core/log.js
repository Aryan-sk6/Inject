// Appends one JSON line per injected message to <project>/.steer/fixes.jsonl.

import fs from 'node:fs';
import path from 'node:path';

export function logPath(projectDir) {
  return path.join(projectDir, '.steer', 'fixes.jsonl');
}

/**
 * @param {string} projectDir
 * @param {{text:string, urgency:string, queuedAt:string}} msg
 * @param {{agent?:string, deliveredAt?:string|null, event?:string|null,
 *          doing?:string|null, sessionId?:string|null}} delivery
 */
export function appendFix(projectDir, msg, delivery) {
  const record = {
    ts: msg.queuedAt,
    text: msg.text,
    urgency: msg.urgency,
    agent: delivery.agent ?? null,
    delivered_at: delivery.deliveredAt ?? null,
    delivered_via: delivery.event ?? null,
    doing: delivery.doing ?? null,
    session_id: delivery.sessionId ?? null,
  };
  try {
    fs.mkdirSync(path.dirname(logPath(projectDir)), { recursive: true });
    fs.appendFileSync(logPath(projectDir), JSON.stringify(record) + '\n');
    return true;
  } catch {
    return false;
  }
}
