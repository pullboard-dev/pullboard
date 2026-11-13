/** An accepted legacy approval baseline keeps its exact source through resume [H16,S1]. */
import { relayRecovered } from '../../../../../packages/link/index.js';
import assert from 'node:assert/strict';
import { cleanupFixtureChildren } from '../../../tests/fixtures/child.js';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { board as store } from '../../../../lib/index.js';
import { initialSpecApprovalBaseline } from '../../../../../packages/spec/index.js';
import { captureSpecApprovalBaseline } from '../../../../../packages/spec/index.js';
import {
  assertBaselineResumeEvidence,
  assertOriginalBaselineEvidence,
} from '../../../tests/fixtures/relay/client/case/baseline.js';
import {
  localEvents,
  receipts,
} from '../../../tests/fixtures/relay/client/replica.js';
import { threeReplicaPhaseCapture } from '../../../tests/fixtures/relay/client/timing.js';
import {
  cli,
  cliResult,
  threeReplicaFixture,
} from '../../../tests/fixtures/relay/client-harness.js';

after(cleanupFixtureChildren);

test('clause 2: an accepted legacy approval baseline keeps its exact source through resume [H16,S1]', { timeout: 60_000 }, async t => { // budget: one lost setup reply and one real resume, bounded fixture cleanup.
  const timing = threeReplicaPhaseCapture(t);
  await timing.run(async () => {
    const fixture = await threeReplicaFixture(t, timing);
    const { clones, envs, relay, person, replicaFiles } = fixture;
    for (const env of envs) env.PULLBOARD_RELAY_SENDER_BACKGROUND = '0';
    timing.begin('baseline reply recovery', 'lose one compatibility setup reply, change the spec, and resume');
    const uploadsBeforeLocalMove = relay.uploads.length;
    relay.dropNextReply({ offline: true });
    const first = await cliResult(clones[0], envs[0], 'add', 'web', 'Work after migration');
    assert.equal(first.status, 0, 'a lost setup reply does not block the local-first add');
    const addedId = first.document.item.item_id;
    assert.equal(localEvents(replicaFiles[0]).filter(event => event.item_id === addedId && event.event_kind === 'add').length, 1,
      'the local add is recorded once before replay');
    const original = store.openBoard(replicaFiles[0]);
    let originalBaseline;
    try { originalBaseline = store.specApprovalBaseline(original); } finally { store.closeBoard(original); }
    assert.ok(originalBaseline, 'the local first move retains the accepted setup baseline');
    const originalBaselineEvent = localEvents(replicaFiles[0]).find(event => event.event_kind === 'spec_approval_baseline');
    assert.ok(originalBaselineEvent, 'the local first move records the setup baseline event once');
    assertOriginalBaselineEvidence(originalBaselineEvent, originalBaseline);
    assert.equal(relay.uploads.length, uploadsBeforeLocalMove + 1,
      'only the existing setup move reaches the relay before the local add is replayed');
    const spec = join(clones[0], 'SPEC.md');
    writeFileSync(spec, readFileSync(spec, 'utf8') + '- G99 [approved, must] A later row needs confirmation. | gate: review\n');
    const local = store.openBoard(replicaFiles[0]);
    try {
      assert.equal(store.specApprovalBaselineExists(local), true, 'the accepted setup baseline remains present while the add is queued');
      const storedBaseline = store.specApprovalBaseline(local);
      assert.deepEqual(storedBaseline, originalBaseline, 'the original baseline event and stored source remain unchanged');
      assert.equal(storedBaseline.rows.some(row => row.id === 'G99'), false, 'a later spec row is not added to the stored baseline');
      const config = { spec: 'SPEC.md' };
      assert.ok(captureSpecApprovalBaseline(clones[0], config).rows.some(row => row.id === 'G99'));
      const selected = initialSpecApprovalBaseline({ info: { root: clones[0], isMain: true } }, local, 'recordHealthFindings', { relayRecovered, specApprovalBaselineExists: store.specApprovalBaselineExists });
      assert.equal(selected, null, 'an existing accepted baseline is not replaced by the current spec');
      assert.equal(initialSpecApprovalBaseline({ info: { root: clones[0], isMain: false } }, local, 'recordHealthFindings', { relayRecovered, specApprovalBaselineExists: store.specApprovalBaselineExists }), null, 'a lane never seeds or consumes setup');
    } finally { store.closeBoard(local); }
    relay.failReads(false);
    const resumed = await cli(clones[0], envs[0], 'resume');
    assert.ok(resumed.needsYou.some(need => need.kind === 'agent-approved' && need.id === 'G99'));
    relay.failReads(false);
    const caughtUp = await cli(clones[0], envs[0], 'status');
    assert.equal(caughtUp.relay.linked, true, 'the next reachable read keeps the board linked');
    assert.equal(caughtUp.relay.behind, 0, 'the next reachable read completes ordered replay');
    assert.deepEqual(caughtUp.relay.outbox ?? [], [], 'no queued moves remain after replay');
    const outboxRenumbered = caughtUp.relay.outboxRenumbered ?? [];
    const canonicalAddedId = outboxRenumbered.find(row => row.was === addedId)?.is ?? addedId;
    const canonicalBoard = store.openBoard(replicaFiles[0]);
    let addedItem;
    try { addedItem = store.getItem(canonicalBoard, canonicalAddedId); } finally { store.closeBoard(canonicalBoard); }
    assertBaselineResumeEvidence({ events: localEvents(replicaFiles[0]), receipts: receipts(replicaFiles[0]),
      originalBaseline, originalBaselineEvent, authenticatedLogin: person.user.login, addedId, outboxRenumbered, addedItem });
    timing.finish(['cloning three replicas', 'baseline reply recovery']);
  });
});

