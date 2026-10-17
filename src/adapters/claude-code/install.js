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
import { spawnSync } from 'node:child_process';
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

export function hookCommand(event, flag, nodePath = process.execPath) {
  if (flag === 'normal') return normalHookCommand(event, nodePath);
  return `[ -e "$INJECT_DIR/${flag}" ] || exit 0; exec "$INJECT_NODE" ${shellQuote(HOOK_JS)} ${event} ${MARKER}`;
}

// Tool-boundary delivery of normal notes. Under the wrapper ($INJECT_DIR set)
// it checks the wrapper's flag file. In a plain `claude` session it checks for
// a pending file from the /inject mod (src/adapters/claude-code/plain.js,
// pendingDir()). Either way it stays in the shell unless there is something
// to deliver.
function normalHookCommand(event, nodePath) {
  return [
    'if [ -n "$INJECT_DIR" ]; then [ -e "$INJECT_DIR/normal" ] || exit 0;',
    'else set -- "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/inject-pending/*.jsonl; [ -e "$1" ] || exit 0; fi;',
    `N="\${INJECT_NODE:-${nodePath.replace(/[\\"$`]/g, '\\$&')}}"; [ -x "$N" ] || N=node;`,
    `exec "$N" ${shellQuote(HOOK_JS)} ${event} ${MARKER}`,
  ].join(' ');
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

function countOurs(settings) {
  let n = 0;
  for (const groups of Object.values(settings.hooks || {})) {
    for (const g of Array.isArray(groups) ? groups : []) n += (g?.hooks || []).filter(isOurs).length;
  }
  return n;
}

export function install() {
  const file = settingsPath();
  const settings = readSettings(file);
  // Already exactly what we'd write: leave the file (and its key order) alone.
  const wanted = hooks();
  const present = (settings.hooks && wanted.every(({ event, command }) => (settings.hooks[event] || []).some((g) => (g.hooks || []).some((h) => h.command === command)))) || false;
  if (present && countOurs(settings) === wanted.length) return { path: file, changed: false };
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

// ---------------------------------------------------------------------------
// The /inject command for plain `claude` sessions is a mod (mod/), which Claude
// Code loads as a plugin. This repo is also a one-plugin marketplace, so
// installing it is two `claude plugin` commands. A directory marketplace loads
// in place, so edits under mod/ apply at the next session start.

const PLUGIN = 'inject@inject';
const PACKAGE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function claude(args) {
  const bin = process.env.INJECT_COMMAND || 'claude';
  const env = { ...process.env };
  delete env.CLAUDE_CODE_CHILD_SESSION;
  const r = spawnSync(bin, ['plugin', ...args], { encoding: 'utf8', timeout: 60_000, env });
  return { ok: r.status === 0, missing: r.error?.code === 'ENOENT', out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

const manual = (cmds) => cmds.map((c) => `    claude plugin ${c}`).join('\n');

/** @returns {{ok:boolean, message:string}} */
export function installMod() {
  const steps = [['marketplace', 'add', PACKAGE_ROOT], ['install', PLUGIN]];
  for (const args of steps) {
    const r = claude(args);
    if (!r.ok) {
      const why = r.missing ? "couldn't find the `claude` command on your PATH" : r.out.split('\n').pop();
      return {
        ok: false,
        message: `could not install the /inject command for plain claude (${why}). Run these yourself:\n${manual(steps.map((a) => a.map((x) => (x === PACKAGE_ROOT ? `"${PACKAGE_ROOT}"` : x)).join(' ')))}`,
      };
    }
  }
  return { ok: true, message: `/inject command installed for plain claude (plugin ${PLUGIN}). Start a new claude session to use it.` };
}

/** @returns {{ok:boolean, message:string}} */
export function uninstallMod() {
  if (!modInstalled()) return { ok: true, message: '' };
  const a = claude(['uninstall', PLUGIN]);
  const b = claude(['marketplace', 'remove', 'inject']);
  if (a.ok && b.ok) return { ok: true, message: `/inject command removed (plugin ${PLUGIN})` };
  return { ok: false, message: `could not remove the /inject command; run:\n${manual([`uninstall ${PLUGIN}`, 'marketplace remove inject'])}` };
}

export function modInstalled() {
  try {
    const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    const plugins = JSON.parse(fs.readFileSync(path.join(base, 'plugins', 'installed_plugins.json'), 'utf8')).plugins;
    return Array.isArray(plugins?.[PLUGIN]) && plugins[PLUGIN].length > 0;
  } catch {
    return false;
  }
}
