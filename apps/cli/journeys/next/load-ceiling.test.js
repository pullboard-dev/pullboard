/** next.holdAboveLoad hands no new claim to a seat on a machine above machine.loadCeiling, on an injected load reading, and is off by default [C7,#9703]. @pullboard-test-input source-cell apps/cli packages/config packages/resources */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { machineSettingsFile } from '../../../../packages/config/index.js';
import { setMachineLoadPort } from '../../../../packages/resources/index.js';
import { cli } from '../../tests/fixtures/next/take.js';
import { fixture } from '../../tests/fixtures/next/take.js';

/** Write this fixture machine's settings, keeping the settings the fixture wrote. */
function machineSettings(next, machine = {}) {
  const file = machineSettingsFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ view: { background: false }, relay: { offerAtInit: false }, gate: { localRunner: false }, next, machine }));
}

/** Inject a 1-minute load on a 4-core machine (ceiling 6) outside any admitted gate run; restore both after the test. */
function injectLoad(t, load) {
  const restore = setMachineLoadPort({ loadavg: () => [load, load, load], cores: () => 4 });
  const saved = process.env.PULLBOARD_GATE_SLOT_HELD;
  delete process.env.PULLBOARD_GATE_SLOT_HELD;
  t.after(() => {
    restore();
    if (saved === undefined) delete process.env.PULLBOARD_GATE_SLOT_HELD; else process.env.PULLBOARD_GATE_SLOT_HELD = saved;
  });
}

test('clause 1: above machine.loadCeiling next hands no new build or review claim and names the load [C7,#9703]', async t => {
  const box = await fixture(t);
  const review = box.add('Review waiting');
  box.submit(review);
  const open = box.add('Open build');
  machineSettings({ holdAboveLoad: true });
  injectLoad(t, 30);
  for (const args of [['next', '--take'], ['next'], ['next', '--verify']]) {
    const answer = await cli(box, box.seats.actor.path, args);
    assert.equal(answer.document?.item ?? null, null, `${args.join(' ')} hands no item: ${answer.out}${answer.err}`);
    assert.match(answer.out + answer.err, /1-minute load 30 on 4 cores \(ceiling 6\)/u, `${args.join(' ')} names the load`);
  }
  assert.equal(store.getItem(box.board, open).item_status, 'open', 'the open build stays unclaimed');
  assert.equal(store.getItem(box.board, review).item_review_by ?? null, null, 'the waiting review stays unreserved');
});

test('clause 2: above the ceiling a seat that holds a claim still resumes it [C7,#9703]', async t => {
  const box = await fixture(t);
  const mine = box.add('Held by the actor');
  box.claim(mine, box.seats.actor);
  box.add('Open build');
  machineSettings({ holdAboveLoad: true });
  injectLoad(t, 30);
  const resumed = await cli(box, box.seats.actor.path, ['next', '--take']);
  assert.equal(resumed.code, 0, resumed.out + resumed.err);
  assert.equal(resumed.document.item.item_id, mine, 'the held claim comes back');
  assert.equal(resumed.document.held, true);
});

test('clause 3: below the ceiling next hands claims as before, and the hold is off by default [C7,#9703]', async t => {
  const box = await fixture(t);
  const open = box.add('Open build');
  machineSettings({ holdAboveLoad: true });
  injectLoad(t, 2);
  const below = await cli(box, box.seats.actor.path, ['next', '--take']);
  assert.equal(below.code, 0, below.out + below.err);
  assert.equal(below.document.item.item_id, open, 'below the ceiling the build is handed over');
});

test('clause 3: with next.holdAboveLoad off, a load above the ceiling changes nothing [C7,#9703]', async t => {
  const box = await fixture(t);
  const open = box.add('Open build');
  machineSettings({});
  injectLoad(t, 30);
  const off = await cli(box, box.seats.actor.path, ['next', '--take']);
  assert.equal(off.code, 0, off.out + off.err);
  assert.equal(off.document.item.item_id, open);
});
