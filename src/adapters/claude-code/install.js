// Registers inject's hooks in Claude Code's user settings
// (~/.claude/settings.json, or $CLAUDE_CONFIG_DIR/settings.json).
//
// Each hook is a shell one-liner that exits immediately unless the wrapper has
// a message of the right kind queued, so Claude sessions started without
// `inject`, and tool calls with nothing queued, never start Node.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = '# inject-hook';
const HOOK_JS = fileURLToPath(new URL('./hook.js', import.meta.url));

// event -> flag file that must exist for the hook to do anything
const HOOKS = {
  PreToolUse: 'urgent',
  PostToolUse: 'normal',
  PostToolUseFailure: 'normal',
};

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
  for (const [event, flag] of Object.entries(HOOKS)) {
    settings.hooks[event] ??= [];
    settings.hooks[event].push({
      hooks: [{ type: 'command', command: hookCommand(event, flag), timeout: 10 }],
    });
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
    const hooks = readSettings(settingsPath()).hooks || {};
    return Object.keys(HOOKS).every((event) =>
      (hooks[event] || []).some((g) => (g.hooks || []).some((h) => isOurs(h) && h.command.includes(HOOK_JS))),
    );
  } catch {
    return false;
  }
}
