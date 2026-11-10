/** The hand-off dispatcher reads runnersOnly and the runner slot count from the real machine settings [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { handoffWorkerCapacity } from '../../../../../resources/index.js';
import { currentCapacity } from '../../../../index.js';

const RUNNERS = [{ host: 'one@runner-one', slots: 9, browser: 2, node: '/usr/bin/node' }, { host: 'two@runner-two', slots: 9, browser: 2, node: '/usr/bin/node' },
  { host: 'three@runner-three', slots: 10, browser: 2, node: '/usr/bin/node' }];
const SLOTS = 28;

/** Run the dispatcher's own capacity reader against a private machine home holding these settings and no cap override. */
function capacityWith(t, settings) {
  const home = mkdtempSync(join(tmpdir(), 'pb-handoff-cap-'));
  const prior = { home: process.env.PULLBOARD_MACHINE_HOME, cap: process.env.PULLBOARD_HANDOFF_WORKERS };
  t.after(() => {
    if (prior.home === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = prior.home;
    if (prior.cap === undefined) delete process.env.PULLBOARD_HANDOFF_WORKERS; else process.env.PULLBOARD_HANDOFF_WORKERS = prior.cap;
    rmSync(home, { recursive: true, force: true });
  });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'settings.json'), JSON.stringify(settings));
  process.env.PULLBOARD_MACHINE_HOME = home;
  delete process.env.PULLBOARD_HANDOFF_WORKERS;
  return currentCapacity();
}

test('clause 1: with gate.runnersOnly on, the dispatcher drains with a capacity of every registered runner slot up to the machine bound, not a fifth of them [C7]', t => {
  const capacity = capacityWith(t, { gate: { runnersOnly: true }, runners: RUNNERS });
  assert.equal(capacity, Math.min(SLOTS, 16));
  assert.ok(capacity > Math.floor(SLOTS / 5), 'more than the one-in-five cap');
});

test('clause 2: with runnersOnly off the cap stays one worker per five runner slots or the local minimum, unchanged [C7]', t => {
  const local = handoffWorkerCapacity({ env: {} });
  assert.equal(capacityWith(t, { runners: RUNNERS }), Math.max(local, Math.floor(SLOTS / 5)));
  assert.equal(capacityWith(t, { gate: { runnersOnly: false }, runners: RUNNERS }), Math.max(local, Math.floor(SLOTS / 5)));
  assert.equal(capacityWith(t, { gate: { runnersOnly: true } }), local, 'no registered runner keeps the local cap whatever runnersOnly says');
});
