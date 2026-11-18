/** The 9-minute journey-check sample stays out of a census and a plain test run, and runs when asked [C7]. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { journeySampleAsked } from './fixtures/journey-sample.js';

const SAMPLE = fileURLToPath(new URL('./journey-check-sample.test.js', import.meta.url));

test('cli.journey-check-sample-gate.a-plain-run-or-a-census-does: clause 1: [C7] a plain run or a census does not ask for the sample', () => {
  assert.equal(journeySampleAsked({}), false);
  assert.equal(journeySampleAsked({ PULLBOARD_JOURNEY_SAMPLE: '0' }), false);
  assert.equal(journeySampleAsked({ PULLBOARD_JOURNEY_SAMPLE: '' }), false);
});

test('cli.journey-check-sample-gate.only-pullboard-journey-sample-1-starts-the: clause 2: [C7] only PULLBOARD_JOURNEY_SAMPLE=1 starts the sample and un-skips its cases', async () => {
  assert.equal(journeySampleAsked({ PULLBOARD_JOURNEY_SAMPLE: '1' }), true);
  const source = await readFile(SAMPLE, 'utf8');
  assert.match(source, /const sample = !ASKED \? null : runJourneyCheck\(/u, 'no sample starts unless asked');
  assert.equal((source.match(/skip: !ASKED/gu) ?? []).length, 2, 'both cases skip unless asked');
});
