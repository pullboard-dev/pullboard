/** @pullboard-test-input source-tree */
import { landingPorts } from '../../../tests/fixtures/landing/ports.js';
import { checkAtCommit } from '../../../../runner/index.js';
import { fileURLToPath } from 'node:url';
const candidateWorkerFile = fileURLToPath(new URL('../../../../lib/src/io/landing/candidate.js', import.meta.url));
/** Real public submission, Git conflict resolution and immutable verdict coverage [V1,V4,H16]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  land,
  runLandingBatch,
} from '../../../../../packages/landing/index.js';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { captureMergeOnly } from '../../../../../packages/merge/index.js';
import { mergeOnlyBasis } from '../../../../../packages/merge/index.js';
import {
  runFixtureGit,
  runFixtureChild,
} from '../../../tests/fixtures/child.js';
import {
  exportBoard,
  importBoard,
} from '../../../../../packages/store/index.js';
import {
  prepareEngineMove,
  applyEngineMove,
  applyRelayMove,
} from '../../../../../packages/state/index.js';
import { MERGE_ONLY_VERDICT_ENGINE } from '../../../../../packages/state/light.js';
import { operationIntent } from '../../../../../packages/state/index.js';
import { capturePrProof } from '../../../../../packages/github/index.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** Require the public command to succeed, retaining its complete diagnostic on refusal. */
function succeeds(box, cwd, ...args) {
  const result = box.run(cwd, ...args);
  assert.equal(result.code, 0, `${args.join(' ')}\n${result.out}\n${result.err}`);
  return result;
}

/** Read authoritative native item state and its append-only receipts. */
function state(box, id) {
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    return { item: store.getItem(board, id), verdicts: store.verdictsFor(board, id),
      events: store.events(board, { itemId: id }), snapshot: exportBoard(board) };
  } finally { store.closeBoard(board); }
}

/** Commit an actual same-line change while leaving a separate behavior line outside the conflict. */
function content(box, cwd, value, message) {
  const committed = e2e.commitFile(box, cwd, 'web/feature.js',
    `export const choice = '${value}';\n\nexport const unrelated = 'unchanged';\n`, message);
  assert.equal(committed.status, 0, committed.stderr);
  return box.git(cwd, 'rev-parse', 'HEAD');
}

