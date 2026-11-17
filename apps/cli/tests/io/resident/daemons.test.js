/** Doctor names a running daemon an app started, which is not a launchd job, while a runner off this machine is registered [C7,#5760]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { residentDaemons } from '../../../src/io/resident/daemons.js';
import { appDaemonProblems } from '../../../src/logic/runner/daemons.js';

const app = { name: 'the resident board (resident-a)', pid: 41, appBundle: 'com.openai.chat', launchd: false };

test('cli.io-resident-daemons.an-app-started-daemon-that-is-no: clause 2: an app-started daemon that is no launchd job is named when a runner off this machine is registered [C7]', () => {
  const [problem, ...rest] = appDaemonProblems({ daemons: [app, { ...app, pid: 42, launchd: true }, { ...app, pid: 43, appBundle: null }], runners: [{ host: 'studio.local' }] });
  assert.equal(rest.length, 0, 'a launchd job and a daemon with no app are left alone');
  assert.equal(problem.code, 'DAEMON_LOCAL_NETWORK');
  assert.match(problem.message, /pid 41.*com\.openai\.chat/u);
  assert.match(problem.next, /kill 41/u);
});

test('cli.io-resident-daemons.with-no-runner-or-only-loopback-runners: clause 2: with no runner or only loopback runners nothing is named [C7]', () => {
  assert.deepEqual(appDaemonProblems({ daemons: [app], runners: [] }), []);
  assert.deepEqual(appDaemonProblems({ daemons: [app], runners: [{ host: '127.0.0.1' }, { host: 'me@localhost:2222' }] }), []);
  assert.equal(appDaemonProblems({ daemons: [app], runners: [{ host: 'me@10.0.0.5' }] }).length, 1);
});

test('cli.io-resident-daemons.residentdaemons-reads-each-live-resident-pid-file: clause 2: residentDaemons reads each live resident pid file, its app bundle and whether launchd runs it [C7]', t => {
  const { root } = privateFixtureFiles('pullboard-daemons-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.git', 'pullboard'), { recursive: true });
  for (const [name, pid] of [['resident-a.pid', 41], ['resident-b.pid', 42], ['resident-c.pid', 99]]) writeFileSync(join(root, '.git', 'pullboard', name), `${pid}\n`);
  const run = (command, args) => command === '/bin/launchctl'
    ? { status: 0, stdout: 'PID\tStatus\tLabel\n42\t0\tdev.pullboard.daemon.abc\n-\t0\tcom.other\n' }
    : { status: 0, stdout: args.includes('41') ? '/node board.js __CFBundleIdentifier=com.openai.chat HOME=/x' : '/node board.js HOME=/x' };
  const found = residentDaemons(root, { run, alive: pid => pid !== 99 });
  assert.deepEqual(found.map(({ pid, appBundle, launchd }) => [pid, appBundle, launchd]), [[41, 'com.openai.chat', false], [42, null, true]]);
});
