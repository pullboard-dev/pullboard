/** A legacy relay exclusion is named unknown with its stable first-seen time; a person exclusion records who, when and why [H5,H17,B26]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';

test('cli.journeys-relay-exclusion.a-legacy-exclusion-shows-as-unknown: a legacy exclusion shows as unknown historical exclusion with a stable first-seen time [H5,H17]', async (t) => {
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

test('cli.journeys-relay-exclusion.a-person-exclusion-records-who-when: a person exclusion records who, when and why, and status names each field [H5,H17,B26]', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  assert.equal((await box.cliLocal('relay', 'off')).code, 0);
  const exclusion = (await box.cliLocal('status')).document.relay.exclusion;
  assert.equal(exclusion.reason, 'person relay off');
  assert.equal(exclusion.by, 'person');
  assert.ok(Number.isFinite(Date.parse(exclusion.at)));
  assert.equal(exclusion.firstSeenAt, undefined, 'recorded exclusions carry no first-seen guess');
});

/** Mark this board excluded on the machine, as a person's earlier relay off left it. */
function markExcluded(box) {
  const file = join(box.env.PULLBOARD_HOME, 'relay-machine/state.json');
  const state = JSON.parse(readFileSync(file, 'utf8'));
  state.excluded = [box.root];
  writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
}

test('cli.journeys-relay-exclusion.relay-on-clears-the-exclusion-of-a-paused: clause 1: on a board whose baseline upload is paused, relay on exits 0 and status then shows no relay.excluded [H5,H17]', async (t) => {
  const box = await relayClientFixture(t, { accountStorageBytes: 1000 }); // Too small for any baseline, so the upload pauses on the account limit.
  await box.link();
  assert.ok(JSON.parse(readFileSync(box.linkFile, 'utf8')).baselinePause, 'the baseline upload is paused');
  markExcluded(box);
  assert.equal((await box.cliLocal('status')).document.relay.excluded, true, 'the board is excluded before relay on');
  const on = await box.cliLocal('relay', 'on', '--url', box.origin);
  assert.equal(on.code, 0, on.failure);
  const status = (await box.cliLocal('status')).document.relay;
  assert.equal(status.excluded, undefined, 'relay on cleared the exclusion');
  assert.ok(JSON.parse(readFileSync(box.linkFile, 'utf8')).baselinePause, 'the pause itself is unchanged');
});

test('cli.journeys-relay-exclusion.relay-off-then-on-ends-unexcluded: clause 2: a plain relay off then relay on on an unpaused board still ends with no relay.excluded [H5,H17]', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  assert.equal((await box.cliLocal('relay', 'off')).code, 0);
  assert.equal((await box.cliLocal('status')).document.relay.excluded, true, 'relay off excludes the board');
  const on = await box.cliLocal('relay', 'on', '--url', box.origin);
  assert.equal(on.code, 0, on.failure);
  assert.equal((await box.cliLocal('status')).document.relay.excluded, undefined, 'relay on leaves it unexcluded');
});
