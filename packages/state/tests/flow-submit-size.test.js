/** Flow size buckets retain the exact observed Git comparison on the native submission [R1,R2,V4]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../src/board.js';
import { openBoard } from '../../../apps/lib/index.js';
import { createE2eHelpers } from '../../../test/e2e-helpers.js';
import {
  applyEngineMove,
  applyRelayMove,
  prepareEngineMove,
} from '../src/shell/engine.js';
import {
  exportBoard,
  importBoard,
} from '../../store/index.js';
import { FLOW_SIZE_ENGINE } from '../../../src/flow-size-engine.js';
import { appliedSequence } from '../src/shell/engine.js';
import { ENGINE_VERSION } from '../src/shell/machine.js';
import { replayHistoricalSeatMove } from '../../../test/pre-grant-seats.js';
import { fixtureAdd } from '../../../test/testkit-fixture.js';

test('a native submit records its immutable changed-line base and head for flow buckets [R1,R2,V4]', { timeout: 60_000 }, t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const added = fixtureAdd(box.run, box.repo, 'web', 'Measure submitted lines', '--specs', 'G1',
    '--criterion', 'The measured page exists.', '--check', 'test -f web/size.txt', '--route', 'strong');
  assert.equal(added.code, 0, added.out + added.err);
  const claimed = box.run(box.web, 'claim', '1');
  assert.equal(claimed.code, 0, claimed.out + claimed.err);
  const base = box.git(box.repo, 'rev-parse', 'main');
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web/size.txt'), Array.from({ length: 100 }, (_, n) => `line ${n}\n`).join(''));
  box.git(box.web, 'add', 'web/size.txt');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): add measured page [G1]');
  const head = box.git(box.web, 'rev-parse', 'HEAD');
  const submitted = box.run(box.web, 'submit', '1');
  assert.equal(submitted.code, 0, submitted.out + submitted.err);
  const json = box.run(box.repo, 'stats', '--json');
  assert.equal(json.code, 0, json.out + json.err);
  const report = JSON.parse(json.out).stats.flow.report;
  assert.ok(report, 'stats JSON includes the same event-derived report');
  assert.deepEqual(report.items.find(item => item.id === 1).sizeBuckets['100to300'],
    { accepted: 0, decided: 0, rate: null, unknown: 1 }, 'a real undecided 100-line first attempt has a known bucket and an unknown verdict');
  const text = box.run(box.repo, 'stats');
  assert.equal(text.code, 0, text.out + text.err);
  assert.match(text.out, /flow report/u);
  assert.match(text.out, /waiting for an agent/u);
  assert.match(text.out, /filed for later/u);
  assert.match(text.out, /item #1/u);
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  try {
    const events = store.events(board);
    const submission = events.findLast(event => event.event_kind === 'submit');
    const detail = JSON.parse(submission.event_detail);
    assert.deepEqual(detail.submissionSize, { base, head, lines: 100, method: 'added-plus-deleted-no-renames' },
      'the observed count is bound to the actual submit comparison, rather than reconstructed from later main');
    assert.equal(detail.commit, head);
    const before = submission.event_detail;
    writeFileSync(join(box.repo, 'later.txt'), 'later trunk change\n');
    box.git(box.repo, 'add', 'later.txt');
    box.git(box.repo, 'commit', '-q', '-m', 'chore: advance the fixture trunk');
    assert.equal(store.events(board).find(event => event.event_id === submission.event_id).event_detail, before,
      'advancing the trunk leaves the earlier submission measurement unchanged');
  } finally { store.closeBoard(board); }
});

test('submission size replays identically and refuses unsupported or malformed measurements [R1,R2,H16]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  // A native board must know its repository, so the fixture boards live in a repo's .git/pullboard as Pullboard stores them.
  const box = helpers.project('true', helpers.sandbox(), { withWorktree: false });
  const source = openBoard(join(box.repo, '.git/pullboard/source.sqlite'));
  source.gitRoot = box.repo; // The native CLI binds its repository on open; this fixture binds it the same way.
  const copies = [];
  t.after(() => { for (const board of [source, ...copies]) store.closeBoard(board); });
  // The older submit control needs joins and a claim that its writer could actually have recorded.
  const historicalEngine = FLOW_SIZE_ENGINE - 1;
  replayHistoricalSeatMove(source, historicalEngine, 'register', [{ lane: 'coordinator', path: '/fixture/main' }]);
  replayHistoricalSeatMove(source, historicalEngine, 'register', [{ lane: 'web', path: '/fixture/web' }]);
  const id = store.addItem(source, { by: 'coordinator', lane: 'web', title: 'Size replay' });
  replayHistoricalSeatMove(source, historicalEngine, 'claim', [id, { agentId: 'web-1', lane: 'web', leaseMs: 3_600_000,
    freeze: () => ({ text: '{"rows":[]}', digest: 'f'.repeat(64) }) }]);
  const document = exportBoard(source);
  for (let index = 0; index < 4; index += 1) {
    const board = openBoard(join(box.repo, `.git/pullboard/replica-${index}.sqlite`));
    board.gitRoot = box.repo;
    importBoard(board, document);
    copies.push(board);
  }
  const size = { base: 'a'.repeat(40), head: 'b'.repeat(40), lines: 0, method: 'added-plus-deleted-no-renames' };
  const options = { agentId: 'web-1', commit: size.head, tree: 'c'.repeat(40), submissionSize: size, policyCommit: box.git(box.repo, 'rev-parse', 'HEAD').trim(),
    submissionProof: { version: 1, files: [], full: false, deferred: true, reason: 'private replay fixture' } };
  const move = prepareEngineMove(source, 'submit', [id, options], { id: 'size-replay', actor: 'web-1' });
  assert.equal(move.engine, ENGINE_VERSION, 'the modern measurement is produced by the current engine');
  const receipt = { sequence: appliedSequence(source) + 1, at: '2026-10-25T06:00:00.000Z', kind: 'move',
    sender: { kind: 'agent', userId: 'fixture', agent: 'web-1' } };
  const first = applyRelayMove(copies[0], move, receipt);
  assert.equal(first.error, undefined);
  assert.deepEqual(applyRelayMove(copies[1], move, receipt), first);
  assert.deepEqual(store.events(copies[0]), store.events(copies[1]));
  assert.deepEqual(JSON.parse(store.events(copies[0]).findLast(event => event.event_kind === 'submit').event_detail).submissionSize, size,
    'a measured zero remains known, with its exact base and head');
  const before = store.events(copies[2]);
  assert.throws(() => applyEngineMove(copies[2], { ...move, engine: FLOW_SIZE_ENGINE - 1 }, receipt), { code: 'RELAY_MOVE' });
  assert.deepEqual(store.events(copies[2]), before, 'unsupported metadata cannot partially change native history');
  for (const [index, change] of [{ lines: -1 }, { lines: 0.5 }, { lines: null }, { lines: Number.MAX_SAFE_INTEGER + 1 },
    { head: 'd'.repeat(40) }, { base: 'missing' }, { method: 'guess' }].entries()) {
    const forged = structuredClone(move);
    forged.id = `size-invalid-${index}`;
    Object.assign(forged.args[1].submissionSize, change);
    assert.equal(applyRelayMove(copies[2], forged, { ...receipt, sequence: receipt.sequence + index }).error?.code, 'SUBMISSION_PROOF');
    assert.deepEqual(store.events(copies[2]), before);
  }
  const legacy = structuredClone(move);
  legacy.engine = FLOW_SIZE_ENGINE - 1;
  delete legacy.args[1].submissionSize;
  for (const sealed of ['policyCommit', 'clausePolicyCommit', 'inspectClauses']) delete legacy.args[1][sealed]; // an older engine never sealed a policy
  assert.equal(applyRelayMove(copies[3], legacy, receipt).error, undefined);
  assert.equal(Object.hasOwn(JSON.parse(store.events(copies[3]).findLast(event => event.event_kind === 'submit').event_detail), 'submissionSize'), false,
    'an older sealed submit remains executable and its missing size remains unknown');
});
