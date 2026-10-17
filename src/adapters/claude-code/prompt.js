// Decides what the UserPromptSubmit hook does with a prompt. See prompt-hook.js.
//
// It only logs messages typed into Claude Code's own queue mid-turn. It never
// blocks or changes a prompt. (/inject is handled by the mod, not here.)

import { recordPrompt } from './steering.js';

/** @returns {null} the hook prints nothing */
export function handlePrompt(input, { projectDir } = {}) {
  // /inject commands are queued and logged by the mod and the tool hooks.
  if (typeof input.prompt === 'string' && /^\s*\/inject\b/.test(input.prompt)) return null;
  recordPrompt(input, { projectDir });
  return null;
}