test('clause 1: a merge-only resubmission keeps its accept and records the resolution diff [V1,V4,H16]', async () => {
  const box = e2e.project();
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  const configured = e2e.commitFile(box, box.repo, 'pullboard.json',
    JSON.stringify({ ...config, landing: { perItem: false, manualOverride: true, publish: 'separate' } }, null, 2), 'chore: configure local landing');
  assert.equal(configured.status, 0, configured.stderr);
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  content(box, box.repo, 'base', 'feat(web): initial choice [G1]');
  box.git(box.web, 'merge', '-q', '--no-edit', 'main');
  const added = succeeds(box, box.repo, 'add', 'web', 'Preserve accepted choice', '--specs', 'G1',
    '--criterion', 'The accepted choice survives a trunk-only merge', '--check', 'node --check web/feature.js',
    '--brief', 'Files:\n- web/feature.js\nChange:\n- keep the accepted choice\nTest:\n- node --check web/feature.js passes', '--json');
  const id = JSON.parse(added.out).item.item_id;
  succeeds(box, box.web, 'claim', String(id));
  const accepted = content(box, box.web, 'accepted', 'feat(web): accepted choice [G1]');
  succeeds(box, box.web, 'submit', String(id));
  box.git(box.repo, 'switch', '-q', '--detach', accepted);
  try {
    succeeds(box, box.repo, 'verify', String(id), 'accept', '--as', 'coordinator', '--note', 'checked the complete choice criterion');
  } finally { box.git(box.repo, 'switch', '-q', 'main'); }
  const original = state(box, id);
  const trunk = content(box, box.repo, 'trunk', 'feat(web): another accepted trunk choice [G1]');
  succeeds(box, box.repo, 'reopen', String(id), '--conflict', 'web/feature.js');
  succeeds(box, box.web, 'claim', String(id));
  assert.equal(state(box, id).item.item_frozen_digest, original.item.item_frozen_digest);
  assert.notEqual(box.tryGit(box.web, 'merge', '-q', '--no-edit', 'main').status, 0);
  const head = content(box, box.web, 'resolved', 'fix(web): resolve the accepted trunk merge [G1]');
  assert.deepEqual(box.git(box.web, 'show', '-s', '--format=%P', head).split(' '), [accepted, trunk]);
  // Build the adversarial object while this real seat still holds the claim. The hook must
  // generate its metadata normally; the later counterexample must not amend an unclaimed commit.
  assert.equal(state(box, id).item.item_status, 'claimed');
  writeFileSync(join(box.web, 'web/feature.js'), "export const choice = 'resolved';\n\nexport const unrelated = 'silently changed';\n");
  box.git(box.web, 'add', 'web/feature.js');
  box.git(box.web, 'commit', '-q', '--amend', '--no-edit');
  const extraHead = box.git(box.web, 'rev-parse', 'HEAD');
  const extraTree = box.git(box.web, 'rev-parse', 'HEAD^{tree}');
  assert.match(box.git(box.web, 'show', '-s', '--format=%B', extraHead), new RegExp(`^Pullboard-Item: #${id}$`, 'mu'));
  assert.deepEqual(box.git(box.web, 'show', '-s', '--format=%P', extraHead).split(' '), [accepted, trunk]);
  box.git(box.web, 'reset', '--hard', head);
  const pending = state(box, id);
  succeeds(box, box.web, 'submit', String(id));
  const carried = state(box, id);
  assert.equal(carried.item.item_status, 'verified', 'a gated merge-only resubmission keeps its original acceptance');
  assert.equal(carried.item.item_commit, head);
  assert.equal(carried.item.item_verified_by, original.item.item_verified_by);
  assert.deepEqual(carried.verdicts, original.verdicts, 'carry-over must not manufacture a second reviewer verdict');
  const receipt = carried.events.findLast(event => event.event_kind === 'merge-only-accept');
  assert.ok(receipt, 'the native receipt records why the existing accept carries');
  const detail = JSON.parse(receipt.event_detail);
  assert.equal(detail.acceptedCommit, accepted);
  assert.equal(detail.commit, head);
  assert.equal(detail.trunk, trunk);
  assert.equal(detail.digest, original.item.item_frozen_digest);
  assert.equal(detail.verdict, original.verdicts.at(-1).verdict_id);
  assert.match(detail.resolutionDiff, /web\/feature\.js/u);
  assert.match(detail.resolutionDiff, /resolved/u);
  assert.equal(detail.resolutionHash, createHash('sha256').update(detail.resolutionDiff).digest('hex'));
  const shown = succeeds(box, box.repo, 'show', String(id));
  assert.match(shown.out, /verified/u);
  assert.doesNotMatch(shown.out, /re-review: main merge only/u);
  const submitted = JSON.parse(carried.events.findLast(event => event.event_kind === 'submit').event_detail);
  const options = { agentId: pending.item.item_owner, commit: head, tree: submitted.tree,
    policyCommit: submitted.policyCommit, submissionProof: submitted.submissionProof, gateGreen: submitted.gateGreen,
    mergeOnly: detail };
  const origin = openBoard(':memory:', undefined, { gitRoot: box.web });
  const objectless = openBoard(':memory:');
  try {
    importBoard(origin, pending.snapshot);
    importBoard(objectless, pending.snapshot);
    const canonical = prepareEngineMove(origin, 'submit', [id, options]);
    const { mergeOnly: suppliedCarry, ...callerOptions } = options;
    assert.ok(suppliedCarry);
    // The engine's submit authorization adds clause and rename policy (inspectClauses, #2711 era); only those fields are derived here.
    const { clausePolicyCommit, inspectClauses, strictRenames } = canonical.args[1];
    const derivedPolicy = { clausePolicyCommit, inspectClauses, strictRenames };
    assert.equal(operationIntent('submit', canonical.args), operationIntent('submit', [id, { ...callerOptions, ...derivedPolicy }]),
      'the derived canonical carry preserves the interrupted caller intent');
    for (const key of ['commit', 'tree', 'policyCommit', 'gateGreen']) {
      const changed = { ...callerOptions, [key]: key === 'gateGreen' ? false : '0'.repeat(40) };
      assert.notEqual(operationIntent('submit', canonical.args), operationIntent('submit', [id, changed]),
        `${key}: an actual changed submission is not an exact retry`);
    }
    const at = '2026-01-01T00:00:00.000Z';
    const sender = { kind: 'agent', agent: options.agentId, userId: 'private-builder',
      policy: MERGE_ONLY_VERDICT_ENGINE };
    const withObjects = applyRelayMove(origin, canonical, { sequence: 1, at, sender, kind: 'move' });
    // 8078e19a4a: replaying a sealed clause policy reads that policy commit, so the replica sees the repository for this one replay; the merge-only carry stays sealed in the move.
    objectless.gitRoot = box.web;
    const withoutObjects = applyRelayMove(objectless, canonical, { sequence: 1, at, sender, kind: 'move' });
    objectless.gitRoot = undefined;
    assert.equal(withObjects.error, undefined,
      `the authenticated builder retains the original reviewer authority: ${JSON.stringify(withObjects.error)}`);
    assert.equal(store.getItem(origin, id).item_status, 'verified');
    assert.deepEqual(withoutObjects, withObjects, 'one canonical move must emit identical events and event IDs without the carried commit objects');
    assert.deepEqual(exportBoard(objectless), exportBoard(origin), 'replicas must retain exactly identical native state');
    assert.deepEqual(capturePrProof(origin).accepted.get(id), store.acceptedVerdict(origin, store.getItem(origin, id)),
      'publication retains the canonical carried acceptance within its snapshot');
    const freshReview = prepareEngineMove(origin, 'verify', [id, { agentId: 'coordinator', decision: 'ACCEPT',
      note: 'a fresh verdict still requires its own reviewer authority', head,
      digest: pending.item.item_frozen_digest, check: 'green',
      review: { commit: head, head, trunk, paths: detail.paths } }]);
    const unprivilegedCoordinator = { kind: 'agent', agent: 'coordinator', userId: 'private-coordinator-without-root',
      policy: MERGE_ONLY_VERDICT_ENGINE };
    const denied = applyRelayMove(origin, freshReview, { sequence: 2, at, sender: unprivilegedCoordinator, kind: 'move' });
    assert.equal(denied.error?.code, 'VERIFIER_STANDING', 'retaining a verdict must never authorize a fresh unprivileged review');
    assert.deepEqual(applyRelayMove(objectless, freshReview,
      { sequence: 2, at, sender: unprivilegedCoordinator, kind: 'move' }), denied);
    assert.deepEqual(store.verdictsFor(origin, id), original.verdicts);
    const subsequent = prepareEngineMove(origin, 'reopen', [id, { agentId: 'coordinator', withdrawVerdict: true,
      note: 'withdraw the original acceptance after canonical carry' }]);
    const next = applyEngineMove(origin, subsequent, { sequence: 3, at });
    assert.deepEqual(applyEngineMove(objectless, subsequent, { sequence: 3, at }), next,
      'a later verdict-ID-bound move must retain the same outcome and event IDs');
    assert.deepEqual(exportBoard(objectless), exportBoard(origin));
    assert.equal(capturePrProof(origin).accepted.get(id), undefined,
      'publication cannot revive an original verdict withdrawn after its carry');

  } finally { store.closeBoard(origin); store.closeBoard(objectless); }
  for (const key of ['commit', 'tree', 'policyCommit']) {
    const replica = openBoard(':memory:', undefined, { gitRoot: box.web });
    try {
      importBoard(replica, pending.snapshot);
      if (key === 'policyCommit') {
        // 8078e19a4a: a submit citing a policy commit that main does not contain is refused before any review, so no carry can apply.
        assert.throws(() => store.submit(replica, id, { ...options, [key]: '0'.repeat(40) }), { code: 'NO_POLICY' });
        assert.equal(store.getItem(replica, id).item_status, pending.item.item_status, 'the refused submit changed nothing');
        assert.equal(store.events(replica, { itemId: id }).filter(event => event.event_kind === 'merge-only-accept').length, 0);
        continue;
      }
      store.submit(replica, id, { ...options, [key]: '0'.repeat(40) });
      assert.equal(store.getItem(replica, id).item_status, 'submitted', `${key}: unavailable or mismatched actual source gets ordinary review`);
      assert.equal(store.events(replica, { itemId: id }).filter(event => event.event_kind === 'merge-only-accept').length, 0);
    } finally { store.closeBoard(replica); }
  }
  for (const key of ['acceptedHead', 'digest', 'verdict', 'reopen']) {
    const replica = openBoard(':memory:', undefined, { gitRoot: box.web });
    try {
      importBoard(replica, pending.snapshot);
      const fake = { ...detail, [key]: typeof detail[key] === 'number' ? detail[key] + 100 : '0'.repeat(40) };
      store.submit(replica, id, { ...options, mergeOnly: fake });
      const receipt = JSON.parse(store.events(replica, { itemId: id }).findLast(event => event.event_kind === 'merge-only-accept').event_detail);
      assert.equal(receipt[key], detail[key], `${key}: native history and Git replace caller-supplied facts`);
    } finally { store.closeBoard(replica); }
  }
  const refrozen = openBoard(':memory:', undefined, { gitRoot: box.web });
  try {
    importBoard(refrozen, pending.snapshot);
    store.refreeze(refrozen, id, { agentId: 'coordinator', freeze: () => ({ text: pending.item.item_frozen, digest: 'a different frozen bar' }) });
    store.claim(refrozen, id, { agentId: options.agentId, lane: 'web', leaseMs: 7_200_000,
      freeze: () => ({ text: pending.item.item_frozen, digest: 'a different frozen bar' }) });
    store.submit(refrozen, id, options);
    assert.equal(store.getItem(refrozen, id).item_status, 'submitted', 'a changed frozen bar requires outside review');
    assert.equal(store.events(refrozen, { itemId: id }).filter(event => event.event_kind === 'merge-only-accept').length, 0);
  } finally { store.closeBoard(refrozen); }
  for (const gateGreen of [false, undefined]) {
    const ungated = openBoard(':memory:', undefined, { gitRoot: box.web });
    try {
      importBoard(ungated, pending.snapshot);
      store.submit(ungated, id, { ...options, gateGreen });
      assert.equal(store.getItem(ungated, id).item_status, 'submitted', 'an absent or waived gate cannot carry acceptance');
    } finally { store.closeBoard(ungated); }
  }
  // This private authenticated engine fixture must not upgrade a builder's invented source facts.
  // The real commit retains both merge parents but changes behavior outside the conflict region.
  writeFileSync(join(box.web, 'web/feature.js'), "export const choice = 'resolved';\n\nexport const unrelated = 'silently changed';\n");
  box.git(box.web, 'add', 'web/feature.js');
  const unclaimedAmend = box.tryGit(box.web, 'commit', '-q', '--amend', '--no-edit');
  assert.notEqual(unclaimedAmend.status, 0, 'an unclaimed amended trailer must still be refused');
  assert.match(unclaimedAmend.stderr, /live claim|verified item in the landing checkout/u);
  assert.equal(box.git(box.web, 'rev-parse', 'HEAD'), head, 'the refused amend cannot replace the accepted merge');
  box.git(box.web, 'reset', '--hard', extraHead);
  const forged = openBoard(':memory:', undefined, { gitRoot: box.web });
  try {
    importBoard(forged, pending.snapshot);
    const move = prepareEngineMove(forged, 'submit', [id, options]);
    // The forged move keeps the sealed clause-policy fields the engine added (8078e19a4a); only the source is swapped.
    move.args[1] = { ...options, ...Object.fromEntries(['clausePolicyCommit', 'inspectClauses', 'strictRenames'].map(key => [key, move.args[1][key]])), commit: extraHead, tree: extraTree,
      mergeOnly: { ...detail, commit: extraHead, tree: extraTree } };
    applyEngineMove(forged, move, { sequence: 1, at: '2026-01-01T00:00:00.000Z' });
    assert.equal(store.getItem(forged, id).item_status, 'verified',
      'canonical replay records the sealed decision consistently; landing is the authoritative Git backstop');
    const beforeLanding = box.git(box.repo, 'rev-parse', 'HEAD');
    await assert.rejects(land({ landingPorts, root: box.repo, board: forged, dryRun: true, say: () => {},
      config: { landing: { perItem: false, publish: 'separate' } } }), error => error.code === 'STALE_VERDICT'
        && /recorded merge-only acceptance/u.test(error.message),
      'forged canonical carry must not reach a physical merge');
    assert.equal(box.git(box.repo, 'rev-parse', 'HEAD'), beforeLanding);
    assert.deepEqual(store.verdictsFor(forged, id), original.verdicts);
    assert.deepEqual(store.landingBatches(forged), []);
    // Adopt an already-gated trunk batch while an independent valid item remains ready.
    // That bypasses the earlier all-stale selection refusal and reaches the final publication guard.
    const adoption = openBoard(':memory:', undefined, { gitRoot: box.web });
    try {
      importBoard(adoption, exportBoard(forged));
      const readyCommit = box.git(box.repo, 'commit-tree', box.git(box.repo, 'rev-parse', `${trunk}^{tree}`),
        '-p', trunk, '-m', 'private independent ready candidate');
      const ready = store.addItem(adoption, { by: 'coordinator', lane: 'web', title: 'Independent ready candidate' });
      store.claim(adoption, ready, { agentId: options.agentId, lane: 'web', leaseMs: 7_200_000,
        freeze: () => ({ text: pending.item.item_frozen, digest: pending.item.item_frozen_digest }) });
      store.submit(adoption, ready, { agentId: options.agentId, commit: readyCommit,
        tree: box.git(box.repo, 'rev-parse', `${readyCommit}^{tree}`), policyCommit: trunk,
        submissionProof: options.submissionProof });
      store.verify(adoption, ready, { agentId: original.verdicts.at(-1).verdict_by, decision: 'ACCEPT',
        note: 'Private independent candidate keeps adoption selection nonempty', head: readyCommit,
        digest: pending.item.item_frozen_digest, check: 'green',
        review: { commit: readyCommit, head: readyCommit, trunk, paths: [] } });
      const batch = { version: 1, id: 'private-gated-forged-carry', state: 'trunk', base: trunk, tip: extraHead,
        root: box.web, branch: 'refs/heads/main', owner: 'private-adopter', logPath: join(box.repo, '.git', 'private-adoption.log'),
        items: [{ id, commit: extraHead, merge: extraHead }] };
      store.recordLandingBatch(adoption, { agentId: 'coordinator', batch });
      await assert.rejects(runLandingBatch({ landingPorts, checkAtCommit, candidateWorkerFile, root: box.repo, board: adoption, adopt: true,
        config: { landing: { perItem: false, publish: 'separate' } }, owner: 'private-adopter', say: () => {},
        write: async (operation, args) => adoption.enginePorts.store[operation](adoption, ...args), checkLease: async () => {} }),
      error => error.code === 'STALE_VERDICT' && /recorded merge-only acceptance/u.test(error.message),
      'adoption must re-prove an already-gated canonical carry before finishing its trunk receipt');
      // 98ea4e7864 and #3188: the final guard refusal is recorded on the batch and the refused batch ends blocked, so no restart adopts it again.
      const refused = store.landingBatches(adoption).at(-1);
      assert.equal(refused.state, 'blocked');
      assert.ok(refused.refusal, 'the final guard refusal is recorded on the batch');
      assert.ok(refused.revision > 2,
        'adoption saved its owner after selection (2), then recorded the final guard refusal and blocked the batch; all-stale preflight did not refuse it');
      assert.equal(store.getItem(adoption, id).item_merged_commit, null);
      assert.equal(box.git(box.repo, 'rev-parse', 'HEAD'), beforeLanding);
    } finally { store.closeBoard(adoption); }
    store.reopen(forged, id, { agentId: 'coordinator',
      note: `test/example.test.js: recorded failure; merge commit ${extraHead}` });
    store.claim(forged, id, { agentId: options.agentId, lane: 'web', leaseMs: 7_200_000,
      freeze: () => ({ text: pending.item.item_frozen, digest: pending.item.item_frozen_digest }) });
    const nextTrunk = box.git(box.repo, 'commit-tree', box.git(box.repo, 'rev-parse', `${trunk}^{tree}`),
      '-p', trunk, '-m', 'private next trunk');
    const nextHead = box.git(box.repo, 'commit-tree', extraTree, '-p', extraHead, '-p', nextTrunk, '-m', 'private clean merge');
    const nextOptions = { ...options, commit: nextHead, tree: extraTree, policyCommit: nextTrunk };
    const nextProof = captureMergeOnly(box.web, mergeOnlyBasis(forged, store.getItem(forged, id), {}, { acceptedVerdict: store.acceptedVerdict }),
      { commit: nextHead, tree: extraTree, trunk: nextTrunk });
    assert.ok(nextProof, 'the newest merge alone is clean, but its inherited acceptance was forged');
    // Main must hold the submit policy commit (#2375): the carried trunk lands before the submit is prepared.
    box.git(box.repo, 'merge', '--ff-only', nextTrunk);
    const chained = prepareEngineMove(forged, 'submit', [id, nextOptions]);
    chained.args[1].mergeOnly = nextProof;
    applyEngineMove(forged, chained, { sequence: 2, at: '2026-01-01T00:00:01.000Z' });
    assert.equal(store.getItem(forged, id).item_status, 'verified');
    await assert.rejects(land({ landingPorts, root: box.repo, board: forged, dryRun: true, say: () => {},
      config: { landing: { perItem: false, publish: 'separate' } } }), error => error.code === 'STALE_VERDICT',
      'a later clean carry must not launder a forged earlier carry into a landable acceptance');
    assert.equal(box.git(box.repo, 'rev-parse', 'HEAD'), nextTrunk);
    box.git(box.repo, 'reset', '--hard', trunk);


  } finally { store.closeBoard(forged); }
  const absent = openBoard(':memory:');
  try {
    importBoard(absent, pending.snapshot);
    const move = prepareEngineMove(absent, 'submit', [id, { ...options, gitRoot: box.web }]);
    assert.equal(Object.hasOwn(move.args[1], 'mergeOnly'), false,
      'ordinary submit omits a derived null field and discards caller-provided carry');
    applyEngineMove(absent, move,
      { sequence: 1, at: '2026-01-01T00:00:00.000Z' });
    assert.equal(store.getItem(absent, id).item_status, 'submitted', 'an objectless origin cannot derive carry from caller fields or a serialized gitRoot');
  } finally { store.closeBoard(absent); }
  const historical = openBoard(':memory:', undefined, { gitRoot: box.web });
  try {
    importBoard(historical, pending.snapshot);
    const { gateGreen, mergeOnly, ...oldOptions } = options;
    const prepared = prepareEngineMove(historical, 'submit', [id, oldOptions]);
    // A submit sealed before the merge-only engine cannot hold the clause and rename policy fields later engines added (clause inspection, #2711 era; strict renames, engine 221): drop them so the minimum engine is the one this replay claims.
    const { clausePolicyCommit, inspectClauses, strictRenames, ...sealedThen } = prepared.args[1];
    const move = { ...prepared, args: [prepared.args[0], sealedThen] };
    applyEngineMove(historical, { ...move, engine: MERGE_ONLY_VERDICT_ENGINE - 1 },
      { sequence: 1, at: '2026-01-01T00:00:00.000Z' });
    assert.equal(store.getItem(historical, id).item_status, 'submitted', 'historical submit replay never gains carry semantics');
  } finally { store.closeBoard(historical); }
  const replay = openBoard(':memory:', undefined, { gitRoot: box.web });
  try {
    importBoard(replay, pending.snapshot);
    const move = prepareEngineMove(replay, 'submit', [id, options]);
    assert.throws(() => applyEngineMove(replay, { ...move, engine: MERGE_ONLY_VERDICT_ENGINE - 1 },
      { sequence: 1, at: '2026-01-01T00:00:00.000Z' }), /engine/iu);
    applyEngineMove(replay, move, { sequence: 1, at: '2026-01-01T00:00:00.000Z' });
    assert.equal(store.getItem(replay, id).item_status, 'verified');
    assert.equal(store.acceptedVerdict(replay, store.getItem(replay, id)).verdict_id, detail.verdict);
    assert.equal(store.checkedLandingCommit(replay, store.getItem(replay, id)), head);
    store.reopen(replay, id, { agentId: 'coordinator', withdrawVerdict: true, note: 'the original reviewer withdraws the retained acceptance' });
    assert.equal(store.getItem(replay, id).item_status, 'open');
    assert.equal(store.acceptedVerdict(replay, store.getItem(replay, id)), undefined, 'a carry cannot resurrect a withdrawn original verdict');
  } finally { store.closeBoard(replay); }
  const landed = succeeds(box, box.repo, 'land', '--json');
  assert.equal(state(box, id).item.item_status, 'verified');
  assert.ok(state(box, id).item.item_merged_commit, landed.out);
  assert.equal(box.tryGit(box.repo, 'merge-base', '--is-ancestor', head, 'HEAD').status, 0);
});

