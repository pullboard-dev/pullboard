/** The detached view writes its error output to its port log file, never to a pipe back to the exiting command [H5,N26]. */
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { watch } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { privateFixtureFiles } from '../../../../packages/gate/tests/fixtures/child.js';
import { backgroundViewLog } from '../../src/io/background.js';
import { launchBackgroundView } from '../../src/io/background.js';

const PROBE = fileURLToPath(new URL('../fixtures/background-stderr-probe.cjs', import.meta.url));

/** A loopback port nothing holds right now. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

test('view.io-background.error-output-goes-to-the-port-log: clause 1: launchBackgroundView starts the detached server with its error output written to its port log file, never to a pipe back to the exiting parent, so a first runtime warning cannot end it [H5,N26]', { timeout: 120_000 }, async t => {
  const home = privateFixtureFiles('pullboard-background-').root;
  mkdirSync(join(home, 'machine'));
  const kept = { ...process.env };
  Object.assign(process.env, { PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: join(home, 'machine'), HOME: home, NODE_OPTIONS: `--require ${PROBE}` });
  let started = null;
  t.after(() => {
    if (started) { try { process.kill(started.pid, 'SIGTERM'); } catch { /* Already gone. */ } }
    for (const name of ['PULLBOARD_HOME', 'PULLBOARD_MACHINE_HOME', 'HOME', 'NODE_OPTIONS']) { if (kept[name] === undefined) delete process.env[name]; else process.env[name] = kept[name]; }
    rmSync(home, { recursive: true, force: true });
  });

  const port = await freePort();
  const io = { cwd: home, say() {}, result: view => { started = view; }, flush() {} };
  assert.equal(await launchBackgroundView(io, port), 0);
  assert.ok(started?.pid > 0, 'the detached view reported its process');

  // The command has let go of the child, as it does before it exits. A line the server writes to stderr now has nowhere
  // to go but the log file; on a pipe back to the parent it would end the server, as the first warning did.
  const log = backgroundViewLog(port);
  const written = new Promise(resolve => {
    const watcher = watch(dirname(log), () => {
      let text = '';
      try { text = readFileSync(log, 'utf8'); } catch { /* Not written yet. */ }
      if (text.includes('probe: first runtime warning')) { watcher.close(); resolve(text); }
    });
    t.after(() => watcher.close());
  });
  process.kill(started.pid, 'SIGUSR2');
  const text = await written;
  assert.match(text, /probe: first runtime warning after the parent let go/u, 'the server\'s error output reached its port log');
  assert.doesNotThrow(() => process.kill(started.pid, 0), 'the server is still running after its first warning');
  assert.equal(statSync(log).mode & 0o777, 0o600, 'the log is private to this account');
});
