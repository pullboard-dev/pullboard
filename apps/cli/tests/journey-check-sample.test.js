/** A 4-journey sample of the delete-tag mutation check finishes within 10 minutes and prints the share of delete tags that hold [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runJourneyCheck } from '../../../packages/gate/index.js';
import { mutateCell } from '../src/io/mutate/run.js';

const TEN_MINUTES_MS = 10 * 60 * 1000;
const ROOT = new URL('../../../', import.meta.url).pathname;

const started = Date.now();
const lines = [];
const say = line => { lines.push(line); process.stderr.write(`${Math.round((Date.now() - started) / 1000)}s ${line}\n`); };
/** One run serves both clauses, so the sample is paid for once. */
const sample = runJourneyCheck(['--limit', '4', '--cells', '2', '--faults', '3', ROOT], { mutate: mutateCell, say, trace: say }).then(result => ({ ...result, took: Date.now() - started }));

test('clause 1: [C7] a 4-journey sample of the delete-tag check ends within 10 minutes', { timeout: TEN_MINUTES_MS }, async () => {
  const { status, took } = await sample;
  assert.equal(status, 0);
  assert.ok(took < TEN_MINUTES_MS, 'the sample took over 10 minutes');
});

test('clause 2: [C7] the sample prints the share of sampled delete tags that hold', { timeout: TEN_MINUTES_MS }, async () => {
  const { stdout } = await sample;
  const last = stdout.trimEnd().split('\n').pop();
  assert.match(last, /^\d+ of \d+ sampled delete tags hold \(\d+%\)/u);
  assert.equal(lines.at(-1), last);
});
