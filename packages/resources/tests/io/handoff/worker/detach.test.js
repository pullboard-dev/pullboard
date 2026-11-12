/** @pullboard-test-input packages/resources/src/io/handoff/worker/cap.js */
/** The submit gate worker pool may shrink as well as grow, so a smaller runner fleet never stops every gate [C7,#2944]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { listResources } from '../../../../index.js';
import { takeResource } from '../../../../index.js';

/** An isolated machine home for one test. */
function machine(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pb-handoff-shrink-'));
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(directory, 'home');
  mkdirSync(process.env.PULLBOARD_MACHINE_HOME);
  t.after(() => {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previous;
    rmSync(directory, { recursive: true, force: true });
  });
}

const options = { name: 'submit-handoff-workers', scope: 'machine', kind: 'submit-handoff', allowCapacityGrowth: true };
const capacityOf = () => listResources({ scope: 'machine' }).find(row => row.name === options.name)?.capacity;

test('a lower worker target shrinks the pool instead of refusing, and a held slot keeps working [C7,#2944]', async t => {
  machine(t);
  const held = await takeResource({ ...options, capacity: 16, agent: 'worker-a' });
  await assert.rejects(takeResource({ ...options, capacity: 10, agent: 'worker-b' }), { code: 'RESOURCE_CAPACITY_MISMATCH' }, 'without shrink the old refusal stands');
  const next = await takeResource({ ...options, capacity: 10, agent: 'worker-b', allowCapacityShrink: true });
  assert.equal(capacityOf(), 10);
  next.release();
  held.release();
});

test('the dispatcher takes worker slots with shrink allowed [C7,#2944]', () => {
  const source = readFileSync(new URL('../../../../src/io/handoff/worker/cap.js', import.meta.url), 'utf8');
  assert.match(source, /allowCapacityGrowth: true, allowCapacityShrink: true/u);
});
