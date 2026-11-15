/** The 9-minute journey-check sample stays out of a census and a plain test run, and runs when asked [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const SAMPLE = fileURLToPath(new URL('./journey-check-sample.test.js', import.meta.url));

/** Runs the sample file with the switch set or cleared. Why spawn: the file decides at load time. */
function run(env) {
  const clean = { ...process.env };
  delete clean.PULLBOARD_JOURNEY_SAMPLE;
  delete clean.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ['--test', SAMPLE], { env: { ...clean, ...env }, encoding: 'utf8', timeout: 30000 });
}

test('clause 1: [C7] a plain run skips both sample cases and starts no sample', () => {
  const out = run({});
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /# skipped 2\b/u);
  assert.match(out.stdout, /# fail 0\b/u);
  assert.doesNotMatch(out.stderr, /^\d+s /mu, 'no sample progress line appears');
});

test('clause 2: [C7] the sample starts only when PULLBOARD_JOURNEY_SAMPLE=1 asks for it', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(SAMPLE, 'utf8');
  assert.match(source, /process\.env\.PULLBOARD_JOURNEY_SAMPLE === '1'/u);
  assert.match(source, /const sample = !ASKED \? null : runJourneyCheck\(/u);
});
