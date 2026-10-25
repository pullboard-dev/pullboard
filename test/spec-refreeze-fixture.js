/** Real Git and SQLite fixtures for spec-row corrections that invalidate unmerged cited items [V2,H16]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import * as store from '../src/board.js';
import { COORDINATOR, loadConfig } from '../src/config.js';
import { prepareRowDecisions } from '../src/row-decisions.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { submitFixture } from './board-submit-fixture.js';

/** Assert that applying a person-approved spec correction refreezes every unmerged citation [V2,H16]. */
export function assertSpecCorrectionRefreezesCitations(t) {
  const helpers = createE2eHelpers();
  const box = helpers.project('true');
  const board = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => {
    store.closeBoard(board);
    helpers.cleanup();
  });

  /** Add a real board item with an optional spec citation. */
  const add = (title, specIds = ['G1']) => store.addItem(board, {
    by: COORDINATOR, lane: 'web', title, criterion: `Deliver ${title.toLowerCase()}.`,
    check: 'true', specIds, brief: 'Files: web/refreeze.js\nTest: the cited criterion is checked.',
  });
  /** Claim through the CLI so the frozen bytes come from the fixture's actual SPEC.md. */
  const claim = (id) => {
    const result = box.run(box.web, 'claim', String(id), '--json');
    assert.equal(result.code, 0, result.err || result.out);
    return store.getItem(board, id);
  };
  /** Record a synthetic submission through the real board transition, without claiming a gate ran. */
  const submit = (id) => {
    const item = store.getItem(board, id);
    const commit = box.git(box.web, 'rev-parse', 'HEAD');
    const tree = box.git(box.web, 'rev-parse', 'HEAD^{tree}');
    submitFixture(board, id, { agentId: item.item_owner, commit, tree });
  };

  const openId = add('Open citation');
  const claimedId = add('Live claim citation');
  const submittedId = add('Submitted citation');
  const verifiedId = add('Verified citation');
  const unrelatedId = add('Unrelated row', ['G2']);
  const withdrawnId = add('Withdrawn citation');

  claim(submittedId);
  submit(submittedId);
  claim(verifiedId);
  submit(verifiedId);
  const verified = store.getItem(board, verifiedId);
  store.verify(board, verifiedId, {
    agentId: COORDINATOR, decision: 'ACCEPT', reason: store.ACCEPT_REASON,
    note: 'fixture acceptance before spec correction',
    head: verified.item_commit, digest: verified.item_frozen_digest, policy: 'any',
  });
  claim(claimedId);
  const beforeClaimed = store.getItem(board, claimedId);
  const oldClaimedBar = beforeClaimed.item_frozen_digest;
  const oldVerifiedVerdicts = store.verdictsFor(board, verifiedId);
  assert.equal(beforeClaimed.item_status, 'claimed');
  assert.equal(store.getItem(board, submittedId).item_status, 'submitted');
  assert.equal(store.getItem(board, verifiedId).item_status, 'verified');

  store.withdraw(board, withdrawnId, { by: COORDINATOR, reason: 'fixture excludes withdrawn citations' });
  const config = loadConfig(box.repo);
  const decision = prepareRowDecisions(box.repo, config, {
    ids: ['G1'], decision: 'approve', text: 'The revised page renders.', by: 'person',
    on: new Date().toISOString(), commit: box.git(box.repo, 'rev-parse', 'HEAD'),
  });
  store.recordRowDecisions(board, { agentId: store.PERSON, channel: 'terminal', decisions: decision });

  const applied = box.run(box.repo, 'spec', 'apply', '--json');
  assert.equal(applied.code, 0, applied.err || applied.out);
  const repeated = box.run(box.repo, 'spec', 'apply', '--json');
  assert.equal(repeated.code, 0, repeated.err || repeated.out);
  assert.deepEqual(JSON.parse(repeated.out).applied, [], 'an already applied decision remains a no-op');

  const correctedText = 'The revised page renders.';
  for (const id of [openId, claimedId, submittedId, verifiedId]) {
    const item = store.getItem(board, id);
    assert.ok(item.item_frozen, `citing item #${id} has a complete frozen payload`);
    assert.ok(item.item_frozen_digest, `citing item #${id} has its frozen digest`);
    assert.match(item.item_frozen, /The revised page renders\./u, `citing item #${id} freezes corrected row text`);
    assert.equal(item.item_spec_ids, 'G1');
  }
  assert.notEqual(store.getItem(board, claimedId).item_frozen_digest, oldClaimedBar,
    'a live claim adopts the corrected bar atomically');
  const claimedAfter = store.getItem(board, claimedId);
  assert.equal(claimedAfter.item_status, 'claimed');
  assert.equal(claimedAfter.item_owner, beforeClaimed.item_owner, 'the live holder remains assigned');
  assert.equal(claimedAfter.item_lease_until, beforeClaimed.item_lease_until, 'the live lease is retained');
  assert.ok(store.inbox(board, beforeClaimed.item_owner).some(entry =>
    entry.shout_text.includes(`corrected #${claimedId}`)), 'the retained holder is notified in the same apply');

  assert.equal(store.getItem(board, submittedId).item_status, 'open', 'a submission at the stale bar returns to open');
  const verifiedAfter = store.getItem(board, verifiedId);
  assert.equal(verifiedAfter.item_status, 'open', 'a stale unmerged acceptance returns to open');
  assert.equal(verifiedAfter.item_verdict, null, 'stale acceptance fields are cleared from the live item');
  assert.ok(store.verdictsFor(board, verifiedId).some(verdict => verdict.verdict_decision === 'ACCEPT'),
    'the immutable acceptance audit remains available');
  assert.deepEqual(store.getItem(board, unrelatedId).item_frozen, null, 'a nonciting item is unchanged');
  assert.equal(store.getItem(board, withdrawnId).item_status, 'withdrawn', 'withdrawn citations are excluded');
  assert.equal(store.getItem(board, withdrawnId).item_frozen, null);
  assert.equal(correctedText, 'The revised page renders.');
}
