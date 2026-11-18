/** next keeps each readiness result for the main commit it ran on and offers a not-ready item again once main moves, behind next.readinessCache [C7,#8794]. @pullboard-test-input source-cell apps/cli packages/config */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { machineSettingsFile } from '../../../../../packages/config/index.js';
import { main } from '../../fixtures/native.js';
import { fixture } from '../../fixtures/next/take.js';

/** Turn the readiness settings on or off for this fixture's machine, keeping the settings the fixture wrote. */
function readinessSettings(cache) {
  const file = machineSettingsFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ view: { background: false }, relay: { offerAtInit: false }, gate: { localRunner: false }, next: { readinessCheck: true, readinessCache: cache } }));
}

/** Run next as a person reads it and return everything it printed; a call with nothing to offer may exit non-zero. */
async function printed(box) {
  let out = '';
  const stdout = { isTTY: false, write: part => { out += part; } };
  await main(['next'], { cwd: box.seats.actor.path, clock: box.clock, stdout, stderr: stdout });
  return out;
}

/** An item whose readiness command logs each run to a marker file and passes only once a ready file exists. */
async function counted(t, cache) {
  const box = await fixture(t);
  const ready = join(box.root, '..', 'ready');
  const marker = join(box.root, '..', 'runs.log');
  const item = box.add('Waits on a flag', { readinessCommand: `echo run >> '${marker}'; test -f '${ready}'` });
  readinessSettings(cache);
  const runs = () => (existsSync(marker) ? readFileSync(marker, 'utf8').split('\n').filter(Boolean).length : 0);
  return { box, item, ready, runs };
}

test('cli.io-next-readiness-cache.cli-next-readiness-cache-a-second-next: cli.next.readiness-cache.a-second-next-on-the-same: clause 1: a second next on the same main commit does not rerun the readiness command [C7,#8794]', async t => {
  const { box, item, runs } = await counted(t, true);
  assert.match(await printed(box), new RegExp(`skipped #${item}:`, 'u'));
  assert.equal(runs(), 1, 'the first next ran the command once');
  assert.match(await printed(box), new RegExp(`skipped #${item}:`, 'u'), 'the cached result still skips the item');
  assert.equal(runs(), 1, 'the second next on the same main commit read the kept result');
});

test('cli.io-next-readiness-cache.cli-next-readiness-cache-a-not-ready: cli.next.readiness-cache.a-not-ready-item-is-offered: clause 2: a not-ready item is offered again once a new main commit makes its readiness command pass [C7,#8794]', async t => {
  const { box, item, ready, runs } = await counted(t, true);
  assert.match(await printed(box), new RegExp(`skipped #${item}:`, 'u'));
  writeFileSync(ready, 'yes');
  assert.match(await printed(box), new RegExp(`skipped #${item}:`, 'u'), 'until main moves the kept result stands');
  assert.equal(runs(), 1);
  box.git(box.root, 'commit', '-q', '--allow-empty', '-m', 'chore: move main [G1]');
  assert.match(await printed(box), new RegExp(`claimed #${item}:`, 'u'), 'the new main commit reran the command, which now passes');
  assert.equal(runs(), 2);
});

test('cli.io-next-readiness-cache.cli-next-readiness-cache-with-next-readinesscache: cli.next.readiness-cache.with-next-readinesscache-off-every-next: clause 1: with next.readinessCache off every next reruns the readiness command [C7,#8794]', async t => {
  const { box, runs } = await counted(t, false);
  await printed(box);
  await printed(box);
  assert.equal(runs(), 2);
});
