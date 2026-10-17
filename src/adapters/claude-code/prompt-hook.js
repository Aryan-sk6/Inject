// Claude Code UserPromptSubmit hook. Runs in every session, with or without
// the inject wrapper, once per prompt you send.
//
// Logs prompts typed while Claude is working (they go into Claude Code's own
// queue) to .steer/fixes.jsonl. Prints nothing; never blocks or changes a prompt.
// Never throws; any failure exits 0.

import { handlePrompt } from './prompt.js';

async function main() {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  handlePrompt(JSON.parse(data), { projectDir: process.env.CLAUDE_PROJECT_DIR });
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
