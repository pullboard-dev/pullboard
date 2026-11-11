/** Submission receipts distinguish actual selection from later landing escapes [C7,V4]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import {
  appliedSequence,
  applyEngineMove,
  applyRelayMove,
  engineReceipt,
  prepareEngineMove,
} from '../../../../packages/state/index.js';
import {
  exportBoard,
  importBoard,
} from '../../../../packages/store/index.js';
import { SUBMISSION_PROOF_ENGINE } from '../../../../packages/state/index.js';
import { landingFileTimes } from '../../../../packages/items/index.js';
import { submitInvariantProposals } from '../../../../packages/items/index.js';
import { ENGINE_VERSION } from '../../../../packages/state/index.js';
import { landingFailures } from '../../../../packages/landing/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { repositoryBoardFile } from '../../tests/fixtures/board/submit.js';
import { replayHistoricalSeatMove } from '../../tests/fixtures/seats.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/**
 * Give one disk fixture board its own real repository, so the board knows its repository [C7,V4].
 * @param {{dir: string}} box
 * @param {string} name
 * @returns {any} the opened board, bound to that repository as the native CLI binds it on open
 */
function repoBoard(box, name) {
  const directory = join(box.dir, `repo-${name.replace(/\.sqlite$/u, '')}`);
  mkdirSync(directory, { recursive: true });
  const board = openBoard(repositoryBoardFile(directory));
  board.gitRoot = directory;
  return board;
}

/**
 * Open a replica board file bound to the same fixture repository as its source, so replay reads the policy the source sealed [C7,V4].
 * @param {{dir: string}} box
 * @param {string} name
 * @param {any} source
 * @returns {any}
 */
function replicaBoard(box, name, source) {
  const board = openBoard(join(box.dir, name));
  board.gitRoot = source.gitRoot;
  return board;
}

/** The commit that holds a repository-bound fixture board's accepted policy, which a submit seals. */
function fixtureHead(board) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: board.gitRoot, encoding: 'utf8' }).trim();
}

/** Read a fixture's real board through its public interface. */
function onBoard(box, action) {
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  try { return action(board); } finally { store.closeBoard(board); }
}

/** Run the real fixture CLI, preserving a refusal as an assertion failure. */
function json(box, root, ...args) {
  const result = box.run(root, ...args, '--json');
  assert.equal(result.code, 0, result.err + result.out);
  return JSON.parse(result.out);
}

/** Record synthetic landing history through the public operation, never direct database writes. */
function landing(box, id, submit, commit, files, diagnostics = [], green = false) {
  return onBoard(box, board => store.recordLandingBatch(board, {
    agentId: 'coordinator', batch: {
      version: 1, id, base: submit.policyCommit, tip: commit, root: join(box.dir, id),
      branch: 'refs/heads/main', owner: 'fixture', state: 'blocked', logPath: join(box.dir, id + '.log'),
      items: [{ id: submit.id, commit: submit.commit }],
      gateResults: [{ commit, tree: 'e'.repeat(40), isGreen: green,
        submissions: [{ id: submit.id, commit: submit.commit }],
        failures: green ? [] : files.map(file => ({ file: file.path, name: file.path + ' contract' })),
        fileTimes: files, logPath: join(box.dir, id + '.log') }],
      invariantEvidence: { version: 1, gates: [{ commit, isGreen: green,
        submissions: [{ id: submit.id, commit: submit.commit }],
        failures: green ? [] : files.map(file => file.path), fileTimes: files }], diagnostics },
    },
  }));
}

