/** The detached view writes its error output to its port log file, never to a pipe back to the exiting command [H5,N26]. */
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdirSync } from 'node:fs';
import { readlinkSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../packages/gate/tests/fixtures/child.js';
import { runFixtureChild } from '../../../../packages/gate/tests/fixtures/child.js';
import { backgroundViewLog } from '../../src/io/background.js';
import { launchBackgroundView } from '../../src/io/background.js';

/** A loopback port nothing holds right now. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

/** What a live process's stdout and stderr point at, by descriptor: a file path, or a pipe or socket name. */
function outputTargets(pid) {
  try { return { 1: readlinkSync(`/proc/${pid}/fd/1`), 2: readlinkSync(`/proc/${pid}/fd/2`) }; } catch { /* No /proc on this system: ask lsof. */ }
  const listed = runFixtureChild('lsof', ['-a', '-p', String(pid), '-d', '1,2', '-Fn'], { encoding: 'utf8' });
  const targets = {};
  let descriptor = null;
  for (const line of String(listed.stdout).split('\n')) {
    if (line.startsWith('f')) descriptor = line.slice(1);
    else if (line.startsWith('n') && descriptor) targets[descriptor] = line.slice(1);
  }
  return targets;
}

test('view.io-background.error-output-goes-to-the-port-log: clause 1: launchBackgroundView starts the detached server with its error output written to its port log file, never to a pipe back to the exiting parent, so a first runtime warning cannot end it [H5,N26]', { timeout: 120_000 }, async t => {
  const home = privateFixtureFiles('pullboard-background-').root;
  mkdirSync(join(home, 'machine'));
  const kept = { ...process.env };
  // A test runner's own context would make the started view behave as a test child, so the view gets a plain environment.
  delete process.env.NODE_TEST_CONTEXT;
  Object.assign(process.env, { PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: join(home, 'machine'), HOME: home });
  let started = null;
  t.after(() => {
    if (started) { try { process.kill(started.pid, 'SIGTERM'); } catch { /* Already gone. */ } }
    for (const name of ['PULLBOARD_HOME', 'PULLBOARD_MACHINE_HOME', 'HOME', 'NODE_TEST_CONTEXT']) { if (kept[name] === undefined) delete process.env[name]; else process.env[name] = kept[name]; }
    rmSync(home, { recursive: true, force: true });
  });

  const port = await freePort();
  const io = { cwd: home, say() {}, result: view => { started = view; }, flush() {} };
  assert.equal(await launchBackgroundView(io, port), 0);
  assert.ok(started?.pid > 0, 'the detached view reported its process');

  // The command has let go of the child, as it does before it exits. Where the server's stdout and stderr point now is
  // where its first warning goes: a pipe back to the parent ends the server on that write, the port log file does not.
  const log = backgroundViewLog(port);
  const targets = outputTargets(started.pid);
  assert.deepEqual(targets, { 1: log, 2: log }, 'the server\'s stdout and stderr are its port log file, not a pipe');
  assert.equal(statSync(log).mode & 0o777, 0o600, 'the log is private to this account');
});
