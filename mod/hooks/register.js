// inject, inside Claude Code: adds /inject <message> to plain `claude` sessions.
//
// A hook can't do this: Claude Code answers "Unknown command: /inject" itself,
// before UserPromptSubmit fires, and holds a command typed mid-turn until the
// turn ends. A mod can register a real command with immediate: true, which runs
// at once even while Claude is working.
//
// The command only queues the message: it appends a line to
// <config dir>/inject-pending/<session id>.jsonl. inject's PostToolUse hook
// (src/adapters/claude-code/hook.js) claims that file after Claude's next tool
// call, adds the message to Claude's context and logs it to .steer/fixes.jsonl.
// Urgent mode (/inject! blocking the next tool call) needs the `inject` wrapper.

const MAX_LENGTH = 2000

// Keep in sync with pendingDir() in src/adapters/claude-code/plain.js and the
// shell guard in install.js.
async function pendingDir($) {
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  if (config) return config + '/inject-pending'
  const home = await $.env.get('HOME')
  return (home || '') + '/.claude/inject-pending'
}

async function queue($, text) {
  const id = await $.session.id()
  const cwd = await $.session.cwd()
  if (!id || !/^[\w-]+$/.test(id)) throw new Error('no session id')
  const file = (await pendingDir($)) + '/' + id + '.jsonl'
  let before = ''
  try {
    before = await $.fs.read(file)
  } catch {
    // First message of this session.
  }
  const record = { text, queuedAt: new Date().toISOString(), projectDir: cwd || null }
  await $.fs.write(file, before + JSON.stringify(record) + '\n')
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'inject',
        description: 'Send Claude a note; it reads it at its next tool call, without being interrupted',
        argumentHint: '<message>',
        immediate: true,
      })
    } catch {
      // Name taken: leave the session alone.
    }
    return next(e)
  })

  on('command.run', { command: 'inject' }, async ($, e) => {
    const text = (e.args || '').replace(/\s+/g, ' ').trim().slice(0, MAX_LENGTH)
    if (!text) {
      $.ui.toast('inject: usage is /inject <message>')
      return {}
    }
    try {
      await queue($, text)
      $.ui.toast('inject: queued, delivers at the next step')
    } catch (err) {
      $.ui.toast('inject: could not queue the message (' + (err && err.message ? err.message : err) + ')')
    }
    return {}
  })
}
