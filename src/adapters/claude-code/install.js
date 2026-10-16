// Registers inject's hooks in Claude Code's user settings
// (~/.claude/settings.json, or $CLAUDE_CONFIG_DIR/settings.json).
//
// The tool hooks are shell one-liners that exit immediately unless the wrapper
// has a message of the right kind queued, so Claude sessions started without
// `inject`, and tool calls with nothing queued, never start Node.
//
// The UserPromptSubmit hook runs in every session (once per prompt you send)
// to log messages typed into Claude Code's own queue mid-turn.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = '# inject-hook';
const HOOK_JS = fileURLToPath(new URL('./hook.js', import.meta.url));
const PROMPT_HOOK_JS = fileURLToPath(new URL('./prompt-hook.js', import.meta.url));

export function settingsPath() {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, 'settings.json');
}

function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function hookCommand(event, flag) {
  return `[ -e "$INJECT_DIR/${flag}" ] || exit 0; exec "$INJECT_NODE" ${shellQuote(HOOK_JS)} ${event} ${MARKER}`;
}

// Plain `claude` sessions don't have $INJECT_NODE, and a GUI-launched session
// may not have Node on PATH, so prefer the Node that ran the install.
export function promptHookCommand(nodePath = process.execPath) {
  return `N=${shellQuote(nodePath)}; [ -x "$N" ] || N=node; exec "$N" ${shellQuote(PROMPT_HOOK_JS)} ${MARKER}`;
}

function hooks() {
  return [
    { event: 'PreToolUse', command: hookCommand('PreToolUse', 'urgent'), timeout: 10 },
    { event: 'PostToolUse', command: hookCommand('PostToolUse', 'normal'), timeout: 10 },
    { event: 'PostToolUseFailure', command: hookCommand('PostToolUseFailure', 'normal'), timeout: 10 },
    { event: 'UserPromptSubmit', command: promptHookCommand(), timeout: 5 },
  ];
}

function isOurs(handler) {
  return typeof handler?.command === 'string' && handler.command.includes(MARKER);
}

function readSettings(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${err.message}). Fix it, then run inject --install again.`);
  }
}

function writeSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.inject-backup`);
  const tmp = `${file}.inject-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** Removes our handlers; returns true if anything was removed. */
function strip(settings) {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== 'object') return false;
  let removed = false;
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    hooks[event] = hooks[event]
      .map((group) => {
        if (!Array.isArray(group?.hooks)) return group;
        const kept = group.hooks.filter((h) => !isOurs(h));
        if (kept.length !== group.hooks.length) removed = true;
        return { ...group, hooks: kept };
      })
      .filter((group) => !Array.isArray(group?.hooks) || group.hooks.length > 0);
    if (hooks[event].length === 0) delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  return removed;
}

export function install() {
  const file = settingsPath();
  const settings = readSettings(file);
  const before = JSON.stringify(settings);
  strip(settings);
  settings.hooks ??= {};
  for (const { event, command, timeout } of hooks()) {
    settings.hooks[event] ??= [];
    settings.hooks[event].push({ hooks: [{ type: 'command', command, timeout }] });
  }
  const changed = JSON.stringify(settings) !== before;
  if (changed) writeSettings(file, settings);
  return { path: file, changed };
}

export function uninstall() {
  const file = settingsPath();
  const settings = readSettings(file);
  const changed = strip(settings);
  if (changed) writeSettings(file, settings);
  return { path: file, changed };
}

export function isInstalled() {
  try {
    const installed = readSettings(settingsPath()).hooks || {};
    return hooks().every(({ event, command }) =>
      (installed[event] || []).some((g) => (g.hooks || []).some((h) => h.command === command)),
    );
  } catch {
    return false;
  }
}
