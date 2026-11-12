import { NO_ELIGIBLE_REVIEWER_ENGINE } from '../../../state/light.js';
import { mkdtempSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordItemSession } from '../../../items/index.js';
import { refuseSelfSession } from '../../../items/index.js';
import { compositionSessionOptions } from '../../../verify/index.js';
import { prepareEngineMove } from '../../../state/index.js';
import { applyEngineMove } from '../../../state/index.js';
import { exportBoard } from '../../../store/index.js';
/** Real native SQLite moves prove current-composition authority and the bounded vendor fallback [V4,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../store/index.js';
import { fixtureBoard } from '../../../../apps/cli/tests/fixtures/board.js';
import { heartbeatSeat } from '../../../store/index.js';
import { reviewEligibility } from '../../../verify/index.js';
import { compositionOwner } from '../../../verify/index.js';
import { refuseUnreviewable } from '../../../verify/index.js';
import { submitPreflight } from '../../../items/index.js';
import { healthReport } from '../../index.js';
import { STRICT_COMPOSITION_ENGINE } from '../../../state/light.js';
import { REVIEW_HEAD_BUILDER_FAMILY_ENGINE } from '../../../state/light.js';

const COMMIT = 'a'.repeat(40), TREE = 'b'.repeat(40);
const freeze = () => ({ text: '{}', digest: 'synthetic-composition-bar' });
const REVIEW = { policy: 'any', familyPolicy: 'require' };
const PATCH = 'diff --git a/x.txt b/x.txt\nnew file mode 100644\n--- /dev/null\n+++ b/x.txt\n@@ -0,0 +1,4 @@\n+a\n+b\n+c\n+d\n';

/** Private fixture authors and independent reviewers have persisted, explicitly distinct parents. */
function fixture(t, { third = false, noIndependentClaude = false } = {}) {
  const board = fixtureBoard(t);
  // These cases prove the composition-fallback rules that the head-builder-family engine replaced.
  board.executionEngineVersion = REVIEW_HEAD_BUILDER_FAMILY_ENGINE - 1;
  const seats = [['coordinator', 'coordinator', undefined, 'f'], ['core-1', 'core', 'openai', 'a'],
    ['core-2', 'core', 'claude', 'b'], ['core-3', 'core', 'openai', 'c'], ['core-4', 'core', 'claude', 'd'],
    ['core-5', 'core', 'claude', 'b']];
  if (third) seats.push(['core-6', 'core', 'gemini', 'e']);
  for (const [id, lane, family, parent] of seats) {
    if (noIndependentClaude && id === 'core-4') continue;
    store.register(board, { id, lane, path: `/fixture/${id}`, family, parentDigest: parent.repeat(64), session: parent.repeat(64), model: 'Synthetic fixture model' });
    heartbeatSeat(board, id);
  }
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Composition fixture', sensitive: true });
  /** Claim through the native guard, never direct item-state writes. */
  const claim = builder => store.claim(board, id, { agentId: builder, lane: 'core', leaseMs: 3_600_000, freeze });
  /** Attach real patch bytes through native author binding and reachability. */
  const attach = (author, key = 'companion') => store.attachItemPatch(board, id, { agentId: 'coordinator', key, commit: COMMIT, patch: PATCH, author, presubmit: true });
  /** Record only a synthetic board proof shape; this fixture makes no runtime receipt claim. */
  const submit = lines => store.submit(board, id, { agentId: 'core-1', commit: COMMIT, tree: TREE, files: [],
    ...(lines === undefined ? {} : { submissionSize: { base: 'c'.repeat(40), head: COMMIT, lines, method: 'added-plus-deleted-no-renames' } }),
    submissionProof: { version: 1, files: [], full: false, deferred: true, reason: 'synthetic native board-state fixture; no execution proof' } });
  const projection = () => reviewEligibility(board, store.getItem(board, id), REVIEW);
  return { board, id, claim, attach, submit, projection };
}

test('Strict uses current material authors, excluding earlier holders and removed companions from fresh review rules [V4,H16]', t => {
  const f = fixture(t);
  f.claim('core-2');
  f.attach('core-2', 'removed');
  store.removeItemPatch(f.board, f.id, { agentId: 'coordinator', key: 'removed' });
  store.release(f.board, f.id, 'core-2', 'Private fixture hands off without source adoption', 'ROUTED_ELSEWHERE');
  f.claim('core-1');
  f.attach('core-3', 'current');
  f.submit();
  const result = f.projection();
  assert.ok(result.eligible.includes('core-2'), JSON.stringify(result));
  assert.ok(result.eligible.includes('core-4'));
  assert.ok(result.ineligible.some(row => row.agent === 'core-3' && row.code === 'SELF_VERIFY'));
  store.reserveReview(f.board, f.id, { agentId: 'core-2', leaseMs: 60_000, ...REVIEW });
  assert.equal(store.getItem(f.board, f.id).item_review_by, 'core-2');
});