test('a landing escape is proposed as a submit invariant [C7,V4]', async () => {
  const box = e2e.project('node --test web/page.test.js');
  const configPath = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.submitGate = 'landing';
  config.affectedTests = 'node --test';
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web/page.js'), 'export const page = 1;\n');
  writeFileSync(join(box.repo, 'web/page.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { page } from './page.js';\ntest('page contract', () => assert.ok(page));\n");
  writeFileSync(join(box.repo, 'web/other.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('unrelated contract', () => assert.ok(true));\n");
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure private selection');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const made = json(box, box.repo, 'add', 'web', 'change the page', '--specs', 'G1',
    '--criterion', 'The page remains present.', '--check', 'node --test web/page.test.js', '--wait');
  const id = made.item.item_id;
  json(box, box.web, 'claim', String(id));
  assert.equal(e2e.commitFile(box, box.web, 'web/page.js', 'export const page = 2;\n',
    'feat(web): update page [G1]').status, 0);
  json(box, box.web, 'submit', String(id), '--wait', '--no-next');
  const event = onBoard(box, board => store.events(board, { itemId: id }).findLast(row => row.event_kind === 'submit'));
  const submit = { id, ...JSON.parse(event.event_detail) };
  assert.ok(submit.submissionProof, 'the actual submit event retains the selected files instead of relying on its human note');
  assert.equal(submit.submissionProof.full, false);
  assert.deepEqual(submit.submissionProof.files, ['web/page.test.js']);
  assert.equal(submit.submissionProof.reason, '');
  assert.equal(submit.submissionProof.deferred, true);
  assert.equal(submit.submissionProof.version, 1);

  const first = 'a'.repeat(40);
  const second = 'b'.repeat(40);
  const third = 'c'.repeat(40);
  landing(box, 'earlier-green', submit, first, [], [], true);
  landing(box, 'first-escape', submit, first, [
    { path: 'test/repeated.test.js', durationMs: 4000 },
    { path: 'test/once.test.js', durationMs: 1000 },
    { path: 'test/slow.test.js', durationMs: 70000 },
    { path: 'web/page.test.js', durationMs: 12 },
    { path: 'test/recovered.test.js', durationMs: 50 },
    { path: 'test/other-commit.test.js', durationMs: 75 },
    { path: 'test/unknown.test.js', durationMs: null },
  ], [
    { test: 'test/recovered.test.js', isGreen: true, commit: first, wallMs: 52 },
    { test: 'test/other-commit.test.js', isGreen: true, commit: second, wallMs: 76 },
  ]);
  landing(box, 'second-escape', submit, second, [
    { path: 'test/repeated.test.js', durationMs: 4500 },
    { path: 'test/slow.test.js', durationMs: 80000 },
  ]);
  // A second receipt of the same merge is evidence custody, not another escaped merge.
  landing(box, 'duplicate-receipt', submit, second, [{ path: 'test/repeated.test.js', durationMs: 4500 }]);
  const recoveredCommit = 'f'.repeat(40);
  landing(box, 'full-recovery-red', submit, recoveredCommit, [{ path: 'test/full-recovered.test.js', durationMs: 25 }]);
  landing(box, 'later-full-green', submit, recoveredCommit, [], [], true);
  onBoard(box, board => {
    const previous = store.landingBatches(board).find(batch => batch.id === 'first-escape');
    const eventCount = store.events(board).length;
    assert.throws(() => store.recordLandingBatch(board, { agentId: 'coordinator', revision: previous.revision,
      batch: { ...previous, invariantEvidence: { ...previous.invariantEvidence, gates: [] } } }), { code: 'LAND_EVIDENCE' });
    assert.equal(store.events(board).length, eventCount, 'a prior receipt cannot be removed or rewritten');
    // Modern evidence names Git OIDs, whose full hexadecimal shape is SHA-1 or SHA-256.
    for (const length of [41, 63]) for (const field of ['gate', 'submission', 'diagnostic']) {
      const malformed = structuredClone(previous);
      if (field === 'diagnostic') {
        malformed.invariantEvidence.diagnostics.push({ commit: 'e'.repeat(length), test: 'test/oid.test.js', isGreen: true, wallMs: 1 });
      } else {
        const gate = structuredClone(previous.invariantEvidence.gates[0]);
        if (field === 'gate') gate.commit = 'e'.repeat(length);
        else gate.submissions[0].commit = 'e'.repeat(length);
        malformed.invariantEvidence.gates.push(gate);
      }
      assert.throws(() => store.recordLandingBatch(board, { agentId: 'coordinator', revision: previous.revision, batch: malformed }),
        { code: 'LAND_EVIDENCE' }, `${field} evidence rejects a ${length}-digit pseudo-commit`);
      assert.equal(store.events(board).length, eventCount, 'malformed exact-commit evidence adds no event');
      assert.deepEqual(store.landingBatches(board).find(batch => batch.id === previous.id), previous, 'malformed evidence preserves its prior revision');
    }
    const oid = 'f'.repeat(64);
    const valid = { ...previous, id: 'sha256-evidence-control', invariantEvidence: { version: 1,
      gates: [{ commit: oid, isGreen: true, submissions: [{ id: submit.id, commit: oid }], failures: [], fileTimes: [] }],
      diagnostics: [{ commit: oid, test: 'test/oid.test.js', isGreen: true, wallMs: 1 }] } };
    const accepted = store.recordLandingBatch(board, { agentId: 'coordinator', batch: valid });
    assert.deepEqual(accepted.invariantEvidence, valid.invariantEvidence, '64-digit SHA-256 evidence remains representable; existing 40-digit receipts stay intact');
  });
  const untouchedConfig = readFileSync(configPath, 'utf8');
  const proposals = json(box, box.repo, 'status').submitInvariantProposals;
  onBoard(box, board => assert.deepEqual(submitInvariantProposals(store.submitInvariantEvents(board, config), config),
    submitInvariantProposals(store.eventsOfKinds(board, ['submit', 'landing_batch']), config),
    'targeted reads preserve repeated snapshots, exact-commit recovery, budgets and latest proof semantics'));
  assert.equal(proposals[0].file, 'test/repeated.test.js', 'a repeated escape below budget is first');
  const byFile = new Map(proposals.map(proposal => [proposal.file, proposal]));
  assert.equal(byFile.get('test/repeated.test.js').escapes, 2);
  assert.equal(byFile.get('test/repeated.test.js').runtimeMs, 4500);
  assert.equal(byFile.get('test/repeated.test.js').budgetMs, 60000);
  assert.equal(byFile.get('test/repeated.test.js').withinBudget, true);
  assert.equal(byFile.get('test/slow.test.js').withinBudget, false);
  assert.equal(byFile.get('test/unknown.test.js').runtimeMs, null, 'unmeasured is not zero');
  assert.equal(byFile.get('test/unknown.test.js').withinBudget, null);
  assert.ok(byFile.has('test/other-commit.test.js'), 'green on a different commit cannot erase the escape');
  assert.ok(byFile.has('test/once.test.js'), 'an earlier green at the same commit does not erase a later failure');
  assert.equal(byFile.has('test/full-recovered.test.js'), false, 'a later full green at the exact commit suppresses the escape');
  assert.equal(byFile.has('test/recovered.test.js'), false, 'whole-file green at the exact merge suppresses it');
  assert.equal(byFile.has('web/page.test.js'), false, 'a selected file did not escape selection');
  const human = box.run(box.repo, 'status');
  assert.equal(human.code, 0, human.err);
  assert.match(human.out, /submit invariant/u);
  assert.match(human.out, /test\/repeated\.test\.js/u);
  assert.match(human.out, /60\s*s/u);
  assert.match(human.out, /unmeasured/u);
  assert.equal(readFileSync(configPath, 'utf8'), untouchedConfig, 'status never auto-edits configuration');

  // Historical submits with no selection remain unknown, even if their human note mentions a fallback.
  onBoard(box, board => {
    const legacy = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'legacy submit' });
    // The existing CLI builder has a modern grant; a genuine old submit needs its own historical join/claim.
    const historicalEngine = SUBMISSION_PROOF_ENGINE - 1;
    const author = replayHistoricalSeatMove(board, historicalEngine, 'register', [{ lane: 'web', path: '/fixture/legacy-proofless-author' }]);
    replayHistoricalSeatMove(board, historicalEngine, 'claim', [legacy, { agentId: author, lane: 'web', leaseMs: 3600000,
      freeze: () => ({ text: '{"rows":[]}', digest: 'f'.repeat(64) }) }]);
    const legacyReceipt = applyEngineMove(board, { version: 1, engine: SUBMISSION_PROOF_ENGINE - 1,
      id: 'legacy-unknown-selection', operation: 'submit', args: [legacy, { agentId: author,
        commit: 'd'.repeat(40), tree: 'e'.repeat(40), note: 'full suite deferred to the landing gate' }] },
    { sequence: appliedSequence(board) + 1, at: new Date().toISOString() });
    assert.equal(legacyReceipt.error, undefined, 'a proofless previous-engine receipt remains legacy unknown');
    submit.legacy = legacy;
  });
  landing(box, 'legacy-unknown', { id: submit.legacy, commit: 'd'.repeat(40), policyCommit: submit.policyCommit }, third,
    [{ path: 'test/legacy.test.js', durationMs: 1 }]);
  assert.equal(json(box, box.repo, 'status').submitInvariantProposals.some(row => row.file === 'test/legacy.test.js'), false);
  onBoard(box, board => assert.deepEqual(submitInvariantProposals(store.submitInvariantEvents(board, config), config),
    submitInvariantProposals(store.eventsOfKinds(board, ['submit', 'landing_batch']), config),
    'proofless legacy submissions stay unknown in targeted history reads'));

  const fallbackItem = json(box, box.repo, 'add', 'web', 'change a non-module input', '--specs', 'G1',
    '--criterion', 'Non-module selection is recorded.', '--check', 'node --test web/other.test.js',
    // The brief names page.test.js; the item check runs a different file, so the gate's dedup of files the check already runs leaves the named file to run.
    '--brief', 'Files: web/style.css\nTest: web/page.test.js', '--wait').item.item_id;
  const fallbackTree = join(box.dir, 'web-fallback');
  box.git(box.repo, 'worktree', 'add', '-q', '-b', 'web/fallback', fallbackTree, 'main');
  json(box, fallbackTree, 'join', 'web');
  json(box, fallbackTree, 'claim', String(fallbackItem));
  assert.equal(e2e.commitFile(box, fallbackTree, 'web/style.css', 'body { color: red; }\n', 'feat(web): change non-module input [G1]').status, 0);
  json(box, fallbackTree, 'submit', String(fallbackItem), '--wait', '--no-next');
  const fallback = onBoard(box, board => store.events(board, { itemId: fallbackItem }).findLast(row => row.event_kind === 'submit'));
  const fallbackProof = JSON.parse(fallback.event_detail).submissionProof;
  assert.equal(fallbackProof.full, true);
  assert.equal(fallbackProof.deferred, true);
  // The gate runs the test files an item's bar names even when the full fallback is deferred (fc2b4817cc, 2a75f1ea71).
  assert.deepEqual(fallbackProof.files, ['web/page.test.js'], 'a deferred full fallback runs only the file its bar names, not its possible selection');
  assert.match(fallbackProof.reason, /style\.css/u, 'the actual full-fallback reason remains durable');

  delete config.submitGate;
  writeFileSync(configPath, JSON.stringify(config));
  assert.deepEqual(json(box, box.repo, 'status').submitInvariantProposals, [], 'feature is off outside landing submit policy');
});

test('submission selection replays on two replicas and legacy history remains unknown [C7,V4,H16]', t => {
  const box = e2e.sandbox();
  const source = repoBoard(box, 'source.sqlite');
  const copies = [];
  t.after(() => { for (const board of [source, ...copies]) store.closeBoard(board); });
  // Engine 12's proofless positive control must start from the joins and claim it could have written.
  replayHistoricalSeatMove(source, 12, 'register', [{ lane: 'coordinator', path: '/fixture/main' }]);
  replayHistoricalSeatMove(source, 12, 'register', [{ lane: 'web', path: '/fixture/web' }]);
  const id = store.addItem(source, { by: 'coordinator', lane: 'web', title: 'selection replica' });
  replayHistoricalSeatMove(source, 12, 'claim', [id, { agentId: 'web-1', lane: 'web', leaseMs: 3600000,
    freeze: () => ({ text: '{"rows":[]}', digest: 'f'.repeat(64) }) }]);
  const document = exportBoard(source);
  for (let index = 0; index < 4; index += 1) {
    const board = replicaBoard(box, `replica-${index}.sqlite`, source);
    importBoard(board, document); copies.push(board);
  }
  const options = { agentId: 'web-1', commit: 'a'.repeat(40), tree: 'b'.repeat(40), policyCommit: fixtureHead(source),
    submissionProof: { version: 1, files: ['test/a.test.js'], full: false, deferred: true, reason: '' } };
  const move = prepareEngineMove(source, 'submit', [id, options], { id: 'selection-replay', actor: 'web-1' });
  const receipt = { sequence: appliedSequence(source) + 1, at: '2026-10-17T00:00:00.000Z', kind: 'move',
    sender: { kind: 'agent', userId: 'fixture', agent: 'web-1' } };
  const first = applyRelayMove(copies[0], move, receipt);
  assert.equal(first.error, undefined);
  assert.deepEqual(applyRelayMove(copies[1], move, receipt), first);
  assert.deepEqual(store.events(copies[0]), store.events(copies[1]));
  assert.throws(() => applyEngineMove(copies[2], { ...move, engine: SUBMISSION_PROOF_ENGINE - 1 }, receipt), { code: 'RELAY_MOVE' });
  assert.equal(store.getItem(copies[2], id).item_status, 'claimed');
  const invalid = structuredClone(move);
  invalid.id = 'selection-invalid-path';
  invalid.args[1].submissionProof.files = ['../outside.test.js'];
  assert.equal(applyRelayMove(copies[2], invalid, receipt).error?.code, 'SUBMISSION_PROOF');
  assert.equal(store.getItem(copies[2], id).item_status, 'claimed', 'invalid coverage cannot submit the item');
  const legacy = structuredClone(move);
  legacy.engine = 12;
  delete legacy.args[1].submissionProof;
  for (const sealed of ['policyCommit', 'clausePolicyCommit', 'inspectClauses']) delete legacy.args[1][sealed]; // an older engine never sealed a policy
  const old = applyRelayMove(copies[3], legacy, receipt);
  assert.equal(old.error, undefined);
  const last = store.events(copies[3]).findLast(event => event.event_kind === 'submit');
  assert.equal(Object.hasOwn(JSON.parse(last.event_detail), 'submissionProof'), false);
  assert.deepEqual(landingFileTimes('/fixture', { files: [], tests: [{ file: 'test/a.test.js', durationMs: 8 }] }), [],
    'case-body duration is not a measured file duration');
  assert.deepEqual(landingFileTimes('/fixture', { files: [{ path: '/fixture/test/a.test.js', durationMs: 8 }, { path: '/elsewhere/private.js', durationMs: 1 }] }),
    [{ path: 'test/a.test.js', durationMs: 8 }], 'reported file timings are relative and cannot escape the project');
  const cancelled = "not ok 1 - cancelled child\n  location: /fixture/test/cancelled.test.js:1:1\n  failureType: 'cancelledByParent'\nnot ok 2 - actual failure\n  location: /fixture/test/failed.test.js:1:1\n  failureType: 'testCodeFailure'\nnot ok 3 - test/wrapper.test.js\n  failureType: 'subtestsFailed'\n";
  assert.equal(landingFailures(cancelled, '/fixture').length, 3, 'the existing landing parser behavior stays available');
  assert.deepEqual(landingFailures(cancelled, '/fixture', { excludeCancelled: true }), [{ file: 'test/failed.test.js', name: 'actual failure' }],
    'cancellation fallout and aggregate wrappers do not become independent escaped-file suggestions');
});

// Maintains the independent public receiver control from outside rejection 1061.
test('a landing escape is proposed as a submit invariant only when modern submits carry their receipt [C7,V4,H16]', t => {
  const box = e2e.sandbox();
  const source = repoBoard(box, 'modern-source.sqlite');
  const target = replicaBoard(box, 'modern-replica.sqlite', source);
  const legacyTarget = replicaBoard(box, 'legacy37-replica.sqlite', source);
  const replica = replicaBoard(box, 'modern-second-replica.sqlite', source);
  t.after(() => {store.closeBoard(source);store.closeBoard(target);store.closeBoard(legacyTarget);store.closeBoard(replica);});
  const historicalEngine = SUBMISSION_PROOF_ENGINE - 1;
  replayHistoricalSeatMove(source,historicalEngine,'register',[{lane:'coordinator',path:'/fixture/main'}]);
  replayHistoricalSeatMove(source,historicalEngine,'register',[{lane:'web',path:'/fixture/web'}]);
  const id=store.addItem(source,{by:'coordinator',lane:'web',title:'modern missing selection'});
  replayHistoricalSeatMove(source,historicalEngine,'claim',[id,{agentId:'web-1',lane:'web',leaseMs:3600000,freeze:()=>({text:'{"rows":[]}',digest:'f'.repeat(64)})}]);
  const sourcePrefix = appliedSequence(source);
  importBoard(target,exportBoard(source));
  importBoard(legacyTarget,exportBoard(source));
  importBoard(replica,exportBoard(source));
  const count=store.events(target).length;
  const options = {agentId:'web-1',commit:'a'.repeat(40),tree:'b'.repeat(40),policyCommit:fixtureHead(source)};
  const move=prepareEngineMove(source,'submit',[id,{...options,submissionProof:{version:1,
    files:[],full:false,deferred:true,reason:'controlled receiver envelope'}}],
    {id:'modern-missing-selection',actor:'web-1'});
  // Forge the missing wire field after valid preparation so the receiver assertion remains independent.
  delete move.args[1].submissionProof;
  assert.equal(SUBMISSION_PROOF_ENGINE,38,'submission receipts keep their stable first engine');
  assert.equal(move.engine,ENGINE_VERSION,'the new envelope uses the current engine, separately from the minimum');
  assert.equal(Object.hasOwn(move.args[1],'submissionProof'),false);
  const legacyMove = structuredClone({...move,engine:SUBMISSION_PROOF_ENGINE - 1,id:'legacy37-missing-selection'});
  for (const sealed of ['policyCommit','clausePolicyCommit','inspectClauses']) delete legacyMove.args[1][sealed]; // an older engine never sealed a policy
  const legacyResult = applyRelayMove(legacyTarget,legacyMove,{sequence:sourcePrefix+1,at:'2026-10-17T00:00:00.000Z',kind:'move',sender:{kind:'agent',userId:'fixture',agent:'web-1'}});
  assert.equal(legacyResult.error,undefined,'controlled engine37 proofless legacy still replays');
  assert.equal(store.getItem(legacyTarget,id).item_status,'submitted');
  const legacyEvent = store.events(legacyTarget).findLast(e=>e.event_kind==='submit');
  assert.equal(Object.hasOwn(JSON.parse(legacyEvent.event_detail),'submissionProof'),false,'legacy37 stays unknown without invented coverage');
  console.log('review696 legacy37 control '+JSON.stringify({engine:SUBMISSION_PROOF_ENGINE - 1,status:store.getItem(legacyTarget,id).item_status,recordedSelection:false}));
  const ordered = {sequence:sourcePrefix+1,at:'2026-10-17T00:00:00.000Z',kind:'move',sender:{kind:'agent',userId:'fixture',agent:'web-1'}};
  const result=applyRelayMove(target,move,ordered);
  const event=store.events(target).findLast(e=>e.event_kind==='submit');
  const detail=event ? JSON.parse(event.event_detail) : null;
  console.log('review696 modern missing proof '+JSON.stringify({engine:move.engine,error:result.error?.code??null,status:store.getItem(target,id).item_status,newEvents:store.events(target).length-count,submitEventPresent:!!event,recordedSelection:!!detail?.submissionProof}));
  assert.equal(result.error?.code,'SUBMISSION_PROOF','a current engine submit must record a selection instead of silently becoming unknown history');
  assert.equal(store.getItem(target,id).item_status,'claimed');
  assert.equal(store.events(target).length,count);
  assert.equal(appliedSequence(target), sourcePrefix + 1, 'a typed refusal still consumes its authenticated relay position');
  assert.deepEqual(engineReceipt(target, move.id)?.outcome, result, 'the refusal is retained as the move receipt');
  assert.deepEqual(applyRelayMove(target, move, ordered), result, 'redelivery returns the same durable refusal');
  assert.equal(appliedSequence(target), sourcePrefix + 1, 'redelivery does not advance twice');
  assert.equal(store.events(target).length, count, 'redelivery adds no submit event');
  assert.deepEqual(applyRelayMove(replica, move, ordered), result, 'another replica reaches the same refusal');
  assert.equal(appliedSequence(replica), sourcePrefix + 1, 'both replicas retain the same ordered prefix');
  assert.equal(store.getItem(replica, id).item_status, 'claimed');
  assert.deepEqual(store.events(replica), store.events(target), 'neither replica records a submit event');
  assert.deepEqual(engineReceipt(replica, move.id), engineReceipt(target, move.id), 'replica refusal receipts agree');
  const sourceEvents = store.events(source).length;
  assert.throws(() => store.submit(source,id,options), {code:'SUBMISSION_PROOF'},
    'a current local board submission also refuses missing selection');
  assert.throws(() => prepareEngineMove(source,'submit',[id,options],
    {id:'producer-missing-selection',actor:'web-1'}), {code:'SUBMISSION_PROOF'},
  'the current producer refuses a missing receipt before sealing a move');
  assert.equal(store.getItem(source, id).item_status, 'claimed');
  assert.equal(store.events(source).length, sourceEvents, 'local refusal writes no item event');
  assert.equal(appliedSequence(source), sourcePrefix, 'local refusal writes no relay position beyond the historical prefix');
  assert.equal(engineReceipt(source, 'producer-missing-selection'), null, 'local preparation writes no receipt');
});


// Controlled version-37 envelopes must not erase evidence already recorded under version 38.
for (const operation of ['recordLandingBatch', 'finishLandingBatch']) {
  test(`a landing escape is proposed as a submit invariant: retained landing receipts require their original engine for ${operation} [C7,V4,H16]`, t => {
    const box = e2e.sandbox();
    const current = openBoard(join(box.dir, 'retained-current.sqlite'));
    const legacy = openBoard(join(box.dir, 'retained-legacy37.sqlite'));
    t.after(() => { store.closeBoard(current); store.closeBoard(legacy); });
    for (const board of [current, legacy]) store.register(board, { lane: 'coordinator', path: '/fixture/main' });
    const batch = { version: 1, id: 'retained-receipt', base: 'a'.repeat(40), tip: 'b'.repeat(40),
      root: '/fixture/landing', branch: 'refs/heads/main', owner: 'fixture', state: 'pushed',
      logPath: '/fixture/landing.log', items: [] };
    // This synthetic normalized receipt exercises custody, not a claim of gate execution.
    const evidence = { version: 1, gates: [{ commit: batch.tip, isGreen: false, submissions: [],
      failures: ['test/escaped.test.js'], fileTimes: [{ path: 'test/escaped.test.js', durationMs: 10 }] }], diagnostics: [] };
    const previous = store.recordLandingBatch(current, { agentId: 'coordinator', batch: { ...batch, invariantEvidence: evidence } });
    const args = operation === 'recordLandingBatch'
      ? [{ agentId: 'coordinator', batch: { ...batch, state: 'blocked' }, revision: previous.revision }]
      : [{ agentId: 'coordinator', id: batch.id, tip: batch.tip }];
    const move = { ...prepareEngineMove(current, operation, args, { id: `older-retained-${operation}` }), engine: SUBMISSION_PROOF_ENGINE - 1 };
    // A reached legacy control starts without modern evidence, rather than deleting real history.
    const seeded = applyEngineMove(legacy, { version: 1, engine: SUBMISSION_PROOF_ENGINE - 1, id: 'legacy-only-batch',
      operation: 'recordLandingBatch', args: [{ agentId: 'coordinator', batch }] },
    { sequence: 1, at: '2026-10-17T00:00:00.000Z' });
    assert.equal(seeded.error, undefined, 'a controlled engine-37 batch still replays without invented evidence');
    const legacyResult = applyEngineMove(legacy, { ...move, id: `legacy-only-${operation}` },
      { sequence: 2, at: '2026-10-17T00:00:01.000Z' });
    assert.equal(legacyResult.error, undefined, 'the older operation still works on its own legacy batch');
    assert.equal(Object.hasOwn(store.landingBatches(legacy)[0], 'invariantEvidence'), false);
    const eventCount = store.events(current).length;
    let result;
    let thrown;
    try { result = applyEngineMove(current, move, { sequence: 1, at: '2026-10-17T00:00:02.000Z' }); }
    catch (error) { thrown = error; }
    const code = thrown?.code ?? result?.error?.code ?? null;
    const after = store.landingBatches(current)[0];
    console.log('review696 retained receipt boundary ' + JSON.stringify({ operation, engine: SUBMISSION_PROOF_ENGINE - 1, code,
      beforeEvidence: true, afterEvidence: Object.hasOwn(after, 'invariantEvidence'),
      newEvents: store.events(current).length - eventCount, legacyReached: true }));
    assert.equal(code, 'RELAY_MOVE', 'an older writer cannot adopt or finish a snapshot carrying a modern receipt');
    assert.deepEqual(after, previous, 'the retained receipt and batch revision remain byte-equivalent');
    assert.equal(store.events(current).length, eventCount, 'the refused old writer adds no board event');
  });
}
