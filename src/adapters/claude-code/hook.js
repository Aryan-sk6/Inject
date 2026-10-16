// Claude Code hook entry point: node hook.js <HookEventName>
//
// Registered for PreToolUse (urgent: deny the call, reason goes to Claude)
// and PostToolUse / PostToolUseFailure (normal: additionalContext).
// With the wrapper, messages come from its socket ($INJECT_DIR); without it,
// from the pending file written by the UserPromptSubmit hook (plain.js).
// See https://code.claude.com/docs/en/hooks
//
// Any failure exits 0 with no output, so a missing or crashed wrapper never
// gets in Claude's way.

import { request } from '../../core/ipc.js';
import { appendFix } from '../../core/log.js';
import { ENV_DIR, socketPath } from '../../core/session.js';
import { BOUNDARY, buildOutput, describeTool } from './output.js';
import { claim } from './plain.js';

async function readStdin() {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function main() {
  const event = process.argv[2];
  const dir = process.env[ENV_DIR];
  if (!BOUNDARY[event]) return;
  if (!dir && BOUNDARY[event] === 'before-tool') return; // urgent needs the wrapper

  let input = {};
  try {
    input = JSON.parse(await readStdin());
  } catch {
    // Claim anyway; we just lose the "doing" detail.
  }

  const boundary = BOUNDARY[event];
  const tool = describeTool(input.tool_name, input.tool_input);
  const doing = tool ? `${boundary === 'before-tool' ? 'about to run' : 'just ran'} ${tool}` : null;

  if (!dir) return deliverPlain(event, input, doing);

  const reply = await request(socketPath(dir), {
    op: 'claim',
    boundary,
    agent: 'claude-code',
    event,
    doing,
    projectDir: process.env.CLAUDE_PROJECT_DIR || input.cwd || null,
    sessionId: input.session_id || null,
  });

  const out = buildOutput(event, reply.messages || []);
  if (out) process.stdout.write(JSON.stringify(out));
}

// Plain `claude` (no wrapper): messages queued by the UserPromptSubmit hook.
function deliverPlain(event, input, doing) {
  const messages = claim(input.session_id);
  if (!messages.length) return;
  const deliveredAt = new Date().toISOString();
  for (const m of messages) {
    appendFix(m.projectDir || process.env.CLAUDE_PROJECT_DIR || input.cwd, m, {
      agent: 'claude-code',
      deliveredAt,
      event,
      doing,
      sessionId: input.session_id,
    });
  }
  process.stdout.write(JSON.stringify(buildOutput(event, messages)));
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
