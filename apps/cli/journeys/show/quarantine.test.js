/** @pullboard-test-input source-tree */
/** Actual private Submit cycles retain raw reds while repeated native pairs acquire quarantine authority [C7,H16]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
} from 'node:fs';
import {
  dirname,
  join,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import {
  flakyProject,
  TITLE,
} from '../../../../packages/git/tests/fixtures/flakes.js';
import { copyCommittedPackageFiles } from '../../tests/fixtures/copy.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import {
  openBoard,
  flakeQuarantines,
  gateRuns,
} from '../../../lib/index.js';
import * as store from '../../../../packages/store/index.js';
import {
  recordGateRun,
  requireSubmitDiagnosticAdmission,
  submitFlakePairs,
} from '../../../../packages/flakes/index.js';
import { recordGateRun as recordGateRunMove } from '../../../../packages/moves/index.js';
import { AUTO_SUBMIT_QUARANTINE_ENGINE } from '../../../../packages/state/light.js';
import { proofRunReceipt } from '../../../../packages/store/index.js';
import {
  readGateReceipt,
  receiptStore,
} from '../../../../packages/gate/index.js';

// The worktree join inherits PULLBOARD_MODEL; without it the join refuses with MODEL_REQUIRED before any case runs.
process.env.PULLBOARD_MODEL ??= 'Test Model';

/** Build genuine private package source and an ordinary joined/claimed builder; no receipt is fabricated. */
function fixture(t, deterministic = false, companion = false) {
  const box = flakyProject(t, { beforeInit: ({ root, git }) => {
    copyCommittedPackageFiles({ repo: root, git: (_root, ...args) => git(...args) }, resolve(import.meta.dirname, '../../../..'));
    // The copied test-cell listing guards new root tests; the fixture's own controlled target is a journey it lists.
    const listing = join(root, 'packages/gate/data/tests/test-cells.json');
    const cells = JSON.parse(readFileSync(listing, 'utf8'));
    cells.journeys['test/alternating.test.mjs'] = 'drives the controlled intermittent assertion through the real submit gate';
    writeFileSync(listing, JSON.stringify(cells, null, 2) + '\n');
    return join(root, 'apps/cli/pullboard.js');
  } });
  const config = JSON.parse(readFileSync(join(box.root, 'pullboard.json'), 'utf8'));
  config.lanes = { core: { owns: ['src/', 'test/', 'packages/controlled/'], specs: [] } };
  config.flakes = { rerun: true, quarantine: true };
  config.gate = 'node packages/gate/src/io/run/tests.js test/alternating.test.mjs';
  config.affectedTests = 'node packages/gate/src/io/run/tests.js';
  delete config.submitGate;
  delete config.submitDeferAbove;
  writeFileSync(join(box.root, 'pullboard.json'), JSON.stringify(config) + '\n');
  // Remove only the consumer's generated cells plan; keep the shipped runtime manifest and modules intact.
  rmSync(join(box.root, 'packages/codemap/data/plan/cells.json'), { force: true });
  const behavior = join(box.root, 'packages/controlled/src/behavior.js');
  mkdirSync(dirname(behavior), { recursive: true });
  writeFileSync(behavior, '/** Return whether this controlled run should fail. */\nexport function shouldFail() { return false; }\n');
  writeFileSync(join(box.root, 'packages/controlled/index.js'), "export { shouldFail } from './src/behavior.js';\n");
  writeFileSync(join(box.root, 'test/alternating.test.mjs'), `import assert from 'node:assert/strict';\nimport {appendFileSync,readFileSync} from 'node:fs';\nimport {test} from 'node:test';\nimport {shouldFail} from '../packages/controlled/index.js';\ntest(${JSON.stringify(TITLE)},()=>{appendFileSync(${JSON.stringify(box.counter)},'run\\n');const runs=readFileSync(${JSON.stringify(box.counter)},'utf8').trim().split('\\n').length;assert.equal(shouldFail(runs),false);});\n`);
  box.git('add', '-A'); box.git('commit', '-q', '-m', 'chore: prepare controlled submit consumer');
  const made = box.cli('worktree', 'core');
  assert.equal(made.code, 0, JSON.stringify(made.document));
  const root = made.document.path;
  const cli = (...args) => box.cliAt(root, ...args);
  const git = (...args) => runFixtureGit(args, { cwd: root, env: box.env });
  if (!deterministic) writeFileSync(box.counter, 'run\n'); // Baseline executes a genuine pass; no legacy one-pair quarantine is seeded.
  const added = box.cli('add', 'core', 'Controlled native Submit', '--route', 'strong', '--criterion', 'Retain the actual initial failure.', '--brief', 'Files:\n- packages/controlled/src/behavior.js\n- test/alternating.test.mjs\nTest:\n- the controlled Submit receipt retains the real initial failure and paired pass', '--check', 'true', '--wait');
  assert.equal(added.code, 0, JSON.stringify(added.document));
  assert.equal(added.document.item.item_check, 'true', JSON.stringify(added.document));
  const id = added.document.item.item_id;
  assert.equal(cli('claim', String(id)).code, 0);
  writeFileSync(join(root, 'packages/controlled/src/behavior.js'), `/** Return whether this controlled run should fail. */\nexport function shouldFail(runs) { return ${deterministic ? 'true' : 'runs % 2 === 1'}; }\n`);
  git('add', 'packages/controlled/src/behavior.js'); git('commit', '-q', '-m', 'chore: retain controlled proposal');
  if (companion) {
    const file = join(root, 'packages/controlled/src/companion.js');
    writeFileSync(file, 'export const companion = true;\n');
    git('add', 'packages/controlled/src/companion.js');
    const patch = git('diff', '--cached', '--binary') + '\n';
    git('restore', '--staged', 'packages/controlled/src/companion.js');
    rmSync(file);
    const patchFile = box.counter + '.patch';
    writeFileSync(patchFile, patch);
    const author = cli('whoami').document.id;
    const attached = box.cli('patch', 'attach', String(id), patchFile, '--key', 'controlled-companion', '--author', author, '--source', git('rev-parse', 'HEAD'));
    assert.equal(attached.code, 0, JSON.stringify(attached.document));
  }
  return { ...box, builder: { root, cli, git }, id };
}

