// inject [agent args...]   run the agent with /inject interception
// inject --install         register hooks (one time)
// inject --uninstall       remove hooks
//
// Everything other than the two flags above is passed to the agent unchanged,
// so `inject --resume` behaves like `claude --resume`.

import { defaultAdapter } from './adapters/index.js';
import { run } from './wrapper/run.js';

export async function main(argv) {
  const adapter = defaultAdapter;

  if (argv[0] === '--install' || argv[0] === '--uninstall') {
    try {
      const { path, changed } = argv[0] === '--install' ? adapter.install() : adapter.uninstall();
      const verb = argv[0] === '--install' ? 'installed in' : 'removed from';
      console.log(changed ? `inject: ${adapter.name} hooks ${verb} ${path}` : `inject: nothing to change in ${path}`);
      if (changed) console.log(`inject: previous settings saved to ${path}.inject-backup`);
      if (changed && argv[0] === '--install') {
        console.log(`inject: already-running ${adapter.name} sessions pick this up after a restart.`);
      }
      const mod = argv[0] === '--install' ? adapter.installMod?.() : adapter.uninstallMod?.();
      if (mod?.message) console[mod.ok ? 'log' : 'error'](`inject: ${mod.message}`);
    } catch (err) {
      console.error(`inject: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  if (!adapter.isInstalled()) {
    process.stderr.write(
      `inject: ${adapter.name} hooks are not installed, so /inject messages won't be delivered.\n` +
        `        Run \`inject --install\` once, then start inject again.\n`,
    );
  }

  await run(adapter, argv);
}
