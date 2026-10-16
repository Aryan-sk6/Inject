// Decides what the UserPromptSubmit hook does with a prompt. See prompt-hook.js.

import { ENV_DIR } from '../../core/session.js';
import { enqueue, parseInjectPrompt } from './plain.js';
import { recordPrompt } from './steering.js';

const block = (reason) => JSON.stringify({ decision: 'block', reason });

/** @returns {string|null} hook stdout, if any */
export function handlePrompt(input, { wrapped = Boolean(process.env[ENV_DIR]), projectDir } = {}) {
  const cmd = typeof input.prompt === 'string' ? parseInjectPrompt(input.prompt) : null;

  // Inside the wrapper, "/inject" never reaches Claude Code; if it does (e.g.
  // wrapper detection was paused), let it through rather than swallow it.
  if (cmd && !wrapped) {
    if (!cmd.text) {
      return block('inject: usage is `/inject <message>`. The message is delivered to Claude at its next tool call.');
    }
    if (cmd.urgent) {
      return block(
        'inject: `/inject!` (urgent, blocks the next tool call) only works when you start Claude with `inject` instead of `claude`. ' +
          'Nothing was sent. Use `/inject <message>` here.',
      );
    }
    const ok = enqueue(input.session_id, cmd.text, { projectDir: projectDir || input.cwd });
    return block(
      ok
        ? 'inject: queued, delivers at Claude\'s next tool call.'
        : 'inject: could not queue this message (no session id). Nothing was sent.',
    );
  }

  recordPrompt(input, { projectDir });
  return null;
}
