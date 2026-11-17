/** next.routeByTier offers an item only to a seat on the tier the project's tiers route it to, and is off by default [C7,#8800,#2178]. @pullboard-test-input source-cell apps/cli packages/config */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { nextRouteByTier } from '../../../../packages/config/index.js';
import { machineSettingsFile } from '../../../../packages/config/index.js';
import { tierOmissions } from '../../../../packages/moves/index.js';
import { saveAgentModel } from '../../../../packages/seats/index.js';
import { cli } from '../../tests/fixtures/next/take.js';
import { fixture } from '../../tests/fixtures/next/take.js';
import { FIXTURE_MODEL } from '../../../../packages/gate/tests/fixtures/testkit.js';
import { FIXTURE_MODEL_EARLIER } from '../../../../packages/gate/tests/fixtures/testkit.js';

const TIERS = { routine: { endpoint: 'http://routine.invalid', model: FIXTURE_MODEL }, escalation: { endpoint: 'http://escalation.invalid', model: FIXTURE_MODEL_EARLIER } };

/** Write this fixture machine's next settings, keeping the settings the fixture wrote. */
function nextSettings(next) {
  const file = machineSettingsFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ view: { background: false }, relay: { offerAtInit: false }, gate: { localRunner: false }, next }));
}

/** A fixture whose project declares tiers and whose asking seat serves the routine tier. */
async function tiered(t) {
  const box = await fixture(t, { projectConfig: { tiers: TIERS } });
  saveAgentModel(box.board, box.seats.actor.id, FIXTURE_MODEL);
  return box;
}

/** An item the builder submitted and the coordinator returned twice: two bounces at the routine tier. */
function bounced(box, title) {
  const id = box.add(title);
  for (let round = 0; round < 2; round += 1) {
    box.git(box.seats.builder.path, 'commit', '--allow-empty', '-q', '-m', `chore: rework ${round} [G1]`);
    box.submit(id);
    store.reopen(box.board, id, { agentId: 'coordinator', note: 'Synthetic bounce for the tier-routing journey; no gate execution claimed.' });
  }
  assert.equal(store.getItem(box.board, id).item_status, 'open');
  return id;
}

/** Pin an item to a tier the way the board reads a pin: a note fact on its thread. */
function pin(box, id, tier) {
  store.appendFact(box.board, id, { agentId: 'coordinator', kind: 'note', text: `tier-pin: ${tier}` });
}

/** The item `next --take` hands the actor seat, or null when it hands none. */
async function offered(box) {
  const taken = await cli(box, box.seats.actor.path, ['next', '--take']);
  assert.equal(taken.code, 0, taken.out + taken.err);
  return taken.document?.item?.item_id ?? null;
}

test('clause 1: with next.routeByTier on, an item bounced twice at a tier is next offered at the tier above [C7,#8800]', async t => {
  const box = await tiered(t);
  const id = bounced(box, 'Bounced twice');
  nextSettings({ routeByTier: true });
  assert.equal(await offered(box), null, 'a routine seat is not offered an item that escalated');
  saveAgentModel(box.board, box.seats.actor.id, FIXTURE_MODEL_EARLIER);
  assert.equal(await offered(box), id, 'an escalation seat is offered it');
});

test('clause 2: with next.routeByTier on, an item pinned to a tier is never offered at another [C7,#8800]', async t => {
  const box = await tiered(t);
  const id = box.add('Pinned to escalation');
  pin(box, id, 'escalation');
  nextSettings({ routeByTier: true });
  assert.deepEqual(tierOmissions(box.config, box.board, store.listItems(box.board), { id: box.seats.actor.id }), [id], `the pinned item is left out: ${JSON.stringify(box.config.tiers)} ${store.agentModel(box.board, box.seats.actor.id)}`);
  assert.equal(await offered(box), null, 'a routine seat is not offered an escalation pin');
  saveAgentModel(box.board, box.seats.actor.id, FIXTURE_MODEL_EARLIER);
  assert.equal(await offered(box), id, 'an escalation seat is');
  const other = await tiered(t);
  const held = bounced(other, 'Bounced but pinned to routine');
  pin(other, held, 'routine');
  nextSettings({ routeByTier: true });
  saveAgentModel(other.board, other.seats.actor.id, FIXTURE_MODEL_EARLIER);
  assert.equal(await offered(other), null, 'a pin to routine holds the item there even after two bounces');
});

test('clause 3: with next.routeByTier off, next offers items as on main [C7,#8800]', async t => {
  const box = await tiered(t);
  const id = bounced(box, 'Bounced twice, setting off');
  assert.equal(nextRouteByTier(), false, 'the default is off');
  assert.equal(await offered(box), id, 'a routine seat is offered it while the setting is off');
});
