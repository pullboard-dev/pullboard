/** A legacy relay exclusion is named unknown with its stable first-seen time; a person exclusion records who, when and why [H5,H17,B26]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';

test('a legacy exclusion shows as unknown historical exclusion with a stable first-seen time [H5,H17]', async (t) => {
  const box = await relayClientFixture(t);
  const file = join(box.env.PULLBOARD_HOME, 'relay-machine/state.json');
  await box.link();
  const state = JSON.parse(readFileSync(file, 'utf8'));
  state.excluded = [box.root];
  delete state.exclusionDetails;
  writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  const first = (await box.cliLocal('status')).document.relay.exclusion;
  assert.equal(first.reason, 'unknown historical exclusion');
  assert.equal(first.at, null, 'a missing historical time is never invented');
  assert.ok(Number.isFinite(Date.parse(first.firstSeenAt)), 'the time it was first observed is named');
  const second = (await box.cliLocal('status')).document.relay.exclusion;
  assert.equal(second.firstSeenAt, first.firstSeenAt, 'the first-seen time does not move on later reads');
});

test('a person exclusion records who, when and why, and status names each field [H5,H17,B26]', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  assert.equal((await box.cliLocal('relay', 'off')).code, 0);
  const exclusion = (await box.cliLocal('status')).document.relay.exclusion;
  assert.equal(exclusion.reason, 'person relay off');
  assert.equal(exclusion.by, 'person');
  assert.ok(Number.isFinite(Date.parse(exclusion.at)));
  assert.equal(exclusion.firstSeenAt, undefined, 'recorded exclusions carry no first-seen guess');
});
