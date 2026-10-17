# inject

<img width="800" height="500" alt="ezgif-825eae4d6b687d00" src="https://github.com/user-attachments/assets/ca05823c-99ae-4c70-b605-27cf69f3743c" />


Steer Claude Code while it works, in the same terminal window.

Run `inject` instead of `claude`. While Claude is mid-task, type:

```
/inject use pnpm, not npm
/inject! stop, don't touch the v1 routes
```

The line never reaches Claude Code's input box. It goes into a local queue,
and a Claude Code hook delivers it at the next tool boundary, without stopping
the agent. Every message is logged to `.steer/fixes.jsonl`.

`/inject <msg>` also works if you start plain `claude` instead of `inject`
(`inject --install` adds a small Claude Code plugin for that), without urgent
mode. See [Plain `claude` sessions](#plain-claude-sessions).

| You type | Urgency | Delivered | What Claude sees | `inject` | plain `claude` |
| --- | --- | --- | --- | :-: | :-: |
| `/inject <msg>` | normal | after the current tool call finishes | extra context next to the tool result | yes | yes |
| `/inject! <msg>` | urgent | before the next tool call runs | that call is **blocked** and the message is the reason | yes | no |

## Quickstart

1. **Install** (Node 18+, macOS, Linux, or Windows via WSL2):

   ```bash
   npm install -g .
   ```

   Run this from a clone of this repository. The package isn't on npm yet.
   Once it is published it will be `npm install -g inject-steer`.

2. **Register the hooks and the `/inject` command** (one time, and again after
   upgrading inject). It edits `~/.claude/settings.json` (keeping a backup) and
   installs a small Claude Code plugin with `claude plugin install`, so the
   `claude` command must be on your PATH:

   ```bash
   inject --install
   ```

3. **Use `inject` wherever you'd use `claude`.** All arguments pass through
   (`inject --resume`, `inject --model opus`, ...). While Claude works, type
   `/inject <message>` or `/inject! <message>` and press Enter.

   Prefer to keep typing `claude`? After step 2, start a new `claude` session and
   `/inject <message>` works there too, just without urgent mode.

## What you'll see

- While typing a message, a bar at the bottom of the terminal shows what
  you're writing. **Enter** queues it and **Esc** cancels. Claude never sees
  the keystrokes.
- After Enter: `queued · delivers at next step` (normal) or
  `queued · will block the next tool call` (urgent). A small
  `N queued` marker stays until the message is picked up.
- On delivery: `✓ inject: delivered (just ran Bash: npm test)`.
- If Claude Code exits with messages still queued, inject prints them and
  logs them with `"delivered_at": null`.

## How it works

```
  keyboard ──► inject (node-pty) ──────────────► claude
                 │  "/inject ..." lines                ▲  hooks inherit INJECT_DIR
                 ▼  are held back                      │
           queue + unix socket  ◄──── claim ──── hook (PreToolUse / PostToolUse)
           $INJECT_DIR/sock                            │
                 │                                     └─► JSON back to Claude Code
                 └─► .steer/fixes.jsonl
```

- **Wrapper** (`src/wrapper/`): starts the agent in a pseudo-terminal and
  passes every byte through unchanged. It keeps a shadow copy of what you've
  typed since the last Enter. When that copy is empty and you start typing
  `/inject`, the keys are held back. If what you type turns out to be
  something else, like `/init`, the held keys are forwarded exactly as typed.
- **Queue** (`src/core/`): lives in the wrapper process and listens on a unix
  socket in a private per-session directory (mode 0700). The path reaches the
  agent's hooks through the `INJECT_DIR` environment variable, so several
  `inject` sessions in different terminals never cross. Claims are atomic, so
  parallel tool calls can't deliver a message twice.
- **Hooks** (`src/adapters/claude-code/`): the tool hooks are shell one-liners
  that exit right away unless a message of the right kind is queued, so tool
  calls with nothing queued never start Node. The `UserPromptSubmit` hook is
  the exception: it runs Node once per prompt (see
  [Plain `claude` sessions](#plain-claude-sessions)).

### Claude Code hook events used

Based on the [hooks reference](https://code.claude.com/docs/en/hooks):

| Event | Used for | Output |
| --- | --- | --- |
| `PostToolUse`, `PostToolUseFailure` | normal notes | `hookSpecificOutput.additionalContext`. Claude Code wraps it in a system reminder that Claude reads on its next request |
| `PreToolUse` | urgent messages | `hookSpecificOutput.permissionDecision: "deny"` with `permissionDecisionReason`, which is shown to Claude. Any notes still queued ride along in the same reason |
| `UserPromptSubmit` | logging messages typed into Claude Code's own queue | none; it only appends to `.steer/fixes.jsonl` |

Hook changes take effect in Claude Code sessions started after
`inject --install`.

## `.steer/fixes.jsonl`

One line per message, written in the project directory (`$CLAUDE_PROJECT_DIR`):

```json
{"ts":"2026-10-16T15:38:04.772Z","text":"stop, don't touch the v1 routes","urgency":"urgent","agent":"claude-code","delivered_at":"2026-10-16T15:38:08.889Z","delivered_via":"PreToolUse","doing":"about to run Edit: src/v1/routes.ts","session_id":"f6afb1c7-..."}
```

`ts` is when you queued the message. `doing` is the tool call Claude was about
to make, or had just made, when the message was delivered.

`delivered_via` says how the message reached Claude:

| `delivered_via` | Meaning |
| --- | --- |
| `PostToolUse`, `PostToolUseFailure` | an `/inject` note, added as context after a tool call (wrapper or plain `claude`, via the mod) |
| `PreToolUse` | an `/inject!` message that blocked a tool call |
| `claude-code-queue` | a message typed into Claude Code's own queue mid-turn. Claude Code delivers it itself once the running tool calls finish, so `delivered_at` is `null` |
| `null` | an `/inject` message still queued when Claude Code exited |

## Plain `claude` sessions

After `inject --install`, `/inject <message>` also works in a session started with
plain `claude`, even while Claude is working. There is no wrapper and no urgent mode:

| | `inject` | plain `claude` |
| --- | --- | --- |
| `/inject <msg>` | yes | yes |
| `/inject! <msg>` | yes, blocks the next tool call | no (Claude Code says "Unknown command") |
| Live "queued" bar at the bottom of the terminal | yes | a short toast: "queued, delivers at the next step" |
| Message reaches Claude | next tool boundary | next tool boundary |
| Logged to `.steer/fixes.jsonl` | yes | yes |

**Why a plugin and not just a hook.** Claude Code answers `Unknown command: /inject`
by itself, before any hook runs, and it holds a command typed while Claude is working
until the turn ends. A hook therefore can't catch `/inject`. A Claude Code
[mod](https://code.claude.com/docs/en/plugins/mods/overview) can register a real
command with `immediate: true`, which runs at once even mid-turn. That is all the
`mod/` folder is: one command, about 60 lines.

How it works:

1. `/inject use pnpm` runs the mod's command. It appends the message to a small file,
   `~/.claude/inject-pending/<session id>.jsonl` (or under `$CLAUDE_CONFIG_DIR`), and
   shows a toast. Nothing is sent to Claude yet, and the command prints nothing into
   the conversation.
2. After Claude's next tool call, the same `PostToolUse` hook that the wrapper uses
   claims that file and returns the message as `additionalContext`. It is delivered
   once, and only to the session that queued it. The hook also logs it to
   `.steer/fixes.jsonl`.

`inject --install` runs `claude plugin marketplace add <this repo>` and
`claude plugin install inject@inject`. Because it is a directory marketplace, the
plugin loads in place: edits under `mod/` apply at the next session start.
`inject --uninstall` removes it again. If `claude` isn't on your PATH, `inject --install`
prints the two commands to run yourself.

Other messages you type mid-turn (no `/inject` prefix) go into Claude Code's own queue
as usual. The `UserPromptSubmit` hook logs those to `.steer/fixes.jsonl` too, with
`delivered_via: "claude-code-queue"`. It keeps the last `prompt_id` per session: a
queued message carries the running turn's `prompt_id`, and a new turn gets a new one.
That hook prints nothing and always exits 0, so it never changes or blocks a prompt. It
runs once per prompt in every Claude Code session that reads `~/.claude/settings.json`,
including the desktop app's.

Limits:

- **No urgent mode.** Only a wrapper that holds the queue can make the next tool
  call fail.
- **A tool call is needed.** A message queued while Claude writes its final
  answer waits for Claude's next tool call, which may be in your next turn.
- **New sessions only.** Already-running `claude` sessions don't have the command until
  you restart them (or run `/reload-plugins`).
- **Folder trust.** Claude Code loads plugins only in folders you've trusted.
- **Inside the wrapper** `/inject` lines are held back before Claude Code sees them,
  so the mod isn't involved.
- A message you take back out of Claude Code's own queue with `Up` has already
  been logged.

## Things to know

- **Claude Code's own queue.** Recent Claude Code versions already queue a
  normal message you type while Claude works, and pass it to Claude once the
  current tool calls finish. inject adds `/inject`, the urgent mode, the log,
  and an agent-neutral core that other agents can plug into. Messages sent that
  way are logged too.
- **Delivery needs a tool boundary.** A message queued while Claude writes its
  final answer stays queued until Claude's next tool call, which may be in
  your next turn. The `N queued` marker shows that it is waiting.
- **Parallel tool calls.** An urgent message blocks the first tool call that
  reaches the hook. Other calls in the same parallel batch still run.
- **Detection is conservative.** After cursor keys, Tab completion, or `Esc`
  while typing a prompt, inject can't be sure Claude's input box is empty. It
  stops looking for `/inject` until the next Enter or Ctrl+C. Pressing Enter on
  an empty prompt resets it.
- **`/` is held for one keystroke.** Claude's slash-command menu appears when
  you type the second character instead of the first.
- **Windows:** use WSL2. Native Windows isn't supported, because the hooks are
  POSIX shell one-liners and use unix sockets.
- **Linux / WSL2:** node-pty has no prebuilt binary there, so it compiles
  during install. That needs `python3`, `make` and a C++ compiler. If npm
  skipped node-pty's install script, `inject` tells you which
  `npm rebuild node-pty` to run.

## Uninstall

```bash
inject --uninstall
npm uninstall -g inject-steer
```

`--uninstall` removes only inject's hooks (they're tagged `# inject-hook`) and the
`inject@inject` plugin, and leaves the rest of your settings alone.

## Adding another agent

Everything except `src/adapters/claude-code/` is agent-neutral. An adapter
provides:

- the command to start (`claude`),
- `install` / `uninstall` for its hook configuration,
- a hook entry point. It reads the agent's hook input, sends
  `{op:"claim", boundary:"before-tool"|"after-tool", ...}` to `$INJECT_DIR/sock`,
  and turns the reply into that agent's output: block the call for
  `before-tool`, add context for `after-tool`.

See `src/adapters/types.js` for the contract and `src/adapters/claude-code/`
for a reference implementation.

## Development

```bash
npm install
npm test
```

The tests drive the real wrapper in a pseudo-terminal with a fake agent. They
run the exact hook commands that `inject --install` writes, the same way
Claude Code would.

## License

MIT
