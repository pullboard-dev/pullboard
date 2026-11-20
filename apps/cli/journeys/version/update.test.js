/**
 * pullboard update across the three install kinds, run through the command's own ports (C7, #1303).
 * Each kind's script sits where that kind installs Pullboard, so the command classifies itself from that path;
 * the ports stand in for npm, so every run stays off the network and nothing is installed.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { run } from '../../src/io/commands/update.js';

const NEWEST = '9.9.9';
const RUNNING = '0.0.1';
const CHANGELOG = '# Changelog\n\n## [9.9.9] - 2099-01-01\n\nnewest-fix-line\n\n## [9.9.8] - 2099-01-01\n\nolder-fix-line\n\n## [0.0.1] - 2000-01-01\n\nancient-line\n';

/** Run `update` with ports that log each shell line instead of running it; the latest version is `latest`. */
function update({ scriptPath, env = {}, latest = NEWEST }) {
  const calls = [];
  const said = [];
  const io = { say: line => said.push(line), result: () => {} };
  const ports = { run: line => { calls.push(line); return 0; }, latest: () => latest, changelog: () => CHANGELOG, scriptPath: () => scriptPath, env: () => env, package: () => ({ name: 'pullboard', version: RUNNING }) };
  try {
    const status = run(io, [], ports);
    return { status, said: said.join('\n'), calls, error: null };
  } catch (error) {
    return { status: null, said: said.join('\n'), calls, error };
  }
}

test('cli.journeys-version-update.each-install-kind-upgrades: clause 1: for each of global, npx and project, pullboard update runs that kind\'s upgrade through the stub npm on PATH and prints the changelog sections between the two versions [C7,#1303]', () => {
  const installs = {
    global: { scriptPath: '/home/u/prefix/lib/node_modules/pullboard/apps/cli/pullboard.js', env: { npm_config_prefix: '/home/u/prefix', PWD: '/home/u' }, line: 'npm install -g pullboard@latest' },
    npx: { scriptPath: '/home/u/cache/_npx/abc/node_modules/pullboard/apps/cli/pullboard.js', env: { PWD: '/home/u' }, line: 'npx --yes pullboard@latest --version' },
    project: { scriptPath: '/home/u/app/node_modules/pullboard/apps/cli/pullboard.js', env: { PWD: '/home/u/app' }, line: 'npm install --save-dev pullboard@latest' },
  };
  for (const [kind, install] of Object.entries(installs)) {
    const { status, said, calls, error } = update(install);
    assert.equal(error, null, `${kind}: ${error?.message}`);
    assert.equal(status, 0, kind);
    assert.deepEqual(calls, [install.line], `${kind} ran its own upgrade and nothing else`);
    assert.match(said, /newest-fix-line/u, kind);
    assert.match(said, /older-fix-line/u, kind);
    assert.doesNotMatch(said, /ancient-line/u, kind);
  }
});

test('cli.journeys-version-update.current-and-unknown-installs: clause 2: pullboard update says Pullboard is already current when the stub reports the running version, and refuses UPDATE_KIND_UNKNOWN naming the one manual command for an install it cannot tell [C7,#1303]', () => {
  const current = update({ scriptPath: '/home/u/prefix/lib/node_modules/pullboard/apps/cli/pullboard.js', env: { npm_config_prefix: '/home/u/prefix', PWD: '/home/u' }, latest: RUNNING });
  assert.equal(current.status, 0);
  assert.match(current.said, /already current/u);
  assert.deepEqual(current.calls, [], 'no upgrade ran');

  const unknown = update({ scriptPath: '/home/u/somewhere/pullboard.js' });
  assert.equal(unknown.error?.code, 'UPDATE_KIND_UNKNOWN');
  assert.match(`${unknown.error.message} ${unknown.error.hint ?? ''}`, /npm install -g pullboard@latest/u);
  assert.deepEqual(unknown.calls, [], 'an unknown install runs nothing');
});