/** Read only this journey's real fixture board, shared with its actual native CLI processes. */
function snapshot(box) {
  // @pullboard-board-file journey: actual Submit and native gate records persisted by this private CLI fixture
  const board = openBoard(join(box.root, '.git/pullboard/board.sqlite'), undefined, { isMain: true });
  try { return { quarantines: flakeQuarantines(board), runs: gateRuns(board), items: store.listItems(board, { all: true }), admissions: store.events(board).filter(event => ['claim', 'renew'].includes(event.event_kind)).map(event => JSON.parse(event.event_detail).submitAdmission).filter(Boolean) }; }
  finally { store.closeBoard(board); }
}

/** Begin another actual Submit admission with the controlled case failing on its initial body. */
function submit(box) {
  writeFileSync(box.counter, '');
  return box.builder.cli('submit', String(box.id), '--infra', 'private controlled native fixture', '--no-next');
}

for (const companion of [false, true]) test(`clause 1: two actual ${companion ? 'composed ' : ''}Submit pairs quarantine once, retain raw receipts, and let the third computed verdict through [C7,H16]`, t => {
  const box = fixture(t, false, companion);
  assert.equal(snapshot(box).quarantines.length, 0, 'the setup must not seed a legacy quarantine');
  const first = submit(box);
  assert.equal(first.code, 1, JSON.stringify(first.document));
  // f562d717d8: a Submit pair files its quarantine at once, so the first pair already holds the one active repair.
  assert.equal(snapshot(box).quarantines.length, 1, JSON.stringify({ quarantines: snapshot(box).quarantines, runs: snapshot(box).runs.map(run => ({ id: run.id, kind: run.kind, proof: run.proof, outcomes: run.testOutcomes })) }));
  const second = submit(box);
  assert.equal(second.code, 0, JSON.stringify(second.document)); // the active quarantine lets the computed verdict through
  const state = snapshot(box);
  assert.equal(state.quarantines.length, 1, JSON.stringify({ first: first.document, second: second.document, quarantines: state.quarantines, runs: state.runs.map(({ id, kind, proof, testOutcomes }) => ({ id, kind, proof, testOutcomes })) }));
  const entry = state.quarantines[0];
  assert.equal(entry.nativeCore, true); // the Submit backfill marks its quarantine nativeCore (f562d717d8)
  assert.equal(entry.name, TITLE);
  assert.equal(entry.status, 'quarantined');
  const repair = state.items.find(item => item.item_id === entry.item);
  assert.equal(repair.item_lane, 'core');
  assert.equal(state.items.filter(item => item.item_title.startsWith('Flaky test:')).length, 1, 'typed diagnostics and quarantine share one owner');
  assert.equal(entry.runs.length, 2, 'the second pair never files a second quarantine');
  const receipts = entry.runs.map(id => readGateReceipt(receiptStore(box.root), id));
  assert.ok(receipts.every(Boolean), 'both proving receipts are native-produced private bytes');
  if (companion) assert.ok(receipts.every(receipt => receipt.head !== box.builder.git('rev-parse', 'HEAD')), 'all proving receipts execute the actual composition, not the bare builder head');
  assert.equal(new Set(receipts.map(receipt => receipt.proof.diagnosticAdmission)).size, 1);
  assert.equal(state.admissions.length, 2, 'each actually acquired Submit lease creates exactly one authenticated native witness');
  assert.ok(receipts.every(receipt => state.admissions.some(admission => admission.id === receipt.proof.diagnosticAdmission)));
  // These are synthetic validator inputs copied from actual sealed native bytes, never execution receipts or writes.
  // @pullboard-board-file journey: challenge authenticated grants on the actual private fixture board without altering events
  const admissionBoard = openBoard(join(box.root, '.git/pullboard/board.sqlite'), undefined, { isMain: true });
  try {
    for (const receipt of receipts) {
      requireSubmitDiagnosticAdmission(admissionBoard, receipt.proof.seat, receipt);
      const request = { agentId: receipt.proof.seat, receipt };
      assert.ok(recordGateRunMove.minimumEngine([request]) >= AUTO_SUBMIT_QUARANTINE_ENGINE, 'omitted auto flag cannot downgrade marked evidence');
      assert.equal(recordGateRun(admissionBoard, request).duplicate, true, 'omitted auto flag preserves native automatic mode');
      for (const changed of [
        { ...receipt, proof: { ...receipt.proof, diagnosticAdmission: '00000000-0000-0000-0000-000000000000' } },
        { ...receipt, proof: { ...receipt.proof, item: box.id + 1 } },
        { ...receipt, proof: { ...receipt.proof, seat: 'core-unrelated' } },
        { ...receipt, tree: '0'.repeat(40) },
        { ...receipt, head: '0'.repeat(40) },
        { ...receipt, at: '2000-01-01T00:00:00.000Z' },
        ...(receipt.kind === 'check' ? [{ ...receipt, proof: { ...receipt.proof, submitPhase: undefined } }] : []),
        { ...receipt, proof: { ...receipt.proof, frozenDigest: '0'.repeat(64) } },
      ]) assert.throws(() => requireSubmitDiagnosticAdmission(admissionBoard, receipt.proof.seat, changed), error => error.code === 'GATE_RUN_UNBOUND');
      const stripped = structuredClone(receipt);
      delete stripped.proof.diagnosticAdmission;
      assert.throws(() => recordGateRun(admissionBoard, { ...request, receipt: stripped }), error => error.code === 'GATE_RUN_UNBOUND', 'removing purpose cannot reuse sealed bytes as legacy inference');
      assert.throws(() => recordGateRun(admissionBoard, { ...request, autoSubmit: false }), error => error.code === 'GATE_RUN_EVIDENCE');
    }
  } finally { store.closeBoard(admissionBoard); }
  for (const receipt of receipts.filter(receipt => receipt.kind === 'check')) {
    assert.equal(receipt.proof.submitPhase, 'diagnostic');
    assert.equal(receipt.proof.frozenDigest, null, 'a diagnostic cannot attest the frozen Submit bar');
    // @pullboard-board-file journey: challenge the actual diagnostic receipt against the actual claimed item bar
    const board = openBoard(join(box.root, '.git/pullboard/board.sqlite'), undefined, { isMain: true });
    try { assert.throws(() => proofRunReceipt(board, { agentId: receipt.proof.seat, itemId: box.id, receiptId: receipt.id }), error => error.code === 'PROOF_RUN_STALE'); }
    finally { store.closeBoard(board); }
  }
  const ledger = box.cli('flakes').document;
  const row = ledger.regressions.find(value => value.file === 'test/alternating.test.mjs' && value.name === TITLE);
  assert.ok(row);
  assert.equal(row.classification, 'possible-regression');
  assert.ok(row.observations.length >= 1 && row.observations.every(observation => observation.kind === 'submit'
    && observation.classification === 'possible-regression'
    && observation.original.green === false && observation.paired?.green === true && observation.mainReceipt?.green === true));
  for (const observation of row.observations) {
    for (const evidence of [observation.original, observation.paired]) {
      const raw = box.readData(join(box.root, '.git/pullboard', evidence.artifact), 'utf8');
      assert.match(raw, /controlled intermittent assertion/);
    }
  }
  // f562d717d8: the Submit backfill files an ordinary nativeCore quarantine, not an autoSubmit one, so health lists none.
  assert.deepEqual(box.cli('health').document.autoQuarantines, []);
  const cleanIds = new Set();
  for (let index = 0; index < 20; index += 1) {
    writeFileSync(box.counter, 'run\n'); // The real next controlled body passes.
    const clean = box.cli('gate', '--landing', '--receipt');
    assert.equal(clean.code, 0, JSON.stringify(clean.document));
    assert.ok(clean.document.receiptId, 'each clean body produces fresh native receipt evidence');
    cleanIds.add(clean.document.receiptId);
  }
  assert.equal(cleanIds.size, 20, 'twenty actual executions, never a reused green stamp');
  assert.equal(snapshot(box).quarantines[0].status, 'lifted', 'the Submit backfill files an ordinary quarantine, which the 20-clean-run release lifts (f562d717d8)');
  assert.equal(snapshot(box).quarantines.length, 1, 'later admissions retain one active repair');
  assert.equal(box.cli('show', String(box.id)).document.item_status, 'submitted');
});

