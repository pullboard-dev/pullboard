/** pullboard capacity keeps one row per ISO week on the board [C7,R1,R2]. */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../fixtures/e2e.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** Run capacity in process and return its JSON result. */
async function capacity(box) {
  const result = await box.runLocal(box.repo, 'capacity', '--json');
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  return JSON.parse(result.out);
}

test('cli.io-commands-capacity-weeks.pullboard-capacity-records-one-row-per-week: clause 1: pullboard capacity records one row per week on the board [C7,R1,R2]', async () => {
  const box = e2e.project();
  const first = await capacity(box);
  assert.equal(first.weeks.length, 1, 'the first reading adds the week');
  const [row] = first.weeks;
  assert.match(row.week, /^\d{4}-W\d{2}$/u);
  for (const key of ['conflictPressure', 'hoursInFlight', 'cellsPerItem']) assert.ok(key in row, `the row holds ${key}`);
  assert.ok(Array.isArray(row.files), 'the row names the files that drove it');
  assert.equal(row.runs, 1);
});

test('cli.io-commands-capacity-weeks.a-second-run-in-the-same-week: clause 2: a second run in the same week updates that week row instead of adding one [C7,R1,R2]', async () => {
  const box = e2e.project();
  await capacity(box);
  const second = await capacity(box);
  assert.equal(second.weeks.length, 1, 'still one row');
  assert.equal(second.weeks[0].runs, 2, 'the row absorbed the second reading');
});
