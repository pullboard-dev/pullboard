/** A gate slot held by a live but hung process is terminated, freed and its captured request re-run once [C7]. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { waitForCondition } from './runner-fixture-state.js';

const REPO = resolve(import.meta.dirname, '..');
const RESOURCE = 'liveness-test';

/** A holder that takes the slot with a captured re-run, then idles until it is stopped or killed. */
const HOLDER = `const { writeFileSync } = require('node:fs');
(async () => {
  const { takeResource } = await import(${JSON.stringify(pathToFileURL(join(REPO, 'packages/resources/index.js')).href)});
  const [, , ready, rerun, marker] = process.argv;
  await takeResource({ name: ${JSON.stringify(RESOURCE)}, capacity: 1, scope: 'machine', agent: 'holder',
    capturedRequest: { argv: [process.execPath, rerun, marker] } });
  writeFileSync(ready, String(process.pid));
  setInterval(() => {}, 1000);
})();
`;

/** A re-run that records how often it started and whether it was marked as a re-dispatch. */
const RERUN = `require('node:fs').appendFileSync(process.argv[2], 'ran ' + (process.env.PULLBOARD_LIVENESS_RELAUNCH ?? '') + '\\n');
`;

/** Build a private machine home, the holder and re-run scripts, and the environment that shortens the windows. */
function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-liveness-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  writeFileSync(join(dir, 'holder.cjs'), HOLDER);
  writeFileSync(join(dir, 'rerun.cjs'), RERUN);
  return { dir, home, holderScript: join(dir, 'holder.cjs'), rerunScript: join(dir, 'rerun.cjs') };
}

test('a stale-live holder is terminated, its slot freed and its captured request re-run exactly once [C7]', async t => {
  const { dir, home, holderScript, rerunScript } = fixture(t);
  const env = { PULLBOARD_MACHINE_HOME: home, PULLBOARD_STALE_HOLDER_MS: '1000', PULLBOARD_HOLDER_KILL_GRACE_MS: '500' };
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  t.after(() => { for (const key of Object.keys(env)) delete process.env[key]; });
  const { takeResource } = await import(pathToFileURL(join(REPO, 'packages/resources/index.js')).href);

  const ready = join(dir, 'ready');
  const marker = join(dir, 'marker');
  const holder = spawn(process.execPath, [holderScript, ready, rerunScript, marker],
    { detached: true, stdio: 'ignore', env: { ...process.env } });
  let exited = false;
  holder.on('exit', () => { exited = true; });
  t.after(() => { try { process.kill(-holder.pid, 'SIGKILL'); } catch { /* Already gone. */ } });
  await waitForCondition(() => existsSync(ready), 'the holder takes the slot');

  // A stopped process keeps its PID but cannot run its heartbeat timer: alive, and hung.
  process.kill(holder.pid, 'SIGSTOP');
  const lease = await takeResource({ name: RESOURCE, capacity: 1, scope: 'machine', agent: 'waiter' });

  // The slot is freed only once the holder's PID is gone.
  assert.equal(exited, true, 'the terminated holder must be gone before its slot is granted');
  lease.release();

  await waitForCondition(() => existsSync(marker), 'the captured request re-runs');
  const runs = readFileSync(marker, 'utf8').trim().split('\n');
  assert.deepEqual(runs, ['ran 1'], 'the captured request runs exactly once, marked as a re-dispatch');

  const db = new DatabaseSync(join(home, 'resources.sqlite'));
  try {
    const kinds = db.prepare('SELECT kind, COUNT(*) AS n FROM liveness_event GROUP BY kind').all();
    const count = kind => kinds.find(row => row.kind === kind)?.n ?? 0;
    assert.equal(count('terminate'), 1, 'SIGTERM is sent once');
    assert.equal(count('requeue'), 1, 'the request is re-dispatched once');
    assert.equal(count('requeue-spent'), 0, 'the re-dispatch is never requeued again');
  } finally { db.close(); }
});
