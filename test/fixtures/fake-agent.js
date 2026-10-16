// Stands in for `claude` in end-to-end tests: records its environment and
// every byte it receives on stdin to $FAKE_LOG.
import fs from 'node:fs';

const log = process.env.FAKE_LOG;
fs.writeFileSync(log, JSON.stringify({ dir: process.env.INJECT_DIR, node: process.env.INJECT_NODE }) + '\n');
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  fs.appendFileSync(log, JSON.stringify({ input: d }) + '\n');
  if (d.includes('\x04')) process.exit(7);
});
process.stdout.write('fake agent ready\r\n');