test('a current companion family stays excluded when a third joined family can independently review [V4]', t => {
  const f = fixture(t, { third: true });
  f.claim('core-1'); f.attach('core-2'); f.submit();
  const result = f.projection();
  assert.equal(result.owner, undefined, 'no fallback while an unauthored family exists');
  assert.ok(result.ineligible.some(row => row.agent === 'core-4' && row.code === 'SAME_FAMILY'));
  assert.ok(result.eligible.includes('core-6'));
});

test('mixed-family composition remains independently reviewable while every current author and parent stays excluded [V4,H16]', t => {
  const f = fixture(t);
  f.claim('core-1'); f.attach('core-2');
  f.board.executionEngineVersion = REVIEW_HEAD_BUILDER_FAMILY_ENGINE - 1;
  assert.doesNotThrow(() => submitPreflight(f.board, f.id, { agentId: 'core-1', commit: COMMIT, tree: TREE },
    { atomic: store.atomic, submit: store.submit }, { refuse: (board, item) => refuseUnreviewable(board, item, REVIEW) }));
  f.submit();
  f.board.executionEngineVersion = REVIEW_HEAD_BUILDER_FAMILY_ENGINE - 1; // moves above raise the board engine; this case proves the replaced rules
  const result = f.projection();
  assert.equal(result.owner, 'core-1', 'missing legacy size chooses the last builder');
  assert.ok(result.eligible.includes('core-4'), JSON.stringify(result));
  for (const author of ['core-1', 'core-2']) assert.ok(result.ineligible.some(row => row.agent === author && row.code === 'SELF_VERIFY'));
  assert.ok(result.ineligible.some(row => row.agent === 'core-5' && row.code === 'SELF_SESSION_VERIFY'));
  assert.doesNotThrow(() => refuseUnreviewable(f.board, store.getItem(f.board, f.id), REVIEW));
  const report = healthReport({ db: f.board.db, root: process.cwd(), config: { verify: REVIEW }, now: f.board.clock.now(), dispatchHealth: () => ({ findings: [] }) });
  assert.equal(report.stuck.some(row => row.cause === 'NO_ELIGIBLE_REVIEWER' && row.item === f.id), false);
  // health reads the board at its real engine, where nothing is relaxed and so no fallback owner is reported
  assert.equal(report.waiting.some(row => row.cause === 'REVIEW_FAMILY_FALLBACK' && row.item === f.id), false);
});

test('owner uses matching native submit size against active patch hunk lines; a tie retains last builder [V4,H16]', t => {
  for (const [lines, expected, eligible] of [[1, 'core-2', 'core-3'], [4, 'core-1', 'core-4'], [5, 'core-1', 'core-4']]) {
    const f = fixture(t); f.claim('core-1'); f.attach('core-2'); f.submit(lines);
    assert.equal(compositionOwner(f.board, store.getItem(f.board, f.id)), expected);
    const result = f.projection();
    assert.equal(result.owner, expected);
    assert.ok(result.eligible.includes(eligible), JSON.stringify(result));
    assert.ok(result.ineligible.some(row => row.agent === 'core-2' && row.code === 'SELF_VERIFY'));
  }
});

test('old ordered review semantics still exclude historical contributors and refuse mixed-family reachability [V4,H16]', t => {
  const f = fixture(t); f.claim('core-1'); f.attach('core-2'); f.submit();
  f.board.executionEngineVersion = STRICT_COMPOSITION_ENGINE - 1;
  const result = f.projection();
  assert.equal(result.owner, undefined);
  assert.ok(result.ineligible.some(row => row.agent === 'core-4' && row.code === 'O2_FAMILY_MATCH'));
  assert.throws(() => refuseUnreviewable(f.board, store.getItem(f.board, f.id), REVIEW), { code: 'NO_ELIGIBLE_REVIEWER' });
});

