/** @pullboard-test-input source-tree */
/** Actual private Submit cycles retain raw reds while repeated native pairs acquire quarantine authority [C7,H16]. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { flakyProject, TITLE } from '../packages/git/tests/flakes-fixture.js';
import { copyPackageFiles } from '../src/package-files.js';
import { commitFixtureFiles } from './package-copy-fixture.js';
import { runFixtureGit } from './fixture-child.js';
import { openBoard, flakeQuarantines, gateRuns } from '../src/native-board.js';
import * as store from '../src/board.js';
import { submitFlakePairs } from '../src/auto-submit-quarantine.js';
import { readGateReceipt, receiptStore } from '../src/gate-run-receipt.js';

/** Build genuine private package source and an ordinary joined/claimed builder; no receipt is fabricated. */
function fixture(t, deterministic = false) {
  const box = flakyProject(t);
  const copied = copyPackageFiles(resolve(import.meta.dirname, '..'), box.root);
  commitFixtureFiles({ repo: box.root, git: (_root, ...args) => box.git(...args) }, copied);
  const config = JSON.parse(readFileSync(join(box.root, 'pullboard.json'), 'utf8'));
  config.lanes = { core: { owns: ['src/', 'test/'], specs: [] } };
  config.flakes = { rerun: true, quarantine: true };
  config.gate = 'node bin/run-tests.js test/alternating.test.mjs';
  config.affectedTests = 'node bin/run-tests.js';
  config.submitGate = 'landing';
  config.submitDeferAbove = 20;
  writeFileSync(join(box.root, 'pullboard.json'), JSON.stringify(config) + '\n');
  // This synthetic consumer project has no cells-plan authority; the installed runtime is copied unchanged.
  rmSync(join(box.root, 'bin/cells-plan.json'), { force: true });
  if (deterministic) writeFileSync(join(box.root, 'test/alternating.test.mjs'), `import assert from 'node:assert/strict';\nimport {test} from 'node:test';\nimport {appendFileSync} from 'node:fs';\ntest(${JSON.stringify(TITLE)},()=>{appendFileSync(${JSON.stringify(box.counter)},'run\\n');assert.fail('deterministic controlled failure');});\n`);
  box.git('add', '-A'); box.git('commit', '-q', '-m', 'chore: prepare controlled submit consumer');
  const made = box.cli('worktree', 'core');
  assert.equal(made.code, 0, JSON.stringify(made.document));
  const root = made.document.path;
  const cli = (...args) => box.cliAt(root, ...args);
  const git = (...args) => runFixtureGit(args, { cwd: root, env: box.env });
  if (!deterministic) writeFileSync(box.counter, 'run\n'); // Baseline executes a genuine pass; no legacy one-pair quarantine is seeded.
  const added = box.cli('add', 'core', 'Controlled native Submit', '--criterion', 'Retain the actual initial failure.', '--check', config.gate, '--wait');
  assert.equal(added.code, 0, JSON.stringify(added.document));
  assert.equal(added.document.item.item_check, config.gate, JSON.stringify(added.document));
  const id = added.document.item.item_id;
  assert.equal(cli('claim', String(id)).code, 0);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/controlled-proposal.js'), 'export const controlled = true;\n');
  git('add', 'src/controlled-proposal.js'); git('commit', '-q', '-m', 'chore: retain controlled proposal');
  return { ...box, builder: { root, cli, git }, id };
}

/** Read only this journey's real fixture board, shared with its actual native CLI processes. */
function snapshot(box) {
  // @pullboard-board-file journey: actual Submit and native gate records persisted by this private CLI fixture
  const board = openBoard(join(box.root, '.git/pullboard/board.sqlite'), undefined, { isMain: true });
  try { return { quarantines: flakeQuarantines(board), runs: gateRuns(board), items: store.listItems(board, { all: true }) }; }
  finally { store.closeBoard(board); }
}

/** Begin another actual Submit admission with the controlled case failing on its initial body. */
function submit(box) {
  writeFileSync(box.counter, '');
  return box.builder.cli('submit', String(box.id), '--infra', 'private controlled native fixture', '--no-next');
}

test('two actual Submit pairs quarantine once, retain raw receipts, and let the third computed verdict through [C7,H16]', t => {
  const box = fixture(t);
  assert.equal(snapshot(box).quarantines.length, 0, 'the setup must not seed a legacy quarantine');
  const first = submit(box);
  assert.equal(first.code, 1, JSON.stringify(first.document));
  assert.equal(snapshot(box).quarantines.length, 0, JSON.stringify({ quarantines: snapshot(box).quarantines, runs: snapshot(box).runs.map(run => ({ id: run.id, kind: run.kind, proof: run.proof, outcomes: run.testOutcomes })) }));
  const second = submit(box);
  assert.equal(second.code, 1, JSON.stringify(second.document));
  const state = snapshot(box);
  assert.equal(state.quarantines.length, 1, JSON.stringify({ quarantines: state.quarantines, runs: state.runs.map(({ id, kind, proof, testOutcomes }) => ({ id, kind, proof, testOutcomes })) }));
  const entry = state.quarantines[0];
  assert.equal(entry.autoSubmit, true);
  assert.equal(entry.name, TITLE);
  assert.equal(entry.status, 'quarantined');
  const repair = state.items.find(item => item.item_id === entry.item);
  assert.equal(repair.item_lane, 'core');
  assert.equal(state.items.filter(item => item.item_title.startsWith('Flaky test:')).length, 1, 'typed diagnostics and quarantine share one owner');
  assert.equal(entry.runs.length, 4);
  const receipts = entry.runs.map(id => readGateReceipt(receiptStore(box.root), id));
  assert.ok(receipts.every(Boolean), 'all four proving receipts are native-produced private bytes');
  assert.equal(new Set(receipts.map(receipt => receipt.proof.diagnosticAdmission)).size, 2);
  for (const receipt of receipts.filter(receipt => receipt.kind === 'check')) {
    assert.equal(receipt.proof.submitPhase, 'diagnostic');
    assert.equal(receipt.proof.frozenDigest, null, 'a diagnostic cannot attest the frozen Submit bar');
  }
  const ledger = box.cli('flakes').document;
  const row = ledger.flakes.find(value => value.name === TITLE);
  assert.ok(row);
  for (const observation of row.observations) {
    for (const evidence of [observation.original, observation.paired]) {
      const raw = box.readData(join(box.root, '.git/pullboard', evidence.artifact), 'utf8');
      assert.match(raw, /controlled intermittent assertion/);
    }
  }
  const health = box.cli('health');
  assert.ok(health.document.autoQuarantines.some(value => value.item === entry.item));
  const third = submit(box);
  assert.equal(third.code, 0, JSON.stringify(third.document));
  assert.equal(snapshot(box).quarantines.length, 1, 'later admissions retain one active repair');
  assert.equal(box.cli('show', String(box.id)).document.item_status, 'submitted');
});

test('a real deterministic Submit original and rerun never acquire automatic quarantine [C7,H16]', t => {
  const box = fixture(t, true);
  const first = submit(box);
  assert.ok([0, 1].includes(first.code), JSON.stringify(first.document));
  assert.ok(box.readData(box.counter, 'utf8').trim().split('\n').length >= 2, 'the actual deterministic original and paired bodies executed');
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

test('synthetic selector boundaries reject repeated admission, reversed order, changed trees, skips and expired pairs [C7,H16]', () => {
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
