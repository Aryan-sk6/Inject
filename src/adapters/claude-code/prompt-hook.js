// Claude Code UserPromptSubmit hook. Runs in every session, with or without
// the inject wrapper, once per prompt you send.
//
// 1. Plain `claude` (no wrapper): "/inject <msg>" is blocked so Claude never
//    sees the text, and the message is queued for the next tool boundary.
//    "/inject!" is refused: urgent mode needs the wrapper.
// 2. Any other prompt typed while Claude is working goes into Claude Code's own
//    queue; those are logged to .steer/fixes.jsonl.
//
// Never throws; any failure exits 0 and lets the prompt through unchanged.

import { handlePrompt } from './prompt.js';

async function main() {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  const out = handlePrompt(JSON.parse(data), { projectDir: process.env.CLAUDE_PROJECT_DIR });
  if (out) process.stdout.write(out);
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