test('clause 1: a real deterministic Submit original and rerun never acquire automatic quarantine [C7,H16]', t => {
  const box = fixture(t, true);
  const first = submit(box);
  assert.ok([0, 1].includes(first.code), JSON.stringify(first.document));
  assert.ok(box.readData(box.counter, 'utf8').trim().split('\n').length >= 2, 'the actual deterministic original and paired bodies executed: ' + JSON.stringify(first.document));
  assert.deepEqual(snapshot(box).quarantines, []);
  if (first.code === 1) {
    const second = submit(box);
    assert.ok([0, 1].includes(second.code), JSON.stringify(second.document));
    assert.deepEqual(snapshot(box).quarantines, []);
  }
});

/** Synthetic pure selector input explicitly tests historical time/identity boundaries, never execution authority. */
function synthetic(admission, passed, at, { tree = 'a', diagnostic = passed, skipped = false } = {}) {
  return { id: `${admission}-${passed}-${at}`, version: 2, kind: diagnostic ? 'check' : 'submit', tree,
    at, proof: { seat: 'synthetic', item: 1, frozenDigest: diagnostic ? null : 'bar', sourceClean: true,
      exitCode: passed ? 0 : 1, diagnosticAdmission: admission, ...(diagnostic ? { submitPhase: 'diagnostic' } : {}) },
    testOutcomes: [{ file: 'test/synthetic.js', name: 'synthetic case', passed, skipped }] };
}