test('current strict local session checks ignore superseded ledger claims but still refuse current authors [V4,H16]', t => {
  const f = fixture(t); f.claim('core-1'); f.attach('core-2'); f.submit();
  const commonDir = mkdtempSync(join(tmpdir(), 'pullboard-current-author-'));
  t.after(() => rmSync(commonDir, { recursive: true, force: true }));
  const info = { commonDir }, digest = 'e'.repeat(64), item = store.getItem(f.board, f.id);
  mkdirSync(join(commonDir, 'pullboard'));
  recordItemSession(info, f.id, 'claim', digest);
  assert.throws(() => refuseSelfSession(info, item, digest, ['core-1', 'core-2']), { code: 'SELF_SESSION_VERIFY' }, 'historical default ledger semantics are unchanged');
  const options = compositionSessionOptions(f.board, item);
  assert.doesNotThrow(() => refuseSelfSession(info, item, digest, ['core-1', 'core-2'], options), 'a former holder ledger row is not current material');
  writeFileSync(join(commonDir, 'pullboard-checkout-session.json'), JSON.stringify({ agent: 'core-2', digest }));
  assert.throws(() => refuseSelfSession(info, item, digest, ['core-1', 'core-2'], options), { code: 'SELF_SESSION_VERIFY' }, 'a current companion author remains excluded locally');
  rmSync(join(commonDir, 'pullboard-checkout-session.json'));
  assert.throws(() => refuseSelfSession(info, item, digest, [], { currentAuthorSessions: [digest] }), { code: 'SELF_SESSION_VERIFY' }, 'immutable current session snapshots refuse even without a local seat binding');
});

test('new native activation fences downgraded review while preserving genuine historical receipt bytes [V4,H16]', t => {
  const f = fixture(t); f.claim('core-1'); f.attach('core-3'); f.submit();
  const args = [f.id, { agentId: 'core-2', lane: 'core', leaseMs: 60_000, ...REVIEW }];
  const old = { ...prepareEngineMove(f.board, 'reserveReview', args, { id: 'old-composition-review' }), engine: STRICT_COMPOSITION_ENGINE - 1 };
  const first = applyEngineMove(f.board, old, { sequence: 1, at: f.board.clock.now().toISOString() });
  assert.equal(first.error, undefined);
  const receipt = f.board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`relay_receipt_${old.id}`).meta_value;
  store.release(f.board, f.id, 'core-2', 'Private historical reservation ends before rollout', 'OTHER');
  const activate = prepareEngineMove(f.board, 'appendFact', [f.id, { agentId: 'coordinator', kind: 'note', text: 'Private native activation control.' }]);
  assert.equal(applyEngineMove(f.board, activate, { sequence: 2, at: f.board.clock.now().toISOString() }).error, undefined);
  const fresh = prepareEngineMove(f.board, 'reserveReview', [f.id, { ...args[1], agentId: 'core-4' }]);
  const before = exportBoard(f.board);
  assert.throws(() => applyEngineMove(f.board, { ...fresh, engine: STRICT_COMPOSITION_ENGINE - 1 }, { sequence: 3, at: f.board.clock.now().toISOString() }), { code: 'RELAY_MOVE' });
  assert.deepEqual(exportBoard(f.board), before);
  assert.equal(applyEngineMove(f.board, fresh, { sequence: 3, at: f.board.clock.now().toISOString() }).error, undefined);
  assert.deepEqual(applyEngineMove(f.board, old, { sequence: 1, at: f.board.clock.now().toISOString() }), first);
  assert.equal(f.board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`relay_receipt_${old.id}`).meta_value, receipt);
});

test('real submit preflight uses candidate size for companion-owned reachability and rolls every observation back [V4,H16]', t => {
  const f = fixture(t, { noIndependentClaude: true });
  f.claim('core-1');
  // A real legacy attachment predates the reachability guard; upgrading must not strand its composition.
  f.board.executionEngineVersion = NO_ELIGIBLE_REVIEWER_ENGINE - 1;
  f.attach('core-2');
  f.board.executionEngineVersion = REVIEW_HEAD_BUILDER_FAMILY_ENGINE - 1;
  const ports = { atomic: store.atomic, submit: store.submit };
  const review = { refuse: (board, item) => refuseUnreviewable(board, item, REVIEW) };
  const before = exportBoard(f.board);
  assert.throws(() => submitPreflight(f.board, f.id, { agentId: 'core-1', commit: COMMIT, tree: TREE }, ports, review), { code: 'NO_ELIGIBLE_REVIEWER' }, 'missing counts conservatively choose the last builder');
  assert.deepEqual(exportBoard(f.board), before);
  assert.doesNotThrow(() => submitPreflight(f.board, f.id, { agentId: 'core-1', commit: COMMIT, tree: TREE,
    submissionSize: { base: 'c'.repeat(40), head: COMMIT, lines: 1, method: 'added-plus-deleted-no-renames' } }, ports, review), 'matching candidate size selects companion owner and permits independent OpenAI core-3');
  assert.deepEqual(exportBoard(f.board), before, 'preflight records no submit, size, event or authority');
});
