/** The landing worker's stderr never breaks a completed batch, and a guardian crash names it [C7]. */
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runLandingWorker } from '../packages/landing/index.js';
import { parseProcessCensus } from '../packages/kernel/src/core/process-census.js';

/** A stand-in guardian: on start it writes stderr, then either reports a result or crashes. */
const GUARDIAN = `process.on('message', message => {
  if (message.type !== 'start') return;
  process.stderr.write('guardian noise on stderr\\n');
  if (process.env.GUARDIAN_CRASH === '1') process.exit(3);
  process.send({ type: 'result', value: { landed: 42 } }, () => process.disconnect());
});
`;

/** Run the real worker parent against the stand-in guardian with inert canonical ports. */
async function run(t, crash) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-landing-stderr-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workerFile = join(dir, 'guardian.cjs');
  writeFileSync(workerFile, GUARDIAN);
  const previous = process.env.GUARDIAN_CRASH;
  process.env.GUARDIAN_CRASH = crash ? '1' : '0';
  t.after(() => { if (previous === undefined) delete process.env.GUARDIAN_CRASH; else process.env.GUARDIAN_CRASH = previous; });
  return runLandingWorker({ root: dir }, { write: async () => null, checkLease: async () => {}, checkLeaseNow: () => {},
    bindWorker: async () => {}, watchDeadline: () => () => {}, say: () => {}, signal: new AbortController().signal,
    workerFile, parseProcessCensus });
}

test('a completed landing run that printed stderr returns its result [C7]', async t => {
  assert.deepEqual(await run(t, false), { landed: 42 });
});

test('a guardian that stops unexpectedly refuses with its stderr tail [C7]', async t => {
  await assert.rejects(run(t, true), error => error.code === 'LAND_WORKER' && /stopped unexpectedly; .*adopting: guardian noise on stderr$/u.test(error.message));
});
