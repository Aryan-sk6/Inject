import { install, installMod, isInstalled, modInstalled, uninstall, uninstallMod } from './install.js';

/** @type {import('../types.js').Adapter} */
export default {
  id: 'claude-code',
  name: 'Claude Code',
  command: 'claude',
  install,
  uninstall,
  isInstalled,
  installMod,
  uninstallMod,
  modInstalled,
};
