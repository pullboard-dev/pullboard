/** A 4-journey sample of the delete-tag mutation check finishes within 10 minutes and prints the share of delete tags that hold [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runJourneyCheck } from '../../../packages/gate/index.js';
import { mutateCell } from '../src/io/mutate/run.js';

const TEN_MINUTES_MS = 10 * 60 * 1000;
const ROOT = new URL('../../../', import.meta.url).pathname;

test('a 4-journey sample of the delete-tag check on this repository ends within 10 minutes with the hold share [C7]', { timeout: TEN_MINUTES_MS }, async () => {
  const started = Date.now();
  const lines = [];
  const say = line => { lines.push(line); process.stderr.write(`${Math.round((Date.now() - started) / 1000)}s ${line}\n`); };
  const { status, stdout } = await runJourneyCheck(['--limit', '4', '--cells', '2', '--faults', '3', ROOT], { mutate: mutateCell, say, trace: say });
  assert.equal(status, 0);
  assert.ok(Date.now() - started < TEN_MINUTES_MS, 'the sample took over 10 minutes');
  const last = stdout.trimEnd().split('\n').pop();
  assert.match(last, /^\d+ of \d+ sampled delete tags hold \(\d+%\)/u);
  assert.equal(lines.at(-1), last);
});
