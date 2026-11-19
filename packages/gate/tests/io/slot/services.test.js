/** requireGateExecutionServices snapshots the landing services, carrying the optional release shard readers when given [C7,#11370]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requireGateExecutionServices } from '../../../src/io/slot.js';
import { executionServices } from '../../fixtures/execution.js';

/** The fixture services with `landing` replaced by `extra` beside the three required names. */
function withLanding(extra, drop = []) {
  const landing = { ...executionServices.landing, ...extra };
  for (const name of drop) delete landing[name];
  return { ...executionServices, landing };
}

test('gate.io-slot-services.release-shard-services-pass-through: clause 1: landing services holding offerReleaseShards and releaseParticipationShards come back on the frozen landing object, and without them neither new name appears [test] [C7,#11370]', () => {
  const offerReleaseShards = () => 1, releaseParticipationShards = () => 2;
  const given = requireGateExecutionServices(withLanding({ offerReleaseShards, releaseParticipationShards }));
  assert.equal(given.landing.offerReleaseShards, offerReleaseShards);
  assert.equal(given.landing.releaseParticipationShards, releaseParticipationShards);
  assert.ok(Object.isFrozen(given.landing));
  const plain = requireGateExecutionServices(withLanding({}, ['offerReleaseShards', 'releaseParticipationShards']));
  assert.deepEqual(Object.keys(plain.landing).sort(), ['captureReleaseQueue', 'constrainedLandingHost', 'releaseExecutors']);
});

test('gate.io-slot-services.required-names-unchanged: clause 2: services missing captureReleaseQueue, constrainedLandingHost or releaseExecutors are still refused [test] [C7,#11370]', () => {
  for (const name of ['captureReleaseQueue', 'constrainedLandingHost', 'releaseExecutors']) {
    assert.throws(() => requireGateExecutionServices(withLanding({ offerReleaseShards: () => 1, releaseParticipationShards: () => 2 }, [name])),
      { name: 'TypeError', message: 'gate execution needs explicit canonical runner and landing services' }, name);
  }
});
