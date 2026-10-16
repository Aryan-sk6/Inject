// Turns claimed messages into Claude Code hook output.

import { formatNotes, formatUrgent } from '../../core/format.js';

export const BOUNDARY = {
  PreToolUse: 'before-tool',
  PostToolUse: 'after-tool',
  PostToolUseFailure: 'after-tool',
};

/** Short description of a tool call, e.g. "Bash: npm test". */
export function describeTool(name, input) {
  if (!name) return null;
  const i = input || {};
  const detail = i.command ?? i.file_path ?? i.notebook_path ?? i.path ?? i.pattern ?? i.url ?? i.query ?? i.description;
  if (detail == null) return name;
  const s = String(detail).replace(/\s+/g, ' ').trim();
  return `${name}: ${s.length > 120 ? s.slice(0, 119) + '…' : s}`;
}

/** Turn claimed messages into Claude Code hook output (null = no output). */
export function buildOutput(event, messages) {
  if (!messages.length) return null;
  if (BOUNDARY[event] === 'before-tool') {
    return {
      hookSpecificOutput: {
        hookEventName: event,
        permissionDecision: 'deny',
        permissionDecisionReason: formatUrgent(messages),
      },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: formatNotes(messages),
    },
  };
}
