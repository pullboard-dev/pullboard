/** Flow size buckets retain the exact observed Git comparison on the submission [R1,R2,V4]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { exportBoard } from '../../../../../packages/store/index.js';
import { importBoard } from '../../../../../packages/store/index.js';
import { counterProofStats } from '../../../../../packages/verify/index.js';
import { changedLines } from '../../../../../packages/items/index.js';
import {
  flowLines,
  flowReportLines,
  proofStats,
} from '../../../../../packages/stats/index.js';
import {
  ENGINE_VERSION,
  SUBMISSION_SIZE_METHOD,
  appliedSequence,
  applyEngineMove,
  applyRelayMove,
  prepareEngineMove,
} from '../../../../../packages/state/index.js';
import { FLOW_SIZE_ENGINE } from '../../../../../packages/state/light.js';
import { cellBoard } from '../../../../../packages/store/tests/fixtures/cell.js';
import { cellItem } from '../../../../../packages/store/tests/fixtures/cell.js';
import { cellProject } from '../../../../../packages/store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../../packages/store/tests/fixtures/cell.js';
import { submitFixture } from '../../fixtures/board/submit.js';
import { replayHistoricalSeatMove } from '../../fixtures/seats.js';

const HOUR = 3_600_000;

test('a submit records its immutable changed-line base and head for flow buckets [R1,R2,V4]', { timeout: 60_000 }, t => {
  const project = cellProject(t, { gate: 'true' });
  const repo = project.repo;
  const web = join(project.dir, 'web');
  project.git(repo, 'worktree', 'add', '-q', web, '-b', 'web/one');
  const board = cellBoard(t, project.boardFile, undefined, { gitRoot: repo });
  cellSeat(board, { lane: 'coordinator', path: repo });
  const agentId = cellSeat(board, { lane: 'web', path: web }).id;
  const { item_id: id } = cellItem(board, { lane: 'web', title: 'Measure submitted lines', specIds: ['G1'],
    criterion: 'The measured page exists.', check: 'test -f web/size.txt', route: 'strong' });
  assert.equal(id, 1);
  const frozen = JSON.stringify({ criterion: 'The measured page exists.' });
  const digest = createHash('sha256').update(frozen).digest('hex');
  const base = project.git(repo, 'rev-parse', 'main');
  store.claim(board, id, { agentId, lane: 'web', leaseMs: 2 * HOUR, freeze: () => ({ text: frozen, digest }), head: base });
  mkdirSync(join(web, 'web'), { recursive: true });
  writeFileSync(join(web, 'web/size.txt'), Array.from({ length: 100 }, (_, n) => `line ${n}\n`).join(''));
  project.git(web, 'add', 'web/size.txt');
  project.git(web, 'commit', '-q', '-m', 'feat(web): add measured page [G1]');
  const head = project.git(web, 'rev-parse', 'HEAD');
  // The submit measures the changed lines of its commit against main, exactly as the command does, and seals that comparison.
  const lines = changedLines(web, base, head);
  assert.equal(lines, 100);
  const policyCommit = project.git(repo, 'rev-parse', 'main');
  submitFixture(board, id, { agentId, commit: head, tree: project.git(web, 'rev-parse', `${head}^{tree}`), policyCommit, clausePolicyCommit: policyCommit,
    submissionSize: { base, head, lines, method: SUBMISSION_SIZE_METHOD } });
  const stats = proofStats(board, { now: Date.now() }, { events: store.events, counterProofStats });
  const report = stats.flow.report;
  assert.ok(report, 'the statistics include the same event-derived report');
  assert.deepEqual(report.items.find(item => item.id === 1).sizeBuckets['100to300'],
    { accepted: 0, decided: 0, rate: null, unknown: 1 }, 'a real undecided 100-line first attempt has a known bucket and an unknown verdict');
  const text = [...flowLines(stats.flow), ...flowReportLines(stats.flow)].join('\n');
  assert.match(text, /flow report/u);
  assert.match(text, /waiting for an agent/u);
  assert.match(text, /filed for later/u);
  assert.match(text, /item #1/u);
  const events = store.events(board);
  const submission = events.findLast(event => event.event_kind === 'submit');
  const detail = JSON.parse(submission.event_detail);
  assert.deepEqual(detail.submissionSize, { base, head, lines: 100, method: 'added-plus-deleted-no-renames' },
    'the observed count is bound to the actual submit comparison, rather than reconstructed from later main');
  assert.equal(detail.commit, head);
  const before = submission.event_detail;
  writeFileSync(join(repo, 'later.txt'), 'later trunk change\n');
  project.git(repo, 'add', 'later.txt');
  project.git(repo, 'commit', '-q', '-m', 'chore: advance the fixture trunk');
  assert.equal(store.events(board).find(event => event.event_id === submission.event_id).event_detail, before,
    'advancing the trunk leaves the earlier submission measurement unchanged');
});

test('submission size replays identically and refuses unsupported or malformed measurements [R1,R2,H16]', t => {
  // A native board must know its repository, so the fixture boards live in a repo's .git/pullboard as Pullboard stores them.
  const box = cellProject(t, { gate: 'true' });
  const source = cellBoard(t, join(box.repo, '.git/pullboard/source.sqlite'), undefined, { gitRoot: box.repo });
  const copies = [];
  // The older submit control needs joins and a claim that its writer could actually have recorded.
  const historicalEngine = FLOW_SIZE_ENGINE - 1;
  replayHistoricalSeatMove(source, historicalEngine, 'register', [{ lane: 'coordinator', path: '/fixture/main' }]);
  replayHistoricalSeatMove(source, historicalEngine, 'register', [{ lane: 'web', path: '/fixture/web' }]);
  const id = store.addItem(source, { by: 'coordinator', lane: 'web', title: 'Size replay' });
  replayHistoricalSeatMove(source, historicalEngine, 'claim', [id, { agentId: 'web-1', lane: 'web', leaseMs: 3_600_000,
    freeze: () => ({ text: '{"rows":[]}', digest: 'f'.repeat(64) }) }]);
  const document = exportBoard(source);
  for (let index = 0; index < 4; index += 1) {
    const board = cellBoard(t, join(box.repo, `.git/pullboard/replica-${index}.sqlite`), undefined, { gitRoot: box.repo });
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