/** Make a small real Git conflict without pretending these synthetic identities are live reviewers. */
function sourceFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-merge-only-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Merge fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'Merge fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' };
  /** Run only bounded private Git fixture commands. */
  const git = (...args) => runFixtureGit(args, { cwd: root, env, timeout: 5000 });
  /** Commit one literal private file and return its content-addressed commit. */
  const save = (choice, unrelated = 'unchanged', amend = false) => {
    writeFileSync(join(root, 'hot.js'), `const choice = '${choice}';\n${'// stable context\n'.repeat(12)}const behavior = '${unrelated}';\n`);
    git('add', 'hot.js'); git('commit', '-q', ...(amend ? ['--amend'] : []), '-m', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main'); save('base'); git('switch', '-q', '-c', 'candidate');
  const accepted = save('accepted'); git('switch', '-q', 'main'); const trunk = save('trunk');
  git('switch', '-q', 'candidate');
  const merge = runFixtureChild('git', ['merge', '-q', '--no-edit', 'main'], { cwd: root, env, encoding: 'utf8', timeout: 5000 });
  assert.notEqual(merge.status, 0);
  const commit = save('resolved');
  const basis = { acceptedCommit: accepted, acceptedHead: accepted, digest: 'synthetic frozen bar',
    verdict: 1, reopen: 2, conflict: { trunk, files: ['hot.js'] }, review: { paths: ['hot.js'] } };
  /** Capture the exact current commit and tree as the post-gate CLI does. */
  const capture = () => captureMergeOnly(root, basis, { commit: git('rev-parse', 'HEAD'),
    tree: git('rev-parse', 'HEAD^{tree}'), trunk });
  /** Start a real conflict with the same isolated Git identity and configuration as every fixture write. */
  const conflict = () => runFixtureChild('git', ['merge', '-q', '--no-edit', 'main'], { cwd: root, env, encoding: 'utf8', timeout: 5000 });
  return { root, git, save, accepted, trunk, commit, basis, capture, conflict };
}

test('extra behavioral edits in the same conflicted file need outside review [V1,V4]', t => {
  const box = sourceFixture(t);
  assert.ok(box.capture(), 'the actual resolution is eligible');
  box.save('resolved', 'changed behavior', true);
  assert.equal(box.capture(), null, 'a merge commit cannot exempt the whole hot file');
});

test('amended non-merge and stale head or tree proofs cannot retain an accept [V1,V4]', t => {
  const box = sourceFixture(t);
  const proof = box.capture();
  assert.ok(proof);
  assert.equal(captureMergeOnly(box.root, box.basis, { commit: box.commit, tree: box.accepted, trunk: box.trunk }), null);
  box.git('reset', '--hard', box.accepted);
  box.save('resolved', 'unchanged', true);
  assert.equal(box.capture(), null, 'an amended commit without the exact merge parents needs review');
});

test('unresolved conflict markers cannot masquerade as a resolution [V1,V4]', t => {
  const box = sourceFixture(t);
  box.git('reset', '--hard', box.accepted);
  const merged = box.conflict();
  assert.notEqual(merged.status, 0);
  assert.match(merged.stdout, /CONFLICT/u);
  box.git('add', 'hot.js'); box.git('commit', '-q', '-m', 'unresolved markers');
  assert.equal(box.capture(), null);
});

test('a landing-failure return allows only the exact automatic clean merge [V1,V4]', t => {
  const box = sourceFixture(t);
  box.git('switch', '-q', 'main'); box.git('reset', '--hard', `${box.accepted}^`);
  writeFileSync(join(box.root, 'trunk-only.txt'), 'accepted trunk change\n');
  box.git('add', 'trunk-only.txt'); box.git('commit', '-q', '-m', 'trunk-only change');
  const trunk = box.git('rev-parse', 'HEAD');
  box.git('switch', '-q', 'candidate'); box.git('reset', '--hard', box.accepted);
  box.git('merge', '-q', '--no-edit', 'main');
  const basis = { ...box.basis, cleanOnly: true, conflict: { trunk: null, files: [] } };
  const commit = box.git('rev-parse', 'HEAD');
  const tree = box.git('rev-parse', 'HEAD^{tree}');
  const proof = captureMergeOnly(box.root, basis, { commit, tree, trunk });
  assert.ok(proof);
  assert.equal(proof.resolutionDiff, '', 'no unrecorded conflict resolution is exempt');
  box.save('accepted', 'extra behavior', true);
  assert.equal(captureMergeOnly(box.root, basis, { commit: box.git('rev-parse', 'HEAD'),
    tree: box.git('rev-parse', 'HEAD^{tree}'), trunk }), null);
});
