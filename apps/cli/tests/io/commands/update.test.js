/** pullboard update runs the upgrade that matches the install through its ports and prints what changed [C7,#1303]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { run } from '../../../src/io/commands/update.js';

const NAME = 'pullboard';
const RUNNING = '0.9.4';
const CHANGELOG = '# Changelog\n\n## [9.9.9] - 2099-01-01\n\nnewest fix\n\n## [9.9.8] - 2099-01-01\n\nolder fix\n\n## [0.0.1] - 2000-01-01\n\nancient\n';

/** Ports for one install: the script path and PWD decide the kind; every call is recorded. */
function ports(over = {}) {
  const calls = { ran: [] };
  const base = {
    scriptPath: () => '/home/me/.npm/_npx/abc/node_modules/pullboard/apps/cli/pullboard.js',
    env: () => ({}),
    latest: () => '9.9.9',
    run: line => { calls.ran.push(line); return 0; },
    changelog: () => CHANGELOG,
    package: () => ({ name: NAME, version: RUNNING }),
  };
  return { calls, port: { ...base, ...over } };
}

/** A recording io. */
function recorder() {
  const said = [];
  return { said, say: line => said.push(line) };
}

test('cli.io-commands-update.runs-the-upgrade-for-each-install-kind: clause 1: for each of global, npx and project, update runs exactly the upgradeCommand line for the install kind through its run port, then prints the changelog sections from the old version to the new one [C7,#1303]', () => {
  const installs = {
    global: { scriptPath: () => '/usr/local/lib/node_modules/pullboard/apps/cli/pullboard.js', env: () => ({ npm_config_prefix: '/usr/local' }), line: `npm install -g ${NAME}@latest` },
    npx: { scriptPath: () => '/home/me/.npm/_npx/abc/node_modules/pullboard/apps/cli/pullboard.js', env: () => ({}), line: `npx --yes ${NAME}@latest --version` },
    project: { scriptPath: () => '/work/app/node_modules/pullboard/apps/cli/pullboard.js', env: () => ({ PWD: '/work/app' }), line: `npm install --save-dev ${NAME}@latest` },
  };
  for (const [kind, install] of Object.entries(installs)) {
    const { calls, port } = ports({ scriptPath: install.scriptPath, env: install.env });
    const io = recorder();
    assert.equal(run(io, {}, port), 0, kind);
    assert.deepEqual(calls.ran, [install.line], kind);
    const text = io.said.join('\n');
    assert.match(text, /newest fix/u, kind);
    assert.match(text, /older fix/u, kind);
    assert.doesNotMatch(text, /ancient/u, kind);
  }
});

test('cli.io-commands-update.already-current-runs-nothing: clause 2: when the latest published version equals the running version, update prints that Pullboard is already current and runs no upgrade [C7,#1303]', () => {
  const { calls, port } = ports({ latest: () => RUNNING });
  const io = recorder();
  assert.equal(run(io, {}, port), 0);
  assert.deepEqual(calls.ran, []);
  assert.match(io.said.join('\n'), /already current/u);
});

test('cli.io-commands-update.unknown-install-refuses: clause 3: for an unknown install, update refuses UPDATE_KIND_UNKNOWN naming the one manual command and runs nothing [C7,#1303]', () => {
  const { calls, port } = ports({ scriptPath: () => '/somewhere/else/pullboard.js' });
  assert.throws(() => run(recorder(), {}, port), error => {
    assert.equal(error.code, 'UPDATE_KIND_UNKNOWN');
    assert.match(error.message, new RegExp(`npm install -g ${NAME}@latest`, 'u'));
    return true;
  });
  assert.deepEqual(calls.ran, []);
});
