// Claude Code UserPromptSubmit hook: logs messages typed mid-turn into Claude
// Code's own queue. Runs in every session, with or without the inject
// wrapper. Prints nothing and always exits 0, so it never changes or blocks
// a prompt.

import { recordPrompt } from './steering.js';

async function main() {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  recordPrompt(JSON.parse(data), { projectDir: process.env.CLAUDE_PROJECT_DIR });
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