test('clause 1: synthetic selector boundaries reject repeated admission, reversed order, changed trees, skips and expired pairs [C7,H16]', () => {
  const time = '2026-10-30T10:00:00.000Z';
  const red = synthetic('one', false, '2026-10-30T09:00:00.000Z');
  const green = synthetic('one', true, '2026-10-30T09:01:00.000Z');
  const select = runs => submitFlakePairs(runs, 'test/synthetic.js', 'synthetic case', time);
  assert.equal(select([red, green, red, green]).length, 1);
  assert.equal(select([red, synthetic('two', false, green.at)]).length, 0, 'repeated deterministic reds never complete a pair');
  assert.equal(select([red, { ...green, tree: 'different' }]).length, 0);
  assert.equal(select([green, { ...red, at: '2026-10-30T09:02:00.000Z' }]).length, 0);
  assert.equal(select([red, synthetic('one', true, green.at, { skipped: true })]).length, 0);
  assert.equal(select([red, synthetic('one', true, green.at, { diagnostic: false })]).length, 0);
  assert.equal(submitFlakePairs([red, green], 'test/synthetic.js', 'synthetic case', '2026-11-01T10:00:00.000Z').length, 0);
  const another = [synthetic('two', false, '2026-10-30T09:03:00.000Z', { tree: 'b' }), synthetic('two', true, '2026-10-30T09:04:00.000Z', { tree: 'b' })];
  assert.equal(select([red, green, ...another]).length, 2, 'each Submit pair keeps its own unchanged tree');
});
