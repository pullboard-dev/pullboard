/** The pullboard update command: run the upgrade that matches how Pullboard was installed, then print what changed [C7,#1303]. */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import packageData from '../../../../../package.json' with { type: 'json' };
import { Refused } from '../../../../../packages/kernel/index.js';
import { changelogBetween } from '../../logic/changelog-between.js';
import { installKind } from '../../logic/install-kind.js';
import { upgradeCommand } from '../../logic/upgrade-command.js';

/** The real ports: a shell line, the latest published version, and the installed package's CHANGELOG.md. */
const REAL = {
  run: line => spawnSync('sh', ['-c', line], { stdio: 'inherit' }).status ?? 1,
  latest: name => {
    const found = spawnSync('npm', ['view', name, 'version'], { encoding: 'utf8', timeout: 30_000 });
    if (found.status !== 0) throw new Refused('UPDATE_LATEST', `could not read the latest ${name} version from npm`, 'check the network and run pullboard update again');
    return found.stdout.trim();
  },
  changelog: () => readFileSync(new URL('../../../../../CHANGELOG.md', import.meta.url), 'utf8'),
  scriptPath: () => realpathSync(process.argv[1]),
  env: () => process.env,
  package: () => packageData,
};

/**
 * Run `pullboard update` and return its exit code: 0 after an upgrade or when already current.
 * Why ports: a test passes fake ones, so no test runs npm or reads the network.
 */
export function run(io, _args, ports = {}) {
  const port = { ...REAL, ...ports };
  const { name, version } = port.package();
  const upgrade = upgradeCommand(installKind({ scriptPath: port.scriptPath(), env: port.env() }), name);
  if (upgrade.refusal) throw upgrade.refusal;
  const latest = port.latest(name);
  if (latest === version) {
    io.result?.({ current: true, from: version, to: latest });
    io.say(`Pullboard is already current at ${version}`);
    return 0;
  }
  io.say(`updating Pullboard ${version} to ${latest}: ${upgrade.command}`);
  const status = port.run(upgrade.command);
  if (status !== 0) throw new Refused('UPDATE_FAILED', `${upgrade.command} exited ${status}`, `run ${upgrade.command} yourself and read its output`);
  const changes = changelogBetween(port.changelog(), version, latest);
  io.result?.({ current: false, from: version, to: latest, command: upgrade.command });
  io.say(changes === '' ? `updated to ${latest}` : changes);
  return 0;
}
